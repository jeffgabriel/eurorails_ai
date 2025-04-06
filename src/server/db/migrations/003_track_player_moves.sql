-- Add train direction columns to players table
ALTER TABLE players
ADD COLUMN current_turn_number INTEGER;

CREATE TABLE movement_history (
    id SERIAL PRIMARY KEY,
    player_id character varying(255) REFERENCES players(id) ON DELETE CASCADE,
    movement_path JSONB,
    turn_number INTEGER
);
