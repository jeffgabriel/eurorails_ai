-- Drop existing table (will implicitly drop its foreign keys)
DROP TABLE IF EXISTS player_track_networks;

-- Table: public.player_tracks

-- DROP TABLE IF EXISTS public.player_tracks;

CREATE TABLE IF NOT EXISTS public.player_tracks
(
    id SERIAL, 
    game_id UUID REFERENCES games(id) ON DELETE CASCADE,
    player_id UUID REFERENCES players(id) ON DELETE CASCADE,
    segments jsonb NOT NULL DEFAULT '[]'::jsonb,
    total_cost integer NOT NULL DEFAULT 0,
    turn_build_cost integer NOT NULL DEFAULT 0,
    last_build_timestamp timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (game_id, player_id)
)

TABLESPACE pg_default;

ALTER TABLE IF EXISTS public.player_tracks
    OWNER to postgres;

-- Trigger: update_player_tracks_updated_at

-- DROP TRIGGER IF EXISTS update_player_tracks_updated_at ON public.player_tracks;

CREATE OR REPLACE TRIGGER update_player_tracks_updated_at
    BEFORE UPDATE 
    ON public.player_tracks
    FOR EACH ROW
    EXECUTE FUNCTION public.update_updated_at_column();