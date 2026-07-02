/**
 * Apply standalone rewards module schema patch.
 * @deprecated Use `npm run db:migrate` — rewards module is included in startup migrations.
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
    console.error('Rewards module migration failed:', err)
    await closePool().catch(() => {})
    process.exit(1)
  })
