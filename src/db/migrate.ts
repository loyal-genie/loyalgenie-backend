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

const CAMPAIGN_MIGRATIONS = `
CREATE TABLE IF NOT EXISTS campaigns (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL,
  name TEXT NOT NULL,
  mechanic TEXT NOT NULL DEFAULT 'shake',
  status TEXT NOT NULL DEFAULT 'draft',
  start_date TEXT NOT NULL,
  end_date TEXT NOT NULL,
  user_cap INTEGER NOT NULL,
  per_day_user_limit INTEGER NOT NULL,
  plays_per_day INTEGER NOT NULL DEFAULT 1,
  win_rate_percent INTEGER NOT NULL,
  config_json TEXT,
  pin TEXT,
  pin_expires_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (business_id) REFERENCES businesses(id)
);

CREATE TABLE IF NOT EXISTS campaign_rewards (
  id TEXT PRIMARY KEY,
  campaign_id TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  icon TEXT NOT NULL DEFAULT '🎁',
  share_percent INTEGER NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (campaign_id) REFERENCES campaigns(id)
);

CREATE TABLE IF NOT EXISTS campaign_participations (
  id TEXT PRIMARY KEY,
  campaign_id TEXT NOT NULL,
  customer_id TEXT NOT NULL,
  plays_today INTEGER NOT NULL DEFAULT 0,
  last_play_date TEXT,
  total_plays INTEGER NOT NULL DEFAULT 0,
  first_played_at TEXT NOT NULL,
  UNIQUE(campaign_id, customer_id)
);

CREATE TABLE IF NOT EXISTS game_plays (
  id TEXT PRIMARY KEY,
  campaign_id TEXT NOT NULL,
  customer_id TEXT NOT NULL,
  mechanic TEXT NOT NULL,
  won INTEGER NOT NULL,
  reward_id TEXT,
  reward_name TEXT,
  redemption_code TEXT,
  played_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS customer_rewards (
  id TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL,
  campaign_id TEXT NOT NULL,
  play_id TEXT NOT NULL,
  reward_name TEXT NOT NULL,
  icon TEXT,
  redemption_code TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'pending',
  earned_at TEXT NOT NULL,
  redeemed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_campaigns_business ON campaigns(business_id, status);
CREATE INDEX IF NOT EXISTS idx_campaign_participations ON campaign_participations(campaign_id, customer_id);
CREATE INDEX IF NOT EXISTS idx_customer_rewards_customer ON customer_rewards(customer_id);
CREATE INDEX IF NOT EXISTS idx_game_plays_campaign ON game_plays(campaign_id);
CREATE INDEX IF NOT EXISTS idx_game_plays_customer ON game_plays(customer_id);
`

const COLUMN_PATCHES_CAMPAIGNS = [
  'ALTER TABLE campaign_participations ADD COLUMN last_played_at TEXT',
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
  await db.executeMultiple(CAMPAIGN_MIGRATIONS)
  for (const sql of COLUMN_PATCHES_CAMPAIGNS) await runOptional(sql)
  console.log('Database migrations applied.')
}

if (import.meta.url === `file://${process.argv[1]}`) {
  migrate().catch(err => {
    console.error(err)
    process.exit(1)
  })
}
