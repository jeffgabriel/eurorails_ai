-- Migration: Add debt_owed column for Mercy Borrowing feature
-- Version: 2
-- Description: Adds debt_owed column to players table for tracking borrowed money
--              that must be repaid at 2x rate from delivery payoffs.
--
-- Run: psql -d eurorails_claude -f add_debt_owed.sql

-- ============================================================================
-- UP MIGRATION
-- ============================================================================

-- Add debt_owed column to players table
-- Stores the amount remaining to repay (already doubled when borrowing)
ALTER TABLE players
ADD COLUMN IF NOT EXISTS debt_owed INTEGER NOT NULL DEFAULT 0;

-- Add constraint to prevent negative debt
ALTER TABLE players
ADD CONSTRAINT players_debt_owed_non_negative CHECK (debt_owed >= 0);

-- Record migration in schema_migrations table
INSERT INTO schema_migrations (version) VALUES (2)
ON CONFLICT (version) DO NOTHING;

-- ============================================================================
-- ROLLBACK (run manually if needed)
-- ============================================================================
-- ALTER TABLE players DROP CONSTRAINT IF EXISTS players_debt_owed_non_negative;
-- ALTER TABLE players DROP COLUMN IF EXISTS debt_owed;
-- DELETE FROM schema_migrations WHERE version = 2;
