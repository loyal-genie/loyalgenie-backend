import { createHash, randomInt } from 'crypto'
import { db } from '../db/client.js'
import { normalizeIndianPhone } from './phone.js'

const OTP_TTL_MINUTES = 10

function hashOtp(phone: string, otp: string): string {
  return createHash('sha256').update(`${phone}:${otp}`).digest('hex')
}

export function generateOtp(): string {
  return String(randomInt(100000, 1000000))
}

export async function saveOtp(phone: string, otp: string): Promise<void> {
  const key = normalizeIndianPhone(phone)
  const expiresAt = new Date(Date.now() + OTP_TTL_MINUTES * 60_000).toISOString()
  await db.execute({
    sql: `INSERT INTO otp_verifications (phone, otp_hash, expires_at)
          VALUES (?, ?, ?)
          ON CONFLICT(phone) DO UPDATE SET otp_hash = excluded.otp_hash, expires_at = excluded.expires_at`,
    args: [key, hashOtp(key, otp), expiresAt],
  })
}

export async function verifyStoredOtp(phone: string, otp: string): Promise<boolean> {
  const key = normalizeIndianPhone(phone)
  const result = await db.execute({
    sql: 'SELECT otp_hash, expires_at FROM otp_verifications WHERE phone = ?',
    args: [key],
  })
  const row = result.rows[0]
  if (!row) return false

  const expiresAt = new Date(row.expires_at as string).getTime()
  if (Date.now() > expiresAt) {
    await db.execute({ sql: 'DELETE FROM otp_verifications WHERE phone = ?', args: [key] })
    return false
  }

  const valid = row.otp_hash === hashOtp(key, otp)
  if (valid) {
    await db.execute({ sql: 'DELETE FROM otp_verifications WHERE phone = ?', args: [key] })
  }
  return valid
}
