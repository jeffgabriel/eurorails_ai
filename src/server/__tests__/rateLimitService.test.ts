/**
 * RateLimitService Unit Tests
 * Tests for per-user rate limiting (15 messages per minute)
 */

import { rateLimitService } from '../services/rateLimitService';
import { db } from '../db';
import { v4 as uuidv4 } from 'uuid';

// Helper function to run database queries with proper connection handling
async function runQuery<T = any>(queryFn: (client: any) => Promise<T>): Promise<T> {
  const client = await db.connect();
  try {
    return await queryFn(client);
  } finally {
    client.release();
  }
}

// Helper function to create test game
async function createTestGame(): Promise<string> {
  const gameId = uuidv4();
  await runQuery(async (client) => {
    await client.query(
      `INSERT INTO games (id, status) VALUES ($1, $2)`,
      [gameId, 'active']
    );
  });
  return gameId;
}

// Helper function to create test user
async function createTestUser(username: string, email: string): Promise<string> {
  const userId = uuidv4();
  await runQuery(async (client) => {
    await client.query(
      'INSERT INTO users (id, username, email, password_hash, email_verified, chat_enabled) VALUES ($1, $2, $3, $4, $5, $6)',
      [userId, username, email, 'hash', true, true]
    );
  });
  return userId;
}

// Helper function to clean up test data
async function cleanupTestData(userIds: string[], gameIds: string[]) {
  await runQuery(async (client) => {
    if (userIds.length > 0) {
      await client.query('DELETE FROM chat_rate_limits WHERE user_id = ANY($1)', [userIds]);
      await client.query('DELETE FROM users WHERE id = ANY($1)', [userIds]);
    }
    if (gameIds.length > 0) {
      await client.query('DELETE FROM games WHERE id = ANY($1)', [gameIds]);
    }
  });
}

describe('RateLimitService', () => {
  let testUserIds: string[] = [];
  let testGameIds: string[] = [];

  afterEach(async () => {
    // Clean up test data
    await cleanupTestData(testUserIds, testGameIds);
    testUserIds = [];
    testGameIds = [];
  });

  afterAll(async () => {
    // Final cleanup
    await cleanupTestData(testUserIds, testGameIds);
  });

  describe('checkUserLimit', () => {
    it('should allow messages within limit', async () => {
      const userId = await createTestUser('testuser1', 'test1@example.com');
      const gameId = await createTestGame();
      testUserIds.push(userId);
      testGameIds.push(gameId);

      // Send 5 messages (well under limit of 15)
      for (let i = 0; i < 5; i++) {
        const check = await rateLimitService.checkUserLimit(userId, gameId);
        expect(check.allowed).toBe(true);
        await rateLimitService.recordMessage(userId, gameId);
      }

      // Verify final check still allows
      const finalCheck = await rateLimitService.checkUserLimit(userId, gameId);
      expect(finalCheck.allowed).toBe(true);
    });

    it('should block messages after limit exceeded', async () => {
      const userId = await createTestUser('testuser2', 'test2@example.com');
      const gameId = await createTestGame();
      testUserIds.push(userId);
      testGameIds.push(gameId);

      // Send 15 messages (exactly the limit)
      for (let i = 0; i < 15; i++) {
        await rateLimitService.recordMessage(userId, gameId);
      }

      // Small delay to ensure all database writes are committed (CI race condition fix)
      await new Promise(resolve => setTimeout(resolve, 50));

      // Verify the database state before checking limit (prevents race conditions in CI)
      const status = await rateLimitService.getUserStatus(userId, gameId);
      expect(status).toBeDefined();
      expect(status!.messageCount).toBe(15);

      // 16th message should be blocked
      const check = await rateLimitService.checkUserLimit(userId, gameId);
      expect(check.allowed).toBe(false);
      expect(check.retryAfter).toBeDefined();
      expect(check.retryAfter).toBeGreaterThan(0);
    });

    it('should reset limit after window expires', async () => {
      const userId = await createTestUser('testuser3', 'test3@example.com');
      const gameId = await createTestGame();
      testUserIds.push(userId);
      testGameIds.push(gameId);

      // Send 15 messages
      for (let i = 0; i < 15; i++) {
        await rateLimitService.recordMessage(userId, gameId);
      }

      // Small delay to ensure all database writes are committed (CI race condition fix)
      await new Promise(resolve => setTimeout(resolve, 50));

      // Verify the count is correct before checking limit
      const status = await rateLimitService.getUserStatus(userId, gameId);
      expect(status).toBeDefined();
      expect(status!.messageCount).toBe(15);

      // Verify blocked
      const blockedCheck = await rateLimitService.checkUserLimit(userId, gameId);
      expect(blockedCheck.allowed).toBe(false);

      // Manually expire the window by setting window_start to past
      await runQuery(async (client) => {
        await client.query(
          `UPDATE chat_rate_limits
           SET window_start = NOW() - INTERVAL '2 minutes'
           WHERE user_id = $1 AND game_id = $2`,
          [userId, gameId]
        );
      });

      // Should now be allowed
      const allowedCheck = await rateLimitService.checkUserLimit(userId, gameId);
      expect(allowedCheck.allowed).toBe(true);
    });

    it('should track limits per user per game separately', async () => {
      const user1 = await createTestUser('testuser4', 'test4@example.com');
      const user2 = await createTestUser('testuser5', 'test5@example.com');
      const game1 = await createTestGame();
      const game2 = await createTestGame();
      testUserIds.push(user1, user2);
      testGameIds.push(game1, game2);

      // User1 in Game1: send 15 messages
      for (let i = 0; i < 15; i++) {
        await rateLimitService.recordMessage(user1, game1);
      }

      // Small delay to ensure all database writes are committed (CI race condition fix)
      await new Promise(resolve => setTimeout(resolve, 50));

      // Verify count before checking
      const status = await rateLimitService.getUserStatus(user1, game1);
      expect(status!.messageCount).toBe(15);

      // User1 in Game1 should be blocked
      const user1Game1Check = await rateLimitService.checkUserLimit(user1, game1);
      expect(user1Game1Check.allowed).toBe(false);

      // User1 in Game2 should still be allowed (different game)
      const user1Game2Check = await rateLimitService.checkUserLimit(user1, game2);
      expect(user1Game2Check.allowed).toBe(true);

      // User2 in Game1 should still be allowed (different user)
      const user2Game1Check = await rateLimitService.checkUserLimit(user2, game1);
      expect(user2Game1Check.allowed).toBe(true);
    });
  });

  describe('getUserStatus', () => {
    it('should return current rate limit status', async () => {
      const userId = await createTestUser('testuser6', 'test6@example.com');
      const gameId = await createTestGame();
      testUserIds.push(userId);
      testGameIds.push(gameId);

      // Send 10 messages
      for (let i = 0; i < 10; i++) {
        await rateLimitService.recordMessage(userId, gameId);
      }

      const status = await rateLimitService.getUserStatus(userId, gameId);

      expect(status).toBeDefined();
      expect(status?.messageCount).toBe(10);
      expect(status?.limit).toBe(15);
      expect(status?.windowStart).toBeDefined();
      expect(status?.windowEnd).toBeDefined();
    });

    it('should return null for user with no messages', async () => {
      const userId = await createTestUser('testuser7', 'test7@example.com');
      const gameId = await createTestGame();
      testUserIds.push(userId);
      testGameIds.push(gameId);

      const status = await rateLimitService.getUserStatus(userId, gameId);

      expect(status).toBeNull();
    });
  });

  describe('cleanupOldData', () => {
    it('should delete old rate limit records', async () => {
      const userId1 = await createTestUser('testuser10', 'test10@example.com');
      const userId2 = await createTestUser('testuser11', 'test11@example.com');
      const gameId = await createTestGame();
      testUserIds.push(userId1, userId2);
      testGameIds.push(gameId);

      // Create one old and one recent record
      await rateLimitService.recordMessage(userId1, gameId);
      await rateLimitService.recordMessage(userId2, gameId);

      // Manually set first record to be 25 hours old
      await runQuery(async (client) => {
        await client.query(
          `UPDATE chat_rate_limits
           SET last_message_at = NOW() - INTERVAL '25 hours'
           WHERE user_id = $1 AND game_id = $2`,
          [userId1, gameId]
        );
      });

      const deletedCount = await rateLimitService.cleanupOldData();

      expect(deletedCount).toBeGreaterThanOrEqual(1);

      // Verify old record was deleted
      const remaining = await runQuery(async (client) => {
        const result = await client.query('SELECT * FROM chat_rate_limits WHERE user_id = $1 AND game_id = $2', [
          userId1,
          gameId,
        ]);
        return result.rows;
      });

      expect(remaining.length).toBe(0);

      // Verify recent record still exists
      const recentRecord = await runQuery(async (client) => {
        const result = await client.query('SELECT * FROM chat_rate_limits WHERE user_id = $1 AND game_id = $2', [
          userId2,
          gameId,
        ]);
        return result.rows;
      });

      expect(recentRecord.length).toBe(1);
    });
  });

  describe('resetUserLimit', () => {
    it('should reset user rate limit', async () => {
      const userId = await createTestUser('testuser9', 'test9@example.com');
      const gameId = await createTestGame();
      testUserIds.push(userId);
      testGameIds.push(gameId);

      // Send 15 messages to hit limit
      for (let i = 0; i < 15; i++) {
        await rateLimitService.recordMessage(userId, gameId);
      }

      // Small delay to ensure all database writes are committed (CI race condition fix)
      await new Promise(resolve => setTimeout(resolve, 50));

      // Verify count before checking
      const status = await rateLimitService.getUserStatus(userId, gameId);
      expect(status!.messageCount).toBe(15);

      // Verify blocked
      const blockedCheck = await rateLimitService.checkUserLimit(userId, gameId);
      expect(blockedCheck.allowed).toBe(false);

      // Reset limit
      await rateLimitService.resetUserLimit(userId, gameId);

      // Should now be allowed
      const allowedCheck = await rateLimitService.checkUserLimit(userId, gameId);
      expect(allowedCheck.allowed).toBe(true);
    });
  });
});
