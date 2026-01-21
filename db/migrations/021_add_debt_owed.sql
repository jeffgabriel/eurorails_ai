-- Migration: Add debt_owed column for Mercy Borrowing feature
-- Version: 21
-- Description: Adds debt_owed column to players table for tracking borrowed money
--              that must be repaid at 2x rate from delivery payoffs.

-- Add debt_owed column to players table
-- Stores the amount remaining to repay (already doubled when borrowing)
ALTER TABLE players
ADD COLUMN IF NOT EXISTS debt_owed INTEGER NOT NULL DEFAULT 0;

-- Add constraint to prevent negative debt
ALTER TABLE players
ADD CONSTRAINT players_debt_owed_non_negative CHECK (debt_owed >= 0);
