BEGIN;

-- Update load_chips table to better track dropped loads
ALTER TABLE load_chips DROP COLUMN IF EXISTS location;
ALTER TABLE load_chips DROP COLUMN IF EXISTS player_id;

-- Add new columns for tracking dropped loads
ALTER TABLE load_chips ADD COLUMN city_name TEXT NOT NULL;
-- Add comment explaining the table's purpose
COMMENT ON TABLE load_chips IS 'Tracks loads that have been dropped in cities that do not naturally produce them';

-- Add comment explaining the columns
COMMENT ON COLUMN load_chips.type IS 'The type of load (e.g., Coal, Wine, etc.)';
COMMENT ON COLUMN load_chips.city_name IS 'The name of the city where the load was dropped';

-- Insert schema version
INSERT INTO schema_migrations (version) VALUES (10); 
COMMIT;