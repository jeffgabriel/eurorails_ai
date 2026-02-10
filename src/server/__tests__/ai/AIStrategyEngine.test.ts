/**
 * Unit tests for AIStrategyEngine — the top-level bot orchestrator.
 * Tests pipeline orchestration, retry logic, PassTurn fallback,
 * audit logging, and socket event emissions.
 */

import { makeSnapshot } from './helpers/testFixtures';
import { AIStrategyEngine } from '../../ai/AIStrategyEngine';
import { AIActionType } from '../../ai/types';
import type {
  BotConfig,
  FeasibleOption,
  ScoredOption,
  InfeasibleOption,
  WorldSnapshot,
  ExecutionResult,
  ValidationResult,
} from '../../ai/types';
import { TrainType } from '../../../shared/types/GameTypes';

// --- Mocks ---

// Mock majorCityGroups (transitive dependency)
jest.mock('../../../shared/services/majorCityGroups', () => ({
  getMajorCityGroups: () => [],
  getFerryEdges: () => [],
}));

// Mock WorldSnapshotService
const mockCapture = jest.fn();
jest.mock('../../ai/WorldSnapshotService', () => ({
  WorldSnapshotService: {
    capture: (...args: unknown[]) => mockCapture(...args),
  },
}));

// Mock OptionGenerator
const mockGenerate = jest.fn();
jest.mock('../../ai/OptionGenerator', () => ({
  OptionGenerator: {
    generate: (...args: unknown[]) => mockGenerate(...args),
  },
}));

// Mock Scorer
const mockScore = jest.fn();
jest.mock('../../ai/Scorer', () => ({
  Scorer: {
    score: (...args: unknown[]) => mockScore(...args),
  },
}));

// Mock PlanValidator
const mockValidate = jest.fn();
jest.mock('../../ai/PlanValidator', () => ({
  PlanValidator: {
    validate: (...args: unknown[]) => mockValidate(...args),
  },
}));

// Mock TurnExecutor
const mockExecute = jest.fn();
jest.mock('../../ai/TurnExecutor', () => ({
  TurnExecutor: {
    execute: (...args: unknown[]) => mockExecute(...args),
  },
}));

// Mock BotAuditService
const mockSaveTurnAudit = jest.fn().mockResolvedValue(undefined);
jest.mock('../../services/botAuditService', () => ({
  BotAuditService: {
    saveTurnAudit: (...args: unknown[]) => mockSaveTurnAudit(...args),
  },
}));

// Mock socketService
const mockEmitToGame = jest.fn();
jest.mock('../../services/socketService', () => ({
  emitToGame: (...args: unknown[]) => mockEmitToGame(...args),
}));

// Mock BotLogger
jest.mock('../../ai/BotLogger', () => {
  const noop = jest.fn();
  const mockLoggerInstance = {
    trace: noop,
    debug: noop,
    info: noop,
    warn: noop,
    error: noop,
    withContext: jest.fn(),
  };
  mockLoggerInstance.withContext.mockReturnValue(mockLoggerInstance);
  return {
    BotLogger: jest.fn(() => mockLoggerInstance),
    BotLogLevel: { TRACE: 0, DEBUG: 1, INFO: 2, WARN: 3, ERROR: 4 },
    setGlobalBotLogLevel: noop,
    getGlobalBotLogLevel: noop,
  };
});

// Mock skill and archetype profiles
const mockGetSkillProfile = jest.fn();
const mockGetArchetypeProfile = jest.fn();
jest.mock('../../ai/config/skillProfiles', () => ({
  getSkillProfile: (...args: unknown[]) => mockGetSkillProfile(...args),
}));
jest.mock('../../ai/config/archetypeProfiles', () => ({
  getArchetypeProfile: (...args: unknown[]) => mockGetArchetypeProfile(...args),
}));

// --- Helpers ---

const TEST_GAME_ID = 'test-game';
const TEST_BOT_PLAYER_ID = 'bot-1';
const TEST_BOT_USER_ID = 'bot-user-1';
const TEST_TURN = 1;

const TEST_CONFIG: BotConfig = {
  skillLevel: 'hard',
  archetype: 'backbone_builder',
  botId: 'bot-1',
  botName: 'TestBot',
};

function makeScoredOption(
  type: AIActionType = AIActionType.BuildTrack,
  score: number = 50,
  overrides: Partial<ScoredOption> = {},
): ScoredOption {
  const params =
    type === AIActionType.PassTurn
      ? { type: AIActionType.PassTurn }
      : type === AIActionType.BuildTrack
        ? { type: AIActionType.BuildTrack, segments: [], totalCost: 1 }
        : type === AIActionType.UpgradeTrain
          ? {
              type: AIActionType.UpgradeTrain,
              targetTrainType: TrainType.FastFreight,
              kind: 'upgrade' as const,
              cost: 20,
            }
          : { type: AIActionType.PassTurn };

  return {
    type,
    description: `${type} action`,
    feasible: true,
    params: params as FeasibleOption['params'],
    score,
    rationale: `Test rationale for ${type}`,
    ...overrides,
  };
}

function makeInfeasible(reason: string = 'test reason'): InfeasibleOption {
  return {
    type: AIActionType.DeliverLoad,
    description: 'Deliver Coal to Berlin',
    feasible: false,
    reason,
  };
}

function makeSuccessResult(overrides: Partial<ExecutionResult> = {}): ExecutionResult {
  return {
    success: true,
    actionsExecuted: 1,
    durationMs: 10,
    ...overrides,
  };
}

function makeFailedResult(error: string = 'test error'): ExecutionResult {
  return {
    success: false,
    actionsExecuted: 0,
    error,
    durationMs: 5,
  };
}

function makeValidResult(): ValidationResult {
  return { valid: true, errors: [] };
}

function makeInvalidResult(errors: string[] = ['validation error']): ValidationResult {
  return { valid: false, errors };
}

// --- Setup ---

function setupDefaults(snapshot?: WorldSnapshot): void {
  const snap = snapshot ?? makeSnapshot();
  mockCapture.mockResolvedValue(snap);
  mockGenerate.mockReturnValue({
    feasible: [makeScoredOption(AIActionType.BuildTrack, 50)],
    infeasible: [],
  });
  mockScore.mockReturnValue([makeScoredOption(AIActionType.BuildTrack, 50)]);
  mockValidate.mockReturnValue(makeValidResult());
  mockExecute.mockResolvedValue(makeSuccessResult());
  mockGetSkillProfile.mockReturnValue({
    level: 'hard',
    baseWeights: {},
    randomChoicePercent: 0,
    suboptimalityPercent: 0,
    lookaheadDepth: 4,
    lookaheadBreadth: 3,
    lookaheadDiscount: 0.8,
  });
  mockGetArchetypeProfile.mockReturnValue({
    id: 'backbone_builder',
    name: 'Backbone Builder',
    description: 'Builds a central trunk line first',
    multipliers: {},
  });
}

// --- Tests ---

describe('AIStrategyEngine', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    setupDefaults();
  });

  describe('successful turn', () => {
    it('should orchestrate the full pipeline and return success', async () => {
      const result = await AIStrategyEngine.takeTurn(
        TEST_GAME_ID,
        TEST_BOT_PLAYER_ID,
        TEST_BOT_USER_ID,
        TEST_CONFIG,
        TEST_TURN,
      );

      expect(result.success).toBe(true);
      expect(result.retriesUsed).toBe(0);
      expect(result.fellBackToPass).toBe(false);

      // Verify pipeline stages called in order
      expect(mockCapture).toHaveBeenCalledWith(
        TEST_GAME_ID,
        TEST_BOT_PLAYER_ID,
        TEST_BOT_USER_ID,
      );
      expect(mockGenerate).toHaveBeenCalled();
      expect(mockScore).toHaveBeenCalled();
      expect(mockValidate).toHaveBeenCalled();
      expect(mockExecute).toHaveBeenCalled();
    });

    it('should pass snapshot to OptionGenerator', async () => {
      const snapshot = makeSnapshot({ money: 100 });
      mockCapture.mockResolvedValue(snapshot);

      await AIStrategyEngine.takeTurn(
        TEST_GAME_ID,
        TEST_BOT_PLAYER_ID,
        TEST_BOT_USER_ID,
        TEST_CONFIG,
        TEST_TURN,
      );

      expect(mockGenerate).toHaveBeenCalledWith(snapshot);
    });

    it('should pass feasible options, snapshot, and config to Scorer', async () => {
      const feasible = [makeScoredOption(AIActionType.BuildTrack, 60)];
      mockGenerate.mockReturnValue({ feasible, infeasible: [] });
      mockScore.mockReturnValue([makeScoredOption(AIActionType.BuildTrack, 60)]);

      await AIStrategyEngine.takeTurn(
        TEST_GAME_ID,
        TEST_BOT_PLAYER_ID,
        TEST_BOT_USER_ID,
        TEST_CONFIG,
        TEST_TURN,
      );

      expect(mockScore).toHaveBeenCalledWith(
        feasible,
        expect.any(Object),
        TEST_CONFIG,
      );
    });
  });

  describe('audit logging', () => {
    it('should save audit to database after successful turn', async () => {
      await AIStrategyEngine.takeTurn(
        TEST_GAME_ID,
        TEST_BOT_PLAYER_ID,
        TEST_BOT_USER_ID,
        TEST_CONFIG,
        TEST_TURN,
      );

      expect(mockSaveTurnAudit).toHaveBeenCalledTimes(1);
      expect(mockSaveTurnAudit).toHaveBeenCalledWith(
        TEST_GAME_ID,
        TEST_BOT_PLAYER_ID,
        expect.objectContaining({
          turnNumber: TEST_TURN,
          archetypeName: 'Backbone Builder',
          skillLevel: 'hard',
        }),
      );
    });

    it('should include bot status in audit', async () => {
      const snapshot = makeSnapshot({
        money: 75,
        trainType: TrainType.FastFreight,
        connectedMajorCities: 3,
      });
      mockCapture.mockResolvedValue(snapshot);

      await AIStrategyEngine.takeTurn(
        TEST_GAME_ID,
        TEST_BOT_PLAYER_ID,
        TEST_BOT_USER_ID,
        TEST_CONFIG,
        TEST_TURN,
      );

      const audit = mockSaveTurnAudit.mock.calls[0][2];
      expect(audit.botStatus.cash).toBe(75);
      expect(audit.botStatus.trainType).toBe(TrainType.FastFreight);
      expect(audit.botStatus.majorCitiesConnected).toBe(3);
    });

    it('should include scored and infeasible options in audit', async () => {
      const scored = [makeScoredOption(AIActionType.BuildTrack, 80)];
      const infeasible = [makeInfeasible('No track connection')];
      mockGenerate.mockReturnValue({ feasible: scored, infeasible });
      mockScore.mockReturnValue(scored);

      await AIStrategyEngine.takeTurn(
        TEST_GAME_ID,
        TEST_BOT_PLAYER_ID,
        TEST_BOT_USER_ID,
        TEST_CONFIG,
        TEST_TURN,
      );

      const audit = mockSaveTurnAudit.mock.calls[0][2];
      expect(audit.feasibleOptions).toEqual(scored);
      expect(audit.rejectedOptions).toEqual(infeasible);
    });

    it('should not throw if audit save fails', async () => {
      mockSaveTurnAudit.mockRejectedValueOnce(new Error('DB error'));

      const result = await AIStrategyEngine.takeTurn(
        TEST_GAME_ID,
        TEST_BOT_PLAYER_ID,
        TEST_BOT_USER_ID,
        TEST_CONFIG,
        TEST_TURN,
      );

      // Should still succeed despite audit failure
      expect(result.success).toBe(true);
    });
  });

  describe('socket events', () => {
    it('should emit bot:turn-start at the beginning', async () => {
      await AIStrategyEngine.takeTurn(
        TEST_GAME_ID,
        TEST_BOT_PLAYER_ID,
        TEST_BOT_USER_ID,
        TEST_CONFIG,
        TEST_TURN,
      );

      expect(mockEmitToGame).toHaveBeenCalledWith(
        TEST_GAME_ID,
        'bot:turn-start',
        { botPlayerId: TEST_BOT_PLAYER_ID, turnNumber: TEST_TURN },
      );
    });

    it('should emit bot:turn-complete at the end', async () => {
      await AIStrategyEngine.takeTurn(
        TEST_GAME_ID,
        TEST_BOT_PLAYER_ID,
        TEST_BOT_USER_ID,
        TEST_CONFIG,
        TEST_TURN,
      );

      expect(mockEmitToGame).toHaveBeenCalledWith(
        TEST_GAME_ID,
        'bot:turn-complete',
        expect.objectContaining({
          botPlayerId: TEST_BOT_PLAYER_ID,
          audit: expect.objectContaining({ turnNumber: TEST_TURN }),
        }),
      );
    });

    it('should emit both events even on failure', async () => {
      mockCapture.mockRejectedValue(new Error('snapshot failed'));

      await AIStrategyEngine.takeTurn(
        TEST_GAME_ID,
        TEST_BOT_PLAYER_ID,
        TEST_BOT_USER_ID,
        TEST_CONFIG,
        TEST_TURN,
      );

      const emitCalls = mockEmitToGame.mock.calls;
      expect(emitCalls[0][1]).toBe('bot:turn-start');
      expect(emitCalls[1][1]).toBe('bot:turn-complete');
    });
  });

  describe('retry mechanism', () => {
    it('should retry on validation failure and succeed on next option', async () => {
      const options = [
        makeScoredOption(AIActionType.BuildTrack, 80),
        makeScoredOption(AIActionType.UpgradeTrain, 60),
      ];
      mockScore.mockReturnValue(options);

      // First validation fails, second succeeds
      mockValidate
        .mockReturnValueOnce(makeInvalidResult(['cost exceeds budget']))
        .mockReturnValueOnce(makeValidResult());

      const result = await AIStrategyEngine.takeTurn(
        TEST_GAME_ID,
        TEST_BOT_PLAYER_ID,
        TEST_BOT_USER_ID,
        TEST_CONFIG,
        TEST_TURN,
      );

      expect(result.success).toBe(true);
      expect(result.retriesUsed).toBe(1);
      expect(result.fellBackToPass).toBe(false);
      expect(mockValidate).toHaveBeenCalledTimes(2);
      expect(mockExecute).toHaveBeenCalledTimes(1);
    });

    it('should retry on execution failure and succeed on next option', async () => {
      const options = [
        makeScoredOption(AIActionType.BuildTrack, 80),
        makeScoredOption(AIActionType.UpgradeTrain, 60),
      ];
      mockScore.mockReturnValue(options);

      // First execution fails, second succeeds
      mockExecute
        .mockResolvedValueOnce(makeFailedResult('DB constraint'))
        .mockResolvedValueOnce(makeSuccessResult());

      const result = await AIStrategyEngine.takeTurn(
        TEST_GAME_ID,
        TEST_BOT_PLAYER_ID,
        TEST_BOT_USER_ID,
        TEST_CONFIG,
        TEST_TURN,
      );

      expect(result.success).toBe(true);
      expect(result.retriesUsed).toBe(1);
      expect(mockExecute).toHaveBeenCalledTimes(2);
    });

    it('should count both validation and execution failures as retries', async () => {
      const options = [
        makeScoredOption(AIActionType.BuildTrack, 80),
        makeScoredOption(AIActionType.UpgradeTrain, 60),
        makeScoredOption(AIActionType.PassTurn, 10),
      ];
      mockScore.mockReturnValue(options);

      // First: validation fails, second: execution fails, third: succeeds
      mockValidate
        .mockReturnValueOnce(makeInvalidResult())
        .mockReturnValueOnce(makeValidResult())
        .mockReturnValueOnce(makeValidResult());
      mockExecute
        .mockResolvedValueOnce(makeFailedResult())
        .mockResolvedValueOnce(makeSuccessResult());

      const result = await AIStrategyEngine.takeTurn(
        TEST_GAME_ID,
        TEST_BOT_PLAYER_ID,
        TEST_BOT_USER_ID,
        TEST_CONFIG,
        TEST_TURN,
      );

      expect(result.success).toBe(true);
      expect(result.retriesUsed).toBe(2);
    });
  });

  describe('PassTurn fallback', () => {
    it('should fall back to PassTurn after all retries exhausted', async () => {
      const options = [
        makeScoredOption(AIActionType.BuildTrack, 80),
        makeScoredOption(AIActionType.UpgradeTrain, 60),
        makeScoredOption(AIActionType.PassTurn, 10),
      ];
      mockScore.mockReturnValue(options);

      // All 3 validations fail
      mockValidate.mockReturnValue(makeInvalidResult());

      // PassTurn fallback always succeeds
      mockExecute.mockResolvedValue(makeSuccessResult());

      const result = await AIStrategyEngine.takeTurn(
        TEST_GAME_ID,
        TEST_BOT_PLAYER_ID,
        TEST_BOT_USER_ID,
        TEST_CONFIG,
        TEST_TURN,
      );

      expect(result.success).toBe(true);
      expect(result.fellBackToPass).toBe(true);
      expect(result.retriesUsed).toBe(3);

      // The fallback PassTurn should be executed
      const lastExecuteCall = mockExecute.mock.calls[0];
      const plan = lastExecuteCall[0];
      expect(plan.actions[0].params.type).toBe(AIActionType.PassTurn);
    });

    it('should fall back when fewer candidates than MAX_RETRIES', async () => {
      // Only 1 option, and it fails
      const options = [makeScoredOption(AIActionType.BuildTrack, 80)];
      mockScore.mockReturnValue(options);
      mockValidate.mockReturnValue(makeInvalidResult());
      mockExecute.mockResolvedValue(makeSuccessResult());

      const result = await AIStrategyEngine.takeTurn(
        TEST_GAME_ID,
        TEST_BOT_PLAYER_ID,
        TEST_BOT_USER_ID,
        TEST_CONFIG,
        TEST_TURN,
      );

      expect(result.fellBackToPass).toBe(true);
      expect(result.retriesUsed).toBe(1);
    });

    it('should record fallback audit with PassTurn description', async () => {
      mockValidate.mockReturnValue(makeInvalidResult());
      mockExecute.mockResolvedValue(makeSuccessResult());

      await AIStrategyEngine.takeTurn(
        TEST_GAME_ID,
        TEST_BOT_PLAYER_ID,
        TEST_BOT_USER_ID,
        TEST_CONFIG,
        TEST_TURN,
      );

      const audit = mockSaveTurnAudit.mock.calls[0][2];
      expect(audit.currentPlan).toContain('PassTurn');
      expect(audit.selectedPlan[0].type).toBe(AIActionType.PassTurn);
    });
  });

  describe('snapshot failure', () => {
    it('should return failure and log audit when snapshot capture fails', async () => {
      mockCapture.mockRejectedValue(new Error('DB connection lost'));

      const result = await AIStrategyEngine.takeTurn(
        TEST_GAME_ID,
        TEST_BOT_PLAYER_ID,
        TEST_BOT_USER_ID,
        TEST_CONFIG,
        TEST_TURN,
      );

      expect(result.success).toBe(false);
      expect(result.fellBackToPass).toBe(true);
      expect(result.retriesUsed).toBe(0);

      // No pipeline stages should have been called
      expect(mockGenerate).not.toHaveBeenCalled();
      expect(mockScore).not.toHaveBeenCalled();
      expect(mockValidate).not.toHaveBeenCalled();
      expect(mockExecute).not.toHaveBeenCalled();

      // Audit should still be saved
      expect(mockSaveTurnAudit).toHaveBeenCalledTimes(1);
      const audit = mockSaveTurnAudit.mock.calls[0][2];
      expect(audit.executionResult.success).toBe(false);
      expect(audit.executionResult.error).toContain('DB connection lost');
    });
  });

  describe('skill-level randomization', () => {
    it('should use hard profile with no randomization (0%)', async () => {
      const options = [
        makeScoredOption(AIActionType.BuildTrack, 80),
        makeScoredOption(AIActionType.UpgradeTrain, 40),
      ];
      mockScore.mockReturnValue(options);

      // Hard: 0% random, 0% suboptimal
      mockGetSkillProfile.mockReturnValue({
        level: 'hard',
        baseWeights: {},
        randomChoicePercent: 0,
        suboptimalityPercent: 0,
        lookaheadDepth: 4,
        lookaheadBreadth: 3,
        lookaheadDiscount: 0.8,
      });

      await AIStrategyEngine.takeTurn(
        TEST_GAME_ID,
        TEST_BOT_PLAYER_ID,
        TEST_BOT_USER_ID,
        TEST_CONFIG,
        TEST_TURN,
      );

      // Should execute the best option (BuildTrack, score=80)
      const executedPlan = mockExecute.mock.calls[0][0];
      expect(executedPlan.actions[0].type).toBe(AIActionType.BuildTrack);
    });

    it('should apply suboptimality for easy skill level', async () => {
      const options = [
        makeScoredOption(AIActionType.BuildTrack, 80),
        makeScoredOption(AIActionType.UpgradeTrain, 40),
      ];
      mockScore.mockReturnValue(options);

      // Easy: 20% random, 30% suboptimal
      mockGetSkillProfile.mockReturnValue({
        level: 'easy',
        baseWeights: {},
        randomChoicePercent: 0, // Disable random for this test
        suboptimalityPercent: 100, // Force suboptimality
        lookaheadDepth: 0,
        lookaheadBreadth: 1,
        lookaheadDiscount: 0,
      });

      // Mock Math.random to return a value that triggers suboptimality
      // (between randomChoicePercent and randomChoicePercent + suboptimalityPercent)
      jest.spyOn(Math, 'random').mockReturnValue(0.01); // 1% → in suboptimality range

      await AIStrategyEngine.takeTurn(
        TEST_GAME_ID,
        TEST_BOT_PLAYER_ID,
        TEST_BOT_USER_ID,
        TEST_CONFIG,
        TEST_TURN,
      );

      // Should execute the second-best option (UpgradeTrain, score=40)
      const executedPlan = mockExecute.mock.calls[0][0];
      expect(executedPlan.actions[0].type).toBe(AIActionType.UpgradeTrain);

      jest.spyOn(Math, 'random').mockRestore();
    });
  });

  describe('audit content', () => {
    it('should include snapshot hash in audit', async () => {
      await AIStrategyEngine.takeTurn(
        TEST_GAME_ID,
        TEST_BOT_PLAYER_ID,
        TEST_BOT_USER_ID,
        TEST_CONFIG,
        TEST_TURN,
      );

      const audit = mockSaveTurnAudit.mock.calls[0][2];
      expect(audit.snapshotHash).toBeTruthy();
      expect(audit.snapshotHash.length).toBe(8);
    });

    it('should include archetype rationale', async () => {
      await AIStrategyEngine.takeTurn(
        TEST_GAME_ID,
        TEST_BOT_PLAYER_ID,
        TEST_BOT_USER_ID,
        TEST_CONFIG,
        TEST_TURN,
      );

      const audit = mockSaveTurnAudit.mock.calls[0][2];
      expect(audit.archetypeRationale).toContain('Backbone Builder');
    });

    it('should include duration in audit', async () => {
      await AIStrategyEngine.takeTurn(
        TEST_GAME_ID,
        TEST_BOT_PLAYER_ID,
        TEST_BOT_USER_ID,
        TEST_CONFIG,
        TEST_TURN,
      );

      const audit = mockSaveTurnAudit.mock.calls[0][2];
      expect(audit.durationMs).toBeGreaterThanOrEqual(0);
    });
  });
});
