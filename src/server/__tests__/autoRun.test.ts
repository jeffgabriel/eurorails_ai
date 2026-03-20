// server/__tests__/autoRun.test.ts

// Mock socket.io Server before any imports
jest.mock('socket.io', () => {
  const mockTo = jest.fn().mockReturnValue({ emit: jest.fn() });
  const mockOn = jest.fn();
  const mockUse = jest.fn();
  return {
    Server: jest.fn().mockImplementation(() => ({
      to: mockTo,
      on: mockOn,
      use: mockUse,
    })),
  };
});

jest.mock('../db', () => ({
  db: { query: jest.fn() },
}));
jest.mock('../services/authService', () => ({
  AuthService: { verifyToken: jest.fn() },
}));
jest.mock('../services/gameService', () => ({
  GameService: { getGame: jest.fn() },
}));
jest.mock('../services/chatService', () => ({
  ChatService: {},
}));
jest.mock('../services/rateLimitService', () => ({
  rateLimitService: {},
}));
jest.mock('../services/gameChatLimitService', () => ({
  gameChatLimitService: {},
}));
jest.mock('../services/moderationService', () => ({
  moderationService: {},
}));
jest.mock('../services/ai/BotTurnTrigger', () => ({
  onTurnChange: jest.fn().mockResolvedValue(undefined),
  onHumanReconnect: jest.fn().mockResolvedValue(undefined),
  advanceTurnAfterBot: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../services/ai/WhisperService', () => ({
  WhisperService: {},
}));

import {
  isAutoRunEnabled,
  toggleAutoRun,
  clearAutoRun,
  initializeSocketIO,
  emitTurnChange,
} from '../services/socketService';
import { advanceTurnAfterBot } from '../services/ai/BotTurnTrigger';
import { db } from '../db';
import { createServer } from 'http';

const mockDb = db as unknown as { query: jest.Mock };
const mockAdvance = advanceTurnAfterBot as jest.Mock;

describe('Auto-Run State Management', () => {
  const gameId = 'game-1';
  const playerId = 'player-1';
  const playerId2 = 'player-2';

  afterEach(() => {
    clearAutoRun(gameId);
    clearAutoRun('game-2');
  });

  describe('toggleAutoRun', () => {
    it('should enable auto-run and return true on first toggle', () => {
      const enabled = toggleAutoRun(gameId, playerId);
      expect(enabled).toBe(true);
      expect(isAutoRunEnabled(gameId, playerId)).toBe(true);
    });

    it('should disable auto-run and return false on second toggle', () => {
      toggleAutoRun(gameId, playerId);
      const enabled = toggleAutoRun(gameId, playerId);
      expect(enabled).toBe(false);
      expect(isAutoRunEnabled(gameId, playerId)).toBe(false);
    });

    it('should be idempotent: toggle on/off/on cycle', () => {
      expect(toggleAutoRun(gameId, playerId)).toBe(true);
      expect(toggleAutoRun(gameId, playerId)).toBe(false);
      expect(toggleAutoRun(gameId, playerId)).toBe(true);
      expect(isAutoRunEnabled(gameId, playerId)).toBe(true);
    });

    it('should handle multiple players in the same game independently', () => {
      toggleAutoRun(gameId, playerId);
      toggleAutoRun(gameId, playerId2);

      expect(isAutoRunEnabled(gameId, playerId)).toBe(true);
      expect(isAutoRunEnabled(gameId, playerId2)).toBe(true);

      toggleAutoRun(gameId, playerId);
      expect(isAutoRunEnabled(gameId, playerId)).toBe(false);
      expect(isAutoRunEnabled(gameId, playerId2)).toBe(true);
    });

    it('should handle multiple games independently', () => {
      toggleAutoRun('game-1', playerId);
      toggleAutoRun('game-2', playerId);

      expect(isAutoRunEnabled('game-1', playerId)).toBe(true);
      expect(isAutoRunEnabled('game-2', playerId)).toBe(true);

      clearAutoRun('game-1');
      expect(isAutoRunEnabled('game-1', playerId)).toBe(false);
      expect(isAutoRunEnabled('game-2', playerId)).toBe(true);
    });
  });

  describe('isAutoRunEnabled', () => {
    it('should return false for unknown game', () => {
      expect(isAutoRunEnabled('nonexistent', playerId)).toBe(false);
    });

    it('should return false for unknown player in known game', () => {
      toggleAutoRun(gameId, playerId);
      expect(isAutoRunEnabled(gameId, 'unknown-player')).toBe(false);
    });
  });

  describe('clearAutoRun', () => {
    it('should remove all players for a game', () => {
      toggleAutoRun(gameId, playerId);
      toggleAutoRun(gameId, playerId2);

      clearAutoRun(gameId);

      expect(isAutoRunEnabled(gameId, playerId)).toBe(false);
      expect(isAutoRunEnabled(gameId, playerId2)).toBe(false);
    });

    it('should be safe to call on unknown game', () => {
      expect(() => clearAutoRun('nonexistent')).not.toThrow();
    });
  });
});

describe('Auto-Run in emitTurnChange', () => {
  beforeAll(() => {
    // Initialize io with mocked socket.io so emitTurnChange doesn't bail
    const server = createServer();
    initializeSocketIO(server);
  });

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
  });

  afterEach(() => {
    clearAutoRun('game-1');
    jest.useRealTimers();
  });

  it('should NOT auto-advance for a bot player with auto-run', async () => {
    toggleAutoRun('game-1', 'player-bot');

    // Mock: player is a bot
    mockDb.query.mockResolvedValueOnce({ rows: [{ is_bot: true }] });

    emitTurnChange('game-1', 0, 'player-bot');

    // Flush microtask queue (promise chain for db.query)
    await new Promise(process.nextTick);
    jest.advanceTimersByTime(3000);

    expect(mockAdvance).not.toHaveBeenCalled();
  });

  it('should NOT auto-advance for a non-auto-run human', async () => {
    // Do NOT enable auto-run
    emitTurnChange('game-1', 0, 'player-human');

    await new Promise(process.nextTick);
    jest.advanceTimersByTime(3000);

    expect(mockAdvance).not.toHaveBeenCalled();
  });

  it('should auto-advance for a non-bot human with auto-run after delay', async () => {
    toggleAutoRun('game-1', 'player-human');

    // Mock: player is NOT a bot
    mockDb.query.mockResolvedValueOnce({ rows: [{ is_bot: false }] });

    emitTurnChange('game-1', 0, 'player-human');

    // Flush microtask queue so the .then() resolves
    await new Promise(process.nextTick);

    // Before delay: should not have been called
    expect(mockAdvance).not.toHaveBeenCalled();

    // Advance past the 2000ms delay
    jest.advanceTimersByTime(2000);

    expect(mockAdvance).toHaveBeenCalledWith('game-1');
  });
});
