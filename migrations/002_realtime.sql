-- Phase 4: enable Supabase Realtime on hot tables (run after Phase 1 schema exists)

ALTER TABLE campaigns REPLICA IDENTITY FULL;
ALTER TABLE customer_rewards REPLICA IDENTITY FULL;

DO $$
BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE campaigns;
EXCEPTION
  WHEN duplicate_object THEN NULL;
  WHEN OTHERS THEN
    RAISE NOTICE 'Could not add campaigns to realtime: %', SQLERRM;
END $$;

DO $$
BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE customer_rewards;
EXCEPTION
  WHEN duplicate_object THEN NULL;
  WHEN OTHERS THEN
    RAISE NOTICE 'Could not add customer_rewards to realtime: %', SQLERRM;
END $$;
