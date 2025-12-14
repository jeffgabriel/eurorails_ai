import { Pool } from 'pg';
import { readFileSync } from 'fs';
import { join } from 'path';
import dotenv from 'dotenv';

dotenv.config();

const initializeDatabase = () => {
    const pool = new Pool({
        user: process.env.DB_USER || 'postgres',
        host: process.env.DB_HOST || 'localhost',
        database: process.env.DB_NAME || 'eurorails',
        password: process.env.DB_PASSWORD || 'postgres',
        port: parseInt(process.env.DB_PORT || '5432')
    });

    const schemaSQL = readFileSync(join(__dirname, 'schema.sql'), 'utf8');
    
    pool.query(schemaSQL)
        .then(() => {
            return pool.end();
        })
        .catch((error: Error) => {
            console.error('Error initializing database schema:', error);
            pool.end();
            process.exit(1);
        });
};

// Initialize the database
initializeDatabase(); 