import { db, cleanDatabase } from '../db';
import dotenv from 'dotenv';
import '@jest/globals';

// Load environment variables
dotenv.config();

// Global setup
beforeAll(async () => {
    // Ensure we're in test mode
    process.env.NODE_ENV = 'test';
    
    // Wait for database connection
    try {
        const client = await db.connect();
        await client.query('SELECT 1');
        client.release();
        console.log('Database connected for tests');
    } catch (err) {
        console.error('Failed to connect to database:', err);
        throw err;
    }
});

// Clean up after each test
afterEach(async () => {
    await cleanDatabase();
});

// Global teardown
afterAll(async () => {
    await cleanDatabase();
    await db.end();
}); 