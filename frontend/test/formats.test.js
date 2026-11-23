import test from 'node:test'
import assert from 'node:assert/strict'
import { encode } from '@msgpack/msgpack'
import { Buffer } from 'buffer'
import { encodeEdited, guessFormat, renderFormat } from '../src/formats.js'

// Redis JSON must retain 64-bit values as written and binary modes must preserve exact bytes.
test('keeps large JSON numbers and validates exact binary edits', async () => {
  assert.equal(guessFormat('{"number":9223372036854775807}'), 'JSON')
  assert.match(await renderFormat('JSON', '{"number":9223372036854775807}'), /9223372036854775807/)
  assert.equal(await renderFormat('Hex', { hex: 'ff0041' }), 'ff 00 41')
  assert.equal(await renderFormat('Binary', { hex: 'ff0041' }), '11111111 00000000 01000001')
  assert.deepEqual(encodeEdited('Binary', '11111111 01000001'), { hex: 'ff41' })
  assert.deepEqual(encodeEdited('Hex', '0xFF 41'), { hex: 'FF41' })
  assert.throws(() => encodeEdited('Hex', 'xyz'), /hexadecimal/)
  assert.throws(() => encodeEdited('Binary', '01'), /eight bits/)
  assert.throws(() => encodeEdited('JSON', '[invalid]'))
})

// Read-only binary views decode representative data without changing Redis values.
test('decodes supported serialized formats and protobuf with and without a schema', async () => {
  assert.equal(JSON.parse(await renderFormat('Msgpack', { hex: Buffer.from(encode({ name: 'Redis' })).toString('hex') })).name, 'Redis')
  assert.equal(await renderFormat('PHPSerialize', 's:5:"hello";'), '"hello"')
  assert.equal(await renderFormat('JavaSerialize', { hex: 'aced000574000568656c6c6f' }), '"hello"')
  assert.equal(await renderFormat('Pickle', { hex: '80048c0568656c6c6f942e' }), '"hello"')
  const value = { hex: '082a12036162631a03010203' }
  const schema = { type: 'Example', sources: ['syntax = "proto3"; message Example { int32 count = 1; string name = 2; repeated int32 ids = 3; }'] }
  assert.deepEqual(JSON.parse(await renderFormat('Protobuf', value, schema)), { count: 42, name: 'abc', ids: [1, 2, 3] })
  assert.match(await renderFormat('Protobuf', value), /abc/)
})
