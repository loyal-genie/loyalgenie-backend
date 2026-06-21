/**
 * Check-in Loyalty — E2E test
 *
 * Usage (from backend/):
 *   npm run test:loyalty:e2e
 */

import { migrate } from '../src/db/migrate.js'
import { db } from '../src/db/client.js'
import { nanoid } from 'nanoid'
import { hashPassword } from '../src/services/auth.js'
import { todayInCampaignTz } from '../src/utils/campaign-dates.js'
import {
  createCampaign,
  getCampaignPinForBusiness,
  verifyCampaignPin,
} from '../src/services/campaigns.js'
import {
  executeCheckIn,
  getLoyaltyState,
  getPendingCheckInPrompt,
  listCustomerLoyaltyProfiles,
} from '../src/services/check-in-loyalty.js'

const RUN_ID = Date.now().toString(36)
const today = todayInCampaignTz()

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
    args: [userId, `vendor-loyalty-${RUN_ID}@test.local`, await hashPassword('TestPass123!')],
  })
  const businessId = nanoid()
  await db.execute({
    sql: `INSERT INTO businesses (id, user_id, name, qr_slug, business_type, city) VALUES (?, ?, ?, ?, 'Cafe', 'Mumbai')`,
    args: [businessId, userId, `Loyalty Cafe ${RUN_ID}`, `e2e-loyalty-${RUN_ID}`],
  })
  return { userId, businessId }
}

async function createCustomer() {
  const id = nanoid()
  await db.execute({
    sql: `INSERT INTO customer_users (id, name, phone, email, password_hash) VALUES (?, ?, ?, ?, ?)`,
    args: [id, 'Loyalty User', '9199999999', `loyalty-cust-${RUN_ID}@test.local`, await hashPassword('TestPass123!')],
  })
  return id
}

async function main() {
  console.log(`\n═══ Check-in Loyalty E2E (${RUN_ID}) ═══\n`)

  await migrate()
  const { userId: vendorId } = await createVendor()
  const customerId = await createCustomer()

  const campaign = await createCampaign(vendorId, {
    name: `Loyalty Campaign ${RUN_ID}`,
    mechanic: 'check-in-loyalty',
    startDate: today,
    endDate: today,
    userCap: 100,
    checkInConfig: { pointsPerCheckIn: 10 },
    milestones: [
      { name: 'Free Coffee', icon: '☕', pointsThreshold: 10 },
      { name: 'Free Meal', icon: '🍽️', pointsThreshold: 20 },
    ],
  })

  assert('Campaign created', campaign.mechanic === 'check-in-loyalty', `id=${campaign.id}`)

  const pinData = await getCampaignPinForBusiness(vendorId, campaign.id)
  assert('Staff PIN active', Boolean(pinData.pin), `PIN=${pinData.pin}, cycle=${pinData.cycleSeconds}s`)
  assert('PIN cycle is 120s', pinData.cycleSeconds === 120, `cycleSeconds=${pinData.cycleSeconds}`)

  const promptBefore = await getPendingCheckInPrompt(customerId)
  assert('Pending check-in before login flow', promptBefore.hasPendingCheckIn === true, `campaign=${promptBefore.campaignId}`)

  const verify = await verifyCampaignPin(campaign.id, pinData.pin!, customerId)
  const checkIn1 = await executeCheckIn(campaign.id, customerId, verify.playSessionToken)

  assert('First check-in earns points', checkIn1.pointsEarned === 10 && checkIn1.loyaltyPoints === 10, `points=${checkIn1.loyaltyPoints}`)
  assert('Coffee milestone unlocked', checkIn1.milestonesUnlocked.some(m => m.name === 'Free Coffee'), `unlocked=${checkIn1.milestonesUnlocked.map(m => m.name).join(', ')}`)

  const state = await getLoyaltyState(campaign.id, customerId)
  assert('Cannot check in again today', state.canCheckInToday === false && state.checkedInToday === true, `canCheckIn=${state.canCheckInToday}`)

  const promptAfter = await getPendingCheckInPrompt(customerId)
  assert('No pending check-in after today', promptAfter.hasPendingCheckIn === false, 'already checked in')

  const rewards = await db.execute({
    sql: `SELECT * FROM customer_rewards WHERE customer_id = ? AND campaign_id = ?`,
    args: [customerId, campaign.id],
  })
  assert('Reward in wallet', rewards.rows.length === 1, `count=${rewards.rows.length}`)

  const profiles = await listCustomerLoyaltyProfiles(customerId)
  assert('Loyalty profile shows points', profiles.length === 1 && profiles[0]!.loyaltyPoints === 10, `pts=${profiles[0]?.loyaltyPoints}`)

  await db.execute({
    sql: `UPDATE loyalty_cards SET last_check_in_date = '2000-01-01' WHERE campaign_id = ? AND customer_id = ?`,
    args: [campaign.id, customerId],
  })
  const pinSecond = await getCampaignPinForBusiness(vendorId, campaign.id)
  const verifySecond = await verifyCampaignPin(campaign.id, pinSecond.pin!, customerId)
  const checkIn2 = await executeCheckIn(campaign.id, customerId, verifySecond.playSessionToken)
  assert(
    'Second check-in adds points (no string concat)',
    checkIn2.pointsEarned === 10 && checkIn2.loyaltyPoints === 20,
    `earned=${checkIn2.pointsEarned} total=${checkIn2.loyaltyPoints}`,
  )

  try {
    const pin2 = await getCampaignPinForBusiness(vendorId, campaign.id)
    const v2 = await verifyCampaignPin(campaign.id, pin2.pin!, customerId)
    await executeCheckIn(campaign.id, customerId, v2.playSessionToken)
    assert('Duplicate check-in blocked', false, 'should have thrown')
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    assert('Duplicate check-in blocked', msg === 'ALREADY_CHECKED_IN_TODAY', msg)
  }

  const failed = results.filter(r => !r.passed)
  console.log(`\n═══ ${results.length - failed.length}/${results.length} passed ═══\n`)
  if (failed.length > 0) {
    failed.forEach(f => console.error(`FAIL: ${f.name} — ${f.detail}`))
    process.exit(1)
  }
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
