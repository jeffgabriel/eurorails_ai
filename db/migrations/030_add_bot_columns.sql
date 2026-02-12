-- Migration: Add bot columns to players table
-- Version: 30
-- Description: Adds is_bot and bot_config columns to distinguish AI bot players
--              from human players and store bot-specific configuration.

-- Add bot columns to players table
ALTER TABLE players
ADD COLUMN IF NOT EXISTS is_bot BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN IF NOT EXISTS bot_config JSONB;

-- Add index for efficient bot queries
CREATE INDEX IF NOT EXISTS idx_players_is_bot ON players(is_bot);

-- Add comments explaining the new columns
COMMENT ON COLUMN players.is_bot IS 'Whether this player is an AI bot (true) or human (false)';
COMMENT ON COLUMN players.bot_config IS 'JSON config for bot players: { skillLevel, archetype, name }. NULL for human players.';

-- Migration rollback (DOWN migration)
-- DOWN
-- DROP INDEX IF EXISTS idx_players_is_bot;
-- ALTER TABLE players DROP COLUMN IF EXISTS bot_config;
-- ALTER TABLE players DROP COLUMN IF EXISTS is_bot;
