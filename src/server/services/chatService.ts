import { db } from '../db';
import { BlockService } from './blockService';
import { VerificationService } from './verificationService';

export interface ChatMessage {
  id: number;
  gameId: string;
  senderUserId: string;
  senderUsername: string;
  recipientType: 'game' | 'player';
  recipientId: string;
  messageText: string;
  isRead: boolean;
  createdAt: string;
}

export interface MessagePage {
  messages: ChatMessage[];
  hasMore: boolean;
  totalPages: number;
  currentPage: number;
}

export interface UnreadCounts {
  total: number;
  byRecipient: Record<string, number>;
}

export interface ValidationResult {
  valid: boolean;
  error?: string;
  details?: string;
}

/**
 * Service for managing chat messages and permissions
 */
export class ChatService {
  /**
   * Validate that sender can send message to recipient
   */
  static async validateChatPermissions(
    senderId: string,
    recipientType: 'game' | 'player',
    recipientId: string,
    gameId: string
  ): Promise<ValidationResult> {
    try {
      // 1. Check if sender is in the game
      const senderInGame = await this.isUserInGame(senderId, gameId);
      if (!senderInGame) {
        return {
          valid: false,
          error: 'USER_NOT_IN_GAME',
          details: 'You must be in the game to send messages',
        };
      }

      // 2. Check if game is active (not completed)
      const gameActive = await this.isGameActive(gameId);
      if (!gameActive) {
        return {
          valid: false,
          error: 'GAME_ENDED',
          details: 'Chat is disabled when game ends',
        };
      }

      // 3. Check if sender's email is verified
      const senderVerified = await VerificationService.isEmailVerified(senderId);
      if (!senderVerified) {
        return {
          valid: false,
          error: 'EMAIL_NOT_VERIFIED',
          details: 'Please verify your email to use chat',
        };
      }

      // 4. Check if sender has chat enabled
      const senderChatEnabled = await this.isChatEnabled(senderId);
      if (!senderChatEnabled) {
        return {
          valid: false,
          error: 'CHAT_DISABLED',
          details: 'You have chat disabled in settings',
        };
      }

      // 5. If recipient is a player (DM), validate recipient
      if (recipientType === 'player') {
        // Check if recipient is in the game
        const recipientInGame = await this.isUserInGame(recipientId, gameId);
        if (!recipientInGame) {
          return {
            valid: false,
            error: 'RECIPIENT_NOT_IN_GAME',
            details: 'Recipient is not in this game',
          };
        }

        // Check if recipient has chat enabled
        const recipientChatEnabled = await this.isChatEnabled(recipientId);
        if (!recipientChatEnabled) {
          return {
            valid: false,
            error: 'RECIPIENT_CHAT_DISABLED',
            details: 'Recipient has chat disabled',
          };
        }

        // Check if users have blocked each other
        const isBlocked = await BlockService.isBlocked(senderId, recipientId);
        if (isBlocked) {
          return {
            valid: false,
            error: 'USER_BLOCKED',
            details: 'Cannot send messages to this user',
          };
        }
      }

      return { valid: true };
    } catch (error) {
      console.error('[ChatService] Error validating permissions:', error);
      return {
        valid: false,
        error: 'VALIDATION_ERROR',
        details: 'Failed to validate permissions',
      };
    }
  }

  /**
   * Check if two users have blocked each other
   */
  static async checkBlockStatus(
    userId1: string,
    userId2: string
  ): Promise<boolean> {
    return BlockService.isBlocked(userId1, userId2);
  }

  /**
   * Store a chat message
   */
  static async storeMessage(message: {
    gameId: string;
    senderUserId: string;
    recipientType: 'game' | 'player';
    recipientId: string;
    messageText: string;
  }): Promise<number> {
    try {
      const result = await db.query(
        `INSERT INTO chat_messages (game_id, sender_user_id, recipient_type, recipient_id, message_text)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id`,
        [
          message.gameId,
          message.senderUserId,
          message.recipientType,
          message.recipientId,
          message.messageText,
        ]
      );

      return result.rows[0].id;
    } catch (error) {
      console.error('[ChatService] Error storing message:', error);
      throw new Error('Failed to store message');
    }
  }

  /**
   * Get paginated messages for a conversation
   */
  static async getMessages(
    gameId: string,
    recipientType: 'game' | 'player',
    recipientId: string,
    userId: string,
    page: number = 1,
    limit: number = 30
  ): Promise<MessagePage> {
    try {
      // Ensure limit doesn't exceed 30
      const safeLimit = Math.min(limit, 30);
      const offset = (page - 1) * safeLimit;

      // For DMs, get messages where:
      // - (sender = userId AND recipient = recipientId) OR
      // - (sender = recipientId AND recipient = userId)
      // For game chat, get messages where recipient_type = 'game'

      let query: string;
      let params: any[];

      if (recipientType === 'player') {
        // Direct messages - bidirectional
        query = `
          SELECT 
            cm.id,
            cm.game_id,
            cm.sender_user_id,
            u.username as sender_username,
            cm.recipient_type,
            cm.recipient_id,
            cm.message_text,
            cm.is_read,
            cm.created_at
          FROM chat_messages cm
          JOIN users u ON cm.sender_user_id = u.id
          WHERE cm.game_id = $1
            AND cm.recipient_type = 'player'
            AND (
              (cm.sender_user_id = $2 AND cm.recipient_id = $3)
              OR (cm.sender_user_id = $3 AND cm.recipient_id = $2)
            )
          ORDER BY cm.created_at DESC
          LIMIT $4 OFFSET $5
        `;
        params = [gameId, userId, recipientId, safeLimit, offset];
      } else {
        // Game chat - all messages to game
        query = `
          SELECT 
            cm.id,
            cm.game_id,
            cm.sender_user_id,
            u.username as sender_username,
            cm.recipient_type,
            cm.recipient_id,
            cm.message_text,
            cm.is_read,
            cm.created_at
          FROM chat_messages cm
          JOIN users u ON cm.sender_user_id = u.id
          WHERE cm.game_id = $1
            AND cm.recipient_type = 'game'
          ORDER BY cm.created_at DESC
          LIMIT $2 OFFSET $3
        `;
        params = [gameId, safeLimit, offset];
      }

      const result = await db.query(query, params);

      // Get total count for pagination
      let countQuery: string;
      let countParams: any[];

      if (recipientType === 'player') {
        countQuery = `
          SELECT COUNT(*) as total
          FROM chat_messages
          WHERE game_id = $1
            AND recipient_type = 'player'
            AND (
              (sender_user_id = $2 AND recipient_id = $3)
              OR (sender_user_id = $3 AND recipient_id = $2)
            )
        `;
        countParams = [gameId, userId, recipientId];
      } else {
        countQuery = `
          SELECT COUNT(*) as total
          FROM chat_messages
          WHERE game_id = $1
            AND recipient_type = 'game'
        `;
        countParams = [gameId];
      }

      const countResult = await db.query(countQuery, countParams);
      const total = parseInt(countResult.rows[0].total, 10);
      const totalPages = Math.ceil(total / safeLimit);

      const messages: ChatMessage[] = result.rows.map((row) => ({
        id: row.id,
        gameId: row.game_id,
        senderUserId: row.sender_user_id,
        senderUsername: row.sender_username,
        recipientType: row.recipient_type,
        recipientId: row.recipient_id,
        messageText: row.message_text,
        isRead: row.is_read,
        createdAt: row.created_at,
      }));

      // Reverse to show oldest first
      messages.reverse();

      return {
        messages,
        hasMore: page < totalPages,
        totalPages,
        currentPage: page,
      };
    } catch (error) {
      console.error('[ChatService] Error getting messages:', error);
      throw new Error('Failed to get messages');
    }
  }

  /**
   * Get unread message counts for a user in a game
   */
  static async getUnreadCounts(
    gameId: string,
    userId: string
  ): Promise<UnreadCounts> {
    try {
      // Get unread counts grouped by sender/conversation
      const result = await db.query(
        `SELECT 
           cm.recipient_type,
           CASE 
             WHEN cm.recipient_type = 'game' THEN cm.game_id
             ELSE cm.sender_user_id
           END as conversation_id,
           COUNT(*) as unread_count
         FROM chat_messages cm
         WHERE cm.game_id = $1
           AND cm.is_read = false
           AND (
             (cm.recipient_type = 'game')
             OR (cm.recipient_type = 'player' AND cm.recipient_id = $2)
           )
           AND cm.sender_user_id != $2
         GROUP BY cm.recipient_type, conversation_id`,
        [gameId, userId]
      );

      const byRecipient: Record<string, number> = {};
      let total = 0;

      for (const row of result.rows) {
        const count = parseInt(row.unread_count, 10);
        byRecipient[row.conversation_id] = count;
        total += count;
      }

      return { total, byRecipient };
    } catch (error) {
      console.error('[ChatService] Error getting unread counts:', error);
      return { total: 0, byRecipient: {} };
    }
  }

  /**
   * Mark messages as read
   */
  static async markAsRead(messageIds: number[]): Promise<void> {
    // Input validation
    if (!Array.isArray(messageIds)) {
      throw new Error('messageIds must be an array');
    }
    
    if (messageIds.length === 0) {
      return;
    }
    
    // Validate all IDs are valid numbers/strings (BIGSERIAL can be returned as string)
    if (!messageIds.every(id => typeof id === 'number' || typeof id === 'string')) {
      throw new Error('All message IDs must be numbers or numeric strings');
    }

    try {
      await db.query(
        `UPDATE chat_messages
         SET is_read = true
         WHERE id = ANY($1::bigint[])`,
        [messageIds]
      );
    } catch (error) {
      console.error('[ChatService] Error marking messages as read:', error);
      throw new Error('Failed to mark messages as read');
    }
  }

  /**
   * Check if user is in a game
   */
  private static async isUserInGame(
    userId: string,
    gameId: string
  ): Promise<boolean> {
    try {
      const result = await db.query(
        `SELECT id FROM players
         WHERE user_id = $1 AND game_id = $2
         LIMIT 1`,
        [userId, gameId]
      );

      return result.rows.length > 0;
    } catch (error) {
      console.error('[ChatService] Error checking user in game:', error);
      return false;
    }
  }

  /**
   * Check if game is active (not completed)
   */
  private static async isGameActive(gameId: string): Promise<boolean> {
    try {
      const result = await db.query(
        `SELECT status FROM games WHERE id = $1`,
        [gameId]
      );

      if (result.rows.length === 0) {
        return false;
      }

      const status = result.rows[0].status;
      // Chat is disabled when game is completed
      return status !== 'completed';
    } catch (error) {
      console.error('[ChatService] Error checking game status:', error);
      return false;
    }
  }

  /**
   * Check if user has chat enabled
   */
  private static async isChatEnabled(userId: string): Promise<boolean> {
    try {
      const result = await db.query(
        `SELECT chat_enabled FROM users WHERE id = $1`,
        [userId]
      );

      if (result.rows.length === 0) {
        return false;
      }

      return result.rows[0].chat_enabled === true;
    } catch (error) {
      console.error('[ChatService] Error checking chat enabled:', error);
      return false;
    }
  }

  /**
   * Get all players in a game (for chat UI)
   */
  static async getGamePlayers(
    gameId: string
  ): Promise<{ userId: string; username: string; playerId: string }[]> {
    try {
      const result = await db.query(
        `SELECT p.id as player_id, p.user_id, u.username
         FROM players p
         JOIN users u ON p.user_id = u.id
         WHERE p.game_id = $1
           AND p.is_deleted = false
         ORDER BY u.username`,
        [gameId]
      );

      return result.rows.map((row) => ({
        userId: row.user_id,
        username: row.username,
        playerId: row.player_id,
      }));
    } catch (error) {
      console.error('[ChatService] Error getting game players:', error);
      return [];
    }
  }

  /**
   * Get sender username by user ID
   */
  static async getSenderUsername(userId: string): Promise<string | null> {
    try {
      const result = await db.query(
        `SELECT username FROM users WHERE id = $1`,
        [userId]
      );

      if (result.rows.length === 0) {
        return null;
      }

      return result.rows[0].username;
    } catch (error) {
      console.error('[ChatService] Error getting sender username:', error);
      return null;
    }
  }
}
