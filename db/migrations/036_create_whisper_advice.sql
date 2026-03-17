-- Migration: Create whisper_advice table for human-to-bot coaching
-- Version: 36
-- Description: Stores human player advice about bot decisions, including
--              the full game state snapshot and bot decision summary for
--              later review and analysis.

CREATE TABLE IF NOT EXISTS whisper_advice (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  game_id UUID NOT NULL,
  turn_number INTEGER NOT NULL,
  bot_player_id UUID NOT NULL,
  human_player_id UUID NOT NULL,
  advice TEXT NOT NULL,
  bot_decision JSONB NOT NULL,
  game_state_snapshot JSONB NOT NULL,
  metadata JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_whisper_game_id ON whisper_advice (game_id);
CREATE INDEX IF NOT EXISTS idx_whisper_game_turn ON whisper_advice (game_id, turn_number);

-- DOWN
-- DROP TABLE IF EXISTS whisper_advice;
