// services/socketService.ts
import { Server as SocketIOServer, Socket } from 'socket.io';
import type { Server as HTTPServer } from 'http';
import type { GameState } from '../../shared/types/GameTypes';
import { AuthService } from './authService';
import { db } from '../db';
import { GameService } from './gameService';
import { ChatService } from './chatService';
import { rateLimitService } from './rateLimitService';
import { gameChatLimitService } from './gameChatLimitService';
import { moderationService } from './moderationService';

let io: SocketIOServer | null = null;
let presenceSweepInterval: NodeJS.Timeout | null = null;

const PRESENCE_HEARTBEAT_MS = 60_000;
const PRESENCE_STALE_INTERVAL = '5 minutes';

/**
 * Create deterministic DM room ID (both users join same room)
 * Sort user IDs alphabetically for consistency
 */
function createDMRoomId(userId1: string, userId2: string, gameId: string): string {
  const sorted = [userId1, userId2].sort();
  return `game:${gameId}:dm:${sorted[0]}:${sorted[1]}`;
}

async function nextServerSeq(gameId: string): Promise<number> {
  const result = await db.query(
    `UPDATE games
     SET server_seq = server_seq + 1
     WHERE id = $1
     RETURNING server_seq`,
    [gameId]
  );

  if (result.rows.length === 0) {
    throw new Error('GAME_NOT_FOUND');
  }

  const raw = result.rows[0]?.server_seq;
  const serverSeq = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(serverSeq)) {
    throw new Error('INVALID_SERVER_SEQ');
  }
  return serverSeq;
}

async function getCurrentServerSeq(gameId: string): Promise<number> {
  const result = await db.query(
    `SELECT server_seq
     FROM games
     WHERE id = $1`,
    [gameId]
  );
  if (result.rows.length === 0) {
    throw new Error('GAME_NOT_FOUND');
  }
  const raw = result.rows[0]?.server_seq;
  const serverSeq = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(serverSeq)) {
    throw new Error('INVALID_SERVER_SEQ');
  }
  return serverSeq;
}

/**
 * Initialize Socket.IO server
 */
export function initializeSocketIO(server: HTTPServer): SocketIOServer {
  if (io) {
    return io;
  }

  io = new SocketIOServer(server, {
    cors: {
      origin: process.env.CLIENT_URL || 'http://localhost:3000',
      methods: ['GET', 'POST'],
      credentials: true,
    },
    transports: ['websocket'],
  });

  // Socket auth: attach userId from JWT (best-effort)
  io.use(async (socket, next) => {
    try {
      const token = (socket.handshake.auth as any)?.token
        || (typeof socket.handshake.headers.authorization === 'string'
          ? socket.handshake.headers.authorization.split(' ')[1]
          : undefined);

      if (!token) {
        // Allow connection but without presence tracking
        (socket.data as any).userId = null;
        return next();
      }

      const payload = AuthService.verifyToken(token);
      if (!payload) {
        return next(new Error('UNAUTHORIZED'));
      }

      (socket.data as any).userId = payload.userId;
      (socket.data as any).joinedGameIds = new Set<string>();
      return next();
    } catch (err) {
      return next(err as Error);
    }
  });

  // Global sweep: mark stale players offline after 5 minutes without heartbeat
  if (!presenceSweepInterval) {
    presenceSweepInterval = setInterval(async () => {
      try {
        await db.query(
          `UPDATE players
           SET is_online = false
           WHERE is_online = true
             AND last_seen_at < NOW() - $1::interval`,
          [PRESENCE_STALE_INTERVAL]
        );
      } catch (err) {
        console.error('Presence sweep failed:', err);
      }
    }, PRESENCE_HEARTBEAT_MS);
    // Allow Node process (and Jest) to exit naturally
    presenceSweepInterval.unref?.();
  }

  // Handle socket connections
  io.on('connection', (socket: Socket) => {
    const userId: string | null = (socket.data as any).userId ?? null;
    const joinedGameIds: Set<string> = (socket.data as any).joinedGameIds ?? new Set<string>();

    // Heartbeat while connected: update last_seen_at for joined games
    const heartbeatInterval = setInterval(async () => {
      if (!userId || joinedGameIds.size === 0) return;
      const gameIds = Array.from(joinedGameIds);
      try {
        await db.query(
          `UPDATE players
           SET is_online = true,
               last_seen_at = NOW()
           WHERE user_id = $1
             AND game_id = ANY($2::uuid[])`,
          [userId, gameIds]
        );
      } catch (err) {
        // Do not crash the process on heartbeat failures
        console.error('Presence heartbeat update failed:', err);
      }
    }, PRESENCE_HEARTBEAT_MS);
    // Allow Node process (and Jest) to exit naturally
    heartbeatInterval.unref?.();

    // Handle disconnection
    socket.on('disconnect', () => {
      clearInterval(heartbeatInterval);
    });

    // Handle join lobby event
    socket.on('join-lobby', (data: { gameId: string }) => {
      if (!data || !data.gameId || typeof data.gameId !== 'string' || data.gameId.trim() === '') {
        console.warn(`Invalid gameId from client ${socket.id} for join-lobby`);
        return;
      }
      const { gameId } = data;
      socket.join(`lobby-${gameId}`);
      if (userId) {
        joinedGameIds.add(gameId);
        db.query(
          `UPDATE players
           SET is_online = true,
               last_seen_at = NOW()
           WHERE game_id = $1 AND user_id = $2`,
          [gameId, userId]
        ).catch((err) => console.error('Failed to set presence on join-lobby:', err));
      }
      // Note: We don't emit lobby-updated here because the LobbyService
      // handles emitting proper events with player data when players actually join/leave
    });

    // Handle leave lobby event
    socket.on('leave-lobby', (data: { gameId: string }) => {
      if (!data || !data.gameId || typeof data.gameId !== 'string' || data.gameId.trim() === '') {
        console.warn(`Invalid gameId from client ${socket.id} for leave-lobby`);
        return;
      }
      const { gameId } = data;
      socket.leave(`lobby-${gameId}`);
      // Do not mark offline here; rely on heartbeat + 5-minute staleness sweep
      joinedGameIds.delete(gameId);
      // Note: We don't emit lobby-updated here because the LobbyService
      // handles emitting proper events with player data when players actually join/leave
    });

    // Handle other existing game events (preserve existing functionality)
    socket.on('join', (data: { gameId: string }) => {
      if (!data || !data.gameId || typeof data.gameId !== 'string' || data.gameId.trim() === '') {
        console.warn(`Invalid gameId from client ${socket.id} for join`);
        return;
      }
      const gameId = data.gameId;
      socket.join(gameId);
      if (userId) {
        joinedGameIds.add(gameId);
        db.query(
          `UPDATE players
           SET is_online = true,
               last_seen_at = NOW()
           WHERE game_id = $1 AND user_id = $2`,
          [gameId, userId]
        ).catch((err) => console.error('Failed to set presence on join:', err));
      }

      (async () => {
        try {
          if (!userId) {
            socket.emit('error', { code: 'UNAUTHORIZED', message: 'Authentication required to join game' });
            return;
          }

          const membershipResult = await db.query(
            'SELECT is_deleted FROM players WHERE game_id = $1 AND user_id = $2 LIMIT 1',
            [gameId, userId]
          );
          if (membershipResult.rows.length === 0) {
            socket.emit('error', { code: 'FORBIDDEN', message: 'You are not a player in this game' });
            return;
          }
          if (membershipResult.rows[0].is_deleted === true) {
            socket.emit('error', { code: 'FORBIDDEN', message: 'You no longer have access to this game' });
            return;
          }

          const gameState = await GameService.getGame(gameId, userId);
          if (!gameState) {
            socket.emit('error', { code: 'GAME_NOT_FOUND', message: 'Game not found' });
            return;
          }

          const serverSeq = await getCurrentServerSeq(gameId);
          socket.emit('state:init', { gameState, serverSeq });
        } catch (err) {
          console.error('Failed to emit state:init on join:', err);
          socket.emit('error', { code: 'STATE_INIT_FAILED', message: 'Failed to initialize game state' });
        }
      })();
    });

    socket.on('action', async (data: { gameId: string; type: string; payload: unknown; clientSeq: number }) => {
      if (!data || !data.gameId || typeof data.gameId !== 'string' || data.gameId.trim() === '') {
        console.warn(`Invalid gameId from client ${socket.id} for action`);
        return;
      }
      if (!data.type || typeof data.type !== 'string') {
        console.warn(`Invalid action type from client ${socket.id}`);
        return;
      }
      if (userId) {
        joinedGameIds.add(data.gameId);
        // Best-effort heartbeat on activity
        db.query(
          `UPDATE players
           SET is_online = true,
               last_seen_at = NOW()
           WHERE game_id = $1 AND user_id = $2`,
          [data.gameId, userId]
        ).catch(() => {});
      }
      try {
        const serverSeq = await nextServerSeq(data.gameId);
        // Forward action to other players in the game
        socket.to(data.gameId).emit('state:patch', {
          patch: data.payload as any,
          serverSeq,
        });
      } catch (err) {
        console.error('Failed to forward action as state:patch:', err);
        // Notify the sending client; otherwise this failure is silent and the UI may assume success.
        socket.emit('error', {
          code: 'ACTION_PATCH_FAILED',
          message: 'Failed to broadcast action update. Please retry.',
        });
      }
    });

    // ====== CHAT EVENTS ======

    /**
     * Join game chat rooms
     */
    socket.on('join-game-chat', async (data: { gameId: string; userId: string }) => {
      if (!data || !data.gameId || !data.userId) {
        console.warn(`Invalid join-game-chat data from client ${socket.id}`);
        return;
      }

      const { gameId, userId: requestUserId } = data;

      // Verify user is authenticated and matches request
      if (!userId || userId !== requestUserId) {
        socket.emit('chat-error', {
          error: 'UNAUTHORIZED',
          message: 'Authentication required',
        });
        return;
      }

      try {
        // SECURITY: Verify user is a member of the game before joining chat
        const validation = await ChatService.validateChatPermissions(
          userId,
          'game',
          gameId,
          gameId
        );

        if (!validation.valid) {
          socket.emit('chat-error', {
            error: validation.error || 'UNAUTHORIZED',
            message: validation.details || 'You must be in the game to access chat',
          });
          return;
        }

        // Join game chat room
        socket.join(`game:${gameId}:chat`);
        
        // Get all players in game to set up DM rooms
        const players = await ChatService.getGamePlayers(gameId);
        
        // Join DM room with each other player
        for (const player of players) {
          if (player.userId !== userId) {
            const dmRoom = createDMRoomId(userId, player.userId, gameId);
            socket.join(dmRoom);
          }
        }

        socket.emit('chat-joined', { gameId });
        console.log(`[Chat] User ${userId} joined chat for game ${gameId}`);
      } catch (error) {
        console.error('[Chat] Error joining game chat:', error);
        socket.emit('chat-error', {
          error: 'JOIN_FAILED',
          message: 'Failed to join chat',
        });
      }
    });

    /**
     * Send chat message
     */
    socket.on('send-chat-message', async (data: {
      tempId: string;
      gameId: string;
      recipientType: 'game' | 'player';
      recipientId: string;
      messageText: string;
    }) => {
      if (!data || !data.gameId || !data.recipientType || !data.messageText) {
        console.warn(`Invalid send-chat-message data from client ${socket.id}`);
        return;
      }

      const { tempId, gameId, recipientType, recipientId, messageText } = data;

      // Verify user is authenticated
      if (!userId) {
        socket.emit('message-error', {
          tempId,
          error: 'not_verified',
          message: 'Authentication required',
        });
        return;
      }

      try {
        // Validate message length (500 Unicode characters)
        if (messageText.length > 500) {
          socket.emit('message-error', {
            tempId,
            error: 'message_too_long',
            message: 'Message cannot exceed 500 characters',
          });
          return;
        }

        // Trim message
        const trimmedMessage = messageText.trim();
        if (trimmedMessage.length === 0) {
          socket.emit('message-error', {
            tempId,
            error: 'empty_message',
            message: 'Message cannot be empty',
          });
          return;
        }

        // 1. Validate chat permissions
        const validation = await ChatService.validateChatPermissions(
          userId,
          recipientType,
          recipientId,
          gameId
        );

        if (!validation.valid) {
          socket.emit('message-error', {
            tempId,
            error: validation.error,
            message: validation.details || 'Permission denied',
          });
          return;
        }

        // 2. Check rate limit
        const rateCheck = await rateLimitService.checkUserLimit(userId, gameId);
        if (!rateCheck.allowed) {
          socket.emit('message-error', {
            tempId,
            error: 'rate_limited',
            message: `You are sending messages too quickly. Please wait ${rateCheck.retryAfter} seconds.`,
            retryAfter: rateCheck.retryAfter,
          });
          return;
        }

        // 3. Check game limit
        const gameLimitOk = await gameChatLimitService.checkGameLimit(gameId);
        if (!gameLimitOk) {
          socket.emit('message-error', {
            tempId,
            error: 'game_limit_reached',
            message: 'This game has reached its message limit (1000). Chat is now disabled.',
          });
          return;
        }

        // 4. Run content moderation
        if (moderationService.isReady()) {
          const moderationResult = await moderationService.checkMessage(trimmedMessage);
          if (!moderationResult.isAppropriate) {
            socket.emit('message-error', {
              tempId,
              error: 'inappropriate_content',
              message: 'Your message was flagged by our content moderation system. Please revise and try again.',
            });
            return;
          }
        }

        // 5. Store message
        const messageId = await ChatService.storeMessage({
          gameId,
          senderUserId: userId,
          recipientType,
          recipientId,
          messageText: trimmedMessage,
        });

        // 6. Update rate limit and game count
        await rateLimitService.recordMessage(userId, gameId);
        await gameChatLimitService.incrementGameCount(gameId);

        // 7. Get sender username
        const senderUsername = await ChatService.getSenderUsername(userId);

        // 8. Emit confirmation to sender
        socket.emit('message-sent', {
          tempId,
          messageId,
          timestamp: new Date().toISOString(),
        });

        // 9. Broadcast to recipients
        const messageData = {
          id: messageId,
          senderUserId: userId,
          senderUsername: senderUsername || 'Unknown',
          recipientType,
          recipientId,
          messageText: trimmedMessage,
          createdAt: new Date().toISOString(),
        };

        if (recipientType === 'game') {
          // Broadcast to all players in game (except sender)
          socket.to(`game:${gameId}:chat`).emit('new-chat-message', messageData);
        } else {
          // Send to specific player's DM room
          const dmRoom = createDMRoomId(userId, recipientId, gameId);
          socket.to(dmRoom).emit('new-chat-message', messageData);
        }

        console.log(`[Chat] Message sent from ${userId} in game ${gameId} (type: ${recipientType})`);
      } catch (error) {
        console.error('[Chat] Error sending message:', error);
        socket.emit('message-error', {
          tempId,
          error: 'send_failed',
          message: 'Failed to send message. Please try again.',
        });
      }
    });
  });

  return io;
}

/**
 * Get the Socket.IO server instance
 */
export function getSocketIO(): SocketIOServer | null {
  return io;
}

/**
 * Emit event to all clients in a lobby room
 */
export function emitToLobby(gameId: string, event: string, data: unknown): void {
  if (!io) {
    // In tests we often exercise services without initializing Socket.IO.
    // Avoid spamming console during Jest runs; this is still a useful warning at runtime.
    if (process.env.NODE_ENV !== 'test') {
      console.warn('Socket.IO not initialized, cannot emit to lobby');
    }
    return;
  }
  io.to(`lobby-${gameId}`).emit(event, data);
}

/**
 * Emit lobby updated event with player list
 */
export async function emitLobbyUpdated(
  gameId: string,
  action: 'player-joined' | 'player-left',
  players: any[]
): Promise<void> {
  emitToLobby(gameId, 'lobby-updated', {
    gameId,
    players,
    action,
    timestamp: Date.now(),
  });
}

/**
 * Emit turn change event to all clients in a game room
 */
export function emitTurnChange(gameId: string, currentPlayerIndex: number, currentPlayerId?: string): void {
  if (!io) {
    console.warn('Socket.IO not initialized, cannot emit turn change');
    return;
  }
  io.to(gameId).emit('turn:change', {
    currentPlayerIndex,
    currentPlayerId,
    gameId,
    timestamp: Date.now(),
  });
}

/**
 * Emit event to all clients in a game room
 * @param gameId - The game ID
 * @param event - The event name
 * @param data - The data to emit
 */
export function emitToGame(gameId: string, event: string, data: unknown): void {
  if (!io) {
    console.warn('Socket.IO not initialized, cannot emit to game');
    return;
  }
  io.to(gameId).emit(event, data);
}

/**
 * Emit a state patch to all clients in a game room
 * Uses standardized format: { patch: Partial<GameState>, serverSeq: number }
 * @param gameId - The game ID
 * @param patch - The state patch (only changed data, not full state)
 */
export async function emitStatePatch(gameId: string, patch: Partial<GameState>): Promise<void> {
  if (!io) {
    console.warn('Socket.IO not initialized, cannot emit state patch');
    return;
  }
  const serverSeq = await nextServerSeq(gameId);
  io.to(gameId).emit('state:patch', {
    patch,
    serverSeq,
  });
}

/**
 * Emit victory triggered event to all clients in a game
 */
export function emitVictoryTriggered(
  gameId: string,
  triggerPlayerIndex: number,
  triggerPlayerName: string,
  finalTurnPlayerIndex: number,
  victoryThreshold: number
): void {
  if (!io) {
    console.warn('Socket.IO not initialized, cannot emit victory triggered');
    return;
  }
  io.to(gameId).emit('victory:triggered', {
    gameId,
    triggerPlayerIndex,
    triggerPlayerName,
    finalTurnPlayerIndex,
    victoryThreshold,
    timestamp: Date.now(),
  });
}

/**
 * Emit game over event to all clients in a game
 */
export function emitGameOver(
  gameId: string,
  winnerId: string,
  winnerName: string
): void {
  if (!io) {
    console.warn('Socket.IO not initialized, cannot emit game over');
    return;
  }
  io.to(gameId).emit('game:over', {
    gameId,
    winnerId,
    winnerName,
    timestamp: Date.now(),
  });
}

/**
 * Emit tie extended event when victory threshold increases to 300M
 */
export function emitTieExtended(
  gameId: string,
  newThreshold: number
): void {
  if (!io) {
    console.warn('Socket.IO not initialized, cannot emit tie extended');
    return;
  }
  io.to(gameId).emit('victory:tie-extended', {
    gameId,
    newThreshold,
    timestamp: Date.now(),
  });
}

