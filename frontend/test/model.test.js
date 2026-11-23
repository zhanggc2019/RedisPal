import test from 'node:test'
import assert from 'node:assert/strict'
import { asArg, decodeBackup, keyTree, normalizeConnections, splitCommand } from '../src/model.js'

// A binary Redis key must survive tree rendering and a second Redis call.
test('inherits literal tree paths and binary identities', () => {
  const binary = { hex: 'ff0041' }
  const rows = keyTree(['users', 'users:profile', 'users:session', 'users-old', binary], ':')
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
