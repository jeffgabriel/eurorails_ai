import { DebugOverlay } from '../components/DebugOverlay';
import { GameStateService } from '../services/GameStateService';
import { GameState } from '../../shared/types/GameTypes';

// Mock GameStateService
jest.mock('../services/GameStateService', () => ({
  GameStateService: jest.fn().mockImplementation(() => ({
    onStateChange: jest.fn(),
    offStateChange: jest.fn(),
    onTurnChange: jest.fn(),
    offTurnChange: jest.fn(),
  })),
}));

function makeGameState(overrides: Partial<GameState> = {}): GameState {
  return {
    id: 'test-game-1234-5678',
    status: 'active',
    currentPlayerIndex: 0,
    maxPlayers: 6,
    players: [
      {
        id: 'p1', name: 'Alice', color: '#ff0000', money: 50,
        trainType: 'Freight' as any, turnNumber: 3,
        trainState: { position: { row: 5, col: 10 }, remainingMovement: 9, movementHistory: [], loads: [] },
        hand: [],
      },
      {
        id: 'p2', name: 'BotPlayer', color: '#0000ff', money: 30,
        trainType: 'FastFreight' as any, turnNumber: 2,
        trainState: { position: null, remainingMovement: 12, movementHistory: [], loads: ['Coal' as any] },
        hand: [], isBot: true, botConfig: { skillLevel: 'medium' as any, archetype: 'balanced' as any },
      },
    ],
    ...overrides,
  } as GameState;
}

describe('DebugOverlay', () => {
  let overlay: DebugOverlay;
  let mockScene: any;
  let mockGameStateService: any;
  let addEventListenerSpy: jest.SpyInstance;
  let removeEventListenerSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();

    // Reset localStorage mock
    (localStorage.getItem as jest.Mock).mockReturnValue(null);
    (localStorage.setItem as jest.Mock).mockClear();

    // Clean up any lingering DOM elements
    const existing = document.getElementById('debug-overlay');
    if (existing) existing.remove();

    // Spy on window event listeners
    addEventListenerSpy = jest.spyOn(window, 'addEventListener');
    removeEventListenerSpy = jest.spyOn(window, 'removeEventListener');

    mockScene = { gameState: makeGameState() };

    mockGameStateService = {
      onStateChange: jest.fn(),
      offStateChange: jest.fn(),
      onTurnChange: jest.fn(),
      offTurnChange: jest.fn(),
    };
  });

  afterEach(() => {
    // Clean up overlay if it exists
    try { overlay?.destroy(); } catch { /* already destroyed */ }
    const el = document.getElementById('debug-overlay');
    if (el) el.remove();
    addEventListenerSpy.mockRestore();
    removeEventListenerSpy.mockRestore();
  });

  describe('constructor and DOM lifecycle', () => {
    it('should create and append a container div to document.body', () => {
      overlay = new DebugOverlay(mockScene, mockGameStateService);

      const container = document.getElementById('debug-overlay');
      expect(container).not.toBeNull();
      expect(container?.parentNode).toBe(document.body);
    });

    it('should apply correct styles to the container', () => {
      overlay = new DebugOverlay(mockScene, mockGameStateService);

      const container = document.getElementById('debug-overlay')!;
      expect(container.style.position).toBe('fixed');
      expect(container.style.right).toBe('0px');
      expect(container.style.width).toBe('400px');
      expect(container.style.zIndex).toBe('5000');
    });

    it('should start hidden when localStorage has no value', () => {
      (localStorage.getItem as jest.Mock).mockReturnValue(null);
      overlay = new DebugOverlay(mockScene, mockGameStateService);

      const container = document.getElementById('debug-overlay')!;
      expect(container.style.display).toBe('none');
    });

    it('should start visible when localStorage has "true"', () => {
      (localStorage.getItem as jest.Mock).mockReturnValue('true');
      overlay = new DebugOverlay(mockScene, mockGameStateService);

      const container = document.getElementById('debug-overlay')!;
      expect(container.style.display).toBe('block');
    });

    it('should register a keydown listener on window', () => {
      overlay = new DebugOverlay(mockScene, mockGameStateService);
      expect(addEventListenerSpy).toHaveBeenCalledWith('keydown', expect.any(Function));
    });

    it('should register state change and turn change listeners', () => {
      overlay = new DebugOverlay(mockScene, mockGameStateService);
      expect(mockGameStateService.onStateChange).toHaveBeenCalledWith(expect.any(Function));
      expect(mockGameStateService.onTurnChange).toHaveBeenCalledWith(expect.any(Function));
    });
  });

  describe('destroy', () => {
    it('should remove the container from the DOM', () => {
      overlay = new DebugOverlay(mockScene, mockGameStateService);
      expect(document.getElementById('debug-overlay')).not.toBeNull();

      overlay.destroy();
      expect(document.getElementById('debug-overlay')).toBeNull();
    });

    it('should remove the keydown listener from window', () => {
      overlay = new DebugOverlay(mockScene, mockGameStateService);
      overlay.destroy();
      expect(removeEventListenerSpy).toHaveBeenCalledWith('keydown', expect.any(Function));
    });

    it('should unregister GameStateService listeners', () => {
      overlay = new DebugOverlay(mockScene, mockGameStateService);
      overlay.destroy();
      expect(mockGameStateService.offStateChange).toHaveBeenCalledWith(expect.any(Function));
      expect(mockGameStateService.offTurnChange).toHaveBeenCalledWith(expect.any(Function));
    });
  });

  describe('toggle, show, hide', () => {
    it('should toggle from hidden to visible on backtick keydown', () => {
      overlay = new DebugOverlay(mockScene, mockGameStateService);
      const container = document.getElementById('debug-overlay')!;
      expect(container.style.display).toBe('none');

      window.dispatchEvent(new KeyboardEvent('keydown', { key: '`', code: 'Backquote' }));
      expect(container.style.display).toBe('block');
    });

    it('should toggle from visible to hidden on second backtick keydown', () => {
      (localStorage.getItem as jest.Mock).mockReturnValue('true');
      overlay = new DebugOverlay(mockScene, mockGameStateService);
      const container = document.getElementById('debug-overlay')!;
      expect(container.style.display).toBe('block');

      window.dispatchEvent(new KeyboardEvent('keydown', { key: '`', code: 'Backquote' }));
      expect(container.style.display).toBe('none');
    });

    it('should persist open state to localStorage on show', () => {
      overlay = new DebugOverlay(mockScene, mockGameStateService);
      window.dispatchEvent(new KeyboardEvent('keydown', { key: '`', code: 'Backquote' }));
      expect(localStorage.setItem).toHaveBeenCalledWith('eurorails.debugOverlay.open', 'true');
    });

    it('should persist closed state to localStorage on hide', () => {
      (localStorage.getItem as jest.Mock).mockReturnValue('true');
      overlay = new DebugOverlay(mockScene, mockGameStateService);
      window.dispatchEvent(new KeyboardEvent('keydown', { key: '`', code: 'Backquote' }));
      expect(localStorage.setItem).toHaveBeenCalledWith('eurorails.debugOverlay.open', 'false');
    });
  });

  describe('keyboard activeElement guard', () => {
    it('should not toggle when activeElement is an INPUT', () => {
      overlay = new DebugOverlay(mockScene, mockGameStateService);
      const container = document.getElementById('debug-overlay')!;

      const input = document.createElement('input');
      document.body.appendChild(input);
      input.focus();

      window.dispatchEvent(new KeyboardEvent('keydown', { key: '`', code: 'Backquote' }));
      expect(container.style.display).toBe('none');

      input.remove();
    });

    it('should not toggle when activeElement is a TEXTAREA', () => {
      overlay = new DebugOverlay(mockScene, mockGameStateService);
      const container = document.getElementById('debug-overlay')!;

      const textarea = document.createElement('textarea');
      document.body.appendChild(textarea);
      textarea.focus();

      window.dispatchEvent(new KeyboardEvent('keydown', { key: '`', code: 'Backquote' }));
      expect(container.style.display).toBe('none');

      textarea.remove();
    });

    it('should ignore non-backtick keys', () => {
      overlay = new DebugOverlay(mockScene, mockGameStateService);
      const container = document.getElementById('debug-overlay')!;

      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', code: 'KeyA' }));
      expect(container.style.display).toBe('none');
    });
  });

  describe('state change listeners', () => {
    it('should re-render when stateChangeListener fires and overlay is open', () => {
      (localStorage.getItem as jest.Mock).mockReturnValue('true');
      overlay = new DebugOverlay(mockScene, mockGameStateService);
      const container = document.getElementById('debug-overlay')!;

      // Get the registered listener and invoke it
      const stateListener = mockGameStateService.onStateChange.mock.calls[0][0];

      // Modify state and fire listener
      mockScene.gameState.players[0].money = 99;
      stateListener();

      expect(container.innerHTML).toContain('99');
    });

    it('should not re-render when stateChangeListener fires and overlay is hidden', () => {
      overlay = new DebugOverlay(mockScene, mockGameStateService);
      const container = document.getElementById('debug-overlay')!;

      const stateListener = mockGameStateService.onStateChange.mock.calls[0][0];
      stateListener();

      // Hidden overlay should have empty innerHTML (no render called)
      expect(container.innerHTML).toBe('');
    });

    it('should re-render when turnChangeListener fires and overlay is open', () => {
      (localStorage.getItem as jest.Mock).mockReturnValue('true');
      overlay = new DebugOverlay(mockScene, mockGameStateService);
      const container = document.getElementById('debug-overlay')!;

      const turnListener = mockGameStateService.onTurnChange.mock.calls[0][0];
      turnListener(1);

      expect(container.innerHTML).toContain('Debug Overlay');
    });
  });

  describe('logSocketEvent and ring buffer', () => {
    it('should add events to the log', () => {
      (localStorage.getItem as jest.Mock).mockReturnValue('true');
      overlay = new DebugOverlay(mockScene, mockGameStateService);
      const container = document.getElementById('debug-overlay')!;

      overlay.logSocketEvent('state:patch', { some: 'data' });

      expect(container.innerHTML).toContain('state:patch');
    });

    it('should show newest events first', () => {
      (localStorage.getItem as jest.Mock).mockReturnValue('true');
      overlay = new DebugOverlay(mockScene, mockGameStateService);
      const container = document.getElementById('debug-overlay')!;

      overlay.logSocketEvent('first-event', {});
      overlay.logSocketEvent('second-event', {});

      const html = container.innerHTML;
      const firstIdx = html.indexOf('second-event');
      const secondIdx = html.indexOf('first-event');
      expect(firstIdx).toBeLessThan(secondIdx);
    });

    it('should cap the event log at 50 entries', () => {
      overlay = new DebugOverlay(mockScene, mockGameStateService);

      for (let i = 0; i < 60; i++) {
        overlay.logSocketEvent(`event-${i}`, {});
      }

      // Open overlay to render
      window.dispatchEvent(new KeyboardEvent('keydown', { key: '`', code: 'Backquote' }));
      const container = document.getElementById('debug-overlay')!;

      // Count event entries - should show (50) in header
      expect(container.innerHTML).toContain('(50)');
    });

    it('should truncate payload to 100 characters', () => {
      (localStorage.getItem as jest.Mock).mockReturnValue('true');
      overlay = new DebugOverlay(mockScene, mockGameStateService);
      const container = document.getElementById('debug-overlay')!;

      const longPayload = { data: 'x'.repeat(200) };
      overlay.logSocketEvent('big-event', longPayload);

      // The rendered payload should not contain the full 200 chars
      const html = container.innerHTML;
      expect(html).toContain('big-event');
      // JSON.stringify of the payload is truncated to 100 chars
      const payloadMatch = html.match(/big-event<\/span>\s*<span[^>]*> — ([^<]*)/);
      expect(payloadMatch).not.toBeNull();
      expect(payloadMatch![1].length).toBeLessThanOrEqual(100);
    });

    it('should not re-render on logSocketEvent when overlay is hidden', () => {
      overlay = new DebugOverlay(mockScene, mockGameStateService);
      const container = document.getElementById('debug-overlay')!;

      overlay.logSocketEvent('hidden-event', {});
      expect(container.innerHTML).toBe('');
    });
  });

  describe('render output structure', () => {
    it('should render header with game ID and status', () => {
      (localStorage.getItem as jest.Mock).mockReturnValue('true');
      overlay = new DebugOverlay(mockScene, mockGameStateService);
      const container = document.getElementById('debug-overlay')!;

      expect(container.innerHTML).toContain('Debug Overlay');
      expect(container.innerHTML).toContain('test-gam'); // first 8 chars
      expect(container.innerHTML).toContain('active');
    });

    it('should render player table with correct data', () => {
      (localStorage.getItem as jest.Mock).mockReturnValue('true');
      overlay = new DebugOverlay(mockScene, mockGameStateService);
      const container = document.getElementById('debug-overlay')!;

      expect(container.innerHTML).toContain('Alice');
      expect(container.innerHTML).toContain('BotPlayer');
      expect(container.innerHTML).toContain('(5,10)');
      expect(container.innerHTML).toContain('50'); // Alice's money
      expect(container.innerHTML).toContain('Coal');
    });

    it('should render current player name in header', () => {
      (localStorage.getItem as jest.Mock).mockReturnValue('true');
      overlay = new DebugOverlay(mockScene, mockGameStateService);
      const container = document.getElementById('debug-overlay')!;

      expect(container.innerHTML).toContain('#0');
      expect(container.innerHTML).toContain('Alice');
    });

    it('should render bot turn placeholder', () => {
      (localStorage.getItem as jest.Mock).mockReturnValue('true');
      overlay = new DebugOverlay(mockScene, mockGameStateService);
      const container = document.getElementById('debug-overlay')!;

      expect(container.innerHTML).toContain('Bot Turn');
      expect(container.innerHTML).toContain('No bot turn data yet');
    });

    it('should render socket events section', () => {
      (localStorage.getItem as jest.Mock).mockReturnValue('true');
      overlay = new DebugOverlay(mockScene, mockGameStateService);
      const container = document.getElementById('debug-overlay')!;

      expect(container.innerHTML).toContain('Socket Events');
      expect(container.innerHTML).toContain('No events yet');
    });

    it('should show "Waiting for game state" when gameState is missing', () => {
      mockScene.gameState = undefined;
      (localStorage.getItem as jest.Mock).mockReturnValue('true');
      overlay = new DebugOverlay(mockScene, mockGameStateService);
      const container = document.getElementById('debug-overlay')!;

      expect(container.innerHTML).toContain('Waiting for game state');
    });

    it('should highlight bot players with blue background', () => {
      (localStorage.getItem as jest.Mock).mockReturnValue('true');
      overlay = new DebugOverlay(mockScene, mockGameStateService);
      const container = document.getElementById('debug-overlay')!;

      // Bot player row should have blue tint
      expect(container.innerHTML).toContain('rgba(59,130,246,0.2)');
    });

    it('should highlight current player with green background', () => {
      (localStorage.getItem as jest.Mock).mockReturnValue('true');
      overlay = new DebugOverlay(mockScene, mockGameStateService);
      const container = document.getElementById('debug-overlay')!;

      // Current player (Alice, index 0) should have green tint
      expect(container.innerHTML).toContain('rgba(34,197,94,0.2)');
    });
  });
});
