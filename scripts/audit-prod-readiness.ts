/**
 * Production readiness audit — Supabase data vs R2 images.
 * Run: npx tsx scripts/audit-prod-readiness.ts
 */
import dotenv from 'dotenv'
import { closePool, pool } from '../src/db/client.js'

dotenv.config()

const R2_PUBLIC = (process.env.R2_PUBLIC_URL ?? '').replace(/\/$/, '')

interface Check {
  name: string
  passed: boolean
  detail: string
}

const checks: Check[] = []

function check(name: string, passed: boolean, detail: string) {
  checks.push({ name, passed, detail })
  console.log(`${passed ? '✓' : '✗'} ${name}\n    ${detail}`)
}

async function tableExists(table: string): Promise<boolean> {
  const r = await pool.query(
    `SELECT EXISTS (
       SELECT 1 FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = $1
     ) AS ok`,
    [table],
  )
  return Boolean(r.rows[0]?.ok)
}

async function columnExists(table: string, column: string): Promise<boolean> {
  const r = await pool.query(
    `SELECT EXISTS (
       SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2
     ) AS ok`,
    [table, column],
  )
  return Boolean(r.rows[0]?.ok)
}

async function countTable(table: string): Promise<number> {
  if (!(await tableExists(table))) return -1
  const r = await pool.query(`SELECT COUNT(*)::int AS c FROM ${table}`)
  return Number(r.rows[0]?.c ?? 0)
}

async function auditSchema() {
  console.log('\n── Schema & migrations ──\n')

  const coreTables = [
    'business_users', 'businesses', 'branches', 'customer_users',
    'campaigns', 'campaign_rewards', 'campaign_participations',
    'game_plays', 'customer_rewards', 'stamp_cards', 'loyalty_cards',
  ]
  for (const t of coreTables) {
    const exists = await tableExists(t)
    check(`Table ${t}`, exists, exists ? 'present' : 'MISSING')
  }

  const blobCols = ['logo_data', 'cover_banner_data', 'interior_photos_data', 'exterior_photos_data']
  for (const col of blobCols) {
    const exists = await columnExists('businesses', col)
    check(`Blob column dropped: businesses.${col}`, !exists, exists ? 'STILL EXISTS — run db:drop-blobs' : 'dropped ✓')
  }

  const urlCols = ['logo_url', 'cover_banner_url', 'interior_photo_urls', 'exterior_photo_urls']
  for (const col of urlCols) {
    const exists = await columnExists('businesses', col)
    check(`URL column: businesses.${col}`, exists, exists ? 'present' : 'MISSING')
  }

  const pub = await pool.query(
    `SELECT tablename FROM pg_publication_tables WHERE pubname = 'supabase_realtime' ORDER BY tablename`,
  )
  const rtTables = pub.rows.map(r => r.tablename as string)
  check('Realtime: campaigns', rtTables.includes('campaigns'), rtTables.join(', ') || 'none')
  check('Realtime: customer_rewards', rtTables.includes('customer_rewards'), rtTables.join(', ') || 'none')
}

async function auditData() {
  console.log('\n── Data integrity (Turso import) ──\n')

  const counts: Record<string, number> = {}
  for (const t of [
    'businesses', 'campaigns', 'customer_users', 'game_plays',
    'customer_rewards', 'stamp_cards', 'loyalty_cards', 'campaign_participations',
  ]) {
    counts[t] = await countTable(t)
    check(`Row count: ${t}`, counts[t] >= 0, counts[t] >= 0 ? String(counts[t]) : 'table missing')
  }

  const hasData = counts.businesses > 0 && counts.campaigns > 0
  check('Imported data present', hasData, `${counts.businesses} businesses, ${counts.campaigns} campaigns`)
}

async function auditImages() {
  console.log('\n── Images: R2 URLs only (no base64 in DB) ──\n')

  const stats = await pool.query<{
    total: string
    logo_url: string
    cover_url: string
    interior_urls: string
    exterior_urls: string
    any_base64_logo: string
    any_base64_cover: string
  }>(`
    SELECT
      COUNT(*)::text AS total,
      COUNT(*) FILTER (WHERE logo_url IS NOT NULL AND logo_url <> '')::text AS logo_url,
      COUNT(*) FILTER (WHERE cover_banner_url IS NOT NULL AND cover_banner_url <> '')::text AS cover_url,
      COUNT(*) FILTER (
        WHERE interior_photo_urls IS NOT NULL
          AND interior_photo_urls <> '[]'
          AND interior_photo_urls <> ''
      )::text AS interior_urls,
      COUNT(*) FILTER (
        WHERE exterior_photo_urls IS NOT NULL
          AND exterior_photo_urls <> '[]'
          AND exterior_photo_urls <> ''
      )::text AS exterior_urls,
      COUNT(*) FILTER (WHERE logo_url LIKE 'data:%')::text AS any_base64_logo,
      COUNT(*) FILTER (WHERE cover_banner_url LIKE 'data:%')::text AS any_base64_cover
    FROM businesses
  `)

  const s = stats.rows[0]
  check('No base64 in logo_url', Number(s?.any_base64_logo ?? 0) === 0, `base64 rows: ${s?.any_base64_logo}`)
  check('No base64 in cover_banner_url', Number(s?.any_base64_cover ?? 0) === 0, `base64 rows: ${s?.any_base64_cover}`)

  const r2Rows = await pool.query<{ cnt: string }>(
    `SELECT COUNT(*)::text AS cnt FROM businesses
     WHERE (logo_url LIKE $1 OR cover_banner_url LIKE $1
            OR interior_photo_urls LIKE $2 OR exterior_photo_urls LIKE $2)`,
    [`${R2_PUBLIC}%`, `%${R2_PUBLIC}%`],
  )
  const r2Count = Number(r2Rows.rows[0]?.cnt ?? 0)
  check(
    'Businesses with R2-hosted images',
    r2Count > 0,
    `${r2Count} of ${s?.total} businesses have R2 URLs (${s?.logo_url} logos, ${s?.cover_url} covers)`,
  )

  // Sample URL reachability (up to 5)
  const samples = await pool.query<{ name: string; logo_url: string }>(
    `SELECT name, logo_url FROM businesses
     WHERE logo_url LIKE $1 LIMIT 5`,
    [`${R2_PUBLIC}%`],
  )
  let reachable = 0
  for (const row of samples.rows) {
    try {
      const res = await fetch(row.logo_url, { method: 'HEAD' })
      if (res.ok) reachable++
    } catch { /* ignore */ }
  }
  check(
    'R2 image URLs reachable (sample)',
    samples.rows.length === 0 || reachable === samples.rows.length,
    `${reachable}/${samples.rows.length} sample logos return HTTP 2xx`,
  )
}

async function auditCampaigns() {
  console.log('\n── Campaign mechanics coverage ──\n')

  const mech = await pool.query<{ mechanic: string; cnt: string; active: string }>(`
    SELECT mechanic, COUNT(*)::text AS cnt,
           COUNT(*) FILTER (WHERE status = 'active')::text AS active
    FROM campaigns GROUP BY mechanic ORDER BY mechanic
  `)
  for (const row of mech.rows) {
    check(`Mechanic: ${row.mechanic}`, Number(row.cnt) > 0, `${row.cnt} total, ${row.active} active`)
  }

  const pin = await pool.query<{ with_pin: string; active_with_pin: string }>(`
    SELECT
      COUNT(*) FILTER (WHERE pin IS NOT NULL)::text AS with_pin,
      COUNT(*) FILTER (WHERE status = 'active' AND pin IS NOT NULL)::text AS active_with_pin
    FROM campaigns
  `)
  check(
    'Active campaigns have PINs',
    Number(pin.rows[0]?.active_with_pin ?? 0) > 0,
    `${pin.rows[0]?.active_with_pin} active with PIN of ${pin.rows[0]?.with_pin} total`,
  )
}

async function main() {
  console.log('\n═══ Loyal Genie — Production DB Audit ═══\n')
  console.log(`R2 public base: ${R2_PUBLIC || '(not set)'}`)

  await auditSchema()
  await auditData()
  await auditImages()
  await auditCampaigns()

  const failed = checks.filter(c => !c.passed)
  console.log('\n══════════════════════════════════════════════════')
  console.log(`Results: ${checks.length - failed.length}/${checks.length} passed`)
  if (failed.length) {
    console.log('\nFailed:')
    for (const f of failed) console.log(`  ✗ ${f.name}: ${f.detail}`)
    await closePool()
    process.exit(1)
  }
  console.log('\nDB audit: PASS')
  await closePool()
}

main().catch(async err => {
  console.error(err)
  await closePool().catch(() => {})
  process.exit(1)
})
