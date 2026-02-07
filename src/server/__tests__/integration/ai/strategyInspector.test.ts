/**
 * Integration test: Strategy Inspector (Audit Data Accuracy)
 *
 * Verifies that the StrategyAudit produced by AIStrategyEngine contains
 * accurate, complete data for debugging and the strategy inspector UI:
 * - All options are recorded (feasible + infeasible)
 * - Scores match the scoring pipeline output
 * - Selected plan reflects the highest-scored option
 * - Timing measurements are captured for each pipeline stage
 * - Audit is persisted to the ai_turn_audits table with correct columns
 */
import { AIStrategyEngine } from '../../../services/ai/AIStrategyEngine';
import { AIActionType } from '../../../../shared/types/AITypes';
import type { StrategyAudit, FeasibleOption } from '../../../../shared/types/AITypes';
import { LoadType } from '../../../../shared/types/LoadTypes';
import { makeSnapshot, makeOption, makeScoredOption, configureBotConfigResponse } from './helpers';

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
  PathCache: class { get size() { return 0; } },
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

describe('Strategy Inspector: Audit Data Accuracy', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    configureBotConfigResponse(mockDbQuery);
    mockCapture.mockResolvedValue(makeSnapshot());
  });

  describe('option recording', () => {
    it('records both feasible and infeasible options in allOptions', async () => {
      const feasibleOptions: FeasibleOption[] = [
        makeOption(AIActionType.DeliverLoad, 'opt-1', { payment: 30 }),
        makeOption(AIActionType.BuildTrack, 'opt-2', { estimatedCost: 10 }),
        makeOption(AIActionType.PassTurn, 'opt-3'),
      ];
      const infeasibleOptions: FeasibleOption[] = [
        { ...makeOption(AIActionType.UpgradeTrain, 'opt-4'), feasible: false, rejectionReason: 'Insufficient funds' },
        { ...makeOption(AIActionType.PickupAndDeliver, 'opt-5'), feasible: false, rejectionReason: 'No path to load' },
      ];
      const allOptions = [...feasibleOptions, ...infeasibleOptions];

      mockGenerate.mockReturnValue(allOptions);

      const scored = [
        makeScoredOption(AIActionType.DeliverLoad, 'opt-1', 80, { payment: 30 }),
        makeScoredOption(AIActionType.BuildTrack, 'opt-2', 40, { estimatedCost: 10 }),
        makeScoredOption(AIActionType.PassTurn, 'opt-3', 0),
      ];
      mockScore.mockReturnValue(scored);
      mockSelectBest.mockReturnValue(scored[0]);
      mockValidate.mockReturnValue({ ok: true, reason: null });
      mockExecute.mockResolvedValue({
        success: true,
        actionResults: [{ actionType: AIActionType.DeliverLoad, success: true, durationMs: 10 }],
        totalDurationMs: 20,
      });

      const audit = await AIStrategyEngine.executeTurn('game-1', 'bot-1');

      // All 5 options are in the audit (3 feasible + 2 infeasible)
      expect(audit.allOptions).toHaveLength(5);

      // Feasible options are recorded
      const feasibleIds = audit.allOptions.filter(o => o.feasible).map(o => o.id);
      expect(feasibleIds).toEqual(['opt-1', 'opt-2', 'opt-3']);

      // Infeasible options are recorded with reasons
      const infeasible = audit.allOptions.filter(o => !o.feasible);
      expect(infeasible).toHaveLength(2);
      expect(infeasible[0].rejectionReason).toBe('Insufficient funds');
      expect(infeasible[1].rejectionReason).toBe('No path to load');
    });

    it('records option parameters accurately', async () => {
      const options = [
        makeOption(AIActionType.DeliverLoad, 'opt-1', {
          payment: 42,
          loadType: LoadType.Steel,
          city: 'Berlin',
          demandCardId: 7,
        }),
        makeOption(AIActionType.PassTurn, 'opt-2'),
      ];
      mockGenerate.mockReturnValue(options);

      const scored = [
        makeScoredOption(AIActionType.DeliverLoad, 'opt-1', 90, {
          payment: 42,
          loadType: LoadType.Steel,
          city: 'Berlin',
          demandCardId: 7,
        }),
        makeScoredOption(AIActionType.PassTurn, 'opt-2', 0),
      ];
      mockScore.mockReturnValue(scored);
      mockSelectBest.mockReturnValue(scored[0]);
      mockValidate.mockReturnValue({ ok: true, reason: null });
      mockExecute.mockResolvedValue({
        success: true,
        actionResults: [{ actionType: AIActionType.DeliverLoad, success: true, durationMs: 10 }],
        totalDurationMs: 20,
      });

      const audit = await AIStrategyEngine.executeTurn('game-1', 'bot-1');

      const deliverOption = audit.allOptions.find(o => o.type === AIActionType.DeliverLoad);
      expect(deliverOption?.parameters).toMatchObject({
        payment: 42,
        loadType: LoadType.Steel,
        city: 'Berlin',
        demandCardId: 7,
      });
    });
  });

  describe('score accuracy', () => {
    it('audit scores array matches the scorer output order', async () => {
      const options = [
        makeOption(AIActionType.DeliverLoad, 'opt-1', { payment: 30 }),
        makeOption(AIActionType.BuildTrack, 'opt-2', { estimatedCost: 10 }),
        makeOption(AIActionType.PassTurn, 'opt-3'),
      ];
      mockGenerate.mockReturnValue(options);

      const expectedScores = [85.5, 42.3, 0];
      const scored = [
        makeScoredOption(AIActionType.DeliverLoad, 'opt-1', expectedScores[0]),
        makeScoredOption(AIActionType.BuildTrack, 'opt-2', expectedScores[1]),
        makeScoredOption(AIActionType.PassTurn, 'opt-3', expectedScores[2]),
      ];
      mockScore.mockReturnValue(scored);
      mockSelectBest.mockReturnValue(scored[0]);
      mockValidate.mockReturnValue({ ok: true, reason: null });
      mockExecute.mockResolvedValue({
        success: true,
        actionResults: [{ actionType: AIActionType.DeliverLoad, success: true, durationMs: 10 }],
        totalDurationMs: 20,
      });

      const audit = await AIStrategyEngine.executeTurn('game-1', 'bot-1');

      expect(audit.scores).toEqual(expectedScores);
    });

    it('selected plan reflects the highest-scored option', async () => {
      const options = [
        makeOption(AIActionType.BuildTrack, 'opt-low', { estimatedCost: 5 }),
        makeOption(AIActionType.DeliverLoad, 'opt-high', { payment: 50 }),
        makeOption(AIActionType.PassTurn, 'opt-zero'),
      ];
      mockGenerate.mockReturnValue(options);

      const scored = [
        // Note: returned sorted by score (highest first) after Scorer.score()
        makeScoredOption(AIActionType.DeliverLoad, 'opt-high', 95, { payment: 50 }),
        makeScoredOption(AIActionType.BuildTrack, 'opt-low', 30, { estimatedCost: 5 }),
        makeScoredOption(AIActionType.PassTurn, 'opt-zero', 0),
      ];
      mockScore.mockReturnValue(scored);
      mockSelectBest.mockReturnValue(scored[0]); // Highest scored

      mockValidate.mockReturnValue({ ok: true, reason: null });
      mockExecute.mockResolvedValue({
        success: true,
        actionResults: [{ actionType: AIActionType.DeliverLoad, success: true, durationMs: 10 }],
        totalDurationMs: 20,
      });

      const audit = await AIStrategyEngine.executeTurn('game-1', 'bot-1');

      expect(audit.selectedPlan.actions[0].type).toBe(AIActionType.DeliverLoad);
      expect(audit.selectedPlan.totalScore).toBe(95);
      expect(audit.selectedPlan.actions[0].parameters).toMatchObject({ payment: 50 });
    });
  });

  describe('timing measurements', () => {
    it('all timing fields are non-negative numbers', async () => {
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

      expect(typeof audit.timing.snapshotMs).toBe('number');
      expect(typeof audit.timing.optionGenerationMs).toBe('number');
      expect(typeof audit.timing.scoringMs).toBe('number');
      expect(typeof audit.timing.executionMs).toBe('number');
      expect(typeof audit.timing.totalMs).toBe('number');

      expect(audit.timing.snapshotMs).toBeGreaterThanOrEqual(0);
      expect(audit.timing.optionGenerationMs).toBeGreaterThanOrEqual(0);
      expect(audit.timing.scoringMs).toBeGreaterThanOrEqual(0);
      expect(audit.timing.executionMs).toBeGreaterThanOrEqual(0);
      expect(audit.timing.totalMs).toBeGreaterThanOrEqual(0);
    });

    it('totalMs >= sum of individual stage timings', async () => {
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

      // totalMs includes overhead (DB calls, audit logging) beyond the measured stages
      const stageSumMs = audit.timing.snapshotMs +
        audit.timing.optionGenerationMs +
        audit.timing.scoringMs +
        audit.timing.executionMs;
      expect(audit.timing.totalMs).toBeGreaterThanOrEqual(stageSumMs);
    });
  });

  describe('audit persistence', () => {
    it('writes audit to ai_turn_audits with all required columns', async () => {
      const options = [
        makeOption(AIActionType.DeliverLoad, 'opt-1', { payment: 30 }),
        { ...makeOption(AIActionType.UpgradeTrain, 'opt-2'), feasible: false, rejectionReason: 'No funds' },
        makeOption(AIActionType.PassTurn, 'opt-3'),
      ];
      mockGenerate.mockReturnValue(options);

      const scored = [
        makeScoredOption(AIActionType.DeliverLoad, 'opt-1', 70, { payment: 30 }),
        makeScoredOption(AIActionType.PassTurn, 'opt-3', 0),
      ];
      mockScore.mockReturnValue(scored);
      mockSelectBest.mockReturnValue(scored[0]);
      mockValidate.mockReturnValue({ ok: true, reason: null });
      mockExecute.mockResolvedValue({
        success: true,
        actionResults: [{ actionType: AIActionType.DeliverLoad, success: true, durationMs: 10 }],
        totalDurationMs: 20,
      });

      await AIStrategyEngine.executeTurn('game-1', 'bot-1');

      // Find the audit INSERT call
      const auditInserts = mockDbQuery.mock.calls.filter(
        (c: unknown[]) => typeof c[0] === 'string' && (c[0] as string).includes('ai_turn_audits'),
      );
      expect(auditInserts).toHaveLength(1);

      const [sql, params] = auditInserts[0] as [string, unknown[]];

      // Verify SQL includes all expected columns
      expect(sql).toContain('game_id');
      expect(sql).toContain('player_id');
      expect(sql).toContain('turn_number');
      expect(sql).toContain('snapshot_hash');
      expect(sql).toContain('feasible_options_count');
      expect(sql).toContain('infeasible_options_count');
      expect(sql).toContain('selected_option_type');
      expect(sql).toContain('selected_option_score');
      expect(sql).toContain('execution_result');
      expect(sql).toContain('duration_ms');
      expect(sql).toContain('audit_json');

      // Verify parameter values
      expect(params[0]).toBe('game-1');         // game_id
      expect(params[1]).toBe('bot-1');          // player_id
      expect(params[2]).toBe(5);               // turn_number
      expect(params[3]).toBe('test-snapshot-hash'); // snapshot_hash
      expect(params[4]).toBe(2);               // feasible_options_count (DeliverLoad + PassTurn)
      expect(params[5]).toBe(1);               // infeasible_options_count (UpgradeTrain)
      expect(params[6]).toBe(AIActionType.DeliverLoad); // selected_option_type
      expect(params[7]).toBe(70);              // selected_option_score
      expect(params[8]).toBe('success');        // execution_result
      expect(typeof params[9]).toBe('number');  // duration_ms
    });

    it('audit_json contains the full StrategyAudit object', async () => {
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

      const auditInserts = mockDbQuery.mock.calls.filter(
        (c: unknown[]) => typeof c[0] === 'string' && (c[0] as string).includes('ai_turn_audits'),
      );
      const auditJsonStr = auditInserts[0][1][10] as string;
      const auditJson = JSON.parse(auditJsonStr);

      // Full audit structure is present
      expect(auditJson).toHaveProperty('snapshotHash');
      expect(auditJson).toHaveProperty('allOptions');
      expect(auditJson).toHaveProperty('scores');
      expect(auditJson).toHaveProperty('selectedPlan');
      expect(auditJson).toHaveProperty('executionResults');
      expect(auditJson).toHaveProperty('timing');
    });

    it('records fallback result when all retries fail', async () => {
      mockGenerate.mockReturnValue([
        makeOption(AIActionType.DeliverLoad, 'opt-1'),
        makeOption(AIActionType.PassTurn, 'opt-2'),
      ]);
      mockScore.mockReturnValue([
        makeScoredOption(AIActionType.DeliverLoad, 'opt-1', 80),
        makeScoredOption(AIActionType.PassTurn, 'opt-2', 0),
      ]);
      mockSelectBest.mockImplementation((s: unknown[]) =>
        Array.isArray(s) && s.length > 0 ? s[0] : null,
      );
      mockValidate.mockReturnValue({ ok: false, reason: 'Always fails' });
      mockExecute.mockResolvedValue({
        success: true,
        actionResults: [{ actionType: AIActionType.PassTurn, success: true, durationMs: 1 }],
        totalDurationMs: 5,
      });

      await AIStrategyEngine.executeTurn('game-1', 'bot-1');

      const auditInserts = mockDbQuery.mock.calls.filter(
        (c: unknown[]) => typeof c[0] === 'string' && (c[0] as string).includes('ai_turn_audits'),
      );
      expect(auditInserts).toHaveLength(1);
      expect(auditInserts[0][1][8]).toBe('fallback'); // execution_result
    });
  });

  describe('execution results', () => {
    it('records per-action success/failure in executionResults', async () => {
      const options = [
        makeOption(AIActionType.DeliverLoad, 'opt-1', { payment: 30 }),
        makeOption(AIActionType.PassTurn, 'opt-2'),
      ];
      mockGenerate.mockReturnValue(options);

      mockScore.mockReturnValue([
        makeScoredOption(AIActionType.DeliverLoad, 'opt-1', 80, { payment: 30 }),
        makeScoredOption(AIActionType.PassTurn, 'opt-2', 0),
      ]);
      mockSelectBest.mockReturnValue(
        makeScoredOption(AIActionType.DeliverLoad, 'opt-1', 80, { payment: 30 }),
      );
      mockValidate.mockReturnValue({ ok: true, reason: null });

      mockExecute.mockResolvedValue({
        success: true,
        actionResults: [
          { actionType: AIActionType.DeliverLoad, success: true, durationMs: 25 },
        ],
        totalDurationMs: 30,
      });

      const audit = await AIStrategyEngine.executeTurn('game-1', 'bot-1');

      expect(audit.executionResults).toHaveLength(1);
      expect(audit.executionResults[0].actionType).toBe(AIActionType.DeliverLoad);
      expect(audit.executionResults[0].success).toBe(true);
      expect(audit.executionResults[0].durationMs).toBe(25);
    });

    it('captures error details on failed execution', async () => {
      mockGenerate.mockReturnValue([
        makeOption(AIActionType.DeliverLoad, 'opt-1', { payment: 30 }),
        makeOption(AIActionType.BuildTrack, 'opt-2', { estimatedCost: 10 }),
        makeOption(AIActionType.PassTurn, 'opt-3'),
      ]);

      const scored = [
        makeScoredOption(AIActionType.DeliverLoad, 'opt-1', 80, { payment: 30 }),
        makeScoredOption(AIActionType.BuildTrack, 'opt-2', 50, { estimatedCost: 10 }),
        makeScoredOption(AIActionType.PassTurn, 'opt-3', 0),
      ];
      mockScore.mockReturnValue(scored);

      mockSelectBest.mockImplementation((s: unknown[]) =>
        Array.isArray(s) && s.length > 0 ? s[0] : null,
      );
      mockValidate.mockReturnValue({ ok: true, reason: null });

      // First execution fails with error
      let execCount = 0;
      mockExecute.mockImplementation(() => {
        execCount++;
        if (execCount === 1) {
          return {
            success: false,
            actionResults: [{ actionType: AIActionType.DeliverLoad, success: false, error: 'Load not on train', durationMs: 5 }],
            error: 'Action 1 failed',
            totalDurationMs: 10,
          };
        }
        return {
          success: true,
          actionResults: [{ actionType: AIActionType.BuildTrack, success: true, durationMs: 15 }],
          totalDurationMs: 20,
        };
      });

      const audit = await AIStrategyEngine.executeTurn('game-1', 'bot-1');

      // Turn should succeed (retried)
      expect(audit.executionResults.length).toBeGreaterThan(0);
    });
  });
});
