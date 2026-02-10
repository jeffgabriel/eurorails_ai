/**
 * BotTurnTrigger tests
 *
 * Verifies that the trigger correctly:
 * - Detects bot players and invokes AIStrategyEngine after a delay
 * - Skips human players
 * - Queues bot turns when no humans are connected
 * - Resumes queued turns on human reconnect
 * - Advances the game turn after a bot turn completes
 * - Prevents double-triggering for the same game
 */

// --- Mocks (before imports) ---

jest.mock('../../db/index', () => ({
  db: {
    query: jest.fn(),
    connect: jest.fn(),
  },
}));

jest.mock('../../ai/AIStrategyEngine', () => ({
  AIStrategyEngine: {
    takeTurn: jest.fn(),
  },
}));

jest.mock('../../ai/BotLogger', () => {
  const noop = jest.fn().mockReturnThis();
  return {
    BotLogger: jest.fn().mockImplementation(() => ({
      info: noop,
      debug: noop,
      warn: noop,
      error: noop,
      trace: noop,
      withContext: jest.fn().mockReturnValue({
        info: noop,
        debug: noop,
        warn: noop,
        error: noop,
        trace: noop,
      }),
    })),
  };
});

jest.mock('../../services/playerService', () => ({
  PlayerService: {
    updateCurrentPlayerIndex: jest.fn(),
  },
}));

// --- Imports ---

import { BotTurnTrigger } from '../../ai/BotTurnTrigger';
import { AIStrategyEngine } from '../../ai/AIStrategyEngine';
import { db } from '../../db/index';
import { PlayerService } from '../../services/playerService';

const mockQuery = db.query as jest.Mock;
const mockTakeTurn = AIStrategyEngine.takeTurn as jest.Mock;
const mockUpdateIndex = PlayerService.updateCurrentPlayerIndex as jest.Mock;

// --- Helpers ---

function makeBotPlayer(overrides: Record<string, unknown> = {}) {
  return {
    id: 'bot-player-1',
    user_id: null,
    is_bot: true,
    bot_config: { archetype: 'freight_optimizer', skillLevel: 'medium' },
    name: 'TestBot',
    current_turn_number: 3,
    ...overrides,
  };
}

function makeHumanPlayer(overrides: Record<string, unknown> = {}) {
  return {
    id: 'human-player-1',
    user_id: 'user-abc',
    is_bot: false,
    bot_config: null,
    name: 'Human',
    current_turn_number: 5,
    ...overrides,
  };
}

function makeTurnResult(overrides: Record<string, unknown> = {}) {
  return {
    success: true,
    audit: {} as any,
    retriesUsed: 0,
    fellBackToPass: false,
    ...overrides,
  };
}

/**
 * Set up mockQuery to handle the standard sequence of DB queries:
 * 1. getPlayerAtIndex
 * 2. hasConnectedHuman
 * 3. position check (position_row, position_col)
 * 4. (After takeTurn) increment turn number
 * 5. COUNT players
 * 6. (updateCurrentPlayerIndex is a separate mock)
 */
function setupQueryMocks(options: {
  player?: ReturnType<typeof makeBotPlayer> | ReturnType<typeof makeHumanPlayer> | null;
  humanConnected?: boolean;
  playerCount?: number;
  hasPosition?: boolean;
  gameStatus?: string;
}) {
  const {
    player = makeBotPlayer(),
    humanConnected = true,
    playerCount = 3,
    hasPosition = true,
    gameStatus = 'active',
  } = options;

  const calls: Array<{ rows: unknown[] }> = [];

  // Call 1: getPlayerAtIndex
  calls.push({ rows: player ? [player] : [] });

  // Call 2: hasConnectedHuman
  calls.push({ rows: humanConnected ? [{ '?column?': 1 }] : [] });

  // Call 3: position check (bot auto-placement)
  calls.push({
    rows: [{ position_row: hasPosition ? 5 : null, position_col: hasPosition ? 10 : null }],
  });

  // Call 4: SELECT game status (advanceTurnAfterBot phase check)
  calls.push({ rows: [{ status: gameStatus }] });

  // Call 5: increment turn number (UPDATE, no meaningful return)
  calls.push({ rows: [] });

  // Call 6: COUNT players
  calls.push({ rows: [{ count: playerCount }] });

  mockQuery.mockReset();
  for (const result of calls) {
    mockQuery.mockResolvedValueOnce(result);
  }
}

// --- Tests ---

describe('BotTurnTrigger', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    BotTurnTrigger._clearState();
    mockTakeTurn.mockResolvedValue(makeTurnResult());
    mockUpdateIndex.mockResolvedValue(undefined);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe('init', () => {
    it('should initialize without errors', () => {
      expect(() => BotTurnTrigger.init()).not.toThrow();
    });
  });

  describe('onTurnChange — bot detection', () => {
    it('should invoke AIStrategyEngine when current player is a bot', async () => {
      setupQueryMocks({ player: makeBotPlayer() });

      const promise = BotTurnTrigger.onTurnChange('game-1', 1, 'bot-player-1');
      // Advance past the delay
      jest.advanceTimersByTime(2000);
      await promise;
      // Allow the setTimeout callback to complete
      await jest.advanceTimersByTimeAsync(2000);

      expect(mockTakeTurn).toHaveBeenCalledWith(
        'game-1',
        'bot-player-1',
        expect.any(String), // botUserId (player.id fallback when user_id is null)
        expect.objectContaining({
          skillLevel: 'medium',
          archetype: 'freight_optimizer',
          botId: 'bot-player-1',
          botName: 'TestBot',
        }),
        3, // turnNumber
      );
    });

    it('should skip when current player is human', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [makeHumanPlayer()] });

      await BotTurnTrigger.onTurnChange('game-1', 0, 'human-player-1');
      jest.advanceTimersByTime(2000);

      expect(mockTakeTurn).not.toHaveBeenCalled();
    });

    it('should skip when no player found at index', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });

      await BotTurnTrigger.onTurnChange('game-1', 99);
      jest.advanceTimersByTime(2000);

      expect(mockTakeTurn).not.toHaveBeenCalled();
    });
  });

  describe('delayed invocation', () => {
    it('should not invoke immediately — waits for delay', async () => {
      setupQueryMocks({ player: makeBotPlayer() });

      await BotTurnTrigger.onTurnChange('game-1', 1);

      // Before delay
      expect(mockTakeTurn).not.toHaveBeenCalled();

      // After delay
      await jest.advanceTimersByTimeAsync(2000);
      expect(mockTakeTurn).toHaveBeenCalledTimes(1);
    });

    it('should use default config when bot_config is null', async () => {
      setupQueryMocks({ player: makeBotPlayer({ bot_config: null }) });

      await BotTurnTrigger.onTurnChange('game-1', 1);
      await jest.advanceTimersByTimeAsync(2000);

      expect(mockTakeTurn).toHaveBeenCalledWith(
        'game-1',
        'bot-player-1',
        expect.any(String),
        expect.objectContaining({
          skillLevel: 'medium',
          archetype: 'opportunist',
        }),
        expect.any(Number),
      );
    });
  });

  describe('turn advancement after bot turn', () => {
    it('should increment bot turn number and advance to next player', async () => {
      setupQueryMocks({ player: makeBotPlayer(), playerCount: 3 });

      await BotTurnTrigger.onTurnChange('game-1', 1);
      await jest.advanceTimersByTimeAsync(2000);

      // Check turn number increment (call 3)
      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining('current_turn_number'),
        ['game-1', 'bot-player-1'],
      );

      // Check player count query (call 4)
      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining('COUNT'),
        ['game-1'],
      );

      // Check updateCurrentPlayerIndex called with next index
      // playerIndex=1, playerCount=3 → nextIndex=2
      expect(mockUpdateIndex).toHaveBeenCalledWith('game-1', 2);
    });

    it('should wrap around to index 0 at the end of player order', async () => {
      setupQueryMocks({ player: makeBotPlayer(), playerCount: 3 });

      await BotTurnTrigger.onTurnChange('game-1', 2); // last player
      await jest.advanceTimersByTimeAsync(2000);

      // (2 + 1) % 3 = 0
      expect(mockUpdateIndex).toHaveBeenCalledWith('game-1', 0);
    });
  });

  describe('double-trigger prevention', () => {
    it('should ignore second onTurnChange while first is pending', async () => {
      setupQueryMocks({ player: makeBotPlayer() });

      // First call — schedules the bot turn
      await BotTurnTrigger.onTurnChange('game-1', 1);

      // Second call — should be ignored (game-1 is pending)
      await BotTurnTrigger.onTurnChange('game-1', 1);

      await jest.advanceTimersByTimeAsync(2000);

      // Only one invocation
      expect(mockTakeTurn).toHaveBeenCalledTimes(1);
    });

    it('should allow new trigger after previous completes', async () => {
      setupQueryMocks({ player: makeBotPlayer() });

      await BotTurnTrigger.onTurnChange('game-1', 1);
      await jest.advanceTimersByTimeAsync(2000);

      expect(mockTakeTurn).toHaveBeenCalledTimes(1);

      // Set up mocks for second call
      setupQueryMocks({ player: makeBotPlayer() });

      await BotTurnTrigger.onTurnChange('game-1', 1);
      await jest.advanceTimersByTimeAsync(2000);

      expect(mockTakeTurn).toHaveBeenCalledTimes(2);
    });
  });

  describe('human connection check', () => {
    it('should queue bot turn when no humans are connected', async () => {
      setupQueryMocks({ player: makeBotPlayer(), humanConnected: false });

      await BotTurnTrigger.onTurnChange('game-1', 1, 'bot-player-1');
      jest.advanceTimersByTime(2000);

      expect(mockTakeTurn).not.toHaveBeenCalled();

      const queued = BotTurnTrigger._getQueuedTurns();
      expect(queued.has('game-1')).toBe(true);
      expect(queued.get('game-1')).toEqual({
        gameId: 'game-1',
        playerId: 'bot-player-1',
        playerIndex: 1,
      });
    });

    it('should proceed when humans are connected', async () => {
      setupQueryMocks({ player: makeBotPlayer(), humanConnected: true });

      await BotTurnTrigger.onTurnChange('game-1', 1);
      await jest.advanceTimersByTimeAsync(2000);

      expect(mockTakeTurn).toHaveBeenCalledTimes(1);
      expect(BotTurnTrigger._getQueuedTurns().has('game-1')).toBe(false);
    });
  });

  describe('bot turn queuing and resumption', () => {
    it('should resume queued bot turn when human reconnects', async () => {
      // First: queue (no humans connected)
      setupQueryMocks({ player: makeBotPlayer(), humanConnected: false });
      await BotTurnTrigger.onTurnChange('game-1', 1, 'bot-player-1');

      expect(BotTurnTrigger._getQueuedTurns().has('game-1')).toBe(true);
      expect(mockTakeTurn).not.toHaveBeenCalled();

      // Now: human reconnects — set up mocks for the resumed onTurnChange
      setupQueryMocks({ player: makeBotPlayer(), humanConnected: true });

      await BotTurnTrigger.onHumanReconnect('game-1');
      await jest.advanceTimersByTimeAsync(2000);

      expect(mockTakeTurn).toHaveBeenCalledTimes(1);
      expect(BotTurnTrigger._getQueuedTurns().has('game-1')).toBe(false);
    });

    it('should do nothing on reconnect if no queued turn', async () => {
      await BotTurnTrigger.onHumanReconnect('game-1');
      jest.advanceTimersByTime(2000);

      expect(mockTakeTurn).not.toHaveBeenCalled();
    });
  });

  describe('bot config parsing', () => {
    it('should use bot_config values from database', async () => {
      setupQueryMocks({
        player: makeBotPlayer({
          bot_config: { archetype: 'trunk_sprinter', skillLevel: 'hard' },
        }),
      });

      await BotTurnTrigger.onTurnChange('game-1', 1);
      await jest.advanceTimersByTimeAsync(2000);

      expect(mockTakeTurn).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(String),
        expect.any(String),
        expect.objectContaining({
          skillLevel: 'hard',
          archetype: 'trunk_sprinter',
        }),
        expect.any(Number),
      );
    });

    it('should fall back to player.id when user_id is null', async () => {
      setupQueryMocks({
        player: makeBotPlayer({ user_id: null, id: 'bot-xyz' }),
      });

      await BotTurnTrigger.onTurnChange('game-1', 1);
      await jest.advanceTimersByTimeAsync(2000);

      // botUserId should fall back to player.id
      expect(mockTakeTurn).toHaveBeenCalledWith(
        'game-1',
        'bot-xyz',
        'bot-xyz', // user_id fallback
        expect.any(Object),
        expect.any(Number),
      );
    });

    it('should use user_id when available', async () => {
      setupQueryMocks({
        player: makeBotPlayer({ user_id: 'bot-user-id', id: 'bot-xyz' }),
      });

      await BotTurnTrigger.onTurnChange('game-1', 1);
      await jest.advanceTimersByTimeAsync(2000);

      expect(mockTakeTurn).toHaveBeenCalledWith(
        'game-1',
        'bot-xyz',
        'bot-user-id',
        expect.any(Object),
        expect.any(Number),
      );
    });
  });

  describe('error handling', () => {
    it('should clear pending state even if AIStrategyEngine throws', async () => {
      setupQueryMocks({ player: makeBotPlayer() });
      mockTakeTurn.mockRejectedValueOnce(new Error('AI exploded'));

      await BotTurnTrigger.onTurnChange('game-1', 1);
      await jest.advanceTimersByTimeAsync(2000);

      // Pending should be cleared so future turns can proceed
      expect(BotTurnTrigger._getPendingGames().has('game-1')).toBe(false);
    });

    it('should not advance turn if AIStrategyEngine throws', async () => {
      setupQueryMocks({ player: makeBotPlayer() });
      mockTakeTurn.mockRejectedValueOnce(new Error('AI exploded'));

      await BotTurnTrigger.onTurnChange('game-1', 1);
      await jest.advanceTimersByTimeAsync(2000);

      expect(mockUpdateIndex).not.toHaveBeenCalled();
    });
  });
});
