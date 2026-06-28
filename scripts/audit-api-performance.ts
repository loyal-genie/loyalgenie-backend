/**
 * API performance + endpoint smoke test.
 * Requires API running. Run: npx tsx scripts/audit-api-performance.ts
 */
import dotenv from 'dotenv'
import { nanoid } from 'nanoid'
import { db } from '../src/db/client.js'
import { signToken } from '../src/services/auth.js'
import { closePool } from '../src/db/client.js'

dotenv.config()

const BASE = (process.env.API_BASE_URL ?? 'http://localhost:4000/api').replace(/\/$/, '')

interface Bench {
  name: string
  ms: number
  bytes: number
  status: number
  ok: boolean
  note?: string
}

const benches: Bench[] = []

async function request(
  name: string,
  method: string,
  path: string,
  opts?: { body?: unknown; token?: string; expectStatus?: number; maxMs?: number; maxBytes?: number },
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
  const bytes = buf.byteLength
  const expectStatus = opts?.expectStatus ?? 200
  const ok = res.status === expectStatus
    && (opts?.maxMs === undefined || ms <= opts.maxMs)
    && (opts?.maxBytes === undefined || bytes <= opts.maxBytes)
  let note = `status=${res.status} ${ms.toFixed(0)}ms ${(bytes / 1024).toFixed(1)}KB`
  if (opts?.maxMs && ms > opts.maxMs) note += ` (slow, target <${opts.maxMs}ms)`
  if (opts?.maxBytes && bytes > opts.maxBytes) note += ` (large, target <${(opts.maxBytes / 1024).toFixed(0)}KB)`
  benches.push({ name, ms, bytes, status: res.status, ok, note })
  console.log(`${ok ? '✓' : '✗'} ${name}\n    ${note}`)
  let json: unknown = {}
  try { json = JSON.parse(new TextDecoder().decode(buf)) } catch { /* */ }
  return { status: res.status, json, ms, bytes }
}

async function getTestTokens() {
  const vendor = await db.execute({
    sql: `SELECT u.id, b.id AS business_id FROM business_users u
          JOIN businesses b ON b.user_id = u.id
          JOIN campaigns c ON c.business_id = b.id AND c.status = 'active'
          ORDER BY c.created_at DESC LIMIT 1`,
    args: [],
  })
  const customer = await db.execute({
    sql: `SELECT id FROM customer_users ORDER BY created_at DESC LIMIT 1`,
    args: [],
  })
  const campaign = await db.execute({
    sql: `SELECT c.id, c.business_id, c.mechanic FROM campaigns c
          WHERE c.status = 'active' ORDER BY c.created_at DESC LIMIT 1`,
    args: [],
  })
  const vendorId = vendor.rows[0]?.id as string | undefined
  const customerId = customer.rows[0]?.id as string | undefined
  const campaignRow = campaign.rows[0] as { id: string; business_id: string; mechanic: string } | undefined
  return {
    vendorToken: vendorId ? signToken({ id: vendorId, email: 'audit@test.local', role: 'business' }) : undefined,
    customerToken: customerId ? signToken({ id: customerId, email: 'audit@test.local', role: 'customer' }) : undefined,
    campaignId: campaignRow?.id,
    businessId: campaignRow?.business_id,
  }
}

async function main() {
  console.log('\n═══ API Performance Audit ═══\n')
  console.log(`API: ${BASE}\n`)

  await request('Health', 'GET', '/health', { maxMs: 50 })

  const discover = await request('Discover (public businesses)', 'GET', '/campaigns/public/businesses', {
    maxMs: 2000,
    maxBytes: 500_000,
  })

  const businesses = (discover.json as { data?: { id: string }[] })?.data ?? []
  const bizId = businesses[0]?.id
  if (bizId) {
    const campRow = await db.execute({
      sql: `SELECT id FROM campaigns WHERE business_id = ? AND status = 'active' LIMIT 1`,
      args: [bizId],
    })
    const publicCampId = campRow.rows[0]?.id as string | undefined
    if (publicCampId) {
      await request('Public campaign detail', 'GET', `/campaigns/public/${publicCampId}`, { maxMs: 1500 })
    }
  }

  const tokens = await getTestTokens()

  if (tokens.vendorToken) {
    await request('Vendor campaigns list', 'GET', '/campaigns', {
      token: tokens.vendorToken,
      maxMs: 3000,
      maxBytes: 1_000_000,
    })
    await request('Vendor business profile', 'GET', '/business/me', {
      token: tokens.vendorToken,
      maxMs: 1500,
    })
    await request('Vendor dashboard stats', 'GET', '/business/dashboard/stats', {
      token: tokens.vendorToken,
      maxMs: 3000,
    })
    await request('Vendor customers', 'GET', '/business/customers', {
      token: tokens.vendorToken,
      maxMs: 3000,
    })
    await request('Vendor pending redemptions', 'GET', '/business/redemptions/pending', {
      token: tokens.vendorToken,
      maxMs: 2000,
    })
    if (tokens.campaignId) {
      await request('Vendor campaign PIN', 'GET', `/campaigns/${tokens.campaignId}/pin`, {
        token: tokens.vendorToken,
        maxMs: 1500,
      })
      await request('Vendor campaign detail', 'GET', `/campaigns/${tokens.campaignId}`, {
        token: tokens.vendorToken,
        maxMs: 2000,
      })
    }
  } else {
    console.log('⚠ No vendor token — skipping vendor endpoints')
  }

  if (tokens.customerToken && tokens.businessId) {
    await request('Customer batch states', 'GET', `/campaigns/public/businesses/${tokens.businessId}/states`, {
      token: tokens.customerToken,
      maxMs: 2000,
    })
    await request('Customer rewards wallet', 'GET', '/campaigns/customer/rewards', {
      token: tokens.customerToken,
      maxMs: 2000,
    })
    await request('Customer loyalty profile', 'GET', '/campaigns/customer/loyalty-profile', {
      token: tokens.customerToken,
      maxMs: 2000,
    })
    if (tokens.campaignId) {
      const mech = tokens.campaignId
      const camp = await db.execute({ sql: 'SELECT mechanic FROM campaigns WHERE id = ?', args: [tokens.campaignId] })
      const mechanic = camp.rows[0]?.mechanic as string
      if (mechanic === 'shake') {
        await request('Shake play-state', 'GET', `/campaigns/${tokens.campaignId}/play-state`, {
          token: tokens.customerToken,
          maxMs: 1500,
        })
      } else if (mechanic === 'stamp') {
        await request('Stamp state', 'GET', `/campaigns/${tokens.campaignId}/stamp-state`, {
          token: tokens.customerToken,
          maxMs: 1500,
        })
      } else if (mechanic === 'check-in-loyalty') {
        await request('Loyalty state', 'GET', `/campaigns/${tokens.campaignId}/loyalty-state`, {
          token: tokens.customerToken,
          maxMs: 1500,
        })
      }
    }
  } else {
    console.log('⚠ No customer token — skipping customer endpoints')
  }

  // Check no base64 in discover payload
  const discoverBody = JSON.stringify(discover.json)
  const hasBase64 = discoverBody.includes('data:image/')
  benches.push({
    name: 'Discover payload has no base64 images',
    ms: 0,
    bytes: 0,
    status: hasBase64 ? 500 : 200,
    ok: !hasBase64,
    note: hasBase64 ? 'FOUND data:image/ in JSON — images not fully migrated to R2' : 'clean — URL-only images',
  })
  console.log(`${!hasBase64 ? '✓' : '✗'} Discover payload has no base64 images\n    ${hasBase64 ? 'FOUND data:image/' : 'clean — URL-only images'}`)

  const failed = benches.filter(b => !b.ok)
  console.log('\n══════════════════════════════════════════════════')
  console.log(`Results: ${benches.length - failed.length}/${benches.length} passed`)
  if (failed.length) {
    console.log('\nSlow or failed:')
    for (const f of failed) console.log(`  ✗ ${f.name}: ${f.note}`)
  }
  await closePool()
  process.exit(failed.length ? 1 : 0)
}

main().catch(async err => {
  console.error(err)
  await closePool().catch(() => {})
  process.exit(1)
})
