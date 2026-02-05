import { db } from '../db';

/**
 * Service for rate limiting chat messages per user per game
 * Implements a rolling window algorithm with 15 messages per minute limit
 */
export class RateLimitService {
  private readonly USER_LIMIT: number;
  private readonly WINDOW_MS: number;

  constructor() {
    this.USER_LIMIT = parseInt(
      process.env.CHAT_RATE_LIMIT_PER_MIN || '15',
      10
    );
    this.WINDOW_MS = 60000; // 1 minute
  }

  /**
   * Check if user is within rate limit
   */
  async checkUserLimit(
    userId: string,
    gameId: string
  ): Promise<{ allowed: boolean; retryAfter?: number }> {
    try {
      const now = new Date();
      const windowStart = new Date(now.getTime() - this.WINDOW_MS);

      // Get or create rate limit record
      const result = await db.query(
        `SELECT message_count, window_start, last_message_at
         FROM chat_rate_limits
         WHERE user_id = $1 AND game_id = $2`,
        [userId, gameId]
      );

      if (result.rows.length === 0) {
        // No record exists, user is within limit
        return { allowed: true };
      }

      const record = result.rows[0];
      const recordWindowStart = new Date(record.window_start);
      const lastMessageAt = new Date(record.last_message_at);

      // Check if current window has expired
      if (recordWindowStart < windowStart) {
        // Window expired, reset and allow
        await this.resetWindow(userId, gameId);
        return { allowed: true };
      }

      // Check if user has exceeded limit
      if (record.message_count >= this.USER_LIMIT) {
        // Calculate retry after (time until window expires)
        const windowEnd = new Date(
          recordWindowStart.getTime() + this.WINDOW_MS
        );
        const retryAfter = Math.ceil(
          (windowEnd.getTime() - now.getTime()) / 1000
        );

        console.log(
          `[RateLimit] User ${userId} in game ${gameId} exceeded limit (${record.message_count}/${this.USER_LIMIT}). Retry after ${retryAfter}s`
        );

        return { allowed: false, retryAfter };
      }

      // User is within limit
      return { allowed: true };
    } catch (error) {
      console.error('[RateLimit] Error checking user limit:', error);
      // Fail open: allow on error to prevent blocking legitimate users
      return { allowed: true };
    }
  }

  /**
   * Record a message sent by user
   */
  async recordMessage(userId: string, gameId: string): Promise<void> {
    try {
      const now = new Date();

      await db.query(
        `INSERT INTO chat_rate_limits (user_id, game_id, message_count, window_start, last_message_at)
         VALUES ($1, $2, 1, $3, $3)
         ON CONFLICT (user_id, game_id)
         DO UPDATE SET
           message_count = chat_rate_limits.message_count + 1,
           last_message_at = $3`,
        [userId, gameId, now]
      );
    } catch (error) {
      console.error('[RateLimit] Error recording message:', error);
      // Don't throw - rate limiting is not critical enough to block message sending
    }
  }

  /**
   * Reset rate limit window for user
   */
  private async resetWindow(userId: string, gameId: string): Promise<void> {
    try {
      const now = new Date();

      await db.query(
        `UPDATE chat_rate_limits
         SET message_count = 0,
             window_start = $3,
             last_message_at = $3
         WHERE user_id = $1 AND game_id = $2`,
        [userId, gameId, now]
      );
    } catch (error) {
      console.error('[RateLimit] Error resetting window:', error);
    }
  }

  /**
   * Get current rate limit status for a user
   */
  async getUserStatus(
    userId: string,
    gameId: string
  ): Promise<{
    messageCount: number;
    limit: number;
    windowStart: Date;
    windowEnd: Date;
  } | null> {
    try {
      const result = await db.query(
        `SELECT message_count, window_start
         FROM chat_rate_limits
         WHERE user_id = $1 AND game_id = $2`,
        [userId, gameId]
      );

      if (result.rows.length === 0) {
        return null;
      }

      const record = result.rows[0];
      const windowStart = new Date(record.window_start);
      const windowEnd = new Date(windowStart.getTime() + this.WINDOW_MS);

      return {
        messageCount: record.message_count,
        limit: this.USER_LIMIT,
        windowStart,
        windowEnd,
      };
    } catch (error) {
      console.error('[RateLimit] Error getting user status:', error);
      return null;
    }
  }

  /**
   * Clean up old rate limit data (called by cron job)
   * Removes records older than 24 hours
   */
  async cleanupOldData(): Promise<number> {
    try {
      const cutoffTime = new Date(Date.now() - 24 * 60 * 60 * 1000); // 24 hours ago

      const result = await db.query(
        `DELETE FROM chat_rate_limits
         WHERE last_message_at < $1
         RETURNING id`,
        [cutoffTime]
      );

      const deletedCount = result.rows.length;
      if (deletedCount > 0) {
        console.log(
          `[RateLimit] Cleaned up ${deletedCount} old rate limit records`
        );
      }

      return deletedCount;
    } catch (error) {
      console.error('[RateLimit] Error cleaning up old data:', error);
      return 0;
    }
  }

  /**
   * Reset rate limit for a specific user (admin function)
   */
  async resetUserLimit(userId: string, gameId: string): Promise<void> {
    try {
      await db.query(
        `DELETE FROM chat_rate_limits
         WHERE user_id = $1 AND game_id = $2`,
        [userId, gameId]
      );

      console.log(
        `[RateLimit] Reset rate limit for user ${userId} in game ${gameId}`
      );
    } catch (error) {
      console.error('[RateLimit] Error resetting user limit:', error);
      throw new Error('Failed to reset rate limit');
    }
  }
}

// Export singleton instance
export const rateLimitService = new RateLimitService();
