ALTER TABLE games 
ADD COLUMN status VARCHAR(20) NOT NULL DEFAULT 'setup',
ADD COLUMN created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- Add an index to quickly find the active game
CREATE INDEX idx_games_status ON games(status); 