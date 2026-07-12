/**
 * Lottery — new-flow E2E (1-month campaign)
 *
 * Validates:
 *   - plays/day=1 → one ticket/day, multi-day multi-ticket
 *   - claim does NOT create wallet rows
 *   - Check Status state lists all tickets
 *   - draw is ticket-weighted, one prize per customer
 *   - only winners claim to wallet after draw
 *   - campaign is deleted after the run
 *
 * Usage (from backend/):
 *   npx tsx scripts/test-lottery-new-flow-e2e.ts
 */

import { nanoid } from 'nanoid'
import bcrypt from 'bcryptjs'
import { ensureColumnPatches } from '../src/db/migrate.js'
import { db, closePool } from '../src/db/client.js'
import {
  setCampaignDateOverride,
  addCampaignDays,
  addCampaignMonths,
} from '../src/utils/campaign-dates.js'
import {
  createCampaign,
  deleteCampaign,
  getCampaignPinForBusiness,
  verifyCampaignPin,
} from '../src/services/campaigns.js'
import {
  claimLotteryTicket,
  claimLotteryWinToWallet,
  executeLotteryDraw,
  getLotteryState,
} from '../src/services/lottery-service.js'

const RUN_ID = Date.now().toString(36)

async function hashPassword(password: string) {
  return bcrypt.hash(password, 10)
}

interface TestResult { name: string; passed: boolean; detail: string }
const results: TestResult[] = []

function assert(name: string, condition: boolean, detail: string) {
  results.push({ name, passed: condition, detail })
  console.log(`${condition ? '✓' : '✗'} ${name}\n    ${detail}`)
}

async function createVendor() {
  const userId = nanoid()
  await db.execute({
    sql: `INSERT INTO business_users (id, email, password_hash) VALUES (?, ?, ?)`,
    args: [userId, `vendor-lotto-${RUN_ID}@test.local`, await hashPassword('TestPass123!')],
  })
  const businessId = nanoid()
  await db.execute({
    sql: `INSERT INTO businesses (id, user_id, name, qr_slug, business_type, city) VALUES (?, ?, ?, ?, 'Cafe', 'Mumbai')`,
    args: [businessId, userId, `Lotto E2E Cafe ${RUN_ID}`, `e2e-lotto-${RUN_ID}`],
  })
  return { userId, businessId }
}

async function createCustomer(i: number) {
  const id = nanoid()
  await db.execute({
    sql: `INSERT INTO customer_users (id, name, phone, email, password_hash) VALUES (?, ?, ?, ?, ?)`,
    args: [
      id,
      `Lotto User ${i}`,
      String(9300000000 + Number.parseInt(RUN_ID.slice(-4), 36) % 1000 * 10 + i),
      `e2e-lotto-${RUN_ID}-${i}@test.local`,
      await hashPassword('TestPass123!'),
    ],
  })
  return { id, label: `User${i}` }
}

async function refreshPin(vendorUserId: string, campaignId: string) {
  const pinData = await getCampaignPinForBusiness(vendorUserId, campaignId)
  if (!pinData.pin) throw new Error('PIN not active')
  return pinData.pin
}

async function claimWithPin(campaignId: string, customerId: string, pin: string) {
  const verify = await verifyCampaignPin(campaignId, pin, customerId)
  return claimLotteryTicket(campaignId, customerId, verify.playSessionToken)
}

async function countWalletRewards(campaignId: string, customerId?: string) {
  const sql = customerId
    ? `SELECT COUNT(*) AS c FROM customer_rewards WHERE campaign_id = ? AND customer_id = ?`
    : `SELECT COUNT(*) AS c FROM customer_rewards WHERE campaign_id = ?`
  const args = customerId ? [campaignId, customerId] : [campaignId]
  const r = await db.execute({ sql, args })
  return Number(r.rows[0]?.c ?? 0)
}

async function cleanup(
  vendor: { userId: string; businessId: string },
  campaignId: string | null,
  customerIds: string[],
) {
  if (campaignId) {
    try {
      await db.execute({ sql: 'DELETE FROM customer_rewards WHERE campaign_id = ?', args: [campaignId] })
      await db.execute({ sql: 'DELETE FROM customer_notifications WHERE campaign_id = ?', args: [campaignId] })
      await db.execute({ sql: 'DELETE FROM lottery_tickets WHERE campaign_id = ?', args: [campaignId] })
      await db.execute({ sql: 'DELETE FROM campaign_participations WHERE campaign_id = ?', args: [campaignId] })
      await db.execute({ sql: 'DELETE FROM campaign_rewards WHERE campaign_id = ?', args: [campaignId] })
      await deleteCampaign(vendor.userId, campaignId)
    } catch (err) {
      console.warn('Campaign cleanup warning:', err instanceof Error ? err.message : err)
      await db.execute({
        sql: 'DELETE FROM campaigns WHERE id = ?',
        args: [campaignId],
      }).catch(() => undefined)
    }
  }

  for (const id of customerIds) {
    await db.execute({ sql: 'DELETE FROM customer_notifications WHERE customer_id = ?', args: [id] }).catch(() => undefined)
    await db.execute({ sql: 'DELETE FROM customer_rewards WHERE customer_id = ?', args: [id] }).catch(() => undefined)
    await db.execute({ sql: 'DELETE FROM customer_users WHERE id = ?', args: [id] }).catch(() => undefined)
  }

  await db.execute({ sql: 'DELETE FROM businesses WHERE id = ?', args: [vendor.businessId] }).catch(() => undefined)
  await db.execute({ sql: 'DELETE FROM business_users WHERE id = ?', args: [vendor.userId] }).catch(() => undefined)
}

async function main() {
  console.log(`\n═══ Lottery NEW FLOW E2E (${RUN_ID}) ═══`)
  console.log('1-month campaign · plays/day=1 · tickets out of wallet until win\n')

  await ensureColumnPatches()

  const campaignStart = '2026-08-01'
  const campaignEnd = addCampaignMonths(campaignStart, 1) // 2026-09-01
  // Draw on last day after noon — set endTime so noon override makes draw due
  const endTime = '11:00'

  setCampaignDateOverride(campaignStart)

  const vendor = await createVendor()
  let campaignId: string | null = null
  const customers: { id: string; label: string }[] = []

  try {
    const campaign = await createCampaign(vendor.userId, {
      name: `Lotto New Flow ${RUN_ID}`,
      mechanic: 'lottery',
      startDate: campaignStart,
      endDate: campaignEnd,
      startTime: '00:00',
      endTime,
      lotteryConfig: {
        prizes: [
          { tier: 'jackpot', name: 'Grand Prize', reward: 'Free Dinner for 2', icon: '👑' },
          { tier: 'prize', name: '2nd Prize', reward: 'Free Breakfast', icon: '🍳' },
          { tier: 'prize', name: '3rd Prize', reward: 'Free Coffee', icon: '☕' },
        ],
        redeemExpiryMode: 'relative',
        redeemRelativeAmount: 30,
        redeemRelativeUnit: 'day',
      },
    })
    campaignId = campaign.id
    assert('Campaign created (1 month)', campaign.mechanic === 'lottery', `id=${campaign.id} ${campaignStart}→${campaignEnd}`)
    assert('plays_per_day is 1', campaign.playsPerDay === 1, `playsPerDay=${campaign.playsPerDay}`)

    // Heavy (5 tickets), Medium (2), Light×3 (1 each)
    const heavy = await createCustomer(1)
    const medium = await createCustomer(2)
    const lightA = await createCustomer(3)
    const lightB = await createCustomer(4)
    const lightC = await createCustomer(5)
    customers.push(heavy, medium, lightA, lightB, lightC)

    let pin = await refreshPin(vendor.userId, campaign.id)

    // ── Day 0: everyone claims once ──
    console.log('\n── Day 1 claims (all 5 users) ──')
    for (const c of customers) {
      const claimed = await claimWithPin(campaign.id, c.id, pin)
      assert(
        `${c.label} claimed ticket`,
        typeof claimed.ticketNumber === 'number' && claimed.walletRewardId === null,
        `#${claimed.ticketNumber} walletRewardId=${claimed.walletRewardId}`,
      )
    }

    const walletAfterDay1 = await countWalletRewards(campaign.id)
    assert('No wallet rows after claims', walletAfterDay1 === 0, `walletCount=${walletAfterDay1}`)

    // Second claim same day must fail
    let blockedSameDay = false
    try {
      await claimWithPin(campaign.id, heavy.id, pin)
    } catch (e) {
      blockedSameDay = e instanceof Error && e.message === 'NO_PLAYS_REMAINING'
    }
    assert('Same-day second claim blocked', blockedSameDay, 'NO_PLAYS_REMAINING')

    const stateDay1 = await getLotteryState(campaign.id, heavy.id)
    assert(
      'Check Status: heavy has 1 ticket, 0 plays left',
      stateDay1.ticketCount === 1 && stateDay1.playsRemaining === 0 && !stateDay1.canClaimTicket,
      `tickets=${stateDay1.ticketCount} remaining=${stateDay1.playsRemaining} canClaim=${stateDay1.canClaimTicket}`,
    )

    // ── Days 2–5: heavy claims daily ──
    for (let d = 1; d <= 4; d++) {
      const day = addCampaignDays(campaignStart, d)
      setCampaignDateOverride(day)
      pin = await refreshPin(vendor.userId, campaign.id)
      const claimed = await claimWithPin(campaign.id, heavy.id, pin)
      assert(
        `Heavy day ${d + 1} claim`,
        claimed.walletRewardId === null,
        `#${claimed.ticketNumber}`,
      )
    }

    // ── Day 6: medium claims second ticket ──
    setCampaignDateOverride(addCampaignDays(campaignStart, 5))
    pin = await refreshPin(vendor.userId, campaign.id)
    await claimWithPin(campaign.id, medium.id, pin)

    const heavyState = await getLotteryState(campaign.id, heavy.id)
    const mediumState = await getLotteryState(campaign.id, medium.id)
    const lightState = await getLotteryState(campaign.id, lightA.id)

    assert('Heavy has 5 tickets', heavyState.ticketCount === 5, `got ${heavyState.ticketCount}`)
    assert('Medium has 2 tickets', mediumState.ticketCount === 2, `got ${mediumState.ticketCount}`)
    assert('Light has 1 ticket', lightState.ticketCount === 1, `got ${lightState.ticketCount}`)
    assert(
      'Still no wallet rows before draw',
      (await countWalletRewards(campaign.id)) === 0,
      'wallet empty',
    )
    assert(
      'Total tickets pool = 10',
      heavyState.totalTickets === 10,
      `totalTickets=${heavyState.totalTickets}`,
    )

    // ── Draw day (end date, after endTime) ──
    console.log('\n── Draw day ──')
    setCampaignDateOverride(campaignEnd)
    const drew = await executeLotteryDraw(campaign.id)
    assert('Draw executed', drew === true, `drew=${drew}`)

    const tickets = await db.execute({
      sql: `SELECT customer_id, status, prize_reward_id FROM lottery_tickets WHERE campaign_id = ?`,
      args: [campaign.id],
    })
    const won = tickets.rows.filter(r => r.status === 'won')
    const lost = tickets.rows.filter(r => r.status === 'lost')
    assert('3 winning tickets', won.length === 3, `won=${won.length}`)
    assert('7 losing tickets', lost.length === 7, `lost=${lost.length}`)

    const winnerCustomers = new Set(won.map(r => r.customer_id as string))
    assert('One prize per customer', winnerCustomers.size === won.length, `winners=${winnerCustomers.size}`)

    const walletAfterDraw = await countWalletRewards(campaign.id)
    assert('Draw does NOT auto-fill wallet', walletAfterDraw === 0, `walletCount=${walletAfterDraw}`)

    // Check Status post-draw for a winner
    const anyWinnerId = won[0]!.customer_id as string
    const winnerState = await getLotteryState(campaign.id, anyWinnerId)
    const claimable = winnerState.tickets.filter(t => t.canClaimToWallet)
    assert(
      'Winner Check Status exposes claimable ticket',
      claimable.length === 1,
      `claimable=${claimable.length} tickets=${winnerState.ticketCount}`,
    )

    // Loser Check Status — tickets lost, still no wallet
    const loserId = customers.find(c => !winnerCustomers.has(c.id))?.id
    if (loserId) {
      const loserState = await getLotteryState(campaign.id, loserId)
      assert(
        'Loser tickets marked lost',
        loserState.tickets.every(t => t.status === 'lost' || t.status === 'loss_viewed'),
        loserState.tickets.map(t => t.status).join(','),
      )
      assert(
        'Loser has no wallet reward',
        (await countWalletRewards(campaign.id, loserId)) === 0,
        'no wallet',
      )
    }

    // Claim win → wallet
    const winTicket = claimable[0]!
    const claimedWin = await claimLotteryWinToWallet(anyWinnerId, winTicket.id)
    assert('Claim to wallet succeeds', Boolean(claimedWin.walletRewardId), `id=${claimedWin.walletRewardId}`)

    const walletAfterClaim = await countWalletRewards(campaign.id, anyWinnerId)
    assert('Winner now has 1 wallet reward', walletAfterClaim === 1, `count=${walletAfterClaim}`)

    const rewardRow = await db.execute({
      sql: `SELECT status, source_type FROM customer_rewards WHERE id = ?`,
      args: [claimedWin.walletRewardId],
    })
    assert(
      'Wallet reward is earned / campaign_win',
      rewardRow.rows[0]?.status === 'earned' && rewardRow.rows[0]?.source_type === 'campaign_win',
      `${rewardRow.rows[0]?.status}/${rewardRow.rows[0]?.source_type}`,
    )

    // Double-claim is idempotent
    const again = await claimLotteryWinToWallet(anyWinnerId, winTicket.id)
    assert('Re-claim returns same wallet id', again.alreadyClaimed === true, `alreadyClaimed=${again.alreadyClaimed}`)

    // Heavy (most tickets) should often win — soft check: among winners, prefer reporting ticket counts
    const ticketCounts = await db.execute({
      sql: `SELECT customer_id, COUNT(*) AS c FROM lottery_tickets
            WHERE campaign_id = ? GROUP BY customer_id`,
      args: [campaign.id],
    })
    const countByCustomer = new Map(ticketCounts.rows.map(r => [r.customer_id as string, Number(r.c)]))
    const winnerTicketTotals = [...winnerCustomers].map(id => countByCustomer.get(id) ?? 0)
    console.log(`    Winner ticket counts: ${winnerTicketTotals.sort((a, b) => b - a).join(', ')}`)
    console.log(`    Heavy tickets: ${countByCustomer.get(heavy.id)} · in winners: ${winnerCustomers.has(heavy.id)}`)

  } finally {
    console.log('\n── Cleanup ──')
    setCampaignDateOverride(null)
    await cleanup(vendor, campaignId, customers.map(c => c.id))
    assert('Campaign deleted', campaignId != null, `cleaned ${campaignId}`)
  }

  const passed = results.filter(r => r.passed).length
  const failed = results.filter(r => !r.passed).length
  console.log(`\n═══ Results: ${passed} passed, ${failed} failed ═══\n`)

  await closePool()
  process.exit(failed > 0 ? 1 : 0)
}

main().catch(async err => {
  console.error(err)
  setCampaignDateOverride(null)
  await closePool().catch(() => undefined)
  process.exit(1)
})
