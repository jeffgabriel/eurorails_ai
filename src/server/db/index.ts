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
    user: process.env.DB_USER || 'postgres',
    host: process.env.DB_HOST || 'localhost',
    database: process.env.DB_NAME || 'eurorails',
    password: String(process.env.DB_PASSWORD || ''),  // Ensure password is a string
    port: parseInt(process.env.DB_PORT || '5432'),
    ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false,
    max: parseInt(process.env.DB_MAX_CONNECTIONS || '10'),
    idleTimeoutMillis: parseInt(process.env.DB_IDLE_TIMEOUT || '30000'),
});

// Clean all game data
export async function cleanDatabase(): Promise<void> {
    if (!DEV_MODE && !TEST_MODE) {
        console.warn('Cleanup attempted in production mode. Skipping.');
        return;
    }

    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        // Delete in correct order to respect foreign keys
        await client.query('DELETE FROM players');
        await client.query('DELETE FROM games');
        await client.query('COMMIT');
        console.log('Database cleaned for', TEST_MODE ? 'testing' : 'development');
    } catch (err) {
        await client.query('ROLLBACK');
        console.error('Error cleaning database:', err);
        throw err;
    } finally {
        client.release();
    }
}

// Check database connection and schema version
export async function checkDatabase(): Promise<boolean> {
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

// Export pool for use in other modules
export const db = pool; 