import { darkTheme, lightTheme } from 'naive-ui'

const nativeColors = { light: lightTheme.common, dark: darkTheme.common }

const modeColors = {
  light: {
    bg: '#f5f6f8', sidebar: '#f9fafb', panel: '#ffffff', hover: '#eef1f5',
    border: '#dfe4ea', borderStrong: '#c6cfd9', ink: '#18242f', muted: '#506071',
    danger: '#a52b40', success: '#218658', warn: '#a56d10',
    dangerSurface: '#fcecef', dangerBorder: '#eec3cb',
    successSurface: '#edf8ef', successBorder: '#a4ceb3', successText: '#145737',
  },
  dark: {
    bg: '#14181e', sidebar: '#181c22', panel: '#1b2027', hover: '#252c34',
    border: '#333b46', borderStrong: '#4e5967', ink: '#edf2f7', muted: '#abb9c7',
    danger: '#ffacb5', success: '#69c895', warn: '#efbd68',
    dangerSurface: '#402a30', dangerBorder: '#7c4953',
    successSurface: '#203b30', successBorder: '#517d64', successText: '#b5f1d2',
  },
}

export const themePresets = [
  { id: 'default', zh: 'Naive UI', en: 'Naive UI', light: nativeColors.light.primaryColor, dark: nativeColors.dark.primaryColor },
  { id: 'pine', zh: '松绿', en: 'Pine', light: '#156b53', dark: '#74d2ae' },
  { id: 'lake', zh: '湖蓝', en: 'Lake', light: '#205d96', dark: '#86c2f3' },
  { id: 'dusk', zh: '暮紫', en: 'Dusk', light: '#67459b', dark: '#c3a7f2' },
  { id: 'graphite', zh: '石墨', en: 'Graphite', light: '#495463', dark: '#b5c2d3' },
]

/** Restore a supported preference or use the Naive UI palette. */
export function normalizePreset(value) {
  return themePresets.some(preset => preset.id === value) ? value : themePresets[0].id
}

/** Blend two six-digit palette colors in sRGB. */
function mix(base, tint, amount) {
  const channels = [1, 3, 5].map(index => {
    const from = Number.parseInt(base.slice(index, index + 2), 16)
    const to = Number.parseInt(tint.slice(index, index + 2), 16)
    return Math.round(from + (to - from) * amount).toString(16).padStart(2, '0')
  })
  return '#' + channels.join('')
}

/** Compute one palette for Naive UI controls and custom desktop surfaces. */
export function appearance(value, mode, font) {
  const preset = themePresets.find(item => item.id === normalizePreset(value))
  const dark = mode === 'dark'
  const modeName = dark ? 'dark' : 'light'
  const colors = modeColors[modeName]
  const accent = preset[modeName]
  const native = preset.id === 'default' ? nativeColors[modeName] : null
  const active = mix(colors.panel, accent, dark ? .19 : .10)
  const foreground = mix(accent, dark ? '#ffffff' : '#0b1420', dark ? .27 : .12)
  const accentHover = native?.primaryColorHover ?? mix(accent, dark ? '#ffffff' : '#07111c', .12)
  const accentPressed = native?.primaryColorPressed ?? mix(accent, dark ? '#ffffff' : '#07111c', .2)
  const stateColors = base => {
    const hover = mix(base, dark ? '#ffffff' : '#07111c', .12)
    return { base, hover, pressed: mix(base, dark ? '#ffffff' : '#07111c', .2), suppl: hover }
  }
  const info = stateColors(colors.muted)
  const success = stateColors(colors.success)
  const warning = stateColors(colors.warn)
  const danger = stateColors(colors.danger)
  const onAccent = dark ? '#101a25' : '#ffffff'
  const fontFamily = font || '"Segoe UI", "Microsoft YaHei UI", sans-serif'

  return {
    css: {
      '--bg': colors.bg, '--sidebar': colors.sidebar, '--panel': colors.panel,
      '--hover': colors.hover, '--border': colors.border, '--border-strong': colors.borderStrong,
      '--ink': colors.ink, '--muted': colors.muted, '--accent': accent,
      '--accent-text': foreground, '--accent-soft': active, '--focus': accent,
      '--danger': colors.danger, '--success': colors.success, '--warn': colors.warn,
      '--danger-surface': colors.dangerSurface, '--danger-border': colors.dangerBorder,
      '--success-surface': colors.successSurface, '--success-border': colors.successBorder,
      '--success-text': colors.successText,
      '--console-prompt': preset.dark,
      '--console-background': '#161b22',
    },
    naive: {
      common: {
        fontFamily, fontFamilyMono: '"Consolas", "Cascadia Mono", monospace',
        fontSize: '13px', fontSizeMini: '11px', fontSizeTiny: '12px',
        fontSizeSmall: '12px', fontSizeMedium: '13px', fontWeightStrong: '650',
        borderRadius: '5px', borderRadiusSmall: '5px',
        primaryColor: accent, primaryColorHover: accentHover,
        primaryColorPressed: accentPressed, primaryColorSuppl: native?.primaryColorSuppl ?? accentHover,
        infoColor: info.base, infoColorHover: info.hover,
        infoColorPressed: info.pressed, infoColorSuppl: info.suppl,
        successColor: success.base, successColorHover: success.hover,
        successColorPressed: success.pressed, successColorSuppl: success.suppl,
        warningColor: warning.base, warningColorHover: warning.hover,
        warningColorPressed: warning.pressed, warningColorSuppl: warning.suppl,
        errorColor: danger.base, errorColorHover: danger.hover,
        errorColorPressed: danger.pressed, errorColorSuppl: danger.suppl,
        textColor1: colors.ink, textColor2: colors.ink, textColor3: colors.muted,
        bodyColor: colors.bg, cardColor: colors.panel, modalColor: colors.panel, popoverColor: colors.panel,
        inputColor: colors.panel, actionColor: colors.panel, tagColor: colors.hover,
        tableColor: colors.panel, tableHeaderColor: colors.sidebar,
        tableColorHover: colors.hover, tableColorStriped: colors.sidebar,
        tabColor: colors.panel, codeColor: colors.bg, buttonColor2: colors.hover, pressedColor: active,
        borderColor: colors.border, dividerColor: colors.border, hoverColor: colors.hover,
      },
      Button: {
        heightSmall: '28px', heightMedium: '32px', fontSizeSmall: '12px', fontSizeMedium: '13px',
        textColorPrimary: onAccent, textColorHoverPrimary: onAccent,
        textColorPressedPrimary: onAccent, textColorFocusPrimary: onAccent,
        fontWeightStrong: '650',
      },
      Card: {
        borderRadius: '6px',
      },
      DataTable: {
        borderRadius: '6px',
      },
      Dialog: {
        borderRadius: '8px',
      },
      Input: {
        heightSmall: '30px', heightMedium: '32px', fontSizeSmall: '12px', fontSizeMedium: '13px',
        borderRadius: '5px', placeholderColor: colors.muted,
        border: `1px solid ${colors.border}`, borderHover: `1px solid ${colors.borderStrong}`,
        borderFocus: `1px solid ${accent}`,
      },
      Tag: {
        textColorPrimary: foreground, colorPrimary: active,
        textColorSuccess: colors.successText, colorSuccess: colors.successSurface,
        textColorWarning: dark ? colors.warn : colors.ink, colorWarning: colors.hover,
        textColorError: colors.danger, colorError: colors.dangerSurface,
      },
    },
  }
}
