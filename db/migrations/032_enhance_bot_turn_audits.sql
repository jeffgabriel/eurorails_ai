-- Enhance bot_turn_audits table with additional columns for full AI decision logging
-- Adds: snapshot_hash, selected_plan (JSONB), execution_result (JSONB)
-- Adds: created_at index for retention queries

-- Snapshot hash for linking audit to immutable game state snapshot
ALTER TABLE bot_turn_audits ADD COLUMN IF NOT EXISTS snapshot_hash TEXT NOT NULL DEFAULT '';

-- Full selected plan as structured JSONB (sequence of actions the bot chose)
ALTER TABLE bot_turn_audits ADD COLUMN IF NOT EXISTS selected_plan JSONB NOT NULL DEFAULT '[]';

-- Execution result: success/failure, actions executed, error details
ALTER TABLE bot_turn_audits ADD COLUMN IF NOT EXISTS execution_result JSONB NOT NULL DEFAULT '{}';

-- Index for retention/cleanup queries (delete audits older than N days)
CREATE INDEX IF NOT EXISTS idx_bot_turn_audits_created_at ON bot_turn_audits (created_at);

-- DOWN (for reference, not auto-executed)
-- ALTER TABLE bot_turn_audits DROP COLUMN IF EXISTS snapshot_hash;
-- ALTER TABLE bot_turn_audits DROP COLUMN IF EXISTS selected_plan;
-- ALTER TABLE bot_turn_audits DROP COLUMN IF EXISTS execution_result;
-- DROP INDEX IF EXISTS idx_bot_turn_audits_created_at;
