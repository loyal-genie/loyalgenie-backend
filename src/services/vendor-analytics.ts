import { nanoid } from 'nanoid'
import { db } from '../db/client.js'
import { getBusinessForUser } from './auth.js'
import { TtlCache } from '../utils/ttl-cache.js'

async function getBusinessIdForUser(userId: string): Promise<string> {
  const business = await getBusinessForUser(userId)
  if (!business) throw new Error('BUSINESS_NOT_FOUND')
  return business.id as string
}

export interface VendorCustomerSummary {
  id: string
  name: string
  phone: string
  email: string
  joinedAt: string
  lastVisit: string | null
  totalVisits: number
  gamesPlayed: number
  rewardsEarned: number
  redeemedCount: number
  totalLoyaltyPoints: number
  status: 'active' | 'inactive'
}

export interface VendorCustomerReward {
  id: string
  campaignId: string
  campaignName: string
  mechanic: string
  reward: string
  icon: string
  earnedAt: string
  status: 'earned' | 'pending' | 'redeemed'
  requestedAt?: string
  redeemedAt?: string
  code: string
}

export interface VendorGameHistoryItem {
  id: string
  campaignId: string
  campaignName: string
  mechanic: string
  playedAt: string
  won: boolean
  reward?: string
}

export interface VendorCampaignActivity {
  id: string
  name: string
  mechanic: string
  status: string
  plays: number
  wins: number
}

export interface VendorCustomerDetail extends VendorCustomerSummary {
  rewards: VendorCustomerReward[]
  gameHistory: VendorGameHistoryItem[]
  campaignActivity: VendorCampaignActivity[]
}

export interface VendorRedemptionItem {
  id: string
  customerId: string
  customerName: string
  phone: string
  reward: string
  campaignName: string
  mechanic: string
  earnedAt: string
  requestedAt?: string
  code: string
}

export interface VendorDashboardStats {
  totalCustomers: number
  activeCustomers30d: number
  repeatVisitRate: number
  retentionRate: number
  segmentCounts: {
    loyalist: number
    regular: number
    atRisk: number
    inactive: number
  }
  atRiskCustomers: VendorCustomerSummary[]
  pendingRedemptions: number
  totalPlays: number
  totalWins: number
  totalRedeemed: number
  playsLast30d: number
  returningCustomers30d: number
}

const DASHBOARD_CACHE_TTL_MS = Number(process.env.VENDOR_DASHBOARD_CACHE_MS ?? 30_000)
const CUSTOMERS_CACHE_TTL_MS = Number(process.env.VENDOR_CUSTOMERS_CACHE_MS ?? 60_000)
const dashboardCache = new TtlCache<VendorDashboardStats>(DASHBOARD_CACHE_TTL_MS)
const customersCache = new TtlCache<VendorCustomerSummary[]>(CUSTOMERS_CACHE_TTL_MS)

export function invalidateVendorDashboardCache(businessId?: string): void {
  if (businessId) dashboardCache.delete(businessId)
  else dashboardCache.clear()
}

export function invalidateVendorCustomersCache(businessId?: string): void {
  if (businessId) customersCache.delete(businessId)
  else customersCache.clear()
}

function mapCustomerRow(row: Record<string, unknown>): VendorCustomerSummary {
  const lastVisit = (row.last_visit as string) ?? null
  const daysSinceVisit = lastVisit
    ? Math.floor((Date.now() - new Date(lastVisit).getTime()) / 86400000)
    : 999

  return {
    id: row.id as string,
    name: row.name as string,
    phone: row.phone as string,
    email: row.email as string,
    joinedAt: (row.joined_at as string) ?? (row.created_at as string),
    lastVisit,
    totalVisits: Number(row.total_visits ?? 0),
    gamesPlayed: Number(row.games_played ?? 0),
    rewardsEarned: Number(row.rewards_earned ?? 0),
    redeemedCount: Number(row.redeemed_count ?? 0),
    totalLoyaltyPoints: Number(row.total_loyalty_points ?? 0),
    status: daysSinceVisit <= 45 ? 'active' : 'inactive',
  }
}

async function syncParticipationsFromGamePlays(businessId: string) {
  const orphaned = await db.execute({
    sql: `
      SELECT gp.campaign_id, gp.customer_id,
             MIN(gp.played_at) AS first_played,
             MAX(gp.played_at) AS last_played,
             COUNT(*) AS total,
             MAX(date(gp.played_at)) AS last_play_date
      FROM game_plays gp
      INNER JOIN campaigns c ON c.id = gp.campaign_id AND c.business_id = ?
      LEFT JOIN campaign_participations cp
        ON cp.campaign_id = gp.campaign_id AND cp.customer_id = gp.customer_id
      WHERE cp.id IS NULL
      GROUP BY gp.campaign_id, gp.customer_id
    `,
    args: [businessId],
  })

  if (orphaned.rows.length === 0) return

  await db.batch(
    orphaned.rows.map(row => ({
      sql: `INSERT INTO campaign_participations
            (id, campaign_id, customer_id, plays_today, last_play_date, total_plays, first_played_at, last_played_at)
            VALUES (?, ?, ?, 1, ?, ?, ?, ?)`,
      args: [
        nanoid(),
        row.campaign_id as string,
        row.customer_id as string,
        row.last_play_date as string,
        Number(row.total ?? 1),
        row.first_played as string,
        row.last_played as string,
      ],
    })),
  )
}

async function fetchCustomerSummaries(businessId: string): Promise<VendorCustomerSummary[]> {
  await syncParticipationsFromGamePlays(businessId)

  const result = await db.execute({
    sql: `
      SELECT
        cu.id,
        cu.name,
        cu.phone,
        cu.email,
        cu.created_at,
        MIN(gp.played_at) AS joined_at,
        MAX(gp.played_at) AS last_visit,
        COUNT(gp.id) AS total_visits,
        COUNT(gp.id) AS games_played,
        SUM(CASE WHEN gp.won = 1 THEN 1 ELSE 0 END) AS rewards_earned,
        COALESCE(cr_agg.redeemed_count, 0) AS redeemed_count,
        COALESCE(lc_agg.total_loyalty_points, 0) AS total_loyalty_points
      FROM game_plays gp
      INNER JOIN campaigns c ON c.id = gp.campaign_id AND c.business_id = ?
      INNER JOIN customer_users cu ON cu.id = gp.customer_id
      LEFT JOIN (
        SELECT cr.customer_id, COUNT(*) AS redeemed_count
        FROM customer_rewards cr
        INNER JOIN campaigns c2 ON c2.id = cr.campaign_id AND c2.business_id = ?
        WHERE cr.status = 'redeemed'
        GROUP BY cr.customer_id
      ) cr_agg ON cr_agg.customer_id = cu.id
      LEFT JOIN (
        SELECT lc.customer_id, SUM(lc.loyalty_points) AS total_loyalty_points
        FROM loyalty_cards lc
        INNER JOIN campaigns c3 ON c3.id = lc.campaign_id AND c3.business_id = ?
        GROUP BY lc.customer_id
      ) lc_agg ON lc_agg.customer_id = cu.id
      GROUP BY cu.id, cu.name, cu.phone, cu.email, cu.created_at,
               cr_agg.redeemed_count, lc_agg.total_loyalty_points
      ORDER BY last_visit DESC
    `,
    args: [businessId, businessId, businessId],
  })

  return result.rows.map(row => mapCustomerRow(row as Record<string, unknown>))
}

async function getCustomerSummariesCached(businessId: string): Promise<VendorCustomerSummary[]> {
  const cached = customersCache.get(businessId)
  if (cached) return cached
  const customers = await fetchCustomerSummaries(businessId)
  customersCache.set(businessId, customers)
  return customers
}

function computeSegment(c: VendorCustomerSummary): 'loyalist' | 'regular' | 'at-risk' | 'inactive' {
  if (!c.lastVisit) return 'inactive'
  const days = Math.floor((Date.now() - new Date(c.lastVisit).getTime()) / 86400000)
  if (days > 45) return 'inactive'
  if (days > 14) return 'at-risk'
  if (c.totalVisits >= 15) return 'loyalist'
  return 'regular'
}

export async function getVendorDashboardStats(userId: string): Promise<VendorDashboardStats> {
  const businessId = await getBusinessIdForUser(userId)
  const cached = dashboardCache.get(businessId)
  if (cached) return cached

  const stats = await computeVendorDashboardStats(businessId)
  dashboardCache.set(businessId, stats)
  return stats
}

async function computeVendorDashboardStats(businessId: string): Promise<VendorDashboardStats> {
  const customers = await getCustomerSummariesCached(businessId)

  const segmentCounts = { loyalist: 0, regular: 0, atRisk: 0, inactive: 0 }
  for (const c of customers) {
    const seg = computeSegment(c)
    if (seg === 'at-risk') segmentCounts.atRisk++
    else segmentCounts[seg]++
  }

  const activeCustomers30d = customers.filter(c => {
    if (!c.lastVisit) return false
    const days = Math.floor((Date.now() - new Date(c.lastVisit).getTime()) / 86400000)
    return days <= 30
  }).length

  const repeatCustomers = customers.filter(c => c.totalVisits > 1).length
  const repeatVisitRate = customers.length > 0
    ? Math.round((repeatCustomers / customers.length) * 100)
    : 0

  const [playsResult, returningResult, pendingResult] = await Promise.all([
    db.execute({
      sql: `
        SELECT
          COUNT(*) AS total_plays,
          SUM(CASE WHEN gp.won = 1 THEN 1 ELSE 0 END) AS total_wins,
          SUM(CASE WHEN (gp.played_at)::timestamptz >= datetime('now', '-30 days') THEN 1 ELSE 0 END) AS plays_last_30d,
          COUNT(DISTINCT CASE WHEN (gp.played_at)::timestamptz >= datetime('now', '-30 days') THEN gp.customer_id END) AS customers_last_30d,
          COUNT(DISTINCT CASE
            WHEN (gp.played_at)::timestamptz >= datetime('now', '-60 days')
             AND (gp.played_at)::timestamptz < datetime('now', '-30 days')
            THEN gp.customer_id END) AS customers_prior_30d
        FROM game_plays gp
        INNER JOIN campaigns c ON c.id = gp.campaign_id AND c.business_id = ?
      `,
      args: [businessId],
    }),
    db.execute({
      sql: `
        SELECT COUNT(DISTINCT recent.customer_id) AS cnt
        FROM (
          SELECT DISTINCT gp.customer_id
          FROM game_plays gp
          INNER JOIN campaigns c ON c.id = gp.campaign_id AND c.business_id = ?
          WHERE (gp.played_at)::timestamptz >= datetime('now', '-30 days')
        ) recent
        INNER JOIN (
          SELECT DISTINCT gp.customer_id
          FROM game_plays gp
          INNER JOIN campaigns c ON c.id = gp.campaign_id AND c.business_id = ?
          WHERE (gp.played_at)::timestamptz >= datetime('now', '-60 days')
            AND (gp.played_at)::timestamptz < datetime('now', '-30 days')
        ) prior ON prior.customer_id = recent.customer_id
      `,
      args: [businessId, businessId],
    }),
    db.execute({
      sql: `
        SELECT
          SUM(CASE WHEN cr.status = 'pending' THEN 1 ELSE 0 END) AS pending_cnt,
          SUM(CASE WHEN cr.status = 'redeemed' THEN 1 ELSE 0 END) AS redeemed_cnt
        FROM customer_rewards cr
        INNER JOIN campaigns c ON c.id = cr.campaign_id AND c.business_id = ?
      `,
      args: [businessId],
    }),
  ])

  const playRow = playsResult.rows[0] ?? {}
  const totalPlays = Number(playRow.total_plays ?? 0)
  const totalWins = Number(playRow.total_wins ?? 0)
  const playsLast30d = Number(playRow.plays_last_30d ?? 0)
  const customersLast30d = Number(playRow.customers_last_30d ?? 0)
  const customersPrior30d = Number(playRow.customers_prior_30d ?? 0)
  const returningCustomers30d = Number(returningResult.rows[0]?.cnt ?? 0)
  const pendingRedemptions = Number(pendingResult.rows[0]?.pending_cnt ?? 0)
  const totalRedeemed = Number(pendingResult.rows[0]?.redeemed_cnt ?? 0)

  const retentionRate = customersPrior30d > 0
    ? Math.round((returningCustomers30d / customersPrior30d) * 100)
    : customersLast30d > 0 ? 100 : 0

  const atRiskCustomers = customers
    .filter(c => {
      const seg = computeSegment(c)
      return seg === 'at-risk' || seg === 'inactive'
    })
    .slice(0, 6)

  return {
    totalCustomers: customers.length,
    activeCustomers30d,
    repeatVisitRate,
    retentionRate,
    segmentCounts,
    atRiskCustomers,
    pendingRedemptions,
    totalPlays,
    totalWins,
    totalRedeemed,
    playsLast30d,
    returningCustomers30d,
  }
}

export async function listVendorCustomers(userId: string): Promise<VendorCustomerSummary[]> {
  const businessId = await getBusinessIdForUser(userId)
  return getCustomerSummariesCached(businessId)
}

export async function getVendorCustomer(userId: string, customerId: string): Promise<VendorCustomerDetail> {
  const businessId = await getBusinessIdForUser(userId)
  const customers = await getCustomerSummariesCached(businessId)
  const summary = customers.find(c => c.id === customerId)
  if (!summary) throw new Error('CUSTOMER_NOT_FOUND')

  const rewardsResult = await db.execute({
    sql: `
      SELECT cr.id, cr.campaign_id, c.name AS campaign_name, c.mechanic,
             cr.reward_name, cr.icon, cr.earned_at, cr.status, cr.requested_at, cr.redeemed_at, cr.redemption_code
      FROM customer_rewards cr
      INNER JOIN campaigns c ON c.id = cr.campaign_id AND c.business_id = ?
      WHERE cr.customer_id = ?
      ORDER BY cr.earned_at DESC
    `,
    args: [businessId, customerId],
  })

  const rewards: VendorCustomerReward[] = rewardsResult.rows.map(row => ({
    id: row.id as string,
    campaignId: row.campaign_id as string,
    campaignName: row.campaign_name as string,
    mechanic: row.mechanic as string,
    reward: row.reward_name as string,
    icon: (row.icon as string) ?? '🎁',
    earnedAt: row.earned_at as string,
    status: row.status as 'earned' | 'pending' | 'redeemed',
    requestedAt: (row.requested_at as string) ?? undefined,
    redeemedAt: (row.redeemed_at as string) ?? undefined,
    code: row.redemption_code as string,
  }))

  const historyResult = await db.execute({
    sql: `
      SELECT gp.id, gp.campaign_id, c.name AS campaign_name, c.mechanic,
             gp.played_at, gp.won, gp.reward_name
      FROM game_plays gp
      INNER JOIN campaigns c ON c.id = gp.campaign_id AND c.business_id = ?
      WHERE gp.customer_id = ?
      ORDER BY gp.played_at DESC
    `,
    args: [businessId, customerId],
  })

  const gameHistory: VendorGameHistoryItem[] = historyResult.rows.map(row => ({
    id: row.id as string,
    campaignId: row.campaign_id as string,
    campaignName: row.campaign_name as string,
    mechanic: row.mechanic as string,
    playedAt: row.played_at as string,
    won: Boolean(row.won),
    reward: (row.reward_name as string) ?? undefined,
  }))

  const activityResult = await db.execute({
    sql: `
      SELECT c.id, c.name, c.mechanic, c.status,
             COUNT(gp.id) AS plays,
             SUM(CASE WHEN gp.won = 1 THEN 1 ELSE 0 END) AS wins
      FROM game_plays gp
      INNER JOIN campaigns c ON c.id = gp.campaign_id AND c.business_id = ?
      WHERE gp.customer_id = ?
      GROUP BY c.id
      ORDER BY MAX(gp.played_at) DESC
    `,
    args: [businessId, customerId],
  })

  const campaignActivity: VendorCampaignActivity[] = activityResult.rows.map(row => ({
    id: row.id as string,
    name: row.name as string,
    mechanic: row.mechanic as string,
    status: row.status as string,
    plays: Number(row.plays ?? 0),
    wins: Number(row.wins ?? 0),
  }))

  return { ...summary, rewards, gameHistory, campaignActivity }
}

export async function listPendingRedemptions(userId: string): Promise<VendorRedemptionItem[]> {
  const businessId = await getBusinessIdForUser(userId)
  const result = await db.execute({
    sql: `
      SELECT cr.id, cr.customer_id, cu.name AS customer_name, cu.phone,
             cr.reward_name, c.name AS campaign_name, c.mechanic,
             cr.requested_at, cr.earned_at, cr.redemption_code
      FROM customer_rewards cr
      INNER JOIN campaigns c ON c.id = cr.campaign_id AND c.business_id = ?
      INNER JOIN customer_users cu ON cu.id = cr.customer_id
      WHERE cr.status = 'pending'
      ORDER BY COALESCE(cr.requested_at, cr.earned_at) ASC
    `,
    args: [businessId],
  })

  return result.rows.map(row => ({
    id: row.id as string,
    customerId: row.customer_id as string,
    customerName: row.customer_name as string,
    phone: row.phone as string,
    reward: row.reward_name as string,
    campaignName: row.campaign_name as string,
    mechanic: row.mechanic as string,
    earnedAt: row.earned_at as string,
    requestedAt: (row.requested_at as string) ?? undefined,
    code: row.redemption_code as string,
  }))
}

export async function markRedemptionRedeemed(userId: string, rewardId: string) {
  const businessId = await getBusinessIdForUser(userId)
  const check = await db.execute({
    sql: `
      SELECT cr.id
      FROM customer_rewards cr
      INNER JOIN campaigns c ON c.id = cr.campaign_id AND c.business_id = ?
      WHERE cr.id = ? AND cr.status = 'pending'
    `,
    args: [businessId, rewardId],
  })
  if (check.rows.length === 0) throw new Error('REWARD_NOT_FOUND')

  await db.execute({
    sql: `UPDATE customer_rewards SET status = 'redeemed', redeemed_at = datetime('now') WHERE id = ?`,
    args: [rewardId],
  })

  invalidateVendorDashboardCache(businessId)
  invalidateVendorCustomersCache(businessId)
}
