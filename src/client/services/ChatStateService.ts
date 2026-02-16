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
  createdAt: string; // Store creation time to avoid re-generating on every render
  error?: string;
}

/**
 * Chat state for a specific game or DM
 */
interface GameChatState {
  messages: ChatMessage[];
  optimisticMessages: OptimisticMessage[];
  unreadCount: number;
  isJoined: boolean;
  isLoading: boolean;
}

function getDMKey(gameId: string, otherUserId: string): string {
  return `dm:${gameId}:${otherUserId}`;
}

type MessageListener = (message: ChatMessage) => void;
type UnreadCountListener = (gameId: string, count: number) => void;
type ErrorListener = (error: { code: string; message: string }) => void;
type FlaggedListener = (optimisticId: string, errorMessage: string) => void;

/**
 * Manages chat state and real-time messaging for games
 * Follows server-authoritative pattern: API calls first, local updates after success
 */
export class ChatStateService {
  private gameChats: Map<string, GameChatState> = new Map();
  private dmChats: Map<string, GameChatState> = new Map();
  private messageListeners: Map<string, Set<MessageListener>> = new Map();
  private unreadCountListeners: Set<UnreadCountListener> = new Set();
  private errorListeners: Set<ErrorListener> = new Set();
  private flaggedListeners: Set<FlaggedListener> = new Set();
  private flaggedOptimisticIds: Set<string> = new Set();
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

    // Listen for message-level errors (moderation, validation, etc.)
    socketService.onMessageError?.((data: { tempId: string; error: string; message: string }) => {
      this.handleMessageError(data.tempId, data.error, data.message);
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

      // Fetch initial message history (game chat)
      const messages = await this.fetchMessages(gameId, 'game', gameId, 1, 50);
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
   * Ensure DM state exists for a recipient; returns state or null if game not joined
   */
  private ensureDMState(gameId: string, recipientId: string): GameChatState | null {
    if (!this.gameChats.has(gameId) || !this.gameChats.get(gameId)!.isJoined) {
      return null;
    }
    const dmKey = getDMKey(gameId, recipientId);
    if (!this.dmChats.has(dmKey)) {
      this.dmChats.set(dmKey, {
        messages: [],
        optimisticMessages: [],
        unreadCount: 0,
        isJoined: true,
        isLoading: false,
      });
    }
    return this.dmChats.get(dmKey)!;
  }

  /**
   * Open DM with a player: load history and return messages. Caller should subscribe via onMessage(dmKey, ...).
   */
  async openDM(gameId: string, recipientId: string): Promise<ChatMessage[]> {
    if (!this.userId) {
      throw new Error('ChatStateService not initialized');
    }
    const dmKey = getDMKey(gameId, recipientId);
    if (!this.dmChats.has(dmKey)) {
      this.dmChats.set(dmKey, {
        messages: [],
        optimisticMessages: [],
        unreadCount: 0,
        isJoined: true,
        isLoading: true,
      });
    }
    const state = this.dmChats.get(dmKey)!;
    try {
      const messages = await this.fetchMessages(gameId, 'player', recipientId, 1, 50);
      state.messages = messages;
      state.isLoading = false;
      return this.getDMMessages(gameId, recipientId);
    } catch (error) {
      state.isLoading = false;
      console.error('[ChatStateService] Failed to load DM:', error);
      throw error;
    }
  }

  /**
   * Get messages for a DM (including optimistic)
   */
  getDMMessages(gameId: string, recipientId: string): ChatMessage[] {
    const dmKey = getDMKey(gameId, recipientId);
    return this.getMessagesByKey(dmKey);
  }

  /**
   * Get messages by key (gameId or dmKey)
   */
  private getMessagesByKey(key: string): ChatMessage[] {
    const state = this.gameChats.get(key) ?? this.dmChats.get(key);
    if (!state) return [];
    const combinedMessages: ChatMessage[] = [
      ...state.messages,
      ...state.optimisticMessages.map((opt): ChatMessage => ({
        id: -1,
        gameId: opt.gameId,
        senderId: opt.senderId,
        senderUsername: opt.senderUsername,
        recipientType: opt.recipientType,
        recipientId: opt.recipientId,
        message: opt.message,
        createdAt: opt.createdAt,
        isRead: opt.isRead,
      })),
    ];
    return combinedMessages;
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
  async sendMessage(gameId: string, message: string, recipientType: 'game' | 'player' = 'game', recipientId?: string): Promise<string> {
    if (!this.userId) {
      throw new Error('ChatStateService not initialized');
    }

    const effectiveRecipientId = recipientId || gameId;
    const state =
      recipientType === 'game'
        ? this.gameChats.get(gameId)
        : this.ensureDMState(gameId, effectiveRecipientId);

    if (!state) {
      throw new Error(recipientType === 'game' ? 'Not joined to game chat' : 'DM state not initialized');
    }

    // Create optimistic message
    const optimisticId = `optimistic-${Date.now()}-${Math.random()}`;
    const createdAt = new Date().toISOString();
    const optimisticMessage: OptimisticMessage = {
      optimisticId,
      gameId,
      senderId: this.userId,
      senderUsername: 'You', // Will be replaced by server response
      recipientType,
      recipientId: effectiveRecipientId,
      message,
      createdAt, // Store creation time to avoid inconsistent timestamps on re-renders
      isRead: false,
      isPending: true,
    };

    // Add to optimistic messages immediately (optimistic UI)
    state.optimisticMessages.push(optimisticMessage);

    const notifyKey = recipientType === 'game' ? gameId : getDMKey(gameId, effectiveRecipientId);

    // Notify listeners with a properly typed message
    const tempMessage: ChatMessage = {
      id: -1,
      gameId: optimisticMessage.gameId,
      senderId: optimisticMessage.senderId,
      senderUsername: optimisticMessage.senderUsername,
      recipientType: optimisticMessage.recipientType,
      recipientId: optimisticMessage.recipientId,
      message: optimisticMessage.message,
      createdAt: optimisticMessage.createdAt,
      isRead: optimisticMessage.isRead,
    };
    this.notifyMessageListeners(notifyKey, tempMessage);

    try {
      // Send via socket (server-authoritative) - pass tempId for optimistic matching
      socketService.sendChatMessage?.(
        gameId,
        message,
        recipientType,
        effectiveRecipientId,
        optimisticId
      );

      // Note: The actual message confirmation will come via socket 'new-chat-message' event
      // At that point, we'll remove the optimistic message and add the real one
      return optimisticId;
    } catch (error) {
      // Mark optimistic message as failed
      optimisticMessage.isPending = false;
      optimisticMessage.error = 'Failed to send message';
      console.error('[ChatStateService] Failed to send message:', error);
      return optimisticId;
    }
  }

  /**
   * Handle incoming message from socket
   */
  private handleIncomingMessage(gameId: string, message: ChatMessage): void {
    // Route to game chat or DM based on recipientType
    if (message.recipientType === 'game') {
      this.handleGameMessage(gameId, message);
    } else {
      const otherUserId = message.senderId === this.userId ? message.recipientId : message.senderId;
      const dmKey = getDMKey(gameId, otherUserId);
      this.handleDMMessage(dmKey, message);
    }
  }

  private handleGameMessage(gameId: string, message: ChatMessage): void {
    const state = this.gameChats.get(gameId);
    if (!state) return;
    this.applyIncomingMessage(state, message, gameId, () => this.notifyMessageListeners(gameId, message));
  }

  private handleDMMessage(dmKey: string, message: ChatMessage): void {
    // Extract gameId from dmKey format: dm:gameId:otherUserId
    const gameId = dmKey.split(':')[1];
    
    // Only process DMs if user has joined the game chat
    if (!this.gameChats.has(gameId) || !this.gameChats.get(gameId)!.isJoined) {
      return;
    }
    
    if (!this.dmChats.has(dmKey)) {
      this.dmChats.set(dmKey, {
        messages: [],
        optimisticMessages: [],
        unreadCount: 0,
        isJoined: true,
        isLoading: false,
      });
    }
    const state = this.dmChats.get(dmKey)!;
    this.applyIncomingMessage(state, message, dmKey, () => this.notifyMessageListeners(dmKey, message));
  }

  private applyIncomingMessage(
    state: GameChatState,
    message: ChatMessage,
    notifyKey: string,
    notify: () => void
  ): void {
    const optimisticIndex = state.optimisticMessages.findIndex((opt) => {
      if ((message as any).optimisticId) {
        return opt.optimisticId === (message as any).optimisticId;
      }
      return opt.senderId === message.senderId && opt.message === message.message;
    });

    const wasOptimistic = optimisticIndex >= 0;

    if (wasOptimistic) {
      state.optimisticMessages.splice(optimisticIndex, 1);
    }

    state.messages.push(message);

    if (message.senderId !== this.userId && !message.isRead) {
      state.unreadCount++;
      this.notifyUnreadCount(notifyKey, state.unreadCount);
    }

    // Only notify listeners if this is NOT replacing an optimistic message
    // (optimistic messages were already shown in the UI)
    if (!wasOptimistic) {
      notify();
    }
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
      // Ensure all IDs are numbers (server may return them as strings for BIGSERIAL)
      const numericIds = messageIds.map(id => typeof id === 'string' ? parseInt(id, 10) : id);
      
      const response = await authenticatedFetch(`${config.apiBaseUrl}/api/chat/mark-read`, {
        method: 'POST',
        body: JSON.stringify({ messageIds: numericIds }),
      });

      if (!response.ok) {
        throw new Error('Failed to mark messages as read');
      }

      // Update local state for both game chats and DMs
      for (const [gameId, state] of this.gameChats.entries()) {
        let unreadChanged = false;
        for (const message of state.messages) {
          if (numericIds.includes(message.id) && !message.isRead) {
            message.isRead = true;
            state.unreadCount = Math.max(0, state.unreadCount - 1);
            unreadChanged = true;
          }
        }
        if (unreadChanged) {
          this.notifyUnreadCount(gameId, state.unreadCount);
        }
      }

      // Also update DM local state
      for (const [dmKey, state] of this.dmChats.entries()) {
        let unreadChanged = false;
        for (const message of state.messages) {
          if (numericIds.includes(message.id) && !message.isRead) {
            message.isRead = true;
            state.unreadCount = Math.max(0, state.unreadCount - 1);
            unreadChanged = true;
          }
        }
        if (unreadChanged) {
          this.notifyUnreadCount(dmKey, state.unreadCount);
        }
      }
    } catch (error) {
      console.error('[ChatStateService] Failed to mark messages as read:', error);
      throw error;
    }
  }

  /**
   * Fetch message history for a game or DM
   */
  private async fetchMessages(
    gameId: string,
    recipientType: 'game' | 'player' = 'game',
    recipientId?: string,
    page: number = 1,
    limit: number = 50
  ): Promise<ChatMessage[]> {
    try {
      const { authenticatedFetch } = await import('./authenticatedFetch');
      const effectiveRecipientId = recipientId || gameId;
      const params = new URLSearchParams({
        recipientType,
        recipientId: effectiveRecipientId,
        page: String(page),
        limit: String(Math.min(limit, 30)),
      });
      const response = await authenticatedFetch(
        `${config.apiBaseUrl}/api/chat/messages/${gameId}?${params}`,
        { method: 'GET' }
      );

      if (!response.ok) {
        throw new Error('Failed to fetch messages');
      }

      const data = await response.json();
      const rawMessages = data.data?.messages || data.messages || [];
      // Map server format (messageText, senderUserId) to client format (message, senderId)
      return rawMessages.map((m: any) => ({
        ...m,
        message: m.messageText ?? m.message,
        senderId: m.senderUserId ?? m.senderId,
      }));
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
        `${config.apiBaseUrl}/api/chat/unread/${gameId}`,
        { method: 'GET' }
      );

      if (!response.ok) {
        throw new Error('Failed to fetch unread count');
      }

      const data = await response.json();
      return data.data?.total ?? data.unreadCount ?? 0;
    } catch (error) {
      console.error('[ChatStateService] Failed to fetch unread count:', error);
      return 0;
    }
  }

  /**
   * Get all messages for a game (including optimistic ones)
   */
  getMessages(gameId: string): ChatMessage[] {
    return this.getMessagesByKey(gameId);
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
   * Handle a message-error event from the server (moderation, rate limit, etc.)
   * Finds the optimistic message by tempId and marks it as flagged.
   */
  private handleMessageError(tempId: string, error: string, errorMessage: string): void {
    // Search game chats and DM chats for the matching optimistic message
    for (const state of [...this.gameChats.values(), ...this.dmChats.values()]) {
      const opt = state.optimisticMessages.find((m) => m.optimisticId === tempId);
      if (opt) {
        opt.isPending = false;
        opt.error = errorMessage;
        this.flaggedOptimisticIds.add(tempId);
        this.notifyFlaggedListeners(tempId, errorMessage);
        return;
      }
    }
  }

  /**
   * Subscribe to flagged message notifications
   */
  onMessageFlagged(listener: FlaggedListener): () => void {
    this.flaggedListeners.add(listener);
    return () => {
      this.flaggedListeners.delete(listener);
    };
  }

  /**
   * Check if an optimistic message was flagged
   */
  isFlagged(optimisticId: string): boolean {
    return this.flaggedOptimisticIds.has(optimisticId);
  }

  /**
   * Notify flagged listeners
   */
  private notifyFlaggedListeners(optimisticId: string, errorMessage: string): void {
    for (const listener of this.flaggedListeners) {
      try {
        listener(optimisticId, errorMessage);
      } catch (err) {
        console.error('[ChatStateService] Flagged listener error:', err);
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
      // Remove DM states for this game
      for (const key of this.dmChats.keys()) {
        if (key.startsWith(`dm:${gameId}:`)) {
          this.dmChats.delete(key);
          this.messageListeners.delete(key);
        }
      }
    } else {
      // Clean up all
      for (const gId of this.gameChats.keys()) {
        this.leaveGameChat(gId);
      }
      this.gameChats.clear();
      this.dmChats.clear();
      this.messageListeners.clear();
      this.unreadCountListeners.clear();
      this.errorListeners.clear();
      this.flaggedListeners.clear();
      this.flaggedOptimisticIds.clear();
    }
  }
}

// Export singleton instance
export const chatStateService = new ChatStateService();
