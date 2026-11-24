import assert from 'node:assert/strict'
import test from 'node:test'
import { listedRows } from '../src/keydata.js'
import { streamPage, streamRecords } from '../src/streamdata.js'

test('retains the exact names and counters from consumer group replies', () => {
  const name = { hex: 'ff80' }
  assert.deepEqual(streamRecords([
    ['name', name, 'consumers', 1, 'pending', '9007199254740993', 'lag', null],
    ['name', '0xff80', 'consumers', 0],
  ]), [
    { id: 'b:ff80', name, consumers: 1, pending: '9007199254740993', lag: null },
    { id: 't:0xff80', name: '0xff80', consumers: 0 },
  ])
})

test('uses an inclusive lookahead cursor for pending entries on Redis 5 and later', () => {
  const older = ['1640000000000-0', 'worker-a', 100, 1]
  const newer = ['1640000000000-1', 'worker-b', 42, 2]
  assert.deepEqual(streamPage([older, newer], 1), { entries: [older], cursor: newer[0] })
  assert.deepEqual(streamPage([newer], 1), { entries: [newer], cursor: null })
})

test('reads the latest stream page and continues toward the lower bound', async () => {
  const key = { hex: 'fffe' }
  const range = { from: '1-0', to: '300-0' }
  const replies = Array.from({ length: 101 }, (_, i) => [`${200 - i}-0`, ['field', 'value']])
  const commands = []

  /** Return one Redis reply for each page while recording its range arguments. */
  async function run(...args) {
    commands.push(args)
    return commands.length === 1 ? replies : [replies.at(-1)]
  }

  const first = await listedRows(run, 'stream', key, null, '', range)
  const second = await listedRows(run, 'stream', key, first.cursor, '', range)
  assert.equal(first.rows.length, 100)
  assert.equal(first.rows[0].index, '200-0')
  assert.deepEqual(second, { rows: [{ index: '100-0', value: ['field', 'value'] }], cursor: null })
  assert.deepEqual(commands, [
    ['XREVRANGE', key, '300-0', '1-0', 'COUNT', 101],
    ['XREVRANGE', key, '100-0', '1-0', 'COUNT', 101],
  ])
})
