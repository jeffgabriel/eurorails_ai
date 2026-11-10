/**
 * #302: read endpoints only serve the game's (non-deleted) players.
 * A request without a token gets 401 and a non-member gets 403.
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

describe('Membership checks on read endpoints (#302)', () => {
  let memberId: string;
  let deletedMemberId: string;
  let outsiderId: string;
  let memberToken: string;
  let deletedMemberToken: string;
  let outsiderToken: string;
  let memberPlayerId: string;
  let gameIds: string[] = [];

  async function createGame(status: string): Promise<string> {
    const gameId = uuidv4();
    await runQuery(async (client) => {
      await client.query('INSERT INTO games (id, status) VALUES ($1, $2)', [gameId, status]);
      await client.query(
        'INSERT INTO players (id, user_id, game_id, name, color, is_deleted) VALUES ($1, $2, $3, $4, $5, false)',
        [memberPlayerId, memberId, gameId, 'Member', '#FF0000']
      );
      await client.query(
        'INSERT INTO players (id, user_id, game_id, name, color, is_deleted) VALUES ($1, $2, $3, $4, $5, true)',
        [uuidv4(), deletedMemberId, gameId, 'Deleted', '#0000FF']
      );
    });
    gameIds.push(gameId);
    return gameId;
  }

  beforeAll(async () => {
    memberId = uuidv4();
    deletedMemberId = uuidv4();
    outsiderId = uuidv4();
    await runQuery(async (client) => {
      for (const [id, name] of [[memberId, 'rm-member'], [deletedMemberId, 'rm-deleted'], [outsiderId, 'rm-outsider']]) {
        await client.query(
          'INSERT INTO users (id, username, email, password_hash, email_verified) VALUES ($1, $2, $3, $4, true)',
          [id, `${name}-${id.slice(0, 8)}`, `${id}@example.com`, 'hash']
        );
      }
    });
    memberToken = tokenFor(memberId);
    deletedMemberToken = tokenFor(deletedMemberId);
    outsiderToken = tokenFor(outsiderId);
  });

  beforeEach(() => {
    memberPlayerId = uuidv4();
  });

  afterEach(async () => {
    await runQuery(async (client) => {
      await client.query('DELETE FROM chat_messages WHERE game_id = ANY($1)', [gameIds]);
      await client.query('DELETE FROM players WHERE game_id = ANY($1)', [gameIds]);
      await client.query('DELETE FROM games WHERE id = ANY($1)', [gameIds]);
    });
    gameIds = [];
  });

  afterAll(async () => {
    await runQuery((client) => client.query(
      'DELETE FROM users WHERE id = ANY($1)',
      [[memberId, deletedMemberId, outsiderId]]
    ));
  });

  describe.each([
    ['GET /api/players/:gameId', (gameId: string) => `/api/players/${gameId}`],
    ['GET /api/game/:gameId/victory-state', (gameId: string) => `/api/game/${gameId}/victory-state`],
    ['GET /api/tracks/:gameId', (gameId: string) => `/api/tracks/${gameId}`],
    ['GET /api/tracks/:gameId/:playerId', (gameId: string) => `/api/tracks/${gameId}/${memberPlayerId}`],
  ])('%s', (_name: string, path: (gameId: string) => string) => {
    it('returns 401 without a token', async () => {
      const gameId = await createGame('active');
      const res = await request(app).get(path(gameId));
      expect(res.status).toBe(401);
    });

    it('returns 403 for a non-member', async () => {
      const gameId = await createGame('active');
      const res = await request(app).get(path(gameId)).set('Authorization', `Bearer ${outsiderToken}`);
      expect(res.status).toBe(403);
      expect(res.body.error).toBe('FORBIDDEN');
    });

    it('returns 403 for a soft-deleted player', async () => {
      const gameId = await createGame('active');
      const res = await request(app).get(path(gameId)).set('Authorization', `Bearer ${deletedMemberToken}`);
      expect(res.status).toBe(403);
    });

    it('returns 403 for a malformed game id', async () => {
      const res = await request(app).get(path('test')).set('Authorization', `Bearer ${memberToken}`);
      expect(res.status).toBe(403);
    });

    it('returns 200 for a member', async () => {
      const gameId = await createGame('active');
      const res = await request(app).get(path(gameId)).set('Authorization', `Bearer ${memberToken}`);
      expect(res.status).toBe(200);
    });
  });

  describe('track reads for finished games (public map viewer)', () => {
    it.each(['completed', 'abandoned'])('allows anonymous reads of a %s game', async (status: string) => {
      const gameId = await createGame(status);
      const all = await request(app).get(`/api/tracks/${gameId}`);
      const one = await request(app).get(`/api/tracks/${gameId}/${memberPlayerId}`);
      expect(all.status).toBe(200);
      expect(one.status).toBe(200);
    });
  });

  describe('POST /api/chat/mark-read', () => {
    async function postGameMessage(gameId: string, senderId: string): Promise<number> {
      const result = await runQuery((client) => client.query(
        `INSERT INTO chat_messages (game_id, sender_user_id, recipient_type, recipient_id, message_text)
         VALUES ($1, $2, 'game', $1, 'hello') RETURNING id`,
        [gameId, senderId]
      ));
      return Number(result.rows[0].id);
    }

    async function isRead(messageId: number): Promise<boolean> {
      const result = await runQuery((client) => client.query(
        'SELECT is_read FROM chat_messages WHERE id = $1',
        [messageId]
      ));
      return result.rows[0].is_read;
    }

    it('lets a member mark game messages in their game as read', async () => {
      const gameId = await createGame('active');
      const messageId = await postGameMessage(gameId, deletedMemberId);

      const res = await request(app)
        .post('/api/chat/mark-read')
        .set('Authorization', `Bearer ${memberToken}`)
        .send({ messageIds: [messageId] });

      expect(res.status).toBe(200);
      expect(await isRead(messageId)).toBe(true);
    });

    it("refuses game messages from a game the caller isn't in", async () => {
      const gameId = await createGame('active');
      const messageId = await postGameMessage(gameId, memberId);

      const res = await request(app)
        .post('/api/chat/mark-read')
        .set('Authorization', `Bearer ${outsiderToken}`)
        .send({ messageIds: [messageId] });

      expect(res.status).toBe(403);
      expect(await isRead(messageId)).toBe(false);
    });

    it('refuses a soft-deleted player', async () => {
      const gameId = await createGame('active');
      const messageId = await postGameMessage(gameId, memberId);

      const res = await request(app)
        .post('/api/chat/mark-read')
        .set('Authorization', `Bearer ${deletedMemberToken}`)
        .send({ messageIds: [messageId] });

      expect(res.status).toBe(403);
      expect(await isRead(messageId)).toBe(false);
    });
  });
});
