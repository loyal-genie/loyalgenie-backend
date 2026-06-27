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
  normalizePin,
  getPlayState,
  type UpdateCampaignPayload,
  executeShakePlay,
  listCustomerRewards,
  requestCustomerRedemption,
} from '../services/campaigns.js'
import {
  getStampState,
  executeStampCollect,
} from '../services/stamp-cards.js'
import {
  getLoyaltyState,
  executeCheckIn,
  getPendingCheckInPrompt,
  listCustomerLoyaltyProfiles,
} from '../services/check-in-loyalty.js'
import { getBusinessCampaignStates } from '../services/business-campaign-states.js'

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

router.get('/public/businesses/:businessId/states', requireCustomerAuth, async (req, res) => {
  try {
    const states = await getBusinessCampaignStates(String(req.params.businessId), req.user!.id)
    res.json({ success: true, data: states })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Failed to fetch campaign states' })
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

router.post('/customer/rewards/:id/request-redemption', requireCustomerAuth, async (req, res) => {
  try {
    await requestCustomerRedemption(req.user!.id, String(req.params.id))
    res.json({ success: true })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'REQUEST_FAILED'
    if (message === 'REWARD_NOT_FOUND') {
      return res.status(404).json({ error: 'Reward not found' })
    }
    if (message === 'ALREADY_REQUESTED') {
      return res.status(409).json({ error: 'Redemption already requested' })
    }
    if (message === 'ALREADY_REDEEMED') {
      return res.status(409).json({ error: 'Reward already redeemed' })
    }
    console.error(err)
    res.status(500).json({ error: 'Failed to request redemption' })
  }
})

router.get('/customer/loyalty-profile', requireCustomerAuth, async (req, res) => {
  try {
    const profiles = await listCustomerLoyaltyProfiles(req.user!.id)
    res.json({ success: true, data: profiles })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Failed to fetch loyalty profile' })
  }
})

router.get('/customer/check-in-prompt', requireCustomerAuth, async (req, res) => {
  try {
    const prompt = await getPendingCheckInPrompt(req.user!.id)
    res.json({ success: true, data: prompt })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Failed to fetch check-in prompt' })
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
      const flat = parsed.error.flatten()
      const mechanicErr = flat.fieldErrors.mechanic?.[0]
      const message = mechanicErr?.includes('discriminator') || mechanicErr?.includes('Invalid enum')
        ? 'Campaign type not supported by the running API. Rebuild and restart the backend (npm run build && npm start).'
        : 'Validation failed'
      return res.status(422).json({
        error: message,
        details: flat.fieldErrors,
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
    if (message === 'INVALID_STAMP_CONFIG' || message === 'INVALID_STAMP_REWARDS' || message === 'INVALID_STAMP_POOL' || message === 'INVALID_LOYALTY_MILESTONES') {
      return res.status(422).json({ error: message === 'INVALID_LOYALTY_MILESTONES' ? 'Milestone point thresholds must be unique' : 'Invalid stamp card configuration' })
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
    const campaign = await updateCampaign(req.user!.id, String(req.params.id), parsed.data as UpdateCampaignPayload)
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
    if (message === 'INVALID_STAMP_CONFIG' || message === 'INVALID_STAMP_REWARDS' || message === 'INVALID_STAMP_POOL') {
      return res.status(422).json({ error: 'Invalid stamp card configuration' })
    }
    if (message === 'INVALID_LOYALTY_MILESTONES') {
      return res.status(422).json({ error: 'Milestone point thresholds must be unique' })
    }
    console.error(err)
    res.status(500).json({ error: 'Failed to update campaign' })
  }
})

// ── Customer play ─────────────────────────────────────────────────────────────

router.post('/:id/verify-pin', requireCustomerAuth, async (req, res) => {
  try {
    const normalizedPin = normalizePin(String(req.body?.pin ?? ''))
    if (!/^\d{3}$/.test(normalizedPin)) {
      return res.status(422).json({ error: 'PIN must be 3 digits' })
    }
    const result = await verifyCampaignPin(String(req.params.id), normalizedPin, req.user!.id)
    res.json({ success: true, data: result })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'VERIFY_FAILED'
    if (message === 'INVALID_PIN') {
      return res.status(422).json({
        error: 'Wrong or expired PIN. Ask staff to check the live PIN on their dashboard.',
      })
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

router.get('/:id/stamp-state', requireCustomerAuth, async (req, res) => {
  try {
    const state = await getStampState(String(req.params.id), req.user!.id)
    res.json({ success: true, data: state })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'STATE_FAILED'
    if (message === 'CAMPAIGN_NOT_FOUND' || message === 'NOT_STAMP_CAMPAIGN') {
      return res.status(404).json({ error: 'Campaign not found' })
    }
    console.error(err)
    res.status(500).json({ error: 'Failed to get stamp state' })
  }
})

router.post('/:id/stamp', requireCustomerAuth, async (req, res) => {
  try {
    const playSessionToken = String(req.body?.playSessionToken ?? '')
    if (!playSessionToken) {
      return res.status(422).json({ error: 'Play session required. Enter PIN first.' })
    }
    const result = await executeStampCollect(String(req.params.id), req.user!.id, playSessionToken)
    res.json({ success: true, data: result })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'STAMP_FAILED'
    if (message === 'INVALID_PLAY_SESSION') {
      return res.status(401).json({ error: 'Session expired. Enter PIN again.' })
    }
    if (message === 'USER_CAP_REACHED') {
      return res.status(403).json({ error: 'Campaign is full' })
    }
    if (message === 'STAMP_ALREADY_COLLECTED_TODAY') {
      return res.status(403).json({ error: 'You already collected your stamp today' })
    }
    if (message === 'CARD_EXPIRED' || message === 'CLAIM_PERIOD_ENDED') {
      return res.status(403).json({ error: 'Your stamp card has expired' })
    }
    if (message === 'CARD_COMPLETE') {
      return res.status(403).json({ error: 'Your stamp card is complete' })
    }
    if (message === 'CAMPAIGN_NOT_ACTIVE') {
      return res.status(403).json({ error: 'Campaign is not active' })
    }
    console.error(err)
    res.status(500).json({ error: 'Failed to collect stamp' })
  }
})

router.get('/:id/loyalty-state', requireCustomerAuth, async (req, res) => {
  try {
    const state = await getLoyaltyState(String(req.params.id), req.user!.id)
    res.json({ success: true, data: state })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'STATE_FAILED'
    if (message === 'CAMPAIGN_NOT_FOUND' || message === 'NOT_LOYALTY_CAMPAIGN') {
      return res.status(404).json({ error: 'Campaign not found' })
    }
    console.error(err)
    res.status(500).json({ error: 'Failed to get loyalty state' })
  }
})

router.post('/:id/check-in', requireCustomerAuth, async (req, res) => {
  try {
    const playSessionToken = String(req.body?.playSessionToken ?? '')
    if (!playSessionToken) {
      return res.status(422).json({ error: 'Play session required. Enter PIN first.' })
    }
    const result = await executeCheckIn(String(req.params.id), req.user!.id, playSessionToken)
    res.json({ success: true, data: result })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'CHECK_IN_FAILED'
    if (message === 'INVALID_PLAY_SESSION') {
      return res.status(401).json({ error: 'Session expired. Enter PIN again.' })
    }
    if (message === 'USER_CAP_REACHED') {
      return res.status(403).json({ error: 'Campaign is full' })
    }
    if (message === 'ALREADY_CHECKED_IN_TODAY') {
      return res.status(403).json({ error: 'You already checked in today' })
    }
    if (message === 'CAMPAIGN_NOT_ACTIVE') {
      return res.status(403).json({ error: 'Campaign is not active' })
    }
    console.error(err)
    res.status(500).json({ error: 'Failed to check in' })
  }
})

export default router
