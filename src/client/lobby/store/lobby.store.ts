// store/lobby.store.ts
import { create } from 'zustand';
import type { Game, Player, ApiError, CreateGameForm, JoinGameForm, ID } from '../shared/types';
import { api, getErrorMessage } from '../shared/api';
import { socketService } from '../shared/socket';

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
  leaveGame: () => Promise<void>;
  updatePlayerPresence: (userId: ID, isOnline: boolean) => Promise<void>;
  clearError: () => void;
  // New methods for state recovery
  loadGameFromUrl: (gameId: ID) => Promise<void>;
  restoreGameState: () => Promise<boolean>;
  saveGameState: () => void;
  clearGameState: () => void;
  refreshGameState: () => Promise<void>;
  // Socket methods
  connectToLobbySocket: (gameId: ID, token: string) => void;
  disconnectFromLobbySocket: (gameId: ID) => void;
  onGameStarted: (callback: (gameId: ID) => void) => void;
}

type LobbyStore = LobbyState & LobbyActions;

// Helper function to determine if an error is retryable
const isRetryableError = (error: ApiError): boolean => {
  const retryableCodes = ['HTTP_500', 'HTTP_502', 'HTTP_503', 'HTTP_504', 'NETWORK_ERROR'];
  return retryableCodes.includes(error.error) || error.error.startsWith('HTTP_5');
};

// Helper function to create user-friendly error messages
const createUserFriendlyError = (error: ApiError): ApiError => {
  return {
    ...error,
    message: error.message || getErrorMessage(error),
  };
};

// Helper function to safely convert unknown error to ApiError
const normalizeError = (error: unknown): ApiError => {
  // If it's already an ApiError-like object, validate and return it
  if (typeof error === 'object' && error !== null && 'error' in error) {
    const errorObj = error as Record<string, unknown>;
    return {
      error: String(errorObj.error),
      message: errorObj.message ? String(errorObj.message) : 'Unknown error',
    };
  }
  
  // If it's an Error object, convert to ApiError
  if (error instanceof Error) {
    return {
      error: 'UNKNOWN_ERROR',
      message: error.message,
    };
  }
  
  // If it's a string, convert to ApiError
  if (typeof error === 'string') {
    return {
      error: 'UNKNOWN_ERROR',
      message: error,
    };
  }
  
  // For any other type, convert to string and create ApiError
  return {
    error: 'UNKNOWN_ERROR',
    message: String(error),
  };
};

// Helper function to handle errors with retry logic
const handleError = (error: unknown, retryCount: number, maxRetries: number = 3): ApiError => {
  const apiError = normalizeError(error);
  const friendlyError = createUserFriendlyError(apiError);
  
  if (isRetryableError(apiError) && retryCount < maxRetries) {
    return friendlyError;
  }
  
  return friendlyError;
};

// localStorage helper functions for state persistence
const STORAGE_KEYS = {
  CURRENT_GAME: 'eurorails.currentGame',
  CURRENT_PLAYERS: 'eurorails.currentPlayers',
  GAME_TIMESTAMP: 'eurorails.gameTimestamp',
};

const saveToStorage = (game: Game | null, players: Player[]) => {
  if (game) {
    localStorage.setItem(STORAGE_KEYS.CURRENT_GAME, JSON.stringify(game));
    localStorage.setItem(STORAGE_KEYS.CURRENT_PLAYERS, JSON.stringify(players));
    localStorage.setItem(STORAGE_KEYS.GAME_TIMESTAMP, Date.now().toString());
  }
};

const loadFromStorage = (): { game: Game | null; players: Player[] } | null => {
  try {
    const gameStr = localStorage.getItem(STORAGE_KEYS.CURRENT_GAME);
    const playersStr = localStorage.getItem(STORAGE_KEYS.CURRENT_PLAYERS);
    const timestampStr = localStorage.getItem(STORAGE_KEYS.GAME_TIMESTAMP);
    
    if (!gameStr || !playersStr || !timestampStr) {
      return null;
    }
    
    // Check if data is not too old (e.g., 5 minutes for real-time game state)
    const timestamp = parseInt(timestampStr);
    const maxAge = 5 * 60 * 1000; // 5 minutes
    
    if (Date.now() - timestamp > maxAge) {
      clearStorage();
      return null;
    }
    
    return {
      game: JSON.parse(gameStr),
      players: JSON.parse(playersStr),
    };
  } catch (error) {
    console.warn('Failed to load game state from localStorage:', error);
    clearStorage();
    return null;
  }
};

const clearStorage = () => {
  Object.values(STORAGE_KEYS).forEach(key => {
    localStorage.removeItem(key);
  });
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
        const playerResult = await api.getGamePlayers(result.game.id);
        set({ players: playerResult.players });
      } catch (playerError) {
        // If loading players fails, log but don't fail the entire operation
        console.warn('Failed to load initial players:', playerError);
      }
      
      // Save to localStorage
      get().saveGameState();
      
      return result.game;
    } catch (error) {
      const handledError = handleError(error, get().retryCount);
      
      set({
        isLoading: false,
        error: handledError,
        retryCount: isRetryableError(handledError) ? get().retryCount + 1 : 0,
      });
      throw handledError;
    }
  },

  joinGame: async (joinData: JoinGameForm) => {
    // Validate join code format
    if (!joinData.joinCode || joinData.joinCode.trim().length === 0) {
      const error: ApiError = {
        error: 'INVALID_JOIN_CODE',
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
      
      // Save to localStorage
      get().saveGameState();
      
      return result.game;
    } catch (error) {
      const handledError = handleError(error, get().retryCount);
      
      set({
        isLoading: false,
        error: handledError,
        retryCount: isRetryableError(handledError) ? get().retryCount + 1 : 0,
      });
      throw handledError;
    }
  },

  loadCurrentGame: async (gameId: ID) => {
    // Validate game ID
    if (!gameId || gameId.trim().length === 0) {
      const error: ApiError = {
        error: 'INVALID_GAME_ID',
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
      const handledError = handleError(error, get().retryCount);
      
      set({
        isLoading: false,
        error: handledError,
        retryCount: isRetryableError(handledError) ? get().retryCount + 1 : 0,
      });
      throw handledError;
    }
  },

  loadGamePlayers: async (gameId: ID) => {
    // Validate game ID
    if (!gameId || gameId.trim().length === 0) {
      const error: ApiError = {
        error: 'INVALID_GAME_ID',
        message: 'Game ID is required',
      };
      set({ error: createUserFriendlyError(error) });
      throw error;
    }

    set({ isLoading: true, error: null });

    try {
      const result = await api.getGamePlayers(gameId);
      
      set({
        players: result.players,
        error: null, // Clear any previous errors on success
        isLoading: false,
      });
    } catch (error) {
      const handledError = handleError(error, 0); // Don't retry for player loading
      
      set({
        error: handledError,
        isLoading: false,
      });
    }
  },

  startGame: async (gameId: ID) => {
    // Validate game ID
    if (!gameId || gameId.trim().length === 0) {
      const error: ApiError = {
        error: 'INVALID_GAME_ID',
        message: 'Game ID is required',
      };
      set({ error: createUserFriendlyError(error) });
      throw error;
    }

    // Check if we have a current game
    const currentGame = get().currentGame;
    if (!currentGame) {
      const error: ApiError = {
        error: 'NO_CURRENT_GAME',
        message: 'No game selected',
      };
      set({ error: createUserFriendlyError(error) });
      throw error;
    }

    // Check if game is already started
    if (currentGame.status === 'ACTIVE') {
      const error: ApiError = {
        error: 'GAME_ALREADY_STARTED',
        message: 'Game has already started',
      };
      set({ error: createUserFriendlyError(error) });
      throw error;
    }

    const state = get();
    set({ isLoading: true, error: null, retryCount: 0 });
    
    try {
      // Lobby startGame does nothing - just sets loading to false
      // The actual game start happens in SetupScene
      set({
        isLoading: false,
        retryCount: 0,
      });
      
    } catch (error) {
      const handledError = handleError(error, get().retryCount);
      
      set({
        isLoading: false,
        error: handledError,
        retryCount: isRetryableError(handledError) ? get().retryCount + 1 : 0,
      });
      throw handledError;
    }
  },

  leaveGame: async () => {
    const currentGame = get().currentGame;
    if (currentGame) {
      try {
        await api.leaveGame(currentGame.id);
      } catch (error) {
        // Log error but don't fail the operation
        console.warn('Failed to leave game on server:', error);
      }
    }
    
    // Clear localStorage and state
    get().clearGameState();
  },

  updatePlayerPresence: async (userId: ID, isOnline: boolean) => {
    try {
      await api.updatePlayerPresence(userId, isOnline);
    } catch (error) {
      // Log error but don't fail the operation
      console.warn('Failed to update player presence on server:', error);
    }
    
    // Update local state regardless of server success
    const currentPlayers = get().players;
    const updatedPlayers = currentPlayers.map(player =>
      player.userId === userId
        ? { ...player, isOnline }
        : player
    );
    
    set({ players: updatedPlayers });
  },

  // New state recovery methods
  loadGameFromUrl: async (gameId: ID) => {
    set({ isLoading: true, error: null });
    
    try {
      // Validate game ID format
      if (!gameId || typeof gameId !== 'string' || gameId.trim().length === 0) {
        throw new Error('Invalid game ID');
      }
      
      // Load game details
      const gameResult = await api.getGame(gameId);
      const playersResult = await api.getGamePlayers(gameId);
      
      // Validate game exists and is accessible
      if (!gameResult.game) {
        throw new Error('Game not found');
      }
      
      set({
        currentGame: gameResult.game,
        players: playersResult.players,
        isLoading: false,
      });
      
      // Save to localStorage for quick recovery
      get().saveGameState();
    } catch (error) {
      const handledError = handleError(error, get().retryCount);
      set({
        isLoading: false,
        error: {
          ...handledError,
          message: 'Failed to load game. Redirecting to lobby...'
        },
        retryCount: isRetryableError(handledError) ? get().retryCount + 1 : 0,
      });
      
      // Clear invalid state
      get().clearGameState();
      throw handledError;
    }
  },

  restoreGameState: async () => {
    const stored = loadFromStorage();
    if (stored) {
      // Validate stored game data
      if (!stored.game) {
        console.warn('No stored game data, clearing storage');
        clearStorage();
        return false;
      }
      
      // Always fetch fresh data from server, but handle different error types appropriately
      try {
        // Try to get fresh data from server
        const gameResult = await api.getGame(stored.game.id);
        const playersResult = await api.getGamePlayers(stored.game.id);
        
        set({
          currentGame: gameResult.game,
          players: playersResult.players,
        });
        
        // Update localStorage with fresh data
        get().saveGameState();
        return true;
      } catch (error) {
        const apiError = normalizeError(error);
        
        // If game not found (404), clear stale state and return false
        if (apiError.error === 'HTTP_404' || apiError.message.includes('not found')) {
          console.warn('Game not found, clearing stale state:', stored.game.id);
          get().clearGameState();
          return false;
        }
        
        // If auth failed, we can't proceed - auth should be handled at a higher level
        // Don't use stale localStorage data when authentication has failed
        if (apiError.error === 'HTTP_401' || apiError.error === 'HTTP_403' || apiError.error === 'UNAUTHORIZED') {
          console.warn('Authentication failed, clearing game state');
          get().clearGameState();
          return false;
        }
        
        // For other errors (network issues, etc.), use localStorage data as fallback
        console.warn('Failed to fetch fresh game state from server, using localStorage:', error);
        const validPlayers = Array.isArray(stored.players) ? stored.players : [];
        set({
          currentGame: stored.game,
          players: validPlayers,
        });
        return true;
      }
    }
    return false;
  },

  saveGameState: () => {
    const { currentGame, players } = get();
    saveToStorage(currentGame, players);
  },

  clearGameState: () => {
    clearStorage();
    set({
      currentGame: null,
      players: [],
      error: null,
      retryCount: 0,
    });
  },

  refreshGameState: async () => {
    const { currentGame } = get();
    if (!currentGame) {
      throw new Error('No current game to refresh');
    }
    
    try {
      const gameResult = await api.getGame(currentGame.id);
      const playersResult = await api.getGamePlayers(currentGame.id);
      
      set({
        currentGame: gameResult.game,
        players: playersResult.players,
      });
      
      // Update localStorage with fresh data
      get().saveGameState();
    } catch (error) {
      const handledError = handleError(error, 0);
      set({ error: handledError });
      throw handledError;
    }
  },

  clearError: () => {
    set({ error: null, retryCount: 0 });
  },

  // Socket methods
  connectToLobbySocket: async (gameId: ID, token: string) => {
    try {
      // Connect to socket if not already connected
      if (!socketService.isConnected()) {
        socketService.connect(token);
      }
      
      // Join the lobby room
      socketService.joinLobby(gameId);
      
      // Only refresh player list if we don't have players yet
      const currentPlayers = get().players;
      console.log('Connecting to lobby socket - current players:', currentPlayers?.length || 0);
      if (!currentPlayers || currentPlayers.length === 0) {
        try {
          console.log('Loading players for game:', gameId);
          await get().loadGamePlayers(gameId);
          const afterLoad = get().players;
          console.log('Players loaded, count:', afterLoad?.length || 0);
        } catch (error) {
          console.warn('Failed to load initial players on socket connect:', error);
        }
      }
      
      // Listen for lobby updates
      socketService.onLobbyUpdate((data) => {
        if (data.gameId === gameId) {
          console.log('Lobby updated event received:', {
            action: data.action,
            playerCount: data.players?.length || 0,
            players: data.players,
          });
          // Update player list
          set({ players: data.players });
        }
      });
    } catch (error) {
      console.error('Failed to connect to lobby socket:', error);
    }
  },

  disconnectFromLobbySocket: (gameId: ID) => {
    try {
      socketService.leaveLobby(gameId);
    } catch (error) {
      console.error('Failed to disconnect from lobby socket:', error);
    }
  },

  onGameStarted: (callback: (gameId: ID) => void) => {
    socketService.onGameStarted((data) => {
      console.log('Game started event received:', data.gameId);
      callback(data.gameId);
    });
  },

}));