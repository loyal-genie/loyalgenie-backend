import pg from 'pg'
import dotenv from 'dotenv'

dotenv.config()

const { Pool } = pg

function getConnectionString(): string {
  const url = process.env.DATABASE_URL?.trim()
  if (!url) {
    throw new Error('DATABASE_URL must be set in .env (Supabase Postgres connection string)')
  }
  return url
}

export const pool = new Pool({
  connectionString: getConnectionString(),
  ssl: process.env.NODE_ENV === 'production' || process.env.DATABASE_URL?.includes('supabase')
    ? { rejectUnauthorized: false }
    : undefined,
  max: Number(process.env.PG_POOL_MAX ?? 10),
})

pool.on('error', (err) => {
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
  converted = converted.replace(/datetime\('now'\)/gi, 'NOW()')

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

export async function verifyDatabaseConnection(): Promise<void> {
  await execute('SELECT 1')
}

export async function closePool(): Promise<void> {
  await pool.end()
}
