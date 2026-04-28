/**
 * InitialBuildRunner unit tests (JIRA-195b Sub-slice C, BE-003).
 *
 * Covers:
 *   1. Success — initial-build branch returns activeRoute+decision+execCompositionTrace
 *      shaped per the partial Stage3Result contract.
 *   2. JIRA-148 demand-score injection — context.demands flows into the demandScores
 *      Map passed to InitialBuildPlanner.planInitialBuild.
 *   3. Empty-plans fallback — when TurnExecutorPlanner returns no plans, decision.plan
 *      collapses to a BuildTrack with empty segments and a resolved targetCity.
 */

import { InitialBuildRunner } from '../../services/ai/InitialBuildRunner';
import { InitialBuildPlanner } from '../../services/ai/InitialBuildPlanner';
import { TurnExecutorPlanner } from '../../services/ai/TurnExecutorPlanner';
import { AIActionType } from '../../../shared/types/GameTypes';
import type {
  RouteStop,
  GameContext,
  WorldSnapshot,
  GridPoint,
  TurnPlan,
  InitialBuildPlan,
  BotMemoryState,
} from '../../../shared/types/GameTypes';
import type { LLMStrategyBrain } from '../../services/ai/LLMStrategyBrain';
import type { CompositionTrace, TurnExecutorResult } from '../../services/ai/TurnExecutorPlanner';

// ── Mock InitialBuildPlanner and TurnExecutorPlanner ─────────────────────────

jest.mock('../../services/ai/InitialBuildPlanner', () => ({
  InitialBuildPlanner: {
    planInitialBuild: jest.fn(),
  },
}));

jest.mock('../../services/ai/TurnExecutorPlanner', () => ({
  TurnExecutorPlanner: {
    execute: jest.fn(),
    isCappedCityBlocked: jest.fn().mockReturnValue(false),
    resolveCappedCityDelivery: jest.fn(),
    assertBuildDirection: jest.fn(),
    executeBuildPhase: jest.fn(),
    shouldDeferBuild: jest.fn().mockReturnValue(false),
    skipCompletedStops: jest.fn(),
    revalidateRoute: jest.fn(),
  },
}));

const mockPlanInitialBuild = InitialBuildPlanner.planInitialBuild as jest.Mock;
const mockExecute = TurnExecutorPlanner.execute as jest.Mock;

// ── Factory helpers ───────────────────────────────────────────────────────────

function makeStop(action: 'pickup' | 'deliver', city = 'TestCity', loadType = 'Coal'): RouteStop {
  return { action, city, loadType };
}

function makeBuildPlan(overrides: Partial<InitialBuildPlan> = {}): InitialBuildPlan {
  return {
    route: [makeStop('pickup', 'Lyon', 'Coal'), makeStop('deliver', 'Berlin', 'Coal')],
    startingCity: 'Lyon',
    totalPayout: 30,
    totalBuildCost: 12,
    buildPriority: 'high-payoff Lyon→Berlin',
    ...overrides,
  } as InitialBuildPlan;
}

function makeContext(overrides: Partial<GameContext> = {}): GameContext {
  return {
    position: { row: 5, col: 5, city: 'Lyon' },
    money: 100,
    speed: 9,
    capacity: 2,
    loads: [],
    demands: [],
    citiesOnNetwork: [],
    connectedMajorCities: [],
    unconnectedMajorCities: [],
    totalMajorCities: 12,
    trackSummary: '',
    turnBuildCost: 0,
    canDeliver: [],
    canPickup: [],
    reachableCities: [],
    canUpgrade: false,
    canBuild: true,
    isInitialBuild: true,
    opponents: [],
    phase: 'build',
    turnNumber: 1,
    trainType: 'Freight',
    ...overrides,
  };
}

function makeSnapshot(): WorldSnapshot {
  return {
    bot: {
      playerId: 'bot-1',
      position: { row: 5, col: 5 },
      existingSegments: [],
      money: 100,
      trainType: 'Freight',
      loads: [],
      connectedMajorCityCount: 0,
    },
    players: [],
    loadAvailability: {},
    turnNumber: 1,
  } as unknown as WorldSnapshot;
}

function makeTrace(): CompositionTrace {
  return {
    inputPlan: [],
    outputPlan: [],
    moveBudget: { total: 9, used: 0, wasted: 0 },
    a1: { citiesScanned: 0, opportunitiesFound: 0 },
    a2: { iterations: 0, terminationReason: '' },
    a3: { movePreprended: false },
    build: { target: null, cost: 0, skipped: false, upgradeConsidered: false },
    pickups: [],
    deliveries: [],
  };
}

function makeExecResult(overrides: Partial<TurnExecutorResult> = {}): TurnExecutorResult {
  return {
    plans: [{ type: AIActionType.PassTurn }],
    updatedRoute: undefined as unknown as TurnExecutorResult['updatedRoute'],
    compositionTrace: makeTrace(),
    routeComplete: false,
    routeAbandoned: false,
    hasDelivery: false,
    ...overrides,
  };
}

function makeMemory(): BotMemoryState {
  return {
    deliveryCount: 0,
    activeRoute: null,
    lastReasoning: undefined,
    lastPlanHorizon: undefined,
    lastAction: undefined,
  } as unknown as BotMemoryState;
}

const gridPoints: GridPoint[] = [];
const brain: LLMStrategyBrain | null = null;
const tag = '[bot:test turn:1]';

beforeEach(() => {
  jest.clearAllMocks();
  // Default mocks — individual tests override
  mockPlanInitialBuild.mockReturnValue(makeBuildPlan());
  mockExecute.mockResolvedValue(makeExecResult());
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('InitialBuildRunner.run', () => {
  describe('success case — initial build planned and executed', () => {
    it('returns activeRoute, decision, and execCompositionTrace shaped per the partial Stage3Result', async () => {
      const buildPlan = makeBuildPlan({ startingCity: 'Lyon', buildPriority: 'high-payoff Lyon→Berlin' });
      mockPlanInitialBuild.mockReturnValue(buildPlan);
      const execResult = makeExecResult();
      mockExecute.mockResolvedValue(execResult);

      const result = await InitialBuildRunner.run(
        makeSnapshot(),
        makeContext(),
        brain,
        gridPoints,
        makeMemory(),
        tag,
      );

      // activeRoute is built from the planner output (always non-null from this branch)
      expect(result.activeRoute).not.toBeNull();
      const route = result.activeRoute!;
      expect(route.startingCity).toBe('Lyon');
      expect(route.phase).toBe('build');
      expect(route.currentStopIndex).toBe(0);
      expect(route.stops).toEqual(buildPlan.route);
      expect(route.reasoning).toBe('[initial-build-planner] high-payoff Lyon→Berlin');

      // decision is shaped as an LLMDecisionResult-like object with the initial-build model
      expect(result.decision.model).toBe('initial-build-planner');
      expect(result.decision.reasoning).toBe('[initial-build-planner] high-payoff Lyon→Berlin');
      expect(result.decision.planHorizon).toContain('Route:');

      // execCompositionTrace flows through from TurnExecutorPlanner
      expect(result.execCompositionTrace).toBe(execResult.compositionTrace);
    });

    it('collapses multiple TurnExecutorPlanner plans into a MultiAction step', async () => {
      const plan1 = { type: AIActionType.BuildTrack, segments: [], targetCity: 'Berlin' } as TurnPlan;
      const plan2 = { type: AIActionType.PassTurn } as TurnPlan;
      mockExecute.mockResolvedValue(makeExecResult({ plans: [plan1, plan2] }));

      const result = await InitialBuildRunner.run(
        makeSnapshot(),
        makeContext(),
        brain,
        gridPoints,
        makeMemory(),
        tag,
      );

      expect(result.decision.plan).toEqual({ type: 'MultiAction', steps: [plan1, plan2] });
    });

    it('returns the single plan unwrapped when TurnExecutorPlanner returns exactly one plan', async () => {
      const plan = { type: AIActionType.BuildTrack, segments: [], targetCity: 'Berlin' } as TurnPlan;
      mockExecute.mockResolvedValue(makeExecResult({ plans: [plan] }));

      const result = await InitialBuildRunner.run(
        makeSnapshot(),
        makeContext(),
        brain,
        gridPoints,
        makeMemory(),
        tag,
      );

      expect(result.decision.plan).toBe(plan);
    });
  });

  describe('JIRA-148 demand-score injection', () => {
    it('builds demandScores Map from context.demands and passes it to InitialBuildPlanner.planInitialBuild', async () => {
      const context = makeContext({
        demands: [
          { loadType: 'Coal', deliveryCity: 'Berlin', demandScore: 7.5 } as GameContext['demands'][number],
          { loadType: 'Iron', deliveryCity: 'Paris', demandScore: 4.2 } as GameContext['demands'][number],
        ],
      });

      await InitialBuildRunner.run(
        makeSnapshot(),
        context,
        brain,
        gridPoints,
        makeMemory(),
        tag,
      );

      expect(mockPlanInitialBuild).toHaveBeenCalledTimes(1);
      const callArgs = mockPlanInitialBuild.mock.calls[0];
      // Signature: planInitialBuild(snapshot, gridPoints, demandScores)
      const passedDemandScores = callArgs[2] as Map<string, number>;
      expect(passedDemandScores).toBeInstanceOf(Map);
      expect(passedDemandScores.get('Coal:Berlin')).toBe(7.5);
      expect(passedDemandScores.get('Iron:Paris')).toBe(4.2);
      expect(passedDemandScores.size).toBe(2);
    });

    it('passes an empty demandScores Map when context.demands is empty', async () => {
      await InitialBuildRunner.run(
        makeSnapshot(),
        makeContext({ demands: [] }),
        brain,
        gridPoints,
        makeMemory(),
        tag,
      );

      const passedDemandScores = mockPlanInitialBuild.mock.calls[0][2] as Map<string, number>;
      expect(passedDemandScores).toBeInstanceOf(Map);
      expect(passedDemandScores.size).toBe(0);
    });
  });

  describe('empty-plans fallback', () => {
    it('produces a BuildTrack plan with empty segments and resolved targetCity when TurnExecutorPlanner returns zero plans', async () => {
      // JIRA-145: targetCity should be the first non-starting-city stop, not the starting city itself.
      const buildPlan = makeBuildPlan({
        startingCity: 'Lyon',
        route: [makeStop('pickup', 'Lyon', 'Coal'), makeStop('deliver', 'Berlin', 'Coal')],
      });
      mockPlanInitialBuild.mockReturnValue(buildPlan);
      mockExecute.mockResolvedValue(makeExecResult({ plans: [] }));

      const result = await InitialBuildRunner.run(
        makeSnapshot(),
        makeContext(),
        brain,
        gridPoints,
        makeMemory(),
        tag,
      );

      expect(result.decision.plan).toEqual({
        type: AIActionType.BuildTrack,
        segments: [],
        targetCity: 'Berlin',
      });
    });

    it('falls back to startingCity for targetCity when all route stops are at the starting city', async () => {
      const buildPlan = makeBuildPlan({
        startingCity: 'Lyon',
        route: [makeStop('pickup', 'Lyon', 'Coal')],
      });
      mockPlanInitialBuild.mockReturnValue(buildPlan);
      mockExecute.mockResolvedValue(makeExecResult({ plans: [] }));

      const result = await InitialBuildRunner.run(
        makeSnapshot(),
        makeContext(),
        brain,
        gridPoints,
        makeMemory(),
        tag,
      );

      // Both fallbacks: route.find returns undefined → falls back to route[0]?.city → 'Lyon'
      expect((result.decision.plan as { targetCity?: string }).targetCity).toBe('Lyon');
    });
  });
});
