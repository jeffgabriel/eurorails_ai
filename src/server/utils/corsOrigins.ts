/**
 * Single CORS allow-list shared by the HTTP API (index.ts) and Socket.IO.
 *
 * Resolution order: ALLOWED_ORIGINS (comma-separated) → CLIENT_URL →
 * http://localhost:<SERVER_LOCAL_PORT|3000>. Evaluated on every call so tests
 * and runtime config changes take effect without a restart.
 */
export function getAllowedOrigins(): string[] {
  if (process.env.ALLOWED_ORIGINS) {
    return process.env.ALLOWED_ORIGINS.split(',').map(origin => origin.trim()).filter(Boolean);
  }

  if (process.env.CLIENT_URL) {
    return [process.env.CLIENT_URL];
  }

  const serverPort = parseInt(process.env.SERVER_LOCAL_PORT || '3000', 10);
  const fallback = `http://localhost:${serverPort}`;

  if (process.env.NODE_ENV === 'production') {
    console.error('========================================');
    console.error('SECURITY ERROR: CORS not configured for production!');
    console.error('Production deployments MUST set CLIENT_URL or ALLOWED_ORIGINS');
    console.error('Falling back to localhost is INSECURE and will block legitimate requests.');
    console.error('========================================');
  } else if (process.env.NODE_ENV !== 'development') {
    console.warn('CORS: No CLIENT_URL or ALLOWED_ORIGINS set. Defaulting to localhost');
  }
  return [fallback];
}

/**
 * Returns true when a request from `origin` may be served.
 * A missing origin (same-origin request or a non-browser client) is allowed,
 * matching the HTTP CORS middleware; browsers always send Origin cross-site.
 */
export function isOriginAllowed(origin: string | undefined): boolean {
  if (!origin) {
    return true;
  }
  const allowed = getAllowedOrigins();
  return allowed.includes('*') || allowed.includes(origin);
}
