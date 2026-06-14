import { db } from './client.js'

/** Core tables — compatible with DBs created before auth/upload columns existed. */
const MIGRATIONS_CORE = `
CREATE TABLE IF NOT EXISTS business_users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS businesses (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  tagline TEXT,
  description TEXT,
  business_type TEXT,
  owner_name TEXT,
  mobile TEXT,
  whatsapp TEXT,
  email TEXT,
  city TEXT,
  pincode TEXT,
  landmark TEXT,
  address TEXT,
  map_link TEXT,
  operating_hours TEXT,
  weekly_off TEXT,
  brand_color TEXT DEFAULT '#7C3AED',
  instagram TEXT,
  facebook TEXT,
  website TEXT,
  google_review TEXT,
  qr_slug TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS branches (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL,
  name TEXT NOT NULL,
  city TEXT,
  address TEXT,
  is_primary INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (business_id) REFERENCES businesses(id)
);

CREATE INDEX IF NOT EXISTS idx_businesses_qr_slug ON businesses(qr_slug);
CREATE INDEX IF NOT EXISTS idx_users_email ON business_users(email);

CREATE TABLE IF NOT EXISTS customer_users (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  phone TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_customer_users_email ON customer_users(email);
CREATE INDEX IF NOT EXISTS idx_customer_users_phone ON customer_users(phone);

CREATE TABLE IF NOT EXISTS password_reset_tokens (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  user_type TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_password_reset_token_hash ON password_reset_tokens(token_hash);
`

const COLUMN_PATCHES = [
  'ALTER TABLE businesses ADD COLUMN user_id TEXT',
  'ALTER TABLE businesses ADD COLUMN logo_data TEXT',
  'ALTER TABLE businesses ADD COLUMN cover_banner_data TEXT',
  'ALTER TABLE businesses ADD COLUMN interior_photos_data TEXT',
  'ALTER TABLE businesses ADD COLUMN exterior_photos_data TEXT',
]

const INDEX_PATCHES = [
  'CREATE INDEX IF NOT EXISTS idx_businesses_user_id ON businesses(user_id)',
]

async function runOptional(sql: string) {
  try {
    await db.execute(sql)
  } catch {
    // column/index already exists
  }
}

export async function migrate() {
  await db.executeMultiple(MIGRATIONS_CORE)
  for (const sql of COLUMN_PATCHES) await runOptional(sql)
  for (const sql of INDEX_PATCHES) await runOptional(sql)
  console.log('Database migrations applied.')
}

if (import.meta.url === `file://${process.argv[1]}`) {
  migrate().catch(err => {
    console.error(err)
    process.exit(1)
  })
}
