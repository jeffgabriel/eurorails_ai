-- Migration: Add bot_memory column to players table
-- Version: 37
-- Description: Adds bot_memory JSONB column to persist BotMemoryState across server restarts.

ALTER TABLE players
ADD COLUMN IF NOT EXISTS bot_memory JSONB;

COMMENT ON COLUMN players.bot_memory IS 'Persisted BotMemoryState JSON for AI bot players. NULL for human players.';

-- Migration rollback (DOWN migration)
-- DOWN
-- ALTER TABLE players DROP COLUMN IF EXISTS bot_memory;
