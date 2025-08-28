-- Migration 011: Add lobby fields for game creation and user management
-- This migration adds the necessary fields to support lobby functionality

-- Add lobby-specific fields to games table
ALTER TABLE games 
ADD COLUMN IF NOT EXISTS join_code VARCHAR(8) UNIQUE,
ADD COLUMN IF NOT EXISTS created_by UUID REFERENCES players(id),
ADD COLUMN IF NOT EXISTS is_public BOOLEAN DEFAULT false,
ADD COLUMN IF NOT EXISTS lobby_status TEXT CHECK (lobby_status IN ('IN_SETUP', 'ACTIVE', 'COMPLETE')) DEFAULT 'IN_SETUP';

-- Add user management fields to players table
ALTER TABLE players 
ADD COLUMN IF NOT EXISTS user_id UUID,
ADD COLUMN IF NOT EXISTS is_online BOOLEAN DEFAULT true;

-- Create performance indexes for lobby operations
CREATE INDEX IF NOT EXISTS idx_games_join_code ON games(join_code);
CREATE INDEX IF NOT EXISTS idx_games_lobby_status ON games(lobby_status);
CREATE INDEX IF NOT EXISTS idx_games_created_by ON games(created_by);
CREATE INDEX IF NOT EXISTS idx_games_is_public ON games(is_public);
CREATE INDEX IF NOT EXISTS idx_players_user_id ON players(user_id);
CREATE INDEX IF NOT EXISTS idx_players_is_online ON players(is_online);

-- Add comments explaining the new columns
COMMENT ON COLUMN games.join_code IS 'Unique 8-character code for players to join the game';
COMMENT ON COLUMN games.created_by IS 'Reference to the player who created this game';
COMMENT ON COLUMN games.is_public IS 'Whether this game is visible in public lobby listings';
COMMENT ON COLUMN games.lobby_status IS 'Current status of the game in the lobby (IN_SETUP, ACTIVE, COMPLETE)';
COMMENT ON COLUMN players.user_id IS 'Unique identifier for the user account (for future authentication)';
COMMENT ON COLUMN players.is_online IS 'Whether the player is currently online and active';

-- Update the existing games.status check constraint to include the new lobby_status values
-- First, drop the existing constraint
ALTER TABLE games DROP CONSTRAINT IF EXISTS games_status_check;

-- Then add the new constraint that includes both game status and lobby status
ALTER TABLE games 
ADD CONSTRAINT games_status_check 
CHECK (status IN ('setup', 'initialBuild', 'active', 'completed'));

-- Add a function to generate unique join codes
CREATE OR REPLACE FUNCTION generate_unique_join_code() 
RETURNS VARCHAR(8) AS $$
DECLARE
    new_code VARCHAR(8);
    attempts INTEGER := 0;
    max_attempts INTEGER := 10;
BEGIN
    LOOP
        -- Generate a random 8-character alphanumeric code
        new_code := upper(substring(md5(random()::text || clock_timestamp()::text) from 1 for 8));
        
        -- Check if this code already exists
        IF NOT EXISTS (SELECT 1 FROM games WHERE join_code = new_code) THEN
            RETURN new_code;
        END IF;
        
        attempts := attempts + 1;
        
        -- Prevent infinite loops
        IF attempts >= max_attempts THEN
            RAISE EXCEPTION 'Unable to generate unique join code after % attempts', max_attempts;
        END IF;
    END LOOP;
END;
$$ LANGUAGE plpgsql;

-- Add comment to the function
COMMENT ON FUNCTION generate_unique_join_code() IS 'Generates a unique 8-character alphanumeric join code for games';

-- Migration rollback (DOWN migration)
-- DOWN
-- DROP FUNCTION IF EXISTS generate_unique_join_code();
-- DROP INDEX IF EXISTS idx_players_is_online;
-- DROP INDEX IF EXISTS idx_players_user_id;
-- DROP INDEX IF EXISTS idx_games_is_public;
-- DROP INDEX IF EXISTS idx_games_created_by;
-- DROP INDEX IF EXISTS idx_games_lobby_status;
-- DROP INDEX IF EXISTS idx_games_join_code;
-- ALTER TABLE players DROP COLUMN IF EXISTS is_online;
-- ALTER TABLE players DROP COLUMN IF EXISTS user_id;
-- ALTER TABLE games DROP COLUMN IF EXISTS lobby_status;
-- ALTER TABLE games DROP COLUMN IF EXISTS is_public;
-- ALTER TABLE games DROP COLUMN IF EXISTS created_by;
-- ALTER TABLE games DROP COLUMN IF EXISTS join_code;
