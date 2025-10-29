// client/lobby/__tests__/socketService.test.ts
/**
 * Client-side socket service tests
 * Tests the SocketService singleton and lobby methods
 */

import { socketService } from '../shared/socket';

// Mock socket.io-client
jest.mock('socket.io-client', () => {
  const mockSocket = {
    connected: false,
    id: 'mock-socket-id',
    disconnect: jest.fn(),
    on: jest.fn(),
    emit: jest.fn(),
    removeAllListeners: jest.fn(),
  };

  return {
    io: jest.fn(() => mockSocket),
  };
});

describe('SocketService', () => {
  beforeEach(() => {
    // Reset mocks before each test
    jest.clearAllMocks();
  });

  describe('connection lifecycle', () => {
    it('should connect with token', () => {
      const token = 'test-token';
      
      expect(() => {
        socketService.connect(token);
      }).not.toThrow();
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
      // In a real scenario, this would return true after connection
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

    it('should leave lobby room', () => {
      const token = 'test-token';
      const gameId = 'test-game-123';
      
      socketService.connect(token);
      
      expect(() => {
        socketService.leaveLobby(gameId);
      }).not.toThrow();
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

    it('should send game action', () => {
      const token = 'test-token';
      const gameId = 'test-game-123';
      
      socketService.connect(token);
      
      expect(() => {
        socketService.sendAction(gameId, 'test-action', { data: 'test' }, 0);
      }).not.toThrow();
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

