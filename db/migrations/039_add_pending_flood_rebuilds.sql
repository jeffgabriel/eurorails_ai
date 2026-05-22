-- Migration 039: Add pending_flood_rebuilds column to player_tracks
--
-- When a Flood event card is drawn, the server erases all bridge segments
-- crossing the named river from player_tracks.segments. These erased segments
-- are recorded here so the bot can eagerly rebuild them after the Flood card
-- discards. The column is a JSONB array of TrackSegment objects (same shape as
-- the entries in the segments column).
--
-- JIRA-256 Phase 4 — eager Flood rebuild policy.

ALTER TABLE player_tracks
ADD COLUMN pending_flood_rebuilds JSONB NOT NULL DEFAULT '[]';
