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

// Helper function to clean up test data
async function cleanupTestData(userIds: string[], gameIds: string[]) {
  await runQuery(async (client) => {
    if (userIds.length > 0) {
      await client.query('DELETE FROM chat_rate_limits WHERE user_id = ANY($1)', [userIds]);
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
      const userId = uuidv4();
      const gameId = uuidv4();
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
      const userId = uuidv4();
      const gameId = uuidv4();
      testUserIds.push(userId);
      testGameIds.push(gameId);

      // Send 15 messages (exactly the limit)
      for (let i = 0; i < 15; i++) {
        await rateLimitService.recordMessage(userId, gameId);
      }

      // 16th message should be blocked
      const check = await rateLimitService.checkUserLimit(userId, gameId);
      expect(check.allowed).toBe(false);
      expect(check.retryAfter).toBeDefined();
      expect(check.retryAfter).toBeGreaterThan(0);
    });

    it('should reset limit after window expires', async () => {
      const userId = uuidv4();
      const gameId = uuidv4();
      testUserIds.push(userId);
      testGameIds.push(gameId);

      // Send 15 messages
      for (let i = 0; i < 15; i++) {
        await rateLimitService.recordMessage(userId, gameId);
      }

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
      const user1 = uuidv4();
      const user2 = uuidv4();
      const game1 = uuidv4();
      const game2 = uuidv4();
      testUserIds.push(user1, user2);
      testGameIds.push(game1, game2);

      // User1 in Game1: send 15 messages
      for (let i = 0; i < 15; i++) {
        await rateLimitService.recordMessage(user1, game1);
      }

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
      const userId = uuidv4();
      const gameId = uuidv4();
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
      const userId = uuidv4();
      const gameId = uuidv4();
      testUserIds.push(userId);
      testGameIds.push(gameId);

      const status = await rateLimitService.getUserStatus(userId, gameId);

      expect(status).toBeNull();
    });
  });

  describe('cleanupOldData', () => {
    it('should delete old rate limit records', async () => {
      const userId1 = uuidv4();
      const userId2 = uuidv4();
      const gameId = uuidv4();
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
      const userId = uuidv4();
      const gameId = uuidv4();
      testUserIds.push(userId);
      testGameIds.push(gameId);

      // Send 15 messages to hit limit
      for (let i = 0; i < 15; i++) {
        await rateLimitService.recordMessage(userId, gameId);
      }

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
