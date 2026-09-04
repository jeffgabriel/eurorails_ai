import express from 'express';
import request from 'supertest';
import gameRoutes from '../routes/gameRoutes';
import { VictoryService } from '../services/victoryService';
import { emitStatePatch, emitGameOver, emitTieExtended } from '../services/socketService';
import type { Request, Response, NextFunction } from 'express';
import type { User } from '../../shared/types/AuthTypes';

jest.mock('../db', () => ({ db: { query: jest.fn() } }));
jest.mock('../services/gameService');
jest.mock('../services/victoryService');
jest.mock('../services/socketService', () => ({
  emitVictoryTriggered: jest.fn(),
  emitGameOver: jest.fn(),
  emitTieExtended: jest.fn(),
  emitStatePatch: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../middleware/authMiddleware', () => ({
  authenticateToken: (req: Request, _res: Response, next: NextFunction): void => {
    req.user = { id: 'user' } as User;
    next();
  },
}));

const app = express();
app.use(express.json());
app.use('/api/game', gameRoutes);

describe('victory resolution HTTP synchronization', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.mocked(VictoryService.isFinalTurn).mockResolvedValue(true);
  });

  it.each([false, true])('returns the committed reset without announcing a winner or tie (broadcast fails: %s)', async (broadcastFails) => {
    const victoryState = {
      triggered: false, triggerPlayerIndex: -1, finalTurnPlayerIndex: -1, victoryThreshold: 250,
    };
    jest.mocked(VictoryService.resolveVictory).mockResolvedValue({ gameOver: false, victoryState });
    if (broadcastFails) {
      jest.mocked(emitStatePatch).mockRejectedValueOnce(new Error('sequence database unavailable'));
    }

    const result = await request(app).post('/api/game/game-1/resolve-victory');

    expect(result.status).toBe(200);
    expect(result.body).toEqual({ gameOver: false, victoryState });
    expect(emitStatePatch).toHaveBeenCalledWith('game-1', { victoryState });
    expect(emitGameOver).not.toHaveBeenCalled();
    expect(emitTieExtended).not.toHaveBeenCalled();
  });

  it('does not resolve or broadcast when a final round is not active', async () => {
    jest.mocked(VictoryService.isFinalTurn).mockResolvedValue(false);
    const result = await request(app).post('/api/game/game-1/resolve-victory');
    expect(result.status).toBe(400);
    expect(VictoryService.resolveVictory).not.toHaveBeenCalled();
    expect(emitStatePatch).not.toHaveBeenCalled();
  });
});
