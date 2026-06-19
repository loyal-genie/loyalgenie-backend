import { createHash, randomInt } from 'crypto'
import { db } from '../db/client.js'
import { normalizeIndianPhone } from './phone.js'

const OTP_TTL_MINUTES = 10
const EMAIL_KEY_PREFIX = 'email:'

function hashOtp(key: string, otp: string): string {
  return createHash('sha256').update(`${key}:${otp}`).digest('hex')
}

export function normalizeEmailOtpKey(email: string): string {
  return `${EMAIL_KEY_PREFIX}${email.trim().toLowerCase()}`
}

export function generateOtp(): string {
  return String(randomInt(100000, 1000000))
}

async function saveOtpForKey(key: string, otp: string): Promise<void> {
  const expiresAt = new Date(Date.now() + OTP_TTL_MINUTES * 60_000).toISOString()
  await db.execute({
    sql: `INSERT INTO otp_verifications (phone, otp_hash, expires_at)
          VALUES (?, ?, ?)
          ON CONFLICT(phone) DO UPDATE SET otp_hash = excluded.otp_hash, expires_at = excluded.expires_at`,
    args: [key, hashOtp(key, otp), expiresAt],
  })
}

async function verifyStoredOtpForKey(key: string, otp: string): Promise<boolean> {
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

export async function saveOtp(phone: string, otp: string): Promise<void> {
  await saveOtpForKey(normalizeIndianPhone(phone), otp)
}

export async function verifyStoredOtp(phone: string, otp: string): Promise<boolean> {
  return verifyStoredOtpForKey(normalizeIndianPhone(phone), otp)
}

export async function saveEmailOtp(email: string, otp: string): Promise<void> {
  await saveOtpForKey(normalizeEmailOtpKey(email), otp)
}

export async function verifyStoredEmailOtp(email: string, otp: string): Promise<boolean> {
  return verifyStoredOtpForKey(normalizeEmailOtpKey(email), otp)
}
