import { nanoid } from 'nanoid'
import { db } from '../db/client.js'
import { todayInCampaignTz, isCampaignInWindow } from '../utils/campaign-dates.js'
import { computeRedeemExpiryDate } from '../utils/redeem-expiry.js'
import { verifyPlaySession } from './campaigns.js'
import { invalidateBusinessAnalyticsCaches } from './vendor-analytics.js'
import {
  formatFlashDescription,
  formatFlashRewardLabel,
  formatFlashSentence,
  parseFlashConfig,
} from './flash-campaign-schema.js'

function generateRedemptionCode(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  return Array.from({ length: 8 }, () => chars[Math.floor(Math.random() * chars.length)]).join('')
}

async function getCampaignRow(campaignId: string) {
  const result = await db.execute({
    sql: `SELECT c.*, b.name AS business_name
          FROM campaigns c
          INNER JOIN businesses b ON b.id = c.business_id
          WHERE c.id = ?`,
    args: [campaignId],
  })
  const row = result.rows[0] as Record<string, unknown> | undefined
  if (!row) throw new Error('CAMPAIGN_NOT_FOUND')
  if (row.mechanic !== 'flash') throw new Error('NOT_FLASH_CAMPAIGN')
  return row
}

export async function getFlashState(campaignId: string, customerId: string) {
  const row = await getCampaignRow(campaignId)
  const config = parseFlashConfig((row.config_json as string) ?? null)
  if (!config) throw new Error('INVALID_FLASH_CONFIG')

  const startTime = (row.start_time as string) ?? '00:00'
  const endTime = (row.end_time as string) ?? '23:59'
  const active =
    row.status === 'active' &&
    isCampaignInWindow(row.start_date as string, row.end_date as string, startTime, endTime)

  const existing = await db.execute({
    sql: `SELECT * FROM customer_rewards
          WHERE campaign_id = ? AND customer_id = ? AND source_type = 'flash'
          LIMIT 1`,
    args: [campaignId, customerId],
  })
  const reward = existing.rows[0] as Record<string, unknown> | undefined

  const claimedCount = await db.execute({
    sql: `SELECT COUNT(*) AS c FROM customer_rewards
          WHERE campaign_id = ? AND source_type = 'flash'`,
    args: [campaignId],
  })

  const totalSlots = config.totalSlots
  const claimed = Number(claimedCount.rows[0]?.c ?? 0)
  const rewardLabel = formatFlashRewardLabel(config)

  return {
    campaignId,
    campaignName: row.name as string,
    businessName: row.business_name as string,
    active,
    canClaim: active && !reward && claimed < totalSlots,
    hasClaimed: Boolean(reward),
    claimedCount: claimed,
    totalSlots,
    spotsRemaining: Math.max(0, totalSlots - claimed),
    offerSentence: formatFlashSentence(config),
    rewardLabel,
    rewardDescription: formatFlashDescription(config),
    termsAndConditions: config.termsAndConditions,
    rewardKind: config.rewardKind,
    endDate: row.end_date as string,
    walletReward: reward
      ? {
          id: reward.id as string,
          status: reward.status as string,
          code: reward.redemption_code as string,
          redeemBefore: (reward.redeem_expires_at as string) ?? null,
        }
      : null,
    flashConfig: config,
  }
}

export async function claimFlashReward(
  campaignId: string,
  customerId: string,
  playSessionToken: string,
) {
  if (!verifyPlaySession(playSessionToken, campaignId, customerId)) {
    throw new Error('INVALID_PLAY_SESSION')
  }

  const row = await getCampaignRow(campaignId)
  const config = parseFlashConfig((row.config_json as string) ?? null)
  if (!config) throw new Error('INVALID_FLASH_CONFIG')

  const startTime = (row.start_time as string) ?? '00:00'
  const endTime = (row.end_time as string) ?? '23:59'
  if (
    row.status !== 'active' ||
    !isCampaignInWindow(row.start_date as string, row.end_date as string, startTime, endTime)
  ) {
    throw new Error('CAMPAIGN_NOT_ACTIVE')
  }

  const existing = await db.execute({
    sql: `SELECT id FROM customer_rewards
          WHERE campaign_id = ? AND customer_id = ? AND source_type = 'flash'
          LIMIT 1`,
    args: [campaignId, customerId],
  })
  if (existing.rows.length > 0) throw new Error('ALREADY_CLAIMED')

  const claimedCount = await db.execute({
    sql: `SELECT COUNT(*) AS c FROM customer_rewards
          WHERE campaign_id = ? AND source_type = 'flash'`,
    args: [campaignId],
  })
  if (Number(claimedCount.rows[0]?.c ?? 0) >= config.totalSlots) {
    throw new Error('USER_CAP_REACHED')
  }

  const rewardResult = await db.execute({
    sql: `SELECT * FROM campaign_rewards WHERE campaign_id = ? ORDER BY sort_order ASC LIMIT 1`,
    args: [campaignId],
  })
  const campaignReward = rewardResult.rows[0] as Record<string, unknown> | undefined
  if (!campaignReward) throw new Error('NO_REWARD_CONFIGURED')

  const rewardId = nanoid()
  const playId = nanoid()
  const redemptionCode = generateRedemptionCode()
  const rewardLabel = formatFlashRewardLabel(config)
  const redeemExpiresAt = computeRedeemExpiryDate(
    config.redeemExpiryMode,
    config.redeemFixedDate ?? null,
    config.redeemRelativeAmount ?? 3,
    config.redeemRelativeUnit ?? 'day',
  )
  const today = todayInCampaignTz()
  const businessId = row.business_id as string

  await db.batch([
    {
      sql: `INSERT INTO game_plays (id, campaign_id, customer_id, mechanic, won, reward_id, reward_name, redemption_code)
            VALUES (?, ?, ?, 'flash', 1, ?, ?, ?)`,
      args: [playId, campaignId, customerId, campaignReward.id as string, rewardLabel, redemptionCode],
    },
    {
      sql: `INSERT INTO customer_rewards
            (id, customer_id, campaign_id, play_id, reward_name, icon, redemption_code, status, earned_at, business_id, source_type, redeem_expires_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, 'earned', datetime('now'), ?, 'flash', ?)`,
      args: [
        rewardId,
        customerId,
        campaignId,
        playId,
        rewardLabel,
        (campaignReward.icon as string) ?? '⚡',
        redemptionCode,
        businessId,
        redeemExpiresAt,
      ],
    },
    {
      sql: `INSERT INTO campaign_participations
            (id, campaign_id, customer_id, plays_today, last_play_date, total_plays, first_played_at, last_played_at)
            VALUES (?, ?, ?, 1, ?, 1, datetime('now'), datetime('now'))
            ON CONFLICT(campaign_id, customer_id) DO UPDATE SET
              total_plays = campaign_participations.total_plays + 1,
              last_played_at = datetime('now')`,
      args: [nanoid(), campaignId, customerId, today],
    },
  ])

  invalidateBusinessAnalyticsCaches(businessId)

  return {
    rewardId,
    reward: rewardLabel,
    description: formatFlashDescription(config),
    offerSentence: formatFlashSentence(config),
    code: redemptionCode,
    redeemBefore: redeemExpiresAt,
    icon: (campaignReward.icon as string) ?? '⚡',
  }
}
