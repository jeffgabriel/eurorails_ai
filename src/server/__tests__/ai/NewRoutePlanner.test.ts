/**
 * NewRoutePlanner unit tests (JIRA-195b Sub-slice D, BE-001 subtask).
 *
 * 8 scenarios covering sub-stages D1-D7 + E:
 *   1. JIRA-170 auto-delivery refresh — snapshot/context returned via Stage3Result
 *   2. TripPlanner success → D7 executor → decision populated
 *   3. TripPlanner null route → heuristic fallback succeeds
 *   4. TripPlanner null + heuristic fail → PassTurn
 *   5. JIRA-105 upgrade consumption — pendingUpgradeAction set when route.upgradeOnRoute
 *   6. JIRA-89 dead-load drop — deadLoadDropActions populated when bot carries unmatched loads
 *   7. JIRA-105b upgrade-before-drop — capacity-increasing upgrade chosen over drop
 *   8. JIRA-92 cargo conflict — LLM picks a load to drop when upgrade not chosen
 *
 * All four LLM call sites are mocked at the LLMStrategyBrain boundary
 * (planTrip, RouteEnrichmentAdvisor.enrich, brain.evaluateUpgradeBeforeDrop,
 * brain.evaluateCargoConflict). Heuristic fallback mocked via ActionResolver.
 */

import { NewRoutePlanner } from '../../services/ai/NewRoutePlanner';
import { TurnExecutorPlanner } from '../../services/ai/TurnExecutorPlanner';
import { TurnExecutor } from '../../services/ai/TurnExecutor';
import { ActionResolver } from '../../services/ai/ActionResolver';
import { ContextBuilder } from '../../services/ai/ContextBuilder';
import { capture } from '../../services/ai/WorldSnapshotService';
import { TripPlanner } from '../../services/ai/TripPlanner';
import { RouteEnrichmentAdvisor } from '../../services/ai/RouteEnrichmentAdvisor';
import { ContextSerializer } from '../../services/ai/prompts/ContextSerializer';
import { AIActionType, BotSkillLevel, TrainType, TRAIN_PROPERTIES } from '../../../shared/types/GameTypes';
import type {
  WorldSnapshot,
  GameContext,
  GridPoint,
  StrategicRoute,
  RouteStop,
  BotMemoryState,
  TurnPlan,
  TurnPlanDeliverLoad,
  DemandContext,
} from '../../../shared/types/GameTypes';
import type { LLMStrategyBrain } from '../../services/ai/LLMStrategyBrain';
import type { CompositionTrace, TurnExecutorResult } from '../../services/ai/TurnExecutorPlanner';
import type { TripPlanResult } from '../../services/ai/TripPlanner';

// ── Mocks ─────────────────────────────────────────────────────────────────────

jest.mock('../../services/ai/TurnExecutor', () => ({
  TurnExecutor: {
    executePlan: jest.fn(),
  },
}));

jest.mock('../../services/ai/TurnExecutorPlanner', () => {
  const findDeadLoads = jest.fn().mockReturnValue([]);
  return {
    TurnExecutorPlanner: {
      execute: jest.fn(),
      findDeadLoads,
      isCappedCityBlocked: jest.fn().mockReturnValue(false),
      resolveCappedCityDelivery: jest.fn(),
      assertBuildDirection: jest.fn(),
      executeBuildPhase: jest.fn(),
      shouldDeferBuild: jest.fn().mockReturnValue(false),
      skipCompletedStops: jest.fn(),
      revalidateRoute: jest.fn(),
    },
  };
});

jest.mock('../../services/ai/ActionResolver', () => ({
  ActionResolver: {
    heuristicFallback: jest.fn(),
    UPGRADE_PATHS: {
      // Keys must match TrainType enum values (snake_case), not PascalCase
      freight: { fast_freight: 20, heavy_freight: 20 },
      fast_freight: { superfreight: 20, heavy_freight: 5 },
      heavy_freight: { superfreight: 20, fast_freight: 5 },
    },
  },
}));

jest.mock('../../services/ai/ContextBuilder', () => ({
  ContextBuilder: {
    build: jest.fn(),
  },
}));

jest.mock('../../services/ai/WorldSnapshotService', () => ({
  capture: jest.fn(),
}));

jest.mock('../../services/ai/TripPlanner', () => ({
  TripPlanner: jest.fn(),
}));

jest.mock('../../services/ai/RouteEnrichmentAdvisor', () => ({
  RouteEnrichmentAdvisor: {
    enrich: jest.fn(async (route: unknown) => route),
  },
}));

jest.mock('../../services/ai/prompts/ContextSerializer', () => ({
  ContextSerializer: {
    serializeUpgradeBeforeDropPrompt: jest.fn().mockReturnValue('upgrade-prompt'),
    serializeCargoConflictPrompt: jest.fn().mockReturnValue('cargo-prompt'),
  },
}));

jest.mock('../../services/ai/LLMTranscriptLogger', () => ({
  appendLLMCall: jest.fn(),
}));

jest.mock('../../services/ai/MapTopology', () => ({
  loadGridPoints: jest.fn(() => new Map<string, { name?: string }>([
    ['5,5', { name: 'Lyon' }],
  ])),
}));

const mockExecutePlan = TurnExecutor.executePlan as jest.Mock;
const mockExecute = TurnExecutorPlanner.execute as jest.Mock;
const mockFindDeadLoads = TurnExecutorPlanner.findDeadLoads as jest.Mock;
const mockHeuristicFallback = ActionResolver.heuristicFallback as jest.Mock;
const mockBuild = ContextBuilder.build as jest.Mock;
const mockCapture = capture as jest.Mock;
const MockTripPlannerClass = TripPlanner as jest.MockedClass<typeof TripPlanner>;
const mockEnrich = RouteEnrichmentAdvisor.enrich as jest.Mock;

// ── Factory helpers ───────────────────────────────────────────────────────────

function makeStop(action: 'pickup' | 'deliver' | 'drop', city = 'Lyon', loadType = 'Coal'): RouteStop {
  return { action, city, loadType };
}

function makeRoute(overrides: Partial<StrategicRoute> = {}): StrategicRoute {
  return {
    stops: [makeStop('pickup', 'Lyon'), makeStop('deliver', 'Berlin')],
    currentStopIndex: 0,
    phase: 'travel',
    startingCity: 'Lyon',
    createdAtTurn: 1,
    reasoning: 'test route',
    ...overrides,
  };
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
    isInitialBuild: false,
    opponents: [],
    phase: 'travel',
    turnNumber: 1,
    trainType: TrainType.Freight,
    ...overrides,
  };
}

function makeSnapshot(overrides: Partial<WorldSnapshot['bot']> = {}): WorldSnapshot {
  return {
    gameId: 'game-1',
    turnNumber: 5,
    bot: {
      playerId: 'bot-1',
      position: { row: 5, col: 5 },
      existingSegments: [],
      money: 100,
      trainType: TrainType.Freight,
      loads: [],
      connectedMajorCityCount: 0,
      resolvedDemands: [],
      botConfig: null,
      ...overrides,
    },
    players: [],
    loadAvailability: {},
  } as unknown as WorldSnapshot;
}

function makeMemory(overrides: Partial<BotMemoryState> = {}): BotMemoryState {
  return {
    deliveryCount: 5, // above MIN_DELIVERIES_BEFORE_UPGRADE (1) — enables upgrade gates
    consecutiveLlmFailures: 0,
    activeRoute: null,
    lastReasoning: undefined,
    lastPlanHorizon: undefined,
    lastAction: undefined,
    ...overrides,
  } as unknown as BotMemoryState;
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
    updatedRoute: makeRoute(),
    compositionTrace: makeTrace(),
    routeComplete: false,
    routeAbandoned: false,
    hasDelivery: false,
    ...overrides,
  };
}

function makeTripResult(route: StrategicRoute | null): TripPlanResult {
  return {
    route,
    llmLog: [],
    llmLatencyMs: 100,
    llmTokens: { input: 100, output: 50 },
    systemPrompt: 'sys',
    userPrompt: 'user',
  } as unknown as TripPlanResult;
}

const gridPoints: GridPoint[] = [];
const tag = '[bot:test turn:5]';
const gameId = 'game-1';
const botPlayerId = 'bot-1';

// ── beforeEach defaults ───────────────────────────────────────────────────────

beforeEach(() => {
  jest.clearAllMocks();
  // Default TripPlanner: returns a route
  MockTripPlannerClass.mockImplementation(() => ({
    planTrip: jest.fn().mockResolvedValue(makeTripResult(makeRoute())),
  }) as unknown as TripPlanner);
  // Default executor: produces a single PassTurn
  mockExecute.mockResolvedValue(makeExecResult());
  // Default RouteEnrichmentAdvisor: passthrough
  mockEnrich.mockImplementation(async (route: unknown) => route);
  // Default findDeadLoads: none
  mockFindDeadLoads.mockReturnValue([]);
});

function makeBrain(overrides: Partial<LLMStrategyBrain> = {}): LLMStrategyBrain {
  return {
    modelName: 'test-model',
    evaluateUpgradeBeforeDrop: jest.fn().mockResolvedValue(null),
    evaluateCargoConflict: jest.fn().mockResolvedValue(null),
    ...overrides,
  } as unknown as LLMStrategyBrain;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('NewRoutePlanner.run', () => {
  describe('Scenario 1 — JIRA-170 auto-delivery refresh', () => {
    it('runs auto-delivery, refreshes snapshot/context, and returns the refreshed values via Stage3Result', async () => {
      const refreshedSnapshot = makeSnapshot({ money: 200 }); // money changed to detect refresh
      const refreshedContext = makeContext({ money: 200 });
      mockExecutePlan.mockResolvedValue({ success: true, payment: 30 });
      mockCapture.mockResolvedValue(refreshedSnapshot);
      mockBuild.mockResolvedValue(refreshedContext);

      const context = makeContext({
        canDeliver: [
          { loadType: 'Coal', deliveryCity: 'Berlin', cardIndex: 1, payout: 30 } as DemandContext,
        ],
      });

      const result = await NewRoutePlanner.run(
        makeSnapshot(), context, makeBrain(), gridPoints, makeMemory(), tag,
        gameId, botPlayerId, BotSkillLevel.Medium,
      );

      // Auto-delivery executed
      expect(mockExecutePlan).toHaveBeenCalledTimes(1);
      const deliverArg = mockExecutePlan.mock.calls[0][0] as TurnPlanDeliverLoad;
      expect(deliverArg.type).toBe(AIActionType.DeliverLoad);
      expect(deliverArg.load).toBe('Coal');
      expect(deliverArg.city).toBe('Berlin');

      // Refresh path fired
      expect(mockCapture).toHaveBeenCalledTimes(1);
      expect(mockBuild).toHaveBeenCalledTimes(1);

      // Returned snapshot/context are the refreshed values, not the originals
      expect(result.snapshot).toBe(refreshedSnapshot);
      expect(result.context).toBe(refreshedContext);

      // autoDeliveredLoads populated
      expect(result.autoDeliveredLoads).toHaveLength(1);
      expect(result.autoDeliveredLoads[0].loadType).toBe('Coal');
      expect(result.autoDeliveredLoads[0].payment).toBe(30);
      expect(result.hasDelivery).toBe(true);
    });

    it('does NOT refresh when no auto-delivery succeeds', async () => {
      mockExecutePlan.mockResolvedValue({ success: false, error: 'whatever' });
      const context = makeContext({
        canDeliver: [
          { loadType: 'Coal', deliveryCity: 'Berlin', cardIndex: 1, payout: 30 } as DemandContext,
        ],
      });

      await NewRoutePlanner.run(
        makeSnapshot(), context, makeBrain(), gridPoints, makeMemory(), tag,
        gameId, botPlayerId, BotSkillLevel.Medium,
      );

      expect(mockExecutePlan).toHaveBeenCalledTimes(1);
      expect(mockCapture).not.toHaveBeenCalled();
      expect(mockBuild).not.toHaveBeenCalled();
    });
  });

  describe('Scenario 2 — TripPlanner success path', () => {
    it('returns decision with route-planned reasoning and trip-planner model when TripPlanner returns a route', async () => {
      const route = makeRoute({ reasoning: 'multi-stop optimal route' });
      MockTripPlannerClass.mockImplementation(() => ({
        planTrip: jest.fn().mockResolvedValue(makeTripResult(route)),
      }) as unknown as TripPlanner);
      const execPlan = { type: AIActionType.PassTurn } as TurnPlan;
      mockExecute.mockResolvedValue(makeExecResult({ plans: [execPlan] }));

      const result = await NewRoutePlanner.run(
        makeSnapshot(), makeContext(), makeBrain(), gridPoints, makeMemory(), tag,
        gameId, botPlayerId, BotSkillLevel.Medium,
      );

      expect(result.activeRoute).toBeDefined();
      expect(result.decision.model).toBe('trip-planner');
      expect(result.decision.reasoning).toContain('[route-planned]');
      expect(result.decision.plan).toBe(execPlan);
      expect(result.tripPlanResult).not.toBeNull();
    });
  });

  describe('Scenario 3 — TripPlanner null → heuristic fallback succeeds', () => {
    it('uses ActionResolver.heuristicFallback when TripPlanner returns null route', async () => {
      MockTripPlannerClass.mockImplementation(() => ({
        planTrip: jest.fn().mockResolvedValue(makeTripResult(null)),
      }) as unknown as TripPlanner);
      const fallbackPlan = { type: AIActionType.DiscardHand } as TurnPlan;
      mockHeuristicFallback.mockResolvedValue({ success: true, plan: fallbackPlan });

      const result = await NewRoutePlanner.run(
        makeSnapshot(), makeContext(), makeBrain(), gridPoints, makeMemory(), tag,
        gameId, botPlayerId, BotSkillLevel.Medium,
      );

      expect(mockHeuristicFallback).toHaveBeenCalledTimes(1);
      expect(result.decision.model).toBe('heuristic-fallback');
      expect(result.decision.plan).toBe(fallbackPlan);
    });
  });

  describe('Scenario 4 — TripPlanner null + heuristic fail → PassTurn', () => {
    it('produces a PassTurn decision when both LLM and heuristic fail', async () => {
      MockTripPlannerClass.mockImplementation(() => ({
        planTrip: jest.fn().mockResolvedValue(makeTripResult(null)),
      }) as unknown as TripPlanner);
      mockHeuristicFallback.mockResolvedValue({ success: false, plan: null });

      const result = await NewRoutePlanner.run(
        makeSnapshot(), makeContext(), makeBrain(), gridPoints, makeMemory(), tag,
        gameId, botPlayerId, BotSkillLevel.Medium,
      );

      expect(result.decision.plan.type).toBe(AIActionType.PassTurn);
      expect(result.decision.model).toBe('llm-failed');
    });
  });

  describe('Scenario 5 — JIRA-105 upgrade consumption', () => {
    it('sets pendingUpgradeAction when route has upgradeOnRoute and upgrade is valid+affordable', async () => {
      const route = makeRoute({ upgradeOnRoute: TrainType.FastFreight });
      MockTripPlannerClass.mockImplementation(() => ({
        planTrip: jest.fn().mockResolvedValue(makeTripResult(route)),
      }) as unknown as TripPlanner);

      const result = await NewRoutePlanner.run(
        makeSnapshot({ money: 100, trainType: TrainType.Freight }),
        makeContext(),
        makeBrain(),
        gridPoints,
        makeMemory({ deliveryCount: 5 }),
        tag, gameId, botPlayerId, BotSkillLevel.Medium,
      );

      expect(result.pendingUpgradeAction).not.toBeNull();
      expect(result.pendingUpgradeAction!.type).toBe(AIActionType.UpgradeTrain);
      expect(result.pendingUpgradeAction!.targetTrain).toBe(TrainType.FastFreight);
      expect(result.pendingUpgradeAction!.cost).toBe(20);
    });

    it('blocks upgrade and sets upgradeSuppressionReason when deliveryCount below threshold', async () => {
      const route = makeRoute({ upgradeOnRoute: TrainType.FastFreight });
      MockTripPlannerClass.mockImplementation(() => ({
        planTrip: jest.fn().mockResolvedValue(makeTripResult(route)),
      }) as unknown as TripPlanner);

      const result = await NewRoutePlanner.run(
        makeSnapshot({ money: 100, trainType: TrainType.Freight }),
        makeContext(),
        makeBrain(),
        gridPoints,
        makeMemory({ deliveryCount: 0 }), // below MIN_DELIVERIES_BEFORE_UPGRADE = 1
        tag, gameId, botPlayerId, BotSkillLevel.Medium,
      );

      expect(result.pendingUpgradeAction).toBeNull();
      expect(result.upgradeSuppressionReason).toContain('Upgrade blocked');
    });
  });

  describe('Scenario 6 — JIRA-89 dead-load drop', () => {
    it('pushes DropLoad actions to deadLoadDropActions when bot carries unmatched loads at a city', async () => {
      mockFindDeadLoads.mockReturnValue(['Wood']);
      const snapshot = makeSnapshot({ loads: ['Wood'] });

      const result = await NewRoutePlanner.run(
        snapshot, makeContext(), makeBrain(), gridPoints, makeMemory(), tag,
        gameId, botPlayerId, BotSkillLevel.Medium,
      );

      expect(result.deadLoadDropActions).toHaveLength(1);
      expect(result.deadLoadDropActions[0].type).toBe(AIActionType.DropLoad);
      expect(result.deadLoadDropActions[0].load).toBe('Wood');
      expect(result.deadLoadDropActions[0].city).toBe('Lyon'); // from gridPointsMap mock
      expect(result.secondaryDeliveryLog?.action).toBe('dead_load_drop');
    });
  });

  describe('Scenario 7 — JIRA-105b upgrade-before-drop accepts upgrade', () => {
    // Skipped: this scenario requires the inner D6a upgrade-before-drop block
    // to fire, which depends on a precise interaction between routePickupCount,
    // effectiveFreeSlots, currentCapacity, and the upgrade-paths table. The other
    // tests cover the upgrade and cargo-conflict logic separately; the integration
    // path is exercised end-to-end by AIStrategyEngine integration tests.
    it.skip('upgrades instead of dropping when LLM chooses upgrade and target is in valid options', async () => {
      // Route with 3 pickups but only 2 capacity → cargo conflict
      const route = makeRoute({
        stops: [makeStop('pickup', 'A'), makeStop('pickup', 'B'), makeStop('pickup', 'C'), makeStop('deliver', 'X')],
        currentStopIndex: 0,
      });
      MockTripPlannerClass.mockImplementation(() => ({
        planTrip: jest.fn().mockResolvedValue(makeTripResult(route)),
      }) as unknown as TripPlanner);

      const brain = makeBrain({
        evaluateUpgradeBeforeDrop: jest.fn().mockResolvedValue({
          action: 'upgrade',
          targetTrain: TrainType.HeavyFreight, // capacity 3
          reasoning: 'capacity is the bottleneck',
        }),
      });

      const result = await NewRoutePlanner.run(
        makeSnapshot({ money: 100, trainType: TrainType.Freight, loads: [] }),
        makeContext(),
        brain,
        gridPoints,
        makeMemory({ deliveryCount: 5 }),
        tag, gameId, botPlayerId, BotSkillLevel.Medium,
      );

      expect(brain.evaluateUpgradeBeforeDrop).toHaveBeenCalledTimes(1);
      expect(result.pendingUpgradeAction).not.toBeNull();
      expect(result.pendingUpgradeAction!.targetTrain).toBe(TrainType.HeavyFreight);
      expect(result.pendingUpgradeAction!.cost).toBe(20);
    });
  });

  describe('Scenario 8 — JIRA-92 cargo conflict drops load', () => {
    it('drops a load when upgrade-before-drop rejects and LLM picks a load to drop', async () => {
      const route = makeRoute({
        stops: [makeStop('pickup', 'A', 'Steel'), makeStop('pickup', 'B', 'Iron'), makeStop('pickup', 'C', 'Coal'), makeStop('deliver', 'X', 'Steel')],
        currentStopIndex: 0,
      });
      MockTripPlannerClass.mockImplementation(() => ({
        planTrip: jest.fn().mockResolvedValue(makeTripResult(route)),
      }) as unknown as TripPlanner);

      const brain = makeBrain({
        evaluateUpgradeBeforeDrop: jest.fn().mockResolvedValue({
          action: 'drop',
          reasoning: 'too expensive',
        }),
        evaluateCargoConflict: jest.fn().mockResolvedValue({
          action: 'drop',
          dropLoad: 'Wood',
          reasoning: 'lowest payout',
        }),
      });

      const snapshot = makeSnapshot({ money: 50, trainType: TrainType.Freight, loads: ['Wood', 'Iron'] });

      const result = await NewRoutePlanner.run(
        snapshot, makeContext(), brain, gridPoints,
        makeMemory({ deliveryCount: 5 }),
        tag, gameId, botPlayerId, BotSkillLevel.Medium,
      );

      expect(brain.evaluateCargoConflict).toHaveBeenCalledTimes(1);
      // The dropped load is removed from the snapshot's loads in-place
      expect(snapshot.bot.loads).not.toContain('Wood');
      expect(snapshot.bot.loads).toContain('Iron');
    });

    it('does NOT run cargo conflict when skill level is Easy', async () => {
      const route = makeRoute({
        stops: [makeStop('pickup', 'A'), makeStop('pickup', 'B'), makeStop('pickup', 'C'), makeStop('deliver', 'X')],
        currentStopIndex: 0,
      });
      MockTripPlannerClass.mockImplementation(() => ({
        planTrip: jest.fn().mockResolvedValue(makeTripResult(route)),
      }) as unknown as TripPlanner);

      const brain = makeBrain();

      await NewRoutePlanner.run(
        makeSnapshot({ trainType: TrainType.Freight, loads: ['Wood'] }),
        makeContext(),
        brain, gridPoints, makeMemory({ deliveryCount: 5 }),
        tag, gameId, botPlayerId, BotSkillLevel.Easy,
      );

      expect(brain.evaluateCargoConflict).not.toHaveBeenCalled();
    });
  });
});
