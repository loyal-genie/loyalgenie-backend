/**
 * Apply all idempotent Postgres migrations (schema, realtime, rewards module).
 * Also runs automatically on `npm start` before the API listens.
 */
import dotenv from 'dotenv'
import { applyPendingMigrations } from '../src/db/apply-migrations.js'
import { closePool } from '../src/db/client.js'

dotenv.config()

applyPendingMigrations()
  .then(async () => {
    await closePool()
  })
  .catch(async err => {
    console.error('Migration failed:', err)
    await closePool().catch(() => {})
    process.exit(1)
  })
