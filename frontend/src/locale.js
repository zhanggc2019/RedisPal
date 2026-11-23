/** Preserve saved English and use Simplified Chinese for new or unsupported preferences. */
export function normalizeLanguage(language) {
  return language === 'en' ? 'en' : 'zh'
}
