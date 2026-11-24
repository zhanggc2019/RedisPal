import { darkTheme, lightTheme } from 'naive-ui'

export const themePresets = [
  { id: 'default', zh: 'Naive UI', en: 'Naive UI', light: lightTheme.common.primaryColor, dark: darkTheme.common.primaryColor },
  { id: 'pine', zh: '松绿', en: 'Pine', light: '#156b53', dark: '#74d2ae' },
  { id: 'lake', zh: '湖蓝', en: 'Lake', light: '#205d96', dark: '#86c2f3' },
  { id: 'dusk', zh: '暮紫', en: 'Dusk', light: '#67459b', dark: '#c3a7f2' },
  { id: 'graphite', zh: '石墨', en: 'Graphite', light: '#495463', dark: '#b5c2d3' },
]

/** Restore a supported preference or use Naive UI's default palette. */
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
  const accent = dark ? preset.dark : preset.light
  const panel = dark ? '#1b2027' : '#ffffff'
  const bg = dark ? '#14181e' : '#f5f6f8'
  const sidebar = dark ? '#181c22' : '#f9fafb'
  const ink = dark ? '#edf2f7' : '#18242f'
  const muted = dark ? '#abb9c7' : '#506071'
  const border = dark ? '#333b46' : '#dfe4ea'
  const hover = dark ? '#252c34' : '#eef1f5'
  const active = mix(panel, accent, dark ? .19 : .10)
  const foreground = dark ? mix(accent, '#ffffff', .27) : mix(accent, '#0b1420', .12)
  const accentHover = mix(accent, dark ? '#ffffff' : '#07111c', .12)
  const accentPressed = mix(accent, dark ? '#ffffff' : '#07111c', .2)
  const onAccent = dark ? '#101a25' : '#ffffff'
  const fontFamily = font || '"Segoe UI", "Microsoft YaHei UI", sans-serif'

  return {
    css: {
      '--bg': bg, '--sidebar': sidebar, '--panel': panel, '--hover': hover,
      '--border': border, '--border-strong': dark ? '#4e5967' : '#c6cfd9',
      '--ink': ink, '--muted': muted, '--focus': accent,
      '--accent': accent,
      '--accent-text': foreground, '--accent-soft': active,
      '--console-prompt': preset.dark,
      '--console-background': '#161b22',
    },
    naive: preset.id === 'default' ? (font ? { common: { fontFamily: font } } : undefined) : {
      common: {
        fontFamily, borderRadius: '8px',
        primaryColor: accent, primaryColorHover: accentHover,
        primaryColorPressed: accentPressed, primaryColorSuppl: accentHover,
        textColor1: ink, textColor2: ink, textColor3: muted,
        bodyColor: bg, cardColor: panel, modalColor: panel, popoverColor: panel,
        inputColor: panel, borderColor: border, dividerColor: border, hoverColor: hover,
      },
      Button: {
        textColorPrimary: onAccent, textColorHoverPrimary: onAccent,
        textColorPressedPrimary: onAccent, textColorFocusPrimary: onAccent,
        fontWeightStrong: '650',
      },
      Input: { placeholderColor: muted, border: `1px solid ${border}` },
    },
  }
}
