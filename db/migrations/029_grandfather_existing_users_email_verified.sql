-- Migration: Grandfather existing users as email verified
-- Version: 29
-- Description: Sets email_verified=true for all existing users to avoid disruption

-- Grandfather all existing users as email verified
-- This prevents existing users from being locked out of chat
UPDATE users 
SET email_verified = true 
WHERE email_verified IS NULL OR email_verified = false;

-- Add comment explaining the migration
COMMENT ON COLUMN users.email_verified IS 'Whether email has been verified. Existing users grandfathered as verified in migration 029.';
