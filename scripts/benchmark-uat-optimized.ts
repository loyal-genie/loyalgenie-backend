/**
 * Post-deploy UAT benchmark — cache + optimized endpoints.
 * Run: npx tsx scripts/benchmark-uat-optimized.ts
 */
import dotenv from 'dotenv'
import { signToken } from '../src/services/auth.js'
import { db, closePool } from '../src/db/client.js'

dotenv.config()

const API = (process.env.API_BASE_URL ?? 'https://loyalgenie-backend-uat.onrender.com/api').replace(/\/$/, '')

async function timed(label: string, path: string, token: string) {
  const start = performance.now()
  const res = await fetch(`${API}${path}`, { headers: { Authorization: `Bearer ${token}` } })
  const ms = performance.now() - start
  console.log(`${label}: ${ms.toFixed(0)}ms (HTTP ${res.status})`)
  return ms
}

async function main() {
  console.log('\n═══ UAT optimized endpoint benchmark ═══\n')

  const v = await db.execute({
    sql: `SELECT u.id AS user_id, c.id AS campaign_id, c.business_id
          FROM business_users u
          JOIN businesses b ON b.user_id = u.id
          JOIN campaigns c ON c.business_id = b.id AND c.status = 'active'
          LIMIT 1`,
    args: [],
  })
  const row = v.rows[0] as { user_id: string; campaign_id: string; business_id: string }
  const vendorToken = signToken({ id: row.user_id, email: 'bench@test.local', role: 'business' })

  const cust = await db.execute({ sql: 'SELECT id FROM customer_users LIMIT 1', args: [] })
  const customerToken = signToken({
    id: cust.rows[0]!.id as string,
    email: 'bench@test.local',
    role: 'customer',
  })

  console.log('Dashboard stats (30s cache):')
  const d1 = await timed('  1st call (cold)', '/business/dashboard/stats', vendorToken)
  const d2 = await timed('  2nd call (warm)', '/business/dashboard/stats', vendorToken)
  const d3 = await timed('  3rd call (warm)', '/business/dashboard/stats', vendorToken)

  console.log('\nCampaigns list (batched + 30s cache):')
  const c1 = await timed('  1st call (cold)', '/campaigns', vendorToken)
  const c2 = await timed('  2nd call (warm cache)', '/campaigns', vendorToken)
  const c3 = await timed('  3rd call (warm cache)', '/campaigns', vendorToken)

  console.log('\nPublic campaign (lightweight):')
  const p1 = await timed('  1st call', `/campaigns/public/${row.campaign_id}`, customerToken)
  const p2 = await timed('  2nd call', `/campaigns/public/${row.campaign_id}`, customerToken)

  console.log('\nBatch campaign states:')
  const s1 = await timed('  1st call', `/campaigns/public/businesses/${row.business_id}/states`, customerToken)
  const s2 = await timed('  2nd call', `/campaigns/public/businesses/${row.business_id}/states`, customerToken)

  const cacheGain = d1 > 0 ? ((d1 - d2) / d1 * 100).toFixed(0) : '0'
  const campaignsCacheGain = c1 > 0 ? ((c1 - c2) / c1 * 100).toFixed(0) : '0'
  console.log(`\nDashboard cache gain: ${cacheGain}% (${d1.toFixed(0)}ms → ${d2.toFixed(0)}ms)`)
  console.log(`Campaigns cache gain: ${campaignsCacheGain}% (${c1.toFixed(0)}ms → ${c2.toFixed(0)}ms)`)
  console.log('══════════════════════════════════════════════════\n')

  await closePool()
}

main().catch(async err => {
  console.error(err)
  await closePool().catch(() => {})
  process.exit(1)
})
