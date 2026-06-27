import { Router } from 'express'
import express from 'express'
import { z } from 'zod'
import { requireAuth } from '../middleware/auth.js'
import { getBusinessForUser } from '../services/auth.js'
import {
  buildTempUploadKey,
  buildUploadKey,
  createPresignedUploadUrl,
  uploadBufferToR2,
  type UploadPurpose,
} from '../services/r2-storage.js'

const router = Router()

const presignSchema = z.object({
  purpose: z.enum(['logo', 'cover', 'interior', 'exterior']),
  contentType: z.string().min(1),
  index: z.number().int().min(0).optional(),
})

const directQuerySchema = z.object({
  purpose: z.enum(['logo', 'cover', 'interior', 'exterior']),
  index: z.coerce.number().int().min(0).optional(),
})

const imageBodyParser = express.raw({
  limit: '5mb',
  type: ['image/jpeg', 'image/png', 'image/webp', 'image/gif'],
})

async function handleDirectUpload(
  req: express.Request,
  res: express.Response,
  buildKey: (purpose: UploadPurpose, contentType: string, index?: number) => string,
) {
  try {
    const parsed = directQuerySchema.safeParse(req.query)
    if (!parsed.success) {
      return res.status(422).json({ error: 'Validation failed', details: parsed.error.flatten().fieldErrors })
    }

    const buffer = req.body
    if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
      return res.status(400).json({ error: 'Empty image body' })
    }

    const contentType = (req.headers['content-type'] || 'image/jpeg').split(';')[0].trim()
    const purpose = parsed.data.purpose as UploadPurpose
    const key = buildKey(purpose, contentType, parsed.data.index)
    const publicUrl = await uploadBufferToR2(key, buffer, contentType)

    res.json({ success: true, data: { publicUrl, key } })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Failed to upload image' })
  }
}

/** Upload via API (no R2 CORS required — preferred for browser uploads). */
router.post('/direct', requireAuth, imageBodyParser, async (req, res) => {
  const business = await getBusinessForUser(req.user!.id)
  if (!business) {
    return res.status(404).json({ error: 'Complete onboarding first' })
  }
  const businessId = business.id as string
  await handleDirectUpload(req, res, (purpose, contentType, index) =>
    buildUploadKey(businessId, purpose, contentType, index),
  )
})

router.post('/direct/onboarding', imageBodyParser, async (req, res) => {
  await handleDirectUpload(req, res, (purpose, contentType, index) =>
    buildTempUploadKey(purpose, contentType, index),
  )
})

router.post('/presign', requireAuth, async (req, res) => {
  try {
    const parsed = presignSchema.safeParse(req.body)
    if (!parsed.success) {
      return res.status(422).json({ error: 'Validation failed', details: parsed.error.flatten().fieldErrors })
    }

    const business = await getBusinessForUser(req.user!.id)
    if (!business) {
      return res.status(404).json({ error: 'Complete onboarding first' })
    }

    const purpose = parsed.data.purpose as UploadPurpose
    const key = buildUploadKey(
      business.id as string,
      purpose,
      parsed.data.contentType,
      parsed.data.index,
    )
    const result = await createPresignedUploadUrl({
      key,
      contentType: parsed.data.contentType,
    })

    res.json({ success: true, data: result })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Failed to create upload URL' })
  }
})

/** Onboarding — business may not exist yet. */
router.post('/presign/onboarding', async (req, res) => {
  try {
    const parsed = presignSchema.safeParse(req.body)
    if (!parsed.success) {
      return res.status(422).json({ error: 'Validation failed', details: parsed.error.flatten().fieldErrors })
    }

    const purpose = parsed.data.purpose as UploadPurpose
    const key = buildTempUploadKey(purpose, parsed.data.contentType, parsed.data.index)
    const result = await createPresignedUploadUrl({
      key,
      contentType: parsed.data.contentType,
    })

    res.json({ success: true, data: result })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Failed to create upload URL' })
  }
})

export default router
