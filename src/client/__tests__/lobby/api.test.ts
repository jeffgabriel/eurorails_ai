// src/client/__tests__/lobby/api.test.ts
import * as apiModule from '../../lobby/shared/api';

describe('ApiClient', () => {
  let fetchSpy: jest.SpyInstance;
  let client: any; // tolerate either export shape
  let mockLocalStorage: Storage;

  beforeAll(() => {
    // Resolve the API client regardless of export shape
    // - If module exports `api` (instance), use it
    // - Else if it exports `ApiClient` (class), construct it (optionally pass base URL)
    if ((apiModule as any).api) {
      client = (apiModule as any).api;
    } else if ((apiModule as any).ApiClient) {
      const ApiClient = (apiModule as any).ApiClient;
      client = new ApiClient(); // If your ctor needs a base URL, put it here
      // e.g., new ApiClient('/api/lobby')
    } else {
      throw new Error('api module must export either `api` or `ApiClient`');
    }

    // Ensure window.localStorage exists and is replaceable
    mockLocalStorage = {
      getItem: jest.fn(),
      setItem: jest.fn(),
      removeItem: jest.fn(),
      clear: jest.fn(),
    } as unknown as Storage;

    Object.defineProperty(window, 'localStorage', {
      value: mockLocalStorage,
      writable: true,
      configurable: true,
    });

    // Ensure globalThis.fetch exists so we can spy on it
    if (typeof (globalThis as any).fetch !== 'function') {
      Object.defineProperty(globalThis, 'fetch', {
        value: jest.fn(),
        writable: true,
        configurable: true,
      });
    }
  });

  beforeEach(() => {
    jest.clearAllMocks();

    // Cast to any so TS doesn't enforce full DOM Response shape
    fetchSpy = jest
      .spyOn(globalThis as any, 'fetch')
      .mockResolvedValue({
        ok: true,
        json: async () => ({ message: 'OK' }),
      } as unknown as Response);
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it('calls createGame endpoint with JSON headers', async () => {
    // Support either instance method or static function
    if (typeof client.createGame !== 'function') {
      throw new Error('`createGame` is not found on the API client. Export `api.createGame` or implement it.');
    }

    await client.createGame();

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0];

    // Match relative or absolute forms
    expect(String(url)).toMatch(/\/games$/);

    expect(init).toEqual(
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          'Content-Type': 'application/json',
        }),
      })
    );
  });
});
