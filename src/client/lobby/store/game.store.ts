// store/game.store.ts
import { create } from 'zustand';
import type { GameState, ID, ApiError } from '../shared/types';
import type {
  EventCardDrawnPayload,
  EventEffectExpiredPayload,
  ActiveEffectSummary,
  QueuedUpdate,
  EventCard,
} from '../../../shared/types/EventCard';
import { socketService } from '../shared/socket';
import { debug } from '../shared/config';
import { authenticatedFetch } from '../../services/authenticatedFetch';

/** Auto-dismiss timer delay for event overlays (30 seconds) */
const EVENT_OVERLAY_AUTO_DISMISS_MS = 30_000;

interface GameStoreState {
  gameState: GameState | null;
  isConnected: boolean;
  isLoading: boolean;
  error: ApiError | null;
  clientSeq: number;
  connectionStatus: 'disconnected' | 'connecting' | 'connected' | 'reconnecting';
  /** Active event effects currently in play */
  activeEffects: ActiveEffectSummary[];
  /** Event card overlay awaiting player acknowledgment */
  pendingEventOverlay: EventCardDrawnPayload | null;
  /** Visual mutations queued while an event overlay is visible */
  pendingVisualUpdates: QueuedUpdate[];
  /** Client-side cache of event card definitions, keyed by card ID */
  eventCardCache: Map<number, EventCard>;
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
  /** Show event card overlay and start 30-second auto-dismiss timer */
  showEventOverlay: (payload: EventCardDrawnPayload) => void;
  /** Dismiss event overlay and flush all queued visual updates */
  dismissEventOverlay: () => void;
  /** Queue a visual mutation to be applied after the overlay is dismissed */
  enqueueVisualUpdate: (update: QueuedUpdate) => void;
  /** Apply all queued visual updates immediately */
  flushPendingVisualUpdates: () => void;
  /** Replace the full active effects list */
  setActiveEffects: (effects: ActiveEffectSummary[]) => void;
  /** Add a single active effect */
  addActiveEffect: (effect: ActiveEffectSummary) => void;
  /** Remove an active effect by card ID */
  removeActiveEffect: (cardId: number) => void;
  /** Fetch event card definitions from server and populate the cache */
  fetchEventCardDefinitions: () => Promise<void>;
}

type GameStore = GameStoreState & GameStoreActions;

/** Module-level timer handle for auto-dismiss (cleared on manual dismiss) */
let overlayAutoDismissTimer: ReturnType<typeof setTimeout> | null = null;

export const useGameStore = create<GameStore>((set, get) => ({
  // Initial state
  gameState: null,
  isConnected: false,
  isLoading: false,
  error: null,
  clientSeq: 0,
  connectionStatus: 'disconnected',
  activeEffects: [],
  pendingEventOverlay: null,
  pendingVisualUpdates: [],
  eventCardCache: new Map(),

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
        // Restore active effects from state:init (server includes them on reconnect)
        const initData = data as Record<string, unknown>;
        if (Array.isArray(initData.activeEffects)) {
          get().setActiveEffects(initData.activeEffects as ActiveEffectSummary[]);
        }
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

      // Wire event card socket listeners to store actions
      socketService.onEventCardDrawn((payload) => {
        get().showEventOverlay(payload);
      });

      socketService.onEventEffectExpired((payload) => {
        get().removeActiveEffect(payload.cardId);
      });

      socketService.onActiveEffects((effects) => {
        get().setActiveEffects(effects);
      });

      // Join the game room
      socketService.join(gameId);

      // Fetch and cache event card definitions for overlay rendering
      get().fetchEventCardDefinitions();

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
    // Clear overlay auto-dismiss timer to prevent stale callbacks after reconnect
    if (overlayAutoDismissTimer) {
      clearTimeout(overlayAutoDismissTimer);
      overlayAutoDismissTimer = null;
    }

    socketService.removeAllListeners();
    socketService.disconnect();

    set({
      gameState: null,
      isConnected: false,
      isLoading: false,
      connectionStatus: 'disconnected',
      clientSeq: 0,
      pendingEventOverlay: null,
      pendingVisualUpdates: [],
      activeEffects: [],
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

    // Visual gating: if an event overlay is pending, queue visual mutations instead of applying them
    const pendingOverlay = get().pendingEventOverlay;
    if (pendingOverlay !== null) {
      const isVisualMutation = patch.tracks !== undefined || patch.players !== undefined;
      if (isVisualMutation) {
        get().enqueueVisualUpdate({
          kind: 'generic_patch',
          patch: patch as Record<string, unknown>,
        });
        return;
      }
    }

    // Merge players array properly: if patch.players is provided, merge individual players
    let mergedPlayers = currentState.players;
    if (patch.players && patch.players.length > 0) {
      // Merge updated players into existing players array
      mergedPlayers = currentState.players.map(existingPlayer => {
        const updatedPlayer = patch.players!.find(p => p.id === existingPlayer.id);
        return updatedPlayer || existingPlayer;
      });
      // Add any new players that don't exist yet
      patch.players.forEach(updatedPlayer => {
        if (!mergedPlayers.find(p => p.id === updatedPlayer.id)) {
          mergedPlayers.push(updatedPlayer);
        }
      });
    }

    const newState: GameState = {
      ...currentState,
      ...patch,
      // Use merged arrays
      players: mergedPlayers,
      tracks: patch.tracks !== undefined ? patch.tracks : currentState.tracks,
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

  showEventOverlay: (payload: EventCardDrawnPayload) => {
    // Clear any existing auto-dismiss timer
    if (overlayAutoDismissTimer !== null) {
      clearTimeout(overlayAutoDismissTimer);
    }

    set({ pendingEventOverlay: payload });

    // For persistent effects, immediately add to activeEffects so the HUD updates.
    // The server only broadcasts event:active-effects on reconnect, so we derive
    // an ActiveEffectSummary from the drawn card payload here.
    if (payload.duration === 'persistent') {
      get().addActiveEffect({
        cardId: payload.card.id,
        cardType: payload.card.type,
        drawingPlayerId: payload.drawingPlayerId,
        drawingPlayerName: payload.drawingPlayerName,
        expiresAfterTurnNumber: 0, // Unknown from payload; HUD shows "active" as fallback
        affectedZone: payload.affectedZone,
        effectSummary: payload.effectSummary,
      });
    }

    // Start a 30-second auto-dismiss timer
    overlayAutoDismissTimer = setTimeout(() => {
      get().dismissEventOverlay();
    }, EVENT_OVERLAY_AUTO_DISMISS_MS);
  },

  dismissEventOverlay: () => {
    // Clear the auto-dismiss timer if it's still running
    if (overlayAutoDismissTimer !== null) {
      clearTimeout(overlayAutoDismissTimer);
      overlayAutoDismissTimer = null;
    }

    set({ pendingEventOverlay: null });

    // Flush all queued visual updates now that overlay is dismissed
    get().flushPendingVisualUpdates();
  },

  enqueueVisualUpdate: (update: QueuedUpdate) => {
    set(state => ({
      pendingVisualUpdates: [...state.pendingVisualUpdates, update],
    }));
  },

  flushPendingVisualUpdates: () => {
    const updates = get().pendingVisualUpdates;

    if (updates.length === 0) return;

    // Clear the queue first to prevent re-entrancy issues
    set({ pendingVisualUpdates: [] });

    // Apply each queued patch in order (use 0 as sentinel for serverSeq — these updates bypass seq checking)
    for (const update of updates) {
      try {
        get().applyStatePatch(update.patch as Partial<GameState>, 0);
      } catch (err) {
        debug.error('[game.store] Failed to apply queued visual update:', err);
      }
    }
  },

  setActiveEffects: (effects: ActiveEffectSummary[]) => {
    set({ activeEffects: effects });
  },

  addActiveEffect: (effect: ActiveEffectSummary) => {
    set(state => {
      // Replace existing entry for same cardId if present, otherwise append
      const existing = state.activeEffects.findIndex(e => e.cardId === effect.cardId);
      if (existing >= 0) {
        const updated = [...state.activeEffects];
        updated[existing] = effect;
        return { activeEffects: updated };
      }
      return { activeEffects: [...state.activeEffects, effect] };
    });
  },

  removeActiveEffect: (cardId: number) => {
    set(state => ({
      activeEffects: state.activeEffects.filter(e => e.cardId !== cardId),
    }));
  },

  fetchEventCardDefinitions: async () => {
    try {
      const response = await authenticatedFetch('/api/deck/events');
      if (!response.ok) {
        debug.warn('[game.store] Failed to fetch event card definitions:', response.status);
        return;
      }
      const cards: EventCard[] = await response.json();
      const cache = new Map<number, EventCard>();
      for (const card of cards) {
        cache.set(card.id, card);
      }
      set({ eventCardCache: cache });
    } catch (err) {
      debug.error('[game.store] Error fetching event card definitions:', err);
    }
  },
}));