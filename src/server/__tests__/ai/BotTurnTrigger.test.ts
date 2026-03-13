/**
 * BotTurnTrigger tests — JIRA-19
 *
 * Tests the best-effort persistence of LLM decision metadata
 * to the bot_turn_audits.details JSONB column.
 */

import { describe, it, expect, beforeEach, jest } from '@jest/globals';

// ── Mock external systems ─────────────────────────────────────────────────

jest.mock('../../db/index', () => ({
  db: {
    query: jest.fn<() => Promise<any>>(),
  },
}));

jest.mock('../../services/socketService', () => ({
  emitToGame: jest.fn<() => void>(),
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

import { onTurnChange, pendingBotTurns, checkBotVictory, queuedBotTurns, onHumanReconnect } from '../../services/ai/BotTurnTrigger';
import { AIStrategyEngine } from '../../services/ai/AIStrategyEngine';
import { db } from '../../db/index';
import { emitToGame, emitVictoryTriggered, emitGameOver } from '../../services/socketService';
import { AIActionType } from '../../../shared/types/GameTypes';
import { VictoryService } from '../../services/victoryService';
import { TrackService } from '../../services/trackService';
import { getConnectedMajorCities } from '../../services/ai/connectedMajorCities';

const mockQuery = db.query as unknown as jest.Mock<(...args: any[]) => Promise<any>>;
const mockTakeTurn = AIStrategyEngine.takeTurn as jest.MockedFunction<typeof AIStrategyEngine.takeTurn>;
const mockEmitToGame = emitToGame as jest.MockedFunction<typeof emitToGame>;

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

// ── JIRA-107: Chained bot turn queuing ──────────────────────────────────────

describe('BotTurnTrigger — chained bot turn queuing', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    pendingBotTurns.clear();
    queuedBotTurns.clear();
    process.env.ENABLE_AI_BOTS = 'true';
  });

  it('should queue a bot turn when pendingBotTurns guard is active', async () => {
    // Simulate another bot turn already in progress
    pendingBotTurns.add('game-1');

    mockQuery.mockImplementation(async (sql: string) => {
      if (typeof sql === 'string') {
        if (sql.includes('SELECT is_bot')) return mockResult([{ is_bot: true }]);
        if (sql.includes('SELECT status FROM games')) return mockResult([{ status: 'active' }]);
      }
      return mockResult([]);
    });

    await onTurnChange('game-1', 1, 'bot-2');

    // Turn should be queued, not dropped
    expect(queuedBotTurns.has('game-1')).toBe(true);
    const queued = queuedBotTurns.get('game-1');
    expect(queued?.currentPlayerId).toBe('bot-2');
    expect(queued?.currentPlayerIndex).toBe(1);

    // Clean up
    pendingBotTurns.delete('game-1');
    queuedBotTurns.clear();
  });
});

// ── Stuck bot detection on reconnect ────────────────────────────────────────

describe('BotTurnTrigger — stuck bot recovery on reconnect', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    pendingBotTurns.clear();
    queuedBotTurns.clear();
    process.env.ENABLE_AI_BOTS = 'true';

    mockQuery.mockImplementation(async (sql: string) => {
      if (typeof sql === 'string') {
        if (sql.includes('SELECT is_bot')) return mockResult([{ is_bot: true }]);
        if (sql.includes('SELECT status FROM games') || sql.includes('current_player_index'))
          return mockResult([{ status: 'active', current_player_index: 1 }]);
        if (sql.includes('SELECT id, is_bot, name FROM players'))
          return mockResult([{ id: 'bot-1', is_bot: true, name: 'Flash' }]);
        if (sql.includes('SELECT current_turn_number')) return mockResult([{ current_turn_number: 5 }]);
        if (sql.includes('UPDATE')) return mockResult([]);
        if (sql.includes('SELECT COUNT')) return mockResult([{ count: 3 }]);
      }
      return mockResult([]);
    });
  });

  it('should re-trigger bot turn on reconnect when bot is stuck', async () => {
    mockTakeTurn.mockResolvedValue({
      action: AIActionType.MoveTrain,
      segmentsBuilt: 0,
      cost: 0,
      durationMs: 100,
      success: true,
    } as any);

    // No queued turns, no pending turns — bot is stuck
    await onHumanReconnect('game-1');

    // Give the fire-and-forget onTurnChange time to start
    await new Promise(resolve => setTimeout(resolve, 2000));

    // The bot pipeline should have been triggered
    expect(mockTakeTurn).toHaveBeenCalledWith('game-1', 'bot-1');
  });

  it('should NOT re-trigger if a bot turn is already pending', async () => {
    pendingBotTurns.add('game-1');

    await onHumanReconnect('game-1');
    await new Promise(resolve => setTimeout(resolve, 100));

    expect(mockTakeTurn).not.toHaveBeenCalled();

    pendingBotTurns.delete('game-1');
  });

  it('should NOT re-trigger if current player is human', async () => {
    mockQuery.mockImplementation(async (sql: string) => {
      if (typeof sql === 'string') {
        if (sql.includes('SELECT status FROM games') || sql.includes('current_player_index'))
          return mockResult([{ status: 'active', current_player_index: 0 }]);
        if (sql.includes('SELECT id, is_bot, name FROM players'))
          return mockResult([{ id: 'human-1', is_bot: false, name: 'matt' }]);
      }
      return mockResult([]);
    });

    await onHumanReconnect('game-1');
    await new Promise(resolve => setTimeout(resolve, 100));

    expect(mockTakeTurn).not.toHaveBeenCalled();
  });
});
