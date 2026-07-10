import { nanoid } from 'nanoid'
import { db } from '../db/client.js'
import { todayInCampaignTz, isCampaignInWindow } from '../utils/campaign-dates.js'
import { computeRedeemExpiryDate } from '../utils/redeem-expiry.js'
import { verifyPlaySession } from './campaigns.js'
import {
  formatGroupUnlockDescription,
  formatGroupUnlockRewardLabel,
  formatGroupUnlockSentence,
  parseGroupUnlockConfig,
} from './groupunlock-campaign-schema.js'
import { maybeUnlockGroupRewards } from './groupunlock-progress.js'

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
  if (row.mechanic !== 'groupunlock') throw new Error('NOT_GROUPUNLOCK_CAMPAIGN')
  return row
}

export async function getGroupUnlockState(campaignId: string, customerId: string) {
  const row = await getCampaignRow(campaignId)
  const config = parseGroupUnlockConfig((row.config_json as string) ?? null)
  if (!config) throw new Error('INVALID_GROUPUNLOCK_CONFIG')

  const startTime = (row.start_time as string) ?? '00:00'
  const endTime = (row.end_time as string) ?? '23:59'
  const active =
    row.status === 'active' &&
    isCampaignInWindow(row.start_date as string, row.end_date as string, startTime, endTime)

  const existing = await db.execute({
    sql: `SELECT * FROM customer_rewards
          WHERE campaign_id = ? AND customer_id = ? AND source_type = 'groupunlock'
          LIMIT 1`,
    args: [campaignId, customerId],
  })
  const reward = existing.rows[0] as Record<string, unknown> | undefined

  const claimedCount = await db.execute({
    sql: `SELECT COUNT(*) AS c FROM customer_rewards
          WHERE campaign_id = ? AND source_type = 'groupunlock'
            AND status IN ('group_pending', 'earned', 'pending', 'redeemed')`,
    args: [campaignId],
  })

  const target = config.targetParticipants
  const joined = Number(claimedCount.rows[0]?.c ?? 0)
  const rewardLabel = formatGroupUnlockRewardLabel(config)
  const unlocked = joined >= target

  // Sync unlock if target already met (e.g. concurrent claims)
  if (unlocked && reward?.status === 'group_pending') {
    await maybeUnlockGroupRewards(campaignId)
  }

  const refreshedReward =
    unlocked && reward?.status === 'group_pending'
      ? (
          await db.execute({
            sql: `SELECT * FROM customer_rewards WHERE id = ?`,
            args: [reward.id as string],
          })
        ).rows[0] as Record<string, unknown> | undefined
      : reward

  return {
    campaignId,
    campaignName: row.name as string,
    businessName: row.business_name as string,
    active,
    canClaim: active && !reward && joined < target,
    hasClaimed: Boolean(reward),
    claimedCount: joined,
    targetParticipants: target,
    spotsRemaining: Math.max(0, target - joined),
    groupJoined: joined,
    peopleLeft: Math.max(0, target - joined),
    unlocked,
    offerSentence: formatGroupUnlockSentence(config),
    rewardLabel,
    rewardDescription: formatGroupUnlockDescription(config),
    rewardKind: config.rewardKind,
    endDate: row.end_date as string,
    walletReward: refreshedReward
      ? {
          id: refreshedReward.id as string,
          status: refreshedReward.status as string,
          code: refreshedReward.redemption_code as string,
          redeemBefore: (refreshedReward.redeem_expires_at as string) ?? null,
        }
      : null,
    groupUnlockConfig: config,
  }
}

export async function claimGroupUnlockReward(
  campaignId: string,
  customerId: string,
  playSessionToken: string,
) {
  if (!verifyPlaySession(playSessionToken, campaignId, customerId)) {
    throw new Error('INVALID_PLAY_SESSION')
  }

  const row = await getCampaignRow(campaignId)
  const config = parseGroupUnlockConfig((row.config_json as string) ?? null)
  if (!config) throw new Error('INVALID_GROUPUNLOCK_CONFIG')

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
          WHERE campaign_id = ? AND customer_id = ? AND source_type = 'groupunlock'
          LIMIT 1`,
    args: [campaignId, customerId],
  })
  if (existing.rows.length > 0) throw new Error('ALREADY_CLAIMED')

  const claimedCount = await db.execute({
    sql: `SELECT COUNT(*) AS c FROM customer_rewards
          WHERE campaign_id = ? AND source_type = 'groupunlock'
            AND status IN ('group_pending', 'earned', 'pending', 'redeemed')`,
    args: [campaignId],
  })
  if (Number(claimedCount.rows[0]?.c ?? 0) >= config.targetParticipants) {
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
  const rewardLabel = formatGroupUnlockRewardLabel(config)
  const redeemExpiresAt = computeRedeemExpiryDate(
    config.redeemExpiryMode,
    config.redeemFixedDate ?? null,
    config.redeemRelativeAmount ?? 14,
    config.redeemRelativeUnit ?? 'day',
  )
  const today = todayInCampaignTz()
  const businessId = row.business_id as string

  const previousJoined = Number(claimedCount.rows[0]?.c ?? 0)
  const joinedAfter = previousJoined + 1

  await db.batch([
    {
      sql: `INSERT INTO game_plays (id, campaign_id, customer_id, mechanic, won, reward_id, reward_name, redemption_code)
            VALUES (?, ?, ?, 'groupunlock', 1, ?, ?, ?)`,
      args: [playId, campaignId, customerId, campaignReward.id as string, rewardLabel, redemptionCode],
    },
    {
      sql: `INSERT INTO customer_rewards
            (id, customer_id, campaign_id, play_id, reward_name, icon, redemption_code, status, earned_at, business_id, source_type, redeem_expires_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, 'group_pending', datetime('now'), ?, 'groupunlock', ?)`,
      args: [
        rewardId,
        customerId,
        campaignId,
        playId,
        rewardLabel,
        (campaignReward.icon as string) ?? '🤝',
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

  const unlocked = await maybeUnlockGroupRewards(campaignId)

  return {
    rewardId,
    reward: rewardLabel,
    description: formatGroupUnlockDescription(config),
    offerSentence: formatGroupUnlockSentence(config),
    code: redemptionCode,
    redeemBefore: redeemExpiresAt,
    icon: (campaignReward.icon as string) ?? '🤝',
    unlocked,
    groupJoined: joinedAfter,
    targetParticipants: config.targetParticipants,
    peopleLeft: Math.max(0, config.targetParticipants - joinedAfter),
  }
}
