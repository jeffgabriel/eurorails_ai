-- Migration 015: Remove lobby_status; add per-player visibility + presence
--
-- Decisions:
-- - games.status is the single source of truth for lifecycle: setup | initialBuild | active | completed | abandoned
-- - lobby_status is removed entirely
-- - players.is_deleted supports per-player soft delete/hide
-- - players.last_seen_at supports server-driven presence staleness (5-minute timeout)

-- 1) Remove lobby_status (no longer used)
DROP INDEX IF EXISTS idx_games_lobby_status;
ALTER TABLE games DROP CONSTRAINT IF EXISTS games_lobby_status_check;
ALTER TABLE games DROP COLUMN IF EXISTS lobby_status;

-- 2) Extend games.status constraint to include abandoned
ALTER TABLE games DROP CONSTRAINT IF EXISTS games_status_check;
ALTER TABLE games
ADD CONSTRAINT games_status_check
CHECK (status IN ('setup', 'initialBuild', 'active', 'completed', 'abandoned'));

-- 3) Add per-player visibility + presence tracking
ALTER TABLE players
ADD COLUMN IF NOT EXISTS is_deleted BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP;

CREATE INDEX IF NOT EXISTS idx_players_user_game_visible ON players(user_id, game_id, is_deleted);
CREATE INDEX IF NOT EXISTS idx_players_last_seen_at ON players(last_seen_at);

COMMENT ON COLUMN players.is_deleted IS 'Soft delete for lobby listing: true hides game for this user';
COMMENT ON COLUMN players.last_seen_at IS 'Last time server observed presence for this player (socket/heartbeat)';
