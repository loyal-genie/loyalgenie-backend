/**
 * Stamp Card — Production E2E test (mocked dates)
 *
 * Scenario:
 *   - 10-day campaign duration
 *   - 30-day (1 month) claim period
 *   - User cap: 10
 *   - 10 total stamps, surprise 3–5, big 8–10
 *   - Days 1–10: 10 users visit once/day in random order
 *   - Verify rewards, triggers, PIN during claim window, expiry after claim
 *
 * Usage (from backend/):
 *   npm run test:stamp:e2e
 */

import { migrate } from '../src/db/migrate.js'
import { db } from '../src/db/client.js'
import { nanoid } from 'nanoid'
import { hashPassword } from '../src/services/auth.js'
import {
  setCampaignDateOverride,
  addCampaignDays,
} from '../src/utils/campaign-dates.js'
import {
  createCampaign,
  getCampaignById,
  getCampaignPinForBusiness,
  verifyCampaignPin,
  signPlaySession,
} from '../src/services/campaigns.js'
import {
  executeStampCollect,
  getStampState,
  getStampCampaignStats,
  getClaimDeadline,
  isPinActiveForStamp,
} from '../src/services/stamp-cards.js'

const RUN_ID = Date.now().toString(36)
const CAMPAIGN_DAYS = 10
const CLAIM_DAYS = 30
const USER_CAP = 10
const TOTAL_STAMPS = 10
const SURPRISE_RANGE: [number, number] = [3, 5]
const BIG_RANGE: [number, number] = [8, 10]

interface TestResult { name: string; passed: boolean; detail: string }
const results: TestResult[] = []

function assert(name: string, condition: boolean, detail: string) {
  results.push({ name, passed: condition, detail })
  console.log(`${condition ? '✓' : '✗'} ${name}\n    ${detail}`)
}

function shuffle<T>(arr: T[]): T[] {
  const a = [...arr]
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!]
  }
  return a
}

async function createVendor() {
  const userId = nanoid()
  await db.execute({
    sql: `INSERT INTO business_users (id, email, password_hash) VALUES (?, ?, ?)`,
    args: [userId, `vendor-e2e-${RUN_ID}@test.local`, await hashPassword('TestPass123!')],
  })
  const businessId = nanoid()
  await db.execute({
    sql: `INSERT INTO businesses (id, user_id, name, qr_slug, business_type, city) VALUES (?, ?, ?, ?, 'Cafe', 'Mumbai')`,
    args: [businessId, userId, `E2E Cafe ${RUN_ID}`, `e2e-stamp-${RUN_ID}`],
  })
  return { userId, businessId }
}

async function createCustomer(i: number) {
  const id = nanoid()
  await db.execute({
    sql: `INSERT INTO customer_users (id, name, phone, email, password_hash) VALUES (?, ?, ?, ?, ?)`,
    args: [id, `User ${i}`, String(9200000000 + i), `e2e-cust-${RUN_ID}-${i}@test.local`, await hashPassword('TestPass123!')],
  })
  return { id, label: `User${i}` }
}

interface CardRow {
  customer_id: string
  stamps_collected: number
  surprise_trigger_at: number
  big_trigger_at: number
  surprise_awarded: number
  big_awarded: number
  status: string
}

async function fetchCards(campaignId: string): Promise<CardRow[]> {
  const r = await db.execute({
    sql: `SELECT customer_id, stamps_collected, surprise_trigger_at, big_trigger_at,
                 surprise_awarded, big_awarded, status FROM stamp_cards WHERE campaign_id = ?`,
    args: [campaignId],
  })
  return r.rows as unknown as CardRow[]
}

async function collectStamp(campaignId: string, customerId: string, pin: string) {
  const verify = await verifyCampaignPin(campaignId, pin, customerId)
  return executeStampCollect(campaignId, customerId, verify.playSessionToken)
}

async function refreshPin(vendorUserId: string, campaignId: string) {
  const pinData = await getCampaignPinForBusiness(vendorUserId, campaignId)
  if (!pinData.pin) throw new Error('PIN not active')
  return pinData.pin
}

async function main() {
  console.log(`\n═══ Stamp Card PROD E2E (${RUN_ID}) ═══`)
  console.log(`Config: ${CAMPAIGN_DAYS}d campaign · ${CLAIM_DAYS}d claim · cap ${USER_CAP} · ${TOTAL_STAMPS} stamps\n`)

  await migrate()

  const campaignStart = '2026-08-01'
  const campaignEnd = addCampaignDays(campaignStart, CAMPAIGN_DAYS - 1)

  setCampaignDateOverride(campaignStart)

  const vendor = await createVendor()
  const campaign = await createCampaign(vendor.userId, {
    name: `Prod E2E Stamp ${RUN_ID}`,
    mechanic: 'stamp',
    startDate: campaignStart,
    endDate: campaignEnd,
    userCap: USER_CAP,
    claimPeriodDays: CLAIM_DAYS,
    stampConfig: {
      totalStamps: TOTAL_STAMPS,
      prefillStamps: 0,
      surpriseRange: SURPRISE_RANGE,
      bigRange: BIG_RANGE,
      surpriseMode: 'single',
      bigMode: 'single',
    },
    rewards: {
      surprise: [{ name: 'Mystery Treat', icon: '🎁', winPercent: 100 }],
      big: [{ name: 'Free Breakfast Combo', icon: '🏆', winPercent: 100 }],
    },
  })

  assert('Campaign created', campaign.mechanic === 'stamp', `id=${campaign.id}`)

  const customers = await Promise.all(
    Array.from({ length: USER_CAP }, (_, i) => createCustomer(i + 1)),
  )

  let pin = await refreshPin(vendor.userId, campaign.id)
  assert('PIN active on day 1', /^\d{3}$/.test(pin), `pin=${pin}`)

  const preEnroll = await getStampState(campaign.id, customers[0]!.id)
  assert(
    'Unenrolled user canCollectToday (frontend flow)',
    !preEnroll.enrolled && preEnroll.canCollectToday,
    `enrolled=${preEnroll.enrolled}, canCollectToday=${preEnroll.canCollectToday}`,
  )

  // ── Days 1–10: each user visits once per day in random order ──
  for (let dayOffset = 0; dayOffset < CAMPAIGN_DAYS; dayOffset++) {
    const simDate = addCampaignDays(campaignStart, dayOffset)
    setCampaignDateOverride(simDate)
    pin = await refreshPin(vendor.userId, campaign.id)

    const order = shuffle(customers)
    console.log(`\n── Day ${dayOffset + 1} (${simDate}) — visit order: ${order.map(c => c.label).join(', ')}`)

    for (const c of order) {
      const stateBefore = await getStampState(campaign.id, c.id)
      const stampsBefore = stateBefore.stampsCollected

      const result = await collectStamp(campaign.id, c.id, pin)
      assert(
        `Day ${dayOffset + 1} ${c.label} stamp`,
        result.stampsCollected === Math.min(stampsBefore + 1, TOTAL_STAMPS),
        `${stampsBefore} → ${result.stampsCollected}`,
      )
    }
  }

  // ── Verify all cards complete with correct triggers ──
  const cards = await fetchCards(campaign.id)
  assert('All 10 enrolled', cards.length === USER_CAP, `count=${cards.length}`)

  let triggerErrors = 0
  for (const card of cards) {
    if (card.surprise_trigger_at < SURPRISE_RANGE[0] || card.surprise_trigger_at > SURPRISE_RANGE[1]) triggerErrors++
    if (card.big_trigger_at < BIG_RANGE[0] || card.big_trigger_at > BIG_RANGE[1]) triggerErrors++
    if (card.stamps_collected !== TOTAL_STAMPS) triggerErrors++
    if (!card.surprise_awarded || !card.big_awarded) triggerErrors++
    if (card.status !== 'completed') triggerErrors++
  }
  assert('Per-user triggers in range + completed', triggerErrors === 0,
    `all triggers in ${SURPRISE_RANGE.join('-')}/${BIG_RANGE.join('-')}, all completed`)

  const rewards = await db.execute({
    sql: `SELECT COUNT(*) as c FROM customer_rewards WHERE campaign_id = ?`,
    args: [campaign.id],
  })
  const rewardCount = Number(rewards.rows[0]?.c ?? 0)
  assert('20 rewards issued (10 surprise + 10 big)', rewardCount === USER_CAP * 2,
    `expected ${USER_CAP * 2}, got ${rewardCount}`)

  // Verify reward timing: surprise at trigger stamp, big at trigger stamp
  let timingErrors = 0
  for (const c of customers) {
    const card = cards.find(x => x.customer_id === c.id)!
    const surprisePlays = await db.execute({
      sql: `SELECT COUNT(*) as c FROM game_plays WHERE campaign_id = ? AND customer_id = ? AND won = 1 AND reward_name = 'Mystery Treat'`,
      args: [campaign.id, c.id],
    })
    const bigPlays = await db.execute({
      sql: `SELECT COUNT(*) as c FROM game_plays WHERE campaign_id = ? AND customer_id = ? AND won = 1 AND reward_name = 'Free Breakfast Combo'`,
      args: [campaign.id, c.id],
    })
    if (Number(surprisePlays.rows[0]?.c) !== 1 || Number(bigPlays.rows[0]?.c) !== 1) timingErrors++
  }
  assert('Each user has exactly 1 surprise + 1 big reward', timingErrors === 0, 'reward rows correct')

  const stats = await getStampCampaignStats(campaign.id)
  assert('Analytics: 100% completion', stats?.completionRate === 100,
    `${stats?.completed}/${stats?.enrolled} complete`)
  assert('Analytics: 10 surprise awards', stats?.surpriseAwards === USER_CAP, `got ${stats?.surpriseAwards}`)
  assert('Analytics: 10 big awards', stats?.bigAwards === USER_CAP, `got ${stats?.bigAwards}`)

  // ── Day 11: after campaign end, cap filled — PIN still active (claim window) ──
  const dayAfterCampaign = addCampaignDays(campaignEnd, 1)
  setCampaignDateOverride(dayAfterCampaign)

  const cAfter = await getCampaignById(campaign.id)
  assert('Cap filled', cAfter.capFilledAt !== null, `filled at ${cAfter.capFilledAt}`)

  const claimDeadlineWithCap = getClaimDeadline(campaignEnd, CLAIM_DAYS, cAfter.capFilledAt)
  assert('Claim deadline from cap fill', claimDeadlineWithCap === addCampaignDays(campaignStart, CLAIM_DAYS),
    `cap fill day 1 + ${CLAIM_DAYS}d = ${claimDeadlineWithCap}`)

  const pinDay11 = await getCampaignPinForBusiness(vendor.userId, campaign.id)
  assert('PIN active on day 11 (claim window)', pinDay11.pinActive === true && Boolean(pinDay11.pin),
    `pin=${pinDay11.pin}, active=${pinDay11.pinActive}`)

  const statsDay11 = await getStampCampaignStats(campaign.id)
  assert('Enrollment closed day 11', statsDay11?.enrollmentOpen === false, 'no new enrollments')
  assert('Claim window open day 11', statsDay11?.pinActive === true, `deadline ${statsDay11?.claimDeadline}`)

  // 11th user still blocked
  const extra = await createCustomer(99)
  let blocked = false
  try {
    await collectStamp(campaign.id, extra.id, pinDay11.pin!)
  } catch (e) {
    blocked = e instanceof Error && e.message === 'USER_CAP_REACHED'
  }
  assert('11th user blocked during claim window', blocked, 'USER_CAP_REACHED')

  // ── Day 20: mid-claim window, PIN still active ──
  const day20 = addCampaignDays(campaignEnd, 10)
  setCampaignDateOverride(day20)
  const pinDay20 = await getCampaignPinForBusiness(vendor.userId, campaign.id)
  assert('PIN active day 20 (within 30d claim)', pinDay20.pinActive === true,
    `pin=${pinDay20.pin}`)

  // ── After claim deadline: PIN inactive ──
  const afterClaim = addCampaignDays(claimDeadlineWithCap, 1)
  setCampaignDateOverride(afterClaim)

  const pinExpired = await getCampaignPinForBusiness(vendor.userId, campaign.id)
  assert('PIN inactive after claim period', pinExpired.pinActive === false,
    `active=${pinExpired.pinActive}`)

  assert('isPinActiveForStamp false after deadline',
    !isPinActiveForStamp('active', campaignStart, campaignEnd, CLAIM_DAYS, cAfter.capFilledAt, afterClaim),
    'campaign fully ended')

  // Incomplete card expiry simulation — create fresh campaign with 1 user, 1 stamp, jump past deadline
  setCampaignDateOverride(campaignStart)
  const shortCampaign = await createCampaign(vendor.userId, {
    name: `Expiry test ${RUN_ID}`,
    mechanic: 'stamp',
    startDate: campaignStart,
    endDate: addCampaignDays(campaignStart, 2),
    userCap: 1,
    claimPeriodDays: 3,
    stampConfig: {
      totalStamps: 10, prefillStamps: 0,
      surpriseRange: [3, 5], bigRange: [8, 10],
      surpriseMode: 'single', bigMode: 'single',
    },
    rewards: {
      surprise: [{ name: 'Treat', icon: '🎁', winPercent: 100 }],
      big: [{ name: 'Big', icon: '🏆', winPercent: 100 }],
    },
  })
  const lone = await createCustomer(50)
  const lonePin = await refreshPin(vendor.userId, shortCampaign.id)
  await collectStamp(shortCampaign.id, lone.id, lonePin)

  const shortEnd = addCampaignDays(campaignStart, 2)
  const shortDeadline = getClaimDeadline(shortEnd, 3, null)
  setCampaignDateOverride(addCampaignDays(shortDeadline, 1))
  await getStampState(shortCampaign.id, lone.id)
  const loneCard = await db.execute({
    sql: `SELECT status FROM stamp_cards WHERE campaign_id = ? AND customer_id = ?`,
    args: [shortCampaign.id, lone.id],
  })
  assert('Incomplete card expires after claim period', loneCard.rows[0]?.status === 'expired',
    `status=${loneCard.rows[0]?.status}`)

  setCampaignDateOverride(null)

  const passed = results.filter(r => r.passed).length
  const failed = results.filter(r => !r.passed).length
  console.log(`\n═══ Results: ${passed} passed, ${failed} failed ═══\n`)

  if (failed > 0) process.exit(1)
}

main().catch(err => {
  console.error(err)
  setCampaignDateOverride(null)
  process.exit(1)
})
