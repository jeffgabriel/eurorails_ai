#!/bin/bash

# Load environment variables
source .env

# Create database if it doesn't exist
psql -U $DB_USER -h $DB_HOST -p $DB_PORT -d postgres -c "CREATE DATABASE $DB_NAME;" 2>/dev/null || true

# Apply schema
psql -U $DB_USER -h $DB_HOST -p $DB_PORT -d $DB_NAME -f src/server/db/schema.sql

# Insert initial schema version
psql -U $DB_USER -h $DB_HOST -p $DB_PORT -d $DB_NAME -c "INSERT INTO schema_migrations (version) VALUES (1) ON CONFLICT DO NOTHING;"

echo "Database initialization complete" 