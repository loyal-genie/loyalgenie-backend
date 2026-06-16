import { nanoid } from 'nanoid'
import { db } from '../db/client.js'
import {
  addCampaignDays,
  todayInCampaignTz,
  nowInCampaignTz,
} from '../utils/campaign-dates.js'
import {
  verifyPlaySession,
  getCampaignById,
  type CampaignReward,
} from './campaigns.js'
import {
  stampConfigSchema,
  createStampCampaignSchema,
  type CreateStampCampaignPayload,
  type StampConfig,
} from './stamp-campaign-schema.js'

export {
  stampConfigSchema,
  createStampCampaignSchema,
  type CreateStampCampaignPayload,
  type StampConfig,
} from './stamp-campaign-schema.js'

export const PIN_CYCLE_STAMP_SECONDS = 86400
const STAMP_PIN_GRACE_MINUTES = 30

export interface StampCardRow {
  id: string
  campaignId: string
  customerId: string
  stampsCollected: number
  surpriseTriggerAt: number
  bigTriggerAt: number
  surpriseAwarded: boolean
  bigAwarded: boolean
  status: 'active' | 'completed' | 'expired'
  enrolledAt: string
  completedAt: string | null
  expiredAt: string | null
  lastStampDate: string | null
}

export interface StampCampaignMeta {
  claimPeriodDays: number
  capFilledAt: string | null
  config: StampConfig
}

export function validateStampConfig(config: StampConfig): void {
  const half = Math.floor(config.totalStamps / 2)
  const [sFrom, sTo] = config.surpriseRange
  const [bFrom, bTo] = config.bigRange

  if (config.prefillStamps >= config.totalStamps) {
    throw new Error('INVALID_STAMP_CONFIG')
  }
  if (sFrom < 1 || sTo > half || sFrom > sTo) {
    throw new Error('INVALID_STAMP_CONFIG')
  }
  if (bFrom < half + 1 || bTo > config.totalStamps || bFrom > bTo) {
    throw new Error('INVALID_STAMP_CONFIG')
  }
  if (sTo >= bFrom) {
    throw new Error('INVALID_STAMP_CONFIG')
  }
}

export function parseStampConfig(json: string | null | undefined): StampConfig | null {
  if (!json) return null
  try {
    const parsed = JSON.parse(json) as Record<string, unknown>
    if (parsed.type === 'stamp' && parsed.stampConfig) {
      return stampConfigSchema.parse(parsed.stampConfig)
    }
    if (parsed.totalStamps !== undefined) {
      return stampConfigSchema.parse(parsed)
    }
  } catch {
    return null
  }
  return null
}

export function parseStampCampaignMeta(row: Record<string, unknown>): StampCampaignMeta | null {
  const config = parseStampConfig(row.config_json as string | null)
  if (!config) return null
  return {
    claimPeriodDays: Number(row.claim_period_days ?? 30),
    capFilledAt: (row.cap_filled_at as string) ?? null,
    config,
  }
}

export function randomIntInclusive(min: number, max: number): number {
  return min + Math.floor(Math.random() * (max - min + 1))
}

export function getEnrollmentCloseDate(
  endDate: string,
  capFilledAt: string | null,
): string {
  if (capFilledAt) return capFilledAt.slice(0, 10)
  return endDate
}

export function isEnrollmentOpen(
  startDate: string,
  endDate: string,
  userCap: number,
  currentUsers: number,
  capFilledAt: string | null,
  today = todayInCampaignTz(),
): boolean {
  if (capFilledAt) return false
  if (today < startDate || today > endDate) return false
  return currentUsers < userCap
}

export function getClaimDeadline(
  endDate: string,
  claimPeriodDays: number,
  capFilledAt: string | null,
): string {
  const closeDate = getEnrollmentCloseDate(endDate, capFilledAt)
  return addCampaignDays(closeDate, claimPeriodDays)
}

export function isStampCampaignActive(
  status: string,
  startDate: string,
  endDate: string,
  claimPeriodDays: number,
  capFilledAt: string | null,
  today = todayInCampaignTz(),
): boolean {
  if (status !== 'active') return false
  if (today < startDate) return false
  return today <= getClaimDeadline(endDate, claimPeriodDays, capFilledAt)
}

export function isPinActiveForStamp(
  status: string,
  startDate: string,
  endDate: string,
  claimPeriodDays: number,
  capFilledAt: string | null,
  today = todayInCampaignTz(),
): boolean {
  return isStampCampaignActive(status, startDate, endDate, claimPeriodDays, capFilledAt, today)
}

function rowToStampCard(row: Record<string, unknown>): StampCardRow {
  return {
    id: row.id as string,
    campaignId: row.campaign_id as string,
    customerId: row.customer_id as string,
    stampsCollected: row.stamps_collected as number,
    surpriseTriggerAt: row.surprise_trigger_at as number,
    bigTriggerAt: row.big_trigger_at as number,
    surpriseAwarded: Boolean(row.surprise_awarded),
    bigAwarded: Boolean(row.big_awarded),
    status: row.status as StampCardRow['status'],
    enrolledAt: row.enrolled_at as string,
    completedAt: (row.completed_at as string) ?? null,
    expiredAt: (row.expired_at as string) ?? null,
    lastStampDate: (row.last_stamp_date as string) ?? null,
  }
}

async function fetchStampCard(campaignId: string, customerId: string): Promise<StampCardRow | null> {
  const result = await db.execute({
    sql: 'SELECT * FROM stamp_cards WHERE campaign_id = ? AND customer_id = ?',
    args: [campaignId, customerId],
  })
  const row = result.rows[0]
  return row ? rowToStampCard(row as Record<string, unknown>) : null
}

async function fetchTierRewards(campaignId: string, tier: 'surprise' | 'big'): Promise<CampaignReward[]> {
  const result = await db.execute({
    sql: `SELECT id, name, description, icon, share_percent FROM campaign_rewards
          WHERE campaign_id = ? AND reward_tier = ? ORDER BY sort_order ASC`,
    args: [campaignId, tier],
  })
  return result.rows.map(row => ({
    id: row.id as string,
    name: row.name as string,
    description: (row.description as string) ?? '',
    icon: (row.icon as string) ?? '🎁',
    sharePercent: row.share_percent as number,
  }))
}

export function rollPoolReward(rewards: CampaignReward[]): CampaignReward | null {
  const total = rewards.reduce((s, r) => s + r.sharePercent, 0)
  if (total <= 0) return null
  const roll = Math.random() * 100
  if (roll > total) return null
  let remaining = roll
  for (const reward of rewards) {
    remaining -= reward.sharePercent
    if (remaining <= 0) return reward
  }
  return rewards[rewards.length - 1]!
}

function generateRedemptionCode(customerId: string): string {
  return `${customerId.slice(0, 4).toUpperCase()}-${nanoid(6).toUpperCase()}`
}

interface TriggerResult {
  tier: 'surprise' | 'big' | null
  won: boolean
  reward: CampaignReward | null
  code: string | null
  playId: string | null
}

async function evaluateTriggers(
  card: StampCardRow,
  campaignId: string,
  customerId: string,
  config: StampConfig,
  surpriseRewards: CampaignReward[],
  bigRewards: CampaignReward[],
): Promise<TriggerResult[]> {
  const results: TriggerResult[] = []

  if (!card.surpriseAwarded && card.stampsCollected >= card.surpriseTriggerAt) {
    const reward = config.surpriseMode === 'single'
      ? surpriseRewards[0] ?? null
      : rollPoolReward(surpriseRewards)
    const won = reward !== null
    const playId = nanoid()
    const code = won ? generateRedemptionCode(customerId) : null
    results.push({ tier: 'surprise', won, reward, code, playId })
  }

  if (!card.bigAwarded && card.stampsCollected >= card.bigTriggerAt) {
    const reward = config.bigMode === 'single'
      ? bigRewards[0] ?? null
      : rollPoolReward(bigRewards)
    const won = reward !== null
    const playId = nanoid()
    const code = won ? generateRedemptionCode(customerId) : null
    results.push({ tier: 'big', won, reward, code, playId })
  }

  return results
}

async function expireStaleCards(campaignId: string, claimDeadline: string, today: string): Promise<void> {
  if (today <= claimDeadline) return
  await db.execute({
    sql: `UPDATE stamp_cards SET status = 'expired', expired_at = datetime('now')
          WHERE campaign_id = ? AND status = 'active'`,
    args: [campaignId],
  })
  await db.execute({
    sql: `UPDATE campaigns SET status = 'ended' WHERE id = ? AND status = 'active'`,
    args: [campaignId],
  })
}

async function maybeMarkCapFilled(campaignId: string, userCap: number): Promise<void> {
  const count = await db.execute({
    sql: 'SELECT COUNT(*) as c FROM campaign_participations WHERE campaign_id = ?',
    args: [campaignId],
  })
  const users = Number(count.rows[0]?.c ?? 0)
  if (users >= userCap) {
    const today = todayInCampaignTz()
    await db.execute({
      sql: `UPDATE campaigns SET cap_filled_at = COALESCE(cap_filled_at, ?) WHERE id = ?`,
      args: [`${today}T12:00:00+05:30`, campaignId],
    })
  }
}

export async function getStampState(campaignId: string, customerId: string) {
  const campaign = await getCampaignById(campaignId)
  if (campaign.mechanic !== 'stamp') throw new Error('NOT_STAMP_CAMPAIGN')

  const raw = await db.execute({
    sql: 'SELECT config_json, claim_period_days, cap_filled_at FROM campaigns WHERE id = ?',
    args: [campaignId],
  })
  const row = raw.rows[0] as Record<string, unknown>
  const meta = parseStampCampaignMeta(row)
  if (!meta) throw new Error('INVALID_STAMP_CONFIG')

  const today = todayInCampaignTz()
  const claimDeadline = getClaimDeadline(
    campaign.endDate,
    meta.claimPeriodDays,
    meta.capFilledAt,
  )
  await expireStaleCards(campaignId, claimDeadline, today)

  const card = await fetchStampCard(campaignId, customerId)
  const enrollmentOpen = isEnrollmentOpen(
    campaign.startDate,
    campaign.endDate,
    campaign.userCap,
    campaign.currentUsers,
    meta.capFilledAt,
    today,
  )

  const withinClaimWindow = claimDeadline ? today <= claimDeadline : today <= campaign.endDate

  const canCollectToday = card
    ? card.status === 'active'
      && card.stampsCollected < meta.config.totalStamps
      && card.lastStampDate !== today
      && withinClaimWindow
    : enrollmentOpen && withinClaimWindow

  return {
    campaignId,
    mechanic: 'stamp' as const,
    enrolled: Boolean(card),
    enrollmentOpen,
    stampsCollected: card?.stampsCollected ?? 0,
    totalStamps: meta.config.totalStamps,
    prefillStamps: meta.config.prefillStamps,
    surpriseRange: meta.config.surpriseRange,
    bigRange: meta.config.bigRange,
    surpriseAwarded: card?.surpriseAwarded ?? false,
    bigAwarded: card?.bigAwarded ?? false,
    surpriseTriggerAt: card?.surpriseTriggerAt ?? null,
    bigTriggerAt: card?.bigTriggerAt ?? null,
    status: card?.status ?? null,
    claimDeadline,
    enrollmentCloseDate: getEnrollmentCloseDate(campaign.endDate, meta.capFilledAt),
    canCollectToday,
    cardComplete: card?.status === 'completed',
    userCap: campaign.userCap,
    currentUsers: campaign.currentUsers,
  }
}

export async function executeStampCollect(
  campaignId: string,
  customerId: string,
  playSessionToken: string,
) {
  if (!verifyPlaySession(playSessionToken, campaignId, customerId)) {
    throw new Error('INVALID_PLAY_SESSION')
  }

  const campaign = await getCampaignById(campaignId)
  if (campaign.mechanic !== 'stamp') throw new Error('NOT_STAMP_CAMPAIGN')

  const raw = await db.execute({
    sql: 'SELECT config_json, claim_period_days, cap_filled_at, status FROM campaigns WHERE id = ?',
    args: [campaignId],
  })
  const row = raw.rows[0] as Record<string, unknown>
  const meta = parseStampCampaignMeta(row)
  if (!meta) throw new Error('INVALID_STAMP_CONFIG')

  const today = todayInCampaignTz()
  const claimDeadline = getClaimDeadline(
    campaign.endDate,
    meta.claimPeriodDays,
    meta.capFilledAt,
  )

  if (!isStampCampaignActive(
    campaign.status,
    campaign.startDate,
    campaign.endDate,
    meta.claimPeriodDays,
    meta.capFilledAt,
    today,
  )) {
    throw new Error('CAMPAIGN_NOT_ACTIVE')
  }

  if (claimDeadline) {
    await expireStaleCards(campaignId, claimDeadline, today)
  }

  let card = await fetchStampCard(campaignId, customerId)
  const isNew = !card

  if (isNew) {
    if (!isEnrollmentOpen(
      campaign.startDate,
      campaign.endDate,
      campaign.userCap,
      campaign.currentUsers,
      meta.capFilledAt,
      today,
    )) {
      throw new Error('USER_CAP_REACHED')
    }

    const surpriseTriggerAt = randomIntInclusive(...meta.config.surpriseRange)
    const bigTriggerAt = randomIntInclusive(...meta.config.bigRange)
    const cardId = nanoid()
    const initialStamps = meta.config.prefillStamps

    await db.batch([
      {
        sql: `INSERT INTO stamp_cards (
          id, campaign_id, customer_id, stamps_collected,
          surprise_trigger_at, big_trigger_at, status, enrolled_at, last_stamp_date
        ) VALUES (?, ?, ?, ?, ?, ?, 'active', datetime('now'), NULL)`,
        args: [cardId, campaignId, customerId, initialStamps, surpriseTriggerAt, bigTriggerAt],
      },
      {
        sql: `INSERT INTO campaign_participations
              (id, campaign_id, customer_id, plays_today, last_play_date, total_plays, first_played_at, last_played_at)
              VALUES (?, ?, ?, 0, NULL, 0, datetime('now'), datetime('now'))`,
        args: [nanoid(), campaignId, customerId],
      },
    ])

    card = (await fetchStampCard(campaignId, customerId))!
    await maybeMarkCapFilled(campaignId, campaign.userCap)

    // Evaluate prefill triggers
    const surpriseRewards = await fetchTierRewards(campaignId, 'surprise')
    const bigRewards = await fetchTierRewards(campaignId, 'big')
    const prefillTriggers = await evaluateTriggers(
      card, campaignId, customerId, meta.config, surpriseRewards, bigRewards,
    )
    if (prefillTriggers.length > 0) {
      await applyTriggerResults(card, campaignId, customerId, prefillTriggers)
      card = (await fetchStampCard(campaignId, customerId))!
    }
  } else {
    if (!card) throw new Error('CARD_NOT_FOUND')
    if (card.status === 'expired') throw new Error('CARD_EXPIRED')
    if (card.status === 'completed') throw new Error('CARD_COMPLETE')
    if (card.lastStampDate === today) throw new Error('STAMP_ALREADY_COLLECTED_TODAY')
    if (claimDeadline && today > claimDeadline) throw new Error('CLAIM_PERIOD_ENDED')
  }

  if (!card) throw new Error('CARD_NOT_FOUND')

  // Add visit stamp (+1)
  const newStampCount = Math.min(card.stampsCollected + 1, meta.config.totalStamps)
  const statements: { sql: string; args: (string | number | null)[] }[] = [
    {
      sql: `UPDATE stamp_cards SET stamps_collected = ?, last_stamp_date = ? WHERE id = ?`,
      args: [newStampCount, today, card.id],
    },
    {
      sql: `UPDATE campaign_participations
            SET plays_today = 1, last_play_date = ?, total_plays = total_plays + 1, last_played_at = datetime('now')
            WHERE campaign_id = ? AND customer_id = ?`,
      args: [today, campaignId, customerId],
    },
    {
      sql: `INSERT INTO game_plays (id, campaign_id, customer_id, mechanic, won, reward_id, reward_name, redemption_code)
            VALUES (?, ?, ?, 'stamp', 0, NULL, NULL, NULL)`,
      args: [nanoid(), campaignId, customerId],
    },
  ]

  await db.batch(statements)

  card = (await fetchStampCard(campaignId, customerId))!
  const surpriseRewards = await fetchTierRewards(campaignId, 'surprise')
  const bigRewards = await fetchTierRewards(campaignId, 'big')
  const triggers = await evaluateTriggers(
    card, campaignId, customerId, meta.config, surpriseRewards, bigRewards,
  )
  const triggerOutcomes = await applyTriggerResults(card, campaignId, customerId, triggers)

  card = (await fetchStampCard(campaignId, customerId))!

  if (card.stampsCollected >= meta.config.totalStamps && card.status === 'active') {
    await db.execute({
      sql: `UPDATE stamp_cards SET status = 'completed', completed_at = datetime('now') WHERE id = ?`,
      args: [card.id],
    })
    card.status = 'completed'
  }

  const primaryTrigger = triggerOutcomes.find(t => t.won) ?? triggerOutcomes[0] ?? null

  return {
    enrolled: isNew,
    stampsCollected: card.stampsCollected,
    totalStamps: meta.config.totalStamps,
    stampEarned: true,
    cardComplete: card.status === 'completed',
    canCollectTomorrow: card.status === 'active' && card.stampsCollected < meta.config.totalStamps,
    trigger: primaryTrigger?.tier ?? null,
    won: primaryTrigger?.won ?? false,
    reward: primaryTrigger?.reward
      ? { name: primaryTrigger.reward.name, icon: primaryTrigger.reward.icon }
      : null,
    code: primaryTrigger?.code ?? null,
    triggers: triggerOutcomes,
  }
}

interface AppliedTrigger {
  tier: 'surprise' | 'big'
  won: boolean
  reward: CampaignReward | null
  code: string | null
}

async function applyTriggerResults(
  card: StampCardRow,
  campaignId: string,
  customerId: string,
  triggers: TriggerResult[],
): Promise<AppliedTrigger[]> {
  const applied: AppliedTrigger[] = []

  for (const t of triggers) {
    if (!t.tier || !t.playId) continue

    const statements: { sql: string; args: (string | number | null)[] }[] = [
      {
        sql: `INSERT INTO game_plays (id, campaign_id, customer_id, mechanic, won, reward_id, reward_name, redemption_code)
              VALUES (?, ?, ?, 'stamp', ?, ?, ?, ?)`,
        args: [
          t.playId, campaignId, customerId,
          t.won ? 1 : 0,
          t.reward?.id ?? null,
          t.reward?.name ?? (t.won ? 'Reward' : 'No win'),
          t.code,
        ],
      },
    ]

    if (t.tier === 'surprise') {
      statements.push({
        sql: `UPDATE stamp_cards SET surprise_awarded = 1, surprise_play_id = ? WHERE id = ?`,
        args: [t.playId, card.id],
      })
    } else {
      statements.push({
        sql: `UPDATE stamp_cards SET big_awarded = 1, big_play_id = ? WHERE id = ?`,
        args: [t.playId, card.id],
      })
    }

    if (t.won && t.reward && t.code) {
      statements.push({
        sql: `INSERT INTO customer_rewards
              (id, customer_id, campaign_id, play_id, reward_name, icon, redemption_code, status, earned_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', datetime('now'))`,
        args: [nanoid(), customerId, campaignId, t.playId, t.reward.name, t.reward.icon, t.code],
      })
    }

    await db.batch(statements)
    applied.push({
      tier: t.tier,
      won: t.won,
      reward: t.reward,
      code: t.code,
    })
  }

  return applied
}

export function stampPinGraceExpired(pinExpiresAt: string | null): boolean {
  if (!pinExpiresAt) return false
  const graceMs = STAMP_PIN_GRACE_MINUTES * 60 * 1000
  return nowInCampaignTz().getTime() > new Date(pinExpiresAt).getTime() + graceMs
}

export interface StampCampaignStats {
  enrolled: number
  active: number
  completed: number
  expired: number
  completionRate: number
  surpriseAwards: number
  bigAwards: number
  totalRewardsIssued: number
  avgStampsCollected: number
  claimDeadline: string
  enrollmentCloseDate: string
  claimPeriodDays: number
  pinActive: boolean
  enrollmentOpen: boolean
  stampConfig: StampConfig | null
}

export async function getStampCampaignStats(campaignId: string): Promise<StampCampaignStats | null> {
  const result = await db.execute({
    sql: 'SELECT * FROM campaigns WHERE id = ?',
    args: [campaignId],
  })
  const row = result.rows[0] as Record<string, unknown> | undefined
  if (!row || row.mechanic !== 'stamp') return null

  const meta = parseStampCampaignMeta(row)
  if (!meta) return null

  const startDate = row.start_date as string
  const endDate = row.end_date as string
  const status = row.status as string
  const userCap = row.user_cap as number
  const capFilledAt = (row.cap_filled_at as string) ?? null

  const usersResult = await db.execute({
    sql: 'SELECT COUNT(*) as c FROM campaign_participations WHERE campaign_id = ?',
    args: [campaignId],
  })
  const currentUsers = Number(usersResult.rows[0]?.c ?? 0)

  const today = todayInCampaignTz()
  const claimDeadline = getClaimDeadline(endDate, meta.claimPeriodDays, capFilledAt)
  const enrollmentCloseDate = getEnrollmentCloseDate(endDate, capFilledAt)

  const cards = await db.execute({
    sql: `SELECT status, stamps_collected, surprise_awarded, big_awarded FROM stamp_cards WHERE campaign_id = ?`,
    args: [campaignId],
  })

  let active = 0
  let completed = 0
  let expired = 0
  let surpriseAwards = 0
  let bigAwards = 0
  let stampSum = 0

  for (const row of cards.rows) {
    const status = row.status as string
    if (status === 'active') active++
    else if (status === 'completed') completed++
    else if (status === 'expired') expired++
    stampSum += Number(row.stamps_collected ?? 0)
    if (row.surprise_awarded) surpriseAwards++
    if (row.big_awarded) bigAwards++
  }

  const enrolled = cards.rows.length
  const rewards = await db.execute({
    sql: `SELECT COUNT(*) as c FROM customer_rewards WHERE campaign_id = ?`,
    args: [campaignId],
  })
  const totalRewardsIssued = Number(rewards.rows[0]?.c ?? 0)

  return {
    enrolled,
    active,
    completed,
    expired,
    completionRate: enrolled > 0 ? Math.round((completed / enrolled) * 100) : 0,
    surpriseAwards,
    bigAwards,
    totalRewardsIssued,
    avgStampsCollected: enrolled > 0 ? Math.round((stampSum / enrolled) * 10) / 10 : 0,
    claimDeadline,
    enrollmentCloseDate,
    claimPeriodDays: meta.claimPeriodDays,
    pinActive: isPinActiveForStamp(
      status,
      startDate,
      endDate,
      meta.claimPeriodDays,
      capFilledAt,
      today,
    ),
    enrollmentOpen: isEnrollmentOpen(
      startDate,
      endDate,
      userCap,
      currentUsers,
      capFilledAt,
      today,
    ),
    stampConfig: meta.config,
  }
}
