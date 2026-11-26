/**
 * #305: in-game Settings actions.
 *   - DELETE /api/game/:gameId/players/:playerId  (creator only)
 *   - POST   /api/game/:gameId/end                (creator only)
 *   - PATCH  /api/players/me                      (own player only)
 */

import request from 'supertest';
import jwt from 'jsonwebtoken';
import { v4 as uuidv4 } from 'uuid';
import app from '../app';
import { db } from '../db';

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

describe('Settings actions (#305)', () => {
  const creatorId = uuidv4();
  const memberId = uuidv4();
  const thirdId = uuidv4();
  const outsiderId = uuidv4();
  const userIds = [creatorId, memberId, thirdId, outsiderId];
  const creatorToken = tokenFor(creatorId);
  const memberToken = tokenFor(memberId);
  const outsiderToken = tokenFor(outsiderId);

  let gameId: string;
  let creatorPlayerId: string;
  let memberPlayerId: string;
  let thirdPlayerId: string;
  let gameIds: string[] = [];

  /** Creates a game with three players, in seat order creator, member, third. */
  async function createGame(status: string, currentPlayerIndex: number = 0): Promise<void> {
    gameId = uuidv4();
    creatorPlayerId = uuidv4();
    memberPlayerId = uuidv4();
    thirdPlayerId = uuidv4();
    await runQuery(async (client) => {
      await client.query(
        'INSERT INTO games (id, status, current_player_index, created_by) VALUES ($1, $2, $3, $4)',
        [gameId, status, currentPlayerIndex, creatorId]
      );
      const seats: Array<[string, string, string, string]> = [
        [creatorPlayerId, creatorId, 'Creator', '#ff0000'],
        [memberPlayerId, memberId, 'Member', '#0000ff'],
        [thirdPlayerId, thirdId, 'Third', '#008000'],
      ];
      for (let i = 0; i < seats.length; i++) {
        const [id, userId, name, color] = seats[i];
        await client.query(
          `INSERT INTO players (id, user_id, game_id, name, color, money, created_at)
           VALUES ($1, $2, $3, $4, $5, 50, NOW() + ($6 || ' seconds')::interval)`,
          [id, userId, gameId, name, color, String(i)]
        );
      }
    });
    gameIds.push(gameId);
  }

  async function playerIdsInGame(): Promise<string[]> {
    const result = await db.query(
      'SELECT id FROM players WHERE game_id = $1 ORDER BY created_at ASC',
      [gameId]
    );
    return result.rows.map((row: { id: string }) => row.id);
  }

  async function gameRow(): Promise<any> {
    const result = await db.query('SELECT * FROM games WHERE id = $1', [gameId]);
    return result.rows[0];
  }

  beforeAll(async () => {
    await runQuery(async (client) => {
      for (const id of userIds) {
        await client.query(
          'INSERT INTO users (id, username, email, password_hash, email_verified) VALUES ($1, $2, $3, $4, true)',
          [id, `sa-${id.slice(0, 8)}`, `${id}@example.com`, 'hash']
        );
      }
    });
  });

  afterEach(async () => {
    await runQuery(async (client) => {
      await client.query('DELETE FROM player_tracks WHERE game_id = ANY($1)', [gameIds]);
      await client.query('UPDATE games SET created_by = NULL WHERE id = ANY($1)', [gameIds]);
      await client.query('DELETE FROM players WHERE game_id = ANY($1)', [gameIds]);
      await client.query('DELETE FROM games WHERE id = ANY($1)', [gameIds]);
    });
    gameIds = [];
  });

  afterAll(async () => {
    await runQuery((client) => client.query('DELETE FROM users WHERE id = ANY($1)', [userIds]));
  });

  describe('DELETE /api/game/:gameId/players/:playerId', () => {
    it('returns 401 without a token', async () => {
      await createGame('setup');
      const res = await request(app).delete(`/api/game/${gameId}/players/${thirdPlayerId}`);
      expect(res.status).toBe(401);
      expect(await playerIdsInGame()).toHaveLength(3);
    });

    it('returns 403 for a member who is not the creator', async () => {
      await createGame('setup');
      const res = await request(app)
        .delete(`/api/game/${gameId}/players/${thirdPlayerId}`)
        .set('Authorization', `Bearer ${memberToken}`);
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('NotCreator');
      expect(await playerIdsInGame()).toHaveLength(3);
    });

    it('returns 403 for a user outside the game', async () => {
      await createGame('setup');
      const res = await request(app)
        .delete(`/api/game/${gameId}/players/${thirdPlayerId}`)
        .set('Authorization', `Bearer ${outsiderToken}`);
      expect(res.status).toBe(403);
      expect(await playerIdsInGame()).toHaveLength(3);
    });

    it('lets the creator delete a player, along with their track', async () => {
      await createGame('setup');
      await db.query(
        'INSERT INTO player_tracks (game_id, player_id, segments, total_cost) VALUES ($1, $2, $3, $4)',
        [gameId, thirdPlayerId, JSON.stringify([{ x1: 0, y1: 0, x2: 1, y2: 1 }]), 10]
      );

      const res = await request(app)
        .delete(`/api/game/${gameId}/players/${thirdPlayerId}`)
        .set('Authorization', `Bearer ${creatorToken}`);

      expect(res.status).toBe(200);
      expect(await playerIdsInGame()).toEqual([creatorPlayerId, memberPlayerId]);
      const tracks = await db.query('SELECT 1 FROM player_tracks WHERE player_id = $1', [thirdPlayerId]);
      expect(tracks.rows).toHaveLength(0);
    });

    it('returns 404 when the player belongs to another game', async () => {
      await createGame('setup');
      const otherGamePlayerId = thirdPlayerId;
      const otherGameId = gameId;
      await createGame('setup');

      const res = await request(app)
        .delete(`/api/game/${gameId}/players/${otherGamePlayerId}`)
        .set('Authorization', `Bearer ${creatorToken}`);

      expect(res.status).toBe(404);
      expect(res.body.code).toBe('PlayerNotFound');
      const other = await db.query('SELECT id FROM players WHERE game_id = $1', [otherGameId]);
      expect(other.rows).toHaveLength(3);
    });

    it('returns 404 for a malformed player id', async () => {
      await createGame('setup');
      const res = await request(app)
        .delete(`/api/game/${gameId}/players/not-a-uuid`)
        .set('Authorization', `Bearer ${creatorToken}`);
      expect(res.status).toBe(404);
    });

    it('does not let the creator delete their own player', async () => {
      await createGame('setup');
      const res = await request(app)
        .delete(`/api/game/${gameId}/players/${creatorPlayerId}`)
        .set('Authorization', `Bearer ${creatorToken}`);
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('CannotDeleteSelf');
      expect(await playerIdsInGame()).toHaveLength(3);
    });

    it('refuses to drop below two players', async () => {
      await createGame('setup');
      await db.query('DELETE FROM players WHERE id = $1', [thirdPlayerId]);

      const res = await request(app)
        .delete(`/api/game/${gameId}/players/${memberPlayerId}`)
        .set('Authorization', `Bearer ${creatorToken}`);

      expect(res.status).toBe(409);
      expect(res.body.code).toBe('TooFewPlayers');
      expect(await playerIdsInGame()).toHaveLength(2);
    });

    it('keeps the turn on the same player when an earlier seat is deleted', async () => {
      // Third (index 2) has the turn; deleting Member (index 1) shifts Third to index 1.
      await createGame('active', 2);

      const res = await request(app)
        .delete(`/api/game/${gameId}/players/${memberPlayerId}`)
        .set('Authorization', `Bearer ${creatorToken}`);

      expect(res.status).toBe(200);
      expect(res.body.currentPlayerIndex).toBe(1);
      expect((await gameRow()).current_player_index).toBe(1);
      expect((await playerIdsInGame())[1]).toBe(thirdPlayerId);
    });

    it('leaves the turn index alone when a later seat is deleted', async () => {
      await createGame('active', 0);

      const res = await request(app)
        .delete(`/api/game/${gameId}/players/${thirdPlayerId}`)
        .set('Authorization', `Bearer ${creatorToken}`);

      expect(res.status).toBe(200);
      expect((await gameRow()).current_player_index).toBe(0);
    });

    it('refuses to delete the player whose turn it is', async () => {
      await createGame('active', 1);

      const res = await request(app)
        .delete(`/api/game/${gameId}/players/${memberPlayerId}`)
        .set('Authorization', `Bearer ${creatorToken}`);

      expect(res.status).toBe(409);
      expect(res.body.code).toBe('PlayerHasTurn');
      expect(await playerIdsInGame()).toHaveLength(3);
    });

    it('refuses while a victory declaration is pending', async () => {
      await createGame('active', 0);
      await db.query('UPDATE games SET victory_triggered = true WHERE id = $1', [gameId]);

      const res = await request(app)
        .delete(`/api/game/${gameId}/players/${thirdPlayerId}`)
        .set('Authorization', `Bearer ${creatorToken}`);

      expect(res.status).toBe(409);
      expect(res.body.code).toBe('VictoryPending');
    });

    it('removes the player from the initial build order', async () => {
      await createGame('initialBuild', 0);
      await db.query(
        'UPDATE games SET initial_build_round = 1, initial_build_order = $1 WHERE id = $2',
        [JSON.stringify([creatorPlayerId, memberPlayerId, thirdPlayerId]), gameId]
      );

      const res = await request(app)
        .delete(`/api/game/${gameId}/players/${memberPlayerId}`)
        .set('Authorization', `Bearer ${creatorToken}`);

      expect(res.status).toBe(200);
      expect((await gameRow()).initial_build_order).toEqual([creatorPlayerId, thirdPlayerId]);
    });
  });

  describe('POST /api/game/:gameId/end', () => {
    it('returns 401 without a token', async () => {
      await createGame('active');
      const res = await request(app).post(`/api/game/${gameId}/end`);
      expect(res.status).toBe(401);
      expect((await gameRow()).status).toBe('active');
    });

    it('returns 403 for a member who is not the creator', async () => {
      await createGame('active');
      const res = await request(app)
        .post(`/api/game/${gameId}/end`)
        .set('Authorization', `Bearer ${memberToken}`);
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('NotCreator');
      expect((await gameRow()).status).toBe('active');
    });

    it('returns 403 for a user outside the game', async () => {
      await createGame('active');
      const res = await request(app)
        .post(`/api/game/${gameId}/end`)
        .set('Authorization', `Bearer ${outsiderToken}`);
      expect(res.status).toBe(403);
      expect((await gameRow()).status).toBe('active');
    });

    it('lets the creator end the game', async () => {
      await createGame('active');
      const res = await request(app)
        .post(`/api/game/${gameId}/end`)
        .set('Authorization', `Bearer ${creatorToken}`);
      expect(res.status).toBe(200);
      expect((await gameRow()).status).toBe('completed');
    });

    it('returns 404 for a game that does not exist', async () => {
      const res = await request(app)
        .post(`/api/game/${uuidv4()}/end`)
        .set('Authorization', `Bearer ${creatorToken}`);
      expect(res.status).toBe(404);
    });
  });

  describe('PATCH /api/players/me', () => {
    async function playerRow(playerId: string): Promise<any> {
      const result = await db.query('SELECT * FROM players WHERE id = $1', [playerId]);
      return result.rows[0];
    }

    it('returns 401 without a token', async () => {
      await createGame('active');
      const res = await request(app).patch('/api/players/me').send({ gameId, name: 'Nope' });
      expect(res.status).toBe(401);
    });

    it("changes only the caller's own name and color", async () => {
      await createGame('active');
      const res = await request(app)
        .patch('/api/players/me')
        .set('Authorization', `Bearer ${memberToken}`)
        .send({ gameId, name: '  Renamed  ', color: '#FFD700' });

      expect(res.status).toBe(200);
      expect(res.body.player).toEqual({ id: memberPlayerId, name: 'Renamed', color: '#ffd700' });
      const member = await playerRow(memberPlayerId);
      expect(member.name).toBe('Renamed');
      expect(member.color).toBe('#ffd700');
      expect((await playerRow(creatorPlayerId)).name).toBe('Creator');
    });

    it('ignores any other field in the body, including a player id', async () => {
      await createGame('active');
      const res = await request(app)
        .patch('/api/players/me')
        .set('Authorization', `Bearer ${memberToken}`)
        .send({ gameId, name: 'Sneaky', id: creatorPlayerId, playerId: creatorPlayerId, money: 999, user_id: outsiderId });

      expect(res.status).toBe(200);
      const creator = await playerRow(creatorPlayerId);
      expect(creator.name).toBe('Creator');
      const member = await playerRow(memberPlayerId);
      expect(member.name).toBe('Sneaky');
      expect(member.money).toBe(50);
      expect(member.user_id).toBe(memberId);
    });

    it('changes the name alone and keeps the color', async () => {
      await createGame('active');
      const res = await request(app)
        .patch('/api/players/me')
        .set('Authorization', `Bearer ${memberToken}`)
        .send({ gameId, name: 'JustName' });
      expect(res.status).toBe(200);
      expect((await playerRow(memberPlayerId)).color).toBe('#0000ff');
    });

    it('returns 409 when another player has the color', async () => {
      await createGame('active');
      const res = await request(app)
        .patch('/api/players/me')
        .set('Authorization', `Bearer ${memberToken}`)
        .send({ gameId, color: '#FF0000' });
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('ColorTaken');
      expect((await playerRow(memberPlayerId)).color).toBe('#0000ff');
    });

    it('accepts the color the caller already has', async () => {
      await createGame('active');
      const res = await request(app)
        .patch('/api/players/me')
        .set('Authorization', `Bearer ${memberToken}`)
        .send({ gameId, name: 'Same', color: '#0000FF' });
      expect(res.status).toBe(200);
    });

    it.each([
      ['an empty name', { name: '   ' }, 'InvalidName'],
      ['a name over 20 characters', { name: 'x'.repeat(21) }, 'InvalidName'],
      ['a color outside the palette', { color: '#123456' }, 'InvalidColor'],
      ['a malformed color', { color: 'red' }, 'InvalidColor'],
    ])('returns 400 for %s', async (_label: string, changes: object, code: string) => {
      await createGame('active');
      const res = await request(app)
        .patch('/api/players/me')
        .set('Authorization', `Bearer ${memberToken}`)
        .send({ gameId, ...changes });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe(code);
    });

    it('returns 400 when there is nothing to change', async () => {
      await createGame('active');
      const res = await request(app)
        .patch('/api/players/me')
        .set('Authorization', `Bearer ${memberToken}`)
        .send({ gameId });
      expect(res.status).toBe(400);
    });

    it('returns 403 for a user with no player in the game', async () => {
      await createGame('active');
      const res = await request(app)
        .patch('/api/players/me')
        .set('Authorization', `Bearer ${outsiderToken}`)
        .send({ gameId, name: 'Intruder' });
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('NotAMember');
    });
  });

  describe('removed endpoints', () => {
    it.each([
      ['/api/players/delete', (): object => ({ gameId, playerId: thirdPlayerId })],
      ['/api/players/game/:gameId/end', (): object => ({})],
    ])('POST %s is gone', async (path: string, body: () => object) => {
      await createGame('active');
      const res = await request(app)
        .post(path.replace(':gameId', gameId))
        .set('Authorization', `Bearer ${creatorToken}`)
        .send(body());
      expect(res.status).toBe(404);
      expect(await playerIdsInGame()).toHaveLength(3);
      expect((await gameRow()).status).toBe('active');
    });
  });
});
