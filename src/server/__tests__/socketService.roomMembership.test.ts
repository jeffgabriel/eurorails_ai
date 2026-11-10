// server/__tests__/socketService.roomMembership.test.ts
// Real Socket.IO server + client: verifies that game and lobby rooms only admit
// authenticated, non-deleted players (#298), and that the `action` relay is gone.

jest.mock('../db', () => ({
  db: { query: jest.fn() },
}));
jest.mock('../services/authService', () => ({
  AuthService: {
    verifyToken: jest.fn((token: string) => (token.startsWith('token-') ? { userId: token.slice('token-'.length) } : null)),
  },
}));
jest.mock('../services/playerService', () => ({
  PlayerService: { isUserPlayerInGame: jest.fn() },
}));
jest.mock('../services/gameService', () => ({
  GameService: { getGame: jest.fn() },
}));
jest.mock('../services/ai/BotTurnTrigger', () => ({
  onTurnChange: jest.fn().mockResolvedValue(undefined),
  onHumanReconnect: jest.fn().mockResolvedValue(undefined),
  advanceTurnAfterBot: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../services/ActiveEffectManager', () => ({
  ActiveEffectManager: jest.fn().mockImplementation(() => ({
    getActiveEffects: jest.fn().mockResolvedValue([]),
  })),
}));

import { createServer, Server as HTTPServer } from 'http';
import { AddressInfo } from 'net';
import { io as ioClient, Socket as ClientSocket } from 'socket.io-client';
import { initializeSocketIO, getSocketIO, emitToGame, emitToLobby } from '../services/socketService';
import { db } from '../db';
import { PlayerService } from '../services/playerService';
import { GameService } from '../services/gameService';
import { onHumanReconnect } from '../services/ai/BotTurnTrigger';

const GAME_ID = '11111111-1111-4111-8111-111111111111';
const MEMBER_ID = '22222222-2222-4222-8222-222222222222';
const OUTSIDER_ID = '33333333-3333-4333-8333-333333333333';

const mockQuery = db.query as jest.Mock;
const mockIsMember = PlayerService.isUserPlayerInGame as jest.Mock;
const mockGetGame = GameService.getGame as jest.Mock;
const mockOnHumanReconnect = onHumanReconnect as jest.Mock;

type ServerError = { code: string; message: string };

describe('socketService room membership (#298)', () => {
  let httpServer: HTTPServer;
  let url: string;
  const clients: ClientSocket[] = [];
  const savedEnv = { ...process.env };

  beforeAll((done) => {
    httpServer = createServer();
    initializeSocketIO(httpServer);
    httpServer.listen(0, () => {
      url = `http://localhost:${(httpServer.address() as AddressInfo).port}`;
      done();
    });
  });

  afterAll((done) => {
    getSocketIO()?.close();
    httpServer.close(() => done());
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockQuery.mockImplementation(async (sql: string) => {
      if (sql.includes('server_seq')) return { rows: [{ server_seq: 7 }] };
      return { rows: [] };
    });
    mockIsMember.mockImplementation(async (_gameId: string, userId: string) => userId === MEMBER_ID);
    mockGetGame.mockResolvedValue({ id: GAME_ID, players: [] });
  });

  afterEach(() => {
    while (clients.length) clients.pop()!.disconnect();
    process.env = { ...savedEnv };
  });

  function connect(userId?: string, extraHeaders?: Record<string, string>): Promise<ClientSocket> {
    const client = ioClient(url, {
      transports: ['websocket'],
      auth: userId ? { token: `token-${userId}` } : {},
      extraHeaders,
      forceNew: true,
      reconnection: false,
    });
    clients.push(client);
    return new Promise((resolve, reject) => {
      client.once('connect', () => resolve(client));
      client.once('connect_error', reject);
    });
  }

  function nextEvent<T>(client: ClientSocket, event: string): Promise<T> {
    return new Promise((resolve) => client.once(event, (data: T) => resolve(data)));
  }

  /** Resolves true if `event` arrives within the window, false otherwise. */
  function receives(client: ClientSocket, event: string, ms = 200): Promise<boolean> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        client.off(event, onEvent);
        resolve(false);
      }, ms);
      function onEvent(): void {
        clearTimeout(timer);
        resolve(true);
      }
      client.once(event, onEvent);
    });
  }

  async function roomSize(room: string): Promise<number> {
    const sockets = await getSocketIO()!.in(room).fetchSockets();
    return sockets.length;
  }

  describe('join', () => {
    it('lets a member join the room and receive state:init', async () => {
      const client = await connect(MEMBER_ID);
      const init = nextEvent<{ gameState: unknown; serverSeq: number }>(client, 'state:init');
      client.emit('join', { gameId: GAME_ID });

      const data = await init;
      expect(data.gameState).toEqual({ id: GAME_ID, players: [] });
      expect(data.serverSeq).toBe(7);
      expect(await roomSize(GAME_ID)).toBe(1);
      expect(mockOnHumanReconnect).toHaveBeenCalledWith(GAME_ID);

      const patch = nextEvent<unknown>(client, 'state:patch');
      emitToGame(GAME_ID, 'state:patch', { patch: {}, serverSeq: 8 });
      await expect(patch).resolves.toEqual({ patch: {}, serverSeq: 8 });
    });

    it('rejects an unauthenticated socket without joining the room', async () => {
      const client = await connect();
      const error = nextEvent<ServerError>(client, 'error');
      client.emit('join', { gameId: GAME_ID });

      expect((await error).code).toBe('UNAUTHORIZED');
      expect(await roomSize(GAME_ID)).toBe(0);
      expect(mockOnHumanReconnect).not.toHaveBeenCalled();

      const gotBroadcast = receives(client, 'state:patch');
      emitToGame(GAME_ID, 'state:patch', { patch: {}, serverSeq: 8 });
      expect(await gotBroadcast).toBe(false);
    });

    it('rejects a non-member (including deleted players) without joining the room', async () => {
      const client = await connect(OUTSIDER_ID);
      const error = nextEvent<ServerError>(client, 'error');
      client.emit('join', { gameId: GAME_ID });

      expect((await error).code).toBe('FORBIDDEN');
      expect(mockIsMember).toHaveBeenCalledWith(GAME_ID, OUTSIDER_ID);
      expect(await roomSize(GAME_ID)).toBe(0);
      expect(mockOnHumanReconnect).not.toHaveBeenCalled();
      expect(mockGetGame).not.toHaveBeenCalled();

      const gotBroadcast = receives(client, 'turn:change');
      emitToGame(GAME_ID, 'turn:change', { currentPlayerIndex: 0 });
      expect(await gotBroadcast).toBe(false);
    });

    it('rejects a malformed game id without querying membership', async () => {
      const client = await connect(MEMBER_ID);
      const error = nextEvent<ServerError>(client, 'error');
      client.emit('join', { gameId: 'not-a-uuid' });

      expect((await error).code).toBe('FORBIDDEN');
      expect(mockIsMember).not.toHaveBeenCalled();
      expect(await roomSize('not-a-uuid')).toBe(0);
    });
  });

  describe('join-lobby', () => {
    it('lets a member join the lobby room', async () => {
      const client = await connect(MEMBER_ID);
      client.emit('join-lobby', { gameId: GAME_ID });

      const update = nextEvent<unknown>(client, 'lobby-updated');
      // Wait for the async membership check to finish before broadcasting.
      await waitFor(async () => (await roomSize(`lobby-${GAME_ID}`)) === 1);
      emitToLobby(GAME_ID, 'lobby-updated', { gameId: GAME_ID });
      await expect(update).resolves.toEqual({ gameId: GAME_ID });
    });

    it('rejects unauthenticated and non-member sockets', async () => {
      const anon = await connect();
      const outsider = await connect(OUTSIDER_ID);
      const anonError = nextEvent<ServerError>(anon, 'error');
      const outsiderError = nextEvent<ServerError>(outsider, 'error');
      anon.emit('join-lobby', { gameId: GAME_ID });
      outsider.emit('join-lobby', { gameId: GAME_ID });

      expect((await anonError).code).toBe('UNAUTHORIZED');
      expect((await outsiderError).code).toBe('FORBIDDEN');
      expect(await roomSize(`lobby-${GAME_ID}`)).toBe(0);

      const anonGot = receives(anon, 'lobby-updated');
      const outsiderGot = receives(outsider, 'lobby-updated');
      emitToLobby(GAME_ID, 'lobby-updated', { gameId: GAME_ID });
      expect(await anonGot).toBe(false);
      expect(await outsiderGot).toBe(false);
    });
  });

  describe('action relay', () => {
    it('ignores the removed action event: no server_seq bump and no broadcast', async () => {
      const member = await connect(MEMBER_ID);
      const init = nextEvent<unknown>(member, 'state:init');
      member.emit('join', { gameId: GAME_ID });
      await init;
      mockQuery.mockClear();

      const attacker = await connect(OUTSIDER_ID);
      const memberGotPatch = receives(member, 'state:patch');
      attacker.emit('action', { gameId: GAME_ID, type: 'x', payload: { money: 9999 }, clientSeq: 1 });

      expect(await memberGotPatch).toBe(false);
      expect(mockQuery.mock.calls.some(([sql]) => String(sql).includes('server_seq'))).toBe(false);
    });
  });

  describe('autorun:toggle', () => {
    it('only matches non-deleted players', async () => {
      const client = await connect(MEMBER_ID);
      const error = nextEvent<ServerError>(client, 'error');
      client.emit('autorun:toggle', { gameId: GAME_ID });
      // The mocked lookup returns no rows, standing in for a deleted player.
      expect((await error).code).toBe('NOT_IN_GAME');

      // Disconnect cleanup from earlier tests also runs `SELECT id FROM players`,
      // so match the toggle lookup by its deleted-player filter.
      const lookup = mockQuery.mock.calls.find(
        ([sql]) => String(sql).includes('SELECT id FROM players') && String(sql).includes('is_deleted = false'),
      );
      expect(lookup?.[1]).toEqual([GAME_ID, MEMBER_ID]);
    });
  });

  describe('origin check', () => {
    it('refuses a websocket handshake from an origin outside the allow-list', async () => {
      process.env.ALLOWED_ORIGINS = 'https://good.example';
      await expect(connect(MEMBER_ID, { origin: 'https://evil.example' })).rejects.toBeDefined();
    });

    it('accepts a handshake from an allowed origin', async () => {
      process.env.ALLOWED_ORIGINS = 'https://good.example, https://also-good.example';
      const client = await connect(MEMBER_ID, { origin: 'https://also-good.example' });
      expect(client.connected).toBe(true);
    });
  });
});

async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 1000): Promise<void> {
  const start = Date.now();
  while (!(await predicate())) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
