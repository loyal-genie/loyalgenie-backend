/**
 * Enable extended Supabase Realtime tables (game_plays, stamp_cards, loyalty_cards).
 * Run after db:enable-realtime.
 */
import { readFileSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'
import dotenv from 'dotenv'
import { closePool, pool } from '../src/db/client.js'

dotenv.config()

const __dirname = dirname(fileURLToPath(import.meta.url))
const file = join(__dirname, '../../supabase/migrations/004_realtime_extended.sql')

async function main() {
  const sql = readFileSync(file, 'utf8')
  await pool.query(sql)
  console.log('Extended Realtime publication updated (game_plays, stamp_cards, loyalty_cards).')
  await closePool()
}

main().catch(async err => {
  console.error(err)
  await closePool().catch(() => {})
  process.exit(1)
})
