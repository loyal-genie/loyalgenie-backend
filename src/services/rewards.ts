import { nanoid } from 'nanoid'
import { z } from 'zod'
import { computeRedeemExpiryDate, validateRedeemExpiryConfig } from '../utils/redeem-expiry.js'
import { db } from '../db/client.js'
import { getBusinessForUser } from './auth.js'
import { invalidateBusinessAnalyticsCaches } from './vendor-analytics.js'
import { nowInCampaignTz, todayInCampaignTz } from '../utils/campaign-dates.js'

const rewardStatusSchema = z.enum(['active', 'expired', 'depleted'])
const redeemExpiryModeSchema = z.enum(['fixed', 'relative'])
const redeemRelativeUnitSchema = z.enum(['day', 'week', 'month'])

export const rewardCategorySchema = z.object({
  name: z.string().trim().min(1).max(64),
})

export const createBusinessRewardSchema = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(500).optional().default(''),
  icon: z.string().trim().min(1).max(80).optional().default('gift'),
  categoryId: z.string().optional(),
  categoryName: z.string().trim().max(64).optional(),
  pointsRequired: z.number().int().min(1).max(100000),
  maxClaims: z.number().int().min(1).max(100000).optional(),
  claimBefore: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  redeemExpiryMode: redeemExpiryModeSchema,
  redeemFixedDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  redeemRelativeAmount: z.number().int().min(1).max(365).optional(),
  redeemRelativeUnit: redeemRelativeUnitSchema.optional(),
  redemptionInstructions: z.string().trim().max(500).optional().default(''),
})

export const updateBusinessRewardSchema = createBusinessRewardSchema.partial().extend({
  status: rewardStatusSchema.optional(),
})

type CreateBusinessRewardPayload = z.infer<typeof createBusinessRewardSchema>
type UpdateBusinessRewardPayload = z.infer<typeof updateBusinessRewardSchema>

function assertRedeemExpiry(payload: CreateBusinessRewardPayload | UpdateBusinessRewardPayload): void {
  if (!payload.redeemExpiryMode) return
  try {
    validateRedeemExpiryConfig(
      payload.redeemExpiryMode,
      payload.redeemFixedDate,
      payload.redeemRelativeAmount,
      payload.redeemRelativeUnit,
    )
  } catch {
    throw new Error('REDEEM_BEFORE_REQUIRED')
  }
}

async function getBusinessIdForUser(userId: string): Promise<string> {
  const business = await getBusinessForUser(userId)
  if (!business) throw new Error('BUSINESS_NOT_FOUND')
  return business.id as string
}

async function ensureCategory(
  businessId: string,
  categoryId?: string,
  categoryName?: string,
): Promise<string | null> {
  if (categoryId) {
    const existing = await db.execute({
      sql: 'SELECT id FROM reward_categories WHERE id = ? AND business_id = ?',
      args: [categoryId, businessId],
    })
    if (!existing.rows[0]) throw new Error('CATEGORY_NOT_FOUND')
    return categoryId
  }

  const trimmed = categoryName?.trim()
  if (!trimmed) return null

  const existing = await db.execute({
    sql: `SELECT id FROM reward_categories
          WHERE business_id = ? AND lower(name) = lower(?)
          LIMIT 1`,
    args: [businessId, trimmed],
  })
  if (existing.rows[0]) return existing.rows[0].id as string

  const id = nanoid()
  await db.execute({
    sql: `INSERT INTO reward_categories (id, business_id, name, created_at)
          VALUES (?, ?, ?, datetime('now'))`,
    args: [id, businessId, trimmed],
  })
  return id
}

function resolveRewardStatus(row: Record<string, unknown>): 'active' | 'expired' | 'depleted' {
  const status = (row.status as string) ?? 'active'
  if (status === 'depleted' || status === 'expired') return status
  const maxClaims = row.max_claims != null ? Number(row.max_claims) : null
  const claimsCount = Number(row.claims_count ?? 0)
  if (maxClaims !== null && claimsCount >= maxClaims) return 'depleted'
  const claimBefore = row.claim_before as string | null
  if (claimBefore && todayInCampaignTz() > claimBefore) return 'expired'
  return 'active'
}

export async function listRewardCategories(userId: string) {
  const businessId = await getBusinessIdForUser(userId)
  const result = await db.execute({
    sql: `SELECT id, name, created_at
          FROM reward_categories
          WHERE business_id = ?
          ORDER BY lower(name) ASC`,
    args: [businessId],
  })
  return result.rows.map(row => ({
    id: row.id as string,
    name: row.name as string,
    createdAt: row.created_at as string,
  }))
}

export async function createRewardCategory(userId: string, payload: z.infer<typeof rewardCategorySchema>) {
  const businessId = await getBusinessIdForUser(userId)
  return {
    id: await ensureCategory(businessId, undefined, payload.name),
    name: payload.name.trim(),
  }
}

export async function listBusinessRewards(userId: string, status?: 'active' | 'expired' | 'depleted') {
  const businessId = await getBusinessIdForUser(userId)
  const result = await db.execute({
    sql: `SELECT br.*, rc.name AS category_name
          FROM business_rewards br
          LEFT JOIN reward_categories rc ON rc.id = br.category_id
          WHERE br.business_id = ?
          ORDER BY br.created_at DESC`,
    args: [businessId],
  })

  const items = result.rows.map(row => {
    const effectiveStatus = resolveRewardStatus(row)
    return {
      id: row.id as string,
      name: row.name as string,
      description: (row.description as string) ?? '',
      icon: (row.icon as string) ?? 'gift',
      categoryId: (row.category_id as string) ?? null,
      categoryName: (row.category_name as string) ?? null,
      pointsRequired: Number(row.points_required ?? 0),
      maxClaims: row.max_claims != null ? Number(row.max_claims) : null,
      claimsCount: Number(row.claims_count ?? 0),
      claimBefore: (row.claim_before as string) ?? null,
      redeemExpiryMode: row.redeem_expiry_mode as 'fixed' | 'relative',
      redeemFixedDate: (row.redeem_fixed_date as string) ?? null,
      redeemRelativeAmount: row.redeem_relative_amount != null ? Number(row.redeem_relative_amount) : null,
      redeemRelativeUnit: (row.redeem_relative_unit as 'day' | 'week' | 'month' | null) ?? null,
      redemptionInstructions: (row.redemption_instructions as string) ?? '',
      status: effectiveStatus,
      createdAt: row.created_at as string,
    }
  })

  return status ? items.filter(item => item.status === status) : items
}

export async function createBusinessReward(userId: string, payload: CreateBusinessRewardPayload) {
  const businessId = await getBusinessIdForUser(userId)
  assertRedeemExpiry(payload)
  const categoryId = await ensureCategory(businessId, payload.categoryId, payload.categoryName)
  const id = nanoid()
  await db.execute({
    sql: `INSERT INTO business_rewards
          (id, business_id, category_id, name, description, icon, points_required, max_claims, claims_count,
           claim_before, redeem_expiry_mode, redeem_fixed_date, redeem_relative_amount, redeem_relative_unit,
           redemption_instructions, status, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, 'active', datetime('now'), datetime('now'))`,
    args: [
      id,
      businessId,
      categoryId,
      payload.name.trim(),
      payload.description?.trim() ?? '',
      payload.icon ?? 'gift',
      payload.pointsRequired,
      payload.maxClaims ?? null,
      payload.claimBefore ?? null,
      payload.redeemExpiryMode,
      payload.redeemFixedDate ?? null,
      payload.redeemRelativeAmount ?? null,
      payload.redeemRelativeUnit ?? null,
      payload.redemptionInstructions?.trim() ?? '',
    ],
  })

  const rows = await listBusinessRewards(userId)
  const created = rows.find(item => item.id === id)
  if (!created) throw new Error('CREATE_FAILED')
  return created
}

export async function updateBusinessReward(userId: string, rewardId: string, payload: UpdateBusinessRewardPayload) {
  const businessId = await getBusinessIdForUser(userId)
  const existing = await db.execute({
    sql: `SELECT id FROM business_rewards WHERE id = ? AND business_id = ?`,
    args: [rewardId, businessId],
  })
  if (!existing.rows[0]) throw new Error('REWARD_NOT_FOUND')

  assertRedeemExpiry(payload)

  const fields: string[] = []
  const args: unknown[] = []

  if (payload.name !== undefined) { fields.push('name = ?'); args.push(payload.name.trim()) }
  if (payload.description !== undefined) { fields.push('description = ?'); args.push(payload.description.trim()) }
  if (payload.icon !== undefined) { fields.push('icon = ?'); args.push(payload.icon) }
  if (payload.pointsRequired !== undefined) { fields.push('points_required = ?'); args.push(payload.pointsRequired) }
  if (payload.maxClaims !== undefined) { fields.push('max_claims = ?'); args.push(payload.maxClaims) }
  if (payload.claimBefore !== undefined) { fields.push('claim_before = ?'); args.push(payload.claimBefore) }
  if (payload.redeemExpiryMode !== undefined) { fields.push('redeem_expiry_mode = ?'); args.push(payload.redeemExpiryMode) }
  if (payload.redeemFixedDate !== undefined) { fields.push('redeem_fixed_date = ?'); args.push(payload.redeemFixedDate) }
  if (payload.redeemRelativeAmount !== undefined) { fields.push('redeem_relative_amount = ?'); args.push(payload.redeemRelativeAmount) }
  if (payload.redeemRelativeUnit !== undefined) { fields.push('redeem_relative_unit = ?'); args.push(payload.redeemRelativeUnit) }
  if (payload.redemptionInstructions !== undefined) { fields.push('redemption_instructions = ?'); args.push(payload.redemptionInstructions.trim()) }
  if (payload.status !== undefined) { fields.push('status = ?'); args.push(payload.status) }
  if (payload.categoryId !== undefined || payload.categoryName !== undefined) {
    const categoryId = await ensureCategory(businessId, payload.categoryId, payload.categoryName)
    fields.push('category_id = ?')
    args.push(categoryId)
  }

  if (fields.length === 0) throw new Error('NOTHING_TO_UPDATE')
  fields.push('updated_at = datetime(\'now\')')
  args.push(rewardId, businessId)

  await db.execute({
    sql: `UPDATE business_rewards SET ${fields.join(', ')} WHERE id = ? AND business_id = ?`,
    args,
  })

  const all = await listBusinessRewards(userId)
  const updated = all.find(item => item.id === rewardId)
  if (!updated) throw new Error('REWARD_NOT_FOUND')
  return updated
}

export async function getBusinessReward(userId: string, rewardId: string) {
  const rewards = await listBusinessRewards(userId)
  const reward = rewards.find(item => item.id === rewardId)
  if (!reward) throw new Error('REWARD_NOT_FOUND')
  return reward
}

export async function deleteBusinessReward(userId: string, rewardId: string) {
  const businessId = await getBusinessIdForUser(userId)
  const existing = await db.execute({
    sql: `SELECT id FROM business_rewards WHERE id = ? AND business_id = ?`,
    args: [rewardId, businessId],
  })
  if (!existing.rows[0]) throw new Error('REWARD_NOT_FOUND')

  await db.execute({
    sql: `DELETE FROM business_rewards WHERE id = ? AND business_id = ?`,
    args: [rewardId, businessId],
  })

  return { success: true }
}

export async function listVendorRedeemedRewards(userId: string, fromDate?: string, toDate?: string) {
  const businessId = await getBusinessIdForUser(userId)
  const conditions: string[] = ['cr.status = \'redeemed\'', 'cr.business_id = ?']
  const args: unknown[] = [businessId]
  if (fromDate) {
    conditions.push('date(cr.redeemed_at) >= ?')
    args.push(fromDate)
  }
  if (toDate) {
    conditions.push('date(cr.redeemed_at) <= ?')
    args.push(toDate)
  }

  const result = await db.execute({
    sql: `SELECT cr.id, cr.reward_name, cr.icon, cr.earned_at, cr.claimed_at, cr.redeemed_at,
                 cr.source_type, cu.name AS customer_name, cu.phone AS customer_phone,
                 c.mechanic, c.name AS campaign_name
          FROM customer_rewards cr
          INNER JOIN customer_users cu ON cu.id = cr.customer_id
          LEFT JOIN campaigns c ON c.id = cr.campaign_id
          WHERE ${conditions.join(' AND ')}
          ORDER BY cr.redeemed_at DESC`,
    args,
  })

  return result.rows.map(row => ({
    id: row.id as string,
    customerName: row.customer_name as string,
    customerPhone: row.customer_phone as string,
    rewardName: row.reward_name as string,
    icon: (row.icon as string) ?? 'gift',
    source: row.source_type === 'points_claim'
      ? 'Rewards'
      : row.mechanic === 'check-in-loyalty'
        ? 'Check-In'
        : row.mechanic === 'stamp'
          ? 'Surprise card'
          : row.campaign_name
            ? 'Shake & Win'
            : 'N/A',
    claimedAt: (row.claimed_at as string) ?? null,
    earnedAt: row.earned_at as string,
    redeemedAt: (row.redeemed_at as string) ?? null,
  }))
}

export async function getRewardsOverview(userId: string) {
  const rewards = await listBusinessRewards(userId)
  const totalRewards = rewards.length
  const activeRewards = rewards.filter(r => r.status === 'active').length
  const expiredRewards = rewards.filter(r => r.status !== 'active').length

  const businessId = await getBusinessIdForUser(userId)
  const redeemed = await db.execute({
    sql: `SELECT COUNT(*) AS c FROM customer_rewards
          WHERE business_id = ? AND status = 'redeemed'`,
    args: [businessId],
  })

  return {
    totalRewards,
    activeRewards,
    totalRedeemed: Number(redeemed.rows[0]?.c ?? 0),
    expiredRewards,
  }
}

export async function listCustomerBusinessRewards(customerId: string, businessId: string) {
  const pointsRes = await db.execute({
    sql: `SELECT points FROM business_customer_points
          WHERE business_id = ? AND customer_id = ?`,
    args: [businessId, customerId],
  })
  const points = Number(pointsRes.rows[0]?.points ?? 0)

  const rewards = await db.execute({
    sql: `SELECT br.*, rc.name AS category_name
          FROM business_rewards br
          LEFT JOIN reward_categories rc ON rc.id = br.category_id
          WHERE br.business_id = ?
          ORDER BY br.created_at DESC`,
    args: [businessId],
  })

  return {
    points,
    rewards: rewards.rows
      .map(row => {
        const status = resolveRewardStatus(row)
        const maxClaims = row.max_claims != null ? Number(row.max_claims) : null
        const claimsCount = Number(row.claims_count ?? 0)
        const availableCount = maxClaims === null ? null : Math.max(0, maxClaims - claimsCount)
        const redeemBefore = computeRedeemExpiryDate(
          row.redeem_expiry_mode as 'fixed' | 'relative',
          (row.redeem_fixed_date as string) ?? null,
          row.redeem_relative_amount != null ? Number(row.redeem_relative_amount) : null,
          (row.redeem_relative_unit as 'day' | 'week' | 'month' | null) ?? null,
        )
        return {
          id: row.id as string,
          name: row.name as string,
          description: (row.description as string) ?? '',
          icon: (row.icon as string) ?? 'gift',
          category: (row.category_name as string) ?? 'General',
          pointsRequired: Number(row.points_required ?? 0),
          availableCount,
          maxClaims,
          claimsCount,
          claimBefore: (row.claim_before as string) ?? null,
          redeemBefore,
          redemptionInstructions: (row.redemption_instructions as string) ?? '',
          status,
          claimable: status === 'active' && points >= Number(row.points_required ?? 0),
          lockedByPoints: points < Number(row.points_required ?? 0),
        }
      })
      .filter(item => item.status === 'active'),
  }
}

export async function claimCustomerBusinessReward(customerId: string, rewardId: string) {
  const rewardRes = await db.execute({
    sql: `SELECT * FROM business_rewards WHERE id = ?`,
    args: [rewardId],
  })
  const reward = rewardRes.rows[0]
  if (!reward) throw new Error('REWARD_NOT_FOUND')

  const status = resolveRewardStatus(reward)
  if (status !== 'active') throw new Error('REWARD_NOT_AVAILABLE')

  const businessId = reward.business_id as string
  const pointsRequired = Number(reward.points_required ?? 0)
  const pointsRes = await db.execute({
    sql: `SELECT id, points FROM business_customer_points
          WHERE business_id = ? AND customer_id = ?`,
    args: [businessId, customerId],
  })
  const pointsRow = pointsRes.rows[0]
  const currentPoints = Number(pointsRow?.points ?? 0)
  if (!pointsRow || currentPoints < pointsRequired) throw new Error('INSUFFICIENT_POINTS')

  const maxClaims = reward.max_claims != null ? Number(reward.max_claims) : null
  const claimsCount = Number(reward.claims_count ?? 0)
  if (maxClaims !== null && claimsCount >= maxClaims) throw new Error('REWARD_EXHAUSTED')

  const redeemExpiresAt = computeRedeemExpiryDate(
    reward.redeem_expiry_mode as 'fixed' | 'relative',
    (reward.redeem_fixed_date as string) ?? null,
    reward.redeem_relative_amount != null ? Number(reward.redeem_relative_amount) : null,
    (reward.redeem_relative_unit as 'day' | 'week' | 'month' | null) ?? null,
  )

  const redemptionCode = `${customerId.slice(0, 4).toUpperCase()}-${nanoid(6).toUpperCase()}`
  await db.batch([
    {
      sql: `UPDATE business_customer_points
            SET points = ?, updated_at = datetime('now')
            WHERE id = ?`,
      args: [currentPoints - pointsRequired, pointsRow.id as string],
    },
    {
      sql: `UPDATE business_rewards
            SET claims_count = claims_count + 1, updated_at = datetime('now')
            WHERE id = ?`,
      args: [rewardId],
    },
    {
      sql: `INSERT INTO customer_rewards
            (id, customer_id, campaign_id, play_id, reward_name, icon, redemption_code, status, earned_at,
             business_reward_id, business_id, source_type, claimed_at, redeem_expires_at)
            VALUES (?, ?, NULL, ?, ?, ?, ?, 'earned', datetime('now'),
                    ?, ?, 'points_claim', datetime('now'), ?)`,
      args: [
        nanoid(),
        customerId,
        nanoid(),
        reward.name as string,
        (reward.icon as string) ?? 'gift',
        redemptionCode,
        rewardId,
        businessId,
        redeemExpiresAt,
      ],
    },
  ])

  invalidateBusinessAnalyticsCaches(businessId)

  return {
    success: true,
    code: redemptionCode,
    rewardName: reward.name as string,
    icon: (reward.icon as string) ?? 'gift',
  }
}
