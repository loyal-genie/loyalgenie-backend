/**
 * Delete all objects from the Cloudflare R2 assets bucket.
 *
 * Usage:
 *   CONFIRM=yes npm run r2:cleanup
 *   CONFIRM=yes npm run r2:cleanup -- --prefix businesses/
 *
 * Requires R2_* env vars in backend/.env
 */
import dotenv from 'dotenv'
import { deleteR2Keys, listAllR2Keys } from '../src/services/r2-storage.js'

dotenv.config()

function parsePrefix(): string | undefined {
  const idx = process.argv.indexOf('--prefix')
  if (idx === -1) return undefined
  return process.argv[idx + 1]?.trim() || undefined
}

async function main() {
  if (process.env.CONFIRM?.trim().toLowerCase() !== 'yes') {
    console.error('Refusing to run without CONFIRM=yes')
    console.error('Example: CONFIRM=yes npm run r2:cleanup')
    process.exit(1)
  }

  const bucket = process.env.R2_BUCKET_NAME?.trim()
  if (!bucket) {
    console.error('R2_BUCKET_NAME is not set in backend/.env')
    process.exit(1)
  }

  const prefix = parsePrefix()
  console.log(`Listing objects in bucket "${bucket}"${prefix ? ` (prefix: ${prefix})` : ''}...`)
  const keys = await listAllR2Keys(prefix)

  if (keys.length === 0) {
    console.log('Bucket is already empty for this scope.')
    return
  }

  console.log(`Deleting ${keys.length} object(s)...`)
  const deleted = await deleteR2Keys(keys)
  console.log(`R2 cleanup complete. Deleted ${deleted} object(s).`)
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
