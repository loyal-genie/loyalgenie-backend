/**
 * Apply campaign times + shake reward redeem-before columns.
 * Run: npm run db:apply-campaign-times
 */
import { existsSync, readFileSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'
import dotenv from 'dotenv'
import { closePool, pool } from '../src/db/client.js'

dotenv.config()

const __dirname = dirname(fileURLToPath(import.meta.url))

function resolveMigrationFile(): string {
  const candidates = [
    join(__dirname, '../migrations/006_campaign_times_reward_expiry.sql'),
    join(__dirname, '../../supabase/migrations/006_campaign_times_reward_expiry.sql'),
  ]
  for (const file of candidates) {
    if (existsSync(file)) return file
  }
  throw new Error('006_campaign_times_reward_expiry.sql not found')
}

async function main() {
  const migrationFile = resolveMigrationFile()
  console.log('Applying campaign times + reward expiry migration...')
  const sql = readFileSync(migrationFile, 'utf8')
  await pool.query(sql)
  console.log('Migration applied.')
  await closePool()
}

main().catch(async err => {
  console.error('Migration failed:', err)
  await closePool().catch(() => {})
  process.exit(1)
})
