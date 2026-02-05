import { db } from '../db';

/**
 * Service for managing per-game chat message limits
 * Enforces 1000 message limit per game
 */
export class GameChatLimitService {
  private readonly GAME_LIMIT: number;

  constructor() {
    this.GAME_LIMIT = parseInt(process.env.GAME_MESSAGE_LIMIT || '1000', 10);
  }

  /**
   * Check if game has reached message limit
   */
  async checkGameLimit(gameId: string): Promise<boolean> {
    try {
      const result = await db.query(
        `SELECT total_messages
         FROM game_message_counts
         WHERE game_id = $1`,
        [gameId]
      );

      if (result.rows.length === 0) {
        // No record exists, game is within limit
        return true;
      }

      const totalMessages = result.rows[0].total_messages;

      if (totalMessages >= this.GAME_LIMIT) {
        console.log(
          `[GameChatLimit] Game ${gameId} has reached message limit (${totalMessages}/${this.GAME_LIMIT})`
        );
        return false;
      }

      return true;
    } catch (error) {
      console.error('[GameChatLimit] Error checking game limit:', error);
      // Fail open: allow on error to prevent blocking legitimate messages
      return true;
    }
  }

  /**
   * Increment game message count
   */
  async incrementGameCount(gameId: string): Promise<void> {
    try {
      const now = new Date();

      await db.query(
        `INSERT INTO game_message_counts (game_id, total_messages, updated_at)
         VALUES ($1, 1, $2)
         ON CONFLICT (game_id)
         DO UPDATE SET
           total_messages = game_message_counts.total_messages + 1,
           updated_at = $2`,
        [gameId, now]
      );
    } catch (error) {
      console.error('[GameChatLimit] Error incrementing game count:', error);
      // Don't throw - counting is not critical enough to block message sending
    }
  }

  /**
   * Get current message count for a game
   */
  async getGameCount(gameId: string): Promise<number> {
    try {
      const result = await db.query(
        `SELECT total_messages
         FROM game_message_counts
         WHERE game_id = $1`,
        [gameId]
      );

      if (result.rows.length === 0) {
        return 0;
      }

      return result.rows[0].total_messages;
    } catch (error) {
      console.error('[GameChatLimit] Error getting game count:', error);
      return 0;
    }
  }

  /**
   * Get game message status
   */
  async getGameStatus(
    gameId: string
  ): Promise<{ count: number; limit: number; remaining: number } | null> {
    try {
      const count = await this.getGameCount(gameId);

      return {
        count,
        limit: this.GAME_LIMIT,
        remaining: Math.max(0, this.GAME_LIMIT - count),
      };
    } catch (error) {
      console.error('[GameChatLimit] Error getting game status:', error);
      return null;
    }
  }

  /**
   * Reset game message count (admin function or game restart)
   */
  async resetGameCount(gameId: string): Promise<void> {
    try {
      await db.query(
        `DELETE FROM game_message_counts
         WHERE game_id = $1`,
        [gameId]
      );

      console.log(`[GameChatLimit] Reset message count for game ${gameId}`);
    } catch (error) {
      console.error('[GameChatLimit] Error resetting game count:', error);
      throw new Error('Failed to reset game message count');
    }
  }

  /**
   * Check if game is approaching limit (for warning users)
   */
  async isApproachingLimit(
    gameId: string,
    threshold: number = 0.9
  ): Promise<boolean> {
    try {
      const count = await this.getGameCount(gameId);
      const limitThreshold = this.GAME_LIMIT * threshold;

      return count >= limitThreshold;
    } catch (error) {
      console.error(
        '[GameChatLimit] Error checking approaching limit:',
        error
      );
      return false;
    }
  }

  /**
   * Get all games that have reached or are approaching the limit
   */
  async getGamesNearLimit(
    threshold: number = 0.9
  ): Promise<{ gameId: string; count: number; limit: number }[]> {
    try {
      const limitThreshold = Math.floor(this.GAME_LIMIT * threshold);

      const result = await db.query(
        `SELECT game_id, total_messages
         FROM game_message_counts
         WHERE total_messages >= $1
         ORDER BY total_messages DESC`,
        [limitThreshold]
      );

      return result.rows.map((row) => ({
        gameId: row.game_id,
        count: row.total_messages,
        limit: this.GAME_LIMIT,
      }));
    } catch (error) {
      console.error('[GameChatLimit] Error getting games near limit:', error);
      return [];
    }
  }
}

// Export singleton instance
export const gameChatLimitService = new GameChatLimitService();
