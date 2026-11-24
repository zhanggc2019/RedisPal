import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const root = new URL('../', import.meta.url)
const logo = readFileSync(new URL('src/../public/logo.png', root))
const icon = readFileSync(new URL('../build/windows/RedisPal.ico', root))

function assertPngAlpha(buffer, offset = 0) {
  assert.equal(buffer.toString('ascii', offset + 1, offset + 4), 'PNG')
  assert.equal(buffer[offset + 25], 6, 'PNG must use RGBA color type 6')
}

test('the workspace logo has a transparent alpha channel', () => {
  assertPngAlpha(logo)
})

test('every Windows icon frame preserves the logo alpha channel', () => {
  assert.equal(icon.readUInt16LE(2), 1)
  const frames = icon.readUInt16LE(4)
  assert.ok(frames > 0)
  for (let index = 0; index < frames; index++) {
    const entry = 6 + index * 16
    const offset = icon.readUInt32LE(entry + 12)
    assertPngAlpha(icon, offset)
  }
})
