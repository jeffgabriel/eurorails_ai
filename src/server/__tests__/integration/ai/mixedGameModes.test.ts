/**
 * Integration test: Mixed Game Modes (Human + Bot)
 *
 * Verifies that AI turn execution respects game turn ordering,
 * handles human→bot→human transitions, and correctly processes
 * multiple bots in a single game.
 */
import { AIStrategyEngine } from '../../../services/ai/AIStrategyEngine';
import { AIActionType } from '../../../../shared/types/AITypes';
import type { StrategyAudit, AIDifficulty, AIArchetype } from '../../../../shared/types/AITypes';
import { makeSnapshot, makeOption, makeScoredOption } from './helpers';

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
  getSkillProfile: (difficulty: string) => ({
    difficulty,
    weights: {
      immediateIncome: 0.5, incomePerMilepost: 0.7, multiDeliveryPotential: 0.7,
      networkExpansionValue: 0.7, victoryProgress: 0.7, competitorBlocking: 0.5,
      riskEventExposure: 0.5, loadScarcity: 0.5,
    },
    behavior: { planningHorizonTurns: 5, randomChoiceProbability: 0, missedOptionProbability: 0 },
  }),
}));

jest.mock('../../../services/ai/config/archetypeProfiles', () => ({
  getArchetypeProfile: (archetype: string) => ({
    archetype,
    multipliers: {
      immediateIncome: 1.0, incomePerMilepost: 1.0, multiDeliveryPotential: 1.0,
      networkExpansionValue: 1.0, victoryProgress: 1.0, competitorBlocking: 1.0,
      riskEventExposure: 1.0, loadScarcity: 1.0, upgradeRoi: 1.0,
      backboneAlignment: 1.0, loadCombinationScore: 1.0, majorCityProximity: 1.0,
    },
  }),
}));

// --- Helpers ---

interface BotConfig {
  id: string;
  difficulty: AIDifficulty;
  archetype: AIArchetype;
}

function configureBotConfig(bot: BotConfig, turnNumber: number): void {
  mockDbQuery.mockImplementation((sql: string, params?: unknown[]) => {
    if (typeof sql === 'string' && sql.includes('FROM players')) {
      const requestedPlayerId = Array.isArray(params) ? params[1] : undefined;
      // Return the matching bot config
      return {
        rows: [{
          ai_difficulty: bot.difficulty,
          ai_archetype: bot.archetype,
          current_turn_number: turnNumber,
        }],
      };
    }
    return { rows: [] };
  });
}

function setupDefaultPipeline(botId: string, turnNumber: number): void {
  const snapshot = makeSnapshot({
    botPlayerId: botId,
    turnNumber,
    snapshotHash: `hash-${botId}-${turnNumber}`,
  });
  mockCapture.mockResolvedValue(snapshot);

  const options = [
    makeOption(AIActionType.DeliverLoad, `opt-${botId}-1`, { payment: 25 }),
    makeOption(AIActionType.PassTurn, `opt-${botId}-2`),
  ];
  mockGenerate.mockReturnValue(options);

  const scored = [
    makeScoredOption(AIActionType.DeliverLoad, `opt-${botId}-1`, 60, { payment: 25 }),
    makeScoredOption(AIActionType.PassTurn, `opt-${botId}-2`, 0),
  ];
  mockScore.mockReturnValue(scored);
  mockSelectBest.mockReturnValue(scored[0]);
  mockValidate.mockReturnValue({ ok: true, reason: null });
  mockExecute.mockResolvedValue({
    success: true,
    actionResults: [{ actionType: AIActionType.DeliverLoad, success: true, durationMs: 15 }],
    totalDurationMs: 25,
  });
}

// --- Tests ---

describe('Mixed Game Modes: Human + Bot Turn Ordering', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('sequential bot execution', () => {
    it('executes two bots in sequence with correct player IDs', async () => {
      const bot1: BotConfig = { id: 'bot-1', difficulty: 'medium', archetype: 'backbone_builder' };
      const bot2: BotConfig = { id: 'bot-2', difficulty: 'hard', archetype: 'freight_optimizer' };

      // Bot 1 turn
      configureBotConfig(bot1, 5);
      setupDefaultPipeline(bot1.id, 5);
      const audit1 = await AIStrategyEngine.executeTurn('game-1', bot1.id);

      // Bot 2 turn
      configureBotConfig(bot2, 5);
      setupDefaultPipeline(bot2.id, 5);
      const audit2 = await AIStrategyEngine.executeTurn('game-1', bot2.id);

      // Both completed successfully
      expect(audit1.snapshotHash).toBe(`hash-${bot1.id}-5`);
      expect(audit2.snapshotHash).toBe(`hash-${bot2.id}-5`);

      // Each bot's snapshot was captured with correct player ID
      expect(mockCapture).toHaveBeenCalledWith('game-1', bot1.id);
      expect(mockCapture).toHaveBeenCalledWith('game-1', bot2.id);

      // Socket events include correct player IDs
      const thinkingCalls = mockEmitToGame.mock.calls.filter(
        (c: unknown[]) => c[1] === 'ai:thinking',
      );
      expect(thinkingCalls).toHaveLength(2);
      expect(thinkingCalls[0][2]).toMatchObject({ playerId: bot1.id });
      expect(thinkingCalls[1][2]).toMatchObject({ playerId: bot2.id });
    });

    it('simulates human→bot→human→bot→human turn sequence over 10 turns', async () => {
      const turnSequence = [
        { type: 'human', id: 'human-1' },
        { type: 'bot', id: 'bot-1', difficulty: 'medium' as AIDifficulty, archetype: 'opportunist' as AIArchetype },
        { type: 'human', id: 'human-2' },
        { type: 'bot', id: 'bot-2', difficulty: 'hard' as AIDifficulty, archetype: 'backbone_builder' as AIArchetype },
      ];

      const botAudits: StrategyAudit[] = [];
      let gameTurn = 1;

      for (let round = 0; round < 3; round++) {
        for (const player of turnSequence) {
          if (player.type === 'bot') {
            const bot = player as typeof player & { difficulty: AIDifficulty; archetype: AIArchetype };
            configureBotConfig(
              { id: bot.id, difficulty: bot.difficulty, archetype: bot.archetype },
              gameTurn,
            );
            setupDefaultPipeline(bot.id, gameTurn);
            const audit = await AIStrategyEngine.executeTurn('game-1', bot.id);
            botAudits.push(audit);
          }
          // Human turns are skipped (handled by the game server, not the AI pipeline)
          gameTurn++;
        }
      }

      // 3 rounds × 2 bots per round = 6 bot turns executed
      expect(botAudits).toHaveLength(6);

      // Each bot audit has valid structure
      for (const audit of botAudits) {
        expect(audit.selectedPlan).toBeDefined();
        expect(audit.executionResults.length).toBeGreaterThan(0);
        expect(audit.timing.totalMs).toBeGreaterThanOrEqual(0);
      }
    });
  });

  describe('bot isolation', () => {
    it('different bots in the same game produce independent audits', async () => {
      const bots: BotConfig[] = [
        { id: 'bot-alpha', difficulty: 'easy', archetype: 'trunk_sprinter' },
        { id: 'bot-bravo', difficulty: 'hard', archetype: 'continental_connector' },
        { id: 'bot-charlie', difficulty: 'medium', archetype: 'freight_optimizer' },
      ];

      const audits: StrategyAudit[] = [];

      for (const bot of bots) {
        configureBotConfig(bot, 10);
        setupDefaultPipeline(bot.id, 10);
        const audit = await AIStrategyEngine.executeTurn('game-1', bot.id);
        audits.push(audit);
      }

      // Each bot produced a distinct snapshot hash
      const hashes = audits.map(a => a.snapshotHash);
      expect(new Set(hashes).size).toBe(3);

      // Capture called with each bot's ID
      for (const bot of bots) {
        expect(mockCapture).toHaveBeenCalledWith('game-1', bot.id);
      }
    });

    it('one bot failure does not affect subsequent bot turns', async () => {
      // Bot 1: will fail (player not found)
      mockDbQuery.mockResolvedValueOnce({ rows: [] }); // No player found

      await expect(
        AIStrategyEngine.executeTurn('game-1', 'bot-missing'),
      ).rejects.toThrow('AI player bot-missing not found');

      // Bot 2: should still work fine
      configureBotConfig({ id: 'bot-ok', difficulty: 'medium', archetype: 'opportunist' }, 5);
      setupDefaultPipeline('bot-ok', 5);

      const audit = await AIStrategyEngine.executeTurn('game-1', 'bot-ok');
      expect(audit).toBeDefined();
      expect(audit.selectedPlan).toBeDefined();
    });
  });

  describe('multiple games', () => {
    it('bots in different games are independent', async () => {
      const games = ['game-1', 'game-2'];

      for (const gameId of games) {
        configureBotConfig({ id: 'bot-1', difficulty: 'hard', archetype: 'opportunist' }, 5);

        const snapshot = makeSnapshot({
          botPlayerId: 'bot-1',
          turnNumber: 5,
          snapshotHash: `hash-${gameId}-bot-1`,
        });
        mockCapture.mockResolvedValue(snapshot);

        mockGenerate.mockReturnValue([makeOption(AIActionType.PassTurn, 'opt-1')]);
        mockScore.mockReturnValue([makeScoredOption(AIActionType.PassTurn, 'opt-1', 0)]);
        mockSelectBest.mockReturnValue(makeScoredOption(AIActionType.PassTurn, 'opt-1', 0));
        mockValidate.mockReturnValue({ ok: true, reason: null });
        mockExecute.mockResolvedValue({
          success: true,
          actionResults: [{ actionType: AIActionType.PassTurn, success: true, durationMs: 1 }],
          totalDurationMs: 5,
        });

        const audit = await AIStrategyEngine.executeTurn(gameId, 'bot-1');
        expect(audit.snapshotHash).toBe(`hash-${gameId}-bot-1`);
      }

      // Capture called once per game
      expect(mockCapture).toHaveBeenCalledWith('game-1', 'bot-1');
      expect(mockCapture).toHaveBeenCalledWith('game-2', 'bot-1');

      // Socket events emitted to each game room separately
      const game1Thinking = mockEmitToGame.mock.calls.filter(
        (c: unknown[]) => c[0] === 'game-1' && c[1] === 'ai:thinking',
      );
      const game2Thinking = mockEmitToGame.mock.calls.filter(
        (c: unknown[]) => c[0] === 'game-2' && c[1] === 'ai:thinking',
      );
      expect(game1Thinking).toHaveLength(1);
      expect(game2Thinking).toHaveLength(1);
    });
  });

  describe('turn number tracking', () => {
    it('audit logs include correct turn numbers from DB', async () => {
      const turnNumbers = [1, 5, 10, 25, 50];

      for (const turnNumber of turnNumbers) {
        configureBotConfig({ id: 'bot-1', difficulty: 'hard', archetype: 'opportunist' }, turnNumber);
        setupDefaultPipeline('bot-1', turnNumber);

        await AIStrategyEngine.executeTurn('game-1', 'bot-1');
      }

      // Check that each audit INSERT used the correct turn number
      const auditCalls = mockDbQuery.mock.calls.filter(
        (c: unknown[]) => typeof c[0] === 'string' && (c[0] as string).includes('ai_turn_audits'),
      );
      expect(auditCalls).toHaveLength(turnNumbers.length);

      for (let i = 0; i < turnNumbers.length; i++) {
        const params = auditCalls[i][1] as unknown[];
        expect(params[2]).toBe(turnNumbers[i]); // turn_number is param $3
      }
    });
  });
});
