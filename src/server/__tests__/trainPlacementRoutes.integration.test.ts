/**
 * #311: validated initial train placement, and the removal of /players/update.
 *   - POST /api/players/place-train  (caller's turn; body { gameId, to: { row, col } })
 *   - POST /api/players/update       (gone)
 *
 * Mileposts used (row,col), on the real map: Berlin center (24,52) and outer
 * milepost (24,51); clear (24,50) next to Berlin.
 *
 * Cleanup: each test creates its own game. `afterEach` deletes that game's
 * players and the game; `afterAll` deletes the users created in `beforeAll`.
 */

import request from 'supertest';
import jwt from 'jsonwebtoken';
import { v4 as uuidv4 } from 'uuid';
import type { PoolClient } from 'pg';
import app from '../app';
import { db } from '../db';
import { gridToPixel } from '../services/MapTopology';

async function runQuery<T>(queryFn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await db.connect();
  try {
    return await queryFn(client);
  } finally {
    client.release();
  }
}

function tokenFor(userId: string): string {
  // Set by the Jest setup file; no fallback, matching AuthService.
  const JWT_SECRET = process.env.JWT_SECRET as string;
  const now = Math.floor(Date.now() / 1000);
  return jwt.sign({ userId, email: `${userId}@example.com`, username: userId, iat: now, exp: now + 15 * 60 }, JWT_SECRET);
}

type Coord = { row: number; col: number };
const BERLIN_CENTER: Coord = { row: 24, col: 52 };
const BERLIN_OUTER: Coord = { row: 24, col: 51 };
const CLEAR: Coord = { row: 24, col: 50 };

describe('Validated train placement (#311)', () => {
  const firstId = uuidv4();
  const secondId = uuidv4();
  const outsiderId = uuidv4();
  const userIds = [firstId, secondId, outsiderId];
  const firstToken = tokenFor(firstId);
  const secondToken = tokenFor(secondId);
  const outsiderToken = tokenFor(outsiderId);

  let gameId: string;
  let firstPlayerId: string;
  let secondPlayerId: string;
  let gameIds: string[] = [];

  /** Creates a two-player game; the first player (seat 0) has the turn. */
  async function createGame(
    opts: { status?: string; currentPlayerIndex?: number; firstPosition?: Coord | null } = {},
  ): Promise<void> {
    const { status = 'active', currentPlayerIndex = 0, firstPosition = null } = opts;
    gameId = uuidv4();
    firstPlayerId = uuidv4();
    secondPlayerId = uuidv4();
    await runQuery(async (client) => {
      await client.query(
        'INSERT INTO games (id, status, current_player_index, created_by) VALUES ($1, $2, $3, $4)',
        [gameId, status, currentPlayerIndex, firstId],
      );
      await client.query(
        `INSERT INTO players (id, user_id, game_id, name, color, money, hand, loads, train_type,
                              current_turn_number, position_row, position_col, position_x, position_y, created_at)
         VALUES ($1, $2, $3, 'First', '#ff0000', 63, '{4,5,6}', '{Coal}', 'fast_freight', 3, $4, $5, $6, $7, NOW())`,
        [
          firstPlayerId, firstId, gameId,
          firstPosition?.row ?? null, firstPosition?.col ?? null,
          firstPosition ? 0 : null, firstPosition ? 0 : null,
        ],
      );
      await client.query(
        `INSERT INTO players (id, user_id, game_id, name, color, money, current_turn_number, created_at)
         VALUES ($1, $2, $3, 'Second', '#0000ff', 50, 3, NOW() + interval '1 second')`,
        [secondPlayerId, secondId, gameId],
      );
    });
    gameIds.push(gameId);
  }

  async function playerRow(playerId: string): Promise<Record<string, unknown>> {
    const result = await db.query(
      `SELECT name, color, user_id, money, hand, loads, train_type, current_turn_number,
              position_row, position_col, position_x, position_y
       FROM players WHERE id = $1`,
      [playerId],
    );
    return result.rows[0];
  }

  function place(token: string | undefined, to: unknown, extra: object = {}): request.Test {
    const req = request(app).post('/api/players/place-train').send({ gameId, to, ...extra });
    return token ? req.set('Authorization', `Bearer ${token}`) : req;
  }

  beforeAll(async () => {
    await runQuery(async (client) => {
      for (const id of userIds) {
        await client.query(
          'INSERT INTO users (id, username, email, password_hash, email_verified) VALUES ($1, $2, $3, $4, true)',
          [id, `tp-${id.slice(0, 8)}`, `${id}@example.com`, 'hash'],
        );
      }
    });
  });

  afterEach(async () => {
    await runQuery(async (client) => {
      await client.query('DELETE FROM players WHERE game_id = ANY($1)', [gameIds]);
      await client.query('DELETE FROM games WHERE id = ANY($1)', [gameIds]);
    });
    gameIds = [];
  });

  afterAll(async () => {
    await runQuery((client) => client.query('DELETE FROM users WHERE id = ANY($1)', [userIds]));
  });

  describe('POST /api/players/place-train', () => {
    it('places the train at a city and changes nothing else about the player', async () => {
      await createGame();
      const before = await playerRow(firstPlayerId);

      // Everything but the milepost is ignored, including a position and other player fields.
      const res = await place(firstToken, { ...BERLIN_CENTER, x: -5, y: -5 }, {
        player: { id: secondPlayerId, money: 999, hand: [1, 2, 3], trainType: 'superfreight' },
      });

      const pixel = gridToPixel(BERLIN_CENTER.row, BERLIN_CENTER.col);
      expect(res.status).toBe(200);
      expect(res.body.position).toEqual({ ...BERLIN_CENTER, x: pixel.x, y: pixel.y });
      expect(await playerRow(firstPlayerId)).toEqual({
        ...before,
        position_row: BERLIN_CENTER.row,
        position_col: BERLIN_CENTER.col,
        position_x: Math.round(pixel.x),
        position_y: Math.round(pixel.y),
      });
      expect((await playerRow(secondPlayerId)).money).toBe(50);
    });

    it('accepts an outer milepost of a major city', async () => {
      await createGame();
      const res = await place(firstToken, BERLIN_OUTER);
      expect(res.status).toBe(200);
      expect(await playerRow(firstPlayerId)).toMatchObject({ position_row: 24, position_col: 51 });
    });

    it('is allowed during the initial building turns', async () => {
      await createGame({ status: 'initialBuild' });
      expect((await place(firstToken, BERLIN_CENTER)).status).toBe(200);
    });

    it('returns 409 AlreadyPlaced once the train is on the board, and leaves it where it is', async () => {
      await createGame({ firstPosition: BERLIN_OUTER });

      const res = await place(firstToken, BERLIN_CENTER);

      expect(res.status).toBe(409);
      expect(res.body.code).toBe('AlreadyPlaced');
      expect(await playerRow(firstPlayerId)).toMatchObject({ position_row: 24, position_col: 51 });
    });

    it('cannot be used twice to jump the train to another city', async () => {
      await createGame();
      expect((await place(firstToken, BERLIN_CENTER)).status).toBe(200);
      expect((await place(firstToken, BERLIN_OUTER)).status).toBe(409);
      expect(await playerRow(firstPlayerId)).toMatchObject({ position_row: 24, position_col: 52 });
    });

    it('returns 400 NotACity for a milepost that is not a city', async () => {
      await createGame();
      const res = await place(firstToken, CLEAR);
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('NotACity');
      expect((await playerRow(firstPlayerId)).position_row).toBeNull();
    });

    it.each([
      ['no target', undefined],
      ['a non-integer milepost', { row: 24.5, col: 52 }],
    ])('returns 400 InvalidTarget for %s', async (_name: string, to: unknown) => {
      await createGame();
      const res = await place(firstToken, to);
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('InvalidTarget');
    });

    it('returns 401 without a token', async () => {
      await createGame();
      expect((await place(undefined, BERLIN_CENTER)).status).toBe(401);
      expect((await playerRow(firstPlayerId)).position_row).toBeNull();
    });

    it('returns 400 for a malformed game id', async () => {
      await createGame();
      const res = await request(app)
        .post('/api/players/place-train')
        .set('Authorization', `Bearer ${firstToken}`)
        .send({ gameId: 'not-a-uuid', to: BERLIN_CENTER });
      expect(res.status).toBe(400);
    });

    it('returns 403 for a user who is not in the game', async () => {
      await createGame();
      expect((await place(outsiderToken, BERLIN_CENTER)).status).toBe(403);
    });

    it('returns 403 when it is not the caller\'s turn, and places no train', async () => {
      await createGame();
      const res = await place(secondToken, BERLIN_CENTER);
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('NotYourTurn');
      expect((await playerRow(secondPlayerId)).position_row).toBeNull();
    });

    it('returns 409 when the game is not being played', async () => {
      await createGame({ status: 'completed' });
      expect((await place(firstToken, BERLIN_CENTER)).status).toBe(409);
    });
  });

  describe('POST /api/players/update', () => {
    it('is gone: a request can no longer write a player\'s money, hand, loads or position', async () => {
      await createGame();
      const before = await playerRow(firstPlayerId);

      const res = await request(app)
        .post('/api/players/update')
        .set('Authorization', `Bearer ${firstToken}`)
        .send({
          gameId,
          player: {
            id: firstPlayerId, name: 'First', color: '#ff0000', money: 999, hand: [], turnNumber: 9,
            trainType: 'superfreight',
            trainState: { position: { x: 1, y: 1, row: 1, col: 1 }, loads: [] },
          },
        });

      expect(res.status).toBe(404);
      expect(await playerRow(firstPlayerId)).toEqual(before);
    });

    it('no longer creates games or players', async () => {
      const newGameId = uuidv4();
      const res = await request(app).post('/api/players/update').send({
        gameId: newGameId,
        player: { id: uuidv4(), name: 'Ghost', color: '#00ff00', trainState: { loads: [] } },
      });

      expect(res.status).toBe(404);
      expect((await db.query('SELECT id FROM games WHERE id = $1', [newGameId])).rows).toHaveLength(0);
    });
  });
});
