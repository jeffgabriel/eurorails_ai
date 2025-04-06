#!/bin/bash

# Set defaults and load environment variables if .env file exists
if [ -f .env ]; then
    echo "Loading environment variables from .env file..."
    source .env
fi

# Database configuration with environment variable fallbacks
DB_NAME=${DB_NAME:-"eurorails"}
DB_USER=${DB_USER:-"postgres"}
DB_HOST=${DB_HOST:-"localhost"}
DB_PORT=${DB_PORT:-"5432"}
DB_PASSWORD=${DB_PASSWORD:-""}

# Construct the connection string
if [ -n "$DB_PASSWORD" ]; then
    export PGPASSWORD="$DB_PASSWORD"
    CONNECTION_PARAMS="-h $DB_HOST -p $DB_PORT -U $DB_USER"
else
    CONNECTION_PARAMS="-h $DB_HOST -p $DB_PORT -U $DB_USER"
fi

# Print database connection information
echo "============================================================"
echo "Database Initialization"
echo "============================================================"
echo "Host: $DB_HOST"
echo "Port: $DB_PORT"
echo "User: $DB_USER"
echo "Database: $DB_NAME"
echo "------------------------------------------------------------"

# Function to run a migration file
run_migration() {
    local migration_file=$1
    local version=$(basename "$migration_file" | cut -d'_' -f1)
    
    echo "Checking migration $version..."
    
    # Check if migration has already been applied
    if psql $CONNECTION_PARAMS -d $DB_NAME -t -c "SELECT version FROM schema_migrations WHERE version = $version;" | grep -q "$version"; then
        echo "✓ Migration $version already applied"
        return 0
    fi
    
    echo "Applying migration $version..."
    if psql $CONNECTION_PARAMS -d $DB_NAME -f "$migration_file"; then
        echo "✓ Migration $version successfully applied"
        return 0
    else
        echo "✗ Error applying migration $version"
        return 1
    fi
}

# Check if database exists
if ! psql $CONNECTION_PARAMS -lqt | cut -d \| -f 1 | grep -qw "$DB_NAME"; then
    echo "Creating database $DB_NAME..."
    createdb $CONNECTION_PARAMS $DB_NAME
    if [ $? -ne 0 ]; then
        echo "✗ Failed to create database!"
        exit 1
    fi
    echo "✓ Database created successfully"
else
    echo "✓ Database already exists"
fi

# Check if schema_migrations table exists
if ! psql $CONNECTION_PARAMS -d $DB_NAME -tc "SELECT 1 FROM information_schema.tables WHERE table_name = 'schema_migrations'" | grep -q 1; then
    echo "Creating schema_migrations table..."
    psql $CONNECTION_PARAMS -d $DB_NAME -c "CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP);"
    if [ $? -ne 0 ]; then
        echo "✗ Failed to create schema_migrations table!"
        exit 1
    fi
    echo "✓ schema_migrations table created"
else
    echo "✓ schema_migrations table already exists"
fi

echo "------------------------------------------------------------"
echo "Applying migrations..."
echo "------------------------------------------------------------"

# Run all migrations in order
for migration in $(ls db/migrations/*.sql | sort); do
    if ! run_migration "$migration"; then
        echo "✗ Migration failed. Exiting."
        exit 1
    fi
done

echo "============================================================"
echo "✓ Database initialization complete!"
echo "============================================================"