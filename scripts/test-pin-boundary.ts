/**
 * PIN boundary tests — last-second verify, post-rotation grace, concurrent rotation safety.
 * Run: npx tsx scripts/test-pin-boundary.ts
 */
import { migrate } from '../src/db/migrate.js'
import { db } from '../src/db/client.js'
import { nanoid } from 'nanoid'
import { hashPassword } from '../src/services/auth.js'
import {
  PIN_VERIFY_GRACE_SECONDS,
  createCampaign,
  getCampaignPinForBusiness,
  verifyCampaignPin,
  isPinValidForVerify,
  computePinSecondsRemaining,
} from '../src/services/campaigns.js'
import { todayInCampaignTz, addCampaignDays } from '../src/utils/campaign-dates.js'

const RUN_ID = Date.now().toString(36)

let passed = 0
let failed = 0

function assert(name: string, ok: boolean, detail = '') {
  if (ok) {
    passed++
    console.log(`✓ ${name}${detail ? ` — ${detail}` : ''}`)
  } else {
    failed++
    console.log(`✗ ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

async function createVendor() {
  const userId = nanoid()
  await db.execute({
    sql: `INSERT INTO business_users (id, email, password_hash) VALUES (?, ?, ?)`,
    args: [userId, `vendor-pin-${RUN_ID}@test.local`, await hashPassword('TestPass123!')],
  })
  const businessId = nanoid()
  await db.execute({
    sql: `INSERT INTO businesses (id, user_id, name, qr_slug, business_type, city) VALUES (?, ?, ?, ?, 'Cafe', 'Mumbai')`,
    args: [businessId, userId, `PIN Test Cafe ${RUN_ID}`, `pin-test-${RUN_ID}`],
  })
  return userId
}

async function createCustomer() {
  const id = nanoid()
  await db.execute({
    sql: `INSERT INTO customer_users (id, name, phone, email, password_hash) VALUES (?, ?, ?, ?, ?)`,
    args: [id, 'PIN User', '9198888777', `pin-cust-${RUN_ID}@test.local`, await hashPassword('TestPass123!')],
  })
  return id
}

async function main() {
  console.log('\n═══ PIN boundary tests ═══\n')

  await migrate()
  const vendorId = await createVendor()
  const customerId = await createCustomer()
  const today = todayInCampaignTz()
  const campaign = await createCampaign(vendorId, {
    mechanic: 'shake',
    name: `PIN Boundary ${Date.now()}`,
    startDate: today,
    endDate: addCampaignDays(today, 7),
    userCap: 100,
    perDayUserLimit: 50,
    playsPerDay: 3,
    winRatePercent: 30,
    rewards: [{ name: 'Prize', icon: '🎁', sharePercent: 100 }],
  })

  const pinMeta = await getCampaignPinForBusiness(vendorId, campaign.id)
  assert('Initial PIN returned', Boolean(pinMeta.pin), `pin=${pinMeta.pin}`)
  assert(
    'Grace matches cycle',
    pinMeta.verifyGraceSeconds === PIN_VERIFY_GRACE_SECONDS,
    `${pinMeta.verifyGraceSeconds}s`,
  )

  // ── Last second: expires in 1s, verify immediately ──
  const almostExpired = new Date(Date.now() + 500).toISOString()
  await db.execute({
    sql: 'UPDATE campaigns SET pin_expires_at = ? WHERE id = ?',
    args: [almostExpired, campaign.id],
  })
  const remaining = computePinSecondsRemaining(almostExpired)
  assert('Ceil shows 1s in last half-second', remaining === 1, `remaining=${remaining}`)

  const lastSecondPin = (await db.execute({
    sql: 'SELECT pin FROM campaigns WHERE id = ?',
    args: [campaign.id],
  })).rows[0]?.pin as string

  const v1 = await verifyCampaignPin(campaign.id, lastSecondPin, customerId)
  assert('Verify succeeds in last second', Boolean(v1.playSessionToken), 'ok')

  // ── Expired 1s ago, before vendor poll rotates ──
  const expired1s = new Date(Date.now() - 1000).toISOString()
  await db.execute({
    sql: 'UPDATE campaigns SET pin = ?, pin_expires_at = ?, previous_pin = NULL, previous_pin_valid_until = NULL WHERE id = ?',
    args: [lastSecondPin, expired1s, campaign.id],
  })

  const v2 = await verifyCampaignPin(campaign.id, lastSecondPin, customerId)
  assert('Verify succeeds 1s after expiry (grace on current pin)', Boolean(v2.playSessionToken), 'ok')

  // ── Vendor poll rotates; old PIN via previous_pin ──
  const beforeRotate = lastSecondPin
  const afterPoll = await getCampaignPinForBusiness(vendorId, campaign.id)
  assert('Vendor poll rotates PIN', afterPoll.pin !== beforeRotate, `${beforeRotate} → ${afterPoll.pin}`)

  const v3 = await verifyCampaignPin(campaign.id, beforeRotate, customerId)
  assert('Old PIN works after vendor rotation (previous_pin)', Boolean(v3.playSessionToken), 'ok')

  const v4 = await verifyCampaignPin(campaign.id, afterPoll.pin!, customerId)
  assert('New PIN works after rotation', Boolean(v4.playSessionToken), 'ok')

  // ── Beyond grace: reject ──
  const staleExpires = new Date(Date.now() - PIN_VERIFY_GRACE_SECONDS * 1000 - 5000).toISOString()
  await db.execute({
    sql: `UPDATE campaigns SET pin = ?, pin_expires_at = ?, previous_pin = NULL, previous_pin_valid_until = NULL WHERE id = ?`,
    args: ['999', staleExpires, campaign.id],
  })

  try {
    await verifyCampaignPin(campaign.id, '999', customerId)
    assert('Stale PIN rejected beyond grace', false, 'should have thrown')
  } catch (err) {
    assert(
      'Stale PIN rejected beyond grace',
      err instanceof Error && err.message === 'INVALID_PIN',
      err instanceof Error ? err.message : String(err),
    )
  }

  // ── isPinValidForVerify unit check at boundary ──
  const boundaryExpires = new Date(Date.now() - 100).toISOString()
  const valid = isPinValidForVerify('123', {
    pin: '123',
    pinExpiresAt: boundaryExpires,
    previousPin: null,
    previousPinValidUntil: null,
    mechanic: 'check-in-loyalty',
  })
  assert('check-in-loyalty uses shake-like grace', valid, 'within grace')

  console.log(`\n═══ ${passed}/${passed + failed} passed ═══\n`)
  if (failed > 0) process.exit(1)
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
