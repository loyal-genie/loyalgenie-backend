-- Loyal Genie — standalone rewards module

CREATE TABLE IF NOT EXISTS reward_categories (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT NOW()::text,
  UNIQUE (business_id, name)
);

CREATE TABLE IF NOT EXISTS business_rewards (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  category_id TEXT REFERENCES reward_categories(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  icon TEXT NOT NULL DEFAULT 'gift',
  points_required INTEGER NOT NULL,
  max_claims INTEGER,
  claims_count INTEGER NOT NULL DEFAULT 0,
  claim_before TEXT,
  redeem_expiry_mode TEXT NOT NULL DEFAULT 'relative',
  redeem_fixed_date TEXT,
  redeem_relative_amount INTEGER,
  redeem_relative_unit TEXT,
  redemption_instructions TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL DEFAULT NOW()::text,
  updated_at TEXT NOT NULL DEFAULT NOW()::text
);

CREATE TABLE IF NOT EXISTS business_customer_points (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  customer_id TEXT NOT NULL REFERENCES customer_users(id) ON DELETE CASCADE,
  points INTEGER NOT NULL DEFAULT 0,
  total_earned INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT NOW()::text,
  UNIQUE (business_id, customer_id)
);

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'customer_rewards'
      AND column_name = 'campaign_id'
      AND is_nullable = 'NO'
  ) THEN
    ALTER TABLE customer_rewards ALTER COLUMN campaign_id DROP NOT NULL;
  END IF;
END $$;

ALTER TABLE customer_rewards
  ADD COLUMN IF NOT EXISTS business_reward_id TEXT REFERENCES business_rewards(id) ON DELETE SET NULL;

ALTER TABLE customer_rewards
  ADD COLUMN IF NOT EXISTS business_id TEXT REFERENCES businesses(id) ON DELETE SET NULL;

ALTER TABLE customer_rewards
  ADD COLUMN IF NOT EXISTS source_type TEXT NOT NULL DEFAULT 'campaign_win';

ALTER TABLE customer_rewards
  ADD COLUMN IF NOT EXISTS claimed_at TEXT;

ALTER TABLE customer_rewards
  ADD COLUMN IF NOT EXISTS redeem_expires_at TEXT;

CREATE INDEX IF NOT EXISTS idx_reward_categories_business ON reward_categories(business_id);
CREATE INDEX IF NOT EXISTS idx_business_rewards_business ON business_rewards(business_id, status);
CREATE INDEX IF NOT EXISTS idx_business_rewards_category ON business_rewards(category_id);
CREATE INDEX IF NOT EXISTS idx_points_business_customer ON business_customer_points(business_id, customer_id);
CREATE INDEX IF NOT EXISTS idx_customer_rewards_business_status ON customer_rewards(business_id, status);
