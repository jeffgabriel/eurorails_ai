// server/__tests__/authTokenTypes.test.ts
// A refresh token must not work as an access token (#300): not in AuthService,
// not on a protected HTTP route, and not on the Socket.IO handshake. Uses the
// real AuthService so the tokens are the ones the server actually issues.

jest.mock('../db', () => ({
  db: { query: jest.fn() },
}));
jest.mock('../services/verificationService');
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
import request from 'supertest';
import express from 'express';
import jwt from 'jsonwebtoken';
import { io as ioClient, Socket as ClientSocket } from 'socket.io-client';
import authRoutes from '../routes/authRoutes';
import { AuthService } from '../services/authService';
import { initializeSocketIO, getSocketIO } from '../services/socketService';
import { db } from '../db';
import { User } from '../../shared/types/AuthTypes';

const USER_ID = '22222222-2222-4222-8222-222222222222';
const USER_ROW = {
  id: USER_ID,
  username: 'tokenuser',
  email: 'tokenuser@example.com',
  password_hash: 'unused',
  email_verified: true,
  created_at: new Date(),
  last_active: new Date(),
  updated_at: new Date(),
};
const USER: User = {
  id: USER_ID,
  username: USER_ROW.username,
  email: USER_ROW.email,
  emailVerified: true,
  createdAt: USER_ROW.created_at,
  lastActive: USER_ROW.last_active,
  updatedAt: USER_ROW.updated_at,
};

const mockQuery = db.query as jest.Mock;

describe('access vs refresh tokens (#300)', () => {
  let accessToken: string;
  let refreshToken: string;
  let consoleWarnSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    consoleWarnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    mockQuery.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM users')) return { rows: [USER_ROW] };
      return { rows: [] };
    });
    // The server's own (private) generators, so the test tracks the real token shape.
    accessToken = AuthService['generateAccessToken'](USER);
    refreshToken = AuthService['generateRefreshToken'](USER_ID);
  });

  afterEach(() => {
    consoleWarnSpy.mockRestore();
  });

  describe('AuthService', () => {
    it('verifyToken accepts an access token and rejects a refresh token', () => {
      expect(AuthService.verifyToken(accessToken)).toMatchObject({ userId: USER_ID });
      expect(AuthService.verifyToken(refreshToken)).toBeNull();
    });

    it('verifyRefreshToken accepts a refresh token and rejects an access token', () => {
      expect(AuthService.verifyRefreshToken(refreshToken)).toMatchObject({ userId: USER_ID, type: 'refresh' });
      expect(AuthService.verifyRefreshToken(accessToken)).toBeNull();
    });

    it('both reject tokens that are expired, wrongly signed, malformed or lack a userId', () => {
      const secret = process.env.JWT_SECRET as string;
      const bad = [
        jwt.sign({ type: 'refresh', userId: USER_ID }, secret, { expiresIn: -10 }),
        jwt.sign({ userId: USER_ID }, secret, { expiresIn: -10 }),
        jwt.sign({ type: 'refresh', userId: USER_ID }, 'some-other-secret'),
        jwt.sign({ userId: USER_ID }, 'some-other-secret'),
        jwt.sign({ type: 'refresh' }, secret),
        jwt.sign({ email: 'nobody@example.com' }, secret),
        jwt.sign('just-a-string', secret),
        'not.a.jwt',
      ];
      for (const token of bad) {
        expect(AuthService.verifyToken(token)).toBeNull();
        expect(AuthService.verifyRefreshToken(token)).toBeNull();
      }
    });

    it('refreshAccessToken exchanges a refresh token for a working pair', async () => {
      const result = await AuthService.refreshAccessToken(refreshToken);
      expect(AuthService.verifyToken(result.token)).toMatchObject({ userId: USER_ID });
      expect(AuthService.verifyRefreshToken(result.refreshToken)).toMatchObject({ userId: USER_ID });
    });

    it('refreshAccessToken rejects an access token', async () => {
      await expect(AuthService.refreshAccessToken(accessToken)).rejects.toThrow('Invalid refresh token');
    });
  });

  describe('protected HTTP route', () => {
    const app = express();
    app.use(express.json());
    app.use('/api/auth', authRoutes);

    it('accepts an access token', async () => {
      const res = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${accessToken}`);
      expect(res.status).toBe(200);
      expect(res.body.data.user.id).toBe(USER_ID);
    });

    it('answers 401 to a refresh token', async () => {
      const res = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${refreshToken}`);
      expect(res.status).toBe(401);
      expect(res.body.error).toBe('UNAUTHORIZED');
      // Rejected on the token alone, before any user lookup.
      expect(mockQuery).not.toHaveBeenCalled();
    });

    it('POST /refresh accepts the refresh token and answers 401 to an access token', async () => {
      const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
      try {
        const ok = await request(app).post('/api/auth/refresh').send({ refreshToken });
        expect(ok.status).toBe(200);
        expect(AuthService.verifyToken(ok.body.data.token)).toMatchObject({ userId: USER_ID });

        const rejected = await request(app).post('/api/auth/refresh').send({ refreshToken: accessToken });
        expect(rejected.status).toBe(401);
        expect(rejected.body.error).toBe('INVALID_REFRESH_TOKEN');
      } finally {
        consoleErrorSpy.mockRestore();
      }
    });
  });

  describe('socket handshake', () => {
    let httpServer: HTTPServer;
    let url: string;
    const clients: ClientSocket[] = [];

    beforeAll((done) => {
      httpServer = createServer();
      initializeSocketIO(httpServer);
      httpServer.listen(0, () => {
        url = `http://localhost:${(httpServer.address() as AddressInfo).port}`;
        done();
      });
    });

    afterAll((done) => {
      // io.close() also closes the attached HTTP server; closing it again errors.
      const io = getSocketIO();
      if (io) {
        io.close(() => done());
      } else {
        httpServer.close(() => done());
      }
    });

    afterEach(() => {
      while (clients.length) clients.pop()!.disconnect();
    });

    function connect(options: { auth?: { token: string }; extraHeaders?: Record<string, string> }): Promise<ClientSocket> {
      const client = ioClient(url, {
        transports: ['websocket'],
        forceNew: true,
        reconnection: false,
        ...options,
      });
      clients.push(client);
      return new Promise((resolve, reject) => {
        client.once('connect', () => resolve(client));
        client.once('connect_error', reject);
      });
    }

    it('accepts an access token', async () => {
      const client = await connect({ auth: { token: accessToken } });
      expect(client.connected).toBe(true);
    });

    it('rejects a refresh token in handshake auth', async () => {
      await expect(connect({ auth: { token: refreshToken } })).rejects.toThrow('UNAUTHORIZED');
    });

    it('rejects a refresh token in the Authorization header', async () => {
      await expect(
        connect({ extraHeaders: { Authorization: `Bearer ${refreshToken}` } }),
      ).rejects.toThrow('UNAUTHORIZED');
    });
  });
});
