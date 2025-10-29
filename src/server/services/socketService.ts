// services/socketService.ts
import { Server as SocketIOServer, Socket } from 'socket.io';
import type { Server as HTTPServer } from 'http';

let io: SocketIOServer | null = null;

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

  console.log('Socket.IO server initialized');

  // Handle socket connections
  io.on('connection', (socket: Socket) => {
    console.log('Client connected:', socket.id);

    // Handle disconnection
    socket.on('disconnect', () => {
      console.log('Client disconnected:', socket.id);
    });

    // Handle join lobby event
    socket.on('join-lobby', (data: { gameId: string }) => {
      if (!data || !data.gameId || typeof data.gameId !== 'string' || data.gameId.trim() === '') {
        console.warn(`Invalid gameId from client ${socket.id} for join-lobby`);
        return;
      }
      const { gameId } = data;
      console.log(`Client ${socket.id} joining lobby for game ${gameId}`);
      socket.join(`lobby-${gameId}`);
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
      console.log(`Client ${socket.id} leaving lobby for game ${gameId}`);
      socket.leave(`lobby-${gameId}`);
      // Note: We don't emit lobby-updated here because the LobbyService
      // handles emitting proper events with player data when players actually join/leave
    });

    // Handle other existing game events (preserve existing functionality)
    socket.on('join', (data: { gameId: string }) => {
      if (!data || !data.gameId || typeof data.gameId !== 'string' || data.gameId.trim() === '') {
        console.warn(`Invalid gameId from client ${socket.id} for join`);
        return;
      }
      console.log(`Client ${socket.id} joining game ${data.gameId}`);
      socket.join(data.gameId);
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
      console.log(`Client ${socket.id} sent action: ${data.type} for game ${data.gameId}`);
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

  console.log(`Emitting ${event} to lobby-${gameId}`);
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

