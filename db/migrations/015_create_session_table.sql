-- Migration 015: Create session table for connect-pg-simple
-- This migration manually creates the session table that connect-pg-simple uses
-- The table should be created automatically by connect-pg-simple with createTableIfMissing: true,
-- but this migration ensures it exists reliably, especially if there are permission issues

-- Create session table with exact schema expected by connect-pg-simple v10.0.0
CREATE TABLE IF NOT EXISTS "session" (
  "sid" varchar NOT NULL COLLATE "default",
  "sess" json NOT NULL,
  "expire" timestamp(6) NOT NULL
)
WITH (OIDS=FALSE);

-- Add primary key constraint if it doesn't exist
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint 
        WHERE conname = 'session_pkey' 
        AND conrelid = 'session'::regclass
    ) THEN
        ALTER TABLE "session" ADD CONSTRAINT "session_pkey" PRIMARY KEY ("sid") NOT DEFERRABLE INITIALLY IMMEDIATE;
    END IF;
END $$;

-- Create index on expire column if it doesn't exist (for cleanup operations)
CREATE INDEX IF NOT EXISTS "IDX_session_expire" ON "session" ("expire");

-- Add comment
COMMENT ON TABLE "session" IS 'Session store table for connect-pg-simple. Stores express-session data.';

