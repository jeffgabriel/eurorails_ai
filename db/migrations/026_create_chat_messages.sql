-- Migration: Create chat_messages table
-- Version: 26
-- Description: Adds table for storing in-game chat messages

-- Create chat_messages table
CREATE TABLE IF NOT EXISTS chat_messages (
    id BIGSERIAL PRIMARY KEY,
    game_id UUID NOT NULL,
    sender_user_id UUID NOT NULL,
    recipient_type VARCHAR(10) NOT NULL CHECK (recipient_type IN ('player', 'game')),
    recipient_id UUID NOT NULL,
    message_text VARCHAR(500) NOT NULL,
    is_read BOOLEAN DEFAULT false,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Add foreign key constraints separately to avoid issues with table order
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.table_constraints WHERE constraint_name = 'chat_messages_game_id_fkey' AND table_name = 'chat_messages') THEN
        ALTER TABLE chat_messages ADD CONSTRAINT chat_messages_game_id_fkey FOREIGN KEY (game_id) REFERENCES games(id) ON DELETE CASCADE;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.table_constraints WHERE constraint_name = 'chat_messages_sender_user_id_fkey' AND table_name = 'chat_messages') THEN
        ALTER TABLE chat_messages ADD CONSTRAINT chat_messages_sender_user_id_fkey FOREIGN KEY (sender_user_id) REFERENCES users(id) ON DELETE CASCADE;
    END IF;
END $$;

-- Create indexes for performance
CREATE INDEX IF NOT EXISTS idx_chat_game_recipient ON chat_messages(game_id, recipient_type, recipient_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_chat_sender ON chat_messages(sender_user_id, created_at DESC);

-- Add comments
COMMENT ON TABLE chat_messages IS 'In-game chat messages between players';
COMMENT ON COLUMN chat_messages.message_text IS '500 Unicode characters maximum (counted by String.length in JS, not bytes)';
COMMENT ON COLUMN chat_messages.recipient_type IS 'Type of recipient: player (DM) or game (group chat)';
COMMENT ON COLUMN chat_messages.recipient_id IS 'User ID for player DMs, game ID for group chat';
