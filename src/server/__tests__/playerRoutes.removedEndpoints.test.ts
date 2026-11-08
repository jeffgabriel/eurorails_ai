/**
 * Regression tests for #301: dead, unauthenticated player endpoints were removed
 * and must stay unreachable.
 */

import request from 'supertest';
import express from 'express';

jest.mock('../db/index', () => ({
  db: {
    query: jest.fn(),
  },
}));

jest.mock('../services/InitialBuildService', () => ({
  InitialBuildService: {
    advanceTurn: jest.fn(),
  },
}));

jest.mock('../services/playerService', () => ({
  PlayerService: {
    getPlayers: jest.fn().mockResolvedValue([]),
  },
}));

jest.mock('../services/socketService', () => ({
  emitTurnChange: jest.fn(),
  emitStatePatch: jest.fn().mockResolvedValue(undefined),
  getSocketIO: jest.fn().mockReturnValue(null),
}));

jest.mock('../middleware/authMiddleware', () => ({
  authenticateToken: jest.fn((req: any, res: any, next: any) => next()),
  requireAuth: jest.fn((req: any, res: any, next: any) => next()),
}));

import playerRoutes from '../routes/playerRoutes';

const app = express();
app.use(express.json());
app.use('/api/players', playerRoutes);

describe('Removed player endpoints (#301)', () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  it.each([
    ['/api/players/game/create', { gameId: 'game-1' }],
    ['/api/players/create', { gameId: 'game-1', player: { name: 'P', color: '#FF0000' } }],
    ['/api/players/game/game-1/status', { status: 'active' }],
    ['/api/players/fulfill-demand', { gameId: 'game-1', playerId: 'p1', city: 'Paris', loadType: 'Coal', cardId: 1 }],
  ])('should return 404 for POST %s', async (path: string, body: object) => {
    const res = await request(app).post(path).send(body);

    expect(res.status).toBe(404);
  });

  it('should return 404 for GET /api/players/game/active', async () => {
    const res = await request(app).get('/api/players/game/active');

    expect(res.status).toBe(404);
  });
});
