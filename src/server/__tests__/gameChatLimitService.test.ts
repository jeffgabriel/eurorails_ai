/**
 * GameChatLimitService Unit Tests
 * Tests for per-game chat message limits (1000 messages)
 */

import { gameChatLimitService } from '../services/gameChatLimitService';
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

// Helper function to clean up test data
async function cleanupTestData(gameIds: string[]) {
  if (gameIds.length > 0) {
    await runQuery(async (client) => {
      await client.query('DELETE FROM game_message_counts WHERE game_id = ANY($1)', [gameIds]);
      await client.query('DELETE FROM games WHERE id = ANY($1)', [gameIds]);
    });
  }
}

describe('GameChatLimitService', () => {
  let testGameIds: string[] = [];

  afterEach(async () => {
    // Clean up test data
    await cleanupTestData(testGameIds);
    testGameIds = [];
  });

  afterAll(async () => {
    // Final cleanup
    await cleanupTestData(testGameIds);
  });

  describe('checkGameLimit', () => {
    it('should allow messages within limit', async () => {
      const gameId = await createTestGame();
      testGameIds.push(gameId);

      // Add 100 messages (well under limit of 1000)
      for (let i = 0; i < 100; i++) {
        await gameChatLimitService.incrementGameCount(gameId);
      }

      const allowed = await gameChatLimitService.checkGameLimit(gameId);

      expect(allowed).toBe(true);
    });

    it('should block messages after limit exceeded', async () => {
      const gameId = await createTestGame();
      testGameIds.push(gameId);

      // Use service method but speed up by doing batches
      // Do 100 iterations (fast enough for testing)
      for (let i = 0; i < 100; i++) {
        await gameChatLimitService.incrementGameCount(gameId);
      }

      // Manually set to exactly 1000 after service initialized the record
      await runQuery(async (client) => {
        await client.query(
          `UPDATE game_message_counts SET total_messages = $2 WHERE game_id = $1`,
          [gameId, 1000]
        );
      });

      const allowed = await gameChatLimitService.checkGameLimit(gameId);

      expect(allowed).toBe(false);
    });

    it('should return true for games with no messages', async () => {
      const gameId = await createTestGame();
      testGameIds.push(gameId);

      const allowed = await gameChatLimitService.checkGameLimit(gameId);

      expect(allowed).toBe(true);
    });
  });

  describe('getGameCount', () => {
    it('should return current message count', async () => {
      const gameId = await createTestGame();
      testGameIds.push(gameId);

      // Add 50 messages
      for (let i = 0; i < 50; i++) {
        await gameChatLimitService.incrementGameCount(gameId);
      }

      const count = await gameChatLimitService.getGameCount(gameId);

      expect(count).toBe(50);
    });

    it('should return 0 for games with no messages', async () => {
      const gameId = await createTestGame();
      testGameIds.push(gameId);

      const count = await gameChatLimitService.getGameCount(gameId);

      expect(count).toBe(0);
    });
  });

  describe('getGameStatus', () => {
    it('should return game status with count and remaining', async () => {
      const gameId = await createTestGame();
      testGameIds.push(gameId);

      // Add 750 messages
      for (let i = 0; i < 750; i++) {
        await gameChatLimitService.incrementGameCount(gameId);
      }

      const status = await gameChatLimitService.getGameStatus(gameId);

      expect(status).toBeDefined();
      expect(status?.count).toBe(750);
      expect(status?.limit).toBe(1000);
      expect(status?.remaining).toBe(250);
    });

    it('should return 0 remaining when at limit', async () => {
      const gameId = await createTestGame();
      testGameIds.push(gameId);

      // Add 1000 messages
      for (let i = 0; i < 1000; i++) {
        await gameChatLimitService.incrementGameCount(gameId);
      }

      const status = await gameChatLimitService.getGameStatus(gameId);

      expect(status).toBeDefined();
      expect(status?.count).toBe(1000);
      expect(status?.remaining).toBe(0);
    });
  });

  describe('isApproachingLimit', () => {
    it('should return true when approaching 90% limit', async () => {
      const gameId = await createTestGame();
      testGameIds.push(gameId);

      // Add 900 messages (90% of limit)
      for (let i = 0; i < 900; i++) {
        await gameChatLimitService.incrementGameCount(gameId);
      }

      const approaching = await gameChatLimitService.isApproachingLimit(gameId);

      expect(approaching).toBe(true);
    });

    it('should return false when below threshold', async () => {
      const gameId = await createTestGame();
      testGameIds.push(gameId);

      // Add 500 messages (50% of limit)
      for (let i = 0; i < 500; i++) {
        await gameChatLimitService.incrementGameCount(gameId);
      }

      const approaching = await gameChatLimitService.isApproachingLimit(gameId);

      expect(approaching).toBe(false);
    });

    it('should support custom threshold', async () => {
      const gameId = await createTestGame();
      testGameIds.push(gameId);

      // Add 800 messages (80% of limit)
      for (let i = 0; i < 800; i++) {
        await gameChatLimitService.incrementGameCount(gameId);
      }

      // Check with 75% threshold
      const approaching75 = await gameChatLimitService.isApproachingLimit(gameId, 0.75);
      expect(approaching75).toBe(true);

      // Check with 85% threshold
      const approaching85 = await gameChatLimitService.isApproachingLimit(gameId, 0.85);
      expect(approaching85).toBe(false);
    });
  });

  describe('resetGameCount', () => {
    it('should reset game message count', async () => {
      const gameId = await createTestGame();
      testGameIds.push(gameId);

      // Add 1000 messages to hit limit
      for (let i = 0; i < 1000; i++) {
        await gameChatLimitService.incrementGameCount(gameId);
      }

      // Verify at limit
      const blockedBefore = await gameChatLimitService.checkGameLimit(gameId);
      expect(blockedBefore).toBe(false);

      // Reset count
      await gameChatLimitService.resetGameCount(gameId);

      // Should now be allowed
      const allowedAfter = await gameChatLimitService.checkGameLimit(gameId);
      expect(allowedAfter).toBe(true);

      // Count should be 0
      const count = await gameChatLimitService.getGameCount(gameId);
      expect(count).toBe(0);
    });
  });

  describe('getGamesNearLimit', () => {
    it('should return games approaching limit', async () => {
      const game1 = await createTestGame();
      const game2 = await createTestGame();
      const game3 = await createTestGame();
      testGameIds.push(game1, game2, game3);

      // Game1: 950 messages (95%)
      for (let i = 0; i < 950; i++) {
        await gameChatLimitService.incrementGameCount(game1);
      }

      // Game2: 100 messages (10%)
      for (let i = 0; i < 100; i++) {
        await gameChatLimitService.incrementGameCount(game2);
      }

      // Game3: 920 messages (92%)
      for (let i = 0; i < 920; i++) {
        await gameChatLimitService.incrementGameCount(game3);
      }

      const gamesNearLimit = await gameChatLimitService.getGamesNearLimit(0.9);

      expect(gamesNearLimit.length).toBe(2);
      expect(gamesNearLimit[0].gameId).toBe(game1); // Highest count first
      expect(gamesNearLimit[0].count).toBe(950);
      expect(gamesNearLimit[1].gameId).toBe(game3);
      expect(gamesNearLimit[1].count).toBe(920);
    });

    it('should return empty array when no games near limit', async () => {
      const gameId = await createTestGame();
      testGameIds.push(gameId);

      // Add 100 messages (10%)
      for (let i = 0; i < 100; i++) {
        await gameChatLimitService.incrementGameCount(gameId);
      }

      const gamesNearLimit = await gameChatLimitService.getGamesNearLimit(0.9);

      expect(gamesNearLimit.length).toBe(0);
    });
  });

  describe('incrementGameCount', () => {
    it('should increment count correctly', async () => {
      const gameId = await createTestGame();
      testGameIds.push(gameId);

      await gameChatLimitService.incrementGameCount(gameId);
      await gameChatLimitService.incrementGameCount(gameId);
      await gameChatLimitService.incrementGameCount(gameId);

      const count = await gameChatLimitService.getGameCount(gameId);

      expect(count).toBe(3);
    });

    it('should handle concurrent increments', async () => {
      const gameId = await createTestGame();
      testGameIds.push(gameId);

      // Simulate concurrent increments
      await Promise.all([
        gameChatLimitService.incrementGameCount(gameId),
        gameChatLimitService.incrementGameCount(gameId),
        gameChatLimitService.incrementGameCount(gameId),
        gameChatLimitService.incrementGameCount(gameId),
        gameChatLimitService.incrementGameCount(gameId),
      ]);

      const count = await gameChatLimitService.getGameCount(gameId);

      expect(count).toBe(5);
    });
  });
});
