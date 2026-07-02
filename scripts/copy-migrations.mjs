import { cpSync, existsSync, mkdirSync, readdirSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'

const backendRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const destDir = join(backendRoot, 'dist/migrations')

const sourceCandidates = [
  join(backendRoot, 'migrations'),
  join(backendRoot, '../supabase/migrations'),
  join(backendRoot, 'supabase/migrations'),
]

const sourceDir = sourceCandidates.find(dir => existsSync(join(dir, '001_initial_schema.sql')))

if (!sourceDir) {
  console.error('Migration SQL source not found. Expected backend/migrations or supabase/migrations.')
  process.exit(1)
}

mkdirSync(destDir, { recursive: true })

const files = readdirSync(sourceDir).filter(name => name.endsWith('.sql'))
if (files.length === 0) {
  console.error(`No .sql files in ${sourceDir}`)
  process.exit(1)
}

for (const file of files) {
  cpSync(join(sourceDir, file), join(destDir, file))
}

console.log(`Copied ${files.length} migration file(s) from ${sourceDir} to ${destDir}`)
