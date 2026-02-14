// shared/socket.ts
import { io, Socket } from 'socket.io-client';
import type { ID, GameState, ClientToServerEvents, ServerToClientEvents, Player } from './types';
import { config, debug } from './config';

class SocketService {
  private socket: Socket<ServerToClientEvents, ClientToServerEvents> | null = null;
  private serverSeq = 0;
  private reconnectAttempts = 0;
  private connecting = false;
  private joinedGameIds = new Set<ID>();
  private joinedLobbyIds = new Set<ID>();
  private hasEverConnected = false;

  private onReconnectedCallbacks = new Set<() => void>();
  private onSeqGapCallbacks = new Set<(data: { expected: number; received: number }) => void>();

  connect(token: string): void {
    if (this.socket) {
      this.disconnect();
    }

    debug.log('Connecting to socket server:', config.socketUrl);
    this.connecting = true;
    
    this.socket = io(config.socketUrl, {
      auth: { token },
      transports: ['websocket'],
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 5000,
    });

    this.setupEventHandlers();
  }

  private setupEventHandlers(): void {
    if (!this.socket) return;

    // Keep auth fresh across reconnect attempts (handles token refresh cases)
    this.socket.io.on('reconnect_attempt', () => {
      const latestToken = localStorage.getItem('eurorails.jwt');
      if (latestToken) {
        this.socket!.auth = { token: latestToken };
      }
    });

    this.socket.on('connect', () => {
      debug.log('Socket connected');
      this.connecting = false;
      this.reconnectAttempts = 0;

      const isReconnect = this.hasEverConnected;
      this.hasEverConnected = true;

      if (isReconnect) {
        // Server restarts lose room membership; re-emit joins for anything we were in.
        for (const gameId of this.joinedGameIds) {
          this.socket!.emit('join', { gameId });
        }
        for (const gameId of this.joinedLobbyIds) {
          this.socket!.emit('join-lobby', { gameId });
        }

        for (const cb of this.onReconnectedCallbacks) {
          try {
            cb();
          } catch (err) {
            debug.error('onReconnected callback failed:', err);
          }
        }
      }
    });

    this.socket.on('disconnect', (reason) => {
      debug.log('Socket disconnected:', reason);
      this.connecting = false;
      // If server explicitly disconnected us, Socket.IO won't auto-reconnect unless we call connect()
      if (reason === 'io server disconnect') {
        this.socket?.connect();
      }
    });

    this.socket.on('connect_error', (error) => {
      debug.error('Socket connection error:', error);
      this.connecting = false;
      this.reconnectAttempts++;
      // IMPORTANT: do not disconnect/null out the socket here; let Socket.IO keep retrying.
    });
  }

  disconnect(): void {
    if (this.socket) {
      this.socket.disconnect();
      this.socket = null;
      this.serverSeq = 0;
      this.reconnectAttempts = 0;
      this.connecting = false;
      this.hasEverConnected = false;
      this.joinedGameIds.clear();
      this.joinedLobbyIds.clear();
    }
  }

  hasSocket(): boolean {
    return this.socket !== null;
  }

  isConnected(): boolean {
    return this.socket?.connected ?? false;
  }

  isConnecting(): boolean {
    return this.connecting && !this.isConnected();
  }

  /**
   * Wait for the current socket to become connected.
   * Returns true if connected, false if timed out or if no socket exists.
   */
  waitForConnection(timeoutMs: number = 2000): Promise<boolean> {
    if (!this.socket) {
      return Promise.resolve(false);
    }

    if (this.socket.connected) {
      return Promise.resolve(true);
    }

    return new Promise((resolve) => {
      const socketRef = this.socket;
      if (!socketRef) {
        resolve(false);
        return;
      }
      let done = false;
      let timer: number | undefined;

      const cleanup = () => {
        socketRef.off('connect', onConnect);
        socketRef.off('connect_error', onConnectError);
        if (timer !== undefined) {
          window.clearTimeout(timer);
        }
      };

      const finish = (ok: boolean) => {
        if (done) return;
        done = true;
        cleanup();
        resolve(ok);
      };

      const onConnect = () => finish(true);
      const onConnectError = () => finish(false);

      socketRef.on('connect', onConnect);
      socketRef.on('connect_error', onConnectError);

      timer = window.setTimeout(() => {
        finish(socketRef.connected);
      }, timeoutMs);
    });
  }

  join(gameId: ID): void {
    if (!this.socket) {
      throw new Error('Socket not connected');
    }
    this.joinedGameIds.add(gameId);
    this.socket.emit('join', { gameId });
  }

  sendAction(gameId: ID, type: string, payload: unknown, clientSeq: number): void {
    if (!this.socket) {
      throw new Error('Socket not connected');
    }
    this.socket.emit('action', { gameId, type, payload, clientSeq });
  }

  onInit(callback: (data: { gameState: GameState; serverSeq: number }) => void): void {
    if (!this.socket) return;
    
    this.socket.on('state:init', (data) => {
      if (typeof data?.serverSeq === 'number' && Number.isFinite(data.serverSeq)) {
        this.serverSeq = data.serverSeq;
      }
      callback(data);
    });
  }

  onPatch(callback: (data: { patch: Partial<GameState>; serverSeq: number }) => void): void {
    if (!this.socket) return;
    
    this.socket.on('state:patch', (data) => {
      const nextSeq = (typeof data?.serverSeq === 'number' && Number.isFinite(data.serverSeq))
        ? data.serverSeq
        : null;
      if (nextSeq !== null && nextSeq <= this.serverSeq) {
        return;
      }
      if (nextSeq !== null && nextSeq > this.serverSeq + 1) {
        for (const cb of this.onSeqGapCallbacks) {
          try {
            cb({ expected: this.serverSeq + 1, received: nextSeq });
          } catch (err) {
            debug.error('onSeqGap callback failed:', err);
          }
        }
      }
      // Only accept finite numbers; ignore NaN/Infinity to avoid corrupting comparisons.
      if (nextSeq !== null) {
        this.serverSeq = nextSeq;
      }
      callback(data);
    });
  }

  onPresenceUpdate(callback: (data: { userId: ID; isOnline: boolean }) => void): void {
    if (!this.socket) return;
    this.socket.on('presence:update', callback);
  }

  onTurnChange(callback: (data: { currentTurnUserId: ID; serverSeq: number }) => void): void {
    if (!this.socket) return;
    // Allow multiple listeners - both GameScene and game.store need to receive turn changes
    this.socket.on('turn:change', (data) => {
      if (typeof (data as any)?.serverSeq === 'number' && Number.isFinite((data as any).serverSeq)) {
        this.serverSeq = (data as any).serverSeq;
      }
      callback(data);
    });
  }

  onError(callback: (data: { code: string; message: string }) => void): void {
    if (!this.socket) return;
    this.socket.on('error', callback);
  }

  // Lobby-specific methods
  joinLobby(gameId: ID): void {
    if (!this.socket) {
      throw new Error('Socket not connected');
    }
    this.joinedLobbyIds.add(gameId);
    this.socket.emit('join-lobby', { gameId });
    debug.log(`Joined lobby room for game ${gameId}`);
  }

  leaveLobby(gameId: ID): void {
    if (!this.socket) {
      throw new Error('Socket not connected');
    }
    this.joinedLobbyIds.delete(gameId);
    this.socket.emit('leave-lobby', { gameId });
    debug.log(`Left lobby room for game ${gameId}`);
  }

  onLobbyUpdate(callback: (data: { gameId: ID; players: Player[]; action: 'player-joined' | 'player-left'; timestamp: number }) => void): void {
    if (!this.socket) return;
    // Remove old listener before adding new one to prevent duplicates
    this.socket.off('lobby-updated');
    this.socket.on('lobby-updated', callback);
  }

  onGameStarted(callback: (data: { gameId: ID; timestamp: number }) => void): void {
    if (!this.socket) return;
    // Remove old listener before adding new one to prevent duplicates
    this.socket.off('game-started');
    this.socket.on('game-started', callback);
  }

  onTrackUpdated(callback: (data: { gameId: ID; playerId: ID; timestamp: number }) => void): void {
    if (!this.socket) return;
    // Remove old listener before adding new one to prevent duplicates
    this.socket.off('track:updated');
    this.socket.on('track:updated', callback);
  }

  onVictoryTriggered(callback: (data: {
    gameId: ID;
    triggerPlayerIndex: number;
    triggerPlayerName: string;
    finalTurnPlayerIndex: number;
    victoryThreshold: number;
    timestamp: number;
  }) => void): void {
    if (!this.socket) return;
    this.socket.off('victory:triggered');
    this.socket.on('victory:triggered', callback);
  }

  onGameOver(callback: (data: {
    gameId: ID;
    winnerId: ID;
    winnerName: string;
    timestamp: number;
  }) => void): void {
    if (!this.socket) return;
    this.socket.off('game:over');
    this.socket.on('game:over', callback);
  }

  onTieExtended(callback: (data: {
    gameId: ID;
    newThreshold: number;
    timestamp: number;
  }) => void): void {
    if (!this.socket) return;
    this.socket.off('victory:tie-extended');
    this.socket.on('victory:tie-extended', callback);
  }

  // Chat-specific methods
  joinGameChat(gameId: ID, userId: ID): void {
    if (!this.socket) {
      throw new Error('Socket not connected');
    }
    this.socket.emit('join-game-chat', { gameId, userId });
    debug.log(`Joined game chat for game ${gameId}`);
  }

  leaveGameChat(gameId: ID): void {
    if (!this.socket) {
      throw new Error('Socket not connected');
    }
    this.socket.emit('leave-game-chat', { gameId });
    debug.log(`Left game chat for game ${gameId}`);
  }

  sendChatMessage(
    gameId: ID,
    message: string,
    recipientType: 'game' | 'player' = 'game',
    recipientId?: ID,
    tempId?: string
  ): void {
    if (!this.socket) {
      throw new Error('Socket not connected');
    }

    // Validate that recipientId is provided for player-to-player messages
    if (recipientType === 'player' && !recipientId) {
      throw new Error('recipientId is required when recipientType is player');
    }

    // Server expects messageText and tempId
    this.socket.emit('send-chat-message', {
      tempId: tempId || `temp-${Date.now()}`,
      gameId,
      messageText: message,
      recipientType,
      recipientId: recipientId || gameId,
    });
    debug.log(`Sent chat message to game ${gameId}`);
  }

  onChatMessage(callback: (data: { gameId: ID; message: any }) => void): void {
    if (!this.socket) return;
    this.socket.off('new-chat-message');
    this.socket.on('new-chat-message', (data: any) => {
      // Map server format to client ChatMessage format
      const gameId = data.gameId;
      const message = {
        id: data.id,
        gameId,
        senderId: data.senderUserId,
        senderUsername: data.senderUsername || 'Unknown',
        recipientType: data.recipientType,
        recipientId: data.recipientId,
        message: data.messageText,
        createdAt: data.createdAt,
        isRead: false,
      };
      callback({ gameId, message });
    });
  }

  onChatStatus(callback: (data: { gameId: ID; messageId: number; status: 'delivered' | 'read' }) => void): void {
    if (!this.socket) return;
    this.socket.off('chat-status');
    this.socket.on('chat-status', callback);
  }

  onChatError(callback: (data: { error: string; message: string }) => void): void {
    if (!this.socket) return;
    this.socket.off('chat-error');
    this.socket.on('chat-error', callback);
  }

  getServerSeq(): number {
    return this.serverSeq;
  }

  onReconnected(callback: () => void): () => void {
    this.onReconnectedCallbacks.add(callback);
    return () => {
      this.onReconnectedCallbacks.delete(callback);
    };
  }

  onSeqGap(callback: (data: { expected: number; received: number }) => void): () => void {
    this.onSeqGapCallbacks.add(callback);
    return () => {
      this.onSeqGapCallbacks.delete(callback);
    };
  }

  // Remove all listeners
  removeAllListeners(): void {
    if (!this.socket) return;
    this.socket.removeAllListeners();
    this.setupEventHandlers(); // Re-add connection handlers
  }
}

// Export singleton instance
export const socketService = new SocketService();