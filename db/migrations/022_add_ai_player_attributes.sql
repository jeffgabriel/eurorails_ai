-- Add AI player attributes to players table
ALTER TABLE players
ADD COLUMN IF NOT EXISTS is_ai BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE players
ADD COLUMN IF NOT EXISTS ai_difficulty VARCHAR(20);

ALTER TABLE players
ADD COLUMN IF NOT EXISTS ai_personality VARCHAR(20);

-- Index for filtering AI players in a game
CREATE INDEX IF NOT EXISTS idx_players_is_ai ON players (game_id, is_ai) WHERE is_ai = true;

-- Check constraints
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'players_ai_difficulty_check') THEN
    ALTER TABLE players ADD CONSTRAINT players_ai_difficulty_check
    CHECK (ai_difficulty IS NULL OR ai_difficulty IN ('easy', 'medium', 'hard'));
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'players_ai_personality_check') THEN
    ALTER TABLE players ADD CONSTRAINT players_ai_personality_check
    CHECK (ai_personality IS NULL OR ai_personality IN (
        'optimizer', 'network_builder', 'opportunist',
        'blocker', 'steady_hand', 'chaos_agent'
    ));
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'players_ai_no_user_id') THEN
    ALTER TABLE players ADD CONSTRAINT players_ai_no_user_id
    CHECK (NOT is_ai OR user_id IS NULL);
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'players_ai_requires_difficulty') THEN
    ALTER TABLE players ADD CONSTRAINT players_ai_requires_difficulty
    CHECK (NOT is_ai OR ai_difficulty IS NOT NULL);
  END IF;
END $$;
