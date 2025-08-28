-- Add lobby-specific fields to games table
ALTER TABLE games 
ADD COLUMN IF NOT EXISTS join_code VARCHAR(8) UNIQUE,
ADD COLUMN IF NOT EXISTS created_by UUID REFERENCES players(id),
ADD COLUMN IF NOT EXISTS is_public BOOLEAN DEFAULT false,
ADD COLUMN IF NOT EXISTS lobby_status TEXT CHECK (lobby_status IN ('IN_SETUP', 'ACTIVE', 'COMPLETE')) DEFAULT 'IN_SETUP';

-- Create index on join_code for fast lookups
CREATE INDEX IF NOT EXISTS idx_games_join_code ON games(join_code);

-- Create index on lobby_status for filtering
CREATE INDEX IF NOT EXISTS idx_games_lobby_status ON games(lobby_status);

-- Update existing games to have a default lobby_status
UPDATE games SET lobby_status = 'IN_SETUP' WHERE lobby_status IS NULL;

-- Add user_id to players table for authentication
ALTER TABLE players 
ADD COLUMN IF NOT EXISTS user_id UUID,
ADD COLUMN IF NOT EXISTS is_online BOOLEAN DEFAULT true;

-- Create index on user_id for fast lookups
CREATE INDEX IF NOT EXISTS idx_players_user_id ON players(user_id);
