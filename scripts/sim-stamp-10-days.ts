/**
 * Set simulated IST date for manual stamp testing in the customer app.
 *
 * Usage (backend/, with `npm run dev` running in another terminal):
 *   CHANGE_DATE=2026-06-17 npm run sim:stamp:10d
 *   CHANGE_DATE=2026-06-18 npm run sim:stamp:10d
 *
 * Each run writes `.campaign-date-override` — the dev server reads it on every request.
 *
 * Optional:
 *   CUSTOMER_EMAIL=omkar@gmail.com
 *   CAMPAIGN_NAME=stampNwin
 *   CLEAR_DATE=1          — remove override (use real clock)
 */

import { writeFileSync, unlinkSync, existsSync } from 'fs'
import { db } from '../src/db/client.js'
import { getCampaignDateOverrideFile } from '../src/utils/campaign-dates.js'

const CAMPAIGN_NAME = process.env.CAMPAIGN_NAME ?? 'stampNwin'
const CUSTOMER_EMAIL = process.env.CUSTOMER_EMAIL ?? 'omkar@gmail.com'
const CHANGE_DATE = process.env.CHANGE_DATE
const CLEAR_DATE = process.env.CLEAR_DATE === '1'
const OVERRIDE_FILE = getCampaignDateOverrideFile()

function setSimDate(iso: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) {
    throw new Error(`Invalid CHANGE_DATE "${iso}" — use YYYY-MM-DD`)
  }
  writeFileSync(OVERRIDE_FILE, `${iso}\n`, 'utf8')
}

function clearSimDate() {
  if (existsSync(OVERRIDE_FILE)) unlinkSync(OVERRIDE_FILE)
}

async function printStatus(simDate: string) {
  const customer = await db.execute({
    sql: 'SELECT id, name FROM customer_users WHERE email = ?',
    args: [CUSTOMER_EMAIL.toLowerCase()],
  })
  const customerId = customer.rows[0]?.id as string | undefined
  if (!customerId) throw new Error(`Customer not found: ${CUSTOMER_EMAIL}`)

  const campaign = await db.execute({
    sql: `SELECT id, name, start_date, end_date FROM campaigns
          WHERE name = ? AND mechanic = 'stamp' LIMIT 1`,
    args: [CAMPAIGN_NAME],
  })
  const c = campaign.rows[0] as Record<string, unknown> | undefined
  if (!c) throw new Error(`Campaign not found: ${CAMPAIGN_NAME}`)

  const card = await db.execute({
    sql: `SELECT stamps_collected, last_stamp_date, surprise_trigger_at, big_trigger_at,
                 surprise_awarded, big_awarded, status
          FROM stamp_cards WHERE campaign_id = ? AND customer_id = ?`,
    args: [c.id, customerId],
  })
  const row = card.rows[0] as Record<string, unknown> | undefined

  const rewards = await db.execute({
    sql: `SELECT reward_name, redemption_code FROM customer_rewards
          WHERE campaign_id = ? AND customer_id = ? ORDER BY earned_at`,
    args: [c.id, customerId],
  })

  const lastStamp = (row?.last_stamp_date as string | null)?.slice(0, 10) ?? null
  const canCollect = row
    ? row.status === 'active'
      && Number(row.stamps_collected) < 10
      && lastStamp !== simDate
    : true

  console.log('')
  console.log('═'.repeat(56))
  console.log(`  Simulated date:  ${simDate} (IST)`)
  console.log(`  Override file:   ${OVERRIDE_FILE}`)
  console.log('═'.repeat(56))
  console.log(`  Campaign:        ${CAMPAIGN_NAME}`)
  console.log(`  Customer:        ${customer.rows[0]?.name} <${CUSTOMER_EMAIL}>`)
  console.log(`  Campaign window: ${c.start_date} → ${c.end_date}`)
  console.log('')
  if (!row) {
    console.log('  Card:            not enrolled yet')
    console.log('  Can collect:     YES (first visit)')
  } else {
    console.log(`  Stamps:          ${row.stamps_collected}/10`)
    console.log(`  Last stamp day:  ${lastStamp ?? 'never'}`)
    console.log(`  Can collect:     ${canCollect ? 'YES ✓' : 'NO — already stamped this sim day'}`)
    console.log(`  Surprise @:      stamp ${row.surprise_trigger_at} (awarded: ${row.surprise_awarded})`)
    console.log(`  Big reward @:    stamp ${row.big_trigger_at} (awarded: ${row.big_awarded})`)
    console.log(`  Status:          ${row.status}`)
  }
  if (rewards.rows.length > 0) {
    console.log('  Wallet:')
    for (const r of rewards.rows) {
      console.log(`    · ${r.reward_name} (${r.redemption_code})`)
    }
  }
  console.log('')
  console.log('  Next steps:')
  console.log('    1. Customer app → stampNwin → staff PIN → collect stamp')
  console.log('    2. Vendor dashboard → stampNwin → copy Live Staff PIN')
  console.log(`    3. Tomorrow: CHANGE_DATE=${nextDay(simDate)} npm run sim:stamp:10d`)
  console.log('═'.repeat(56))
  console.log('')
}

function nextDay(iso: string): string {
  const [y, mo, d] = iso.split('-').map(Number)
  const dt = new Date(Date.UTC(y, mo - 1, d + 1))
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(dt.getUTCDate()).padStart(2, '0')}`
}

async function main() {
  if (process.env.NODE_ENV === 'production') {
    console.error('Refusing to run in production.')
    process.exit(1)
  }

  if (CLEAR_DATE) {
    clearSimDate()
    console.log('Cleared simulated date. Server uses real clock now.')
    return
  }

  if (!CHANGE_DATE) {
    console.error('Set CHANGE_DATE=YYYY-MM-DD')
    console.error('Example: CHANGE_DATE=2026-06-17 npm run sim:stamp:10d')
    console.error('Clear:    CLEAR_DATE=1 npm run sim:stamp:10d')
    process.exit(1)
  }

  setSimDate(CHANGE_DATE)
  await printStatus(CHANGE_DATE)
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
