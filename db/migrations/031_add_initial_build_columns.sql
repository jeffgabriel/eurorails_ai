-- Add initial build phase tracking columns to games table
ALTER TABLE games ADD COLUMN IF NOT EXISTS initial_build_round INTEGER NOT NULL DEFAULT 0;
ALTER TABLE games ADD COLUMN IF NOT EXISTS initial_build_order JSONB;

-- DOWN (for reference, not auto-executed)
-- ALTER TABLE games DROP COLUMN IF EXISTS initial_build_round;
-- ALTER TABLE games DROP COLUMN IF EXISTS initial_build_order;
