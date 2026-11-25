import { Buffer } from 'buffer'

const encoder = new TextEncoder()
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })

// asArg maps text, numbers and binary values to the Wails argument shape.
export function asArg(value) {
  return value && typeof value === 'object' ? value : { text: String(value ?? '') }
}

// display renders binary bytes with an explicit hex prefix.
export function display(value) {
  if (value && typeof value === 'object' && 'hex' in value) return '0x' + value.hex
  if (value && typeof value === 'object') return JSON.stringify(value)
  return value == null ? '' : String(value)
}

// identity distinguishes binary keys from text that looks like hex.
export function identity(value) {
  return typeof value === 'object' ? 'b:' + value.hex : 't:' + value
}

// toBytes exposes the exact Redis bytes for binary views and backup files.
export function toBytes(value) {
  const raw = asArg(value)
  return raw.hex == null ? encoder.encode(raw.text) : Buffer.from(raw.hex, 'hex')
}

// fromBytes keeps valid UTF-8 readable and returns a hex argument for all other data.
export function fromBytes(bytes) {
  try {
    return decoder.decode(bytes)
  } catch {
    return { hex: Buffer.from(bytes).toString('hex') }
  }
}

// splitCommand reads Redis-style quoted arguments and preserves hexadecimal byte escapes.
export function splitCommand(line) {
  const parts = []
  let quote = ''
  let active = false
  let closed = false
  let value = ''
  let bytes = []
  const escapes = { n: '\n', r: '\r', t: '\t', b: '\b', a: '\x07' }

  /** Append pending Unicode text before moving to or from a binary escape. */
  function flushText() {
    for (const byte of encoder.encode(value)) bytes.push(byte)
    value = ''
  }

  /** Finish an argument even if it consisted of two empty quotes. */
  function finish() {
    flushText()
    parts.push(fromBytes(Uint8Array.from(bytes)))
    bytes = []
    active = false
    closed = false
  }

  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (!quote && /\s/.test(ch)) {
      if (active) finish()
      continue
    }
    if (closed) throw new Error('引号结束后需要空格 / expected whitespace after quote')
    active = true
    if (!quote && (ch === '"' || ch === "'")) {
      quote = ch
    } else if (ch === quote) {
      quote = ''
      closed = true
    } else if (ch === '\\' && quote && i + 1 < line.length) {
      const next = line[i + 1]
      const pair = line.slice(i + 2, i + 4)
      if (quote === '"' && next === 'x' && /^[0-9a-f]{2}$/i.test(pair)) {
        flushText()
        bytes.push(Number.parseInt(pair, 16))
        i += 3
      } else if (quote === '"' || next === "'") {
        value += quote === '"' ? (escapes[next] ?? next) : next
        i++
      } else {
        value += ch
      }
    } else {
      value += ch
    }
  }
  if (quote) throw new Error('引号未闭合 / unterminated quote')
  if (active) finish()
  return parts
}

export function createKeyTreeIndex(separator) {
  const nodes = []
  const byId = new Map()

  function add(id, title, siblings) {
    let node = byId.get(id)
    if (!node) {
      node = { id, title, value: undefined, children: [] }
      byId.set(id, node)
      siblings.push(node)
    }
    return node
  }

  function append(keys) {
    for (const value of keys) {
      if (typeof value !== 'string' || !separator) {
        add(identity(value), display(value), nodes).value = value
        continue
      }
      const segments = value.split(separator)
      let siblings = nodes
      let path = 't:'
      let node
      for (let i = 0; i < segments.length; i++) {
        path += (i === 0 ? '' : separator) + segments[i]
        node = add(path, segments[i], siblings)
        siblings = node.children
      }
      node.value = value
    }
  }

  return { nodes, append }
}

export async function scanKeyBatches(state, limit, reset, request, isCurrent) {
  function append(keys) {
    state.keyIndex?.append(keys)
    state.keys.push(...keys)
  }

  if (reset) {
    state.keys.length = 0
    state.pendingKeys.length = 0
    state.cursor = ''
    state.seen.clear()
  }
  append(state.pendingKeys.splice(0, limit - state.keys.length))
  let first = reset
  while ((first || state.cursor) && state.keys.length < limit) {
    first = false
    const page = await request(state.cursor)
    if (!isCurrent()) return
    state.cursor = page.cursor
    const room = limit - state.keys.length
    const next = []
    for (const value of page.keys) {
      const id = identity(value)
      if (state.seen.has(id)) continue
      state.seen.add(id)
      if (next.length < room) next.push(value)
      else state.pendingKeys.push(value)
    }
    append(next)
  }
}

// endpoint accepts legacy split hosts, including unbracketed IPv6.
export function endpoint(host, port) {
  const address = String(host ?? '').trim()
  if (!address) return ''
  return (address.includes(':') && !address.startsWith('[') ? '[' + address + ']' : address) + ':' + port
}

// normalizeConnections accepts an Electron export or a Wails connection bundle.
export function normalizeConnections(bundle) {
  const entries = Array.isArray(bundle) ? bundle : bundle?.connections
  if (!Array.isArray(entries)) throw new Error('连接文件缺少 connections 列表 / invalid connection bundle')
  const groups = (Array.isArray(bundle?.groups) ? bundle.groups : []).filter(group => group?.id && group?.name)
  const groupIDs = new Set(groups.map(group => group.id))
  const used = new Set()
  const connections = entries.map(item => {
    const addr = item.addr || endpoint(item.host, item.port || 6379)
    if (typeof addr !== 'string' || !addr) throw new Error('连接缺少地址 / Redis address is required')
    const sentinel = item.sentinelOptions?.masterName ? item.sentinelOptions : null
    const ssh = item.sshOptions?.host ? item.sshOptions : null
    const tls = item.sslOptions
    let id = String(item.id || item.key || crypto.randomUUID())
    if (used.has(id)) id = crypto.randomUUID()
    used.add(id)
    return {
      id, name: item.name || addr, addr, username: item.username || '',
      password: item.password ?? (sentinel ? sentinel.nodePassword || '' : item.auth || ''),
      mode: item.mode || (item.cluster ? 'cluster' : sentinel ? 'sentinel' : 'standalone'),
      sentinelMaster: item.sentinelMaster ?? sentinel?.masterName ?? '',
      sentinelUsername: item.sentinelUsername || '',
      sentinelPassword: item.sentinelPassword ?? (sentinel ? item.auth || '' : ''),
      separator: item.separator ?? ':', readOnly: item.readOnly ?? Boolean(item.connectionReadOnly),
      tls: item.tls ?? Boolean(tls), tlsCA: item.tlsCA ?? tls?.ca ?? '',
      tlsCert: item.tlsCert ?? tls?.cert ?? '', tlsKey: item.tlsKey ?? tls?.key ?? '',
      tlsServerName: item.tlsServerName ?? tls?.servername ?? '',
      ssh: item.ssh ?? Boolean(ssh), sshAddr: item.sshAddr ?? endpoint(ssh?.host, ssh?.port || 22),
      sshUsername: item.sshUsername ?? ssh?.username ?? '', sshPassword: item.sshPassword ?? ssh?.password ?? '',
      sshKey: item.sshKey ?? ssh?.privatekey ?? '', sshPassphrase: item.sshPassphrase ?? ssh?.passphrase ?? '',
      sshKnownHosts: item.sshKnownHosts || '', sshTimeout: Number(item.sshTimeout ?? ssh?.timeout ?? 10) || 10,
      color: item.color || '', groupId: groupIDs.has(item.groupId) ? item.groupId : '',
      dbNames: item.dbNames && typeof item.dbNames === 'object' ? item.dbNames : {},
      lastDb: Number.isSafeInteger(item.lastDb) ? item.lastDb : 0,
      searchHistory: Array.isArray(item.searchHistory) ? item.searchHistory.filter(value => typeof value === 'string').slice(0, 30) : [],
    }
  })
  return { connections, groups }
}

// decodeBackup accepts the current JSON format and Electron's hexadecimal CSV format.
export function decodeBackup(text, now = Date.now()) {
  const clean = text.replace(/^\uFEFF/, '').trim()
  if (clean.startsWith('[') || clean.startsWith('{')) {
    const data = JSON.parse(clean)
    const rows = Array.isArray(data) ? data : data.keys
    if (!Array.isArray(rows)) throw new Error('备份缺少键列表 / invalid backup')
    return rows
  }
  return clean.split(/\r?\n/).filter(Boolean).map((line, index) => {
    const [key, dump, rawTTL, extra] = line.split(',')
    const ttl = Number(rawTTL)
    if (extra !== undefined || !/^(?:[a-f0-9]{2})*$/i.test(key) || !/^(?:[a-f0-9]{2})+$/i.test(dump ?? '') || !Number.isSafeInteger(ttl)) {
      throw new Error('无效的 CSV 行 / invalid CSV row ' + (index + 1))
    }
    return { key: { hex: key }, dump, expiresAt: ttl > 0 ? now + ttl : 0 }
  })
}

// parseInfo exposes the Redis INFO fields and sections without rounding large counters.
export function parseInfo(text = '') {
  const sections = {}
  let name = 'Server'
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith('# ')) {
      name = line.slice(2)
    } else if (line.includes(':')) {
      const end = line.indexOf(':')
      ;(sections[name] ??= {})[line.slice(0, end)] = line.slice(end + 1)
    }
  }
  return sections
}

// download writes a generated backup or result through the WebView download manager.
export function download(name, data, type = 'application/json') {
  const url = URL.createObjectURL(new Blob([data], { type }))
  const link = document.createElement('a')
  link.href = url
  link.download = name
  link.click()
  setTimeout(() => URL.revokeObjectURL(url), 30_000)
}
