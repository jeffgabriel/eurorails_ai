/**
 * Integration Tests for POST /api/players/borrow (Mercy Borrowing)
 * Tests for the borrow money endpoint including authentication, authorization,
 * input validation, and socket.io broadcasts.
 */

import request from 'supertest';
import express from 'express';
import playerRoutes from '../routes/playerRoutes';
import { PlayerService } from '../services/playerService';
import { AuthService } from '../services/authService';
import * as socketService from '../services/socketService';
import { v4 as uuidv4 } from 'uuid';

// Mock the services
jest.mock('../services/playerService');
jest.mock('../services/authService');
jest.mock('../services/socketService');

const mockPlayerService = PlayerService as jest.Mocked<typeof PlayerService>;
const mockAuthService = AuthService as jest.Mocked<typeof AuthService>;
const mockSocketService = socketService as jest.Mocked<typeof socketService>;

const app = express();
app.use(express.json());
app.use('/api/players', playerRoutes);

describe('POST /api/players/borrow - Mercy Borrowing', () => {
  const testUserId = uuidv4();
  const testGameId = uuidv4();
  const testPlayerId = uuidv4();

  const mockUser = {
    id: testUserId,
    username: 'testuser',
    email: 'test@example.com',
    emailVerified: true,
    createdAt: new Date(),
    lastActive: new Date(),
    updatedAt: new Date()
  };

  const mockTokenPayload = {
    userId: testUserId,
    username: 'testuser',
    email: 'test@example.com',
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + (15 * 60)
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('Authentication (401 UNAUTHORIZED)', () => {
    it('should return 401 when no Authorization header is provided', async () => {
      const response = await request(app)
        .post('/api/players/borrow')
        .send({
          gameId: testGameId,
          amount: 10
        })
        .expect(401);

      expect(response.body.error).toBe('UNAUTHORIZED');
      expect(response.body.message).toBe('Access token required');
    });

    it('should return 401 when Authorization header has invalid format', async () => {
      const response = await request(app)
        .post('/api/players/borrow')
        .set('Authorization', 'InvalidFormat')
        .send({
          gameId: testGameId,
          amount: 10
        })
        .expect(401);

      expect(response.body.error).toBe('UNAUTHORIZED');
    });

    it('should return 401 when token is invalid or expired', async () => {
      mockAuthService.verifyToken.mockReturnValue(null);

      const response = await request(app)
        .post('/api/players/borrow')
        .set('Authorization', 'Bearer invalid.token.here')
        .send({
          gameId: testGameId,
          amount: 10
        })
        .expect(401);

      expect(response.body.error).toBe('UNAUTHORIZED');
      expect(response.body.message).toBe('Invalid or expired token');
    });

    it('should return 401 when user no longer exists', async () => {
      mockAuthService.verifyToken.mockReturnValue(mockTokenPayload);
      mockAuthService.findUserById.mockResolvedValue(null);

      const response = await request(app)
        .post('/api/players/borrow')
        .set('Authorization', 'Bearer valid.token.here')
        .send({
          gameId: testGameId,
          amount: 10
        })
        .expect(401);

      expect(response.body.error).toBe('UNAUTHORIZED');
      expect(response.body.message).toBe('User not found');
    });
  });

  describe('Input Validation (400 BAD REQUEST)', () => {
    beforeEach(() => {
      // Set up valid authentication for validation tests
      mockAuthService.verifyToken.mockReturnValue(mockTokenPayload);
      mockAuthService.findUserById.mockResolvedValue(mockUser);
    });

    it('should return 400 when gameId is missing', async () => {
      const response = await request(app)
        .post('/api/players/borrow')
        .set('Authorization', 'Bearer valid.token.here')
        .send({
          amount: 10
        })
        .expect(400);

      expect(response.body.error).toBe('Validation error');
    });

    it('should return 400 when amount is missing', async () => {
      const response = await request(app)
        .post('/api/players/borrow')
        .set('Authorization', 'Bearer valid.token.here')
        .send({
          gameId: testGameId
        })
        .expect(400);

      expect(response.body.error).toBe('Validation error');
    });

    it('should return 400 when amount is 0', async () => {
      mockPlayerService.borrowForUser.mockRejectedValue(new Error('Amount must be between 1 and 20'));

      const response = await request(app)
        .post('/api/players/borrow')
        .set('Authorization', 'Bearer valid.token.here')
        .send({
          gameId: testGameId,
          amount: 0
        })
        .expect(400);

      expect(response.body.error).toBe('Validation error');
      expect(response.body.details).toContain('1 and 20');
    });

    it('should return 400 when amount exceeds 20', async () => {
      mockPlayerService.borrowForUser.mockRejectedValue(new Error('Amount must be between 1 and 20'));

      const response = await request(app)
        .post('/api/players/borrow')
        .set('Authorization', 'Bearer valid.token.here')
        .send({
          gameId: testGameId,
          amount: 21
        })
        .expect(400);

      expect(response.body.error).toBe('Validation error');
      expect(response.body.details).toContain('1 and 20');
    });

    it('should return 400 when amount is negative', async () => {
      mockPlayerService.borrowForUser.mockRejectedValue(new Error('Amount must be between 1 and 20'));

      const response = await request(app)
        .post('/api/players/borrow')
        .set('Authorization', 'Bearer valid.token.here')
        .send({
          gameId: testGameId,
          amount: -5
        })
        .expect(400);

      expect(response.body.error).toBe('Validation error');
    });

    it('should return 400 when amount is not an integer', async () => {
      mockPlayerService.borrowForUser.mockRejectedValue(new Error('Amount must be an integer'));

      const response = await request(app)
        .post('/api/players/borrow')
        .set('Authorization', 'Bearer valid.token.here')
        .send({
          gameId: testGameId,
          amount: 5.5
        })
        .expect(400);

      expect(response.body.error).toBe('Validation error');
      expect(response.body.details).toContain('integer');
    });

    it('should return 400 when amount is NaN', async () => {
      const response = await request(app)
        .post('/api/players/borrow')
        .set('Authorization', 'Bearer valid.token.here')
        .send({
          gameId: testGameId,
          amount: 'not-a-number'
        })
        .expect(400);

      expect(response.body.error).toBe('Validation error');
    });
  });

  describe('Authorization (403 FORBIDDEN)', () => {
    beforeEach(() => {
      mockAuthService.verifyToken.mockReturnValue(mockTokenPayload);
      mockAuthService.findUserById.mockResolvedValue(mockUser);
    });

    it('should return 403 when it is not the player\'s turn', async () => {
      mockPlayerService.borrowForUser.mockRejectedValue(new Error('Not your turn'));

      const response = await request(app)
        .post('/api/players/borrow')
        .set('Authorization', 'Bearer valid.token.here')
        .send({
          gameId: testGameId,
          amount: 10
        })
        .expect(403);

      expect(response.body.error).toBe('Forbidden');
      expect(response.body.details).toBe('Not your turn');
    });
  });

  describe('Not Found (404)', () => {
    beforeEach(() => {
      mockAuthService.verifyToken.mockReturnValue(mockTokenPayload);
      mockAuthService.findUserById.mockResolvedValue(mockUser);
    });

    it('should return 404 when player is not found in the game', async () => {
      mockPlayerService.borrowForUser.mockRejectedValue(new Error('Player not found in game'));

      const response = await request(app)
        .post('/api/players/borrow')
        .set('Authorization', 'Bearer valid.token.here')
        .send({
          gameId: testGameId,
          amount: 10
        })
        .expect(404);

      expect(response.body.error).toBe('Not found');
      expect(response.body.details).toBe('Player not found in game');
    });
  });

  describe('Success (200 OK)', () => {
    beforeEach(() => {
      mockAuthService.verifyToken.mockReturnValue(mockTokenPayload);
      mockAuthService.findUserById.mockResolvedValue(mockUser);
    });

    it('should return 200 with correct response body when borrowing valid amount', async () => {
      const borrowResult = {
        borrowedAmount: 10,
        debtIncurred: 20,
        updatedMoney: 60,
        updatedDebtOwed: 20
      };

      mockPlayerService.borrowForUser.mockResolvedValue(borrowResult);
      mockPlayerService.getPlayers.mockResolvedValue([{
        id: testPlayerId,
        userId: testUserId,
        name: 'Test Player',
        color: '#FF0000',
        money: 60,
        debtOwed: 20,
        trainType: 'freight' as any,
        turnNumber: 1,
        trainState: { position: null, remainingMovement: 0, movementHistory: [], loads: [] },
        hand: []
      }]);

      const response = await request(app)
        .post('/api/players/borrow')
        .set('Authorization', 'Bearer valid.token.here')
        .send({
          gameId: testGameId,
          amount: 10
        })
        .expect(200);

      expect(response.body).toEqual(borrowResult);
      expect(mockPlayerService.borrowForUser).toHaveBeenCalledWith(
        testGameId,
        testUserId,
        10
      );
    });

    it('should return 200 when borrowing minimum amount (1 ECU)', async () => {
      const borrowResult = {
        borrowedAmount: 1,
        debtIncurred: 2,
        updatedMoney: 51,
        updatedDebtOwed: 2
      };

      mockPlayerService.borrowForUser.mockResolvedValue(borrowResult);
      mockPlayerService.getPlayers.mockResolvedValue([]);

      const response = await request(app)
        .post('/api/players/borrow')
        .set('Authorization', 'Bearer valid.token.here')
        .send({
          gameId: testGameId,
          amount: 1
        })
        .expect(200);

      expect(response.body.borrowedAmount).toBe(1);
      expect(response.body.debtIncurred).toBe(2);
    });

    it('should return 200 when borrowing maximum amount (20 ECU)', async () => {
      const borrowResult = {
        borrowedAmount: 20,
        debtIncurred: 40,
        updatedMoney: 70,
        updatedDebtOwed: 40
      };

      mockPlayerService.borrowForUser.mockResolvedValue(borrowResult);
      mockPlayerService.getPlayers.mockResolvedValue([]);

      const response = await request(app)
        .post('/api/players/borrow')
        .set('Authorization', 'Bearer valid.token.here')
        .send({
          gameId: testGameId,
          amount: 20
        })
        .expect(200);

      expect(response.body.borrowedAmount).toBe(20);
      expect(response.body.debtIncurred).toBe(40);
    });

    it('should emit state:patch via socket.io after successful borrow', async () => {
      const borrowResult = {
        borrowedAmount: 10,
        debtIncurred: 20,
        updatedMoney: 60,
        updatedDebtOwed: 20
      };

      const updatedPlayer = {
        id: testPlayerId,
        userId: testUserId,
        name: 'Test Player',
        color: '#FF0000',
        money: 60,
        debtOwed: 20,
        trainType: 'freight' as any,
        turnNumber: 1,
        trainState: { position: null, remainingMovement: 0, movementHistory: [], loads: [] },
        hand: []
      };

      mockPlayerService.borrowForUser.mockResolvedValue(borrowResult);
      mockPlayerService.getPlayers.mockResolvedValue([updatedPlayer]);
      mockSocketService.emitStatePatch.mockResolvedValue(undefined);

      await request(app)
        .post('/api/players/borrow')
        .set('Authorization', 'Bearer valid.token.here')
        .send({
          gameId: testGameId,
          amount: 10
        })
        .expect(200);

      expect(mockSocketService.emitStatePatch).toHaveBeenCalledWith(
        testGameId,
        expect.objectContaining({
          players: expect.arrayContaining([
            expect.objectContaining({
              id: testPlayerId,
              money: 60,
              debtOwed: 20
            })
          ])
        })
      );
    });

    it('should not include player hand in socket.io broadcast', async () => {
      const borrowResult = {
        borrowedAmount: 10,
        debtIncurred: 20,
        updatedMoney: 60,
        updatedDebtOwed: 20
      };

      const updatedPlayer = {
        id: testPlayerId,
        userId: testUserId,
        name: 'Test Player',
        color: '#FF0000',
        money: 60,
        debtOwed: 20,
        trainType: 'freight' as any,
        turnNumber: 1,
        trainState: { position: null, remainingMovement: 0, movementHistory: [], loads: [] },
        hand: [{ id: 1, demands: [] }] // Player has cards in hand
      };

      mockPlayerService.borrowForUser.mockResolvedValue(borrowResult);
      mockPlayerService.getPlayers.mockResolvedValue([updatedPlayer]);
      mockSocketService.emitStatePatch.mockResolvedValue(undefined);

      await request(app)
        .post('/api/players/borrow')
        .set('Authorization', 'Bearer valid.token.here')
        .send({
          gameId: testGameId,
          amount: 10
        })
        .expect(200);

      // Verify emitStatePatch was called
      expect(mockSocketService.emitStatePatch).toHaveBeenCalled();

      // Verify the broadcast does NOT include the hand
      const callArgs = mockSocketService.emitStatePatch.mock.calls[0];
      const patchData = callArgs[1] as any;
      if (patchData.players && patchData.players.length > 0) {
        expect(patchData.players[0]).not.toHaveProperty('hand');
      }
    });
  });

  describe('Response Structure Validation', () => {
    beforeEach(() => {
      mockAuthService.verifyToken.mockReturnValue(mockTokenPayload);
      mockAuthService.findUserById.mockResolvedValue(mockUser);
    });

    it('should return response with all required fields', async () => {
      const borrowResult = {
        borrowedAmount: 10,
        debtIncurred: 20,
        updatedMoney: 60,
        updatedDebtOwed: 20
      };

      mockPlayerService.borrowForUser.mockResolvedValue(borrowResult);
      mockPlayerService.getPlayers.mockResolvedValue([]);

      const response = await request(app)
        .post('/api/players/borrow')
        .set('Authorization', 'Bearer valid.token.here')
        .send({
          gameId: testGameId,
          amount: 10
        })
        .expect(200);

      // Verify all required fields are present
      expect(response.body).toHaveProperty('borrowedAmount');
      expect(response.body).toHaveProperty('debtIncurred');
      expect(response.body).toHaveProperty('updatedMoney');
      expect(response.body).toHaveProperty('updatedDebtOwed');

      // Verify correct types
      expect(typeof response.body.borrowedAmount).toBe('number');
      expect(typeof response.body.debtIncurred).toBe('number');
      expect(typeof response.body.updatedMoney).toBe('number');
      expect(typeof response.body.updatedDebtOwed).toBe('number');
    });

    it('should return debtIncurred as 2x borrowedAmount', async () => {
      const borrowResult = {
        borrowedAmount: 15,
        debtIncurred: 30,
        updatedMoney: 65,
        updatedDebtOwed: 30
      };

      mockPlayerService.borrowForUser.mockResolvedValue(borrowResult);
      mockPlayerService.getPlayers.mockResolvedValue([]);

      const response = await request(app)
        .post('/api/players/borrow')
        .set('Authorization', 'Bearer valid.token.here')
        .send({
          gameId: testGameId,
          amount: 15
        })
        .expect(200);

      expect(response.body.debtIncurred).toBe(response.body.borrowedAmount * 2);
    });
  });

  describe('Server Error Handling (500)', () => {
    beforeEach(() => {
      mockAuthService.verifyToken.mockReturnValue(mockTokenPayload);
      mockAuthService.findUserById.mockResolvedValue(mockUser);
    });

    it('should return 500 for unexpected server errors', async () => {
      mockPlayerService.borrowForUser.mockRejectedValue(new Error('Database connection failed'));

      const response = await request(app)
        .post('/api/players/borrow')
        .set('Authorization', 'Bearer valid.token.here')
        .send({
          gameId: testGameId,
          amount: 10
        })
        .expect(500);

      expect(response.body.error).toBe('Server error');
    });
  });
});
