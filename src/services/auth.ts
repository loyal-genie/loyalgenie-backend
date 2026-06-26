import jwt from 'jsonwebtoken'
import { nanoid } from 'nanoid'
import { db } from '../db/client.js'
import { toStoredPhone, formatPhoneLocal } from './phone.js'
import { getCustomerById } from './customer.js'

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

export function signProfileCompletionToken(phone: string) {
  return jwt.sign(
    { sub: phone, type: 'profile_completion' },
    JWT_SECRET,
    { expiresIn: '15m' },
  )
}

export function verifyProfileCompletionToken(token: string): string | null {
  try {
    const payload = jwt.verify(token, JWT_SECRET) as { sub: string; type: string }
    if (payload.type !== 'profile_completion' || !payload.sub) return null
    return payload.sub
  } catch {
    return null
  }
}

export async function createBusinessUser(email: string) {
  const normalized = email.toLowerCase()
  const existing = await db.execute({ sql: 'SELECT id FROM business_users WHERE email = ?', args: [normalized] })
  if (existing.rows.length > 0) throw new Error('EMAIL_EXISTS')

  const id = nanoid()
  await db.execute({
    sql: 'INSERT INTO business_users (id, email, password_hash) VALUES (?, ?, NULL)',
    args: [id, normalized],
  })
  return { id, email: normalized }
}

/** Login email may match business_users.email or businesses.email on the linked account. */
export async function resolveBusinessUserByEmail(email: string) {
  const normalized = email.toLowerCase()
  const direct = await db.execute({
    sql: 'SELECT id, email FROM business_users WHERE email = ?',
    args: [normalized],
  })
  if (direct.rows[0]) return direct.rows[0]

  const viaBusiness = await db.execute({
    sql: `SELECT bu.id, bu.email
          FROM businesses b
          JOIN business_users bu ON bu.id = b.user_id
          WHERE lower(b.email) = ?
          LIMIT 1`,
    args: [normalized],
  })
  return viaBusiness.rows[0] ?? null
}

export async function signInBusinessByEmail(loginEmail: string) {
  const row = await resolveBusinessUserByEmail(loginEmail)
  if (!row) throw new Error('EMAIL_NOT_FOUND')

  const user = { id: row.id as string, email: row.email as string }
  const business = await resolveBusinessForLogin(user.id, loginEmail)
  const token = signToken({ ...user, role: 'business' })

  return {
    token,
    userId: user.id,
    email: user.email,
    role: 'business' as const,
    businessId: business?.id as string | undefined,
    onboarded: Boolean(business),
    isNewUser: false,
  }
}

export async function getBusinessForUser(userId: string) {
  const result = await db.execute({
    sql: 'SELECT id, name, qr_slug FROM businesses WHERE user_id = ? LIMIT 1',
    args: [userId],
  })
  return result.rows[0] ?? null
}

/** Resolve business profile for login — by user_id, then by login email (legacy rows). */
async function resolveBusinessForLogin(userId: string, loginEmail: string) {
  const byUser = await getBusinessForUser(userId)
  if (byUser) return byUser

  const normalized = loginEmail.toLowerCase()
  const byEmail = await db.execute({
    sql: 'SELECT id, name, qr_slug, user_id FROM businesses WHERE lower(email) = ? LIMIT 1',
    args: [normalized],
  })
  const row = byEmail.rows[0]
  if (!row) return null

  if (!row.user_id) {
    await db.execute({
      sql: 'UPDATE businesses SET user_id = ? WHERE id = ?',
      args: [userId, row.id as string],
    })
  }

  return { id: row.id, name: row.name, qr_slug: row.qr_slug }
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
      sql: 'SELECT id, name, phone, email, date_of_birth, gender FROM customer_users WHERE phone = ?',
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
        gender: (row.gender as string | null) ?? undefined,
      }
    }
  }
  return null
}

export async function signInCustomerByPhone(phone: string) {
  const user = await getCustomerByPhone(phone)
  if (!user) throw new Error('PHONE_NOT_FOUND')

  const profile = await getCustomerById(user.id)
  const token = signToken({ ...user, role: 'customer' })

  return {
    token,
    userId: user.id,
    email: user.email,
    name: user.name,
    phone: user.phone,
    role: 'customer' as const,
    profileComplete: profile?.profileComplete ?? true,
  }
}

export async function registerBusinessUserAfterOtp(email: string) {
  const user = await createBusinessUser(email)
  const token = signToken({ ...user, role: 'business' })
  return {
    token,
    userId: user.id,
    email: user.email,
    role: 'business' as const,
    onboarded: false,
    isNewUser: true,
  }
}
