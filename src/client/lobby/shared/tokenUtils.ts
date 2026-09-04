// shared/tokenUtils.ts
//
// Client-side JWT expiry checks. Never calls the server -- this only inspects
// the `exp` claim already embedded in a token the client is holding, so
// callers can decide whether to proactively refresh before making a request.

const JWT_SEGMENT_COUNT = 3;
const DEFAULT_SKEW_SECONDS = 30;

interface DecodedJwtPayload {
  exp?: number;
  [key: string]: unknown;
}

function base64UrlDecode(segment: string): string {
  const base64 = segment.replace(/-/g, '+').replace(/_/g, '/');
  const paddingLength = (4 - (base64.length % 4)) % 4;
  const padded = base64 + '='.repeat(paddingLength);
  return atob(padded);
}

function tryDecodeJwtPayload(payloadSegment: string): DecodedJwtPayload | null {
  try {
    const json = base64UrlDecode(payloadSegment);
    return JSON.parse(json) as DecodedJwtPayload;
  } catch {
    return null;
  }
}

/**
 * Determine whether an access token is expired (or within `skewSeconds` of
 * expiring), without making a network call.
 *
 * A token that isn't JWT-shaped (does not have 3 dot-separated segments) is
 * treated as NOT expired rather than thrown on. The dev-auth flow issues a
 * plain sentinel string ('dev-token') in place of a real JWT, and callers
 * (e.g. a reconnect wake handler) must be able to run this check on whatever
 * token is currently stored without special-casing dev auth at every call
 * site.
 *
 * A token that IS JWT-shaped but fails to decode, or has no numeric `exp`
 * claim, is treated as expired (fail closed) -- it cannot be trusted enough
 * to skip a refresh.
 */
export function isAccessTokenExpired(
  token: string | null | undefined,
  skewSeconds: number = DEFAULT_SKEW_SECONDS
): boolean {
  if (!token) {
    return true;
  }

  const parts = token.split('.');
  if (parts.length !== JWT_SEGMENT_COUNT) {
    return false;
  }

  const payload = tryDecodeJwtPayload(parts[1]);
  if (!payload || typeof payload.exp !== 'number') {
    return true;
  }

  const nowSeconds = Date.now() / 1000;
  return payload.exp <= nowSeconds + skewSeconds;
}
