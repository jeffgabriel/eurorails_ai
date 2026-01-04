-- Fix data integrity: ensure turn_actions uniqueness is scoped to a single game.
-- Prior constraint UNIQUE(player_id, turn_number) could collide across multiple games.

ALTER TABLE turn_actions
    DROP CONSTRAINT IF EXISTS turn_actions_player_id_turn_number_key;

ALTER TABLE turn_actions
    ADD CONSTRAINT turn_actions_player_id_game_id_turn_number_key UNIQUE (player_id, game_id, turn_number);


