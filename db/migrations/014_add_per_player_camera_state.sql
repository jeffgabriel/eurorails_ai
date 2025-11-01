-- Add camera_state column to players table for per-player camera state
ALTER TABLE players ADD COLUMN IF NOT EXISTS camera_state JSONB;

-- Add index to improve migration performance
CREATE INDEX IF NOT EXISTS idx_players_game_id_created_at ON players(game_id, created_at);

-- Migrate existing global camera state from games table to first player
-- This ensures backward compatibility for existing games
DO $$
DECLARE
    game_record RECORD;
    first_player_id UUID;
BEGIN
    FOR game_record IN 
        SELECT id, camera_state 
        FROM games 
        WHERE camera_state IS NOT NULL
    LOOP
        -- Get first player for this game (lowest created_at or first by id)
        SELECT id INTO first_player_id
        FROM players
        WHERE game_id = game_record.id
        ORDER BY created_at ASC, id ASC
        LIMIT 1;
        
        -- If player exists and doesn't already have a camera_state, migrate it
        IF first_player_id IS NOT NULL THEN
            UPDATE players
            SET camera_state = game_record.camera_state
            WHERE id = first_player_id
            AND camera_state IS NULL;
            
            RAISE NOTICE 'Migrated camera state from game % to player %', game_record.id, first_player_id;
        ELSE
            RAISE WARNING 'No players found for game % - camera state migration skipped', game_record.id;
        END IF;
    END LOOP;
END $$;

-- Note: We keep camera_state in games table for backwards compatibility during transition
-- It can be removed in a future migration once we're confident all clients are updated

