-- Add an index to quickly find the active game if it doesn't already exist
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_indexes
        WHERE indexname = 'idx_games_status'
    ) THEN
        CREATE INDEX idx_games_status ON games(status);
    END IF;
END
$$;

-- Insert schema version
INSERT INTO schema_migrations (version) VALUES (5);