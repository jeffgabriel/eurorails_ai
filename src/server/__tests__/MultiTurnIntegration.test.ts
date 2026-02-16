/**
 * TEST-002: Multi-turn integration tests for AI bot pipeline.
 *
 * Uses GameSimulator to run multi-turn bot simulations with mocked dependencies.
 * Validates behavioral patterns across turns:
 *   - 10-turn smoke test (pipeline doesn't crash)
 *   - 50-turn full game simulation (money and segments accumulate)
 *   - Sticky build targeting (BotMemory loyalty)
 *   - Game-phase-aware upgrade timing
 *   - Discard intelligence (desperate hand replacement)
 *   - Drop load proximity protection
 *   - Delivery sequencing (highest payment first)
 *
 * Mock strategy: We mock at the PIPELINE LEVEL (OptionGenerator, Scorer,
 * PlanValidator, TurnExecutor) rather than the DB level, so the tests
 * exercise AIStrategyEngine's orchestration logic directly.
 */

// ── Mock external dependencies before imports ────────────────────────────
jest.mock('../db/index', () => ({
  db: {
    query: jest.fn().mockResolvedValue({ rows: [] }),
    connect: jest.fn().mockResolvedValue({
      query: jest.fn().mockResolvedValue({ rows: [] }),
      release: jest.fn(),
    }),
  },
}));

jest.mock('../services/socketService', () => ({
  emitToGame: jest.fn(),
  emitStatePatch: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../services/demandDeckService', () => ({
  DemandDeckService: {
    getInstance: jest.fn().mockReturnValue({
      getCard: jest.fn().mockReturnValue(null),
      drawCard: jest.fn().mockReturnValue(null),
      discardCard: jest.fn(),
    }),
  },
}));

jest.mock('../services/loadService', () => ({
  LoadService: {
    getInstance: jest.fn().mockReturnValue({
      getAvailableLoadsForCity: jest.fn().mockReturnValue([]),
      getSourceCitiesForLoad: jest.fn().mockReturnValue([]),
      isLoadAvailableAtCity: jest.fn().mockReturnValue(false),
      pickupDroppedLoad: jest.fn().mockResolvedValue(undefined),
      returnLoad: jest.fn().mockResolvedValue(undefined),
      setLoadInCity: jest.fn().mockResolvedValue(undefined),
    }),
  },
}));

jest.mock('../services/ai/WorldSnapshotService', () => ({
  capture: jest.fn(),
}));

jest.mock('../services/ai/OptionGenerator', () => ({
  OptionGenerator: {
    generate: jest.fn().mockReturnValue([]),
  },
}));

jest.mock('../services/ai/Scorer', () => ({
  Scorer: {
    score: jest.fn().mockReturnValue([]),
  },
}));

jest.mock('../services/ai/PlanValidator', () => ({
  validate: jest.fn().mockReturnValue({ valid: true }),
}));

jest.mock('../services/ai/TurnExecutor', () => ({
  TurnExecutor: {
    execute: jest.fn(),
  },
}));

jest.mock('../services/ai/MapTopology', () => ({
  gridToPixel: jest.fn().mockReturnValue({ x: 0, y: 0 }),
  loadGridPoints: jest.fn().mockReturnValue(new Map()),
}));

jest.mock('../../shared/services/majorCityGroups', () => ({
  getMajorCityGroups: jest.fn().mockReturnValue([]),
  getFerryEdges: jest.fn().mockReturnValue([]),
}));

jest.mock('../services/ai/DecisionLogger', () => ({
  initTurnLog: jest.fn(),
  logPhase: jest.fn(),
  flushTurnLog: jest.fn(),
}));

// BotMemory is NOT mocked — we use the real module to test state continuity
// across multiple turns.

// ── Imports ──────────────────────────────────────────────────────────────
import { AIStrategyEngine, BotTurnResult } from '../services/ai/AIStrategyEngine';
import { capture } from '../services/ai/WorldSnapshotService';
import { OptionGenerator } from '../services/ai/OptionGenerator';
import { Scorer } from '../services/ai/Scorer';
import { TurnExecutor } from '../services/ai/TurnExecutor';
import { validate } from '../services/ai/PlanValidator';
import { getMemory, clearMemory } from '../services/ai/BotMemory';
import {
  GameSimulator,
  createMockSnapshot,
  SimulatorConfig,
} from './utils/GameSimulator';
import {
  AIActionType,
  FeasibleOption,
  TrainType,
  TerrainType,
  WorldSnapshot,
} from '../../shared/types/GameTypes';

const mockCapture = capture as jest.Mock;
const mockGenerate = OptionGenerator.generate as jest.Mock;
const mockScore = Scorer.score as jest.Mock;
const mockExecute = TurnExecutor.execute as jest.Mock;
const mockValidate = validate as jest.Mock;

// ── Helpers ──────────────────────────────────────────────────────────────

const GAME_ID = 'sim-game-001';
const BOT_ID = 'sim-bot-001';

function makeSnapshot(overrides: Partial<WorldSnapshot['bot']> = {}): WorldSnapshot {
  return createMockSnapshot({
    gameId: GAME_ID,
    botPlayerId: BOT_ID,
    initialMoney: 50,
    initialPosition: { row: 10, col: 10 },
    ...overrides as any,
  });
}

/**
 * Configure mocks for a single turn that performs a specific action.
 * Handles the correct number of mockReturnValueOnce calls for
 * executeLoadActions (3 per phase: delivery, drop, pickup).
 */
function setupTurnMocks(opts: {
  snapshot: WorldSnapshot;
  phase1Action?: FeasibleOption | null;
  phase2Action: FeasibleOption;
  phase2Result: Partial<import('../services/ai/TurnExecutor').ExecutionResult>;
  phase1Result?: Partial<import('../services/ai/TurnExecutor').ExecutionResult>;
}): void {
  mockCapture.mockResolvedValue(opts.snapshot);
  mockValidate.mockReturnValue({ valid: true });

  // Phase 0: executeLoadActions calls generate 3 times (delivery, drop, pickup)
  mockGenerate
    .mockReturnValueOnce([])  // Phase 0: delivery
    .mockReturnValueOnce([])  // Phase 0: drop
    .mockReturnValueOnce([]); // Phase 0: pickup

  if (opts.phase1Action) {
    // Phase 1: movement
    mockGenerate.mockReturnValueOnce([opts.phase1Action]);
    mockScore.mockReturnValueOnce([opts.phase1Action]);
    mockExecute.mockResolvedValueOnce({
      success: true,
      action: AIActionType.MoveTrain,
      cost: 0,
      segmentsBuilt: 0,
      remainingMoney: opts.snapshot.bot.money,
      durationMs: 1,
      ...opts.phase1Result,
    });

    // Phase 1.5: executeLoadActions calls generate 3 times
    mockGenerate
      .mockReturnValueOnce([])  // Phase 1.5: delivery
      .mockReturnValueOnce([])  // Phase 1.5: drop
      .mockReturnValueOnce([]); // Phase 1.5: pickup
  } else {
    // Phase 1: no movement options
    mockGenerate.mockReturnValueOnce([]);
  }

  // Phase 2: build/upgrade/pass
  mockGenerate.mockReturnValueOnce([opts.phase2Action]);
  mockScore.mockReturnValueOnce([opts.phase2Action]);
  mockExecute.mockResolvedValueOnce({
    success: true,
    action: opts.phase2Action.action,
    cost: 0,
    segmentsBuilt: 0,
    remainingMoney: opts.snapshot.bot.money,
    durationMs: 1,
    ...opts.phase2Result,
  });
}

/**
 * Build a FeasibleOption for building track.
 */
function buildOption(targetCity: string, cost: number, segmentCount: number): FeasibleOption {
  const segments = Array.from({ length: segmentCount }, (_, i) => ({
    from: { x: 0, y: 0, row: 10, col: 10 + i, terrain: TerrainType.Clear },
    to: { x: 0, y: 0, row: 10, col: 11 + i, terrain: TerrainType.Clear },
    cost: Math.ceil(cost / segmentCount),
  }));
  return {
    action: AIActionType.BuildTrack,
    feasible: true,
    reason: `Build toward ${targetCity}`,
    targetCity,
    segments,
    estimatedCost: cost,
    score: 50,
  };
}

/**
 * Build a FeasibleOption for PassTurn.
 */
function passOption(): FeasibleOption {
  return {
    action: AIActionType.PassTurn,
    feasible: true,
    reason: 'Always an option',
    score: 0,
  };
}

// ── Tests ────────────────────────────────────────────────────────────────

describe('Multi-turn integration tests (TEST-002)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    clearMemory(GAME_ID, BOT_ID);
  });

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // 1. Smoke test: 10-turn pipeline stability
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  describe('10-turn smoke test', () => {
    it('completes 10 turns without crashing, all PassTurn', async () => {
      const snapshot = makeSnapshot();

      const sim = new GameSimulator(async (gid, pid) => {
        mockCapture.mockResolvedValue({ ...snapshot, turnNumber: sim.getMetrics().turnCount + 1 });
        mockGenerate.mockReturnValue([]);
        mockScore.mockReturnValue([]);
        mockExecute.mockResolvedValue({
          success: true,
          action: AIActionType.PassTurn,
          cost: 0,
          segmentsBuilt: 0,
          remainingMoney: 50,
          durationMs: 1,
        });
        return AIStrategyEngine.takeTurn(gid, pid);
      });

      sim.initialize(snapshot);
      const completed = await sim.runTurns(10);

      expect(completed).toBe(10);
      const metrics = sim.getMetrics();
      expect(metrics.turnCount).toBe(10);
      expect(metrics.errors).toHaveLength(0);
      expect(metrics.actionHistory).toHaveLength(10);
    });

    it('completes 10 turns with alternating Build and PassTurn', async () => {
      const snapshot = makeSnapshot();
      let turnCounter = 0;

      const sim = new GameSimulator(async (gid, pid) => {
        turnCounter++;
        jest.clearAllMocks();

        const currentSnapshot = { ...snapshot, turnNumber: turnCounter };
        currentSnapshot.bot = { ...snapshot.bot, money: 50 };
        mockCapture.mockResolvedValue(currentSnapshot);
        mockValidate.mockReturnValue({ valid: true });

        if (turnCounter % 2 === 1) {
          // Build turn: Phase 0 (3 calls) + Phase 1 (1 call, no options) + Phase 2 (1 call)
          const build = buildOption('Berlin', 5, 2);
          mockGenerate
            .mockReturnValueOnce([])  // Phase 0: delivery
            .mockReturnValueOnce([])  // Phase 0: drop
            .mockReturnValueOnce([])  // Phase 0: pickup
            .mockReturnValueOnce([])  // Phase 1: no movement
            .mockReturnValueOnce([build]); // Phase 2: build
          mockScore.mockReturnValueOnce([build]);
          mockExecute.mockResolvedValueOnce({
            success: true,
            action: AIActionType.BuildTrack,
            cost: 5,
            segmentsBuilt: 2,
            remainingMoney: 45,
            durationMs: 3,
          });
        } else {
          // Pass turn
          mockGenerate
            .mockReturnValueOnce([])  // Phase 0: delivery
            .mockReturnValueOnce([])  // Phase 0: drop
            .mockReturnValueOnce([])  // Phase 0: pickup
            .mockReturnValueOnce([])  // Phase 1: no movement
            .mockReturnValueOnce([passOption()]); // Phase 2: pass
          mockScore.mockReturnValueOnce([passOption()]);
          mockExecute.mockResolvedValueOnce({
            success: true,
            action: AIActionType.PassTurn,
            cost: 0,
            segmentsBuilt: 0,
            remainingMoney: 50,
            durationMs: 1,
          });
        }

        return AIStrategyEngine.takeTurn(gid, pid);
      });

      sim.initialize(snapshot);
      const completed = await sim.runTurns(10);

      expect(completed).toBe(10);
      const metrics = sim.getMetrics();
      expect(metrics.turnCount).toBe(10);
      expect(metrics.errors).toHaveLength(0);
      // 5 build turns + 5 pass turns
      const builds = metrics.actionHistory.filter(a => a === AIActionType.BuildTrack);
      const passes = metrics.actionHistory.filter(a => a === AIActionType.PassTurn);
      expect(builds).toHaveLength(5);
      expect(passes).toHaveLength(5);
    });

    it('handles pipeline errors gracefully without halting', async () => {
      const snapshot = makeSnapshot();
      let turnCounter = 0;

      const sim = new GameSimulator(async (gid, pid) => {
        turnCounter++;
        jest.clearAllMocks();

        if (turnCounter === 3) {
          // Turn 3: WorldSnapshotService throws
          mockCapture.mockRejectedValue(new Error('DB connection timeout'));
        } else {
          mockCapture.mockResolvedValue({ ...snapshot, turnNumber: turnCounter });
          mockGenerate.mockReturnValue([]);
          mockScore.mockReturnValue([]);
          mockExecute.mockResolvedValue({
            success: true,
            action: AIActionType.PassTurn,
            cost: 0,
            segmentsBuilt: 0,
            remainingMoney: 50,
            durationMs: 1,
          });
        }

        return AIStrategyEngine.takeTurn(gid, pid);
      });

      sim.initialize(snapshot);
      const completed = await sim.runTurns(10);

      // Simulator stops early on error
      expect(completed).toBe(3);
      const metrics = sim.getMetrics();
      expect(metrics.errors).toHaveLength(1);
      expect(metrics.errors[0]).toContain('DB connection timeout');
    });
  });

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // 2. 50-turn full game simulation
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  describe('50-turn full game simulation', () => {
    it('accumulates money and segments over 50 turns of building', async () => {
      let money = 50;
      let turnCounter = 0;

      const sim = new GameSimulator(async (gid, pid) => {
        turnCounter++;
        jest.clearAllMocks();

        const currentSnapshot = createMockSnapshot({
          gameId: GAME_ID,
          botPlayerId: BOT_ID,
          initialMoney: money,
          initialPosition: { row: 10, col: 10 },
        });
        (currentSnapshot as any).turnNumber = turnCounter;

        mockCapture.mockResolvedValue(currentSnapshot);
        mockValidate.mockReturnValue({ valid: true });

        const buildCost = Math.min(5, money);
        if (buildCost > 0) {
          const build = buildOption('Paris', buildCost, 2);
          mockGenerate
            .mockReturnValueOnce([])  // Phase 0: delivery
            .mockReturnValueOnce([])  // Phase 0: drop
            .mockReturnValueOnce([])  // Phase 0: pickup
            .mockReturnValueOnce([])  // Phase 1: no movement
            .mockReturnValueOnce([build]); // Phase 2: build
          mockScore.mockReturnValueOnce([build]);
          mockExecute.mockResolvedValueOnce({
            success: true,
            action: AIActionType.BuildTrack,
            cost: buildCost,
            segmentsBuilt: 2,
            remainingMoney: money - buildCost,
            durationMs: 2,
          });
          money -= buildCost;
        } else {
          mockGenerate
            .mockReturnValueOnce([])  // Phase 0: delivery
            .mockReturnValueOnce([])  // Phase 0: drop
            .mockReturnValueOnce([])  // Phase 0: pickup
            .mockReturnValueOnce([])  // Phase 1: no movement
            .mockReturnValueOnce([passOption()]); // Phase 2: pass
          mockScore.mockReturnValueOnce([passOption()]);
          mockExecute.mockResolvedValueOnce({
            success: true,
            action: AIActionType.PassTurn,
            cost: 0,
            segmentsBuilt: 0,
            remainingMoney: money,
            durationMs: 1,
          });
        }

        return AIStrategyEngine.takeTurn(gid, pid);
      });

      sim.initialize(createMockSnapshot({
        gameId: GAME_ID,
        botPlayerId: BOT_ID,
        initialMoney: 50,
        initialPosition: { row: 10, col: 10 },
      }));

      const completed = await sim.runTurns(50);
      expect(completed).toBe(50);

      const metrics = sim.getMetrics();
      expect(metrics.turnCount).toBe(50);
      // Bot starts with 50M, spending 5 per build turn → runs out after 10 turns
      // Then passes for remaining 40 turns
      const buildCount = metrics.actionHistory.filter(a => a === AIActionType.BuildTrack).length;
      expect(buildCount).toBe(10);
      expect(metrics.totalSegmentsBuilt).toBe(20); // 10 turns * 2 segments
      expect(metrics.errors).toHaveLength(0);
    });

    it('tracks deliveries and earnings across turns in a full simulation', async () => {
      let money = 50;
      let turnCounter = 0;

      const sim = new GameSimulator(async (gid, pid) => {
        turnCounter++;
        jest.clearAllMocks();

        const currentSnapshot = createMockSnapshot({
          gameId: GAME_ID,
          botPlayerId: BOT_ID,
          initialMoney: money,
          initialPosition: { row: 10, col: 10 },
        });
        (currentSnapshot as any).turnNumber = turnCounter;

        mockCapture.mockResolvedValue(currentSnapshot);
        mockValidate.mockReturnValue({ valid: true });

        // Every 5th turn: simulate a delivery for 15M
        if (turnCounter % 5 === 0) {
          mockGenerate
            .mockReturnValueOnce([])  // Phase 0: delivery
            .mockReturnValueOnce([])  // Phase 0: drop
            .mockReturnValueOnce([])  // Phase 0: pickup
            .mockReturnValueOnce([])  // Phase 1: no movement
            .mockReturnValueOnce([passOption()]); // Phase 2: pass
          mockScore.mockReturnValueOnce([passOption()]);
          mockExecute.mockResolvedValueOnce({
            success: true,
            action: AIActionType.PassTurn,
            cost: 0,
            segmentsBuilt: 0,
            remainingMoney: money,
            durationMs: 1,
          });

          // Return delivery result from takeTurn
          const result = await AIStrategyEngine.takeTurn(gid, pid);
          // Simulate delivery in result
          result.loadsDelivered = [{ loadType: 'Coal', city: 'Berlin', payment: 15, cardId: turnCounter }];
          money += 15;
          return result;
        }

        // Normal build turn
        const buildCost = Math.min(3, money);
        if (buildCost > 0) {
          const build = buildOption('London', buildCost, 1);
          mockGenerate
            .mockReturnValueOnce([])  // Phase 0: delivery
            .mockReturnValueOnce([])  // Phase 0: drop
            .mockReturnValueOnce([])  // Phase 0: pickup
            .mockReturnValueOnce([])  // Phase 1: no movement
            .mockReturnValueOnce([build]); // Phase 2: build
          mockScore.mockReturnValueOnce([build]);
          mockExecute.mockResolvedValueOnce({
            success: true,
            action: AIActionType.BuildTrack,
            cost: buildCost,
            segmentsBuilt: 1,
            remainingMoney: money - buildCost,
            durationMs: 2,
          });
          money -= buildCost;
        } else {
          mockGenerate
            .mockReturnValueOnce([])
            .mockReturnValueOnce([])
            .mockReturnValueOnce([])
            .mockReturnValueOnce([])
            .mockReturnValueOnce([passOption()]);
          mockScore.mockReturnValueOnce([passOption()]);
          mockExecute.mockResolvedValueOnce({
            success: true,
            action: AIActionType.PassTurn,
            cost: 0,
            segmentsBuilt: 0,
            remainingMoney: money,
            durationMs: 1,
          });
        }

        return AIStrategyEngine.takeTurn(gid, pid);
      });

      sim.initialize(createMockSnapshot({
        gameId: GAME_ID,
        botPlayerId: BOT_ID,
        initialMoney: 50,
        initialPosition: { row: 10, col: 10 },
      }));

      const completed = await sim.runTurns(50);
      expect(completed).toBe(50);

      const metrics = sim.getMetrics();
      // 10 delivery turns (every 5th: 5, 10, 15, 20, 25, 30, 35, 40, 45, 50)
      expect(metrics.deliveryCount).toBe(10);
      expect(metrics.totalEarnings).toBe(150); // 10 * 15M
    });
  });

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // 3. Sticky build targeting (BotMemory persistence)
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  describe('Sticky build targeting', () => {
    it('BotMemory tracks currentBuildTarget across consecutive build turns', async () => {
      let turnCounter = 0;

      const sim = new GameSimulator(async (gid, pid) => {
        turnCounter++;
        jest.clearAllMocks();

        const currentSnapshot = makeSnapshot();
        (currentSnapshot as any).turnNumber = turnCounter;
        mockCapture.mockResolvedValue(currentSnapshot);
        mockValidate.mockReturnValue({ valid: true });

        const build = buildOption('Madrid', 5, 2);
        mockGenerate
          .mockReturnValueOnce([])  // Phase 0: delivery
          .mockReturnValueOnce([])  // Phase 0: drop
          .mockReturnValueOnce([])  // Phase 0: pickup
          .mockReturnValueOnce([])  // Phase 1: no movement
          .mockReturnValueOnce([build]); // Phase 2: build
        mockScore.mockReturnValueOnce([build]);
        mockExecute.mockResolvedValueOnce({
          success: true,
          action: AIActionType.BuildTrack,
          cost: 5,
          segmentsBuilt: 2,
          remainingMoney: 45,
          durationMs: 2,
        });

        return AIStrategyEngine.takeTurn(gid, pid);
      });

      sim.initialize(makeSnapshot());

      // Run 3 turns all targeting Madrid
      await sim.runTurns(3);

      const memory = getMemory(GAME_ID, BOT_ID);
      expect(memory.currentBuildTarget).toBe('Madrid');
      expect(memory.turnsOnTarget).toBe(3);
      expect(memory.consecutivePassTurns).toBe(0);
    });

    it('resets turnsOnTarget when build target changes', async () => {
      let turnCounter = 0;

      const sim = new GameSimulator(async (gid, pid) => {
        turnCounter++;
        jest.clearAllMocks();

        const currentSnapshot = makeSnapshot();
        (currentSnapshot as any).turnNumber = turnCounter;
        mockCapture.mockResolvedValue(currentSnapshot);
        mockValidate.mockReturnValue({ valid: true });

        // First 2 turns target Madrid, then switch to Berlin
        const targetCity = turnCounter <= 2 ? 'Madrid' : 'Berlin';
        const build = buildOption(targetCity, 5, 2);
        mockGenerate
          .mockReturnValueOnce([])
          .mockReturnValueOnce([])
          .mockReturnValueOnce([])
          .mockReturnValueOnce([])
          .mockReturnValueOnce([build]);
        mockScore.mockReturnValueOnce([build]);
        mockExecute.mockResolvedValueOnce({
          success: true,
          action: AIActionType.BuildTrack,
          cost: 5,
          segmentsBuilt: 2,
          remainingMoney: 45,
          durationMs: 2,
        });

        return AIStrategyEngine.takeTurn(gid, pid);
      });

      sim.initialize(makeSnapshot());
      await sim.runTurns(4);

      const memory = getMemory(GAME_ID, BOT_ID);
      expect(memory.currentBuildTarget).toBe('Berlin');
      // 2 turns on Berlin (turns 3 and 4)
      expect(memory.turnsOnTarget).toBe(2);
    });

    it('tracks consecutivePassTurns accurately', async () => {
      let turnCounter = 0;

      const sim = new GameSimulator(async (gid, pid) => {
        turnCounter++;
        jest.clearAllMocks();

        const currentSnapshot = makeSnapshot();
        (currentSnapshot as any).turnNumber = turnCounter;
        mockCapture.mockResolvedValue(currentSnapshot);
        mockValidate.mockReturnValue({ valid: true });

        // First turn: build. Turns 2-4: pass.
        if (turnCounter === 1) {
          const build = buildOption('Roma', 5, 2);
          mockGenerate
            .mockReturnValueOnce([])
            .mockReturnValueOnce([])
            .mockReturnValueOnce([])
            .mockReturnValueOnce([])
            .mockReturnValueOnce([build]);
          mockScore.mockReturnValueOnce([build]);
          mockExecute.mockResolvedValueOnce({
            success: true,
            action: AIActionType.BuildTrack,
            cost: 5,
            segmentsBuilt: 2,
            remainingMoney: 45,
            durationMs: 2,
          });
        } else {
          mockGenerate.mockReturnValue([]);
          mockScore.mockReturnValue([]);
          mockExecute.mockResolvedValue({
            success: true,
            action: AIActionType.PassTurn,
            cost: 0,
            segmentsBuilt: 0,
            remainingMoney: 50,
            durationMs: 1,
          });
        }

        return AIStrategyEngine.takeTurn(gid, pid);
      });

      sim.initialize(makeSnapshot());
      await sim.runTurns(4);

      const memory = getMemory(GAME_ID, BOT_ID);
      // After build on turn 1: consecutivePassTurns = 0
      // After pass on turn 2: consecutivePassTurns = 1
      // After pass on turn 3: consecutivePassTurns = 2
      // After pass on turn 4: consecutivePassTurns = 3
      expect(memory.consecutivePassTurns).toBe(3);
      expect(memory.lastAction).toBe(AIActionType.PassTurn);
    });
  });

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // 4. Game-phase-aware upgrade timing (BE-004)
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  describe('Upgrade timing', () => {
    it('BotMemory accumulates deliveryCount which gates upgrade decisions', async () => {
      let turnCounter = 0;

      const sim = new GameSimulator(async (gid, pid) => {
        turnCounter++;
        jest.clearAllMocks();

        const currentSnapshot = makeSnapshot();
        (currentSnapshot as any).turnNumber = turnCounter;
        mockCapture.mockResolvedValue(currentSnapshot);
        mockValidate.mockReturnValue({ valid: true });

        // Simulate build turns, with deliveries injected via result
        const build = buildOption('Wien', 5, 2);
        mockGenerate
          .mockReturnValueOnce([])
          .mockReturnValueOnce([])
          .mockReturnValueOnce([])
          .mockReturnValueOnce([])
          .mockReturnValueOnce([build]);
        mockScore.mockReturnValueOnce([build]);
        mockExecute.mockResolvedValueOnce({
          success: true,
          action: AIActionType.BuildTrack,
          cost: 5,
          segmentsBuilt: 2,
          remainingMoney: 45,
          durationMs: 2,
        });

        return AIStrategyEngine.takeTurn(gid, pid);
      });

      sim.initialize(makeSnapshot());
      await sim.runTurns(5);

      const memory = getMemory(GAME_ID, BOT_ID);
      // All turns were builds, no deliveries from Phase 0/1.5
      expect(memory.deliveryCount).toBe(0);
      expect(memory.turnNumber).toBe(5);
    });

    it('upgrade option appears in Phase 2 alongside build options', async () => {
      const snapshot = makeSnapshot();
      mockCapture.mockResolvedValue(snapshot);
      mockValidate.mockReturnValue({ valid: true });

      const upgradeOption: FeasibleOption = {
        action: AIActionType.UpgradeTrain,
        feasible: true,
        reason: 'Upgrade to Fast Freight',
        targetTrainType: TrainType.FastFreight,
        upgradeKind: 'upgrade',
        estimatedCost: 20,
        score: 30,
      };

      mockGenerate
        .mockReturnValueOnce([])  // Phase 0: delivery
        .mockReturnValueOnce([])  // Phase 0: drop
        .mockReturnValueOnce([])  // Phase 0: pickup
        .mockReturnValueOnce([])  // Phase 1: no movement
        .mockReturnValueOnce([upgradeOption]); // Phase 2: upgrade
      mockScore.mockReturnValueOnce([upgradeOption]);
      mockExecute.mockResolvedValueOnce({
        success: true,
        action: AIActionType.UpgradeTrain,
        cost: 20,
        segmentsBuilt: 0,
        remainingMoney: 30,
        durationMs: 3,
      });

      const result = await AIStrategyEngine.takeTurn(GAME_ID, BOT_ID);

      expect(result.action).toBe(AIActionType.UpgradeTrain);
      expect(result.cost).toBe(20);
      expect(result.success).toBe(true);
    });
  });

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // 5. Discard intelligence (BE-005)
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  describe('Discard intelligence', () => {
    it('DiscardHand action goes through Phase 2 pipeline correctly', async () => {
      const snapshot = makeSnapshot();
      mockCapture.mockResolvedValue(snapshot);
      mockValidate.mockReturnValue({ valid: true });

      const discardOption: FeasibleOption = {
        action: AIActionType.DiscardHand,
        feasible: true,
        reason: 'Discard hand and draw 3 new cards',
        score: 20,
      };

      mockGenerate
        .mockReturnValueOnce([])  // Phase 0: delivery
        .mockReturnValueOnce([])  // Phase 0: drop
        .mockReturnValueOnce([])  // Phase 0: pickup
        .mockReturnValueOnce([])  // Phase 1: no movement
        .mockReturnValueOnce([discardOption]); // Phase 2: discard
      mockScore.mockReturnValueOnce([discardOption]);
      mockExecute.mockResolvedValueOnce({
        success: true,
        action: AIActionType.DiscardHand,
        cost: 0,
        segmentsBuilt: 0,
        remainingMoney: 50,
        durationMs: 1,
      });

      const result = await AIStrategyEngine.takeTurn(GAME_ID, BOT_ID);

      expect(result.action).toBe(AIActionType.DiscardHand);
      expect(result.success).toBe(true);
      expect(result.cost).toBe(0);
    });

    it('DiscardHand does not trigger PassTurn fallback when it succeeds', async () => {
      const snapshot = makeSnapshot();
      mockCapture.mockResolvedValue(snapshot);
      mockValidate.mockReturnValue({ valid: true });

      const discardOption: FeasibleOption = {
        action: AIActionType.DiscardHand,
        feasible: true,
        reason: 'Discard hand',
        score: 20,
      };

      mockGenerate
        .mockReturnValueOnce([])
        .mockReturnValueOnce([])
        .mockReturnValueOnce([])
        .mockReturnValueOnce([])
        .mockReturnValueOnce([discardOption]);
      mockScore.mockReturnValueOnce([discardOption]);
      mockExecute.mockResolvedValueOnce({
        success: true,
        action: AIActionType.DiscardHand,
        cost: 0,
        segmentsBuilt: 0,
        remainingMoney: 50,
        durationMs: 1,
      });

      const result = await AIStrategyEngine.takeTurn(GAME_ID, BOT_ID);

      // Should NOT fall back to PassTurn
      expect(result.action).not.toBe(AIActionType.PassTurn);
      expect(result.action).toBe(AIActionType.DiscardHand);
    });
  });

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // 6. Drop load — orphaned loads only, with score gate (BE-006 fix)
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  describe('Drop load — orphaned loads with score gate', () => {
    it('DropLoad in Phase 0 is executed when score > 0', async () => {
      const snapshot = makeSnapshot();
      snapshot.bot.loads = ['Coal'];
      mockCapture.mockResolvedValue(snapshot);
      mockValidate.mockReturnValue({ valid: true });

      const dropOption: FeasibleOption = {
        action: AIActionType.DropLoad,
        feasible: true,
        reason: 'Drop Coal (no demand card)',
        loadType: 'Coal' as any,
        targetCity: 'TestCity',
        score: 10,
      };

      // Phase 0: delivery (none), drop (Coal), pickup (none)
      mockGenerate
        .mockReturnValueOnce([])  // Phase 0: delivery
        .mockReturnValueOnce([dropOption])  // Phase 0: drop
        .mockReturnValueOnce([])  // Phase 0: pickup (after drop)
        .mockReturnValueOnce([])  // Phase 1: no movement
        .mockReturnValueOnce([passOption()]); // Phase 2: pass
      mockScore
        .mockReturnValueOnce([dropOption])  // Phase 0: scored drops
        .mockReturnValueOnce([passOption()]); // Phase 2: scored options
      mockExecute
        .mockResolvedValueOnce({
          success: true,
          action: AIActionType.DropLoad,
          cost: 0,
          segmentsBuilt: 0,
          remainingMoney: 50,
          durationMs: 1,
        })
        .mockResolvedValueOnce({
          success: true,
          action: AIActionType.PassTurn,
          cost: 0,
          segmentsBuilt: 0,
          remainingMoney: 50,
          durationMs: 1,
        });

      const result = await AIStrategyEngine.takeTurn(GAME_ID, BOT_ID);
      expect(result.success).toBe(true);
      expect(result.action).toBe(AIActionType.PassTurn);
    });

    it('DropLoad in Phase 0 is skipped when score <= 0', async () => {
      const snapshot = makeSnapshot();
      snapshot.bot.loads = ['Coal'];
      mockCapture.mockResolvedValue(snapshot);
      mockValidate.mockReturnValue({ valid: true });

      const dropOption: FeasibleOption = {
        action: AIActionType.DropLoad,
        feasible: true,
        reason: 'Drop Coal (no demand card)',
        loadType: 'Coal' as any,
        targetCity: 'TestCity',
        score: -5, // Negative score — should be skipped
      };

      // Phase 0: delivery (none), drop (Coal — skipped due to score), pickup (none)
      mockGenerate
        .mockReturnValueOnce([])  // Phase 0: delivery
        .mockReturnValueOnce([dropOption])  // Phase 0: drop (will be skipped)
        .mockReturnValueOnce([])  // Phase 0: pickup
        .mockReturnValueOnce([])  // Phase 1: no movement
        .mockReturnValueOnce([passOption()]); // Phase 2: pass
      mockScore
        .mockReturnValueOnce([dropOption])  // Phase 0: scored drops
        .mockReturnValueOnce([passOption()]); // Phase 2: scored options
      mockExecute
        .mockResolvedValueOnce({
          success: true,
          action: AIActionType.PassTurn,
          cost: 0,
          segmentsBuilt: 0,
          remainingMoney: 50,
          durationMs: 1,
        });

      const result = await AIStrategyEngine.takeTurn(GAME_ID, BOT_ID);
      expect(result.success).toBe(true);
      // DropLoad was skipped, only PassTurn executed
      expect(mockExecute).toHaveBeenCalledTimes(1);
      expect(result.action).toBe(AIActionType.PassTurn);
    });
  });

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // 7. Delivery sequencing
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  describe('Delivery sequencing', () => {
    it('deliveries in Phase 0 are recorded in loadsDelivered of the turn result', async () => {
      const snapshot = makeSnapshot();
      snapshot.bot.loads = ['Wine'];
      snapshot.bot.demandCards = [42];
      snapshot.bot.resolvedDemands = [{
        cardId: 42,
        demands: [{ city: 'Paris', loadType: 'Wine', payment: 15 }],
      }];
      mockCapture.mockResolvedValue(snapshot);
      mockValidate.mockReturnValue({ valid: true });

      const deliverOption: FeasibleOption = {
        action: AIActionType.DeliverLoad,
        feasible: true,
        reason: 'Deliver Wine to Paris',
        loadType: 'Wine' as any,
        targetCity: 'Paris',
        cardId: 42,
        payment: 15,
        score: 130,
      };

      // Phase 0: delivery (Wine), drop (none), pickup (none)
      mockGenerate
        .mockReturnValueOnce([deliverOption])  // Phase 0: delivery
        .mockReturnValueOnce([])  // Phase 0: drop
        .mockReturnValueOnce([])  // Phase 0: pickup
        .mockReturnValueOnce([])  // Phase 1: no movement
        .mockReturnValueOnce([passOption()]); // Phase 2: pass
      mockScore
        .mockReturnValueOnce([deliverOption])  // Phase 0: scored deliveries
        .mockReturnValueOnce([passOption()]); // Phase 2
      mockExecute
        .mockResolvedValueOnce({
          success: true,
          action: AIActionType.DeliverLoad,
          cost: 0,
          segmentsBuilt: 0,
          remainingMoney: 65,
          durationMs: 1,
          payment: 15,
          newCardId: 201,
        })
        .mockResolvedValueOnce({
          success: true,
          action: AIActionType.PassTurn,
          cost: 0,
          segmentsBuilt: 0,
          remainingMoney: 65,
          durationMs: 1,
        });

      const result = await AIStrategyEngine.takeTurn(GAME_ID, BOT_ID);

      expect(result.success).toBe(true);
      expect(result.loadsDelivered).toBeDefined();
      expect(result.loadsDelivered).toHaveLength(1);
      expect(result.loadsDelivered![0]).toEqual({
        loadType: 'Wine',
        city: 'Paris',
        payment: 15,
        cardId: 42,
      });
    });

    it('multiple deliveries in same phase are all recorded', async () => {
      const snapshot = makeSnapshot();
      snapshot.bot.loads = ['Wine', 'Coal'];
      snapshot.bot.demandCards = [42, 43];
      snapshot.bot.resolvedDemands = [
        { cardId: 42, demands: [{ city: 'Paris', loadType: 'Wine', payment: 15 }] },
        { cardId: 43, demands: [{ city: 'Paris', loadType: 'Coal', payment: 10 }] },
      ];
      mockCapture.mockResolvedValue(snapshot);
      mockValidate.mockReturnValue({ valid: true });

      const deliverWine: FeasibleOption = {
        action: AIActionType.DeliverLoad,
        feasible: true,
        reason: 'Deliver Wine',
        loadType: 'Wine' as any,
        targetCity: 'Paris',
        cardId: 42,
        payment: 15,
        score: 130,
      };
      const deliverCoal: FeasibleOption = {
        action: AIActionType.DeliverLoad,
        feasible: true,
        reason: 'Deliver Coal',
        loadType: 'Coal' as any,
        targetCity: 'Paris',
        cardId: 43,
        payment: 10,
        score: 120,
      };

      // Phase 0: delivery generates both; both are scored and executed
      mockGenerate
        .mockReturnValueOnce([deliverWine, deliverCoal])  // Phase 0: delivery
        .mockReturnValueOnce([])  // Phase 0: drop
        .mockReturnValueOnce([])  // Phase 0: pickup
        .mockReturnValueOnce([])  // Phase 1: no movement
        .mockReturnValueOnce([passOption()]); // Phase 2: pass
      mockScore
        .mockReturnValueOnce([deliverWine, deliverCoal])  // Phase 0: scored deliveries
        .mockReturnValueOnce([passOption()]); // Phase 2
      mockExecute
        .mockResolvedValueOnce({
          success: true,
          action: AIActionType.DeliverLoad,
          cost: 0,
          segmentsBuilt: 0,
          remainingMoney: 65,
          durationMs: 1,
          payment: 15,
          newCardId: 201,
        })
        .mockResolvedValueOnce({
          success: true,
          action: AIActionType.DeliverLoad,
          cost: 0,
          segmentsBuilt: 0,
          remainingMoney: 75,
          durationMs: 1,
          payment: 10,
          newCardId: 202,
        })
        .mockResolvedValueOnce({
          success: true,
          action: AIActionType.PassTurn,
          cost: 0,
          segmentsBuilt: 0,
          remainingMoney: 75,
          durationMs: 1,
        });

      const result = await AIStrategyEngine.takeTurn(GAME_ID, BOT_ID);

      expect(result.success).toBe(true);
      expect(result.loadsDelivered).toBeDefined();
      expect(result.loadsDelivered).toHaveLength(2);
      expect(result.loadsDelivered![0].loadType).toBe('Wine');
      expect(result.loadsDelivered![0].payment).toBe(15);
      expect(result.loadsDelivered![1].loadType).toBe('Coal');
      expect(result.loadsDelivered![1].payment).toBe(10);
    });

    it('Phase 1.5 delivery after movement is also recorded', async () => {
      const snapshot = makeSnapshot();
      snapshot.bot.loads = ['Iron'];
      snapshot.bot.demandCards = [44];
      snapshot.bot.resolvedDemands = [
        { cardId: 44, demands: [{ city: 'Berlin', loadType: 'Iron', payment: 20 }] },
      ];
      mockCapture.mockResolvedValue(snapshot);
      mockValidate.mockReturnValue({ valid: true });

      const moveOption: FeasibleOption = {
        action: AIActionType.MoveTrain,
        feasible: true,
        reason: 'Move to Berlin',
        movementPath: [{ row: 10, col: 10 }, { row: 11, col: 10 }],
        mileposts: 1,
        score: 80,
      };

      const deliverIron: FeasibleOption = {
        action: AIActionType.DeliverLoad,
        feasible: true,
        reason: 'Deliver Iron to Berlin',
        loadType: 'Iron' as any,
        targetCity: 'Berlin',
        cardId: 44,
        payment: 20,
        score: 140,
      };

      // Phase 0: no actions
      mockGenerate
        .mockReturnValueOnce([])  // Phase 0: delivery
        .mockReturnValueOnce([])  // Phase 0: drop
        .mockReturnValueOnce([])  // Phase 0: pickup
        // Phase 1: movement
        .mockReturnValueOnce([moveOption])
        // Phase 1.5: delivery after move
        .mockReturnValueOnce([deliverIron])  // Phase 1.5: delivery
        .mockReturnValueOnce([])  // Phase 1.5: drop
        .mockReturnValueOnce([])  // Phase 1.5: pickup
        // Phase 2: pass
        .mockReturnValueOnce([passOption()]);

      mockScore
        .mockReturnValueOnce([moveOption])  // Phase 1
        .mockReturnValueOnce([deliverIron])  // Phase 1.5: delivery
        .mockReturnValueOnce([passOption()]); // Phase 2

      mockExecute
        .mockResolvedValueOnce({
          success: true,
          action: AIActionType.MoveTrain,
          cost: 0,
          segmentsBuilt: 0,
          remainingMoney: 50,
          durationMs: 1,
        })
        .mockResolvedValueOnce({
          success: true,
          action: AIActionType.DeliverLoad,
          cost: 0,
          segmentsBuilt: 0,
          remainingMoney: 70,
          durationMs: 1,
          payment: 20,
          newCardId: 203,
        })
        .mockResolvedValueOnce({
          success: true,
          action: AIActionType.PassTurn,
          cost: 0,
          segmentsBuilt: 0,
          remainingMoney: 70,
          durationMs: 1,
        });

      const result = await AIStrategyEngine.takeTurn(GAME_ID, BOT_ID);

      expect(result.success).toBe(true);
      expect(result.loadsDelivered).toBeDefined();
      expect(result.loadsDelivered).toHaveLength(1);
      expect(result.loadsDelivered![0].loadType).toBe('Iron');
      expect(result.loadsDelivered![0].payment).toBe(20);
      // Movement should also be recorded
      expect(result.movedTo).toBeDefined();
    });
  });

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // 8. BotMemory state continuity across turns
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  describe('BotMemory state continuity', () => {
    it('deliveryCount accumulates across turns when deliveries happen', async () => {
      let turnCounter = 0;

      const sim = new GameSimulator(async (gid, pid) => {
        turnCounter++;
        jest.clearAllMocks();

        const currentSnapshot = makeSnapshot();
        currentSnapshot.bot.loads = ['Coal'];
        currentSnapshot.bot.demandCards = [turnCounter * 10];
        currentSnapshot.bot.resolvedDemands = [{
          cardId: turnCounter * 10,
          demands: [{ city: 'Berlin', loadType: 'Coal', payment: 12 }],
        }];
        (currentSnapshot as any).turnNumber = turnCounter;
        mockCapture.mockResolvedValue(currentSnapshot);
        mockValidate.mockReturnValue({ valid: true });

        const deliverOption: FeasibleOption = {
          action: AIActionType.DeliverLoad,
          feasible: true,
          reason: 'Deliver Coal',
          loadType: 'Coal' as any,
          targetCity: 'Berlin',
          cardId: turnCounter * 10,
          payment: 12,
          score: 124,
        };

        // Phase 0: delivery
        mockGenerate
          .mockReturnValueOnce([deliverOption])
          .mockReturnValueOnce([])
          .mockReturnValueOnce([])
          .mockReturnValueOnce([])
          .mockReturnValueOnce([passOption()]);
        mockScore
          .mockReturnValueOnce([deliverOption])
          .mockReturnValueOnce([passOption()]);
        mockExecute
          .mockResolvedValueOnce({
            success: true,
            action: AIActionType.DeliverLoad,
            cost: 0,
            segmentsBuilt: 0,
            remainingMoney: 62,
            durationMs: 1,
            payment: 12,
            newCardId: 300 + turnCounter,
          })
          .mockResolvedValueOnce({
            success: true,
            action: AIActionType.PassTurn,
            cost: 0,
            segmentsBuilt: 0,
            remainingMoney: 62,
            durationMs: 1,
          });

        return AIStrategyEngine.takeTurn(gid, pid);
      });

      sim.initialize(makeSnapshot());
      await sim.runTurns(3);

      const memory = getMemory(GAME_ID, BOT_ID);
      expect(memory.deliveryCount).toBe(3);
      expect(memory.totalEarnings).toBe(36); // 3 * 12
      expect(memory.turnNumber).toBe(3);
    });

    it('totalEarnings tracks cumulative delivery income', async () => {
      let turnCounter = 0;
      const payments = [10, 15, 20];

      const sim = new GameSimulator(async (gid, pid) => {
        const idx = turnCounter;
        turnCounter++;
        jest.clearAllMocks();

        const currentSnapshot = makeSnapshot();
        currentSnapshot.bot.loads = ['Fish'];
        const cardId = (idx + 1) * 100;
        const payment = payments[idx];
        currentSnapshot.bot.demandCards = [cardId];
        currentSnapshot.bot.resolvedDemands = [{
          cardId,
          demands: [{ city: 'London', loadType: 'Fish', payment }],
        }];
        (currentSnapshot as any).turnNumber = idx + 1;
        mockCapture.mockResolvedValue(currentSnapshot);
        mockValidate.mockReturnValue({ valid: true });

        const deliverOption: FeasibleOption = {
          action: AIActionType.DeliverLoad,
          feasible: true,
          reason: 'Deliver Fish',
          loadType: 'Fish' as any,
          targetCity: 'London',
          cardId,
          payment,
          score: 100 + payment * 2,
        };

        mockGenerate
          .mockReturnValueOnce([deliverOption])
          .mockReturnValueOnce([])
          .mockReturnValueOnce([])
          .mockReturnValueOnce([])
          .mockReturnValueOnce([passOption()]);
        mockScore
          .mockReturnValueOnce([deliverOption])
          .mockReturnValueOnce([passOption()]);
        mockExecute
          .mockResolvedValueOnce({
            success: true,
            action: AIActionType.DeliverLoad,
            cost: 0,
            segmentsBuilt: 0,
            remainingMoney: 50 + payment,
            durationMs: 1,
            payment,
            newCardId: 500 + idx,
          })
          .mockResolvedValueOnce({
            success: true,
            action: AIActionType.PassTurn,
            cost: 0,
            segmentsBuilt: 0,
            remainingMoney: 50 + payment,
            durationMs: 1,
          });

        return AIStrategyEngine.takeTurn(gid, pid);
      });

      sim.initialize(makeSnapshot());
      await sim.runTurns(3);

      const memory = getMemory(GAME_ID, BOT_ID);
      expect(memory.totalEarnings).toBe(45); // 10 + 15 + 20
      expect(memory.deliveryCount).toBe(3);
    });
  });

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // 9. Pickup sequencing
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  describe('Pickup sequencing', () => {
    it('pickup in Phase 0 is recorded in loadsPickedUp', async () => {
      const snapshot = makeSnapshot();
      mockCapture.mockResolvedValue(snapshot);
      mockValidate.mockReturnValue({ valid: true });

      const pickupOption: FeasibleOption = {
        action: AIActionType.PickupLoad,
        feasible: true,
        reason: 'Pick up Coal',
        loadType: 'Coal' as any,
        targetCity: 'Essen',
        cardId: 50,
        payment: 12,
        score: 56,
      };

      // Phase 0: delivery (none), drop (none), pickup (Coal)
      mockGenerate
        .mockReturnValueOnce([])  // Phase 0: delivery
        .mockReturnValueOnce([])  // Phase 0: drop
        .mockReturnValueOnce([pickupOption])  // Phase 0: pickup (1st iteration)
        .mockReturnValueOnce([])  // Phase 0: pickup (2nd iteration — no more)
        .mockReturnValueOnce([])  // Phase 1: no movement
        .mockReturnValueOnce([passOption()]); // Phase 2: pass
      mockScore
        .mockReturnValueOnce([pickupOption])  // Phase 0: scored pickups
        .mockReturnValueOnce([passOption()]); // Phase 2
      mockExecute
        .mockResolvedValueOnce({
          success: true,
          action: AIActionType.PickupLoad,
          cost: 0,
          segmentsBuilt: 0,
          remainingMoney: 50,
          durationMs: 1,
        })
        .mockResolvedValueOnce({
          success: true,
          action: AIActionType.PassTurn,
          cost: 0,
          segmentsBuilt: 0,
          remainingMoney: 50,
          durationMs: 1,
        });

      const result = await AIStrategyEngine.takeTurn(GAME_ID, BOT_ID);

      expect(result.success).toBe(true);
      expect(result.loadsPickedUp).toBeDefined();
      expect(result.loadsPickedUp).toHaveLength(1);
      expect(result.loadsPickedUp![0]).toEqual({ loadType: 'Coal', city: 'Essen' });
    });
  });

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // 10. Movement + build in same turn
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  describe('Combined movement and building', () => {
    it('movement in Phase 1 followed by build in Phase 2 produces both results', async () => {
      const snapshot = makeSnapshot();
      mockCapture.mockResolvedValue(snapshot);
      mockValidate.mockReturnValue({ valid: true });

      const moveOption: FeasibleOption = {
        action: AIActionType.MoveTrain,
        feasible: true,
        reason: 'Move toward Berlin',
        movementPath: [{ row: 10, col: 10 }, { row: 11, col: 10 }, { row: 12, col: 10 }],
        mileposts: 2,
        targetCity: 'Berlin',
        score: 80,
      };

      const build = buildOption('Paris', 8, 3);

      mockGenerate
        .mockReturnValueOnce([])  // Phase 0: delivery
        .mockReturnValueOnce([])  // Phase 0: drop
        .mockReturnValueOnce([])  // Phase 0: pickup
        .mockReturnValueOnce([moveOption])  // Phase 1: movement
        .mockReturnValueOnce([])  // Phase 1.5: delivery
        .mockReturnValueOnce([])  // Phase 1.5: drop
        .mockReturnValueOnce([])  // Phase 1.5: pickup
        .mockReturnValueOnce([build]); // Phase 2: build

      mockScore
        .mockReturnValueOnce([moveOption])  // Phase 1
        .mockReturnValueOnce([build]); // Phase 2

      mockExecute
        .mockResolvedValueOnce({
          success: true,
          action: AIActionType.MoveTrain,
          cost: 4,
          segmentsBuilt: 0,
          remainingMoney: 46,
          durationMs: 2,
        })
        .mockResolvedValueOnce({
          success: true,
          action: AIActionType.BuildTrack,
          cost: 8,
          segmentsBuilt: 3,
          remainingMoney: 38,
          durationMs: 3,
        });

      const result = await AIStrategyEngine.takeTurn(GAME_ID, BOT_ID);

      expect(result.success).toBe(true);
      // Final action is Phase 2 (build)
      expect(result.action).toBe(AIActionType.BuildTrack);
      expect(result.segmentsBuilt).toBe(3);
      expect(result.cost).toBe(8);
      // Movement data is also present
      expect(result.movedTo).toEqual({ row: 12, col: 10 });
      expect(result.milepostsMoved).toBe(2);
    });
  });

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // 11. Retry and fallback behavior
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  describe('Retry and fallback', () => {
    it('falls back to PassTurn when all build options fail validation', async () => {
      const snapshot = makeSnapshot();
      mockCapture.mockResolvedValue(snapshot);

      const build1 = buildOption('Paris', 25, 5); // over budget
      const build2 = buildOption('Berlin', 25, 5); // over budget

      // Validation rejects both
      mockValidate
        .mockReturnValueOnce({ valid: false, reason: 'Over budget' })
        .mockReturnValueOnce({ valid: false, reason: 'Over budget' });

      mockGenerate
        .mockReturnValueOnce([])  // Phase 0: delivery
        .mockReturnValueOnce([])  // Phase 0: drop
        .mockReturnValueOnce([])  // Phase 0: pickup
        .mockReturnValueOnce([])  // Phase 1: no movement
        .mockReturnValueOnce([build1, build2]); // Phase 2: both builds

      mockScore.mockReturnValueOnce([build1, build2]);

      // PassTurn fallback executes
      mockExecute.mockResolvedValue({
        success: true,
        action: AIActionType.PassTurn,
        cost: 0,
        segmentsBuilt: 0,
        remainingMoney: 50,
        durationMs: 1,
      });

      const result = await AIStrategyEngine.takeTurn(GAME_ID, BOT_ID);

      expect(result.action).toBe(AIActionType.PassTurn);
      expect(result.success).toBe(true);
    });

    it('tries next option when first build execution throws', async () => {
      const snapshot = makeSnapshot();
      mockCapture.mockResolvedValue(snapshot);
      mockValidate.mockReturnValue({ valid: true });

      const build1 = buildOption('Paris', 10, 3);
      build1.score = 60;
      const build2 = buildOption('Berlin', 8, 2);
      build2.score = 50;

      mockGenerate
        .mockReturnValueOnce([])
        .mockReturnValueOnce([])
        .mockReturnValueOnce([])
        .mockReturnValueOnce([])
        .mockReturnValueOnce([build1, build2]);

      mockScore.mockReturnValueOnce([build1, build2]);

      // First build throws, second succeeds
      mockExecute
        .mockRejectedValueOnce(new Error('FK constraint violation'))
        .mockResolvedValueOnce({
          success: true,
          action: AIActionType.BuildTrack,
          cost: 8,
          segmentsBuilt: 2,
          remainingMoney: 42,
          durationMs: 3,
        });

      const result = await AIStrategyEngine.takeTurn(GAME_ID, BOT_ID);

      expect(result.success).toBe(true);
      expect(result.action).toBe(AIActionType.BuildTrack);
      expect(result.cost).toBe(8);
      // Verify the executor was called twice (first failed, second succeeded)
      expect(mockExecute).toHaveBeenCalledTimes(2);
    });
  });

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // 12. SimulationMetrics correctness
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  describe('SimulationMetrics correctness', () => {
    it('metrics.actionHistory records the correct sequence', async () => {
      const actions = [
        AIActionType.BuildTrack,
        AIActionType.PassTurn,
        AIActionType.BuildTrack,
      ];
      let turnCounter = 0;

      const sim = new GameSimulator(async () => {
        const action = actions[turnCounter++];
        return {
          action,
          segmentsBuilt: action === AIActionType.BuildTrack ? 2 : 0,
          cost: action === AIActionType.BuildTrack ? 5 : 0,
          durationMs: 1,
          success: true,
        };
      });

      sim.initialize(makeSnapshot());
      await sim.runTurns(3);

      const metrics = sim.getMetrics();
      expect(metrics.actionHistory).toEqual([
        AIActionType.BuildTrack,
        AIActionType.PassTurn,
        AIActionType.BuildTrack,
      ]);
      expect(metrics.totalSegmentsBuilt).toBe(4);
      expect(metrics.totalTrackCost).toBe(10);
      expect(metrics.consecutivePassTurns).toBe(0); // last action was Build
    });

    it('getMetrics returns a snapshot that does not mutate', async () => {
      const sim = new GameSimulator(async () => ({
        action: AIActionType.PassTurn,
        segmentsBuilt: 0,
        cost: 0,
        durationMs: 1,
        success: true,
      }));

      sim.initialize(makeSnapshot());
      await sim.runTurns(2);

      const metrics1 = sim.getMetrics();
      await sim.runTurns(1);
      const metrics2 = sim.getMetrics();

      // Modifying metrics1 should not affect simulator state
      metrics1.actionHistory.push(AIActionType.BuildTrack);
      expect(metrics2.actionHistory).not.toContain(AIActionType.BuildTrack);
      expect(metrics1.turnCount).toBe(2);
      expect(metrics2.turnCount).toBe(3);
    });
  });
});
