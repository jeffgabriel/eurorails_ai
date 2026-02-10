-- Add is_bot flag to players table for bot identification
ALTER TABLE players ADD COLUMN IF NOT EXISTS is_bot BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE players ADD COLUMN IF NOT EXISTS bot_config JSONB;

-- Bot turn audit storage for Strategy Inspector UI
CREATE TABLE IF NOT EXISTS bot_turn_audits (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    game_id UUID NOT NULL REFERENCES games(id) ON DELETE CASCADE,
    player_id UUID NOT NULL,
    turn_number INTEGER NOT NULL,
    archetype_name TEXT NOT NULL,
    skill_level TEXT NOT NULL CHECK (skill_level IN ('easy', 'medium', 'hard')),
    current_plan TEXT NOT NULL DEFAULT '',
    archetype_rationale TEXT NOT NULL DEFAULT '',
    feasible_options JSONB NOT NULL DEFAULT '[]',
    rejected_options JSONB NOT NULL DEFAULT '[]',
    bot_status JSONB NOT NULL DEFAULT '{}',
    duration_ms INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

-- Index for fast lookup: latest audit per bot in a game
CREATE INDEX idx_bot_turn_audits_game_player ON bot_turn_audits (game_id, player_id, turn_number DESC);
