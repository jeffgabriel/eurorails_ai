-- Migration: Add AI player fields for AI Adversaries feature
-- Version: 22
-- Description: Adds is_ai, ai_difficulty, and ai_personality columns to players table
--              to support AI opponents with configurable difficulty and personality.

-- Add is_ai column to distinguish AI players from human players
ALTER TABLE players
ADD COLUMN IF NOT EXISTS is_ai BOOLEAN NOT NULL DEFAULT FALSE;

-- Add ai_difficulty column for AI skill level
ALTER TABLE players
ADD COLUMN IF NOT EXISTS ai_difficulty VARCHAR(10);

-- Add ai_personality column for AI playstyle
ALTER TABLE players
ADD COLUMN IF NOT EXISTS ai_personality VARCHAR(20);

-- Add CHECK constraint for ai_difficulty
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.table_constraints WHERE constraint_name = 'players_ai_difficulty_check' AND table_name = 'players') THEN
        ALTER TABLE players ADD CONSTRAINT players_ai_difficulty_check
        CHECK (ai_difficulty IS NULL OR ai_difficulty IN ('easy', 'medium', 'hard'));
    END IF;
END $$;

-- Add CHECK constraint for ai_personality
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.table_constraints WHERE constraint_name = 'players_ai_personality_check' AND table_name = 'players') THEN
        ALTER TABLE players ADD CONSTRAINT players_ai_personality_check
        CHECK (ai_personality IS NULL OR ai_personality IN ('optimizer', 'network_builder', 'opportunist', 'blocker', 'steady_hand', 'chaos_agent'));
    END IF;
END $$;

-- Add index on is_ai for efficient filtering of AI vs human players
CREATE INDEX IF NOT EXISTS idx_players_is_ai ON players(is_ai) WHERE is_ai = TRUE;
