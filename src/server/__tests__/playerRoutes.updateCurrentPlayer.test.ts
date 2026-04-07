/**
 * Tests for POST /api/players/updateCurrentPlayer
 * Focuses on phase-aware routing and stale-request validation (AC3).
 */

import request from 'supertest';
import express from 'express';

// Mock db before importing routes
jest.mock('../db/index', () => ({
  db: {
    query: jest.fn(),
  },
}));

// Mock InitialBuildService
jest.mock('../services/InitialBuildService', () => ({
  InitialBuildService: {
    advanceTurn: jest.fn(),
  },
}));

// Mock PlayerService
jest.mock('../services/playerService', () => ({
  PlayerService: {
    updateCurrentPlayerIndex: jest.fn(),
    getGameState: jest.fn(),
    getPlayers: jest.fn().mockResolvedValue([]),
  },
}));

// Mock socketService
jest.mock('../services/socketService', () => ({
  emitTurnChange: jest.fn(),
  emitStatePatch: jest.fn().mockResolvedValue(undefined),
  getSocketIO: jest.fn().mockReturnValue(null),
}));

// Mock authMiddleware (no auth required for updateCurrentPlayer)
jest.mock('../middleware/authMiddleware', () => ({
  authenticateToken: jest.fn((req: any, res: any, next: any) => next()),
  requireAuth: jest.fn((req: any, res: any, next: any) => next()),
}));

import { db } from '../db/index';
import { InitialBuildService } from '../services/InitialBuildService';
import { PlayerService } from '../services/playerService';
import playerRoutes from '../routes/playerRoutes';

const mockQuery = db.query as unknown as jest.Mock;
const mockAdvanceTurn = InitialBuildService.advanceTurn as jest.Mock;
const mockGetGameState = PlayerService.getGameState as jest.Mock;
const mockUpdateCurrentPlayerIndex = PlayerService.updateCurrentPlayerIndex as jest.Mock;

const app = express();
app.use(express.json());
app.use('/api/players', playerRoutes);

function mockResult(rows: any[]) {
  return { rows, command: '', rowCount: rows.length, oid: 0, fields: [] };
}

const gameId = 'game-123';
const mockGameState = { id: gameId, status: 'initialBuild', currentPlayerIndex: 0 };

describe('POST /api/players/updateCurrentPlayer', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetGameState.mockResolvedValue(mockGameState);
    mockAdvanceTurn.mockResolvedValue(undefined);
    mockUpdateCurrentPlayerIndex.mockResolvedValue(undefined);
  });

  describe('Input validation (400)', () => {
    it('should return 400 when gameId is missing', async () => {
      const response = await request(app)
        .post('/api/players/updateCurrentPlayer')
        .send({ currentPlayerIndex: 0 })
        .expect(400);

      expect(response.body.error).toBe('Validation error');
      expect(response.body.details).toContain('Game ID is required');
    });

    it('should return 400 when currentPlayerIndex is missing', async () => {
      const response = await request(app)
        .post('/api/players/updateCurrentPlayer')
        .send({ gameId })
        .expect(400);

      expect(response.body.error).toBe('Validation error');
      expect(response.body.details).toContain('Current player index must be a number');
    });

    it('should return 400 when currentPlayerIndex is a string', async () => {
      const response = await request(app)
        .post('/api/players/updateCurrentPlayer')
        .send({ gameId, currentPlayerIndex: 'zero' })
        .expect(400);

      expect(response.body.error).toBe('Validation error');
    });
  });

  describe('initialBuild phase', () => {
    it('should return 409 when advanceTurn detects a stale request', async () => {
      // Game has current_player_index = 0; advanceTurn's FOR UPDATE lock discovers
      // another caller already advanced, so it throws with stale = true.
      mockQuery.mockResolvedValueOnce(mockResult([{
        status: 'initialBuild',
        current_player_index: 0,
      }]));
      const staleErr = new Error('Stale request: expected current_player_index 0, got 1');
      (staleErr as any).stale = true;
      mockAdvanceTurn.mockRejectedValueOnce(staleErr);

      const response = await request(app)
        .post('/api/players/updateCurrentPlayer')
        .send({ gameId, currentPlayerIndex: 1 })
        .expect(409);

      expect(response.body.error).toBe('Conflict');
      expect(response.body.details).toContain('Stale request');
      expect(mockAdvanceTurn).toHaveBeenCalledWith(gameId, 0);
    });

    it('should call InitialBuildService.advanceTurn with expectedCurrentIndex', async () => {
      mockQuery.mockResolvedValueOnce(mockResult([{
        status: 'initialBuild',
        current_player_index: 0,
      }]));

      const response = await request(app)
        .post('/api/players/updateCurrentPlayer')
        .send({ gameId, currentPlayerIndex: 1 })
        .expect(200);

      expect(mockAdvanceTurn).toHaveBeenCalledWith(gameId, 0);
      expect(response.body).toEqual(mockGameState);
    });

    it('should not call updateCurrentPlayerIndex during initialBuild', async () => {
      mockQuery.mockResolvedValueOnce(mockResult([{
        status: 'initialBuild',
        current_player_index: 0,
      }]));

      await request(app)
        .post('/api/players/updateCurrentPlayer')
        .send({ gameId, currentPlayerIndex: 1 })
        .expect(200);

      expect(mockUpdateCurrentPlayerIndex).not.toHaveBeenCalled();
    });
  });

  describe('active phase', () => {
    it('should call PlayerService.updateCurrentPlayerIndex for active games', async () => {
      mockQuery.mockResolvedValueOnce(mockResult([{
        status: 'active',
        current_player_index: 1,
      }]));

      const response = await request(app)
        .post('/api/players/updateCurrentPlayer')
        .send({ gameId, currentPlayerIndex: 2 })
        .expect(200);

      expect(mockUpdateCurrentPlayerIndex).toHaveBeenCalledWith(gameId, 2);
      expect(mockAdvanceTurn).not.toHaveBeenCalled();
      expect(response.body).toEqual(mockGameState);
    });
  });
});
