import { z } from 'zod'
import QRCode from 'qrcode'
import { db } from '../db/client.js'
import { onboardingSchema } from './onboarding.js'

export const businessUpdateSchema = onboardingSchema
  .partial()
  .extend({
    name: z.string().min(1).optional(),
    businessType: z.string().min(1).optional(),
    ownerName: z.string().min(1).optional(),
    mobile: z.string().min(10).optional(),
    email: z.string().email().optional(),
    city: z.string().min(1).optional(),
  })

export type BusinessUpdatePayload = z.infer<typeof businessUpdateSchema>

function parsePhotoArray(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw as string[]
  if (typeof raw === 'string' && raw) {
    try {
      const parsed = JSON.parse(raw)
      return Array.isArray(parsed) ? parsed : []
    } catch {
      return []
    }
  }
  return []
}

function rowToProfile(row: Record<string, unknown>, branch?: Record<string, unknown> | null) {
  return {
    id: row.id as string,
    name: row.name as string,
    tagline: (row.tagline as string) ?? '',
    description: (row.description as string) ?? '',
    businessType: row.business_type as string,
    ownerName: row.owner_name as string,
    mobile: row.mobile as string,
    whatsapp: (row.whatsapp as string) ?? '',
    email: row.email as string,
    city: row.city as string,
    pincode: (row.pincode as string) ?? '',
    landmark: (row.landmark as string) ?? '',
    address: (row.address as string) ?? '',
    mapLink: (row.map_link as string) ?? '',
    operatingHours: (row.operating_hours as string) ?? '',
    weeklyOff: (row.weekly_off as string) ?? '',
    brandColor: (row.brand_color as string) ?? '#7C3AED',
    instagram: (row.instagram as string) ?? '',
    facebook: (row.facebook as string) ?? '',
    website: (row.website as string) ?? '',
    googleReview: (row.google_review as string) ?? '',
    rating: row.rating != null ? Number(row.rating) : null,
    latitude: row.latitude != null ? Number(row.latitude) : null,
    longitude: row.longitude != null ? Number(row.longitude) : null,
    qrSlug: row.qr_slug as string,
    branchName: (branch?.name as string) ?? '',
    branchCity: (branch?.city as string) ?? '',
    branchAddress: (branch?.address as string) ?? '',
    logoData: (row.logo_data as string) ?? '',
    coverBannerData: (row.cover_banner_data as string) ?? '',
    interiorPhotosData: parsePhotoArray(row.interior_photos_data),
    exteriorPhotosData: parsePhotoArray(row.exterior_photos_data),
  }
}

export async function getBusinessProfileForUser(userId: string) {
  const result = await db.execute({
    sql: 'SELECT * FROM businesses WHERE user_id = ? LIMIT 1',
    args: [userId],
  })
  const row = result.rows[0]
  if (!row) return null

  const branchResult = await db.execute({
    sql: 'SELECT * FROM branches WHERE business_id = ? AND is_primary = 1 LIMIT 1',
    args: [row.id as string],
  })

  return rowToProfile(row as Record<string, unknown>, branchResult.rows[0] as Record<string, unknown> | undefined)
}

export async function updateBusinessProfile(userId: string, payload: BusinessUpdatePayload) {
  const existing = await db.execute({
    sql: 'SELECT id FROM businesses WHERE user_id = ? LIMIT 1',
    args: [userId],
  })
  const businessId = existing.rows[0]?.id as string | undefined
  if (!businessId) throw new Error('BUSINESS_NOT_FOUND')

  const fieldMap: [keyof BusinessUpdatePayload, string][] = [
    ['name', 'name'],
    ['tagline', 'tagline'],
    ['description', 'description'],
    ['businessType', 'business_type'],
    ['ownerName', 'owner_name'],
    ['mobile', 'mobile'],
    ['whatsapp', 'whatsapp'],
    ['email', 'email'],
    ['city', 'city'],
    ['pincode', 'pincode'],
    ['landmark', 'landmark'],
    ['address', 'address'],
    ['mapLink', 'map_link'],
    ['operatingHours', 'operating_hours'],
    ['weeklyOff', 'weekly_off'],
    ['brandColor', 'brand_color'],
    ['instagram', 'instagram'],
    ['facebook', 'facebook'],
    ['website', 'website'],
    ['googleReview', 'google_review'],
    ['rating', 'rating'],
    ['latitude', 'latitude'],
    ['longitude', 'longitude'],
    ['logoData', 'logo_data'],
    ['coverBannerData', 'cover_banner_data'],
  ]

  const jsonFieldMap: [keyof BusinessUpdatePayload, string][] = [
    ['interiorPhotosData', 'interior_photos_data'],
    ['exteriorPhotosData', 'exterior_photos_data'],
  ]

  const sets: string[] = []
  const args: (string | number | null)[] = []
  for (const [key, col] of fieldMap) {
    if (payload[key] !== undefined) {
      sets.push(`${col} = ?`)
      args.push((payload[key] as string) || null)
    }
  }

  for (const [key, col] of jsonFieldMap) {
    if (payload[key] !== undefined) {
      sets.push(`${col} = ?`)
      args.push(JSON.stringify(payload[key] ?? []))
    }
  }

  if (sets.length > 0) {
    args.push(businessId)
    await db.execute({
      sql: `UPDATE businesses SET ${sets.join(', ')} WHERE id = ?`,
      args,
    })
  }

  if (payload.branchName !== undefined || payload.branchCity !== undefined || payload.branchAddress !== undefined) {
    const branchResult = await db.execute({
      sql: 'SELECT id FROM branches WHERE business_id = ? AND is_primary = 1 LIMIT 1',
      args: [businessId],
    })
    const branchId = branchResult.rows[0]?.id as string | undefined
    if (branchId) {
      const branchSets: string[] = []
      const branchArgs: string[] = []
      if (payload.branchName !== undefined) {
        branchSets.push('name = ?')
        branchArgs.push(payload.branchName)
      }
      if (payload.branchCity !== undefined) {
        branchSets.push('city = ?')
        branchArgs.push(payload.branchCity)
      }
      if (payload.branchAddress !== undefined) {
        branchSets.push('address = ?')
        branchArgs.push(payload.branchAddress)
      }
      if (branchSets.length > 0) {
        branchArgs.push(branchId)
        await db.execute({
          sql: `UPDATE branches SET ${branchSets.join(', ')} WHERE id = ?`,
          args: branchArgs,
        })
      }
    }
  }

  return getBusinessProfileForUser(userId)
}

export async function getBusinessQrForUser(userId: string, frontendBaseUrl: string) {
  const profile = await getBusinessProfileForUser(userId)
  if (!profile) throw new Error('BUSINESS_NOT_FOUND')

  const joinUrl = `${frontendBaseUrl.replace(/\/$/, '')}/${profile.qrSlug}`
  const qrCodeDataUrl = await QRCode.toDataURL(joinUrl, {
    margin: 2,
    width: 400,
    color: { dark: '#1A1840', light: '#FFFFFF' },
  })

  return {
    businessId: profile.id,
    businessName: profile.name,
    qrSlug: profile.qrSlug,
    joinUrl,
    qrCodeDataUrl,
  }
}
