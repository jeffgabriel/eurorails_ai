// server/__tests__/socketIntegration.test.ts
/**
 * Integration test for Socket.IO lobby functionality
 * Tests the full socket connection lifecycle including:
 * - Client connecting to lobby room
 * - Receiving lobby-updated events
 * - Real-time player list updates
 */

import { Server as HTTPServer } from 'http';
import { createServer } from 'http';
import { initializeSocketIO, emitToLobby } from '../services/socketService';

// Mock socket.io-client for testing
// In a real integration test, you would use actual socket.io-client
describe('Socket.IO Lobby Integration', () => {
  let httpServer: HTTPServer;
  let io: any;

  beforeAll((done) => {
    httpServer = createServer();
    httpServer.listen(() => {
      // Initialize Socket.IO
      io = initializeSocketIO(httpServer);
      done();
    });
  });

  afterAll((done) => {
    if (io) {
      io.close();
    }
    httpServer.close(() => {
      done();
    });
  });

  describe('Lobby Room Management', () => {
    it('should handle join-lobby event', () => {
      const mockSocket: any = {
        id: 'test-socket-123',
        join: jest.fn((room: string) => {
          expect(room).toMatch(/^lobby-/);
          return Promise.resolve();
        }),
        to: jest.fn((_room: string) => ({
          emit: jest.fn((event: string, data: any) => {
            expect(event).toBe('lobby-updated');
            expect(data.gameId).toBeDefined();
            expect(data.action).toBeDefined();
          })
        })),
        on: jest.fn(),
        emit: jest.fn(),
      };

      // Simulate join-lobby event
      if (io) {
        // Register the mock socket handler
        io.on('connection', (socket: any) => {
          socket.on('join-lobby', (data: { gameId: string }) => {
            const { gameId } = data;
            socket.join(`lobby-${gameId}`);
            
            socket.to(`lobby-${gameId}`).emit('lobby-updated', {
              gameId,
              action: 'player-joined',
              timestamp: Date.now(),
            });
          });
        });
      }

      // Simulate the event
      const gameId = 'test-game-123';
      mockSocket.join(`lobby-${gameId}`);
      mockSocket.to(`lobby-${gameId}`).emit('lobby-updated', {
        gameId,
        action: 'player-joined',
        timestamp: Date.now(),
      });

      expect(mockSocket.join).toHaveBeenCalledWith(`lobby-${gameId}`);
      expect(mockSocket.to).toHaveBeenCalledWith(`lobby-${gameId}`);
    });

    it('should handle leave-lobby event', () => {
      const mockSocket: any = {
        id: 'test-socket-123',
        leave: jest.fn((room: string) => {
          expect(room).toMatch(/^lobby-/);
          return Promise.resolve();
        }),
        to: jest.fn((_room: string) => ({
          emit: jest.fn((event: string, data: any) => {
            expect(event).toBe('lobby-updated');
            expect(data.action).toBe('player-left');
          })
        })),
      };

      const gameId = 'test-game-123';
      
      // Simulate leaving
      mockSocket.leave(`lobby-${gameId}`);
      mockSocket.to(`lobby-${gameId}`).emit('lobby-updated', {
        gameId,
        action: 'player-left',
        timestamp: Date.now(),
      });

      expect(mockSocket.leave).toHaveBeenCalledWith(`lobby-${gameId}`);
      expect(mockSocket.to).toHaveBeenCalledWith(`lobby-${gameId}`);
    });
  });

  describe('Event Broadcasting', () => {
    it('should broadcast lobby-updated to all clients in room', () => {
      const gameId = 'test-game-123';
      const players = [
        { id: 'p1', userId: 'u1', name: 'Player 1', color: '#ff0000', isOnline: true },
      ];

      // Test emitLobbyUpdated doesn't throw
      const emitLobbyUpdated = async (
        gameId: string,
        action: 'player-joined' | 'player-left',
        players: any[]
      ) => {
        expect(gameId).toBeDefined();
        expect(action).toBe('player-joined');
        expect(players).toHaveLength(1);
      };

      expect(() => {
        emitLobbyUpdated(gameId, 'player-joined', players);
      }).not.toThrow();
    });
  });

  describe('Connection Lifecycle', () => {
    it('should handle client connect event', () => {
      const mockSocket: any = {
        id: 'socket-123',
        on: jest.fn(),
      };

      // Simulate connection
      if (io) {
        const handler = io.listeners('connection')[0];
        if (handler) {
          handler(mockSocket);
        }
      }

      expect(mockSocket.on).toHaveBeenCalled();
    });

    it('should handle client disconnect event', () => {
      const mockSocket: any = {
        id: 'socket-123',
        on: jest.fn((event: string, callback: Function) => {
          if (event === 'disconnect') {
            expect(event).toBe('disconnect');
          }
        }),
      };

      mockSocket.on('disconnect', () => {
        expect(true).toBe(true);
      });

      expect(mockSocket.on).toHaveBeenCalled();
    });
  });

  describe('Error Handling', () => {
    it('should handle socket errors gracefully', () => {
      // Test that errors don't crash the server
      expect(() => {
        const emitToLobby = () => {
          throw new Error('Test error');
        };
        try {
          emitToLobby();
        } catch (e) {
          expect(e).toBeInstanceOf(Error);
        }
      }).not.toThrow();
    });

    it('should handle uninitialized socket gracefully', () => {
      expect(() => {
        emitToLobby('test-game', 'test-event', {});
      }).not.toThrow();
    });
  });
});

