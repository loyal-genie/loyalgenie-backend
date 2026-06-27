/**
 * Drop legacy base64 image columns from businesses (Phase 4).
 * Run after R2 backfill: npm run db:drop-blobs
 */
import { readFileSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'
import dotenv from 'dotenv'
import { closePool, pool } from '../src/db/client.js'

dotenv.config()

const __dirname = dirname(fileURLToPath(import.meta.url))
const file = join(__dirname, '../../supabase/migrations/003_drop_blob_columns.sql')

async function countBlobRows(): Promise<number> {
  try {
    const remaining = await pool.query<{ cnt: string }>(
      `SELECT COUNT(*)::text AS cnt FROM businesses
       WHERE logo_data IS NOT NULL
          OR cover_banner_data IS NOT NULL
          OR interior_photos_data IS NOT NULL
          OR exterior_photos_data IS NOT NULL`,
    )
    return Number(remaining.rows[0]?.cnt ?? 0)
  } catch {
    return 0
  }
}

async function main() {
  const blobRows = await countBlobRows()
  if (blobRows > 0) {
    console.warn(`Warning: ${blobRows} businesses still have base64 in *_data columns.`)
    console.warn('Run db:import or upload images to R2 before dropping columns.')
  }

  const sql = readFileSync(file, 'utf8')
  await pool.query(sql)
  console.log('Dropped legacy *_data image columns from businesses.')
  await closePool()
}

main().catch(async err => {
  console.error(err)
  await closePool().catch(() => {})
  process.exit(1)
})
