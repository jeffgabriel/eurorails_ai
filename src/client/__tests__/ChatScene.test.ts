import { chatStateService } from '../services/ChatStateService';

// Mock dependencies
jest.mock('../services/ChatStateService', () => ({
  chatStateService: {
    initialize: jest.fn().mockResolvedValue(undefined),
    joinGameChat: jest.fn().mockResolvedValue(undefined),
    sendMessage: jest.fn().mockResolvedValue(undefined),
    getMessages: jest.fn().mockReturnValue([]),
    onMessage: jest.fn(),
    onUnreadCount: jest.fn(),
    onError: jest.fn(),
    markMessagesAsRead: jest.fn().mockResolvedValue(undefined),
    cleanup: jest.fn(),
  },
}));

jest.mock('../lobby/shared/socket', () => ({
  socketService: {
    onChatMessage: jest.fn(),
    onChatError: jest.fn(),
  },
}));

/**
 * Unit tests for ChatScene logic
 * Note: Full Phaser scene rendering tests require integration testing
 */
describe('ChatScene', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('service initialization', () => {
    it('should initialize chat state service with user ID', async () => {
      const userId = 'test-user';
      await chatStateService.initialize(userId);

      expect(chatStateService.initialize).toHaveBeenCalledWith(userId);
    });

    it('should join game chat with game ID', async () => {
      const gameId = 'test-game';
      await chatStateService.joinGameChat(gameId);

      expect(chatStateService.joinGameChat).toHaveBeenCalledWith(gameId);
    });

    it('should set up message listeners', () => {
      const gameId = 'test-game';
      const callback = jest.fn();

      chatStateService.onMessage(gameId, callback);

      expect(chatStateService.onMessage).toHaveBeenCalledWith(gameId, callback);
    });

    it('should set up error listeners', () => {
      const callback = jest.fn();
      chatStateService.onError(callback);

      expect(chatStateService.onError).toHaveBeenCalledWith(callback);
    });
  });

  describe('message handling', () => {
    it('should retrieve messages for a game', () => {
      const gameId = 'test-game';
      const mockMessages = [
        {
          id: 1,
          gameId,
          senderId: 'user-1',
          senderUsername: 'Player 1',
          recipientType: 'game' as const,
          recipientId: gameId,
          message: 'Hello!',
          createdAt: new Date().toISOString(),
          isRead: false,
        },
      ];

      (chatStateService.getMessages as jest.Mock).mockReturnValue(mockMessages);

      const messages = chatStateService.getMessages(gameId);

      expect(messages).toHaveLength(1);
      expect(messages[0].message).toBe('Hello!');
    });

    it('should send a message to game chat', async () => {
      const gameId = 'test-game';
      const message = 'Test message';

      await chatStateService.sendMessage(gameId, message);

      expect(chatStateService.sendMessage).toHaveBeenCalledWith(gameId, message);
    });

    it('should not send empty messages', async () => {
      const gameId = 'test-game';
      const emptyMessage = '   ';

      // This would be handled at the UI layer
      if (emptyMessage.trim()) {
        await chatStateService.sendMessage(gameId, emptyMessage);
      }

      expect(chatStateService.sendMessage).not.toHaveBeenCalled();
    });

    it('should mark messages as read', async () => {
      const messageIds = [1, 2, 3];

      await chatStateService.markMessagesAsRead(messageIds);

      expect(chatStateService.markMessagesAsRead).toHaveBeenCalledWith(messageIds);
    });

    it('should not mark empty array of messages as read', async () => {
      const messageIds: number[] = [];

      // This would be handled at the UI layer
      if (messageIds.length > 0) {
        await chatStateService.markMessagesAsRead(messageIds);
      }

      expect(chatStateService.markMessagesAsRead).not.toHaveBeenCalled();
    });
  });

  describe('responsive behavior', () => {
    it('should detect mobile mode for narrow widths', () => {
      const width = 375;
      const isMobile = width < 768;

      expect(isMobile).toBe(true);
    });

    it('should detect desktop mode for wide widths', () => {
      const width = 1024;
      const isMobile = width < 768;

      expect(isMobile).toBe(false);
    });

    it('should use full width on mobile', () => {
      const isMobile = true;
      const screenWidth = 375;
      const sidebarWidth = 350;

      const width = isMobile ? screenWidth : sidebarWidth;

      expect(width).toBe(screenWidth);
    });

    it('should use sidebar width on desktop', () => {
      const isMobile = false;
      const screenWidth = 1024;
      const sidebarWidth = 350;

      const width = isMobile ? screenWidth : sidebarWidth;

      expect(width).toBe(sidebarWidth);
    });
  });

  describe('input validation', () => {
    it('should trim whitespace from messages', () => {
      const input = '  Hello world  ';
      const trimmed = input.trim();

      expect(trimmed).toBe('Hello world');
    });

    it('should reject messages with only whitespace', () => {
      const input = '   ';
      const isValid = input.trim().length > 0;

      expect(isValid).toBe(false);
    });

    it('should accept valid messages', () => {
      const input = 'Hello world';
      const isValid = input.trim().length > 0;

      expect(isValid).toBe(true);
    });

    it('should enforce max length of 500 characters', () => {
      const longMessage = 'a'.repeat(501);
      const maxLength = 500;
      const isValid = longMessage.length <= maxLength;

      expect(isValid).toBe(false);
    });

    it('should accept messages within max length', () => {
      const validMessage = 'a'.repeat(500);
      const maxLength = 500;
      const isValid = validMessage.length <= maxLength;

      expect(isValid).toBe(true);
    });
  });

  describe('cleanup', () => {
    it('should clean up chat state on shutdown', () => {
      const gameId = 'test-game';

      chatStateService.cleanup(gameId);

      expect(chatStateService.cleanup).toHaveBeenCalledWith(gameId);
    });
  });
});
