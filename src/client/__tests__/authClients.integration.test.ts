// src/client/__tests__/authClients.integration.test.ts
//
// Integration coverage for the client HTTP layer's interaction with the
// FE-001 auth store resilience logic. Unlike a typical unit test, this
// deliberately does NOT mock useAuthStore or its refreshAccessToken --
// the whole point is to prove the REAL single-flight refresh guard in
// auth.store.ts is what both authenticatedFetch.ts and shared/api.ts end
// up sharing when they both hit a 401 at the same time. Only the network
// boundary (global fetch) and localStorage are faked.
import { authenticatedFetch } from '../services/authenticatedFetch';
import { api } from '../lobby/shared/api';

jest.mock('sonner', () => ({
  toast: {
    success: jest.fn(),
    error: jest.fn(),
  },
}));

const JWT_STORAGE_KEY = 'eurorails.jwt';
const REFRESH_TOKEN_STORAGE_KEY = 'eurorails.refreshToken';

// The global test setup (src/client/__tests__/setupTests.js) stubs
// window.localStorage with bare jest.fn()s that don't actually store
// anything. Install a real in-memory implementation so refreshAccessToken's
// localStorage reads/writes are meaningful across the whole request chain.
function installFakeLocalStorage(): void {
  const store = new Map<string, string>();
  Object.defineProperty(window, 'localStorage', {
    value: {
      getItem: jest.fn((key: string) => (store.has(key) ? store.get(key)! : null)),
      setItem: jest.fn((key: string, value: string) => {
        store.set(key, value);
      }),
      removeItem: jest.fn((key: string) => {
        store.delete(key);
      }),
      clear: jest.fn(() => {
        store.clear();
      }),
    },
    configurable: true,
    writable: true,
  });
}

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

function authHeaderOf(init: RequestInit | undefined): string | undefined {
  const headers = init?.headers as Record<string, string> | undefined;
  return headers?.Authorization;
}

describe('client HTTP clients + auth store integration (TEST-001)', () => {
  beforeEach(() => {
    installFakeLocalStorage();
    jest.clearAllMocks();
  });

  it('routes a 401 through the shared refresh so concurrent calls from authenticatedFetch and api.request trigger exactly one /api/auth/refresh call', async () => {
    localStorage.setItem(JWT_STORAGE_KEY, 'stale-token');
    localStorage.setItem(REFRESH_TOKEN_STORAGE_KEY, 'refresh-token-1');

    let refreshCallCount = 0;
    const fetchMock = jest.fn((url: unknown, init?: RequestInit) => {
      const urlStr = String(url);

      if (urlStr.includes('/api/auth/refresh')) {
        refreshCallCount += 1;
        // Artificial delay: widens the window during which a second,
        // near-simultaneous 401 would (if the single-flight guard were
        // broken) trigger its own separate refresh call.
        return new Promise<Response>((resolve) => {
          setTimeout(() => {
            resolve(
              jsonResponse(200, {
                success: true,
                data: { token: 'refreshed-token', refreshToken: 'refresh-token-2' },
                message: 'Token refreshed successfully',
              }),
            );
          }, 10);
        });
      }

      if (urlStr.includes('/protected-a')) {
        if (authHeaderOf(init) === 'Bearer stale-token') {
          return Promise.resolve(jsonResponse(401, { error: 'HTTP_401', message: 'Unauthorized' }));
        }
        return Promise.resolve(jsonResponse(200, { ok: true, via: 'authenticatedFetch' }));
      }

      if (urlStr.includes('/api/lobby/health')) {
        if (authHeaderOf(init) === 'Bearer stale-token') {
          return Promise.resolve(jsonResponse(401, { error: 'HTTP_401', message: 'Unauthorized' }));
        }
        return Promise.resolve(
          jsonResponse(200, { success: true, message: 'OK', timestamp: '2026-01-01', service: 'lobby' }),
        );
      }

      return Promise.resolve(jsonResponse(404, { error: 'NOT_FOUND', message: 'unexpected url in test' }));
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const [afResponse, healthResult] = await Promise.all([
      authenticatedFetch('http://localhost:3001/protected-a'),
      api.healthCheck(),
    ]);

    expect(refreshCallCount).toBe(1);
    expect(afResponse.status).toBe(200);
    expect(healthResult).toEqual({ message: 'OK' });
    // Both requests retried with the token the single shared refresh produced.
    expect(localStorage.getItem(JWT_STORAGE_KEY)).toBe('refreshed-token');
  });

  it('authenticatedFetch retries automatically with the new token after a successful refresh', async () => {
    localStorage.setItem(JWT_STORAGE_KEY, 'stale-token');
    localStorage.setItem(REFRESH_TOKEN_STORAGE_KEY, 'refresh-token-1');

    let protectedCallCount = 0;
    const fetchMock = jest.fn((url: unknown, init?: RequestInit) => {
      const urlStr = String(url);

      if (urlStr.includes('/api/auth/refresh')) {
        return Promise.resolve(
          jsonResponse(200, {
            success: true,
            data: { token: 'refreshed-token', refreshToken: 'refresh-token-2' },
            message: 'Token refreshed successfully',
          }),
        );
      }

      if (urlStr.includes('/protected-b')) {
        protectedCallCount += 1;
        if (authHeaderOf(init) === 'Bearer stale-token') {
          return Promise.resolve(jsonResponse(401, { error: 'HTTP_401', message: 'Unauthorized' }));
        }
        expect(authHeaderOf(init)).toBe('Bearer refreshed-token');
        return Promise.resolve(jsonResponse(200, { ok: true }));
      }

      return Promise.resolve(jsonResponse(404, {}));
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const response = await authenticatedFetch('http://localhost:3001/protected-b');

    expect(response.status).toBe(200);
    expect(protectedCallCount).toBe(2); // original 401 + one retry with the new token
    expect(localStorage.getItem(JWT_STORAGE_KEY)).toBe('refreshed-token');
  });

  it('authenticatedFetch does not retry and returns the original 401 when the refresh is definitively rejected', async () => {
    localStorage.setItem(JWT_STORAGE_KEY, 'stale-token');
    localStorage.setItem(REFRESH_TOKEN_STORAGE_KEY, 'refresh-token-1');

    let protectedCallCount = 0;
    const fetchMock = jest.fn((url: unknown) => {
      const urlStr = String(url);

      if (urlStr.includes('/api/auth/refresh')) {
        // Matches the real server contract (authRoutes.ts POST /api/auth/refresh):
        // any refresh failure comes back as 401 INVALID_REFRESH_TOKEN.
        return Promise.resolve(
          jsonResponse(401, {
            error: 'INVALID_REFRESH_TOKEN',
            message: 'Invalid or expired refresh token',
            details: 'Please login again',
          }),
        );
      }

      if (urlStr.includes('/protected-c')) {
        protectedCallCount += 1;
        return Promise.resolve(jsonResponse(401, { error: 'HTTP_401', message: 'Unauthorized' }));
      }

      return Promise.resolve(jsonResponse(404, {}));
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const response = await authenticatedFetch('http://localhost:3001/protected-c');

    expect(response.status).toBe(401);
    // Exactly one call -- the retry path must never fire on a definitive rejection.
    expect(protectedCallCount).toBe(1);
    // The definitive-rejection path in auth.store.ts logs the user out.
    expect(localStorage.getItem(JWT_STORAGE_KEY)).toBeNull();
    expect(localStorage.getItem(REFRESH_TOKEN_STORAGE_KEY)).toBeNull();
  });

  it('api.request does not retry and surfaces the definitive rejection when the shared refresh fails', async () => {
    localStorage.setItem(JWT_STORAGE_KEY, 'stale-token');
    localStorage.setItem(REFRESH_TOKEN_STORAGE_KEY, 'refresh-token-1');

    let healthCallCount = 0;
    const fetchMock = jest.fn((url: unknown) => {
      const urlStr = String(url);

      if (urlStr.includes('/api/auth/refresh')) {
        return Promise.resolve(
          jsonResponse(401, { error: 'INVALID_REFRESH_TOKEN', message: 'Invalid or expired refresh token' }),
        );
      }

      if (urlStr.includes('/api/lobby/health')) {
        healthCallCount += 1;
        return Promise.resolve(jsonResponse(401, { error: 'HTTP_401', message: 'Unauthorized' }));
      }

      return Promise.resolve(jsonResponse(404, {}));
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await expect(api.healthCheck()).rejects.toMatchObject({ error: 'HTTP_401' });

    expect(healthCallCount).toBe(1);
    expect(localStorage.getItem(JWT_STORAGE_KEY)).toBeNull();
  });
});
