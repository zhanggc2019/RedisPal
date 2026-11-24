import { identity } from './model.js'

/** Decode XINFO's RESP2 alternating field/value arrays without coercing names or counters. */
export function streamRecords(reply) {
  return reply.map(fields => {
    const pairs = []
    for (let i = 0; i + 1 < fields.length; i += 2) pairs.push([fields[i], fields[i + 1]])
    return Object.fromEntries(pairs)
  }).filter(record => record.name != null).map(record => ({ ...record, id: identity(record.name) }))
}

/** Cut a bounded page at the first unseen ID, used as the next inclusive cursor. */
export function streamPage(reply, size) {
  return { entries: reply.slice(0, size), cursor: reply[size]?.[0] ?? null }
}
