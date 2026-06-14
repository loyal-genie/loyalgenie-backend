import bcrypt from 'bcryptjs'
import jwt from 'jsonwebtoken'
import { nanoid } from 'nanoid'
import { db } from '../db/client.js'

const JWT_SECRET = process.env.JWT_SECRET ?? 'loyalgenie-dev-secret-change-in-prod'
const JWT_EXPIRES = '30d'

export interface AuthUser {
  id: string
  email: string
}

export function signToken(user: AuthUser) {
  return jwt.sign({ sub: user.id, email: user.email, type: 'business' }, JWT_SECRET, { expiresIn: JWT_EXPIRES })
}

export function verifyToken(token: string): AuthUser | null {
  try {
    const payload = jwt.verify(token, JWT_SECRET) as { sub: string; email: string; type: string }
    if (payload.type !== 'business') return null
    return { id: payload.sub, email: payload.email }
  } catch {
    return null
  }
}

export async function hashPassword(password: string) {
  return bcrypt.hash(password, 12)
}

export async function verifyPassword(password: string, hash: string) {
  return bcrypt.compare(password, hash)
}

export async function createBusinessUser(email: string, password: string) {
  const existing = await db.execute({ sql: 'SELECT id FROM business_users WHERE email = ?', args: [email.toLowerCase()] })
  if (existing.rows.length > 0) throw new Error('EMAIL_EXISTS')

  const id = nanoid()
  const passwordHash = await hashPassword(password)
  await db.execute({
    sql: 'INSERT INTO business_users (id, email, password_hash) VALUES (?, ?, ?)',
    args: [id, email.toLowerCase(), passwordHash],
  })
  return { id, email: email.toLowerCase() }
}

export async function signInBusiness(email: string, password: string) {
  const result = await db.execute({
    sql: 'SELECT id, email, password_hash FROM business_users WHERE email = ?',
    args: [email.toLowerCase()],
  })
  const row = result.rows[0]
  if (!row) throw new Error('INVALID_CREDENTIALS')

  const valid = await verifyPassword(password, row.password_hash as string)
  if (!valid) throw new Error('INVALID_CREDENTIALS')

  const user = { id: row.id as string, email: row.email as string }
  const business = await getBusinessForUser(user.id)
  const token = signToken(user)

  return {
    token,
    userId: user.id,
    email: user.email,
    businessId: business?.id as string | undefined,
    onboarded: Boolean(business),
  }
}

export async function getBusinessForUser(userId: string) {
  const result = await db.execute({
    sql: 'SELECT id, name, qr_slug FROM businesses WHERE user_id = ? LIMIT 1',
    args: [userId],
  })
  return result.rows[0] ?? null
}

export async function getUserByEmail(email: string) {
  const result = await db.execute({
    sql: 'SELECT id, email FROM business_users WHERE email = ?',
    args: [email.toLowerCase()],
  })
  return result.rows[0] ?? null
}
