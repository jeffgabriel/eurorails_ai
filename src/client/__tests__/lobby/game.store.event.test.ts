/**
 * Tests for FE-001: Game Store Event Management & Visual Gating Logic
 *
 * Covers:
 * - New store fields initialization
 * - showEventOverlay / dismissEventOverlay behavior
 * - Visual gating in applyStatePatch
 * - enqueueVisualUpdate / flushPendingVisualUpdates
 * - setActiveEffects / addActiveEffect / removeActiveEffect
 */
import { act } from 'react';
import type { EventCardDrawnPayload, ActiveEffectSummary, QueuedUpdate } from '../../../shared/types/EventCard';
import { EventCardType } from '../../../shared/types/EventCard';
import type { GameState } from '../../lobby/shared/types';

// ---------- mock socket.io-client ----------
jest.mock('socket.io-client', () => ({
  io: jest.fn(() => ({
    connected: false,
    on: jest.fn(),
    off: jest.fn(),
    emit: jest.fn(),
    disconnect: jest.fn(),
    removeAllListeners: jest.fn(),
    onAny: jest.fn(),
    offAny: jest.fn(),
    io: { on: jest.fn() },
    auth: {},
  })),
}));

// ---------- mock config / debug ----------
jest.mock('../../lobby/shared/config', () => ({
  config: { socketUrl: 'http://localhost:3001' },
  debug: {
    log: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

// ---------- import store AFTER mocks ----------
import { useGameStore } from '../../../client/lobby/store/game.store';

// ---------- helpers ----------

/** Build a minimal EventCardDrawnPayload */
const makeDrawnPayload = (cardId = 125): EventCardDrawnPayload => ({
  gameId: 'game-1',
  card: {
    id: cardId,
    type: EventCardType.Derailment,
    title: 'Derailment!',
    description: 'Trains derail',
    effectConfig: {
      type: EventCardType.Derailment,
      cities: ['Berlin'],
      radius: 3,
    },
  },
  drawingPlayerId: 'player-1',
  drawingPlayerName: 'Alice',
  affectedZone: ['r10c20'],
  affectedPlayerIds: ['player-2'],
  affectedPlayerNames: ['Bob'],
  effectSummary: 'All trains within 3 mileposts of Berlin lose 1 turn and 1 load.',
  duration: 'immediate',
  timestamp: new Date().toISOString(),
});

/** Build a minimal GameState for testing */
const makeGameState = (): GameState => ({
  id: 'game-1',
  players: [{ id: 'p1', userId: 'u1', name: 'Alice', color: '#ff0000', isOnline: true }],
  currentTurnUserId: 'u1',
  tracks: [],
});

// Reset store state between tests using the internal set
const resetStore = () => {
  const store = useGameStore.getState();
  // Reset all event-related fields
  useGameStore.setState({
    activeEffects: [],
    pendingEventOverlay: null,
    pendingVisualUpdates: [],
    eventCardCache: new Map(),
    gameState: null,
    error: null,
  });
};

describe('Game Store — Event Management (FE-001)', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    resetStore();
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.clearAllMocks();
  });

  // ── Field initialization ──────────────────────────────────────────────────

  describe('initial state', () => {
    it('initializes activeEffects as empty array', () => {
      expect(useGameStore.getState().activeEffects).toEqual([]);
    });

    it('initializes pendingEventOverlay as null', () => {
      expect(useGameStore.getState().pendingEventOverlay).toBeNull();
    });

    it('initializes pendingVisualUpdates as empty array', () => {
      expect(useGameStore.getState().pendingVisualUpdates).toEqual([]);
    });

    it('initializes eventCardCache as empty Map', () => {
      expect(useGameStore.getState().eventCardCache).toBeInstanceOf(Map);
      expect(useGameStore.getState().eventCardCache.size).toBe(0);
    });
  });

  // ── showEventOverlay ──────────────────────────────────────────────────────

  describe('showEventOverlay', () => {
    it('sets pendingEventOverlay to the given payload', () => {
      const payload = makeDrawnPayload();
      act(() => {
        useGameStore.getState().showEventOverlay(payload);
      });
      expect(useGameStore.getState().pendingEventOverlay).toEqual(payload);
    });

    it('starts a 30-second auto-dismiss timer that clears the overlay', () => {
      const payload = makeDrawnPayload();
      act(() => {
        useGameStore.getState().showEventOverlay(payload);
      });
      expect(useGameStore.getState().pendingEventOverlay).not.toBeNull();

      // Advance timer by 30 seconds
      act(() => {
        jest.advanceTimersByTime(30_000);
      });

      expect(useGameStore.getState().pendingEventOverlay).toBeNull();
    });

    it('replaces an existing overlay (resets auto-dismiss timer)', () => {
      const payload1 = makeDrawnPayload(125);
      const payload2 = makeDrawnPayload(126);

      act(() => {
        useGameStore.getState().showEventOverlay(payload1);
      });
      // Advance 15s — should NOT dismiss yet
      act(() => {
        jest.advanceTimersByTime(15_000);
      });
      expect(useGameStore.getState().pendingEventOverlay?.card.id).toBe(125);

      // Show a second overlay — timer should reset
      act(() => {
        useGameStore.getState().showEventOverlay(payload2);
      });
      expect(useGameStore.getState().pendingEventOverlay?.card.id).toBe(126);

      // Advance another 15s (total 30s from first show, 15s from second show)
      act(() => {
        jest.advanceTimersByTime(15_000);
      });
      // Overlay should still be visible (30s from second show not elapsed)
      expect(useGameStore.getState().pendingEventOverlay).not.toBeNull();
    });
  });

  // ── dismissEventOverlay ───────────────────────────────────────────────────

  describe('dismissEventOverlay', () => {
    it('clears pendingEventOverlay', () => {
      const payload = makeDrawnPayload();
      act(() => {
        useGameStore.getState().showEventOverlay(payload);
        useGameStore.getState().dismissEventOverlay();
      });
      expect(useGameStore.getState().pendingEventOverlay).toBeNull();
    });

    it('flushes queued visual updates after dismissing', () => {
      // Set up game state so applyStatePatch can merge
      useGameStore.setState({ gameState: makeGameState() });

      const payload = makeDrawnPayload();
      act(() => {
        useGameStore.getState().showEventOverlay(payload);
      });

      // Queue a visual update manually
      act(() => {
        useGameStore.getState().enqueueVisualUpdate({
          kind: 'generic_patch',
          patch: { currentTurnUserId: 'u2' },
        });
      });
      expect(useGameStore.getState().pendingVisualUpdates).toHaveLength(1);

      // Dismiss — should flush
      act(() => {
        useGameStore.getState().dismissEventOverlay();
      });
      expect(useGameStore.getState().pendingVisualUpdates).toHaveLength(0);
    });

    it('cancels the auto-dismiss timer on manual dismiss', () => {
      const payload = makeDrawnPayload();
      act(() => {
        useGameStore.getState().showEventOverlay(payload);
        useGameStore.getState().dismissEventOverlay();
      });

      // Advance full 30s — timer should NOT fire again
      act(() => {
        jest.advanceTimersByTime(30_000);
      });

      // No crash and overlay remains null
      expect(useGameStore.getState().pendingEventOverlay).toBeNull();
    });
  });

  // ── Visual gating in applyStatePatch ─────────────────────────────────────

  describe('applyStatePatch — visual gating', () => {
    it('applies patch directly when no overlay is pending', () => {
      const gameState = makeGameState();
      useGameStore.setState({ gameState });

      act(() => {
        useGameStore.getState().applyStatePatch({ currentTurnUserId: 'u2' }, 1);
      });

      expect(useGameStore.getState().gameState?.currentTurnUserId).toBe('u2');
      expect(useGameStore.getState().pendingVisualUpdates).toHaveLength(0);
    });

    it('enqueues patch containing tracks when overlay is pending', () => {
      const gameState = makeGameState();
      useGameStore.setState({ gameState });

      const payload = makeDrawnPayload();
      act(() => {
        useGameStore.getState().showEventOverlay(payload);
      });

      const trackPatch: Partial<GameState> = { tracks: [{ ownerUserId: 'u1', segments: [] }] };
      act(() => {
        useGameStore.getState().applyStatePatch(trackPatch, 2);
      });

      // Patch should NOT have been applied yet
      expect(useGameStore.getState().gameState?.tracks).toEqual([]);
      // But it should be queued
      expect(useGameStore.getState().pendingVisualUpdates).toHaveLength(1);
    });

    it('enqueues patch containing players when overlay is pending', () => {
      const gameState = makeGameState();
      useGameStore.setState({ gameState });

      const payload = makeDrawnPayload();
      act(() => {
        useGameStore.getState().showEventOverlay(payload);
      });

      const playerPatch: Partial<GameState> = {
        players: [{ id: 'p1', userId: 'u1', name: 'Alice', color: '#ff0000', isOnline: false }],
      };
      act(() => {
        useGameStore.getState().applyStatePatch(playerPatch, 3);
      });

      // Original player should still be online
      expect(useGameStore.getState().gameState?.players[0].isOnline).toBe(true);
      expect(useGameStore.getState().pendingVisualUpdates).toHaveLength(1);
    });

    it('applies non-visual patches directly even when overlay is pending', () => {
      const gameState = makeGameState();
      useGameStore.setState({ gameState });

      const payload = makeDrawnPayload();
      act(() => {
        useGameStore.getState().showEventOverlay(payload);
      });

      // A patch with only currentTurnUserId is NOT a visual mutation (no tracks/players)
      act(() => {
        useGameStore.getState().applyStatePatch({ currentTurnUserId: 'u3' }, 4);
      });

      // Should be applied immediately
      expect(useGameStore.getState().gameState?.currentTurnUserId).toBe('u3');
      expect(useGameStore.getState().pendingVisualUpdates).toHaveLength(0);
    });
  });

  // ── enqueueVisualUpdate ───────────────────────────────────────────────────

  describe('enqueueVisualUpdate', () => {
    it('appends updates to pendingVisualUpdates', () => {
      const update1: QueuedUpdate = { kind: 'track_change', patch: {} };
      const update2: QueuedUpdate = { kind: 'money_change', patch: {} };

      act(() => {
        useGameStore.getState().enqueueVisualUpdate(update1);
        useGameStore.getState().enqueueVisualUpdate(update2);
      });

      expect(useGameStore.getState().pendingVisualUpdates).toHaveLength(2);
      expect(useGameStore.getState().pendingVisualUpdates[0].kind).toBe('track_change');
      expect(useGameStore.getState().pendingVisualUpdates[1].kind).toBe('money_change');
    });
  });

  // ── flushPendingVisualUpdates ─────────────────────────────────────────────

  describe('flushPendingVisualUpdates', () => {
    it('clears pendingVisualUpdates after flushing', () => {
      useGameStore.setState({ gameState: makeGameState() });

      act(() => {
        useGameStore.getState().enqueueVisualUpdate({ kind: 'generic_patch', patch: { currentTurnUserId: 'u9' } });
        useGameStore.getState().flushPendingVisualUpdates();
      });

      expect(useGameStore.getState().pendingVisualUpdates).toHaveLength(0);
    });

    it('is a no-op when queue is empty', () => {
      expect(() => {
        act(() => {
          useGameStore.getState().flushPendingVisualUpdates();
        });
      }).not.toThrow();
    });
  });

  // ── Active effect management ──────────────────────────────────────────────

  describe('setActiveEffects', () => {
    it('replaces the activeEffects array', () => {
      const effect: ActiveEffectSummary = {
        cardId: 125,
        cardType: 'Derailment',
        drawingPlayerId: 'player-1',
        expiresAfterTurnNumber: 10,
        affectedZone: ['r5c10'],
      };

      act(() => {
        useGameStore.getState().setActiveEffects([effect]);
      });

      expect(useGameStore.getState().activeEffects).toHaveLength(1);
      expect(useGameStore.getState().activeEffects[0].cardId).toBe(125);
    });

    it('replaces the entire array (not appends)', () => {
      const e1: ActiveEffectSummary = { cardId: 1, cardType: 'Derailment', drawingPlayerId: 'p1', expiresAfterTurnNumber: 5, affectedZone: [] };
      const e2: ActiveEffectSummary = { cardId: 2, cardType: 'Snow', drawingPlayerId: 'p1', expiresAfterTurnNumber: 5, affectedZone: [] };

      act(() => {
        useGameStore.getState().setActiveEffects([e1]);
        useGameStore.getState().setActiveEffects([e2]);
      });

      expect(useGameStore.getState().activeEffects).toHaveLength(1);
      expect(useGameStore.getState().activeEffects[0].cardId).toBe(2);
    });
  });

  describe('addActiveEffect', () => {
    it('appends a new effect', () => {
      const effect: ActiveEffectSummary = { cardId: 130, cardType: 'Snow', drawingPlayerId: 'p1', expiresAfterTurnNumber: 8, affectedZone: [] };
      act(() => {
        useGameStore.getState().addActiveEffect(effect);
      });
      expect(useGameStore.getState().activeEffects).toHaveLength(1);
    });

    it('replaces an existing effect with the same cardId', () => {
      const e1: ActiveEffectSummary = { cardId: 130, cardType: 'Snow', drawingPlayerId: 'p1', expiresAfterTurnNumber: 8, affectedZone: [] };
      const e2: ActiveEffectSummary = { cardId: 130, cardType: 'Snow', drawingPlayerId: 'p2', expiresAfterTurnNumber: 10, affectedZone: [] };

      act(() => {
        useGameStore.getState().addActiveEffect(e1);
        useGameStore.getState().addActiveEffect(e2);
      });

      expect(useGameStore.getState().activeEffects).toHaveLength(1);
      expect(useGameStore.getState().activeEffects[0].drawingPlayerId).toBe('p2');
    });
  });

  describe('removeActiveEffect', () => {
    it('removes the effect with matching cardId', () => {
      const e1: ActiveEffectSummary = { cardId: 125, cardType: 'Derailment', drawingPlayerId: 'p1', expiresAfterTurnNumber: 5, affectedZone: [] };
      const e2: ActiveEffectSummary = { cardId: 130, cardType: 'Snow', drawingPlayerId: 'p1', expiresAfterTurnNumber: 8, affectedZone: [] };

      act(() => {
        useGameStore.getState().setActiveEffects([e1, e2]);
        useGameStore.getState().removeActiveEffect(125);
      });

      expect(useGameStore.getState().activeEffects).toHaveLength(1);
      expect(useGameStore.getState().activeEffects[0].cardId).toBe(130);
    });

    it('is a no-op if cardId is not found', () => {
      act(() => {
        useGameStore.getState().removeActiveEffect(999);
      });
      expect(useGameStore.getState().activeEffects).toHaveLength(0);
    });
  });
});
