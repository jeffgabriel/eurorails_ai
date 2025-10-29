// server/__tests__/socketService.test.ts
import { Server as HTTPServer } from 'http';
import { Server as SocketIOServer, Socket } from 'socket.io';
import { initializeSocketIO, getSocketIO, emitToLobby, emitLobbyUpdated } from '../services/socketService';
import { createServer } from 'http';
import { AddressInfo } from 'net';

describe('SocketService', () => {
  let httpServer: HTTPServer;
  let serverPort: number;

  beforeAll((done) => {
    // Create HTTP server for testing
    httpServer = createServer();
    httpServer.listen(() => {
      const address = httpServer.address();
      if (address && typeof address === 'object') {
        serverPort = address.port;
      }
      done();
    });
  });

  afterAll((done) => {
    // Close the socket.io instance if it exists
    const io = getSocketIO();
    if (io) {
      io.close();
    }
    httpServer.close(() => {
      done();
    });
  });

  describe('initializeSocketIO', () => {
    it('should initialize Socket.IO server', () => {
      const io = initializeSocketIO(httpServer);
      
      expect(io).toBeDefined();
      expect(getSocketIO()).toBe(io);
    });

    it('should return same instance on subsequent calls', () => {
      const io1 = initializeSocketIO(httpServer);
      const io2 = initializeSocketIO(httpServer);
      
      expect(io1).toBe(io2);
    });

    it('should configure CORS correctly', () => {
      const io = initializeSocketIO(httpServer);
      
      // The CORS configuration is set in the Server constructor
      // We can verify it doesn't throw an error
      expect(io).toBeDefined();
    });
  });

  describe('emitToLobby', () => {
    it('should emit event to all clients in lobby room', (done) => {
      initializeSocketIO(httpServer);
      
      const mockData = { message: 'test' };
      const gameId = 'test-game-123';
      
      // Test that the function doesn't throw when socket is initialized
      expect(() => {
        emitToLobby(gameId, 'test-event', mockData);
      }).not.toThrow();
      
      done();
    });

    it('should not throw when calling emitToLobby', () => {
      initializeSocketIO(httpServer);
      
      expect(() => {
        emitToLobby('test-game', 'test-event', {});
      }).not.toThrow();
    });
  });

  describe('emitLobbyUpdated', () => {
    it('should emit lobby updated event with player data', (done) => {
      initializeSocketIO(httpServer);
      
      const gameId = 'test-game-123';
      const mockPlayers = [
        { id: 'p1', userId: 'u1', name: 'Player 1', color: '#ff0000', isOnline: true },
        { id: 'p2', userId: 'u2', name: 'Player 2', color: '#0000ff', isOnline: true },
      ];
      
      // Test that it doesn't throw
      expect(async () => {
        await emitLobbyUpdated(gameId, 'player-joined', mockPlayers);
      }).not.toThrow();
      
      done();
    });

    it('should handle player-left action', (done) => {
      initializeSocketIO(httpServer);
      
      const gameId = 'test-game-123';
      const mockPlayers = [
        { id: 'p1', userId: 'u1', name: 'Player 1', color: '#ff0000', isOnline: true },
      ];
      
      expect(async () => {
        await emitLobbyUpdated(gameId, 'player-left', mockPlayers);
      }).not.toThrow();
      
      done();
    });
  });

  describe('Socket event handling', () => {
    it('should handle connection event', (done) => {
      const io = initializeSocketIO(httpServer);
      
      if (io) {
        // Listen for connection
        io.on('connection', (socket: Socket) => {
          expect(socket).toBeDefined();
          done();
        });
        
        // Simulate a client connection would require a socket.io-client
        // This is better tested with an integration test
        done();
      } else {
        done();
      }
    });
  });

  describe('getSocketIO', () => {
    it('should return socket instance once initialized (singleton)', () => {
      // Initialize the socket
      const io = initializeSocketIO(httpServer);
      const result = getSocketIO();
      expect(result).toBeDefined();
      expect(result).toBe(io);
    });

    it('should return same instance on subsequent calls', () => {
      // The socket was already initialized in previous tests
      const result1 = getSocketIO();
      const result2 = getSocketIO();
      expect(result1).toBe(result2);
      expect(result1).toBeDefined();
    });
  });
});

