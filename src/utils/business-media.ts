export function parsePhotoArray(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.filter((v): v is string => typeof v === 'string')
  if (typeof raw === 'string' && raw) {
    try {
      const parsed = JSON.parse(raw)
      return Array.isArray(parsed)
        ? parsed.filter((v): v is string => typeof v === 'string')
        : []
    } catch {
      return []
    }
  }
  return []
}

/** Prefer R2/CDN URL; fall back to legacy base64 data URL. */
export function resolveImageField(urlValue: unknown, dataValue: unknown): string {
  if (typeof urlValue === 'string' && urlValue.trim()) return urlValue.trim()
  if (typeof dataValue === 'string') return dataValue
  return ''
}

/** Prefer JSON URL array column; fall back to legacy base64 array in data column. */
export function resolvePhotoArrayField(urlValue: unknown, dataValue: unknown): string[] {
  const fromUrls = parsePhotoArray(urlValue)
  if (fromUrls.length > 0) return fromUrls
  return parsePhotoArray(dataValue)
}
