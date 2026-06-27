import { z } from 'zod'
import { nanoid } from 'nanoid'
import QRCode from 'qrcode'
import { db } from '../db/client.js'
import { createBusinessUser, getBusinessForUser } from './auth.js'
import { uniqueCafeSlug } from '../utils/slug.js'
import { buildCustomerJoinUrl } from '../utils/frontend-url.js'
import { normalizePhotoArrayInput, normalizeSingleImageInput } from '../utils/media-input.js'

const uploadArraySchema = z.array(z.string()).optional().default([])

export const onboardingSchema = z.object({
  name: z.string().min(1, 'Business name is required'),
  tagline: z.string().optional().default(''),
  description: z.string().optional().default(''),
  businessType: z.string().min(1, 'Business type is required'),
  ownerName: z.string().min(1, 'Owner name is required'),
  mobile: z.string().min(10, 'Valid mobile number is required'),
  whatsapp: z.string().optional().default(''),
  email: z.string().email('Valid email is required'),
  city: z.string().min(1, 'City is required'),
  pincode: z.string().optional().default(''),
  landmark: z.string().optional().default(''),
  address: z.string().optional().default(''),
  mapLink: z.string().optional().default(''),
  operatingHours: z.string().optional().default(''),
  weeklyOff: z.string().optional().default(''),
  branchName: z.string().optional().default(''),
  branchCity: z.string().optional().default(''),
  branchAddress: z.string().optional().default(''),
  brandColor: z.string().default('#7C3AED'),
  instagram: z.string().optional().default(''),
  facebook: z.string().optional().default(''),
  website: z.string().optional().default(''),
  googleReview: z.string().optional().default(''),
  rating: z.coerce.number().min(0).max(5).optional().nullable(),
  latitude: z.coerce.number().optional().nullable(),
  longitude: z.coerce.number().optional().nullable(),
  logoData: z.string().optional().default(''),
  coverBannerData: z.string().optional().default(''),
  interiorPhotosData: uploadArraySchema,
  exteriorPhotosData: uploadArraySchema,
})

export type OnboardingPayload = z.infer<typeof onboardingSchema>

export interface OnboardingResult {
  businessId: string
  qrSlug: string
  joinUrl: string
  qrCodeDataUrl: string
  token?: string
}

export async function completeOnboarding(
  payload: OnboardingPayload,
  frontendBaseUrl: string,
  existingUserId?: string,
): Promise<OnboardingResult> {
  let userId = existingUserId

  if (!userId) {
    const user = await createBusinessUser(payload.email)
    userId = user.id
  } else {
    const existing = await getBusinessForUser(userId)
    if (existing) throw new Error('ALREADY_ONBOARDED')
  }

  const businessId = nanoid()
  const qrSlug = await uniqueCafeSlug(payload.name)
  const joinUrl = buildCustomerJoinUrl(frontendBaseUrl, qrSlug)

  const branchName = payload.branchName || `${payload.name} — Main`
  const branchCity = payload.branchCity || payload.city
  const branchAddress = payload.branchAddress || payload.address
  const branchId = nanoid()

  const logo = normalizeSingleImageInput(payload.logoData)
  const cover = normalizeSingleImageInput(payload.coverBannerData)
  const interior = normalizePhotoArrayInput(payload.interiorPhotosData)
  const exterior = normalizePhotoArrayInput(payload.exteriorPhotosData)

  await db.batch([
    {
      sql: `INSERT INTO businesses (
        id, user_id, name, tagline, description, business_type, owner_name, mobile, whatsapp, email,
        city, pincode, landmark, address, map_link, operating_hours, weekly_off,
        brand_color, instagram, facebook, website, google_review,
        logo_url, cover_banner_url, interior_photo_urls, exterior_photo_urls, qr_slug
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        businessId, userId, payload.name, payload.tagline, payload.description, payload.businessType,
        payload.ownerName, payload.mobile, payload.whatsapp, payload.email,
        payload.city, payload.pincode, payload.landmark, payload.address, payload.mapLink,
        payload.operatingHours, payload.weeklyOff, payload.brandColor,
        payload.instagram, payload.facebook, payload.website, payload.googleReview,
        logo.url,
        cover.url,
        JSON.stringify(interior.urls),
        JSON.stringify(exterior.urls),
        qrSlug,
      ],
    },
    {
      sql: `INSERT INTO branches (id, business_id, name, city, address, is_primary) VALUES (?, ?, ?, ?, ?, 1)`,
      args: [branchId, businessId, branchName, branchCity, branchAddress],
    },
  ])

  const qrCodeDataUrl = await QRCode.toDataURL(joinUrl, {
    margin: 2,
    width: 400,
    color: { dark: '#1A1840', light: '#FFFFFF' },
  })

  return { businessId, qrSlug, joinUrl, qrCodeDataUrl }
}

export async function getBusinessById(id: string) {
  const result = await db.execute({
    sql: 'SELECT * FROM businesses WHERE id = ?',
    args: [id],
  })
  return result.rows[0] ?? null
}

export async function getBusinessByQrSlug(slug: string) {
  const result = await db.execute({
    sql: 'SELECT * FROM businesses WHERE qr_slug = ?',
    args: [slug],
  })
  return result.rows[0] ?? null
}
