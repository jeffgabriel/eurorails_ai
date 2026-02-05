-- Migration: Create block_history table
-- Version: 25
-- Description: Adds table for auditing block/unblock actions

-- Create block_history table
CREATE TABLE IF NOT EXISTS block_history (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    blocker_user_id UUID NOT NULL,
    blocked_user_id UUID NOT NULL,
    action VARCHAR(10) NOT NULL CHECK (action IN ('block', 'unblock')),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Create index for querying user's block history
CREATE INDEX IF NOT EXISTS idx_block_history ON block_history(blocker_user_id, created_at DESC);

-- Add comments
COMMENT ON TABLE block_history IS 'Audit log of all block and unblock actions';
COMMENT ON COLUMN block_history.action IS 'Type of action: block or unblock';
