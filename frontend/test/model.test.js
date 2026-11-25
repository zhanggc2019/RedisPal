import test from 'node:test'
import assert from 'node:assert/strict'
import { asArg, createKeyTreeIndex, decodeBackup, normalizeConnections, scanKeyBatches, splitCommand } from '../src/model.js'

function scanState(separator = ':') {
  return { keys: [], pendingKeys: [], seen: new Set(), cursor: '', keyIndex: createKeyTreeIndex(separator) }
}

function treeValues(nodes) {
  return nodes.flatMap(node => [
    ...(node.value === undefined ? [] : [node.value]), ...treeValues(node.children),
  ])
}

test('adds only new nodes and preserves keys that are also directories', () => {
  const index = createKeyTreeIndex(':')
  index.append(['left:item', 'right:item'])
  const [left, right] = index.nodes
  const item = right.children[0]
  index.append(['left', 'left:other', 'right:item'])
  assert.equal(index.nodes[0], left)
  assert.equal(index.nodes[1], right)
  assert.equal(right.children[0], item)
  assert.deepEqual(treeValues(index.nodes), ['left', 'left:item', 'left:other', 'right:item'])
})

test('counts loaded descendant keys once, including keys that also have children', () => {
  const index = createKeyTreeIndex(':')
  index.append(['068:hash:item', '068:hash', '068'])
  const [group] = index.nodes
  const [hash] = group.children
  assert.equal(group.descendantCount, 2)
  assert.equal(hash.descendantCount, 1)
  index.append(['068:hash:item', '068:hash:next', '069:list:item'])
  assert.equal(group.descendantCount, 3)
  assert.equal(hash.descendantCount, 2)
  assert.equal(index.nodes[1].descendantCount, 1)
  assert.equal(hash.children[0].descendantCount, 0)
})

test('deduplicates across scan replies and overflow while preserving distinct full keys', async () => {
  const state = scanState()
  const binary = { hex: 'ff' }
  const replies = new Map([
    ['', { cursor: 'a', keys: ['left:item', 'left:item', 'right:item', binary] }],
    ['a', { cursor: 'b', keys: ['right:item', { hex: 'ff' }, '0xff', 'extra'] }],
    ['b', { cursor: '', keys: ['extra', 'left:item', 'last'] }],
  ])
  const request = async cursor => replies.get(cursor)
  const run = (limit, reset) => scanKeyBatches(state, limit, reset, request, () => true)
  await run(2, true)
  assert.deepEqual(state.keys, ['left:item', 'right:item'])
  assert.deepEqual(state.pendingKeys, [binary])
  assert.deepEqual(treeValues(state.keyIndex.nodes), state.keys)
  await run(4, false)
  assert.deepEqual(state.keys, ['left:item', 'right:item', binary, '0xff'])
  assert.deepEqual(state.pendingKeys, ['extra'])
  await run(Infinity, false)
  const expected = ['left:item', 'right:item', binary, '0xff', 'extra', 'last']
  assert.deepEqual(state.keys, expected)
  assert.deepEqual(treeValues(state.keyIndex.nodes), expected)
  assert.deepEqual(state.pendingKeys, [])
  assert.equal(state.cursor, '')
})

test('resumes a stopped scan from the last accepted cursor, including before the first reply', async () => {
  const state = scanState()
  for (const expectedCursor of ['', 'next']) {
    let release
    let current = true
    const response = new Promise(resolve => { release = resolve })
    const keysBeforeStop = state.keys.slice()
    const stopped = scanKeyBatches(state, Infinity, expectedCursor === '', cursor => {
      assert.equal(cursor, expectedCursor)
      return response
    }, () => current)
    current = false
    const resumed = scanKeyBatches(state, 1 + keysBeforeStop.length, false, async cursor => {
      assert.equal(cursor, expectedCursor)
      return expectedCursor === '' ? { keys: ['a:first'], cursor: 'next' } : { keys: ['a:first', 'a:second'], cursor: '' }
    }, () => true)
    release({ keys: ['a:late'], cursor: 'obsolete' })
    await Promise.all([stopped, resumed])
    assert.deepEqual(state.keys, expectedCursor === '' ? ['a:first'] : ['a:first', 'a:second'])
  }
  assert.equal(state.cursor, '')
  assert.deepEqual(treeValues(state.keyIndex.nodes), ['a:first', 'a:second'])
})

for (const action of ['refresh', 'database switch']) {
  test(`ignores a scan reply from before a ${action}`, async () => {
    const state = scanState()
    let revision = 1
    let release
    const request = new Promise(resolve => { release = resolve })
    const oldScan = scanKeyBatches(state, 1, true, () => request, () => revision === 1)
    revision++
    state.keyIndex = createKeyTreeIndex(':')
    await scanKeyBatches(state, 1, true, async () => ({ cursor: '', keys: ['current:item'] }), () => revision === 2)
    release({ cursor: 'obsolete', keys: ['old:item', 'stale:overflow'] })
    await oldScan
    assert.deepEqual(state.keys, ['current:item'])
    assert.deepEqual(treeValues(state.keyIndex.nodes), ['current:item'])
    assert.deepEqual(state.pendingKeys, [])
    assert.deepEqual([...state.seen], ['t:current:item'])
    assert.equal(state.cursor, '')
  })
}

// A binary Redis key must survive tree rendering and a second Redis call.
test('inherits literal tree paths and binary identities', () => {
  const binary = { hex: 'ff0041' }
  const index = createKeyTreeIndex(':')
  index.append(['users', 'users:profile', 'users:session', 'users-old', binary])
  const rows = index.nodes
  assert.equal(rows[0].title, 'users')
  assert.deepEqual(rows[0].children.map(row => row.title), ['profile', 'session'])
  assert.equal(rows.at(-1).value, binary)
  assert.deepEqual(asArg(binary), binary)
  assert.deepEqual(asArg(0), { text: '0' })
})

// A pasted Redis command uses redis-cli's quotations and binary escapes.
test('preserves quotes, empty values and binary CLI arguments', () => {
  assert.deepEqual(splitCommand(' SET key "中文 spaced" '), ['SET', 'key', '中文 spaced'])
  assert.deepEqual(splitCommand('MSET a "" b "\\xff"'), ['MSET', 'a', '', 'b', { hex: 'ff' }])
  assert.throws(() => splitCommand('SET a "unfinished'), /引号|quote/)
})

// Legacy Electron connections and CSV backups can be imported without conversion.
test('accepts Electron exports without losing TLS, SSH, Sentinel or a custom separator', () => {
  const result = normalizeConnections({ connections: [{ key: 'x', host: '::1', port: '6380', auth: 'sentinelPass', separator: '', sentinelOptions: { masterName: 'master', nodePassword: 'redisPass' }, sshOptions: { host: 'ssh', port: 22, username: 'me' }, sslOptions: { ca: 'ca.pem' } }], groups: [{ id: 'g', name: 'Work' }] })
  assert.equal(result.connections[0].addr, '[::1]:6380')
  assert.equal(result.connections[0].mode, 'sentinel')
  assert.equal(result.connections[0].sentinelPassword, 'sentinelPass')
  assert.equal(result.connections[0].password, 'redisPass')
  assert.equal(result.connections[0].sshAddr, 'ssh:22')
  assert.equal(result.connections[0].tlsCA, 'ca.pem')
  assert.equal(result.connections[0].separator, '')
  const now = 2000
  assert.deepEqual(decodeBackup('ff,001122,400\r\n62,abcd,-1\n', now), [
    { key: { hex: 'ff' }, dump: '001122', expiresAt: 2400 },
    { key: { hex: '62' }, dump: 'abcd', expiresAt: 0 },
  ])
})
