-- Add loads column to player table to store the current loads being carried
ALTER TABLE players
ADD COLUMN IF NOT EXISTS loads TEXT[] NOT NULL DEFAULT '{}'::TEXT[];

-- Add constraint to ensure loads array doesn't exceed train capacity
ALTER TABLE players DROP CONSTRAINT IF EXISTS player_loads_size;
ALTER TABLE players
ADD CONSTRAINT player_loads_size CHECK (array_length(loads, 1) IS NULL OR array_length(loads, 1) <= 3);

-- Add comment explaining the column
COMMENT ON COLUMN players.loads IS 'Array of load types currently being carried by the player''s train (max 3 for Heavy/Super Freight, max 2 for others)';

-- Migration rollback
-- DOWN
-- ALTER TABLE players DROP COLUMN loads;