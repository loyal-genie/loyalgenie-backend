/**
 * Full Turso SQLite export → Supabase Postgres + Cloudflare R2 migration.
 *
 * - Uploads business images (base64 in SQLite) to R2
 * - Stores public URLs in Postgres (blobs left NULL for fast queries)
 * - Imports all other tables
 *
 * Usage:
 *   npm run db:import -- "../loyalgenie (1).db"
 *   npm run db:import -- "../loyalgenie (1).db" --fresh   # wipe Postgres first
 */
import { existsSync } from 'fs'
import { resolve } from 'path'
import dotenv from 'dotenv'
import Database from 'better-sqlite3'
import { closePool, pool } from '../src/db/client.js'
import { parsePhotoArray } from '../src/utils/business-media.js'
import { parseDataUrl, uploadBufferToR2, uploadDataUrlToR2 } from '../src/services/r2-storage.js'

dotenv.config()

const TABLES_AFTER_BUSINESSES = [
  'branches',
  'customer_users',
  'password_reset_tokens',
  'campaigns',
  'campaign_rewards',
  'campaign_participations',
  'game_plays',
  'customer_rewards',
  'stamp_cards',
  'loyalty_cards',
  'loyalty_milestone_awards',
  'otp_verifications',
  'schema_patches',
] as const

const BLOB_COLUMNS = new Set([
  'logo_data',
  'cover_banner_data',
  'interior_photos_data',
  'exterior_photos_data',
])

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`
}

async function clearPostgres(): Promise<void> {
  console.log('Clearing existing Postgres data...')
  await pool.query(`
    TRUNCATE TABLE
      loyalty_milestone_awards,
      loyalty_cards,
      stamp_cards,
      customer_rewards,
      game_plays,
      campaign_participations,
      campaign_rewards,
      campaigns,
      otp_verifications,
      password_reset_tokens,
      branches,
      businesses,
      business_users,
      customer_users,
      schema_patches
    CASCADE
  `)
}

async function migrateBusinessImages(
  businessId: string,
  row: Record<string, unknown>,
): Promise<{
  logo_url: string | null
  cover_banner_url: string | null
  cover_thumbnail_url: string | null
  interior_photo_urls: string
  exterior_photo_urls: string
}> {
  const logoUrl = await uploadDataUrlToR2(
    `businesses/${businessId}/logo`,
    row.logo_data as string | null,
  )

  const coverUrl = await uploadDataUrlToR2(
    `businesses/${businessId}/cover`,
    row.cover_banner_data as string | null,
  )

  let coverThumbnailUrl: string | null = null
  const coverParsed = parseDataUrl(row.cover_banner_data as string | null)
  if (coverParsed && coverParsed.buffer.length > 0) {
    // Same file as cover for now — Phase 3 can add real thumbnails
    coverThumbnailUrl = await uploadBufferToR2(
      `businesses/${businessId}/cover-thumb.${coverParsed.ext}`,
      coverParsed.buffer,
      coverParsed.contentType,
    )
  }

  const interiorUrls: string[] = []
  for (const [index, dataUrl] of parsePhotoArray(row.interior_photos_data).entries()) {
    const url = await uploadDataUrlToR2(
      `businesses/${businessId}/interior/${index}`,
      dataUrl,
    )
    if (url) interiorUrls.push(url)
  }

  const exteriorUrls: string[] = []
  for (const [index, dataUrl] of parsePhotoArray(row.exterior_photos_data).entries()) {
    const url = await uploadDataUrlToR2(
      `businesses/${businessId}/exterior/${index}`,
      dataUrl,
    )
    if (url) exteriorUrls.push(url)
  }

  return {
    logo_url: logoUrl,
    cover_banner_url: coverUrl,
    cover_thumbnail_url: coverThumbnailUrl,
    interior_photo_urls: JSON.stringify(interiorUrls),
    exterior_photo_urls: JSON.stringify(exteriorUrls),
  }
}

async function importBusinesses(sqlite: Database.Database): Promise<number> {
  const sqliteColumns = sqlite
    .prepare('PRAGMA table_info(businesses)')
    .all() as { name: string }[]

  const pgCols = await pool.query(
    `SELECT column_name FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'businesses'`,
  )
  const pgColSet = new Set(pgCols.rows.map(r => r.column_name as string))

  const baseColNames = sqliteColumns
    .map(c => c.name)
    .filter(name => pgColSet.has(name) && !BLOB_COLUMNS.has(name))

  const insertCols = [
    ...baseColNames,
    'logo_url',
    'cover_banner_url',
    'cover_thumbnail_url',
    'interior_photo_urls',
    'exterior_photo_urls',
  ]

  const placeholders = insertCols.map((_, i) => `$${i + 1}`).join(', ')
  const insertSql = `INSERT INTO businesses (${insertCols.map(quoteIdent).join(', ')})
    VALUES (${placeholders})
    ON CONFLICT (id) DO UPDATE SET
      logo_url = EXCLUDED.logo_url,
      cover_banner_url = EXCLUDED.cover_banner_url,
      cover_thumbnail_url = EXCLUDED.cover_thumbnail_url,
      interior_photo_urls = EXCLUDED.interior_photo_urls,
      exterior_photo_urls = EXCLUDED.exterior_photo_urls`

  const rows = sqlite.prepare('SELECT * FROM businesses').all() as Record<string, unknown>[]
  let uploaded = 0

  for (const row of rows) {
    const businessId = row.id as string
    const images = await migrateBusinessImages(businessId, row)

    if (images.logo_url || images.cover_banner_url || images.interior_photo_urls !== '[]') {
      uploaded++
      console.log(`  images → R2: ${row.name as string} (${businessId})`)
    }

    const values = [
      ...baseColNames.map(col => row[col] ?? null),
      images.logo_url,
      images.cover_banner_url,
      images.cover_thumbnail_url,
      images.interior_photo_urls,
      images.exterior_photo_urls,
    ]

    await pool.query(insertSql, values)
  }

  console.log(`  businesses: ${rows.length} rows (${uploaded} with images uploaded to R2)`)
  return rows.length
}

async function importTable(sqlite: Database.Database, table: string): Promise<number> {
  const sqliteColumns = sqlite
    .prepare(`PRAGMA table_info(${table})`)
    .all() as { name: string }[]

  if (sqliteColumns.length === 0) {
    console.log(`  skip ${table} (not in export)`)
    return 0
  }

  const pgCols = await pool.query(
    `SELECT column_name FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = $1`,
    [table],
  )
  const pgColSet = new Set(pgCols.rows.map(r => r.column_name as string))
  const colNames = sqliteColumns.map(c => c.name).filter(name => pgColSet.has(name))

  if (colNames.length === 0) {
    console.log(`  skip ${table} (no matching columns)`)
    return 0
  }

  const rows = sqlite.prepare(`SELECT * FROM ${table}`).all() as Record<string, unknown>[]
  if (rows.length === 0) {
    console.log(`  ${table}: 0 rows`)
    return 0
  }

  const placeholders = colNames.map((_, i) => `$${i + 1}`).join(', ')
  const insertSql = `INSERT INTO ${quoteIdent(table)} (${colNames.map(quoteIdent).join(', ')})
    VALUES (${placeholders})
    ON CONFLICT DO NOTHING`

  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    for (const row of rows) {
      const values = colNames.map(col => row[col] ?? null)
      await client.query(insertSql, values)
    }
    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }

  console.log(`  ${table}: ${rows.length} rows`)
  return rows.length
}

async function ensureStubCustomers(sqlite: Database.Database): Promise<number> {
  const tablesWithCustomer = [
    'campaign_participations',
    'game_plays',
    'stamp_cards',
    'loyalty_cards',
    'customer_rewards',
  ] as const

  const referenced = new Set<string>()
  for (const table of tablesWithCustomer) {
    try {
      const rows = sqlite
        .prepare(`SELECT DISTINCT customer_id AS id FROM ${table} WHERE customer_id IS NOT NULL`)
        .all() as { id: string }[]
      for (const row of rows) referenced.add(row.id)
    } catch {
      /* table missing in export */
    }
  }

  const existing = new Set(
    (sqlite.prepare('SELECT id FROM customer_users').all() as { id: string }[]).map(r => r.id),
  )

  const missing = [...referenced].filter(id => !existing.has(id))
  if (missing.length === 0) return 0

  let counter = 0
  for (const id of missing) {
    counter++
    const phone = `+9198888${String(counter).padStart(6, '0')}`
    await pool.query(
      `INSERT INTO customer_users (id, name, phone, profile_complete, phone_verified)
       VALUES ($1, $2, $3, 1, 1)
       ON CONFLICT (id) DO NOTHING`,
      [id, 'Imported Player', phone],
    )
  }

  console.log(`  stub customer_users: ${missing.length} rows (from game/stamp data)`)
  return missing.length
}

async function main() {
  const args = process.argv.slice(2)
  const fresh = args.includes('--fresh')
  const fileArg = args.find(a => !a.startsWith('--'))

  if (!fileArg) {
    console.error('Usage: npm run db:import -- /path/to/export.db [--fresh]')
    process.exit(1)
  }

  const dbPath = resolve(fileArg)
  if (!existsSync(dbPath)) {
    console.error(`File not found: ${dbPath}`)
    process.exit(1)
  }

  console.log(`Migrating Turso export → Supabase + R2`)
  console.log(`Source: ${dbPath}\n`)

  if (fresh) await clearPostgres()

  const sqlite = new Database(dbPath, { readonly: true })
  let total = 0

  try {
    console.log('Step 1: business_users')
    total += await importTable(sqlite, 'business_users')

    console.log('Step 2: businesses (images → R2, data → Postgres)')
    total += await importBusinesses(sqlite)

    console.log('Step 3: customer_users')
    total += await importTable(sqlite, 'customer_users')
    total += await ensureStubCustomers(sqlite)

    for (const table of TABLES_AFTER_BUSINESSES) {
      if (table === 'customer_users') continue
      console.log(`Step: ${table}`)
      total += await importTable(sqlite, table)
    }
  } catch (error) {
    console.error('Migration failed:', error)
    process.exit(1)
  } finally {
    sqlite.close()
  }

  const verify = await pool.query('SELECT COUNT(*)::int AS c FROM businesses')
  console.log(`\nMigration complete (${total} rows processed).`)
  console.log(`Postgres businesses: ${verify.rows[0].c}`)
  await closePool()
}

main().catch(async err => {
  console.error(err)
  await closePool().catch(() => {})
  process.exit(1)
})
