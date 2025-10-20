/**
 * Integration Tests - Real Server Communication
 * These tests make actual HTTP requests to the running server
 */

// Use Node.js built-in fetch (Node 18+)
import { useLobbyStore } from '../../lobby/store/lobby.store';
import { api } from '../../lobby/shared/api';
import { CreateGameForm, JoinGameForm } from '../../lobby/shared/types';
import { db } from '../../../server/db';
import { v4 as uuidv4 } from 'uuid';

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
    // First delete players (to satisfy foreign key constraints), then any remaining games
    if (playerIds.length > 0) {
      await client.query('DELETE FROM players WHERE id = ANY($1)', [playerIds]);
    }
    if (gameIds.length > 0) {
      await client.query('DELETE FROM games WHERE id = ANY($1)', [gameIds]);
    }
  });
}

// Mock localStorage for user identification
const mockLocalStorage = {
  getItem: jest.fn(),
  setItem: jest.fn(),
  removeItem: jest.fn(),
  clear: jest.fn(),
} as unknown as Storage;

beforeAll(async () => {
  // Mock global objects for Node environment
  global.localStorage = mockLocalStorage;
  global.window = {
    localStorage: mockLocalStorage,
  } as any;
  
  // Verify server is running before tests
  try {
    await api.healthCheck();
  } catch (err) {
    throw new Error('Server is not available for integration tests');
  }
});

beforeEach(() => {
  jest.clearAllMocks();
  // Reset store state
  useLobbyStore.setState({
    currentGame: null,
    players: [],
    isLoading: false,
    error: null,
    retryCount: 0,
  });
  // Mock user in localStorage
  (mockLocalStorage.getItem as jest.Mock).mockImplementation((key) => {
    if (key === 'eurorails.user') {
      return JSON.stringify({ id: '123e4567-e89b-12d3-a456-426614174000', name: 'Test User' });
    }
    if (key === 'eurorails.jwt') {
      return 'mock-jwt-token';
    }
    return null;
  });
});

describe('Integration Tests - Real Server Communication', () => {
  // Test timeout for real server calls
  const TEST_TIMEOUT = 10000;
  let testGameIds: string[] = [];
  let testPlayerIds: string[] = [];
  let testUserId: string;
  let testUserId2: string;

  beforeAll(async () => {
    // Generate test user IDs
    testUserId = '123e4567-e89b-12d3-a456-426614174000';
    testUserId2 = '123e4567-e89b-12d3-a456-426614174001';
    
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
    
    // Close database connection pool
    await db.end();
  });

  describe('API Client Integration', () => {
    it('should call real server health endpoint', async () => {
      const result = await api.healthCheck();
      
      expect(result).toEqual({
        message: 'Lobby service is healthy'
      });
    }, TEST_TIMEOUT);

    it('should create game with real server', async () => {
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
