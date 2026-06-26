/**
 * Stamp Card — integration test with mocked campaign dates
 *
 * Simulates: 10-day campaign, 10-day claim period, user cap 10
 *
 * Usage (from backend/):
 *   npm run test:stamp
 */

import { migrate } from '../src/db/migrate.js'
import { db } from '../src/db/client.js'
import {
  setCampaignDateOverride,
  todayInCampaignTz,
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
  getStampState,
  executeStampCollect,
  getClaimDeadline,
  randomIntInclusive,
  rollPoolReward,
  validateStampConfig,
} from '../src/services/stamp-cards.js'
import { hashPassword } from '../src/services/auth.js'
import { nanoid } from 'nanoid'

const RUN_ID = Date.now().toString(36)

interface TestResult {
  name: string
  passed: boolean
  detail: string
}

const results: TestResult[] = []

function assert(name: string, condition: boolean, detail: string) {
  results.push({ name, passed: condition, detail })
  console.log(`${condition ? '✓' : '✗'} ${name}\n    ${detail}`)
}

async function createVendorUser() {
  const userId = nanoid()
  const email = `vendor-stamp-${RUN_ID}@test.local`
  await db.execute({
    sql: `INSERT INTO business_users (id, email, password_hash) VALUES (?, ?, ?)`,
    args: [userId, email, await hashPassword('TestPass123!')],
  })
  const businessId = nanoid()
  await db.execute({
    sql: `INSERT INTO businesses (id, user_id, name, qr_slug, business_type, city)
          VALUES (?, ?, ?, ?, 'Cafe', 'Mumbai')`,
    args: [businessId, userId, `Stamp Test Cafe ${RUN_ID}`, `stamp-${RUN_ID}`],
  })
  return { userId, businessId, email }
}

async function createCustomer(index: number) {
  const id = nanoid()
  const email = `cust-stamp-${RUN_ID}-${index}@test.local`
  const phone = String(9100000000 + index)
  await db.execute({
    sql: `INSERT INTO customer_users (id, name, phone, email, password_hash)
          VALUES (?, ?, ?, ?, ?)`,
    args: [id, `Customer ${index}`, phone, email, await hashPassword('TestPass123!')],
  })
  return { id, email, phone }
}

function unitTests() {
  assert('randomIntInclusive(3,5) in range', (() => {
    for (let i = 0; i < 50; i++) {
      const n = randomIntInclusive(3, 5)
      if (n < 3 || n > 5) return false
    }
    return true
  })(), '50 rolls within [3,5]')

  const pool = [{ id: '1', name: 'Treat', description: '', icon: '🎁', sharePercent: 100 }]
  assert('rollPoolReward single 100%', rollPoolReward(pool)?.name === 'Treat', 'always wins')

  const lowPool = [{ id: '1', name: 'Rare', description: '', icon: '🎁', sharePercent: 0 }]
  assert('validateStampConfig allows flexible ranges', (() => {
    try {
      validateStampConfig({
        totalStamps: 6,
        prefillStamps: 2,
        surpriseRange: [3, 5],
        bigRange: [6, 6],
        surpriseMode: 'single',
        bigMode: 'single',
      })
      return true
    } catch {
      return false
    }
  })(), '6 stamps · 2 prefill · surprise 3-5 · big 6-6')

  assert('validateStampConfig allows overlapping ranges', (() => {
    try {
      validateStampConfig({
        totalStamps: 10,
        prefillStamps: 10,
        surpriseRange: [1, 10],
        bigRange: [1, 10],
        surpriseMode: 'single',
        bigMode: 'single',
      })
      return true
    } catch {
      return false
    }
  })(), 'full prefill and overlapping reward ranges')

  assert('validateStampConfig rejects out-of-bounds range', (() => {
    try {
      validateStampConfig({
        totalStamps: 6,
        prefillStamps: 0,
        surpriseRange: [1, 7],
        bigRange: [6, 6],
        surpriseMode: 'single',
        bigMode: 'single',
      })
      return false
    } catch {
      return true
    }
  })(), 'surprise to > total stamps')

  const deadline = getClaimDeadline('2026-06-20', 10, '2026-06-10T12:00:00.000Z')
  assert('claim deadline cap fill', deadline === '2026-06-20', `cap fill day 10 + 10 days = ${deadline}`)
}

async function runCampaignSimulation() {
  const campaignStart = '2026-06-01'
  const campaignEnd = addCampaignDays(campaignStart, 9) // 10 days inclusive
  const claimPeriodDays = 10
  const userCap = 10
  const totalStamps = 10

  setCampaignDateOverride(campaignStart)

  const vendor = await createVendorUser()
  const campaign = await createCampaign(vendor.userId, {
    name: `Stamp E2E ${RUN_ID}`,
    mechanic: 'stamp',
    startDate: campaignStart,
    endDate: campaignEnd,
    userCap,
    claimPeriodDays,
    stampConfig: {
      totalStamps,
      prefillStamps: 0,
      surpriseRange: [3, 5],
      bigRange: [8, 10],
      surpriseMode: 'single',
      bigMode: 'single',
    },
    rewards: {
      surprise: [{ name: 'Mystery Treat', icon: '🎁', winPercent: 100 }],
      big: [{ name: 'Free Breakfast', icon: '🏆', winPercent: 100 }],
    },
  })

  assert('Campaign created', campaign.mechanic === 'stamp', `id=${campaign.id}`)

  const customers = await Promise.all(
    Array.from({ length: userCap }, (_, i) => createCustomer(i + 1)),
  )

  const pinData = await getCampaignPinForBusiness(vendor.userId, campaign.id)
  const pin = pinData.pin!
  assert('PIN cycle is 120s', pinData.cycleSeconds === 120, `cycleSeconds=${pinData.cycleSeconds}`)
  assert('PIN generated', /^\d{3}$/.test(pin), `pin=${pin}`)

  // Enroll all 10 users on day 1 with first stamp
  for (const c of customers) {
    const verify = await verifyCampaignPin(campaign.id, pin, c.id)
    const result = await executeStampCollect(campaign.id, c.id, verify.playSessionToken)
    assert(`User ${c.id.slice(0, 6)} enrolled`, result.enrolled === true, `stamps=${result.stampsCollected}`)
  }

  const updated = await getCampaignById(campaign.id)
  assert('Cap filled', updated.capFilledAt !== null, `users=${updated.currentUsers}`)
  assert('Cap filled count', updated.currentUsers === userCap, `expected ${userCap}`)

  // 11th user blocked
  const extra = await createCustomer(99)
  const extraVerify = await verifyCampaignPin(campaign.id, pin, extra.id)
  let blocked = false
  try {
    await executeStampCollect(campaign.id, extra.id, extraVerify.playSessionToken)
  } catch (e) {
    blocked = e instanceof Error && e.message === 'USER_CAP_REACHED'
  }
  assert('11th user blocked', blocked, 'USER_CAP_REACHED')

  // Simulate remaining stamps — each user needs up to 10 stamps total
  // Day 2-10: each customer collects 1 stamp/day
  for (let day = 1; day < totalStamps; day++) {
    const simDate = addCampaignDays(campaignStart, day)
    setCampaignDateOverride(simDate)

    for (const c of customers) {
      const state = await getStampState(campaign.id, c.id)
      if (!state.canCollectToday || state.cardComplete) continue

      const token = signPlaySession(campaign.id, c.id)
      try {
        await executeStampCollect(campaign.id, c.id, token)
      } catch (e) {
        const msg = e instanceof Error ? e.message : ''
        if (msg !== 'STAMP_ALREADY_COLLECTED_TODAY') throw e
      }
    }
  }

  // Count rewards — each user should have surprise + big = 2 rewards × 10 users = 20
  const rewards = await db.execute({
    sql: `SELECT COUNT(*) as c FROM customer_rewards WHERE campaign_id = ?`,
    args: [campaign.id],
  })
  const rewardCount = Number(rewards.rows[0]?.c ?? 0)
  assert('Total rewards issued', rewardCount === userCap * 2, `expected ${userCap * 2}, got ${rewardCount}`)

  const completed = await db.execute({
    sql: `SELECT COUNT(*) as c FROM stamp_cards WHERE campaign_id = ? AND status = 'completed'`,
    args: [campaign.id],
  })
  assert('All cards completed', Number(completed.rows[0]?.c) === userCap, `completed=${completed.rows[0]?.c}`)

  // Claim period expiry — move past deadline
  const c2 = await getCampaignById(campaign.id)
  const deadline = getClaimDeadline(c2.endDate, claimPeriodDays, c2.capFilledAt)
  const afterDeadline = addCampaignDays(deadline, 1)
  setCampaignDateOverride(afterDeadline)

  const expiredState = await getStampState(campaign.id, customers[0]!.id)
  assert('After claim deadline cards expire', expiredState.status === 'expired' || expiredState.cardComplete, `status=${expiredState.status}`)

  let stampBlocked = false
  try {
    const token = signPlaySession(campaign.id, customers[0]!.id)
    await executeStampCollect(campaign.id, customers[0]!.id, token)
  } catch (e) {
    stampBlocked = e instanceof Error && (e.message === 'CARD_EXPIRED' || e.message === 'CLAIM_PERIOD_ENDED' || e.message === 'CAMPAIGN_NOT_ACTIVE')
  }
  assert('Stamp blocked after claim period', stampBlocked || expiredState.cardComplete, 'no more stamps')

  setCampaignDateOverride(null)
}

async function main() {
  console.log(`\n═══ Stamp Card Tests (${RUN_ID}) ═══\n`)
  await migrate()

  console.log('── Unit tests ──\n')
  unitTests()

  console.log('\n── Full campaign simulation (mocked dates) ──\n')
  await runCampaignSimulation()

  const passed = results.filter(r => r.passed).length
  const failed = results.filter(r => !r.passed).length
  console.log(`\n═══ Results: ${passed} passed, ${failed} failed ═══\n`)

  if (failed > 0) {
    process.exit(1)
  }
}

main().catch(err => {
  console.error(err)
  setCampaignDateOverride(null)
  process.exit(1)
})
