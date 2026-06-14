import { Router } from 'express'
import { requireAuth } from '../middleware/auth.js'
import {
  businessUpdateSchema,
  getBusinessProfileForUser,
  getBusinessQrForUser,
  updateBusinessProfile,
} from '../services/business.js'

const router = Router()

router.get('/me', requireAuth, async (req, res) => {
  try {
    const profile = await getBusinessProfileForUser(req.user!.id)
    if (!profile) {
      return res.status(404).json({ error: 'Business profile not found. Complete onboarding first.' })
    }
    res.json({ success: true, data: profile })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Failed to fetch business profile' })
  }
})

router.patch('/me', requireAuth, async (req, res) => {
  try {
    const parsed = businessUpdateSchema.safeParse(req.body)
    if (!parsed.success) {
      return res.status(422).json({
        error: 'Validation failed',
        details: parsed.error.flatten().fieldErrors,
      })
    }

    const profile = await updateBusinessProfile(req.user!.id, parsed.data)
    res.json({ success: true, data: profile })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'UPDATE_FAILED'
    if (message === 'BUSINESS_NOT_FOUND') {
      return res.status(404).json({ error: 'Business profile not found' })
    }
    console.error(err)
    res.status(500).json({ error: 'Failed to update business profile' })
  }
})

router.get('/me/qr', requireAuth, async (req, res) => {
  try {
    const frontendBaseUrl = process.env.FRONTEND_URL ?? 'http://localhost:5173'
    const qr = await getBusinessQrForUser(req.user!.id, frontendBaseUrl)
    res.json({ success: true, data: qr })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'QR_FAILED'
    if (message === 'BUSINESS_NOT_FOUND') {
      return res.status(404).json({ error: 'Business profile not found' })
    }
    console.error(err)
    res.status(500).json({ error: 'Failed to generate QR code' })
  }
})

export default router
