-- Add current_turn_number column to players table if it doesn't exist
ALTER TABLE players ADD COLUMN IF NOT EXISTS current_turn_number INTEGER;

-- Create movement_history table if it doesn't exist
CREATE TABLE IF NOT EXISTS movement_history (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    player_id UUID REFERENCES players(id) ON DELETE CASCADE,
    game_id UUID REFERENCES games(id) ON DELETE CASCADE,
    movement_path JSONB,
    turn_number INTEGER,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Create updated_at trigger for movement_history
CREATE TRIGGER update_movement_history_updated_at
    BEFORE UPDATE ON movement_history
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

-- Insert schema version
INSERT INTO schema_migrations (version) VALUES (6);