// store/lobby.store.ts
import { create } from 'zustand';
import type { Game, Player, ApiError, CreateGameForm, JoinGameForm, ID } from '../shared/types';
import { api } from '../shared/api';

// Mock data for development
const MOCK_GAMES: Game[] = [
  {
    id: 'game-1',
    joinCode: 'ABC123',
    createdBy: 'dev-user',
    status: 'IN_SETUP',
    maxPlayers: 4,
  },
  {
    id: 'game-2',
    joinCode: 'DEF456',
    createdBy: 'other-user',
    status: 'IN_SETUP',
    maxPlayers: 3,
  },
  {
    id: 'game-3',
    joinCode: 'GHI789',
    createdBy: 'dev-user',
    status: 'ACTIVE',
    maxPlayers: 4,
  },
];

const MOCK_PLAYERS: Record<ID, Player[]> = {
  'game-1': [
    { id: 'player-1', userId: 'dev-user', name: 'dev-user', color: '#ff0000', isOnline: true },
    { id: 'player-2', userId: 'user-2', name: 'Alice', color: '#00ff00', isOnline: true },
  ],
  'game-2': [
    { id: 'player-3', userId: 'other-user', name: 'Bob', color: '#0000ff', isOnline: true },
    { id: 'player-4', userId: 'user-4', name: 'Charlie', color: '#ffff00', isOnline: false },
  ],
  'game-3': [
    { id: 'player-5', userId: 'dev-user', name: 'dev-user', color: '#ff0000', isOnline: true },
    { id: 'player-6', userId: 'user-6', name: 'David', color: '#00ffff', isOnline: true },
    { id: 'player-7', userId: 'user-7', name: 'Eve', color: '#ff00ff', isOnline: true },
  ],
};

interface LobbyState {
  currentGame: Game | null;
  players: Player[];
  isLoading: boolean;
  error: ApiError | null;
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
}

type LobbyStore = LobbyState & LobbyActions;

const isDevelopment = process.env.NODE_ENV === 'development';

export const useLobbyStore = create<LobbyStore>((set, get) => ({
  // Initial state
  currentGame: null,
  players: [],
  isLoading: false,
  error: null,

  // Actions
  createGame: async (gameData: CreateGameForm = {}) => {
    set({ isLoading: true, error: null });
    
    if (isDevelopment) {
      // Simulate API delay
      await new Promise(resolve => setTimeout(resolve, 500));
      
      // Generate a new mock game
      const newGame: Game = {
        id: `game-${Date.now()}`,
        joinCode: Math.random().toString(36).substring(2, 10).toUpperCase(),
        createdBy: 'dev-user',
        status: 'IN_SETUP',
        maxPlayers: 4,
      };
      
      // Add to mock games
      MOCK_GAMES.push(newGame);
      MOCK_PLAYERS[newGame.id] = [
        { id: 'player-new', userId: 'dev-user', name: 'dev-user', color: '#ff0000', isOnline: true },
      ];
      
      set({
        currentGame: newGame,
        players: MOCK_PLAYERS[newGame.id],
        isLoading: false,
      });
      
      return newGame;
    }
    
    try {
      const result = await api.createGame(gameData);
      
      set({
        currentGame: result.game,
        players: [], // Will be loaded separately
        isLoading: false,
      });

      // Load initial players
      await get().loadGamePlayers(result.game.id);
      
      return result.game;
    } catch (error) {
      set({
        isLoading: false,
        error: error as ApiError,
      });
      throw error;
    }
  },

  joinGame: async (joinData: JoinGameForm) => {
    set({ isLoading: true, error: null });
    
    if (isDevelopment) {
      // Simulate API delay
      await new Promise(resolve => setTimeout(resolve, 500));
      
      // Find game by join code
      const game = MOCK_GAMES.find(g => g.joinCode === joinData.joinCode);
      
      if (!game) {
        const error: ApiError = {
          code: 'GAME_NOT_FOUND',
          message: 'Game not found with that join code',
        };
        set({
          isLoading: false,
          error,
        });
        throw error;
      }
      
      if (game.status !== 'IN_SETUP') {
        const error: ApiError = {
          code: 'GAME_ALREADY_STARTED',
          message: 'Game has already started',
        };
        set({
          isLoading: false,
          error,
        });
        throw error;
      }
      
      // Add current user to the game
      const currentPlayers = MOCK_PLAYERS[game.id] || [];
      const playerExists = currentPlayers.some(p => p.userId === 'dev-user');
      
      if (!playerExists) {
        MOCK_PLAYERS[game.id] = [
          ...currentPlayers,
          { id: `player-${Date.now()}`, userId: 'dev-user', name: 'dev-user', color: '#ff0000', isOnline: true },
        ];
      }
      
      set({
        currentGame: game,
        players: MOCK_PLAYERS[game.id],
        isLoading: false,
      });
      
      return game;
    }
    
    try {
      const result = await api.joinGame(joinData);
      
      set({
        currentGame: result.game,
        players: [], // Will be loaded separately
        isLoading: false,
      });

      // Load current players
      await get().loadGamePlayers(result.game.id);
      
      return result.game;
    } catch (error) {
      set({
        isLoading: false,
        error: error as ApiError,
      });
      throw error;
    }
  },

  loadCurrentGame: async (gameId: ID) => {
    set({ isLoading: true, error: null });
    
    if (isDevelopment) {
      const game = MOCK_GAMES.find(g => g.id === gameId);
      if (game) {
        set({
          currentGame: game,
          players: MOCK_PLAYERS[game.id] || [],
          isLoading: false,
        });
      } else {
        set({
          isLoading: false,
          error: { code: 'GAME_NOT_FOUND', message: 'Game not found' },
        });
      }
      return;
    }
    
    try {
      const result = await api.getGame(gameId);
      
      set({
        currentGame: result.game,
        isLoading: false,
      });
    } catch (error) {
      set({
        isLoading: false,
        error: error as ApiError,
      });
      throw error;
    }
  },

  loadGamePlayers: async (gameId: ID) => {
    if (isDevelopment) {
      const players = MOCK_PLAYERS[gameId] || [];
      set({ players });
      return;
    }
    
    try {
      const result = await api.getGamePlayers(gameId);
      
      set({
        players: result.players,
      });
    } catch (error) {
      set({
        error: error as ApiError,
      });
    }
  },

  startGame: async (gameId: ID) => {
    set({ isLoading: true, error: null });
    
    if (isDevelopment) {
      // Simulate API delay
      await new Promise(resolve => setTimeout(resolve, 1000));
      
      // Update game status locally
      const currentGame = get().currentGame;
      if (currentGame && currentGame.id === gameId) {
        const updatedGame = { ...currentGame, status: 'ACTIVE' as const };
        
        // Update in mock data
        const gameIndex = MOCK_GAMES.findIndex(g => g.id === gameId);
        if (gameIndex !== -1) {
          MOCK_GAMES[gameIndex] = updatedGame;
        }
        
        set({
          currentGame: updatedGame,
          isLoading: false,
        });
      }
      return;
    }
    
    try {
      await api.startGame(gameId);
      
      // Update game status locally (optimistic update)
      const currentGame = get().currentGame;
      if (currentGame && currentGame.id === gameId) {
        set({
          currentGame: {
            ...currentGame,
            status: 'ACTIVE',
          },
          isLoading: false,
        });
      }
    } catch (error) {
      set({
        isLoading: false,
        error: error as ApiError,
      });
      throw error;
    }
  },

  leaveGame: () => {
    set({
      currentGame: null,
      players: [],
      error: null,
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
    set({ error: null });
  },
}));