// server/__tests__/authRateLimit.test.ts
// Per-IP rate limits on the credential routes (#300): going over the limit gets
// 429 in the shared rateLimitHandler shape, on the real auth router.

jest.mock('../db', () => ({
  db: { query: jest.fn() },
}));
jest.mock('../services/authService');
jest.mock('../services/verificationService');

import request from 'supertest';
import express, { Express, Request, Response } from 'express';
import authRoutes from '../routes/authRoutes';
import { AuthService } from '../services/authService';
import { addRequestId } from '../middleware/errorHandler';
import {
  configureTrustProxy,
  createAuthRateLimiter,
  isAuthRateLimitEnabled,
} from '../middleware/authRateLimit';

const mockAuthService = AuthService as jest.Mocked<typeof AuthService>;

const ENV_KEYS = ['AUTH_RATE_LIMIT_ENABLED', 'TRUST_PROXY', 'NODE_ENV'] as const;

function buildAuthApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(addRequestId);
  app.use('/api/auth', authRoutes);
  return app;
}

/** POST `body` to `path` `count` times, one after another; returns each status. */
async function postTimes(app: Express, path: string, body: object, count: number): Promise<number[]> {
  const statuses: number[] = [];
  for (let i = 0; i < count; i++) {
    const res = await request(app).post(path).send(body);
    statuses.push(res.status);
  }
  return statuses;
}

describe('auth rate limiting (#300)', () => {
  const savedEnv: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};
  let consoleWarnSpy: jest.SpyInstance;
  let consoleErrorSpy: jest.SpyInstance;

  beforeAll(() => {
    for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
  });

  beforeEach(() => {
    jest.clearAllMocks();
    consoleWarnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    mockAuthService.login.mockRejectedValue(new Error('Invalid email or password'));
    mockAuthService.register.mockRejectedValue(new Error('Username is already taken'));
    mockAuthService.refreshAccessToken.mockRejectedValue(new Error('Invalid refresh token'));
  });

  afterEach(() => {
    consoleWarnSpy.mockRestore();
    consoleErrorSpy.mockRestore();
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
  });

  describe('isAuthRateLimitEnabled', () => {
    it('is off under NODE_ENV=test and on elsewhere, unless overridden', () => {
      delete process.env.AUTH_RATE_LIMIT_ENABLED;
      process.env.NODE_ENV = 'test';
      expect(isAuthRateLimitEnabled()).toBe(false);
      process.env.NODE_ENV = 'production';
      expect(isAuthRateLimitEnabled()).toBe(true);
      process.env.NODE_ENV = 'development';
      expect(isAuthRateLimitEnabled()).toBe(true);

      process.env.AUTH_RATE_LIMIT_ENABLED = 'false';
      expect(isAuthRateLimitEnabled()).toBe(false);
      process.env.NODE_ENV = 'test';
      process.env.AUTH_RATE_LIMIT_ENABLED = 'true';
      expect(isAuthRateLimitEnabled()).toBe(true);
    });
  });

  describe('auth routes', () => {
    const loginBody = { email: 'player@example.com', password: 'WrongPass1' };
    const registerBody = {
      username: 'player',
      email: 'player@example.com',
      password: 'Password1',
      confirmPassword: 'Password1',
    };
    const refreshBody = { refreshToken: 'not-a-real-token' };

    it('does not limit when disabled (the default under NODE_ENV=test)', async () => {
      delete process.env.AUTH_RATE_LIMIT_ENABLED;
      const statuses = await postTimes(buildAuthApp(), '/api/auth/login', loginBody, 12);
      expect(statuses).toEqual(Array(12).fill(401));
    });

    it('answers 429 after 10 failed logins', async () => {
      process.env.AUTH_RATE_LIMIT_ENABLED = 'true';
      const app = buildAuthApp();

      const statuses = await postTimes(app, '/api/auth/login', loginBody, 10);
      expect(statuses).toEqual(Array(10).fill(401));

      const blocked = await request(app).post('/api/auth/login').send(loginBody);
      expect(blocked.status).toBe(429);
      expect(blocked.body).toMatchObject({
        error: 'RATE_LIMIT_EXCEEDED',
        message: 'Too many requests',
        path: '/login',
        method: 'POST',
      });
      expect(blocked.body.requestId).toEqual(blocked.headers['x-request-id']);
      expect(blocked.headers['retry-after']).toBeDefined();
      // The limiter answers before the handler: no 11th password check.
      expect(mockAuthService.login).toHaveBeenCalledTimes(10);
    });

    it('answers 429 after 20 registration attempts', async () => {
      process.env.AUTH_RATE_LIMIT_ENABLED = 'true';
      const app = buildAuthApp();

      const statuses = await postTimes(app, '/api/auth/register', registerBody, 20);
      expect(statuses).toEqual(Array(20).fill(400));

      const blocked = await request(app).post('/api/auth/register').send(registerBody);
      expect(blocked.status).toBe(429);
      expect(blocked.body.error).toBe('RATE_LIMIT_EXCEEDED');
      expect(mockAuthService.register).toHaveBeenCalledTimes(20);
    });

    it('answers 429 after 30 refresh attempts', async () => {
      process.env.AUTH_RATE_LIMIT_ENABLED = 'true';
      const app = buildAuthApp();

      const statuses = await postTimes(app, '/api/auth/refresh', refreshBody, 30);
      expect(statuses).toEqual(Array(30).fill(401));

      const blocked = await request(app).post('/api/auth/refresh').send(refreshBody);
      expect(blocked.status).toBe(429);
      expect(blocked.body.error).toBe('RATE_LIMIT_EXCEEDED');
      expect(mockAuthService.refreshAccessToken).toHaveBeenCalledTimes(30);
    });

    it('keeps a separate budget per route', async () => {
      // The login budget was spent above; an unrelated auth route still answers.
      process.env.AUTH_RATE_LIMIT_ENABLED = 'true';
      const res = await request(buildAuthApp()).post('/api/auth/logout');
      expect(res.status).toBe(401);
    });
  });

  describe('createAuthRateLimiter', () => {
    function buildApp(skipSuccessfulRequests: boolean): Express {
      const app = express();
      const limiter = createAuthRateLimiter({ windowMs: 60_000, limit: 2, skipSuccessfulRequests });
      app.post('/ok', limiter, (_req: Request, res: Response) => { res.status(200).json({}); });
      app.post('/fail', limiter, (_req: Request, res: Response) => { res.status(401).json({}); });
      return app;
    }

    it('counts every request by default', async () => {
      process.env.AUTH_RATE_LIMIT_ENABLED = 'true';
      expect(await postTimes(buildApp(false), '/ok', {}, 3)).toEqual([200, 200, 429]);
    });

    it('counts only failures with skipSuccessfulRequests', async () => {
      process.env.AUTH_RATE_LIMIT_ENABLED = 'true';
      const app = buildApp(true);
      expect(await postTimes(app, '/ok', {}, 5)).toEqual(Array(5).fill(200));
      expect(await postTimes(app, '/fail', {}, 3)).toEqual([401, 401, 429]);
    });
  });

  describe('configureTrustProxy', () => {
    function trustProxySetting(): unknown {
      const app = express();
      configureTrustProxy(app);
      return app.get('trust proxy');
    }

    it('trusts one hop in production and none elsewhere by default', () => {
      delete process.env.TRUST_PROXY;
      process.env.NODE_ENV = 'production';
      expect(trustProxySetting()).toBe(1);
      process.env.NODE_ENV = 'development';
      expect(trustProxySetting()).toBe(false);
    });

    it('honours TRUST_PROXY', () => {
      process.env.NODE_ENV = 'production';
      process.env.TRUST_PROXY = '2';
      expect(trustProxySetting()).toBe(2);
      process.env.TRUST_PROXY = 'false';
      expect(trustProxySetting()).toBe(false);
    });

    it('rejects a TRUST_PROXY that is not a hop count', () => {
      process.env.TRUST_PROXY = 'true';
      expect(() => trustProxySetting()).toThrow('TRUST_PROXY must be');
    });
  });
});
