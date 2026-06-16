/**
 * Stamp Card — Frontend API flow test
 *
 * Mirrors the customer UI path:
 *   PIN page → stamp page (?collect=1) → executeStamp
 *
 * Verifies unenrolled users see canCollectToday=true (not "come back tomorrow").
 *
 * Usage: npm run test:stamp:frontend
 */

import { migrate } from '../src/db/migrate.js'
import { nanoid } from 'nanoid'
import { hashPassword } from '../src/services/auth.js'
import { setCampaignDateOverride, addCampaignDays } from '../src/utils/campaign-dates.js'
import {
  createCampaign,
  getCampaignPinForBusiness,
  verifyCampaignPin,
} from '../src/services/campaigns.js'
import { executeStampCollect, getStampState } from '../src/services/stamp-cards.js'
import { db } from '../src/db/client.js'

const RUN_ID = Date.now().toString(36)
const PREFILL = 2

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
    args: [userId, `vendor-fe-${RUN_ID}@test.local`, await hashPassword('TestPass123!')],
  })
  const businessId = nanoid()
  await db.execute({
    sql: `INSERT INTO businesses (id, user_id, name, qr_slug, business_type, city) VALUES (?, ?, ?, ?, 'Cafe', 'Mumbai')`,
    args: [businessId, userId, `FE Cafe ${RUN_ID}`, `fe-stamp-${RUN_ID}`],
  })
  return { userId, businessId }
}

async function createCustomer() {
  const id = nanoid()
  await db.execute({
    sql: `INSERT INTO customer_users (id, name, phone, email, password_hash) VALUES (?, ?, ?, ?, ?)`,
    args: [id, 'FE User', '9199999999', `fe-cust-${RUN_ID}@test.local`, await hashPassword('TestPass123!')],
  })
  return id
}

async function main() {
  console.log(`\n═══ Stamp Card Frontend Flow (${RUN_ID}) ═══\n`)

  await migrate()

  const start = '2026-09-01'
  setCampaignDateOverride(start)

  const vendor = await createVendor()
  const customerId = await createCustomer()

  const campaign = await createCampaign(vendor.userId, {
    name: `FE Stamp ${RUN_ID}`,
    mechanic: 'stamp',
    startDate: start,
    endDate: addCampaignDays(start, 9),
    userCap: 10,
    claimPeriodDays: 30,
    stampConfig: {
      totalStamps: 10,
      prefillStamps: PREFILL,
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

  // Step 1: Customer opens stamp page before PIN — not enrolled
  const beforePin = await getStampState(campaign.id, customerId)
  assert(
    'Before PIN: not enrolled',
    !beforePin.enrolled && beforePin.prefillStamps === PREFILL,
    `enrolled=${beforePin.enrolled}, prefill=${beforePin.prefillStamps}`,
  )
  assert(
    'Before PIN: canCollectToday (frontend button enabled)',
    beforePin.canCollectToday === true,
    `canCollectToday=${beforePin.canCollectToday}`,
  )

  // Step 2: Customer enters PIN on campaign page (no stamp yet)
  const pinData = await getCampaignPinForBusiness(vendor.userId, campaign.id)
  const verify = await verifyCampaignPin(campaign.id, pinData.pin!, customerId)

  const afterPin = await getStampState(campaign.id, customerId)
  assert(
    'After PIN verify: still not enrolled until collect',
    !afterPin.enrolled,
    `enrolled=${afterPin.enrolled}`,
  )
  assert(
    'After PIN verify: canCollectToday for auto-collect',
    afterPin.canCollectToday === true,
    `canCollectToday=${afterPin.canCollectToday}`,
  )

  // Step 3: Stamp page auto-collect / manual collect (first visit)
  const result = await executeStampCollect(campaign.id, customerId, verify.playSessionToken)
  const expectedFirst = PREFILL + 1
  assert(
    'First collect enrolls + visit stamp',
    result.enrolled === true && result.stampsCollected === expectedFirst,
    `enrolled=${result.enrolled}, stamps=${result.stampsCollected} (expected ${expectedFirst})`,
  )

  const afterCollect = await getStampState(campaign.id, customerId)
  assert(
    'After first collect: stamped today',
    afterCollect.enrolled && afterCollect.stampsCollected === expectedFirst && !afterCollect.canCollectToday,
    `stamps=${afterCollect.stampsCollected}, canCollectToday=${afterCollect.canCollectToday}`,
  )
  assert(
    'Trigger positions exposed for UI',
    afterCollect.surpriseTriggerAt !== null
      && afterCollect.bigTriggerAt !== null
      && afterCollect.surpriseTriggerAt >= 3
      && afterCollect.surpriseTriggerAt <= 5,
    `surprise@${afterCollect.surpriseTriggerAt}, big@${afterCollect.bigTriggerAt}`,
  )

  // Step 4: Same day second attempt blocked
  let blockedToday = false
  try {
    await executeStampCollect(campaign.id, customerId, verify.playSessionToken)
  } catch (e) {
    blockedToday = e instanceof Error && e.message === 'STAMP_ALREADY_COLLECTED_TODAY'
  }
  assert('Second collect same day blocked', blockedToday, 'STAMP_ALREADY_COLLECTED_TODAY')

  // Step 5: Next day can collect stamp #4 (prefill 2 + 2 visits)
  setCampaignDateOverride(addCampaignDays(start, 1))
  const nextDay = await getStampState(campaign.id, customerId)
  assert(
    'Next day: canCollectToday',
    nextDay.canCollectToday === true,
    `canCollectToday=${nextDay.canCollectToday}`,
  )

  const day2 = await executeStampCollect(campaign.id, customerId, verify.playSessionToken)
  assert(
    'Day 2 collect adds visit stamp',
    day2.stampsCollected === expectedFirst + 1,
    `${expectedFirst} → ${day2.stampsCollected}`,
  )

  const failed = results.filter(r => !r.passed).length
  console.log(`\n═══ Results: ${results.length - failed} passed, ${failed} failed ═══\n`)
  if (failed > 0) process.exit(1)
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
