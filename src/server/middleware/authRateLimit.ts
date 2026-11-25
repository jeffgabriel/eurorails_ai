import { Express } from 'express';
import rateLimit, { RateLimitRequestHandler } from 'express-rate-limit';
import { rateLimitHandler } from './errorHandler';

interface AuthRateLimitOptions {
  /** Length of the counting window in milliseconds */
  windowMs: number;
  /** Requests allowed per IP within the window */
  limit: number;
  /** When true, only failed (4xx/5xx) responses count against the limit */
  skipSuccessfulRequests?: boolean;
}

const MINUTE_MS = 60 * 1000;

/**
 * Whether the auth limiters count requests. Read per request so tests can turn
 * them on for one case.
 *
 * AUTH_RATE_LIMIT_ENABLED=true|false overrides the default, which is on
 * everywhere except NODE_ENV=test (suites log in and register far more often
 * than a person would).
 */
export function isAuthRateLimitEnabled(): boolean {
  const override = process.env.AUTH_RATE_LIMIT_ENABLED;
  if (override === 'true') return true;
  if (override === 'false') return false;
  return process.env.NODE_ENV !== 'test';
}

/**
 * Build a per-IP limiter that answers 429 through the shared rateLimitHandler.
 * Counters live in this process's memory, which is right for a single server
 * instance; a multi-instance deploy would need a shared store.
 */
export function createAuthRateLimiter(options: AuthRateLimitOptions): RateLimitRequestHandler {
  return rateLimit({
    windowMs: options.windowMs,
    limit: options.limit,
    skipSuccessfulRequests: options.skipSuccessfulRequests ?? false,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    skip: (): boolean => !isAuthRateLimitEnabled(),
    handler: rateLimitHandler,
  });
}

/**
 * Login: 10 failed attempts per 15 minutes. Successful logins don't count, so
 * players sharing a network aren't locked out by each other; credential
 * stuffing is almost all failures.
 */
export const loginRateLimiter = createAuthRateLimiter({
  windowMs: 15 * MINUTE_MS,
  limit: 10,
  skipSuccessfulRequests: true,
});

/** Register: 20 attempts per hour, successful or not (failures reveal which emails exist). */
export const registerRateLimiter = createAuthRateLimiter({
  windowMs: 60 * MINUTE_MS,
  limit: 20,
});

/** Refresh: 30 per 15 minutes. Access tokens last 60 minutes, so real clients need very few. */
export const refreshRateLimiter = createAuthRateLimiter({
  windowMs: 15 * MINUTE_MS,
  limit: 30,
});

/**
 * Tell Express how many reverse proxies sit in front of it, so req.ip is the
 * client's address rather than the proxy's. Without this every player behind
 * the platform proxy would share one rate-limit bucket.
 *
 * TRUST_PROXY overrides (a hop count, or "false" to disable). The default is
 * one hop in production (Railway's edge proxy) and none elsewhere, where a
 * client could otherwise spoof X-Forwarded-For to dodge the limits.
 */
export function configureTrustProxy(app: Express): void {
  const raw = process.env.TRUST_PROXY;
  if (raw === undefined || raw === '') {
    if (process.env.NODE_ENV === 'production') {
      app.set('trust proxy', 1);
    }
    return;
  }
  if (raw === 'false') {
    return;
  }
  const hops = Number(raw);
  if (!Number.isInteger(hops) || hops < 0) {
    throw new Error(`TRUST_PROXY must be a non-negative integer or "false", got "${raw}"`);
  }
  app.set('trust proxy', hops);
}
