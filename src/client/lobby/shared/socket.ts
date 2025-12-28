// shared/socket.ts
import { io, Socket } from 'socket.io-client';
import type { ID, GameState, ClientToServerEvents, ServerToClientEvents, Player } from './types';
import { config, debug } from './config';

class SocketService {
  private socket: Socket<ServerToClientEvents, ClientToServerEvents> | null = null;
  private serverSeq = 0;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 5;
  private connecting = false;

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
      reconnectionDelay: 1000,
      reconnectionDelayMax: 5000,
    });

    this.setupEventHandlers();
  }

  private setupEventHandlers(): void {
    if (!this.socket) return;

    this.socket.on('connect', () => {
      debug.log('Socket connected');
      this.connecting = false;
      this.reconnectAttempts = 0;
    });

    this.socket.on('disconnect', (reason) => {
      debug.log('Socket disconnected:', reason);
      this.connecting = false;
    });

    this.socket.on('connect_error', (error) => {
      debug.error('Socket connection error:', error);
      this.connecting = false;
      this.reconnectAttempts++;
      
      if (this.reconnectAttempts >= this.maxReconnectAttempts) {
        debug.error('Max reconnection attempts reached');
        this.disconnect();
      }
    });
  }

  disconnect(): void {
    if (this.socket) {
      this.socket.disconnect();
      this.socket = null;
      this.serverSeq = 0;
      this.connecting = false;
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
      this.serverSeq = data.serverSeq;
      callback(data);
    });
  }

  onPatch(callback: (data: { patch: Partial<GameState>; serverSeq: number }) => void): void {
    if (!this.socket) return;
    
    this.socket.on('state:patch', (data) => {
      // Check for sequence gap
      if (data.serverSeq !== this.serverSeq + 1) {
        debug.warn('Sequence gap detected, requesting full state', {
          expected: this.serverSeq + 1,
          received: data.serverSeq
        });
        // Request full state refresh - this would be handled by the game store
        return;
      }
      
      this.serverSeq = data.serverSeq;
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
      this.serverSeq = data.serverSeq;
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
    this.socket.emit('join-lobby', { gameId });
    debug.log(`Joined lobby room for game ${gameId}`);
  }

  leaveLobby(gameId: ID): void {
    if (!this.socket) {
      throw new Error('Socket not connected');
    }
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

  getServerSeq(): number {
    return this.serverSeq;
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