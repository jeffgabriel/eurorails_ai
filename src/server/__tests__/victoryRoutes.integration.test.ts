/**
 * #306: victory declare/resolve integrity.
 *   - POST /api/game/:gameId/declare-victory  (caller's turn, active game)
 *   - POST /api/game/:gameId/resolve-victory  (final-turn player only, during that turn)
 */

import request from 'supertest';
import jwt from 'jsonwebtoken';
import { v4 as uuidv4 } from 'uuid';
import app from '../app';
import { db } from '../db';
import { TrackService } from '../services/trackService';
import { victoryTrack } from './fixtures/victoryFixtures';

async function runQuery<T = any>(queryFn: (client: any) => Promise<T>): Promise<T> {
  const client = await db.connect();
  try {
    return await queryFn(client);
  } finally {
    client.release();
  }
}

function tokenFor(userId: string): string {
  const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key-change-in-production';
  const now = Math.floor(Date.now() / 1000);
  return jwt.sign({ userId, email: `${userId}@example.com`, username: userId, iat: now, exp: now + 15 * 60 }, JWT_SECRET);
}

describe('Victory declare/resolve integrity (#306)', () => {
  const firstId = uuidv4();
  const secondId = uuidv4();
  const thirdId = uuidv4();
  const outsiderId = uuidv4();
  const userIds = [firstId, secondId, thirdId, outsiderId];
  const firstToken = tokenFor(firstId);
  const secondToken = tokenFor(secondId);
  const thirdToken = tokenFor(thirdId);
  const outsiderToken = tokenFor(outsiderId);

  let gameId: string;
  let firstPlayerId: string;
  let secondPlayerId: string;
  let thirdPlayerId: string;
  let gameIds: string[] = [];

  /**
   * Creates a game with three players in seat order first, second, third.
   * The first player is eligible to win (260M, seven connected major cities).
   */
  async function createGame(status: string = 'active', currentPlayerIndex: number = 0): Promise<void> {
    gameId = uuidv4();
    firstPlayerId = uuidv4();
    secondPlayerId = uuidv4();
    thirdPlayerId = uuidv4();
    await runQuery(async (client) => {
      await client.query(
        'INSERT INTO games (id, status, current_player_index, created_by) VALUES ($1, $2, $3, $4)',
        [gameId, status, currentPlayerIndex, firstId]
      );
      const seats: Array<[string, string, string, string, number]> = [
        [firstPlayerId, firstId, 'First', '#ff0000', 260],
        [secondPlayerId, secondId, 'Second', '#0000ff', 100],
        [thirdPlayerId, thirdId, 'Third', '#008000', 100],
      ];
      for (let i = 0; i < seats.length; i++) {
        const [id, userId, name, color, money] = seats[i];
        await client.query(
          `INSERT INTO players (id, user_id, game_id, name, color, money, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, NOW() + ($7 || ' seconds')::interval)`,
          [id, userId, gameId, name, color, money, String(i)]
        );
      }
    });
    gameIds.push(gameId);
    await saveTrack(firstPlayerId);
  }

  async function saveTrack(playerId: string, turnBuildCost: number = 0): Promise<void> {
    await TrackService.saveTrackState(gameId, playerId, {
      playerId, gameId, segments: victoryTrack(), totalCost: 0,
      turnBuildCost, lastBuildTimestamp: new Date(),
    });
  }

  /** Puts the game into a final round declared by the first player (seat 0). */
  async function triggerFinalRound(currentPlayerIndex: number): Promise<void> {
    await db.query(
      `UPDATE games
       SET victory_triggered = true, victory_trigger_player_index = 0,
           final_turn_player_index = 2, current_player_index = $2
       WHERE id = $1`,
      [gameId, currentPlayerIndex]
    );
  }

  async function gameRow(): Promise<any> {
    const result = await db.query('SELECT * FROM games WHERE id = $1', [gameId]);
    return result.rows[0];
  }

  async function moneyOf(playerId: string): Promise<number> {
    const result = await db.query('SELECT money FROM players WHERE id = $1', [playerId]);
    return Number(result.rows[0].money);
  }

  function declare(token?: string, body: object = {}): request.Test {
    const req = request(app).post(`/api/game/${gameId}/declare-victory`).send(body);
    return token ? req.set('Authorization', `Bearer ${token}`) : req;
  }

  function resolve(token?: string): request.Test {
    const req = request(app).post(`/api/game/${gameId}/resolve-victory`);
    return token ? req.set('Authorization', `Bearer ${token}`) : req;
  }

  beforeAll(async () => {
    await runQuery(async (client) => {
      for (const id of userIds) {
        await client.query(
          'INSERT INTO users (id, username, email, password_hash, email_verified) VALUES ($1, $2, $3, $4, true)',
          [id, `vr-${id.slice(0, 8)}`, `${id}@example.com`, 'hash']
        );
      }
    });
  });

  afterEach(async () => {
    await runQuery(async (client) => {
      await client.query('DELETE FROM player_tracks WHERE game_id = ANY($1)', [gameIds]);
      await client.query('DELETE FROM players WHERE game_id = ANY($1)', [gameIds]);
      await client.query('DELETE FROM games WHERE id = ANY($1)', [gameIds]);
    });
    gameIds = [];
  });

  afterAll(async () => {
    await runQuery((client) => client.query('DELETE FROM users WHERE id = ANY($1)', [userIds]));
  });

  describe('POST /api/game/:gameId/declare-victory', () => {
    it('returns 401 without a token', async () => {
      await createGame();
      const res = await declare();
      expect(res.status).toBe(401);
      expect((await gameRow()).victory_triggered).toBe(false);
    });

    it('returns 404 for a malformed game id', async () => {
      const res = await request(app)
        .post('/api/game/not-a-uuid/declare-victory')
        .set('Authorization', `Bearer ${firstToken}`);
      expect(res.status).toBe(404);
    });

    it('returns 403 for a user outside the game', async () => {
      await createGame();
      const res = await declare(outsiderToken);
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('NotAMember');
      expect((await gameRow()).victory_triggered).toBe(false);
    });

    it('returns 403 when it is not the caller\'s turn', async () => {
      await createGame('active', 1);
      const res = await declare(firstToken);
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('NotYourTurn');
      expect((await gameRow()).victory_triggered).toBe(false);
    });

    it.each(['setup', 'initialBuild', 'completed'])('returns 409 while the game is %s', async (status) => {
      await createGame(status);
      const res = await declare(firstToken);
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('WrongStatus');
      expect((await gameRow()).victory_triggered).toBe(false);
    });

    it('declares for the caller\'s own player and ignores the body', async () => {
      await createGame();
      const res = await declare(firstToken, { playerId: secondPlayerId, connectedCities: [] });
      expect(res.status).toBe(200);
      expect(res.body.victoryState).toEqual({
        triggered: true, triggerPlayerIndex: 0, finalTurnPlayerIndex: 2, victoryThreshold: 250,
      });
      expect(await gameRow()).toMatchObject({
        victory_triggered: true, victory_trigger_player_index: 0, final_turn_player_index: 2,
      });
    });

    it('cannot be used to declare for another player whose turn it is not', async () => {
      await createGame();
      // Second is not eligible and it is not their turn; naming First does not help.
      const res = await declare(secondToken, { playerId: firstPlayerId, connectedCities: [] });
      expect(res.status).toBe(403);
      expect((await gameRow()).victory_triggered).toBe(false);
    });

    it('returns 400 and changes nothing when the caller is not eligible', async () => {
      await createGame('active', 1);
      const res = await declare(secondToken);
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('VICTORY_INVALID');
      expect((await gameRow()).victory_triggered).toBe(false);
    });

    it('judges eligibility on money after this turn\'s unsettled build cost', async () => {
      await createGame();
      await saveTrack(firstPlayerId, 20); // 260M - 20M = 240M
      const res = await declare(firstToken);
      expect(res.status).toBe(400);
      expect(res.body.details).toContain('Insufficient funds');
      expect((await gameRow()).victory_triggered).toBe(false);
      // A rejected declaration rolls back, so the cost is still owed at turn end.
      expect(await moneyOf(firstPlayerId)).toBe(260);
    });

    it('settles the build cost when the declaration succeeds', async () => {
      await createGame();
      await saveTrack(firstPlayerId, 10); // 260M - 10M = 250M
      const res = await declare(firstToken);
      expect(res.status).toBe(200);
      expect(await moneyOf(firstPlayerId)).toBe(250);
      const track = await TrackService.getTrackState(gameId, firstPlayerId);
      expect(track?.turnBuildCost).toBe(0);
    });

    it('accepts exactly one of two concurrent declarations', async () => {
      await createGame();
      const [a, b] = await Promise.all([declare(firstToken), declare(firstToken)]);
      expect([a.status, b.status].sort()).toEqual([200, 400]);
      const rejected = a.status === 400 ? a : b;
      expect(rejected.body.details).toBe('Victory already declared');
    });
  });

  describe('POST /api/game/:gameId/resolve-victory', () => {
    it('returns 401 without a token', async () => {
      await createGame();
      await triggerFinalRound(2);
      const res = await resolve();
      expect(res.status).toBe(401);
      expect((await gameRow()).status).toBe('active');
    });

    it('returns 404 for a malformed game id', async () => {
      const res = await request(app)
        .post('/api/game/not-a-uuid/resolve-victory')
        .set('Authorization', `Bearer ${firstToken}`);
      expect(res.status).toBe(404);
    });

    it('returns 403 for a user outside the game', async () => {
      await createGame();
      await triggerFinalRound(2);
      const res = await resolve(outsiderToken);
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('NotAMember');
      expect((await gameRow()).status).toBe('active');
    });

    it('returns 403 for a member other than the final-turn player during the final turn', async () => {
      await createGame();
      await triggerFinalRound(2);
      const res = await resolve(firstToken);
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('NotYourTurn');
      expect(await gameRow()).toMatchObject({ status: 'active', winner_id: null, victory_triggered: true });
    });

    it('returns 400 for the current player before the final turn', async () => {
      await createGame();
      await triggerFinalRound(1);
      const res = await resolve(secondToken);
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('NOT_FINAL_TURN');
      expect(await gameRow()).toMatchObject({ status: 'active', winner_id: null, victory_triggered: true });
    });

    it('returns 400 when no victory has been declared', async () => {
      await createGame('active', 2);
      const res = await resolve(thirdToken);
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('NOT_FINAL_TURN');
      expect((await gameRow()).status).toBe('active');
    });

    it('lets the final-turn player resolve during their turn', async () => {
      await createGame();
      await triggerFinalRound(2);
      const res = await resolve(thirdToken);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ gameOver: true, winnerId: firstPlayerId, winnerName: 'First' });
      expect(await gameRow()).toMatchObject({ status: 'completed', winner_id: firstPlayerId });
    });

    it('returns 409 once the game is completed', async () => {
      await createGame();
      await triggerFinalRound(2);
      expect((await resolve(thirdToken)).status).toBe(200);
      const again = await resolve(thirdToken);
      expect(again.status).toBe(409);
      expect(again.body.code).toBe('WrongStatus');
    });

    it('charges the final player\'s unsettled build cost before judging them', async () => {
      await createGame();
      await triggerFinalRound(2);
      // Third would out-earn First on raw cash, but owes 20M for this turn's track.
      await db.query('UPDATE players SET money = 270 WHERE id = $1', [thirdPlayerId]);
      await saveTrack(thirdPlayerId, 20);
      const res = await resolve(thirdToken);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ gameOver: true, winnerId: firstPlayerId });
      expect(await moneyOf(thirdPlayerId)).toBe(250);
    });

    it('resumes normal play when nobody qualifies any more', async () => {
      await createGame();
      await triggerFinalRound(2);
      await db.query('UPDATE players SET money = 249 WHERE id = $1', [firstPlayerId]);
      const res = await resolve(thirdToken);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        gameOver: false,
        victoryState: { triggered: false, triggerPlayerIndex: -1, finalTurnPlayerIndex: -1, victoryThreshold: 250 },
      });
      expect(await gameRow()).toMatchObject({ status: 'active', winner_id: null, victory_triggered: false });
    });
  });
});
