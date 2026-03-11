-- Migration: Add initial build columns to games table
-- Version: 31
-- Description: Adds initial_build_round and initial_build_order columns
--              to support the two-round initial track building phase.

-- Add initial build columns to games table
ALTER TABLE games
ADD COLUMN IF NOT EXISTS initial_build_round INTEGER DEFAULT 0,
ADD COLUMN IF NOT EXISTS initial_build_order JSONB DEFAULT NULL;

-- Add comments explaining the new columns
COMMENT ON COLUMN games.initial_build_round IS 'Current round in the initial build phase (0 = not started, 1 = first round clockwise, 2 = second round counterclockwise)';
COMMENT ON COLUMN games.initial_build_order IS 'JSON array of player IDs defining the turn order for the current initial build round. NULL when not in initial build phase.';

-- Migration rollback (DOWN migration)
-- DOWN
-- ALTER TABLE games DROP COLUMN IF EXISTS initial_build_order;
-- ALTER TABLE games DROP COLUMN IF EXISTS initial_build_round;
