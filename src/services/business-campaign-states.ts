import { db } from '../db/client.js'
import { todayInCampaignTz, istDateSql } from '../utils/campaign-dates.js'
import {
  fetchCampaignStatsBatch,
  checkEligibility,
  mapRowToCampaignLite,
} from './campaigns.js'
import {
  parseStampCampaignMeta,
  isEnrollmentOpen,
  getClaimDeadline,
  getEnrollmentCloseDate,
  expireStaleStampCampaigns,
  parseDropTriggersFromRow,
} from './stamp-cards.js'
import {
  parseCheckInConfig,
  fetchMilestoneRewardsBatch,
} from './check-in-loyalty.js'

export interface BusinessCampaignStateItem {
  campaignId: string
  mechanic: string
  state: Record<string, unknown> | null
}

async function batchDailyNewUsers(campaignIds: string[], today: string): Promise<Map<string, number>> {
  const map = new Map<string, number>()
  if (campaignIds.length === 0) return map
  const placeholders = campaignIds.map(() => '?').join(', ')
  const result = await db.execute({
    sql: `SELECT campaign_id, COUNT(*) AS c FROM campaign_participations
          WHERE campaign_id IN (${placeholders}) AND ${istDateSql('first_played_at')} = ?
          GROUP BY campaign_id`,
    args: [...campaignIds, today],
  })
  for (const row of result.rows) {
    map.set(row.campaign_id as string, Number(row.c ?? 0))
  }
  return map
}

export async function getBusinessCampaignStates(
  businessId: string,
  customerId: string,
): Promise<BusinessCampaignStateItem[]> {
  const today = todayInCampaignTz()
  const result = await db.execute({
    sql: `SELECT * FROM campaigns
          WHERE business_id = ? AND status = 'active' AND start_date <= ?`,
    args: [businessId, today],
  })
  const rows = result.rows as Record<string, unknown>[]
  if (rows.length === 0) return []

  const ids = rows.map(r => r.id as string)
  const shakeIds = rows.filter(r => r.mechanic === 'shake' || r.mechanic === 'spin' || r.mechanic === 'dice').map(r => r.id as string)
  const stampIds = rows.filter(r => r.mechanic === 'stamp').map(r => r.id as string)
  const loyaltyIds = rows.filter(r => r.mechanic === 'check-in-loyalty').map(r => r.id as string)

  const placeholders = ids.map(() => '?').join(', ')

  const [statsMap, participations, dailyNewMap, stampCards, loyaltyCards, businessRow, milestoneMap, loyaltyRedeemedResult] = await Promise.all([
    fetchCampaignStatsBatch(ids),
    db.execute({
      sql: `SELECT * FROM campaign_participations WHERE customer_id = ? AND campaign_id IN (${placeholders})`,
      args: [customerId, ...ids],
    }),
    batchDailyNewUsers(shakeIds, today),
    stampIds.length > 0
      ? db.execute({
          sql: `SELECT * FROM stamp_cards WHERE customer_id = ? AND campaign_id IN (${stampIds.map(() => '?').join(', ')})`,
          args: [customerId, ...stampIds],
        })
      : Promise.resolve({ rows: [] }),
    loyaltyIds.length > 0
      ? db.execute({
          sql: `SELECT * FROM loyalty_cards WHERE customer_id = ? AND campaign_id IN (${loyaltyIds.map(() => '?').join(', ')})`,
          args: [customerId, ...loyaltyIds],
        })
      : Promise.resolve({ rows: [] }),
    loyaltyIds.length > 0
      ? db.execute({ sql: 'SELECT name FROM businesses WHERE id = ?', args: [businessId] })
      : Promise.resolve({ rows: [] }),
    fetchMilestoneRewardsBatch(loyaltyIds),
    loyaltyIds.length > 0
      ? db.execute({
          sql: `SELECT campaign_id, reward_name, status FROM customer_rewards
                WHERE customer_id = ? AND campaign_id IN (${loyaltyIds.map(() => '?').join(', ')})`,
          args: [customerId, ...loyaltyIds],
        })
      : Promise.resolve({ rows: [] }),
  ])

  const stampExpireEntries = rows
    .filter(r => r.mechanic === 'stamp')
    .map(r => {
      const meta = parseStampCampaignMeta({
        config_json: r.config_json,
        claim_period_days: r.claim_period_days,
        cap_filled_at: r.cap_filled_at,
      })
      if (!meta) return null
      return {
        campaignId: r.id as string,
        claimDeadline: getClaimDeadline(
          r.end_date as string,
          meta.claimPeriodDays,
          meta.capFilledAt,
        ),
      }
    })
    .filter((e): e is { campaignId: string; claimDeadline: string } => e !== null)

  await expireStaleStampCampaigns(stampExpireEntries, today)

  const partMap = new Map(
    participations.rows.map(r => [r.campaign_id as string, r as Record<string, unknown>]),
  )
  const stampCardMap = new Map(
    stampCards.rows.map(r => [r.campaign_id as string, r as Record<string, unknown>]),
  )
  const loyaltyCardMap = new Map(
    loyaltyCards.rows.map(r => [r.campaign_id as string, r as Record<string, unknown>]),
  )
  const businessName = (businessRow.rows[0]?.name as string) ?? 'Business'

  const loyaltyRedeemedMap = new Map<string, Set<string>>()
  for (const row of loyaltyRedeemedResult.rows) {
    const cid = row.campaign_id as string
    if (!loyaltyRedeemedMap.has(cid)) loyaltyRedeemedMap.set(cid, new Set())
    if (row.status === 'redeemed') {
      loyaltyRedeemedMap.get(cid)!.add(row.reward_name as string)
    }
  }

  const items: BusinessCampaignStateItem[] = []

  for (const row of rows) {
    const campaignId = row.id as string
    const mechanic = row.mechanic as string
    const stats = statsMap.get(campaignId)!
    const campaign = mapRowToCampaignLite(row, stats.currentUsers)

    if (mechanic === 'shake' || mechanic === 'spin' || mechanic === 'dice') {
      const eligibility = await checkEligibility(campaign, customerId, {
        participation: partMap.get(campaignId) ?? null,
        totalUsers: stats.currentUsers,
        dailyNewUsers: dailyNewMap.get(campaignId) ?? 0,
      })
      items.push({
        campaignId,
        mechanic,
        state: {
          campaignId,
          playsRemaining: eligibility.playsRemaining,
          playsUsedToday: eligibility.playsUsedToday,
          playsPerDay: eligibility.playsPerDay,
          canPlay: eligibility.canPlay,
          message: eligibility.message,
          blockReason: eligibility.blockReason,
          winRatePercent: campaign.winRatePercent,
          overallWinners: campaign.overallWinners,
        },
      })
      continue
    }

    if (mechanic === 'stamp') {
      const meta = parseStampCampaignMeta({
        config_json: campaign.configJson,
        claim_period_days: campaign.claimPeriodDays,
        cap_filled_at: campaign.capFilledAt,
      })
      if (!meta) {
        items.push({ campaignId, mechanic, state: null })
        continue
      }

      const claimDeadline = getClaimDeadline(campaign.endDate, meta.claimPeriodDays, meta.capFilledAt)
      const card = stampCardMap.get(campaignId)
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
          && Number(card.stamps_collected ?? 0) < meta.config.totalStamps
          && card.last_stamp_date !== today
          && withinClaimWindow
        : enrollmentOpen && withinClaimWindow

      items.push({
        campaignId,
        mechanic,
        state: {
          campaignId,
          mechanic: 'stamp',
          enrolled: Boolean(card),
          enrollmentOpen,
          stampsCollected: Number(card?.stamps_collected ?? 0),
          totalStamps: meta.config.totalStamps,
          prefillStamps: meta.config.prefillStamps,
          surpriseDrops: meta.config.surpriseDrops,
          bigRewards: meta.config.bigRewards,
          dropTriggers: card
            ? parseDropTriggersFromRow(card as Record<string, unknown>, meta.config)
            : [],
          surpriseRange: meta.config.surpriseDrops[0]
            ? [meta.config.surpriseDrops[0].from, meta.config.surpriseDrops[0].to] as [number, number]
            : [1, 1],
          bigRange: meta.config.bigRewards[0]
            ? [meta.config.bigRewards[0].from, meta.config.bigRewards[0].to] as [number, number]
            : [1, 1],
          surpriseAwarded: Boolean(card?.surprise_awarded),
          bigAwarded: Boolean(card?.big_awarded),
          surpriseTriggerAt: (card?.surprise_trigger_at as string) ?? null,
          bigTriggerAt: (card?.big_trigger_at as string) ?? null,
          status: (card?.status as string) ?? null,
          claimDeadline,
          enrollmentCloseDate: getEnrollmentCloseDate(campaign.endDate, meta.capFilledAt),
          canCollectToday,
          cardComplete: card?.status === 'completed',
          userCap: campaign.userCap,
          currentUsers: campaign.currentUsers,
        },
      })
      continue
    }

    if (mechanic === 'check-in-loyalty') {
      const config = parseCheckInConfig(campaign.configJson)
      if (!config) {
        items.push({ campaignId, mechanic, state: null })
        continue
      }

      const card = loyaltyCardMap.get(campaignId)
      const checkedInToday = card?.last_check_in_date === today
      const milestones = milestoneMap.get(campaignId) ?? []
      const redeemedNames = loyaltyRedeemedMap.get(campaignId) ?? new Set<string>()

      const milestoneStates = milestones.map(m => ({
        id: m.id,
        name: m.name,
        icon: m.icon,
        pointsThreshold: m.pointsThreshold,
        unlocked: Number(card?.loyalty_points ?? 0) >= m.pointsThreshold,
        redeemed: redeemedNames.has(m.name),
      }))

      const points = Number(card?.loyalty_points ?? 0)
      const next = milestones.find(m => m.pointsThreshold > points) ?? null

      items.push({
        campaignId,
        mechanic,
        state: {
          campaignId,
          mechanic: 'check-in-loyalty',
          enrolled: Boolean(card),
          loyaltyPoints: points,
          totalCheckIns: Number(card?.total_check_ins ?? 0),
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
        },
      })
      continue
    }

    items.push({ campaignId, mechanic, state: null })
  }

  return items
}
