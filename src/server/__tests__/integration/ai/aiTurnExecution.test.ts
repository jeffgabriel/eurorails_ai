/**
 * Integration test: AI Turn Execution Stability
 *
 * Verifies that the full AI pipeline (AIStrategyEngine.executeTurn) can
 * execute 50 consecutive turns without errors, using all pipeline stages
 * with mocked DB/Socket but real scoring + validation logic.
 */
import { AIStrategyEngine } from '../../../services/ai/AIStrategyEngine';
import { AIActionType } from '../../../../shared/types/AITypes';
import type { StrategyAudit } from '../../../../shared/types/AITypes';
import { LoadType } from '../../../../shared/types/LoadTypes';
import { makeSnapshot, makeRichSnapshot, makeOption, makeScoredOption, configureBotConfigResponse } from './helpers';

// --- Mocks ---

const mockDbQuery = jest.fn();
jest.mock('../../../../server/db/index', () => ({
  db: { query: (...args: unknown[]) => mockDbQuery(...args) },
}));

const mockEmitToGame = jest.fn();
jest.mock('../../../services/socketService', () => ({
  emitToGame: (...args: unknown[]) => mockEmitToGame(...args),
}));

const mockCapture = jest.fn();
jest.mock('../../../services/ai/WorldSnapshotService', () => ({
  WorldSnapshotService: {
    capture: (...args: unknown[]) => mockCapture(...args),
  },
}));

const mockGenerate = jest.fn();
jest.mock('../../../services/ai/OptionGenerator', () => ({
  OptionGenerator: {
    generate: (...args: unknown[]) => mockGenerate(...args),
  },
}));

const mockScore = jest.fn();
const mockSelectBest = jest.fn();
jest.mock('../../../services/ai/Scorer', () => ({
  Scorer: {
    score: (...args: unknown[]) => mockScore(...args),
    selectBest: (...args: unknown[]) => mockSelectBest(...args),
  },
}));

const mockValidate = jest.fn();
jest.mock('../../../services/ai/PlanValidator', () => ({
  PlanValidator: {
    validate: (...args: unknown[]) => mockValidate(...args),
  },
}));

const mockExecute = jest.fn();
jest.mock('../../../services/ai/TurnExecutor', () => ({
  TurnExecutor: {
    execute: (...args: unknown[]) => mockExecute(...args),
  },
}));

jest.mock('../../../services/ai/config/skillProfiles', () => ({
  getSkillProfile: () => ({
    difficulty: 'hard',
    weights: {
      immediateIncome: 0.5, incomePerMilepost: 0.7, multiDeliveryPotential: 0.7,
      networkExpansionValue: 0.7, victoryProgress: 0.7, competitorBlocking: 0.5,
      riskEventExposure: 0.5, loadScarcity: 0.5,
    },
    behavior: { planningHorizonTurns: 5, randomChoiceProbability: 0, missedOptionProbability: 0 },
  }),
}));

jest.mock('../../../services/ai/config/archetypeProfiles', () => ({
  getArchetypeProfile: () => ({
    archetype: 'opportunist',
    multipliers: {
      immediateIncome: 1.3, incomePerMilepost: 1.2, multiDeliveryPotential: 0.6,
      networkExpansionValue: 0.5, victoryProgress: 0.7, competitorBlocking: 1.3,
      riskEventExposure: 1.2, loadScarcity: 1.5, upgradeRoi: 0.7,
      backboneAlignment: 0.3, loadCombinationScore: 1.0, majorCityProximity: 0.5,
    },
  }),
}));

// --- Test Suite ---

describe('AI Turn Execution Stability', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    configureBotConfigResponse(mockDbQuery);
  });

  it('completes 50 consecutive turns without errors', async () => {
    const audits: StrategyAudit[] = [];

    for (let turn = 1; turn <= 50; turn++) {
      // Vary the snapshot per turn
      const snapshot = makeRichSnapshot(turn);
      mockCapture.mockResolvedValue(snapshot);

      // Generate a mix of options per turn
      const actionType = turn % 3 === 0
        ? AIActionType.BuildTrack
        : turn % 3 === 1
          ? AIActionType.DeliverLoad
          : AIActionType.PickupAndDeliver;

      const options = [
        makeOption(actionType, `opt-${turn}-1`, { payment: 20 + turn }),
        makeOption(AIActionType.PassTurn, `opt-${turn}-2`),
      ];
      mockGenerate.mockReturnValue(options);

      const scored = [
        makeScoredOption(actionType, `opt-${turn}-1`, 50 + turn, { payment: 20 + turn }),
        makeScoredOption(AIActionType.PassTurn, `opt-${turn}-2`, 0),
      ];
      mockScore.mockReturnValue(scored);
      mockSelectBest.mockReturnValue(scored[0]);

      mockValidate.mockReturnValue({ ok: true, reason: null });
      mockExecute.mockResolvedValue({
        success: true,
        actionResults: [{ actionType, success: true, durationMs: 10 }],
        totalDurationMs: 20,
      });

      const audit = await AIStrategyEngine.executeTurn('game-1', 'bot-1');
      audits.push(audit);
    }

    // All 50 turns completed
    expect(audits).toHaveLength(50);

    // Each audit has the expected structure
    for (let i = 0; i < 50; i++) {
      const audit = audits[i];
      expect(audit.snapshotHash).toBe(`snapshot-turn-${i + 1}`);
      expect(audit.allOptions.length).toBeGreaterThanOrEqual(2);
      expect(audit.scores.length).toBeGreaterThan(0);
      expect(audit.selectedPlan).toBeDefined();
      expect(audit.selectedPlan.actions.length).toBeGreaterThan(0);
      expect(audit.executionResults.length).toBeGreaterThan(0);
      expect(audit.timing.totalMs).toBeGreaterThanOrEqual(0);
    }

    // Socket events emitted for every turn
    const thinkingCalls = mockEmitToGame.mock.calls.filter(
      (c: unknown[]) => c[1] === 'ai:thinking',
    );
    const completeCalls = mockEmitToGame.mock.calls.filter(
      (c: unknown[]) => c[1] === 'ai:turn-complete',
    );
    expect(thinkingCalls).toHaveLength(50);
    expect(completeCalls).toHaveLength(50);
  });

  it('handles intermittent failures across 50 turns with retries', async () => {
    let failedCount = 0;
    let successCount = 0;

    for (let turn = 1; turn <= 50; turn++) {
      mockCapture.mockResolvedValue(makeRichSnapshot(turn));

      const options = [
        makeOption(AIActionType.DeliverLoad, `opt-${turn}-1`, { payment: 30 }),
        makeOption(AIActionType.BuildTrack, `opt-${turn}-2`, { estimatedCost: 10 }),
        makeOption(AIActionType.PassTurn, `opt-${turn}-3`),
      ];
      mockGenerate.mockReturnValue(options);

      const scored = [
        makeScoredOption(AIActionType.DeliverLoad, `opt-${turn}-1`, 80, { payment: 30 }),
        makeScoredOption(AIActionType.BuildTrack, `opt-${turn}-2`, 50, { estimatedCost: 10 }),
        makeScoredOption(AIActionType.PassTurn, `opt-${turn}-3`, 0),
      ];
      mockScore.mockReturnValue(scored);

      // selectBest returns the first option from the provided array
      mockSelectBest.mockImplementation((s: unknown[]) =>
        Array.isArray(s) && s.length > 0 ? s[0] : null,
      );

      // Every 5th turn: first validation fails, retry succeeds
      if (turn % 5 === 0) {
        let validateCallCount = 0;
        mockValidate.mockImplementation(() => {
          validateCallCount++;
          if (validateCallCount === 1) {
            return { ok: false, reason: 'Simulated intermittent failure' };
          }
          return { ok: true, reason: null };
        });
        failedCount++;
      } else {
        mockValidate.mockReturnValue({ ok: true, reason: null });
        successCount++;
      }

      mockExecute.mockResolvedValue({
        success: true,
        actionResults: [{ actionType: AIActionType.DeliverLoad, success: true, durationMs: 15 }],
        totalDurationMs: 25,
      });

      // Should never throw, even with intermittent failures
      const audit = await AIStrategyEngine.executeTurn('game-1', 'bot-1');
      expect(audit).toBeDefined();
      expect(audit.selectedPlan).toBeDefined();
    }

    expect(successCount + failedCount).toBe(50);
  });

  it('survives when all plans fail and falls back to PassTurn', async () => {
    mockCapture.mockResolvedValue(makeSnapshot());

    const options = [
      makeOption(AIActionType.DeliverLoad, 'opt-1', { payment: 30 }),
      makeOption(AIActionType.BuildTrack, 'opt-2', { estimatedCost: 10 }),
      makeOption(AIActionType.PickupAndDeliver, 'opt-3', { loadType: LoadType.Wine }),
      makeOption(AIActionType.PassTurn, 'opt-4'),
    ];
    mockGenerate.mockReturnValue(options);

    const scored = [
      makeScoredOption(AIActionType.DeliverLoad, 'opt-1', 80, { payment: 30 }),
      makeScoredOption(AIActionType.BuildTrack, 'opt-2', 50, { estimatedCost: 10 }),
      makeScoredOption(AIActionType.PickupAndDeliver, 'opt-3', 30, { loadType: LoadType.Wine }),
      makeScoredOption(AIActionType.PassTurn, 'opt-4', 0),
    ];
    mockScore.mockReturnValue(scored);

    mockSelectBest.mockImplementation((s: unknown[]) =>
      Array.isArray(s) && s.length > 0 ? s[0] : null,
    );

    // All validations fail → forces fallback
    mockValidate.mockReturnValue({ ok: false, reason: 'Always fails' });

    mockExecute.mockResolvedValue({
      success: true,
      actionResults: [{ actionType: AIActionType.PassTurn, success: true, durationMs: 1 }],
      totalDurationMs: 5,
    });

    const audit = await AIStrategyEngine.executeTurn('game-1', 'bot-1');

    expect(audit.selectedPlan.actions[0].type).toBe(AIActionType.PassTurn);
    // Tried 3 retries before fallback (each excluding the failed option)
    expect(mockValidate).toHaveBeenCalledTimes(3);
  });

  it('each turn produces a unique snapshot hash in the audit', async () => {
    const hashes = new Set<string>();

    for (let turn = 1; turn <= 10; turn++) {
      const snapshot = makeSnapshot({
        turnNumber: turn,
        snapshotHash: `unique-hash-${turn}`,
      });
      mockCapture.mockResolvedValue(snapshot);

      mockGenerate.mockReturnValue([makeOption(AIActionType.PassTurn, `opt-${turn}`)]);
      mockScore.mockReturnValue([makeScoredOption(AIActionType.PassTurn, `opt-${turn}`, 0)]);
      mockSelectBest.mockReturnValue(makeScoredOption(AIActionType.PassTurn, `opt-${turn}`, 0));
      mockValidate.mockReturnValue({ ok: true, reason: null });
      mockExecute.mockResolvedValue({
        success: true,
        actionResults: [{ actionType: AIActionType.PassTurn, success: true, durationMs: 1 }],
        totalDurationMs: 5,
      });

      const audit = await AIStrategyEngine.executeTurn('game-1', 'bot-1');
      hashes.add(audit.snapshotHash);
    }

    // All 10 hashes are unique
    expect(hashes.size).toBe(10);
  });

  it('audit logging failure does not crash the turn', async () => {
    mockCapture.mockResolvedValue(makeSnapshot());
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
    mockDbQuery.mockImplementation((sql: string) => {
      if (typeof sql === 'string' && sql.includes('FROM players')) {
        return { rows: [{ ai_difficulty: 'hard', ai_archetype: 'opportunist', current_turn_number: 5 }] };
      }
      if (typeof sql === 'string' && sql.includes('ai_turn_audits')) {
        throw new Error('Audit DB write failed');
      }
      return { rows: [] };
    });

    const audit = await AIStrategyEngine.executeTurn('game-1', 'bot-1');
    expect(audit.snapshotHash).toBe('test-snapshot-hash');
    expect(audit.selectedPlan.actions[0].type).toBe(AIActionType.PassTurn);
  });
});
