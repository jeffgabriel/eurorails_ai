-- Add a per-game monotonic server sequence number for Socket.IO state sync
-- Used for state:init and state:patch ordering and gap detection.

ALTER TABLE games
ADD COLUMN IF NOT EXISTS server_seq BIGINT NOT NULL DEFAULT 0;


