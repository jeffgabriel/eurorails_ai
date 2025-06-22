-- Add position columns to players table if they don't exist
-- These allow tracking the train's position on the board
ALTER TABLE players 
ADD COLUMN IF NOT EXISTS position_x INTEGER,
ADD COLUMN IF NOT EXISTS position_y INTEGER,
ADD COLUMN IF NOT EXISTS position_row INTEGER,
ADD COLUMN IF NOT EXISTS position_col INTEGER;