-- Add debt_owed column to players table to track borrowing debt
ALTER TABLE players
ADD COLUMN IF NOT EXISTS debt_owed INTEGER NOT NULL DEFAULT 0;

-- Add constraint to ensure debt_owed is non-negative
ALTER TABLE players DROP CONSTRAINT IF EXISTS player_debt_non_negative;
ALTER TABLE players
ADD CONSTRAINT player_debt_non_negative CHECK (debt_owed >= 0);

-- Add comment explaining the column
COMMENT ON COLUMN players.debt_owed IS 'Amount player owes to bank (in millions ECU). Repaid automatically from delivery payments.';

-- Migration rollback
-- DOWN
-- ALTER TABLE players DROP COLUMN debt_owed;


