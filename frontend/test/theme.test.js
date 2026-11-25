import assert from 'node:assert/strict'
import test from 'node:test'
import { darkTheme, lightTheme } from 'naive-ui'
import { appearance, normalizePreset, themePresets } from '../src/theme.js'

test('defaults to Naive UI and preserves other saved schemes', () => {
  assert.equal(themePresets[0].en, 'Naive UI')
  assert.equal(normalizePreset(undefined), 'default')
  assert.deepEqual(themePresets.map(preset => preset.id), ['default', 'pine', 'lake', 'dusk', 'graphite'])
  assert.equal(normalizePreset('not-a-theme'), 'default')
  assert.equal(normalizePreset('lake'), 'lake')
})

// Every palette must receive the same compact Naive UI mapping as the default.
test('maps the default preset to the same compact contract as every palette', () => {
  for (const mode of ['light', 'dark']) {
    const selected = appearance('default', mode)
    assert.equal(selected.naive.common.borderRadius, '5px')
    assert.equal(selected.naive.common.primaryColor, selected.css['--accent'])
    const native = (mode === 'light' ? lightTheme : darkTheme).common
    for (const token of ['primaryColor', 'primaryColorHover', 'primaryColorPressed', 'primaryColorSuppl']) {
      assert.equal(selected.naive.common[token], native[token])
    }
    assert.equal(selected.css['--danger'], mode === 'light' ? '#a52b40' : '#ffacb5')
    assert.equal(selected.css['--success'], mode === 'light' ? '#218658' : '#69c895')
    assert.equal(selected.css['--warn'], mode === 'light' ? '#a56d10' : '#efbd68')
  }
})

// Component controls and the custom workspace use the same colors in both modes.
test('maps each palette to Naive UI and workspace tokens', () => {
  for (const mode of ['light', 'dark']) {
    const themes = themePresets.map(preset => appearance(preset.id, mode))
    assert.equal(new Set(themes.map(theme => theme.css['--accent'])).size, themePresets.length)
    for (const surface of ['--bg', '--panel', '--sidebar']) {
      assert.equal(new Set(themes.map(theme => theme.css[surface])).size, 1)
    }
    for (const theme of themes) {
      assert.equal(theme.naive.common.primaryColor, theme.css['--accent'])
      assert.notEqual(theme.css['--panel'], theme.css['--bg'])
    }
  }
})

test('preserves RedisPal surfaces and status colors with the Naive UI accent', () => {
  const expected = {
    light: {
      '--bg': '#f5f6f8', '--sidebar': '#f9fafb', '--panel': '#ffffff',
      '--hover': '#eef1f5', '--border': '#dfe4ea', '--border-strong': '#c6cfd9',
      '--ink': '#18242f', '--muted': '#506071', '--accent': lightTheme.common.primaryColor,
      '--accent-text': '#168f51', '--accent-soft': '#e8f6ee', '--focus': lightTheme.common.primaryColor,
      '--danger': '#a52b40', '--success': '#218658', '--warn': '#a56d10',
    },
    dark: {
      '--bg': '#14181e', '--sidebar': '#181c22', '--panel': '#1b2027',
      '--hover': '#252c34', '--border': '#333b46', '--border-strong': '#4e5967',
      '--ink': '#edf2f7', '--muted': '#abb9c7', '--accent': darkTheme.common.primaryColor,
      '--accent-text': '#8deaca', '--accent-soft': '#294542', '--focus': darkTheme.common.primaryColor,
      '--danger': '#ffacb5', '--success': '#69c895', '--warn': '#efbd68',
    },
  }
  for (const mode of ['light', 'dark']) {
    const { css } = appearance('default', mode)
    for (const [token, value] of Object.entries(expected[mode])) {
      assert.equal(css[token], value, `${mode} ${token}`)
    }
  }
})

// A font preference must not opt any palette out of the shared component mapping.
test('keeps the complete compact Naive UI contract for every palette and font', () => {
  for (const mode of ['light', 'dark']) {
    for (const preset of themePresets) {
      const { css, naive } = appearance(preset.id, mode, 'Segoe UI')
      assert.deepEqual(Object.keys(naive).sort(), ['Button', 'Card', 'DataTable', 'Dialog', 'Input', 'Tag', 'common'])
      assert.equal(naive.common.fontFamily, 'Segoe UI')
      assert.equal(naive.common.fontFamilyMono, '"Consolas", "Cascadia Mono", monospace')
      assert.equal(naive.common.fontSize, '13px')
      assert.equal(naive.common.borderRadius, '5px')
      assert.equal(naive.common.borderRadiusSmall, '5px')
      assert.equal(naive.common.primaryColor, css['--accent'])
      assert.equal(naive.common.infoColor, css['--muted'])
      assert.equal(naive.common.successColor, css['--success'])
      assert.equal(naive.common.warningColor, css['--warn'])
      assert.equal(naive.common.errorColor, css['--danger'])
      assert.equal(naive.common.textColor1, css['--ink'])
      assert.equal(naive.common.textColor2, css['--ink'])
      assert.equal(naive.common.textColor3, css['--muted'])
      assert.equal(naive.common.bodyColor, css['--bg'])
      assert.equal(naive.common.cardColor, css['--panel'])
      assert.equal(naive.common.modalColor, css['--panel'])
      assert.equal(naive.common.popoverColor, css['--panel'])
      assert.equal(naive.common.inputColor, css['--panel'])
      assert.equal(naive.common.actionColor, css['--panel'])
      assert.equal(naive.common.tagColor, css['--hover'])
      assert.equal(naive.common.tableColor, css['--panel'])
      assert.equal(naive.common.tableHeaderColor, css['--sidebar'])
      assert.equal(naive.common.tableColorHover, css['--hover'])
      assert.equal(naive.common.tableColorStriped, css['--sidebar'])
      assert.equal(naive.common.tabColor, css['--panel'])
      assert.equal(naive.common.codeColor, css['--bg'])
      assert.equal(naive.common.buttonColor2, css['--hover'])
      assert.equal(naive.common.pressedColor, css['--accent-soft'])
      assert.equal(naive.common.borderColor, css['--border'])
      assert.equal(naive.common.dividerColor, css['--border'])
      assert.equal(naive.common.hoverColor, css['--hover'])
      assert.equal(naive.Input.placeholderColor, css['--muted'])
      assert.equal(naive.Input.border, `1px solid ${css['--border']}`)
      assert.equal(naive.Input.borderFocus, `1px solid ${css['--focus']}`)
      assert.equal(naive.Input.borderRadius, '5px')
      assert.equal(naive.Card.borderRadius, '6px')
      assert.equal(naive.DataTable.borderRadius, '6px')
      assert.equal(naive.Dialog.borderRadius, '8px')
      assert.equal(naive.Input.heightSmall, '30px')
      assert.equal(naive.Input.heightMedium, '32px')
      assert.equal(naive.Button.heightSmall, '28px')
      assert.equal(naive.Button.heightMedium, '32px')
      assert.equal(naive.Button.fontSizeSmall, '12px')
      assert.equal(naive.Button.fontSizeMedium, '13px')
      assert.equal(naive.Tag.textColorPrimary, css['--accent-text'])
      assert.equal(naive.Tag.colorPrimary, css['--accent-soft'])
      assert.equal(naive.Tag.textColorSuccess, css['--success-text'])
      assert.equal(naive.Tag.colorSuccess, css['--success-surface'])
      assert.equal(naive.Tag.textColorWarning, mode === 'dark' ? css['--warn'] : css['--ink'])
      assert.equal(naive.Tag.colorWarning, css['--hover'])
      assert.equal(naive.Tag.textColorError, css['--danger'])
      assert.equal(naive.Tag.colorError, css['--danger-surface'])
      for (const state of ['Primary', 'HoverPrimary', 'PressedPrimary', 'FocusPrimary']) {
        assert.equal(naive.Button[`textColor${state}`], mode === 'light' ? '#ffffff' : '#101a25')
      }
    }
  }
})
