import { useLobbyStore } from '../../lobby/store/lobby.store';
import { api } from '../../lobby/shared/api';
import { CreateGameForm, JoinGameForm } from '../../lobby/shared/types';

// Mock the API client
jest.mock('../../lobby/shared/api', () => ({
  api: {
    createGame: jest.fn(),
    joinGame: jest.fn(),
    getGame: jest.fn(),
    getGamePlayers: jest.fn(),
    startGame: jest.fn(),
  },
  getErrorMessage: jest.fn(),
}));

const mockApi = api as jest.Mocked<typeof api>;

// Mock localStorage
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
      return JSON.stringify({ id: 'user-123', name: 'Test User' });
    }
    return null;
  });
});

describe('Lobby End-to-End Flows', () => {
  describe('Complete Game Creation Flow', () => {
    it('should handle complete game creation workflow', async () => {
      const gameData: CreateGameForm = {
        isPublic: true,
      };

      const mockGame = {
        id: 'game-123',
        joinCode: 'ABC123',
        createdBy: 'user-123',
        status: 'IN_SETUP' as const,
        maxPlayers: 4,
        isPublic: true,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      const mockPlayers = [
        {
          id: 'player-1',
          userId: 'user-123',
          name: 'Test User',
          color: '#FF0000',
          isOnline: true,
        },
      ];

      // Mock API responses
      mockApi.createGame.mockResolvedValueOnce({ game: mockGame });
      mockApi.getGamePlayers.mockResolvedValueOnce({ players: mockPlayers });

      // Start the workflow
      const store = useLobbyStore.getState();
      
      // 1. Create game
      expect(store.isLoading).toBe(false);
      expect(store.currentGame).toBeNull();
      
      const createPromise = store.createGame(gameData);
      
      // Should be loading immediately
      expect(useLobbyStore.getState().isLoading).toBe(true);
      
      const result = await createPromise;
      
      // Should have created game and loaded players
      expect(result).toEqual(mockGame);
      expect(useLobbyStore.getState().currentGame).toEqual(mockGame);
      expect(useLobbyStore.getState().players).toEqual(mockPlayers);
      expect(useLobbyStore.getState().isLoading).toBe(false);
      expect(useLobbyStore.getState().error).toBeNull();
      
      // Verify API calls
      expect(mockApi.createGame).toHaveBeenCalledWith(gameData);
      expect(mockApi.getGamePlayers).toHaveBeenCalledWith('game-123');
    });

    it('should handle game creation with player loading failure gracefully', async () => {
      const gameData: CreateGameForm = {
        isPublic: true,
      };

      const mockGame = {
        id: 'game-123',
        joinCode: 'ABC123',
        createdBy: 'user-123',
        status: 'IN_SETUP' as const,
        maxPlayers: 4,
        isPublic: true,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      // Mock API responses - game creation succeeds, player loading fails
      mockApi.createGame.mockResolvedValueOnce({ game: mockGame });
      mockApi.getGamePlayers.mockRejectedValueOnce(new Error('Player loading failed'));

      const store = useLobbyStore.getState();
      
      // Create game should still succeed even if player loading fails
      const result = await store.createGame(gameData);
      
      // Game should be created successfully
      expect(result).toEqual(mockGame);
      expect(useLobbyStore.getState().currentGame).toEqual(mockGame);
      expect(useLobbyStore.getState().isLoading).toBe(false);
      expect(useLobbyStore.getState().error).toBeNull(); // No error should be set
      
      // Players should be empty due to loading failure
      expect(useLobbyStore.getState().players).toEqual([]);
    });
  });

  describe('Complete Game Joining Flow', () => {
    it('should handle complete game joining workflow', async () => {
      const joinData: JoinGameForm = {
        joinCode: 'ABC123',
      };

      const mockGame = {
        id: 'game-123',
        joinCode: 'ABC123',
        createdBy: 'user-456',
        status: 'IN_SETUP' as const,
        maxPlayers: 4,
        isPublic: true,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      const mockPlayers = [
        {
          id: 'player-1',
          userId: 'user-456',
          name: 'Creator',
          color: '#FF0000',
          isOnline: true,
        },
        {
          id: 'player-2',
          userId: 'user-123',
          name: 'Joining Player',
          color: '#00FF00',
          isOnline: true,
        },
      ];

      // Mock API responses
      mockApi.joinGame.mockResolvedValueOnce({ game: mockGame });
      mockApi.getGamePlayers.mockResolvedValueOnce({ players: mockPlayers });

      const store = useLobbyStore.getState();
      
      // 1. Join game
      expect(store.isLoading).toBe(false);
      expect(store.currentGame).toBeNull();
      
      const joinPromise = store.joinGame(joinData);
      
      // Should be loading immediately
      expect(useLobbyStore.getState().isLoading).toBe(true);
      
      const result = await joinPromise;
      
      // Should have joined game and loaded all players
      expect(result).toEqual(mockGame);
      expect(useLobbyStore.getState().currentGame).toEqual(mockGame);
      expect(useLobbyStore.getState().players).toEqual(mockPlayers);
      expect(useLobbyStore.getState().isLoading).toBe(false);
      expect(useLobbyStore.getState().error).toBeNull();
      
      // Verify API calls
      expect(mockApi.joinGame).toHaveBeenCalledWith(joinData);
      expect(mockApi.getGamePlayers).toHaveBeenCalledWith('game-123');
    });

    it('should handle join game with invalid join code', async () => {
      const joinData: JoinGameForm = {
        joinCode: 'INVALID',
      };

      // Mock API error
      mockApi.joinGame.mockRejectedValueOnce({
        code: 'INVALID_JOIN_CODE',
        message: 'Invalid join code',
      });

      const store = useLobbyStore.getState();
      
      try {
        await store.joinGame(joinData);
        fail('Expected function to throw');
      } catch (error) {
        // Expected to throw
      }
      
      // Should have error state
      expect(useLobbyStore.getState().error?.code).toBe('INVALID_JOIN_CODE');
      expect(useLobbyStore.getState().isLoading).toBe(false);
      expect(useLobbyStore.getState().currentGame).toBeNull();
      expect(useLobbyStore.getState().players).toEqual([]);
    });
  });

  describe('Complete Game Start Flow', () => {
    it('should handle complete game start workflow', async () => {
      const mockGame = {
        id: 'game-123',
        joinCode: 'ABC123',
        createdBy: 'user-123',
        status: 'IN_SETUP' as const,
        maxPlayers: 4,
        isPublic: true,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      const mockStartedGame = {
        ...mockGame,
        status: 'IN_PROGRESS' as const,
      };

      const mockPlayers = [
        {
          id: 'player-1',
          userId: 'user-123',
          name: 'Creator',
          color: '#FF0000',
          isOnline: true,
        },
        {
          id: 'player-2',
          userId: 'user-456',
          name: 'Player 2',
          color: '#00FF00',
          isOnline: true,
        },
      ];

      // Set up initial state
      useLobbyStore.setState({
        currentGame: mockGame,
        players: mockPlayers,
        isLoading: false,
        error: null,
      });

      // Mock API responses
      mockApi.startGame.mockResolvedValueOnce();

      const store = useLobbyStore.getState();
      
      // 1. Start game
      expect(store.isLoading).toBe(false);
      expect(store.currentGame?.status).toBe('IN_SETUP');
      
      const startPromise = store.startGame('game-123');
      
      // Should be loading immediately
      expect(useLobbyStore.getState().isLoading).toBe(true);
      
      await startPromise;
      
      // Should have started game (status updated locally)
      expect(useLobbyStore.getState().currentGame?.status).toBe('ACTIVE');
      expect(useLobbyStore.getState().isLoading).toBe(false);
      expect(useLobbyStore.getState().error).toBeNull();
      
      // Verify API call
      expect(mockApi.startGame).toHaveBeenCalledWith('game-123');
    });

    it('should handle game start with insufficient players', async () => {
      const mockGame = {
        id: 'game-123',
        joinCode: 'ABC123',
        createdBy: 'user-123',
        status: 'IN_SETUP' as const,
        maxPlayers: 4,
        isPublic: true,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      // Set up initial state with only one player
      useLobbyStore.setState({
        currentGame: mockGame,
        players: [
          {
            id: 'player-1',
            userId: 'user-123',
            name: 'Creator',
            color: '#FF0000',
            isOnline: true,
          },
        ],
        isLoading: false,
        error: null,
      });

      // Mock API error
      mockApi.startGame.mockRejectedValueOnce({
        code: 'INSUFFICIENT_PLAYERS',
        message: 'At least 2 players required to start game',
      });

      const store = useLobbyStore.getState();
      
      try {
        await store.startGame('game-123');
        fail('Expected function to throw');
      } catch (error) {
        // Expected to throw
      }
      
      // Should have error state
      expect(useLobbyStore.getState().error?.code).toBe('INSUFFICIENT_PLAYERS');
      expect(useLobbyStore.getState().isLoading).toBe(false);
      expect(useLobbyStore.getState().currentGame?.status).toBe('IN_SETUP'); // Should remain unchanged
    });
  });

  describe('Complete Leave Game Flow', () => {
    it('should handle complete leave game workflow', async () => {
      const mockGame = {
        id: 'game-123',
        joinCode: 'ABC123',
        createdBy: 'user-123',
        status: 'IN_SETUP' as const,
        maxPlayers: 4,
        isPublic: true,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      const mockPlayers = [
        {
          id: 'player-1',
          userId: 'user-123',
          name: 'Creator',
          color: '#FF0000',
          isOnline: true,
        },
      ];

      // Set up initial state
      useLobbyStore.setState({
        currentGame: mockGame,
        players: mockPlayers,
        isLoading: false,
        error: null,
        retryCount: 2, // Simulate some retry state
      });

      // Mock API response - leaveGame is a void function

      const store = useLobbyStore.getState();
      
      // 1. Leave game
      expect(store.currentGame).toEqual(mockGame);
      expect(store.players).toEqual(mockPlayers);
      expect(store.retryCount).toBe(2);
      
      await store.leaveGame();
      
      // Should have cleared all state
      expect(useLobbyStore.getState().currentGame).toBeNull();
      expect(useLobbyStore.getState().players).toEqual([]);
      expect(useLobbyStore.getState().error).toBeNull();
      expect(useLobbyStore.getState().retryCount).toBe(0);
      
      // leaveGame is a void function, no API call to verify
    });
  });

  describe('Error Recovery and Retry Flow', () => {
    it('should handle retryable error and retry logic', async () => {
      const gameData: CreateGameForm = {
        isPublic: true,
      };

      const mockGame = {
        id: 'game-123',
        joinCode: 'ABC123',
        createdBy: 'user-123',
        status: 'IN_SETUP' as const,
        maxPlayers: 4,
        isPublic: true,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      // Mock API to fail first time, succeed second time
      mockApi.createGame
        .mockRejectedValueOnce({
          code: 'HTTP_500',
          message: 'Internal server error',
        })
        .mockResolvedValueOnce({ game: mockGame });
      mockApi.getGamePlayers.mockResolvedValueOnce({ players: [] });

      const store = useLobbyStore.getState();
      
      // First attempt should fail
      try {
        await store.createGame(gameData);
        fail('Expected function to throw');
      } catch (error) {
        // Expected to throw
      }
      
      // Should have error state and retry count
      expect(useLobbyStore.getState().error?.code).toBe('HTTP_500');
      expect(useLobbyStore.getState().retryCount).toBe(1);
      expect(useLobbyStore.getState().isLoading).toBe(false);
      
      // Second attempt should succeed
      const result = await store.createGame(gameData);
      
      // Should have succeeded
      expect(result).toEqual(mockGame);
      expect(useLobbyStore.getState().currentGame).toEqual(mockGame);
      expect(useLobbyStore.getState().error).toBeNull();
      expect(useLobbyStore.getState().retryCount).toBe(0);
      expect(useLobbyStore.getState().isLoading).toBe(false);
    });

    it('should handle non-retryable error without retry', async () => {
      const gameData: CreateGameForm = {
        isPublic: true,
      };

      // Mock API to fail with non-retryable error
      mockApi.createGame.mockRejectedValueOnce({
        code: 'VALIDATION_ERROR',
        message: 'Invalid game data',
      });

      const store = useLobbyStore.getState();
      
      try {
        await store.createGame(gameData);
        fail('Expected function to throw');
      } catch (error) {
        // Expected to throw
      }
      
      // Should have error state and retry count reset to 0 for non-retryable errors
      expect(useLobbyStore.getState().error?.code).toBe('VALIDATION_ERROR');
      expect(useLobbyStore.getState().retryCount).toBe(0); // Should reset to 0 for non-retryable errors
      expect(useLobbyStore.getState().isLoading).toBe(false);
    });
  });

  describe('State Consistency Across Operations', () => {
    it('should maintain consistent state across multiple operations', async () => {
      const mockGame = {
        id: 'game-123',
        joinCode: 'ABC123',
        createdBy: 'user-123',
        status: 'IN_SETUP' as const,
        maxPlayers: 4,
        isPublic: true,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      const mockPlayers = [
        {
          id: 'player-1',
          userId: 'user-123',
          name: 'Creator',
          color: '#FF0000',
          isOnline: true,
        },
      ];

      // Mock API responses
      mockApi.createGame.mockResolvedValueOnce({ game: mockGame });
      mockApi.getGamePlayers.mockResolvedValue({ players: mockPlayers });
      mockApi.getGame.mockResolvedValueOnce({ game: mockGame });

      const store = useLobbyStore.getState();
      
      // 1. Create game
      await store.createGame();
      expect(useLobbyStore.getState().currentGame).toEqual(mockGame);
      expect(useLobbyStore.getState().players).toEqual(mockPlayers);
      
      // 2. Load current game (should maintain state)
      await store.loadCurrentGame('game-123');
      expect(useLobbyStore.getState().currentGame).toEqual(mockGame);
      
      // 3. Load game players (should maintain state)
      await store.loadGamePlayers('game-123');
      expect(useLobbyStore.getState().players).toEqual(mockPlayers);
      
      // State should be consistent throughout
      expect(useLobbyStore.getState().currentGame?.id).toBe('game-123');
      expect(useLobbyStore.getState().players).toHaveLength(1);
      expect(useLobbyStore.getState().error).toBeNull();
      expect(useLobbyStore.getState().isLoading).toBe(false);
    });
  });
});
