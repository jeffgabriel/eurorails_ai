-- Migration: Create game_message_counts table
-- Version: 28
-- Description: Adds table for tracking total messages per game (1000 message limit)

-- Create game_message_counts table
CREATE TABLE IF NOT EXISTS game_message_counts (
    game_id UUID PRIMARY KEY,
    total_messages INTEGER DEFAULT 0,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Add foreign key constraint separately
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.table_constraints WHERE constraint_name = 'game_message_counts_game_id_fkey' AND table_name = 'game_message_counts') THEN
        ALTER TABLE game_message_counts ADD CONSTRAINT game_message_counts_game_id_fkey FOREIGN KEY (game_id) REFERENCES games(id) ON DELETE CASCADE;
    END IF;
END $$;

-- Add trigger to update updated_at
DROP TRIGGER IF EXISTS update_game_message_counts_updated_at ON game_message_counts;
CREATE TRIGGER update_game_message_counts_updated_at
    BEFORE UPDATE ON game_message_counts
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

-- Add comments
COMMENT ON TABLE game_message_counts IS 'Total message count per game (limit: 1000 messages)';
COMMENT ON COLUMN game_message_counts.total_messages IS 'Total number of messages sent in this game';
