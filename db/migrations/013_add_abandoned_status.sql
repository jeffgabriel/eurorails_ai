-- Add ABANDONED status to lobby_status
-- This allows games to be preserved for stats/history when players leave

-- Update the lobby_status check constraint to include ABANDONED
ALTER TABLE games DROP CONSTRAINT IF EXISTS games_lobby_status_check;
ALTER TABLE games ADD CONSTRAINT games_lobby_status_check 
    CHECK (lobby_status IN ('IN_SETUP', 'ACTIVE', 'COMPLETE', 'ABANDONED'));

-- Add comment explaining the new status
COMMENT ON COLUMN games.lobby_status IS 'Current status of the game in the lobby (IN_SETUP, ACTIVE, COMPLETE, ABANDONED)';

-- Update any existing games that might need the new status
-- (This is a no-op if no games exist, but ensures consistency)
UPDATE games SET lobby_status = 'ABANDONED' WHERE lobby_status = 'IN_SETUP' AND created_at < NOW() - INTERVAL '24 hours';
