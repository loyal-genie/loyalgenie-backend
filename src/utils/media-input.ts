/** Accept https URLs (R2) or legacy base64 data URLs from the client. */
export function isPublicUrl(value: string): boolean {
  return value.startsWith('http://') || value.startsWith('https://')
}

export function normalizeSingleImageInput(value: string | undefined | null): {
  url: string | null
  legacyData: string | null
} {
  const trimmed = (value ?? '').trim()
  if (!trimmed) return { url: null, legacyData: null }
  if (isPublicUrl(trimmed)) return { url: trimmed, legacyData: null }
  return { url: null, legacyData: trimmed }
}

export function normalizePhotoArrayInput(values: string[] | undefined | null): {
  urls: string[]
  legacyDataJson: string | null
} {
  const list = values ?? []
  const urls = list.filter(v => isPublicUrl(v.trim()))
  const legacy = list.filter(v => v.trim() && !isPublicUrl(v.trim()))
  return {
    urls,
    legacyDataJson: legacy.length > 0 ? JSON.stringify(legacy) : null,
  }
}
