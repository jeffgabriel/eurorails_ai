import { GameSocketCoordinator, GameSocketCoordinatorDeps } from '../services/GameSocketCoordinator';
import { GameStateService } from '../services/GameStateService';
import { PlayerStateService } from '../services/PlayerStateService';
import { socketService } from '../lobby/shared/socket';
import { authenticatedFetch } from '../services/authenticatedFetch';
import { useGameStore } from '../lobby/store/game.store';
import { FullGameState, Player } from '../../shared/types/GameTypes';
import type { TrackDrawingManager } from '../components/TrackDrawingManager';
import type { LoadService } from '../services/LoadService';

jest.mock('../services/authenticatedFetch', () => ({
  authenticatedFetch: jest.fn(),
}));

jest.mock('../config/apiConfig', () => ({
  config: { apiBaseUrl: 'http://test' },
}));

jest.mock('../lobby/store/game.store', () => ({
  useGameStore: {
    getState: jest.fn(() => ({
      showEventOverlay: jest.fn(),
      removeActiveEffect: jest.fn(),
      setActiveEffects: jest.fn(),
    })),
  },
}));

jest.mock('../lobby/shared/socket', () => ({
  socketService: {
    ensureConnected: jest.fn(),
    join: jest.fn(),
    onInit: jest.fn(),
    onTurnChange: jest.fn(),
    onPatch: jest.fn(),
    onVictoryTriggered: jest.fn(),
    onGameOver: jest.fn(),
    onTieExtended: jest.fn(),
    onTrackUpdated: jest.fn(),
    onEventCardDrawn: jest.fn(),
    onEventEffectExpired: jest.fn(),
    onActiveEffects: jest.fn(),
    onAutoRunStatus: jest.fn(() => jest.fn()),
    onAnyEvent: jest.fn(() => jest.fn()),
    onReconnected: jest.fn(() => jest.fn()),
    onSeqGap: jest.fn(() => jest.fn()),
  },
}));

function createPlayer(id: string): Player {
  return {
    id,
    name: id,
    color: '#ff0000',
    money: 50,
    trainState: {
      position: null,
      remainingMovement: 0,
      movementHistory: [],
      loads: [],
    },
    hand: [],
  } as unknown as Player;
}

function createGameState(): FullGameState {
  return {
    id: 'game-1',
    players: [createPlayer('p1'), createPlayer('p2')],
    currentPlayerIndex: 0,
    status: 'active',
    maxPlayers: 4,
  } as unknown as FullGameState;
}

function getLastCall(mockFn: jest.Mock): any[] {
  const calls = mockFn.mock.calls;
  if (calls.length === 0) {
    throw new Error('Mock was never called');
  }
  return calls[calls.length - 1];
}

describe('GameSocketCoordinator', () => {
  let coordinator: GameSocketCoordinator;
  let gameStateService: GameStateService;
  let playerStateService: PlayerStateService;
  let deps: GameSocketCoordinatorDeps;
  let trackManager: { loadExistingTracks: jest.Mock; drawAllTracks: jest.Mock };
  let loadService: { loadInitialState: jest.Mock };

  beforeEach(() => {
    jest.clearAllMocks();
    (socketService.ensureConnected as jest.Mock).mockResolvedValue(true);
    (localStorage as any).getItem = jest.fn(() => 'test-token');

    coordinator = new GameSocketCoordinator();
    gameStateService = new GameStateService(createGameState());
    playerStateService = new PlayerStateService();
    trackManager = { loadExistingTracks: jest.fn().mockResolvedValue(undefined), drawAllTracks: jest.fn() };
    loadService = { loadInitialState: jest.fn().mockResolvedValue(undefined) };

    deps = {
      gameId: 'game-1',
      gameStateService,
      playerStateService,
      loadService: loadService as unknown as LoadService,
      getTrackManager: () => trackManager as unknown as TrackDrawingManager,
      getMapGridPoint: (row, col) => ({ x: row * 10, y: col * 10 }),
      isBotAnimating: () => false,
      onApplySpriteUpdates: jest.fn(),
      onUIRefresh: jest.fn(),
      onLaunchWinner: jest.fn(),
      onTieExtended: jest.fn(),
      onAutoRunStatus: jest.fn(),
      onBotTurnComplete: jest.fn(),
    };
  });

  describe('start', () => {
    it('connects, joins the game room, and registers every game socket handler exactly once', async () => {
      const connected = await coordinator.start(deps);

      expect(connected).toBe(true);
      expect(socketService.ensureConnected).toHaveBeenCalledWith('test-token');
      expect(socketService.join).toHaveBeenCalledWith('game-1');

      expect(socketService.onInit).toHaveBeenCalledTimes(1);
      expect(socketService.onTurnChange).toHaveBeenCalledTimes(1);
      expect(socketService.onPatch).toHaveBeenCalledTimes(1);
      expect(socketService.onVictoryTriggered).toHaveBeenCalledTimes(1);
      expect(socketService.onGameOver).toHaveBeenCalledTimes(1);
      expect(socketService.onTieExtended).toHaveBeenCalledTimes(1);
      expect(socketService.onTrackUpdated).toHaveBeenCalledTimes(1);
      expect(socketService.onEventCardDrawn).toHaveBeenCalledTimes(1);
      expect(socketService.onEventEffectExpired).toHaveBeenCalledTimes(1);
      expect(socketService.onActiveEffects).toHaveBeenCalledTimes(1);
      expect(socketService.onAutoRunStatus).toHaveBeenCalledTimes(1);
      expect(socketService.onAnyEvent).toHaveBeenCalledTimes(1);
      expect(socketService.onReconnected).toHaveBeenCalledTimes(1);
      expect(socketService.onSeqGap).toHaveBeenCalledTimes(1);
    });

    it('returns false and does not register handlers when the socket fails to connect (fail closed)', async () => {
      (socketService.ensureConnected as jest.Mock).mockResolvedValue(false);

      const connected = await coordinator.start(deps);

      expect(connected).toBe(false);
      expect(socketService.join).not.toHaveBeenCalled();
      expect(socketService.onPatch).not.toHaveBeenCalled();
    });

    it('registers onInit so SocketService seeds serverSeq from state:init (bug #4)', async () => {
      await coordinator.start(deps);

      expect(socketService.onInit).toHaveBeenCalledTimes(1);
      expect(typeof (socketService.onInit as jest.Mock).mock.calls[0][0]).toBe('function');
    });
  });

  describe('onTurnChange handler', () => {
    it('updates currentPlayerIndex only when the new index differs from the current one', async () => {
      await coordinator.start(deps);
      const handler = getLastCall(socketService.onTurnChange as jest.Mock)[0];

      const spy = jest.spyOn(gameStateService, 'updateCurrentPlayerIndex');

      // Same as current (0) — should not update.
      handler({ currentPlayerIndex: 0 });
      expect(spy).not.toHaveBeenCalled();

      // Different — should update.
      handler({ currentPlayerIndex: 1 });
      expect(spy).toHaveBeenCalledWith(1);
    });
  });

  describe('onPatch handler', () => {
    it('applies the server patch, forwards resolved sprite updates, and refreshes the UI', async () => {
      await coordinator.start(deps);
      const handler = getLastCall(socketService.onPatch as jest.Mock)[0];

      const patchSpy = jest.spyOn(gameStateService, 'applyServerPatch').mockReturnValue({
        spriteUpdates: [{ playerId: 'p2', row: 3, col: 4 }],
      });

      handler({ patch: { players: [] }, serverSeq: 1 });

      expect(patchSpy).toHaveBeenCalled();
      expect(deps.onApplySpriteUpdates).toHaveBeenCalledWith([
        { playerId: 'p2', x: 30, y: 40, row: 3, col: 4 },
      ]);
      expect(deps.onUIRefresh).toHaveBeenCalled();
    });

    it('skips sprite updates for players whose train is mid-animation', async () => {
      deps.isBotAnimating = (playerId: string) => playerId === 'p2';
      await coordinator.start(deps);
      const handler = getLastCall(socketService.onPatch as jest.Mock)[0];

      jest.spyOn(gameStateService, 'applyServerPatch').mockReturnValue({
        spriteUpdates: [{ playerId: 'p2', row: 3, col: 4 }],
      });

      handler({ patch: {}, serverSeq: 1 });

      expect(deps.onApplySpriteUpdates).not.toHaveBeenCalled();
    });
  });

  describe('stop', () => {
    it('clears the resync timer and calls every stored unsubscribe function', async () => {
      await coordinator.start(deps);

      const autoRunUnsub = (socketService.onAutoRunStatus as jest.Mock).mock.results[0].value;
      const anyEventUnsub = (socketService.onAnyEvent as jest.Mock).mock.results[0].value;
      const reconnectedUnsub = (socketService.onReconnected as jest.Mock).mock.results[0].value;
      const seqGapUnsub = (socketService.onSeqGap as jest.Mock).mock.results[0].value;

      coordinator.stop();

      expect(autoRunUnsub).toHaveBeenCalledTimes(1);
      expect(anyEventUnsub).toHaveBeenCalledTimes(1);
      expect(reconnectedUnsub).toHaveBeenCalledTimes(1);
      expect(seqGapUnsub).toHaveBeenCalledTimes(1);
    });

    it('is safe to call multiple times and before start()', () => {
      expect(() => coordinator.stop()).not.toThrow();
      expect(() => coordinator.stop()).not.toThrow();
    });

    it('cancels a pending (not-yet-fired) resync timer so it never runs', async () => {
      jest.useFakeTimers();
      try {
        (authenticatedFetch as jest.Mock).mockResolvedValue({ ok: true, json: () => Promise.resolve({}) });
        await coordinator.start(deps);
        const reconnectedHandler = getLastCall(socketService.onReconnected as jest.Mock)[0];

        reconnectedHandler(); // schedules the debounced resync timer
        coordinator.stop();
        await jest.advanceTimersByTimeAsync(1000);

        expect(authenticatedFetch).not.toHaveBeenCalledWith(expect.stringContaining('/api/game/game-1'));
      } finally {
        jest.useRealTimers();
      }
    });
  });

  describe('scheduleSocketResync (via reconnect/seq-gap)', () => {
    beforeEach(() => {
      jest.useFakeTimers();
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    it('heals currentPlayerIndex from GET /api/game/:id and refreshes UI, debounced 250ms', async () => {
      (authenticatedFetch as jest.Mock).mockImplementation((url: string) => {
        if (url.includes('/api/game/')) {
          return Promise.resolve({ ok: true, json: () => Promise.resolve({ currentPlayerIndex: 1 }) });
        }
        return Promise.resolve({ ok: true, json: () => Promise.resolve([]) });
      });

      await coordinator.start(deps);
      const reconnectedHandler = getLastCall(socketService.onReconnected as jest.Mock)[0];
      const updateSpy = jest.spyOn(gameStateService, 'updateCurrentPlayerIndex');

      reconnectedHandler();
      expect(updateSpy).not.toHaveBeenCalled(); // debounced, not yet fired

      await jest.advanceTimersByTimeAsync(250);

      expect(authenticatedFetch).toHaveBeenCalledWith(expect.stringContaining('/api/game/game-1'));
      expect(updateSpy).toHaveBeenCalledWith(1);
      expect(deps.onUIRefresh).toHaveBeenCalled();
    });

    it('debounces multiple reconnect/seq-gap events within the window into a single resync', async () => {
      (authenticatedFetch as jest.Mock).mockImplementation((url: string) => {
        if (url.includes('/api/game/')) {
          return Promise.resolve({ ok: true, json: () => Promise.resolve({ currentPlayerIndex: 0 }) });
        }
        return Promise.resolve({ ok: true, json: () => Promise.resolve([]) });
      });

      await coordinator.start(deps);
      const reconnectedHandler = getLastCall(socketService.onReconnected as jest.Mock)[0];
      const seqGapHandler = getLastCall(socketService.onSeqGap as jest.Mock)[0];

      reconnectedHandler();
      await jest.advanceTimersByTimeAsync(100);
      seqGapHandler({ expected: 1, received: 3 });
      await jest.advanceTimersByTimeAsync(250);

      // Only the debounced (second, restarted) timer should have fired the HTTP heal call.
      const healCalls = (authenticatedFetch as jest.Mock).mock.calls.filter(([url]) =>
        String(url).includes('/api/game/'),
      );
      expect(healCalls.length).toBe(1);
    });

    it('does not overlap a second resync while one is already in flight', async () => {
      let resolveFirstFetch!: (value: unknown) => void;
      (authenticatedFetch as jest.Mock).mockImplementation((url: string) => {
        if (url.includes('/api/game/')) {
          return new Promise((resolve) => {
            resolveFirstFetch = resolve;
          });
        }
        return Promise.resolve({ ok: true, json: () => Promise.resolve([]) });
      });

      await coordinator.start(deps);
      const reconnectedHandler = getLastCall(socketService.onReconnected as jest.Mock)[0];

      reconnectedHandler();
      await jest.advanceTimersByTimeAsync(250);
      await Promise.resolve(); // let runResync start and set resyncInFlight = true

      // A second reconnect fires while the first resync's fetch is still pending.
      reconnectedHandler();
      await jest.advanceTimersByTimeAsync(250);

      const healCallsBeforeResolve = (authenticatedFetch as jest.Mock).mock.calls.filter(([url]) =>
        String(url).includes('/api/game/'),
      );
      // In-flight guard: the second debounce fired runResync again, but it must
      // have returned early without issuing a second HTTP heal call.
      expect(healCallsBeforeResolve.length).toBe(1);

      resolveFirstFetch({ ok: true, json: () => Promise.resolve({}) });
      await Promise.resolve();
      await Promise.resolve();
    });

    it('applies already-resolved (x/y known) sprite updates returned by the player refresh', async () => {
      (authenticatedFetch as jest.Mock).mockImplementation((url: string) => {
        if (url.includes('/api/game/')) {
          return Promise.resolve({ ok: true, json: () => Promise.resolve({ currentPlayerIndex: 0 }) });
        }
        // Player refresh: p2 has moved, giving a fully-resolved sprite update.
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve([
              {
                id: 'p2',
                name: 'p2',
                color: '#00ff00',
                money: 50,
                trainState: { position: { x: 55, y: 66, row: 5, col: 6 }, remainingMovement: 0, movementHistory: [], loads: [] },
                hand: [],
              },
            ]),
        });
      });

      await coordinator.start(deps);
      const reconnectedHandler = getLastCall(socketService.onReconnected as jest.Mock)[0];

      reconnectedHandler();
      await jest.advanceTimersByTimeAsync(250);

      expect(deps.onApplySpriteUpdates).toHaveBeenCalledWith([
        { playerId: 'p2', x: 55, y: 66, row: 5, col: 6 },
      ]);
    });

    it('logs and recovers when the resync throws partway through (e.g. loadService rejects)', async () => {
      (authenticatedFetch as jest.Mock).mockImplementation((url: string) => {
        if (url.includes('/api/game/')) {
          return Promise.resolve({ ok: true, json: () => Promise.resolve({ currentPlayerIndex: 0 }) });
        }
        return Promise.resolve({ ok: true, json: () => Promise.resolve([]) });
      });
      (loadService.loadInitialState as jest.Mock).mockRejectedValueOnce(new Error('load failed'));
      const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

      await coordinator.start(deps);
      const reconnectedHandler = getLastCall(socketService.onReconnected as jest.Mock)[0];

      reconnectedHandler();
      await jest.advanceTimersByTimeAsync(250);

      expect(errorSpy).toHaveBeenCalledWith('[GameSocketCoordinator] Socket resync failed:', expect.any(Error));
      errorSpy.mockRestore();

      // A subsequent resync must still be able to run (resyncInFlight was reset).
      (authenticatedFetch as jest.Mock).mockClear();
      reconnectedHandler();
      await jest.advanceTimersByTimeAsync(250);
      expect(authenticatedFetch).toHaveBeenCalled();
    });

    it('warns and skips the currentPlayerIndex heal when GET /api/game/:id responds non-ok', async () => {
      (authenticatedFetch as jest.Mock).mockImplementation((url: string) => {
        if (url.includes('/api/game/')) {
          return Promise.resolve({ ok: false, status: 500, json: () => Promise.resolve({}) });
        }
        return Promise.resolve({ ok: true, json: () => Promise.resolve([]) });
      });
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
      const updateSpy = jest.spyOn(gameStateService, 'updateCurrentPlayerIndex');

      await coordinator.start(deps);
      const reconnectedHandler = getLastCall(socketService.onReconnected as jest.Mock)[0];

      reconnectedHandler();
      await jest.advanceTimersByTimeAsync(250);

      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Failed to heal currentPlayerIndex: HTTP 500'));
      expect(updateSpy).not.toHaveBeenCalled();
      warnSpy.mockRestore();
    });

    it('logs and recovers when the currentPlayerIndex heal fetch itself rejects', async () => {
      (authenticatedFetch as jest.Mock).mockImplementation((url: string) => {
        if (url.includes('/api/game/')) {
          return Promise.reject(new Error('network down'));
        }
        return Promise.resolve({ ok: true, json: () => Promise.resolve([]) });
      });
      const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

      await coordinator.start(deps);
      const reconnectedHandler = getLastCall(socketService.onReconnected as jest.Mock)[0];

      reconnectedHandler();
      await jest.advanceTimersByTimeAsync(250);

      expect(errorSpy).toHaveBeenCalledWith('[GameSocketCoordinator] Error healing currentPlayerIndex:', expect.any(Error));
      // The rest of the resync still proceeds despite the heal failure.
      expect(deps.onUIRefresh).toHaveBeenCalled();
      errorSpy.mockRestore();
    });
  });

  describe('onVictoryTriggered handler', () => {
    it('sets victoryState and refreshes the UI when the payload is for this game', async () => {
      await coordinator.start(deps);
      const handler = getLastCall(socketService.onVictoryTriggered as jest.Mock)[0];

      handler({
        gameId: 'game-1',
        triggerPlayerIndex: 1,
        triggerPlayerName: 'p2',
        finalTurnPlayerIndex: 0,
        victoryThreshold: 250,
        timestamp: Date.now(),
      });

      expect(gameStateService.getGameState().victoryState).toEqual({
        triggered: true,
        triggerPlayerIndex: 1,
        victoryThreshold: 250,
        finalTurnPlayerIndex: 0,
      });
      expect(deps.onUIRefresh).toHaveBeenCalled();
    });

    it('ignores a payload for a different game', async () => {
      await coordinator.start(deps);
      const handler = getLastCall(socketService.onVictoryTriggered as jest.Mock)[0];

      handler({ gameId: 'other-game', triggerPlayerIndex: 1, finalTurnPlayerIndex: 0, victoryThreshold: 250, timestamp: Date.now() });

      expect(gameStateService.getGameState().victoryState).toBeUndefined();
      expect(deps.onUIRefresh).not.toHaveBeenCalled();
    });
  });

  describe('onGameOver handler', () => {
    it('marks the game completed and launches the winner scene when the payload is for this game', async () => {
      await coordinator.start(deps);
      const handler = getLastCall(socketService.onGameOver as jest.Mock)[0];

      handler({ gameId: 'game-1', winnerId: 'p1', winnerName: 'p1', timestamp: Date.now() });

      expect(gameStateService.getGameState().status).toBe('completed');
      expect(deps.onLaunchWinner).toHaveBeenCalledWith('p1', 'p1');
    });

    it('ignores a payload for a different game', async () => {
      await coordinator.start(deps);
      const handler = getLastCall(socketService.onGameOver as jest.Mock)[0];

      handler({ gameId: 'other-game', winnerId: 'p1', winnerName: 'p1', timestamp: Date.now() });

      expect(gameStateService.getGameState().status).not.toBe('completed');
      expect(deps.onLaunchWinner).not.toHaveBeenCalled();
    });
  });

  describe('onTieExtended handler', () => {
    it('resets victoryState with the new threshold and notifies the caller', async () => {
      await coordinator.start(deps);
      const handler = getLastCall(socketService.onTieExtended as jest.Mock)[0];

      handler({ gameId: 'game-1', newThreshold: 300, timestamp: Date.now() });

      expect(gameStateService.getGameState().victoryState).toEqual({
        triggered: false,
        triggerPlayerIndex: -1,
        victoryThreshold: 300,
        finalTurnPlayerIndex: -1,
      });
      expect(deps.onTieExtended).toHaveBeenCalledWith(300);
      expect(deps.onUIRefresh).toHaveBeenCalled();
    });

    it('ignores a payload for a different game', async () => {
      await coordinator.start(deps);
      const handler = getLastCall(socketService.onTieExtended as jest.Mock)[0];

      handler({ gameId: 'other-game', newThreshold: 300, timestamp: Date.now() });

      expect(deps.onTieExtended).not.toHaveBeenCalled();
    });
  });

  describe('onTrackUpdated handler', () => {
    it('reloads and redraws tracks when the payload is for this game and a track manager exists', async () => {
      await coordinator.start(deps);
      const handler = getLastCall(socketService.onTrackUpdated as jest.Mock)[0];

      await handler({ gameId: 'game-1', playerId: 'p2', timestamp: Date.now() });

      expect(trackManager.loadExistingTracks).toHaveBeenCalled();
      expect(trackManager.drawAllTracks).toHaveBeenCalled();
    });

    it('does nothing for a payload from a different game', async () => {
      await coordinator.start(deps);
      const handler = getLastCall(socketService.onTrackUpdated as jest.Mock)[0];

      await handler({ gameId: 'other-game', playerId: 'p2', timestamp: Date.now() });

      expect(trackManager.loadExistingTracks).not.toHaveBeenCalled();
    });

    it('logs and does not throw when reloading tracks fails', async () => {
      await coordinator.start(deps);
      const handler = getLastCall(socketService.onTrackUpdated as jest.Mock)[0];
      trackManager.loadExistingTracks.mockRejectedValueOnce(new Error('boom'));

      await expect(handler({ gameId: 'game-1', playerId: 'p2', timestamp: Date.now() })).resolves.toBeUndefined();
    });
  });

  describe('event card handlers', () => {
    it('forwards event:card-drawn payloads to the Zustand store', async () => {
      const showEventOverlay = jest.fn();
      (useGameStore.getState as jest.Mock).mockReturnValue({
        showEventOverlay,
        removeActiveEffect: jest.fn(),
        setActiveEffects: jest.fn(),
      });

      await coordinator.start(deps);
      const handler = getLastCall(socketService.onEventCardDrawn as jest.Mock)[0];
      const payload = { gameId: 'game-1', card: { id: 1 }, drawingPlayerId: 'p1' };

      handler(payload);

      expect(showEventOverlay).toHaveBeenCalledWith(payload);
    });

    it('forwards event:effect-expired payloads to the Zustand store', async () => {
      const removeActiveEffect = jest.fn();
      (useGameStore.getState as jest.Mock).mockReturnValue({
        showEventOverlay: jest.fn(),
        removeActiveEffect,
        setActiveEffects: jest.fn(),
      });

      await coordinator.start(deps);
      const handler = getLastCall(socketService.onEventEffectExpired as jest.Mock)[0];

      handler({ gameId: 'game-1', cardId: 7 });

      expect(removeActiveEffect).toHaveBeenCalledWith(7);
    });

    it('forwards event:active-effects payloads to the Zustand store', async () => {
      const setActiveEffects = jest.fn();
      (useGameStore.getState as jest.Mock).mockReturnValue({
        showEventOverlay: jest.fn(),
        removeActiveEffect: jest.fn(),
        setActiveEffects,
      });

      await coordinator.start(deps);
      const handler = getLastCall(socketService.onActiveEffects as jest.Mock)[0];
      const effects = [{ cardId: 1 }];

      handler(effects);

      expect(setActiveEffects).toHaveBeenCalledWith(effects);
    });
  });

  describe('onAutoRunStatus handler', () => {
    it('forwards the enabled flag to the caller', async () => {
      await coordinator.start(deps);
      const handler = getLastCall(socketService.onAutoRunStatus as jest.Mock)[0];

      handler({ enabled: true });

      expect(deps.onAutoRunStatus).toHaveBeenCalledWith(true);
    });
  });

  describe('bot:turn-complete dispatch (via onAnyEvent)', () => {
    it('forwards only bot:turn-complete events to onBotTurnComplete', async () => {
      await coordinator.start(deps);
      const handler = getLastCall(socketService.onAnyEvent as jest.Mock)[0];

      handler('some-other-event', { irrelevant: true });
      expect(deps.onBotTurnComplete).not.toHaveBeenCalled();

      const payload = { botPlayerId: 'p2' };
      handler('bot:turn-complete', payload);
      expect(deps.onBotTurnComplete).toHaveBeenCalledWith(payload);
    });
  });

  describe('stop error handling', () => {
    it('logs and continues if an individual unsubscribe function throws', async () => {
      const throwingUnsub = jest.fn(() => {
        throw new Error('unsub failed');
      });
      (socketService.onAutoRunStatus as jest.Mock).mockReturnValueOnce(throwingUnsub);
      const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

      await coordinator.start(deps);

      expect(() => coordinator.stop()).not.toThrow();
      expect(throwingUnsub).toHaveBeenCalled();
      expect(errorSpy).toHaveBeenCalled();

      // The other unsubs must still run despite the throw.
      const anyEventUnsub = (socketService.onAnyEvent as jest.Mock).mock.results[0].value;
      expect(anyEventUnsub).toHaveBeenCalled();

      errorSpy.mockRestore();
    });
  });
});
