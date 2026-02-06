-- Rename ai_personality to ai_archetype with updated archetype values
-- Drop old constraint and column, add new column with correct archetypes

ALTER TABLE players DROP CONSTRAINT IF EXISTS players_ai_personality_check;

ALTER TABLE players ADD COLUMN IF NOT EXISTS ai_archetype VARCHAR(30);

-- Migrate any existing data from ai_personality to ai_archetype
UPDATE players SET ai_archetype = ai_personality WHERE ai_personality IS NOT NULL;

ALTER TABLE players DROP COLUMN IF EXISTS ai_personality;

-- Add check constraint with the correct archetype values
ALTER TABLE players ADD CONSTRAINT chk_ai_archetype
CHECK (ai_archetype IS NULL OR ai_archetype IN (
    'backbone_builder', 'freight_optimizer', 'trunk_sprinter',
    'continental_connector', 'opportunist'
));
