/**
 * Enable Supabase Realtime publication (Phase 4).
 * Run: npm run db:enable-realtime
 */
import { readFileSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'
import dotenv from 'dotenv'
import { closePool, pool } from '../src/db/client.js'

dotenv.config()

const __dirname = dirname(fileURLToPath(import.meta.url))
const file = join(__dirname, '../../supabase/migrations/002_realtime.sql')

async function main() {
  const sql = readFileSync(file, 'utf8')
  await pool.query(sql)
  console.log('Realtime publication updated.')
  await closePool()
}

main().catch(async err => {
  console.error(err)
  await closePool().catch(() => {})
  process.exit(1)
})
