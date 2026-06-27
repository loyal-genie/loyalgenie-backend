/**
 * UAT end-to-end audit — realistic remote thresholds + latency breakdown.
 *
 * Run:
 *   API_BASE_URL=https://loyalgenie-backend-uat.onrender.com/api \
 *   FRONTEND_URL=https://loyalgenie-uat.vercel.app \
 *   npm run audit:uat
 *
 * Writes: docs/uat-audit-report.json (machine-readable trail)
 */
import dotenv from 'dotenv'
import { writeFileSync, mkdirSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'
import { db, closePool, pool } from '../src/db/client.js'
import { signToken } from '../src/services/auth.js'
import { rotatePinIfExpired } from '../src/services/campaigns.js'

dotenv.config()

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = join(__dirname, '../..')

const API_BASE = (process.env.API_BASE_URL ?? 'https://loyalgenie-backend-uat.onrender.com/api').replace(/\/$/, '')
const FRONTEND_URL = (process.env.FRONTEND_URL ?? 'https://loyalgenie-uat.vercel.app').replace(/\/$/, '')
const R2_PUBLIC = (process.env.R2_PUBLIC_URL ?? '').replace(/\/$/, '')

/** Realistic thresholds for remote UAT (Bangalore → Render → Supabase). */
const UAT_THRESHOLDS = {
  health: 800,
  healthDeep: 1200,
  discover: 2500,
  discoverBytes: 50_000,
  publicCampaign: 2500,
  vendorDefault: 3500,
  customerDefault: 3500,
  pin: 2500,
  pinRotationSla: 8_000,
  coldStartSuspect: 5_000,
} as const

interface AuditEntry {
  category: string
  name: string
  passed: boolean
  clientMs: number
  serverDbMs?: number
  serverMs?: number
  estNetworkMs?: number
  estAppDbMs?: number
  bytes?: number
  status?: number
  detail: string
}

interface AuditReport {
  generatedAt: string
  targets: { api: string; frontend: string }
  baseline: {
    healthMedianMs: number
    healthDeepMedianMs: number
    serverDbMedianMs: number
    serverMedianMs: number
    estNetworkMedianMs: number
    coldStartDetected: boolean
  }
  infra: AuditEntry[]
  api: AuditEntry[]
  vendor: AuditEntry[]
  customer: AuditEntry[]
  pin: AuditEntry[]
  frontend: AuditEntry[]
  summary: {
    total: number
    passed: number
    failed: number
    categories: Record<string, { passed: number; total: number }>
  }
}

const report: AuditReport = {
  generatedAt: new Date().toISOString(),
  targets: { api: API_BASE, frontend: FRONTEND_URL },
  baseline: {
    healthMedianMs: 0,
    healthDeepMedianMs: 0,
    serverDbMedianMs: 0,
    serverMedianMs: 0,
    estNetworkMedianMs: 0,
    coldStartDetected: false,
  },
  infra: [],
  api: [],
  vendor: [],
  customer: [],
  pin: [],
  frontend: [],
  summary: { total: 0, passed: 0, failed: 0, categories: {} },
}

function median(nums: number[]): number {
  if (!nums.length) return 0
  const sorted = [...nums].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2
}

function record(category: keyof Pick<AuditReport, 'infra' | 'api' | 'vendor' | 'customer' | 'pin' | 'frontend'>, entry: AuditEntry) {
  report[category].push(entry)
}

async function timedFetch(
  url: string,
  opts?: { method?: string; headers?: Record<string, string>; body?: unknown },
): Promise<{ ms: number; status: number; bytes: number; json: unknown; headers: Headers }> {
  const start = performance.now()
  const res = await fetch(url, {
    method: opts?.method ?? 'GET',
    headers: opts?.headers,
    body: opts?.body !== undefined ? JSON.stringify(opts.body) : undefined,
  })
  const buf = await res.arrayBuffer()
  const ms = performance.now() - start
  let json: unknown = {}
  try {
    json = JSON.parse(new TextDecoder().decode(buf))
  } catch { /* */ }
  return { ms, status: res.status, bytes: buf.byteLength, json, headers: res.headers }
}

async function measureBaseline() {
  console.log('\n── Baseline latency (warm-up + median) ──\n')

  const healthSamples: number[] = []
  const deepSamples: { client: number; db: number; server: number }[] = []

  for (let i = 0; i < 5; i++) {
    const h = await timedFetch(`${API_BASE}/health`)
    healthSamples.push(h.ms)
    const d = await timedFetch(`${API_BASE}/health/deep`)
    if (d.status === 200) {
      const timing = (d.json as { timing?: { dbMs: number; serverMs: number } })?.timing
      deepSamples.push({
        client: d.ms,
        db: timing?.dbMs ?? 0,
        server: timing?.serverMs ?? 0,
      })
    }
    await new Promise(r => setTimeout(r, 200))
  }

  const healthMed = median(healthSamples)
  const deepMed = deepSamples.length ? median(deepSamples.map(s => s.client)) : healthMed
  const dbMed = deepSamples.length ? median(deepSamples.map(s => s.db)) : 0
  const serverMed = deepSamples.length ? median(deepSamples.map(s => s.server)) : 0
  const networkMed = deepSamples.length
    ? Math.max(0, healthMed - serverMed)
    : Math.round(healthMed * 0.85)

  report.baseline = {
    healthMedianMs: Math.round(healthMed),
    healthDeepMedianMs: Math.round(deepMed),
    serverDbMedianMs: Math.round(dbMed),
    serverMedianMs: Math.round(serverMed),
    estNetworkMedianMs: Math.round(networkMed),
    coldStartDetected: Math.max(...healthSamples) > UAT_THRESHOLDS.coldStartSuspect,
  }

  record('infra', {
    category: 'baseline',
    name: 'Health median (network baseline)',
    passed: healthMed <= UAT_THRESHOLDS.health,
    clientMs: Math.round(healthMed),
    estNetworkMs: Math.round(networkMed),
    detail: `p50=${Math.round(healthMed)}ms est.network≈${Math.round(networkMed)}ms (samples: ${healthSamples.map(n => Math.round(n)).join(', ')})`,
  })
  record('infra', {
    category: 'baseline',
    name: 'Health/deep median (DB on server)',
    passed: deepSamples.length > 0 ? deepMed <= UAT_THRESHOLDS.healthDeep : true,
    clientMs: Math.round(deepMed),
    serverDbMs: Math.round(dbMed),
    serverMs: Math.round(serverMed),
    estNetworkMs: Math.round(networkMed),
    detail: deepSamples.length
      ? `p50 client=${Math.round(deepMed)}ms server.db=${Math.round(dbMed)}ms server.total=${Math.round(serverMed)}ms`
      : '/health/deep not deployed yet — using health-only estimate (deploy backend for server timing)',
  })
  record('infra', {
    category: 'baseline',
    name: 'No cold-start spike (>5s)',
    passed: !report.baseline.coldStartDetected,
    clientMs: Math.max(...healthSamples),
    detail: report.baseline.coldStartDetected
      ? `max health=${Math.round(Math.max(...healthSamples))}ms — UptimeRobot may not be warming`
      : `max health=${Math.round(Math.max(...healthSamples))}ms — service awake`,
  })

  console.log(`  Health p50: ${Math.round(healthMed)}ms | est. network: ~${Math.round(networkMed)}ms`)
  console.log(`  Health/deep p50: ${Math.round(deepMed)}ms | server DB: ${Math.round(dbMed)}ms | server total: ${Math.round(serverMed)}ms`)
}

function estAppDb(clientMs: number): number {
  const baseline = report.baseline.healthMedianMs
  return Math.max(0, Math.round(clientMs - baseline))
}

async function auditInfra() {
  console.log('\n── Infrastructure (Supabase + R2) ──\n')

  const blobCols = ['logo_data', 'cover_banner_data']
  for (const col of blobCols) {
    const r = await pool.query(
      `SELECT EXISTS (
         SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'businesses' AND column_name = $1
       ) AS ok`,
      [col],
    )
    const exists = Boolean(r.rows[0]?.ok)
    record('infra', {
      category: 'infra',
      name: `Blob column dropped: businesses.${col}`,
      passed: !exists,
      clientMs: 0,
      detail: exists ? 'STILL EXISTS' : 'dropped ✓',
    })
  }

  const b64 = await pool.query<{ cnt: string }>(
    `SELECT COUNT(*)::text AS cnt FROM businesses WHERE logo_url LIKE 'data:%' OR cover_banner_url LIKE 'data:%'`,
  )
  record('infra', {
    category: 'infra',
    name: 'No base64 images in DB',
    passed: Number(b64.rows[0]?.cnt ?? 0) === 0,
    clientMs: 0,
    detail: `base64 rows: ${b64.rows[0]?.cnt ?? 0}`,
  })

  const rt = await pool.query(`SELECT tablename FROM pg_publication_tables WHERE pubname = 'supabase_realtime'`)
  const tables = rt.rows.map(r => r.tablename as string)
  for (const t of ['campaigns', 'customer_rewards', 'game_plays']) {
    record('infra', {
      category: 'infra',
      name: `Realtime enabled: ${t}`,
      passed: tables.includes(t),
      clientMs: 0,
      detail: tables.includes(t) ? 'yes' : 'MISSING — run db:enable-realtime',
    })
  }

  if (R2_PUBLIC) {
    const r2 = await pool.query<{ cnt: string }>(
      `SELECT COUNT(*)::text AS cnt FROM businesses WHERE logo_url LIKE $1`,
      [`${R2_PUBLIC}%`],
    )
    record('infra', {
      category: 'infra',
      name: 'R2 URLs in database',
      passed: Number(r2.rows[0]?.cnt ?? 0) > 0,
      clientMs: 0,
      detail: `${r2.rows[0]?.cnt ?? 0} businesses with R2 logo URLs`,
    })
  }
}

async function auditApiEndpoints() {
  console.log('\n── Public API endpoints ──\n')
  const network = report.baseline.estNetworkMedianMs

  const discover = await timedFetch(`${API_BASE}/campaigns/public/businesses`, {
    headers: { 'Accept-Encoding': 'gzip' },
  })
  const discoverBody = JSON.stringify(discover.json)
  const hasB64 = discoverBody.includes('data:image/')
  const hasR2 = R2_PUBLIC ? discoverBody.includes(R2_PUBLIC) : discoverBody.includes('r2.dev')

  record('api', {
    category: 'api',
    name: 'Discover /public/businesses',
    passed: discover.status === 200 && discover.ms <= UAT_THRESHOLDS.discover && discover.bytes <= UAT_THRESHOLDS.discoverBytes,
    clientMs: Math.round(discover.ms),
    bytes: discover.bytes,
    status: discover.status,
    estNetworkMs: network,
    estAppDbMs: estAppDb(discover.ms),
    detail: `${discover.status} ${Math.round(discover.ms)}ms ${(discover.bytes / 1024).toFixed(1)}KB | est.app+db≈${estAppDb(discover.ms)}ms`,
  })
  record('api', {
    category: 'api',
    name: 'Discover payload size (<50KB)',
    passed: discover.bytes <= UAT_THRESHOLDS.discoverBytes,
    clientMs: 0,
    bytes: discover.bytes,
    detail: `${(discover.bytes / 1024).toFixed(1)}KB (was ~6MB pre-migration)`,
  })
  record('api', {
    category: 'api',
    name: 'Discover uses R2 URLs (not base64)',
    passed: !hasB64 && hasR2,
    clientMs: 0,
    detail: hasB64 ? 'FOUND data:image/' : hasR2 ? 'R2 URLs present ✓' : 'no R2 URLs detected',
  })

  const businesses = (discover.json as { data?: { id: string; campaigns: { id: string; mechanic: string }[] }[] })?.data ?? []
  const biz = businesses[0]
  if (biz?.campaigns[0]) {
    const campId = biz.campaigns[0].id
    const pub = await timedFetch(`${API_BASE}/campaigns/public/${campId}`)
    record('api', {
      category: 'api',
      name: 'Public campaign detail',
      passed: pub.status === 200 && pub.ms <= UAT_THRESHOLDS.publicCampaign,
      clientMs: Math.round(pub.ms),
      bytes: pub.bytes,
      status: pub.status,
      estAppDbMs: estAppDb(pub.ms),
      detail: `${pub.status} ${Math.round(pub.ms)}ms est.app+db≈${estAppDb(pub.ms)}ms`,
    })
  }

  const comp = await timedFetch(`${API_BASE}/campaigns/public/businesses`, {
    headers: { 'Accept-Encoding': 'gzip' },
  })
  const encoding = comp.headers.get('content-encoding')
  record('api', {
    category: 'api',
    name: 'Gzip compression',
    passed: encoding === 'gzip',
    clientMs: 0,
    detail: encoding ? `content-encoding: ${encoding}` : 'no gzip (send Accept-Encoding: gzip)',
  })

  return { biz, discover }
}

async function auditVendor(campaignId: string) {
  console.log('\n── Vendor flows ──\n')

  const row = await db.execute({
    sql: `SELECT u.id AS user_id, b.name FROM business_users u
          JOIN businesses b ON b.user_id = u.id
          JOIN campaigns c ON c.business_id = b.id AND c.status = 'active'
          ORDER BY b.name LIMIT 1`,
    args: [],
  })
  const v = row.rows[0] as { user_id: string; name: string }
  const token = signToken({ id: v.user_id, email: 'uat-audit@test.local', role: 'business' })
  const auth = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }

  const endpoints: { name: string; path: string; maxMs?: number }[] = [
    { name: 'Session', path: '/auth/session' },
    { name: 'Business profile', path: '/business/me' },
    { name: 'Dashboard stats', path: '/business/dashboard/stats' },
    { name: 'Campaigns list', path: '/campaigns' },
    { name: 'Campaign detail', path: `/campaigns/${campaignId}` },
    { name: 'Campaign PIN', path: `/campaigns/${campaignId}/pin`, maxMs: UAT_THRESHOLDS.pin },
    { name: 'Customers list', path: '/business/customers' },
    { name: 'Pending redemptions', path: '/business/redemptions/pending' },
  ]

  for (const ep of endpoints) {
    const maxMs = ep.maxMs ?? UAT_THRESHOLDS.vendorDefault
    const r = await timedFetch(`${API_BASE}${ep.path}`, { headers: auth })
    record('vendor', {
      category: 'vendor',
      name: ep.name,
      passed: r.status === 200 && r.ms <= maxMs,
      clientMs: Math.round(r.ms),
      bytes: r.bytes,
      status: r.status,
      estNetworkMs: report.baseline.estNetworkMedianMs,
      estAppDbMs: estAppDb(r.ms),
      detail: `${r.status} ${Math.round(r.ms)}ms ${(r.bytes / 1024).toFixed(1)}KB est.app+db≈${estAppDb(r.ms)}ms`,
    })
    console.log(`  ${r.status === 200 && r.ms <= maxMs ? '✓' : '✗'} ${ep.name}: ${Math.round(r.ms)}ms`)
  }
}

async function auditCustomer(bizId: string, campaigns: { id: string; mechanic: string }[]) {
  console.log('\n── Customer flows ──\n')

  const custRow = await db.execute({ sql: 'SELECT id FROM customer_users ORDER BY created_at DESC LIMIT 1', args: [] })
  const customerId = custRow.rows[0]?.id as string
  const token = signToken({ id: customerId, email: 'uat-audit@test.local', role: 'customer' })
  const auth = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }

  const shake = campaigns.find(c => c.mechanic === 'shake')
  const stamp = campaigns.find(c => c.mechanic === 'stamp')
  const loyalty = campaigns.find(c => c.mechanic === 'check-in-loyalty')

  const endpoints: { name: string; method?: string; path: string; body?: unknown; expect?: number; maxMs?: number }[] = [
    { name: 'Customer profile', path: '/customer/profile' },
    { name: 'Batch campaign states', path: `/campaigns/public/businesses/${bizId}/states` },
    { name: 'Wallet rewards', path: '/campaigns/customer/rewards' },
    { name: 'Loyalty profiles', path: '/campaigns/customer/loyalty-profile' },
    { name: 'Notifications', path: '/customer/notifications' },
  ]

  for (const ep of endpoints) {
    const maxMs = ep.maxMs ?? UAT_THRESHOLDS.customerDefault
    const r = await timedFetch(`${API_BASE}${ep.path}`, {
      method: ep.method,
      headers: auth,
      body: ep.body,
    })
    const expect = ep.expect ?? 200
    record('customer', {
      category: 'customer',
      name: ep.name,
      passed: r.status === expect && r.ms <= maxMs,
      clientMs: Math.round(r.ms),
      bytes: r.bytes,
      status: r.status,
      estAppDbMs: estAppDb(r.ms),
      detail: `${r.status} ${Math.round(r.ms)}ms est.app+db≈${estAppDb(r.ms)}ms${r.status !== expect ? ' (expected ' + expect + ')' : ''}`,
    })
    console.log(`  ${r.status === expect && r.ms <= maxMs ? '✓' : '✗'} ${ep.name}: ${Math.round(r.ms)}ms`)
  }

  if (shake) {
    const ps = await timedFetch(`${API_BASE}/campaigns/${shake.id}/play-state`, { headers: auth })
    record('customer', {
      category: 'customer',
      name: 'Shake play-state',
      passed: ps.status === 200 && ps.ms <= UAT_THRESHOLDS.customerDefault,
      clientMs: Math.round(ps.ms),
      status: ps.status,
      estAppDbMs: estAppDb(ps.ms),
      detail: `${ps.status} ${Math.round(ps.ms)}ms`,
    })
  }
  if (stamp) {
    const st = await timedFetch(`${API_BASE}/campaigns/${stamp.id}/stamp-state`, { headers: auth })
    record('customer', { category: 'customer', name: 'Stamp state', passed: st.status === 200 && st.ms <= UAT_THRESHOLDS.customerDefault, clientMs: Math.round(st.ms), status: st.status, detail: `${st.status} ${Math.round(st.ms)}ms` })
  }
  if (loyalty) {
    const ly = await timedFetch(`${API_BASE}/campaigns/${loyalty.id}/loyalty-state`, { headers: auth })
    record('customer', { category: 'customer', name: 'Loyalty state', passed: ly.status === 200 && ly.ms <= UAT_THRESHOLDS.customerDefault, clientMs: Math.round(ly.ms), status: ly.status, detail: `${ly.status} ${Math.round(ly.ms)}ms` })
  }

  if (shake) {
    const camp = await rotatePinIfExpired(shake.id)
    if (camp.pin) {
      const verify = await timedFetch(`${API_BASE}/campaigns/${shake.id}/verify-pin`, {
        method: 'POST',
        headers: auth,
        body: { pin: camp.pin },
      })
      record('customer', {
        category: 'customer',
        name: 'PIN verify',
        passed: verify.status === 200,
        clientMs: Math.round(verify.ms),
        status: verify.status,
        detail: `${verify.status} ${Math.round(verify.ms)}ms`,
      })
      const sessionToken = (verify.json as { data?: { playSessionToken?: string } })?.data?.playSessionToken
      if (sessionToken) {
        const play = await timedFetch(`${API_BASE}/campaigns/${shake.id}/shake`, {
          method: 'POST',
          headers: auth,
          body: { playSessionToken: sessionToken },
        })
        record('customer', {
          category: 'customer',
          name: 'Shake play',
          passed: play.status === 200 || play.status === 403,
          clientMs: Math.round(play.ms),
          status: play.status,
          detail: play.status === 403
            ? `${play.status} ${Math.round(play.ms)}ms — daily limit (business rule, not infra)`
            : `${play.status} ${Math.round(play.ms)}ms`,
        })
      }
    }
  }
}

async function auditPin(campaignId: string) {
  console.log('\n── PIN rotation ──\n')

  const vendorRow = await db.execute({
    sql: `SELECT u.id FROM business_users u JOIN businesses b ON b.user_id = u.id
          JOIN campaigns c ON c.business_id = b.id WHERE c.id = ? LIMIT 1`,
    args: [campaignId],
  })
  const vendorId = vendorRow.rows[0]?.id as string

  const before = await rotatePinIfExpired(campaignId)
  const oldPin = before.pin!
  await db.execute({
    sql: `UPDATE campaigns SET pin_expires_at = ?, pin = ? WHERE id = ?`,
    args: [new Date(Date.now() - 500).toISOString(), oldPin, campaignId],
  })

  const start = performance.now()
  let newPin: string | null = null
  let polls = 0
  while (performance.now() - start < UAT_THRESHOLDS.pinRotationSla) {
    polls++
    await rotatePinIfExpired(campaignId)
    const meta = await db.execute({ sql: 'SELECT pin, pin_expires_at FROM campaigns WHERE id = ?', args: [campaignId] })
    const pin = meta.rows[0]?.pin as string
    if (pin && pin !== oldPin) {
      newPin = pin
      break
    }
    await new Promise(r => setTimeout(r, 400))
  }
  const elapsed = performance.now() - start

  record('pin', {
    category: 'pin',
    name: 'PIN rotation within SLA',
    passed: Boolean(newPin),
    clientMs: Math.round(elapsed),
    detail: newPin ? `${Math.round(elapsed)}ms, ${polls} polls, ${oldPin}→${newPin}` : `timeout after ${polls} polls`,
  })
  console.log(`  ${newPin ? '✓' : '✗'} Rotation: ${Math.round(elapsed)}ms`)
}

async function auditFrontend() {
  console.log('\n── Frontend (Vercel) ──\n')

  try {
    const feStart = performance.now()
    const feRes = await fetch(FRONTEND_URL)
    const htmlText = await feRes.text()
    const feMs = performance.now() - feStart

    record('frontend', {
      category: 'frontend',
      name: 'Vercel app loads',
      passed: feRes.status === 200,
      clientMs: Math.round(feMs),
      status: feRes.status,
      detail: `${feRes.status} ${Math.round(feMs)}ms`,
    })

    const scriptMatch = htmlText.match(/src="(\/assets\/index-[^"]+\.js)"/)
    let bundleText = htmlText
    if (scriptMatch?.[1]) {
      const jsRes = await fetch(`${FRONTEND_URL}${scriptMatch[1]}`)
      bundleText = await jsRes.text()
    }

    const hasApi =
      bundleText.includes('loyalgenie-backend-uat.onrender.com') ||
      bundleText.includes('onrender.com/api')
    const hasSupabase = bundleText.includes('supabase.co')

    record('frontend', {
      category: 'frontend',
      name: 'Bundle references UAT API',
      passed: hasApi,
      clientMs: 0,
      detail: hasApi ? 'Render API URL in JS bundle ✓' : 'UAT API URL not in bundle — check VITE_API_URL on Vercel',
    })
    record('frontend', {
      category: 'frontend',
      name: 'Bundle references Supabase',
      passed: hasSupabase,
      clientMs: 0,
      detail: hasSupabase ? 'Supabase URL in JS bundle ✓' : 'Missing — check VITE_SUPABASE_URL on Vercel',
    })

    const cors = await timedFetch(`${API_BASE}/health`)
    const corsJson = cors.json as { corsOrigins?: string[] }
    const corsOk = (corsJson.corsOrigins ?? []).some(o => o.includes('loyalgenie-uat.vercel.app'))
    record('frontend', {
      category: 'frontend',
      name: 'CORS allows UAT frontend',
      passed: corsOk,
      clientMs: 0,
      detail: corsOk ? 'loyalgenie-uat.vercel.app in corsOrigins' : `missing: ${(corsJson.corsOrigins ?? []).join(', ')}`,
    })
  } catch (err) {
    record('frontend', {
      category: 'frontend',
      name: 'Vercel app loads',
      passed: false,
      clientMs: 0,
      detail: String(err),
    })
  }
}

function finalizeSummary() {
  const all = [...report.infra, ...report.api, ...report.vendor, ...report.customer, ...report.pin, ...report.frontend]
  const passed = all.filter(e => e.passed).length
  report.summary = {
    total: all.length,
    passed,
    failed: all.length - passed,
    categories: {},
  }
  for (const cat of ['infra', 'api', 'vendor', 'customer', 'pin', 'frontend'] as const) {
    const items = report[cat]
    report.summary.categories[cat] = {
      passed: items.filter(i => i.passed).length,
      total: items.length,
    }
  }
}

async function main() {
  console.log('\n══════════════════════════════════════════════════')
  console.log('  Loyal Genie — UAT E2E Audit')
  console.log('══════════════════════════════════════════════════')
  console.log(`\nAPI:      ${API_BASE}`)
  console.log(`Frontend: ${FRONTEND_URL}`)
  console.log(`Thresholds: UAT remote (not localhost)\n`)

  await measureBaseline()
  await auditInfra()
  const { biz } = await auditApiEndpoints()
  if (!biz) throw new Error('No businesses on discover')

  const campRow = await db.execute({
    sql: `SELECT id FROM campaigns WHERE business_id = ? AND status = 'active' LIMIT 1`,
    args: [biz.id],
  })
  const campaignId = campRow.rows[0]?.id as string

  await auditVendor(campaignId)
  await auditCustomer(biz.id, biz.campaigns)
  await auditPin(campaignId)
  await auditFrontend()

  finalizeSummary()

  const outPath = join(REPO_ROOT, 'docs/uat-audit-report.json')
  mkdirSync(dirname(outPath), { recursive: true })
  writeFileSync(outPath, JSON.stringify(report, null, 2))

  console.log('\n══════════════════════════════════════════════════')
  console.log(`UAT Audit: ${report.summary.passed}/${report.summary.total} passed`)
  for (const [cat, s] of Object.entries(report.summary.categories)) {
    console.log(`  ${cat}: ${s.passed}/${s.total}`)
  }
  console.log(`\nReport: docs/uat-audit-report.json`)
  console.log(`Baseline: network≈${report.baseline.estNetworkMedianMs}ms | server.db≈${report.baseline.serverDbMedianMs}ms`)
  console.log('══════════════════════════════════════════════════\n')

  await closePool()
  process.exit(report.summary.failed > 0 ? 1 : 0)
}

main().catch(async err => {
  console.error(err)
  await closePool().catch(() => {})
  process.exit(1)
})
