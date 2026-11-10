import { authenticatedFetch } from '../services/authenticatedFetch';
import {
  _getStateForTests,
  _resetForTests,
  describeTarget,
  flush,
  initDeviceDiagnostics,
  isEnabled,
  isRectOnScreen,
  log,
  MAX_QUEUE,
  sanitize,
} from '../utils/deviceDiagnostics';

jest.mock('../services/authenticatedFetch', () => ({
  authenticatedFetch: jest.fn(),
}));
jest.mock('../config/apiConfig', () => ({
  config: { apiBaseUrl: 'http://api.test' },
}));

const mockFetch = authenticatedFetch as jest.MockedFunction<typeof authenticatedFetch>;

function setSearch(search: string): void {
  window.history.replaceState({}, '', `/game/11111111-2222-4333-8444-555555555555${search}`);
}

describe('deviceDiagnostics', () => {
  beforeEach(() => {
    _resetForTests();
    window.sessionStorage.clear();
    window.localStorage.clear();
    setSearch('');
  });

  afterEach(() => {
    _resetForTests();
    (window.localStorage.getItem as jest.Mock).mockReset();
    jest.clearAllMocks();
  });

  describe('activation', () => {
    it('is a no-op when ?diag is absent', () => {
      initDeviceDiagnostics({ attachListeners: false, showOverlay: false });
      log('x', 'y', { a: 1 });
      expect(isEnabled()).toBe(false);
      expect(_getStateForTests().queue).toHaveLength(0);
    });

    it('enables with ?diag=1 and persists for the tab', () => {
      setSearch('?diag=1');
      initDeviceDiagnostics({ attachListeners: false, showOverlay: false });
      expect(isEnabled()).toBe(true);
      expect(window.sessionStorage.getItem('eurorails.diag')).toBe('1');

      const firstSession = _getStateForTests().sessionId;
      _resetForTests();
      setSearch('');
      initDeviceDiagnostics({ attachListeners: false, showOverlay: false });
      expect(isEnabled()).toBe(true);
      expect(_getStateForTests().sessionId).toBe(firstSession);
    });

    it('disables with ?diag=0', () => {
      window.sessionStorage.setItem('eurorails.diag', '1');
      setSearch('?diag=0');
      initDeviceDiagnostics({ attachListeners: false, showOverlay: false });
      expect(isEnabled()).toBe(false);
      expect(window.sessionStorage.getItem('eurorails.diag')).toBeNull();
    });

    it('shows the overlay badge when enabled', () => {
      setSearch('?diag=1');
      initDeviceDiagnostics({ attachListeners: false });
      expect(document.getElementById('diag-overlay')).not.toBeNull();
    });
  });

  describe('buffering', () => {
    beforeEach(() => {
      setSearch('?diag=1');
      initDeviceDiagnostics({ attachListeners: false, showOverlay: false });
    });

    it('caps the queue and counts dropped entries', () => {
      // No token, so flushes are held and the queue only grows.
      for (let i = 0; i < MAX_QUEUE + 50; i++) log('t', 'e');
      const state = _getStateForTests();
      expect(state.queue).toHaveLength(MAX_QUEUE);
      expect(state.dropped).toBeGreaterThanOrEqual(50);
    });

    it('holds entries until an auth token exists', async () => {
      log('t', 'e');
      await flush();
      expect(mockFetch).not.toHaveBeenCalled();
      expect(_getStateForTests().queue.length).toBeGreaterThan(0);
    });

    it('sends a batch with sessionId and gameId, then clears it', async () => {
      // setupTests mocks localStorage with inert jest.fn()s
      (window.localStorage.getItem as jest.Mock).mockImplementation((k: string) => (k === 'eurorails.jwt' ? 'token' : null));
      mockFetch.mockResolvedValue({ ok: true, status: 204 } as Response);
      log('t', 'e', { n: 1 });
      await flush();

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const [url, opts] = mockFetch.mock.calls[0];
      expect(url).toBe('http://api.test/api/diag/client');
      expect(opts?.keepalive).toBe(true);
      const body = JSON.parse(opts?.body as string);
      expect(body.sessionId).toBe(_getStateForTests().sessionId);
      expect(body.gameId).toBe('11111111-2222-4333-8444-555555555555');
      expect(body.entries.some((e: any) => e.cat === 't' && e.ev === 'e')).toBe(true);
      expect(_getStateForTests().queue).toHaveLength(0);
    });

    it('keeps the batch queued on a server error', async () => {
      (window.localStorage.getItem as jest.Mock).mockImplementation((k: string) => (k === 'eurorails.jwt' ? 'token' : null));
      mockFetch.mockResolvedValue({ ok: false, status: 500 } as Response);
      log('t', 'e');
      const before = _getStateForTests().queue.length;
      await flush();
      expect(_getStateForTests().queue).toHaveLength(before);
    });
  });

  describe('helpers', () => {
    it('sanitize truncates long strings and arrays and drops functions', () => {
      const out = sanitize({ s: 'a'.repeat(500), arr: Array.from({ length: 30 }, (_, i) => i), fn: () => 1 }) as any;
      expect(out.s.length).toBeLessThanOrEqual(301);
      expect(out.arr).toHaveLength(21);
      expect(out.fn).toBeUndefined();
    });

    it('describeTarget never includes input values', () => {
      const input = document.createElement('input');
      input.id = 'msg';
      input.setAttribute('data-chat-input', '');
      input.value = 'secret message';
      expect(describeTarget(input)).toBe('input#msg[chat-input]');
    });

    it('isRectOnScreen detects off-screen rects', () => {
      expect(isRectOnScreen({ x: 0, y: 0, w: 100, h: 100 }, 375, 667)).toBe(true);
      expect(isRectOnScreen({ x: 300, y: 0, w: 100, h: 100 }, 375, 667)).toBe(false);
      expect(isRectOnScreen(null, 375, 667)).toBeNull();
    });
  });

  describe('keyboard privacy', () => {
    it('logs only metadata for keys typed into inputs', () => {
      setSearch('?diag=1');
      initDeviceDiagnostics({ showOverlay: false });
      const input = document.createElement('input');
      document.body.appendChild(input);
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'q', code: 'KeyQ', bubbles: true }));
      const keyEntry = _getStateForTests().queue.find((e) => e.ev === 'keydown');
      expect(keyEntry?.data).toMatchObject({ inField: true, isEnter: false, keyLen: 1 });
      expect(JSON.stringify(keyEntry)).not.toContain('KeyQ');
      input.remove();
    });
  });
});
