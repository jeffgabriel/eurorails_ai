import express from 'express';
import request from 'supertest';
import gameRoutes from '../routes/gameRoutes';
import { db } from '../db';

jest.mock('../db', () => ({
  db: {
    query: jest.fn(),
  },
}));

jest.mock('../services/gameService');
jest.mock('../services/victoryService');
jest.mock('../services/socketService', () => ({
  emitVictoryTriggered: jest.fn(),
  emitGameOver: jest.fn(),
  emitTieExtended: jest.fn(),
}));

const app = express();
app.use(express.json());
app.use('/api/game', gameRoutes);

const mockDb = db as jest.Mocked<typeof db>;

describe('GET /api/game/:gameId/map-data', () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  it('should return 404 when game does not exist', async () => {
    (mockDb.query as jest.Mock).mockResolvedValueOnce({ rows: [] });

    const res = await request(app).get('/api/game/nonexistent-id/map-data');

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('GAME_NOT_FOUND');
  });

  it('should return 403 when game is not completed or abandoned', async () => {
    (mockDb.query as jest.Mock).mockResolvedValueOnce({
      rows: [{ status: 'in_progress' }],
    });

    const res = await request(app).get('/api/game/game-123/map-data');

    expect(res.status).toBe(403);
    expect(res.body.error).toBe('GAME_NOT_AVAILABLE');
  });

  it('should return player data for a completed game', async () => {
    (mockDb.query as jest.Mock)
      .mockResolvedValueOnce({ rows: [{ status: 'completed' }] })
      .mockResolvedValueOnce({
        rows: [
          { id: 'p1', name: 'Alice', color: '#ff0000' },
          { id: 'p2', name: 'Bob', color: '#0000ff' },
        ],
      });

    const res = await request(app).get('/api/game/game-123/map-data');

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('completed');
    expect(res.body.players).toHaveLength(2);
    expect(res.body.players[0]).toEqual({ id: 'p1', name: 'Alice', color: '#ff0000' });
  });

  it('should return player data for an abandoned game', async () => {
    (mockDb.query as jest.Mock)
      .mockResolvedValueOnce({ rows: [{ status: 'abandoned' }] })
      .mockResolvedValueOnce({
        rows: [{ id: 'p1', name: 'Alice', color: '#ff0000' }],
      });

    const res = await request(app).get('/api/game/game-123/map-data');

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('abandoned');
    expect(res.body.players).toHaveLength(1);
  });

  it('should return 500 on database error', async () => {
    (mockDb.query as jest.Mock).mockRejectedValueOnce(new Error('DB connection failed'));

    const res = await request(app).get('/api/game/game-123/map-data');

    expect(res.status).toBe(500);
    expect(res.body.error).toBe('SERVER_ERROR');
  });
});
