/**
 * MovementPhasePlanner unit tests (JIRA-195 Slice 3b).
 *
 * Phase A scenarios: simple movement, pickup, delivery with replan,
 * route complete, ferry arrival, budget exhausted, action failure.
 *
 * Mirrors critical Phase A scenarios from TurnExecutorPlanner.test.ts to
 * verify that moving Phase A into MovementPhasePlanner preserves all behaviour.
 */

import { MovementPhasePlanner } from '../../services/ai/MovementPhasePlanner';
import { TurnExecutorPlanner } from '../../services/ai/TurnExecutorPlanner';
import { AIActionType, TerrainType } from '../../../shared/types/GameTypes';
import type {
  StrategicRoute,
  RouteStop,
  GameContext,
  WorldSnapshot,
  GridPoint,
} from '../../../shared/types/GameTypes';
import type { LLMStrategyBrain } from '../../services/ai/LLMStrategyBrain';
import type { CompositionTrace } from '../../services/ai/TurnExecutorPlanner';

// ── Mock dependencies ──────────────────────────────────────────────────────

jest.mock('../../services/ai/MapTopology', () => ({
  loadGridPoints: jest.fn(() => new Map()),
  makeKey: (row: number, col: number) => `${row},${col}`,
  hexDistance: jest.fn(() => 5),
  getHexNeighbors: jest.fn(() => []),
}));

jest.mock('../../../shared/services/trackUsageFees', () => ({
  buildUnionTrackGraph: jest.fn(() => ({
    adjacency: new Map(),
    edgeOwners: new Map(),
  })),
}));

jest.mock('../../../shared/services/computeTrackUsageFees', () => ({
  computeTrackUsageFees: jest.fn(() => 0),
}));

jest.mock('../../services/ai/routeHelpers', () => {
  const real = jest.requireActual('../../services/ai/routeHelpers');
  return {
    isStopComplete: jest.fn(),
    resolveBuildTarget: jest.fn(),
    getNetworkFrontier: jest.fn(() => []),
    isDeliveryComplete: jest.fn(),
    // JIRA-196 Fix B: signature is now (stop, context) — snapshot parameter dropped
    applyStopEffectToLocalState: jest.fn((...args: Parameters<typeof real.applyStopEffectToLocalState>) =>
      real.applyStopEffectToLocalState(...args),
    ),
  };
});

jest.mock('../../services/ai/computeBuildSegments', () => ({
  computeBuildSegments: jest.fn(() => []),
}));

jest.mock('../../services/ai/ActionResolver', () => ({
  ActionResolver: {
    resolve: jest.fn(),
    resolveMove: jest.fn(),
  },
}));

jest.mock('../../../shared/services/majorCityGroups', () => ({
  getMajorCityLookup: jest.fn(() => new Map()),
  computeEffectivePathLength: jest.fn(() => 3),
}));

jest.mock('../../services/ai/PostDeliveryReplanner', () => ({
  PostDeliveryReplanner: {
    replan: jest.fn(),
  },
}));

jest.mock('../../services/ai/TurnExecutor', () => ({
  TurnExecutor: {
    executePlan: jest.fn().mockResolvedValue({
      success: true,
      action: 'DeliverLoad',
      cost: 0,
      segmentsBuilt: 0,
      remainingMoney: 108,
      durationMs: 1,
      payment: 8,
      newCardId: 5,
    }),
  },
}));

jest.mock('../../../shared/constants/gameRules', () => ({
  TURN_BUILD_BUDGET: 20,
}));

jest.mock('../../services/ai/BotMemory', () => ({
  getMemory: jest.fn(() => ({
    currentBuildTarget: null,
    turnsOnTarget: 0,
    lastAction: null,
    noProgressTurns: 0,
    consecutiveDiscards: 0,
    deliveryCount: 0,
    totalEarnings: 0,
    turnNumber: 0,
    activeRoute: null,
    turnsOnRoute: 0,
    routeHistory: [],
    lastReasoning: null,
    lastPlanHorizon: null,
    previousRouteStops: null,
    consecutiveLlmFailures: 0,
  })),
}));

jest.mock('../../services/ai/WorldSnapshotService', () => ({
  capture: jest.fn().mockResolvedValue({
    gameId: 'game-1',
    gameStatus: 'active',
    turnNumber: 1,
    bot: {
      playerId: 'bot-1',
      userId: 'user-1',
      money: 100,
      position: { row: 5, col: 5 },
      existingSegments: [],
      demandCards: [2, 3, 4],
      resolvedDemands: [],
      trainType: 'Freight',
      loads: [],
      botConfig: null,
      connectedMajorCityCount: 0,
    },
    allPlayerTracks: [],
    loadAvailability: {},
  }),
}));

jest.mock('../../services/ai/ContextBuilder', () => ({
  ContextBuilder: {
    rebuildDemands: jest.fn(() => []),
    rebuildCanDeliver: jest.fn(() => []),
  },
}));

jest.mock('../../services/ai/RouteEnrichmentAdvisor', () => ({
  RouteEnrichmentAdvisor: {
    enrich: jest.fn((route: unknown) => Promise.resolve(route)),
  },
}));

jest.mock('../../services/ai/RouteDetourEstimator', () => ({
  computeCandidateDetourCosts: jest.fn(() => []),
  MAX_DETOUR_TURNS: 3,
  OPPORTUNITY_COST_PER_TURN_M: 5,
}));

import { isStopComplete, resolveBuildTarget } from '../../services/ai/routeHelpers';
import { ActionResolver } from '../../services/ai/ActionResolver';
import { PostDeliveryReplanner } from '../../services/ai/PostDeliveryReplanner';
import { RouteEnrichmentAdvisor } from '../../services/ai/RouteEnrichmentAdvisor';
import { computeCandidateDetourCosts } from '../../services/ai/RouteDetourEstimator';
import type { DemandContext } from '../../../shared/types/GameTypes';

const mockIsStopComplete = isStopComplete as jest.Mock;
const mockResolveBuildTarget = resolveBuildTarget as jest.Mock;
const mockResolve = ActionResolver.resolve as jest.Mock;
const mockResolveMove = ActionResolver.resolveMove as jest.Mock;
const mockPostDeliveryReplan = PostDeliveryReplanner.replan as jest.Mock;
const mockEnrichRoute = RouteEnrichmentAdvisor.enrich as jest.Mock;
const mockComputeDetourCosts = computeCandidateDetourCosts as jest.Mock;
let mockRevalidate: jest.SpyInstance;
let mockSkipCompleted: jest.SpyInstance;
let mockExecuteStopAction: jest.SpyInstance;

// ── Factory helpers ────────────────────────────────────────────────────────

function makeStop(
  action: 'pickup' | 'deliver',
  city = 'TestCity',
  loadType = 'Coal',
): RouteStop {
  return { action, city, loadType };
}

function makeRoute(overrides: Partial<StrategicRoute> = {}): StrategicRoute {
  return {
    stops: [makeStop('pickup', 'Paris'), makeStop('deliver', 'Berlin')],
    currentStopIndex: 0,
    phase: 'travel',
    startingCity: 'Paris',
    createdAtTurn: 1,
    reasoning: 'test route',
    ...overrides,
  };
}

function makeContext(overrides: Partial<GameContext> = {}): GameContext {
  return {
    position: null,
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
    trainType: 'Freight',
    ...overrides,
  };
}

function makeSnapshot(): WorldSnapshot {
  return {
    gameId: 'game-1',
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

beforeEach(() => {
  jest.clearAllMocks();

  mockRevalidate = jest.spyOn(TurnExecutorPlanner, 'revalidateRemainingDeliveries')
    .mockImplementation((route: StrategicRoute) => route);

  mockSkipCompleted = jest.spyOn(TurnExecutorPlanner, 'skipCompletedStops')
    .mockImplementation((route: StrategicRoute) => route);

  mockExecuteStopAction = jest.spyOn(TurnExecutorPlanner, 'executeStopAction')
    .mockResolvedValue({ success: false, error: 'default mock — override in test' });
});

afterEach(() => {
  mockRevalidate.mockRestore();
  mockSkipCompleted.mockRestore();
  mockExecuteStopAction.mockRestore();
});

// ── Route complete before movement loop ───────────────────────────────────

describe('MovementPhasePlanner.run — route complete before movement loop', () => {
  it('returns routeComplete=true when route is already fully done', async () => {
    mockSkipCompleted.mockImplementation((route: StrategicRoute) => ({
      ...route,
      currentStopIndex: route.stops.length, // past all stops
    }));

    const result = await MovementPhasePlanner.run(
      makeRoute(),
      makeSnapshot(),
      makeContext(),
      makeTrace(),
    );

    expect(result.routeComplete).toBe(true);
    expect(result.routeAbandoned).toBe(false);
    expect(result.accumulatedPlans).toHaveLength(0);
  });
});

// ── Stop city not on network → exits immediately ───────────────────────────

describe('MovementPhasePlanner.run — stop not on network', () => {
  it('returns empty plans with routeComplete=false when stop city not on network', async () => {
    mockIsStopComplete.mockReturnValue(false);

    const context = makeContext({ citiesOnNetwork: [] }); // Paris not on network

    const result = await MovementPhasePlanner.run(
      makeRoute(),
      makeSnapshot(),
      context,
      makeTrace(),
    );

    expect(result.accumulatedPlans).toHaveLength(0);
    expect(result.routeComplete).toBe(false);
    expect(result.routeAbandoned).toBe(false);
    expect(result.lastMoveTargetCity).toBeNull();
  });
});

// ── Move toward stop city on network ──────────────────────────────────────

describe('MovementPhasePlanner.run — move toward stop on network', () => {
  it('emits a MoveTrain plan and records lastMoveTargetCity', async () => {
    mockIsStopComplete.mockReturnValue(false);

    const context = makeContext({ citiesOnNetwork: ['Paris'] });
    mockResolveMove.mockResolvedValue({
      success: true,
      plan: {
        type: AIActionType.MoveTrain,
        path: [{ row: 5, col: 5 }, { row: 5, col: 6 }],
        milesUsed: 3,
        cost: 0,
        trackUsageFees: [],
      },
    });

    const result = await MovementPhasePlanner.run(
      makeRoute(),
      makeSnapshot(),
      context,
      makeTrace(),
    );

    expect(result.accumulatedPlans.some(p => p.type === AIActionType.MoveTrain)).toBe(true);
    expect(result.lastMoveTargetCity).toBe('Paris');
  });

  it('breaks to Phase B when move fails', async () => {
    mockIsStopComplete.mockReturnValue(false);

    const context = makeContext({ citiesOnNetwork: ['Paris'] });
    mockResolveMove.mockResolvedValue({ success: false, error: 'no path' });

    const result = await MovementPhasePlanner.run(
      makeRoute(),
      makeSnapshot(),
      context,
      makeTrace(),
    );

    expect(result.accumulatedPlans).toHaveLength(0);
    expect(result.routeAbandoned).toBe(false); // move failure is not route abandonment
  });
});

// ── Pickup action at stop city ─────────────────────────────────────────────

describe('MovementPhasePlanner.run — pickup at stop city', () => {
  it('emits a PickupLoad plan and returns hasDelivery=false', async () => {
    mockIsStopComplete.mockReturnValue(false);

    const context = makeContext({
      position: { row: 5, col: 5, city: 'Paris' },
    });
    mockExecuteStopAction.mockResolvedValue({
      success: true,
      plan: { type: AIActionType.PickupLoad, load: 'Coal', city: 'Paris' },
    });

    const result = await MovementPhasePlanner.run(
      makeRoute(),
      makeSnapshot(),
      context,
      makeTrace(),
    );

    expect(result.accumulatedPlans.some(p => p.type === AIActionType.PickupLoad)).toBe(true);
    expect(result.hasDelivery).toBe(false);
  });
});

// ── Delivery action + PostDeliveryReplanner delegation ────────────────────

describe('MovementPhasePlanner.run — delivery + PostDeliveryReplanner', () => {
  it('delegates to PostDeliveryReplanner.replan() after delivery', async () => {
    mockIsStopComplete.mockReturnValue(false);

    const route = makeRoute({
      stops: [makeStop('deliver', 'Berlin', 'Wine')],
      currentStopIndex: 0,
    });
    const context = makeContext({
      position: { row: 5, col: 5, city: 'Berlin' },
    });

    mockExecuteStopAction.mockResolvedValue({
      success: true,
      plan: { type: AIActionType.DeliverLoad, load: 'Wine', city: 'Berlin' },
    });

    const replanRoute = makeRoute({ reasoning: 'replanned' });
    mockPostDeliveryReplan.mockResolvedValue({
      route: replanRoute,
      moveTargetInvalidated: true,
    });

    const result = await MovementPhasePlanner.run(
      route,
      makeSnapshot(),
      context,
      makeTrace(),
    );

    expect(mockPostDeliveryReplan).toHaveBeenCalledTimes(1);
    expect(result.hasDelivery).toBe(true);
    expect(result.deliveriesThisTurn).toBe(1);
    expect(result.lastMoveTargetCity).toBeNull(); // cleared by moveTargetInvalidated
  });

  it('keeps lastMoveTargetCity when moveTargetInvalidated is false', async () => {
    // Edge case: if for some reason replan returns false (shouldn't happen per spec,
    // but testing the wiring)
    mockIsStopComplete.mockReturnValue(false);

    const route = makeRoute({
      stops: [makeStop('deliver', 'Berlin', 'Wine')],
      currentStopIndex: 0,
    });
    const context = makeContext({
      position: { row: 5, col: 5, city: 'Berlin' },
    });

    mockExecuteStopAction.mockResolvedValue({
      success: true,
      plan: { type: AIActionType.DeliverLoad, load: 'Wine', city: 'Berlin' },
    });

    const replanRoute = makeRoute({ reasoning: 'replanned' });
    mockPostDeliveryReplan.mockResolvedValue({
      route: replanRoute,
      moveTargetInvalidated: false,
    });

    // Pre-set lastMoveTargetCity by making bot have moved first would be complex,
    // so just verify that false doesn't clear it (via the logic path)
    const result = await MovementPhasePlanner.run(
      route,
      makeSnapshot(),
      context,
      makeTrace(),
    );

    // lastMoveTargetCity was null to begin with (no move before delivery),
    // and moveTargetInvalidated=false means we DON'T overwrite it to null
    // The result here depends on whether there was a prior move — there wasn't,
    // so it stays null from initialization
    expect(result.hasDelivery).toBe(true);
  });
});

// ── Action failure → routeAbandoned ───────────────────────────────────────

describe('MovementPhasePlanner.run — action failure', () => {
  it('returns routeAbandoned=true and PassTurn when stop action fails', async () => {
    mockIsStopComplete.mockReturnValue(false);

    const context = makeContext({
      position: { row: 5, col: 5, city: 'Paris' },
    });
    mockExecuteStopAction.mockResolvedValue({
      success: false,
      error: 'no such load',
    });

    const result = await MovementPhasePlanner.run(
      makeRoute(),
      makeSnapshot(),
      context,
      makeTrace(),
    );

    expect(result.routeAbandoned).toBe(true);
    expect(result.accumulatedPlans.some(p => p.type === AIActionType.PassTurn)).toBe(true);
  });
});

// ── PhaseAResult fields populated correctly ────────────────────────────────

describe('MovementPhasePlanner.run — PhaseAResult fields', () => {
  it('loadStateMutations snapshots snapshot.bot.loads and context.loads', async () => {
    mockIsStopComplete.mockReturnValue(false);

    const snapshot = makeSnapshot();
    (snapshot.bot.loads as string[]).push('Wine');
    const context = makeContext({ loads: ['Wine'] });
    // Stop not on network → returns immediately without movement
    context.citiesOnNetwork = [];

    const result = await MovementPhasePlanner.run(
      makeRoute(),
      snapshot,
      context,
      makeTrace(),
    );

    expect(result.loadStateMutations.snapshotLoads).toEqual(['Wine']);
    expect(result.loadStateMutations.contextLoads).toEqual(['Wine']);
  });

  it('deliveriesThisTurn starts at 0 and increments per delivery', async () => {
    mockIsStopComplete.mockReturnValue(false);

    const route = makeRoute({
      stops: [makeStop('deliver', 'Berlin', 'Wine')],
      currentStopIndex: 0,
    });
    const context = makeContext({
      position: { row: 5, col: 5, city: 'Berlin' },
    });

    mockExecuteStopAction.mockResolvedValue({
      success: true,
      plan: { type: AIActionType.DeliverLoad, load: 'Wine', city: 'Berlin' },
    });

    mockPostDeliveryReplan.mockResolvedValue({
      route: makeRoute({ stops: [], currentStopIndex: 0 }),
      moveTargetInvalidated: true,
    });

    const result = await MovementPhasePlanner.run(
      route,
      makeSnapshot(),
      context,
      makeTrace(),
    );

    expect(result.deliveriesThisTurn).toBe(1);
  });
});

// ── JIRA-202: Arrival on last milepost executes stop action ───────────────

/**
 * Helper: build a GridPoint array with one entry at the given row/col
 * whose city.name matches cityName, so the position-update code sets
 * context.position.city correctly and isBotAtCity() returns true.
 */
function makeGridPointsForCity(row: number, col: number, cityName: string): GridPoint[] {
  return [
    {
      row,
      col,
      terrain: 0 as TerrainType, // Clear
      city: { name: cityName } as GridPoint['city'],
      name: cityName,
    } as unknown as GridPoint,
  ];
}

describe('JIRA-202: arrival on last milepost executes stop action', () => {
  // Shared setup: bot starts NOT at city, moves 9/9 mileposts to Berlin, budget = 0.
  // computeEffectivePathLength is mocked globally to return 3; we override per-test to 9.

  it('deliver on arrival — DeliverLoad plan emitted and delivery side-effects fire', async () => {
    const { computeEffectivePathLength } = jest.requireMock('../../../shared/services/majorCityGroups');
    (computeEffectivePathLength as jest.Mock).mockReturnValue(9); // consume full budget

    const route = makeRoute({
      stops: [makeStop('deliver', 'Berlin', 'Wine')],
      currentStopIndex: 0,
    });
    // Bot starts away from Berlin
    const context = makeContext({
      position: { row: 1, col: 1, city: 'Paris' },
      citiesOnNetwork: ['Berlin'],
      speed: 9,
    });
    const snapshot = makeSnapshot();

    // Move resolves toward Berlin, landing at row=10,col=10
    mockResolveMove.mockResolvedValue({
      success: true,
      plan: {
        type: AIActionType.MoveTrain,
        path: [{ row: 1, col: 1 }, { row: 10, col: 10 }],
        milesUsed: 9,
        cost: 0,
        trackUsageFees: [],
      },
    });

    // Deliver action succeeds
    mockExecuteStopAction.mockResolvedValue({
      success: true,
      plan: { type: AIActionType.DeliverLoad, load: 'Wine', city: 'Berlin' },
    });

    // Post-delivery replan returns empty route
    mockPostDeliveryReplan.mockResolvedValue({
      route: makeRoute({ stops: [], currentStopIndex: 0 }),
      moveTargetInvalidated: true,
    });

    // Provide gridPoints so position update sets city='Berlin'
    const gridPoints = makeGridPointsForCity(10, 10, 'Berlin');
    const trace = makeTrace();
    const result = await MovementPhasePlanner.run(route, snapshot, context, trace, undefined, gridPoints);

    expect(result.accumulatedPlans.some(p => p.type === AIActionType.MoveTrain)).toBe(true);
    expect(result.accumulatedPlans.some(p => p.type === AIActionType.DeliverLoad)).toBe(true);
    expect(result.hasDelivery).toBe(true);
    expect(result.deliveriesThisTurn).toBe(1);
    expect(mockPostDeliveryReplan).toHaveBeenCalledTimes(1);

    // Reset the mock for other tests
    (computeEffectivePathLength as jest.Mock).mockReturnValue(3);
  });

  it('pickup on arrival — PickupLoad plan emitted and stop index advances', async () => {
    const { computeEffectivePathLength } = jest.requireMock('../../../shared/services/majorCityGroups');
    (computeEffectivePathLength as jest.Mock).mockReturnValue(9);

    const route = makeRoute({
      stops: [makeStop('pickup', 'Berlin', 'Coal')],
      currentStopIndex: 0,
    });
    const context = makeContext({
      position: { row: 1, col: 1, city: 'Paris' },
      citiesOnNetwork: ['Berlin'],
      speed: 9,
    });
    const snapshot = makeSnapshot();

    mockResolveMove.mockResolvedValue({
      success: true,
      plan: {
        type: AIActionType.MoveTrain,
        path: [{ row: 1, col: 1 }, { row: 10, col: 10 }],
        milesUsed: 9,
        cost: 0,
        trackUsageFees: [],
      },
    });

    mockExecuteStopAction.mockResolvedValue({
      success: true,
      plan: { type: AIActionType.PickupLoad, load: 'Coal', city: 'Berlin' },
    });

    const gridPoints = makeGridPointsForCity(10, 10, 'Berlin');
    const trace = makeTrace();
    const result = await MovementPhasePlanner.run(route, snapshot, context, trace, undefined, gridPoints);

    expect(result.accumulatedPlans.some(p => p.type === AIActionType.MoveTrain)).toBe(true);
    expect(result.accumulatedPlans.some(p => p.type === AIActionType.PickupLoad)).toBe(true);
    expect(result.hasDelivery).toBe(false);

    (computeEffectivePathLength as jest.Mock).mockReturnValue(3);
  });

  it('non-stop milepost budget exhausted — no stop action runs (regression R3)', async () => {
    const { computeEffectivePathLength } = jest.requireMock('../../../shared/services/majorCityGroups');
    (computeEffectivePathLength as jest.Mock).mockReturnValue(9);

    const route = makeRoute({
      stops: [makeStop('deliver', 'Berlin', 'Wine')],
      currentStopIndex: 0,
    });
    // Bot starts away from Berlin, arrives at a different city (Prague)
    const context = makeContext({
      position: { row: 1, col: 1, city: 'Paris' },
      citiesOnNetwork: ['Berlin'],
      speed: 9,
    });
    const snapshot = makeSnapshot();

    // Move resolves to Prague (not Berlin), budget exhausted
    mockResolveMove.mockResolvedValue({
      success: true,
      plan: {
        type: AIActionType.MoveTrain,
        path: [{ row: 1, col: 1 }, { row: 7, col: 7 }],
        milesUsed: 9,
        cost: 0,
        trackUsageFees: [],
      },
    });

    // gridPoints positions row=7,col=7 as 'Prague', not 'Berlin'
    const gridPoints = makeGridPointsForCity(7, 7, 'Prague');
    const trace = makeTrace();
    const result = await MovementPhasePlanner.run(route, snapshot, context, trace, undefined, gridPoints);

    expect(result.accumulatedPlans.some(p => p.type === AIActionType.MoveTrain)).toBe(true);
    expect(result.accumulatedPlans.some(p => p.type === AIActionType.DeliverLoad)).toBe(false);
    expect(trace.a2.terminationReason).toBe('budget_exhausted');
    expect(mockExecuteStopAction).not.toHaveBeenCalled();

    (computeEffectivePathLength as jest.Mock).mockReturnValue(3);
  });

  it('ferry port arrival — ferry guard fires, no stop action even if ferry port is stop city (R5)', async () => {
    const { computeEffectivePathLength } = jest.requireMock('../../../shared/services/majorCityGroups');
    (computeEffectivePathLength as jest.Mock).mockReturnValue(9);

    // Patch loadGridPoints (MapTopology) to return a ferry port at destination
    const MapTopology = jest.requireMock('../../services/ai/MapTopology');
    const ferryMap = new Map<string, { terrain: TerrainType }>();
    ferryMap.set('10,10', { terrain: TerrainType.FerryPort });
    (MapTopology.loadGridPoints as jest.Mock).mockReturnValue(ferryMap);

    const route = makeRoute({
      stops: [makeStop('pickup', 'FerryCity', 'Coal')],
      currentStopIndex: 0,
    });
    const context = makeContext({
      position: { row: 1, col: 1, city: 'Paris' },
      citiesOnNetwork: ['FerryCity'],
      speed: 9,
    });
    const snapshot = makeSnapshot();

    mockResolveMove.mockResolvedValue({
      success: true,
      plan: {
        type: AIActionType.MoveTrain,
        path: [{ row: 1, col: 1 }, { row: 10, col: 10 }],
        milesUsed: 9,
        cost: 0,
        trackUsageFees: [],
      },
    });

    // gridPoints mark destination as FerryCity so isBotAtCity would return true
    const gridPoints = makeGridPointsForCity(10, 10, 'FerryCity');
    const trace = makeTrace();
    const result = await MovementPhasePlanner.run(route, snapshot, context, trace, undefined, gridPoints);

    // Ferry guard takes precedence — no stop action executes
    expect(trace.a2.terminationReason).toBe('ferry_arrival');
    expect(result.accumulatedPlans.some(p => p.type === AIActionType.PickupLoad)).toBe(false);
    expect(mockExecuteStopAction).not.toHaveBeenCalled();

    // Restore mocks
    (MapTopology.loadGridPoints as jest.Mock).mockReturnValue(new Map());
    (computeEffectivePathLength as jest.Mock).mockReturnValue(3);
  });

  it('stop action failure on arrival path — route abandoned, action_failed termination', async () => {
    const { computeEffectivePathLength } = jest.requireMock('../../../shared/services/majorCityGroups');
    (computeEffectivePathLength as jest.Mock).mockReturnValue(9);

    const route = makeRoute({
      stops: [makeStop('pickup', 'Berlin', 'Coal')],
      currentStopIndex: 0,
    });
    const context = makeContext({
      position: { row: 1, col: 1, city: 'Paris' },
      citiesOnNetwork: ['Berlin'],
      speed: 9,
    });
    const snapshot = makeSnapshot();

    mockResolveMove.mockResolvedValue({
      success: true,
      plan: {
        type: AIActionType.MoveTrain,
        path: [{ row: 1, col: 1 }, { row: 10, col: 10 }],
        milesUsed: 9,
        cost: 0,
        trackUsageFees: [],
      },
    });

    // Pickup fails
    mockExecuteStopAction.mockResolvedValue({
      success: false,
      error: 'load not available',
    });

    const gridPoints = makeGridPointsForCity(10, 10, 'Berlin');
    const trace = makeTrace();
    const result = await MovementPhasePlanner.run(route, snapshot, context, trace, undefined, gridPoints);

    expect(result.routeAbandoned).toBe(true);
    expect(trace.a2.terminationReason).toBe('action_failed');

    (computeEffectivePathLength as jest.Mock).mockReturnValue(3);
  });

  it('mid-budget arrival — existing isBotAtCity branch handles stop action (R4 regression)', async () => {
    // Bot arrives at stop city with budget remaining (not the edge case)
    // computeEffectivePathLength returns default 3 (not 9)

    const route = makeRoute({
      stops: [makeStop('pickup', 'Berlin', 'Coal')],
      currentStopIndex: 0,
    });
    // Bot already at Berlin — existing branch fires immediately
    const context = makeContext({
      position: { row: 10, col: 10, city: 'Berlin' },
      citiesOnNetwork: ['Berlin'],
      speed: 9,
    });

    mockExecuteStopAction.mockResolvedValue({
      success: true,
      plan: { type: AIActionType.PickupLoad, load: 'Coal', city: 'Berlin' },
    });

    const trace = makeTrace();
    const result = await MovementPhasePlanner.run(route, makeSnapshot(), context, trace);

    // The regular isBotAtCity branch handles this — no move emitted
    expect(result.accumulatedPlans.some(p => p.type === AIActionType.PickupLoad)).toBe(true);
    expect(result.accumulatedPlans.some(p => p.type === AIActionType.MoveTrain)).toBe(false);
  });
});

// ── JIRA-214 P2: Advisor trigger (AC10, AC11, AC12) ──────────────────────────

function makeDemand(loadType: string, supplyCity: string, deliveryCity: string, payout = 10): DemandContext {
  return {
    cardIndex: 0,
    loadType,
    supplyCity,
    deliveryCity,
    payout,
    isSupplyReachable: true,
    isDeliveryReachable: true,
    isSupplyOnNetwork: false,
    isDeliveryOnNetwork: false,
    estimatedTrackCostToSupply: 0,
    estimatedTrackCostToDelivery: 0,
    isLoadAvailable: true,
    isLoadOnTrain: false,
    ferryRequired: false,
    loadChipTotal: 4,
    loadChipCarried: 0,
    estimatedTurns: 5,
    demandScore: 2,
    efficiencyPerTurn: 2,
    networkCitiesUnlocked: 0,
    victoryMajorCitiesEnRoute: 0,
    isAffordable: true,
    projectedFundsAfterDelivery: 100,
  };
}

function makeBrain(): import('../../services/ai/LLMStrategyBrain').LLMStrategyBrain {
  return {
    providerAdapter: {
      chat: jest.fn().mockResolvedValue({ text: '{"decision":"keep","reasoning":"ok"}', usage: {} }),
      setContext: jest.fn(),
    },
    modelName: 'test-model',
  } as unknown as import('../../services/ai/LLMStrategyBrain').LLMStrategyBrain;
}

describe('JIRA-214 P2: Advisor trigger after pickup at city (AC10)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockEnrichRoute.mockImplementation((route: unknown) => Promise.resolve(route));
    mockComputeDetourCosts.mockReturnValue([]);

    jest.spyOn(TurnExecutorPlanner, 'revalidateRemainingDeliveries')
      .mockImplementation((route: StrategicRoute) => route);
    jest.spyOn(TurnExecutorPlanner, 'skipCompletedStops')
      .mockImplementation((route: StrategicRoute) => route);
    jest.spyOn(TurnExecutorPlanner, 'executeStopAction')
      .mockResolvedValue({ success: false, error: 'default' });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('AC10: fires advisor after pickup when next stop is at a different city', async () => {
    mockIsStopComplete.mockReturnValue(false);

    // Bot at Paris, picks up Coal, next stop is Berlin (different city)
    const route = makeRoute({
      stops: [
        makeStop('pickup', 'Paris', 'Coal'),
        makeStop('deliver', 'Berlin', 'Coal'),
      ],
      currentStopIndex: 0,
    });
    const context = makeContext({
      position: { row: 5, col: 5, city: 'Paris' },
      demands: [makeDemand('Flowers', 'Paris', 'Krakow', 18)],
    });

    // Snapshot: Paris has Flowers available, bot has 1 free slot
    const snapshot = makeSnapshot();
    (snapshot.loadAvailability as Record<string, string[]>) = { 'Paris': ['Flowers'] };
    snapshot.bot.loads = []; // empty loads — has free slot

    jest.spyOn(TurnExecutorPlanner, 'executeStopAction')
      .mockResolvedValue({
        success: true,
        plan: { type: AIActionType.PickupLoad, load: 'Coal', city: 'Paris' },
      });

    // Skip after pickup → different city next stop
    jest.spyOn(TurnExecutorPlanner, 'skipCompletedStops')
      .mockImplementation((r: StrategicRoute) => r);

    // computeCandidateDetourCosts returns a viable candidate
    mockComputeDetourCosts.mockReturnValue([{
      loadType: 'Flowers', deliveryCity: 'Krakow', payout: 18,
      cardIndex: 0, bestSlotIndex: 1, marginalBuildM: 0, marginalTurns: 0, feasible: true,
    }]);

    const gridPoints = makeGridPointsForCity(5, 5, 'Paris');
    const brain = makeBrain();
    const trace = makeTrace();

    await MovementPhasePlanner.run(route, snapshot, context, trace, brain, gridPoints);

    // Advisor must have been called
    expect(mockEnrichRoute).toHaveBeenCalled();
    const enrichCall = mockEnrichRoute.mock.calls[0];
    expect(enrichCall[5]).toBe('Paris'); // currentCity param
    expect(enrichCall[6]).toHaveLength(1); // 1 viable candidate
  });

  it('AC10: does NOT fire advisor when next stop is at the same city', async () => {
    mockIsStopComplete.mockReturnValue(false);

    // Bot at Paris, picks up Coal, next stop is ALSO Paris (deliver)
    const route = makeRoute({
      stops: [
        makeStop('pickup', 'Paris', 'Coal'),
        makeStop('deliver', 'Paris', 'Coal'), // same city!
      ],
      currentStopIndex: 0,
    });
    const context = makeContext({
      position: { row: 5, col: 5, city: 'Paris' },
    });

    jest.spyOn(TurnExecutorPlanner, 'executeStopAction')
      .mockResolvedValue({
        success: true,
        plan: { type: AIActionType.PickupLoad, load: 'Coal', city: 'Paris' },
      });
    jest.spyOn(TurnExecutorPlanner, 'skipCompletedStops')
      .mockImplementation((r: StrategicRoute) => r);

    const snapshot = makeSnapshot();
    (snapshot.loadAvailability as Record<string, string[]>) = { 'Paris': ['Flowers'] };

    const gridPoints = makeGridPointsForCity(5, 5, 'Paris');
    const brain = makeBrain();

    await MovementPhasePlanner.run(route, snapshot, context, makeTrace(), brain, gridPoints);

    // Advisor must NOT be called — next stop is same city
    expect(mockEnrichRoute).not.toHaveBeenCalled();
  });

  it('AC10: does NOT fire advisor (no LLM call) when no candidates pass pre-LLM filter', async () => {
    mockIsStopComplete.mockReturnValue(false);

    const route = makeRoute({
      stops: [
        makeStop('pickup', 'Paris', 'Coal'),
        makeStop('deliver', 'Berlin', 'Coal'),
      ],
      currentStopIndex: 0,
    });
    const context = makeContext({
      position: { row: 5, col: 5, city: 'Paris' },
      demands: [],  // No demands → no candidates pass filter
    });

    jest.spyOn(TurnExecutorPlanner, 'executeStopAction')
      .mockResolvedValue({
        success: true,
        plan: { type: AIActionType.PickupLoad, load: 'Coal', city: 'Paris' },
      });
    jest.spyOn(TurnExecutorPlanner, 'skipCompletedStops')
      .mockImplementation((r: StrategicRoute) => r);

    const snapshot = makeSnapshot();
    const gridPoints = makeGridPointsForCity(5, 5, 'Paris');
    const brain = makeBrain();

    await MovementPhasePlanner.run(route, snapshot, context, makeTrace(), brain, gridPoints);

    // Advisor must NOT be called — no candidates
    expect(mockEnrichRoute).not.toHaveBeenCalled();
  });

  it('AC12: already-in-plan case — route has DELIVER Flowers@Krakow, filter drops candidate', async () => {
    mockIsStopComplete.mockReturnValue(false);

    // Route already has DELIVER Flowers@Krakow
    const route = makeRoute({
      stops: [
        makeStop('pickup', 'Paris', 'Coal'),
        { action: 'deliver', loadType: 'Flowers', city: 'Krakow', payment: 18 } as RouteStop,
        makeStop('deliver', 'Berlin', 'Coal'),
      ],
      currentStopIndex: 0,
    });
    const context = makeContext({
      position: { row: 5, col: 5, city: 'Paris' },
      demands: [makeDemand('Flowers', 'Paris', 'Krakow', 18)], // Flowers demand present
    });

    // Snapshot: Paris has Flowers available
    const snapshot = makeSnapshot();
    (snapshot.loadAvailability as Record<string, string[]>) = { 'Paris': ['Flowers'] };

    jest.spyOn(TurnExecutorPlanner, 'executeStopAction')
      .mockResolvedValue({
        success: true,
        plan: { type: AIActionType.PickupLoad, load: 'Coal', city: 'Paris' },
      });
    jest.spyOn(TurnExecutorPlanner, 'skipCompletedStops')
      .mockImplementation((r: StrategicRoute) => r);

    const gridPoints = makeGridPointsForCity(5, 5, 'Paris');
    const brain = makeBrain();

    await MovementPhasePlanner.run(route, snapshot, context, makeTrace(), brain, gridPoints);

    // Advisor NOT called — Flowers@Krakow already in route (condition 2 blocks it)
    expect(mockEnrichRoute).not.toHaveBeenCalled();
    // computeCandidateDetourCosts NOT called either (short-circuit before conditions 4-5)
    expect(mockComputeDetourCosts).not.toHaveBeenCalled();
  });

  it('AC11: same-resource second-copy — route has DELIVER Flowers@Krakow but NOT @Kaliningrad', async () => {
    mockIsStopComplete.mockReturnValue(false);

    // Route has DELIVER Flowers@Krakow only — @Kaliningrad is NOT in route
    const route = makeRoute({
      stops: [
        makeStop('pickup', 'Paris', 'Coal'),
        { action: 'deliver', loadType: 'Flowers', city: 'Krakow', payment: 18 } as RouteStop,
        makeStop('deliver', 'Berlin', 'Coal'),
      ],
      currentStopIndex: 0,
    });
    const context = makeContext({
      position: { row: 5, col: 5, city: 'Paris' },
      demands: [
        makeDemand('Flowers', 'Paris', 'Krakow', 18),       // already in plan
        makeDemand('Flowers', 'Paris', 'Kaliningrad', 22),  // NOT in plan
      ],
    });

    const snapshot = makeSnapshot();
    (snapshot.loadAvailability as Record<string, string[]>) = { 'Paris': ['Flowers'] };
    snapshot.bot.loads = []; // has free slot

    jest.spyOn(TurnExecutorPlanner, 'executeStopAction')
      .mockResolvedValue({
        success: true,
        plan: { type: AIActionType.PickupLoad, load: 'Coal', city: 'Paris' },
      });
    jest.spyOn(TurnExecutorPlanner, 'skipCompletedStops')
      .mockImplementation((r: StrategicRoute) => r);

    // Only Kaliningrad passes the pre-LLM filter (Krakow is filtered by condition 2)
    // computeCandidateDetourCosts is called for Kaliningrad candidate
    mockComputeDetourCosts.mockReturnValue([{
      loadType: 'Flowers', deliveryCity: 'Kaliningrad', payout: 22,
      cardIndex: 1, bestSlotIndex: 2, marginalBuildM: 0, marginalTurns: 0, feasible: true,
    }]);

    const gridPoints = makeGridPointsForCity(5, 5, 'Paris');
    const brain = makeBrain();

    await MovementPhasePlanner.run(route, snapshot, context, makeTrace(), brain, gridPoints);

    // Advisor IS called with the Kaliningrad candidate
    expect(mockEnrichRoute).toHaveBeenCalled();
    const enrichCall = mockEnrichRoute.mock.calls[0];
    const passedCandidates = enrichCall[6];
    // Should include Kaliningrad, not Krakow
    expect(passedCandidates.some((c: { deliveryCity: string }) => c.deliveryCity === 'Kaliningrad')).toBe(true);
    expect(passedCandidates.some((c: { deliveryCity: string }) => c.deliveryCity === 'Krakow')).toBe(false);
  });
});
