DROP TABLE IF EXISTS tracks;

CREATE TABLE IF NOT EXISTS player_track_networks (
    player_id UUID REFERENCES players(id),
    game_id UUID REFERENCES games(id),
    network_state JSONB NOT NULL,  -- Stores serialized TrackNetwork
    total_cost INTEGER NOT NULL DEFAULT 0,
    last_turn_cost INTEGER NOT NULL DEFAULT 0,
    last_build_timestamp TIMESTAMP,
    PRIMARY KEY (player_id, game_id)
);