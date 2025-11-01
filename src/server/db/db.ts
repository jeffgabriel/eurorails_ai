import { Pool } from 'pg';

// Use test database when in test mode, otherwise use configured database
const TEST_MODE = process.env.NODE_ENV === 'test';
const databaseName = TEST_MODE 
    ? (process.env.DB_NAME_TEST || 'eurorails_test')
    : process.env.DB_NAME;

export const db = new Pool({
    user: process.env.DB_USER,
    host: process.env.DB_HOST,
    database: databaseName,
    password: process.env.DB_PASSWORD,
    port: parseInt(process.env.DB_PORT || '5432'),
}); 