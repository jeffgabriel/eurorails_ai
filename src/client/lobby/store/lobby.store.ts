// store/lobby.store.ts
import { create } from 'zustand';
import type { Game, Player, ApiError, CreateGameForm, JoinGameForm, ID } from '../shared/types';
import { api } from '../shared/api';

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

export const useLobbyStore = create<LobbyStore>((set, get) => ({
  // Initial state
  currentGame: null,
  players: [],
  isLoading: false,
  error: null,

  // Actions
  createGame: async (gameData: CreateGameForm = {}) => {
    set({ isLoading: true, error: null });
    
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