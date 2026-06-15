import { Router } from 'express'
import { requireAuth, requireCustomerAuth } from '../middleware/auth.js'
import {
  createCampaignSchema,
  updateCampaignSchema,
  createCampaign,
  updateCampaign,
  listCampaignsForBusiness,
  getCampaignForBusiness,
  getCampaignPinForBusiness,
  listBusinessesWithActiveCampaigns,
  getPublicCampaign,
  verifyCampaignPin,
  getPlayState,
  executeShakePlay,
  listCustomerRewards,
} from '../services/campaigns.js'

const router = Router()

// ── Static paths first (before /:id) ─────────────────────────────────────────

router.get('/public/businesses', async (_req, res) => {
  try {
    const businesses = await listBusinessesWithActiveCampaigns()
    res.json({ success: true, data: businesses })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Failed to list businesses' })
  }
})

router.get('/customer/rewards', requireCustomerAuth, async (req, res) => {
  try {
    const rewards = await listCustomerRewards(req.user!.id)
    res.json({ success: true, data: rewards })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Failed to fetch rewards' })
  }
})

// ── Vendor (business) ─────────────────────────────────────────────────────────

router.get('/', requireAuth, async (req, res) => {
  try {
    const campaigns = await listCampaignsForBusiness(req.user!.id)
    res.json({ success: true, data: campaigns })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'LIST_FAILED'
    if (message === 'BUSINESS_NOT_FOUND') {
      return res.status(404).json({ error: 'Complete onboarding first' })
    }
    console.error(err)
    res.status(500).json({ error: 'Failed to list campaigns' })
  }
})

router.post('/', requireAuth, async (req, res) => {
  try {
    const parsed = createCampaignSchema.safeParse(req.body)
    if (!parsed.success) {
      return res.status(422).json({
        error: 'Validation failed',
        details: parsed.error.flatten().fieldErrors,
      })
    }
    const campaign = await createCampaign(req.user!.id, parsed.data)
    res.status(201).json({ success: true, data: campaign })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'CREATE_FAILED'
    if (message === 'BUSINESS_NOT_FOUND') {
      return res.status(404).json({ error: 'Complete onboarding first' })
    }
    if (message === 'REWARD_SHARES_MUST_SUM_100') {
      return res.status(422).json({ error: 'Reward shares must sum to exactly 100%' })
    }
    console.error(err)
    res.status(500).json({ error: 'Failed to create campaign' })
  }
})

router.get('/public/:id', async (req, res) => {
  try {
    const campaign = await getPublicCampaign(String(req.params.id))
    res.json({ success: true, data: campaign })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'FETCH_FAILED'
    if (message === 'CAMPAIGN_NOT_FOUND' || message === 'CAMPAIGN_NOT_ACTIVE') {
      return res.status(404).json({ error: 'Campaign not available' })
    }
    console.error(err)
    res.status(500).json({ error: 'Failed to fetch campaign' })
  }
})

router.get('/:id/pin', requireAuth, async (req, res) => {
  try {
    const pin = await getCampaignPinForBusiness(req.user!.id, String(req.params.id))
    res.json({ success: true, data: pin })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'PIN_FAILED'
    if (message === 'CAMPAIGN_NOT_FOUND' || message === 'BUSINESS_NOT_FOUND') {
      return res.status(404).json({ error: 'Campaign not found' })
    }
    console.error(err)
    res.status(500).json({ error: 'Failed to fetch PIN' })
  }
})

router.get('/:id', requireAuth, async (req, res) => {
  try {
    const campaign = await getCampaignForBusiness(req.user!.id, String(req.params.id))
    res.json({ success: true, data: campaign })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'FETCH_FAILED'
    if (message === 'CAMPAIGN_NOT_FOUND' || message === 'BUSINESS_NOT_FOUND') {
      return res.status(404).json({ error: 'Campaign not found' })
    }
    console.error(err)
    res.status(500).json({ error: 'Failed to fetch campaign' })
  }
})

router.patch('/:id', requireAuth, async (req, res) => {
  try {
    const parsed = updateCampaignSchema.safeParse(req.body)
    if (!parsed.success) {
      return res.status(422).json({
        error: 'Validation failed',
        details: parsed.error.flatten().fieldErrors,
      })
    }
    const campaign = await updateCampaign(req.user!.id, String(req.params.id), parsed.data)
    res.json({ success: true, data: campaign })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'UPDATE_FAILED'
    if (message === 'CAMPAIGN_NOT_FOUND' || message === 'BUSINESS_NOT_FOUND') {
      return res.status(404).json({ error: 'Campaign not found' })
    }
    if (message === 'CAMPAIGN_ENDED' || message === 'CANNOT_REACTIVATE_ENDED') {
      return res.status(403).json({ error: 'This campaign has ended and cannot be changed' })
    }
    if (message === 'USER_CAP_BELOW_CURRENT') {
      return res.status(422).json({ error: 'User cap cannot be below the number of players who already joined' })
    }
    if (message === 'END_DATE_BEFORE_START') {
      return res.status(422).json({ error: 'End date must be on or after start date' })
    }
    if (message === 'REWARD_SHARES_MUST_SUM_100') {
      return res.status(422).json({ error: 'Reward shares must sum to exactly 100%' })
    }
    console.error(err)
    res.status(500).json({ error: 'Failed to update campaign' })
  }
})

// ── Customer play ─────────────────────────────────────────────────────────────

router.post('/:id/verify-pin', requireCustomerAuth, async (req, res) => {
  try {
    const pin = String(req.body?.pin ?? '')
    if (!/^\d{3}$/.test(pin)) {
      return res.status(422).json({ error: 'PIN must be 3 digits' })
    }
    const result = await verifyCampaignPin(String(req.params.id), pin, req.user!.id)
    res.json({ success: true, data: result })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'VERIFY_FAILED'
    if (message === 'INVALID_PIN') {
      return res.status(422).json({ error: 'Wrong PIN. Ask staff for the current PIN.' })
    }
    if (message === 'CAMPAIGN_NOT_ACTIVE') {
      return res.status(403).json({ error: 'Campaign is not active' })
    }
    console.error(err)
    res.status(500).json({ error: 'Failed to verify PIN' })
  }
})

router.get('/:id/play-state', requireCustomerAuth, async (req, res) => {
  try {
    const state = await getPlayState(String(req.params.id), req.user!.id)
    res.json({ success: true, data: state })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'STATE_FAILED'
    if (message === 'CAMPAIGN_NOT_FOUND') {
      return res.status(404).json({ error: 'Campaign not found' })
    }
    console.error(err)
    res.status(500).json({ error: 'Failed to get play state' })
  }
})

router.post('/:id/shake', requireCustomerAuth, async (req, res) => {
  try {
    const playSessionToken = String(req.body?.playSessionToken ?? '')
    if (!playSessionToken) {
      return res.status(422).json({ error: 'Play session required. Enter PIN first.' })
    }
    const result = await executeShakePlay(String(req.params.id), req.user!.id, playSessionToken)
    res.json({ success: true, data: result })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'SHAKE_FAILED'
    if (message === 'INVALID_PLAY_SESSION') {
      return res.status(401).json({ error: 'Session expired. Enter PIN again.' })
    }
    if (message === 'NO_PLAYS_REMAINING') {
      return res.status(403).json({ error: 'No plays remaining today' })
    }
    if (message === 'CAMPAIGN_NOT_ACTIVE') {
      return res.status(403).json({ error: 'Campaign is not active' })
    }
    if (message === 'USER_CAP_REACHED' || message === 'DAILY_LIMIT_REACHED') {
      return res.status(403).json({ error: message === 'USER_CAP_REACHED' ? 'Campaign is full' : 'Daily limit reached' })
    }
    console.error(err)
    res.status(500).json({ error: 'Failed to process shake' })
  }
})

export default router
