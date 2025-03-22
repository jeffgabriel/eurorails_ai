-- Create schema_migrations table if it doesn't exist
CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Create games table if it doesn't exist
CREATE TABLE IF NOT EXISTS games (
    id VARCHAR(36) PRIMARY KEY,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    status VARCHAR(20) DEFAULT 'setup',
    max_players INTEGER DEFAULT 6
);

-- Create players table if it doesn't exist
CREATE TABLE IF NOT EXISTS players (
    id VARCHAR(36) PRIMARY KEY,
    game_id VARCHAR(36) REFERENCES games(id) ON DELETE CASCADE,
    name VARCHAR(100) NOT NULL,
    color VARCHAR(7) NOT NULL CHECK (color ~ '^#[0-9A-Fa-f]{6}$'),  -- Hex color code validation
    money INTEGER DEFAULT 50,
    train_type VARCHAR(20) DEFAULT 'Freight',
    turn_order INTEGER,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(game_id, name),
    UNIQUE(game_id, color),
    UNIQUE(game_id, turn_order)
);

-- Create game_players table if it doesn't exist
CREATE TABLE IF NOT EXISTS game_players (
    id VARCHAR(36) PRIMARY KEY,
    game_id VARCHAR(36) REFERENCES games(id) ON DELETE CASCADE,
    player_id VARCHAR(36) REFERENCES players(id) ON DELETE CASCADE,
    color VARCHAR(7) NOT NULL,  -- Hex color code
    money INTEGER DEFAULT 50,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(game_id, player_id),
    UNIQUE(game_id, color)
); 