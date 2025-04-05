-- Drop existing table (will implicitly drop its foreign keys)
DROP TABLE IF EXISTS player_track_networks;

-- Recreate with proper CASCADE settings
CREATE TABLE player_track_networks (
    player_id UUID REFERENCES players(id) ON DELETE CASCADE,
    game_id UUID REFERENCES games(id) ON DELETE CASCADE,
    network_state JSONB NOT NULL,  -- Stores serialized TrackNetwork
    total_cost INTEGER NOT NULL DEFAULT 0,
    last_turn_cost INTEGER NOT NULL DEFAULT 0,
    last_build_timestamp TIMESTAMP,
    PRIMARY KEY (player_id, game_id)
);

-- Insert schema version
INSERT INTO schema_migrations (version) VALUES (3);