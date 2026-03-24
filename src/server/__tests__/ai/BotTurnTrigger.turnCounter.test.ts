/**
 * BotTurnTrigger turn counter integration test — JIRA-143 R1
 *
 * Verifies that the first bot turn in a new game logs as turn: 1,
 * not turn: 2 (the off-by-one bug fixed by COALESCE(null, 0) + 1).
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

import { onTurnChange, pendingBotTurns } from '../../services/ai/BotTurnTrigger';
import { AIStrategyEngine } from '../../services/ai/AIStrategyEngine';
import { db } from '../../db/index';
import { appendTurn } from '../../services/ai/GameLogger';
import { AIActionType } from '../../../shared/types/GameTypes';
import { VictoryService } from '../../services/victoryService';

const mockQuery = db.query as unknown as jest.Mock<(...args: any[]) => Promise<any>>;
const mockTakeTurn = AIStrategyEngine.takeTurn as jest.MockedFunction<typeof AIStrategyEngine.takeTurn>;
const mockAppendTurn = appendTurn as jest.MockedFunction<typeof appendTurn>;

function mockResult(rows: any[]) {
  return { rows, command: '', rowCount: rows.length, oid: 0, fields: [] };
}

describe('BotTurnTrigger — JIRA-143 R1: Turn counter starts at 1', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    pendingBotTurns.clear();
    process.env.ENABLE_AI_BOTS = 'true';
  });

  it('should log turn: 1 when current_turn_number is NULL (new game)', async () => {
    // Simulate a brand-new game where current_turn_number is NULL
    mockQuery.mockImplementation(async (sql: string) => {
      if (typeof sql === 'string') {
        if (sql.includes('SELECT is_bot')) return mockResult([{ is_bot: true }]);
        if (sql.includes('SELECT status FROM games')) return mockResult([{ status: 'active', current_player_index: 0 }]);
        if (sql.includes('SELECT current_turn_number')) return mockResult([{ current_turn_number: null }]);
        if (sql.includes('UPDATE players SET current_turn_number')) return mockResult([]);
        if (sql.includes('UPDATE player_tracks')) return mockResult([]);
        if (sql.includes('UPDATE bot_turn_audits')) return mockResult([]);
        if (sql.includes('SELECT COUNT')) return mockResult([{ count: 2 }]);
      }
      return mockResult([]);
    });

    mockTakeTurn.mockResolvedValue({
      action: AIActionType.BuildTrack,
      segmentsBuilt: 1,
      cost: 3,
      durationMs: 500,
      success: true,
    });

    (VictoryService.getVictoryState as jest.Mock).mockResolvedValue(null);
    (VictoryService.isFinalTurn as jest.Mock).mockResolvedValue(false);

    await onTurnChange('game-new', 'player-1', 'Bot 1');

    // The appendTurn call should have turn: 1 (COALESCE(null, 0) + 1 = 1)
    expect(mockAppendTurn).toHaveBeenCalledWith(
      'game-new',
      expect.objectContaining({
        turn: 1,
      }),
    );
  });

  it('should log turn: 6 when current_turn_number is 5 (subsequent turn)', async () => {
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

    mockTakeTurn.mockResolvedValue({
      action: AIActionType.MoveTrain,
      segmentsBuilt: 0,
      cost: 0,
      durationMs: 300,
      success: true,
    });

    (VictoryService.getVictoryState as jest.Mock).mockResolvedValue(null);
    (VictoryService.isFinalTurn as jest.Mock).mockResolvedValue(false);

    await onTurnChange('game-existing', 'player-1', 'Bot 1');

    // turn should be 5 + 1 = 6
    expect(mockAppendTurn).toHaveBeenCalledWith(
      'game-existing',
      expect.objectContaining({
        turn: 6,
      }),
    );
  });
});
