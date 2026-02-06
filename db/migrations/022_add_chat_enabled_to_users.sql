-- Migration: Add chat_enabled column to users table
-- Version: 22
-- Description: Adds chat_enabled column to allow users to enable/disable chat functionality

-- Add chat_enabled column to users table
ALTER TABLE users
ADD COLUMN IF NOT EXISTS chat_enabled BOOLEAN NOT NULL DEFAULT true;

-- Add index for performance when filtering by chat_enabled status
CREATE INDEX IF NOT EXISTS idx_users_chat_enabled ON users(chat_enabled);

-- Add comment explaining the column
COMMENT ON COLUMN users.chat_enabled IS 'Whether the user has chat functionality enabled (can be toggled in settings)';
