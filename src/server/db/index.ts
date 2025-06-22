import { Pool } from 'pg';
import dotenv from 'dotenv';
import * as fs from 'fs';
import * as path from 'path';

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

// Check database connection and schema
export async function checkDatabase() {
    const client = await pool.connect();
    try {
        console.log('Initializing and verifying database schema...');

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
        console.log(`Current database schema version: ${currentVersion}`);

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
            console.log('Pending migrations found. Applying now...');
            await client.query('BEGIN');
            try {
                for (const migration of pendingMigrations) {
                    console.log(`- Applying migration ${migration.file}...`);
                    const sql = fs.readFileSync(migration.path, 'utf-8');
                    await client.query(sql);
                    await client.query('INSERT INTO schema_migrations (version) VALUES ($1)', [migration.version]);
                }
                await client.query('COMMIT');
                console.log('All pending migrations applied successfully.');
            } catch (err) {
                await client.query('ROLLBACK');
                console.error('Error applying migrations, rolled back transaction.', err);
                throw err;
            }
        } else {
            console.log('Database schema is up to date.');
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
        client.release();
    }
}

export const db = pool; 