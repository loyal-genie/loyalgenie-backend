/**
 * Verify Supabase Postgres + Cloudflare R2 credentials.
 * Run: npm run verify:infra
 */
import dotenv from 'dotenv'
import pg from 'pg'
import { HeadBucketCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3'

dotenv.config()

function requireEnv(name: string): string {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`Missing ${name}`)
  return value
}

async function verifySupabase(): Promise<void> {
  const url = requireEnv('DATABASE_URL')
  const pool = new pg.Pool({
    connectionString: url,
    ssl: { rejectUnauthorized: false },
    max: 2,
  })
  try {
    const result = await pool.query(
      'SELECT current_database() AS db, version() AS version',
    )
    console.log('✓ Supabase Postgres connected')
    console.log(`  database: ${result.rows[0].db}`)
  } finally {
    await pool.end()
  }
}

async function verifyR2(): Promise<void> {
  const accountId = requireEnv('R2_ACCOUNT_ID')
  const accessKeyId = requireEnv('R2_ACCESS_KEY_ID')
  const secretAccessKey = requireEnv('R2_SECRET_ACCESS_KEY')
  const bucket = requireEnv('R2_BUCKET_NAME')
  const publicUrl = requireEnv('R2_PUBLIC_URL')

  const client = new S3Client({
    region: 'auto',
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId, secretAccessKey },
  })

  await client.send(new HeadBucketCommand({ Bucket: bucket }))
  console.log('✓ Cloudflare R2 bucket reachable')

  const key = `_healthcheck/${Date.now()}.txt`
  await client.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: 'loyalgenie-infra-check',
      ContentType: 'text/plain',
    }),
  )
  console.log('✓ R2 write test passed')
  console.log(`  public base: ${publicUrl}`)
}

async function main() {
  console.log('Verifying infrastructure credentials...\n')
  await verifySupabase()
  await verifyR2()
  console.log('\nAll checks passed.')
}

main().catch(err => {
  console.error('\n✗ Verification failed:', err instanceof Error ? err.message : err)
  process.exit(1)
})
