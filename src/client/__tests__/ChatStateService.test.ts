/**
 * ChatStateService Unit Tests
 * Tests for frontend chat state management and socket integration
 */

import { ChatStateService, ChatMessage } from '../services/ChatStateService';
import { socketService } from '../lobby/shared/socket';

// Mock socketService
jest.mock('../lobby/shared/socket', () => ({
  socketService: {
    joinGameChat: jest.fn(),
    leaveGameChat: jest.fn(),
    sendChatMessage: jest.fn(),
    onChatMessage: jest.fn(),
    onChatStatus: jest.fn(),
    onChatError: jest.fn(),
  },
}));

// Mock authenticatedFetch
jest.mock('../services/authenticatedFetch', () => ({
  authenticatedFetch: jest.fn(),
}));

describe('ChatStateService', () => {
  let chatService: ChatStateService;
  const mockUserId = 'user-123';
  const mockGameId = 'game-456';

  beforeEach(() => {
    chatService = new ChatStateService();
    jest.clearAllMocks();
  });

  afterEach(() => {
    chatService.cleanup();
  });

  describe('initialization', () => {
    it('should initialize with user ID', async () => {
      await chatService.initialize(mockUserId);

      // Should set up socket listeners
      expect(socketService.onChatMessage).toHaveBeenCalled();
      expect(socketService.onChatStatus).toHaveBeenCalled();
      expect(socketService.onChatError).toHaveBeenCalled();
    });

    it('should not reinitialize if already initialized', async () => {
      await chatService.initialize(mockUserId);
      await chatService.initialize(mockUserId);

      // Should only call once
      expect(socketService.onChatMessage).toHaveBeenCalledTimes(1);
    });

    it('should throw error when sending message without initialization', async () => {
      await expect(
        chatService.sendMessage(mockGameId, 'test message')
      ).rejects.toThrow('ChatStateService not initialized');
    });
  });

  describe('joining and leaving chat', () => {
    beforeEach(async () => {
      await chatService.initialize(mockUserId);

      // Mock fetch responses
      const { authenticatedFetch } = require('../services/authenticatedFetch');
      authenticatedFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ messages: [], unreadCount: 0 }),
      });
    });

    it('should join game chat successfully', async () => {
      await chatService.joinGameChat(mockGameId);

      expect(socketService.joinGameChat).toHaveBeenCalledWith(mockGameId, mockUserId);
      expect(chatService.isJoined(mockGameId)).toBe(true);
    });

    it('should fetch messages and unread count when joining', async () => {
      const mockMessages: ChatMessage[] = [
        {
          id: 1,
          gameId: mockGameId,
          senderId: 'other-user',
          senderUsername: 'OtherUser',
          recipientType: 'game',
          recipientId: mockGameId,
          message: 'Hello!',
          createdAt: new Date().toISOString(),
          isRead: false,
        },
      ];

      const { authenticatedFetch } = require('../services/authenticatedFetch');
      authenticatedFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ messages: mockMessages }),
      }).mockResolvedValueOnce({
        ok: true,
        json: async () => ({ unreadCount: 1 }),
      });

      await chatService.joinGameChat(mockGameId);

      const messages = chatService.getMessages(mockGameId);
      expect(messages).toHaveLength(1);
      expect(messages[0].message).toBe('Hello!');
      expect(chatService.getUnreadCount(mockGameId)).toBe(1);
    });

    it('should leave game chat', async () => {
      await chatService.joinGameChat(mockGameId);
      chatService.leaveGameChat(mockGameId);

      expect(socketService.leaveGameChat).toHaveBeenCalledWith(mockGameId);
      expect(chatService.isJoined(mockGameId)).toBe(false);
    });
  });

  describe('sending messages with optimistic UI', () => {
    beforeEach(async () => {
      await chatService.initialize(mockUserId);

      const { authenticatedFetch } = require('../services/authenticatedFetch');
      authenticatedFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ messages: [], unreadCount: 0 }),
      });

      await chatService.joinGameChat(mockGameId);
    });

    it('should send message and show optimistic UI', async () => {
      const messageListener = jest.fn();
      chatService.onMessage(mockGameId, messageListener);

      await chatService.sendMessage(mockGameId, 'Test message');

      // Should send via socket (5th arg is optimisticId for server matching)
      expect(socketService.sendChatMessage).toHaveBeenCalledWith(
        mockGameId,
        'Test message',
        'game',
        mockGameId,
        expect.stringMatching(/^optimistic-\d+-[\d.]+$/)
      );

      // Should show optimistic message
      expect(messageListener).toHaveBeenCalled();
      const messages = chatService.getMessages(mockGameId);
      expect(messages).toHaveLength(1);
      expect(messages[0].message).toBe('Test message');
      expect(messages[0].id).toBe(-1); // Optimistic ID
    });

    it('should support direct messages to players', async () => {
      const recipientId = 'player-789';
      await chatService.sendMessage(mockGameId, 'Private message', 'player', recipientId);

      expect(socketService.sendChatMessage).toHaveBeenCalledWith(
        mockGameId,
        'Private message',
        'player',
        recipientId,
        expect.stringMatching(/^optimistic-\d+-[\d.]+$/)
      );
    });

    it('should throw error when sending to non-joined game', async () => {
      await expect(
        chatService.sendMessage('other-game', 'test')
      ).rejects.toThrow('Not joined to game chat');
    });
  });

  describe('receiving messages', () => {
    beforeEach(async () => {
      await chatService.initialize(mockUserId);

      const { authenticatedFetch } = require('../services/authenticatedFetch');
      authenticatedFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ messages: [], unreadCount: 0 }),
      });

      await chatService.joinGameChat(mockGameId);
    });

    it('should handle incoming messages', () => {
      const messageListener = jest.fn();
      chatService.onMessage(mockGameId, messageListener);

      const incomingMessage: ChatMessage = {
        id: 1,
        gameId: mockGameId,
        senderId: 'other-user',
        senderUsername: 'OtherUser',
        recipientType: 'game',
        recipientId: mockGameId,
        message: 'Hello from server!',
        createdAt: new Date().toISOString(),
        isRead: false,
      };

      // Directly call the private method via accessing the service's handler
      // In a real scenario, this would come from the socket
      (chatService as any).handleIncomingMessage(mockGameId, incomingMessage);

      expect(messageListener).toHaveBeenCalledWith(incomingMessage);
      const messages = chatService.getMessages(mockGameId);
      expect(messages).toHaveLength(1);
      expect(messages[0].id).toBe(1); // Real ID from server
    });

    it('should replace optimistic message with real one', async () => {
      // Send optimistic message
      await chatService.sendMessage(mockGameId, 'Test message');

      let messages = chatService.getMessages(mockGameId);
      expect(messages).toHaveLength(1);
      expect(messages[0].id).toBe(-1);

      // Receive confirmation from server
      const confirmedMessage: ChatMessage = {
        id: 123,
        gameId: mockGameId,
        senderId: mockUserId,
        senderUsername: 'TestUser',
        recipientType: 'game',
        recipientId: mockGameId,
        message: 'Test message',
        createdAt: new Date().toISOString(),
        isRead: false,
      };

      (chatService as any).handleIncomingMessage(mockGameId, confirmedMessage);

      messages = chatService.getMessages(mockGameId);
      expect(messages).toHaveLength(1);
      expect(messages[0].id).toBe(123); // Real ID
    });

    it('should increment unread count for messages from others', () => {
      const unreadListener = jest.fn();
      chatService.onUnreadCount(unreadListener);

      const incomingMessage: ChatMessage = {
        id: 1,
        gameId: mockGameId,
        senderId: 'other-user',
        senderUsername: 'OtherUser',
        recipientType: 'game',
        recipientId: mockGameId,
        message: 'Unread message',
        createdAt: new Date().toISOString(),
        isRead: false,
      };

      (chatService as any).handleIncomingMessage(mockGameId, incomingMessage);

      expect(chatService.getUnreadCount(mockGameId)).toBe(1);
      expect(unreadListener).toHaveBeenCalledWith(mockGameId, 1);
    });

    it('should not increment unread count for own messages', () => {
      const incomingMessage: ChatMessage = {
        id: 1,
        gameId: mockGameId,
        senderId: mockUserId,
        senderUsername: 'Me',
        recipientType: 'game',
        recipientId: mockGameId,
        message: 'My message',
        createdAt: new Date().toISOString(),
        isRead: false,
      };

      (chatService as any).handleIncomingMessage(mockGameId, incomingMessage);

      expect(chatService.getUnreadCount(mockGameId)).toBe(0);
    });
  });

  describe('marking messages as read', () => {
    beforeEach(async () => {
      await chatService.initialize(mockUserId);

      const { authenticatedFetch } = require('../services/authenticatedFetch');
      authenticatedFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ messages: [], unreadCount: 0 }),
      });

      await chatService.joinGameChat(mockGameId);
    });

    it('should mark messages as read via API', async () => {
      const { authenticatedFetch } = require('../services/authenticatedFetch');
      authenticatedFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({}),
      });

      await chatService.markMessagesAsRead([1, 2, 3]);

      expect(authenticatedFetch).toHaveBeenCalledWith(
        expect.stringContaining('/api/chat/mark-read'),
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ messageIds: [1, 2, 3] }),
        })
      );
    });

    it('should handle empty message ID array', async () => {
      const { authenticatedFetch } = require('../services/authenticatedFetch');
      
      // Reset mock to clear any previous calls
      authenticatedFetch.mockClear();
      
      await chatService.markMessagesAsRead([]);

      // Should not call the mark-as-read endpoint (but may have called join game endpoints)
      const calls = authenticatedFetch.mock.calls;
      const markAsReadCalls = calls.filter((call: any) => call[0].includes('/mark-read'));
      expect(markAsReadCalls.length).toBe(0);
    });
  });

  describe('listeners and subscriptions', () => {
    beforeEach(async () => {
      await chatService.initialize(mockUserId);

      const { authenticatedFetch } = require('../services/authenticatedFetch');
      authenticatedFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ messages: [], unreadCount: 0 }),
      });

      await chatService.joinGameChat(mockGameId);
    });

    it('should support multiple message listeners', () => {
      const listener1 = jest.fn();
      const listener2 = jest.fn();

      chatService.onMessage(mockGameId, listener1);
      chatService.onMessage(mockGameId, listener2);

      // Simulate incoming message
      const chatMessageCallback = (socketService.onChatMessage as jest.Mock).mock.calls[0][0];
      const testMessage: ChatMessage = {
        id: 1,
        gameId: mockGameId,
        senderId: 'other-user',
        senderUsername: 'OtherUser',
        recipientType: 'game',
        recipientId: mockGameId,
        message: 'Test',
        createdAt: new Date().toISOString(),
        isRead: false,
      };

      chatMessageCallback({ gameId: mockGameId, message: testMessage });

      expect(listener1).toHaveBeenCalledWith(testMessage);
      expect(listener2).toHaveBeenCalledWith(testMessage);
    });

    it('should support unsubscribing from listeners', () => {
      const listener = jest.fn();
      const unsubscribe = chatService.onMessage(mockGameId, listener);

      unsubscribe();

      // Simulate incoming message
      const chatMessageCallback = (socketService.onChatMessage as jest.Mock).mock.calls[0][0];
      const testMessage: ChatMessage = {
        id: 1,
        gameId: mockGameId,
        senderId: 'other-user',
        senderUsername: 'OtherUser',
        recipientType: 'game',
        recipientId: mockGameId,
        message: 'Test',
        createdAt: new Date().toISOString(),
        isRead: false,
      };

      chatMessageCallback({ gameId: mockGameId, message: testMessage });

      expect(listener).not.toHaveBeenCalled();
    });

    it('should notify error listeners', () => {
      const errorListener = jest.fn();
      chatService.onError(errorListener);

      // Simulate error
      const chatErrorCallback = (socketService.onChatError as jest.Mock).mock.calls[0][0];
      chatErrorCallback({ error: 'RATE_LIMIT', message: 'Too many messages' });

      expect(errorListener).toHaveBeenCalledWith({
        code: 'RATE_LIMIT',
        message: 'Too many messages',
      });
    });
  });

  describe('cleanup', () => {
    beforeEach(async () => {
      await chatService.initialize(mockUserId);

      const { authenticatedFetch } = require('../services/authenticatedFetch');
      authenticatedFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ messages: [], unreadCount: 0 }),
      });

      await chatService.joinGameChat(mockGameId);
    });

    it('should clean up specific game', () => {
      chatService.cleanup(mockGameId);

      expect(socketService.leaveGameChat).toHaveBeenCalledWith(mockGameId);
      expect(chatService.isJoined(mockGameId)).toBe(false);
      expect(chatService.getMessages(mockGameId)).toHaveLength(0);
    });

    it('should clean up all games', () => {
      chatService.cleanup();

      expect(socketService.leaveGameChat).toHaveBeenCalledWith(mockGameId);
      expect(chatService.isJoined(mockGameId)).toBe(false);
    });
  });
});
