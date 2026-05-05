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
import { appendTurn } from '../../services/ai/GameLogger';

const mockQuery = db.query as unknown as jest.Mock<(...args: any[]) => Promise<any>>;
const mockTakeTurn = AIStrategyEngine.takeTurn as jest.MockedFunction<typeof AIStrategyEngine.takeTurn>;
const mockEmitToGame = emitToGame as jest.MockedFunction<typeof emitToGame>;
const mockAppendTurn = appendTurn as jest.MockedFunction<typeof appendTurn>;

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
      // JIRA-143 P2 fields
      actor: 'llm',
      actorDetail: 'strategy-brain',
      llmModel: 'claude-sonnet-4-20250514',
      actionBreakdown: [
        { action: 'BuildTrack', actor: 'llm', detail: 'build-advisor' },
      ],
      llmCallIds: ['call-001', 'call-002'],
      llmSummary: {
        callCount: 2,
        totalLatencyMs: 1200,
        totalTokens: { input: 300, output: 100 },
        callers: ['strategy-brain', 'build-advisor'],
      },
      actionTimeline: [{ step: 1, action: 'BuildTrack', detail: 'build 3 segments' }],
      originalPlan: undefined,
      advisorUsedFallback: false,
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

  // ── JIRA-143 P2: New fields passed to appendTurn ────────────────────────

  it('should pass actor metadata fields to appendTurn (JIRA-143)', async () => {
    mockTakeTurn.mockResolvedValue(makeBotTurnResult() as any);

    await onTurnChange('game-1', 0, 'bot-1');

    expect(mockAppendTurn).toHaveBeenCalledWith(
      'game-1',
      expect.objectContaining({
        actor: 'llm',
        actorDetail: 'strategy-brain',
        llmModel: 'claude-sonnet-4-20250514',
        actionBreakdown: [{ action: 'BuildTrack', actor: 'llm', detail: 'build-advisor' }],
        llmCallIds: ['call-001', 'call-002'],
        llmSummary: expect.objectContaining({
          callCount: 2,
          callers: ['strategy-brain', 'build-advisor'],
        }),
        actionTimeline: [{ step: 1, action: 'BuildTrack', detail: 'build 3 segments' }],
        advisorUsedFallback: false,
      }),
    );
  });

  it('should pass originalPlan to appendTurn when guardrail overrides (JIRA-143)', async () => {
    mockTakeTurn.mockResolvedValue(makeBotTurnResult({
      guardrailOverride: true,
      guardrailReason: 'Safety override',
      originalPlan: { action: 'MoveTrain', reasoning: 'Original LLM plan' },
      actor: 'guardrail',
      actorDetail: 'guardrail-enforcer',
    }) as any);

    await onTurnChange('game-1', 0, 'bot-1');

    expect(mockAppendTurn).toHaveBeenCalledWith(
      'game-1',
      expect.objectContaining({
        actor: 'guardrail',
        actorDetail: 'guardrail-enforcer',
        originalPlan: { action: 'MoveTrain', reasoning: 'Original LLM plan' },
      }),
    );
  });

  it('should handle absent optional JIRA-143 fields gracefully in appendTurn', async () => {
    mockTakeTurn.mockResolvedValue(makeBotTurnResult({
      actor: 'system',
      actorDetail: 'route-executor',
      llmModel: undefined,
      actionBreakdown: undefined,
      llmCallIds: undefined,
      llmSummary: undefined,
      actionTimeline: undefined,
      originalPlan: undefined,
      advisorUsedFallback: undefined,
    }) as any);

    await onTurnChange('game-1', 0, 'bot-1');

    expect(mockAppendTurn).toHaveBeenCalledWith(
      'game-1',
      expect.objectContaining({
        actor: 'system',
        actorDetail: 'route-executor',
      }),
    );
    // Verify undefined fields are passed through (not causing errors)
    const appendCall = mockAppendTurn.mock.calls[0];
    expect(appendCall).toBeDefined();
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

    expect(result.outcome).toBe('declared');
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

    expect(result.outcome).toBe('insufficient-funds');
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

    expect(result.outcome).toBe('too-few-cities');
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

    expect(result.outcome).toBe('already-triggered');
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

    expect(result.outcome).toBe('insufficient-funds');
    expect(mockDeclareVictory).not.toHaveBeenCalled();
  });

  // ── AC1: New tests covering all eight outcomes ──────────────────────────

  it('returns outcome=no-player when player row is missing', async () => {
    mockGetVictoryState.mockResolvedValue({
      triggered: false,
      triggerPlayerIndex: -1,
      victoryThreshold: 250,
      finalTurnPlayerIndex: -1,
    });
    (db.query as any).mockImplementation(async (sql: string) => {
      if (sql.includes('SELECT money')) return { rows: [] };
      return { rows: [] };
    });

    const result = await checkBotVictory('game-1', 'bot-1');
    expect(result.outcome).toBe('no-player');
    expect(mockDeclareVictory).not.toHaveBeenCalled();
  });

  it('returns outcome=no-track when player has no track segments', async () => {
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
    mockGetTrackState.mockResolvedValue({ segments: [] } as any);

    const result = await checkBotVictory('game-1', 'bot-1');
    expect(result.outcome).toBe('no-track');
    expect(result.netWorth).toBe(300);
    expect(result.threshold).toBe(250);
    expect(mockDeclareVictory).not.toHaveBeenCalled();
  });

  it('returns outcome=too-few-cities with diagnostic fields', async () => {
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
    const fourCities = sevenCities.slice(0, 4);
    mockGetConnectedMajorCities.mockReturnValue(fourCities);

    const result = await checkBotVictory('game-1', 'bot-1');
    expect(result.outcome).toBe('too-few-cities');
    expect(result.netWorth).toBe(300);
    expect(result.threshold).toBe(250);
    expect(result.connectedCityCount).toBe(4);
    expect(result.connectedCityNames).toEqual(['London', 'Paris', 'Berlin', 'Madrid']);
    expect(mockDeclareVictory).not.toHaveBeenCalled();
  });

  it('returns outcome=declaration-rejected with rejectionReason when declareVictory fails', async () => {
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
    mockGetConnectedMajorCities.mockReturnValue(sevenCities);
    mockDeclareVictory.mockResolvedValue({
      success: false,
      error: 'Claimed city coordinates not found in track',
    });

    const result = await checkBotVictory('game-1', 'bot-1');
    expect(result.outcome).toBe('declaration-rejected');
    expect(result.rejectionReason).toBe('Claimed city coordinates not found in track');
    expect(result.connectedCityCount).toBe(7);
    expect(mockEmitVictoryTriggered).not.toHaveBeenCalled();
  });

  it('returns outcome=declared with full diagnostic fields on success', async () => {
    mockGetVictoryState.mockResolvedValue({
      triggered: false,
      triggerPlayerIndex: -1,
      victoryThreshold: 250,
      finalTurnPlayerIndex: -1,
    });
    (db.query as any).mockImplementation(async (sql: string) => {
      if (sql.includes('SELECT money')) return { rows: [{ money: 280, debt_owed: 0, name: 'Flash' }] };
      return { rows: [] };
    });
    mockGetTrackState.mockResolvedValue({ segments: [{ from: { row: 1, col: 1 }, to: { row: 1, col: 2 }, cost: 1 }] } as any);
    mockGetConnectedMajorCities.mockReturnValue(sevenCities);
    mockDeclareVictory.mockResolvedValue({
      success: true,
      victoryState: {
        triggered: true,
        triggerPlayerIndex: 0,
        victoryThreshold: 250,
        finalTurnPlayerIndex: 1,
      },
    });

    const result = await checkBotVictory('game-1', 'bot-1');
    expect(result.outcome).toBe('declared');
    expect(result.netWorth).toBe(280);
    expect(result.threshold).toBe(250);
    expect(result.connectedCityCount).toBe(7);
    expect(result.connectedCityNames).toHaveLength(7);
  });

  it('returns outcome=error when an underlying call throws', async () => {
    mockGetVictoryState.mockRejectedValue(new Error('DB connection lost'));

    const result = await checkBotVictory('game-1', 'bot-1');
    expect(result.outcome).toBe('error');
    expect(result.errorMessage).toBe('DB connection lost');
    expect(mockDeclareVictory).not.toHaveBeenCalled();
  });
});

// ── JIRA-212: victoryCheck threaded into appendTurn (AC2) ───────────────────

describe('BotTurnTrigger — JIRA-212: victoryCheck in appendTurn payload', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    pendingBotTurns.clear();
    process.env.ENABLE_AI_BOTS = 'true';

    mockIsFinalTurn.mockResolvedValue(false);
    mockResolveVictory.mockResolvedValue({ gameOver: false });

    mockQuery.mockImplementation(async (sql: string) => {
      if (typeof sql === 'string') {
        if (sql.includes('SELECT is_bot')) return mockResult([{ is_bot: true, name: 'Flash' }]);
        if (sql.includes('SELECT status FROM games') || sql.includes('status, current_player_index')) {
          return mockResult([{ status: 'active', current_player_index: 1 }]);
        }
        if (sql.includes('SELECT current_turn_number')) return mockResult([{ current_turn_number: 5 }]);
        if (sql.includes('UPDATE players SET current_turn_number')) return mockResult([]);
        if (sql.includes('UPDATE player_tracks')) return mockResult([]);
        if (sql.includes('UPDATE bot_turn_audits')) return mockResult([]);
        if (sql.includes('SELECT COUNT')) return mockResult([{ count: 2 }]);
        if (sql.includes('SELECT money')) return { rows: [{ money: 200, debt_owed: 0, name: 'Flash' }] };
      }
      return mockResult([]);
    });
  });

  it('threads victoryCheck result into appendTurn payload (AC2)', async () => {
    // Insufficient funds → outcome = 'insufficient-funds'
    mockGetVictoryState.mockResolvedValue({
      triggered: false,
      triggerPlayerIndex: -1,
      victoryThreshold: 250,
      finalTurnPlayerIndex: -1,
    });

    mockTakeTurn.mockResolvedValue({
      action: AIActionType.BuildTrack,
      segmentsBuilt: 1,
      cost: 3,
      durationMs: 500,
      success: true,
      actor: 'system',
      actorDetail: 'route-executor',
    } as any);

    await onTurnChange('game-1', 1, 'bot-1');

    expect(mockAppendTurn).toHaveBeenCalledWith(
      'game-1',
      expect.objectContaining({
        victoryCheck: expect.objectContaining({
          outcome: 'insufficient-funds',
        }),
      }),
    );
  });
});

// ── JIRA-212: Stalled-victory guard (AC3, AC4) ──────────────────────────────

describe('BotTurnTrigger — JIRA-212: stalled-victory backstop guard', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    pendingBotTurns.clear();
    process.env.ENABLE_AI_BOTS = 'true';

    mockIsFinalTurn.mockResolvedValue(false);
    mockResolveVictory.mockResolvedValue({ gameOver: false });
  });

  it('forces resolveVictory and skips takeTurn when victory is stalled (AC3)', async () => {
    const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    // current_player_index === triggerPlayerIndex (0) → stall detected
    mockQuery.mockImplementation(async (sql: string) => {
      if (typeof sql === 'string') {
        if (sql.includes('SELECT is_bot')) return mockResult([{ is_bot: true, name: 'Flash' }]);
        if (sql.includes('status, current_player_index') || sql.includes('SELECT status FROM games')) {
          return mockResult([{ status: 'active', current_player_index: 0 }]);
        }
      }
      return mockResult([]);
    });

    // Victory is triggered; trigger player = 0; final turn player = 1 (different)
    mockGetVictoryState.mockResolvedValue({
      triggered: true,
      triggerPlayerIndex: 0,
      victoryThreshold: 250,
      finalTurnPlayerIndex: 1,
    });

    mockResolveVictory.mockResolvedValue({
      gameOver: true,
      winnerId: 'bot-1',
      winnerName: 'Flash',
    });

    // currentPlayerIndex = 0 matches triggerPlayerIndex = 0 → stall
    await onTurnChange('game-1', 0, 'bot-1');

    // (a) takeTurn NOT called
    expect(mockTakeTurn).not.toHaveBeenCalled();
    // (b) resolveVictory IS called
    expect(mockResolveVictory).toHaveBeenCalledWith('game-1');
    // (c) console.error logged the stall message
    const stallLog = consoleErrorSpy.mock.calls.find(
      (call: any[]) => typeof call[0] === 'string' && call[0].includes('Stalled victory detected'),
    );
    expect(stallLog).toBeDefined();

    consoleErrorSpy.mockRestore();
  });

  it('emits gameOver after stall resolution when winner found', async () => {
    mockQuery.mockImplementation(async (sql: string) => {
      if (typeof sql === 'string') {
        if (sql.includes('SELECT is_bot')) return mockResult([{ is_bot: true, name: 'Flash' }]);
        if (sql.includes('status, current_player_index') || sql.includes('SELECT status FROM games')) {
          return mockResult([{ status: 'active', current_player_index: 0 }]);
        }
      }
      return mockResult([]);
    });

    mockGetVictoryState.mockResolvedValue({
      triggered: true,
      triggerPlayerIndex: 0,
      victoryThreshold: 250,
      finalTurnPlayerIndex: 1,
    });

    mockResolveVictory.mockResolvedValue({
      gameOver: true,
      winnerId: 'bot-1',
      winnerName: 'Flash',
    });

    await onTurnChange('game-1', 0, 'bot-1');

    expect(mockEmitGameOver).toHaveBeenCalledWith('game-1', 'bot-1', 'Flash');
  });

  it('does NOT fire stall guard when final-turn player has not yet taken their turn (AC4)', async () => {
    // triggerPlayerIndex = 1, finalTurnPlayerIndex = 0, current = 1 (same as trigger)
    // BUT: finalTurnIndex === triggerIndex is false, so...
    // Actually per the guard: fires when gameCurrentIndex === triggerIndex AND finalTurnIndex !== triggerIndex.
    // Here we test that when current player != triggerPlayerIndex, guard does NOT fire.
    mockQuery.mockImplementation(async (sql: string) => {
      if (typeof sql === 'string') {
        if (sql.includes('SELECT is_bot')) return mockResult([{ is_bot: true, name: 'Flash' }]);
        if (sql.includes('status, current_player_index') || sql.includes('SELECT status FROM games')) {
          // current_player_index = 0 (NOT trigger player 1)
          return mockResult([{ status: 'active', current_player_index: 0 }]);
        }
        if (sql.includes('SELECT current_turn_number')) return mockResult([{ current_turn_number: 5 }]);
        if (sql.includes('UPDATE players SET current_turn_number')) return mockResult([]);
        if (sql.includes('UPDATE player_tracks')) return mockResult([]);
        if (sql.includes('UPDATE bot_turn_audits')) return mockResult([]);
        if (sql.includes('SELECT COUNT')) return mockResult([{ count: 2 }]);
        if (sql.includes('SELECT money')) return { rows: [{ money: 200, debt_owed: 0, name: 'Flash' }] };
      }
      return mockResult([]);
    });

    // Victory triggered but current player (0) != triggerPlayerIndex (1) → guard does NOT fire
    mockGetVictoryState.mockResolvedValue({
      triggered: true,
      triggerPlayerIndex: 1,
      victoryThreshold: 250,
      finalTurnPlayerIndex: 0,
    });

    mockTakeTurn.mockResolvedValue({
      action: AIActionType.BuildTrack,
      segmentsBuilt: 1,
      cost: 3,
      durationMs: 500,
      success: true,
      actor: 'system',
      actorDetail: 'route-executor',
    } as any);

    // Should proceed normally (takeTurn called)
    await onTurnChange('game-1', 0, 'bot-1');

    expect(mockTakeTurn).toHaveBeenCalled();
    expect(mockResolveVictory).not.toHaveBeenCalled();
  });
});

// ── JIRA-107: Chained bot turn queuing ──────────────────────────────────────

describe('BotTurnTrigger — chained bot turn queuing', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    pendingBotTurns.clear();
    queuedBotTurns.clear();
    process.env.ENABLE_AI_BOTS = 'true';
    // Ensure JIRA-212 stall guard does not fire — no triggered victory state
    mockGetVictoryState.mockResolvedValue(null);
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
    // Ensure JIRA-212 stall guard does not fire — no triggered victory state
    mockGetVictoryState.mockResolvedValue(null);

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
