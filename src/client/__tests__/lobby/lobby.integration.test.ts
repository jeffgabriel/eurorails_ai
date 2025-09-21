/**
 * Integration Tests - Real Server Communication
 * These tests make actual HTTP requests to the running server
 */

// Use Node.js built-in fetch (Node 18+)
import { useLobbyStore } from '../../lobby/store/lobby.store';
import { api } from '../../lobby/shared/api';
import { CreateGameForm, JoinGameForm } from '../../lobby/shared/types';

// Mock localStorage for user identification
const mockLocalStorage = {
  getItem: jest.fn(),
  setItem: jest.fn(),
  removeItem: jest.fn(),
  clear: jest.fn(),
} as unknown as Storage;

beforeAll(() => {
  // Mock global objects for Node environment
  global.localStorage = mockLocalStorage;
  global.window = {
    localStorage: mockLocalStorage,
  } as any;
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
    return null;
  });
});

describe('Integration Tests - Real Server Communication', () => {
  // Test timeout for real server calls
  const TEST_TIMEOUT = 10000;

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
      
      expect(result.game).toBeDefined();
      expect(result.game.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
      expect(result.game.joinCode).toMatch(/^[A-Z0-9]{8}$/);
      expect(result.game.status).toBe('IN_SETUP');
      expect(result.game.maxPlayers).toBe(4);
      expect(result.game.isPublic).toBe(true);
    }, TEST_TIMEOUT);

    it('should join game with real server', async () => {
      // First create a game
      const createResult = await api.createGame({ isPublic: true });
      const gameId = createResult.game.id;
      const joinCode = createResult.game.joinCode;

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
