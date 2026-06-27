import { nanoid } from 'nanoid'
import { db } from '../db/client.js'
import { todayInCampaignTz } from '../utils/campaign-dates.js'
import {
  verifyPlaySession,
  getCampaignById,
  getCampaignLiteById,
  type CampaignReward,
} from './campaigns.js'
import {
  checkInLoyaltyConfigSchema,
  type CheckInLoyaltyConfig,
} from './check-in-loyalty-schema.js'

export interface LoyaltyCardRow {
  id: string
  campaignId: string
  customerId: string
  loyaltyPoints: number
  totalCheckIns: number
  lastCheckInDate: string | null
  status: 'active' | 'completed'
  enrolledAt: string
}


export function parseCheckInConfig(json: string | null | undefined): CheckInLoyaltyConfig | null {
  if (!json) return null
  try {
    const parsed = JSON.parse(json) as Record<string, unknown>
    if (parsed.type === 'check-in-loyalty' && parsed.checkInConfig) {
      return checkInLoyaltyConfigSchema.parse(parsed.checkInConfig)
    }
  } catch {
    return null
  }
  return null
}

function generateRedemptionCode(customerId: string): string {
  const suffix = nanoid(6).toUpperCase()
  const prefix = customerId.slice(0, 4).toUpperCase()
  return `${prefix}-${suffix}`
}

function asInt(value: unknown, fallback = 0): number {
  const n = Number(value)
  return Number.isFinite(n) ? Math.trunc(n) : fallback
}

async function fetchLoyaltyCard(campaignId: string, customerId: string): Promise<LoyaltyCardRow | null> {
  const result = await db.execute({
    sql: `SELECT id, campaign_id, customer_id, loyalty_points, total_check_ins,
                 last_check_in_date, status, enrolled_at
          FROM loyalty_cards WHERE campaign_id = ? AND customer_id = ?`,
    args: [campaignId, customerId],
  })
  const row = result.rows[0]
  if (!row) return null
  return {
    id: row.id as string,
    campaignId: row.campaign_id as string,
    customerId: row.customer_id as string,
    loyaltyPoints: asInt(row.loyalty_points),
    totalCheckIns: asInt(row.total_check_ins),
    lastCheckInDate: (row.last_check_in_date as string) ?? null,
    status: row.status as 'active' | 'completed',
    enrolledAt: row.enrolled_at as string,
  }
}

export async function fetchMilestoneRewards(campaignId: string): Promise<(CampaignReward & { pointsThreshold: number })[]> {
  const batch = await fetchMilestoneRewardsBatch([campaignId])
  return batch.get(campaignId) ?? []
}

export async function fetchMilestoneRewardsBatch(
  campaignIds: string[],
): Promise<Map<string, (CampaignReward & { pointsThreshold: number })[]>> {
  const map = new Map<string, (CampaignReward & { pointsThreshold: number })[]>()
  if (campaignIds.length === 0) return map
  for (const id of campaignIds) map.set(id, [])

  const placeholders = campaignIds.map(() => '?').join(', ')
  const result = await db.execute({
    sql: `SELECT campaign_id, id, name, description, icon, share_percent, reward_tier
          FROM campaign_rewards
          WHERE campaign_id IN (${placeholders}) AND reward_tier = 'milestone'
          ORDER BY campaign_id ASC, share_percent ASC`,
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
      rewardTier: row.reward_tier as string,
      pointsThreshold: row.share_percent as number,
    })
  }

  return map
}

export async function fetchAwardedRewardIds(loyaltyCardId: string): Promise<Set<string>> {
  const result = await db.execute({
    sql: 'SELECT reward_id FROM loyalty_milestone_awards WHERE loyalty_card_id = ?',
    args: [loyaltyCardId],
  })
  return new Set(result.rows.map(r => r.reward_id as string))
}

async function awardNewMilestones(
  card: LoyaltyCardRow,
  campaignId: string,
  customerId: string,
  loyaltyPoints: number,
): Promise<{ reward: CampaignReward; code: string }[]> {
  const milestones = await fetchMilestoneRewards(campaignId)
  const awarded = await fetchAwardedRewardIds(card.id)
  const newlyUnlocked: { reward: CampaignReward; code: string }[] = []

  for (const milestone of milestones) {
    if (loyaltyPoints < milestone.pointsThreshold) continue
    if (awarded.has(milestone.id)) continue

    const playId = nanoid()
    const code = generateRedemptionCode(customerId)

    await db.batch([
      {
        sql: `INSERT INTO game_plays (id, campaign_id, customer_id, mechanic, won, reward_id, reward_name, redemption_code)
              VALUES (?, ?, ?, 'check-in-loyalty', 1, ?, ?, ?)`,
        args: [playId, campaignId, customerId, milestone.id, milestone.name, code],
      },
      {
        sql: `INSERT INTO customer_rewards
              (id, customer_id, campaign_id, play_id, reward_name, icon, redemption_code, status, earned_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, 'earned', datetime('now'))`,
        args: [nanoid(), customerId, campaignId, playId, milestone.name, milestone.icon, code],
      },
      {
        sql: `INSERT INTO loyalty_milestone_awards (id, loyalty_card_id, reward_id, play_id, awarded_at)
              VALUES (?, ?, ?, ?, datetime('now'))`,
        args: [nanoid(), card.id, milestone.id, playId],
      },
    ])

    newlyUnlocked.push({ reward: milestone, code })
  }

  return newlyUnlocked
}

export interface LoyaltyState {
  campaignId: string
  mechanic: 'check-in-loyalty'
  enrolled: boolean
  loyaltyPoints: number
  totalCheckIns: number
  pointsPerCheckIn: number
  canCheckInToday: boolean
  checkedInToday: boolean
  milestones: { id: string; name: string; icon: string; pointsThreshold: number; unlocked: boolean; redeemed: boolean }[]
  nextMilestone: { name: string; pointsThreshold: number; pointsNeeded: number } | null
  userCap: number
  currentUsers: number
  campaignName: string
  businessId: string
  businessName: string
}

export async function getLoyaltyState(campaignId: string, customerId: string): Promise<LoyaltyState> {
  const campaign = await getCampaignLiteById(campaignId)
  if (campaign.mechanic !== 'check-in-loyalty') throw new Error('NOT_LOYALTY_CAMPAIGN')

  const config = parseCheckInConfig(campaign.configJson)
  if (!config) throw new Error('INVALID_LOYALTY_CONFIG')

  const bizResult = await db.execute({
    sql: 'SELECT name FROM businesses WHERE id = ?',
    args: [campaign.businessId],
  })
  const businessName = (bizResult.rows[0]?.name as string) ?? 'Business'

  const card = await fetchLoyaltyCard(campaignId, customerId)
  const today = todayInCampaignTz()
  const checkedInToday = card?.lastCheckInDate === today

  const milestones = await fetchMilestoneRewards(campaignId)
  const awarded = card ? await fetchAwardedRewardIds(card.id) : new Set<string>()

  const redeemedResult = card
    ? await db.execute({
        sql: `SELECT cr.reward_name, cr.status FROM customer_rewards cr
              WHERE cr.campaign_id = ? AND cr.customer_id = ?`,
        args: [campaignId, customerId],
      })
    : { rows: [] }
  const redeemedNames = new Set(
    redeemedResult.rows.filter(r => r.status === 'redeemed').map(r => r.reward_name as string),
  )

  const milestoneStates = milestones.map(m => ({
    id: m.id,
    name: m.name,
    icon: m.icon,
    pointsThreshold: m.pointsThreshold,
    unlocked: (card?.loyaltyPoints ?? 0) >= m.pointsThreshold,
    redeemed: redeemedNames.has(m.name),
  }))

  const points = card?.loyaltyPoints ?? 0
  const next = milestones.find(m => m.pointsThreshold > points) ?? null

  return {
    campaignId,
    mechanic: 'check-in-loyalty',
    enrolled: Boolean(card),
    loyaltyPoints: points,
    totalCheckIns: card?.totalCheckIns ?? 0,
    pointsPerCheckIn: config.pointsPerCheckIn,
    canCheckInToday: !checkedInToday && campaign.status === 'active',
    checkedInToday,
    milestones: milestoneStates,
    nextMilestone: next
      ? { name: next.name, pointsThreshold: next.pointsThreshold, pointsNeeded: next.pointsThreshold - points }
      : null,
    userCap: campaign.userCap,
    currentUsers: campaign.currentUsers,
    campaignName: campaign.name,
    businessId: campaign.businessId,
    businessName,
  }
}

export async function getPendingCheckInPrompt(customerId: string) {
  const today = todayInCampaignTz()
  const result = await db.execute({
    sql: `SELECT c.id, c.name, c.business_id, b.name as business_name
          FROM campaigns c
          INNER JOIN businesses b ON b.id = c.business_id
          WHERE c.mechanic = 'check-in-loyalty'
            AND c.status = 'active'
            AND c.start_date <= ?
            AND c.end_date >= ?
          ORDER BY c.created_at DESC`,
    args: [today, today],
  })

  for (const row of result.rows) {
    const campaignId = row.id as string
    const card = await fetchLoyaltyCard(campaignId, customerId)
    if (card?.lastCheckInDate === today) continue

    const config = parseCheckInConfig(
      (await db.execute({ sql: 'SELECT config_json FROM campaigns WHERE id = ?', args: [campaignId] })).rows[0]?.config_json as string,
    )
    if (!config) continue

    return {
      hasPendingCheckIn: true,
      campaignId,
      campaignName: row.name as string,
      businessId: row.business_id as string,
      businessName: row.business_name as string,
      loyaltyPoints: card?.loyaltyPoints ?? 0,
      pointsPerCheckIn: config.pointsPerCheckIn,
      enrolled: Boolean(card),
    }
  }

  return { hasPendingCheckIn: false }
}

export async function listCustomerLoyaltyProfiles(customerId: string) {
  const result = await db.execute({
    sql: `SELECT lc.*, c.name as campaign_name, c.business_id, b.name as business_name, c.config_json
          FROM loyalty_cards lc
          INNER JOIN campaigns c ON c.id = lc.campaign_id
          INNER JOIN businesses b ON b.id = c.business_id
          WHERE lc.customer_id = ?
          ORDER BY lc.enrolled_at DESC`,
    args: [customerId],
  })

  return Promise.all(result.rows.map(async row => {
    const campaignId = row.campaign_id as string
    const milestones = await fetchMilestoneRewards(campaignId)
    const awarded = await fetchAwardedRewardIds(row.id as string)
    const points = asInt(row.loyalty_points)

    return {
      campaignId,
      campaignName: row.campaign_name as string,
      businessId: row.business_id as string,
      businessName: row.business_name as string,
      loyaltyPoints: points,
      totalCheckIns: row.total_check_ins as number,
      milestones: milestones.map(m => ({
        name: m.name,
        icon: m.icon,
        pointsThreshold: m.pointsThreshold,
        unlocked: points >= m.pointsThreshold,
        awarded: awarded.has(m.id),
      })),
    }
  }))
}

export interface CheckInResult {
  enrolled: boolean
  pointsEarned: number
  loyaltyPoints: number
  totalCheckIns: number
  checkedInToday: boolean
  milestonesUnlocked: { name: string; icon: string; code: string }[]
}

export async function executeCheckIn(
  campaignId: string,
  customerId: string,
  playSessionToken: string,
): Promise<CheckInResult> {
  if (!verifyPlaySession(playSessionToken, campaignId, customerId)) {
    throw new Error('INVALID_PLAY_SESSION')
  }

  const campaign = await getCampaignById(campaignId)
  if (campaign.mechanic !== 'check-in-loyalty') throw new Error('NOT_LOYALTY_CAMPAIGN')

  const config = parseCheckInConfig(campaign.configJson)
  if (!config) throw new Error('INVALID_LOYALTY_CONFIG')

  const today = todayInCampaignTz()
  if (campaign.status !== 'active' || today < campaign.startDate || today > campaign.endDate) {
    throw new Error('CAMPAIGN_NOT_ACTIVE')
  }

  let card = await fetchLoyaltyCard(campaignId, customerId)
  const isNew = !card

  if (isNew) {
    if (campaign.currentUsers >= campaign.userCap) {
      throw new Error('USER_CAP_REACHED')
    }
  } else if (card!.lastCheckInDate === today) {
    throw new Error('ALREADY_CHECKED_IN_TODAY')
  }

  const pointsEarned = asInt(config.pointsPerCheckIn)
  const playId = nanoid()

  if (isNew) {
    const cardId = nanoid()
    await db.batch([
      {
        sql: `INSERT INTO loyalty_cards (
          id, campaign_id, customer_id, loyalty_points, total_check_ins,
          last_check_in_date, status, enrolled_at
        ) VALUES (?, ?, ?, ?, 1, ?, 'active', datetime('now'))`,
        args: [cardId, campaignId, customerId, pointsEarned, today],
      },
      {
        sql: `INSERT INTO campaign_participations
              (id, campaign_id, customer_id, plays_today, last_play_date, total_plays, first_played_at, last_played_at)
              VALUES (?, ?, ?, 1, ?, 1, datetime('now'), datetime('now'))`,
        args: [nanoid(), campaignId, customerId, today],
      },
      {
        sql: `INSERT INTO game_plays (id, campaign_id, customer_id, mechanic, won, reward_id, reward_name, redemption_code)
              VALUES (?, ?, ?, 'check-in-loyalty', 0, NULL, NULL, NULL)`,
        args: [playId, campaignId, customerId],
      },
    ])
    card = (await fetchLoyaltyCard(campaignId, customerId))!
  } else {
    const newPoints = card!.loyaltyPoints + pointsEarned
    await db.batch([
      {
        sql: `UPDATE loyalty_cards
              SET loyalty_points = ?, total_check_ins = total_check_ins + 1, last_check_in_date = ?
              WHERE id = ?`,
        args: [newPoints, today, card!.id],
      },
      {
        sql: `UPDATE campaign_participations
              SET plays_today = 1, last_play_date = ?, total_plays = total_plays + 1, last_played_at = datetime('now')
              WHERE campaign_id = ? AND customer_id = ?`,
        args: [today, campaignId, customerId],
      },
      {
        sql: `INSERT INTO game_plays (id, campaign_id, customer_id, mechanic, won, reward_id, reward_name, redemption_code)
              VALUES (?, ?, ?, 'check-in-loyalty', 0, NULL, NULL, NULL)`,
        args: [playId, campaignId, customerId],
      },
    ])
    card = (await fetchLoyaltyCard(campaignId, customerId))!
  }

  const milestonesUnlocked = await awardNewMilestones(card, campaignId, customerId, card.loyaltyPoints)

  return {
    enrolled: isNew,
    pointsEarned,
    loyaltyPoints: card.loyaltyPoints,
    totalCheckIns: card.totalCheckIns,
    checkedInToday: true,
    milestonesUnlocked: milestonesUnlocked.map(m => ({
      name: m.reward.name,
      icon: m.reward.icon,
      code: m.code,
    })),
  }
}

export interface LoyaltyCampaignStats {
  enrolled: number
  totalCheckIns: number
  avgLoyaltyPoints: number
  totalRewardsIssued: number
  milestones: { name: string; pointsThreshold: number; unlockCount: number }[]
  checkInConfig: CheckInLoyaltyConfig | null
}

export async function getLoyaltyCampaignStats(campaignId: string): Promise<LoyaltyCampaignStats | null> {
  const result = await db.execute({
    sql: 'SELECT config_json FROM campaigns WHERE id = ? AND mechanic = ?',
    args: [campaignId, 'check-in-loyalty'],
  })
  const row = result.rows[0]
  if (!row) return null

  const config = parseCheckInConfig(row.config_json as string)
  const cards = await db.execute({
    sql: 'SELECT loyalty_points, total_check_ins FROM loyalty_cards WHERE campaign_id = ?',
    args: [campaignId],
  })

  let pointSum = 0
  let checkInSum = 0
  for (const c of cards.rows) {
    pointSum += Number(c.loyalty_points ?? 0)
    checkInSum += Number(c.total_check_ins ?? 0)
  }

  const enrolled = cards.rows.length
  const rewards = await db.execute({
    sql: 'SELECT COUNT(*) as c FROM customer_rewards WHERE campaign_id = ?',
    args: [campaignId],
  })

  const milestoneRewards = await fetchMilestoneRewards(campaignId)
  const milestoneStats = await Promise.all(
    milestoneRewards.map(async m => {
      const count = await db.execute({
        sql: 'SELECT COUNT(*) as c FROM loyalty_milestone_awards WHERE reward_id = ?',
        args: [m.id],
      })
      return {
        name: m.name,
        pointsThreshold: m.pointsThreshold,
        unlockCount: Number(count.rows[0]?.c ?? 0),
      }
    }),
  )

  return {
    enrolled,
    totalCheckIns: checkInSum,
    avgLoyaltyPoints: enrolled > 0 ? Math.round((pointSum / enrolled) * 10) / 10 : 0,
    totalRewardsIssued: Number(rewards.rows[0]?.c ?? 0),
    milestones: milestoneStats,
    checkInConfig: config,
  }
}
