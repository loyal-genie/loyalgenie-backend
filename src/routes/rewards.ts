import { Router } from 'express'
import { requireAuth, requireCustomerAuth } from '../middleware/auth.js'
import {
  createBusinessRewardSchema,
  updateBusinessRewardSchema,
  rewardCategorySchema,
  listBusinessRewards,
  createBusinessReward,
  updateBusinessReward,
  getBusinessReward,
  deleteBusinessReward,
  listRewardCategories,
  createRewardCategory,
  getRewardsOverview,
  listVendorRedeemedRewards,
  listCustomerBusinessRewards,
  claimCustomerBusinessReward,
} from '../services/rewards.js'

const router = Router()

router.get('/categories', requireAuth, async (req, res) => {
  try {
    const categories = await listRewardCategories(req.user!.id)
    res.json({ success: true, data: categories })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Failed to fetch categories' })
  }
})

router.post('/categories', requireAuth, async (req, res) => {
  const parsed = rewardCategorySchema.safeParse(req.body)
  if (!parsed.success) {
    return res.status(422).json({ error: 'Validation failed', details: parsed.error.flatten().fieldErrors })
  }
  try {
    const category = await createRewardCategory(req.user!.id, parsed.data)
    res.status(201).json({ success: true, data: category })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Failed to create category' })
  }
})

router.get('/overview', requireAuth, async (req, res) => {
  try {
    const stats = await getRewardsOverview(req.user!.id)
    res.json({ success: true, data: stats })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Failed to fetch rewards overview' })
  }
})

router.get('/', requireAuth, async (req, res) => {
  try {
    const status = req.query.status as 'active' | 'expired' | 'depleted' | undefined
    const rewards = await listBusinessRewards(req.user!.id, status)
    res.json({ success: true, data: rewards })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Failed to fetch rewards' })
  }
})

router.post('/', requireAuth, async (req, res) => {
  const parsed = createBusinessRewardSchema.safeParse(req.body)
  if (!parsed.success) {
    return res.status(422).json({ error: 'Validation failed', details: parsed.error.flatten().fieldErrors })
  }
  try {
    const reward = await createBusinessReward(req.user!.id, parsed.data)
    res.status(201).json({ success: true, data: reward })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'CREATE_FAILED'
    if (message === 'REDEEM_FIXED_DATE_REQUIRED' || message === 'REDEEM_RELATIVE_REQUIRED') {
      return res.status(422).json({ error: message })
    }
    if (message === 'CATEGORY_NOT_FOUND') return res.status(404).json({ error: 'Category not found' })
    console.error(err)
    res.status(500).json({ error: 'Failed to create reward' })
  }
})

router.get('/redeemed', requireAuth, async (req, res) => {
  try {
    const fromDate = req.query.fromDate as string | undefined
    const toDate = req.query.toDate as string | undefined
    const rows = await listVendorRedeemedRewards(req.user!.id, fromDate, toDate)
    res.json({ success: true, data: rows })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Failed to fetch redeemed rewards' })
  }
})

router.get('/customer/business/:businessId', requireCustomerAuth, async (req, res) => {
  try {
    const data = await listCustomerBusinessRewards(req.user!.id, String(req.params.businessId))
    res.json({ success: true, data })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Failed to fetch available rewards' })
  }
})

router.post('/customer/:rewardId/claim', requireCustomerAuth, async (req, res) => {
  try {
    const result = await claimCustomerBusinessReward(req.user!.id, String(req.params.rewardId))
    res.json({ success: true, data: result })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'CLAIM_FAILED'
    if (message === 'REWARD_NOT_FOUND') return res.status(404).json({ error: 'Reward not found' })
    if (message === 'INSUFFICIENT_POINTS') return res.status(422).json({ error: 'Not enough points' })
    if (message === 'REWARD_EXHAUSTED' || message === 'REWARD_NOT_AVAILABLE') {
      return res.status(422).json({ error: 'Reward not available' })
    }
    console.error(err)
    res.status(500).json({ error: 'Failed to claim reward' })
  }
})

router.get('/:id', requireAuth, async (req, res) => {
  try {
    const reward = await getBusinessReward(req.user!.id, String(req.params.id))
    res.json({ success: true, data: reward })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'FETCH_FAILED'
    if (message === 'REWARD_NOT_FOUND') return res.status(404).json({ error: 'Reward not found' })
    console.error(err)
    res.status(500).json({ error: 'Failed to fetch reward' })
  }
})

router.patch('/:id', requireAuth, async (req, res) => {
  const parsed = updateBusinessRewardSchema.safeParse(req.body)
  if (!parsed.success) {
    return res.status(422).json({ error: 'Validation failed', details: parsed.error.flatten().fieldErrors })
  }
  try {
    const reward = await updateBusinessReward(req.user!.id, String(req.params.id), parsed.data)
    res.json({ success: true, data: reward })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'UPDATE_FAILED'
    if (message === 'REWARD_NOT_FOUND') return res.status(404).json({ error: 'Reward not found' })
    if (message === 'NOTHING_TO_UPDATE') return res.status(422).json({ error: 'No fields to update' })
    if (message === 'REDEEM_FIXED_DATE_REQUIRED' || message === 'REDEEM_RELATIVE_REQUIRED') {
      return res.status(422).json({ error: message })
    }
    console.error(err)
    res.status(500).json({ error: 'Failed to update reward' })
  }
})

router.delete('/:id', requireAuth, async (req, res) => {
  try {
    await deleteBusinessReward(req.user!.id, String(req.params.id))
    res.json({ success: true })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'DELETE_FAILED'
    if (message === 'REWARD_NOT_FOUND') return res.status(404).json({ error: 'Reward not found' })
    console.error(err)
    res.status(500).json({ error: 'Failed to delete reward' })
  }
})

export default router
