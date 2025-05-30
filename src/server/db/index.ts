import { Pool } from 'pg';
import dotenv from 'dotenv';

// Load environment variables
dotenv.config();

// Development mode flag
const DEV_MODE = process.env.NODE_ENV === 'development';
const TEST_MODE = process.env.NODE_ENV === 'test';
const CLEAN_DB_ON_START = process.env.CLEAN_DB_ON_START === 'false';

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
        return;
    }
    try {
        // Get a list of all tables in the database except schema_migrations
        const tableListQuery = `
            SELECT tablename FROM pg_tables 
            WHERE schemaname = 'public' 
            AND tablename != 'schema_migrations'
        `;
        const tableResult = await pool.query(tableListQuery);
        const tables = tableResult.rows.map(row => row.tablename);
        if (tables.length > 0) {
            // Disable triggers to avoid foreign key issues
            await pool.query('SET session_replication_role = replica;');
            await pool.query(`TRUNCATE TABLE ${tables.map(t => '"' + t + '"').join(', ')} RESTART IDENTITY CASCADE`);
            await pool.query('SET session_replication_role = DEFAULT;');
        }
    } catch (err) {
        // Optionally rethrow or handle error
        throw err;
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