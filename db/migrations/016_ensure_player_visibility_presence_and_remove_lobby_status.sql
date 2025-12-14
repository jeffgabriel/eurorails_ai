-- Migration 016: Ensure presence/visibility columns and remove lobby_status (idempotent)
--
-- This migration is intentionally redundant to protect environments where
-- schema_migrations advanced but the underlying DDL did not fully apply.

-- Ensure games.status supports abandoned FIRST (so the data migration cannot violate it)
ALTER TABLE games DROP CONSTRAINT IF EXISTS games_status_check;
ALTER TABLE games
ADD CONSTRAINT games_status_check
CHECK (status IN ('setup', 'initialBuild', 'active', 'completed', 'abandoned'));

-- Data migration: consolidate legacy lobby_status into games.status before dropping column
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_name = 'games'
      AND column_name = 'lobby_status'
  ) THEN
    UPDATE games
    SET status = 'abandoned'
    WHERE lobby_status = 'ABANDONED';
  END IF;
END $$;

-- Remove lobby_status if present
DROP INDEX IF EXISTS idx_games_lobby_status;
ALTER TABLE games DROP CONSTRAINT IF EXISTS games_lobby_status_check;
ALTER TABLE games DROP COLUMN IF EXISTS lobby_status;

-- Ensure per-player visibility + presence columns exist
ALTER TABLE players
ADD COLUMN IF NOT EXISTS is_deleted BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP;

CREATE INDEX IF NOT EXISTS idx_players_user_game_visible ON players(user_id, game_id, is_deleted);
CREATE INDEX IF NOT EXISTS idx_players_last_seen_at ON players(last_seen_at);
