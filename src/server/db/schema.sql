-- Create schema_migrations table if it doesn't exist
CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Create games table if it doesn't exist
CREATE TABLE IF NOT EXISTS games (
    id VARCHAR(255) PRIMARY KEY,
    status VARCHAR(50) NOT NULL DEFAULT 'setup',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Create players table if it doesn't exist
CREATE TABLE IF NOT EXISTS players (
    id VARCHAR(255) PRIMARY KEY,
    game_id VARCHAR(255) REFERENCES games(id) ON DELETE CASCADE,
    name VARCHAR(255) NOT NULL,
    color VARCHAR(7) NOT NULL,
    money INTEGER NOT NULL DEFAULT 50,
    train_type VARCHAR(50) NOT NULL DEFAULT 'Freight',
    position_x INTEGER,
    position_y INTEGER,
    position_row INTEGER,
    position_col INTEGER,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Create player_tracks table
CREATE TABLE IF NOT EXISTS player_tracks (
    id SERIAL PRIMARY KEY,
    game_id VARCHAR(255) REFERENCES games(id) ON DELETE CASCADE,
    player_id VARCHAR(255) REFERENCES players(id) ON DELETE CASCADE,
    segments JSONB NOT NULL DEFAULT '[]',
    total_cost INTEGER NOT NULL DEFAULT 0,
    turn_build_cost INTEGER NOT NULL DEFAULT 0,
    last_build_timestamp TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(game_id, player_id)
);

-- Create game_state table
CREATE TABLE IF NOT EXISTS game_state (
    game_id VARCHAR(255) PRIMARY KEY REFERENCES games(id) ON DELETE CASCADE,
    current_player_index INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Function to update timestamps
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ language 'plpgsql';

-- Triggers for updating timestamps
CREATE TRIGGER update_games_updated_at
    BEFORE UPDATE ON games
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_players_updated_at
    BEFORE UPDATE ON players
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_player_tracks_updated_at
    BEFORE UPDATE ON player_tracks
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_game_state_updated_at
    BEFORE UPDATE ON game_state
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();