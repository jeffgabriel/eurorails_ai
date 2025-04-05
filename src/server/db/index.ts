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
        // Delete in order that respects foreign key constraints
        await pool.query('DELETE FROM player_track_networks');
        await pool.query('DELETE FROM tracks');
        await pool.query('DELETE FROM load_chips');
        await pool.query('DELETE FROM demand_cards');
        await pool.query('DELETE FROM event_cards');
        await pool.query('DELETE FROM game_logs');
        // Set winner_id to null before deleting players
        await pool.query('UPDATE games SET winner_id = NULL');
        await pool.query('DELETE FROM players');
        await pool.query('DELETE FROM games');
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
            console.log(`Database schema version: ${currentVersion}`);

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