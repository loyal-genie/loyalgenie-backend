import pg from 'pg'
import dotenv from 'dotenv'

dotenv.config()

const { Pool } = pg

/**
 * Prefer Supabase Transaction pooler (:6543) over Session (:5432).
 * Session mode caps ~15 clients across ALL apps (local + Render) → EMAXCONNSESSION.
 */
function getConnectionString(): string {
  const url = process.env.DATABASE_URL?.trim()
  if (!url) {
    throw new Error('DATABASE_URL must be set in .env (Supabase Postgres connection string)')
  }

  const forceSession = process.env.DATABASE_POOL_MODE === 'session'
  if (forceSession) return url

  try {
    const parsed = new URL(url)
    const isSupabasePooler = parsed.hostname.includes('pooler.supabase.com')
    if (isSupabasePooler && parsed.port === '5432') {
      parsed.port = '6543'
      console.warn(
        '[db] Switched Supabase pooler 5432→6543 (transaction mode). Set DATABASE_POOL_MODE=session to keep session mode.',
      )
      return parsed.toString()
    }
  } catch {
    /* use original url */
  }

  return url
}

const isProd = process.env.NODE_ENV === 'production'

export const pool = new Pool({
  connectionString: getConnectionString(),
  ssl: isProd || process.env.DATABASE_URL?.includes('supabase')
    ? { rejectUnauthorized: false }
    : undefined,
  // Keep tiny — session pooler is shared; transaction mode still benefits from a small pool.
  max: Number(process.env.PG_POOL_MAX ?? (isProd ? 2 : 3)),
  idleTimeoutMillis: Number(process.env.PG_IDLE_TIMEOUT_MS ?? 10_000),
  connectionTimeoutMillis: Number(process.env.PG_CONNECT_TIMEOUT_MS ?? 15_000),
  allowExitOnIdle: true,
})

pool.on('error', (err: Error) => {
  console.error('Unexpected Postgres pool error:', err)
})

export interface DbExecuteResult {
  rows: Record<string, unknown>[]
  rowCount: number
}

export interface DbStatement {
  sql: string
  args?: unknown[]
}

/** Convert SQLite-style placeholders and functions to Postgres. */
export function convertSql(sql: string): string {
  let converted = sql

  converted = converted.replace(
    /datetime\('now',\s*'-(\d+) days'\)/gi,
    "NOW() - INTERVAL '$1 days'",
  )
  converted = converted.replace(
    /datetime\('now',\s*'\+(\d+) days'\)/gi,
    "NOW() + INTERVAL '$1 days'",
  )
  // Parameterized SQLite offset (arg is e.g. '-7 days') → Postgres interval
  converted = converted.replace(
    /datetime\('now',\s*\?\)/gi,
    '(NOW() + (?::interval))',
  )
  converted = converted.replace(
    /datetime\('now'\)/gi,
    "to_char(NOW() AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM-DD\"T\"HH24:MI:SS')",
  )

  converted = converted.replace(
    /date\(\s*([^,]+),\s*'\+5 hours',\s*'\+30 minutes'\s*\)/gi,
    "(($1)::timestamptz AT TIME ZONE 'Asia/Kolkata')::date",
  )

  converted = converted.replace(
    /\bdate\(\s*'now',\s*'\+5 hours',\s*'\+30 minutes'\s*\)/gi,
    "(NOW() AT TIME ZONE 'Asia/Kolkata')::date",
  )

  converted = converted.replace(/\bdate\(\s*([^)]+)\)/gi, '(($1)::timestamptz)::date')

  let index = 0
  converted = converted.replace(/\?/g, () => `$${++index}`)

  return converted
}

export async function execute(input: string | DbStatement): Promise<DbExecuteResult> {
  const statement = typeof input === 'string' ? { sql: input } : input
  const sql = convertSql(statement.sql)
  const args = statement.args ?? []
  const result = await pool.query(sql, args)
  return { rows: result.rows as Record<string, unknown>[], rowCount: result.rowCount ?? 0 }
}

export async function batch(statements: DbStatement[]): Promise<void> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    for (const statement of statements) {
      const sql = convertSql(statement.sql)
      await client.query(sql, statement.args ?? [])
    }
    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
}

/** @deprecated Use apply-schema script instead of runtime migrations. */
export async function executeMultiple(sqlBlock: string): Promise<void> {
  const statements = sqlBlock
    .split(';')
    .map(s => s.trim())
    .filter(s => s.length > 0 && !s.startsWith('--'))

  for (const statement of statements) {
    await execute(statement)
  }
}

/** Backwards-compatible export used across services. */
export const db = {
  execute,
  batch,
  executeMultiple,
}

export async function verifyDatabaseConnection(retries = 5): Promise<void> {
  let lastError: unknown
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      await execute('SELECT 1')
      return
    } catch (err) {
      lastError = err
      const delayMs = Math.min(1000 * 2 ** (attempt - 1), 8000)
      console.error(
        `Database connection failed (attempt ${attempt}/${retries}):`,
        err instanceof Error ? err.message : err,
      )
      if (attempt < retries) await new Promise(r => setTimeout(r, delayMs))
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error('Database connection failed after retries')
}

export async function closePool(): Promise<void> {
  await pool.end()
}
