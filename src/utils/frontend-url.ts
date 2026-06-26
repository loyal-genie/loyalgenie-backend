/** Normalize a frontend origin or URL to `protocol//host` (no trailing slash). */
export function normalizeFrontendOrigin(raw: string): string {
  const trimmed = raw.trim().replace(/\/+$/, '')
  if (!trimmed) return ''
  const withProtocol = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`
  try {
    return new URL(withProtocol).origin
  } catch {
    return trimmed
  }
}

/** Parse comma-separated FRONTEND_URL values into normalized origins. */
export function parseFrontendOrigins(envValue = process.env.FRONTEND_URL): string[] {
  const raw = envValue ?? 'http://localhost:5173'
  return [...new Set(
    raw
      .split(',')
      .map(normalizeFrontendOrigin)
      .filter(Boolean),
  )]
}

/** Primary frontend base URL for QR/join links (first entry in FRONTEND_URL). */
export function getPrimaryFrontendUrl(envValue = process.env.FRONTEND_URL): string {
  return parseFrontendOrigins(envValue)[0] ?? 'http://localhost:5173'
}

/** Customer sign-in URL encoded in counter QR codes (`/signin?b={qrSlug}`). */
export function buildCustomerJoinUrl(frontendBaseUrl: string, qrSlug: string): string {
  const base = frontendBaseUrl.replace(/\/$/, '')
  return `${base}/signin?b=${encodeURIComponent(qrSlug)}`
}
