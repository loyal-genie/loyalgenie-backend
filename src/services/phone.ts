/** Normalize to MSG91 format: 91XXXXXXXXXX */
export function normalizeIndianPhone(phone: string): string {
  const digits = phone.replace(/\D/g, '')
  if (digits.length === 10) return `91${digits}`
  if (digits.length === 12 && digits.startsWith('91')) return digits
  if (digits.length === 11 && digits.startsWith('0')) return `91${digits.slice(1)}`
  throw new Error('INVALID_PHONE')
}

/** Display format: 10-digit local number */
export function formatPhoneLocal(phone: string): string {
  const normalized = normalizeIndianPhone(phone)
  return normalized.slice(2)
}

/** Canonical storage format: +91XXXXXXXXXX */
export function toStoredPhone(phone: string): string {
  const local = formatPhoneLocal(phone)
  return `+91${local}`
}
