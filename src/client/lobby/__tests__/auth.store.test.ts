// src/client/lobby/__tests__/auth.store.test.ts
import { toast } from 'sonner';
import { api } from '../shared/api';
import { useAuthStore } from '../store/auth.store';

jest.mock('sonner', () => ({
  toast: {
    success: jest.fn(),
    error: jest.fn(),
  },
}));

jest.mock('../shared/api', () => ({
  api: {
    login: jest.fn(),
    register: jest.fn(),
    getCurrentUser: jest.fn(),
    refreshToken: jest.fn(),
  },
}));

const mockedApi = api as jest.Mocked<typeof api>;
const mockedToast = toast as jest.Mocked<typeof toast>;

const JWT_STORAGE_KEY = 'eurorails.jwt';
const USER_STORAGE_KEY = 'eurorails.user';
const REFRESH_TOKEN_STORAGE_KEY = 'eurorails.refreshToken';

// The global test setup (src/client/__tests__/setupTests.js) stubs
// window.localStorage with bare jest.fn()s that don't actually store
// anything. Replace it here with a real in-memory implementation so this
// suite can assert on persisted tokens.
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

function seedAuthenticatedState(): void {
  localStorage.setItem(JWT_STORAGE_KEY, 'old-access-token');
  localStorage.setItem(REFRESH_TOKEN_STORAGE_KEY, 'old-refresh-token');
  localStorage.setItem(USER_STORAGE_KEY, JSON.stringify({ id: 'u1', username: 'u' }));

  useAuthStore.setState({
    user: { id: 'u1', username: 'u' } as any,
    token: 'old-access-token',
    refreshToken: 'old-refresh-token',
    isAuthenticated: true,
    isLoading: false,
    error: null,
  });
}

describe('useAuthStore.refreshAccessToken', () => {
  beforeEach(() => {
    installFakeLocalStorage();
    jest.clearAllMocks();
    useAuthStore.setState({
      user: null,
      token: null,
      refreshToken: null,
      isAuthenticated: false,
      isLoading: false,
      error: null,
    });
  });

  it('returns false and does NOT log out on a network error, keeping tokens in localStorage', async () => {
    seedAuthenticatedState();
    mockedApi.refreshToken.mockRejectedValue(new TypeError('Failed to fetch'));

    const result = await useAuthStore.getState().refreshAccessToken();

    expect(result).toBe(false);
    expect(localStorage.getItem(JWT_STORAGE_KEY)).toBe('old-access-token');
    expect(localStorage.getItem(REFRESH_TOKEN_STORAGE_KEY)).toBe('old-refresh-token');
    expect(useAuthStore.getState().isAuthenticated).toBe(true);
    expect(mockedToast.error).not.toHaveBeenCalled();
  });

  it('returns false and does NOT log out on a transient 5xx-shaped ApiError, keeping tokens', async () => {
    seedAuthenticatedState();
    mockedApi.refreshToken.mockRejectedValue({ error: 'HTTP_503', message: 'Service Unavailable' });

    const result = await useAuthStore.getState().refreshAccessToken();

    expect(result).toBe(false);
    expect(localStorage.getItem(JWT_STORAGE_KEY)).toBe('old-access-token');
    expect(useAuthStore.getState().isAuthenticated).toBe(true);
    expect(mockedToast.error).not.toHaveBeenCalled();
  });

  it('logs out, clears tokens, and shows a session-expired toast on a definitive 401 rejection', async () => {
    seedAuthenticatedState();
    mockedApi.refreshToken.mockRejectedValue({
      error: 'INVALID_REFRESH_TOKEN',
      message: 'Invalid or expired refresh token',
    });

    const result = await useAuthStore.getState().refreshAccessToken();

    expect(result).toBe(false);
    expect(localStorage.getItem(JWT_STORAGE_KEY)).toBeNull();
    expect(localStorage.getItem(REFRESH_TOKEN_STORAGE_KEY)).toBeNull();
    expect(useAuthStore.getState().isAuthenticated).toBe(false);
    expect(useAuthStore.getState().token).toBeNull();
    expect(mockedToast.error).toHaveBeenCalledWith(expect.stringMatching(/session expired/i));
  });

  it('dedupes concurrent callers into a single HTTP call sharing one result', async () => {
    seedAuthenticatedState();
    let resolveRefresh!: (value: { token: string; refreshToken: string }) => void;
    mockedApi.refreshToken.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveRefresh = resolve;
        })
    );

    const first = useAuthStore.getState().refreshAccessToken();
    const second = useAuthStore.getState().refreshAccessToken();

    expect(mockedApi.refreshToken).toHaveBeenCalledTimes(1);

    resolveRefresh({ token: 'new-access-token', refreshToken: 'new-refresh-token' });

    const [firstResult, secondResult] = await Promise.all([first, second]);

    expect(firstResult).toBe(true);
    expect(secondResult).toBe(true);
    expect(mockedApi.refreshToken).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem(JWT_STORAGE_KEY)).toBe('new-access-token');
  });

  it('starts a new refresh after the in-flight one has settled', async () => {
    seedAuthenticatedState();
    mockedApi.refreshToken
      .mockResolvedValueOnce({ token: 'token-1', refreshToken: 'refresh-1' })
      .mockResolvedValueOnce({ token: 'token-2', refreshToken: 'refresh-2' });

    await useAuthStore.getState().refreshAccessToken();
    await useAuthStore.getState().refreshAccessToken();

    expect(mockedApi.refreshToken).toHaveBeenCalledTimes(2);
    expect(localStorage.getItem(JWT_STORAGE_KEY)).toBe('token-2');
  });

  it('returns false without calling the API when there is no refresh token', async () => {
    // No seedAuthenticatedState(): store and localStorage both start empty.
    const result = await useAuthStore.getState().refreshAccessToken();

    expect(result).toBe(false);
    expect(mockedApi.refreshToken).not.toHaveBeenCalled();
  });
});
