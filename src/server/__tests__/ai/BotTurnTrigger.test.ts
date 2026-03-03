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

// ── Imports (after mocks) ─────────────────────────────────────────────────

import { onTurnChange, pendingBotTurns } from '../../services/ai/BotTurnTrigger';
import { AIStrategyEngine } from '../../services/ai/AIStrategyEngine';
import { db } from '../../db/index';
import { emitToGame } from '../../services/socketService';
import { AIActionType } from '../../../shared/types/GameTypes';

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
