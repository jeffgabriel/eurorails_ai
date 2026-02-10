-- Add bot-related columns to players table
ALTER TABLE players ADD COLUMN IF NOT EXISTS is_bot BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE players ADD COLUMN IF NOT EXISTS bot_config JSONB;

-- DOWN (for reference, not auto-executed)
-- ALTER TABLE players DROP COLUMN IF EXISTS is_bot;
-- ALTER TABLE players DROP COLUMN IF EXISTS bot_config;
