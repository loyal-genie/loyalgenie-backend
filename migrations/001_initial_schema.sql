-- Loyal Genie — initial Supabase Postgres schema (Phase 1)
-- Postgres-native with SQLite-compatible column types for smooth Turso import.

CREATE TABLE IF NOT EXISTS business_users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT,
  created_at TEXT NOT NULL DEFAULT NOW()::text
);

CREATE TABLE IF NOT EXISTS businesses (
  id TEXT PRIMARY KEY,
  user_id TEXT,
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
  logo_data TEXT,
  cover_banner_data TEXT,
  interior_photos_data TEXT,
  exterior_photos_data TEXT,
  logo_url TEXT,
  cover_banner_url TEXT,
  cover_thumbnail_url TEXT,
  interior_photo_urls TEXT DEFAULT '[]',
  exterior_photo_urls TEXT DEFAULT '[]',
  rating DOUBLE PRECISION,
  latitude DOUBLE PRECISION,
  longitude DOUBLE PRECISION,
  display_distance_km DOUBLE PRECISION,
  mechanic_tags TEXT DEFAULT '[]',
  created_at TEXT NOT NULL DEFAULT NOW()::text
);

CREATE TABLE IF NOT EXISTS branches (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  city TEXT,
  address TEXT,
  is_primary INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS customer_users (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  phone TEXT NOT NULL UNIQUE,
  email TEXT UNIQUE,
  password_hash TEXT,
  date_of_birth TEXT,
  gender TEXT,
  phone_verified INTEGER NOT NULL DEFAULT 1,
  profile_complete INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT NOW()::text
);

CREATE TABLE IF NOT EXISTS password_reset_tokens (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  user_type TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  created_at TEXT NOT NULL DEFAULT NOW()::text
);

CREATE TABLE IF NOT EXISTS campaigns (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  mechanic TEXT NOT NULL DEFAULT 'shake',
  status TEXT NOT NULL DEFAULT 'draft',
  start_date TEXT NOT NULL,
  end_date TEXT NOT NULL,
  user_cap INTEGER NOT NULL,
  per_day_user_limit INTEGER NOT NULL,
  plays_per_day INTEGER NOT NULL DEFAULT 1,
  win_rate_percent INTEGER NOT NULL,
  overall_winners INTEGER,
  daily_winner_cap INTEGER,
  config_json TEXT,
  pin TEXT,
  pin_expires_at TEXT,
  previous_pin TEXT,
  previous_pin_valid_until TEXT,
  cap_filled_at TEXT,
  claim_period_days INTEGER NOT NULL DEFAULT 30,
  created_at TEXT NOT NULL DEFAULT NOW()::text
);

CREATE TABLE IF NOT EXISTS campaign_rewards (
  id TEXT PRIMARY KEY,
  campaign_id TEXT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT,
  icon TEXT NOT NULL DEFAULT '🎁',
  share_percent INTEGER NOT NULL,
  reward_tier TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS campaign_participations (
  id TEXT PRIMARY KEY,
  campaign_id TEXT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  customer_id TEXT NOT NULL REFERENCES customer_users(id) ON DELETE CASCADE,
  plays_today INTEGER NOT NULL DEFAULT 0,
  last_play_date TEXT,
  total_plays INTEGER NOT NULL DEFAULT 0,
  first_played_at TEXT NOT NULL,
  last_played_at TEXT,
  UNIQUE (campaign_id, customer_id)
);

CREATE TABLE IF NOT EXISTS game_plays (
  id TEXT PRIMARY KEY,
  campaign_id TEXT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  customer_id TEXT NOT NULL REFERENCES customer_users(id) ON DELETE CASCADE,
  mechanic TEXT NOT NULL,
  won INTEGER NOT NULL,
  reward_id TEXT,
  reward_name TEXT,
  redemption_code TEXT,
  played_at TEXT NOT NULL DEFAULT NOW()::text
);

CREATE TABLE IF NOT EXISTS customer_rewards (
  id TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL REFERENCES customer_users(id) ON DELETE CASCADE,
  campaign_id TEXT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  play_id TEXT NOT NULL,
  reward_name TEXT NOT NULL,
  icon TEXT,
  redemption_code TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'pending',
  earned_at TEXT NOT NULL,
  requested_at TEXT,
  redeemed_at TEXT
);

CREATE TABLE IF NOT EXISTS stamp_cards (
  id TEXT PRIMARY KEY,
  campaign_id TEXT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  customer_id TEXT NOT NULL REFERENCES customer_users(id) ON DELETE CASCADE,
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
  UNIQUE (campaign_id, customer_id)
);

CREATE TABLE IF NOT EXISTS loyalty_cards (
  id TEXT PRIMARY KEY,
  campaign_id TEXT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  customer_id TEXT NOT NULL REFERENCES customer_users(id) ON DELETE CASCADE,
  loyalty_points INTEGER NOT NULL DEFAULT 0,
  total_check_ins INTEGER NOT NULL DEFAULT 0,
  last_check_in_date TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  enrolled_at TEXT NOT NULL,
  UNIQUE (campaign_id, customer_id)
);

CREATE TABLE IF NOT EXISTS loyalty_milestone_awards (
  id TEXT PRIMARY KEY,
  loyalty_card_id TEXT NOT NULL REFERENCES loyalty_cards(id) ON DELETE CASCADE,
  reward_id TEXT NOT NULL,
  play_id TEXT NOT NULL,
  awarded_at TEXT NOT NULL,
  UNIQUE (loyalty_card_id, reward_id)
);

CREATE TABLE IF NOT EXISTS otp_verifications (
  phone TEXT PRIMARY KEY,
  otp_hash TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT NOW()::text
);

CREATE TABLE IF NOT EXISTS schema_patches (
  id TEXT PRIMARY KEY,
  applied_at TEXT NOT NULL DEFAULT NOW()::text
);

CREATE INDEX IF NOT EXISTS idx_businesses_qr_slug ON businesses(qr_slug);
CREATE INDEX IF NOT EXISTS idx_users_email ON business_users(email);
CREATE INDEX IF NOT EXISTS idx_businesses_user_id ON businesses(user_id);
CREATE INDEX IF NOT EXISTS idx_customer_users_email ON customer_users(email);
CREATE INDEX IF NOT EXISTS idx_customer_users_phone ON customer_users(phone);
CREATE INDEX IF NOT EXISTS idx_password_reset_token_hash ON password_reset_tokens(token_hash);
CREATE INDEX IF NOT EXISTS idx_campaigns_business ON campaigns(business_id, status);
CREATE INDEX IF NOT EXISTS idx_campaigns_active_list ON campaigns(business_id, status, start_date) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_campaign_participations ON campaign_participations(campaign_id, customer_id);
CREATE INDEX IF NOT EXISTS idx_customer_rewards_customer ON customer_rewards(customer_id);
CREATE INDEX IF NOT EXISTS idx_customer_rewards_status ON customer_rewards(campaign_id, status);
CREATE INDEX IF NOT EXISTS idx_game_plays_campaign ON game_plays(campaign_id);
CREATE INDEX IF NOT EXISTS idx_game_plays_campaign_date ON game_plays(campaign_id, played_at);
CREATE INDEX IF NOT EXISTS idx_game_plays_customer ON game_plays(customer_id);
CREATE INDEX IF NOT EXISTS idx_stamp_cards_campaign ON stamp_cards(campaign_id, status);
CREATE INDEX IF NOT EXISTS idx_loyalty_cards_campaign ON loyalty_cards(campaign_id);
CREATE INDEX IF NOT EXISTS idx_loyalty_cards_customer ON loyalty_cards(customer_id);
