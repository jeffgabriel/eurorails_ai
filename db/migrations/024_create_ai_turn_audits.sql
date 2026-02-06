-- Create ai_turn_audits table for storing AI strategy audit logs
CREATE TABLE IF NOT EXISTS ai_turn_audits (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  game_id UUID NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  player_id UUID NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  turn_number INTEGER NOT NULL,
  snapshot_hash VARCHAR(16),
  feasible_options_count INTEGER,
  infeasible_options_count INTEGER,
  selected_option_type VARCHAR(50),
  selected_option_score NUMERIC(10,2),
  execution_result VARCHAR(20) CHECK (execution_result IN ('success', 'retry', 'fallback', 'timeout')),
  duration_ms INTEGER,
  audit_json JSONB,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_ai_audits_game ON ai_turn_audits(game_id);
CREATE INDEX IF NOT EXISTS idx_ai_audits_player ON ai_turn_audits(player_id);
