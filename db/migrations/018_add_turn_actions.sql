-- Create turn_actions table for server-authored per-turn action history (used for undo)
CREATE TABLE IF NOT EXISTS turn_actions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    player_id UUID REFERENCES players(id) ON DELETE CASCADE,
    game_id UUID REFERENCES games(id) ON DELETE CASCADE,
    turn_number INTEGER NOT NULL,
    actions JSONB NOT NULL DEFAULT '[]'::jsonb,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(player_id, turn_number)
);

-- Create updated_at trigger for turn_actions
DROP TRIGGER IF EXISTS update_turn_actions_updated_at ON turn_actions;
CREATE TRIGGER update_turn_actions_updated_at
    BEFORE UPDATE ON turn_actions
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();


