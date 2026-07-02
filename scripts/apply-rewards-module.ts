/**
 * Apply standalone rewards module schema patch.
 * Run: npm run db:apply-rewards-module
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
    join(__dirname, '../migrations/005_rewards_module.sql'),
    join(__dirname, '../../supabase/migrations/005_rewards_module.sql'),
  ]
  for (const file of candidates) {
    if (existsSync(file)) return file
  }
  throw new Error('005_rewards_module.sql not found in backend/migrations or supabase/migrations')
}

async function main() {
  const migrationFile = resolveMigrationFile()
  console.log('Applying rewards module migration...')
  const sql = readFileSync(migrationFile, 'utf8')
  await pool.query(sql)
  console.log('Rewards module migration applied.')
  await closePool()
}

main().catch(async err => {
  console.error('Rewards module migration failed:', err)
  await closePool().catch(() => {})
  process.exit(1)
})
