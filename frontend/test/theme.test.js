import assert from 'node:assert/strict'
import test from 'node:test'
import { darkTheme, lightTheme } from 'naive-ui'
import { appearance, normalizePreset, themePresets } from '../src/theme.js'

// Older workspaces and invalid preferences fall back to the branded theme.
test('offers the Naive UI default and four additional color schemes', () => {
  assert.deepEqual(themePresets.map(preset => preset.id), ['default', 'pine', 'lake', 'dusk', 'graphite'])
  assert.equal(normalizePreset('not-a-theme'), 'default')
  assert.equal(normalizePreset('lake'), 'lake')
})

/** Keep the built-in Naive UI themes unmodified unless the user sets a font. */
test('uses Naive UI theme defaults for both modes', () => {
  for (const [mode, theme] of [['light', lightTheme], ['dark', darkTheme]]) {
    const selected = appearance('default', mode)
    assert.equal(selected.naive, undefined)
    assert.equal(selected.css['--accent'], theme.common.primaryColor)
    assert.deepEqual(appearance('default', mode, 'Segoe UI').naive, { common: { fontFamily: 'Segoe UI' } })
  }
})

// Component controls and the custom workspace use the same colors in both modes.
test('maps each palette to Naive UI and workspace tokens', () => {
  for (const mode of ['light', 'dark']) {
    const themes = themePresets.map(preset => appearance(preset.id, mode))
    assert.equal(new Set(themes.map(theme => theme.css['--accent'])).size, 5)
    for (const surface of ['--bg', '--panel', '--sidebar']) {
      assert.equal(new Set(themes.map(theme => theme.css[surface])).size, 1)
    }
    for (const theme of themes.slice(1)) {
      assert.equal(theme.naive.common.primaryColor, theme.css['--accent'])
      assert.notEqual(theme.css['--panel'], theme.css['--bg'])
    }
  }
})
