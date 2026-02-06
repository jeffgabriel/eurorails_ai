-- Migration: Create user_blocks table
-- Version: 24
-- Description: Adds table for storing user block relationships

-- Create user_blocks table
CREATE TABLE IF NOT EXISTS user_blocks (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    blocker_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    blocked_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    blocked_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(blocker_user_id, blocked_user_id)
);

-- Create indexes for performance
CREATE INDEX IF NOT EXISTS idx_blocker ON user_blocks(blocker_user_id);
CREATE INDEX IF NOT EXISTS idx_blocked ON user_blocks(blocked_user_id);

-- Add constraint to prevent self-blocking
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.table_constraints WHERE constraint_name = 'user_blocks_no_self_block' AND table_name = 'user_blocks') THEN
        ALTER TABLE user_blocks ADD CONSTRAINT user_blocks_no_self_block CHECK (blocker_user_id != blocked_user_id);
    END IF;
END $$;

-- Add comments
COMMENT ON TABLE user_blocks IS 'User block relationships for chat blocking';
COMMENT ON COLUMN user_blocks.blocker_user_id IS 'User who initiated the block';
COMMENT ON COLUMN user_blocks.blocked_user_id IS 'User who was blocked';
