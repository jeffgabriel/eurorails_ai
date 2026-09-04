// shared/socket.ts
import { io, Socket } from 'socket.io-client';
import type { ID, GameState, ClientToServerEvents, ServerToClientEvents, Player } from './types';
import type {
  EventCardDrawnPayload,
  EventEffectExpiredPayload,
  ActiveEffectSummary,
} from '../../../shared/types/EventCard';
import { config, debug } from './config';
import { isAccessTokenExpired } from './tokenUtils';

const JWT_STORAGE_KEY = 'eurorails.jwt';
const REFRESH_TOKEN_STORAGE_KEY = 'eurorails.refreshToken';

/** The exact `next(new Error(...))` message the server's socket auth middleware
 * uses when a token fails verification (see socketService.ts's `io.use`). */
const AUTH_CONNECT_ERROR_MESSAGE = 'UNAUTHORIZED';

class SocketService {
  private socket: Socket<ServerToClientEvents, ClientToServerEvents> | null = null;
  private serverSeq = 0;
  private reconnectAttempts = 0;
  private connecting = false;
  private joinedGameIds = new Set<ID>();
  private joinedLobbyIds = new Set<ID>();
  private hasEverConnected = false;

  // Guards a single refreshAccessToken() call per disconnect cycle: once an
  // auth-rejected connect_error triggers a refresh, further connect_error
  // retries in the same cycle must not each fire their own refresh (a
  // refresh storm against a rotating refresh token can revoke the session).
  // Cleared on the next successful 'connect', or re-armed by the auth retry
  // timer below when a refresh failed transiently.
  private refreshTriggeredOnConnectError = false;

  // Pending explicit reconnect after a transient refresh failure. A
  // middleware-denied handshake permanently stops Socket.IO's own retry loop
  // (see connect_error below), so every retry from that state has to be
  // driven from here.
  private authRetryTimer?: number;
  private static readonly AUTH_RETRY_BASE_MS = 2000;
  private static readonly AUTH_RETRY_MAX_MS = 30000;

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
      // A live connection ends the disconnect cycle -- the next connect_error
      // (a new cycle) is allowed to trigger its own refresh.
      this.refreshTriggeredOnConnectError = false;
      this.clearAuthRetry();

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

      if (this.isAuthConnectError(error) && !this.refreshTriggeredOnConnectError) {
        this.refreshTriggeredOnConnectError = true;
        // A handshake denied by the server's auth middleware is NOT a
        // transient failure to Socket.IO: the client destroys the namespace
        // socket (`socket.active` becomes false) and closes the manager with
        // reconnection skipped, so its retry loop never runs again and
        // `reconnect_attempt` never re-reads the refreshed token. After the
        // refresh we therefore have to re-open the socket ourselves.
        void this.refreshTokenAfterConnectError();
      }
    });
  }

  /** Detect the server's socket-auth-middleware rejection (see socketService.ts's `io.use`). */
  private isAuthConnectError(error: Error): boolean {
    return error?.message === AUTH_CONNECT_ERROR_MESSAGE;
  }

  private async refreshTokenAfterConnectError(): Promise<void> {
    let refreshed = false;
    try {
      const { useAuthStore } = await import('../store/auth.store');
      refreshed = await useAuthStore.getState().refreshAccessToken();
    } catch (err) {
      debug.error('Token refresh after auth connect_error threw:', err);
    }

    if (refreshed) {
      this.reconnectWithCurrentToken();
      return;
    }

    // refreshAccessToken() returns false for both a definitive rejection (it
    // has already logged out and cleared the persisted tokens -- the session
    // is over and there is nothing to reconnect with) and a transient failure
    // (tokens retained). Only the latter is worth retrying.
    if (!localStorage.getItem(REFRESH_TOKEN_STORAGE_KEY)) {
      debug.warn('Token refresh after auth connect_error was rejected; not reconnecting');
      return;
    }
    debug.warn('Token refresh after auth connect_error failed transiently; scheduling a reconnect retry');
    this.scheduleAuthRetry();
  }

  /**
   * Retry the denied handshake after a backoff. Re-sending the (still stale)
   * token yields another UNAUTHORIZED connect_error, and re-arming the guard
   * first lets that error trigger a fresh refresh attempt -- so the retry
   * loop is: reconnect -> denied -> refresh -> (success: reconnect with the
   * new token | transient failure: back here).
   */
  private scheduleAuthRetry(): void {
    if (this.authRetryTimer !== undefined) {
      return;
    }
    const exponent = Math.min(this.reconnectAttempts, 4);
    const delayMs = Math.min(SocketService.AUTH_RETRY_BASE_MS * 2 ** exponent, SocketService.AUTH_RETRY_MAX_MS);
    this.authRetryTimer = window.setTimeout(() => {
      this.authRetryTimer = undefined;
      this.refreshTriggeredOnConnectError = false;
      this.reconnectWithCurrentToken();
    }, delayMs);
  }

  private clearAuthRetry(): void {
    if (this.authRetryTimer !== undefined) {
      window.clearTimeout(this.authRetryTimer);
      this.authRetryTimer = undefined;
    }
  }

  /**
   * Re-open the existing socket with whatever access token is currently
   * persisted. Used whenever Socket.IO has stopped retrying on its own (a
   * middleware-denied handshake) -- `socket.connect()` re-subscribes the
   * namespace and re-opens the manager, which also clears its skip-reconnect
   * flag so normal auto-reconnect resumes afterwards.
   */
  private reconnectWithCurrentToken(): void {
    if (!this.socket) {
      return;
    }
    const token = localStorage.getItem(JWT_STORAGE_KEY);
    if (token) {
      this.socket.auth = { token };
    }
    if (!this.socket.connected) {
      this.connecting = true;
      this.socket.connect();
    }
  }

  disconnect(): void {
    this.clearAuthRetry();
    if (this.socket) {
      this.socket.disconnect();
      this.socket = null;
      this.serverSeq = 0;
      this.reconnectAttempts = 0;
      this.connecting = false;
      this.hasEverConnected = false;
      this.joinedGameIds.clear();
      this.joinedLobbyIds.clear();
      // A full teardown starts a fresh epoch -- the next connect() begins a
      // brand new socket and disconnect cycle, so any earlier connect_error
      // refresh guard no longer applies.
      this.refreshTriggeredOnConnectError = false;
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

  /**
   * Ensure a live socket connection exists, connecting with `token` if needed.
   * Fails closed: with no existing socket and no token, resolves false rather
   * than guessing at a connection. Pure transport concern — no game logic.
   */
  async ensureConnected(token: string): Promise<boolean> {
    if (this.hasSocket() && this.isConnected()) {
      return true;
    }

    if (!this.hasSocket()) {
      if (!token) {
        return false;
      }

      // Only take the async proactive-refresh path when a refresh is
      // actually needed -- an `await` always yields a microtask tick even
      // when its target is already settled, so this keeps the common
      // (no-refresh-needed) case running synchronously through to
      // `connect()`, matching the pre-existing timing this method relied on.
      let connectToken = token;
      if (this.needsProactiveRefresh(token)) {
        if (!(await this.refreshBeforeConnect())) {
          return false;
        }
        connectToken = localStorage.getItem(JWT_STORAGE_KEY) || token;
      }

      this.connect(connectToken);
    } else if (!this.socket!.active) {
      // The socket exists but Socket.IO has given up on it: a handshake
      // denied by the server's auth middleware destroys the namespace socket
      // and stops all automatic reconnection (see connect_error). Waiting
      // for it to reconnect would never resolve -- refresh if the persisted
      // token is stale, then re-open it explicitly.
      const currentToken = localStorage.getItem(JWT_STORAGE_KEY) || token;
      if (this.needsProactiveRefresh(currentToken) && !(await this.refreshBeforeConnect())) {
        return false;
      }
      this.clearAuthRetry();
      this.refreshTriggeredOnConnectError = false;
      this.reconnectWithCurrentToken();
    }

    return this.waitForConnection(2500);
  }

  /** Refresh-first only when a refresh token exists: the dev-auth sentinel is not a JWT and has nothing to refresh with. */
  private needsProactiveRefresh(token: string): boolean {
    return !!localStorage.getItem(REFRESH_TOKEN_STORAGE_KEY) && isAccessTokenExpired(token);
  }

  private async refreshBeforeConnect(): Promise<boolean> {
    debug.log('Access token expired before connect; refreshing proactively');
    const { useAuthStore } = await import('../store/auth.store');
    const refreshed = await useAuthStore.getState().refreshAccessToken();
    if (!refreshed) {
      debug.error('Proactive refresh failed before connect; not connecting with a stale token');
    }
    return refreshed;
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

  onMessageError(callback: (data: { tempId: string; error: string; message: string }) => void): void {
    if (!this.socket) return;
    this.socket.off('message-error');
    this.socket.on('message-error', callback);
  }

  // Whisper-specific methods
  submitWhisper(payload: {
    gameId: string;
    turnNumber: number;
    botPlayerId: string;
    advice: string;
    botTurnSummary: object;
  }): void {
    if (!this.socket) {
      throw new Error('Socket not connected');
    }
    this.socket.emit('whisper:submit' as any, payload);
  }

  onWhisperRecorded(callback: (data: { whisperId: string; turnNumber: number; timestamp: string }) => void): void {
    if (!this.socket) return;
    this.socket.off('whisper:recorded' as any);
    (this.socket as any).on('whisper:recorded', callback);
  }

  onWhisperError(callback: (data: { code: string; message: string }) => void): void {
    if (!this.socket) return;
    this.socket.off('whisper:error' as any);
    (this.socket as any).on('whisper:error', callback);
  }

  emitAutoRunToggle(gameId: string): void {
    if (!this.socket) return;
    this.socket.emit('autorun:toggle' as any, { gameId });
  }

  onAutoRunStatus(callback: (data: { enabled: boolean }) => void): () => void {
    if (!this.socket) return () => {};
    const handler = callback;
    (this.socket as any).on('autorun:status', handler);
    return () => {
      (this.socket as any)?.off('autorun:status', handler);
    };
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

  onAnyEvent(callback: (eventName: string, ...args: any[]) => void): () => void {
    if (!this.socket) return () => {};
    this.socket.onAny(callback);
    return () => {
      this.socket?.offAny(callback);
    };
  }

  /**
   * Listen for event:card-drawn — fires when an event card is drawn by any player.
   * The callback receives the full event card payload for overlay display.
   */
  onEventCardDrawn(callback: (payload: EventCardDrawnPayload) => void): void {
    if (!this.socket) return;
    this.socket.off('event:card-drawn' as any);
    (this.socket as any).on('event:card-drawn', (payload: unknown) => {
      // Validate payload shape before dispatching to prevent stringly-typed bugs
      if (!payload || typeof payload !== 'object') {
        debug.error('[socketService] Malformed event:card-drawn payload:', payload);
        return;
      }
      const p = payload as Record<string, unknown>;
      if (!p.gameId || !p.card || !p.drawingPlayerId) {
        debug.error('[socketService] event:card-drawn missing required fields:', payload);
        return;
      }
      try {
        callback(payload as EventCardDrawnPayload);
      } catch (err) {
        debug.error('[socketService] onEventCardDrawn callback failed:', err);
      }
    });
  }

  /**
   * Listen for event:effect-expired — fires when a persistent event effect expires.
   */
  onEventEffectExpired(callback: (payload: EventEffectExpiredPayload) => void): void {
    if (!this.socket) return;
    this.socket.off('event:effect-expired' as any);
    (this.socket as any).on('event:effect-expired', (payload: unknown) => {
      if (!payload || typeof payload !== 'object') {
        debug.error('[socketService] Malformed event:effect-expired payload:', payload);
        return;
      }
      const p = payload as Record<string, unknown>;
      if (!p.gameId || typeof p.cardId !== 'number') {
        debug.error('[socketService] event:effect-expired missing required fields:', payload);
        return;
      }
      try {
        callback(payload as EventEffectExpiredPayload);
      } catch (err) {
        debug.error('[socketService] onEventEffectExpired callback failed:', err);
      }
    });
  }

  /**
   * Listen for event:active-effects — fires on reconnect to restore effect state.
   */
  onActiveEffects(callback: (effects: ActiveEffectSummary[]) => void): void {
    if (!this.socket) return;
    this.socket.off('event:active-effects' as any);
    (this.socket as any).on('event:active-effects', (data: unknown) => {
      if (!data || typeof data !== 'object') {
        debug.error('[socketService] Malformed event:active-effects payload:', data);
        return;
      }
      const d = data as Record<string, unknown>;
      if (!Array.isArray(d.activeEffects)) {
        debug.error('[socketService] event:active-effects missing activeEffects array:', data);
        return;
      }
      try {
        callback(d.activeEffects as ActiveEffectSummary[]);
      } catch (err) {
        debug.error('[socketService] onActiveEffects callback failed:', err);
      }
    });
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