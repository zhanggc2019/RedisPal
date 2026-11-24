import assert from 'node:assert/strict'
import test from 'node:test'
import { buildIndex, buildQuery, indexFields, inferFields, readRows } from '../src/search.js'

test('infers HASH and JSON schemas without treating nested JSON as scalar data', () => {
  assert.deepEqual(inferFields('HASH', ['price', '12.50', 'name', 'bike', 'code', '0123']).map(({ name, type }) => [name, type]),
    [['price', 'NUMERIC'], ['name', 'TEXT'], ['code', 'TEXT']])
  assert.deepEqual(inferFields('JSON', JSON.stringify({ price: 12.5, available: true, other: { nested: 1 }, 'title "x"': 'bike' }))
    .map(({ name, alias, type }) => [name, alias, type]),
    [['$["price"]', 'price', 'NUMERIC'], ['$["available"]', 'available', 'TAG'], [String.raw`$["title \"x\""]`, 'title "x"', 'TEXT']])
})

test('builds one FT.CREATE command and validates aliases and vector dimensions', () => {
  const fields = [
    { name: '$.price', alias: 'price', type: 'NUMERIC', sortable: true },
    { name: '$.vector', alias: 'vector', type: 'VECTOR', algorithm: 'HNSW', dimensions: 3, metric: 'COSINE' },
  ]
  assert.deepEqual(buildIndex({ name: 'products', source: 'JSON', prefix: 'prod:', fields }),
    ['FT.CREATE', 'products', 'ON', 'JSON', 'PREFIX', '1', 'prod:', 'SCHEMA', '$.price', 'AS', 'price', 'NUMERIC', 'SORTABLE',
      '$.vector', 'AS', 'vector', 'VECTOR', 'HNSW', '6', 'TYPE', 'FLOAT32', 'DIM', '3', 'DISTANCE_METRIC', 'COSINE'])
  assert.throws(() => buildIndex({ name: 'products', source: 'JSON', prefix: 'prod:', fields: [fields[0], fields[0]] }))
  assert.throws(() => buildIndex({ name: 'products', source: 'JSON', prefix: 'prod:', fields: [{ ...fields[1], dimensions: 0 }] }))
})

test('passes the query as one argument and only forwards dialect to FT.EXPLAIN', () => {
  const options = { index: 'bikes', mode: 'AGGREGATE', query: '@price:[0 25]', options: 'LOAD 1 @name DIALECT 2' }
  assert.deepEqual(buildQuery(options, 'run'), ['FT.AGGREGATE', 'bikes', '@price:[0 25]', 'LOAD', '1', '@name', 'DIALECT', '2'])
  assert.deepEqual(buildQuery(options, 'profile'), ['FT.PROFILE', 'bikes', 'AGGREGATE', 'QUERY', '@price:[0 25]', 'LOAD', '1', '@name', 'DIALECT', '2'])
  assert.deepEqual(buildQuery(options, 'explain'), ['FT.EXPLAIN', 'bikes', '@price:[0 25]', 'DIALECT', '2'])
  assert.throws(() => buildQuery({ ...options, query: ' ' }, 'run'))
})

test('reads FT.INFO schema aliases and normalizes common RESP2 replies', () => {
  assert.deepEqual(indexFields(['attributes', [
    ['identifier', '$.price', 'attribute', 'price', 'type', 'NUMERIC', 'SORTABLE'],
    ['identifier', 'type', 'attribute', 'type', 'type', 'TEXT'],
  ]]), [{ name: '$.price', alias: 'price', type: 'NUMERIC' }, { name: 'type', alias: 'type', type: 'TEXT' }])
  assert.deepEqual(readRows([7, 'bike:1', ['price', '12.50']], 'SEARCH', []),
    { count: 7, rows: [{ key: 'bike:1', fields: [['price', '12.50']] }] })
  assert.deepEqual(readRows([7, 'bike:1', 'bike:2'], 'SEARCH', ['NOCONTENT']),
    { count: 7, rows: [{ key: 'bike:1', fields: [] }, { key: 'bike:2', fields: [] }] })
  assert.deepEqual(readRows([1, ['name', 'bike', 'count', '10']], 'AGGREGATE', []).rows,
    [{ fields: [['name', 'bike'], ['count', '10']] }])
  assert.equal(readRows([1, 'bike:1', '1', ['price', '12.50']], 'SEARCH', ['WITHSCORES']), null)
})
