import { db, checkDatabase } from "../db";
import dotenv from "dotenv";
import "@jest/globals";
import { demandDeckService } from "../services/demandDeckService";
import { Pool } from "pg";

// Load environment variables
dotenv.config();

// Ensure test database exists and is initialized
async function ensureTestDatabase() {
  const TEST_MODE = process.env.NODE_ENV === "test";
  const testDbName = TEST_MODE 
    ? (process.env.DB_NAME_TEST || "eurorails_test")
    : process.env.DB_NAME;

  // Connect to default postgres database to check/create test database
  const adminPool = new Pool({
    user: process.env.DB_USER,
    host: process.env.DB_HOST,
    database: "postgres", // Connect to default database
    password: process.env.DB_PASSWORD,
    port: parseInt(process.env.DB_PORT || "5432"),
  });

  try {
    // Check if test database exists
    const dbCheckResult = await adminPool.query(
      "SELECT 1 FROM pg_database WHERE datname = $1",
      [testDbName]
    );

    if (dbCheckResult.rows.length === 0) {
      console.log(`Creating test database: ${testDbName}`);
      await adminPool.query(`CREATE DATABASE ${testDbName}`);
      console.log(`Test database ${testDbName} created successfully`);
    } else {
      console.log(`Test database ${testDbName} already exists`);
    }
  } catch (err) {
    console.error(`Error ensuring test database exists:`, err);
    throw err;
  } finally {
    await adminPool.end();
  }

  // Now initialize the test database with migrations
  try {
    const initialized = await checkDatabase();
    if (!initialized) {
      throw new Error("Failed to initialize test database");
    }
    console.log(`Test database ${testDbName} initialized with migrations`);
  } catch (err) {
    console.error(`Error initializing test database:`, err);
    throw err;
  }
}

// Global setup
beforeAll(async () => {
  // Ensure we're in test mode
  process.env.NODE_ENV = "test";

  try {
    // Ensure test database exists and is initialized
    await ensureTestDatabase();
    
    // Test the connection by running a simple query
    await db.query("SELECT NOW()");
    console.log("Database connected for tests");
  } catch (err) {
    console.error("Failed to connect to database:", err);
    throw err;
  }
}, 30000);

// Reset deck service before each test to ensure fresh state
beforeEach(() => {
  demandDeckService.reset();
});

// Commented out to prevent database wipes during development
describe("Setup", () => {
  //   beforeEach(async () => {
  //     await db.query('DELETE FROM movement_history');
  //     await db.query('DELETE FROM player_tracks');
  //     await db.query('DELETE FROM players');
  //     //await db.query('DELETE FROM games');
  //   });
  //   afterEach(async () => {
  //     await db.query('DELETE FROM players');
  //     //await db.query('DELETE FROM games');
  //   });
});

// Global teardown
afterAll(async () => {
  let poolClosed = false;
  
  try {
    // Clean up all tables one last time
    await db.query("DELETE FROM movement_history");
    await db.query("DELETE FROM player_tracks");
    await db.query("DELETE FROM players");
    //await db.query('DELETE FROM games');
  } catch (err) {
    // Pool might already be closed, check the error
    if (err instanceof Error && err.message.includes('pool has been ended')) {
      poolClosed = true;
    } else {
      console.error("Error during final table cleanup:", err);
    }
  }

  if (!poolClosed) {
    try {
      // Close the connection pool
      await db.end();
      console.log("Database connection closed");
    } catch (err) {
      // Ignore errors if pool is already closed
      if (err instanceof Error && !err.message.includes('Called end on pool more than once')) {
        console.error("Error closing database connection:", err);
      }
    }
  }
}, 60000); // Increase timeout for cleanup
