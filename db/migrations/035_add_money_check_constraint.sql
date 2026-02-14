-- Migration: Add CHECK constraint to prevent negative player money
-- Version: 35
-- Description: Without this constraint, a race condition or bug in
--              TurnExecutor could deduct more money than available,
--              leaving the player with a negative balance. The DB
--              should enforce this as a last line of defense.

ALTER TABLE players ADD CONSTRAINT players_money_non_negative CHECK (money >= 0);

-- DOWN
-- ALTER TABLE players DROP CONSTRAINT players_money_non_negative;
