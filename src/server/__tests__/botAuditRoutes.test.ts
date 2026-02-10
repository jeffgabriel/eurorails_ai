/**
 * Tests for GET /api/bot-audit/:gameId/:playerId
 * Tests authentication, authorization, bot verification, and audit retrieval.
 */

import request from 'supertest';
import express from 'express';
import botAuditRoutes from '../routes/botAuditRoutes';
import { BotAuditService } from '../services/botAuditService';
import { AuthService } from '../services/authService';
import { db } from '../db';
import { v4 as uuidv4 } from 'uuid';
import type { StrategyAudit } from '../ai/types';

// Mock dependencies
jest.mock('../services/botAuditService');
jest.mock('../services/authService');
jest.mock('../db');

const mockAuthService = AuthService as jest.Mocked<typeof AuthService>;
const mockBotAuditService = BotAuditService as jest.Mocked<typeof BotAuditService>;
const mockDb = db as jest.Mocked<typeof db>;

const app = express();
app.use(express.json());
app.use('/api/bot-audit', botAuditRoutes);

describe('GET /api/bot-audit/:gameId/:playerId', () => {
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
    updatedAt: new Date(),
  };

  const mockTokenPayload = {
    userId: testUserId,
    username: 'testuser',
    email: 'test@example.com',
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 15 * 60,
  };

  const mockAudit: StrategyAudit = {
    turnNumber: 5,
    archetypeName: 'Aggressive Builder',
    skillLevel: 'medium',
    snapshotHash: 'abc123',
    currentPlan: 'Build toward München for delivery',
    archetypeRationale: 'High cash reserves favor aggressive expansion',
    feasibleOptions: [],
    rejectedOptions: [],
    selectedPlan: [],
    executionResult: { success: true, actionsExecuted: 1, durationMs: 50 },
    botStatus: {
      cash: 45,
      trainType: 'Freight' as StrategyAudit['botStatus']['trainType'],
      loads: [],
      majorCitiesConnected: 3,
    },
    durationMs: 120,
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('Authentication (401 UNAUTHORIZED)', () => {
    it('should return 401 when no Authorization header is provided', async () => {
      const response = await request(app)
        .get(`/api/bot-audit/${testGameId}/${testPlayerId}`)
        .expect(401);

      expect(response.body.error).toBe('UNAUTHORIZED');
      expect(response.body.message).toBe('Access token required');
    });

    it('should return 401 when token is invalid', async () => {
      mockAuthService.verifyToken.mockReturnValue(null);

      const response = await request(app)
        .get(`/api/bot-audit/${testGameId}/${testPlayerId}`)
        .set('Authorization', 'Bearer invalid.token')
        .expect(401);

      expect(response.body.error).toBe('UNAUTHORIZED');
    });

    it('should return 401 when user no longer exists', async () => {
      mockAuthService.verifyToken.mockReturnValue(mockTokenPayload);
      mockAuthService.findUserById.mockResolvedValue(null);

      const response = await request(app)
        .get(`/api/bot-audit/${testGameId}/${testPlayerId}`)
        .set('Authorization', 'Bearer valid.token')
        .expect(401);

      expect(response.body.error).toBe('UNAUTHORIZED');
    });
  });

  describe('Authorization (403 FORBIDDEN)', () => {
    beforeEach(() => {
      mockAuthService.verifyToken.mockReturnValue(mockTokenPayload);
      mockAuthService.findUserById.mockResolvedValue(mockUser);
    });

    it('should return 403 when user is not a member of the game', async () => {
      // Membership check returns no rows
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);

      const response = await request(app)
        .get(`/api/bot-audit/${testGameId}/${testPlayerId}`)
        .set('Authorization', 'Bearer valid.token')
        .expect(403);

      expect(response.body.error).toBe('FORBIDDEN');
      expect(response.body.details).toBe('You are not a player in this game');
    });
  });

  describe('Not Found (404)', () => {
    beforeEach(() => {
      mockAuthService.verifyToken.mockReturnValue(mockTokenPayload);
      mockAuthService.findUserById.mockResolvedValue(mockUser);
    });

    it('should return 404 when target player is not a bot', async () => {
      // Membership check succeeds
      mockDb.query.mockResolvedValueOnce({ rows: [{ id: uuidv4() }], rowCount: 1 } as never);
      // Bot check returns no rows
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);

      const response = await request(app)
        .get(`/api/bot-audit/${testGameId}/${testPlayerId}`)
        .set('Authorization', 'Bearer valid.token')
        .expect(404);

      expect(response.body.error).toBe('NOT_FOUND');
      expect(response.body.details).toBe('Bot player not found in this game');
    });
  });

  describe('Success (200 OK)', () => {
    beforeEach(() => {
      mockAuthService.verifyToken.mockReturnValue(mockTokenPayload);
      mockAuthService.findUserById.mockResolvedValue(mockUser);
      // Membership check succeeds
      mockDb.query.mockResolvedValueOnce({ rows: [{ id: uuidv4() }], rowCount: 1 } as never);
      // Bot check succeeds
      mockDb.query.mockResolvedValueOnce({ rows: [{ id: testPlayerId }], rowCount: 1 } as never);
    });

    it('should return audit data when audit exists', async () => {
      mockBotAuditService.getLatestAudit.mockResolvedValue(mockAudit);

      const response = await request(app)
        .get(`/api/bot-audit/${testGameId}/${testPlayerId}`)
        .set('Authorization', 'Bearer valid.token')
        .expect(200);

      expect(response.body.audit).toEqual(mockAudit);
      expect(mockBotAuditService.getLatestAudit).toHaveBeenCalledWith(testGameId, testPlayerId);
    });

    it('should return null audit when no audit exists', async () => {
      mockBotAuditService.getLatestAudit.mockResolvedValue(null);

      const response = await request(app)
        .get(`/api/bot-audit/${testGameId}/${testPlayerId}`)
        .set('Authorization', 'Bearer valid.token')
        .expect(200);

      expect(response.body.audit).toBeNull();
    });
  });

  describe('Server Error (500)', () => {
    beforeEach(() => {
      mockAuthService.verifyToken.mockReturnValue(mockTokenPayload);
      mockAuthService.findUserById.mockResolvedValue(mockUser);
    });

    it('should return 500 when an unexpected error occurs', async () => {
      mockDb.query.mockRejectedValueOnce(new Error('Database connection failed') as never);

      const response = await request(app)
        .get(`/api/bot-audit/${testGameId}/${testPlayerId}`)
        .set('Authorization', 'Bearer valid.token')
        .expect(500);

      expect(response.body.error).toBe('SERVER_ERROR');
      expect(response.body.details).toBe('Database connection failed');
    });
  });
});
