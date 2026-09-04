// client/lobby/__tests__/socketService.test.ts
/**
 * Client-side socket service tests
 * Tests the SocketService singleton and lobby methods
 */

import { socketService } from '../shared/socket';

type Handler = (...args: any[]) => void;

const socketHandlers = new Map<string, Handler[]>();
const managerHandlers = new Map<string, Handler[]>();

const recordHandler = (map: Map<string, Handler[]>, event: string, cb: Handler) => {
  const list = map.get(event) ?? [];
  list.push(cb);
  map.set(event, list);
};

const getLastHandler = (map: Map<string, Handler[]>, event: string): Handler => {
  const list = map.get(event) ?? [];
  if (list.length === 0) {
    throw new Error(`No handler registered for event: ${event}`);
  }
  return list[list.length - 1];
};

// Create a shared mock socket for verification
const mockSocket = {
  connected: false,
  // Mirrors socket.io-client's `Socket#active`: true while Socket.IO will
  // still retry on its own, false once a middleware-denied handshake has
  // destroyed the namespace socket.
  active: true,
  id: 'mock-socket-id',
  disconnect: jest.fn(),
  connect: jest.fn(),
  auth: {},
  on: jest.fn(),
  emit: jest.fn(),
  off: jest.fn(),
  removeAllListeners: jest.fn(),
  io: {
    on: jest.fn(),
  },
};

// Mock socket.io-client
jest.mock('socket.io-client', () => {
  const mockIo = jest.fn(() => mockSocket);
  return {
    io: mockIo,
  };
});

// Mock the shared auth store -- socket.ts reaches it via a dynamic import
// (`await import('../store/auth.store')`) to avoid a static circular import,
// mirroring the same pattern shared/api.ts already uses.
jest.mock('../store/auth.store', () => ({
  useAuthStore: {
    getState: jest.fn(),
  },
}));

// Mock isAccessTokenExpired directly rather than constructing real JWTs --
// tokenUtils has its own dedicated unit tests; here we only need to control
// whether socket.ts believes the token is expired.
jest.mock('../shared/tokenUtils', () => ({
  isAccessTokenExpired: jest.fn(),
}));

import { useAuthStore } from '../store/auth.store';
import { isAccessTokenExpired } from '../shared/tokenUtils';

const mockGetState = useAuthStore.getState as jest.Mock;
const mockIsAccessTokenExpired = isAccessTokenExpired as jest.Mock;

const JWT_STORAGE_KEY = 'eurorails.jwt';
const REFRESH_TOKEN_STORAGE_KEY = 'eurorails.refreshToken';

// The global test setup (src/client/__tests__/setupTests.js) stubs
// window.localStorage with bare jest.fn()s that don't actually store
// anything. Install a real in-memory implementation so these tests can
// control what's "persisted" and assert on it.
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

/** Flush pending microtasks (dynamic import + async mock resolution). */
function flushAsync(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe('SocketService', () => {
  beforeEach(() => {
    socketService.disconnect();

    // Reset mocks/handlers before each test
    jest.clearAllMocks();
    socketHandlers.clear();
    managerHandlers.clear();
    mockSocket.connected = false;
    mockSocket.active = true;
    mockSocket.auth = {};
    installFakeLocalStorage();
    mockIsAccessTokenExpired.mockReturnValue(false);
    mockGetState.mockReturnValue({ refreshAccessToken: jest.fn().mockResolvedValue(true) });

    mockSocket.on.mockImplementation((event: string, cb: Handler) => {
      recordHandler(socketHandlers, event, cb);
      return mockSocket;
    });
    (mockSocket.io.on as jest.Mock).mockImplementation((event: string, cb: Handler) => {
      recordHandler(managerHandlers, event, cb);
      return mockSocket.io;
    });
    mockSocket.off.mockImplementation(() => mockSocket);
  });

  describe('connection lifecycle', () => {
    it('should connect with token', () => {
      const token = 'test-token';
      
      expect(() => {
        socketService.connect(token);
      }).not.toThrow();
    });

    it('should not give up and disconnect after repeated connect_error', () => {
      socketService.connect('test-token');

      const onConnectError = getLastHandler(socketHandlers, 'connect_error');
      for (let i = 0; i < 10; i++) {
        onConnectError(new Error('server down'));
      }

      expect(socketService.hasSocket()).toBe(true);
      expect(mockSocket.disconnect).not.toHaveBeenCalled();
    });

    it('should disconnect when already connected', () => {
      const token = 'test-token';
      socketService.connect(token);
      
      // Should not throw when disconnecting
      expect(() => {
        socketService.disconnect();
      }).not.toThrow();
    });

    it('should report connection status', () => {
      expect(socketService.isConnected()).toBe(false);
      
      socketService.connect('test-token');
      // Manually set connected state for this test to verify isConnected behavior
      mockSocket.connected = true;
      expect(socketService.isConnected()).toBe(true);
    });

    it('should re-join tracked rooms on reconnect and fire onReconnected callbacks', () => {
      const gameId = 'test-game-123';

      socketService.connect('test-token');
      const onReconnected = jest.fn();
      socketService.onReconnected(onReconnected);

      socketService.join(gameId);
      socketService.joinLobby(gameId);

      expect(mockSocket.emit).toHaveBeenCalledWith('join', { gameId });
      expect(mockSocket.emit).toHaveBeenCalledWith('join-lobby', { gameId });

      // First connect: not a reconnect, so should not re-emit joins
      getLastHandler(socketHandlers, 'connect')();
      const emitCallsAfterFirstConnect = mockSocket.emit.mock.calls.length;
      expect(onReconnected).not.toHaveBeenCalled();

      // Second connect: treated as reconnect -> should re-emit joins and fire callback
      getLastHandler(socketHandlers, 'connect')();
      expect(mockSocket.emit.mock.calls.length).toBe(emitCallsAfterFirstConnect + 2);
      expect(onReconnected).toHaveBeenCalledTimes(1);
    });
  });

  describe('ensureConnected', () => {
    it('returns true immediately when already connected, without reconnecting', async () => {
      socketService.connect('test-token');
      mockSocket.connected = true;
      jest.clearAllMocks();

      const result = await socketService.ensureConnected('test-token');

      expect(result).toBe(true);
      const { io } = jest.requireMock('socket.io-client');
      expect(io).not.toHaveBeenCalled();
    });

    it('connects with token and waits for connection when no socket exists', async () => {
      const token = 'fresh-token';

      const pending = socketService.ensureConnected(token);

      const { io } = jest.requireMock('socket.io-client');
      expect(io).toHaveBeenCalledTimes(1);

      // Simulate the socket establishing a connection.
      mockSocket.connected = true;
      getLastHandler(socketHandlers, 'connect')();

      expect(await pending).toBe(true);
    });

    it('returns false when no socket exists and no token is provided', async () => {
      const result = await socketService.ensureConnected('');

      expect(result).toBe(false);
      const { io } = jest.requireMock('socket.io-client');
      expect(io).not.toHaveBeenCalled();
    });

    it('propagates a false result from waitForConnection on timeout', async () => {
      jest.useFakeTimers();
      try {
        const pending = socketService.ensureConnected('test-token');
        jest.advanceTimersByTime(2500);
        expect(await pending).toBe(false);
      } finally {
        jest.useRealTimers();
      }
    });

    it('does not check expiry or refresh when no refresh token is stored (e.g. dev-auth)', async () => {
      // No refresh token set in localStorage.
      const pending = socketService.ensureConnected('dev-token');
      await flushAsync();

      const { io } = jest.requireMock('socket.io-client');
      expect(io).toHaveBeenCalledTimes(1);
      expect(mockIsAccessTokenExpired).not.toHaveBeenCalled();
      expect(mockGetState).not.toHaveBeenCalled();

      mockSocket.connected = true;
      getLastHandler(socketHandlers, 'connect')();
      expect(await pending).toBe(true);
    });

    it('proactively refreshes an expired token before connecting when a refresh token exists', async () => {
      localStorage.setItem(REFRESH_TOKEN_STORAGE_KEY, 'refresh-1');
      mockIsAccessTokenExpired.mockReturnValue(true);
      const refreshAccessToken = jest.fn().mockImplementation(async () => {
        localStorage.setItem(JWT_STORAGE_KEY, 'refreshed-access-token');
        return true;
      });
      mockGetState.mockReturnValue({ refreshAccessToken });

      const pending = socketService.ensureConnected('stale-token');
      await flushAsync();

      expect(refreshAccessToken).toHaveBeenCalledTimes(1);
      const { io } = jest.requireMock('socket.io-client');
      expect(io).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ auth: { token: 'refreshed-access-token' } }),
      );

      mockSocket.connected = true;
      getLastHandler(socketHandlers, 'connect')();
      expect(await pending).toBe(true);
    });

    it('returns false and does not attempt to connect when the proactive refresh fails', async () => {
      localStorage.setItem(REFRESH_TOKEN_STORAGE_KEY, 'refresh-1');
      mockIsAccessTokenExpired.mockReturnValue(true);
      const refreshAccessToken = jest.fn().mockResolvedValue(false);
      mockGetState.mockReturnValue({ refreshAccessToken });

      const result = await socketService.ensureConnected('stale-token');

      expect(result).toBe(false);
      expect(refreshAccessToken).toHaveBeenCalledTimes(1);
      const { io } = jest.requireMock('socket.io-client');
      expect(io).not.toHaveBeenCalled();
    });

    it('re-opens an existing socket that Socket.IO has abandoned instead of only waiting', async () => {
      socketService.connect('old-token');
      jest.clearAllMocks();
      mockSocket.connected = false;
      mockSocket.active = false;
      localStorage.setItem(JWT_STORAGE_KEY, 'current-token');

      const pending = socketService.ensureConnected('current-token');
      await flushAsync();

      const { io } = jest.requireMock('socket.io-client');
      expect(io).not.toHaveBeenCalled();
      expect(mockSocket.auth).toEqual({ token: 'current-token' });
      expect(mockSocket.connect).toHaveBeenCalledTimes(1);

      mockSocket.connected = true;
      getLastHandler(socketHandlers, 'connect')();
      expect(await pending).toBe(true);
    });

    it('refreshes a stale token before re-opening an abandoned socket', async () => {
      socketService.connect('old-token');
      jest.clearAllMocks();
      mockSocket.connected = false;
      mockSocket.active = false;
      localStorage.setItem(JWT_STORAGE_KEY, 'stale-token');
      localStorage.setItem(REFRESH_TOKEN_STORAGE_KEY, 'refresh-1');
      mockIsAccessTokenExpired.mockReturnValue(true);
      const refreshAccessToken = jest.fn().mockImplementation(async () => {
        localStorage.setItem(JWT_STORAGE_KEY, 'refreshed-on-wake');
        return true;
      });
      mockGetState.mockReturnValue({ refreshAccessToken });

      const pending = socketService.ensureConnected('stale-token');
      await flushAsync();

      expect(refreshAccessToken).toHaveBeenCalledTimes(1);
      expect(mockSocket.auth).toEqual({ token: 'refreshed-on-wake' });
      expect(mockSocket.connect).toHaveBeenCalledTimes(1);

      mockSocket.connected = true;
      getLastHandler(socketHandlers, 'connect')();
      expect(await pending).toBe(true);
    });

    it('still just waits when an existing socket is disconnected but Socket.IO is retrying on its own', async () => {
      jest.useFakeTimers();
      try {
        socketService.connect('old-token');
        jest.clearAllMocks();
        mockSocket.connected = false;
        mockSocket.active = true;

        const pending = socketService.ensureConnected('old-token');
        jest.advanceTimersByTime(2500);

        expect(await pending).toBe(false);
        expect(mockSocket.connect).not.toHaveBeenCalled();
      } finally {
        jest.useRealTimers();
      }
    });
  });

  describe('connect_error auth-failure handling', () => {
    it('triggers the shared refresh exactly once per disconnect cycle on an auth-rejected connect_error', async () => {
      const refreshAccessToken = jest.fn().mockResolvedValue(true);
      mockGetState.mockReturnValue({ refreshAccessToken });

      socketService.connect('stale-token');
      const onConnectError = getLastHandler(socketHandlers, 'connect_error');

      onConnectError(new Error('UNAUTHORIZED'));
      onConnectError(new Error('UNAUTHORIZED'));
      onConnectError(new Error('UNAUTHORIZED'));
      await flushAsync();

      expect(refreshAccessToken).toHaveBeenCalledTimes(1);
    });

    it('does not trigger a refresh for a non-auth connect_error', async () => {
      const refreshAccessToken = jest.fn().mockResolvedValue(true);
      mockGetState.mockReturnValue({ refreshAccessToken });

      socketService.connect('stale-token');
      const onConnectError = getLastHandler(socketHandlers, 'connect_error');

      onConnectError(new Error('server down'));
      await flushAsync();

      expect(refreshAccessToken).not.toHaveBeenCalled();
    });

    it('allows a new refresh in a new disconnect cycle after a successful connect', async () => {
      const refreshAccessToken = jest.fn().mockResolvedValue(true);
      mockGetState.mockReturnValue({ refreshAccessToken });

      socketService.connect('stale-token');
      const onConnectError = getLastHandler(socketHandlers, 'connect_error');

      onConnectError(new Error('UNAUTHORIZED'));
      await flushAsync();
      expect(refreshAccessToken).toHaveBeenCalledTimes(1);

      // Connection recovers -- this ends the disconnect cycle and resets the guard.
      getLastHandler(socketHandlers, 'connect')();

      onConnectError(new Error('UNAUTHORIZED'));
      await flushAsync();
      expect(refreshAccessToken).toHaveBeenCalledTimes(2);
    });

    it('reconnect_attempt picks up the newly refreshed token from localStorage', async () => {
      const refreshAccessToken = jest.fn().mockImplementation(async () => {
        localStorage.setItem(JWT_STORAGE_KEY, 'refreshed-after-connect-error');
        return true;
      });
      mockGetState.mockReturnValue({ refreshAccessToken });

      socketService.connect('stale-token');
      const onConnectError = getLastHandler(socketHandlers, 'connect_error');
      onConnectError(new Error('UNAUTHORIZED'));
      await flushAsync();

      expect(refreshAccessToken).toHaveBeenCalledTimes(1);

      const onReconnectAttempt = getLastHandler(managerHandlers, 'reconnect_attempt');
      onReconnectAttempt();

      expect(mockSocket.auth).toEqual({ token: 'refreshed-after-connect-error' });
    });

    // A middleware-denied handshake destroys the namespace socket and stops
    // Socket.IO's own retry loop, so the service must re-open it explicitly.
    it('re-opens the socket with the refreshed token after a successful refresh', async () => {
      const refreshAccessToken = jest.fn().mockImplementation(async () => {
        localStorage.setItem(JWT_STORAGE_KEY, 'refreshed-after-denial');
        return true;
      });
      mockGetState.mockReturnValue({ refreshAccessToken });

      socketService.connect('stale-token');
      mockSocket.active = false;
      const onConnectError = getLastHandler(socketHandlers, 'connect_error');
      onConnectError(new Error('UNAUTHORIZED'));
      await flushAsync();

      expect(refreshAccessToken).toHaveBeenCalledTimes(1);
      expect(mockSocket.auth).toEqual({ token: 'refreshed-after-denial' });
      expect(mockSocket.connect).toHaveBeenCalledTimes(1);
    });

    it('does not re-open the socket when the refresh was definitively rejected (tokens cleared)', async () => {
      jest.useFakeTimers();
      try {
        localStorage.setItem(REFRESH_TOKEN_STORAGE_KEY, 'refresh-1');
        const refreshAccessToken = jest.fn().mockImplementation(async () => {
          // auth.store logs out on a definitive rejection, wiping both tokens.
          localStorage.removeItem(JWT_STORAGE_KEY);
          localStorage.removeItem(REFRESH_TOKEN_STORAGE_KEY);
          return false;
        });
        mockGetState.mockReturnValue({ refreshAccessToken });

        socketService.connect('stale-token');
        mockSocket.active = false;
        getLastHandler(socketHandlers, 'connect_error')(new Error('UNAUTHORIZED'));
        await jest.advanceTimersByTimeAsync(0);

        expect(refreshAccessToken).toHaveBeenCalledTimes(1);
        expect(mockSocket.connect).not.toHaveBeenCalled();

        await jest.advanceTimersByTimeAsync(60_000);
        expect(mockSocket.connect).not.toHaveBeenCalled();
        expect(refreshAccessToken).toHaveBeenCalledTimes(1);
      } finally {
        jest.useRealTimers();
      }
    });

    it('retries the handshake after a backoff when the refresh failed transiently, then refreshes again on the next denial', async () => {
      jest.useFakeTimers();
      try {
        localStorage.setItem(JWT_STORAGE_KEY, 'stale-token');
        localStorage.setItem(REFRESH_TOKEN_STORAGE_KEY, 'refresh-1');
        const refreshAccessToken = jest
          .fn()
          .mockResolvedValueOnce(false) // transient: tokens retained
          .mockImplementationOnce(async () => {
            localStorage.setItem(JWT_STORAGE_KEY, 'refreshed-on-retry');
            return true;
          });
        mockGetState.mockReturnValue({ refreshAccessToken });

        socketService.connect('stale-token');
        mockSocket.active = false;
        const onConnectError = getLastHandler(socketHandlers, 'connect_error');

        onConnectError(new Error('UNAUTHORIZED'));
        await jest.advanceTimersByTimeAsync(0);
        expect(refreshAccessToken).toHaveBeenCalledTimes(1);
        expect(mockSocket.connect).not.toHaveBeenCalled();

        // Backoff elapses (2000ms * 2^1 after one failed attempt) -> explicit retry.
        await jest.advanceTimersByTimeAsync(4_000);
        expect(mockSocket.connect).toHaveBeenCalledTimes(1);

        // The retried (still stale) handshake is denied again; the guard was
        // re-armed so this denial triggers a second refresh, which now
        // succeeds and re-opens the socket with the new token.
        onConnectError(new Error('UNAUTHORIZED'));
        await jest.advanceTimersByTimeAsync(0);
        expect(refreshAccessToken).toHaveBeenCalledTimes(2);
        expect(mockSocket.auth).toEqual({ token: 'refreshed-on-retry' });
        expect(mockSocket.connect).toHaveBeenCalledTimes(2);
      } finally {
        jest.useRealTimers();
      }
    });

    it('cancels a pending auth retry when the connection recovers or the service is torn down', async () => {
      jest.useFakeTimers();
      try {
        localStorage.setItem(REFRESH_TOKEN_STORAGE_KEY, 'refresh-1');
        mockGetState.mockReturnValue({ refreshAccessToken: jest.fn().mockResolvedValue(false) });

        socketService.connect('stale-token');
        getLastHandler(socketHandlers, 'connect_error')(new Error('UNAUTHORIZED'));
        await jest.advanceTimersByTimeAsync(0);
        expect(jest.getTimerCount()).toBe(1);

        getLastHandler(socketHandlers, 'connect')();
        expect(jest.getTimerCount()).toBe(0);

        getLastHandler(socketHandlers, 'connect_error')(new Error('UNAUTHORIZED'));
        await jest.advanceTimersByTimeAsync(0);
        expect(jest.getTimerCount()).toBe(1);

        socketService.disconnect();
        expect(jest.getTimerCount()).toBe(0);
      } finally {
        jest.useRealTimers();
      }
    });
  });

  describe('lobby methods', () => {
    it('should join lobby room', () => {
      const token = 'test-token';
      const gameId = 'test-game-123';
      
      socketService.connect(token);
      
      expect(() => {
        socketService.joinLobby(gameId);
      }).not.toThrow();
    });

    it('should emit join-lobby event with correct gameId', () => {
      const token = 'test-token';
      const gameId = 'test-game-123';
      
      socketService.connect(token);
      socketService.joinLobby(gameId);
      
      expect(mockSocket.emit).toHaveBeenCalledWith('join-lobby', { gameId });
    });

    it('should leave lobby room', () => {
      const token = 'test-token';
      const gameId = 'test-game-123';
      
      socketService.connect(token);
      
      expect(() => {
        socketService.leaveLobby(gameId);
      }).not.toThrow();
    });

    it('should emit leave-lobby event with correct gameId', () => {
      const token = 'test-token';
      const gameId = 'test-game-123';
      
      socketService.connect(token);
      socketService.leaveLobby(gameId);
      
      expect(mockSocket.emit).toHaveBeenCalledWith('leave-lobby', { gameId });
    });

    it('should throw error when not connected', () => {
      const gameId = 'test-game-123';
      
      expect(() => {
        socketService.joinLobby(gameId);
      }).toThrow('Socket not connected');
      
      expect(() => {
        socketService.leaveLobby(gameId);
      }).toThrow('Socket not connected');
    });

    it('should register lobby update listener', () => {
      const token = 'test-token';
      socketService.connect(token);
      
      const mockCallback = jest.fn();
      
      expect(() => {
        socketService.onLobbyUpdate(mockCallback);
      }).not.toThrow();
    });

    it('should register lobby-updated event listener with off before on', () => {
      const token = 'test-token';
      socketService.connect(token);
      
      const mockCallback = jest.fn();
      socketService.onLobbyUpdate(mockCallback);
      
      // Verify off was called to remove old listener, then on was called
      expect(mockSocket.off).toHaveBeenCalledWith('lobby-updated');
      expect(mockSocket.on).toHaveBeenCalledWith('lobby-updated', mockCallback);
    });

    it('should register game started listener', () => {
      const token = 'test-token';
      socketService.connect(token);
      
      const mockCallback = jest.fn();
      
      expect(() => {
        socketService.onGameStarted(mockCallback);
      }).not.toThrow();
    });

    it('should register game-started event listener with off before on', () => {
      const token = 'test-token';
      socketService.connect(token);
      
      const mockCallback = jest.fn();
      socketService.onGameStarted(mockCallback);
      
      // Verify off was called to remove old listener, then on was called
      expect(mockSocket.off).toHaveBeenCalledWith('game-started');
      expect(mockSocket.on).toHaveBeenCalledWith('game-started', mockCallback);
    });
  });

  describe('game methods', () => {
    it('should join game room', () => {
      const token = 'test-token';
      const gameId = 'test-game-123';
      
      socketService.connect(token);
      
      expect(() => {
        socketService.join(gameId);
      }).not.toThrow();
    });

    it('should emit join event with correct gameId', () => {
      const token = 'test-token';
      const gameId = 'test-game-123';
      
      socketService.connect(token);
      socketService.join(gameId);
      
      expect(mockSocket.emit).toHaveBeenCalledWith('join', { gameId });
    });

    it('should emit action event with correct parameters', () => {
      const token = 'test-token';
      const gameId = 'test-game-123';
      const actionType = 'move';
      const payload = { x: 1, y: 2 };
      const clientSeq = 5;
      
      socketService.connect(token);
      socketService.sendAction(gameId, actionType, payload, clientSeq);
      
      expect(mockSocket.emit).toHaveBeenCalledWith('action', {
        gameId,
        type: actionType,
        payload,
        clientSeq,
      });
    });

    it('should throw error when sending action without connection', () => {
      expect(() => {
        socketService.sendAction('test-game', 'action', {}, 0);
      }).toThrow('Socket not connected');
    });
  });

  describe('event listeners', () => {
    it('should register init listener', () => {
      const token = 'test-token';
      socketService.connect(token);
      
      const mockCallback = jest.fn();
      
      expect(() => {
        socketService.onInit(mockCallback);
      }).not.toThrow();
    });

    it('should register patch listener', () => {
      const token = 'test-token';
      socketService.connect(token);
      
      const mockCallback = jest.fn();
      
      expect(() => {
        socketService.onPatch(mockCallback);
      }).not.toThrow();
    });

    it('should trigger onSeqGap when a patch sequence gap is detected', () => {
      socketService.connect('test-token');

      const onSeqGap = jest.fn();
      socketService.onSeqGap(onSeqGap);

      const patchCallback = jest.fn();
      socketService.onPatch(patchCallback);

      const onPatch = getLastHandler(socketHandlers, 'state:patch');
      onPatch({ patch: { players: [] }, serverSeq: 2 });

      expect(onSeqGap).toHaveBeenCalledWith({ expected: 1, received: 2 });
      expect(patchCallback).toHaveBeenCalledWith({ patch: { players: [] }, serverSeq: 2 });
    });

    it('should register presence update listener', () => {
      const token = 'test-token';
      socketService.connect(token);
      
      const mockCallback = jest.fn();
      
      expect(() => {
        socketService.onPresenceUpdate(mockCallback);
      }).not.toThrow();
    });

    it('should register turn change listener', () => {
      const token = 'test-token';
      socketService.connect(token);
      
      const mockCallback = jest.fn();
      
      expect(() => {
        socketService.onTurnChange(mockCallback);
      }).not.toThrow();
    });

    it('should register error listener', () => {
      const token = 'test-token';
      socketService.connect(token);
      
      const mockCallback = jest.fn();
      
      expect(() => {
        socketService.onError(mockCallback);
      }).not.toThrow();
    });
  });

  describe('cleanup', () => {
    it('should remove all listeners', () => {
      const token = 'test-token';
      socketService.connect(token);
      
      expect(() => {
        socketService.removeAllListeners();
      }).not.toThrow();
    });
  });
});


