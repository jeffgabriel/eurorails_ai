/**
 * Integration Tests - Real Server Communication
 * These tests make actual HTTP requests to the running server
 */

// Use Node.js built-in fetch (Node 18+)
import { useLobbyStore } from '../../lobby/store/lobby.store';
import { api } from '../../lobby/shared/api';
import { config } from '../../lobby/shared/config';
import { CreateGameForm, JoinGameForm } from '../../lobby/shared/types';
import { db } from '../../../server/db';
import { v4 as uuidv4 } from 'uuid';
import jwt from 'jsonwebtoken';

// Helper function to run database queries with proper connection handling
async function runQuery<T = any>(queryFn: (client: any) => Promise<T>): Promise<T> {
  const client = await db.connect();
  try {
    return await queryFn(client);
  } finally {
    client.release();
  }
}

// Helper function to clean up test data
async function cleanupTestData(gameIds: string[], playerIds: string[]) {
  await runQuery(async (client) => {
    // Delete in dependency order to avoid constraint errors
    // First delete related data, then players, then games
    if (gameIds.length > 0) {
      // Delete related data first
      await client.query('DELETE FROM movement_history WHERE game_id = ANY($1)', [gameIds]);
      await client.query('DELETE FROM player_tracks WHERE game_id = ANY($1)', [gameIds]);
      await client.query('DELETE FROM load_chips WHERE game_id = ANY($1)', [gameIds]);
      // Delete players associated with these games
      await client.query('DELETE FROM players WHERE game_id = ANY($1)', [gameIds]);
      // Finally delete the games
      await client.query('DELETE FROM games WHERE id = ANY($1)', [gameIds]);
    }
    // Also clean up players by ID if provided (for cases where we have player IDs but not game IDs)
    if (playerIds.length > 0) {
      await client.query('DELETE FROM players WHERE id = ANY($1)', [playerIds]);
    }
  });
}

// Helper function to generate JWT token for testing
function generateTestToken(userId: string, username: string, email: string): string {
  const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key-change-in-production';
  const payload = {
    userId,
    email,
    username,
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + (15 * 60), // 15 minutes
  };
  return jwt.sign(payload, JWT_SECRET);
}

// Mock localStorage for user identification
const mockLocalStorage = {
  getItem: jest.fn(),
  setItem: jest.fn(),
  removeItem: jest.fn(),
  clear: jest.fn(),
} as unknown as Storage;

// Track server availability - will be set in beforeAll
let serverAvailable = false;

// Skip integration tests if SKIP_INTEGRATION_TESTS is set (e.g., in CI without server)
const SKIP_INTEGRATION = process.env.SKIP_INTEGRATION_TESTS === 'true';

beforeAll(async () => {
  // Mock global objects for Node environment
  global.localStorage = mockLocalStorage;
  global.window = {
    localStorage: mockLocalStorage,
  } as any;
  
  // Skip if flag is set
  if (SKIP_INTEGRATION) {
    serverAvailable = false;
    return;
  }
  
  // Verify server is running before tests
  try {
    await api.healthCheck();
    serverAvailable = true;
  } catch (err) {
    // In CI or when server isn't available, we'll skip the tests gracefully
    if (process.env.CI) {
      console.warn('Integration tests will be skipped: Server not available in CI');
      serverAvailable = false;
      return;
    }
    throw new Error(
      'Server is not available for integration tests. ' +
      'Please ensure the server is running with NODE_ENV=test to use the test database. ' +
      'To skip these tests, set SKIP_INTEGRATION_TESTS=true'
    );
  }
  
  // NOTE: For integration tests to work correctly, the server must be started with NODE_ENV=test
  // so it connects to the test database (eurorails_test) instead of the development database.
  // This ensures that users created by the tests are visible to the server's API endpoints.
});

beforeEach(async () => {
  if (!serverAvailable) return;
  
  jest.clearAllMocks();
  // Reset store state
  useLobbyStore.setState({
    currentGame: null,
    players: [],
    isLoading: false,
    error: null,
    retryCount: 0,
  });
  // Mock user in localStorage (default to first test user)
  // Generate token for default test user (tokens for other users are set in individual tests)
  const defaultToken = generateTestToken('123e4567-e89b-12d3-a456-426614174000', 'testuser1', 'test1@example.com');
  (mockLocalStorage.getItem as jest.Mock).mockImplementation((key) => {
    if (key === 'eurorails.user') {
      return JSON.stringify({ id: '123e4567-e89b-12d3-a456-426614174000', name: 'Test User' });
    }
    if (key === 'eurorails.jwt') {
      return defaultToken;
    }
    return null;
  });
  
  // Reset deck service on server
  try {
    const response = await fetch(`${config.apiBaseUrl}/api/deck/reset`, {
      method: 'POST',
      headers: { 
        'Content-Type': 'application/json',
        'x-test-secret': 'test-reset-secret'
      }
    });
    if (!response.ok) {
      throw new Error(`Deck reset failed with status ${response.status}`);
    }
  } catch (error) {
    // If reset fails and server was available, this is a problem
    if (serverAvailable) {
      throw new Error(`Failed to reset deck: ${error}`);
    }
  }
});

describe('Integration Tests - Real Server Communication', () => {
  // Test timeout for real server calls
  const TEST_TIMEOUT = 10000;
  let testGameIds: string[] = [];
  let testPlayerIds: string[] = [];
  let testUserId: string;
  let testUserId2: string;
  let testUserToken: string;
  let testUserToken2: string;

  beforeAll(async () => {
    // Generate test user IDs
    testUserId = '123e4567-e89b-12d3-a456-426614174000';
    testUserId2 = '123e4567-e89b-12d3-a456-426614174001';
    
    // Skip if server is not available
    if (!serverAvailable) {
      console.log('Skipping test setup - server not available');
      return;
    }
    
    // Create test users in the database
    await runQuery(async (client) => {
      await client.query(
        'INSERT INTO users (id, username, email, password_hash) VALUES ($1, $2, $3, $4)',
        [testUserId, 'testuser1', 'test1@example.com', 'hashedpassword1']
      );
      await client.query(
        'INSERT INTO users (id, username, email, password_hash) VALUES ($1, $2, $3, $4)',
        [testUserId2, 'testuser2', 'test2@example.com', 'hashedpassword2']
      );
    });
    
    // Generate JWT tokens for test users
    testUserToken = generateTestToken(testUserId, 'testuser1', 'test1@example.com');
    testUserToken2 = generateTestToken(testUserId2, 'testuser2', 'test2@example.com');
  });

  afterEach(async () => {
    // Clean up test data after each test
    await cleanupTestData(testGameIds, testPlayerIds);
    testGameIds = [];
    testPlayerIds = [];
  });

  afterAll(async () => {
    // Final cleanup
    await cleanupTestData(testGameIds, testPlayerIds);
    
    // Clean up test users
    await runQuery(async (client) => {
      await client.query('DELETE FROM users WHERE id = $1 OR id = $2', [testUserId, testUserId2]);
    });
    
    // Note: Database pool is closed by global teardown in setup.ts
  });

  describe('API Client Integration', () => {
    it('should call real server health endpoint', async () => {
      if (!serverAvailable) {
        console.log('Skipping test - server not available');
        return;
      }
      const result = await api.healthCheck();
      
      expect(result).toEqual({
        message: 'Lobby service is healthy'
      });
    }, TEST_TIMEOUT);

    it('should create game with real server', async () => {
      if (!serverAvailable) {
        console.log('Skipping test - server not available');
        return;
      }
      const gameData: CreateGameForm = {
        isPublic: true,
      };

      const result = await api.createGame(gameData);
      testGameIds.push(result.game.id);
      
      expect(result.game).toBeDefined();
      expect(result.game.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
      expect(result.game.joinCode).toMatch(/^[A-Z0-9]{8}$/);
      expect(result.game.status).toBe('IN_SETUP');
      expect(result.game.maxPlayers).toBe(6); // Default max players is now 6
      expect(result.game.isPublic).toBe(true);
    }, TEST_TIMEOUT);

    it('should join game with real server', async () => {
      if (!serverAvailable) {
        console.log('Skipping test - server not available');
        return;
      }
      // First create a game
      const createResult = await api.createGame({ isPublic: true });
      const gameId = createResult.game.id;
      const joinCode = createResult.game.joinCode;
      testGameIds.push(gameId);

      // Then join the game
      const joinData: JoinGameForm = {
        joinCode: joinCode,
      };

      const result = await api.joinGame(joinData);
      
      expect(result.game).toBeDefined();
      expect(result.game.id).toBe(gameId);
      expect(result.game.joinCode).toBe(joinCode);
    }, TEST_TIMEOUT);
  });

  describe('Lobby Store Integration', () => {
    it('should create game through store with real server', async () => {
      if (!serverAvailable) {
        console.log('Skipping test - server not available');
        return;
      }
      const gameData: CreateGameForm = {
        isPublic: true,
      };

      const result = await useLobbyStore.getState().createGame(gameData);
      testGameIds.push(result.id);
      
      expect(result).toBeDefined();
      expect(result.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
      expect(result.joinCode).toMatch(/^[A-Z0-9]{8}$/);
      expect(result.status).toBe('IN_SETUP');
      
      // Verify store state
      const state = useLobbyStore.getState();
      expect(state.currentGame).toEqual(result);
      expect(state.isLoading).toBe(false);
      expect(state.error).toBeNull();
    }, TEST_TIMEOUT);
  });
});
