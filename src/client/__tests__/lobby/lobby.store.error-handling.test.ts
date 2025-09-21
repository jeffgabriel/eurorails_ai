// src/client/__tests__/lobby/lobby.store.error-handling.test.ts
import { useLobbyStore } from '../../lobby/store/lobby.store';
import { api } from '../../lobby/shared/api';
import type { ApiError } from '../../lobby/shared/types';

// Mock the API client
jest.mock('../../lobby/shared/api', () => ({
  api: {
    createGame: jest.fn(),
    joinGame: jest.fn(),
    getGame: jest.fn(),
    getGamePlayers: jest.fn(),
    startGame: jest.fn(),
  },
  getErrorMessage: jest.fn((error: ApiError) => error.message),
}));

const mockApi = api as jest.Mocked<typeof api>;

describe('LobbyStore Error Handling', () => {
  beforeEach(() => {
    // Reset store state completely
    useLobbyStore.setState({
      currentGame: null,
      players: [],
      isLoading: false,
      error: null,
      retryCount: 0,
    });
    
    // Clear all mocks
    jest.clearAllMocks();
  });

  describe('Input Validation Errors', () => {
    it('should throw error for empty join code', async () => {
      try {
        await useLobbyStore.getState().joinGame({ joinCode: '' });
        fail('Expected function to throw');
      } catch (error) {
        expect(error).toEqual({
          code: 'INVALID_JOIN_CODE',
          message: 'Join code is required',
        });
      }
      
      const state = useLobbyStore.getState();
      expect(state.error?.code).toBe('INVALID_JOIN_CODE');
    });

    it('should throw error for empty game ID in loadCurrentGame', async () => {
      try {
        await useLobbyStore.getState().loadCurrentGame('');
        fail('Expected function to throw');
      } catch (error) {
        expect(error).toEqual({
          code: 'INVALID_GAME_ID',
          message: 'Game ID is required',
        });
      }
      
      const state = useLobbyStore.getState();
      expect(state.error?.code).toBe('INVALID_GAME_ID');
    });

    it('should throw error for empty game ID in loadGamePlayers', async () => {
      try {
        await useLobbyStore.getState().loadGamePlayers('');
        fail('Expected function to throw');
      } catch (error) {
        expect(error).toEqual({
          code: 'INVALID_GAME_ID',
          message: 'Game ID is required',
        });
      }
      
      const state = useLobbyStore.getState();
      expect(state.error?.code).toBe('INVALID_GAME_ID');
    });

    it('should throw error for empty game ID in startGame', async () => {
      try {
        await useLobbyStore.getState().startGame('');
        fail('Expected function to throw');
      } catch (error) {
        expect(error).toEqual({
          code: 'INVALID_GAME_ID',
          message: 'Game ID is required',
        });
      }
      
      const state = useLobbyStore.getState();
      expect(state.error?.code).toBe('INVALID_GAME_ID');
    });
  });

  describe('Business Logic Validation Errors', () => {
    it('should throw error when starting game without current game', async () => {
      try {
        await useLobbyStore.getState().startGame('game-123');
        fail('Expected function to throw');
      } catch (error) {
        expect(error).toEqual({
          code: 'NO_CURRENT_GAME',
          message: 'No game selected',
        });
      }
      
      const state = useLobbyStore.getState();
      expect(state.error?.code).toBe('NO_CURRENT_GAME');
    });

    it('should throw error when starting already started game', async () => {
      // Set up a current game that's already active
      useLobbyStore.setState({
        currentGame: {
          id: 'game-123',
          joinCode: 'ABC123',
          createdBy: 'user-1',
          status: 'ACTIVE',
          maxPlayers: 4,
          isPublic: true,
          createdAt: new Date('2023-01-01T00:00:00Z'),
        },
      });

      try {
        await useLobbyStore.getState().startGame('game-123');
        fail('Expected function to throw');
      } catch (error) {
        expect(error).toEqual({
          code: 'GAME_ALREADY_STARTED',
          message: 'Game has already started',
        });
      }
      
      const state = useLobbyStore.getState();
      expect(state.error?.code).toBe('GAME_ALREADY_STARTED');
    });
  });

  describe('API Error Handling', () => {
    it('should handle API errors and set error state', async () => {
      const apiError: ApiError = {
        code: 'GAME_NOT_FOUND',
        message: 'Game not found',
      };
      
      mockApi.createGame.mockRejectedValueOnce(apiError);
      
      try {
        await useLobbyStore.getState().createGame();
        fail('Expected function to throw');
      } catch (error) {
        // Expected to throw
      }
      
      const state = useLobbyStore.getState();
      expect(state.error?.code).toBe('GAME_NOT_FOUND');
      expect(state.isLoading).toBe(false);
    });

    it('should track retry count for retryable errors', async () => {
      const retryableError: ApiError = {
        code: 'HTTP_500',
        message: 'Internal server error',
      };
      
      mockApi.createGame.mockRejectedValueOnce(retryableError);
      
      try {
        await useLobbyStore.getState().createGame();
        fail('Expected function to throw');
      } catch (error) {
        // Expected to throw
      }
      
      const state = useLobbyStore.getState();
      expect(state.retryCount).toBe(1);
      expect(state.error?.message).toBe('Internal server error');
    });

    it('should not retry non-retryable errors', async () => {
      const nonRetryableError: ApiError = {
        code: 'GAME_NOT_FOUND',
        message: 'Game not found',
      };
      
      mockApi.createGame.mockRejectedValueOnce(nonRetryableError);
      
      try {
        await useLobbyStore.getState().createGame();
        fail('Expected function to throw');
      } catch (error) {
        // Expected to throw
      }
      
      const state = useLobbyStore.getState();
      expect(state.retryCount).toBe(0);
      expect(state.error?.message).not.toContain('(Retry');
    });
  });

  describe('Error State Management', () => {
    it('should clear error on successful operation', async () => {
      // First, set an error
      useLobbyStore.setState({
        error: {
          code: 'TEST_ERROR',
          message: 'Test error',
        },
        retryCount: 1,
      });

      // Then succeed
      mockApi.createGame.mockResolvedValueOnce({
        game: {
          id: 'game-123',
          joinCode: 'ABC123',
          createdBy: 'user-1',
          status: 'IN_SETUP' as const,
          maxPlayers: 4,
          isPublic: true,
          createdAt: new Date('2023-01-01T00:00:00Z'),
        },
      });
      mockApi.getGamePlayers.mockResolvedValueOnce({ players: [] });
      
      await useLobbyStore.getState().createGame();
      
      const state = useLobbyStore.getState();
      expect(state.error).toBeNull();
      expect(state.retryCount).toBe(0);
    });

    it('should clear error and retry count on leaveGame', () => {
      useLobbyStore.setState({
        error: {
          code: 'TEST_ERROR',
          message: 'Test error',
        },
        retryCount: 2,
      });

      useLobbyStore.getState().leaveGame();
      
      const state = useLobbyStore.getState();
      expect(state.error).toBeNull();
      expect(state.retryCount).toBe(0);
    });

    it('should clear error and retry count on clearError', () => {
      useLobbyStore.setState({
        error: {
          code: 'TEST_ERROR',
          message: 'Test error',
        },
        retryCount: 2,
      });

      useLobbyStore.getState().clearError();
      
      const state = useLobbyStore.getState();
      expect(state.error).toBeNull();
      expect(state.retryCount).toBe(0);
    });
  });

  describe('Graceful Degradation', () => {
    it('should handle player loading failure without failing main operation', async () => {
      const game = {
        id: 'game-123',
        joinCode: 'ABC123',
        createdBy: 'user-1',
        status: 'IN_SETUP' as const,
        maxPlayers: 4,
        isPublic: true,
        createdAt: new Date('2023-01-01T00:00:00Z'),
      };
      
      mockApi.createGame.mockResolvedValueOnce({ game });
      mockApi.getGamePlayers.mockRejectedValueOnce(new Error('Player loading failed'));
      
      // Should not throw even if player loading fails
      const result = await useLobbyStore.getState().createGame();
      
      expect(result).toEqual(game);
      expect(useLobbyStore.getState().currentGame).toEqual(game);
      // Player loading failure should be logged but not set as main error
      expect(useLobbyStore.getState().error).toBeNull();
    });
  });

  describe('Error Normalization', () => {
    it('should handle different error types safely', async () => {
      // Test with Error object
      mockApi.createGame.mockRejectedValueOnce(new Error('Network error'));
      
      try {
        await useLobbyStore.getState().createGame();
        fail('Expected function to throw');
      } catch (error) {
        // Expected to throw
      }
      
      let state = useLobbyStore.getState();
      expect(state.error?.code).toBe('UNKNOWN_ERROR');
      expect(state.error?.message).toBe('Network error');
      
      // Reset state
      useLobbyStore.setState({ error: null, retryCount: 0 });
      
      // Test with string error
      mockApi.createGame.mockRejectedValueOnce('String error message');
      
      try {
        await useLobbyStore.getState().createGame();
        fail('Expected function to throw');
      } catch (error) {
        // Expected to throw
      }
      
      state = useLobbyStore.getState();
      expect(state.error?.code).toBe('UNKNOWN_ERROR');
      expect(state.error?.message).toBe('String error message');
      
      // Reset state
      useLobbyStore.setState({ error: null, retryCount: 0 });
      
      // Test with undefined error
      mockApi.createGame.mockRejectedValueOnce(undefined);
      
      try {
        await useLobbyStore.getState().createGame();
        fail('Expected function to throw');
      } catch (error) {
        // Expected to throw
      }
      
      state = useLobbyStore.getState();
      expect(state.error?.code).toBe('UNKNOWN_ERROR');
      expect(state.error?.message).toBe('undefined');
    });
  });

  describe('Loading States', () => {
    it('should set loading to true at start and false on completion for createGame', async () => {
      const game = {
        id: 'game-123',
        joinCode: 'ABC123',
        createdBy: 'user-1',
        status: 'IN_SETUP' as const,
        maxPlayers: 4,
        isPublic: true,
        createdAt: new Date('2023-01-01T00:00:00Z'),
      };
      
      mockApi.createGame.mockResolvedValueOnce({ game });
      mockApi.getGamePlayers.mockResolvedValueOnce({ players: [] });
      
      // Initially not loading
      expect(useLobbyStore.getState().isLoading).toBe(false);
      
      const createPromise = useLobbyStore.getState().createGame();
      
      // Should be loading immediately after call
      expect(useLobbyStore.getState().isLoading).toBe(true);
      
      await createPromise;
      
      // Should not be loading after completion
      expect(useLobbyStore.getState().isLoading).toBe(false);
    });

    it('should set loading to true at start and false on error for createGame', async () => {
      mockApi.createGame.mockRejectedValueOnce(new Error('API Error'));
      
      // Initially not loading
      expect(useLobbyStore.getState().isLoading).toBe(false);
      
      try {
        await useLobbyStore.getState().createGame();
        fail('Expected function to throw');
      } catch (error) {
        // Expected to throw
      }
      
      // Should not be loading after error
      expect(useLobbyStore.getState().isLoading).toBe(false);
    });

    it('should set loading to true at start and false on completion for loadGamePlayers', async () => {
      const players = [
        {
          id: 'player-1',
          userId: 'user-1',
          name: 'Player 1',
          color: '#FF0000',
          money: 50,
          trainType: 'Freight' as const,
          turnNumber: 1,
          isOnline: true,
          createdAt: new Date().toISOString(),
        },
      ];
      
      mockApi.getGamePlayers.mockResolvedValueOnce({ players });
      
      // Initially not loading
      expect(useLobbyStore.getState().isLoading).toBe(false);
      
      const loadPromise = useLobbyStore.getState().loadGamePlayers('game-123');
      
      // Should be loading immediately after call
      expect(useLobbyStore.getState().isLoading).toBe(true);
      
      await loadPromise;
      
      // Should not be loading after completion
      expect(useLobbyStore.getState().isLoading).toBe(false);
    });

    it('should set loading to true at start and false on error for loadGamePlayers', async () => {
      mockApi.getGamePlayers.mockRejectedValueOnce(new Error('API Error'));
      
      // Initially not loading
      expect(useLobbyStore.getState().isLoading).toBe(false);
      
      try {
        await useLobbyStore.getState().loadGamePlayers('game-123');
        fail('Expected function to throw');
      } catch (error) {
        // Expected to throw
      }
      
      // Should not be loading after error
      expect(useLobbyStore.getState().isLoading).toBe(false);
    });
  });
});
