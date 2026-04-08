/**
 * BotTurnTrigger tests
 *
 * Covers: core behavior (enable flag, connected human, turn execution,
 * reconnect, advanceTurnAfterBot), JIRA-19 (LLM metadata persistence),
 * and JIRA-106 (bot victory check).
 */

import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';

// ── Mock external systems ─────────────────────────────────────────────────

jest.mock('../../db/index', () => ({
  db: {
    query: jest.fn<() => Promise<any>>(),
  },
}));

jest.mock('../../services/socketService', () => ({
  emitToGame: jest.fn<() => void>(),
  emitTurnChange: jest.fn<() => void>(),
  getSocketIO: jest.fn<() => any>().mockReturnValue(null),
  emitVictoryTriggered: jest.fn<() => void>(),
  emitGameOver: jest.fn<() => void>(),
  emitTieExtended: jest.fn<() => void>(),
}));

jest.mock('../../services/playerService', () => ({
  PlayerService: {
    updateCurrentPlayerIndex: jest.fn(),
  },
}));

jest.mock('../../services/InitialBuildService', () => ({
  InitialBuildService: {
    advanceTurn: jest.fn(),
  },
}));

jest.mock('../../services/ai/AIStrategyEngine', () => ({
  AIStrategyEngine: {
    takeTurn: jest.fn<() => Promise<any>>(),
  },
}));

jest.mock('../../services/ai/BotMemory', () => ({
  clearMemory: jest.fn(),
}));

jest.mock('../../services/ai/GameLogger', () => ({
  appendTurn: jest.fn(),
}));

jest.mock('../../services/victoryService', () => ({
  VictoryService: {
    getVictoryState: jest.fn<() => Promise<any>>(),
    declareVictory: jest.fn<() => Promise<any>>(),
    isFinalTurn: jest.fn<() => Promise<boolean>>(),
    resolveVictory: jest.fn<() => Promise<any>>(),
  },
}));

jest.mock('../../services/trackService', () => ({
  TrackService: {
    getTrackState: jest.fn<() => Promise<any>>(),
  },
}));

jest.mock('../../services/ai/connectedMajorCities', () => ({
  getConnectedMajorCities: jest.fn<() => any[]>(),
}));

// ── Imports (after mocks) ─────────────────────────────────────────────────

import {
  onTurnChange, pendingBotTurns, queuedBotTurns, checkBotVictory,
  isAIBotsEnabled, hasConnectedHuman, onHumanReconnect, advanceTurnAfterBot,
} from '../../services/ai/BotTurnTrigger';
import { AIStrategyEngine } from '../../services/ai/AIStrategyEngine';
import { db } from '../../db/index';
import { emitToGame, getSocketIO, emitVictoryTriggered, emitGameOver } from '../../services/socketService';
import { PlayerService } from '../../services/playerService';
import { InitialBuildService } from '../../services/InitialBuildService';
import { AIActionType } from '../../../shared/types/GameTypes';
import { VictoryService } from '../../services/victoryService';
import { TrackService } from '../../services/trackService';
import { getConnectedMajorCities } from '../../services/ai/connectedMajorCities';

const mockQuery = db.query as unknown as jest.Mock<(...args: any[]) => Promise<any>>;
const mockTakeTurn = AIStrategyEngine.takeTurn as jest.MockedFunction<typeof AIStrategyEngine.takeTurn>;
const mockEmitToGame = emitToGame as jest.MockedFunction<typeof emitToGame>;
const mockGetSocketIO = getSocketIO as jest.MockedFunction<typeof getSocketIO>;

function mockResult(rows: any[]) {
  return { rows, command: '', rowCount: rows.length, oid: 0, fields: [] };
}

// ── Tests ─────────────────────────────────────────────────────────────────

describe('BotTurnTrigger — JIRA-19: LLM metadata persistence', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    pendingBotTurns.clear();
    process.env.ENABLE_AI_BOTS = 'true';

    // Re-set mockImplementation explicitly after clearAllMocks — clearAllMocks
    // only resets call history, NOT mockReturnValue/mockImplementation.
    // Default query responses for the standard flow:
    // 1. is_bot check
    // 2. game status check
    // 3. turn_number fetch
    // 4. turn_number increment
    // 5. turn_build_cost reset
    // 6. details UPDATE (the one we're testing)
    // 7+ advance turn queries
    mockQuery.mockImplementation(async (sql: string) => {
      if (typeof sql === 'string') {
        if (sql.includes('SELECT is_bot')) return mockResult([{ is_bot: true }]);
        if (sql.includes('SELECT status FROM games')) return mockResult([{ status: 'active', current_player_index: 0 }]);
        if (sql.includes('SELECT current_turn_number')) return mockResult([{ current_turn_number: 5 }]);
        if (sql.includes('UPDATE players SET current_turn_number')) return mockResult([]);
        if (sql.includes('UPDATE player_tracks')) return mockResult([]);
        if (sql.includes('UPDATE bot_turn_audits')) return mockResult([]);
        if (sql.includes('SELECT COUNT')) return mockResult([{ count: 2 }]);
      }
      return mockResult([]);
    });
  });

  function makeBotTurnResult(overrides: Record<string, any> = {}) {
    return {
      action: AIActionType.BuildTrack,
      segmentsBuilt: 3,
      cost: 5,
      durationMs: 800,
      success: true,
      reasoning: '[route-planned] Build toward Berlin',
      planHorizon: 'Route: pickup(Steel@Berlin) → deliver(Steel@Paris)',
      model: 'claude-sonnet-4-20250514',
      llmLatencyMs: 750,
      tokenUsage: { input: 200, output: 80 },
      retried: false,
      guardrailOverride: undefined,
      guardrailReason: undefined,
      demandRanking: [],
      ...overrides,
    };
  }

  it('should UPDATE bot_turn_audits.details with LLM metadata after takeTurn', async () => {
    mockTakeTurn.mockResolvedValue(makeBotTurnResult() as any);

    await onTurnChange('game-1', 0, 'bot-1');

    // Find the UPDATE bot_turn_audits call
    const updateCall = mockQuery.mock.calls.find(
      (call: any[]) => typeof call[0] === 'string' && call[0].includes('UPDATE bot_turn_audits'),
    );
    expect(updateCall).toBeDefined();

    // Verify the JSONB payload
    const details = JSON.parse(updateCall![1][0]);
    expect(details.model).toBe('claude-sonnet-4-20250514');
    expect(details.llmLatencyMs).toBe(750);
    expect(details.tokenUsage).toEqual({ input: 200, output: 80 });
    expect(details.retried).toBe(false);
    expect(details.reasoning).toContain('route-planned');
    expect(details.planHorizon).toContain('Route:');
    expect(details.guardrailOverride).toBe(false);
    expect(details.guardrailReason).toBeNull();
  });

  it('should use turn_number + 1 in WHERE clause', async () => {
    mockTakeTurn.mockResolvedValue(makeBotTurnResult() as any);

    await onTurnChange('game-1', 0, 'bot-1');

    const updateCall = mockQuery.mock.calls.find(
      (call: any[]) => typeof call[0] === 'string' && call[0].includes('UPDATE bot_turn_audits'),
    );
    expect(updateCall).toBeDefined();

    // turn_number from mock is 5, so WHERE should use 6
    const params = updateCall![1];
    expect(params[1]).toBe('game-1');     // game_id
    expect(params[2]).toBe('bot-1');      // player_id
    expect(params[3]).toBe(6);            // turnNumber + 1 = 5 + 1
  });

  it('should not crash if details UPDATE fails', async () => {
    const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    // Make the audit UPDATE throw, but everything else succeeds
    mockQuery.mockImplementation(async (sql: string) => {
      if (typeof sql === 'string') {
        if (sql.includes('SELECT is_bot')) return mockResult([{ is_bot: true }]);
        if (sql.includes('SELECT status FROM games')) return mockResult([{ status: 'active', current_player_index: 0 }]);
        if (sql.includes('SELECT current_turn_number')) return mockResult([{ current_turn_number: 5 }]);
        if (sql.includes('UPDATE players SET current_turn_number')) return mockResult([]);
        if (sql.includes('UPDATE player_tracks')) return mockResult([]);
        if (sql.includes('UPDATE bot_turn_audits')) throw new Error('relation "bot_turn_audits" does not exist');
        if (sql.includes('SELECT COUNT')) return mockResult([{ count: 2 }]);
      }
      return mockResult([]);
    });

    mockTakeTurn.mockResolvedValue(makeBotTurnResult() as any);

    // Should NOT throw
    await expect(onTurnChange('game-1', 0, 'bot-1')).resolves.toBeUndefined();

    // Error should be logged
    const auditErrorLog = consoleSpy.mock.calls.find(
      (call: any[]) => typeof call[0] === 'string' && call[0].includes('details UPDATE failed'),
    );
    expect(auditErrorLog).toBeDefined();

    consoleSpy.mockRestore();
  });

  it('should handle undefined optional fields gracefully', async () => {
    mockTakeTurn.mockResolvedValue(makeBotTurnResult({
      model: undefined,
      llmLatencyMs: undefined,
      tokenUsage: undefined,
      retried: undefined,
      reasoning: undefined,
      planHorizon: undefined,
      guardrailOverride: undefined,
      guardrailReason: undefined,
    }) as any);

    await onTurnChange('game-1', 0, 'bot-1');

    const updateCall = mockQuery.mock.calls.find(
      (call: any[]) => typeof call[0] === 'string' && call[0].includes('UPDATE bot_turn_audits'),
    );
    expect(updateCall).toBeDefined();

    const details = JSON.parse(updateCall![1][0]);
    expect(details.model).toBeNull();
    expect(details.llmLatencyMs).toBeNull();
    expect(details.tokenUsage).toBeNull();
    expect(details.retried).toBe(false);
    expect(details.reasoning).toBeNull();
    expect(details.planHorizon).toBeNull();
    expect(details.guardrailOverride).toBe(false);
    expect(details.guardrailReason).toBeNull();
  });

  it('should include LLM metadata in bot:turn-complete socket event', async () => {
    mockTakeTurn.mockResolvedValue(makeBotTurnResult() as any);

    await onTurnChange('game-1', 0, 'bot-1');

    // Find the bot:turn-complete emit call
    const turnCompleteCall = mockEmitToGame.mock.calls.find(
      (call: any[]) => call[1] === 'bot:turn-complete',
    );
    expect(turnCompleteCall).toBeDefined();

    const payload = turnCompleteCall![2] as Record<string, any>;
    expect(payload.model).toBe('claude-sonnet-4-20250514');
    expect(payload.llmLatencyMs).toBe(750);
    expect(payload.tokenUsage).toEqual({ input: 200, output: 80 });
    expect(payload.retried).toBe(false);
  });
});

// ── JIRA-106: Bot Victory Check Tests ──────────────────────────────────────

const mockGetVictoryState = VictoryService.getVictoryState as jest.MockedFunction<typeof VictoryService.getVictoryState>;
const mockDeclareVictory = VictoryService.declareVictory as jest.MockedFunction<typeof VictoryService.declareVictory>;
const mockIsFinalTurn = VictoryService.isFinalTurn as jest.MockedFunction<typeof VictoryService.isFinalTurn>;
const mockResolveVictory = VictoryService.resolveVictory as jest.MockedFunction<typeof VictoryService.resolveVictory>;
const mockGetTrackState = TrackService.getTrackState as jest.MockedFunction<typeof TrackService.getTrackState>;
const mockGetConnectedMajorCities = getConnectedMajorCities as jest.MockedFunction<typeof getConnectedMajorCities>;
const mockEmitVictoryTriggered = emitVictoryTriggered as jest.MockedFunction<typeof emitVictoryTriggered>;
const mockEmitGameOver = emitGameOver as jest.MockedFunction<typeof emitGameOver>;

describe('BotTurnTrigger — JIRA-106: Bot victory check', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockIsFinalTurn.mockResolvedValue(false);
  });

  const sevenCities = [
    { name: 'London', row: 10, col: 5 },
    { name: 'Paris', row: 20, col: 10 },
    { name: 'Berlin', row: 15, col: 25 },
    { name: 'Madrid', row: 35, col: 3 },
    { name: 'Roma', row: 30, col: 20 },
    { name: 'Wien', row: 18, col: 22 },
    { name: 'Warszawa', row: 12, col: 30 },
  ];

  it('should declare victory when bot has 250M+ and 7+ connected cities', async () => {
    mockGetVictoryState.mockResolvedValue({
      triggered: false,
      triggerPlayerIndex: -1,
      victoryThreshold: 250,
      finalTurnPlayerIndex: -1,
    });
    (db.query as any).mockImplementation(async (sql: string) => {
      if (sql.includes('SELECT money')) return { rows: [{ money: 260, debt_owed: 0, name: 'Flash' }] };
      return { rows: [] };
    });
    mockGetTrackState.mockResolvedValue({ segments: [{ from: { row: 1, col: 1 }, to: { row: 1, col: 2 }, cost: 1 }] } as any);
    mockGetConnectedMajorCities.mockReturnValue(sevenCities);
    mockDeclareVictory.mockResolvedValue({
      success: true,
      victoryState: {
        triggered: true,
        triggerPlayerIndex: 1,
        victoryThreshold: 250,
        finalTurnPlayerIndex: 0,
      },
    });

    const result = await checkBotVictory('game-1', 'bot-1');

    expect(result).toBe(true);
    expect(mockDeclareVictory).toHaveBeenCalledWith('game-1', 'bot-1', sevenCities);
    expect(mockEmitVictoryTriggered).toHaveBeenCalledWith('game-1', 1, 'Flash', 0, 250);
  });

  it('should NOT declare victory when bot has < 250M', async () => {
    mockGetVictoryState.mockResolvedValue({
      triggered: false,
      triggerPlayerIndex: -1,
      victoryThreshold: 250,
      finalTurnPlayerIndex: -1,
    });
    (db.query as any).mockImplementation(async (sql: string) => {
      if (sql.includes('SELECT money')) return { rows: [{ money: 200, debt_owed: 0, name: 'Flash' }] };
      return { rows: [] };
    });

    const result = await checkBotVictory('game-1', 'bot-1');

    expect(result).toBe(false);
    expect(mockDeclareVictory).not.toHaveBeenCalled();
  });

  it('should NOT declare victory when bot has < 7 connected cities', async () => {
    mockGetVictoryState.mockResolvedValue({
      triggered: false,
      triggerPlayerIndex: -1,
      victoryThreshold: 250,
      finalTurnPlayerIndex: -1,
    });
    (db.query as any).mockImplementation(async (sql: string) => {
      if (sql.includes('SELECT money')) return { rows: [{ money: 300, debt_owed: 0, name: 'Flash' }] };
      return { rows: [] };
    });
    mockGetTrackState.mockResolvedValue({ segments: [{ from: { row: 1, col: 1 }, to: { row: 1, col: 2 }, cost: 1 }] } as any);
    mockGetConnectedMajorCities.mockReturnValue(sevenCities.slice(0, 5));

    const result = await checkBotVictory('game-1', 'bot-1');

    expect(result).toBe(false);
    expect(mockDeclareVictory).not.toHaveBeenCalled();
  });

  it('should NOT declare victory when victory already triggered', async () => {
    mockGetVictoryState.mockResolvedValue({
      triggered: true,
      triggerPlayerIndex: 0,
      victoryThreshold: 250,
      finalTurnPlayerIndex: 1,
    });

    const result = await checkBotVictory('game-1', 'bot-1');

    expect(result).toBe(false);
    expect(mockDeclareVictory).not.toHaveBeenCalled();
  });

  it('should account for debt when checking net worth', async () => {
    mockGetVictoryState.mockResolvedValue({
      triggered: false,
      triggerPlayerIndex: -1,
      victoryThreshold: 250,
      finalTurnPlayerIndex: -1,
    });
    (db.query as any).mockImplementation(async (sql: string) => {
      // 300 money - 60 debt = 240 net worth (below 250 threshold)
      if (sql.includes('SELECT money')) return { rows: [{ money: 300, debt_owed: 60, name: 'Flash' }] };
      return { rows: [] };
    });

    const result = await checkBotVictory('game-1', 'bot-1');

    expect(result).toBe(false);
    expect(mockDeclareVictory).not.toHaveBeenCalled();
  });
});

// ── Core behavior tests ──────────────────────────────────────────────────

describe('BotTurnTrigger — core behavior', () => {
  const originalEnv = process.env.ENABLE_AI_BOTS;

  beforeEach(() => {
    jest.useFakeTimers();
    jest.resetAllMocks();
    process.env.ENABLE_AI_BOTS = 'true';
    mockTakeTurn.mockResolvedValue({
      action: 'PassTurn' as any,
      segmentsBuilt: 0,
      cost: 0,
      durationMs: 10,
      success: true,
    });
  });

  afterEach(async () => {
    jest.useRealTimers();
    if (originalEnv === undefined) {
      delete process.env.ENABLE_AI_BOTS;
    } else {
      process.env.ENABLE_AI_BOTS = originalEnv;
    }
    pendingBotTurns.clear();
    queuedBotTurns.clear();
  });

  describe('isAIBotsEnabled', () => {
    it('should return true when ENABLE_AI_BOTS is unset', () => {
      delete process.env.ENABLE_AI_BOTS;
      expect(isAIBotsEnabled()).toBe(true);
    });

    it('should return true when ENABLE_AI_BOTS is "true"', () => {
      process.env.ENABLE_AI_BOTS = 'true';
      expect(isAIBotsEnabled()).toBe(true);
    });

    it('should return false when ENABLE_AI_BOTS is "false"', () => {
      process.env.ENABLE_AI_BOTS = 'false';
      expect(isAIBotsEnabled()).toBe(false);
    });

    it('should return false when ENABLE_AI_BOTS is "FALSE" (case-insensitive)', () => {
      process.env.ENABLE_AI_BOTS = 'FALSE';
      expect(isAIBotsEnabled()).toBe(false);
    });

    it('should return true when ENABLE_AI_BOTS is empty string', () => {
      process.env.ENABLE_AI_BOTS = '';
      expect(isAIBotsEnabled()).toBe(true);
    });
  });

  describe('hasConnectedHuman', () => {
    it('should return true when io is null (testing fallback)', async () => {
      mockGetSocketIO.mockReturnValue(null);
      const result = await hasConnectedHuman('game-1');
      expect(result).toBe(true);
    });

    it('should return true when room has connected sockets', async () => {
      const mockRoom = new Set(['socket-1', 'socket-2']);
      const mockIO = {
        sockets: {
          adapter: {
            rooms: new Map([['game-1', mockRoom]]),
          },
        },
      };
      mockGetSocketIO.mockReturnValue(mockIO as any);
      const result = await hasConnectedHuman('game-1');
      expect(result).toBe(true);
    });

    it('should return false when room has no sockets', async () => {
      const mockIO = {
        sockets: {
          adapter: {
            rooms: new Map(),
          },
        },
      };
      mockGetSocketIO.mockReturnValue(mockIO as any);
      const result = await hasConnectedHuman('game-1');
      expect(result).toBe(false);
    });

    it('should return false when room exists but is empty', async () => {
      const mockRoom = new Set();
      const mockIO = {
        sockets: {
          adapter: {
            rooms: new Map([['game-1', mockRoom]]),
          },
        },
      };
      mockGetSocketIO.mockReturnValue(mockIO as any);
      const result = await hasConnectedHuman('game-1');
      expect(result).toBe(false);
    });
  });

  describe('onTurnChange', () => {
    it('should return immediately when ENABLE_AI_BOTS is false', async () => {
      process.env.ENABLE_AI_BOTS = 'false';
      await onTurnChange('game-1', 0, 'player-1');
      expect(mockQuery).not.toHaveBeenCalled();
    });

    it('should return when player is not a bot', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ is_bot: false }], command: '', rowCount: 1, oid: 0, fields: [] });
      await onTurnChange('game-1', 0, 'player-1');
      expect(mockQuery).toHaveBeenCalledTimes(1);
      expect(mockEmitToGame).not.toHaveBeenCalled();
    });

    it('should return when game status is completed', async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [{ is_bot: true }], command: '', rowCount: 1, oid: 0, fields: [] })
        .mockResolvedValueOnce({ rows: [{ status: 'completed' }], command: '', rowCount: 1, oid: 0, fields: [] });
      await onTurnChange('game-1', 0, 'bot-1');
      expect(mockQuery).toHaveBeenCalledTimes(2);
      expect(mockEmitToGame).not.toHaveBeenCalled();
    });

    it('should return when game status is abandoned', async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [{ is_bot: true }], command: '', rowCount: 1, oid: 0, fields: [] })
        .mockResolvedValueOnce({ rows: [{ status: 'abandoned' }], command: '', rowCount: 1, oid: 0, fields: [] });
      await onTurnChange('game-1', 0, 'bot-1');
      expect(mockEmitToGame).not.toHaveBeenCalled();
    });

    it('should execute bot turn with delay for bot player in active game', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ is_bot: true }], command: '', rowCount: 1, oid: 0, fields: [] });
      mockQuery.mockResolvedValueOnce({ rows: [{ status: 'active' }], command: '', rowCount: 1, oid: 0, fields: [] });
      mockQuery.mockResolvedValueOnce({ rows: [{ current_turn_number: 3 }], command: '', rowCount: 1, oid: 0, fields: [] });
      mockQuery.mockResolvedValueOnce({ rows: [], command: 'UPDATE', rowCount: 1, oid: 0, fields: [] });
      mockQuery.mockResolvedValueOnce({ rows: [], command: 'UPDATE', rowCount: 1, oid: 0, fields: [] });
      mockQuery.mockResolvedValueOnce({ rows: [{ status: 'active', current_player_index: 0 }], command: '', rowCount: 1, oid: 0, fields: [] });
      mockQuery.mockResolvedValueOnce({ rows: [{ count: 3 }], command: '', rowCount: 1, oid: 0, fields: [] });

      const promise = onTurnChange('game-1', 0, 'bot-1');
      await jest.advanceTimersByTimeAsync(1500);
      await promise;

      expect(mockEmitToGame).toHaveBeenCalledWith('game-1', 'bot:turn-start', expect.objectContaining({
        botPlayerId: 'bot-1',
        turnNumber: 3,
      }));
      expect(mockTakeTurn).toHaveBeenCalledWith('game-1', 'bot-1');
      expect(mockEmitToGame).toHaveBeenCalledWith('game-1', 'bot:turn-complete', expect.objectContaining({
        botPlayerId: 'bot-1',
        action: 'PassTurn',
        segmentsBuilt: 0,
        cost: 0,
      }));
    });

    it('should prevent double execution with pendingBotTurns guard', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ is_bot: true }], command: '', rowCount: 1, oid: 0, fields: [] });
      mockQuery.mockResolvedValueOnce({ rows: [{ status: 'active' }], command: '', rowCount: 1, oid: 0, fields: [] });
      mockQuery.mockResolvedValueOnce({ rows: [{ current_turn_number: 1 }], command: '', rowCount: 1, oid: 0, fields: [] });
      mockQuery.mockResolvedValueOnce({ rows: [], command: 'UPDATE', rowCount: 1, oid: 0, fields: [] });
      mockQuery.mockResolvedValueOnce({ rows: [], command: 'UPDATE', rowCount: 1, oid: 0, fields: [] });
      mockQuery.mockResolvedValueOnce({ rows: [{ status: 'active', current_player_index: 0 }], command: '', rowCount: 1, oid: 0, fields: [] });
      mockQuery.mockResolvedValueOnce({ rows: [{ count: 2 }], command: '', rowCount: 1, oid: 0, fields: [] });
      mockQuery.mockResolvedValueOnce({ rows: [{ is_bot: true }], command: '', rowCount: 1, oid: 0, fields: [] });
      mockQuery.mockResolvedValueOnce({ rows: [{ status: 'active' }], command: '', rowCount: 1, oid: 0, fields: [] });

      const promise1 = onTurnChange('game-1', 0, 'bot-1');
      const promise2 = onTurnChange('game-1', 0, 'bot-1');

      await jest.advanceTimersByTimeAsync(1500);
      await promise1;
      await promise2;

      const startCalls = mockEmitToGame.mock.calls.filter(
        (c: any[]) => c[1] === 'bot:turn-start'
      );
      expect(startCalls).toHaveLength(1);
    });

    it('should clean up pendingBotTurns after execution', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ is_bot: true }], command: '', rowCount: 1, oid: 0, fields: [] });
      mockQuery.mockResolvedValueOnce({ rows: [{ status: 'active' }], command: '', rowCount: 1, oid: 0, fields: [] });
      mockQuery.mockResolvedValueOnce({ rows: [{ current_turn_number: 1 }], command: '', rowCount: 1, oid: 0, fields: [] });
      mockQuery.mockResolvedValueOnce({ rows: [], command: 'UPDATE', rowCount: 1, oid: 0, fields: [] });
      mockQuery.mockResolvedValueOnce({ rows: [], command: 'UPDATE', rowCount: 1, oid: 0, fields: [] });
      mockQuery.mockResolvedValueOnce({ rows: [{ status: 'active', current_player_index: 0 }], command: '', rowCount: 1, oid: 0, fields: [] });
      mockQuery.mockResolvedValueOnce({ rows: [{ count: 2 }], command: '', rowCount: 1, oid: 0, fields: [] });

      const promise = onTurnChange('game-1', 0, 'bot-1');

      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      expect(pendingBotTurns.has('game-1')).toBe(true);
      await jest.advanceTimersByTimeAsync(1500);
      await promise;
      expect(pendingBotTurns.has('game-1')).toBe(false);
    });

    it('should clean up pendingBotTurns even on error', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ is_bot: true }], command: '', rowCount: 1, oid: 0, fields: [] });
      mockQuery.mockResolvedValueOnce({ rows: [{ status: 'active' }], command: '', rowCount: 1, oid: 0, fields: [] });
      mockQuery.mockRejectedValueOnce(new Error('DB connection lost'));

      const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

      const promise = onTurnChange('game-1', 0, 'bot-1');
      await jest.advanceTimersByTimeAsync(1500);
      await promise;

      expect(pendingBotTurns.has('game-1')).toBe(false);
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('Error executing bot turn'),
        expect.any(Error),
      );
      consoleSpy.mockRestore();
    });
  });

  describe('onHumanReconnect', () => {
    it('should return immediately when ENABLE_AI_BOTS is false', async () => {
      process.env.ENABLE_AI_BOTS = 'false';
      await onHumanReconnect('game-1');
      expect(mockQuery).not.toHaveBeenCalled();
    });

    it('should do nothing when no queued turn exists', async () => {
      await onHumanReconnect('game-1');
      expect(mockQuery).not.toHaveBeenCalled();
    });

    it('should dequeue and execute when queued turn exists', async () => {
      queuedBotTurns.set('game-1', {
        gameId: 'game-1',
        currentPlayerIndex: 0,
        currentPlayerId: 'bot-1',
      });

      mockQuery.mockResolvedValueOnce({ rows: [{ is_bot: true }], command: '', rowCount: 1, oid: 0, fields: [] });
      mockQuery.mockResolvedValueOnce({ rows: [{ status: 'active' }], command: '', rowCount: 1, oid: 0, fields: [] });
      mockQuery.mockResolvedValueOnce({ rows: [{ current_turn_number: 1 }], command: '', rowCount: 1, oid: 0, fields: [] });
      mockQuery.mockResolvedValueOnce({ rows: [], command: 'UPDATE', rowCount: 1, oid: 0, fields: [] });
      mockQuery.mockResolvedValueOnce({ rows: [], command: 'UPDATE', rowCount: 1, oid: 0, fields: [] });
      mockQuery.mockResolvedValueOnce({ rows: [{ status: 'active', current_player_index: 0 }], command: '', rowCount: 1, oid: 0, fields: [] });
      mockQuery.mockResolvedValueOnce({ rows: [{ count: 2 }], command: '', rowCount: 1, oid: 0, fields: [] });

      const promise = onHumanReconnect('game-1');
      await jest.advanceTimersByTimeAsync(1500);
      await promise;

      expect(queuedBotTurns.has('game-1')).toBe(false);
      expect(mockEmitToGame).toHaveBeenCalledWith('game-1', 'bot:turn-start', expect.any(Object));
    });
  });

  describe('advanceTurnAfterBot', () => {
    beforeEach(() => {
      jest.useRealTimers();
    });

    afterEach(() => {
      jest.useFakeTimers();
    });

    it('should call PlayerService.updateCurrentPlayerIndex for active games', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ status: 'active', current_player_index: 1 }], command: '', rowCount: 1, oid: 0, fields: [] });
      mockQuery.mockResolvedValueOnce({ rows: [{ count: 3 }], command: '', rowCount: 1, oid: 0, fields: [] });
      (PlayerService.updateCurrentPlayerIndex as jest.Mock<() => Promise<void>>).mockResolvedValue(undefined);

      await advanceTurnAfterBot('game-1');

      expect(PlayerService.updateCurrentPlayerIndex).toHaveBeenCalledWith('game-1', 2);
    });

    it('should wrap around player index for active games', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ status: 'active', current_player_index: 2 }], command: '', rowCount: 1, oid: 0, fields: [] });
      mockQuery.mockResolvedValueOnce({ rows: [{ count: 3 }], command: '', rowCount: 1, oid: 0, fields: [] });
      (PlayerService.updateCurrentPlayerIndex as jest.Mock<() => Promise<void>>).mockResolvedValue(undefined);

      await advanceTurnAfterBot('game-1');

      expect(PlayerService.updateCurrentPlayerIndex).toHaveBeenCalledWith('game-1', 0);
    });

    it('should do nothing for completed games', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ status: 'completed', current_player_index: 0 }], command: '', rowCount: 1, oid: 0, fields: [] });

      await advanceTurnAfterBot('game-1');

      expect(PlayerService.updateCurrentPlayerIndex).not.toHaveBeenCalled();
    });

    it('should do nothing for abandoned games', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ status: 'abandoned', current_player_index: 0 }], command: '', rowCount: 1, oid: 0, fields: [] });

      await advanceTurnAfterBot('game-1');

      expect(PlayerService.updateCurrentPlayerIndex).not.toHaveBeenCalled();
    });

    it('should call InitialBuildService.advanceTurn for initialBuild games', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ status: 'initialBuild', current_player_index: 0 }], command: '', rowCount: 1, oid: 0, fields: [] });

      await advanceTurnAfterBot('game-1');

      expect(InitialBuildService.advanceTurn).toHaveBeenCalledWith('game-1', 0);
    });
  });
});
