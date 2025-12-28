-- Add victory state columns to games table
ALTER TABLE games
ADD COLUMN IF NOT EXISTS victory_triggered BOOLEAN DEFAULT FALSE,
ADD COLUMN IF NOT EXISTS victory_trigger_player_index INTEGER DEFAULT -1,
ADD COLUMN IF NOT EXISTS victory_threshold INTEGER DEFAULT 250,
ADD COLUMN IF NOT EXISTS final_turn_player_index INTEGER DEFAULT -1;

-- Add comment explaining the columns
COMMENT ON COLUMN games.victory_triggered IS 'Has a player declared victory by meeting win conditions?';
COMMENT ON COLUMN games.victory_trigger_player_index IS 'Index of the player who triggered victory (-1 if not triggered)';
COMMENT ON COLUMN games.victory_threshold IS 'Current money threshold to win (250M initially, 300M after tie)';
COMMENT ON COLUMN games.final_turn_player_index IS 'Last player to take a turn before game ends (-1 if not triggered)';
