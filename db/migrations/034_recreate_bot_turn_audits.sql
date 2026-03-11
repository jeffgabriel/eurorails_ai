-- Migration: Recreate bot_turn_audits table with correct schema
-- Version: 34
-- Description: The live table was manually altered to a different schema
--              (archetype_name, skill_level, feasible_options, etc.) that does
--              not match what TurnExecutor.ts INSERTs. Every audit INSERT has
--              been failing silently. This drops and recreates with the columns
--              TurnExecutor expects: action, segments_built, cost, remaining_money.

DROP INDEX IF EXISTS idx_bot_turn_audits_created_at;
DROP INDEX IF EXISTS idx_bot_turn_audits_game_player;
DROP INDEX IF EXISTS idx_bot_audits_game;
DROP INDEX IF EXISTS idx_bot_audits_player;
DROP TABLE IF EXISTS bot_turn_audits;

CREATE TABLE bot_turn_audits (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  game_id UUID NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  player_id UUID NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  turn_number INTEGER NOT NULL,
  action VARCHAR(50) NOT NULL,
  segments_built JSONB,
  cost INTEGER DEFAULT 0,
  remaining_money INTEGER,
  duration_ms INTEGER,
  details JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_bot_audits_game ON bot_turn_audits(game_id);
CREATE INDEX idx_bot_audits_player ON bot_turn_audits(player_id);
CREATE INDEX idx_bot_audits_game_player_turn ON bot_turn_audits(game_id, player_id, turn_number DESC);

-- DOWN
-- This migration is not reversible (old data is lost).
