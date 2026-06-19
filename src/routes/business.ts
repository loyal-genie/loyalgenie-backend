import { Router } from 'express'
import { requireAuth } from '../middleware/auth.js'
import {
  businessUpdateSchema,
  getBusinessProfileForUser,
  getBusinessQrForUser,
  updateBusinessProfile,
} from '../services/business.js'
import {
  getVendorDashboardStats,
  listVendorCustomers,
  getVendorCustomer,
  listPendingRedemptions,
  markRedemptionRedeemed,
} from '../services/vendor-analytics.js'
import { getPrimaryFrontendUrl } from '../utils/frontend-url.js'

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
    const frontendBaseUrl = getPrimaryFrontendUrl()
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

router.get('/dashboard/stats', requireAuth, async (req, res) => {
  try {
    const stats = await getVendorDashboardStats(req.user!.id)
    res.json({ success: true, data: stats })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'STATS_FAILED'
    if (message === 'BUSINESS_NOT_FOUND') {
      return res.status(404).json({ error: 'Complete onboarding first' })
    }
    console.error(err)
    res.status(500).json({ error: 'Failed to fetch dashboard stats' })
  }
})

router.get('/customers', requireAuth, async (req, res) => {
  try {
    const customers = await listVendorCustomers(req.user!.id)
    res.json({ success: true, data: customers })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'LIST_FAILED'
    if (message === 'BUSINESS_NOT_FOUND') {
      return res.status(404).json({ error: 'Complete onboarding first' })
    }
    console.error(err)
    res.status(500).json({ error: 'Failed to list customers' })
  }
})

router.get('/customers/:id', requireAuth, async (req, res) => {
  try {
    const customer = await getVendorCustomer(req.user!.id, String(req.params.id))
    res.json({ success: true, data: customer })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'FETCH_FAILED'
    if (message === 'CUSTOMER_NOT_FOUND' || message === 'BUSINESS_NOT_FOUND') {
      return res.status(404).json({ error: 'Customer not found' })
    }
    console.error(err)
    res.status(500).json({ error: 'Failed to fetch customer' })
  }
})

router.get('/redemptions/pending', requireAuth, async (req, res) => {
  try {
    const items = await listPendingRedemptions(req.user!.id)
    res.json({ success: true, data: items })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'LIST_FAILED'
    if (message === 'BUSINESS_NOT_FOUND') {
      return res.status(404).json({ error: 'Complete onboarding first' })
    }
    console.error(err)
    res.status(500).json({ error: 'Failed to list redemptions' })
  }
})

router.patch('/redemptions/:id/redeem', requireAuth, async (req, res) => {
  try {
    await markRedemptionRedeemed(req.user!.id, String(req.params.id))
    res.json({ success: true })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'REDEEM_FAILED'
    if (message === 'REWARD_NOT_FOUND' || message === 'BUSINESS_NOT_FOUND') {
      return res.status(404).json({ error: 'Reward not found' })
    }
    console.error(err)
    res.status(500).json({ error: 'Failed to mark redeemed' })
  }
})

export default router
