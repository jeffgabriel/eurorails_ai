/**
 * Tests for POST /api/diag/client — opt-in client device diagnostics sink.
 */

import request from 'supertest';
import express from 'express';
import { v4 as uuidv4 } from 'uuid';
import clientDiagRoutes, {
  CLIENT_DIAG_LOG_PREFIX,
  MAX_BATCHES_PER_WINDOW,
  MAX_ENTRIES_PER_BATCH,
  resetClientDiagRateLimits,
} from '../routes/clientDiagRoutes';
import { AuthService } from '../services/authService';

jest.mock('../services/authService');

const mockAuthService = AuthService as jest.Mocked<typeof AuthService>;

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use('/api/diag', clientDiagRoutes);

describe('POST /api/diag/client', () => {
  const userId = uuidv4();
  const sessionId = uuidv4();
  const gameId = uuidv4();
  let logSpy: jest.SpyInstance;

  const authenticate = (): void => {
    mockAuthService.verifyToken.mockReturnValue({
      userId,
      username: 'tester',
      email: 'tester@example.com',
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 900,
    } as any);
    mockAuthService.findUserById.mockResolvedValue({
      id: userId,
      username: 'tester',
      email: 'tester@example.com',
      emailVerified: true,
      createdAt: new Date(),
      lastActive: new Date(),
      updatedAt: new Date(),
    } as any);
  };

  const entry = (i: number): Record<string, unknown> => ({ t: i * 10, seq: i, cat: 'dom', ev: 'pointerdown', data: { x: i } });

  beforeEach(() => {
    resetClientDiagRateLimits();
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => {
    logSpy.mockRestore();
    jest.clearAllMocks();
  });

  it('returns 401 without a token', async () => {
    await request(app).post('/api/diag/client').send({ sessionId, entries: [] }).expect(401);
    expect(logSpy).not.toHaveBeenCalled();
  });

  it('returns 400 when sessionId is not a uuid', async () => {
    authenticate();
    const res = await request(app)
      .post('/api/diag/client')
      .set('Authorization', 'Bearer t')
      .send({ sessionId: 'nope', entries: [entry(0)] })
      .expect(400);
    expect(res.body.error).toBe('INVALID_BODY');
  });

  it('returns 400 when gameId is present but not a uuid', async () => {
    authenticate();
    await request(app)
      .post('/api/diag/client')
      .set('Authorization', 'Bearer t')
      .send({ sessionId, gameId: '123', entries: [entry(0)] })
      .expect(400);
  });

  it('returns 400 when the batch has too many entries', async () => {
    authenticate();
    const entries = Array.from({ length: MAX_ENTRIES_PER_BATCH + 1 }, (_, i) => entry(i));
    const res = await request(app)
      .post('/api/diag/client')
      .set('Authorization', 'Bearer t')
      .send({ sessionId, entries })
      .expect(400);
    expect(res.body.error).toBe('BATCH_TOO_LARGE');
  });

  it('returns 400 when the batch exceeds the byte cap', async () => {
    authenticate();
    const big = 'x'.repeat(1000);
    const entries = Array.from({ length: 80 }, (_, i) => ({ ...entry(i), data: { big } }));
    const res = await request(app)
      .post('/api/diag/client')
      .set('Authorization', 'Bearer t')
      .send({ sessionId, entries })
      .expect(400);
    expect(res.body.error).toBe('BATCH_TOO_LARGE');
  });

  it('writes one prefixed JSON line per entry and returns 204', async () => {
    authenticate();
    await request(app)
      .post('/api/diag/client')
      .set('Authorization', 'Bearer t')
      .send({ sessionId, gameId, entries: [entry(0), entry(1)] })
      .expect(204);

    expect(logSpy).toHaveBeenCalledTimes(2);
    const [prefix, json] = logSpy.mock.calls[0];
    expect(prefix).toBe(CLIENT_DIAG_LOG_PREFIX);
    const parsed = JSON.parse(json as string);
    expect(parsed).toMatchObject({ userId, sessionId, gameId, seq: 0, cat: 'dom', ev: 'pointerdown', data: { x: 0 } });
  });

  it('skips non-object entries and truncates long cat/ev fields', async () => {
    authenticate();
    await request(app)
      .post('/api/diag/client')
      .set('Authorization', 'Bearer t')
      .send({ sessionId, entries: ['junk', { seq: 1, cat: 'c'.repeat(200), ev: 'e' }] })
      .expect(204);

    expect(logSpy).toHaveBeenCalledTimes(1);
    const parsed = JSON.parse(logSpy.mock.calls[0][1] as string);
    expect(parsed.cat).toHaveLength(64);
  });

  it('returns 429 once the per-user batch cap is exceeded', async () => {
    authenticate();
    for (let i = 0; i < MAX_BATCHES_PER_WINDOW; i++) {
      await request(app)
        .post('/api/diag/client')
        .set('Authorization', 'Bearer t')
        .send({ sessionId, entries: [] })
        .expect(204);
    }
    const res = await request(app)
      .post('/api/diag/client')
      .set('Authorization', 'Bearer t')
      .send({ sessionId, entries: [] })
      .expect(429);
    expect(res.body.error).toBe('RATE_LIMITED');
  });
});
