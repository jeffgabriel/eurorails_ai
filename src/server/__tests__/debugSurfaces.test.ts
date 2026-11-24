/**
 * Security #299 — debug surfaces are closed unless explicitly configured.
 *
 * - Deck debug routes: NODE_ENV=test or development, or DEBUG_ROUTES_SECRET + matching header.
 * - Log/LLM viewers: NODE_ENV=development or ENABLE_DEBUG_VIEWERS=true.
 * - Viewer pages HTML-escape log content.
 */

import request from 'supertest';
import express from 'express';
import deckRoutes from '../routes/deckRoutes';
import { mountLogViewers } from '../routes/logRoutes';
import { listGameLogs } from '../services/logParser';
import { areDebugViewersEnabled, isDebugRouteRequestAllowed } from '../utils/debugAccess';

jest.mock('../services/authService');
jest.mock('../db/index', () => ({ db: { query: jest.fn(), connect: jest.fn() } }));
jest.mock('../services/demandDeckService', () => ({
  DemandDeckService: {
    destroyAllInstances: jest.fn(),
    loadForGame: jest.fn(),
  },
}));
jest.mock('../services/logParser', () => ({
  isValidGameId: jest.fn(() => true),
  listGameLogs: jest.fn(() => []),
  loadGameLog: jest.fn(() => null),
  loadLLMTranscript: jest.fn(() => null),
  inferDecisionSource: jest.fn(() => 'heuristic'),
  isLlmModel: jest.fn(() => false),
  fmt: jest.fn((n: number) => String(n)),
  secs: jest.fn((ms: number) => `${ms}ms`),
  loc: jest.fn(() => '(0,0)'),
}));

const OLD_HARDCODED_SECRET = 'test-reset-secret';
const DEBUG_ENV_KEYS = ['NODE_ENV', 'DEBUG_ROUTES_SECRET', 'ENABLE_DEBUG_VIEWERS'] as const;

function setEnv(values: Partial<Record<(typeof DEBUG_ENV_KEYS)[number], string>>): void {
  for (const key of DEBUG_ENV_KEYS) {
    const value = values[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

describe('debug surfaces (#299)', () => {
  const savedEnv: Partial<Record<(typeof DEBUG_ENV_KEYS)[number], string | undefined>> = {};

  beforeAll(() => {
    for (const key of DEBUG_ENV_KEYS) {
      savedEnv[key] = process.env[key];
    }
  });

  afterEach(() => {
    setEnv(savedEnv as Partial<Record<(typeof DEBUG_ENV_KEYS)[number], string>>);
    jest.clearAllMocks();
  });

  describe('isDebugRouteRequestAllowed', () => {
    it.each(['test', 'development'])('allows any request under NODE_ENV=%s', (nodeEnv) => {
      setEnv({ NODE_ENV: nodeEnv });
      expect(isDebugRouteRequestAllowed(undefined)).toBe(true);
    });

    it('rejects requests when NODE_ENV is unset and no secret is configured', () => {
      setEnv({});
      expect(isDebugRouteRequestAllowed(undefined)).toBe(false);
    });

    it('rejects the old hardcoded secret in production', () => {
      setEnv({ NODE_ENV: 'production' });
      expect(isDebugRouteRequestAllowed(OLD_HARDCODED_SECRET)).toBe(false);
    });

    it('rejects everything when no secret is configured, including empty values', () => {
      setEnv({ NODE_ENV: 'production', DEBUG_ROUTES_SECRET: '' });
      expect(isDebugRouteRequestAllowed('')).toBe(false);
      expect(isDebugRouteRequestAllowed(undefined)).toBe(false);
    });

    it('accepts only the configured secret', () => {
      setEnv({ NODE_ENV: 'production', DEBUG_ROUTES_SECRET: 's3cret-value' });
      expect(isDebugRouteRequestAllowed('s3cret-value')).toBe(true);
      expect(isDebugRouteRequestAllowed('s3cret-valuX')).toBe(false);
      expect(isDebugRouteRequestAllowed('s3cret')).toBe(false);
      expect(isDebugRouteRequestAllowed(['s3cret-value'])).toBe(false);
    });
  });

  describe('deck debug routes', () => {
    const app = express();
    app.use(express.json());
    app.use('/api/deck', deckRoutes);

    const debugRoutes: Array<{ path: string; body: Record<string, unknown> }> = [
      { path: '/api/deck/reset', body: {} },
      { path: '/api/deck/debug/push-event', body: { gameId: 'g1', eventCardId: 121 } },
      { path: '/api/deck/debug/reshuffle', body: { gameId: 'g1' } },
    ];

    it.each(debugRoutes)('$path returns 403 in production, even with the old secret', async ({ path, body }) => {
      setEnv({ NODE_ENV: 'production' });

      const withoutHeader = await request(app).post(path).send(body);
      const withOldSecret = await request(app).post(path).set('x-test-secret', OLD_HARDCODED_SECRET).send(body);

      expect(withoutHeader.status).toBe(403);
      expect(withOldSecret.status).toBe(403);
    });

    it.each(debugRoutes)('$path returns 403 for a wrong secret when one is configured', async ({ path, body }) => {
      setEnv({ NODE_ENV: 'production', DEBUG_ROUTES_SECRET: 's3cret-value' });

      const response = await request(app).post(path).set('x-test-secret', OLD_HARDCODED_SECRET).send(body);

      expect(response.status).toBe(403);
    });

    it('allows reset with the configured secret', async () => {
      setEnv({ NODE_ENV: 'production', DEBUG_ROUTES_SECRET: 's3cret-value' });

      const response = await request(app).post('/api/deck/reset').set('x-test-secret', 's3cret-value');

      expect(response.status).toBe(200);
    });

    it.each(['test', 'development'])('allows reset under NODE_ENV=%s without a header', async (nodeEnv) => {
      setEnv({ NODE_ENV: nodeEnv });

      const response = await request(app).post('/api/deck/reset');

      expect(response.status).toBe(200);
    });
  });

  describe('log/LLM viewers', () => {
    const viewerPaths = ['/logs', '/logs/abc123', '/logs/api/log/abc123', '/log/abc123', '/llm/abc123', '/llm/api/abc123'];

    function buildApp(): express.Express {
      const app = express();
      mountLogViewers(app);
      // Stand-in for the SPA fallback: proves disabled viewers never fall through to it.
      app.get('*', (_req, res) => {
        res.status(200).send('spa');
      });
      return app;
    }

    it('are enabled only in development or with ENABLE_DEBUG_VIEWERS=true', () => {
      setEnv({ NODE_ENV: 'production' });
      expect(areDebugViewersEnabled()).toBe(false);
      setEnv({ NODE_ENV: 'test' });
      expect(areDebugViewersEnabled()).toBe(false);
      setEnv({ NODE_ENV: 'production', ENABLE_DEBUG_VIEWERS: '1' });
      expect(areDebugViewersEnabled()).toBe(false);
      setEnv({ NODE_ENV: 'development' });
      expect(areDebugViewersEnabled()).toBe(true);
      setEnv({ NODE_ENV: 'production', ENABLE_DEBUG_VIEWERS: 'true' });
      expect(areDebugViewersEnabled()).toBe(true);
    });

    it.each(viewerPaths)('%s returns 404 in production', async (path) => {
      setEnv({ NODE_ENV: 'production' });

      const response = await request(buildApp()).get(path);

      expect(response.status).toBe(404);
    });

    it('does not shadow SPA routes that merely share a prefix', async () => {
      setEnv({ NODE_ENV: 'production' });

      const response = await request(buildApp()).get('/login');

      expect(response.status).toBe(200);
      expect(response.text).toBe('spa');
    });

    it('serves the index in development', async () => {
      setEnv({ NODE_ENV: 'development' });

      const response = await request(buildApp()).get('/logs');

      expect(response.status).toBe(200);
      expect(response.text).toContain('Game Logs');
    });

    it('serves the index in production with ENABLE_DEBUG_VIEWERS=true', async () => {
      setEnv({ NODE_ENV: 'production', ENABLE_DEBUG_VIEWERS: 'true' });

      const response = await request(buildApp()).get('/logs');

      expect(response.status).toBe(200);
    });

    it('HTML-escapes player and model names on the index page', async () => {
      setEnv({ NODE_ENV: 'development' });
      (listGameLogs as jest.Mock).mockReturnValue([
        {
          gameId: 'abc123',
          turnCount: 3,
          players: ['<script>alert(1)</script>'],
          models: ['<img src=x onerror="alert(2)">'],
          lastModified: new Date('2026-01-01T00:00:00Z'),
        },
      ]);

      const response = await request(buildApp()).get('/logs');

      expect(response.status).toBe(200);
      expect(response.text).not.toContain('<script>alert(1)</script>');
      expect(response.text).not.toContain('<img src=x');
      expect(response.text).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
      expect(response.text).toContain('&lt;img src=x onerror=&quot;alert(2)&quot;&gt;');
    });
  });
});
