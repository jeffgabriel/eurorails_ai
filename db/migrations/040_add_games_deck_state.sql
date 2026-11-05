-- Migration: Add per-game deck state columns to games table
-- Version: 40
-- Description: Persists each game's demand/event deck so it survives server restarts
--              (issue #237). Previously the draw/discard piles lived only in memory, so a
--              restart reshuffled every game's deck and could re-deal cards already in hands.
--
-- Encoding (matches DemandDeckService draw keys):
--   positive integer = demand card id, negative integer = -(event card id)
--   The last array element is the top of the pile.
-- Dealt cards are not stored: they are every card in neither pile.
-- NULL means the deck has not been persisted yet; it is built from player hands on first load.

ALTER TABLE games ADD COLUMN IF NOT EXISTS deck_draw_pile INTEGER[] NULL;
ALTER TABLE games ADD COLUMN IF NOT EXISTS deck_discard_pile INTEGER[] NULL;

-- DOWN
-- ALTER TABLE games DROP COLUMN IF EXISTS deck_discard_pile;
-- ALTER TABLE games DROP COLUMN IF EXISTS deck_draw_pile;
