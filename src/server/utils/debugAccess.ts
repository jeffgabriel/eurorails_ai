import { createHash, timingSafeEqual } from 'crypto';

/** Header carrying the debug-route secret. */
export const DEBUG_SECRET_HEADER = 'x-test-secret';

/**
 * Access rules for debug-only surfaces (deck debug routes, log/LLM viewers).
 *
 * Every check reads the environment on each call, so tests and runtime config
 * changes take effect without a restart. Nothing here has a built-in default
 * secret: with no configuration, a server outside test/development exposes
 * none of these surfaces.
 */

/** NODE_ENV values under which the deck debug routes need no secret. */
const OPEN_DEBUG_ROUTE_ENVS: ReadonlyArray<string> = ['test', 'development'];

/**
 * True when a request may use the deck debug routes: either the server runs
 * under NODE_ENV=test or NODE_ENV=development, or DEBUG_ROUTES_SECRET is
 * configured and the request presented exactly that value.
 */
export function isDebugRouteRequestAllowed(presentedSecret: unknown): boolean {
  if (OPEN_DEBUG_ROUTE_ENVS.includes(process.env.NODE_ENV ?? '')) {
    return true;
  }

  const configuredSecret = process.env.DEBUG_ROUTES_SECRET;
  if (!configuredSecret || typeof presentedSecret !== 'string' || presentedSecret.length === 0) {
    return false;
  }

  // Compare fixed-length digests so the check is constant-time regardless of input length.
  const expected = createHash('sha256').update(configuredSecret).digest();
  const presented = createHash('sha256').update(presentedSecret).digest();
  return timingSafeEqual(expected, presented);
}

/**
 * True when the log/LLM viewers (/logs, /log, /llm) may be served: local
 * development, or an explicit ENABLE_DEBUG_VIEWERS=true opt-in.
 */
export function areDebugViewersEnabled(): boolean {
  return process.env.NODE_ENV === 'development' || process.env.ENABLE_DEBUG_VIEWERS === 'true';
}
