/**
 * Customer-side API flow + performance benchmark.
 * Run: npx tsx scripts/audit-customer-flows.ts
 */
import dotenv from 'dotenv'
import { db, closePool } from '../src/db/client.js'
import { signToken } from '../src/services/auth.js'
import { rotatePinIfExpired } from '../src/services/campaigns.js'

dotenv.config()

const BASE = (process.env.API_BASE_URL ?? 'http://localhost:4000/api').replace(/\/$/, '')

interface Result { name: string; ok: boolean; ms: number; note: string }
const results: Result[] = []

async function api(
  name: string,
  method: string,
  path: string,
  opts?: { body?: unknown; token?: string; expect?: number; maxMs?: number },
) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (opts?.token) headers.Authorization = `Bearer ${opts.token}`
  const start = performance.now()
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: opts?.body !== undefined ? JSON.stringify(opts.body) : undefined,
  })
  const buf = await res.arrayBuffer()
  const ms = performance.now() - start
  const expect = opts?.expect ?? 200
  const ok = res.status === expect && (opts?.maxMs === undefined || ms <= opts.maxMs)
  const note = `${res.status} ${ms.toFixed(0)}ms ${(buf.byteLength / 1024).toFixed(1)}KB`
  results.push({ name, ok, ms, note })
  console.log(`${ok ? '✓' : '✗'} ${name}\n    ${note}`)
  let json: unknown = {}
  try { json = JSON.parse(new TextDecoder().decode(buf)) } catch { /* */ }
  return { status: res.status, json, ms }
}

async function main() {
  console.log('\n═══ Customer Flow Benchmark ═══\n')

  const discover = await api('Discover cafes', 'GET', '/campaigns/public/businesses', { maxMs: 2000 })
  const businesses = (discover.json as { data?: { id: string; campaigns: { id: string; mechanic: string }[] }[] })?.data ?? []
  const biz = businesses[0]
  if (!biz) throw new Error('No businesses on discover')

  const shake = biz.campaigns.find(c => c.mechanic === 'shake')
  const stamp = biz.campaigns.find(c => c.mechanic === 'stamp')
  const loyalty = biz.campaigns.find(c => c.mechanic === 'check-in-loyalty')

  await api('Public campaign (shake)', 'GET', `/campaigns/public/${shake?.id ?? biz.campaigns[0].id}`, { maxMs: 2000 })

  const custRow = await db.execute({ sql: 'SELECT id FROM customer_users ORDER BY created_at DESC LIMIT 1', args: [] })
  const customerId = custRow.rows[0]?.id as string
  const token = signToken({ id: customerId, email: 'cust-bench@test.local', role: 'customer' })

  await api('Customer profile', 'GET', '/customer/profile', { token, maxMs: 2000 })
  await api('Batch campaign states', 'GET', `/campaigns/public/businesses/${biz.id}/states`, { token, maxMs: 2000 })
  await api('Wallet rewards', 'GET', '/campaigns/customer/rewards', { token, maxMs: 2000 })
  await api('Loyalty profiles', 'GET', '/campaigns/customer/loyalty-profile', { token, maxMs: 2000 })
  await api('Check-in prompt', 'GET', '/campaigns/customer/check-in-prompt', { token, maxMs: 2000 })
  await api('Notifications', 'GET', '/customer/notifications', { token, maxMs: 2000 })

  if (shake) {
    await api('Shake play-state', 'GET', `/campaigns/${shake.id}/play-state`, { token, maxMs: 1500 })
    const camp = await rotatePinIfExpired(shake.id)
    const pin = camp.pin
    if (pin) {
      const verify = await api('PIN verify', 'POST', `/campaigns/${shake.id}/verify-pin`, {
        token,
        body: { pin },
        maxMs: 2000,
      })
      const sessionToken = (verify.json as { data?: { playSessionToken?: string } })?.data?.playSessionToken
      if (sessionToken) {
        await api('Shake play', 'POST', `/campaigns/${shake.id}/shake`, {
          token,
          body: { playSessionToken: sessionToken },
          maxMs: 3000,
          expect: 200,
        })
      }
    }
  }

  if (stamp) {
    await api('Stamp state', 'GET', `/campaigns/${stamp.id}/stamp-state`, { token, maxMs: 1500 })
  }

  if (loyalty) {
    await api('Loyalty state', 'GET', `/campaigns/${loyalty.id}/loyalty-state`, { token, maxMs: 1500 })
  }

  const body = JSON.stringify(discover.json)
  const noB64 = !body.includes('data:image/')
  console.log(`${noB64 ? '✓' : '✗'} Discover has no base64 images\n    ${noB64 ? 'clean' : 'FOUND base64'}`)
  if (!noB64) results.push({ name: 'No base64 in discover', ok: false, ms: 0, note: 'base64 found' })

  const failed = results.filter(r => !r.ok)
  const avgMs = results.reduce((s, r) => s + r.ms, 0) / Math.max(1, results.length)
  console.log('\n══════════════════════════════════════════════════')
  console.log(`Customer: ${results.length - failed.length}/${results.length} passed | avg ${avgMs.toFixed(0)}ms`)
  await closePool()
  process.exit(failed.length ? 1 : 0)
}

main().catch(async e => {
  console.error(e)
  await closePool().catch(() => {})
  process.exit(1)
})
