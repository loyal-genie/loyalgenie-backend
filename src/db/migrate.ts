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
  'ALTER TABLE businesses ADD COLUMN rating REAL',
  'ALTER TABLE businesses ADD COLUMN latitude REAL',
  'ALTER TABLE businesses ADD COLUMN longitude REAL',
  'ALTER TABLE businesses ADD COLUMN display_distance_km REAL',
  'ALTER TABLE businesses ADD COLUMN mechanic_tags TEXT',
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
CREATE INDEX IF NOT EXISTS idx_game_plays_campaign_date ON game_plays(campaign_id, played_at);
CREATE INDEX IF NOT EXISTS idx_game_plays_customer ON game_plays(customer_id);
`

const COLUMN_PATCHES_CAMPAIGNS = [
  'ALTER TABLE campaign_participations ADD COLUMN last_played_at TEXT',
  'ALTER TABLE campaigns ADD COLUMN cap_filled_at TEXT',
  'ALTER TABLE campaigns ADD COLUMN claim_period_days INTEGER NOT NULL DEFAULT 30',
  'ALTER TABLE campaign_rewards ADD COLUMN reward_tier TEXT',
  'ALTER TABLE campaigns ADD COLUMN previous_pin TEXT',
  'ALTER TABLE campaigns ADD COLUMN previous_pin_valid_until TEXT',
  'ALTER TABLE campaigns ADD COLUMN overall_winners INTEGER',
  'ALTER TABLE campaigns ADD COLUMN daily_winner_cap INTEGER',
]

const STAMP_CARD_MIGRATIONS = `
CREATE TABLE IF NOT EXISTS stamp_cards (
  id TEXT PRIMARY KEY,
  campaign_id TEXT NOT NULL,
  customer_id TEXT NOT NULL,
  stamps_collected INTEGER NOT NULL DEFAULT 0,
  surprise_trigger_at INTEGER NOT NULL,
  big_trigger_at INTEGER NOT NULL,
  surprise_awarded INTEGER NOT NULL DEFAULT 0,
  big_awarded INTEGER NOT NULL DEFAULT 0,
  surprise_play_id TEXT,
  big_play_id TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  enrolled_at TEXT NOT NULL,
  completed_at TEXT,
  expired_at TEXT,
  last_stamp_date TEXT,
  UNIQUE(campaign_id, customer_id),
  FOREIGN KEY (campaign_id) REFERENCES campaigns(id)
);

CREATE INDEX IF NOT EXISTS idx_stamp_cards_campaign ON stamp_cards(campaign_id, status);

CREATE TABLE IF NOT EXISTS loyalty_cards (
  id TEXT PRIMARY KEY,
  campaign_id TEXT NOT NULL,
  customer_id TEXT NOT NULL,
  loyalty_points INTEGER NOT NULL DEFAULT 0,
  total_check_ins INTEGER NOT NULL DEFAULT 0,
  last_check_in_date TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  enrolled_at TEXT NOT NULL,
  UNIQUE(campaign_id, customer_id),
  FOREIGN KEY (campaign_id) REFERENCES campaigns(id)
);

CREATE TABLE IF NOT EXISTS loyalty_milestone_awards (
  id TEXT PRIMARY KEY,
  loyalty_card_id TEXT NOT NULL,
  reward_id TEXT NOT NULL,
  play_id TEXT NOT NULL,
  awarded_at TEXT NOT NULL,
  UNIQUE(loyalty_card_id, reward_id),
  FOREIGN KEY (loyalty_card_id) REFERENCES loyalty_cards(id)
);

CREATE INDEX IF NOT EXISTS idx_loyalty_cards_campaign ON loyalty_cards(campaign_id);
CREATE INDEX IF NOT EXISTS idx_loyalty_cards_customer ON loyalty_cards(customer_id);
`

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
  await db.executeMultiple(STAMP_CARD_MIGRATIONS)
  await migrateCustomerUsersForOtp()
  await migrateBusinessUsersForEmailOtp()
  await db.executeMultiple(`
    CREATE TABLE IF NOT EXISTS otp_verifications (
      phone TEXT PRIMARY KEY,
      otp_hash TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `)
  await runOptional('ALTER TABLE customer_users ADD COLUMN gender TEXT')
  await runOptional('ALTER TABLE customer_users ADD COLUMN profile_complete INTEGER NOT NULL DEFAULT 1')
  await runOptional('ALTER TABLE customer_rewards ADD COLUMN requested_at TEXT')
  await migrateRewardRedemptionStatuses()
  await migrateShakeWinRateToPlayerBased()
  await migrateShakeWinnerCaps()
  console.log('Database migrations applied.')
}

/** Replace percentage-based win rate with explicit overall + daily winner caps. */
async function migrateShakeWinnerCaps() {
  await runOptional(`CREATE TABLE IF NOT EXISTS schema_patches (
    id TEXT PRIMARY KEY,
    applied_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`)
  const applied = await db.execute({
    sql: 'SELECT 1 FROM schema_patches WHERE id = ?',
    args: ['shake_winner_caps_2026_06'],
  })
  if (applied.rows.length > 0) return

  await db.execute(`
    UPDATE campaigns
    SET overall_winners = MAX(1, CAST(ROUND(user_cap * win_rate_percent / 100.0) AS INTEGER)),
        daily_winner_cap = MAX(1, CAST(ROUND(
          CASE
            WHEN start_date = end_date THEN user_cap
            ELSE per_day_user_limit
          END * win_rate_percent / 100.0
        ) AS INTEGER))
    WHERE mechanic = 'shake'
      AND (overall_winners IS NULL OR daily_winner_cap IS NULL)
  `)

  await db.execute({
    sql: 'INSERT INTO schema_patches (id) VALUES (?)',
    args: ['shake_winner_caps_2026_06'],
  })
}

/** Win rate was historically derived from total plays (cap × plays/day). Re-base on players only. */
async function migrateShakeWinRateToPlayerBased() {
  await runOptional(`CREATE TABLE IF NOT EXISTS schema_patches (
    id TEXT PRIMARY KEY,
    applied_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`)
  const applied = await db.execute({
    sql: 'SELECT 1 FROM schema_patches WHERE id = ?',
    args: ['shake_win_rate_player_based_2026_06'],
  })
  if (applied.rows.length > 0) return

  await db.execute(`
    UPDATE campaigns
    SET win_rate_percent = MIN(100, win_rate_percent * plays_per_day)
    WHERE mechanic IN ('shake', 'spin', 'dice', 'lottery')
      AND plays_per_day > 1
  `)
  await db.execute({
    sql: 'INSERT INTO schema_patches (id) VALUES (?)',
    args: ['shake_win_rate_player_based_2026_06'],
  })
}

/** Backfill requested_at for rewards already in the vendor queue before the earned→pending flow. */
async function migrateRewardRedemptionStatuses() {
  await db.execute(`
    UPDATE customer_rewards
    SET requested_at = earned_at
    WHERE status = 'pending' AND requested_at IS NULL
  `)
}

async function migrateCustomerUsersForOtp() {
  const tables = await db.execute(
    `SELECT name FROM sqlite_master WHERE type='table' AND name IN ('customer_users', 'customer_users_v2')`,
  )
  const tableNames = new Set(tables.rows.map((r) => r.name as string))

  if (tableNames.has('customer_users')) {
    const cols = await db.execute('PRAGMA table_info(customer_users)')
    const hasDob = cols.rows.some((r) => r.name === 'date_of_birth')
    if (hasDob) return
  } else if (!tableNames.has('customer_users_v2')) {
    return
  }

  // Recover from a previous failed migration attempt.
  if (tableNames.has('customer_users_v2')) {
    await db.execute('DROP TABLE customer_users_v2')
  }

  if (!tableNames.has('customer_users')) return

  const rows = await db.execute(
    'SELECT id, name, phone, email, password_hash, created_at FROM customer_users ORDER BY created_at ASC',
  )

  function normalizePhone(phone: string): string {
    const digits = phone.replace(/\D/g, '')
    if (digits.length === 10) return `+91${digits}`
    if (digits.length === 12 && digits.startsWith('91')) return `+91${digits.slice(2)}`
    if (digits.length === 11 && digits.startsWith('0')) return `+91${digits.slice(1)}`
    return phone.trim()
  }

  const byPhone = new Map<string, Record<string, unknown>>()
  for (const row of rows.rows) {
    const phone = normalizePhone(row.phone as string)
    const existing = byPhone.get(phone)
    if (!existing) {
      byPhone.set(phone, row as Record<string, unknown>)
      continue
    }
    console.warn(`Migration: skipping duplicate phone ${phone} (user ${row.id as string})`)
  }

  const usedEmails = new Set<string>()
  const dedupedRows: Record<string, unknown>[] = []
  for (const row of byPhone.values()) {
    const email = (row.email as string | null)?.trim().toLowerCase() || null
    if (email && usedEmails.has(email)) {
      console.warn(`Migration: clearing duplicate email ${email} for user ${row.id as string}`)
      dedupedRows.push({ ...row, email: null })
      continue
    }
    if (email) usedEmails.add(email)
    dedupedRows.push({ ...row, email })
  }

  await db.execute(`
    CREATE TABLE customer_users_v2 (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      phone TEXT NOT NULL UNIQUE,
      email TEXT UNIQUE,
      password_hash TEXT,
      date_of_birth TEXT,
      phone_verified INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `)

  for (const row of dedupedRows) {
    const email = (row.email as string | null)?.trim() || null
    await db.execute({
      sql: `INSERT INTO customer_users_v2 (id, name, phone, email, password_hash, created_at)
            VALUES (?, ?, ?, ?, ?, ?)`,
      args: [
        row.id as string,
        row.name as string,
        normalizePhone(row.phone as string),
        email,
        (row.password_hash as string | null) ?? null,
        row.created_at as string,
      ],
    })
  }

  await db.execute('DROP TABLE customer_users')
  await db.execute('ALTER TABLE customer_users_v2 RENAME TO customer_users')
  await db.execute('CREATE INDEX IF NOT EXISTS idx_customer_users_phone ON customer_users(phone)')
  await db.execute('CREATE INDEX IF NOT EXISTS idx_customer_users_email ON customer_users(email)')
}

async function migrateBusinessUsersForEmailOtp() {
  const cols = await db.execute('PRAGMA table_info(business_users)')
  const passwordCol = cols.rows.find((r) => r.name === 'password_hash')
  if (passwordCol && passwordCol.notnull === 0) return

  const rows = await db.execute('SELECT id, email, password_hash, created_at FROM business_users ORDER BY created_at ASC')

  await db.execute(`
    CREATE TABLE business_users_v2 (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `)

  for (const row of rows.rows) {
    await db.execute({
      sql: 'INSERT INTO business_users_v2 (id, email, password_hash, created_at) VALUES (?, ?, ?, ?)',
      args: [
        row.id as string,
        row.email as string,
        (row.password_hash as string | null) ?? null,
        row.created_at as string,
      ],
    })
  }

  await db.execute('DROP TABLE business_users')
  await db.execute('ALTER TABLE business_users_v2 RENAME TO business_users')
  await db.execute('CREATE INDEX IF NOT EXISTS idx_users_email ON business_users(email)')
}

if (import.meta.url === `file://${process.argv[1]}`) {
  migrate().catch(err => {
    console.error(err)
    process.exit(1)
  })
}
