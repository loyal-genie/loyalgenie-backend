import { db } from '../src/db/client.js'
import { nowInCampaignTz, todayInCampaignTz } from '../src/utils/campaign-dates.js'
import {
  isPinValidForVerify,
  normalizePin,
  computePinSecondsRemaining,
  PIN_VERIFY_GRACE_SECONDS,
} from '../src/services/campaigns.js'

const id = process.argv[2] ?? 'b1AOJ8fSh0cMtJMPeo8HC'
const testPin = process.argv[3]

async function main() {
  const row = await db.execute({
    sql: `SELECT id, name, mechanic, status, start_date, end_date,
                 pin, pin_expires_at, previous_pin, previous_pin_valid_until
          FROM campaigns WHERE id = ?`,
    args: [id],
  })
  const c = row.rows[0]
  if (!c) {
    console.log('Campaign not found')
    process.exit(1)
  }

  const now = nowInCampaignTz()
  console.log('Now:', now.toISOString())
  console.log('Today:', todayInCampaignTz())
  console.log('Campaign:', {
    id: c.id,
    name: c.name,
    mechanic: c.mechanic,
    status: c.status,
    startDate: c.start_date,
    endDate: c.end_date,
    pin: c.pin,
    pinExpiresAt: c.pin_expires_at,
    secondsRemaining: computePinSecondsRemaining(c.pin_expires_at as string | null),
    previousPin: c.previous_pin,
    previousPinValidUntil: c.previous_pin_valid_until,
    graceSeconds: PIN_VERIFY_GRACE_SECONDS,
  })

  const cols = await db.execute({ sql: 'PRAGMA table_info(campaigns)' })
  console.log(
    'PIN columns:',
    cols.rows.filter(r => String(r.name).includes('pin')).map(r => r.name),
  )

  if (testPin) {
    const pinState = {
      pin: (c.pin as string | null) ?? null,
      pinExpiresAt: (c.pin_expires_at as string | null) ?? null,
      previousPin: (c.previous_pin as string | null) ?? null,
      previousPinValidUntil: (c.previous_pin_valid_until as string | null) ?? null,
      mechanic: c.mechanic as string,
    }
    const normalized = normalizePin(testPin)
    const valid = isPinValidForVerify(normalized, pinState)
    console.log('Test PIN:', testPin, '→ normalized:', normalized, '→ valid:', valid)
  }
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
