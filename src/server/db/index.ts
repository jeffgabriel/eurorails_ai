import { Pool } from 'pg';
import dotenv from 'dotenv';

// Load environment variables
dotenv.config();

// Development mode flag
const DEV_MODE = process.env.NODE_ENV === 'development';
const TEST_MODE = process.env.NODE_ENV === 'test';
const CLEAN_DB_ON_START = process.env.CLEAN_DB_ON_START === 'true';

// Create a connection pool
const pool = new Pool({
    user: process.env.DB_USER,
    host: process.env.DB_HOST,
    database: process.env.DB_NAME,
    password: process.env.DB_PASSWORD,
    port: parseInt(process.env.DB_PORT || '5432'),
    ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false,
    max: parseInt(process.env.DB_MAX_CONNECTIONS || '10'),
    idleTimeoutMillis: parseInt(process.env.DB_IDLE_TIMEOUT || '30000'),
});

// Clean all game data
export async function cleanDatabase() {
    if (!DEV_MODE && !TEST_MODE) {
        console.warn('Cleanup attempted in production mode. Skipping.');
        return;
    }
    console.log('Database cleaned for testing');
    try {
        // Get a list of all tables in the database to ensure we don't miss any
        const tableListQuery = `
            SELECT tablename FROM pg_tables 
            WHERE schemaname = 'public' 
            AND tablename != 'schema_migrations'
        `;
        const tableResult = await pool.query(tableListQuery);
        
        // Tables that need to be handled separately due to foreign key constraints
        // Set winner_id to null before deleting players
        await pool.query('UPDATE games SET winner_id = NULL WHERE winner_id IS NOT NULL');
        
        // Delete from tables in an order that respects foreign key constraints
        const tablesToDeleteFirst = [
            'player_track_networks',
            'player_tracks',
            'movement_history',
            'load_chips',
            'demand_cards',
            'event_cards',
            'game_logs',
            'players'
        ];
        
        // First delete from the known tables that have foreign key dependencies
        for (const tableName of tablesToDeleteFirst) {
            try {
                // Check if table exists before attempting deletion
                const tableExistsQuery = `
                    SELECT EXISTS (
                        SELECT FROM information_schema.tables 
                        WHERE table_schema = 'public' 
                        AND table_name = $1
                    )
                `;
                const exists = await pool.query(tableExistsQuery, [tableName]);
                
                if (exists.rows[0].exists) {
                    await pool.query(`DELETE FROM ${tableName}`);
                    console.log(`Cleaned table: ${tableName}`);
                }
            } catch (e) {
                console.warn(`Warning: Failed to clean table ${tableName}:`, e);
            }
        }
        
        // Finally delete from games table (the root of most foreign keys)
        await pool.query('DELETE FROM games');
        console.log('Cleaned table: games');
    } catch (err) {
        console.error('Error cleaning database:', err);
    }
}

// Check database connection and schema version
export async function checkDatabase() {
    try {
        const client = await pool.connect();
        
        try {
            // Check if schema_migrations table exists
            const tableCheck = await client.query(`
                SELECT EXISTS (
                    SELECT FROM information_schema.tables 
                    WHERE table_schema = 'public' 
                    AND table_name = 'schema_migrations'
                );
            `);

            if (!tableCheck.rows[0].exists) {
                console.error('Database schema not initialized. Please run db/scripts/init_db.sh first.');
                return false;
            }

            // Get current schema version
            const versionResult = await client.query('SELECT MAX(version) as version FROM schema_migrations;');
            const currentVersion = versionResult.rows[0].version;
            
            if (currentVersion === null) {
                console.error('No schema migrations found. Please run db/scripts/init_db.sh to initialize the database.');
                return false;
            }
            
            console.log(`Database schema version: ${currentVersion}`);
            
            // Analyze required migrations
            // List all sql files in migrations directory
            const fs = require('fs');
            const path = require('path');
            
            try {
                // Get a list of migration files from the db/migrations directory (consolidated location)
                const migrationsDir = path.join(process.cwd(), 'db', 'migrations');
                const migrationFiles = fs.readdirSync(migrationsDir)
                    .filter(file => file.endsWith('.sql'))
                    .map(file => parseInt(file.split('_')[0]));
                
                // Find the highest migration version
                const highestMigration = Math.max(...migrationFiles);
                
                if (currentVersion < highestMigration) {
                    console.warn(`Database schema is out of date. Current: ${currentVersion}, Latest: ${highestMigration}`);
                    console.warn('Please run db/scripts/init_db.sh to update your database schema.');
                    
                    // Log all migrations that need to be applied
                    const pendingMigrations = migrationFiles
                        .filter(version => version > currentVersion)
                        .sort((a, b) => a - b);
                    
                    if (pendingMigrations.length > 0) {
                        console.warn('Pending migrations:');
                        pendingMigrations.forEach(version => {
                            const filename = fs.readdirSync(migrationsDir)
                                .find(file => file.startsWith(`${version.toString().padStart(3, '0')}_`));
                            console.warn(`- ${filename}`);
                        });
                    }
                }
            } catch (err) {
                console.warn('Error checking migration files:', err);
            }

            // Clean database if in development mode and flag is set
            if (DEV_MODE && CLEAN_DB_ON_START) {
                await cleanDatabase();
            }
            
            return true;
        } finally {
            client.release();
        }
    } catch (err) {
        console.error('Database connection error:', err);
        return false;
    }
}

export const db = pool; 