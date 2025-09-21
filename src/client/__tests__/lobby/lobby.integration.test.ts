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
  Object.defineProperty(window, 'localStorage', {
    value: mockLocalStorage,
    writable: true,
    configurable: true,
  });
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

describe('Lobby Integration Tests - Real Server Communication', () => {
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

    it('should get game with real server', async () => {
      // First create a game
      const createResult = await api.createGame({ isPublic: true });
      const gameId = createResult.game.id;

      // Then get the game
      const result = await api.getGame(gameId);
      
      expect(result.game).toBeDefined();
      expect(result.game.id).toBe(gameId);
      expect(result.game.status).toBe('IN_SETUP');
    }, TEST_TIMEOUT);

    it('should get game players with real server', async () => {
      // First create a game
      const createResult = await api.createGame({ isPublic: true });
      const gameId = createResult.game.id;

      // Then get the players
      const result = await api.getGamePlayers(gameId);
      
      expect(result.players).toBeDefined();
      expect(Array.isArray(result.players)).toBe(true);
      expect(result.players.length).toBeGreaterThan(0);
      
      // Verify player structure
      const player = result.players[0];
      expect(player.id).toBeDefined();
      expect(player.userId).toBeDefined();
      expect(player.name).toBeDefined();
      expect(player.color).toBeDefined();
      expect(player.isOnline).toBeDefined();
    }, TEST_TIMEOUT);

    it('should start game with real server', async () => {
      // First create a game
      const createResult = await api.createGame({ isPublic: true });
      const gameId = createResult.game.id;

      // Then start the game
      await expect(api.startGame(gameId)).resolves.not.toThrow();
    }, TEST_TIMEOUT);

    it('should leave game with real server', async () => {
      // First create a game
      const createResult = await api.createGame({ isPublic: true });
      const gameId = createResult.game.id;

      // Then leave the game
      await expect(api.leaveGame(gameId)).resolves.not.toThrow();
    }, TEST_TIMEOUT);

    it('should update player presence with real server', async () => {
      const userId = '123e4567-e89b-12d3-a456-426614174000';
      const isOnline = false;

      await expect(api.updatePlayerPresence(userId, isOnline)).resolves.not.toThrow();
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

    it('should join game through store with real server', async () => {
      // First create a game
      const createResult = await api.createGame({ isPublic: true });
      const joinCode = createResult.game.joinCode;

      const joinData: JoinGameForm = {
        joinCode: joinCode,
      };

      const result = await useLobbyStore.getState().joinGame(joinData);
      
      expect(result).toBeDefined();
      expect(result.id).toBe(createResult.game.id);
      expect(result.joinCode).toBe(joinCode);
      
      // Verify store state
      const state = useLobbyStore.getState();
      expect(state.currentGame).toEqual(result);
      expect(state.isLoading).toBe(false);
      expect(state.error).toBeNull();
    }, TEST_TIMEOUT);

    it('should load current game through store with real server', async () => {
      // First create a game
      const createResult = await api.createGame({ isPublic: true });
      const gameId = createResult.game.id;

      await useLobbyStore.getState().loadCurrentGame(gameId);
      
      // Verify store state
      const state = useLobbyStore.getState();
      expect(state.currentGame).toBeDefined();
      expect(state.currentGame?.id).toBe(gameId);
      expect(state.isLoading).toBe(false);
      expect(state.error).toBeNull();
    }, TEST_TIMEOUT);

    it('should load game players through store with real server', async () => {
      // First create a game
      const createResult = await api.createGame({ isPublic: true });
      const gameId = createResult.game.id;

      await useLobbyStore.getState().loadGamePlayers(gameId);
      
      // Verify store state
      const state = useLobbyStore.getState();
      expect(state.players).toBeDefined();
      expect(Array.isArray(state.players)).toBe(true);
      expect(state.isLoading).toBe(false);
      expect(state.error).toBeNull();
    }, TEST_TIMEOUT);

    it('should start game through store with real server', async () => {
      // First create a game
      const createResult = await api.createGame({ isPublic: true });
      const gameId = createResult.game.id;

      // Set the game in store state
      useLobbyStore.setState({ currentGame: createResult.game });

      await useLobbyStore.getState().startGame(gameId);
      
      // Verify store state
      const state = useLobbyStore.getState();
      expect(state.currentGame?.status).toBe('ACTIVE');
      expect(state.isLoading).toBe(false);
      expect(state.error).toBeNull();
    }, TEST_TIMEOUT);

    it('should leave game through store with real server', async () => {
      // First create a game
      const createResult = await api.createGame({ isPublic: true });
      const gameId = createResult.game.id;

      // Set the game in store state
      useLobbyStore.setState({ currentGame: createResult.game });

      await useLobbyStore.getState().leaveGame();
      
      // Verify store state
      const state = useLobbyStore.getState();
      expect(state.currentGame).toBeNull();
      expect(state.players).toEqual([]);
      expect(state.error).toBeNull();
      expect(state.retryCount).toBe(0);
    }, TEST_TIMEOUT);

    it('should update player presence through store with real server', async () => {
      const userId = '123e4567-e89b-12d3-a456-426614174000';
      const isOnline = false;

      await useLobbyStore.getState().updatePlayerPresence(userId, isOnline);
      
      // Verify no errors occurred
      const state = useLobbyStore.getState();
      expect(state.error).toBeNull();
    }, TEST_TIMEOUT);
  });

  describe('Error Handling Integration', () => {
    it('should handle server validation errors', async () => {
      // Test with invalid data that should trigger server validation
      const invalidGameData = {
        maxPlayers: 999, // Invalid: should be 2-6
      } as any;

      await expect(useLobbyStore.getState().createGame(invalidGameData))
        .rejects.toThrow();
      
      // Verify error state
      const state = useLobbyStore.getState();
      expect(state.error).toBeDefined();
      expect(state.isLoading).toBe(false);
    }, TEST_TIMEOUT);

    it('should handle invalid join code', async () => {
      const invalidJoinData: JoinGameForm = {
        joinCode: 'INVALID',
      };

      await expect(useLobbyStore.getState().joinGame(invalidJoinData))
        .rejects.toThrow();
      
      // Verify error state
      const state = useLobbyStore.getState();
      expect(state.error).toBeDefined();
      expect(state.isLoading).toBe(false);
    }, TEST_TIMEOUT);

    it('should handle non-existent game', async () => {
      const nonExistentGameId = '00000000-0000-0000-0000-000000000000';

      await expect(useLobbyStore.getState().loadCurrentGame(nonExistentGameId))
        .rejects.toThrow();
      
      // Verify error state
      const state = useLobbyStore.getState();
      expect(state.error).toBeDefined();
      expect(state.isLoading).toBe(false);
    }, TEST_TIMEOUT);
  });

  describe('Loading States Integration', () => {
    it('should show loading state during real API calls', async () => {
      const gameData: CreateGameForm = {
        isPublic: true,
      };

      // Start the operation
      const createPromise = useLobbyStore.getState().createGame(gameData);
      
      // Check loading state immediately
      expect(useLobbyStore.getState().isLoading).toBe(true);
      
      // Wait for completion
      await createPromise;
      
      // Check loading state after completion
      expect(useLobbyStore.getState().isLoading).toBe(false);
    }, TEST_TIMEOUT);

    it('should clear loading state on error', async () => {
      const invalidGameData = {
        maxPlayers: 999,
      } as any;

      try {
        await useLobbyStore.getState().createGame(invalidGameData);
      } catch (error) {
        // Expected to throw
      }
      
      // Check loading state after error
      expect(useLobbyStore.getState().isLoading).toBe(false);
    }, TEST_TIMEOUT);
  });

  describe('End-to-End Workflow Integration', () => {
    it('should complete full game creation workflow', async () => {
      // 1. Create game
      const gameData: CreateGameForm = {
        isPublic: true,
      };
      const game = await useLobbyStore.getState().createGame(gameData);
      
      expect(game).toBeDefined();
      expect(useLobbyStore.getState().currentGame).toEqual(game);
      
      // 2. Load players
      await useLobbyStore.getState().loadGamePlayers(game.id);
      
      expect(useLobbyStore.getState().players).toBeDefined();
      expect(Array.isArray(useLobbyStore.getState().players)).toBe(true);
      
      // 3. Start game
      await useLobbyStore.getState().startGame(game.id);
      
      expect(useLobbyStore.getState().currentGame?.status).toBe('ACTIVE');
      
      // 4. Leave game
      await useLobbyStore.getState().leaveGame();
      
      expect(useLobbyStore.getState().currentGame).toBeNull();
      expect(useLobbyStore.getState().players).toEqual([]);
    }, TEST_TIMEOUT);

    it('should complete full game joining workflow', async () => {
      // 1. Create game
      const createResult = await api.createGame({ isPublic: true });
      const joinCode = createResult.game.joinCode;
      
      // 2. Join game
      const joinData: JoinGameForm = {
        joinCode: joinCode,
      };
      const game = await useLobbyStore.getState().joinGame(joinData);
      
      expect(game).toBeDefined();
      expect(game.id).toBe(createResult.game.id);
      expect(useLobbyStore.getState().currentGame).toEqual(game);
      
      // 3. Load players
      await useLobbyStore.getState().loadGamePlayers(game.id);
      
      expect(useLobbyStore.getState().players).toBeDefined();
      expect(useLobbyStore.getState().players.length).toBeGreaterThan(0);
    }, TEST_TIMEOUT);
  });
});
