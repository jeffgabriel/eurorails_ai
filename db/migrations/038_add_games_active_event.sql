-- Migration: Add active_event column to games table
-- Version: 36
-- Description: Adds a nullable JSONB column to store the currently active event card
--              per game. At most one event can be active at a time (per rulebook rules).
--              This column is populated by Project 3 (event effect processing).
--              No backfill required -- existing rows default to NULL.
--
-- Shape (when populated by Project 3):
--   { "cardId": 131, "drawingPlayerId": "uuid", "drawingPlayerIndex": 2, "expiresAfterTurnNumber": 17 }

ALTER TABLE games ADD COLUMN active_event JSONB NULL;

-- DOWN
-- ALTER TABLE games DROP COLUMN active_event;
