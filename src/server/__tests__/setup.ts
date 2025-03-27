import { db } from '../db';
import dotenv from 'dotenv';
import '@jest/globals';

// Load environment variables
dotenv.config();

// Global setup
beforeAll(async () => {
    // Ensure we're in test mode
    process.env.NODE_ENV = 'test';
    
    try {
        // Test the connection by running a simple query
        await db.query('SELECT NOW()');
        console.log('Database connected for tests');
    } catch (err) {
        console.error('Failed to connect to database:', err);
        throw err;
    }
}, 30000);

// Clean up after each test
beforeEach(async () => {
    try {
        await db.query('DELETE FROM players');
        await db.query('DELETE FROM games');
    } catch (err) {
        console.error('Error during test cleanup:', err);
        throw err;
    }
});

// Global teardown
afterAll(async () => {
    try {
        // Clean up all tables one last time
        await db.query('DELETE FROM players');
        await db.query('DELETE FROM games');
    } catch (err) {
        console.error('Error during final table cleanup:', err);
        // Don't throw here, continue with pool end
    }

    try {
        // Close the connection pool
        await db.end();
        console.log('Database connection closed');
    } catch (err) {
        console.error('Error closing database connection:', err);
        // Don't throw here to ensure we always exit
    }
}, 60000); // Increase timeout for cleanup 