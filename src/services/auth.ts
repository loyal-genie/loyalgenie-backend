import bcrypt from 'bcryptjs'
import jwt from 'jsonwebtoken'
import { nanoid } from 'nanoid'
import { db } from '../db/client.js'
import { toStoredPhone, formatPhoneLocal } from './phone.js'

const JWT_SECRET = process.env.JWT_SECRET ?? 'loyalgenie-dev-secret-change-in-prod'
const JWT_EXPIRES = '30d'

export interface AuthUser {
  id: string
  email: string
  role: 'business' | 'customer'
  name?: string
  phone?: string
}

export function signToken(user: AuthUser) {
  return jwt.sign(
    { sub: user.id, email: user.email, type: user.role, name: user.name, phone: user.phone },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRES },
  )
}

export function verifyToken(token: string, expectedRole?: 'business' | 'customer'): AuthUser | null {
  try {
    const payload = jwt.verify(token, JWT_SECRET) as {
      sub: string
      email: string
      type: string
      name?: string
      phone?: string
    }
    const role = payload.type === 'customer' ? 'customer' : 'business'
    if (expectedRole && role !== expectedRole) return null
    return {
      id: payload.sub,
      email: payload.email,
      role,
      name: payload.name,
      phone: payload.phone,
    }
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
  const token = signToken({ ...user, role: 'business' })

  return {
    token,
    userId: user.id,
    email: user.email,
    role: 'business' as const,
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

export async function getCustomerByPhone(phone: string) {
  const stored = toStoredPhone(phone)
  const local = formatPhoneLocal(phone)
  const candidates = [stored, local, `91${local}`, `+91${local}`]

  for (const candidate of [...new Set(candidates)]) {
    const result = await db.execute({
      sql: 'SELECT id, name, phone, email, date_of_birth FROM customer_users WHERE phone = ?',
      args: [candidate],
    })
    const row = result.rows[0]
    if (row) {
      return {
        id: row.id as string,
        name: row.name as string,
        phone: row.phone as string,
        email: (row.email as string | null) ?? '',
        dateOfBirth: (row.date_of_birth as string | null) ?? undefined,
      }
    }
  }
  return null
}

export async function createCustomerUser(
  name: string,
  phone: string,
  dateOfBirth: string,
  email?: string | null,
) {
  const normalizedEmail = email?.trim().toLowerCase() || null
  const existing = await db.execute({
    sql: 'SELECT id FROM customer_users WHERE phone = ? OR (email IS NOT NULL AND email = ?)',
    args: [phone, normalizedEmail ?? ''],
  })
  if (existing.rows.length > 0) throw new Error('EMAIL_OR_PHONE_EXISTS')

  const id = nanoid()
  await db.execute({
    sql: `INSERT INTO customer_users (id, name, phone, email, password_hash, date_of_birth, phone_verified)
          VALUES (?, ?, ?, ?, NULL, ?, 1)`,
    args: [id, name.trim(), phone, normalizedEmail, dateOfBirth],
  })
  return {
    id,
    name: name.trim(),
    phone,
    email: normalizedEmail ?? '',
    dateOfBirth,
  }
}

export async function signInCustomerByPhone(phone: string) {
  const user = await getCustomerByPhone(phone)
  if (!user) throw new Error('PHONE_NOT_FOUND')

  const token = signToken({ ...user, role: 'customer' })

  return {
    token,
    userId: user.id,
    email: user.email,
    name: user.name,
    phone: user.phone,
    role: 'customer' as const,
  }
}

export async function resetPasswordByEmail(
  role: 'business' | 'customer',
  email: string,
  newPassword: string,
) {
  const table = role === 'customer' ? 'customer_users' : 'business_users'
  const result = await db.execute({
    sql: `SELECT id FROM ${table} WHERE email = ?`,
    args: [email.toLowerCase()],
  })
  const row = result.rows[0]
  if (!row) throw new Error('EMAIL_NOT_FOUND')

  const passwordHash = await hashPassword(newPassword)
  await db.execute({
    sql: `UPDATE ${table} SET password_hash = ? WHERE id = ?`,
    args: [passwordHash, row.id as string],
  })
}
