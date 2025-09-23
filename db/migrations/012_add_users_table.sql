-- Migration 012: Add users table for authentication
-- This migration creates the users table and updates existing schema

-- Create users table
CREATE TABLE IF NOT EXISTS users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    username VARCHAR(50) UNIQUE NOT NULL,
    email VARCHAR(255) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    email_verified BOOLEAN DEFAULT false,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    last_active TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Add indexes for performance
CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
CREATE INDEX IF NOT EXISTS idx_users_last_active ON users(last_active);

-- Add updated_at trigger
DROP TRIGGER IF EXISTS update_users_updated_at ON users;
CREATE TRIGGER update_users_updated_at
    BEFORE UPDATE ON users
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

-- Update players table to reference users (nullable for backward compatibility)
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.table_constraints 
        WHERE constraint_name = 'fk_players_user_id' AND table_name = 'players'
    ) THEN
        ALTER TABLE players 
        ADD CONSTRAINT fk_players_user_id 
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;
    END IF;
END $$;

-- Update games table to reference users instead of players
-- Migrate existing game creators by mapping player IDs to user IDs
UPDATE games g
SET created_by = p.user_id
FROM players p WHERE g.created_by = p.id;

-- Handle orphaned games (games with created_by that don't have corresponding players)
UPDATE games SET created_by = NULL WHERE created_by IS NOT NULL AND created_by NOT IN (SELECT id FROM users);

-- Drop both possible constraint names
ALTER TABLE games 
DROP CONSTRAINT IF EXISTS fk_games_created_by;
ALTER TABLE games 
DROP CONSTRAINT IF EXISTS games_created_by_fkey;
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.table_constraints 
        WHERE constraint_name = 'fk_games_created_by' AND table_name = 'games'
    ) THEN
        ALTER TABLE games 
        ADD CONSTRAINT fk_games_created_by 
        FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE CASCADE;
    END IF;
END $$;

-- Add comments explaining the new columns
COMMENT ON TABLE users IS 'User accounts for authentication and game participation';
COMMENT ON COLUMN users.username IS 'Unique username for display and login';
COMMENT ON COLUMN users.email IS 'Unique email address for login and notifications';
COMMENT ON COLUMN users.password_hash IS 'Hashed password using bcrypt';
COMMENT ON COLUMN users.email_verified IS 'Whether the email address has been verified';
COMMENT ON COLUMN users.last_active IS 'Last time the user was active in the system';
