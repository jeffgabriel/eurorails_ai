/**
 * clientDiagRoutes — sink for opt-in client device diagnostics.
 *
 * The client only sends batches when the page was opened with `?diag=1`
 * (see src/client/utils/deviceDiagnostics.ts). Each entry is written to stdout
 * as a single `[client-diag] {json}` line so it lands in the Railway deploy
 * logs and can be pulled with `railway logs | grep client-diag`.
 *
 * Authenticated, size-capped, and rate-capped per user. Write-only.
 */

import express, { Request, Response } from 'express';
import { asyncHandler } from '../middleware/errorHandler';
import { authenticateToken, requireAuth } from '../middleware/authMiddleware';
import { isUuid } from '../utils/uuid';

const router = express.Router();

export const CLIENT_DIAG_LOG_PREFIX = '[client-diag]';
export const MAX_ENTRIES_PER_BATCH = 200;
export const MAX_BATCH_BYTES = 64 * 1024;
export const MAX_BATCHES_PER_WINDOW = 60;
export const RATE_WINDOW_MS = 60 * 1000;
const MAX_STRING_FIELD = 64;

/** Per-user batch counters. Disposable diagnostics state; no DB needed. */
const rateWindows = new Map<string, { windowStart: number; count: number }>();

/** Test hook: clear rate-limit state between tests. */
export function resetClientDiagRateLimits(): void {
  rateWindows.clear();
}

function isRateLimited(userId: string, now: number): boolean {
  const window = rateWindows.get(userId);
  if (!window || now - window.windowStart >= RATE_WINDOW_MS) {
    rateWindows.set(userId, { windowStart: now, count: 1 });
    return false;
  }
  window.count += 1;
  return window.count > MAX_BATCHES_PER_WINDOW;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function shortString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  return value.slice(0, MAX_STRING_FIELD);
}

/**
 * POST /api/diag/client
 * Body: { sessionId: uuid, gameId?: uuid, entries: Array<{ t, seq, cat, ev, data? }> }
 */
router.post('/client', authenticateToken, requireAuth, asyncHandler(async (req: Request, res: Response) => {
  const user = req.user!;
  const body: unknown = req.body;

  if (!isPlainObject(body) || !isUuid(body.sessionId) || !Array.isArray(body.entries)) {
    res.status(400).json({ error: 'INVALID_BODY', message: 'sessionId (uuid) and entries[] are required' });
    return;
  }
  if (body.gameId !== undefined && body.gameId !== null && !isUuid(body.gameId)) {
    res.status(400).json({ error: 'INVALID_BODY', message: 'gameId must be a uuid' });
    return;
  }
  if (body.entries.length > MAX_ENTRIES_PER_BATCH) {
    res.status(400).json({ error: 'BATCH_TOO_LARGE', message: `At most ${MAX_ENTRIES_PER_BATCH} entries per batch` });
    return;
  }
  const serialized = JSON.stringify(body.entries);
  if (Buffer.byteLength(serialized, 'utf8') > MAX_BATCH_BYTES) {
    res.status(400).json({ error: 'BATCH_TOO_LARGE', message: `Batch exceeds ${MAX_BATCH_BYTES} bytes` });
    return;
  }
  if (isRateLimited(user.id, Date.now())) {
    res.status(429).json({ error: 'RATE_LIMITED', message: 'Too many diagnostic batches' });
    return;
  }

  const sessionId = body.sessionId;
  const gameId = typeof body.gameId === 'string' ? body.gameId : undefined;
  const reqId = req.requestId;

  for (const raw of body.entries) {
    if (!isPlainObject(raw)) continue;
    const line = {
      userId: user.id,
      sessionId,
      gameId,
      reqId,
      t: typeof raw.t === 'number' ? raw.t : undefined,
      seq: typeof raw.seq === 'number' ? raw.seq : undefined,
      cat: shortString(raw.cat),
      ev: shortString(raw.ev),
      data: isPlainObject(raw.data) ? raw.data : undefined,
    };
    console.log(CLIENT_DIAG_LOG_PREFIX, JSON.stringify(line));
  }

  res.status(204).end();
}));

export default router;
