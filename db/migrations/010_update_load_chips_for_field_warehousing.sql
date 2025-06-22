-- Update load_chips table to better track dropped loads for field warehousing
ALTER TABLE load_chips DROP COLUMN IF EXISTS location;
ALTER TABLE load_chips DROP COLUMN IF EXISTS player_id;

-- Add new columns for tracking dropped loads
ALTER TABLE load_chips ADD COLUMN IF NOT EXISTS city_name TEXT;
ALTER TABLE load_chips ADD COLUMN IF NOT EXISTS is_dropped BOOLEAN NOT NULL DEFAULT false; 

-- Add comment explaining the table's purpose
COMMENT ON TABLE load_chips IS 'Tracks all loads in the game, including those on the board, held by players, or dropped in cities (field warehousing)';

-- Add comment explaining the columns
COMMENT ON COLUMN load_chips.type IS 'The type of load (e.g., Coal, Wine, etc.)';
COMMENT ON COLUMN load_chips.city_name IS 'The name of the city where the load was dropped. NULL if not dropped.';
COMMENT ON COLUMN load_chips.is_dropped IS 'True if the load is currently dropped in a city under the field warehousing rule.'; 