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

describe('SocketService', () => {
  beforeEach(() => {
    socketService.disconnect();

    // Reset mocks/handlers before each test
    jest.clearAllMocks();
    socketHandlers.clear();
    managerHandlers.clear();
    mockSocket.connected = false;

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


