/**
 * Apply Supabase Postgres schema from supabase/migrations/.
 * Run once: npm run db:apply-schema
 */
import { readFileSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'
import dotenv from 'dotenv'
import { closePool, execute, pool } from '../src/db/client.js'

dotenv.config()

const __dirname = dirname(fileURLToPath(import.meta.url))
const MIGRATION_FILE = join(__dirname, '../../supabase/migrations/001_initial_schema.sql')

async function isSchemaApplied(): Promise<boolean> {
  const result = await pool.query(`
    SELECT EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = 'businesses'
    ) AS exists
  `)
  return Boolean(result.rows[0]?.exists)
}

async function applyMigrationFile(): Promise<void> {
  const sql = readFileSync(MIGRATION_FILE, 'utf8')
  try {
    await pool.query(sql)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (message.includes('already member of publication')) {
      console.warn(`  skip: ${message}`)
      return
    }
    throw error
  }
}

async function main() {
  console.log('Applying Postgres schema...')
  await execute('SELECT 1')

  if (await isSchemaApplied()) {
    console.log('Schema already present — re-applying idempotent statements only.')
  }

  await applyMigrationFile()
  console.log('Schema applied successfully.')
  await closePool()
}

main().catch(async err => {
  console.error('Schema apply failed:', err)
  await closePool().catch(() => {})
  process.exit(1)
})
