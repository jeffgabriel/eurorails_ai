#!/bin/bash

# Database configuration
DB_NAME="eurorails"
DB_USER="postgres"
DB_HOST="localhost"

# Function to run a migration file
run_migration() {
    local migration_file=$1
    local version=$(basename "$migration_file" | cut -d'_' -f1)
    
    echo "Checking migration $version..."
    
    # Check if migration has already been applied
    if psql -h $DB_HOST -U $DB_USER -d $DB_NAME -t -c "SELECT version FROM schema_migrations WHERE version = $version;" | grep -q "$version"; then
        echo "Migration $version already applied"
        return 0
    fi
    
    echo "Applying migration $version..."
    if psql -h $DB_HOST -U $DB_USER -d $DB_NAME -f "$migration_file"; then
        echo "Migration $version successfully applied"
        return 0
    else
        echo "Error applying migration $version"
        return 1
    fi
}

# Check if database exists
if ! psql -h $DB_HOST -U $DB_USER -lqt | cut -d \| -f 1 | grep -qw "$DB_NAME"; then
    echo "Creating database $DB_NAME..."
    createdb -h $DB_HOST -U $DB_USER $DB_NAME
fi

# Run all migrations in order
for migration in $(ls db/migrations/*.sql | sort); do
    if ! run_migration "$migration"; then
        echo "Migration failed. Exiting."
        exit 1
    fi
done

echo "Database initialization complete!" 