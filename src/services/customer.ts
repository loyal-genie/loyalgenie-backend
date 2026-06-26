import { nanoid } from 'nanoid'
import { db } from '../db/client.js'

export interface CustomerProfile {
  id: string
  name: string
  phone: string
  email: string
  dateOfBirth?: string
  gender?: string
  profileComplete: boolean
  missingFields: Array<'dateOfBirth' | 'gender' | 'email'>
}

export interface CustomerNotification {
  id: string
  type: 'profile_incomplete'
  title: string
  body: string
  actionUrl: string
  createdAt: string
}

function rowToProfile(row: Record<string, unknown>): CustomerProfile {
  const dateOfBirth = (row.date_of_birth as string | null) ?? undefined
  const gender = (row.gender as string | null) ?? undefined
  const email = (row.email as string | null) ?? ''
  const missingFields: CustomerProfile['missingFields'] = []
  if (!dateOfBirth) missingFields.push('dateOfBirth')
  if (!gender) missingFields.push('gender')
  if (!email.trim()) missingFields.push('email')

  return {
    id: row.id as string,
    name: row.name as string,
    phone: row.phone as string,
    email,
    dateOfBirth,
    gender,
    profileComplete: missingFields.length === 0,
    missingFields,
  }
}

export async function getCustomerById(id: string): Promise<CustomerProfile | null> {
  const result = await db.execute({
    sql: 'SELECT id, name, phone, email, date_of_birth, gender FROM customer_users WHERE id = ?',
    args: [id],
  })
  const row = result.rows[0]
  if (!row) return null
  return rowToProfile(row as Record<string, unknown>)
}

export async function createCustomerWithNameOnly(name: string, phone: string) {
  const existing = await db.execute({
    sql: 'SELECT id FROM customer_users WHERE phone = ?',
    args: [phone],
  })
  if (existing.rows.length > 0) throw new Error('PHONE_EXISTS')

  const id = nanoid()
  await db.execute({
    sql: `INSERT INTO customer_users (id, name, phone, email, password_hash, date_of_birth, gender, phone_verified, profile_complete)
          VALUES (?, ?, ?, NULL, NULL, NULL, NULL, 1, 0)`,
    args: [id, name.trim(), phone],
  })

  const profile = await getCustomerById(id)
  if (!profile) throw new Error('USER_NOT_FOUND')
  return profile
}

export async function updateCustomerProfileFields(
  userId: string,
  fields: {
    name?: string
    dateOfBirth?: string | null
    gender?: string | null
    email?: string | null
  },
) {
  const current = await getCustomerById(userId)
  if (!current) throw new Error('USER_NOT_FOUND')

  const name = fields.name !== undefined ? fields.name.trim() : current.name
  const dateOfBirth = fields.dateOfBirth !== undefined ? fields.dateOfBirth : current.dateOfBirth ?? null
  const gender = fields.gender !== undefined ? fields.gender : current.gender ?? null
  const normalizedEmail = fields.email !== undefined
    ? (fields.email?.trim().toLowerCase() || null)
    : (current.email.trim() || null)

  if (normalizedEmail) {
    const emailTaken = await db.execute({
      sql: 'SELECT id FROM customer_users WHERE email = ? AND id != ?',
      args: [normalizedEmail, userId],
    })
    if (emailTaken.rows.length > 0) throw new Error('EMAIL_EXISTS')
  }

  const missingFields: CustomerProfile['missingFields'] = []
  if (!dateOfBirth) missingFields.push('dateOfBirth')
  if (!gender) missingFields.push('gender')
  if (!normalizedEmail) missingFields.push('email')
  const profileComplete = missingFields.length === 0 ? 1 : 0

  await db.execute({
    sql: `UPDATE customer_users
          SET name = ?, date_of_birth = ?, gender = ?, email = ?, profile_complete = ?
          WHERE id = ?`,
    args: [name, dateOfBirth, gender, normalizedEmail, profileComplete, userId],
  })

  const profile = await getCustomerById(userId)
  if (!profile) throw new Error('USER_NOT_FOUND')
  return profile
}

function missingFieldLabels(missing: CustomerProfile['missingFields']): string {
  const labels: Record<CustomerProfile['missingFields'][number], string> = {
    dateOfBirth: 'date of birth',
    gender: 'gender',
    email: 'email',
  }
  const parts = missing.map(f => labels[f])
  if (parts.length === 1) return parts[0]
  if (parts.length === 2) return `${parts[0]} and ${parts[1]}`
  return `${parts.slice(0, -1).join(', ')}, and ${parts[parts.length - 1]}`
}

export function buildCustomerNotifications(profile: CustomerProfile): CustomerNotification[] {
  if (profile.profileComplete) return []

  return [{
    id: 'profile-incomplete',
    type: 'profile_incomplete',
    title: 'Complete your profile',
    body: `Add your ${missingFieldLabels(profile.missingFields)} to finish setting up your account.`,
    actionUrl: '/customer/profile/edit',
    createdAt: new Date().toISOString(),
  }]
}
