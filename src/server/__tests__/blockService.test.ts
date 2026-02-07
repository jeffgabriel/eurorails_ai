/**
 * BlockService Unit Tests
 * Tests for user blocking and unblocking functionality
 */

import { BlockService } from '../services/blockService';
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
async function cleanupTestUsers(userIds: string[]) {
  if (userIds.length > 0) {
    await runQuery(async (client) => {
      await client.query('DELETE FROM users WHERE id = ANY($1)', [userIds]);
    });
  }
}

describe('BlockService', () => {
  let testUserIds: string[] = [];

  afterEach(async () => {
    // Clean up test data
    await cleanupTestUsers(testUserIds);
    testUserIds = [];
  });

  afterAll(async () => {
    // Final cleanup
    await cleanupTestUsers(testUserIds);
  });

  describe('blockUser', () => {
    it('should block a user successfully', async () => {
      // Create test users
      const blockerId = uuidv4();
      const blockedId = uuidv4();

      await runQuery(async (client) => {
        await client.query(
          'INSERT INTO users (id, username, email, password_hash) VALUES ($1, $2, $3, $4), ($5, $6, $7, $8)',
          [blockerId, 'blocker', 'blocker@example.com', 'hash', blockedId, 'blocked', 'blocked@example.com', 'hash']
        );
      });
      testUserIds.push(blockerId, blockedId);

      await BlockService.blockUser(blockerId, blockedId);

      // Verify block was created
      const blockRecord = await runQuery(async (client) => {
        const result = await client.query('SELECT * FROM user_blocks WHERE blocker_user_id = $1 AND blocked_user_id = $2', [
          blockerId,
          blockedId,
        ]);
        return result.rows[0];
      });

      expect(blockRecord).toBeDefined();
      expect(blockRecord.blocker_user_id).toBe(blockerId);
      expect(blockRecord.blocked_user_id).toBe(blockedId);

      // Verify history record was created
      const historyRecord = await runQuery(async (client) => {
        const result = await client.query('SELECT * FROM block_history WHERE blocker_user_id = $1 AND blocked_user_id = $2', [
          blockerId,
          blockedId,
        ]);
        return result.rows[0];
      });

      expect(historyRecord).toBeDefined();
      expect(historyRecord.action).toBe('block');
    });

    it('should throw error when trying to block self', async () => {
      const userId = uuidv4();

      await runQuery(async (client) => {
        await client.query('INSERT INTO users (id, username, email, password_hash) VALUES ($1, $2, $3, $4)', [
          userId,
          'selfblocker',
          'selfblocker@example.com',
          'hash',
        ]);
      });
      testUserIds.push(userId);

      await expect(BlockService.blockUser(userId, userId)).rejects.toThrow('CANNOT_BLOCK_SELF');
    });

    it('should handle duplicate block attempts gracefully', async () => {
      const blockerId = uuidv4();
      const blockedId = uuidv4();

      await runQuery(async (client) => {
        await client.query(
          'INSERT INTO users (id, username, email, password_hash) VALUES ($1, $2, $3, $4), ($5, $6, $7, $8)',
          [blockerId, 'blocker2', 'blocker2@example.com', 'hash', blockedId, 'blocked2', 'blocked2@example.com', 'hash']
        );
      });
      testUserIds.push(blockerId, blockedId);

      await BlockService.blockUser(blockerId, blockedId);
      // Second block should not throw error
      await expect(BlockService.blockUser(blockerId, blockedId)).resolves.not.toThrow();
    });
  });

  describe('unblockUser', () => {
    it('should unblock a user successfully', async () => {
      const blockerId = uuidv4();
      const blockedId = uuidv4();

      await runQuery(async (client) => {
        await client.query(
          'INSERT INTO users (id, username, email, password_hash) VALUES ($1, $2, $3, $4), ($5, $6, $7, $8)',
          [blockerId, 'blocker3', 'blocker3@example.com', 'hash', blockedId, 'blocked3', 'blocked3@example.com', 'hash']
        );
      });
      testUserIds.push(blockerId, blockedId);

      // Block first
      await BlockService.blockUser(blockerId, blockedId);

      // Then unblock
      await BlockService.unblockUser(blockerId, blockedId);

      // Verify block was removed
      const blockRecord = await runQuery(async (client) => {
        const result = await client.query('SELECT * FROM user_blocks WHERE blocker_user_id = $1 AND blocked_user_id = $2', [
          blockerId,
          blockedId,
        ]);
        return result.rows[0];
      });

      expect(blockRecord).toBeUndefined();

      // Verify unblock history record was created
      const historyRecords = await runQuery(async (client) => {
        const result = await client.query(
          'SELECT * FROM block_history WHERE blocker_user_id = $1 AND blocked_user_id = $2 ORDER BY created_at DESC',
          [blockerId, blockedId]
        );
        return result.rows;
      });

      expect(historyRecords.length).toBeGreaterThanOrEqual(2);
      expect(historyRecords[0].action).toBe('unblock');
    });

    it('should handle unblocking non-blocked user gracefully', async () => {
      const blockerId = uuidv4();
      const blockedId = uuidv4();

      await runQuery(async (client) => {
        await client.query(
          'INSERT INTO users (id, username, email, password_hash) VALUES ($1, $2, $3, $4), ($5, $6, $7, $8)',
          [blockerId, 'blocker4', 'blocker4@example.com', 'hash', blockedId, 'blocked4', 'blocked4@example.com', 'hash']
        );
      });
      testUserIds.push(blockerId, blockedId);

      // Unblock without blocking first should not throw
      await expect(BlockService.unblockUser(blockerId, blockedId)).resolves.not.toThrow();
    });
  });

  describe('getBlockedUsers', () => {
    it('should return list of blocked users', async () => {
      const blockerId = uuidv4();
      const blocked1 = uuidv4();
      const blocked2 = uuidv4();

      await runQuery(async (client) => {
        await client.query(
          'INSERT INTO users (id, username, email, password_hash) VALUES ($1, $2, $3, $4), ($5, $6, $7, $8), ($9, $10, $11, $12)',
          [
            blockerId,
            'blocker5',
            'blocker5@example.com',
            'hash',
            blocked1,
            'blocked5',
            'blocked5@example.com',
            'hash',
            blocked2,
            'blocked6',
            'blocked6@example.com',
            'hash',
          ]
        );
      });
      testUserIds.push(blockerId, blocked1, blocked2);

      await BlockService.blockUser(blockerId, blocked1);
      await BlockService.blockUser(blockerId, blocked2);

      const blockedUsers = await BlockService.getBlockedUsers(blockerId);

      expect(blockedUsers.length).toBe(2);
      expect(blockedUsers[0].userId).toBeDefined();
      expect(blockedUsers[0].username).toBeDefined();
      expect(blockedUsers[0].blockedAt).toBeDefined();

      const userIds = blockedUsers.map((u) => u.userId);
      expect(userIds).toContain(blocked1);
      expect(userIds).toContain(blocked2);
    });

    it('should return empty array for user with no blocks', async () => {
      const userId = uuidv4();

      await runQuery(async (client) => {
        await client.query('INSERT INTO users (id, username, email, password_hash) VALUES ($1, $2, $3, $4)', [
          userId,
          'noblocker',
          'noblocker@example.com',
          'hash',
        ]);
      });
      testUserIds.push(userId);

      const blockedUsers = await BlockService.getBlockedUsers(userId);

      expect(blockedUsers).toEqual([]);
    });
  });

  describe('isBlocked', () => {
    it('should return true when users have blocked each other', async () => {
      const user1 = uuidv4();
      const user2 = uuidv4();

      await runQuery(async (client) => {
        await client.query(
          'INSERT INTO users (id, username, email, password_hash) VALUES ($1, $2, $3, $4), ($5, $6, $7, $8)',
          [user1, 'user1', 'user1@example.com', 'hash', user2, 'user2', 'user2@example.com', 'hash']
        );
      });
      testUserIds.push(user1, user2);

      await BlockService.blockUser(user1, user2);

      const isBlocked = await BlockService.isBlocked(user1, user2);

      expect(isBlocked).toBe(true);
    });

    it('should return true when either user has blocked the other', async () => {
      const user1 = uuidv4();
      const user2 = uuidv4();

      await runQuery(async (client) => {
        await client.query(
          'INSERT INTO users (id, username, email, password_hash) VALUES ($1, $2, $3, $4), ($5, $6, $7, $8)',
          [user1, 'user3', 'user3@example.com', 'hash', user2, 'user4', 'user4@example.com', 'hash']
        );
      });
      testUserIds.push(user1, user2);

      await BlockService.blockUser(user2, user1);

      // Check from either direction
      const isBlocked1 = await BlockService.isBlocked(user1, user2);
      const isBlocked2 = await BlockService.isBlocked(user2, user1);

      expect(isBlocked1).toBe(true);
      expect(isBlocked2).toBe(true);
    });

    it('should return false when users have not blocked each other', async () => {
      const user1 = uuidv4();
      const user2 = uuidv4();

      await runQuery(async (client) => {
        await client.query(
          'INSERT INTO users (id, username, email, password_hash) VALUES ($1, $2, $3, $4), ($5, $6, $7, $8)',
          [user1, 'user5', 'user5@example.com', 'hash', user2, 'user6', 'user6@example.com', 'hash']
        );
      });
      testUserIds.push(user1, user2);

      const isBlocked = await BlockService.isBlocked(user1, user2);

      expect(isBlocked).toBe(false);
    });
  });

  describe('hasBlocked', () => {
    it('should return true when blocker has blocked target', async () => {
      const blockerId = uuidv4();
      const blockedId = uuidv4();

      await runQuery(async (client) => {
        await client.query(
          'INSERT INTO users (id, username, email, password_hash) VALUES ($1, $2, $3, $4), ($5, $6, $7, $8)',
          [blockerId, 'blocker6', 'blocker6@example.com', 'hash', blockedId, 'blocked7', 'blocked7@example.com', 'hash']
        );
      });
      testUserIds.push(blockerId, blockedId);

      await BlockService.blockUser(blockerId, blockedId);

      const hasBlocked = await BlockService.hasBlocked(blockerId, blockedId);

      expect(hasBlocked).toBe(true);
    });

    it('should return false when blocker has not blocked target', async () => {
      const blockerId = uuidv4();
      const blockedId = uuidv4();

      await runQuery(async (client) => {
        await client.query(
          'INSERT INTO users (id, username, email, password_hash) VALUES ($1, $2, $3, $4), ($5, $6, $7, $8)',
          [blockerId, 'blocker7', 'blocker7@example.com', 'hash', blockedId, 'blocked8', 'blocked8@example.com', 'hash']
        );
      });
      testUserIds.push(blockerId, blockedId);

      const hasBlocked = await BlockService.hasBlocked(blockerId, blockedId);

      expect(hasBlocked).toBe(false);
    });

    it('should be directional (not bidirectional)', async () => {
      const user1 = uuidv4();
      const user2 = uuidv4();

      await runQuery(async (client) => {
        await client.query(
          'INSERT INTO users (id, username, email, password_hash) VALUES ($1, $2, $3, $4), ($5, $6, $7, $8)',
          [user1, 'user7', 'user7@example.com', 'hash', user2, 'user8', 'user8@example.com', 'hash']
        );
      });
      testUserIds.push(user1, user2);

      await BlockService.blockUser(user1, user2);

      const user1BlockedUser2 = await BlockService.hasBlocked(user1, user2);
      const user2BlockedUser1 = await BlockService.hasBlocked(user2, user1);

      expect(user1BlockedUser2).toBe(true);
      expect(user2BlockedUser1).toBe(false);
    });
  });
});
