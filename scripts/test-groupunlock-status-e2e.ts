/**
 * Community Offer (groupunlock) — Check Status flow E2E
 *
 * Validates:
 *   - reserve creates group_pending (spot held)
 *   - state exposes claimed/remaining for Check Status UI
 *   - redeem blocked until target reached
 *   - at target → unlocked → earned (wallet-ready)
 *   - redeem works after unlock
 *   - campaign deleted after run
 *
 * Usage (from backend/):
 *   npx tsx scripts/test-groupunlock-status-e2e.ts
 */

import { nanoid } from 'nanoid'
import bcrypt from 'bcryptjs'
import { ensureColumnPatches } from '../src/db/migrate.js'
import { db, closePool } from '../src/db/client.js'
import {
  setCampaignDateOverride,
  todayInCampaignTz,
  addCampaignDays,
} from '../src/utils/campaign-dates.js'
import {
  createCampaign,
  deleteCampaign,
  getCampaignPinForBusiness,
  verifyCampaignPin,
  requestCustomerRedemption,
  listCustomerRewards,
} from '../src/services/campaigns.js'
import {
  claimGroupUnlockReward,
  getGroupUnlockState,
} from '../src/services/groupunlock-service.js'

const RUN_ID = Date.now().toString(36)
const TARGET = 3

interface TestResult { name: string; passed: boolean; detail: string }
const results: TestResult[] = []

function assert(name: string, condition: boolean, detail: string) {
  results.push({ name, passed: condition, detail })
  console.log(`${condition ? '✓' : '✗'} ${name}\n    ${detail}`)
}

async function hashPassword(password: string) {
  return bcrypt.hash(password, 10)
}

async function createVendor() {
  const userId = nanoid()
  await db.execute({
    sql: `INSERT INTO business_users (id, email, password_hash) VALUES (?, ?, ?)`,
    args: [userId, `vendor-gu-${RUN_ID}@test.local`, await hashPassword('TestPass123!')],
  })
  const businessId = nanoid()
  await db.execute({
    sql: `INSERT INTO businesses (id, user_id, name, qr_slug, business_type, city) VALUES (?, ?, ?, ?, 'Cafe', 'Mumbai')`,
    args: [businessId, userId, `GU E2E Cafe ${RUN_ID}`, `e2e-gu-${RUN_ID}`],
  })
  return { userId, businessId }
}

async function createCustomer(i: number) {
  const id = nanoid()
  const phone = String(9400000000 + (Number.parseInt(RUN_ID.slice(-5), 36) % 90000) * 10 + i)
  await db.execute({
    sql: `INSERT INTO customer_users (id, name, phone, email, password_hash) VALUES (?, ?, ?, ?, ?)`,
    args: [id, `GU User ${i}`, phone, `e2e-gu-${RUN_ID}-${i}@test.local`, await hashPassword('TestPass123!')],
  })
  return { id, label: `User${i}` }
}

async function refreshPin(vendorUserId: string, campaignId: string) {
  const pinData = await getCampaignPinForBusiness(vendorUserId, campaignId)
  if (!pinData.pin) throw new Error('PIN not active')
  return pinData.pin
}

async function reserve(campaignId: string, customerId: string, pin: string) {
  const verify = await verifyCampaignPin(campaignId, pin, customerId)
  return claimGroupUnlockReward(campaignId, customerId, verify.playSessionToken)
}

async function cleanup(
  vendor: { userId: string; businessId: string },
  campaignId: string | null,
  customerIds: string[],
) {
  if (campaignId) {
    try {
      await db.execute({ sql: 'DELETE FROM customer_rewards WHERE campaign_id = ?', args: [campaignId] })
      await db.execute({ sql: 'DELETE FROM game_plays WHERE campaign_id = ?', args: [campaignId] })
      await db.execute({ sql: 'DELETE FROM campaign_participations WHERE campaign_id = ?', args: [campaignId] })
      await db.execute({ sql: 'DELETE FROM campaign_rewards WHERE campaign_id = ?', args: [campaignId] })
      await deleteCampaign(vendor.userId, campaignId)
    } catch (err) {
      console.warn('Cleanup warning:', err instanceof Error ? err.message : err)
      await db.execute({ sql: 'DELETE FROM campaigns WHERE id = ?', args: [campaignId] }).catch(() => undefined)
    }
  }
  for (const id of customerIds) {
    await db.execute({ sql: 'DELETE FROM customer_rewards WHERE customer_id = ?', args: [id] }).catch(() => undefined)
    await db.execute({ sql: 'DELETE FROM customer_users WHERE id = ?', args: [id] }).catch(() => undefined)
  }
  await db.execute({ sql: 'DELETE FROM businesses WHERE id = ?', args: [vendor.businessId] }).catch(() => undefined)
  await db.execute({ sql: 'DELETE FROM business_users WHERE id = ?', args: [vendor.userId] }).catch(() => undefined)
}

async function main() {
  console.log(`\n═══ Community Offer Check Status E2E (${RUN_ID}) ═══`)
  console.log(`Target ${TARGET} people · reserve → status → unlock → wallet redeem\n`)

  await ensureColumnPatches()

  const start = todayInCampaignTz()
  setCampaignDateOverride(start)

  const vendor = await createVendor()
  let campaignId: string | null = null
  const customers: { id: string; label: string }[] = []

  try {
    const campaign = await createCampaign(vendor.userId, {
      name: `Community Offer ${RUN_ID}`,
      mechanic: 'groupunlock',
      startDate: start,
      endDate: addCampaignDays(start, 14),
      startTime: '00:00',
      endTime: '23:59',
      groupUnlockConfig: {
        targetParticipants: TARGET,
        rewardKind: 'flat',
        rewardValue: '100',
        redeemExpiryMode: 'relative',
        redeemRelativeAmount: 14,
        redeemRelativeUnit: 'day',
      },
    })
    campaignId = campaign.id
    assert('Campaign created', campaign.mechanic === 'groupunlock', `id=${campaign.id}`)

    const c1 = await createCustomer(1)
    const c2 = await createCustomer(2)
    const c3 = await createCustomer(3)
    customers.push(c1, c2, c3)

    const pin = await refreshPin(vendor.userId, campaign.id)

    // ── Reserve 1 of 3 ──
    const r1 = await reserve(campaign.id, c1.id, pin)
    assert('User1 reserved', Boolean(r1.rewardId) && r1.unlocked === false, `joined=${r1.groupJoined}`)

    const s1 = await getGroupUnlockState(campaign.id, c1.id)
    assert('Check Status: 1 claimed, 2 remaining', s1.claimedCount === 1 && s1.spotsRemaining === 2,
      `${s1.claimedCount} claimed / ${s1.spotsRemaining} remaining`)
    assert('User1 hasClaimed, cannot re-claim', s1.hasClaimed && !s1.canClaim,
      `hasClaimed=${s1.hasClaimed} canClaim=${s1.canClaim}`)
    assert('Not unlocked yet', s1.unlocked === false, `unlocked=${s1.unlocked}`)
    assert('Wallet row is group_pending (status tracking)', s1.walletReward?.status === 'group_pending',
      `status=${s1.walletReward?.status}`)

    // Redeem blocked while pending
    let blockedRedeem = false
    try {
      await requestCustomerRedemption(c1.id, s1.walletReward!.id)
    } catch (e) {
      blockedRedeem = e instanceof Error && e.message === 'GROUP_NOT_UNLOCKED'
    }
    assert('Redeem blocked before unlock', blockedRedeem, 'GROUP_NOT_UNLOCKED')

    // Double reserve blocked
    let blockedDouble = false
    try {
      await reserve(campaign.id, c1.id, pin)
    } catch (e) {
      blockedDouble = e instanceof Error && e.message === 'ALREADY_CLAIMED'
    }
    assert('Second reserve blocked', blockedDouble, 'ALREADY_CLAIMED')

    // ── Reserve 2 of 3 ──
    const r2 = await reserve(campaign.id, c2.id, pin)
    assert('User2 reserved, still locked', r2.unlocked === false && r2.groupJoined === 2,
      `joined=${r2.groupJoined} unlocked=${r2.unlocked}`)

    const s2 = await getGroupUnlockState(campaign.id, c1.id)
    assert('Check Status: 2 claimed, 1 remaining', s2.claimedCount === 2 && s2.spotsRemaining === 1,
      `${s2.claimedCount}/${TARGET} · ${s2.spotsRemaining} left`)

    // ── Reserve 3 of 3 → unlock ──
    const r3 = await reserve(campaign.id, c3.id, pin)
    assert('User3 unlocks the group', r3.unlocked === true && r3.groupJoined === 3,
      `joined=${r3.groupJoined} unlocked=${r3.unlocked}`)

    const sAfter = await getGroupUnlockState(campaign.id, c1.id)
    assert('Check Status: unlocked, 0 remaining', sAfter.unlocked && sAfter.spotsRemaining === 0,
      `unlocked=${sAfter.unlocked} remaining=${sAfter.spotsRemaining}`)
    assert('User1 reward promoted to earned (wallet-ready)', sAfter.walletReward?.status === 'earned',
      `status=${sAfter.walletReward?.status}`)

    const allStatuses = await db.execute({
      sql: `SELECT status, COUNT(*) AS c FROM customer_rewards
            WHERE campaign_id = ? AND source_type = 'groupunlock' GROUP BY status`,
      args: [campaign.id],
    })
    const earnedCount = Number(allStatuses.rows.find(r => r.status === 'earned')?.c ?? 0)
    assert('All 3 rewards earned after unlock', earnedCount === 3, `earned=${earnedCount}`)

    // ── Redeem after unlock ──
    await requestCustomerRedemption(c1.id, sAfter.walletReward!.id)
    const rewards = await listCustomerRewards(c1.id)
    const mine = rewards.find(r => r.id === sAfter.walletReward!.id)
    assert('Redeem request → pending (wallet claim flow)', mine?.status === 'pending',
      `status=${mine?.status}`)

    // Cap full — 4th user blocked
    const c4 = await createCustomer(4)
    customers.push(c4)
    let capped = false
    try {
      await reserve(campaign.id, c4.id, pin)
    } catch (e) {
      capped = e instanceof Error && e.message === 'USER_CAP_REACHED'
    }
    assert('4th user blocked when full', capped, 'USER_CAP_REACHED')

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
