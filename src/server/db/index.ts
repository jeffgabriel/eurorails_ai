import { Pool, PoolClient } from 'pg';
import dotenv from 'dotenv';
import * as fs from 'fs';
import * as path from 'path';

// Load environment variables
dotenv.config();

// Development mode flag
const DEV_MODE = process.env.NODE_ENV === 'development';
const TEST_MODE = process.env.NODE_ENV === 'test';
const CLEAN_DB_ON_START = process.env.CLEAN_DB_ON_START === 'true';

// Parse DATABASE_URL if provided (Railway, Heroku, etc.)
// Format: postgresql://user:password@host:port/database
function parseDatabaseUrl(): Partial<{
    user: string;
    host: string;
    database: string;
    password: string;
    port: number;
    ssl: boolean | { rejectUnauthorized: boolean };
}> {
    const databaseUrl = process.env.DATABASE_URL;
    if (!databaseUrl) {
        return {};
    }

    try {
        const url = new URL(databaseUrl);
        // Check for explicit sslmode parameter
        const sslMode = url.searchParams.get('sslmode');
        
        // Determine SSL configuration
        let sslConfig: boolean | { rejectUnauthorized: boolean };
        if (sslMode === 'disable') {
            sslConfig = false;
        } else {
            // For Railway/Heroku and other cloud providers, use SSL but allow self-signed certs
            // Railway uses self-signed certificates for internal connections
            // rejectUnauthorized: false is safe because Railway manages the certificates
            sslConfig = { rejectUnauthorized: false };
        }
        
        const parsed = {
            user: url.username,
            password: url.password,
            host: url.hostname,
            port: parseInt(url.port || '5432'),
            database: url.pathname.slice(1), // Remove leading '/'
            ssl: sslConfig
        };
        return parsed;
    } catch (error) {
        console.error('Error parsing DATABASE_URL:', error);
        return {};
    }
}

// Get database configuration from DATABASE_URL or individual env vars
const dbConfigFromUrl = parseDatabaseUrl();
// Check if DATABASE_URL was provided (indicated by presence of host property)
// If DATABASE_URL was provided, its values are authoritative even if empty strings
const usingDatabaseUrl = dbConfigFromUrl.host !== undefined;

// Use test database when in test mode, otherwise use configured database
// IMPORTANT: If DATABASE_URL is provided, use its database name (Railway/Heroku)
// Otherwise fall back to DB_NAME env var
const databaseName = TEST_MODE 
    ? (process.env.DB_NAME_TEST || 'eurorails_test')
    : (usingDatabaseUrl && dbConfigFromUrl.database ? dbConfigFromUrl.database : process.env.DB_NAME);

// Log which database we're using
if (usingDatabaseUrl) {
} else {
}

// Create a connection pool
const pool = new Pool({
    // If DATABASE_URL was provided, use its values (even if empty strings)
    // Otherwise fall back to individual environment variables
    // SECURITY: In test mode, always use test database name, never DATABASE_URL's database
    user: usingDatabaseUrl ? dbConfigFromUrl.user : process.env.DB_USER,
    host: usingDatabaseUrl ? dbConfigFromUrl.host : process.env.DB_HOST,
    database: databaseName, // Always use databaseName (handles test mode correctly)
    password: usingDatabaseUrl ? dbConfigFromUrl.password : process.env.DB_PASSWORD,
    port: usingDatabaseUrl ? dbConfigFromUrl.port : parseInt(process.env.DB_PORT || '5432'),
    ssl: dbConfigFromUrl.ssl !== undefined 
        ? dbConfigFromUrl.ssl 
        : (process.env.DB_SSL === 'true' ? { rejectUnauthorized: process.env.NODE_ENV !== 'test' } : false),
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

async function connectWithRetry(retries = 5, delay = 2000): Promise<PoolClient> {
    for (let i = 0; i < retries; i++) {
        try {
            const client = await pool.connect();
            return client;
        } catch (err) {
            if (i < retries - 1) {
                await new Promise(res => setTimeout(res, delay));
            } else {
                console.error('Database connection failed after multiple retries.');
                throw err;
            }
        }
    }
    throw new Error('Should not reach here');
}

// Check database connection and schema
export async function checkDatabase() {
    let client: PoolClient | undefined;
    try {
        client = await connectWithRetry();

        // 1. Ensure schema_migrations table exists.
        await client.query(`
            CREATE TABLE IF NOT EXISTS schema_migrations (
                version INTEGER PRIMARY KEY,
                applied_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
            );
        `);

        // 2. Get the current schema version.
        const versionResult = await client.query('SELECT MAX(version) as version FROM schema_migrations;');
        const currentVersion = versionResult.rows[0].version || 0;

        // 3. Read migration files from the filesystem.
        const migrationsDir = path.join(process.cwd(), 'db', 'migrations');
        const migrationFiles = fs.readdirSync(migrationsDir)
            .filter(file => file.endsWith('.sql'))
            .map(file => ({
                version: parseInt(file.split('_')[0]),
                file: file,
                path: path.join(migrationsDir, file)
            }))
            .sort((a, b) => a.version - b.version);

        // 4. Find and apply pending migrations.
        const pendingMigrations = migrationFiles.filter(m => m.version > currentVersion);

        if (pendingMigrations.length > 0) {
            await client.query('BEGIN');
            try {
                for (const migration of pendingMigrations) {
                    const sql = fs.readFileSync(migration.path, 'utf-8');
                    console.log(`Applying migration ${migration.version}: ${sql}`);
                    await client.query(sql);
                    await client.query('INSERT INTO schema_migrations (version) VALUES ($1)', [migration.version]);
                }
                await client.query('COMMIT');
            } catch (err) {
                await client.query('ROLLBACK');
                console.error('Error applying migrations, rolled back transaction.', err);
                throw err;
            }
        } else {
        }

        // Clean database if in development mode and flag is set
        if (DEV_MODE && CLEAN_DB_ON_START) {
            await cleanDatabase();
        }
        
        return true;
    } catch (err) {
        console.error('Database connection and schema setup failed:', err);
        return false;
    } finally {
        if (client) {
            client.release();
        }
    }
}

export const db = pool; 