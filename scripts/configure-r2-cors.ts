/**
 * Configure CORS on the R2 bucket so presigned PUT uploads work from browsers.
 * (Direct API upload via POST /api/uploads/direct does not need this.)
 *
 * Usage: npm run r2:configure-cors
 */
import dotenv from 'dotenv'
import { configureR2BucketCors } from '../src/services/r2-storage.js'
import { parseFrontendOrigins } from '../src/utils/frontend-url.js'

dotenv.config()

async function main() {
  const origins = [
    ...parseFrontendOrigins(),
    'http://localhost:5173',
    'http://localhost:3000',
    'http://localhost:3001',
  ]

  await configureR2BucketCors(origins)
  console.log('R2 bucket CORS updated for origins:')
  for (const origin of [...new Set(origins)]) console.log(`  - ${origin}`)
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
