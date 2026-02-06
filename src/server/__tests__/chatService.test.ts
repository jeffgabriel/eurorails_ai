/**
 * ChatService Unit Tests
 * Tests for chat message management and permissions
 */

import { ChatService } from '../services/chatService';
import { db } from '../db';
import { v4 as uuidv4 } from 'uuid';

// Mock services that ChatService depends on
jest.mock('../services/blockService', () => ({
  BlockService: {
    isBlocked: jest.fn().mockResolvedValue(false),
  },
}));

jest.mock('../services/verificationService', () => ({
  VerificationService: {
    isEmailVerified: jest.fn().mockResolvedValue(true),
  },
}));

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
async function createTestUser(username: string, email: string, chatEnabled: boolean = true): Promise<string> {
  const userId = uuidv4();
  await runQuery(async (client) => {
    await client.query(
      'INSERT INTO users (id, username, email, password_hash, email_verified, chat_enabled) VALUES ($1, $2, $3, $4, $5, $6)',
      [userId, username, email, 'hash', true, chatEnabled]
    );
  });
  return userId;
}

// Helper function to add player to game
async function addPlayerToGame(userId: string, gameId: string): Promise<string> {
  const playerId = uuidv4();
  await runQuery(async (client) => {
    await client.query(
      'INSERT INTO players (id, user_id, game_id, name, color, is_deleted) VALUES ($1, $2, $3, $4, $5, $6)',
      [playerId, userId, gameId, 'Test Player', '#FF0000', false]
    );
  });
  return playerId;
}

// Helper function to clean up test data
async function cleanupTestData(userIds: string[], gameIds: string[]) {
  await runQuery(async (client) => {
    if (userIds.length > 0) {
      await client.query('DELETE FROM chat_messages WHERE sender_user_id = ANY($1)', [userIds]);
      await client.query('DELETE FROM players WHERE user_id = ANY($1)', [userIds]);
      await client.query('DELETE FROM users WHERE id = ANY($1)', [userIds]);
    }
    if (gameIds.length > 0) {
      await client.query('DELETE FROM games WHERE id = ANY($1)', [gameIds]);
    }
  });
}

describe('ChatService', () => {
  let testUserIds: string[] = [];
  let testGameIds: string[] = [];

  beforeEach(() => {
    jest.clearAllMocks();
  });

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

  describe('validateChatPermissions', () => {
    it('should allow message when all conditions are met', async () => {
      const gameId = await createTestGame();
      testGameIds.push(gameId);

      const userId = await createTestUser('testuser', 'test@example.com', true);
      testUserIds.push(userId);

      await addPlayerToGame(userId, gameId);

      const validation = await ChatService.validateChatPermissions(userId, 'game', gameId, gameId);

      expect(validation.valid).toBe(true);
    });

    it('should reject when user is not in game', async () => {
      const gameId = await createTestGame();
      testGameIds.push(gameId);

      const userId = await createTestUser('testuser2', 'test2@example.com');
      testUserIds.push(userId);

      // Don't add player to game

      const validation = await ChatService.validateChatPermissions(userId, 'game', gameId, gameId);

      expect(validation.valid).toBe(false);
      expect(validation.error).toBe('USER_NOT_IN_GAME');
    });

    it('should reject when game is completed', async () => {
      const gameId = uuidv4();
      testGameIds.push(gameId);

      // Create completed game
      await runQuery(async (client) => {
        await client.query(
          `INSERT INTO games (id, status) VALUES ($1, $2)`,
          [gameId, 'completed']
        );
      });

      const userId = await createTestUser('testuser3', 'test3@example.com');
      testUserIds.push(userId);

      await addPlayerToGame(userId, gameId);

      const validation = await ChatService.validateChatPermissions(userId, 'game', gameId, gameId);

      expect(validation.valid).toBe(false);
      expect(validation.error).toBe('GAME_ENDED');
    });

    it('should reject when sender has chat disabled', async () => {
      const gameId = await createTestGame();
      testGameIds.push(gameId);

      const userId = await createTestUser('testuser4', 'test4@example.com', false);
      testUserIds.push(userId);

      await addPlayerToGame(userId, gameId);

      const validation = await ChatService.validateChatPermissions(userId, 'game', gameId, gameId);

      expect(validation.valid).toBe(false);
      expect(validation.error).toBe('CHAT_DISABLED');
    });

    it('should reject DM when recipient has chat disabled', async () => {
      const gameId = await createTestGame();
      testGameIds.push(gameId);

      const senderId = await createTestUser('sender', 'sender@example.com', true);
      const recipientId = await createTestUser('recipient', 'recipient@example.com', false);
      testUserIds.push(senderId, recipientId);

      await addPlayerToGame(senderId, gameId);
      await addPlayerToGame(recipientId, gameId);

      const validation = await ChatService.validateChatPermissions(senderId, 'player', recipientId, gameId);

      expect(validation.valid).toBe(false);
      expect(validation.error).toBe('RECIPIENT_CHAT_DISABLED');
    });

    it('should reject DM when recipient is not in game', async () => {
      const gameId = await createTestGame();
      testGameIds.push(gameId);

      const senderId = await createTestUser('sender2', 'sender2@example.com');
      const recipientId = await createTestUser('recipient2', 'recipient2@example.com');
      testUserIds.push(senderId, recipientId);

      await addPlayerToGame(senderId, gameId);
      // Don't add recipient to game

      const validation = await ChatService.validateChatPermissions(senderId, 'player', recipientId, gameId);

      expect(validation.valid).toBe(false);
      expect(validation.error).toBe('RECIPIENT_NOT_IN_GAME');
    });
  });

  describe('storeMessage', () => {
    it('should store a game chat message', async () => {
      const gameId = await createTestGame();
      testGameIds.push(gameId);

      const userId = await createTestUser('testuser5', 'test5@example.com');
      testUserIds.push(userId);

      const messageId = await ChatService.storeMessage({
        gameId,
        senderUserId: userId,
        recipientType: 'game',
        recipientId: gameId,
        messageText: 'Hello everyone!',
      });

      expect(messageId).toBeDefined();
      // BIGSERIAL returns bigint which can be string or number in JS
      expect(['number', 'string']).toContain(typeof messageId);

      // Verify message was stored
      const message = await runQuery(async (client) => {
        const result = await client.query('SELECT * FROM chat_messages WHERE id = $1', [messageId]);
        return result.rows[0];
      });

      expect(message).toBeDefined();
      expect(message.sender_user_id).toBe(userId);
      expect(message.message_text).toBe('Hello everyone!');
      expect(message.recipient_type).toBe('game');
    });

    it('should store a DM', async () => {
      const gameId = await createTestGame();
      testGameIds.push(gameId);

      const senderId = await createTestUser('sender3', 'sender3@example.com');
      const recipientId = await createTestUser('recipient3', 'recipient3@example.com');
      testUserIds.push(senderId, recipientId);

      const messageId = await ChatService.storeMessage({
        gameId,
        senderUserId: senderId,
        recipientType: 'player',
        recipientId,
        messageText: 'Private message',
      });

      expect(messageId).toBeDefined();

      // Verify message was stored
      const message = await runQuery(async (client) => {
        const result = await client.query('SELECT * FROM chat_messages WHERE id = $1', [messageId]);
        return result.rows[0];
      });

      expect(message.recipient_type).toBe('player');
      expect(message.recipient_id).toBe(recipientId);
    });
  });

  describe('getMessages', () => {
    it('should retrieve game chat messages', async () => {
      const gameId = await createTestGame();
      testGameIds.push(gameId);

      const user1 = await createTestUser('user1', 'user1@example.com');
      const user2 = await createTestUser('user2', 'user2@example.com');
      testUserIds.push(user1, user2);

      await addPlayerToGame(user1, gameId);
      await addPlayerToGame(user2, gameId);

      // Store some messages
      await ChatService.storeMessage({
        gameId,
        senderUserId: user1,
        recipientType: 'game',
        recipientId: gameId,
        messageText: 'Message 1',
      });
      await ChatService.storeMessage({
        gameId,
        senderUserId: user2,
        recipientType: 'game',
        recipientId: gameId,
        messageText: 'Message 2',
      });

      const messagePage = await ChatService.getMessages(gameId, 'game', gameId, user1, 1, 30);

      expect(messagePage.messages.length).toBe(2);
      expect(messagePage.messages[0].messageText).toBe('Message 1');
      expect(messagePage.messages[1].messageText).toBe('Message 2');
      expect(messagePage.hasMore).toBe(false);
      expect(messagePage.currentPage).toBe(1);
    });

    it('should retrieve DM messages bidirectionally', async () => {
      const gameId = await createTestGame();
      testGameIds.push(gameId);

      const user1 = await createTestUser('user3', 'user3@example.com');
      const user2 = await createTestUser('user4', 'user4@example.com');
      testUserIds.push(user1, user2);

      await addPlayerToGame(user1, gameId);
      await addPlayerToGame(user2, gameId);

      // Store messages in both directions
      await ChatService.storeMessage({
        gameId,
        senderUserId: user1,
        recipientType: 'player',
        recipientId: user2,
        messageText: 'User1 to User2',
      });
      await ChatService.storeMessage({
        gameId,
        senderUserId: user2,
        recipientType: 'player',
        recipientId: user1,
        messageText: 'User2 to User1',
      });

      const messagePage = await ChatService.getMessages(gameId, 'player', user2, user1, 1, 30);

      expect(messagePage.messages.length).toBe(2);
      expect(messagePage.messages[0].messageText).toBe('User1 to User2');
      expect(messagePage.messages[1].messageText).toBe('User2 to User1');
    });

    it('should paginate messages correctly', async () => {
      const gameId = await createTestGame();
      testGameIds.push(gameId);

      const userId = await createTestUser('user5', 'user5@example.com');
      testUserIds.push(userId);

      await addPlayerToGame(userId, gameId);

      // Store 5 messages
      for (let i = 1; i <= 5; i++) {
        await ChatService.storeMessage({
          gameId,
          senderUserId: userId,
          recipientType: 'game',
          recipientId: gameId,
          messageText: `Message ${i}`,
        });
      }

      // Get first page (limit 3)
      const page1 = await ChatService.getMessages(gameId, 'game', gameId, userId, 1, 3);

      expect(page1.messages.length).toBe(3);
      expect(page1.hasMore).toBe(true);
      expect(page1.totalPages).toBe(2);

      // Get second page
      const page2 = await ChatService.getMessages(gameId, 'game', gameId, userId, 2, 3);

      expect(page2.messages.length).toBe(2);
      expect(page2.hasMore).toBe(false);
    });
  });

  describe('getUnreadCounts', () => {
    it('should count unread messages', async () => {
      const gameId = await createTestGame();
      testGameIds.push(gameId);

      const user1 = await createTestUser('user6', 'user6@example.com');
      const user2 = await createTestUser('user7', 'user7@example.com');
      testUserIds.push(user1, user2);

      await addPlayerToGame(user1, gameId);
      await addPlayerToGame(user2, gameId);

      // Store unread messages
      await ChatService.storeMessage({
        gameId,
        senderUserId: user2,
        recipientType: 'game',
        recipientId: gameId,
        messageText: 'Unread message 1',
      });
      await ChatService.storeMessage({
        gameId,
        senderUserId: user2,
        recipientType: 'game',
        recipientId: gameId,
        messageText: 'Unread message 2',
      });

      const unreadCounts = await ChatService.getUnreadCounts(gameId, user1);

      expect(unreadCounts.total).toBe(2);
      expect(unreadCounts.byRecipient).toBeDefined();
    });

    it('should not count own messages as unread', async () => {
      const gameId = await createTestGame();
      testGameIds.push(gameId);

      const userId = await createTestUser('user8', 'user8@example.com');
      testUserIds.push(userId);

      await addPlayerToGame(userId, gameId);

      // Store own message
      await ChatService.storeMessage({
        gameId,
        senderUserId: userId,
        recipientType: 'game',
        recipientId: gameId,
        messageText: 'My own message',
      });

      const unreadCounts = await ChatService.getUnreadCounts(gameId, userId);

      expect(unreadCounts.total).toBe(0);
    });
  });

  describe('markAsRead', () => {
    it('should mark messages as read', async () => {
      const gameId = await createTestGame();
      testGameIds.push(gameId);

      const user1 = await createTestUser('user9', 'user9@example.com');
      const user2 = await createTestUser('user10', 'user10@example.com');
      testUserIds.push(user1, user2);

      await addPlayerToGame(user1, gameId);
      await addPlayerToGame(user2, gameId);

      const messageId = await ChatService.storeMessage({
        gameId,
        senderUserId: user2,
        recipientType: 'game',
        recipientId: gameId,
        messageText: 'Test message',
      });

      // Verify message is unread
      let message = await runQuery(async (client) => {
        const result = await client.query('SELECT is_read FROM chat_messages WHERE id = $1', [messageId]);
        return result.rows[0];
      });
      expect(message.is_read).toBe(false);

      // Mark as read
      await ChatService.markAsRead([messageId]);

      // Verify message is now read
      message = await runQuery(async (client) => {
        const result = await client.query('SELECT is_read FROM chat_messages WHERE id = $1', [messageId]);
        return result.rows[0];
      });
      expect(message.is_read).toBe(true);
    });
  });

  describe('getGamePlayers', () => {
    it('should return all players in game', async () => {
      const gameId = await createTestGame();
      testGameIds.push(gameId);

      const user1 = await createTestUser('player1', 'player1@example.com');
      const user2 = await createTestUser('player2', 'player2@example.com');
      const user3 = await createTestUser('player3', 'player3@example.com');
      testUserIds.push(user1, user2, user3);

      await addPlayerToGame(user1, gameId);
      await addPlayerToGame(user2, gameId);
      await addPlayerToGame(user3, gameId);

      const players = await ChatService.getGamePlayers(gameId);

      expect(players.length).toBe(3);
      expect(players[0].userId).toBeDefined();
      expect(players[0].username).toBeDefined();
      expect(players[0].playerId).toBeDefined();
    });

    it('should not return deleted players', async () => {
      const gameId = await createTestGame();
      testGameIds.push(gameId);

      const user1 = await createTestUser('player4', 'player4@example.com');
      const user2 = await createTestUser('player5', 'player5@example.com');
      testUserIds.push(user1, user2);

      const player1Id = await addPlayerToGame(user1, gameId);
      await addPlayerToGame(user2, gameId);

      // Mark player1 as deleted
      await runQuery(async (client) => {
        await client.query('UPDATE players SET is_deleted = true WHERE id = $1', [player1Id]);
      });

      const players = await ChatService.getGamePlayers(gameId);

      expect(players.length).toBe(1);
      expect(players[0].userId).toBe(user2);
    });
  });

  describe('getSenderUsername', () => {
    it('should return username for valid user', async () => {
      const userId = await createTestUser('testplayer', 'testplayer@example.com');
      testUserIds.push(userId);

      const username = await ChatService.getSenderUsername(userId);

      expect(username).toBe('testplayer');
    });

    it('should return null for non-existent user', async () => {
      const username = await ChatService.getSenderUsername(uuidv4());

      expect(username).toBeNull();
    });
  });
});
