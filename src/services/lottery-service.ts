import { nanoid } from 'nanoid'
import { db } from '../db/client.js'
import { todayInCampaignTz, nowInCampaignTz } from '../utils/campaign-dates.js'
import { verifyPlaySession } from './campaigns.js'
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
  const now = nowInCampaignTz()
  const today = todayInCampaignTz()
  if (today < startDate || today > endDate) return false
  if (today === startDate || today === endDate) {
    const [h, m] = (today === startDate ? startTime : endTime).split(':').map(Number)
    const nowH = now.getHours()
    const nowM = now.getMinutes()
    if (today === startDate) {
      if (nowH < h || (nowH === h && nowM < m)) return false
    }
    if (today === endDate) {
      if (nowH > h || (nowH === h && nowM > m)) return false
    }
  }
  return true
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
  const now = nowInCampaignTz()
  const [h, m] = endTime.split(':').map(Number)
  return now.getHours() > h || (now.getHours() === h && now.getMinutes() >= m)
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

async function getCustomerTicket(campaignId: string, customerId: string) {
  const result = await db.execute({
    sql: `SELECT * FROM lottery_tickets WHERE campaign_id = ? AND customer_id = ?`,
    args: [campaignId, customerId],
  })
  return result.rows[0] as Record<string, unknown> | undefined
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

  const ticket = await getCustomerTicket(campaignId, customerId)
  const ticketCountResult = await db.execute({
    sql: 'SELECT COUNT(*) AS c FROM lottery_tickets WHERE campaign_id = ?',
    args: [campaignId],
  })
  const totalTickets = Number(ticketCountResult.rows[0]?.c ?? 0)

  let walletReward: Record<string, unknown> | null = null
  if (ticket) {
    const rewardResult = await db.execute({
      sql: `SELECT * FROM customer_rewards WHERE play_id = ? AND customer_id = ?`,
      args: [ticket.id as string, customerId],
    })
    walletReward = (rewardResult.rows[0] as Record<string, unknown>) ?? null
  }

  return {
    campaignId,
    campaignName: row.name as string,
    businessName: row.business_name as string,
    drawDate: row.end_date as string,
    drawCompleted,
    drawCompletedAt: config.drawCompletedAt ?? null,
    active,
    canClaimTicket: active && !ticket,
    hasTicket: Boolean(ticket),
    ticket: ticket ? {
      id: ticket.id as string,
      ticketNumber: ticket.ticket_number as number,
      serialCode: ticket.serial_code as string,
      status: ticket.status as string,
      claimedAt: ticket.claimed_at as string,
    } : null,
    walletRewardStatus: (walletReward?.status as string) ?? null,
    walletRewardId: (walletReward?.id as string) ?? null,
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

  const existing = await getCustomerTicket(campaignId, customerId)
  if (existing) throw new Error('TICKET_ALREADY_CLAIMED')

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

  const rewardId = nanoid()
  const redemptionCode = generateRedemptionCode()
  const businessId = row.business_id as string

  await db.batch([
    {
      sql: `INSERT INTO lottery_tickets
            (id, campaign_id, customer_id, ticket_number, serial_code, status, claimed_at)
            VALUES (?, ?, ?, ?, ?, 'pending_draw', datetime('now'))`,
      args: [ticketId, campaignId, customerId, ticketNumber, serialCode],
    },
    {
      sql: `INSERT INTO customer_rewards
            (id, customer_id, campaign_id, play_id, reward_name, icon, redemption_code, status, earned_at, business_id, source_type)
            VALUES (?, ?, ?, ?, ?, '🎟️', ?, 'lottery_pending', datetime('now'), ?, 'lottery_ticket')`,
      args: [
        rewardId,
        customerId,
        campaignId,
        ticketId,
        `Ticket #${String(ticketNumber).padStart(4, '0')}`,
        redemptionCode,
        businessId,
      ],
    },
    {
      sql: `INSERT INTO campaign_participations
            (id, campaign_id, customer_id, plays_today, last_play_date, total_plays, first_played_at, last_played_at)
            VALUES (?, ?, ?, 1, ?, 1, datetime('now'), datetime('now'))
            ON CONFLICT(campaign_id, customer_id) DO UPDATE SET
              total_plays = campaign_participations.total_plays + 1,
              last_played_at = datetime('now')`,
      args: [nanoid(), campaignId, customerId, todayInCampaignTz()],
    },
  ])

  return {
    ticketId,
    ticketNumber,
    serialCode,
    drawDate: row.end_date as string,
    walletRewardId: rewardId,
    prizes: config.prizes.map(p => ({
      tier: p.tier,
      name: p.name,
      reward: p.reward,
      icon: p.icon ?? (p.tier === 'jackpot' ? '👑' : '🎁'),
    })),
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

async function createDrawNotification(
  customerId: string,
  campaignId: string,
  title: string,
  body: string,
) {
  await db.execute({
    sql: `INSERT INTO customer_notifications (id, customer_id, campaign_id, type, title, body, action_url, created_at)
          VALUES (?, ?, ?, 'lottery_draw', ?, ?, '/customer/wallet', datetime('now'))`,
    args: [nanoid(), customerId, campaignId, title, body],
  })
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

  const shuffled = [...tickets].sort(() => Math.random() - 0.5)
  const winners: { ticket: Record<string, unknown>; prize: Record<string, unknown> }[] = []
  const usedTicketIds = new Set<string>()

  for (const prize of prizes) {
    const available = shuffled.filter(t => !usedTicketIds.has(t.id as string))
    if (available.length === 0) break
    const winner = available[Math.floor(Math.random() * available.length)]!
    usedTicketIds.add(winner.id as string)
    winners.push({ ticket: winner, prize })
  }

  const statements: { sql: string; args: unknown[] }[] = []
  const businessId = row.business_id as string
  const campaignName = row.name as string

  for (const { ticket, prize } of winners) {
    const redeemExpiresAt = computeRedeemExpiryDate(
      ((prize.redeem_expiry_mode as string) ?? config.redeemExpiryMode) as 'fixed' | 'relative',
      (prize.redeem_fixed_date as string) ?? config.redeemFixedDate ?? null,
      (prize.redeem_relative_amount as number) ?? config.redeemRelativeAmount ?? 7,
      ((prize.redeem_relative_unit as string) ?? config.redeemRelativeUnit ?? 'day') as 'day' | 'week' | 'month',
    )
    const prizeName = (prize.name as string)
    const prizeIcon = (prize.icon as string) ?? '🎁'

    statements.push({
      sql: `UPDATE lottery_tickets SET status = 'won', prize_reward_id = ? WHERE id = ?`,
      args: [prize.id as string, ticket.id as string],
    })
    statements.push({
      sql: `UPDATE customer_rewards
            SET status = 'earned', reward_name = ?, icon = ?, source_type = 'campaign_win', redeem_expires_at = ?
            WHERE play_id = ?`,
      args: [prizeName, prizeIcon, redeemExpiresAt, ticket.id as string],
    })
    statements.push({
      sql: `INSERT INTO customer_notifications (id, customer_id, campaign_id, type, title, body, action_url, created_at)
            VALUES (?, ?, ?, 'lottery_win', ?, ?, '/customer/wallet', datetime('now'))`,
      args: [
        nanoid(),
        ticket.customer_id as string,
        campaignId,
        `🎉 You won ${campaignName}!`,
        `Your ticket #${String(ticket.ticket_number as number).padStart(4, '0')} won ${prizeName}. Claim your reward in your wallet.`,
      ],
    })
  }

  for (const ticket of tickets) {
    if (usedTicketIds.has(ticket.id as string)) continue
    statements.push({
      sql: `UPDATE lottery_tickets SET status = 'lost' WHERE id = ?`,
      args: [ticket.id as string],
    })
    statements.push({
      sql: `UPDATE customer_rewards SET status = 'lottery_lost', reward_name = ? WHERE play_id = ?`,
      args: [`Ticket #${String(ticket.ticket_number as number).padStart(4, '0')} — No win`, ticket.id as string],
    })
    statements.push({
      sql: `INSERT INTO customer_notifications (id, customer_id, campaign_id, type, title, body, action_url, created_at)
            VALUES (?, ?, ?, 'lottery_result', ?, ?, '/customer/wallet', datetime('now'))`,
      args: [
        nanoid(),
        ticket.customer_id as string,
        campaignId,
        `${campaignName} results are in`,
        `Draw complete for ${campaignName}. Check your wallet to see if your ticket won.`,
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
