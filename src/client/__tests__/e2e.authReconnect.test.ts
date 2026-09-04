// src/client/__tests__/e2e.authReconnect.test.ts
//
// TEST-002: E2E user-journey coverage for auth & reconnect resilience.
//
// No browser E2E framework exists in this repo -- confirmed via `grep -niE
// "playwright|cypress|puppeteer|webdriver" package.json` (no match) and no
// playwright.config.*/cypress.config.* files. Per the task's own
// Implementation Guidance ("Since Playwright infrastructure is not
// available, these E2E tests will be implemented using Jest, simulating
// browser and server interactions through extensive mocking"), these
// scenarios are Jest tests that exercise the REAL client-side integration
// -- auth.store.ts (FE-001), socket.ts/SocketService (FE-002), and
// GameSocketCoordinator (FE-003) -- together, UNMOCKED. Only the network
// boundary (fetch), the WebSocket transport (socket.io-client), sonner
// (toast), and localStorage are faked. This deliberately goes beyond the
// per-file unit tests already written for FE-001/FE-002/FE-003 (which each
// mock their neighbors) by proving the three real modules cooperate
// correctly through a full user journey.
//
// Scenario 4 (bot turn resumption) is fundamentally a server-side journey
// -- BotTurnTrigger.onHumanReconnect's DB fallback (src/server/services/ai/
// BotTurnTrigger.ts) -- that cannot run inside this jsdom client test
// process (different Jest project, different runtime). That server half,
// including the exact "DB fallback recovers a stuck bot after a simulated
// server restart" case, is already covered by
// src/server/__tests__/ai/BotTurnTrigger.test.ts's 'stuck bot recovery on
// reconnect' suite (extended for BE-001 in this same project). What's
// covered here is the CLIENT half of that same journey: once reconnected,
// the client correctly applies the turn:change event the server pushes
// after resuming the bot's turn via that fallback.

import { useAuthStore } from '../lobby/store/auth.store';
import { socketService } from '../lobby/shared/socket';
import { GameSocketCoordinator, GameSocketCoordinatorDeps } from '../services/GameSocketCoordinator';
import { GameStateService } from '../services/GameStateService';
import { PlayerStateService } from '../services/PlayerStateService';
import type { FullGameState, Player } from '../../shared/types/GameTypes';
import type { LoadService } from '../services/LoadService';

jest.mock('sonner', () => ({
  toast: {
    success: jest.fn(),
    error: jest.fn(),
  },
}));

// ── Mock socket.io-client (the WebSocket transport boundary) ───────────────

type Handler = (...args: any[]) => void;

const socketHandlers = new Map<string, Handler[]>();
const managerHandlers = new Map<string, Handler[]>();

function recordHandler(map: Map<string, Handler[]>, event: string, cb: Handler): void {
  const list = map.get(event) ?? [];
  list.push(cb);
  map.set(event, list);
}

/**
 * Real EventEmitter.off() semantics: with a specific callback, remove just
 * that one; with none, remove every listener for the event (matching how
 * this codebase calls `.off('some-event')` before re-registering).
 * Without this, `waitForConnection`'s ephemeral one-shot 'connect'/
 * 'connect_error' listeners (registered on every ensureConnected() call,
 * cleaned up via .off() once they fire) would pile up in the tracking map
 * and shadow the persistent listener setupEventHandlers() registers once --
 * getLastHandler() would then keep returning a stale, already-fired
 * ephemeral listener instead of the real one.
 */
function removeHandler(map: Map<string, Handler[]>, event: string, cb?: Handler): void {
  if (!cb) {
    map.delete(event);
    return;
  }
  const list = map.get(event);
  if (!list) return;
  const idx = list.indexOf(cb);
  if (idx !== -1) list.splice(idx, 1);
}

function getLastHandler(map: Map<string, Handler[]>, event: string): Handler {
  const list = map.get(event) ?? [];
  if (list.length === 0) {
    throw new Error(`No handler registered for event: ${event}`);
  }
  return list[list.length - 1];
}

/**
 * Simulate a real socket.io event emission: fire EVERY currently-registered
 * handler for the event, not just the most recently added one. socket.ts
 * registers a persistent 'connect' handler once (in setupEventHandlers, via
 * connect()) that tracks hasEverConnected/fires onReconnectedCallbacks, but
 * `waitForConnection()` ALSO registers its own ephemeral, one-shot 'connect'
 * listener on every ensureConnected() call (removed via .off() once it
 * fires). A real 'connect' event invokes both. Firing only the last
 * registered handler (getLastHandler) would, on the very first connect,
 * invoke just the ephemeral one -- resolving ensureConnected() correctly,
 * but never running the persistent handler that sets hasEverConnected, so a
 * later "reconnect" would incorrectly look like the first-ever connection
 * and skip the onReconnected -> resync path entirely.
 *
 * Snapshots the handler list before iterating: a handler may synchronously
 * call .off() (as the ephemeral one does), which would otherwise mutate the
 * live array mid-iteration.
 */
function emitEvent(map: Map<string, Handler[]>, event: string, ...args: unknown[]): void {
  const handlers = [...(map.get(event) ?? [])];
  for (const handler of handlers) {
    handler(...args);
  }
}

const mockSocket = {
  connected: false,
  id: 'mock-socket-id',
  disconnect: jest.fn(),
  connect: jest.fn(),
  auth: {} as Record<string, unknown>,
  on: jest.fn(),
  off: jest.fn(),
  emit: jest.fn(),
  onAny: jest.fn(),
  offAny: jest.fn(),
  removeAllListeners: jest.fn(),
  io: { on: jest.fn() },
};

jest.mock('socket.io-client', () => ({
  io: jest.fn(() => mockSocket),
}));

// ── Fake localStorage (real in-memory implementation) ───────────────────────

const JWT_STORAGE_KEY = 'eurorails.jwt';
const REFRESH_TOKEN_STORAGE_KEY = 'eurorails.refreshToken';
const USER_STORAGE_KEY = 'eurorails.user';

function installFakeLocalStorage(): void {
  const store = new Map<string, string>();
  Object.defineProperty(window, 'localStorage', {
    value: {
      getItem: jest.fn((key: string) => (store.has(key) ? store.get(key)! : null)),
      setItem: jest.fn((key: string, value: string) => {
        store.set(key, value);
      }),
      removeItem: jest.fn((key: string) => {
        store.delete(key);
      }),
      clear: jest.fn(() => {
        store.clear();
      }),
    },
    configurable: true,
    writable: true,
  });
}

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

/** Build a real, valid-shaped JWT (base64url) with a controllable exp claim. */
function makeJwt(expSecondsFromNow: number): string {
  const b64url = (s: string) =>
    Buffer.from(s, 'utf-8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = b64url(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + expSecondsFromNow }));
  return `${header}.${payload}.fakesignature`;
}

function createPlayer(id: string, isBot = false): Player {
  return {
    id,
    name: id,
    color: '#ff0000',
    money: 50,
    isBot,
    trainState: { position: null, remainingMovement: 0, movementHistory: [], loads: [] },
    hand: [],
  } as unknown as Player;
}

function createGameState(): FullGameState {
  return {
    id: 'game-1',
    players: [createPlayer('p1'), createPlayer('bot-2', true)],
    currentPlayerIndex: 0,
    status: 'active',
    maxPlayers: 4,
  } as unknown as FullGameState;
}

describe('E2E: auth & reconnect resilience user journeys (TEST-002)', () => {
  let coordinator: GameSocketCoordinator;
  let deps: GameSocketCoordinatorDeps;
  let gameStateService: GameStateService;
  let fetchMock: jest.Mock;

  beforeEach(() => {
    // socketService is a module-level singleton shared across every test in
    // this file (unlike `coordinator`, freshly constructed below). Without
    // resetting it, a prior test's `this.socket` reference survives into
    // the next one: ensureConnected() then sees hasSocket()===true and
    // skips connect() (and the setupEventHandlers() call inside it)
    // entirely, so the persistent 'connect'/'connect_error' handlers never
    // get re-registered into this test's freshly-cleared handler maps.
    socketService.disconnect();

    jest.clearAllMocks();
    jest.useFakeTimers();
    socketHandlers.clear();
    managerHandlers.clear();
    mockSocket.connected = false;
    mockSocket.auth = {};

    installFakeLocalStorage();

    mockSocket.on.mockImplementation((event: string, cb: Handler) => {
      recordHandler(socketHandlers, event, cb);
      return mockSocket;
    });
    (mockSocket.io.on as jest.Mock).mockImplementation((event: string, cb: Handler) => {
      recordHandler(managerHandlers, event, cb);
      return mockSocket.io;
    });
    mockSocket.off.mockImplementation((event: string, cb?: Handler) => {
      removeHandler(socketHandlers, event, cb);
      return mockSocket;
    });
    mockSocket.onAny.mockImplementation(() => mockSocket);

    fetchMock = jest.fn(() => Promise.resolve(jsonResponse(404, { error: 'NOT_FOUND' })));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    gameStateService = new GameStateService(createGameState());
    coordinator = new GameSocketCoordinator();
    deps = {
      gameId: 'game-1',
      gameStateService,
      playerStateService: new PlayerStateService(),
      loadService: { loadInitialState: jest.fn().mockResolvedValue(undefined) } as unknown as LoadService,
      getTrackManager: () => undefined,
      getMapGridPoint: () => undefined,
      isBotAnimating: () => false,
      onApplySpriteUpdates: jest.fn(),
      onUIRefresh: jest.fn(),
      onLaunchWinner: jest.fn(),
      onTieExtended: jest.fn(),
      onAutoRunStatus: jest.fn(),
      onBotTurnComplete: jest.fn(),
    };

    useAuthStore.setState({
      user: { id: 'u1', username: 'p1' } as any,
      token: null,
      refreshToken: null,
      isAuthenticated: false,
      isLoading: false,
      error: null,
    });
  });

  afterEach(() => {
    coordinator.stop();
    jest.useRealTimers();
  });

  /** Mock /api/auth/refresh success, storing/returning a fresh long-lived token. */
  function mockRefreshSuccess(newToken: string, newRefreshToken: string): void {
    fetchMock.mockImplementation((url: unknown) => {
      const u = String(url);
      if (u.includes('/api/auth/refresh')) {
        return Promise.resolve(
          jsonResponse(200, {
            success: true,
            data: { token: newToken, refreshToken: newRefreshToken },
            message: 'Token refreshed successfully',
          }),
        );
      }
      if (u.includes('/api/game/')) {
        return Promise.resolve(jsonResponse(200, { currentPlayerIndex: 0 }));
      }
      if (u.includes('/api/players/')) {
        return Promise.resolve(jsonResponse(200, []));
      }
      return Promise.resolve(jsonResponse(404, {}));
    });
  }

  /** Resolve the current start()/ensureConnected() call by firing a 'connect' event. */
  async function completeConnect(): Promise<void> {
    await jest.advanceTimersByTimeAsync(0);
    mockSocket.connected = true;
    emitEvent(socketHandlers, 'connect');
  }

  it('Scenario 1 -- idle tab: an expired token is refreshed, the socket reconnects, and the game resyncs without a manual login', async () => {
    // The player was logged in and connected before the tab went idle.
    localStorage.setItem(JWT_STORAGE_KEY, makeJwt(3600));
    localStorage.setItem(REFRESH_TOKEN_STORAGE_KEY, 'refresh-token-1');
    localStorage.setItem(USER_STORAGE_KEY, JSON.stringify({ id: 'u1' }));
    useAuthStore.setState({ token: makeJwt(3600), refreshToken: 'refresh-token-1', isAuthenticated: true });
    mockRefreshSuccess('refreshed-token', 'refresh-token-2');

    const startPromise = coordinator.start(deps);
    await completeConnect();
    expect(await startPromise).toBe(true);

    // Idle: the access token has since expired, and the tab lost its live
    // connection while backgrounded (Socket.IO's own retry loop paused).
    localStorage.setItem(JWT_STORAGE_KEY, makeJwt(-3600));
    mockSocket.connected = false;

    // The user returns to the tab.
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));

    // handleWake: reads localStorage (expired) -> refreshes -> ensureConnected
    // waits for the (already-existing) socket to reconnect.
    await jest.advanceTimersByTimeAsync(0);
    mockSocket.connected = true;
    emitEvent(socketHandlers, 'connect');
    await jest.advanceTimersByTimeAsync(0);

    // No manual login was required: the store is still authenticated, with a
    // fresh token, and no session-expired toast fired.
    expect(useAuthStore.getState().isAuthenticated).toBe(true);
    expect(localStorage.getItem(JWT_STORAGE_KEY)).toBe('refreshed-token');
    const { toast } = jest.requireMock('sonner');
    expect(toast.error).not.toHaveBeenCalled();

    // The debounced wake resync fires and heals game state via HTTP.
    await jest.advanceTimersByTimeAsync(250);
    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining('/api/game/game-1'), expect.anything());
  });

  it('Scenario 2 -- transient network failure: repeated non-auth connect_errors do not log the user out, and the game recovers once reconnected', async () => {
    const originalToken = makeJwt(3600);
    localStorage.setItem(JWT_STORAGE_KEY, originalToken);
    localStorage.setItem(REFRESH_TOKEN_STORAGE_KEY, 'refresh-token-1');
    useAuthStore.setState({ token: originalToken, refreshToken: 'refresh-token-1', isAuthenticated: true });
    mockRefreshSuccess('should-not-be-used', 'should-not-be-used');

    const startPromise = coordinator.start(deps);
    await completeConnect();
    expect(await startPromise).toBe(true);

    const onConnectError = getLastHandler(socketHandlers, 'connect_error');
    const refreshCallsBefore = fetchMock.mock.calls.filter(([u]) => String(u).includes('/api/auth/refresh')).length;

    // Simulate a flaky network: several transient (non-auth) connect_errors.
    onConnectError(new Error('xhr poll error'));
    onConnectError(new Error('websocket error'));
    onConnectError(new Error('timeout'));
    await jest.advanceTimersByTimeAsync(0);

    // Transient errors never trigger a refresh and never log the user out.
    const refreshCallsAfter = fetchMock.mock.calls.filter(([u]) => String(u).includes('/api/auth/refresh')).length;
    expect(refreshCallsAfter).toBe(refreshCallsBefore);
    expect(useAuthStore.getState().isAuthenticated).toBe(true);
    expect(localStorage.getItem(JWT_STORAGE_KEY)).toBe(originalToken);

    // The network recovers; Socket.IO reconnects on its own.
    mockSocket.connected = true;
    emitEvent(socketHandlers, 'connect');
    await jest.advanceTimersByTimeAsync(0);

    // Reconnection heals game state (the existing onReconnected -> resync path).
    await jest.advanceTimersByTimeAsync(250);
    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining('/api/game/game-1'), expect.anything());
    expect(useAuthStore.getState().isAuthenticated).toBe(true);
  });

  it('Scenario 3 -- definitive session expiry: a rejected refresh logs the user out, shows a session-expired message, and never connects with the stale token', async () => {
    const staleToken = makeJwt(-3600);
    localStorage.setItem(JWT_STORAGE_KEY, staleToken);
    localStorage.setItem(REFRESH_TOKEN_STORAGE_KEY, 'refresh-token-1');
    localStorage.setItem(USER_STORAGE_KEY, JSON.stringify({ id: 'u1' }));
    useAuthStore.setState({ token: staleToken, refreshToken: 'refresh-token-1', isAuthenticated: true });

    fetchMock.mockImplementation((url: unknown) => {
      const u = String(url);
      if (u.includes('/api/auth/refresh')) {
        // Matches the real server contract for any refresh failure
        // (authRoutes.ts POST /api/auth/refresh): 401 INVALID_REFRESH_TOKEN.
        return Promise.resolve(
          jsonResponse(401, {
            error: 'INVALID_REFRESH_TOKEN',
            message: 'Invalid or expired refresh token',
            details: 'Please login again',
          }),
        );
      }
      return Promise.resolve(jsonResponse(404, {}));
    });

    const started = await coordinator.start(deps);

    // A dead session must look dead: no connection is established.
    expect(started).toBe(false);
    const { io } = jest.requireMock('socket.io-client');
    expect(io).not.toHaveBeenCalled();

    // The store reflects a real logout, not a lingering stale session.
    expect(useAuthStore.getState().isAuthenticated).toBe(false);
    expect(useAuthStore.getState().token).toBeNull();
    expect(localStorage.getItem(JWT_STORAGE_KEY)).toBeNull();
    expect(localStorage.getItem(REFRESH_TOKEN_STORAGE_KEY)).toBeNull();

    // The player is told why, via the session-expired toast (sonner --
    // GameToastManager is Phaser-Scene-bound and unreachable from the auth
    // store; see FE-001's design decision).
    const { toast } = jest.requireMock('sonner');
    expect(toast.error).toHaveBeenCalledWith(expect.stringMatching(/session expired/i));

    // A later wake event must not resurrect the dead session with the same
    // stale token.
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
    await jest.advanceTimersByTimeAsync(0);
    expect(io).not.toHaveBeenCalled();
  });

  it('Scenario 4 -- bot turn resumption: after reconnecting, the client applies the turn:change the server pushes once BotTurnTrigger resumes a stuck bot via its DB fallback', async () => {
    // Server-side context (not exercised here -- see file header): the
    // in-memory queuedBotTurns/pendingBotTurns state was lost (e.g. a
    // server restart), so BotTurnTrigger.onHumanReconnect falls back to
    // querying games.status/current_player_index and resolving the current
    // player via the existing index-to-player mapping (covered by
    // src/server/__tests__/ai/BotTurnTrigger.test.ts). That resumed bot
    // turn eventually produces a turn:change (and later a state:patch) the
    // server pushes to reconnected clients -- which is what this test
    // verifies the client correctly applies.
    localStorage.setItem(JWT_STORAGE_KEY, makeJwt(3600));
    localStorage.setItem(REFRESH_TOKEN_STORAGE_KEY, 'refresh-token-1');
    useAuthStore.setState({ token: makeJwt(3600), refreshToken: 'refresh-token-1', isAuthenticated: true });
    mockRefreshSuccess('unused', 'unused');

    const startPromise = coordinator.start(deps);
    await completeConnect();
    expect(await startPromise).toBe(true);

    expect(gameStateService.getGameState().currentPlayerIndex).toBe(0);

    // Reconnect (e.g. after the same idle/network gap that caused the
    // server-side bot-turn recovery): Socket.IO drops and re-establishes
    // the connection.
    mockSocket.connected = false;
    mockSocket.connected = true;
    emitEvent(socketHandlers, 'connect'); // isReconnect=true on the second 'connect'
    await jest.advanceTimersByTimeAsync(0);

    // The server pushes the resumed bot's turn to the client.
    const onTurnChange = getLastHandler(socketHandlers, 'turn:change');
    onTurnChange({ currentPlayerIndex: 1, currentPlayerId: 'bot-2', serverSeq: 5 });

    expect(gameStateService.getGameState().currentPlayerIndex).toBe(1);

    // The reconnect also triggers the existing debounced resync, healing
    // any state the client missed while disconnected.
    await jest.advanceTimersByTimeAsync(250);
    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining('/api/game/game-1'), expect.anything());
  });
});
