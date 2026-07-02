import { existsSync, readFileSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'
import { pool } from './client.js'

const MIGRATION_FILES = [
  '001_initial_schema.sql',
  '002_realtime.sql',
  '003_drop_blob_columns.sql',
  '004_realtime_extended.sql',
  '005_rewards_module.sql',
] as const

function resolveMigrationsDir(): string {
  const moduleDir = dirname(fileURLToPath(import.meta.url))
  const candidates = [
    join(process.cwd(), 'migrations'),
    join(process.cwd(), 'supabase/migrations'),
    join(process.cwd(), '../supabase/migrations'),
    join(moduleDir, '../../migrations'),
    join(moduleDir, '../../../supabase/migrations'),
  ]

  for (const dir of candidates) {
    if (existsSync(join(dir, '001_initial_schema.sql'))) {
      return dir
    }
  }

  throw new Error(
    'Migrations directory not found. Expected backend/migrations or supabase/migrations.',
  )
}

async function applySqlFile(filePath: string, label: string): Promise<void> {
  const sql = readFileSync(filePath, 'utf8')
  try {
    await pool.query(sql)
    console.log(`[db] Applied ${label}`)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (message.includes('already member of publication')) {
      console.warn(`[db] Skipped ${label}: ${message}`)
      return
    }
    throw error
  }
}

/** Idempotent schema/realtime/rewards patches — safe to run on every deploy. */
export async function applyPendingMigrations(): Promise<void> {
  if (process.env.SKIP_DB_MIGRATIONS === 'true') {
    console.log('[db] SKIP_DB_MIGRATIONS=true — skipping startup migrations')
    return
  }

  const dir = resolveMigrationsDir()
  console.log(`[db] Applying migrations from ${dir}`)

  for (const file of MIGRATION_FILES) {
    await applySqlFile(join(dir, file), file)
  }

  console.log('[db] All migrations up to date')
}
