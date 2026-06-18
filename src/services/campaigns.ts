import { nanoid } from 'nanoid'
import jwt from 'jsonwebtoken'
import { z } from 'zod'
import { db } from '../db/client.js'
import { getBusinessForUser } from './auth.js'
import { rollWinWithDailyQuota } from './daily-win-quota.js'
import {
  todayInCampaignTz,
  istDateSql,
  nextMidnightIsoInCampaignTz,
  nowInCampaignTz,
} from '../utils/campaign-dates.js'
import {
  validateStampConfig,
  PIN_CYCLE_STAMP_SECONDS,
  isStampCampaignActive,
  isPinActiveForStamp,
  parseStampCampaignMeta,
  stampPinGraceExpired,
  getClaimDeadline,
  getStampCampaignStats,
  type StampCampaignStats,
} from './stamp-cards.js'
import { createStampCampaignSchema, type CreateStampCampaignPayload } from './stamp-campaign-schema.js'
import {
  createCheckInLoyaltyCampaignSchema,
  validateMilestones,
  type CreateCheckInLoyaltyCampaignPayload,
} from './check-in-loyalty-schema.js'
import { getLoyaltyCampaignStats, type LoyaltyCampaignStats } from './check-in-loyalty.js'

const JWT_SECRET = process.env.JWT_SECRET ?? 'loyalgenie-dev-secret-change-in-prod'
export const PIN_CYCLE_SECONDS = 120
/**
 * How long a PIN stays valid for customer verify after its display window ends.
 * Matches the full rotation cycle so a PIN shown at the last second always works,
 * even if the vendor screen has already rotated.
 */
export const PIN_VERIFY_GRACE_SECONDS = PIN_CYCLE_SECONDS
const PLAY_SESSION_EXPIRES = '5m'

const rewardSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional().default(''),
  icon: z.string().min(1).default('🎁'),
  sharePercent: z.number().int().min(1).max(100),
})

export const createShakeCampaignSchema = z.object({
  name: z.string().min(1),
  mechanic: z.literal('shake').default('shake'),
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  userCap: z.number().int().min(1),
  perDayUserLimit: z.number().int().min(1),
  playsPerDay: z.number().int().min(1).max(10),
  winRatePercent: z.number().int().min(1).max(100),
  rewards: z.array(rewardSchema).min(1),
})

export const createCampaignSchema = z.discriminatedUnion('mechanic', [
  createShakeCampaignSchema,
  createStampCampaignSchema,
  createCheckInLoyaltyCampaignSchema,
])

export type CreateCampaignPayload = z.infer<typeof createCampaignSchema>
export type CreateShakeCampaignPayload = z.infer<typeof createShakeCampaignSchema>

const updateRewardSchema = rewardSchema.extend({
  id: z.string().optional(),
})

export const updateCampaignSchema = z.object({
  name: z.string().min(1).optional(),
  endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  userCap: z.number().int().min(1).optional(),
  playsPerDay: z.number().int().min(1).max(10).optional(),
  perDayUserLimit: z.number().int().min(1).optional(),
  winRatePercent: z.number().int().min(1).max(100).optional(),
  status: z.enum(['active', 'paused', 'ended']).optional(),
  rewards: z.array(updateRewardSchema).min(1).optional(),
})

export type UpdateCampaignPayload = z.infer<typeof updateCampaignSchema>

export interface CampaignReward {
  id: string
  name: string
  description: string
  icon: string
  sharePercent: number
  rewardTier?: string | null
}

export interface CampaignRow {
  id: string
  businessId: string
  name: string
  mechanic: string
  status: string
  startDate: string
  endDate: string
  userCap: number
  perDayUserLimit: number
  playsPerDay: number
  winRatePercent: number
  pin: string | null
  pinExpiresAt: string | null
  configJson: string | null
  claimPeriodDays: number
  capFilledAt: string | null
  createdAt: string
  rewards: CampaignReward[]
  currentUsers: number
  participations: number
  rewardsClaimed: number
  redeemedCount: number
  stampStats?: StampCampaignStats | null
  loyaltyStats?: LoyaltyCampaignStats | null
}

export type PlayBlockReason =
  | 'campaign_inactive'
  | 'user_cap'
  | 'daily_participant_limit'
  | 'no_plays_remaining'

/** Single-day campaigns use the full user cap for that day; multi-day uses perDayUserLimit. */
export function effectivePerDayUserLimit(campaign: Pick<CampaignRow, 'startDate' | 'endDate' | 'userCap' | 'perDayUserLimit'>): number {
  if (campaign.startDate === campaign.endDate) return campaign.userCap
  return campaign.perDayUserLimit
}

function generatePin(): string {
  return String(Math.floor(100 + Math.random() * 900))
}

export function normalizePin(pin: string): string {
  const digits = pin.trim().replace(/\D/g, '')
  if (!digits) return ''
  return digits.padStart(3, '0').slice(-3)
}

/** Seconds until PIN display window ends (ceil so "1s" covers the full last second). */
export function computePinSecondsRemaining(
  expiresAt: string | null,
  now = nowInCampaignTz(),
): number {
  if (!expiresAt) return 0
  const ms = new Date(expiresAt).getTime() - now.getTime()
  return Math.max(0, Math.ceil(ms / 1000))
}

function pinGraceUntilIso(pinExpiresAt: string | null, now = nowInCampaignTz()): string {
  const baseMs = pinExpiresAt ? new Date(pinExpiresAt).getTime() : now.getTime()
  return new Date(baseMs + PIN_VERIFY_GRACE_SECONDS * 1000).toISOString()
}

export interface PinVerificationRow {
  pin: string | null
  pinExpiresAt: string | null
  previousPin: string | null
  previousPinValidUntil: string | null
  mechanic: string
}

export function isPinValidForVerify(
  entered: string,
  row: PinVerificationRow,
  now = nowInCampaignTz(),
): boolean {
  const normalized = normalizePin(entered)
  if (!/^\d{3}$/.test(normalized)) return false

  if (row.mechanic === 'stamp') {
    const storedPin = row.pin ? normalizePin(String(row.pin)) : null
    return storedPin === normalized && !stampPinGraceExpired(row.pinExpiresAt)
  }

  return isShakeLikePinValid(
    normalized,
    row.pin,
    row.pinExpiresAt,
    row.previousPin,
    row.previousPinValidUntil,
    now,
  )
}

function isShakeLikePinValid(
  normalized: string,
  currentPin: string | null,
  pinExpiresAt: string | null,
  previousPin: string | null,
  previousPinValidUntil: string | null,
  now = nowInCampaignTz(),
): boolean {
  const nowMs = now.getTime()

  if (currentPin && normalizePin(String(currentPin)) === normalized) {
    if (!pinExpiresAt) return true
    return nowMs <= new Date(pinExpiresAt).getTime() + PIN_VERIFY_GRACE_SECONDS * 1000
  }

  if (previousPin && previousPinValidUntil && normalizePin(String(previousPin)) === normalized) {
    return nowMs <= new Date(previousPinValidUntil).getTime()
  }

  return false
}

function pinExpiresAtIso(mechanic = 'shake'): string {
  if (mechanic === 'stamp') {
    return nextMidnightIsoInCampaignTz(nowInCampaignTz())
  }
  return new Date(nowInCampaignTz().getTime() + PIN_CYCLE_SECONDS * 1000).toISOString()
}

export function pinCycleSecondsForMechanic(mechanic: string): number {
  if (mechanic === 'stamp') return PIN_CYCLE_STAMP_SECONDS
  return PIN_CYCLE_SECONDS
}

async function autoEndExpiredCampaigns(businessId?: string): Promise<void> {
  const today = todayInCampaignTz()
  if (businessId) {
    await db.execute({
      sql: `UPDATE campaigns SET status = 'ended'
            WHERE business_id = ? AND status IN ('active', 'paused') AND end_date < ?`,
      args: [businessId, today],
    })
    return
  }
  await db.execute({
    sql: `UPDATE campaigns SET status = 'ended'
          WHERE status IN ('active', 'paused') AND end_date < ?`,
    args: [today],
  })
}

async function ensureCampaignNotPastEnd(row: Record<string, unknown>): Promise<Record<string, unknown>> {
  const status = row.status as string
  const endDate = row.end_date as string
  const mechanic = row.mechanic as string
  const today = todayInCampaignTz()

  if (status !== 'active' && status !== 'paused') {
    return row
  }

  if (mechanic === 'stamp') {
    const claimPeriodDays = Number(row.claim_period_days ?? 30)
    const capFilledAt = (row.cap_filled_at as string) ?? null
    const deadline = getClaimDeadline(endDate, claimPeriodDays, capFilledAt)
    if (today > deadline) {
      await db.execute({
        sql: `UPDATE campaigns SET status = 'ended' WHERE id = ?`,
        args: [row.id as string],
      })
      return { ...row, status: 'ended' }
    }
    return row
  }

  if (today > endDate) {
    await db.execute({
      sql: `UPDATE campaigns SET status = 'ended' WHERE id = ?`,
      args: [row.id as string],
    })
    return { ...row, status: 'ended' }
  }
  return row
}

async function getBusinessIdForUser(userId: string): Promise<string> {
  const business = await getBusinessForUser(userId)
  if (!business) throw new Error('BUSINESS_NOT_FOUND')
  return business.id as string
}

async function fetchRewards(campaignId: string): Promise<CampaignReward[]> {
  const result = await db.execute({
    sql: `SELECT id, name, description, icon, share_percent, reward_tier FROM campaign_rewards
          WHERE campaign_id = ? ORDER BY sort_order ASC`,
    args: [campaignId],
  })
  return result.rows.map(row => ({
    id: row.id as string,
    name: row.name as string,
    description: (row.description as string) ?? '',
    icon: (row.icon as string) ?? '🎁',
    sharePercent: row.share_percent as number,
    rewardTier: (row.reward_tier as string) ?? null,
  }))
}

async function fetchStats(campaignId: string) {
  const users = await db.execute({
    sql: 'SELECT COUNT(*) as c FROM campaign_participations WHERE campaign_id = ?',
    args: [campaignId],
  })
  const plays = await db.execute({
    sql: 'SELECT COUNT(*) as c FROM game_plays WHERE campaign_id = ?',
    args: [campaignId],
  })
  const wins = await db.execute({
    sql: 'SELECT COUNT(*) as c FROM game_plays WHERE campaign_id = ? AND won = 1',
    args: [campaignId],
  })
  const redeemed = await db.execute({
    sql: `SELECT COUNT(*) as c FROM customer_rewards
          WHERE campaign_id = ? AND status = 'redeemed'`,
    args: [campaignId],
  })
  return {
    currentUsers: Number(users.rows[0]?.c ?? 0),
    participations: Number(plays.rows[0]?.c ?? 0),
    rewardsClaimed: Number(wins.rows[0]?.c ?? 0),
    redeemedCount: Number(redeemed.rows[0]?.c ?? 0),
  }
}

async function rowToCampaign(row: Record<string, unknown>): Promise<CampaignRow> {
  const id = row.id as string
  const stats = await fetchStats(id)
  const rewards = await fetchRewards(id)
  const mechanic = row.mechanic as string
  const base: CampaignRow = {
    id,
    businessId: row.business_id as string,
    name: row.name as string,
    mechanic,
    status: row.status as string,
    startDate: row.start_date as string,
    endDate: row.end_date as string,
    userCap: row.user_cap as number,
    perDayUserLimit: row.per_day_user_limit as number,
    playsPerDay: row.plays_per_day as number,
    winRatePercent: row.win_rate_percent as number,
    pin: (row.pin as string) ?? null,
    pinExpiresAt: (row.pin_expires_at as string) ?? null,
    configJson: (row.config_json as string) ?? null,
    claimPeriodDays: Number(row.claim_period_days ?? 30),
    capFilledAt: (row.cap_filled_at as string) ?? null,
    createdAt: row.created_at as string,
    rewards,
    ...stats,
  }
  if (mechanic === 'stamp') {
    base.stampStats = await getStampCampaignStats(id)
  }
  if (mechanic === 'check-in-loyalty') {
    base.loyaltyStats = await getLoyaltyCampaignStats(id)
  }
  return base
}

async function createShakeCampaign(userId: string, payload: CreateShakeCampaignPayload) {
  const shareTotal = payload.rewards.reduce((s, r) => s + r.sharePercent, 0)
  if (shareTotal !== 100) {
    throw new Error('REWARD_SHARES_MUST_SUM_100')
  }

  const businessId = await getBusinessIdForUser(userId)
  const campaignId = nanoid()
  const pin = generatePin()
  const pinExpires = pinExpiresAtIso('shake')
  const perDayUserLimit =
    payload.startDate === payload.endDate
      ? payload.userCap
      : Math.min(payload.perDayUserLimit, payload.userCap)

  const statements = [
    {
      sql: `INSERT INTO campaigns (
        id, business_id, name, mechanic, status, start_date, end_date,
        user_cap, per_day_user_limit, plays_per_day, win_rate_percent,
        pin, pin_expires_at, claim_period_days
      ) VALUES (?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?, ?, 30)`,
      args: [
        campaignId, businessId, payload.name, payload.mechanic,
        payload.startDate, payload.endDate,
        payload.userCap, perDayUserLimit, payload.playsPerDay,
        payload.winRatePercent, pin, pinExpires,
      ],
    },
    ...payload.rewards.map((r, i) => ({
      sql: `INSERT INTO campaign_rewards (id, campaign_id, name, description, icon, share_percent, sort_order, reward_tier)
            VALUES (?, ?, ?, ?, ?, ?, ?, NULL)`,
      args: [nanoid(), campaignId, r.name, r.description ?? '', r.icon, r.sharePercent, i],
    })),
  ]

  await db.batch(statements)

  const result = await db.execute({
    sql: 'SELECT * FROM campaigns WHERE id = ?',
    args: [campaignId],
  })
  return await rowToCampaign(result.rows[0] as Record<string, unknown>)
}

async function createStampCampaign(userId: string, payload: CreateStampCampaignPayload) {
  validateStampConfig(payload.stampConfig)

  for (const tier of ['surprise', 'big'] as const) {
    const mode = payload.stampConfig[`${tier}Mode`]
    const entries = payload.rewards[tier]
    if (mode === 'single' && entries.length < 1) {
      throw new Error('INVALID_STAMP_REWARDS')
    }
    if (mode === 'pool') {
      const total = entries.reduce((s, r) => s + r.winPercent, 0)
      if (total > 100 || total < 1) {
        throw new Error('INVALID_STAMP_POOL')
      }
    }
  }

  const businessId = await getBusinessIdForUser(userId)
  const campaignId = nanoid()
  const pin = generatePin()
  const pinExpires = pinExpiresAtIso('stamp')
  const configJson = JSON.stringify({
    type: 'stamp',
    stampConfig: payload.stampConfig,
  })

  const rewardStatements: { sql: string; args: (string | number | null)[] }[] = []
  let sortOrder = 0
  for (const tier of ['surprise', 'big'] as const) {
    for (const r of payload.rewards[tier]) {
      rewardStatements.push({
        sql: `INSERT INTO campaign_rewards (id, campaign_id, name, description, icon, share_percent, sort_order, reward_tier)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [
          nanoid(), campaignId, r.name, r.description ?? '', r.icon,
          payload.stampConfig[`${tier}Mode`] === 'single' ? 100 : r.winPercent,
          sortOrder++, tier,
        ],
      })
    }
  }

  await db.batch([
    {
      sql: `INSERT INTO campaigns (
        id, business_id, name, mechanic, status, start_date, end_date,
        user_cap, per_day_user_limit, plays_per_day, win_rate_percent,
        config_json, pin, pin_expires_at, claim_period_days
      ) VALUES (?, ?, ?, 'stamp', 'active', ?, ?, ?, 0, 1, 0, ?, ?, ?, ?)`,
      args: [
        campaignId, businessId, payload.name,
        payload.startDate, payload.endDate, payload.userCap,
        configJson, pin, pinExpires, payload.claimPeriodDays,
      ],
    },
    ...rewardStatements,
  ])

  const result = await db.execute({
    sql: 'SELECT * FROM campaigns WHERE id = ?',
    args: [campaignId],
  })
  return await rowToCampaign(result.rows[0] as Record<string, unknown>)
}

async function createCheckInLoyaltyCampaignHandler(userId: string, payload: CreateCheckInLoyaltyCampaignPayload) {
  validateMilestones(payload.milestones)

  const businessId = await getBusinessIdForUser(userId)
  const campaignId = nanoid()
  const pin = generatePin()
  const pinExpires = pinExpiresAtIso('check-in-loyalty')
  const configJson = JSON.stringify({
    type: 'check-in-loyalty',
    checkInConfig: payload.checkInConfig,
  })

  const rewardStatements = payload.milestones.map((m, i) => ({
    sql: `INSERT INTO campaign_rewards (id, campaign_id, name, description, icon, share_percent, sort_order, reward_tier)
          VALUES (?, ?, ?, ?, ?, ?, ?, 'milestone')`,
    args: [nanoid(), campaignId, m.name, m.description ?? '', m.icon, m.pointsThreshold, i],
  }))

  await db.batch([
    {
      sql: `INSERT INTO campaigns (
        id, business_id, name, mechanic, status, start_date, end_date,
        user_cap, per_day_user_limit, plays_per_day, win_rate_percent,
        config_json, pin, pin_expires_at, claim_period_days
      ) VALUES (?, ?, ?, 'check-in-loyalty', 'active', ?, ?, ?, 0, 1, 0, ?, ?, ?, 30)`,
      args: [
        campaignId, businessId, payload.name,
        payload.startDate, payload.endDate, payload.userCap,
        configJson, pin, pinExpires,
      ],
    },
    ...rewardStatements,
  ])

  const result = await db.execute({
    sql: 'SELECT * FROM campaigns WHERE id = ?',
    args: [campaignId],
  })
  return await rowToCampaign(result.rows[0] as Record<string, unknown>)
}

export async function createCampaign(userId: string, payload: CreateCampaignPayload) {
  if (payload.mechanic === 'stamp') {
    return createStampCampaign(userId, payload)
  }
  if (payload.mechanic === 'check-in-loyalty') {
    return createCheckInLoyaltyCampaignHandler(userId, payload)
  }
  return createShakeCampaign(userId, payload)
}

export async function listCampaignsForBusiness(userId: string) {
  const businessId = await getBusinessIdForUser(userId)
  await autoEndExpiredCampaigns(businessId)
  const result = await db.execute({
    sql: 'SELECT * FROM campaigns WHERE business_id = ? ORDER BY created_at DESC',
    args: [businessId],
  })
  return Promise.all(result.rows.map(row => rowToCampaign(row as Record<string, unknown>)))
}

export async function updateCampaign(
  userId: string,
  campaignId: string,
  payload: UpdateCampaignPayload,
) {
  const existing = await getCampaignForBusiness(userId, campaignId)

  if (existing.status === 'ended') {
    throw new Error('CAMPAIGN_ENDED')
  }

  if (payload.userCap !== undefined && payload.userCap < existing.currentUsers) {
    throw new Error('USER_CAP_BELOW_CURRENT')
  }

  if (payload.endDate !== undefined && payload.endDate < existing.startDate) {
    throw new Error('END_DATE_BEFORE_START')
  }

  if (payload.rewards !== undefined) {
    const shareTotal = payload.rewards.reduce((s, r) => s + r.sharePercent, 0)
    if (shareTotal !== 100) {
      throw new Error('REWARD_SHARES_MUST_SUM_100')
    }
  }

  if (payload.status === 'active' && existing.status === 'ended') {
    throw new Error('CANNOT_REACTIVATE_ENDED')
  }

  const fields: string[] = []
  const args: (string | number)[] = []

  if (payload.name !== undefined) {
    fields.push('name = ?')
    args.push(payload.name)
  }
  if (payload.endDate !== undefined) {
    fields.push('end_date = ?')
    args.push(payload.endDate)
  }
  if (payload.userCap !== undefined) {
    fields.push('user_cap = ?')
    args.push(payload.userCap)
  }
  if (payload.playsPerDay !== undefined) {
    fields.push('plays_per_day = ?')
    args.push(payload.playsPerDay)
  }
  if (payload.perDayUserLimit !== undefined) {
    fields.push('per_day_user_limit = ?')
    args.push(payload.perDayUserLimit)
  }
  if (payload.winRatePercent !== undefined) {
    fields.push('win_rate_percent = ?')
    args.push(payload.winRatePercent)
  }
  if (payload.status !== undefined) {
    fields.push('status = ?')
    args.push(payload.status)
  }

  if (fields.length === 0 && payload.rewards === undefined) {
    return existing
  }

  if (fields.length > 0) {
    args.push(campaignId, existing.businessId)
    await db.execute({
      sql: `UPDATE campaigns SET ${fields.join(', ')} WHERE id = ? AND business_id = ?`,
      args,
    })
  }

  if (payload.rewards !== undefined) {
    const existingIds = new Set(existing.rewards.map(r => r.id))
    const statements = [
      {
        sql: 'DELETE FROM campaign_rewards WHERE campaign_id = ?',
        args: [campaignId],
      },
      ...payload.rewards.map((r, i) => ({
        sql: `INSERT INTO campaign_rewards (id, campaign_id, name, description, icon, share_percent, sort_order)
              VALUES (?, ?, ?, ?, ?, ?, ?)`,
        args: [
          r.id && existingIds.has(r.id) ? r.id : nanoid(),
          campaignId,
          r.name,
          r.description ?? '',
          r.icon,
          r.sharePercent,
          i,
        ],
      })),
    ]
    await db.batch(statements)
  }

  return getCampaignForBusiness(userId, campaignId)
}

export async function getCampaignForBusiness(userId: string, campaignId: string) {
  const businessId = await getBusinessIdForUser(userId)
  const result = await db.execute({
    sql: 'SELECT * FROM campaigns WHERE id = ? AND business_id = ?',
    args: [campaignId, businessId],
  })
  const row = result.rows[0]
  if (!row) throw new Error('CAMPAIGN_NOT_FOUND')
  return await rowToCampaign(await ensureCampaignNotPastEnd(row as Record<string, unknown>))
}

export async function getCampaignPinForBusiness(userId: string, campaignId: string) {
  const campaign = await getCampaignForBusiness(userId, campaignId)
  const refreshed = await rotatePinIfExpired(campaign.id)
  const cycleSeconds = pinCycleSecondsForMechanic(refreshed.mechanic)
  const pinActive = refreshed.mechanic === 'stamp'
    ? isPinActiveForStamp(
        refreshed.status,
        refreshed.startDate,
        refreshed.endDate,
        refreshed.claimPeriodDays,
        refreshed.capFilledAt,
      )
    : refreshed.status === 'active'
  const secondsRemaining = refreshed.pinExpiresAt && pinActive
    ? computePinSecondsRemaining(refreshed.pinExpiresAt)
    : 0
  return {
    pin: pinActive ? refreshed.pin : null,
    expiresAt: pinActive ? refreshed.pinExpiresAt : null,
    secondsRemaining,
    cycleSeconds,
    pinActive,
    verifyGraceSeconds: PIN_VERIFY_GRACE_SECONDS,
  }
}

export async function rotatePinIfExpired(campaignId: string) {
  const result = await db.execute({
    sql: 'SELECT * FROM campaigns WHERE id = ?',
    args: [campaignId],
  })
  const row = result.rows[0]
  if (!row) throw new Error('CAMPAIGN_NOT_FOUND')

  const current = await ensureCampaignNotPastEnd(row as Record<string, unknown>)
  const mechanic = current.mechanic as string
  const expiresAt = current.pin_expires_at as string | null
  const now = nowInCampaignTz()
  const nowIso = now.toISOString()
  const needsRotation = !expiresAt || new Date(expiresAt).getTime() <= now.getTime()

  const pinStillNeeded = mechanic === 'stamp'
    ? isPinActiveForStamp(
        current.status as string,
        current.start_date as string,
        current.end_date as string,
        Number(current.claim_period_days ?? 30),
        (current.cap_filled_at as string) ?? null,
      )
    : current.status === 'active'

  if (needsRotation && pinStillNeeded) {
    const oldPin = (current.pin as string | null) ?? null
    const oldExpires = (current.pin_expires_at as string | null) ?? null
    const graceUntil = pinGraceUntilIso(oldExpires, now)
    const pin = generatePin()
    const pinExpires = pinExpiresAtIso(mechanic)
    const updated = await db.execute({
      sql: `UPDATE campaigns
            SET pin = ?, pin_expires_at = ?, previous_pin = ?, previous_pin_valid_until = ?
            WHERE id = ?
              AND (pin_expires_at IS NULL OR pin_expires_at <= ?)`,
      args: [pin, pinExpires, oldPin, graceUntil, campaignId, nowIso],
    })

    if ((updated.rowsAffected ?? 0) === 0) {
      return getCampaignById(campaignId)
    }

    current.pin = pin
    current.pin_expires_at = pinExpires
    current.previous_pin = oldPin
    current.previous_pin_valid_until = graceUntil
  }

  return await rowToCampaign(current)
}

export async function getCampaignById(campaignId: string) {
  const result = await db.execute({
    sql: 'SELECT * FROM campaigns WHERE id = ?',
    args: [campaignId],
  })
  const row = result.rows[0]
  if (!row) throw new Error('CAMPAIGN_NOT_FOUND')
  return await rowToCampaign(await ensureCampaignNotPastEnd(row as Record<string, unknown>))
}

export async function listBusinessesWithActiveCampaigns() {
  await autoEndExpiredCampaigns()
  const today = todayInCampaignTz()
  const result = await db.execute({
    sql: `SELECT DISTINCT b.id, b.name, b.tagline, b.business_type, b.city, b.brand_color
          FROM businesses b
          INNER JOIN campaigns c ON c.business_id = b.id
          WHERE c.status = 'active'
            AND c.start_date <= ?
          ORDER BY b.name ASC`,
    args: [today],
  })

  const businesses = await Promise.all(
    result.rows.map(async row => {
      const businessId = row.id as string
      const campaignsResult = await db.execute({
        sql: `SELECT id, name, mechanic, start_date, end_date, win_rate_percent, plays_per_day,
                     claim_period_days, cap_filled_at, config_json
              FROM campaigns
              WHERE business_id = ? AND status = 'active' AND start_date <= ?`,
        args: [businessId, today],
      })
      const campaigns = campaignsResult.rows.filter(c => {
        const mechanic = c.mechanic as string
        if (mechanic === 'stamp') {
          return isStampCampaignActive(
            'active',
            c.start_date as string,
            c.end_date as string,
            Number(c.claim_period_days ?? 30),
            (c.cap_filled_at as string) ?? null,
            today,
          )
        }
        if (mechanic === 'check-in-loyalty') {
          const endDate = c.end_date as string
          const startDate = c.start_date as string
          return today >= startDate && today <= endDate
        }
        const endDate = c.end_date as string
        return today <= endDate
      })
      return {
        id: businessId,
        name: row.name as string,
        tagline: (row.tagline as string) ?? '',
        businessType: (row.business_type as string) ?? 'Business',
        city: (row.city as string) ?? '',
        brandColor: (row.brand_color as string) ?? '#7C3AED',
        campaigns: campaigns.map(c => ({
          id: c.id as string,
          name: c.name as string,
          mechanic: c.mechanic as string,
          startDate: c.start_date as string,
          endDate: c.end_date as string,
          winRatePercent: c.win_rate_percent as number,
          playsPerDay: c.plays_per_day as number,
        })),
      }
    }),
  )

  return businesses.filter(b => b.campaigns.length > 0)
}

export async function getPublicCampaign(campaignId: string) {
  const campaign = await getCampaignById(campaignId)
  const today = todayInCampaignTz()

  if (campaign.mechanic === 'stamp') {
    const active = isStampCampaignActive(
      campaign.status,
      campaign.startDate,
      campaign.endDate,
      campaign.claimPeriodDays,
      campaign.capFilledAt,
      today,
    )
    if (!active) throw new Error('CAMPAIGN_NOT_ACTIVE')

    const meta = parseStampCampaignMeta({
      config_json: campaign.configJson,
      claim_period_days: campaign.claimPeriodDays,
      cap_filled_at: campaign.capFilledAt,
    })

    return {
      id: campaign.id,
      businessId: campaign.businessId,
      name: campaign.name,
      mechanic: campaign.mechanic,
      startDate: campaign.startDate,
      endDate: campaign.endDate,
      userCap: campaign.userCap,
      currentUsers: campaign.currentUsers,
      claimPeriodDays: campaign.claimPeriodDays,
      stampConfig: meta?.config ?? null,
      rewards: campaign.rewards.map(r => ({
        id: r.id,
        name: r.name,
        description: r.description,
        icon: r.icon,
        tier: r.rewardTier,
      })),
    }
  }

  if (campaign.mechanic === 'check-in-loyalty') {
    if (campaign.status !== 'active') throw new Error('CAMPAIGN_NOT_ACTIVE')
    if (today < campaign.startDate || today > campaign.endDate) {
      throw new Error('CAMPAIGN_NOT_ACTIVE')
    }

    const { parseCheckInConfig } = await import('./check-in-loyalty.js')
    const checkInConfig = parseCheckInConfig(campaign.configJson)

    return {
      id: campaign.id,
      businessId: campaign.businessId,
      name: campaign.name,
      mechanic: campaign.mechanic,
      startDate: campaign.startDate,
      endDate: campaign.endDate,
      userCap: campaign.userCap,
      currentUsers: campaign.currentUsers,
      checkInConfig,
      rewards: campaign.rewards.map(r => ({
        id: r.id,
        name: r.name,
        description: r.description,
        icon: r.icon,
        pointsThreshold: r.sharePercent,
      })),
    }
  }

  if (campaign.status !== 'active') throw new Error('CAMPAIGN_NOT_ACTIVE')
  if (today < campaign.startDate || today > campaign.endDate) {
    throw new Error('CAMPAIGN_NOT_ACTIVE')
  }
  return {
    id: campaign.id,
    businessId: campaign.businessId,
    name: campaign.name,
    mechanic: campaign.mechanic,
    startDate: campaign.startDate,
    endDate: campaign.endDate,
    playsPerDay: campaign.playsPerDay,
    winRatePercent: campaign.winRatePercent,
    rewards: campaign.rewards.map(r => ({
      id: r.id,
      name: r.name,
      description: r.description,
      icon: r.icon,
    })),
  }
}

export function signPlaySession(campaignId: string, customerId: string) {
  return jwt.sign(
    { campaignId, customerId, type: 'play_session' },
    JWT_SECRET,
    { expiresIn: PLAY_SESSION_EXPIRES },
  )
}

export function verifyPlaySession(token: string, campaignId: string, customerId: string): boolean {
  try {
    const payload = jwt.verify(token, JWT_SECRET) as {
      campaignId: string
      customerId: string
      type: string
    }
    return (
      payload.type === 'play_session' &&
      payload.campaignId === campaignId &&
      payload.customerId === customerId
    )
  } catch {
    return false
  }
}

export async function verifyCampaignPin(campaignId: string, pin: string, customerId: string) {
  const normalizedPin = normalizePin(pin)
  if (!/^\d{3}$/.test(normalizedPin)) {
    throw new Error('INVALID_PIN')
  }

  const pinRow = await db.execute({
    sql: `SELECT pin, pin_expires_at, previous_pin, previous_pin_valid_until, mechanic,
                 status, start_date, end_date, claim_period_days, cap_filled_at
          FROM campaigns WHERE id = ?`,
    args: [campaignId],
  })
  const row = pinRow.rows[0]
  if (!row) throw new Error('CAMPAIGN_NOT_FOUND')

  const today = todayInCampaignTz()
  const mechanic = row.mechanic as string
  const status = row.status as string
  const startDate = row.start_date as string
  const endDate = row.end_date as string

  if (mechanic === 'stamp') {
    if (!isStampCampaignActive(
      status,
      startDate,
      endDate,
      Number(row.claim_period_days ?? 30),
      (row.cap_filled_at as string) ?? null,
      today,
    )) {
      throw new Error('CAMPAIGN_NOT_ACTIVE')
    }
  } else {
    if (status !== 'active') throw new Error('CAMPAIGN_NOT_ACTIVE')
    if (today < startDate || today > endDate) {
      throw new Error('CAMPAIGN_NOT_ACTIVE')
    }
  }

  const pinState: PinVerificationRow = {
    pin: (row.pin as string | null) ?? null,
    pinExpiresAt: (row.pin_expires_at as string | null) ?? null,
    previousPin: (row.previous_pin as string | null) ?? null,
    previousPinValidUntil: (row.previous_pin_valid_until as string | null) ?? null,
    mechanic,
  }

  if (!isPinValidForVerify(normalizedPin, pinState)) {
    throw new Error('INVALID_PIN')
  }

  const playSessionToken = signPlaySession(campaignId, customerId)

  const pinExpiresAt = pinState.pinExpiresAt
  if (pinExpiresAt && new Date(pinExpiresAt).getTime() <= nowInCampaignTz().getTime()) {
    await rotatePinIfExpired(campaignId)
  }

  return { valid: true, playSessionToken, expiresIn: 300 }
}

export async function getPlayState(campaignId: string, customerId: string) {
  const campaign = await getCampaignById(campaignId)
  const eligibility = await checkEligibility(campaign, customerId)
  return {
    campaignId,
    playsRemaining: eligibility.playsRemaining,
    playsUsedToday: eligibility.playsUsedToday,
    playsPerDay: eligibility.playsPerDay,
    canPlay: eligibility.canPlay,
    message: eligibility.message,
    blockReason: eligibility.blockReason,
    winRatePercent: campaign.winRatePercent,
  }
}

interface EligibilityResult {
  canPlay: boolean
  playsRemaining: number
  playsUsedToday: number
  playsPerDay: number
  message: string
  isNewParticipant: boolean
  blockReason: PlayBlockReason | null
}

export async function checkEligibility(
  campaign: CampaignRow,
  customerId: string,
): Promise<EligibilityResult> {
  const base = {
    playsPerDay: campaign.playsPerDay,
    blockReason: null as PlayBlockReason | null,
  }

  if (campaign.status !== 'active') {
    return {
      ...base,
      canPlay: false,
      playsRemaining: 0,
      playsUsedToday: 0,
      message: 'Campaign is not active',
      isNewParticipant: false,
      blockReason: 'campaign_inactive',
    }
  }

  const today = todayInCampaignTz()
  if (today < campaign.startDate || today > campaign.endDate) {
    return {
      ...base,
      canPlay: false,
      playsRemaining: 0,
      playsUsedToday: 0,
      message: 'Campaign is not running today',
      isNewParticipant: false,
      blockReason: 'campaign_inactive',
    }
  }

  const partResult = await db.execute({
    sql: 'SELECT * FROM campaign_participations WHERE campaign_id = ? AND customer_id = ?',
    args: [campaign.id, customerId],
  })
  const participation = partResult.rows[0]
  const isNewParticipant = !participation

  let playsToday = 0
  if (participation) {
    const lastPlayDate = (participation.last_play_date as string) ?? ''
    playsToday = lastPlayDate === today ? (participation.plays_today as number) : 0
  }

  const playsRemaining = Math.max(0, campaign.playsPerDay - playsToday)
  const playsUsedToday = playsToday

  if (playsRemaining <= 0) {
    return {
      ...base,
      canPlay: false,
      playsRemaining: 0,
      playsUsedToday,
      message: 'No plays remaining today. Come back tomorrow!',
      isNewParticipant,
      blockReason: 'no_plays_remaining',
    }
  }

  if (isNewParticipant) {
    const totalUsers = await db.execute({
      sql: 'SELECT COUNT(*) as c FROM campaign_participations WHERE campaign_id = ?',
      args: [campaign.id],
    })
    if (Number(totalUsers.rows[0]?.c ?? 0) >= campaign.userCap) {
      return {
        ...base,
        canPlay: false,
        playsRemaining,
        playsUsedToday,
        message: 'Campaign user cap reached',
        isNewParticipant: true,
        blockReason: 'user_cap',
      }
    }

    const dailyLimit = effectivePerDayUserLimit(campaign)
    const dailyNew = await db.execute({
      sql: `SELECT COUNT(*) as c FROM campaign_participations
            WHERE campaign_id = ? AND ${istDateSql('first_played_at')} = ?`,
      args: [campaign.id, today],
    })
    if (Number(dailyNew.rows[0]?.c ?? 0) >= dailyLimit) {
      const isSingleDay = campaign.startDate === campaign.endDate
      return {
        ...base,
        canPlay: false,
        playsRemaining,
        playsUsedToday,
        message: isSingleDay
          ? 'Campaign is full for today. No more participants can join.'
          : 'Daily participant limit reached. Try again tomorrow.',
        isNewParticipant: true,
        blockReason: 'daily_participant_limit',
      }
    }
  }

  return {
    ...base,
    canPlay: true,
    playsRemaining,
    playsUsedToday,
    message: 'Ready to play',
    isNewParticipant,
    blockReason: null,
  }
}

export function rollWin(winRatePercent: number): boolean {
  return Math.random() < winRatePercent / 100
}

async function fetchDailyWinContext(campaignId: string, customerId: string) {
  const today = todayInCampaignTz()
  const playedAtIst = istDateSql('played_at')
  const result = await db.execute({
    sql: `SELECT
      (SELECT COUNT(DISTINCT customer_id) FROM game_plays
       WHERE campaign_id = ? AND ${playedAtIst} = ?) AS unique_players,
      (SELECT COUNT(*) FROM game_plays
       WHERE campaign_id = ? AND ${playedAtIst} = ? AND won = 1) AS wins_today,
      (SELECT COUNT(*) FROM game_plays
       WHERE campaign_id = ? AND customer_id = ? AND ${playedAtIst} = ?) AS customer_plays_today`,
    args: [campaignId, today, campaignId, today, campaignId, customerId, today],
  })
  const row = result.rows[0]!
  return {
    uniquePlayersBefore: Number(row.unique_players ?? 0),
    winsBefore: Number(row.wins_today ?? 0),
    isFirstPlayToday: Number(row.customer_plays_today ?? 0) === 0,
  }
}

export function pickReward(rewards: CampaignReward[]): CampaignReward {
  let roll = Math.random() * 100
  for (const reward of rewards) {
    roll -= reward.sharePercent
    if (roll <= 0) return reward
  }
  return rewards[rewards.length - 1]!
}

function generateRedemptionCode(customerId: string, campaignId: string): string {
  const suffix = nanoid(6).toUpperCase()
  const prefix = customerId.slice(0, 4).toUpperCase()
  return `${prefix}-${suffix}`
}

export async function executeShakePlay(
  campaignId: string,
  customerId: string,
  playSessionToken: string,
) {
  if (!verifyPlaySession(playSessionToken, campaignId, customerId)) {
    throw new Error('INVALID_PLAY_SESSION')
  }

  const campaign = await getCampaignById(campaignId)
  const eligibility = await checkEligibility(campaign, customerId)
  if (!eligibility.canPlay) {
    const msg = eligibility.message
    throw new Error(
      msg === 'Campaign user cap reached' ? 'USER_CAP_REACHED' :
      msg.includes('Daily') ? 'DAILY_LIMIT_REACHED' :
      msg === 'Campaign is not active' || msg === 'Campaign is not running today' ? 'CAMPAIGN_NOT_ACTIVE' :
      'NO_PLAYS_REMAINING',
    )
  }

  const dailyCtx = await fetchDailyWinContext(campaignId, customerId)
  const won = rollWinWithDailyQuota({
    ...dailyCtx,
    winRatePercent: campaign.winRatePercent,
    perDayUserLimit: campaign.perDayUserLimit,
  })
  const playId = nanoid()
  const today = todayInCampaignTz()

  let reward: CampaignReward | null = null
  let redemptionCode: string | null = null

  if (won) {
    reward = pickReward(campaign.rewards)
    redemptionCode = generateRedemptionCode(customerId, campaignId)
  }

  const statements = []

  if (eligibility.isNewParticipant) {
    statements.push({
      sql: `INSERT INTO campaign_participations
            (id, campaign_id, customer_id, plays_today, last_play_date, total_plays, first_played_at, last_played_at)
            VALUES (?, ?, ?, 1, ?, 1, datetime('now'), datetime('now'))`,
      args: [nanoid(), campaignId, customerId, today],
    })
  } else {
    const partResult = await db.execute({
      sql: 'SELECT * FROM campaign_participations WHERE campaign_id = ? AND customer_id = ?',
      args: [campaignId, customerId],
    })
    const part = partResult.rows[0]!
    const lastPlayDate = (part.last_play_date as string) ?? ''
    const playsToday = lastPlayDate === today ? (part.plays_today as number) + 1 : 1
    statements.push({
      sql: `UPDATE campaign_participations
            SET plays_today = ?, last_play_date = ?, total_plays = total_plays + 1, last_played_at = datetime('now')
            WHERE campaign_id = ? AND customer_id = ?`,
      args: [playsToday, today, campaignId, customerId],
    })
  }

  statements.push({
    sql: `INSERT INTO game_plays (id, campaign_id, customer_id, mechanic, won, reward_id, reward_name, redemption_code)
          VALUES (?, ?, ?, 'shake', ?, ?, ?, ?)`,
    args: [
      playId, campaignId, customerId,
      won ? 1 : 0,
      reward?.id ?? null,
      reward?.name ?? null,
      redemptionCode,
    ],
  })

  if (won && reward && redemptionCode) {
    statements.push({
      sql: `INSERT INTO customer_rewards
            (id, customer_id, campaign_id, play_id, reward_name, icon, redemption_code, status, earned_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', datetime('now'))`,
      args: [nanoid(), customerId, campaignId, playId, reward.name, reward.icon, redemptionCode],
    })
  }

  await db.batch(statements)

  const playsRemaining = eligibility.playsRemaining - 1
  const playsUsedToday = eligibility.playsUsedToday + 1

  return {
    won,
    reward: reward ? {
      id: reward.id,
      name: reward.name,
      description: reward.description,
      icon: reward.icon,
    } : null,
    code: redemptionCode,
    playsRemaining,
    playsUsedToday,
    playsPerDay: campaign.playsPerDay,
    playId,
  }
}

export async function listCustomerRewards(customerId: string) {
  const result = await db.execute({
    sql: `SELECT cr.*, c.name as campaign_name, c.mechanic
          FROM customer_rewards cr
          INNER JOIN campaigns c ON c.id = cr.campaign_id
          WHERE cr.customer_id = ?
          ORDER BY cr.earned_at DESC`,
    args: [customerId],
  })
  return result.rows.map(row => ({
    id: row.id as string,
    campaignId: row.campaign_id as string,
    campaignName: row.campaign_name as string,
    mechanic: row.mechanic as string,
    reward: row.reward_name as string,
    icon: (row.icon as string) ?? '🎁',
    earnedAt: row.earned_at as string,
    status: row.status as string,
    redeemedAt: (row.redeemed_at as string) ?? undefined,
    code: row.redemption_code as string,
  }))
}
