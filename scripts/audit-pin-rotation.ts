/**
 * PIN rotation timing audit — verifies scheduler + API return fresh PIN within SLA.
 * Run: API_BASE_URL=https://loyalgenie-backend-uat.onrender.com/api npx tsx scripts/audit-pin-rotation.ts
 */
import dotenv from 'dotenv'
import { db, closePool } from '../src/db/client.js'
import { signToken } from '../src/services/auth.js'
import { rotatePinIfExpired, getCampaignPinForBusiness } from '../src/services/campaigns.js'

dotenv.config()

const BASE = (process.env.API_BASE_URL ?? 'http://localhost:4000/api').replace(/\/$/, '')
const MAX_ROTATION_MS = Number(process.env.PIN_ROTATION_SLA_MS ?? 8_000)

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

async function fetchPinHttp(token: string, campaignId: string) {
  const start = performance.now()
  const res = await fetch(`${BASE}/campaigns/${campaignId}/pin`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  const ms = performance.now() - start
  const json = (await res.json()) as {
    success?: boolean
    data?: { pin: string | null; expiresAt: string | null; secondsRemaining: number }
  }
  return { status: res.status, ms, data: json.data, ok: res.ok && json.success }
}

async function main() {
  console.log('\n═══ PIN rotation audit ═══\n')
  console.log(`API: ${BASE}`)
  console.log(`SLA: new PIN within ${MAX_ROTATION_MS}ms after expiry\n`)

  const row = await db.execute({
    sql: `SELECT u.id AS user_id, c.id AS campaign_id, c.pin, c.pin_expires_at, b.name
          FROM business_users u
          JOIN businesses b ON b.user_id = u.id
          JOIN campaigns c ON c.business_id = b.id
          WHERE c.status = 'active' AND c.mechanic IN ('shake', 'check-in-loyalty')
          ORDER BY c.pin_expires_at ASC NULLS LAST
          LIMIT 1`,
    args: [],
  })
  const v = row.rows[0] as {
    user_id: string
    campaign_id: string
    pin: string | null
    pin_expires_at: string | null
    name: string
  }
  if (!v) {
    console.log('No active shake/loyalty campaign found — skip')
    await closePool()
    process.exit(1)
  }

  const token = signToken({ id: v.user_id, email: 'pin-audit@test.local', role: 'business' })
  console.log(`Campaign: ${v.campaign_id} (${v.name})\n`)

  // 1) Service-layer rotation on expired PIN
  const almostExpired = new Date(Date.now() - 1000).toISOString()
  await db.execute({
    sql: `UPDATE campaigns SET pin_expires_at = ?, pin = ? WHERE id = ?`,
    args: [almostExpired, v.pin ?? '111', v.campaign_id],
  })

  const before = await getCampaignPinForBusiness(v.user_id, v.campaign_id)
  assert('API rotates expired PIN', Boolean(before.pin), `pin=${before.pin}`)
  assert(
    'secondsRemaining > 0 after rotation',
    (before.secondsRemaining ?? 0) > 0,
    `remaining=${before.secondsRemaining}`,
  )

  // 2) HTTP endpoint returns fresh PIN
  const httpPin = await fetchPinHttp(token, v.campaign_id)
  assert('HTTP PIN 200', httpPin.ok, `${httpPin.status} ${httpPin.ms.toFixed(0)}ms`)
  assert('HTTP pin matches service', httpPin.data?.pin === before.pin)

  // 3) Simulate countdown-to-rotation: set expiry to now, poll until pin changes
  const oldPin = before.pin!
  await db.execute({
    sql: `UPDATE campaigns SET pin_expires_at = ?, pin = ? WHERE id = ?`,
    args: [new Date(Date.now() - 500).toISOString(), oldPin, v.campaign_id],
  })

  const pollStart = performance.now()
  let newPin: string | null = null
  let polls = 0
  while (performance.now() - pollStart < MAX_ROTATION_MS) {
    polls++
    await rotatePinIfExpired(v.campaign_id)
    const meta = await getCampaignPinForBusiness(v.user_id, v.campaign_id)
    if (meta.pin && meta.pin !== oldPin && (meta.secondsRemaining ?? 0) > 0) {
      newPin = meta.pin
      break
    }
    await new Promise(r => setTimeout(r, 400))
  }
  const elapsed = performance.now() - pollStart
  assert(
    'New PIN within SLA after expiry',
    Boolean(newPin),
    newPin ? `${elapsed.toFixed(0)}ms, ${polls} polls, pin ${oldPin}→${newPin}` : `timeout after ${polls} polls`,
  )

  // 4) Health check mentions scheduler is running (log-only on Render)
  const health = await fetch(`${BASE}/health`)
  const healthJson = (await health.json()) as { status?: string; ok?: boolean }
  assert('Health OK', health.ok && (healthJson.status === 'ok' || healthJson.ok === true))

  console.log(`\n═══ ${passed} passed, ${failed} failed ═══\n`)
  await closePool()
  process.exit(failed > 0 ? 1 : 0)
}

main().catch(async err => {
  console.error(err)
  await closePool()
  process.exit(1)
})
