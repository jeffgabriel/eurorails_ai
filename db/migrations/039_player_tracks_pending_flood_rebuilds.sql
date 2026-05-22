-- Migration: Add pending_flood_rebuilds column to player_tracks table
-- Version: 39
-- Description: Adds a JSONB column to store track segments that need to be rebuilt
--              after a flood event clears a river crossing. The bot uses this to
--              perceive and react to active Flood event cards.
--              Defaults to an empty array -- no backfill needed for existing rows.
--
-- Shape (when populated by flood event processing):
--   [{ "from": [x1, y1], "to": [x2, y2] }, ...]

ALTER TABLE player_tracks
  ADD COLUMN pending_flood_rebuilds JSONB NOT NULL DEFAULT '[]';

-- DOWN
-- ALTER TABLE player_tracks DROP COLUMN pending_flood_rebuilds;
