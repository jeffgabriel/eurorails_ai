import { AIStrategyEngine } from '../services/ai/AIStrategyEngine';
import { AIActionType } from '../../shared/types/AITypes';
import type { WorldSnapshot, FeasibleOption, TurnPlan } from '../../shared/types/AITypes';
import { TrainType } from '../../shared/types/GameTypes';
import { LoadType } from '../../shared/types/LoadTypes';

// --- Mocks ---

const mockDbQuery = jest.fn();
jest.mock('../../server/db/index', () => ({
  db: { query: (...args: unknown[]) => mockDbQuery(...args) },
}));

const mockEmitToGame = jest.fn();
jest.mock('../services/socketService', () => ({
  emitToGame: (...args: unknown[]) => mockEmitToGame(...args),
}));

const mockCapture = jest.fn();
jest.mock('../services/ai/WorldSnapshotService', () => ({
  WorldSnapshotService: {
    capture: (...args: unknown[]) => mockCapture(...args),
  },
}));

const mockGenerate = jest.fn();
jest.mock('../services/ai/OptionGenerator', () => ({
  OptionGenerator: {
    generate: (...args: unknown[]) => mockGenerate(...args),
  },
}));

const mockScore = jest.fn();
const mockSelectBest = jest.fn();
jest.mock('../services/ai/Scorer', () => ({
  Scorer: {
    score: (...args: unknown[]) => mockScore(...args),
    selectBest: (...args: unknown[]) => mockSelectBest(...args),
  },
}));

const mockValidate = jest.fn();
jest.mock('../services/ai/PlanValidator', () => ({
  PlanValidator: {
    validate: (...args: unknown[]) => mockValidate(...args),
  },
}));

const mockExecute = jest.fn();
jest.mock('../services/ai/TurnExecutor', () => ({
  TurnExecutor: {
    execute: (...args: unknown[]) => mockExecute(...args),
  },
}));

jest.mock('../services/ai/config/skillProfiles', () => ({
  getSkillProfile: () => ({
    difficulty: 'hard',
    weights: {
      immediateIncome: 0.8, incomePerMilepost: 0.9, multiDeliveryPotential: 0.7,
      networkExpansionValue: 0.6, victoryProgress: 0.8, competitorBlocking: 0.5,
      riskEventExposure: 0.4, loadScarcity: 0.5,
    },
    behavior: { randomChoiceProbability: 0, missedOptionProbability: 0 },
  }),
}));

jest.mock('../services/ai/config/archetypeProfiles', () => ({
  getArchetypeProfile: () => ({
    name: 'opportunist',
    multipliers: {
      immediateIncome: 1.3, incomePerMilepost: 1.2, multiDeliveryPotential: 0.6,
      networkExpansionValue: 0.5, victoryProgress: 0.7, competitorBlocking: 1.3,
      riskEventExposure: 1.2, loadScarcity: 1.5, upgradeRoi: 0.7,
      backboneAlignment: 0.3, loadCombinationScore: 1.0, majorCityProximity: 0.5,
    },
  }),
}));

// --- Helpers ---

function makeMinimalSnapshot(): WorldSnapshot {
  return {
    botPlayerId: 'bot-1',
    botPosition: { x: 0, y: 0, row: 10, col: 15 },
    trackNetworkGraph: new Map(),
    cash: 100,
    demandCards: [],
    carriedLoads: [],
    trainType: TrainType.Freight,
    otherPlayers: [],
    globalLoadAvailability: [],
    activeEvents: [],
    mapTopology: [],
    majorCityConnectionStatus: new Map(),
    turnNumber: 5,
    snapshotHash: 'test-hash',
  } as unknown as WorldSnapshot;
}

function makeOption(type: AIActionType, id: string, params: Record<string, unknown> = {}): FeasibleOption {
  return { id, type, parameters: params, score: 0, feasible: true, rejectionReason: null };
}

function makeScoredOption(type: AIActionType, id: string, finalScore: number, params: Record<string, unknown> = {}) {
  return { ...makeOption(type, id, params), finalScore, dimensionScores: {} };
}

// --- Tests ---

describe('AIStrategyEngine', () => {
  beforeEach(() => {
    jest.clearAllMocks();

    // Default bot config from DB
    mockDbQuery.mockImplementation((sql: string) => {
      if (typeof sql === 'string' && sql.includes('FROM players')) {
        return {
          rows: [{ ai_difficulty: 'hard', ai_archetype: 'opportunist', current_turn_number: 5 }],
        };
      }
      // For audit INSERT
      return { rows: [] };
    });

    // Default snapshot
    mockCapture.mockResolvedValue(makeMinimalSnapshot());
  });

  describe('successful turn', () => {
    it('executes the full pipeline: snapshot → options → score → validate → execute', async () => {
      const options = [
        makeOption(AIActionType.DeliverLoad, 'opt-1', { payment: 30 }),
        makeOption(AIActionType.PassTurn, 'opt-2'),
      ];
      mockGenerate.mockReturnValue(options);

      const scored = [
        makeScoredOption(AIActionType.DeliverLoad, 'opt-1', 80, { payment: 30 }),
        makeScoredOption(AIActionType.PassTurn, 'opt-2', 0),
      ];
      mockScore.mockReturnValue(scored);
      mockSelectBest.mockReturnValue(scored[0]);

      mockValidate.mockReturnValue({ ok: true, reason: null });
      mockExecute.mockResolvedValue({
        success: true,
        actionResults: [{ actionType: AIActionType.DeliverLoad, success: true, durationMs: 50 }],
        totalDurationMs: 100,
      });

      const audit = await AIStrategyEngine.executeTurn('game-1', 'bot-1');

      // Pipeline was called in order
      expect(mockCapture).toHaveBeenCalledWith('game-1', 'bot-1');
      expect(mockGenerate).toHaveBeenCalled();
      expect(mockScore).toHaveBeenCalled();
      expect(mockSelectBest).toHaveBeenCalled();
      expect(mockValidate).toHaveBeenCalled();
      expect(mockExecute).toHaveBeenCalled();

      // Audit is populated
      expect(audit.snapshotHash).toBe('test-hash');
      expect(audit.allOptions).toEqual(options);
      expect(audit.scores).toEqual([80, 0]);
      expect(audit.selectedPlan).toBeDefined();
      expect(audit.selectedPlan.actions[0].type).toBe(AIActionType.DeliverLoad);
      expect(audit.executionResults).toHaveLength(1);
      expect(audit.timing.totalMs).toBeGreaterThanOrEqual(0);
    });

    it('logs audit to ai_turn_audits table', async () => {
      mockGenerate.mockReturnValue([makeOption(AIActionType.PassTurn, 'opt-1')]);
      mockScore.mockReturnValue([makeScoredOption(AIActionType.PassTurn, 'opt-1', 0)]);
      mockSelectBest.mockReturnValue(makeScoredOption(AIActionType.PassTurn, 'opt-1', 0));
      mockValidate.mockReturnValue({ ok: true, reason: null });
      mockExecute.mockResolvedValue({
        success: true,
        actionResults: [{ actionType: AIActionType.PassTurn, success: true, durationMs: 1 }],
        totalDurationMs: 10,
      });

      await AIStrategyEngine.executeTurn('game-1', 'bot-1');

      // Check that INSERT INTO ai_turn_audits was called
      const auditInsertCalls = mockDbQuery.mock.calls.filter(
        (c: unknown[]) => typeof c[0] === 'string' && (c[0] as string).includes('ai_turn_audits'),
      );
      expect(auditInsertCalls.length).toBe(1);
      const params = auditInsertCalls[0][1] as unknown[];
      expect(params[0]).toBe('game-1'); // gameId
      expect(params[1]).toBe('bot-1'); // playerId
      expect(params[2]).toBe(5); // turnNumber
      expect(params[8]).toBe('success'); // execution_result
    });
  });

  describe('retry logic', () => {
    it('retries when plan validation fails', async () => {
      const options = [
        makeOption(AIActionType.DeliverLoad, 'opt-1', { payment: 40 }),
        makeOption(AIActionType.BuildTrack, 'opt-2'),
        makeOption(AIActionType.PassTurn, 'opt-3'),
      ];
      mockGenerate.mockReturnValue(options);

      const scored = [
        makeScoredOption(AIActionType.DeliverLoad, 'opt-1', 80, { payment: 40 }),
        makeScoredOption(AIActionType.BuildTrack, 'opt-2', 50),
        makeScoredOption(AIActionType.PassTurn, 'opt-3', 0),
      ];
      mockScore.mockReturnValue(scored);

      // First call returns opt-1 (best), second returns opt-2 (next best)
      let selectBestCallCount = 0;
      mockSelectBest.mockImplementation((scoredOptions: unknown[]) => {
        selectBestCallCount++;
        if (Array.isArray(scoredOptions) && scoredOptions.length > 0) {
          return scoredOptions[0]; // Return best available
        }
        return null;
      });

      // First validation fails, second succeeds
      let validateCallCount = 0;
      mockValidate.mockImplementation(() => {
        validateCallCount++;
        if (validateCallCount === 1) {
          return { ok: false, reason: 'Load not available' };
        }
        return { ok: true, reason: null };
      });

      mockExecute.mockResolvedValue({
        success: true,
        actionResults: [{ actionType: AIActionType.BuildTrack, success: true, durationMs: 50 }],
        totalDurationMs: 100,
      });

      const audit = await AIStrategyEngine.executeTurn('game-1', 'bot-1');

      // Validation called twice (first fail, second success)
      expect(mockValidate).toHaveBeenCalledTimes(2);
      // Execution called once (after second plan validates)
      expect(mockExecute).toHaveBeenCalledTimes(1);
    });

    it('retries when execution fails', async () => {
      const options = [
        makeOption(AIActionType.DeliverLoad, 'opt-1', { payment: 40 }),
        makeOption(AIActionType.BuildTrack, 'opt-2'),
        makeOption(AIActionType.PassTurn, 'opt-3'),
      ];
      mockGenerate.mockReturnValue(options);

      const scored = [
        makeScoredOption(AIActionType.DeliverLoad, 'opt-1', 80, { payment: 40 }),
        makeScoredOption(AIActionType.BuildTrack, 'opt-2', 50),
        makeScoredOption(AIActionType.PassTurn, 'opt-3', 0),
      ];
      mockScore.mockReturnValue(scored);

      let selectCallCount = 0;
      mockSelectBest.mockImplementation((s: unknown[]) => {
        selectCallCount++;
        return Array.isArray(s) && s.length > 0 ? s[0] : null;
      });

      mockValidate.mockReturnValue({ ok: true, reason: null });

      // First execution fails, second succeeds
      let execCallCount = 0;
      mockExecute.mockImplementation(() => {
        execCallCount++;
        if (execCallCount === 1) {
          return { success: false, actionResults: [], error: 'DB error', totalDurationMs: 50 };
        }
        return {
          success: true,
          actionResults: [{ actionType: AIActionType.BuildTrack, success: true, durationMs: 50 }],
          totalDurationMs: 100,
        };
      });

      const audit = await AIStrategyEngine.executeTurn('game-1', 'bot-1');

      expect(mockExecute).toHaveBeenCalledTimes(2);
      // Audit should record success (from retry)
      expect(audit.executionResults.length).toBeGreaterThan(0);
    });
  });

  describe('safe fallback', () => {
    it('falls back to PassTurn when all retries exhausted', async () => {
      mockGenerate.mockReturnValue([
        makeOption(AIActionType.DeliverLoad, 'opt-1', { payment: 40 }),
        makeOption(AIActionType.BuildTrack, 'opt-2'),
        makeOption(AIActionType.PassTurn, 'opt-3'),
      ]);

      const scored = [
        makeScoredOption(AIActionType.DeliverLoad, 'opt-1', 80),
        makeScoredOption(AIActionType.BuildTrack, 'opt-2', 50),
        makeScoredOption(AIActionType.PassTurn, 'opt-3', 0),
      ];
      mockScore.mockReturnValue(scored);

      let selectCallCount = 0;
      mockSelectBest.mockImplementation((s: unknown[]) => {
        selectCallCount++;
        return Array.isArray(s) && s.length > 0 ? s[0] : null;
      });

      // All validations fail
      mockValidate.mockReturnValue({ ok: false, reason: 'Always fails' });

      // Fallback execution succeeds
      mockExecute.mockResolvedValue({
        success: true,
        actionResults: [{ actionType: AIActionType.PassTurn, success: true, durationMs: 1 }],
        totalDurationMs: 5,
      });

      const audit = await AIStrategyEngine.executeTurn('game-1', 'bot-1');

      // Should have tried 3 times, then fallback
      expect(mockValidate).toHaveBeenCalledTimes(3);
      // Execution called once for the fallback PassTurn
      expect(mockExecute).toHaveBeenCalledTimes(1);

      // Selected plan should be the fallback PassTurn
      expect(audit.selectedPlan.actions[0].type).toBe(AIActionType.PassTurn);

      // Audit logged with 'fallback' result
      const auditCalls = mockDbQuery.mock.calls.filter(
        (c: unknown[]) => typeof c[0] === 'string' && (c[0] as string).includes('ai_turn_audits'),
      );
      expect(auditCalls.length).toBe(1);
      expect((auditCalls[0][1] as unknown[])[8]).toBe('fallback');
    });

    it('falls back when no feasible options exist', async () => {
      mockGenerate.mockReturnValue([
        { ...makeOption(AIActionType.DeliverLoad, 'opt-1'), feasible: false, rejectionReason: 'no path' },
      ]);
      mockScore.mockReturnValue([]); // No feasible options to score
      mockSelectBest.mockReturnValue(null); // Nothing to select

      mockValidate.mockReturnValue({ ok: true, reason: null });
      mockExecute.mockResolvedValue({
        success: true,
        actionResults: [{ actionType: AIActionType.PassTurn, success: true, durationMs: 1 }],
        totalDurationMs: 5,
      });

      const audit = await AIStrategyEngine.executeTurn('game-1', 'bot-1');

      expect(audit.selectedPlan.actions[0].type).toBe(AIActionType.PassTurn);
    });
  });

  describe('socket events', () => {
    it('emits ai:thinking at start', async () => {
      mockGenerate.mockReturnValue([makeOption(AIActionType.PassTurn, 'opt-1')]);
      mockScore.mockReturnValue([makeScoredOption(AIActionType.PassTurn, 'opt-1', 0)]);
      mockSelectBest.mockReturnValue(makeScoredOption(AIActionType.PassTurn, 'opt-1', 0));
      mockValidate.mockReturnValue({ ok: true, reason: null });
      mockExecute.mockResolvedValue({
        success: true,
        actionResults: [{ actionType: AIActionType.PassTurn, success: true, durationMs: 1 }],
        totalDurationMs: 5,
      });

      await AIStrategyEngine.executeTurn('game-1', 'bot-1');

      const thinkingCalls = mockEmitToGame.mock.calls.filter(
        (c: unknown[]) => c[1] === 'ai:thinking',
      );
      expect(thinkingCalls.length).toBe(1);
      expect(thinkingCalls[0][2]).toMatchObject({ playerId: 'bot-1' });
    });

    it('emits ai:turn-complete at end', async () => {
      mockGenerate.mockReturnValue([makeOption(AIActionType.PassTurn, 'opt-1')]);
      mockScore.mockReturnValue([makeScoredOption(AIActionType.PassTurn, 'opt-1', 0)]);
      mockSelectBest.mockReturnValue(makeScoredOption(AIActionType.PassTurn, 'opt-1', 0));
      mockValidate.mockReturnValue({ ok: true, reason: null });
      mockExecute.mockResolvedValue({
        success: true,
        actionResults: [{ actionType: AIActionType.PassTurn, success: true, durationMs: 1 }],
        totalDurationMs: 5,
      });

      await AIStrategyEngine.executeTurn('game-1', 'bot-1');

      const completeCalls = mockEmitToGame.mock.calls.filter(
        (c: unknown[]) => c[1] === 'ai:turn-complete',
      );
      expect(completeCalls.length).toBe(1);
      expect(completeCalls[0][2]).toMatchObject({
        playerId: 'bot-1',
        result: 'success',
      });
    });
  });

  describe('error handling', () => {
    it('throws if bot player not found in DB', async () => {
      mockDbQuery.mockResolvedValue({ rows: [] });

      await expect(
        AIStrategyEngine.executeTurn('game-1', 'nonexistent'),
      ).rejects.toThrow('AI player nonexistent not found');
    });

    it('does not throw if audit logging fails', async () => {
      mockGenerate.mockReturnValue([makeOption(AIActionType.PassTurn, 'opt-1')]);
      mockScore.mockReturnValue([makeScoredOption(AIActionType.PassTurn, 'opt-1', 0)]);
      mockSelectBest.mockReturnValue(makeScoredOption(AIActionType.PassTurn, 'opt-1', 0));
      mockValidate.mockReturnValue({ ok: true, reason: null });
      mockExecute.mockResolvedValue({
        success: true,
        actionResults: [{ actionType: AIActionType.PassTurn, success: true, durationMs: 1 }],
        totalDurationMs: 5,
      });

      // Bot config succeeds, audit INSERT fails
      let queryCallCount = 0;
      mockDbQuery.mockImplementation((sql: string) => {
        queryCallCount++;
        if (typeof sql === 'string' && sql.includes('FROM players')) {
          return { rows: [{ ai_difficulty: 'hard', ai_archetype: 'opportunist', current_turn_number: 5 }] };
        }
        if (typeof sql === 'string' && sql.includes('ai_turn_audits')) {
          throw new Error('DB connection failed');
        }
        return { rows: [] };
      });

      // Should not throw despite audit logging failure
      const audit = await AIStrategyEngine.executeTurn('game-1', 'bot-1');
      expect(audit.snapshotHash).toBe('test-hash');
    });
  });

  describe('audit structure', () => {
    it('captures timing for all pipeline stages', async () => {
      mockGenerate.mockReturnValue([makeOption(AIActionType.PassTurn, 'opt-1')]);
      mockScore.mockReturnValue([makeScoredOption(AIActionType.PassTurn, 'opt-1', 0)]);
      mockSelectBest.mockReturnValue(makeScoredOption(AIActionType.PassTurn, 'opt-1', 0));
      mockValidate.mockReturnValue({ ok: true, reason: null });
      mockExecute.mockResolvedValue({
        success: true,
        actionResults: [{ actionType: AIActionType.PassTurn, success: true, durationMs: 1 }],
        totalDurationMs: 5,
      });

      const audit = await AIStrategyEngine.executeTurn('game-1', 'bot-1');

      expect(audit.timing).toBeDefined();
      expect(typeof audit.timing.snapshotMs).toBe('number');
      expect(typeof audit.timing.optionGenerationMs).toBe('number');
      expect(typeof audit.timing.scoringMs).toBe('number');
      expect(typeof audit.timing.executionMs).toBe('number');
      expect(typeof audit.timing.totalMs).toBe('number');
    });
  });
});
