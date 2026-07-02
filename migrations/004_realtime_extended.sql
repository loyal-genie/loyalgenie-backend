-- Phase 4b: extend Realtime to play/stamp/loyalty tables

ALTER TABLE game_plays REPLICA IDENTITY FULL;
ALTER TABLE stamp_cards REPLICA IDENTITY FULL;
ALTER TABLE loyalty_cards REPLICA IDENTITY FULL;

DO $$
BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE game_plays;
EXCEPTION
  WHEN duplicate_object THEN NULL;
  WHEN OTHERS THEN
    RAISE NOTICE 'Could not add game_plays to realtime: %', SQLERRM;
END $$;

DO $$
BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE stamp_cards;
EXCEPTION
  WHEN duplicate_object THEN NULL;
  WHEN OTHERS THEN
    RAISE NOTICE 'Could not add stamp_cards to realtime: %', SQLERRM;
END $$;

DO $$
BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE loyalty_cards;
EXCEPTION
  WHEN duplicate_object THEN NULL;
  WHEN OTHERS THEN
    RAISE NOTICE 'Could not add loyalty_cards to realtime: %', SQLERRM;
END $$;
