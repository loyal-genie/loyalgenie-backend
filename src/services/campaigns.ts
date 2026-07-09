import { nanoid } from 'nanoid'
import jwt from 'jsonwebtoken'
import { z } from 'zod'
import { db } from '../db/client.js'
import { getBusinessForUser } from './auth.js'
import { rollWinWithDailyQuota } from './daily-win-quota.js'
import {
  todayInCampaignTz,
  istDateSql,
  nowInCampaignTz,
  isCampaignInWindow,
  currentTimeInCampaignTz,
} from '../utils/campaign-dates.js'
import {
  computeRedeemExpiryDate,
  validateRedeemExpiryConfig,
  isCustomerRewardExpired,
} from '../utils/redeem-expiry.js'
import {
  validateStampConfig,
  isStampCampaignActive,
  isPinActiveForStamp,
  parseStampCampaignMeta,
  parseStampConfig,
  getClaimDeadline,
  getStampCampaignStats,
  type StampCampaignStats,
} from './stamp-cards.js'
import { createStampCampaignSchema, stampConfigSchema, stampRewardTierKey, type CreateStampCampaignPayload } from './stamp-campaign-schema.js'
import {
  createCheckInLoyaltyCampaignSchema,
  validateMilestones,
  loyaltyMilestoneSchema,
  checkInLoyaltyConfigSchema,
  type CreateCheckInLoyaltyCampaignPayload,
} from './check-in-loyalty-schema.js'
import { getLoyaltyCampaignStats, type LoyaltyCampaignStats } from './check-in-loyalty.js'
import {
  createSpinCampaignSchema,
  parseSpinConfig,
  spinOverallWinners,
  spinRewardShares,
  spinWinRatePercent,
  spinConfigSchema,
  validateSpinConfig,
  type CreateSpinCampaignPayload,
  type SpinSegment,
} from './spin-campaign-schema.js'
import {
  createDiceCampaignSchema,
  parseDiceConfig,
  diceOverallWinners,
  diceRewardShares,
  diceWinRatePercent,
  diceConfigSchema,
  validateDiceConfig,
  type CreateDiceCampaignPayload,
  type DiceOutcome,
} from './dice-campaign-schema.js'
import { parsePhotoArray, resolveImageField, resolvePhotoArrayField } from '../utils/business-media.js'
import { TtlCache } from '../utils/ttl-cache.js'
import { invalidateVendorDashboardCache, invalidateVendorCustomersCache } from './vendor-analytics.js'

const JWT_SECRET = process.env.JWT_SECRET ?? 'loyalgenie-dev-secret-change-in-prod'
export const PIN_CYCLE_SECONDS = 120
/**
 * How long a PIN stays valid for customer verify after its display window ends.
 * Matches the full rotation cycle so a PIN shown at the last second always works,
 * even if the vendor screen has already rotated.
 */
export const PIN_VERIFY_GRACE_SECONDS = PIN_CYCLE_SECONDS
const PLAY_SESSION_EXPIRES = '5m'

const timeSchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/)

const shakeRewardCore = z.object({
  name: z.string().min(1),
  description: z.string().optional().default(''),
  icon: z.string().min(1).default('🎁'),
  sharePercent: z.number().int().min(1).max(100),
  redeemExpiryMode: z.enum(['fixed', 'relative']),
  redeemFixedDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  redeemRelativeAmount: z.number().int().min(1).optional(),
  redeemRelativeUnit: z.enum(['day', 'week', 'month']).optional(),
})

function refineShakeReward<T extends z.ZodObject<z.ZodRawShape>>(schema: T) {
  return schema.superRefine((val, ctx) => {
    try {
      validateRedeemExpiryConfig(
        val.redeemExpiryMode as 'fixed' | 'relative',
        val.redeemFixedDate as string | undefined,
        val.redeemRelativeAmount as number | undefined,
        val.redeemRelativeUnit as string | undefined,
      )
    } catch {
      ctx.addIssue({ code: 'custom', message: 'Redeem before is required for each reward' })
    }
  })
}

const rewardSchema = refineShakeReward(shakeRewardCore)

export const createShakeCampaignSchema = z.object({
  name: z.string().min(1),
  mechanic: z.literal('shake').default('shake'),
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  startTime: timeSchema.default('00:00'),
  endTime: timeSchema.default('23:59'),
  userCap: z.number().int().min(1),
  perDayUserLimit: z.number().int().min(1),
  playsPerDay: z.number().int().min(1).max(10),
  overallWinners: z.number().int().min(1),
  rewards: z.array(rewardSchema).min(1),
})

export const createCampaignSchema = z.discriminatedUnion('mechanic', [
  createShakeCampaignSchema,
  createSpinCampaignSchema,
  createDiceCampaignSchema,
  createStampCampaignSchema,
  createCheckInLoyaltyCampaignSchema,
])

export type CreateCampaignPayload = z.infer<typeof createCampaignSchema>
export type CreateShakeCampaignPayload = z.infer<typeof createShakeCampaignSchema>

const updateRewardSchema = refineShakeReward(shakeRewardCore.extend({
  id: z.string().optional(),
}))

const stampRewardEntrySchema = z.object({
  id: z.string().optional(),
  name: z.string().min(1),
  description: z.string().optional().default(''),
  icon: z.string().min(1).default('🎁'),
  winPercent: z.number().int().min(1).max(100),
})

const updateLoyaltyMilestoneSchema = loyaltyMilestoneSchema.extend({
  id: z.string().optional(),
})

export const updateCampaignSchema = z.object({
  name: z.string().min(1).optional(),
  endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  endTime: timeSchema.optional(),
  userCap: z.number().int().min(1).optional(),
  playsPerDay: z.number().int().min(1).max(10).optional(),
  perDayUserLimit: z.number().int().min(1).optional(),
  overallWinners: z.number().int().min(1).optional(),
  /** @deprecated use overallWinners */
  winRatePercent: z.number().int().min(1).max(100).optional(),
  status: z.enum(['active', 'paused', 'ended']).optional(),
  rewards: z.union([
    z.array(updateRewardSchema).min(1),
    z.object({
      surprise: z.array(stampRewardEntrySchema).min(1),
      big: z.array(stampRewardEntrySchema).min(1),
    }),
  ]).optional(),
  claimPeriodDays: z.number().int().min(1).max(365).optional(),
  stampConfig: stampConfigSchema.optional(),
  checkInConfig: checkInLoyaltyConfigSchema.optional(),
  milestones: z.array(updateLoyaltyMilestoneSchema).optional(),
  spinConfig: spinConfigSchema.optional(),
  diceConfig: diceConfigSchema.optional(),
  startTime: timeSchema.optional(),
})

export interface UpdateCampaignPayload {
  name?: string
  endDate?: string
  endTime?: string
  userCap?: number
  playsPerDay?: number
  perDayUserLimit?: number
  overallWinners?: number
  /** @deprecated use overallWinners */
  winRatePercent?: number
  status?: 'active' | 'paused' | 'ended'
  rewards?:
    | {
        id?: string
        name: string
        description?: string
        icon: string
        sharePercent: number
        redeemExpiryMode: 'fixed' | 'relative'
        redeemFixedDate?: string
        redeemRelativeAmount?: number
        redeemRelativeUnit?: 'day' | 'week' | 'month'
      }[]
    | StampTierRewards
  claimPeriodDays?: number
  stampConfig?: z.infer<typeof stampConfigSchema>
  checkInConfig?: z.infer<typeof checkInLoyaltyConfigSchema>
  milestones?: { id?: string; name: string; description?: string; icon: string; pointsThreshold: number }[]
  spinConfig?: z.infer<typeof spinConfigSchema>
  diceConfig?: z.infer<typeof diceConfigSchema>
  startTime?: string
}

type StampTierRewards = {
  surprise: Record<string, {
    id?: string
    name: string
    description?: string
    icon: string
    winPercent: number
    redeemExpiryMode: 'fixed' | 'relative'
    redeemFixedDate?: string
    redeemRelativeAmount?: number
    redeemRelativeUnit?: 'day' | 'week' | 'month'
  }[]>
  big: Record<string, {
    id?: string
    name: string
    description?: string
    icon: string
    winPercent: number
    redeemExpiryMode: 'fixed' | 'relative'
    redeemFixedDate?: string
    redeemRelativeAmount?: number
    redeemRelativeUnit?: 'day' | 'week' | 'month'
  }[]>
}

function isShakeRewardsUpdate(
  rewards: UpdateCampaignPayload['rewards'],
): rewards is {
  id?: string
  name: string
  description?: string
  icon: string
  sharePercent: number
  redeemExpiryMode: 'fixed' | 'relative'
  redeemFixedDate?: string
  redeemRelativeAmount?: number
  redeemRelativeUnit?: 'day' | 'week' | 'month'
}[] {
  return Array.isArray(rewards)
}

function isStampRewardsUpdate(
  rewards: UpdateCampaignPayload['rewards'],
): rewards is StampTierRewards {
  return rewards !== undefined
    && !Array.isArray(rewards)
    && typeof (rewards as StampTierRewards).surprise === 'object'
    && !Array.isArray((rewards as StampTierRewards).surprise)
}

export interface CampaignReward {
  id: string
  name: string
  description: string
  icon: string
  sharePercent: number
  rewardTier?: string | null
  redeemExpiryMode?: 'fixed' | 'relative'
  redeemFixedDate?: string | null
  redeemRelativeAmount?: number | null
  redeemRelativeUnit?: 'day' | 'week' | 'month' | null
}

export interface CampaignRow {
  id: string
  businessId: string
  name: string
  mechanic: string
  status: string
  startDate: string
  endDate: string
  startTime: string
  endTime: string
  userCap: number
  perDayUserLimit: number
  playsPerDay: number
  overallWinners: number
  /** Derived for legacy display: round(overallWinners / userCap × 100) */
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
  spinConfig?: z.infer<typeof spinConfigSchema> | null
  diceConfig?: z.infer<typeof diceConfigSchema> | null
}

/** Lightweight campaign read — no stats/rewards aggregation (hot paths). */
export type CampaignLite = Pick<
  CampaignRow,
  | 'id'
  | 'businessId'
  | 'name'
  | 'mechanic'
  | 'status'
  | 'startDate'
  | 'endDate'
  | 'startTime'
  | 'endTime'
  | 'userCap'
  | 'perDayUserLimit'
  | 'playsPerDay'
  | 'overallWinners'
  | 'winRatePercent'
  | 'pin'
  | 'pinExpiresAt'
  | 'configJson'
  | 'claimPeriodDays'
  | 'capFilledAt'
  | 'currentUsers'
>

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

function previousPinGraceUntilIso(now = nowInCampaignTz()): string {
  // Always grace from rotation/verify time — covers late rotations when staff UI was stale
  return new Date(now.getTime() + PIN_VERIFY_GRACE_SECONDS * 1000).toISOString()
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

function pinExpiresAtIso(_mechanic = 'shake'): string {
  return new Date(nowInCampaignTz().getTime() + PIN_CYCLE_SECONDS * 1000).toISOString()
}

export function pinCycleSecondsForMechanic(_mechanic: string): number {
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
  const endTime = (row.end_time as string) ?? '23:59'
  const mechanic = row.mechanic as string
  const today = todayInCampaignTz()
  const now = nowInCampaignTz()

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

  const pastEndDate = today > endDate
  const pastEndTime = today === endDate && currentTimeInCampaignTz(now) > endTime
  if (pastEndDate || pastEndTime) {
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
  const batch = await fetchRewardsBatch([campaignId])
  return batch.get(campaignId) ?? []
}

interface CampaignStatsBundle {
  currentUsers: number
  participations: number
  rewardsClaimed: number
  redeemedCount: number
}

const emptyStats = (): CampaignStatsBundle => ({
  currentUsers: 0,
  participations: 0,
  rewardsClaimed: 0,
  redeemedCount: 0,
})

const CAMPAIGNS_LIST_CACHE_TTL_MS = Number(process.env.VENDOR_CAMPAIGNS_CACHE_MS ?? 30_000)
const campaignsListCache = new TtlCache<CampaignRow[]>(CAMPAIGNS_LIST_CACHE_TTL_MS)

export function invalidateCampaignsListCache(businessId?: string): void {
  if (businessId) campaignsListCache.delete(businessId)
  else campaignsListCache.clear()
}

function invalidateBusinessVendorCaches(businessId: string): void {
  invalidateCampaignsListCache(businessId)
  invalidateVendorDashboardCache(businessId)
  invalidateVendorCustomersCache(businessId)
}

/** Batch-load participation / play / reward stats for many campaigns (list view). */
export async function fetchCampaignStatsBatch(
  campaignIds: string[],
): Promise<Map<string, CampaignStatsBundle>> {
  const map = new Map<string, CampaignStatsBundle>()
  if (campaignIds.length === 0) return map
  for (const id of campaignIds) map.set(id, emptyStats())

  const placeholders = campaignIds.map(() => '?').join(', ')

  const [users, plays, wins, redeemed] = await Promise.all([
    db.execute({
      sql: `SELECT campaign_id, COUNT(*) AS c FROM campaign_participations
            WHERE campaign_id IN (${placeholders}) GROUP BY campaign_id`,
      args: campaignIds,
    }),
    db.execute({
      sql: `SELECT campaign_id, COUNT(*) AS c FROM game_plays
            WHERE campaign_id IN (${placeholders}) GROUP BY campaign_id`,
      args: campaignIds,
    }),
    db.execute({
      sql: `SELECT campaign_id, COUNT(*) AS c FROM game_plays
            WHERE campaign_id IN (${placeholders}) AND won = 1 GROUP BY campaign_id`,
      args: campaignIds,
    }),
    db.execute({
      sql: `SELECT campaign_id, COUNT(*) AS c FROM customer_rewards
            WHERE campaign_id IN (${placeholders}) AND status = 'redeemed' GROUP BY campaign_id`,
      args: campaignIds,
    }),
  ])

  for (const row of users.rows) {
    map.get(row.campaign_id as string)!.currentUsers = Number(row.c ?? 0)
  }
  for (const row of plays.rows) {
    map.get(row.campaign_id as string)!.participations = Number(row.c ?? 0)
  }
  for (const row of wins.rows) {
    map.get(row.campaign_id as string)!.rewardsClaimed = Number(row.c ?? 0)
  }
  for (const row of redeemed.rows) {
    map.get(row.campaign_id as string)!.redeemedCount = Number(row.c ?? 0)
  }

  return map
}

async function fetchRewardsBatch(campaignIds: string[]): Promise<Map<string, CampaignReward[]>> {
  const map = new Map<string, CampaignReward[]>()
  if (campaignIds.length === 0) return map
  for (const id of campaignIds) map.set(id, [])

  const placeholders = campaignIds.map(() => '?').join(', ')
  const result = await db.execute({
    sql: `SELECT id, campaign_id, name, description, icon, share_percent, reward_tier,
                 redeem_expiry_mode, redeem_fixed_date, redeem_relative_amount, redeem_relative_unit
          FROM campaign_rewards
          WHERE campaign_id IN (${placeholders})
          ORDER BY campaign_id ASC, sort_order ASC`,
    args: campaignIds,
  })

  for (const row of result.rows) {
    const campaignId = row.campaign_id as string
    map.get(campaignId)!.push({
      id: row.id as string,
      name: row.name as string,
      description: (row.description as string) ?? '',
      icon: (row.icon as string) ?? '🎁',
      sharePercent: row.share_percent as number,
      rewardTier: (row.reward_tier as string) ?? null,
      redeemExpiryMode: (row.redeem_expiry_mode as 'fixed' | 'relative') ?? 'relative',
      redeemFixedDate: (row.redeem_fixed_date as string) ?? null,
      redeemRelativeAmount: row.redeem_relative_amount != null ? Number(row.redeem_relative_amount) : null,
      redeemRelativeUnit: (row.redeem_relative_unit as 'day' | 'week' | 'month' | null) ?? null,
    })
  }

  return map
}

async function fetchStats(campaignId: string) {
  const batch = await fetchCampaignStatsBatch([campaignId])
  return batch.get(campaignId) ?? emptyStats()
}

async function fetchCurrentUsers(campaignId: string): Promise<number> {
  const result = await db.execute({
    sql: 'SELECT COUNT(*) as c FROM campaign_participations WHERE campaign_id = ?',
    args: [campaignId],
  })
  return Number(result.rows[0]?.c ?? 0)
}

export function mapRowToCampaignLite(
  row: Record<string, unknown>,
  currentUsers = 0,
): CampaignLite {
  const userCap = row.user_cap as number
  const overallWinners = Number(row.overall_winners ?? 0)
    || Math.max(1, Math.round(userCap * (row.win_rate_percent as number) / 100))
  return {
    id: row.id as string,
    businessId: row.business_id as string,
    name: row.name as string,
    mechanic: row.mechanic as string,
    status: row.status as string,
    startDate: row.start_date as string,
    endDate: row.end_date as string,
    startTime: (row.start_time as string) ?? '00:00',
    endTime: (row.end_time as string) ?? '23:59',
    userCap,
    perDayUserLimit: row.per_day_user_limit as number,
    playsPerDay: row.plays_per_day as number,
    overallWinners,
    winRatePercent: userCap > 0 ? Math.round((overallWinners / userCap) * 100) : 0,
    pin: (row.pin as string) ?? null,
    pinExpiresAt: (row.pin_expires_at as string) ?? null,
    configJson: (row.config_json as string) ?? null,
    claimPeriodDays: Number(row.claim_period_days ?? 30),
    capFilledAt: (row.cap_filled_at as string) ?? null,
    currentUsers,
  }
}

export async function getCampaignLiteById(campaignId: string): Promise<CampaignLite> {
  const result = await db.execute({
    sql: 'SELECT * FROM campaigns WHERE id = ?',
    args: [campaignId],
  })
  const row = result.rows[0]
  if (!row) throw new Error('CAMPAIGN_NOT_FOUND')
  const ensured = await ensureCampaignNotPastEnd(row as Record<string, unknown>)
  const currentUsers = await fetchCurrentUsers(campaignId)
  return mapRowToCampaignLite(ensured, currentUsers)
}

function mapRowToCampaignListRow(
  row: Record<string, unknown>,
  stats: CampaignStatsBundle,
  rewards: CampaignReward[],
): CampaignRow {
  const id = row.id as string
  const mechanic = row.mechanic as string
  const userCap = row.user_cap as number
  const overallWinners = Number(row.overall_winners ?? 0)
    || Math.max(1, Math.round(userCap * (row.win_rate_percent as number) / 100))
  return {
    id,
    businessId: row.business_id as string,
    name: row.name as string,
    mechanic,
    status: row.status as string,
    startDate: row.start_date as string,
    endDate: row.end_date as string,
    startTime: (row.start_time as string) ?? '00:00',
    endTime: (row.end_time as string) ?? '23:59',
    userCap,
    perDayUserLimit: row.per_day_user_limit as number,
    playsPerDay: row.plays_per_day as number,
    overallWinners,
    winRatePercent: userCap > 0 ? Math.round((overallWinners / userCap) * 100) : 0,
    pin: (row.pin as string) ?? null,
    pinExpiresAt: (row.pin_expires_at as string) ?? null,
    configJson: (row.config_json as string) ?? null,
    claimPeriodDays: Number(row.claim_period_days ?? 30),
    capFilledAt: (row.cap_filled_at as string) ?? null,
    createdAt: row.created_at as string,
    rewards,
    currentUsers: stats.currentUsers,
    participations: stats.participations,
    rewardsClaimed: stats.rewardsClaimed,
    redeemedCount: stats.redeemedCount,
  }
}

async function rowToCampaign(row: Record<string, unknown>): Promise<CampaignRow> {
  const id = row.id as string
  const stats = await fetchStats(id)
  const rewards = await fetchRewards(id)
  const mechanic = row.mechanic as string
  const userCap = row.user_cap as number
  const overallWinners = Number(row.overall_winners ?? 0) || Math.max(1, Math.round(userCap * (row.win_rate_percent as number) / 100))
  const base: CampaignRow = {
    id,
    businessId: row.business_id as string,
    name: row.name as string,
    mechanic,
    status: row.status as string,
    startDate: row.start_date as string,
    endDate: row.end_date as string,
    startTime: (row.start_time as string) ?? '00:00',
    endTime: (row.end_time as string) ?? '23:59',
    userCap,
    perDayUserLimit: row.per_day_user_limit as number,
    playsPerDay: row.plays_per_day as number,
    overallWinners,
    winRatePercent: userCap > 0 ? Math.round((overallWinners / userCap) * 100) : 0,
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
  if (mechanic === 'spin') {
    base.spinConfig = parseSpinConfig(base.configJson)
  }
  if (mechanic === 'dice') {
    base.diceConfig = parseDiceConfig(base.configJson)
  }
  return base
}

/** Fast post-insert read — rewards only, no stats aggregation (create response). */
async function campaignRowAfterCreate(campaignId: string): Promise<CampaignRow> {
  const [result, rewards, currentUsers] = await Promise.all([
    db.execute({ sql: 'SELECT * FROM campaigns WHERE id = ?', args: [campaignId] }),
    fetchRewards(campaignId),
    fetchCurrentUsers(campaignId),
  ])
  const row = result.rows[0]
  if (!row) throw new Error('CAMPAIGN_NOT_FOUND')
  const ensured = await ensureCampaignNotPastEnd(row as Record<string, unknown>)
  const lite = mapRowToCampaignLite(ensured, currentUsers)
  return {
    ...lite,
    createdAt: ensured.created_at as string,
    rewards,
    participations: 0,
    rewardsClaimed: 0,
    redeemedCount: 0,
  }
}

async function createShakeCampaign(userId: string, payload: CreateShakeCampaignPayload) {
  if (payload.overallWinners > payload.userCap) {
    throw new Error('OVERALL_WINNERS_EXCEEDS_USER_CAP')
  }

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
  const winRatePercent = Math.round((payload.overallWinners / payload.userCap) * 100)

  const statements = [
    {
      sql: `INSERT INTO campaigns (
        id, business_id, name, mechanic, status, start_date, end_date, start_time, end_time,
        user_cap, per_day_user_limit, plays_per_day, win_rate_percent,
        overall_winners,
        pin, pin_expires_at, claim_period_days
      ) VALUES (?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 30)`,
      args: [
        campaignId, businessId, payload.name, payload.mechanic,
        payload.startDate, payload.endDate, payload.startTime, payload.endTime,
        payload.userCap, perDayUserLimit, payload.playsPerDay,
        winRatePercent, payload.overallWinners,
        pin, pinExpires,
      ],
    },
    ...payload.rewards.map((r, i) => ({
      sql: `INSERT INTO campaign_rewards (id, campaign_id, name, description, icon, share_percent, sort_order, reward_tier,
              redeem_expiry_mode, redeem_fixed_date, redeem_relative_amount, redeem_relative_unit)
            VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?)`,
      args: [
        nanoid(), campaignId, r.name, r.description ?? '', r.icon, r.sharePercent, i,
        r.redeemExpiryMode, r.redeemFixedDate ?? null,
        r.redeemRelativeAmount ?? null, r.redeemRelativeUnit ?? null,
      ],
    })),
  ]

  await db.batch(statements)

  return campaignRowAfterCreate(campaignId)
}

async function createSpinCampaign(userId: string, payload: CreateSpinCampaignPayload) {
  validateSpinConfig(payload.spinConfig)

  const winSegments = payload.spinConfig.segments.filter(s => s.isWin && (s.reward ?? '').trim())
  const overallWinners = spinOverallWinners(payload.userCap, payload.spinConfig.segments)
  if (overallWinners > payload.userCap) {
    throw new Error('OVERALL_WINNERS_EXCEEDS_USER_CAP')
  }

  const shares = spinRewardShares(winSegments)
  const businessId = await getBusinessIdForUser(userId)
  const campaignId = nanoid()
  const pin = generatePin()
  const pinExpires = pinExpiresAtIso('spin')
  const perDayUserLimit =
    payload.startDate === payload.endDate
      ? payload.userCap
      : Math.min(payload.perDayUserLimit, payload.userCap)
  const winRatePercent = spinWinRatePercent(payload.spinConfig.segments)
  const configJson = JSON.stringify({
    type: 'spin',
    spinConfig: payload.spinConfig,
  })

  const statements = [
    {
      sql: `INSERT INTO campaigns (
        id, business_id, name, mechanic, status, start_date, end_date, start_time, end_time,
        user_cap, per_day_user_limit, plays_per_day, win_rate_percent,
        overall_winners, config_json,
        pin, pin_expires_at, claim_period_days
      ) VALUES (?, ?, ?, 'spin', 'active', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 30)`,
      args: [
        campaignId, businessId, payload.name,
        payload.startDate, payload.endDate, payload.startTime, payload.endTime,
        payload.userCap, perDayUserLimit, payload.playsPerDay,
        winRatePercent, overallWinners, configJson,
        pin, pinExpires,
      ],
    },
    ...winSegments.map((seg, i) => ({
      sql: `INSERT INTO campaign_rewards (id, campaign_id, name, description, icon, share_percent, sort_order, reward_tier,
              redeem_expiry_mode, redeem_fixed_date, redeem_relative_amount, redeem_relative_unit)
            VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?)`,
      args: [
        seg.id ?? nanoid(), campaignId, (seg.reward ?? '').trim(), seg.description ?? '', seg.icon ?? '🎁', shares[i] ?? 100, i,
        seg.redeemExpiryMode ?? 'relative',
        seg.redeemExpiryMode === 'fixed' ? (seg.redeemFixedDate ?? null) : null,
        seg.redeemExpiryMode === 'relative' ? (seg.redeemRelativeAmount ?? 7) : null,
        seg.redeemExpiryMode === 'relative' ? (seg.redeemRelativeUnit ?? 'day') : null,
      ],
    })),
  ]

  await db.batch(statements)

  return campaignRowAfterCreate(campaignId)
}

async function createDiceCampaign(userId: string, payload: CreateDiceCampaignPayload) {
  validateDiceConfig(payload.diceConfig)

  const winOutcomes = payload.diceConfig.outcomes.filter(o => o.isWin && (o.reward ?? '').trim())
  const overallWinners = diceOverallWinners(payload.userCap, payload.diceConfig.outcomes)
  if (overallWinners > payload.userCap) {
    throw new Error('OVERALL_WINNERS_EXCEEDS_USER_CAP')
  }

  const shares = diceRewardShares(winOutcomes)
  const businessId = await getBusinessIdForUser(userId)
  const campaignId = nanoid()
  const pin = generatePin()
  const pinExpires = pinExpiresAtIso('dice')
  const perDayUserLimit =
    payload.startDate === payload.endDate
      ? payload.userCap
      : Math.min(payload.perDayUserLimit, payload.userCap)
  const winRatePercent = diceWinRatePercent(payload.diceConfig.outcomes)
  const configJson = JSON.stringify({
    type: 'dice',
    diceConfig: payload.diceConfig,
  })

  const statements = [
    {
      sql: `INSERT INTO campaigns (
        id, business_id, name, mechanic, status, start_date, end_date, start_time, end_time,
        user_cap, per_day_user_limit, plays_per_day, win_rate_percent,
        overall_winners, config_json,
        pin, pin_expires_at, claim_period_days
      ) VALUES (?, ?, ?, 'dice', 'active', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 30)`,
      args: [
        campaignId, businessId, payload.name,
        payload.startDate, payload.endDate, payload.startTime, payload.endTime,
        payload.userCap, perDayUserLimit, payload.playsPerDay,
        winRatePercent, overallWinners, configJson,
        pin, pinExpires,
      ],
    },
    ...winOutcomes.map((outcome, i) => ({
      sql: `INSERT INTO campaign_rewards (id, campaign_id, name, description, icon, share_percent, sort_order, reward_tier,
              redeem_expiry_mode, redeem_fixed_date, redeem_relative_amount, redeem_relative_unit)
            VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?)`,
      args: [
        outcome.id ?? nanoid(), campaignId, (outcome.reward ?? '').trim(), outcome.description ?? '', outcome.icon ?? '🎁', shares[i] ?? 100, i,
        outcome.redeemExpiryMode ?? 'relative',
        outcome.redeemExpiryMode === 'fixed' ? (outcome.redeemFixedDate ?? null) : null,
        outcome.redeemExpiryMode === 'relative' ? (outcome.redeemRelativeAmount ?? 7) : null,
        outcome.redeemExpiryMode === 'relative' ? (outcome.redeemRelativeUnit ?? 'day') : null,
      ],
    })),
  ]

  await db.batch(statements)

  return campaignRowAfterCreate(campaignId)
}

async function createStampCampaign(userId: string, payload: CreateStampCampaignPayload) {
  validateStampConfig(payload.stampConfig)

  const allDrops = [
    ...payload.stampConfig.surpriseDrops.map(d => ({ ...d, tier: 'surprise' as const })),
    ...payload.stampConfig.bigRewards.map(d => ({ ...d, tier: 'big' as const })),
  ]

  for (const drop of allDrops) {
    const entries = payload.rewards[drop.tier][drop.id] ?? []
    if (drop.mode === 'single' && entries.length < 1) {
      throw new Error('INVALID_STAMP_REWARDS')
    }
    if (drop.mode === 'pool') {
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
  for (const drop of allDrops) {
    const entries = payload.rewards[drop.tier][drop.id] ?? []
    for (const r of entries) {
      rewardStatements.push({
        sql: `INSERT INTO campaign_rewards (
          id, campaign_id, name, description, icon, share_percent, sort_order, reward_tier,
          redeem_expiry_mode, redeem_fixed_date, redeem_relative_amount, redeem_relative_unit
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [
          nanoid(), campaignId, r.name, r.description ?? '', r.icon,
          drop.mode === 'single' ? 100 : r.winPercent,
          sortOrder++,
          stampRewardTierKey(drop.tier, drop.id),
          r.redeemExpiryMode,
          r.redeemFixedDate ?? null,
          r.redeemRelativeAmount ?? null,
          r.redeemRelativeUnit ?? null,
        ],
      })
    }
  }

  await db.batch([
    {
      sql: `INSERT INTO campaigns (
        id, business_id, name, mechanic, status, start_date, end_date, start_time, end_time,
        user_cap, per_day_user_limit, plays_per_day, win_rate_percent,
        config_json, pin, pin_expires_at, claim_period_days
      ) VALUES (?, ?, ?, 'stamp', 'active', ?, ?, ?, ?, ?, 0, 1, 0, ?, ?, ?, ?)`,
      args: [
        campaignId, businessId, payload.name,
        payload.startDate, payload.endDate, payload.startTime, payload.endTime,
        payload.userCap,
        configJson, pin, pinExpires, payload.claimPeriodDays,
      ],
    },
    ...rewardStatements,
  ])

  return campaignRowAfterCreate(campaignId)
}

async function createCheckInLoyaltyCampaignHandler(userId: string, payload: CreateCheckInLoyaltyCampaignPayload) {
  if (payload.milestones?.length) {
    validateMilestones(payload.milestones)
  }

  const businessId = await getBusinessIdForUser(userId)
  const campaignId = nanoid()
  const pin = generatePin()
  const pinExpires = pinExpiresAtIso('check-in-loyalty')
  const configJson = JSON.stringify({
    type: 'check-in-loyalty',
    checkInConfig: payload.checkInConfig,
  })

  const rewardStatements = (payload.milestones ?? []).map((m, i) => ({
    sql: `INSERT INTO campaign_rewards (id, campaign_id, name, description, icon, share_percent, sort_order, reward_tier)
          VALUES (?, ?, ?, ?, ?, ?, ?, 'milestone')`,
    args: [nanoid(), campaignId, m.name, m.description ?? '', m.icon, m.pointsThreshold, i],
  }))

  await db.batch([
    {
      sql: `INSERT INTO campaigns (
        id, business_id, name, mechanic, status, start_date, end_date, start_time, end_time,
        user_cap, per_day_user_limit, plays_per_day, win_rate_percent,
        config_json, pin, pin_expires_at, claim_period_days
      ) VALUES (?, ?, ?, 'check-in-loyalty', 'active', ?, ?, ?, ?, ?, 0, 1, 0, ?, ?, ?, 30)`,
      args: [
        campaignId, businessId, payload.name,
        payload.startDate, payload.endDate, payload.startTime, payload.endTime,
        payload.userCap,
        configJson, pin, pinExpires,
      ],
    },
    ...rewardStatements,
  ])

  return campaignRowAfterCreate(campaignId)
}

export async function createCampaign(userId: string, payload: CreateCampaignPayload) {
  const businessId = await getBusinessIdForUser(userId)
  let created: CampaignRow
  if (payload.mechanic === 'stamp') {
    created = await createStampCampaign(userId, payload)
  } else if (payload.mechanic === 'check-in-loyalty') {
    created = await createCheckInLoyaltyCampaignHandler(userId, payload)
  } else if (payload.mechanic === 'spin') {
    created = await createSpinCampaign(userId, payload)
  } else if (payload.mechanic === 'dice') {
    created = await createDiceCampaign(userId, payload)
  } else {
    created = await createShakeCampaign(userId, payload)
  }
  invalidateBusinessVendorCaches(businessId)
  return created
}

export async function listCampaignsForBusiness(userId: string) {
  const businessId = await getBusinessIdForUser(userId)
  const cached = campaignsListCache.get(businessId)
  if (cached) return cached

  await autoEndExpiredCampaigns(businessId)
  const result = await db.execute({
    sql: 'SELECT * FROM campaigns WHERE business_id = ? ORDER BY created_at DESC',
    args: [businessId],
  })
  const rows = result.rows as Record<string, unknown>[]
  if (rows.length === 0) {
    campaignsListCache.set(businessId, [])
    return []
  }

  const ids = rows.map(r => r.id as string)
  const [statsMap, rewardsMap] = await Promise.all([
    fetchCampaignStatsBatch(ids),
    fetchRewardsBatch(ids),
  ])

  const campaigns = rows.map(row => {
    const id = row.id as string
    return mapRowToCampaignListRow(
      row,
      statsMap.get(id) ?? emptyStats(),
      rewardsMap.get(id) ?? [],
    )
  })
  campaignsListCache.set(businessId, campaigns)
  return campaigns
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

  if (payload.status === 'active' && existing.status === 'ended') {
    throw new Error('CANNOT_REACTIVATE_ENDED')
  }

  let updated: CampaignRow
  if (existing.mechanic === 'stamp') {
    updated = await updateStampCampaign(userId, existing, payload)
  } else if (existing.mechanic === 'check-in-loyalty') {
    updated = await updateLoyaltyCampaign(userId, existing, payload)
  } else if (existing.mechanic === 'spin') {
    updated = await updateSpinCampaign(userId, existing, payload)
  } else if (existing.mechanic === 'dice') {
    updated = await updateDiceCampaign(userId, existing, payload)
  } else {
    updated = await updateShakeCampaign(userId, existing, payload)
  }
  invalidateBusinessVendorCaches(existing.businessId)
  return updated
}

export interface CampaignDeletionSummary {
  id: string
  name: string
  participations: number
  gamePlays: number
  customerRewards: number
  stampCards: number
  loyaltyCards: number
}

/** Delete campaign and all related rows (DB cascades: rewards, plays, participations, cards, etc.). */
export async function deleteCampaign(
  userId: string,
  campaignId: string,
): Promise<CampaignDeletionSummary> {
  const businessId = await getBusinessIdForUser(userId)
  const owned = await db.execute({
    sql: 'SELECT id, name FROM campaigns WHERE id = ? AND business_id = ?',
    args: [campaignId, businessId],
  })
  const row = owned.rows[0] as { id: string; name: string } | undefined
  if (!row) throw new Error('CAMPAIGN_NOT_FOUND')

  const [participations, gamePlays, customerRewards, stampCards, loyaltyCards] = await Promise.all([
    db.execute({ sql: 'SELECT COUNT(*) AS c FROM campaign_participations WHERE campaign_id = ?', args: [campaignId] }),
    db.execute({ sql: 'SELECT COUNT(*) AS c FROM game_plays WHERE campaign_id = ?', args: [campaignId] }),
    db.execute({ sql: 'SELECT COUNT(*) AS c FROM customer_rewards WHERE campaign_id = ?', args: [campaignId] }),
    db.execute({ sql: 'SELECT COUNT(*) AS c FROM stamp_cards WHERE campaign_id = ?', args: [campaignId] }),
    db.execute({ sql: 'SELECT COUNT(*) AS c FROM loyalty_cards WHERE campaign_id = ?', args: [campaignId] }),
  ])

  await db.execute({
    sql: 'DELETE FROM campaigns WHERE id = ? AND business_id = ?',
    args: [campaignId, businessId],
  })

  invalidateBusinessVendorCaches(businessId)

  return {
    id: row.id,
    name: row.name,
    participations: Number(participations.rows[0]?.c ?? 0),
    gamePlays: Number(gamePlays.rows[0]?.c ?? 0),
    customerRewards: Number(customerRewards.rows[0]?.c ?? 0),
    stampCards: Number(stampCards.rows[0]?.c ?? 0),
    loyaltyCards: Number(loyaltyCards.rows[0]?.c ?? 0),
  }
}

async function updateShakeCampaign(
  userId: string,
  existing: CampaignRow,
  payload: UpdateCampaignPayload,
) {
  if (payload.rewards !== undefined && isShakeRewardsUpdate(payload.rewards)) {
    const shareTotal = payload.rewards.reduce((s, r) => s + r.sharePercent, 0)
    if (shareTotal !== 100) {
      throw new Error('REWARD_SHARES_MUST_SUM_100')
    }
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
  if (payload.endTime !== undefined) {
    fields.push('end_time = ?')
    args.push(payload.endTime)
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
  if (payload.overallWinners !== undefined) {
    fields.push('overall_winners = ?')
    args.push(payload.overallWinners)
    const userCapForRate = payload.userCap ?? existing.userCap
    if (userCapForRate > 0) {
      fields.push('win_rate_percent = ?')
      args.push(Math.round((payload.overallWinners / userCapForRate) * 100))
    }
  } else if (payload.winRatePercent !== undefined) {
    fields.push('win_rate_percent = ?')
    args.push(payload.winRatePercent)
    const userCapForRate = payload.userCap ?? existing.userCap
    fields.push('overall_winners = ?')
    args.push(Math.max(1, Math.round(userCapForRate * payload.winRatePercent / 100)))
  }
  if (payload.userCap !== undefined && payload.overallWinners === undefined && payload.winRatePercent === undefined) {
    fields.push('win_rate_percent = ?')
    args.push(Math.round((existing.overallWinners / payload.userCap) * 100))
  }
  if (payload.status !== undefined) {
    fields.push('status = ?')
    args.push(payload.status)
  }

  if (fields.length === 0 && payload.rewards === undefined) {
    return existing
  }

  if (fields.length > 0) {
    args.push(existing.id, existing.businessId)
    await db.execute({
      sql: `UPDATE campaigns SET ${fields.join(', ')} WHERE id = ? AND business_id = ?`,
      args,
    })
  }

  if (payload.rewards !== undefined && isShakeRewardsUpdate(payload.rewards)) {
    await replaceShakeRewards(existing.id, existing.rewards, payload.rewards)
  }

  return getCampaignForBusiness(userId, existing.id)
}

async function replaceShakeRewards(
  campaignId: string,
  existingRewards: CampaignReward[],
  rewards: {
    id?: string
    name: string
    description?: string
    icon: string
    sharePercent: number
    redeemExpiryMode: 'fixed' | 'relative'
    redeemFixedDate?: string
    redeemRelativeAmount?: number
    redeemRelativeUnit?: 'day' | 'week' | 'month'
  }[],
) {
  const existingIds = new Set(existingRewards.map(r => r.id))
  const statements = [
    {
      sql: 'DELETE FROM campaign_rewards WHERE campaign_id = ?',
      args: [campaignId],
    },
    ...rewards.map((r, i) => ({
      sql: `INSERT INTO campaign_rewards (id, campaign_id, name, description, icon, share_percent, sort_order,
              redeem_expiry_mode, redeem_fixed_date, redeem_relative_amount, redeem_relative_unit)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        r.id && existingIds.has(r.id) ? r.id : nanoid(),
        campaignId,
        r.name,
        r.description ?? '',
        r.icon,
        r.sharePercent,
        i,
        r.redeemExpiryMode,
        r.redeemFixedDate ?? null,
        r.redeemRelativeAmount ?? null,
        r.redeemRelativeUnit ?? null,
      ],
    })),
  ]
  await db.batch(statements)
}

async function replaceSpinRewards(
  campaignId: string,
  _existingRewards: CampaignReward[],
  segments: SpinSegment[],
) {
  const winSegments = segments.filter(s => s.isWin && (s.reward ?? '').trim())
  const shares = spinRewardShares(winSegments)
  const statements = [
    {
      sql: 'DELETE FROM campaign_rewards WHERE campaign_id = ?',
      args: [campaignId],
    },
    ...winSegments.map((seg, i) => ({
      sql: `INSERT INTO campaign_rewards (id, campaign_id, name, description, icon, share_percent, sort_order,
              redeem_expiry_mode, redeem_fixed_date, redeem_relative_amount, redeem_relative_unit)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        seg.id ?? nanoid(),
        campaignId,
        (seg.reward ?? '').trim(),
        seg.description ?? '',
        seg.icon ?? '🎁',
        shares[i] ?? 100,
        i,
        seg.redeemExpiryMode ?? 'relative',
        seg.redeemExpiryMode === 'fixed' ? (seg.redeemFixedDate ?? null) : null,
        seg.redeemExpiryMode === 'relative' ? (seg.redeemRelativeAmount ?? 7) : null,
        seg.redeemExpiryMode === 'relative' ? (seg.redeemRelativeUnit ?? 'day') : null,
      ],
    })),
  ]
  await db.batch(statements)
}

async function updateSpinCampaign(
  userId: string,
  existing: CampaignRow,
  payload: UpdateCampaignPayload,
) {
  if (payload.spinConfig) {
    validateSpinConfig(payload.spinConfig)
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
  if (payload.endTime !== undefined) {
    fields.push('end_time = ?')
    args.push(payload.endTime)
  }
  if (payload.startTime !== undefined) {
    fields.push('start_time = ?')
    args.push(payload.startTime)
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
  if (payload.status !== undefined) {
    fields.push('status = ?')
    args.push(payload.status)
  }

  const segments = payload.spinConfig?.segments
  const userCapForRate = payload.userCap ?? existing.userCap

  if (segments) {
    const overallWinners = spinOverallWinners(userCapForRate, segments)
    const winRatePercent = spinWinRatePercent(segments)
    fields.push('overall_winners = ?', 'win_rate_percent = ?', 'config_json = ?')
    args.push(
      overallWinners,
      winRatePercent,
      JSON.stringify({ type: 'spin', spinConfig: payload.spinConfig }),
    )
  } else if (payload.userCap !== undefined) {
    const config = parseSpinConfig(existing.configJson)
    if (config) {
      const overallWinners = spinOverallWinners(userCapForRate, config.segments)
      const winRatePercent = spinWinRatePercent(config.segments)
      fields.push('overall_winners = ?', 'win_rate_percent = ?')
      args.push(overallWinners, winRatePercent)
    }
  }

  if (fields.length === 0 && !payload.spinConfig) {
    return existing
  }

  if (fields.length > 0) {
    args.push(existing.id, existing.businessId)
    await db.execute({
      sql: `UPDATE campaigns SET ${fields.join(', ')} WHERE id = ? AND business_id = ?`,
      args,
    })
  }

  if (payload.spinConfig) {
    await replaceSpinRewards(existing.id, existing.rewards, payload.spinConfig.segments)
  }

  return getCampaignForBusiness(userId, existing.id)
}

async function replaceDiceRewards(campaignId: string, outcomes: DiceOutcome[]) {
  const winOutcomes = outcomes.filter(o => o.isWin && (o.reward ?? '').trim())
  const shares = diceRewardShares(winOutcomes)
  const statements = [
    {
      sql: 'DELETE FROM campaign_rewards WHERE campaign_id = ?',
      args: [campaignId],
    },
    ...winOutcomes.map((outcome, i) => ({
      sql: `INSERT INTO campaign_rewards (id, campaign_id, name, description, icon, share_percent, sort_order,
              redeem_expiry_mode, redeem_fixed_date, redeem_relative_amount, redeem_relative_unit)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        outcome.id ?? nanoid(),
        campaignId,
        (outcome.reward ?? '').trim(),
        outcome.description ?? '',
        outcome.icon ?? '🎁',
        shares[i] ?? 100,
        i,
        outcome.redeemExpiryMode ?? 'relative',
        outcome.redeemExpiryMode === 'fixed' ? (outcome.redeemFixedDate ?? null) : null,
        outcome.redeemExpiryMode === 'relative' ? (outcome.redeemRelativeAmount ?? 7) : null,
        outcome.redeemExpiryMode === 'relative' ? (outcome.redeemRelativeUnit ?? 'day') : null,
      ],
    })),
  ]
  await db.batch(statements)
}

async function updateDiceCampaign(
  userId: string,
  existing: CampaignRow,
  payload: UpdateCampaignPayload,
) {
  if (payload.diceConfig) {
    validateDiceConfig(payload.diceConfig)
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
  if (payload.endTime !== undefined) {
    fields.push('end_time = ?')
    args.push(payload.endTime)
  }
  if (payload.startTime !== undefined) {
    fields.push('start_time = ?')
    args.push(payload.startTime)
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
  if (payload.status !== undefined) {
    fields.push('status = ?')
    args.push(payload.status)
  }

  const outcomes = payload.diceConfig?.outcomes
  const userCapForRate = payload.userCap ?? existing.userCap

  if (outcomes) {
    const overallWinners = diceOverallWinners(userCapForRate, outcomes)
    const winRatePercent = diceWinRatePercent(outcomes)
    fields.push('overall_winners = ?', 'win_rate_percent = ?', 'config_json = ?')
    args.push(
      overallWinners,
      winRatePercent,
      JSON.stringify({ type: 'dice', diceConfig: payload.diceConfig }),
    )
  } else if (payload.userCap !== undefined) {
    const config = parseDiceConfig(existing.configJson)
    if (config) {
      const overallWinners = diceOverallWinners(userCapForRate, config.outcomes)
      const winRatePercent = diceWinRatePercent(config.outcomes)
      fields.push('overall_winners = ?', 'win_rate_percent = ?')
      args.push(overallWinners, winRatePercent)
    }
  }

  if (fields.length === 0 && !payload.diceConfig) {
    return existing
  }

  if (fields.length > 0) {
    args.push(existing.id, existing.businessId)
    await db.execute({
      sql: `UPDATE campaigns SET ${fields.join(', ')} WHERE id = ? AND business_id = ?`,
      args,
    })
  }

  if (payload.diceConfig) {
    await replaceDiceRewards(existing.id, payload.diceConfig.outcomes)
  }

  return getCampaignForBusiness(userId, existing.id)
}

async function updateStampCampaign(
  userId: string,
  existing: CampaignRow,
  payload: UpdateCampaignPayload,
) {
  const stampConfig = payload.stampConfig
  if (stampConfig) {
    validateStampConfig(stampConfig)
  }

  if (payload.rewards !== undefined && isStampRewardsUpdate(payload.rewards)) {
    const config = stampConfig ?? parseStampConfig(existing.configJson)
    if (!config) throw new Error('INVALID_STAMP_CONFIG')

    const allDrops = [
      ...config.surpriseDrops.map(d => ({ ...d, tier: 'surprise' as const })),
      ...config.bigRewards.map(d => ({ ...d, tier: 'big' as const })),
    ]

    for (const drop of allDrops) {
      const entries = payload.rewards[drop.tier][drop.id] ?? []
      if (drop.mode === 'single' && entries.length < 1) {
        throw new Error('INVALID_STAMP_REWARDS')
      }
      if (drop.mode === 'pool') {
        const total = entries.reduce((s, r) => s + r.winPercent, 0)
        if (total > 100 || total < 1) {
          throw new Error('INVALID_STAMP_POOL')
        }
      }
    }
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
  if (payload.endTime !== undefined) {
    fields.push('end_time = ?')
    args.push(payload.endTime)
  }
  if (payload.userCap !== undefined) {
    fields.push('user_cap = ?')
    args.push(payload.userCap)
  }
  if (payload.claimPeriodDays !== undefined) {
    fields.push('claim_period_days = ?')
    args.push(payload.claimPeriodDays)
  }
  if (payload.status !== undefined) {
    fields.push('status = ?')
    args.push(payload.status)
  }
  if (stampConfig) {
    fields.push('config_json = ?')
    args.push(JSON.stringify({ type: 'stamp', stampConfig }))
  }

  if (fields.length === 0 && payload.rewards === undefined) {
    return existing
  }

  if (fields.length > 0) {
    args.push(existing.id, existing.businessId)
    await db.execute({
      sql: `UPDATE campaigns SET ${fields.join(', ')} WHERE id = ? AND business_id = ?`,
      args,
    })
  }

  if (payload.rewards !== undefined && isStampRewardsUpdate(payload.rewards)) {
    const config = stampConfig ?? parseStampConfig(existing.configJson)
    if (!config) throw new Error('INVALID_STAMP_CONFIG')

    const stampRewards = payload.rewards
    const allDrops = [
      ...config.surpriseDrops.map(d => ({ ...d, tier: 'surprise' as const })),
      ...config.bigRewards.map(d => ({ ...d, tier: 'big' as const })),
    ]

    const existingByTierKey = new Map<string, CampaignReward[]>()
    for (const r of existing.rewards) {
      const tier = r.rewardTier ?? ''
      if (!existingByTierKey.has(tier)) existingByTierKey.set(tier, [])
      existingByTierKey.get(tier)!.push(r)
    }

    const statements: { sql: string; args: (string | number | null)[] }[] = [
      { sql: 'DELETE FROM campaign_rewards WHERE campaign_id = ?', args: [existing.id] },
    ]

    let sortOrder = 0
    for (const drop of allDrops) {
      const tierKey = stampRewardTierKey(drop.tier, drop.id)
      const tierExisting = [...(existingByTierKey.get(tierKey) ?? [])]
      const entries = stampRewards[drop.tier][drop.id] ?? []

      for (const r of entries) {
        const matchedId = r.id && tierExisting.some(x => x.id === r.id)
          ? r.id
          : tierExisting.shift()?.id ?? nanoid()
        statements.push({
          sql: `INSERT INTO campaign_rewards (
            id, campaign_id, name, description, icon, share_percent, sort_order, reward_tier,
            redeem_expiry_mode, redeem_fixed_date, redeem_relative_amount, redeem_relative_unit
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          args: [
            matchedId!,
            existing.id,
            r.name,
            r.description ?? '',
            r.icon,
            drop.mode === 'single' ? 100 : r.winPercent,
            sortOrder++,
            tierKey,
            r.redeemExpiryMode,
            r.redeemFixedDate ?? null,
            r.redeemRelativeAmount ?? null,
            r.redeemRelativeUnit ?? null,
          ],
        })
      }
    }
    await db.batch(statements)
  }

  return getCampaignForBusiness(userId, existing.id)
}

async function updateLoyaltyCampaign(
  userId: string,
  existing: CampaignRow,
  payload: UpdateCampaignPayload,
) {
  if (payload.milestones !== undefined) {
    validateMilestones(payload.milestones)
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
  if (payload.endTime !== undefined) {
    fields.push('end_time = ?')
    args.push(payload.endTime)
  }
  if (payload.userCap !== undefined) {
    fields.push('user_cap = ?')
    args.push(payload.userCap)
  }
  if (payload.status !== undefined) {
    fields.push('status = ?')
    args.push(payload.status)
  }
  if (payload.checkInConfig !== undefined) {
    fields.push('config_json = ?')
    args.push(JSON.stringify({ type: 'check-in-loyalty', checkInConfig: payload.checkInConfig }))
  }

  if (fields.length === 0 && payload.milestones === undefined) {
    return existing
  }

  if (fields.length > 0) {
    args.push(existing.id, existing.businessId)
    await db.execute({
      sql: `UPDATE campaigns SET ${fields.join(', ')} WHERE id = ? AND business_id = ?`,
      args,
    })
  }

  if (payload.milestones !== undefined) {
    const milestones = payload.milestones
    const existingIds = new Set(existing.rewards.map(r => r.id))
    const statements = [
      { sql: 'DELETE FROM campaign_rewards WHERE campaign_id = ?', args: [existing.id] },
      ...milestones.map((m, i) => ({
        sql: `INSERT INTO campaign_rewards (id, campaign_id, name, description, icon, share_percent, sort_order, reward_tier)
              VALUES (?, ?, ?, ?, ?, ?, ?, 'milestone')`,
        args: [
          m.id && existingIds.has(m.id) ? m.id : nanoid(),
          existing.id,
          m.name,
          m.description ?? '',
          m.icon,
          m.pointsThreshold,
          i,
        ],
      })),
    ]
    await db.batch(statements)
  }

  return getCampaignForBusiness(userId, existing.id)
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
  const businessId = await getBusinessIdForUser(userId)
  const owned = await db.execute({
    sql: 'SELECT id FROM campaigns WHERE id = ? AND business_id = ?',
    args: [campaignId, businessId],
  })
  if (!owned.rows[0]) throw new Error('CAMPAIGN_NOT_FOUND')

  let refreshed = await rotatePinIfExpired(campaignId)
  const cycleSeconds = pinCycleSecondsForMechanic(refreshed.mechanic)
  let pinActive = refreshed.mechanic === 'stamp'
    ? isPinActiveForStamp(
        refreshed.status,
        refreshed.startDate,
        refreshed.endDate,
        refreshed.claimPeriodDays,
        refreshed.capFilledAt,
      )
    : refreshed.status === 'active'

  let secondsRemaining = refreshed.pinExpiresAt && pinActive
    ? computePinSecondsRemaining(refreshed.pinExpiresAt)
    : 0

  // Belt-and-suspenders: if still expired after rotate, force one more pass
  if (pinActive && secondsRemaining <= 0) {
    refreshed = await rotatePinIfExpired(campaignId)
    secondsRemaining = refreshed.pinExpiresAt
      ? computePinSecondsRemaining(refreshed.pinExpiresAt)
      : 0
  }

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
  const maxPinWindowMs = (PIN_CYCLE_SECONDS + PIN_VERIFY_GRACE_SECONDS) * 1000
  const pinWindowTooLong = Boolean(
    expiresAt && new Date(expiresAt).getTime() - now.getTime() > maxPinWindowMs,
  )
  const needsRotation = !expiresAt
    || new Date(expiresAt).getTime() <= now.getTime()
    || pinWindowTooLong

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
    const graceUntil = previousPinGraceUntilIso(now)
    const pin = generatePin()
    const pinExpires = pinExpiresAtIso(mechanic)
    const updated = await db.execute({
      sql: `UPDATE campaigns
            SET pin = ?, pin_expires_at = ?, previous_pin = ?, previous_pin_valid_until = ?
            WHERE id = ?
              AND (pin_expires_at IS NULL OR pin_expires_at <= ?)`,
      args: [pin, pinExpires, oldPin, graceUntil, campaignId, nowIso],
    })

    if ((updated.rowCount ?? 0) === 0) {
      return getCampaignLiteById(campaignId)
    }

    current.pin = pin
    current.pin_expires_at = pinExpires
    current.previous_pin = oldPin
    current.previous_pin_valid_until = graceUntil
  } else if (needsRotation && !pinStillNeeded && expiresAt) {
    // Inactive / ended campaigns — clear stale expiry so scheduler does not loop
    await db.execute({
      sql: `UPDATE campaigns
            SET pin = NULL, pin_expires_at = NULL, previous_pin = NULL, previous_pin_valid_until = NULL
            WHERE id = ? AND pin_expires_at IS NOT NULL`,
      args: [campaignId],
    })
  }

  return getCampaignLiteById(campaignId)
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
    sql: `SELECT DISTINCT b.id, b.name, b.tagline, b.business_type, b.city, b.brand_color,
                 b.logo_url, b.cover_banner_url, b.cover_thumbnail_url,
                 b.address, b.landmark, b.mobile,
                 b.operating_hours, b.google_review, b.interior_photo_urls,
                 b.rating, b.latitude, b.longitude, b.display_distance_km, b.mechanic_tags,
                 br.address AS branch_address, br.city AS branch_city
          FROM businesses b
          INNER JOIN campaigns c ON c.business_id = b.id
          LEFT JOIN branches br ON br.business_id = b.id AND br.is_primary = 1
          WHERE c.status = 'active'
            AND c.start_date <= ?
          ORDER BY b.name ASC`,
    args: [today],
  })

  function parseMechanicTags(raw: unknown): string[] {
    return parsePhotoArray(raw)
  }

  function isCampaignRowVisible(c: Record<string, unknown>, day: string): boolean {
    const mechanic = c.mechanic as string
    if (mechanic === 'stamp') {
      return isStampCampaignActive(
        'active',
        c.start_date as string,
        c.end_date as string,
        Number(c.claim_period_days ?? 30),
        (c.cap_filled_at as string) ?? null,
        day,
      )
    }
    if (mechanic === 'check-in-loyalty') {
      return day >= (c.start_date as string) && day <= (c.end_date as string)
    }
    return day <= (c.end_date as string)
  }

  function mapCampaignListItem(c: Record<string, unknown>) {
    const userCap = c.user_cap as number
    const winRate = c.win_rate_percent as number
    const overallWinners = Number(c.overall_winners ?? 0)
      || Math.max(1, Math.round(userCap * winRate / 100))
    return {
      id: c.id as string,
      name: c.name as string,
      mechanic: c.mechanic as string,
      startDate: c.start_date as string,
      endDate: c.end_date as string,
      winRatePercent: userCap > 0 ? Math.round((overallWinners / userCap) * 100) : winRate,
      overallWinners,
      userCap,
      playsPerDay: c.plays_per_day as number,
    }
  }

  const businessRows = result.rows
  const businessIds = [...new Set(businessRows.map(r => r.id as string))]
  if (businessIds.length === 0) return []

  const placeholders = businessIds.map(() => '?').join(', ')
  const campaignsResult = await db.execute({
    sql: `SELECT id, business_id, name, mechanic, start_date, end_date, user_cap, per_day_user_limit,
                 win_rate_percent, plays_per_day, overall_winners,
                 claim_period_days, cap_filled_at, config_json
          FROM campaigns
          WHERE business_id IN (${placeholders}) AND status = 'active' AND start_date <= ?`,
    args: [...businessIds, today],
  })

  const campaignsByBusiness = new Map<string, Record<string, unknown>[]>()
  for (const c of campaignsResult.rows as Record<string, unknown>[]) {
    if (!isCampaignRowVisible(c, today)) continue
    const businessId = c.business_id as string
    const list = campaignsByBusiness.get(businessId) ?? []
    list.push(c)
    campaignsByBusiness.set(businessId, list)
  }

  const seen = new Set<string>()
  const businesses = []
  for (const row of businessRows) {
    const businessId = row.id as string
    if (seen.has(businessId)) continue
    seen.add(businessId)

    const campaigns = (campaignsByBusiness.get(businessId) ?? []).map(mapCampaignListItem)
    if (campaigns.length === 0) continue

    businesses.push({
      id: businessId,
      name: row.name as string,
      tagline: (row.tagline as string) ?? '',
      businessType: (row.business_type as string) ?? 'Business',
      city: (row.city as string) ?? '',
      brandColor: (row.brand_color as string) ?? '#7C3AED',
      logoData: resolveImageField(row.logo_url, null),
      coverBannerData: resolveImageField(
        row.cover_thumbnail_url ?? row.cover_banner_url,
        null,
      ),
      address: (row.address as string) ?? '',
      landmark: (row.landmark as string) ?? '',
      mobile: (row.mobile as string) ?? '',
      operatingHours: (row.operating_hours as string) ?? '',
      googleReview: (row.google_review as string) ?? '',
      interiorPhotosData: resolvePhotoArrayField(row.interior_photo_urls, null),
      branchAddress: (row.branch_address as string) ?? '',
      branchCity: (row.branch_city as string) ?? '',
      rating: row.rating != null ? Number(row.rating) : null,
      latitude: row.latitude != null ? Number(row.latitude) : null,
      longitude: row.longitude != null ? Number(row.longitude) : null,
      displayDistanceKm: row.display_distance_km != null ? Number(row.display_distance_km) : null,
      mechanicTags: parseMechanicTags(row.mechanic_tags),
      campaigns,
    })
  }

  return businesses
}

export async function getPublicCampaign(campaignId: string) {
  const result = await db.execute({
    sql: `SELECT c.*, b.name AS business_name
          FROM campaigns c
          INNER JOIN businesses b ON b.id = c.business_id
          WHERE c.id = ?`,
    args: [campaignId],
  })
  const row = result.rows[0] as Record<string, unknown> | undefined
  if (!row) throw new Error('CAMPAIGN_NOT_FOUND')

  const [statsMap, rewardsMap] = await Promise.all([
    fetchCampaignStatsBatch([campaignId]),
    fetchRewardsBatch([campaignId]),
  ])
  const currentUsers = statsMap.get(campaignId)?.currentUsers ?? 0
  const rewards = rewardsMap.get(campaignId) ?? []
  const today = todayInCampaignTz()

  const campaign = {
    id: row.id as string,
    businessId: row.business_id as string,
    businessName: row.business_name as string,
    name: row.name as string,
    mechanic: row.mechanic as string,
    status: row.status as string,
    startDate: row.start_date as string,
    endDate: row.end_date as string,
    userCap: row.user_cap as number,
    currentUsers,
    perDayUserLimit: row.per_day_user_limit as number,
    playsPerDay: row.plays_per_day as number,
    winRatePercent: (() => {
      const userCap = row.user_cap as number
      const overallWinners = Number(row.overall_winners ?? 0)
        || Math.max(1, Math.round(userCap * (row.win_rate_percent as number) / 100))
      return userCap > 0 ? Math.round((overallWinners / userCap) * 100) : 0
    })(),
    overallWinners: Number(row.overall_winners ?? 0)
      || Math.max(1, Math.round((row.user_cap as number) * (row.win_rate_percent as number) / 100)),
    configJson: (row.config_json as string) ?? null,
    claimPeriodDays: Number(row.claim_period_days ?? 30),
    capFilledAt: (row.cap_filled_at as string) ?? null,
  }

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
      businessName: campaign.businessName,
      name: campaign.name,
      mechanic: campaign.mechanic,
      startDate: campaign.startDate,
      endDate: campaign.endDate,
      userCap: campaign.userCap,
      currentUsers: campaign.currentUsers,
      claimPeriodDays: campaign.claimPeriodDays,
      stampConfig: meta?.config ?? null,
      rewards: rewards.map(r => ({
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
    const startTime = (row.start_time as string) ?? '00:00'
    const endTime = (row.end_time as string) ?? '23:59'
    if (!isCampaignInWindow(campaign.startDate, campaign.endDate, startTime, endTime)) {
      throw new Error('CAMPAIGN_NOT_ACTIVE')
    }

    const { parseCheckInConfig } = await import('./check-in-loyalty.js')
    const checkInConfig = parseCheckInConfig(campaign.configJson)

    return {
      id: campaign.id,
      businessId: campaign.businessId,
      businessName: campaign.businessName,
      name: campaign.name,
      mechanic: campaign.mechanic,
      startDate: campaign.startDate,
      endDate: campaign.endDate,
      userCap: campaign.userCap,
      currentUsers: campaign.currentUsers,
      checkInConfig,
      rewards: rewards.map(r => ({
        id: r.id,
        name: r.name,
        description: r.description,
        icon: r.icon,
        pointsThreshold: r.sharePercent,
      })),
    }
  }

  if (campaign.status !== 'active') throw new Error('CAMPAIGN_NOT_ACTIVE')
  const startTime = (row.start_time as string) ?? '00:00'
  const endTime = (row.end_time as string) ?? '23:59'
  if (!isCampaignInWindow(campaign.startDate, campaign.endDate, startTime, endTime)) {
    throw new Error('CAMPAIGN_NOT_ACTIVE')
  }

  const spinConfig = campaign.mechanic === 'spin'
    ? parseSpinConfig(campaign.configJson)
    : null
  const diceConfig = campaign.mechanic === 'dice'
    ? parseDiceConfig(campaign.configJson)
    : null

  return {
    id: campaign.id,
    businessId: campaign.businessId,
    businessName: campaign.businessName,
    name: campaign.name,
    mechanic: campaign.mechanic,
    startDate: campaign.startDate,
    endDate: campaign.endDate,
    playsPerDay: campaign.playsPerDay,
    winRatePercent: campaign.winRatePercent,
    overallWinners: campaign.overallWinners,
    ...(spinConfig ? { spinConfig } : {}),
    ...(diceConfig ? { diceConfig } : {}),
    rewards: rewards.map(r => ({
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

  const now = nowInCampaignTz()

  let pinRow = await db.execute({
    sql: `SELECT pin, pin_expires_at, previous_pin, previous_pin_valid_until, mechanic,
                 status, start_date, end_date, claim_period_days, cap_filled_at
          FROM campaigns WHERE id = ?`,
    args: [campaignId],
  })
  let row = pinRow.rows[0]
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
    const startTime = (row.start_time as string) ?? '00:00'
    const endTime = (row.end_time as string) ?? '23:59'
    if (!isCampaignInWindow(startDate, endDate, startTime, endTime, now)) {
      throw new Error('CAMPAIGN_NOT_ACTIVE')
    }
  }

  const pinExpiresAt = (row.pin_expires_at as string | null) ?? null
  if (
    mechanic !== 'stamp' &&
    pinExpiresAt &&
    new Date(pinExpiresAt).getTime() <= now.getTime()
  ) {
    await rotatePinIfExpired(campaignId)
    pinRow = await db.execute({
      sql: `SELECT pin, pin_expires_at, previous_pin, previous_pin_valid_until, mechanic,
                   status, start_date, end_date, claim_period_days, cap_filled_at
            FROM campaigns WHERE id = ?`,
      args: [campaignId],
    })
    row = pinRow.rows[0]
    if (!row) throw new Error('CAMPAIGN_NOT_FOUND')
  }

  const pinState: PinVerificationRow = {
    pin: (row.pin as string | null) ?? null,
    pinExpiresAt: (row.pin_expires_at as string | null) ?? null,
    previousPin: (row.previous_pin as string | null) ?? null,
    previousPinValidUntil: (row.previous_pin_valid_until as string | null) ?? null,
    mechanic,
  }

  if (!isPinValidForVerify(normalizedPin, pinState, now)) {
    throw new Error('INVALID_PIN')
  }

  const playSessionToken = signPlaySession(campaignId, customerId)
  return { valid: true, playSessionToken, expiresIn: 300 }
}

export async function getPlayState(campaignId: string, customerId: string) {
  const campaign = await getCampaignLiteById(campaignId)
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
    overallWinners: campaign.overallWinners,
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

export interface EligibilityContext {
  participation?: Record<string, unknown> | null
  totalUsers?: number
  dailyNewUsers?: number
}

export async function checkEligibility(
  campaign: CampaignLite | CampaignRow,
  customerId: string,
  ctx?: EligibilityContext,
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
  const startTime = campaign.startTime ?? '00:00'
  const endTime = campaign.endTime ?? '23:59'
  if (!isCampaignInWindow(campaign.startDate, campaign.endDate, startTime, endTime)) {
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

  const partResult = ctx?.participation !== undefined
    ? { rows: ctx.participation ? [ctx.participation] : [] }
    : await db.execute({
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
    const totalUsers = ctx?.totalUsers ?? Number((await db.execute({
      sql: 'SELECT COUNT(*) as c FROM campaign_participations WHERE campaign_id = ?',
      args: [campaign.id],
    })).rows[0]?.c ?? 0)

    if (totalUsers >= campaign.userCap) {
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
    const dailyNew = ctx?.dailyNewUsers ?? Number((await db.execute({
      sql: `SELECT COUNT(*) as c FROM campaign_participations
            WHERE campaign_id = ? AND ${istDateSql('first_played_at')} = ?`,
      args: [campaign.id, today],
    })).rows[0]?.c ?? 0)

    if (dailyNew >= dailyLimit) {
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
      (SELECT COUNT(DISTINCT customer_id) FROM game_plays
       WHERE campaign_id = ? AND ${playedAtIst} = ? AND won = 1) AS winning_players_today,
      (SELECT COUNT(DISTINCT customer_id) FROM game_plays
       WHERE campaign_id = ? AND won = 1) AS total_winning_players,
      (SELECT COUNT(*) FROM game_plays
       WHERE campaign_id = ? AND customer_id = ? AND ${playedAtIst} = ?) AS customer_plays_today,
      (SELECT COUNT(*) FROM game_plays
       WHERE campaign_id = ? AND customer_id = ? AND ${playedAtIst} = ? AND won = 1) AS customer_won_today`,
    args: [
      campaignId, today,
      campaignId, today,
      campaignId,
      campaignId, customerId, today,
      campaignId, customerId, today,
    ],
  })
  const row = result.rows[0]!
  return {
    uniquePlayersBefore: Number(row.unique_players ?? 0),
    winsBeforeToday: Number(row.winning_players_today ?? 0),
    totalWinsBefore: Number(row.total_winning_players ?? 0),
    isFirstPlayToday: Number(row.customer_plays_today ?? 0) === 0,
    customerAlreadyWonToday: Number(row.customer_won_today ?? 0) > 0,
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
  if (campaign.mechanic !== 'shake' && campaign.mechanic !== 'spin' && campaign.mechanic !== 'dice') {
    throw new Error('INVALID_MECHANIC')
  }
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
    overallWinners: campaign.overallWinners,
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
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      playId, campaignId, customerId, campaign.mechanic,
      won ? 1 : 0,
      reward?.id ?? null,
      reward?.name ?? null,
      redemptionCode,
    ],
  })

  if (won && reward && redemptionCode) {
    const redeemExpiresAt = computeRedeemExpiryDate(
      reward.redeemExpiryMode ?? 'relative',
      reward.redeemFixedDate ?? null,
      reward.redeemRelativeAmount ?? 7,
      reward.redeemRelativeUnit ?? 'day',
    )
    statements.push({
      sql: `INSERT INTO customer_rewards
            (id, customer_id, campaign_id, play_id, reward_name, icon, redemption_code, status, earned_at, business_id, source_type, redeem_expires_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, 'earned', datetime('now'), ?, 'campaign_win', ?)`,
      args: [nanoid(), customerId, campaignId, playId, reward.name, reward.icon, redemptionCode, campaign.businessId, redeemExpiresAt],
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
    sql: `SELECT cr.*,
                 COALESCE(c.name, 'Rewards') as campaign_name,
                 COALESCE(c.mechanic, 'points_claim') as mechanic
          FROM customer_rewards cr
          LEFT JOIN campaigns c ON c.id = cr.campaign_id
          WHERE cr.customer_id = ?
          ORDER BY cr.earned_at DESC`,
    args: [customerId],
  })

  const expiredIds: string[] = []
  const rows = result.rows.map(row => {
    const redeemExpiresAt = (row.redeem_expires_at as string) ?? null
    let status = row.status as string
    if (status === 'earned' && isCustomerRewardExpired(redeemExpiresAt)) {
      status = 'expired'
      expiredIds.push(row.id as string)
    }
    return {
      id: row.id as string,
      campaignId: row.campaign_id as string,
      businessId: (row.business_id as string) ?? null,
      campaignName: row.campaign_name as string,
      mechanic: row.mechanic as string,
      reward: row.reward_name as string,
      icon: (row.icon as string) ?? '🎁',
      earnedAt: row.earned_at as string,
      status,
      requestedAt: (row.requested_at as string) ?? undefined,
      redeemedAt: (row.redeemed_at as string) ?? undefined,
      code: row.redemption_code as string,
      redeemBefore: redeemExpiresAt,
    }
  })

  if (expiredIds.length > 0) {
    const placeholders = expiredIds.map(() => '?').join(', ')
    await db.execute({
      sql: `UPDATE customer_rewards SET status = 'expired' WHERE id IN (${placeholders}) AND status = 'earned'`,
      args: expiredIds,
    })
  }

  return rows
}

export async function requestCustomerRedemption(customerId: string, rewardId: string) {
  const check = await db.execute({
    sql: `SELECT id, status, redeem_expires_at FROM customer_rewards WHERE id = ? AND customer_id = ?`,
    args: [rewardId, customerId],
  })
  if (check.rows.length === 0) throw new Error('REWARD_NOT_FOUND')
  const row = check.rows[0]!
  const status = row.status as string
  if (status === 'pending') throw new Error('ALREADY_REQUESTED')
  if (status === 'redeemed') throw new Error('ALREADY_REDEEMED')
  if (status === 'expired' || isCustomerRewardExpired((row.redeem_expires_at as string) ?? null)) {
    await db.execute({
      sql: `UPDATE customer_rewards SET status = 'expired' WHERE id = ? AND status = 'earned'`,
      args: [rewardId],
    })
    throw new Error('REWARD_EXPIRED')
  }
  if (status !== 'earned') throw new Error('INVALID_STATUS')

  await db.execute({
    sql: `UPDATE customer_rewards SET status = 'pending', requested_at = datetime('now') WHERE id = ?`,
    args: [rewardId],
  })
}
