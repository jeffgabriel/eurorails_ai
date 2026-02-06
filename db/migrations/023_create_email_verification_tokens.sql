-- Migration: Create email_verification_tokens table
-- Version: 23
-- Description: Adds table for storing email verification tokens with expiry

-- Create email_verification_tokens table
CREATE TABLE IF NOT EXISTS email_verification_tokens (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token VARCHAR(255) NOT NULL UNIQUE,
    expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Create indexes for performance
CREATE INDEX IF NOT EXISTS idx_verification_token ON email_verification_tokens(token);
CREATE INDEX IF NOT EXISTS idx_verification_user_expiry ON email_verification_tokens(user_id, expires_at);

-- Add comments
COMMENT ON TABLE email_verification_tokens IS 'Email verification tokens with 15-minute expiry';
COMMENT ON COLUMN email_verification_tokens.token IS 'Unique verification token sent to user email';
COMMENT ON COLUMN email_verification_tokens.expires_at IS 'Token expiration timestamp (15 minutes from creation)';
