import { Router } from 'express'
import {
  completeOnboarding,
  getBusinessById,
  getBusinessByQrSlug,
  onboardingSchema,
} from '../services/onboarding.js'
import { signToken, verifyToken, getUserByEmail } from '../services/auth.js'

const router = Router()

function getUserFromRequest(req: { headers: { authorization?: string } }) {
  const header = req.headers.authorization
  if (!header?.startsWith('Bearer ')) return null
  return verifyToken(header.slice(7), 'business')
}

router.post('/complete', async (req, res) => {
  try {
    const authUser = getUserFromRequest(req)
    const parsed = onboardingSchema.safeParse(req.body)
    if (!parsed.success) {
      return res.status(422).json({
        error: 'Validation failed',
        details: parsed.error.flatten().fieldErrors,
      })
    }

    const frontendBaseUrl = process.env.FRONTEND_URL ?? 'http://localhost:3000'
    const result = await completeOnboarding(parsed.data, frontendBaseUrl, authUser?.id)

    const user = await getUserByEmail(parsed.data.email)
    const token = user
      ? signToken({ id: user.id as string, email: user.email as string, role: 'business' })
      : undefined

    res.status(201).json({
      success: true,
      data: { ...result, token },
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'ONBOARDING_FAILED'
    if (message === 'EMAIL_EXISTS') {
      return res.status(409).json({ error: 'An account with this email already exists. Sign in instead.' })
    }
    if (message === 'ALREADY_ONBOARDED') {
      return res.status(409).json({ error: 'You have already completed onboarding' })
    }
    console.error('Onboarding error:', err)
    res.status(500).json({ error: 'Failed to complete onboarding' })
  }
})

router.get('/business/:id', async (req, res) => {
  try {
    const business = await getBusinessById(req.params.id)
    if (!business) return res.status(404).json({ error: 'Business not found' })
    res.json({ data: business })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Failed to fetch business' })
  }
})

router.get('/qr/:slug', async (req, res) => {
  try {
    const business = await getBusinessByQrSlug(req.params.slug)
    if (!business) return res.status(404).json({ error: 'Business not found' })
    const frontendBaseUrl = process.env.FRONTEND_URL ?? 'http://localhost:3000'
    const joinUrl = `${frontendBaseUrl.replace(/\/$/, '')}/${req.params.slug}`
    const QRCode = (await import('qrcode')).default
    const qrCodeDataUrl = await QRCode.toDataURL(joinUrl, {
      margin: 2,
      width: 400,
      color: { dark: '#1A1840', light: '#FFFFFF' },
    })
    res.json({ data: { ...business, joinUrl, qrCodeDataUrl } })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Failed to fetch business' })
  }
})

export default router
