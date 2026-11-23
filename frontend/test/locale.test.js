import test from 'node:test'
import assert from 'node:assert/strict'
import { normalizeLanguage } from '../src/locale.js'

// Fresh installs and retired language preferences use Simplified Chinese.
test('defaults to Chinese and preserves a saved English preference', () => {
  for (const value of [undefined, 'zh', 'zh-TW', 'de', 'unknown']) {
    assert.equal(normalizeLanguage(value), 'zh')
  }
  assert.equal(normalizeLanguage('en'), 'en')
})
