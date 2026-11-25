/**
 * Tests for POST /api/players/updateCurrentPlayer (end turn).
 * The route is authenticated and server-authoritative (#304): the caller must
 * be the current player, and the body's currentPlayerIndex is ignored.
 */

import request from 'supertest';
import express from 'express';

// Mock PlayerService
jest.mock('../services/playerService', () => ({
  PlayerService: {
    endTurnForUser: jest.fn(),
    getPlayers: jest.fn(),
  },
}));

// Mock socketService
const mockRoomEmit = jest.fn();
jest.mock('../services/socketService', () => ({
  emitTurnChange: jest.fn(),
  emitStatePatch: jest.fn().mockResolvedValue(undefined),
  getSocketIO: jest.fn(),
}));

// Mock authMiddleware: a request is authenticated when it carries x-test-user.
jest.mock('../middleware/authMiddleware', () => ({
  authenticateToken: jest.fn((req: any, res: any, next: any) => {
    const userId = req.headers['x-test-user'];
    if (!userId) {
      return res.status(401).json({ error: 'UNAUTHORIZED', details: 'Access token required' });
    }
    req.user = { id: userId };
    return next();
  }),
  requireAuth: jest.fn((req: any, res: any, next: any) => next()),
}));

import { PlayerService } from '../services/playerService';
import { emitStatePatch, getSocketIO } from '../services/socketService';
import { TurnGuardError, TurnGuardErrorCode } from '../services/turnGuard';
import playerRoutes from '../routes/playerRoutes';

const mockEndTurnForUser = PlayerService.endTurnForUser as jest.Mock;
const mockGetPlayers = PlayerService.getPlayers as jest.Mock;
const mockEmitStatePatch = emitStatePatch as jest.Mock;
const mockGetSocketIO = getSocketIO as jest.Mock;

const app = express();
app.use(express.json());
app.use('/api/players', playerRoutes);

const gameId = 'game-123';
const userId = 'user-1';
const playerId = 'player-1';

function endTurn(body: Record<string, unknown>, asUser: string | null = userId): request.Test {
  const req = request(app).post('/api/players/updateCurrentPlayer');
  if (asUser) {
    req.set('x-test-user', asUser);
  }
  return req.send(body);
}

describe('POST /api/players/updateCurrentPlayer', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    mockEndTurnForUser.mockResolvedValue({ playerId, currentPlayerIndex: 1 });
    mockGetPlayers.mockResolvedValue([{ id: playerId, turnNumber: 4 }, { id: 'player-2', turnNumber: 3 }]);
    mockEmitStatePatch.mockResolvedValue(undefined);
    mockGetSocketIO.mockReturnValue({ to: jest.fn().mockReturnValue({ emit: mockRoomEmit }) });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('authentication and validation', () => {
    it('should return 401 without a token and not end the turn', async () => {
      await endTurn({ gameId }, null).expect(401);

      expect(mockEndTurnForUser).not.toHaveBeenCalled();
    });

    it('should return 400 when gameId is missing', async () => {
      const response = await endTurn({ currentPlayerIndex: 0 }).expect(400);

      expect(response.body.error).toBe('Validation error');
      expect(response.body.details).toContain('Game ID is required');
      expect(mockEndTurnForUser).not.toHaveBeenCalled();
    });
  });

  describe('ending the turn', () => {
    it('should end the turn for the authenticated user and return the new index', async () => {
      const response = await endTurn({ gameId }).expect(200);

      expect(mockEndTurnForUser).toHaveBeenCalledWith(gameId, userId);
      expect(response.body).toEqual({ currentPlayerIndex: 1 });
    });

    it('should ignore a currentPlayerIndex sent by the client', async () => {
      const response = await endTurn({ gameId, currentPlayerIndex: 5 }).expect(200);

      expect(mockEndTurnForUser).toHaveBeenCalledWith(gameId, userId);
      expect(response.body).toEqual({ currentPlayerIndex: 1 });
    });

    it('should broadcast the reset track state and the ending player', async () => {
      await endTurn({ gameId }).expect(200);

      expect(mockRoomEmit).toHaveBeenCalledWith(
        'track:updated',
        expect.objectContaining({ gameId, playerId }),
      );
      expect(mockEmitStatePatch).toHaveBeenCalledWith(gameId, {
        players: [{ id: playerId, turnNumber: 4 }],
      });
    });
  });

  describe('refusals', () => {
    it('should return 403 when the caller is not the current player', async () => {
      mockEndTurnForUser.mockRejectedValueOnce(
        new TurnGuardError(TurnGuardErrorCode.NotYourTurn, 'Not your turn'),
      );

      const response = await endTurn({ gameId }).expect(403);

      expect(response.body).toEqual({ error: 'Forbidden', code: 'NotYourTurn', details: 'Not your turn' });
      expect(mockRoomEmit).not.toHaveBeenCalled();
      expect(mockEmitStatePatch).not.toHaveBeenCalled();
    });

    it('should return 403 when the caller has no player in the game', async () => {
      mockEndTurnForUser.mockRejectedValueOnce(
        new TurnGuardError(TurnGuardErrorCode.NotAMember, 'Player not found in game'),
      );

      const response = await endTurn({ gameId }).expect(403);

      expect(response.body.code).toBe('NotAMember');
    });

    it('should return 409 when the game status does not allow ending a turn', async () => {
      mockEndTurnForUser.mockRejectedValueOnce(
        new TurnGuardError(TurnGuardErrorCode.WrongStatus, 'Action not allowed while the game is completed'),
      );

      await endTurn({ gameId }).expect(409);
    });

    it('should return 409 when the initial-build advance detects a stale request', async () => {
      const staleErr = new Error('Stale request: expected current_player_index 0, got 1');
      (staleErr as any).stale = true;
      mockEndTurnForUser.mockRejectedValueOnce(staleErr);

      const response = await endTurn({ gameId }).expect(409);

      expect(response.body.error).toBe('Conflict');
      expect(response.body.details).toContain('Stale request');
    });

    it('should return 500 on an unexpected error', async () => {
      mockEndTurnForUser.mockRejectedValueOnce(new Error('db down'));

      const response = await endTurn({ gameId }).expect(500);

      expect(response.body.error).toBe('Server error');
    });
  });
});
