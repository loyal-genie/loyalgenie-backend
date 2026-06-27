/**
 * Vendor-side API flow + performance benchmark.
 * Run: npx tsx scripts/audit-vendor-flows.ts
 */
import dotenv from 'dotenv'
import { db, closePool } from '../src/db/client.js'
import { signToken } from '../src/services/auth.js'

dotenv.config()

const BASE = (process.env.API_BASE_URL ?? 'http://localhost:4000/api').replace(/\/$/, '')

interface Result {
  name: string
  ok: boolean
  ms: number
  bytes: number
  status: number
  note: string
}

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
  results.push({ name, ok, ms, bytes: buf.byteLength, status: res.status, note })
  console.log(`${ok ? '✓' : '✗'} ${name}\n    ${note}`)
  let json: unknown = {}
  try { json = JSON.parse(new TextDecoder().decode(buf)) } catch { /* */ }
  return { status: res.status, json, ms, bytes: buf.byteLength }
}

async function main() {
  console.log('\n═══ Vendor Flow Benchmark ═══\n')

  const row = await db.execute({
    sql: `SELECT u.id AS user_id, b.id AS business_id, b.name,
                 (SELECT c.id FROM campaigns c WHERE c.business_id = b.id AND c.status = 'active' LIMIT 1) AS campaign_id
          FROM business_users u
          JOIN businesses b ON b.user_id = u.id
          WHERE EXISTS (SELECT 1 FROM campaigns c WHERE c.business_id = b.id AND c.status = 'active')
          ORDER BY b.name LIMIT 1`,
    args: [],
  })
  const v = row.rows[0] as { user_id: string; business_id: string; name: string; campaign_id: string }
  const token = signToken({ id: v.user_id, email: 'vendor-bench@test.local', role: 'business' })
  console.log(`Vendor: ${v.name} | campaign: ${v.campaign_id}\n`)

  await api('Session check', 'GET', '/auth/session', { token, expect: 200 })
  await api('Business profile', 'GET', '/business/me', { token, maxMs: 2000 })
  await api('QR code', 'GET', '/business/me/qr', { token, maxMs: 2000 })
  await api('Dashboard analytics', 'GET', '/business/dashboard/stats', { token, maxMs: 3000 })
  await api('Campaigns list', 'GET', '/campaigns', { token, maxMs: 3000 })
  await api('Campaign detail', 'GET', `/campaigns/${v.campaign_id}`, { token, maxMs: 2000 })
  await api('PIN (initial)', 'GET', `/campaigns/${v.campaign_id}/pin`, { token, maxMs: 2000 })
  await api('PIN (refresh)', 'GET', `/campaigns/${v.campaign_id}/pin`, { token, maxMs: 2000 })
  await api('Customers list', 'GET', '/business/customers', { token, maxMs: 3000 })
  const customers = await api('Customers list (data)', 'GET', '/business/customers', { token })
  const customerList = (customers.json as { data?: { id: string }[] })?.data ?? []
  if (customerList[0]?.id) {
    await api('Customer detail', 'GET', `/business/customers/${customerList[0].id}`, { token, maxMs: 3000 })
  }
  await api('Pending redemptions', 'GET', '/business/redemptions/pending', { token, maxMs: 2000 })

  const failed = results.filter(r => !r.ok)
  const avgMs = results.reduce((s, r) => s + r.ms, 0) / results.length
  console.log('\n══════════════════════════════════════════════════')
  console.log(`Vendor: ${results.length - failed.length}/${results.length} passed | avg ${avgMs.toFixed(0)}ms`)
  await closePool()
  process.exit(failed.length ? 1 : 0)
}

main().catch(async e => {
  console.error(e)
  await closePool().catch(() => {})
  process.exit(1)
})
