import { display } from './model.js'
import { streamPage } from './streamdata.js'

export const redisTypes = ['string', 'hash', 'list', 'set', 'zset', 'stream', 'ReJSON-RL', 'TSDB-TYPE', 'vectorset', 'array']
const batch = 100
const collectionScan = { hash: 'HSCAN', set: 'SSCAN', zset: 'ZSCAN' }
const rowLimit = { list: 'LLEN', hash: 'HLEN', set: 'SCARD', zset: 'ZCARD', stream: 'XLEN', vectorset: 'VCARD', array: 'ARCOUNT' }

// typeName normalizes Redis's built-in and module identifiers for the editor.
export function typeName(type) {
  return ({ 'ReJSON-RL': 'JSON', 'TSDB-TYPE': 'TimeSeries', vectorset: 'Vector', array: 'Array' })[type] || type
}

// listedRows walks sequences in key order or advances a collection-specific scan.
export async function listedRows(run, type, key, start, filter, range) {
  let rows = []
  let cursor = null
  if (collectionScan[type]) {
    const pattern = /[*?\[\\]/.test(filter) ? filter : '*' + filter + '*'
    const [next, data] = await run(collectionScan[type], key, start ?? '0', 'COUNT', batch, ...(filter ? ['MATCH', pattern] : []))
    if (type === 'set') rows = data.map(value => ({ value }))
    else {
      for (let i = 0; i < data.length; i += 2) {
        rows.push(type === 'hash' ? { field: data[i], value: data[i + 1] } : { score: data[i + 1], value: data[i] })
      }
    }
    if (String(next) !== '0') cursor = String(next)
  } else if (type === 'list') {
    const offset = start ?? 0
    const data = await run('LRANGE', key, offset, offset + batch - 1)
    rows = data.map((value, i) => ({ index: offset + i, value }))
    if (filter) rows = rows.filter(row => display(row.value).includes(filter))
    if (data.length === batch) cursor = offset + data.length
  } else if (type === 'stream') {
    const data = await run('XREVRANGE', key, start ?? (range.to || '+'), range.from || '-', 'COUNT', batch + 1)
    const page = streamPage(data, batch)
    rows = page.entries.map(([index, pairs]) => ({ index, value: pairs }))
    if (filter) rows = rows.filter(row => row.value.some(value => display(value).includes(filter)))
    cursor = page.cursor
  } else if (type === 'TSDB-TYPE') {
    const data = await run('TS.RANGE', key, start ?? (range.from || '-'), range.to || '+', 'COUNT', batch)
    rows = data.map(([index, value]) => ({ index, value }))
    if (data.length === batch) cursor = String(BigInt(data.at(-1)[0]) + 1n)
  } else if (type === 'vectorset') {
    const data = await run('VRANGE', key, start ?? '-', '+', batch)
    rows = data.filter(value => !filter || display(value).includes(filter)).map(value => ({ field: value, value: null }))
    if (data.length === batch) cursor = typeof data.at(-1) === 'string' ? '(' + data.at(-1) : { hex: '28' + data.at(-1).hex }
  } else if (type === 'array') {
    const offset = start ?? 0
    const length = await run('ARLEN', key)
    if (Number(length) > Number(offset)) {
      const data = filter
        ? await run('ARGREP', key, offset, Number(length) - 1, 'MATCH', filter, 'WITHVALUES', 'LIMIT', batch)
        : await run('ARSCAN', key, offset, Number(length) - 1, 'LIMIT', batch)
      rows = (data || []).map(([index, value]) => ({ index, value }))
      if (rows.length === batch) cursor = String(BigInt(rows.at(-1).index) + 1n)
    }
  }
  return { rows, cursor }
}

// countRows retrieves the appropriate Redis collection length without reading its contents.
export function countRows(run, type, key) {
  return rowLimit[type] ? run(rowLimit[type], key) : Promise.resolve(null)
}

// rowCommands builds the minimal native commands needed to add one value.
export function rowCommands(type, key, row, value) {
  switch (type) {
    case 'string': return ['SET', key, value]
    case 'ReJSON-RL': return ['JSON.SET', key, '$', value]
    case 'hash': return ['HSET', key, row.field, value]
    case 'list': return [row.prepend ? 'LPUSH' : 'RPUSH', key, value]
    case 'set': return ['SADD', key, value]
    case 'zset': return ['ZADD', key, row.score, value]
    case 'stream': return ['XADD', key, row.index || '*', ...parseStream(value)]
    case 'TSDB-TYPE': return ['TS.ADD', key, row.index || '*', value, 'ON_DUPLICATE', 'LAST']
    case 'vectorset': {
      const values = String(value).trim().split(/[\s,]+/).filter(Boolean)
      if (!values.length || values.some(item => !Number.isFinite(Number(item)))) throw new Error('Invalid vector values')
      return ['VADD', key, 'VALUES', values.length, ...values, row.field, ...(row.attributes ? ['SETATTR', row.attributes] : [])]
    }
    case 'array': return ['ARSET', key, row.index || '0', value]
    default: throw new Error('Unsupported Redis type: ' + type)
  }
}

// parseStream accepts a JSON field object or ordered [field, value] pairs.
export function parseStream(raw) {
  const value = JSON.parse(raw)
  const pairs = Array.isArray(value) ? value : value && typeof value === 'object' ? Object.entries(value) : []
  if (!pairs.length || pairs.some(item => !Array.isArray(item) || item.length !== 2)) throw new Error('Stream fields require a JSON object or [field, value] pairs')
  return pairs.flat().map(item => typeof item === 'object' && item !== null && 'hex' in item ? item : typeof item === 'string' ? item : JSON.stringify(item))
}

// createKey writes a value only if the exact key does not already exist.
export async function createKey(run, type, key, row, value, ttl) {
  const [command, , ...args] = rowCommands(type, key, row, value)
  if (type === 'string') {
    const result = await run(command, key, ...args, 'NX', ...(ttl > 0 ? ['EX', ttl] : []))
    if (!result) throw new Error('Key already exists')
    return
  }
  await run('EVAL',
    "if redis.call('EXISTS', KEYS[1]) == 1 then return redis.error_reply('Key already exists') end " +
    "local result = redis.call(ARGV[1], KEYS[1], unpack(ARGV, 3)) " +
    "if tonumber(ARGV[2]) > 0 then redis.call('EXPIRE', KEYS[1], ARGV[2]) end return result",
    1, key, command, ttl, ...args)
}

// editRow replaces a row atomically when the edit involves removing its old identity.
export function editRow(run, type, key, row, original, value) {
  switch (type) {
    case 'hash':
      return run('EVAL', "local prior = redis.call('HGET', KEYS[1], ARGV[1]) " +
        "if prior ~= ARGV[4] then return redis.error_reply('Hash field changed. Refresh first.') end " +
        "if ARGV[1] ~= ARGV[2] and redis.call('HEXISTS', KEYS[1], ARGV[2]) == 1 then return redis.error_reply('Hash field already exists') end " +
        "local ttl = redis.pcall('HPTTL', KEYS[1], 'FIELDS', 1, ARGV[1]) " +
        "redis.call('HSET', KEYS[1], ARGV[2], ARGV[3]) " +
        "if type(ttl[1]) == 'number' and ttl[1] >= 0 then redis.call('HPEXPIRE', KEYS[1], math.max(1, ttl[1]), 'FIELDS', 1, ARGV[2]) end " +
        "if ARGV[1] ~= ARGV[2] then redis.call('HDEL', KEYS[1], ARGV[1]) end return 1",
      1, key, original.field, row.field, value, original.value)
    case 'list':
      return run('EVAL', "if redis.call('LINDEX',KEYS[1],ARGV[1]) ~= ARGV[2] then return redis.error_reply('List changed. Refresh first.') end return redis.call('LSET',KEYS[1],ARGV[1],ARGV[3])", 1, key, original.index, original.value, value)
    case 'set':
      return run('EVAL', "if redis.call('SISMEMBER',KEYS[1],ARGV[1]) == 0 then return redis.error_reply('Set changed. Refresh first.') end " +
        "if ARGV[1] == ARGV[2] then return 0 end " +
        "if redis.call('SADD',KEYS[1],ARGV[2]) == 0 then return redis.error_reply('Set member already exists') end " +
        "return redis.call('SREM',KEYS[1],ARGV[1])", 1, key, original.value, value)
    case 'zset':
      return run('EVAL', "if redis.call('ZSCORE',KEYS[1],ARGV[1]) ~= ARGV[4] then return redis.error_reply('Sorted set changed. Refresh first.') end " +
        "if ARGV[1] ~= ARGV[2] and redis.call('ZSCORE',KEYS[1],ARGV[2]) then return redis.error_reply('Sorted set member already exists') end " +
        "redis.call('ZADD',KEYS[1],ARGV[3],ARGV[2]) if ARGV[1] ~= ARGV[2] then redis.call('ZREM',KEYS[1],ARGV[1]) end return 1", 1, key, original.value, value, row.score, original.score)
    case 'vectorset':
      return run('VSETATTR', key, original.field, row.attributes || '{}')
    default:
      return run(...rowCommands(type, key, row, value))
  }
}

// removeRow deletes the requested element while protecting index-based list edits from stale data.
export function removeRow(run, type, key, row) {
  switch (type) {
    case 'hash': return run('HDEL', key, row.field)
    case 'list': return run('EVAL',
      "if redis.call('LINDEX',KEYS[1],ARGV[1]) ~= ARGV[2] then return redis.error_reply('List changed. Refresh first.') end " +
      "redis.call('LSET',KEYS[1],ARGV[1],ARGV[3]) return redis.call('LREM',KEYS[1],1,ARGV[3])",
    1, key, row.index, row.value, crypto.randomUUID())
    case 'set': return run('SREM', key, row.value)
    case 'zset': return run('ZREM', key, row.value)
    case 'stream': return run('XDEL', key, row.index)
    case 'TSDB-TYPE': return run('TS.DEL', key, row.index, row.index)
    case 'vectorset': return run('VREM', key, row.field)
    case 'array': return run('ARDEL', key, row.index)
    default: throw new Error('Unsupported Redis type: ' + type)
  }
}
