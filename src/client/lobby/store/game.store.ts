// store/game.store.ts
import { create } from 'zustand';
import type { GameState, ID, ApiError } from '../shared/types';
import { socketService } from '../shared/socket';
import { debug } from '../shared/config';

interface GameStoreState {
  gameState: GameState | null;
  isConnected: boolean;
  isLoading: boolean;
  error: ApiError | null;
  clientSeq: number;
  connectionStatus: 'disconnected' | 'connecting' | 'connected' | 'reconnecting';
}

interface GameStoreActions {
  connect: (gameId: ID, token: string) => void;
  disconnect: () => void;
  sendAction: (type: string, payload: unknown) => void;
  applyStateInit: (gameState: GameState, serverSeq: number) => void;
  applyStatePatch: (patch: Partial<GameState>, serverSeq: number) => void;
  applyTurnChange: (currentTurnUserId: ID, serverSeq: number) => void;
  updatePlayerPresence: (userId: ID, isOnline: boolean) => void;
  setError: (error: ApiError) => void;
  clearError: () => void;
  requestFullState: () => void;
}

type GameStore = GameStoreState & GameStoreActions;

export const useGameStore = create<GameStore>((set, get) => ({
  // Initial state
  gameState: null,
  isConnected: false,
  isLoading: false,
  error: null,
  clientSeq: 0,
  connectionStatus: 'disconnected',

  // Actions
  connect: (gameId: ID, token: string) => {
    set({ 
      isLoading: true, 
      error: null,
      connectionStatus: 'connecting'
    });

    try {
      // Connect to socket
      socketService.connect(token);

      // Set up event listeners
      socketService.onInit((data) => {
        get().applyStateInit(data.gameState, data.serverSeq);
        set({ 
          isConnected: true, 
          isLoading: false,
          connectionStatus: 'connected'
        });
      });

      socketService.onPatch((data) => {
        get().applyStatePatch(data.patch, data.serverSeq);
      });

      socketService.onTurnChange((data) => {
        get().applyTurnChange(data.currentTurnUserId, data.serverSeq);
      });

      socketService.onPresenceUpdate((data) => {
        get().updatePlayerPresence(data.userId, data.isOnline);
      });

      socketService.onError((error) => {
        get().setError({
          error: error.code,
          message: error.message,
        });
      });

      // Join the game room
      socketService.join(gameId);
      
    } catch (_error) {
      set({
        isLoading: false,
        connectionStatus: 'disconnected',
        error: {
          error: 'CONNECTION_ERROR',
          message: 'Failed to connect to game server',
        },
      });
    }
  },

  disconnect: () => {
    socketService.removeAllListeners();
    socketService.disconnect();
    
    set({
      gameState: null,
      isConnected: false,
      isLoading: false,
      connectionStatus: 'disconnected',
      clientSeq: 0,
    });
  },

  sendAction: (type: string, payload: unknown) => {
    const gameState = get().gameState;
    if (!gameState || !socketService.isConnected()) {
      return;
    }

    const clientSeq = get().clientSeq + 1;
    set({ clientSeq });

    try {
      socketService.sendAction(gameState.id, type, payload, clientSeq);
    } catch (_error) {
      get().setError({
        error: 'ACTION_ERROR',
        message: 'Failed to send action to server',
      });
    }
  },

  applyStateInit: (gameState: GameState) => {
    set({
      gameState,
      error: null,
    });
  },

  applyStatePatch: (patch: Partial<GameState>) => {
    const currentState = get().gameState;
    if (!currentState) {
      // Request full state if we don't have current state
      get().requestFullState();
      return;
    }

    const newState: GameState = {
      ...currentState,
      ...patch,
      // Handle arrays properly
      players: patch.players || currentState.players,
      tracks: patch.tracks || currentState.tracks,
    };

    set({
      gameState: newState,
      error: null,
    });
  },

  applyTurnChange: (currentTurnUserId: ID) => {
    const currentState = get().gameState;
    if (!currentState) return;

    set({
      gameState: {
        ...currentState,
        currentTurnUserId,
      },
    });
  },

  updatePlayerPresence: (userId: ID, isOnline: boolean) => {
    const currentState = get().gameState;
    if (!currentState) return;

    const updatedPlayers = currentState.players.map(player =>
      player.userId === userId
        ? { ...player, isOnline }
        : player
    );

    set({
      gameState: {
        ...currentState,
        players: updatedPlayers,
      },
    });
  },

  setError: (error: ApiError) => {
    set({ error });
  },

  clearError: () => {
    set({ error: null });
  },

  requestFullState: () => {
    // This would trigger a full state request from the server
    // For now, we'll just log and hope the server sends a state:init
    debug.warn('Requesting full state from server (not implemented)');
    
    set({
      isLoading: true,
      connectionStatus: 'reconnecting',
    });
  },
}));