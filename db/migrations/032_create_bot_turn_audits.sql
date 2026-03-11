-- Migration: Create bot_turn_audits table
-- Version: 32
-- Description: Persists bot decision data for debugging. Stores action taken,
--              track segments built, costs, and extensible details per bot turn.

CREATE TABLE bot_turn_audits (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  game_id UUID NOT NULL REFERENCES games(id),
  player_id UUID NOT NULL REFERENCES players(id),
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

-- Migration rollback (DOWN migration)
-- DOWN
-- DROP INDEX IF EXISTS idx_bot_audits_player;
-- DROP INDEX IF EXISTS idx_bot_audits_game;
-- DROP TABLE IF EXISTS bot_turn_audits;
