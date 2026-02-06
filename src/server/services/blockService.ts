import { db } from '../db';

export interface BlockedUser {
  userId: string;
  username: string;
  blockedAt: string;
}

/**
 * Service for managing user blocking/unblocking and block history
 */
export class BlockService {
  /**
   * Block a user (prevents chat communication)
   */
  static async blockUser(blockerId: string, blockedId: string): Promise<void> {
    if (blockerId === blockedId) {
      throw new Error('CANNOT_BLOCK_SELF');
    }

    try {
      // Check if block already exists
      const existingBlock = await db.query(
        'SELECT id FROM user_blocks WHERE blocker_user_id = $1 AND blocked_user_id = $2',
        [blockerId, blockedId]
      );

      if (existingBlock.rows.length > 0) {
        // Block already exists, no need to insert again
        console.log(`[Block] User ${blockerId} already has ${blockedId} blocked`);
        return;
      }

      // Insert block
      await db.query(
        `INSERT INTO user_blocks (blocker_user_id, blocked_user_id)
         VALUES ($1, $2)`,
        [blockerId, blockedId]
      );

      // Record in history
      await this.recordBlockHistory(blockerId, blockedId, 'block');

      console.log(`[Block] User ${blockerId} blocked ${blockedId}`);
    } catch (error) {
      console.error('[Block] Error blocking user:', error);
      throw new Error('Failed to block user');
    }
  }

  /**
   * Unblock a user
   */
  static async unblockUser(blockerId: string, blockedId: string): Promise<void> {
    try {
      // Delete block
      const result = await db.query(
        'DELETE FROM user_blocks WHERE blocker_user_id = $1 AND blocked_user_id = $2 RETURNING id',
        [blockerId, blockedId]
      );

      if (result.rows.length === 0) {
        // Block doesn't exist, nothing to unblock
        console.log(`[Block] User ${blockerId} does not have ${blockedId} blocked`);
        return;
      }

      // Record in history
      await this.recordBlockHistory(blockerId, blockedId, 'unblock');

      console.log(`[Block] User ${blockerId} unblocked ${blockedId}`);
    } catch (error) {
      console.error('[Block] Error unblocking user:', error);
      throw new Error('Failed to unblock user');
    }
  }

  /**
   * Get list of users blocked by a specific user
   */
  static async getBlockedUsers(userId: string): Promise<BlockedUser[]> {
    try {
      const result = await db.query(
        `SELECT 
           ub.blocked_user_id as user_id,
           u.username,
           ub.blocked_at
         FROM user_blocks ub
         JOIN users u ON ub.blocked_user_id = u.id
         WHERE ub.blocker_user_id = $1
         ORDER BY ub.blocked_at DESC`,
        [userId]
      );

      return result.rows.map(row => ({
        userId: row.user_id,
        username: row.username,
        blockedAt: row.blocked_at,
      }));
    } catch (error) {
      console.error('[Block] Error getting blocked users:', error);
      return [];
    }
  }

  /**
   * Check if user1 has blocked user2 (bidirectional check)
   */
  static async isBlocked(userId1: string, userId2: string): Promise<boolean> {
    try {
      const result = await db.query(
        `SELECT id FROM user_blocks 
         WHERE (blocker_user_id = $1 AND blocked_user_id = $2)
            OR (blocker_user_id = $2 AND blocked_user_id = $1)
         LIMIT 1`,
        [userId1, userId2]
      );

      return result.rows.length > 0;
    } catch (error) {
      console.error('[Block] Error checking block status:', error);
      return false;
    }
  }

  /**
   * Check if blocker has blocked blocked (one-way check)
   */
  static async hasBlocked(blockerId: string, blockedId: string): Promise<boolean> {
    try {
      const result = await db.query(
        'SELECT id FROM user_blocks WHERE blocker_user_id = $1 AND blocked_user_id = $2 LIMIT 1',
        [blockerId, blockedId]
      );

      return result.rows.length > 0;
    } catch (error) {
      console.error('[Block] Error checking has blocked:', error);
      return false;
    }
  }

  /**
   * Record block/unblock action in history for auditing
   */
  private static async recordBlockHistory(
    blockerId: string,
    blockedId: string,
    action: 'block' | 'unblock'
  ): Promise<void> {
    try {
      await db.query(
        `INSERT INTO block_history (blocker_user_id, blocked_user_id, action)
         VALUES ($1, $2, $3)`,
        [blockerId, blockedId, action]
      );
    } catch (error) {
      // Don't throw - history is for auditing, not critical
      console.error('[Block] Error recording block history:', error);
    }
  }

  /**
   * Get block history for a user (for admin/debugging purposes)
   */
  static async getBlockHistory(userId: string, limit: number = 50): Promise<any[]> {
    try {
      const result = await db.query(
        `SELECT 
           bh.blocker_user_id,
           bh.blocked_user_id,
           bh.action,
           bh.created_at,
           u1.username as blocker_username,
           u2.username as blocked_username
         FROM block_history bh
         LEFT JOIN users u1 ON bh.blocker_user_id = u1.id
         LEFT JOIN users u2 ON bh.blocked_user_id = u2.id
         WHERE bh.blocker_user_id = $1
         ORDER BY bh.created_at DESC
         LIMIT $2`,
        [userId, limit]
      );

      return result.rows;
    } catch (error) {
      console.error('[Block] Error getting block history:', error);
      return [];
    }
  }
}
