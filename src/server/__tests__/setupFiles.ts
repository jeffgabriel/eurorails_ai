// This file runs BEFORE the test framework is installed (setupFiles, not setupFilesAfterEnv)
// It ensures NODE_ENV is set to 'test' before any modules are imported
// This is critical because database connection modules read NODE_ENV at module load time

// Set NODE_ENV to test before any imports
process.env.NODE_ENV = 'test';

// Load environment variables if .env file exists
import dotenv from 'dotenv';
dotenv.config();

