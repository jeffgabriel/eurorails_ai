-- Add hand column to player table to store the 3 demand card IDs
ALTER TABLE players
ADD COLUMN hand INTEGER[] NOT NULL DEFAULT '{}'::INTEGER[];

-- Add constraint to ensure hand array has exactly 3 elements or is empty
ALTER TABLE players
ADD CONSTRAINT player_hand_size CHECK (array_length(hand, 1) IS NULL OR array_length(hand, 1) = 3);

-- Add comment explaining the column
COMMENT ON COLUMN players.hand IS 'Array of exactly 3 demand card IDs representing the player''s current hand';

-- Migration rollback
-- DOWN
-- ALTER TABLE player DROP COLUMN hand; 