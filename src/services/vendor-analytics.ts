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
  period: VendorStatsPeriod
  /** Lifetime unique customers who have played (period-independent). */
  totalCustomers: number
  /** Unique customers with activity in the selected period. */
  uniquePlayers: number
  /** Customers whose last visit falls in the selected period. */
  activeCustomers: number
  activeCustomers30d: number
  /** % of customers (lifetime or in-period cohort) with more than one play. */
  repeatVisitRate: number
  /** Cohort retention for the selected window (prior window → current). */
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
  /** Exact count of customers with >1 play in the window (for subtitle). */
  multiPlayCustomers: number
  /** Prior equal-length window for real trend chips. */
  previous: {
    uniquePlayers: number
    activeCustomers: number
    totalWins: number
    totalRedeemed: number
    totalPlays: number
    repeatVisitRate: number
    retentionRate: number
    totalCustomers: number
  }
}

export type VendorStatsPeriod = 'all' | '7d' | 'month' | '3m' | 'year'

const PERIOD_DAYS: Record<VendorStatsPeriod, number | null> = {
  all: null,
  '7d': 7,
  month: 30,
  '3m': 90,
  year: 365,
}

const DASHBOARD_CACHE_TTL_MS = Number(process.env.VENDOR_DASHBOARD_CACHE_MS ?? 2_000)
const CUSTOMERS_CACHE_TTL_MS = Number(process.env.VENDOR_CUSTOMERS_CACHE_MS ?? 5_000)
const dashboardCache = new TtlCache<VendorDashboardStats>(DASHBOARD_CACHE_TTL_MS)
const customersCache = new TtlCache<VendorCustomerSummary[]>(CUSTOMERS_CACHE_TTL_MS)

export function invalidateVendorDashboardCache(businessId?: string): void {
  if (businessId) {
    for (const period of Object.keys(PERIOD_DAYS) as VendorStatsPeriod[]) {
      dashboardCache.delete(`${businessId}:${period}`)
    }
  } else {
    dashboardCache.clear()
  }
}

export function invalidateVendorCustomersCache(businessId?: string): void {
  if (businessId) customersCache.delete(businessId)
  else customersCache.clear()
}

/** Clear all vendor analytics caches for a business (call after plays / redeems). */
export function invalidateBusinessAnalyticsCaches(businessId: string): void {
  invalidateVendorDashboardCache(businessId)
  invalidateVendorCustomersCache(businessId)
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

async function countUniqueCustomers(businessId: string): Promise<number> {
  // One person counted once for the business — never sum campaign enrollments.
  const result = await db.execute({
    sql: `
      SELECT COUNT(*) AS c FROM (
        SELECT DISTINCT gp.customer_id
        FROM game_plays gp
        INNER JOIN campaigns c ON c.id = gp.campaign_id AND c.business_id = ?
        INNER JOIN customer_users cu ON cu.id = gp.customer_id
      ) t
    `,
    args: [businessId],
  })
  return Number(result.rows[0]?.c ?? 0)
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
        COALESCE(MAX(cr_agg.redeemed_count), 0) AS redeemed_count,
        COALESCE(MAX(bcp.points), 0) AS total_loyalty_points
      FROM game_plays gp
      INNER JOIN campaigns c ON c.id = gp.campaign_id AND c.business_id = ?
      INNER JOIN customer_users cu ON cu.id = gp.customer_id
      LEFT JOIN (
        SELECT cr.customer_id, COUNT(*) AS redeemed_count
        FROM customer_rewards cr
        LEFT JOIN campaigns c2 ON c2.id = cr.campaign_id
        WHERE cr.status = 'redeemed' AND (cr.business_id = ? OR c2.business_id = ?)
        GROUP BY cr.customer_id
      ) cr_agg ON cr_agg.customer_id = cu.id
      LEFT JOIN business_customer_points bcp
        ON bcp.customer_id = cu.id AND bcp.business_id = ?
      GROUP BY cu.id, cu.name, cu.phone, cu.email, cu.created_at
      ORDER BY last_visit DESC
    `,
    args: [businessId, businessId, businessId, businessId],
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

export async function getVendorDashboardStats(
  userId: string,
  period: VendorStatsPeriod = 'all',
): Promise<VendorDashboardStats> {
  const businessId = await getBusinessIdForUser(userId)
  const cacheKey = `${businessId}:${period}`
  const cached = dashboardCache.get(cacheKey)
  if (cached) return cached

  const stats = await computeVendorDashboardStats(businessId, period)
  dashboardCache.set(cacheKey, stats)
  return stats
}

function periodSqlOffset(days: number): string {
  return `-${Math.max(1, Math.floor(days))} days`
}

/** Literal SQLite datetime() that convertSql maps to Postgres NOW() - INTERVAL. */
function sqlNowOffset(days: number): string {
  return `datetime('now', '${periodSqlOffset(days)}')`
}

async function queryWindowMetrics(
  businessId: string,
  /** Inclusive start offset from now, e.g. 30 for "last 30 days". null = all time. */
  windowDays: number | null,
  /** Shift the window further into the past by this many days (for previous period). */
  shiftDays = 0,
): Promise<{
  uniquePlayers: number
  totalPlays: number
  totalWins: number
  totalRedeemed: number
  multiPlayCustomers: number
}> {
  const hasWindow = windowDays !== null
  const endDays = shiftDays > 0 ? shiftDays : null
  const startDays = hasWindow
    ? (windowDays as number) + shiftDays
    : null

  let playFilter = ''
  if (startDays !== null && endDays !== null) {
    playFilter = `AND (gp.played_at)::timestamptz >= ${sqlNowOffset(startDays)} AND (gp.played_at)::timestamptz < ${sqlNowOffset(endDays)}`
  } else if (startDays !== null) {
    playFilter = `AND (gp.played_at)::timestamptz >= ${sqlNowOffset(startDays)}`
  }

  let redeemFilter = `AND cr.status = 'redeemed'`
  if (startDays !== null && endDays !== null) {
    redeemFilter += ` AND (cr.redeemed_at)::timestamptz >= ${sqlNowOffset(startDays)} AND (cr.redeemed_at)::timestamptz < ${sqlNowOffset(endDays)}`
  } else if (startDays !== null) {
    redeemFilter += ` AND (cr.redeemed_at)::timestamptz >= ${sqlNowOffset(startDays)}`
  }

  const [playsResult, multiResult, redeemResult] = await Promise.all([
    db.execute({
      sql: `
        SELECT
          COUNT(*) AS total_plays,
          COALESCE(SUM(CASE WHEN gp.won = 1 THEN 1 ELSE 0 END), 0) AS total_wins,
          COUNT(DISTINCT gp.customer_id) AS unique_players
        FROM game_plays gp
        INNER JOIN campaigns c ON c.id = gp.campaign_id AND c.business_id = ?
        INNER JOIN customer_users cu ON cu.id = gp.customer_id
        WHERE 1=1 ${playFilter}
      `,
      args: [businessId],
    }),
    db.execute({
      sql: `
        SELECT COUNT(*) AS multi_play_customers FROM (
          SELECT gp.customer_id
          FROM game_plays gp
          INNER JOIN campaigns c ON c.id = gp.campaign_id AND c.business_id = ?
          INNER JOIN customer_users cu ON cu.id = gp.customer_id
          WHERE 1=1 ${playFilter}
          GROUP BY gp.customer_id
          HAVING COUNT(*) > 1
        ) t
      `,
      args: [businessId],
    }),
    db.execute({
      sql: `
        SELECT COUNT(*) AS redeemed_cnt
        FROM customer_rewards cr
        LEFT JOIN campaigns c ON c.id = cr.campaign_id
        WHERE (cr.business_id = ? OR c.business_id = ?)
          ${redeemFilter}
      `,
      args: [businessId, businessId],
    }),
  ])

  const row = playsResult.rows[0] ?? {}
  return {
    uniquePlayers: Number(row.unique_players ?? 0),
    totalPlays: Number(row.total_plays ?? 0),
    totalWins: Number(row.total_wins ?? 0),
    totalRedeemed: Number(redeemResult.rows[0]?.redeemed_cnt ?? 0),
    multiPlayCustomers: Number(multiResult.rows[0]?.multi_play_customers ?? 0),
  }
}

async function queryCohortRetention(
  businessId: string,
  windowDays: number,
): Promise<{ retentionRate: number; returningCount: number; priorCount: number }> {
  // Prior window: [2w, w) ago; current window: [w, now)
  const currentStart = sqlNowOffset(windowDays)
  const priorStart = sqlNowOffset(windowDays * 2)

  const result = await db.execute({
    sql: `
      SELECT
        (SELECT COUNT(DISTINCT gp.customer_id)
         FROM game_plays gp
         INNER JOIN campaigns c ON c.id = gp.campaign_id AND c.business_id = ?
         WHERE (gp.played_at)::timestamptz >= ${priorStart}
           AND (gp.played_at)::timestamptz < ${currentStart}) AS prior_count,
        (SELECT COUNT(DISTINCT recent.customer_id)
         FROM (
           SELECT DISTINCT gp.customer_id
           FROM game_plays gp
           INNER JOIN campaigns c ON c.id = gp.campaign_id AND c.business_id = ?
           WHERE (gp.played_at)::timestamptz >= ${currentStart}
         ) recent
         INNER JOIN (
           SELECT DISTINCT gp.customer_id
           FROM game_plays gp
           INNER JOIN campaigns c ON c.id = gp.campaign_id AND c.business_id = ?
           WHERE (gp.played_at)::timestamptz >= ${priorStart}
             AND (gp.played_at)::timestamptz < ${currentStart}
         ) prior ON prior.customer_id = recent.customer_id) AS returning_count
    `,
    args: [businessId, businessId, businessId],
  })

  const priorCount = Number(result.rows[0]?.prior_count ?? 0)
  const returningCount = Number(result.rows[0]?.returning_count ?? 0)
  const retentionRate = priorCount > 0
    ? Math.round((returningCount / priorCount) * 100)
    : 0

  return { retentionRate, returningCount, priorCount }
}

async function computeVendorDashboardStats(
  businessId: string,
  period: VendorStatsPeriod,
): Promise<VendorDashboardStats> {
  const customers = await getCustomerSummariesCached(businessId)
  const windowDays = PERIOD_DAYS[period]

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

  const activeCustomers = windowDays === null
    ? customers.length
    : customers.filter(c => {
      if (!c.lastVisit) return false
      const days = Math.floor((Date.now() - new Date(c.lastVisit).getTime()) / 86400000)
      return days <= windowDays
    }).length

  const [current, previous, pendingResult, plays30d] = await Promise.all([
    queryWindowMetrics(businessId, windowDays, 0),
    windowDays !== null
      ? queryWindowMetrics(businessId, windowDays, windowDays)
      : Promise.resolve({
          uniquePlayers: 0,
          totalPlays: 0,
          totalWins: 0,
          totalRedeemed: 0,
          multiPlayCustomers: 0,
        }),
    db.execute({
      sql: `
        SELECT
          SUM(CASE WHEN cr.status = 'pending' THEN 1 ELSE 0 END) AS pending_cnt
        FROM customer_rewards cr
        LEFT JOIN campaigns c ON c.id = cr.campaign_id
        WHERE (cr.business_id = ? OR c.business_id = ?)
      `,
      args: [businessId, businessId],
    }),
    db.execute({
      sql: `
        SELECT COUNT(*) AS plays_last_30d
        FROM game_plays gp
        INNER JOIN campaigns c ON c.id = gp.campaign_id AND c.business_id = ?
        WHERE (gp.played_at)::timestamptz >= datetime('now', '-30 days')
      `,
      args: [businessId],
    }),
  ])

  // Repeat visit rate: customers with >1 play in the window (or lifetime for all)
  const repeatBase = current.uniquePlayers
  const repeatVisitRate = repeatBase > 0
    ? Math.round((current.multiPlayCustomers / repeatBase) * 100)
    : 0

  const prevRepeatBase = previous.uniquePlayers
  const prevRepeatVisitRate = prevRepeatBase > 0
    ? Math.round((previous.multiPlayCustomers / prevRepeatBase) * 100)
    : 0

  // Retention: all-time = % who returned at least once; otherwise cohort for window
  let retentionRate: number
  let returningCustomers30d = 0
  let prevRetentionRate = 0

  if (windowDays === null) {
    const returned = customers.filter(c => c.totalVisits > 1).length
    retentionRate = customers.length > 0
      ? Math.round((returned / customers.length) * 100)
      : 0
    const cohort30 = await queryCohortRetention(businessId, 30)
    returningCustomers30d = cohort30.returningCount
    // Lifetime has no prior period — frontend shows "Lifetime total"
    prevRetentionRate = retentionRate
  } else {
    const cohort = await queryCohortRetention(businessId, windowDays)
    retentionRate = cohort.retentionRate
    returningCustomers30d = windowDays === 30 ? cohort.returningCount : 0
    // Prior cohort: windows shifted back by one period length
    const shifted = await queryCohortRetentionShifted(businessId, windowDays, windowDays)
    prevRetentionRate = shifted.retentionRate
  }

  const customersAsOf30dAgo = customers.filter(c => {
    if (!c.joinedAt) return false
    const days = Math.floor((Date.now() - new Date(c.joinedAt).getTime()) / 86400000)
    return days > 30
  }).length

  // Previous active customers when period is all — use activeCustomers30d as soft prior
  const prevActiveCustomers = windowDays === null
    ? activeCustomers30d
    : customers.filter(c => {
      if (!c.lastVisit) return false
      const days = Math.floor((Date.now() - new Date(c.lastVisit).getTime()) / 86400000)
      return days > windowDays && days <= windowDays * 2
    }).length

  const pendingRedemptions = Number(pendingResult.rows[0]?.pending_cnt ?? 0)
  const playsLast30d = Number(plays30d.rows[0]?.plays_last_30d ?? 0)

  const atRiskCustomers = customers
    .filter(c => {
      const seg = computeSegment(c)
      return seg === 'at-risk' || seg === 'inactive'
    })
    .slice(0, 6)

  // Lifetime unique customers — one person = 1, regardless of how many campaigns they joined
  const totalCustomers = await countUniqueCustomers(businessId)
  // Same number for Total Players cards (do not use period-windowed play cohorts here)
  const uniquePlayers = totalCustomers

  return {
    period,
    totalCustomers,
    uniquePlayers,
    activeCustomers,
    activeCustomers30d,
    repeatVisitRate,
    retentionRate,
    segmentCounts,
    atRiskCustomers,
    pendingRedemptions,
    totalPlays: current.totalPlays,
    totalWins: current.totalWins,
    totalRedeemed: current.totalRedeemed,
    playsLast30d,
    returningCustomers30d,
    previous: {
      uniquePlayers: windowDays === null ? customersAsOf30dAgo : previous.uniquePlayers,
      activeCustomers: prevActiveCustomers,
      totalWins: previous.totalWins,
      totalRedeemed: previous.totalRedeemed,
      totalPlays: previous.totalPlays,
      repeatVisitRate: prevRepeatVisitRate,
      retentionRate: prevRetentionRate,
      // Total Users is always lifetime — compare to cohort as of 30d ago
      totalCustomers: customersAsOf30dAgo,
    },
    multiPlayCustomers: current.multiPlayCustomers,
  }
}

/** Cohort retention with both windows shifted back by `shiftDays`. */
async function queryCohortRetentionShifted(
  businessId: string,
  windowDays: number,
  shiftDays: number,
): Promise<{ retentionRate: number; returningCount: number; priorCount: number }> {
  const currentStart = sqlNowOffset(windowDays + shiftDays)
  const currentEnd = sqlNowOffset(shiftDays)
  const priorStart = sqlNowOffset(windowDays * 2 + shiftDays)
  const priorEnd = sqlNowOffset(windowDays + shiftDays)

  const result = await db.execute({
    sql: `
      SELECT
        (SELECT COUNT(DISTINCT gp.customer_id)
         FROM game_plays gp
         INNER JOIN campaigns c ON c.id = gp.campaign_id AND c.business_id = ?
         WHERE (gp.played_at)::timestamptz >= ${priorStart}
           AND (gp.played_at)::timestamptz < ${priorEnd}) AS prior_count,
        (SELECT COUNT(DISTINCT recent.customer_id)
         FROM (
           SELECT DISTINCT gp.customer_id
           FROM game_plays gp
           INNER JOIN campaigns c ON c.id = gp.campaign_id AND c.business_id = ?
           WHERE (gp.played_at)::timestamptz >= ${currentStart}
             AND (gp.played_at)::timestamptz < ${currentEnd}
         ) recent
         INNER JOIN (
           SELECT DISTINCT gp.customer_id
           FROM game_plays gp
           INNER JOIN campaigns c ON c.id = gp.campaign_id AND c.business_id = ?
           WHERE (gp.played_at)::timestamptz >= ${priorStart}
             AND (gp.played_at)::timestamptz < ${priorEnd}
         ) prior ON prior.customer_id = recent.customer_id) AS returning_count
    `,
    args: [businessId, businessId, businessId],
  })

  const priorCount = Number(result.rows[0]?.prior_count ?? 0)
  const returningCount = Number(result.rows[0]?.returning_count ?? 0)
  const retentionRate = priorCount > 0
    ? Math.round((returningCount / priorCount) * 100)
    : 0

  return { retentionRate, returningCount, priorCount }
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
      SELECT cr.id, cr.campaign_id, COALESCE(c.name, 'Rewards') AS campaign_name, COALESCE(c.mechanic, 'points_claim') AS mechanic,
             cr.reward_name, cr.icon, cr.earned_at, cr.status, cr.requested_at, cr.redeemed_at, cr.redemption_code
      FROM customer_rewards cr
      LEFT JOIN campaigns c ON c.id = cr.campaign_id
      WHERE cr.customer_id = ?
        AND (cr.business_id = ? OR c.business_id = ?)
      ORDER BY cr.earned_at DESC
    `,
    args: [customerId, businessId, businessId],
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
             cr.reward_name, COALESCE(c.name, 'Rewards') AS campaign_name,
             COALESCE(c.mechanic, 'points_claim') AS mechanic,
             cr.requested_at, cr.earned_at, cr.redemption_code
      FROM customer_rewards cr
      LEFT JOIN campaigns c ON c.id = cr.campaign_id
      INNER JOIN customer_users cu ON cu.id = cr.customer_id
      WHERE cr.status = 'pending' AND (cr.business_id = ? OR c.business_id = ?)
      ORDER BY COALESCE(cr.requested_at, cr.earned_at) ASC
    `,
    args: [businessId, businessId],
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
      LEFT JOIN campaigns c ON c.id = cr.campaign_id
      WHERE cr.id = ? AND cr.status = 'pending' AND (cr.business_id = ? OR c.business_id = ?)
    `,
    args: [rewardId, businessId, businessId],
  })
  if (check.rows.length === 0) throw new Error('REWARD_NOT_FOUND')

  await db.execute({
    sql: `UPDATE customer_rewards SET status = 'redeemed', redeemed_at = datetime('now') WHERE id = ?`,
    args: [rewardId],
  })

  invalidateVendorDashboardCache(businessId)
  invalidateVendorCustomersCache(businessId)
}
