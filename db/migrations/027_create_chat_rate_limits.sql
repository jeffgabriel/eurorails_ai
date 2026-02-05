-- Migration: Create chat_rate_limits table
-- Version: 27
-- Description: Adds table for tracking per-user rate limits (15 messages/minute)

-- Create chat_rate_limits table
CREATE TABLE IF NOT EXISTS chat_rate_limits (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL,
    game_id UUID NOT NULL,
    message_count INTEGER DEFAULT 0,
    window_start TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    last_message_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(user_id, game_id)
);

-- Create index for performance
CREATE INDEX IF NOT EXISTS idx_rate_limit_user_game ON chat_rate_limits(user_id, game_id);

-- Add comments
COMMENT ON TABLE chat_rate_limits IS 'Rate limiting for chat messages (15 messages per minute per user per game)';
COMMENT ON COLUMN chat_rate_limits.message_count IS 'Number of messages sent in current window';
COMMENT ON COLUMN chat_rate_limits.window_start IS 'Start of 60-second rolling window';
