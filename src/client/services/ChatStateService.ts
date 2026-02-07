import { socketService } from '../lobby/shared/socket';
import { config } from '../config/apiConfig';

/**
 * Chat message type from server
 */
export interface ChatMessage {
  id: number;
  gameId: string;
  senderId: string;
  senderUsername: string;
  recipientType: 'game' | 'player';
  recipientId: string;
  message: string;
  createdAt: string;
  isRead: boolean;
}

/**
 * Optimistic message (not yet confirmed by server)
 */
interface OptimisticMessage extends Omit<ChatMessage, 'id' | 'createdAt'> {
  optimisticId: string;
  isPending: boolean;
  error?: string;
}

/**
 * Chat state for a specific game
 */
interface GameChatState {
  messages: ChatMessage[];
  optimisticMessages: OptimisticMessage[];
  unreadCount: number;
  isJoined: boolean;
  isLoading: boolean;
}

type MessageListener = (message: ChatMessage) => void;
type UnreadCountListener = (gameId: string, count: number) => void;
type ErrorListener = (error: { code: string; message: string }) => void;

/**
 * Manages chat state and real-time messaging for games
 * Follows server-authoritative pattern: API calls first, local updates after success
 */
export class ChatStateService {
  private gameChats: Map<string, GameChatState> = new Map();
  private messageListeners: Map<string, Set<MessageListener>> = new Map();
  private unreadCountListeners: Set<UnreadCountListener> = new Set();
  private errorListeners: Set<ErrorListener> = new Set();
  private userId: string | null = null;
  private initialized = false;

  /**
   * Initialize the chat service with user ID and set up socket listeners
   */
  async initialize(userId: string): Promise<void> {
    if (this.initialized) {
      return;
    }

    this.userId = userId;
    this.setupSocketListeners();
    this.initialized = true;
  }

  /**
   * Set up socket event listeners for real-time chat
   */
  private setupSocketListeners(): void {
    // Listen for incoming messages
    socketService.onChatMessage?.((data: {
      gameId: string;
      message: ChatMessage;
    }) => {
      this.handleIncomingMessage(data.gameId, data.message);
    });

    // Listen for message status updates
    socketService.onChatStatus?.((data: {
      gameId: string;
      messageId: number;
      status: 'delivered' | 'read';
    }) => {
      this.handleMessageStatus(data.gameId, data.messageId, data.status);
    });

    // Listen for chat errors
    socketService.onChatError?.((data: { error: string; message: string }) => {
      this.notifyError({ code: data.error, message: data.message });
    });
  }

  /**
   * Join a game's chat room
   */
  async joinGameChat(gameId: string): Promise<void> {
    if (!this.userId) {
      throw new Error('ChatStateService not initialized');
    }

    // Initialize game chat state if needed
    if (!this.gameChats.has(gameId)) {
      this.gameChats.set(gameId, {
        messages: [],
        optimisticMessages: [],
        unreadCount: 0,
        isJoined: false,
        isLoading: true,
      });
    }

    const state = this.gameChats.get(gameId)!;

    try {
      // Join the socket room
      socketService.joinGameChat?.(gameId, this.userId);

      // Fetch initial message history
      const messages = await this.fetchMessages(gameId);
      state.messages = messages;
      state.isJoined = true;
      state.isLoading = false;

      // Fetch unread count
      const unreadCount = await this.fetchUnreadCount(gameId);
      state.unreadCount = unreadCount;
      this.notifyUnreadCount(gameId, unreadCount);
    } catch (error) {
      state.isLoading = false;
      console.error('[ChatStateService] Failed to join game chat:', error);
      throw error;
    }
  }

  /**
   * Leave a game's chat room
   */
  leaveGameChat(gameId: string): void {
    socketService.leaveGameChat?.(gameId);
    
    const state = this.gameChats.get(gameId);
    if (state) {
      state.isJoined = false;
    }
  }

  /**
   * Send a message (optimistic UI update)
   */
  async sendMessage(gameId: string, message: string, recipientType: 'game' | 'player' = 'game', recipientId?: string): Promise<void> {
    if (!this.userId) {
      throw new Error('ChatStateService not initialized');
    }

    const state = this.gameChats.get(gameId);
    if (!state) {
      throw new Error('Not joined to game chat');
    }

    // Create optimistic message
    const optimisticId = `optimistic-${Date.now()}-${Math.random()}`;
    const effectiveRecipientId = recipientId || gameId;
    const optimisticMessage: OptimisticMessage = {
      optimisticId,
      gameId,
      senderId: this.userId,
      senderUsername: 'You', // Will be replaced by server response
      recipientType,
      recipientId: effectiveRecipientId,
      message,
      isRead: false,
      isPending: true,
    };

    // Add to optimistic messages immediately (optimistic UI)
    state.optimisticMessages.push(optimisticMessage);
    
    // Notify listeners with a properly typed message
    const tempMessage: ChatMessage = {
      id: -1,
      gameId: optimisticMessage.gameId,
      senderId: optimisticMessage.senderId,
      senderUsername: optimisticMessage.senderUsername,
      recipientType: optimisticMessage.recipientType,
      recipientId: optimisticMessage.recipientId,
      message: optimisticMessage.message,
      createdAt: new Date().toISOString(),
      isRead: optimisticMessage.isRead,
    };
    this.notifyMessageListeners(gameId, tempMessage);

    try {
      // Send via socket (server-authoritative)
      socketService.sendChatMessage?.(gameId, message, recipientType, effectiveRecipientId);

      // Note: The actual message confirmation will come via socket 'chat-message' event
      // At that point, we'll remove the optimistic message and add the real one
    } catch (error) {
      // Mark optimistic message as failed
      optimisticMessage.isPending = false;
      optimisticMessage.error = 'Failed to send message';
      console.error('[ChatStateService] Failed to send message:', error);
      throw error;
    }
  }

  /**
   * Handle incoming message from socket
   */
  private handleIncomingMessage(gameId: string, message: ChatMessage): void {
    const state = this.gameChats.get(gameId);
    if (!state) {
      return;
    }

    // Remove matching optimistic message if it exists
    const optimisticIndex = state.optimisticMessages.findIndex(
      (opt) => opt.senderId === message.senderId && opt.message === message.message
    );
    if (optimisticIndex >= 0) {
      state.optimisticMessages.splice(optimisticIndex, 1);
    }

    // Add real message
    state.messages.push(message);

    // Update unread count if message is from another user
    if (message.senderId !== this.userId && !message.isRead) {
      state.unreadCount++;
      this.notifyUnreadCount(gameId, state.unreadCount);
    }

    // Notify listeners
    this.notifyMessageListeners(gameId, message);
  }

  /**
   * Handle message status updates
   */
  private handleMessageStatus(gameId: string, messageId: number, status: 'delivered' | 'read'): void {
    const state = this.gameChats.get(gameId);
    if (!state) {
      return;
    }

    if (status === 'read') {
      const message = state.messages.find((m) => m.id === messageId);
      if (message) {
        message.isRead = true;
      }
    }
  }

  /**
   * Mark messages as read
   */
  async markMessagesAsRead(messageIds: number[]): Promise<void> {
    if (messageIds.length === 0) {
      return;
    }

    try {
      const { authenticatedFetch } = await import('./authenticatedFetch');
      const response = await authenticatedFetch(`${config.apiBaseUrl}/api/chat/messages/read`, {
        method: 'POST',
        body: JSON.stringify({ messageIds }),
      });

      if (!response.ok) {
        throw new Error('Failed to mark messages as read');
      }

      // Update local state
      for (const [gameId, state] of this.gameChats.entries()) {
        let unreadChanged = false;
        for (const message of state.messages) {
          if (messageIds.includes(message.id) && !message.isRead) {
            message.isRead = true;
            state.unreadCount = Math.max(0, state.unreadCount - 1);
            unreadChanged = true;
          }
        }
        if (unreadChanged) {
          this.notifyUnreadCount(gameId, state.unreadCount);
        }
      }
    } catch (error) {
      console.error('[ChatStateService] Failed to mark messages as read:', error);
      throw error;
    }
  }

  /**
   * Fetch message history for a game
   */
  private async fetchMessages(gameId: string, limit: number = 50, offset: number = 0): Promise<ChatMessage[]> {
    try {
      const { authenticatedFetch } = await import('./authenticatedFetch');
      const response = await authenticatedFetch(
        `${config.apiBaseUrl}/api/chat/messages?gameId=${gameId}&limit=${limit}&offset=${offset}`,
        { method: 'GET' }
      );

      if (!response.ok) {
        throw new Error('Failed to fetch messages');
      }

      const data = await response.json();
      return data.messages || [];
    } catch (error) {
      console.error('[ChatStateService] Failed to fetch messages:', error);
      return [];
    }
  }

  /**
   * Fetch unread message count for a game
   */
  private async fetchUnreadCount(gameId: string): Promise<number> {
    try {
      const { authenticatedFetch } = await import('./authenticatedFetch');
      const response = await authenticatedFetch(
        `${config.apiBaseUrl}/api/chat/messages/unread?gameId=${gameId}`,
        { method: 'GET' }
      );

      if (!response.ok) {
        throw new Error('Failed to fetch unread count');
      }

      const data = await response.json();
      return data.unreadCount || 0;
    } catch (error) {
      console.error('[ChatStateService] Failed to fetch unread count:', error);
      return 0;
    }
  }

  /**
   * Get all messages for a game (including optimistic ones)
   */
  getMessages(gameId: string): ChatMessage[] {
    const state = this.gameChats.get(gameId);
    if (!state) {
      return [];
    }

    // Combine real messages with optimistic ones
    const combinedMessages: ChatMessage[] = [
      ...state.messages,
      ...state.optimisticMessages.map((opt): ChatMessage => ({
        id: -1, // Temporary ID for optimistic messages
        gameId: opt.gameId,
        senderId: opt.senderId,
        senderUsername: opt.senderUsername,
        recipientType: opt.recipientType,
        recipientId: opt.recipientId,
        message: opt.message,
        createdAt: new Date().toISOString(),
        isRead: opt.isRead,
      })),
    ];

    return combinedMessages;
  }

  /**
   * Get unread count for a game
   */
  getUnreadCount(gameId: string): number {
    return this.gameChats.get(gameId)?.unreadCount || 0;
  }

  /**
   * Check if joined to a game's chat
   */
  isJoined(gameId: string): boolean {
    return this.gameChats.get(gameId)?.isJoined || false;
  }

  /**
   * Subscribe to new messages for a specific game
   */
  onMessage(gameId: string, listener: MessageListener): () => void {
    if (!this.messageListeners.has(gameId)) {
      this.messageListeners.set(gameId, new Set());
    }
    this.messageListeners.get(gameId)!.add(listener);

    // Return unsubscribe function
    return () => {
      this.messageListeners.get(gameId)?.delete(listener);
    };
  }

  /**
   * Subscribe to unread count changes
   */
  onUnreadCount(listener: UnreadCountListener): () => void {
    this.unreadCountListeners.add(listener);
    return () => {
      this.unreadCountListeners.delete(listener);
    };
  }

  /**
   * Subscribe to chat errors
   */
  onError(listener: ErrorListener): () => void {
    this.errorListeners.add(listener);
    return () => {
      this.errorListeners.delete(listener);
    };
  }

  /**
   * Notify message listeners
   */
  private notifyMessageListeners(gameId: string, message: ChatMessage): void {
    const listeners = this.messageListeners.get(gameId);
    if (listeners) {
      for (const listener of listeners) {
        try {
          listener(message);
        } catch (error) {
          console.error('[ChatStateService] Message listener error:', error);
        }
      }
    }
  }

  /**
   * Notify unread count listeners
   */
  private notifyUnreadCount(gameId: string, count: number): void {
    for (const listener of this.unreadCountListeners) {
      try {
        listener(gameId, count);
      } catch (error) {
        console.error('[ChatStateService] Unread count listener error:', error);
      }
    }
  }

  /**
   * Notify error listeners
   */
  private notifyError(error: { code: string; message: string }): void {
    for (const listener of this.errorListeners) {
      try {
        listener(error);
      } catch (err) {
        console.error('[ChatStateService] Error listener error:', err);
      }
    }
  }

  /**
   * Clean up when leaving a game
   */
  cleanup(gameId?: string): void {
    if (gameId) {
      this.leaveGameChat(gameId);
      this.gameChats.delete(gameId);
      this.messageListeners.delete(gameId);
    } else {
      // Clean up all
      for (const gId of this.gameChats.keys()) {
        this.leaveGameChat(gId);
      }
      this.gameChats.clear();
      this.messageListeners.clear();
      this.unreadCountListeners.clear();
      this.errorListeners.clear();
    }
  }
}

// Export singleton instance
export const chatStateService = new ChatStateService();
