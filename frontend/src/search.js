import { splitCommand } from './model.js'

export const fieldTypes = ['TEXT', 'TAG', 'NUMERIC', 'GEO', 'VECTOR']

/** Make pairs from a RESP2 field list while preserving values and duplicate field names. */
function pairs(reply) {
  if (!Array.isArray(reply)) return []
  const fields = []
  for (let i = 0; i + 1 < reply.length; i += 2) fields.push([reply[i], reply[i + 1]])
  return fields
}

/** Turn the named sections of FT.INFO into properties. */
export function infoFields(reply) {
  return Object.fromEntries(pairs(reply))
}

/** Read indexed field aliases for the query editor. */
export function indexFields(reply) {
  const attributes = infoFields(reply).attributes
  if (!Array.isArray(attributes)) return []
  return attributes.map(value => {
    // FT.INFO attributes can end in flags such as SORTABLE without a value.
    const { identifier: name, attribute: alias, type } = infoFields(value)
    return { name, alias, type }
  }).filter(field => typeof field.alias === 'string')
}

/** Suggest scalar schema fields without guessing how to index nested JSON. */
export function inferFields(source, reply) {
  const json = source === 'JSON' ? JSON.parse(reply) : null
  const entries = source === 'HASH' ? pairs(reply) : json && !Array.isArray(json) && typeof json === 'object' ? Object.entries(json) : []
  return entries.flatMap(([name, value]) => {
    if (typeof name !== 'string' || value === null || typeof value === 'object') return []
    const numeric = typeof value === 'number' || (source === 'HASH' && /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:e[+-]?\d+)?$/i.test(value) && Number.isFinite(Number(value)))
    return [{
      name: source === 'JSON' ? '$[' + JSON.stringify(name) + ']' : name,
      alias: name,
      type: numeric ? 'NUMERIC' : typeof value === 'boolean' ? 'TAG' : 'TEXT',
      sortable: false,
    }]
  })
}

/** Assemble FT.CREATE arguments with one prefix and an explicit editable schema. */
export function buildIndex(draft) {
  const name = draft.name.trim()
  if (!name || !draft.prefix || !draft.fields.length || !['HASH', 'JSON'].includes(draft.source)) {
    throw new Error('请填写索引名称、键前缀和索引字段 / Index name, key prefix and schema fields are required')
  }
  const args = ['FT.CREATE', name, 'ON', draft.source, 'PREFIX', '1', draft.prefix, 'SCHEMA']
  const aliases = new Set()
  for (const field of draft.fields) {
    const alias = field.alias || field.name
    if (!field.name || !alias || aliases.has(alias) || !fieldTypes.includes(field.type)) {
      throw new Error('请检查字段名称、类型和重复别名 / Check field names, types and duplicate aliases')
    }
    aliases.add(alias)
    args.push(field.name)
    if (alias !== field.name) args.push('AS', alias)
    args.push(field.type)
    if (field.type === 'VECTOR') {
      const dimensions = Number(field.dimensions)
      if (!Number.isSafeInteger(dimensions) || dimensions < 1) throw new Error('向量维度须为正整数 / Vector dimensions must be a positive integer')
      args.push(field.algorithm || 'FLAT', '6', 'TYPE', 'FLOAT32', 'DIM', String(dimensions), 'DISTANCE_METRIC', field.metric || 'COSINE')
    } else if (field.sortable) args.push('SORTABLE')
  }
  return args
}

/** Keep the query expression as one argument and parse advanced options using the CLI syntax. */
export function buildQuery(draft, action) {
  const query = draft.query.trim()
  if (!draft.index || !query) throw new Error('请选择索引并输入查询 / Select an index and enter a query')
  const options = splitCommand(draft.options)
  if (action === 'explain') {
    const dialect = options.findLastIndex(arg => typeof arg === 'string' && arg.toUpperCase() === 'DIALECT')
    return ['FT.EXPLAIN', draft.index, query, ...(dialect >= 0 ? options.slice(dialect, dialect + 2) : [])]
  }
  if (action === 'profile') return ['FT.PROFILE', draft.index, draft.mode, 'QUERY', query, ...options]
  return ['FT.' + draft.mode, draft.index, query, ...options]
}

/** Render common result shapes as tables and leave optional metadata formats in the raw reply. */
export function readRows(reply, mode, options) {
  if (!Array.isArray(reply) || !/^\d+$/.test(String(reply[0]))) return null
  const count = reply[0]
  const has = flag => options.some(value => String(value).toUpperCase() === flag)
  const rows = []
  if (mode === 'AGGREGATE') {
    for (const fields of reply.slice(1)) {
      if (!Array.isArray(fields) || fields.length % 2 !== 0) return null
      rows.push({ fields: pairs(fields) })
    }
  } else {
    if (['WITHSCORES', 'WITHPAYLOADS', 'WITHSORTKEYS', 'EXPLAINSCORE'].some(has)) return null
    const stride = has('NOCONTENT') ? 1 : 2
    if ((reply.length - 1) % stride !== 0) return null
    for (let i = 1; i < reply.length; i += stride) {
      const key = reply[i]
      const fields = stride === 2 ? reply[i + 1] : null
      if (typeof key !== 'string' && typeof key?.hex !== 'string') return null
      if (fields !== null && (!Array.isArray(fields) || fields.length % 2 !== 0)) return null
      rows.push({ key, fields: pairs(fields) })
    }
  }
  return { count, rows }
}

/** Quote a complete Redis command for inspection or copy into the RedisPal CLI. */
export function commandText(args) {
  return args.map(value => {
    if (value && typeof value === 'object') return '"' + (value.hex.match(/../g) || []).map(byte => '\\x' + byte).join('') + '"'
    if (/^[^"'\\\s\x00-\x1f]+$/.test(value)) return value
    return '"' + String(value).replace(/[\\\"\x00-\x1f]/g, ch => {
      if (ch === '\\' || ch === '"') return '\\' + ch
      return '\\x' + ch.charCodeAt(0).toString(16).padStart(2, '0')
    }) + '"'
  }).join(' ')
}
