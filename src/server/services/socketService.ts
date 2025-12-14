// services/socketService.ts
import { Server as SocketIOServer, Socket } from 'socket.io';
import type { Server as HTTPServer } from 'http';
import type { GameState } from '../../shared/types/GameTypes';
import { AuthService } from './authService';
import { db } from '../db';

let io: SocketIOServer | null = null;
let presenceSweepInterval: NodeJS.Timeout | null = null;

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
             AND last_seen_at < NOW() - INTERVAL '5 minutes'`
        );
      } catch (err) {
        console.error('Presence sweep failed:', err);
      }
    }, 60_000);
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
    }, 60_000);
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
      socket.join(data.gameId);
      if (userId) {
        joinedGameIds.add(data.gameId);
        db.query(
          `UPDATE players
           SET is_online = true,
               last_seen_at = NOW()
           WHERE game_id = $1 AND user_id = $2`,
          [data.gameId, userId]
        ).catch((err) => console.error('Failed to set presence on join:', err));
      }
    });

    socket.on('action', (data: { gameId: string; type: string; payload: unknown; clientSeq: number }) => {
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
      // Forward action to other players in the game
      socket.to(data.gameId).emit('state:patch', {
        patch: data.payload as any,
        serverSeq: data.clientSeq,
      });
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
    console.warn('Socket.IO not initialized, cannot emit to lobby');
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
export function emitStatePatch(gameId: string, patch: Partial<GameState>): void {
  if (!io) {
    console.warn('Socket.IO not initialized, cannot emit state patch');
    return;
  }

  const serverSeq = Date.now(); // Can be replaced with proper sequence number later
  io.to(gameId).emit('state:patch', {
    patch,
    serverSeq,
  });
}

