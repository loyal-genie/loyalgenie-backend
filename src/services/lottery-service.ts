import { nanoid } from 'nanoid'
import { db } from '../db/client.js'
import {
  todayInCampaignTz,
  nowInCampaignTz,
  currentTimeInCampaignTz,
  isCampaignInWindow,
} from '../utils/campaign-dates.js'
import { verifyPlaySession } from './campaigns.js'
import { invalidateBusinessAnalyticsCaches } from './vendor-analytics.js'
import {
  parseLotteryConfig,
  serializeLotteryConfig,
  type LotteryConfig,
} from './lottery-campaign-schema.js'
import { computeRedeemExpiryDate } from '../utils/redeem-expiry.js'

const UNLIMITED_USER_CAP = 1_000_000

function generateSerialCode(): string {
  return `LG-${Math.floor(10000 + Math.random() * 90000)}`
}

function generateRedemptionCode(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  return Array.from({ length: 8 }, () => chars[Math.floor(Math.random() * chars.length)]).join('')
}

function mapTicket(row: Record<string, unknown>) {
  return {
    id: row.id as string,
    ticketNumber: row.ticket_number as number,
    serialCode: row.serial_code as string,
    status: row.status as string,
    claimedAt: row.claimed_at as string,
    prizeRewardId: (row.prize_reward_id as string) ?? null,
    prizeName: (row.prize_name as string) ?? null,
    prizeIcon: (row.prize_icon as string) ?? null,
    walletRewardId: (row.wallet_reward_id as string) ?? null,
    canClaimToWallet: row.status === 'won' && !row.wallet_reward_id,
  }
}

export function isLotteryCampaignActive(
  status: string,
  startDate: string,
  endDate: string,
  startTime: string,
  endTime: string,
  drawCompleted: boolean,
): boolean {
  if (drawCompleted || status === 'ended') return false
  if (status !== 'active') return false
  // Same-day campaigns must check BOTH start and end times in IST.
  // Do not collapse to a single time — that incorrectly closes "Today" entries.
  return isCampaignInWindow(startDate, endDate, startTime, endTime)
}

export function isLotteryDrawDue(
  endDate: string,
  endTime: string,
  drawCompleted: boolean,
): boolean {
  if (drawCompleted) return false
  const today = todayInCampaignTz()
  if (today < endDate) return false
  if (today > endDate) return true
  return currentTimeInCampaignTz() >= endTime
}

/**
 * Ticket-weighted draw: each ticket is one equal entry, so customers with more
 * tickets have proportionally higher odds. Prizes are assigned jackpot-first
 * (sort_order ASC). A customer can win at most one prize — after they win,
 * their remaining tickets leave the pool so the next prize goes to someone else.
 */
export function selectLotteryWinners(
  tickets: Record<string, unknown>[],
  prizes: Record<string, unknown>[],
  random: () => number = Math.random,
): { ticket: Record<string, unknown>; prize: Record<string, unknown> }[] {
  const winners: { ticket: Record<string, unknown>; prize: Record<string, unknown> }[] = []
  const usedTicketIds = new Set<string>()
  const winningCustomerIds = new Set<string>()

  for (const prize of prizes) {
    const available = tickets.filter(t => {
      const id = t.id as string
      const customerId = t.customer_id as string
      return !usedTicketIds.has(id) && !winningCustomerIds.has(customerId)
    })
    if (available.length === 0) break

    const winner = available[Math.floor(random() * available.length)]!
    usedTicketIds.add(winner.id as string)
    winningCustomerIds.add(winner.customer_id as string)
    winners.push({ ticket: winner, prize })
  }

  return winners
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
  if (row.mechanic !== 'lottery') throw new Error('NOT_LOTTERY_CAMPAIGN')
  return row
}

async function getCustomerTickets(campaignId: string, customerId: string) {
  const result = await db.execute({
    sql: `SELECT lt.*,
                 cr.id AS wallet_reward_id,
                 COALESCE(crw.description, crw.name) AS prize_name,
                 crw.icon AS prize_icon
          FROM lottery_tickets lt
          LEFT JOIN customer_rewards cr ON cr.play_id = lt.id AND cr.customer_id = lt.customer_id
          LEFT JOIN campaign_rewards crw ON crw.id = lt.prize_reward_id
          WHERE lt.campaign_id = ? AND lt.customer_id = ?
          ORDER BY lt.ticket_number ASC`,
    args: [campaignId, customerId],
  })
  return result.rows as Record<string, unknown>[]
}

function playsUsedTodayFromParticipation(
  participation: Record<string, unknown> | undefined,
  today: string,
): number {
  if (!participation) return 0
  const lastPlayDate = (participation.last_play_date as string) ?? ''
  return lastPlayDate === today ? Number(participation.plays_today ?? 0) : 0
}

export async function getLotteryState(campaignId: string, customerId: string) {
  const row = await getCampaignRow(campaignId)
  const config = parseLotteryConfig((row.config_json as string) ?? null)
  if (!config) throw new Error('INVALID_LOTTERY_CONFIG')

  const startTime = (row.start_time as string) ?? '00:00'
  const endTime = (row.end_time as string) ?? '23:59'
  const drawCompleted = Boolean(config.drawCompleted)
  const active = isLotteryCampaignActive(
    row.status as string,
    row.start_date as string,
    row.end_date as string,
    startTime,
    endTime,
    drawCompleted,
  )

  const tickets = await getCustomerTickets(campaignId, customerId)
  const ticketCountResult = await db.execute({
    sql: 'SELECT COUNT(*) AS c FROM lottery_tickets WHERE campaign_id = ?',
    args: [campaignId],
  })
  const totalTickets = Number(ticketCountResult.rows[0]?.c ?? 0)

  const today = todayInCampaignTz()
  const partResult = await db.execute({
    sql: 'SELECT * FROM campaign_participations WHERE campaign_id = ? AND customer_id = ?',
    args: [campaignId, customerId],
  })
  const participation = partResult.rows[0] as Record<string, unknown> | undefined
  const playsPerDay = Math.max(1, Number(row.plays_per_day ?? 1))
  const playsUsedToday = playsUsedTodayFromParticipation(participation, today)
  const playsRemaining = Math.max(0, playsPerDay - playsUsedToday)
  const canClaimTicket = active && playsRemaining > 0

  const mappedTickets = tickets.map(mapTicket)
  const latestTicket = mappedTickets.length > 0 ? mappedTickets[mappedTickets.length - 1]! : null
  const wonTicket = mappedTickets.find(t => t.status === 'won' && t.canClaimToWallet)
    ?? mappedTickets.find(t => t.status === 'won')
    ?? null

  return {
    campaignId,
    campaignName: row.name as string,
    businessName: row.business_name as string,
    drawDate: row.end_date as string,
    drawCompleted,
    drawCompletedAt: config.drawCompletedAt ?? null,
    active,
    canClaimTicket,
    hasTicket: tickets.length > 0,
    ticketCount: tickets.length,
    playsPerDay,
    playsUsedToday,
    playsRemaining,
    ticket: latestTicket,
    tickets: mappedTickets,
    wonTicket,
    walletRewardStatus: null as string | null,
    walletRewardId: wonTicket?.walletRewardId ?? null,
    totalTickets,
    prizes: config.prizes.map(p => ({
      tier: p.tier,
      name: p.name,
      reward: p.reward,
      icon: p.icon ?? (p.tier === 'jackpot' ? '👑' : '🎁'),
    })),
  }
}

export async function claimLotteryTicket(
  campaignId: string,
  customerId: string,
  playSessionToken: string,
) {
  if (!verifyPlaySession(playSessionToken, campaignId, customerId)) {
    throw new Error('INVALID_PLAY_SESSION')
  }

  const row = await getCampaignRow(campaignId)
  const config = parseLotteryConfig((row.config_json as string) ?? null)
  if (!config) throw new Error('INVALID_LOTTERY_CONFIG')
  if (config.drawCompleted) throw new Error('DRAW_ALREADY_COMPLETED')

  const startTime = (row.start_time as string) ?? '00:00'
  const endTime = (row.end_time as string) ?? '23:59'
  if (!isLotteryCampaignActive(
    row.status as string,
    row.start_date as string,
    row.end_date as string,
    startTime,
    endTime,
    false,
  )) {
    throw new Error('CAMPAIGN_NOT_ACTIVE')
  }

  const today = todayInCampaignTz()
  const playsPerDay = Math.max(1, Number(row.plays_per_day ?? 1))
  const partResult = await db.execute({
    sql: 'SELECT * FROM campaign_participations WHERE campaign_id = ? AND customer_id = ?',
    args: [campaignId, customerId],
  })
  const participation = partResult.rows[0] as Record<string, unknown> | undefined
  const playsUsedToday = playsUsedTodayFromParticipation(participation, today)
  if (playsUsedToday >= playsPerDay) {
    throw new Error('NO_PLAYS_REMAINING')
  }

  const countResult = await db.execute({
    sql: 'SELECT COUNT(*) AS c, COALESCE(MAX(ticket_number), 0) AS max_no FROM lottery_tickets WHERE campaign_id = ?',
    args: [campaignId],
  })
  const ticketNumber = Number(countResult.rows[0]?.max_no ?? 0) + 1

  const ticketId = nanoid()
  let serialCode = generateSerialCode()
  for (let attempt = 0; attempt < 5; attempt++) {
    const dup = await db.execute({
      sql: 'SELECT 1 FROM lottery_tickets WHERE serial_code = ?',
      args: [serialCode],
    })
    if (dup.rows.length === 0) break
    serialCode = generateSerialCode()
  }

  const playsToday = playsUsedToday + 1
  const statements: { sql: string; args: unknown[] }[] = [
    {
      sql: `INSERT INTO lottery_tickets
            (id, campaign_id, customer_id, ticket_number, serial_code, status, claimed_at)
            VALUES (?, ?, ?, ?, ?, 'pending_draw', datetime('now'))`,
      args: [ticketId, campaignId, customerId, ticketNumber, serialCode],
    },
  ]

  if (!participation) {
    statements.push({
      sql: `INSERT INTO campaign_participations
            (id, campaign_id, customer_id, plays_today, last_play_date, total_plays, first_played_at, last_played_at)
            VALUES (?, ?, ?, 1, ?, 1, datetime('now'), datetime('now'))`,
      args: [nanoid(), campaignId, customerId, today],
    })
  } else {
    statements.push({
      sql: `UPDATE campaign_participations
            SET plays_today = ?, last_play_date = ?, total_plays = total_plays + 1, last_played_at = datetime('now')
            WHERE campaign_id = ? AND customer_id = ?`,
      args: [playsToday, today, campaignId, customerId],
    })
  }

  await db.batch(statements)

  invalidateBusinessAnalyticsCaches(row.business_id as string)

  return {
    ticketId,
    ticketNumber,
    serialCode,
    drawDate: row.end_date as string,
    walletRewardId: null as string | null,
    playsRemaining: Math.max(0, playsPerDay - playsToday),
    playsUsedToday: playsToday,
    playsPerDay,
    prizes: config.prizes.map(p => ({
      tier: p.tier,
      name: p.name,
      reward: p.reward,
      icon: p.icon ?? (p.tier === 'jackpot' ? '👑' : '🎁'),
    })),
  }
}

/** Move a winning ticket into the wallet so the customer can redeem it. */
export async function claimLotteryWinToWallet(customerId: string, ticketId: string) {
  const ticketResult = await db.execute({
    sql: `SELECT lt.*, c.name AS campaign_name, c.business_id, c.config_json,
                 crw.id AS prize_id, crw.name AS prize_reward_name, crw.icon AS prize_icon,
                 crw.redeem_expiry_mode, crw.redeem_fixed_date, crw.redeem_relative_amount, crw.redeem_relative_unit
          FROM lottery_tickets lt
          INNER JOIN campaigns c ON c.id = lt.campaign_id
          LEFT JOIN campaign_rewards crw ON crw.id = lt.prize_reward_id
          WHERE lt.id = ? AND lt.customer_id = ?`,
    args: [ticketId, customerId],
  })
  const ticket = ticketResult.rows[0] as Record<string, unknown> | undefined
  if (!ticket) throw new Error('TICKET_NOT_FOUND')
  if (ticket.status !== 'won') throw new Error('TICKET_NOT_WON')
  if (!ticket.prize_id) throw new Error('PRIZE_MISSING')

  const existing = await db.execute({
    sql: `SELECT id FROM customer_rewards WHERE play_id = ? AND customer_id = ?`,
    args: [ticketId, customerId],
  })
  if (existing.rows.length > 0) {
    return {
      walletRewardId: existing.rows[0]!.id as string,
      alreadyClaimed: true,
    }
  }

  const config = parseLotteryConfig((ticket.config_json as string) ?? null)
  const redeemExpiresAt = computeRedeemExpiryDate(
    ((ticket.redeem_expiry_mode as string) ?? config?.redeemExpiryMode ?? 'relative') as 'fixed' | 'relative',
    (ticket.redeem_fixed_date as string) ?? config?.redeemFixedDate ?? null,
    (ticket.redeem_relative_amount as number) ?? config?.redeemRelativeAmount ?? 7,
    ((ticket.redeem_relative_unit as string) ?? config?.redeemRelativeUnit ?? 'day') as 'day' | 'week' | 'month',
  )

  const rewardId = nanoid()
  const redemptionCode = generateRedemptionCode()
  const prizeName = (ticket.prize_reward_name as string) || 'Lottery Prize'
  const prizeIcon = (ticket.prize_icon as string) ?? '🎁'

  await db.execute({
    sql: `INSERT INTO customer_rewards
          (id, customer_id, campaign_id, play_id, reward_name, icon, redemption_code, status, earned_at, business_id, source_type, redeem_expires_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, 'earned', datetime('now'), ?, 'campaign_win', ?)`,
    args: [
      rewardId,
      customerId,
      ticket.campaign_id as string,
      ticketId,
      prizeName,
      prizeIcon,
      redemptionCode,
      ticket.business_id as string,
      redeemExpiresAt,
    ],
  })

  invalidateBusinessAnalyticsCaches(ticket.business_id as string)

  return {
    walletRewardId: rewardId,
    alreadyClaimed: false,
    rewardName: prizeName,
    icon: prizeIcon,
    redemptionCode,
    redeemExpiresAt,
  }
}

export async function viewLotteryResult(customerId: string, rewardId: string) {
  const result = await db.execute({
    sql: `SELECT cr.*, lt.status AS ticket_status
          FROM customer_rewards cr
          LEFT JOIN lottery_tickets lt ON lt.id = cr.play_id
          WHERE cr.id = ? AND cr.customer_id = ?`,
    args: [rewardId, customerId],
  })
  const row = result.rows[0] as Record<string, unknown> | undefined
  if (!row) throw new Error('REWARD_NOT_FOUND')
  if (row.source_type !== 'lottery_ticket') throw new Error('NOT_LOTTERY_REWARD')
  if (row.status !== 'lottery_lost') throw new Error('INVALID_STATUS')

  await db.batch([
    {
      sql: `UPDATE customer_rewards SET status = 'lottery_archived' WHERE id = ?`,
      args: [rewardId],
    },
    {
      sql: `UPDATE lottery_tickets SET result_viewed_at = datetime('now'), status = 'loss_viewed'
            WHERE id = ?`,
      args: [row.play_id as string],
    },
  ])

  return { archived: true }
}

export async function executeLotteryDraw(campaignId: string): Promise<boolean> {
  const row = await getCampaignRow(campaignId)
  const config = parseLotteryConfig((row.config_json as string) ?? null)
  if (!config || config.drawCompleted) return false

  const endTime = (row.end_time as string) ?? '23:59'
  if (!isLotteryDrawDue(row.end_date as string, endTime, false)) return false

  const prizesResult = await db.execute({
    sql: `SELECT * FROM campaign_rewards WHERE campaign_id = ? ORDER BY sort_order ASC`,
    args: [campaignId],
  })
  const prizes = prizesResult.rows as Record<string, unknown>[]

  const ticketsResult = await db.execute({
    sql: `SELECT * FROM lottery_tickets WHERE campaign_id = ? AND status = 'pending_draw'`,
    args: [campaignId],
  })
  const tickets = [...ticketsResult.rows] as Record<string, unknown>[]

  const winners = selectLotteryWinners(tickets, prizes)
  const usedTicketIds = new Set(winners.map(w => w.ticket.id as string))
  const winningCustomerIds = new Set(winners.map(w => w.ticket.customer_id as string))

  const statements: { sql: string; args: unknown[] }[] = []
  const campaignName = row.name as string
  const statusUrl = `/customer/campaigns/${campaignId}/lottery-status`

  for (const { ticket, prize } of winners) {
    const prizeName = (prize.name as string)
    statements.push({
      sql: `UPDATE lottery_tickets SET status = 'won', prize_reward_id = ? WHERE id = ?`,
      args: [prize.id as string, ticket.id as string],
    })
    statements.push({
      sql: `INSERT INTO customer_notifications (id, customer_id, campaign_id, type, title, body, action_url, created_at)
            VALUES (?, ?, ?, 'lottery_win', ?, ?, ?, datetime('now'))`,
      args: [
        nanoid(),
        ticket.customer_id as string,
        campaignId,
        `🎉 You won ${campaignName}!`,
        `Your ticket #${String(ticket.ticket_number as number).padStart(4, '0')} won ${prizeName}. Open Check Status to claim it to your wallet.`,
        statusUrl,
      ],
    })
  }

  // Losing tickets stay out of the wallet — only ticket status + notification.
  const notifiedLosers = new Set<string>()
  for (const ticket of tickets) {
    if (usedTicketIds.has(ticket.id as string)) continue
    statements.push({
      sql: `UPDATE lottery_tickets SET status = 'lost' WHERE id = ?`,
      args: [ticket.id as string],
    })
    const customerId = ticket.customer_id as string
    // Skip loss notification if they already won with another ticket
    if (winningCustomerIds.has(customerId) || notifiedLosers.has(customerId)) continue
    notifiedLosers.add(customerId)
    statements.push({
      sql: `INSERT INTO customer_notifications (id, customer_id, campaign_id, type, title, body, action_url, created_at)
            VALUES (?, ?, ?, 'lottery_result', ?, ?, ?, datetime('now'))`,
      args: [
        nanoid(),
        customerId,
        campaignId,
        `${campaignName} results are in`,
        `Draw complete for ${campaignName}. Open Check Status to see your tickets.`,
        statusUrl,
      ],
    })
  }

  const updatedConfig: LotteryConfig = {
    ...config,
    drawCompleted: true,
    drawCompletedAt: nowInCampaignTz().toISOString(),
  }

  statements.push({
    sql: `UPDATE campaigns SET status = 'ended', config_json = ? WHERE id = ?`,
    args: [serializeLotteryConfig(updatedConfig), campaignId],
  })

  if (statements.length > 0) {
    await db.batch(statements)
  }

  return true
}

export async function runDueLotteryDraws(): Promise<number> {
  const today = todayInCampaignTz()
  const result = await db.execute({
    sql: `SELECT id, end_date, end_time, config_json FROM campaigns
          WHERE mechanic = 'lottery' AND status = 'active' AND end_date <= ?`,
    args: [today],
  })

  let count = 0
  for (const row of result.rows) {
    const config = parseLotteryConfig((row.config_json as string) ?? null)
    if (!config || config.drawCompleted) continue
    const due = isLotteryDrawDue(
      row.end_date as string,
      (row.end_time as string) ?? '23:59',
      false,
    )
    if (!due) continue
    try {
      const drew = await executeLotteryDraw(row.id as string)
      if (drew) count++
    } catch (err) {
      console.error(`[lottery-draw] failed for campaign ${row.id}:`, err)
    }
  }
  return count
}

export const LOTTERY_UNLIMITED_USER_CAP = UNLIMITED_USER_CAP
