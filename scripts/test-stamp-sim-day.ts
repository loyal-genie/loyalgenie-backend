/**
 * Simulate a specific calendar day for one real user + campaign (uses in-memory date override).
 * Does NOT change the DB clock — only the app's "today" for that process.
 *
 * Usage (from backend/, with .env pointing at your DB):
 *   CUSTOMER_EMAIL=omkar@gmail.com CAMPAIGN_NAME=stampNwin SIM_DATE=2026-06-17 npx tsx scripts/test-stamp-sim-day.ts
 *
 * To collect again on a new simulated day, the script clears last_stamp_date when SIM_DATE changes.
 */

import { db } from '../src/db/client.js'
import { setCampaignDateOverride, todayInCampaignTz } from '../src/utils/campaign-dates.js'
import {
  getCampaignPinForBusiness,
  verifyCampaignPin,
} from '../src/services/campaigns.js'
import { executeStampCollect, getStampState } from '../src/services/stamp-cards.js'

const CUSTOMER_EMAIL = process.env.CUSTOMER_EMAIL ?? 'omkar@gmail.com'
const CAMPAIGN_NAME = process.env.CAMPAIGN_NAME ?? 'stampNwin'
const SIM_DATE = process.env.SIM_DATE ?? todayInCampaignTz()
const RESET_LAST_STAMP = process.env.RESET_LAST_STAMP !== '0'

async function main() {
  setCampaignDateOverride(SIM_DATE)
  console.log(`\n═══ Simulated day: ${SIM_DATE} (IST) ═══\n`)

  const customer = await db.execute({
    sql: 'SELECT id, email FROM customer_users WHERE email = ?',
    args: [CUSTOMER_EMAIL.toLowerCase()],
  })
  const customerId = customer.rows[0]?.id as string | undefined
  if (!customerId) throw new Error(`Customer not found: ${CUSTOMER_EMAIL}`)

  const campaign = await db.execute({
    sql: `SELECT c.id, c.name, b.user_id as vendor_user_id
          FROM campaigns c
          JOIN businesses b ON b.id = c.business_id
          WHERE c.name = ? AND c.mechanic = 'stamp'
          ORDER BY c.created_at DESC LIMIT 1`,
    args: [CAMPAIGN_NAME],
  })
  const row = campaign.rows[0] as Record<string, unknown> | undefined
  if (!row) throw new Error(`Campaign not found: ${CAMPAIGN_NAME}`)

  const campaignId = row.id as string
  const vendorUserId = row.vendor_user_id as string

  if (RESET_LAST_STAMP) {
    await db.execute({
      sql: `UPDATE stamp_cards SET last_stamp_date = NULL
            WHERE campaign_id = ? AND customer_id = ?`,
      args: [campaignId, customerId],
    })
    console.log('Cleared last_stamp_date so this simulated day can collect.\n')
  }

  const before = await getStampState(campaignId, customerId)
  console.log('Before:', JSON.stringify({
    stamps: before.stampsCollected,
    canCollectToday: before.canCollectToday,
    surpriseTriggerAt: before.surpriseTriggerAt,
    bigTriggerAt: before.bigTriggerAt,
    surpriseAwarded: before.surpriseAwarded,
    bigAwarded: before.bigAwarded,
  }, null, 2))

  if (!before.canCollectToday) {
    console.log('\nCannot collect today. Set RESET_LAST_STAMP=1 (default) or pick another SIM_DATE.')
    setCampaignDateOverride(null)
    return
  }

  const pinData = await getCampaignPinForBusiness(vendorUserId, campaignId)
  if (!pinData.pin) throw new Error('PIN not active')
  console.log(`\nPIN: ${pinData.pin}`)

  const verify = await verifyCampaignPin(campaignId, pinData.pin, customerId)
  const result = await executeStampCollect(campaignId, customerId, verify.playSessionToken)

  console.log('\nCollect result:', JSON.stringify({
    stampsCollected: result.stampsCollected,
    enrolled: result.enrolled,
    trigger: result.trigger,
    won: result.won,
    reward: result.reward?.name ?? null,
    code: result.code,
    cardComplete: result.cardComplete,
  }, null, 2))

  const after = await getStampState(campaignId, customerId)
  console.log('\nAfter:', JSON.stringify({
    stamps: after.stampsCollected,
    surpriseTriggerAt: after.surpriseTriggerAt,
    bigTriggerAt: after.bigTriggerAt,
    surpriseAwarded: after.surpriseAwarded,
    bigAwarded: after.bigAwarded,
    canCollectToday: after.canCollectToday,
  }, null, 2))

  const rewards = await db.execute({
    sql: `SELECT reward_name, redemption_code, created_at FROM customer_rewards
          WHERE campaign_id = ? AND customer_id = ? ORDER BY created_at`,
    args: [campaignId, customerId],
  })
  console.log('\nRewards in wallet:', rewards.rows)

  setCampaignDateOverride(null)
}

main().catch(err => {
  setCampaignDateOverride(null)
  console.error(err)
  process.exit(1)
})
