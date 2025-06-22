-- Add camera_state column to games table
ALTER TABLE games ADD COLUMN IF NOT EXISTS camera_state JSONB;