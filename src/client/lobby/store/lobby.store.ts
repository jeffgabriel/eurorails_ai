// store/lobby.store.ts
import { create } from 'zustand';
import type { Game, Player, ApiError, CreateGameForm, JoinGameForm, ID } from '../shared/types';
import { api, getErrorMessage } from '../shared/api';

interface LobbyState {
  currentGame: Game | null;
  players: Player[];
  isLoading: boolean;
  error: ApiError | null;
  retryCount: number;
}

interface LobbyActions {
  createGame: (gameData?: CreateGameForm) => Promise<Game>;
  joinGame: (joinData: JoinGameForm) => Promise<Game>;
  loadCurrentGame: (gameId: ID) => Promise<void>;
  loadGamePlayers: (gameId: ID) => Promise<void>;
  startGame: (gameId: ID) => Promise<void>;
  leaveGame: () => void;
  updatePlayerPresence: (userId: ID, isOnline: boolean) => void;
  clearError: () => void;
  retryLastAction: () => Promise<void>;
}

type LobbyStore = LobbyState & LobbyActions;

// Helper function to determine if an error is retryable
const isRetryableError = (error: ApiError): boolean => {
  const retryableCodes = ['HTTP_500', 'HTTP_502', 'HTTP_503', 'HTTP_504', 'NETWORK_ERROR'];
  return retryableCodes.includes(error.code) || error.code.startsWith('HTTP_5');
};

// Helper function to create user-friendly error messages
const createUserFriendlyError = (error: ApiError): ApiError => {
  return {
    ...error,
    message: getErrorMessage(error),
  };
};

// Helper function to handle errors with retry logic
const handleError = (error: unknown, retryCount: number, maxRetries: number = 3): ApiError => {
  const apiError = error as ApiError;
  const friendlyError = createUserFriendlyError(apiError);
  
  if (isRetryableError(apiError) && retryCount < maxRetries) {
    return {
      ...friendlyError,
      message: `${friendlyError.message} (Retry ${retryCount + 1}/${maxRetries})`,
    };
  }
  
  return friendlyError;
};

export const useLobbyStore = create<LobbyStore>((set, get) => ({
  // Initial state
  currentGame: null,
  players: [],
  isLoading: false,
  error: null,
  retryCount: 0,

  // Actions
  createGame: async (gameData: CreateGameForm = {}) => {
    const state = get();
    set({ isLoading: true, error: null, retryCount: 0 });
    
    try {
      const result = await api.createGame(gameData);
      
      set({
        currentGame: result.game,
        players: [], // Will be loaded separately
        isLoading: false,
        retryCount: 0,
      });

      // Load initial players
      try {
        await get().loadGamePlayers(result.game.id);
      } catch (playerError) {
        // If loading players fails, log but don't fail the entire operation
        console.warn('Failed to load initial players:', playerError);
      }
      
      return result.game;
    } catch (error) {
      const handledError = handleError(error, state.retryCount);
      
      set({
        isLoading: false,
        error: handledError,
        retryCount: state.retryCount + 1,
      });
      throw handledError;
    }
  },

  joinGame: async (joinData: JoinGameForm) => {
    // Validate join code format
    if (!joinData.joinCode || joinData.joinCode.trim().length === 0) {
      const error: ApiError = {
        code: 'INVALID_JOIN_CODE',
        message: 'Join code is required',
      };
      set({ error: createUserFriendlyError(error) });
      throw error;
    }

    const state = get();
    set({ isLoading: true, error: null, retryCount: 0 });
    
    try {
      const result = await api.joinGame(joinData);
      
      set({
        currentGame: result.game,
        players: [], // Will be loaded separately
        isLoading: false,
        retryCount: 0,
      });

      // Load current players
      try {
        await get().loadGamePlayers(result.game.id);
      } catch (playerError) {
        // If loading players fails, log but don't fail the entire operation
        console.warn('Failed to load game players:', playerError);
      }
      
      return result.game;
    } catch (error) {
      const handledError = handleError(error, state.retryCount);
      
      set({
        isLoading: false,
        error: handledError,
        retryCount: state.retryCount + 1,
      });
      throw handledError;
    }
  },

  loadCurrentGame: async (gameId: ID) => {
    // Validate game ID
    if (!gameId || gameId.trim().length === 0) {
      const error: ApiError = {
        code: 'INVALID_GAME_ID',
        message: 'Game ID is required',
      };
      set({ error: createUserFriendlyError(error) });
      throw error;
    }

    const state = get();
    set({ isLoading: true, error: null, retryCount: 0 });
    
    try {
      const result = await api.getGame(gameId);
      
      set({
        currentGame: result.game,
        isLoading: false,
        retryCount: 0,
      });
    } catch (error) {
      const handledError = handleError(error, state.retryCount);
      
      set({
        isLoading: false,
        error: handledError,
        retryCount: state.retryCount + 1,
      });
      throw handledError;
    }
  },

  loadGamePlayers: async (gameId: ID) => {
    // Validate game ID
    if (!gameId || gameId.trim().length === 0) {
      const error: ApiError = {
        code: 'INVALID_GAME_ID',
        message: 'Game ID is required',
      };
      set({ error: createUserFriendlyError(error) });
      throw error;
    }

    try {
      const result = await api.getGamePlayers(gameId);
      
      set({
        players: result.players,
        error: null, // Clear any previous errors on success
      });
    } catch (error) {
      const handledError = handleError(error, 0); // Don't retry for player loading
      
      set({
        error: handledError,
      });
    }
  },

  startGame: async (gameId: ID) => {
    // Validate game ID
    if (!gameId || gameId.trim().length === 0) {
      const error: ApiError = {
        code: 'INVALID_GAME_ID',
        message: 'Game ID is required',
      };
      set({ error: createUserFriendlyError(error) });
      throw error;
    }

    // Check if we have a current game
    const currentGame = get().currentGame;
    if (!currentGame) {
      const error: ApiError = {
        code: 'NO_CURRENT_GAME',
        message: 'No game selected',
      };
      set({ error: createUserFriendlyError(error) });
      throw error;
    }

    // Check if game is already started
    if (currentGame.status === 'ACTIVE') {
      const error: ApiError = {
        code: 'GAME_ALREADY_STARTED',
        message: 'Game has already started',
      };
      set({ error: createUserFriendlyError(error) });
      throw error;
    }

    const state = get();
    set({ isLoading: true, error: null, retryCount: 0 });
    
    try {
      await api.startGame(gameId);
      
      // Update game status locally (optimistic update)
      set({
        currentGame: {
          ...currentGame,
          status: 'ACTIVE',
        },
        isLoading: false,
        retryCount: 0,
      });
    } catch (error) {
      const handledError = handleError(error, state.retryCount);
      
      set({
        isLoading: false,
        error: handledError,
        retryCount: state.retryCount + 1,
      });
      throw handledError;
    }
  },

  leaveGame: () => {
    set({
      currentGame: null,
      players: [],
      error: null,
      retryCount: 0,
    });
  },

  updatePlayerPresence: (userId: ID, isOnline: boolean) => {
    const currentPlayers = get().players;
    const updatedPlayers = currentPlayers.map(player =>
      player.userId === userId
        ? { ...player, isOnline }
        : player
    );
    
    set({ players: updatedPlayers });
  },

  clearError: () => {
    set({ error: null, retryCount: 0 });
  },

  retryLastAction: async () => {
    const state = get();
    
    if (!state.error || state.retryCount >= 3) {
      return;
    }

    // Clear error and retry the last action
    set({ error: null, retryCount: state.retryCount + 1 });
    
    // Note: In a real implementation, you might want to store the last action
    // and its parameters to retry it. For now, we'll just clear the error
    // and let the user retry manually.
    console.log('Retry functionality available - user can retry the last action');
  },
}));