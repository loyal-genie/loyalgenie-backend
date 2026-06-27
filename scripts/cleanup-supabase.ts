/**
 * Wipe all application data from Supabase Postgres (keeps schema + schema_patches).
 *
 * Usage:
 *   CONFIRM=yes npm run db:cleanup
 *
 * Requires DATABASE_URL in backend/.env
 */
import dotenv from 'dotenv'
import { closePool, pool } from '../src/db/client.js'

dotenv.config()

const TABLES = [
  'loyalty_milestone_awards',
  'loyalty_cards',
  'stamp_cards',
  'customer_rewards',
  'game_plays',
  'campaign_participations',
  'campaign_rewards',
  'campaigns',
  'branches',
  'businesses',
  'business_users',
  'otp_verifications',
  'password_reset_tokens',
  'customer_users',
] as const

async function main() {
  if (process.env.CONFIRM?.trim().toLowerCase() !== 'yes') {
    console.error('Refusing to run without CONFIRM=yes')
    console.error('Example: CONFIRM=yes npm run db:cleanup')
    process.exit(1)
  }

  const dbUrl = process.env.DATABASE_URL?.trim()
  if (!dbUrl) {
    console.error('DATABASE_URL is not set in backend/.env')
    process.exit(1)
  }

  console.log('This will DELETE ALL ROWS from:')
  for (const table of TABLES) console.log(`  - ${table}`)
  console.log('(schema_patches is preserved)\n')

  const sql = `TRUNCATE TABLE ${TABLES.join(', ')} RESTART IDENTITY CASCADE`
  await pool.query(sql)

  console.log('Supabase data cleanup complete.')
  await closePool()
}

main().catch(async err => {
  console.error(err)
  await closePool().catch(() => {})
  process.exit(1)
})
