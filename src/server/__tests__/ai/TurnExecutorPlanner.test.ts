/**
 * TurnExecutorPlanner unit tests.
 *
 * Tests the execute() entry point and helper methods:
 * - skipCompletedStops: advances past completed stops
 * - assertStopIndexNotDecreased: invariant guard
 * - execute(): movement loop (pickup, deliver, move), build target resolution,
 *   route complete paths
 */

import { TurnExecutorPlanner } from '../../services/ai/TurnExecutorPlanner';
import { AIActionType } from '../../../shared/types/GameTypes';
import type {
  StrategicRoute,
  RouteStop,
  GameContext,
  WorldSnapshot,
} from '../../../shared/types/GameTypes';

// ── Mock dependencies ──────────────────────────────────────────────────────

jest.mock('../../services/ai/MapTopology', () => ({
  loadGridPoints: jest.fn(() => new Map()),
}));

jest.mock('../../services/ai/routeHelpers', () => ({
  isStopComplete: jest.fn(),
  resolveBuildTarget: jest.fn(),
  getNetworkFrontier: jest.fn(() => []),
}));

jest.mock('../../services/ai/ActionResolver', () => ({
  ActionResolver: {
    resolve: jest.fn(),
    resolveMove: jest.fn(),
  },
}));

jest.mock('../../services/ai/PlanExecutor', () => ({
  PlanExecutor: {
    revalidateRemainingDeliveries: jest.fn((route: StrategicRoute) => route),
  },
}));

jest.mock('../../../shared/services/majorCityGroups', () => ({
  getMajorCityLookup: jest.fn(() => new Map()),
  computeEffectivePathLength: jest.fn(() => 3),
}));

jest.mock('../../services/ai/TripPlanner', () => ({
  TripPlanner: jest.fn().mockImplementation(() => ({
    planTrip: jest.fn().mockResolvedValue({ route: null, llmLog: [] }),
  })),
}));

jest.mock('../../services/ai/RouteEnrichmentAdvisor', () => ({
  RouteEnrichmentAdvisor: {
    enrich: jest.fn((route: StrategicRoute) => route),
  },
}));

jest.mock('../../services/ai/TurnComposer', () => ({
  TurnComposer: {
    shouldDeferBuild: jest.fn(() => ({
      deferred: false,
      reason: 'build_needed',
      trackRunway: 0,
      intermediateStopTurns: 0,
      effectiveRunway: 0,
    })),
  },
}));

jest.mock('../../services/ai/BuildAdvisor', () => ({
  BuildAdvisor: {
    advise: jest.fn().mockResolvedValue(null),
    retryWithSolvencyFeedback: jest.fn().mockResolvedValue(null),
    lastDiagnostics: {},
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

import { isStopComplete, resolveBuildTarget, getNetworkFrontier } from '../../services/ai/routeHelpers';
import { loadGridPoints } from '../../services/ai/MapTopology';
import { ActionResolver } from '../../services/ai/ActionResolver';
import { PlanExecutor } from '../../services/ai/PlanExecutor';
import { TripPlanner } from '../../services/ai/TripPlanner';
import { RouteEnrichmentAdvisor } from '../../services/ai/RouteEnrichmentAdvisor';
import { TurnComposer } from '../../services/ai/TurnComposer';
import { BuildAdvisor } from '../../services/ai/BuildAdvisor';
import { computeEffectivePathLength } from '../../../shared/services/majorCityGroups';

const mockIsStopComplete = isStopComplete as jest.Mock;
const mockResolveBuildTarget = resolveBuildTarget as jest.Mock;
const mockGetNetworkFrontier = getNetworkFrontier as jest.Mock;
const mockLoadGridPoints = loadGridPoints as jest.Mock;
const mockResolve = ActionResolver.resolve as jest.Mock;
const mockResolveMove = ActionResolver.resolveMove as jest.Mock;
const mockRevalidate = PlanExecutor.revalidateRemainingDeliveries as jest.Mock;
const mockComputeEffectivePathLength = computeEffectivePathLength as jest.Mock;
const MockTripPlanner = TripPlanner as jest.MockedClass<typeof TripPlanner>;
const mockEnrich = RouteEnrichmentAdvisor.enrich as jest.Mock;
const mockShouldDeferBuild = TurnComposer.shouldDeferBuild as jest.Mock;
const mockBuildAdvisorAdvise = BuildAdvisor.advise as jest.Mock;
const mockBuildAdvisorRetry = BuildAdvisor.retryWithSolvencyFeedback as jest.Mock;

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
    bot: {
      position: { row: 5, col: 5 },
      existingSegments: [],
      money: 100,
      trainType: 'Freight',
      loads: [],
    },
    players: [],
    loadAvailability: {},
  } as unknown as WorldSnapshot;
}

// ── skipCompletedStops ─────────────────────────────────────────────────────

describe('TurnExecutorPlanner.skipCompletedStops', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns the route unchanged when no stops are complete', () => {
    mockIsStopComplete.mockReturnValue(false);
    const route = makeRoute();
    const context = makeContext();

    const result = TurnExecutorPlanner.skipCompletedStops(route, context);

    expect(result).toBe(route); // same reference
    expect(result.currentStopIndex).toBe(0);
  });

  it('advances past a single completed stop', () => {
    // First stop complete, second not
    mockIsStopComplete.mockReturnValueOnce(true).mockReturnValueOnce(false);
    const route = makeRoute();
    const context = makeContext();

    const result = TurnExecutorPlanner.skipCompletedStops(route, context);

    expect(result.currentStopIndex).toBe(1);
  });

  it('advances past all completed stops when all are done', () => {
    mockIsStopComplete.mockReturnValue(true);
    const route = makeRoute(); // 2 stops
    const context = makeContext();

    const result = TurnExecutorPlanner.skipCompletedStops(route, context);

    expect(result.currentStopIndex).toBe(2);
  });

  it('does not advance when already at end of stops', () => {
    const route = makeRoute({ currentStopIndex: 2 }); // past all stops
    const context = makeContext();

    const result = TurnExecutorPlanner.skipCompletedStops(route, context);

    expect(result.currentStopIndex).toBe(2);
    expect(mockIsStopComplete).not.toHaveBeenCalled();
  });

  it('returns a new object when stop index changed', () => {
    mockIsStopComplete.mockReturnValueOnce(true).mockReturnValue(false);
    const route = makeRoute();
    const context = makeContext();

    const result = TurnExecutorPlanner.skipCompletedStops(route, context);

    expect(result).not.toBe(route); // new reference
    expect(result.currentStopIndex).toBe(1);
  });

  it('starts skipping from the existing currentStopIndex', () => {
    // Route already at index 1; only stop[1] should be checked
    mockIsStopComplete.mockReturnValue(false);
    const route = makeRoute({ currentStopIndex: 1 });
    const context = makeContext();

    TurnExecutorPlanner.skipCompletedStops(route, context);

    // isStopComplete should only be called for stops from index 1 onward
    expect(mockIsStopComplete).toHaveBeenCalledTimes(1);
    expect(mockIsStopComplete).toHaveBeenCalledWith(
      route.stops[1],
      1,
      route.stops,
      context,
    );
  });
});

// ── execute() — route complete path ────────────────────────────────────────

describe('TurnExecutorPlanner.execute — route complete', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns routeComplete=true and PassTurn when all stops are done', async () => {
    mockIsStopComplete.mockReturnValue(false);
    mockResolveBuildTarget.mockReturnValue(null);

    const route = makeRoute({ currentStopIndex: 2 }); // already at end
    const snapshot = makeSnapshot();
    const context = makeContext();

    const result = await TurnExecutorPlanner.execute(route, snapshot, context);

    expect(result.routeComplete).toBe(true);
    expect(result.routeAbandoned).toBe(false);
    expect(result.plans).toHaveLength(1);
    expect(result.plans[0].type).toBe(AIActionType.PassTurn);
  });

  it('sets compositionTrace.a2.terminationReason to route_complete', async () => {
    mockIsStopComplete.mockReturnValue(false);
    mockResolveBuildTarget.mockReturnValue(null);

    const route = makeRoute({ currentStopIndex: 2 });
    const snapshot = makeSnapshot();
    const context = makeContext();

    const result = await TurnExecutorPlanner.execute(route, snapshot, context);

    expect(result.compositionTrace.a2.terminationReason).toBe('route_complete');
  });
});

// ── execute() — stub movement path ─────────────────────────────────────────

describe('TurnExecutorPlanner.execute — stub movement', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns a PassTurn plan in the stub implementation', async () => {
    mockIsStopComplete.mockReturnValue(false);
    mockResolveBuildTarget.mockReturnValue(null);

    const route = makeRoute();
    const snapshot = makeSnapshot();
    const context = makeContext();

    const result = await TurnExecutorPlanner.execute(route, snapshot, context);

    expect(result.plans).toHaveLength(1);
    expect(result.plans[0].type).toBe(AIActionType.PassTurn);
    expect(result.routeComplete).toBe(false);
    expect(result.routeAbandoned).toBe(false);
  });

  it('resolves a build target and records it in trace', async () => {
    mockIsStopComplete.mockReturnValue(false);
    mockResolveBuildTarget.mockReturnValue({
      targetCity: 'München',
      stopIndex: 1,
      isVictoryBuild: false,
    });

    const route = makeRoute();
    const snapshot = makeSnapshot();
    const context = makeContext();

    const result = await TurnExecutorPlanner.execute(route, snapshot, context);

    expect(result.compositionTrace.build.target).toBe('München');
    expect(result.compositionTrace.build.skipped).toBe(false);
  });

  it('marks build as skipped when no build target', async () => {
    mockIsStopComplete.mockReturnValue(false);
    mockResolveBuildTarget.mockReturnValue(null);

    const route = makeRoute();
    const snapshot = makeSnapshot();
    const context = makeContext();

    const result = await TurnExecutorPlanner.execute(route, snapshot, context);

    expect(result.compositionTrace.build.skipped).toBe(true);
    expect(result.compositionTrace.build.target).toBeNull();
  });

  it('returns updatedRoute with advanced stop index when front stops complete', async () => {
    // First stop complete, second not
    mockIsStopComplete
      .mockReturnValueOnce(true)  // stop[0] complete
      .mockReturnValueOnce(false); // stop[1] not complete
    mockResolveBuildTarget.mockReturnValue(null);

    const route = makeRoute({ currentStopIndex: 0 });
    const snapshot = makeSnapshot();
    const context = makeContext();

    const result = await TurnExecutorPlanner.execute(route, snapshot, context);

    expect(result.updatedRoute.currentStopIndex).toBe(1);
  });

  it('initialises moveBudget from context.speed', async () => {
    mockIsStopComplete.mockReturnValue(false);
    mockResolveBuildTarget.mockReturnValue(null);

    const route = makeRoute();
    const snapshot = makeSnapshot();
    const context = makeContext({ speed: 12 });

    const result = await TurnExecutorPlanner.execute(route, snapshot, context);

    expect(result.compositionTrace.moveBudget.total).toBe(12);
    expect(result.compositionTrace.moveBudget.used).toBe(0);
  });

  it('hasDelivery is false in stub', async () => {
    mockIsStopComplete.mockReturnValue(false);
    mockResolveBuildTarget.mockReturnValue(null);

    const route = makeRoute();
    const snapshot = makeSnapshot();
    const context = makeContext();

    const result = await TurnExecutorPlanner.execute(route, snapshot, context);

    expect(result.hasDelivery).toBe(false);
  });

  it('records outputPlan in compositionTrace', async () => {
    mockIsStopComplete.mockReturnValue(false);
    mockResolveBuildTarget.mockReturnValue(null);

    const route = makeRoute();
    const snapshot = makeSnapshot();
    const context = makeContext();

    const result = await TurnExecutorPlanner.execute(route, snapshot, context);

    expect(result.compositionTrace.outputPlan).toContain(AIActionType.PassTurn);
  });
});

// ── execute() — invariant guard ────────────────────────────────────────────

describe('TurnExecutorPlanner.execute — stop index invariant', () => {
  it('throws when skipCompletedStops would decrease the stop index', () => {
    // This simulates a bug where isStopComplete returns unexpected results
    // causing the index to appear to decrease — the invariant should catch it.
    // We test the assertion directly since it's a private static.
    const tag = '[TurnExecutorPlanner]';
    const original = makeRoute({ currentStopIndex: 3 });
    const decreased = makeRoute({ currentStopIndex: 2 });

    expect(() => {
      // Access via any cast since it's private
      (TurnExecutorPlanner as any).assertStopIndexNotDecreased(
        original,
        decreased,
        tag,
      );
    }).toThrow('INVARIANT VIOLATION');
  });

  it('does not throw when stop index stays the same', () => {
    const tag = '[TurnExecutorPlanner]';
    const route = makeRoute({ currentStopIndex: 1 });

    expect(() => {
      (TurnExecutorPlanner as any).assertStopIndexNotDecreased(route, route, tag);
    }).not.toThrow();
  });

  it('does not throw when stop index increases', () => {
    const tag = '[TurnExecutorPlanner]';
    const original = makeRoute({ currentStopIndex: 0 });
    const advanced = makeRoute({ currentStopIndex: 1 });

    expect(() => {
      (TurnExecutorPlanner as any).assertStopIndexNotDecreased(
        original,
        advanced,
        tag,
      );
    }).not.toThrow();
  });
});

// ── isBotAtCity ────────────────────────────────────────────────────────────

describe('TurnExecutorPlanner.isBotAtCity', () => {
  it('returns false when position is null', () => {
    const context = makeContext({ position: null });
    expect(TurnExecutorPlanner.isBotAtCity(context, 'Paris')).toBe(false);
  });

  it('returns true when position.city matches', () => {
    const context = makeContext({ position: { city: 'Paris', row: 1, col: 1 } });
    expect(TurnExecutorPlanner.isBotAtCity(context, 'Paris')).toBe(true);
  });

  it('returns false when position.city does not match', () => {
    const context = makeContext({ position: { city: 'Berlin', row: 1, col: 1 } });
    expect(TurnExecutorPlanner.isBotAtCity(context, 'Paris')).toBe(false);
  });

  it('returns false when position has no city property', () => {
    const context = makeContext({ position: { row: 5, col: 5 } as any });
    expect(TurnExecutorPlanner.isBotAtCity(context, 'Paris')).toBe(false);
  });
});

// ── execute() — movement loop: pickup at current city ─────────────────────

describe('TurnExecutorPlanner.execute — pickup at current city', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockIsStopComplete.mockReturnValue(false);
    mockResolveBuildTarget.mockReturnValue(null);
    mockRevalidate.mockImplementation((route: StrategicRoute) => route);
    mockComputeEffectivePathLength.mockReturnValue(3);
  });

  it('executes pickup action and advances stop index when bot is at pickup city', async () => {
    const pickupPlan = { type: AIActionType.PickupLoad, load: 'Coal', city: 'Paris' };
    mockResolve.mockResolvedValue({ success: true, plan: pickupPlan });

    const route = makeRoute({
      stops: [makeStop('pickup', 'Paris', 'Coal'), makeStop('deliver', 'Berlin', 'Coal')],
      currentStopIndex: 0,
    });
    const context = makeContext({ position: { city: 'Paris', row: 1, col: 1 } });
    const snapshot = makeSnapshot();

    const result = await TurnExecutorPlanner.execute(route, snapshot, context);

    expect(result.plans).toContainEqual(pickupPlan);
    expect(result.updatedRoute.currentStopIndex).toBe(1);
    expect(result.hasDelivery).toBe(false);
    // Pickup does NOT trigger revalidateRemainingDeliveries (ADR-4)
    expect(mockRevalidate).not.toHaveBeenCalled();
  });

  it('records pickup in compositionTrace.pickups', async () => {
    const pickupPlan = { type: AIActionType.PickupLoad, load: 'Coal', city: 'Paris' };
    mockResolve.mockResolvedValue({ success: true, plan: pickupPlan });

    const route = makeRoute({
      stops: [makeStop('pickup', 'Paris', 'Coal'), makeStop('deliver', 'Berlin', 'Coal')],
      currentStopIndex: 0,
    });
    const context = makeContext({ position: { city: 'Paris', row: 1, col: 1 } });
    const snapshot = makeSnapshot();

    const result = await TurnExecutorPlanner.execute(route, snapshot, context);

    expect(result.compositionTrace.pickups).toContainEqual({ load: 'Coal', city: 'Paris' });
  });

  it('abandons route when pickup action fails', async () => {
    mockResolve.mockResolvedValue({ success: false, error: 'Train is full' });

    const route = makeRoute({
      stops: [makeStop('pickup', 'Paris', 'Coal')],
      currentStopIndex: 0,
    });
    const context = makeContext({ position: { city: 'Paris', row: 1, col: 1 } });
    const snapshot = makeSnapshot();

    const result = await TurnExecutorPlanner.execute(route, snapshot, context);

    expect(result.routeAbandoned).toBe(true);
  });
});

// ── execute() — movement loop: delivery at current city ───────────────────

describe('TurnExecutorPlanner.execute — delivery at current city', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockIsStopComplete.mockReturnValue(false);
    mockResolveBuildTarget.mockReturnValue(null);
    mockRevalidate.mockImplementation((route: StrategicRoute) => route);
    mockComputeEffectivePathLength.mockReturnValue(3);
  });

  it('executes deliver action, sets hasDelivery=true, calls revalidate', async () => {
    const deliverPlan = {
      type: AIActionType.DeliverLoad,
      load: 'Coal',
      city: 'Berlin',
      cardId: 42,
      payout: 8,
    };
    mockResolve.mockResolvedValue({ success: true, plan: deliverPlan });

    const route = makeRoute({
      stops: [makeStop('deliver', 'Berlin', 'Coal')],
      currentStopIndex: 0,
    });
    const context = makeContext({ position: { city: 'Berlin', row: 2, col: 2 } });
    const snapshot = makeSnapshot();

    const result = await TurnExecutorPlanner.execute(route, snapshot, context);

    expect(result.plans).toContainEqual(deliverPlan);
    expect(result.hasDelivery).toBe(true);
    // Delivery triggers revalidateRemainingDeliveries
    expect(mockRevalidate).toHaveBeenCalled();
  });

  it('records delivery in compositionTrace.deliveries', async () => {
    const deliverPlan = {
      type: AIActionType.DeliverLoad,
      load: 'Coal',
      city: 'Berlin',
      cardId: 42,
      payout: 8,
    };
    mockResolve.mockResolvedValue({ success: true, plan: deliverPlan });

    const route = makeRoute({
      stops: [makeStop('deliver', 'Berlin', 'Coal')],
      currentStopIndex: 0,
    });
    const context = makeContext({ position: { city: 'Berlin', row: 2, col: 2 } });
    const snapshot = makeSnapshot();

    const result = await TurnExecutorPlanner.execute(route, snapshot, context);

    expect(result.compositionTrace.deliveries).toContainEqual({ load: 'Coal', city: 'Berlin' });
  });

  it('sets routeComplete=true when last stop delivered', async () => {
    const deliverPlan = {
      type: AIActionType.DeliverLoad,
      load: 'Coal',
      city: 'Berlin',
      cardId: 42,
      payout: 8,
    };
    mockResolve.mockResolvedValue({ success: true, plan: deliverPlan });

    const route = makeRoute({
      stops: [makeStop('deliver', 'Berlin', 'Coal')],
      currentStopIndex: 0,
    });
    const context = makeContext({ position: { city: 'Berlin', row: 2, col: 2 } });
    const snapshot = makeSnapshot();

    const result = await TurnExecutorPlanner.execute(route, snapshot, context);

    expect(result.routeComplete).toBe(true);
    expect(result.plans).toContainEqual(deliverPlan);
  });
});

// ── execute() — movement loop: move toward stop city ──────────────────────

describe('TurnExecutorPlanner.execute — move toward stop city', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockIsStopComplete.mockReturnValue(false);
    mockResolveBuildTarget.mockReturnValue(null);
    mockRevalidate.mockImplementation((route: StrategicRoute) => route);
    mockComputeEffectivePathLength.mockReturnValue(3);
  });

  it('emits a MoveTrain plan when stop city is on network but bot not there', async () => {
    const movePlan = {
      type: AIActionType.MoveTrain,
      path: [{ row: 1, col: 1 }, { row: 2, col: 2 }],
      fees: new Set<string>(),
      totalFee: 0,
    };
    mockResolveMove.mockResolvedValue({ success: true, plan: movePlan });

    const route = makeRoute({
      stops: [makeStop('pickup', 'Berlin', 'Coal')],
      currentStopIndex: 0,
    });
    const context = makeContext({
      position: { city: 'Paris', row: 1, col: 1 },
      citiesOnNetwork: ['Berlin'],
    });
    const snapshot = makeSnapshot();

    const result = await TurnExecutorPlanner.execute(route, snapshot, context);

    expect(result.plans).toContainEqual(movePlan);
    expect(result.hasDelivery).toBe(false);
    expect(mockResolveMove).toHaveBeenCalledWith({ to: 'Berlin' }, snapshot, 9);
  });

  it('breaks to Phase B when move fails (city unreachable on network)', async () => {
    mockResolveMove.mockResolvedValue({ success: false, error: 'No path' });

    const route = makeRoute({
      stops: [makeStop('pickup', 'Berlin', 'Coal')],
      currentStopIndex: 0,
    });
    const context = makeContext({
      position: { city: 'Paris', row: 1, col: 1 },
      citiesOnNetwork: ['Berlin'],
    });
    const snapshot = makeSnapshot();

    const result = await TurnExecutorPlanner.execute(route, snapshot, context);

    // Falls through to PassTurn since no plans produced
    expect(result.plans).toContainEqual({ type: AIActionType.PassTurn });
    expect(result.routeAbandoned).toBe(false);
    expect(result.compositionTrace.a2.terminationReason).toBe('move_failed_fallthrough_build');
  });

  it('breaks to Phase B when stop city is not on network (no frontier nodes)', async () => {
    // Default: getNetworkFrontier returns [] → A3 skipped, no resolveMove called
    mockGetNetworkFrontier.mockReturnValue([]);

    const route = makeRoute({
      stops: [makeStop('pickup', 'München', 'Coal')],
      currentStopIndex: 0,
    });
    // München NOT in citiesOnNetwork
    const context = makeContext({ citiesOnNetwork: [] });
    const snapshot = makeSnapshot();

    const result = await TurnExecutorPlanner.execute(route, snapshot, context);

    expect(result.compositionTrace.a2.terminationReason).toBe('stop_city_not_on_network');
    expect(mockResolveMove).not.toHaveBeenCalled();
  });

  it('A3: emits a MoveTrain plan toward frontier node when stop city not on network', async () => {
    // Frontier node exists and is reachable
    mockGetNetworkFrontier.mockReturnValue([
      { row: 3, col: 3, cityName: 'Ruhr' },
    ]);
    const a3MovePlan = {
      type: AIActionType.MoveTrain,
      path: [{ row: 5, col: 5 }, { row: 3, col: 3 }],
      fees: new Set<string>(),
      totalFee: 0,
    };
    mockResolveMove.mockResolvedValue({ success: true, plan: a3MovePlan });
    mockComputeEffectivePathLength.mockReturnValue(3);

    const route = makeRoute({
      stops: [makeStop('pickup', 'München', 'Coal')],
      currentStopIndex: 0,
    });
    const context = makeContext({
      citiesOnNetwork: [], // München NOT on network → triggers A3
      position: { city: 'Paris', row: 5, col: 5 },
      speed: 9,
    });
    const snapshot = makeSnapshot();

    const result = await TurnExecutorPlanner.execute(route, snapshot, context);

    // A3 should have emitted a MoveTrain plan toward the frontier node
    expect(result.plans).toContainEqual(a3MovePlan);
    expect(result.compositionTrace.a3.movePreprended).toBe(true);
    expect(result.compositionTrace.a2.terminationReason).toBe('stop_city_not_on_network');
    // getNetworkFrontier called with snapshot and the off-network city as target
    expect(mockGetNetworkFrontier).toHaveBeenCalledWith(snapshot, undefined, 'München');
  });

  it('A3: skips frontier move when frontier city matches current bot city', async () => {
    // Frontier node is the bot's current city — should be excluded
    mockGetNetworkFrontier.mockReturnValue([
      { row: 5, col: 5, cityName: 'Paris' }, // same as bot position
    ]);

    const route = makeRoute({
      stops: [makeStop('pickup', 'München', 'Coal')],
      currentStopIndex: 0,
    });
    const context = makeContext({
      citiesOnNetwork: [],
      position: { city: 'Paris', row: 5, col: 5 },
    });
    const snapshot = makeSnapshot();

    const result = await TurnExecutorPlanner.execute(route, snapshot, context);

    // A3 should NOT emit a move (frontier node is current city)
    expect(mockResolveMove).not.toHaveBeenCalled();
    expect(result.compositionTrace.a3.movePreprended).toBe(false);
  });

  it('A3: skips frontier move when resolveMove fails for all frontier nodes', async () => {
    mockGetNetworkFrontier.mockReturnValue([
      { row: 3, col: 3, cityName: 'Ruhr' },
    ]);
    mockResolveMove.mockResolvedValue({ success: false, error: 'Pathfinding failed' });

    const route = makeRoute({
      stops: [makeStop('pickup', 'München', 'Coal')],
      currentStopIndex: 0,
    });
    const context = makeContext({ citiesOnNetwork: [], position: { city: 'Paris', row: 5, col: 5 } });
    const snapshot = makeSnapshot();

    const result = await TurnExecutorPlanner.execute(route, snapshot, context);

    // No move plan — A3 attempted but failed
    expect(result.plans.some(p => p.type === AIActionType.MoveTrain)).toBe(false);
    expect(result.compositionTrace.a3.movePreprended).toBe(false);
  });

  it('records mileposts used in moveBudget trace', async () => {
    const movePlan = {
      type: AIActionType.MoveTrain,
      path: [{ row: 1, col: 1 }, { row: 2, col: 2 }, { row: 3, col: 3 }],
      fees: new Set<string>(),
      totalFee: 0,
    };
    mockResolveMove.mockResolvedValue({ success: true, plan: movePlan });
    mockComputeEffectivePathLength.mockReturnValue(5); // consumed 5 mileposts

    const route = makeRoute({
      stops: [makeStop('pickup', 'Berlin', 'Coal')],
      currentStopIndex: 0,
    });
    const context = makeContext({
      speed: 9,
      position: { city: 'Paris', row: 1, col: 1 },
      citiesOnNetwork: ['Berlin'],
    });
    const snapshot = makeSnapshot();

    const result = await TurnExecutorPlanner.execute(route, snapshot, context);

    expect(result.compositionTrace.moveBudget.used).toBe(5);
  });
});

// ── evaluateCargoForDrop ───────────────────────────────────────────────────

describe('TurnExecutorPlanner.evaluateCargoForDrop', () => {
  function makeDemandContext(overrides: Partial<{
    loadType: string;
    payout: number;
    isDeliveryOnNetwork: boolean;
    estimatedTrackCostToDelivery: number;
  }> = {}) {
    return {
      loadType: overrides.loadType ?? 'Coal',
      payout: overrides.payout ?? 8,
      isDeliveryOnNetwork: overrides.isDeliveryOnNetwork ?? false,
      estimatedTrackCostToDelivery: overrides.estimatedTrackCostToDelivery ?? 10,
      // Minimal required fields
      deliveryCity: 'Berlin',
      cardIndex: 1,
      isLoadOnTrain: false,
      isDeliveryReachable: false,
    } as any;
  }

  function makeSnapshotWithLoads(loads: string[]): WorldSnapshot {
    return {
      ...makeSnapshot(),
      bot: { ...makeSnapshot().bot, loads },
    } as unknown as WorldSnapshot;
  }

  it('returns null when bot carries no loads', () => {
    const snapshot = makeSnapshotWithLoads([]);
    const context = makeContext();

    expect(TurnExecutorPlanner.evaluateCargoForDrop(snapshot, context)).toBeNull();
  });

  it('scores loads with no demand card as Infinity (worst)', () => {
    const snapshot = makeSnapshotWithLoads(['Coal']);
    const context = makeContext({ demands: [] }); // no demands

    const result = TurnExecutorPlanner.evaluateCargoForDrop(snapshot, context);

    expect(result).not.toBeNull();
    expect(result!.loadType).toBe('Coal');
    expect(result!.score).toBe(Infinity);
  });

  it('scores delivery-on-network as 0 (best — keep)', () => {
    const snapshot = makeSnapshotWithLoads(['Coal']);
    const context = makeContext({
      demands: [makeDemandContext({ loadType: 'Coal', isDeliveryOnNetwork: true })],
    });

    const result = TurnExecutorPlanner.evaluateCargoForDrop(snapshot, context);

    expect(result!.score).toBe(0);
  });

  it('returns the worst-scored load when multiple loads carried', () => {
    const snapshot = makeSnapshotWithLoads(['Wine', 'Coal']);
    const context = makeContext({
      demands: [
        // Wine: score = 15 - 10 = 5 (high = bad)
        makeDemandContext({ loadType: 'Wine', estimatedTrackCostToDelivery: 15, payout: 10 }),
        // Coal: on network = 0 (good)
        makeDemandContext({ loadType: 'Coal', isDeliveryOnNetwork: true }),
      ],
    });

    const result = TurnExecutorPlanner.evaluateCargoForDrop(snapshot, context);

    // Wine has the worse score (5 > 0) — should be returned
    expect(result!.loadType).toBe('Wine');
  });

  it('picks the no-demand load over a feasible one', () => {
    const snapshot = makeSnapshotWithLoads(['OrphanLoad', 'Coal']);
    const context = makeContext({
      demands: [
        makeDemandContext({ loadType: 'Coal', isDeliveryOnNetwork: true }), // score=0
        // OrphanLoad has no demand → Infinity
      ],
    });

    const result = TurnExecutorPlanner.evaluateCargoForDrop(snapshot, context);

    expect(result!.loadType).toBe('OrphanLoad');
    expect(result!.score).toBe(Infinity);
  });
});

// ── execute() — full-capacity drop recovery ────────────────────────────────

describe('TurnExecutorPlanner.execute — full-capacity drop recovery', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockIsStopComplete.mockReturnValue(false);
    mockResolveBuildTarget.mockReturnValue(null);
    mockRevalidate.mockImplementation((route: StrategicRoute) => route);
    mockComputeEffectivePathLength.mockReturnValue(3);
  });

  it('emits a DropLoad plan when pickup fails due to full capacity', async () => {
    // Pickup fails with "full" error
    mockResolve.mockResolvedValue({ success: false, error: 'Train is full (2/2).' });

    const route = makeRoute({
      stops: [makeStop('pickup', 'Paris', 'Wine')],
      currentStopIndex: 0,
    });
    const context = makeContext({
      position: { city: 'Paris', row: 1, col: 1 },
      // Bot is carrying Coal which has no demand → Infinity score → drop it
      demands: [],
    });
    const snapshot = {
      ...makeSnapshot(),
      bot: { ...makeSnapshot().bot, loads: ['Coal'] },
    } as unknown as WorldSnapshot;

    const result = await TurnExecutorPlanner.execute(route, snapshot, context);

    const dropPlan = result.plans.find(p => p.type === AIActionType.DropLoad);
    expect(dropPlan).toBeDefined();
    expect((dropPlan as any).load).toBe('Coal');
    expect((dropPlan as any).city).toBe('Paris');
  });
});

// ── execute() — post-delivery replan ──────────────────────────────────────

describe('TurnExecutorPlanner.execute — post-delivery replan', () => {
  let mockPlanTrip: jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    mockIsStopComplete.mockReturnValue(false);
    mockResolveBuildTarget.mockReturnValue(null);
    mockRevalidate.mockImplementation((route: StrategicRoute) => route);
    mockComputeEffectivePathLength.mockReturnValue(3);

    // Reset TripPlanner mock instance behaviour for each test
    mockPlanTrip = jest.fn().mockResolvedValue({ route: null, llmLog: [] });
    MockTripPlanner.mockImplementation(() => ({ planTrip: mockPlanTrip }) as any);
  });

  it('calls TripPlanner.planTrip() and RouteEnrichmentAdvisor.enrich() after delivery when brain is provided', async () => {
    const deliverPlan = {
      type: AIActionType.DeliverLoad,
      load: 'Coal',
      city: 'Berlin',
      cardId: 42,
      payout: 8,
    };
    mockResolve.mockResolvedValue({ success: true, plan: deliverPlan });

    const newRoute = makeRoute({
      stops: [makeStop('pickup', 'Lyon', 'Wine'), makeStop('deliver', 'Madrid', 'Wine')],
      currentStopIndex: 0,
    });
    mockPlanTrip.mockResolvedValue({ route: newRoute, llmLog: [] });
    mockEnrich.mockReturnValue(newRoute);

    const route = makeRoute({
      stops: [makeStop('deliver', 'Berlin', 'Coal')],
      currentStopIndex: 0,
    });
    const context = makeContext({ position: { city: 'Berlin', row: 2, col: 2 } });
    const snapshot = makeSnapshot();
    const fakeBrain = {} as any;
    const fakeGridPoints = [{ row: 1, col: 1, name: 'TestCity' }] as any;

    await TurnExecutorPlanner.execute(route, snapshot, context, fakeBrain, fakeGridPoints);

    expect(mockPlanTrip).toHaveBeenCalledWith(snapshot, context, fakeGridPoints, expect.anything());
    expect(mockEnrich).toHaveBeenCalledWith(newRoute);
  });

  it('replaces active route with the enriched route returned by TripPlanner', async () => {
    const deliverPlan = {
      type: AIActionType.DeliverLoad,
      load: 'Coal',
      city: 'Berlin',
      cardId: 42,
      payout: 8,
    };
    mockResolve.mockResolvedValue({ success: true, plan: deliverPlan });

    const newRoute = makeRoute({
      stops: [makeStop('pickup', 'Lyon', 'Wine'), makeStop('deliver', 'Madrid', 'Wine')],
      currentStopIndex: 0,
      reasoning: 'replanned route',
    });
    mockPlanTrip.mockResolvedValue({ route: newRoute, llmLog: [] });
    mockEnrich.mockReturnValue(newRoute);

    const route = makeRoute({
      stops: [makeStop('deliver', 'Berlin', 'Coal')],
      currentStopIndex: 0,
    });
    const context = makeContext({ position: { city: 'Berlin', row: 2, col: 2 } });
    const snapshot = makeSnapshot();
    const fakeBrain = {} as any;
    const fakeGridPoints = [{ row: 1, col: 1, name: 'TestCity' }] as any;

    const result = await TurnExecutorPlanner.execute(route, snapshot, context, fakeBrain, fakeGridPoints);

    // updatedRoute should reflect the new replanned route
    expect(result.updatedRoute.reasoning).toBe('replanned route');
  });

  it('falls back to revalidateRemainingDeliveries when TripPlanner returns null route', async () => {
    const deliverPlan = {
      type: AIActionType.DeliverLoad,
      load: 'Coal',
      city: 'Berlin',
      cardId: 42,
      payout: 8,
    };
    mockResolve.mockResolvedValue({ success: true, plan: deliverPlan });

    // TripPlanner returns null route
    mockPlanTrip.mockResolvedValue({ route: null, llmLog: [] });

    const route = makeRoute({
      stops: [makeStop('deliver', 'Berlin', 'Coal')],
      currentStopIndex: 0,
    });
    const context = makeContext({ position: { city: 'Berlin', row: 2, col: 2 } });
    const snapshot = makeSnapshot();
    const fakeBrain = {} as any;
    const fakeGridPoints = [{ row: 1, col: 1, name: 'TestCity' }] as any;

    await TurnExecutorPlanner.execute(route, snapshot, context, fakeBrain, fakeGridPoints);

    // Should fall back to revalidateRemainingDeliveries instead
    expect(mockRevalidate).toHaveBeenCalled();
    // enrich should NOT have been called since TripPlanner returned null
    expect(mockEnrich).not.toHaveBeenCalled();
  });

  it('does NOT call TripPlanner when brain is not provided', async () => {
    const deliverPlan = {
      type: AIActionType.DeliverLoad,
      load: 'Coal',
      city: 'Berlin',
      cardId: 42,
      payout: 8,
    };
    mockResolve.mockResolvedValue({ success: true, plan: deliverPlan });

    const route = makeRoute({
      stops: [makeStop('deliver', 'Berlin', 'Coal')],
      currentStopIndex: 0,
    });
    const context = makeContext({ position: { city: 'Berlin', row: 2, col: 2 } });
    const snapshot = makeSnapshot();

    // No brain passed → no TripPlanner
    await TurnExecutorPlanner.execute(route, snapshot, context);

    expect(mockPlanTrip).not.toHaveBeenCalled();
    // Falls back to revalidateRemainingDeliveries
    expect(mockRevalidate).toHaveBeenCalled();
  });

  it('RouteEnrichmentAdvisor.enrich() stub returns the route unchanged', () => {
    // Reset enrich to the default pass-through behaviour (previous tests may override it)
    mockEnrich.mockImplementation((r: StrategicRoute) => r);

    // Direct unit test of the stub behaviour (independent of execute())
    const route = makeRoute({ reasoning: 'original route' });
    const result = RouteEnrichmentAdvisor.enrich(route);
    // In Project 1 the stub returns the same route object
    expect(result).toBe(route);
  });
});

// ── Route mutation invariants (AC13) ──────────────────────────────────────

describe('TurnExecutorPlanner — AC13(b): assertBuildDirectionAgreesWithMove', () => {
  it('does not throw when build target is after move target in route', () => {
    const route = makeRoute({
      stops: [makeStop('pickup', 'Paris', 'Wine'), makeStop('deliver', 'München', 'Wine')],
      currentStopIndex: 0,
    });
    // Move toward Paris (index 0), build toward München (index 1) — valid
    expect(() => {
      TurnExecutorPlanner.assertBuildDirectionAgreesWithMove('München', 'Paris', route, '[test]');
    }).not.toThrow();
  });

  it('does not throw when build and move targets are the same city', () => {
    const route = makeRoute({
      stops: [makeStop('pickup', 'Paris', 'Wine'), makeStop('deliver', 'München', 'Wine')],
      currentStopIndex: 0,
    });
    expect(() => {
      TurnExecutorPlanner.assertBuildDirectionAgreesWithMove('Paris', 'Paris', route, '[test]');
    }).not.toThrow();
  });

  it('throws when build target is BEFORE move target in route', () => {
    const route = makeRoute({
      stops: [makeStop('pickup', 'Paris', 'Wine'), makeStop('deliver', 'München', 'Wine')],
      currentStopIndex: 0,
    });
    // Move toward München (index 1), build toward Paris (index 0) — contradictory
    expect(() => {
      TurnExecutorPlanner.assertBuildDirectionAgreesWithMove('Paris', 'München', route, '[test]');
    }).toThrow('INVARIANT VIOLATION');
  });

  it('does not throw when buildTargetCity is null', () => {
    const route = makeRoute();
    expect(() => {
      TurnExecutorPlanner.assertBuildDirectionAgreesWithMove(null, 'Paris', route, '[test]');
    }).not.toThrow();
  });

  it('does not throw when moveTargetCity is null', () => {
    const route = makeRoute();
    expect(() => {
      TurnExecutorPlanner.assertBuildDirectionAgreesWithMove('München', null, route, '[test]');
    }).not.toThrow();
  });

  it('does not throw when either city is not in the route', () => {
    const route = makeRoute({
      stops: [makeStop('pickup', 'Paris', 'Wine')],
      currentStopIndex: 0,
    });
    // Madrid not in route — cannot determine direction
    expect(() => {
      TurnExecutorPlanner.assertBuildDirectionAgreesWithMove('Madrid', 'Paris', route, '[test]');
    }).not.toThrow();
  });
});

describe('TurnExecutorPlanner — AC13(c): assertStopsNotMutatedAfterPickup', () => {
  const tag = '[test]';

  it('does not throw when stops array is the same reference', () => {
    const stops = [makeStop('pickup', 'Paris')];
    expect(() => {
      TurnExecutorPlanner.assertStopsNotMutatedAfterPickup(stops, stops, 'pickup', tag);
    }).not.toThrow();
  });

  it('does not throw when stops array is a copy with identical stops', () => {
    const stopsA = [makeStop('pickup', 'Paris', 'Coal')];
    const stopsB = [makeStop('pickup', 'Paris', 'Coal')]; // same content, different ref
    expect(() => {
      TurnExecutorPlanner.assertStopsNotMutatedAfterPickup(stopsA, stopsB, 'pickup', tag);
    }).not.toThrow();
  });

  it('throws when stops array length changes (insertion)', () => {
    const before = [makeStop('pickup', 'Paris')];
    const after = [makeStop('pickup', 'Paris'), makeStop('deliver', 'Berlin')];
    expect(() => {
      TurnExecutorPlanner.assertStopsNotMutatedAfterPickup(before, after, 'pickup', tag);
    }).toThrow('INVARIANT VIOLATION');
  });

  it('throws when a stop city is changed', () => {
    const before = [makeStop('pickup', 'Paris', 'Coal')];
    const after = [makeStop('pickup', 'München', 'Coal')]; // city changed
    expect(() => {
      TurnExecutorPlanner.assertStopsNotMutatedAfterPickup(before, after, 'pickup', tag);
    }).toThrow('INVARIANT VIOLATION');
  });

  it('throws when a stop action is changed', () => {
    const before = [makeStop('pickup', 'Paris', 'Coal')];
    const after = [makeStop('deliver', 'Paris', 'Coal')]; // action changed
    expect(() => {
      TurnExecutorPlanner.assertStopsNotMutatedAfterPickup(before, after, 'pickup', tag);
    }).toThrow('INVARIANT VIOLATION');
  });
});

// ── execute() — Phase B: build phase ──────────────────────────────────────

describe('TurnExecutorPlanner.execute — Phase B: build phase', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Movement loop: bot not at any city, city not on network → terminates immediately
    mockIsStopComplete.mockReturnValue(false);
    mockRevalidate.mockImplementation((route: StrategicRoute) => route);
    mockComputeEffectivePathLength.mockReturnValue(3);
    // A3: no frontier nodes by default so Phase B tests are not disrupted
    mockGetNetworkFrontier.mockReturnValue([]);
    // JIT gate: build not deferred by default
    mockShouldDeferBuild.mockReturnValue({
      deferred: false,
      reason: 'build_needed',
      trackRunway: 0,
      intermediateStopTurns: 0,
      effectiveRunway: 0,
    });
    mockBuildAdvisorAdvise.mockResolvedValue(null);
    mockBuildAdvisorRetry.mockResolvedValue(null);
  });

  it('skips build and emits PassTurn when no build target', async () => {
    mockResolveBuildTarget.mockReturnValue(null);

    const route = makeRoute({
      stops: [makeStop('pickup', 'München', 'Coal')],
      currentStopIndex: 0,
    });
    const context = makeContext({ citiesOnNetwork: [] });
    const snapshot = makeSnapshot();

    const result = await TurnExecutorPlanner.execute(route, snapshot, context);

    expect(result.compositionTrace.build.skipped).toBe(true);
    expect(result.compositionTrace.build.target).toBeNull();
    expect(result.plans).toContainEqual({ type: AIActionType.PassTurn });
  });

  it('emits a BuildTrack plan when heuristic fallback succeeds', async () => {
    mockResolveBuildTarget.mockReturnValue({
      targetCity: 'München',
      stopIndex: 0,
      isVictoryBuild: false,
    });

    const buildPlan = {
      type: AIActionType.BuildTrack,
      segments: [{ from: { row: 1, col: 1 }, to: { row: 2, col: 2 }, cost: 3 }],
      targetCity: 'München',
    };
    // ActionResolver: first call is for resolveMove (fails — city not on network),
    // then heuristic BUILD
    mockResolve.mockResolvedValue({ success: true, plan: buildPlan });

    const route = makeRoute({
      stops: [makeStop('pickup', 'München', 'Coal')],
      currentStopIndex: 0,
    });
    const context = makeContext({ citiesOnNetwork: [] });
    const snapshot = makeSnapshot();

    const result = await TurnExecutorPlanner.execute(route, snapshot, context);

    expect(result.compositionTrace.build.target).toBe('München');
    expect(result.plans).toContainEqual(buildPlan);
  });

  it('defers build when JIT gate returns deferred=true', async () => {
    mockResolveBuildTarget.mockReturnValue({
      targetCity: 'München',
      stopIndex: 0,
      isVictoryBuild: false,
    });
    mockShouldDeferBuild.mockReturnValue({
      deferred: true,
      reason: 'sufficient_runway',
      trackRunway: 3,
      intermediateStopTurns: 0,
      effectiveRunway: 3,
    });

    const route = makeRoute({
      stops: [makeStop('pickup', 'München', 'Coal')],
      currentStopIndex: 0,
    });
    const context = makeContext({ citiesOnNetwork: [] });
    const snapshot = makeSnapshot();
    const fakeBrain = {} as any;
    const fakeGridPoints = [{ row: 1, col: 1, name: 'TestCity' }] as any;

    const result = await TurnExecutorPlanner.execute(route, snapshot, context, fakeBrain, fakeGridPoints);

    expect(result.compositionTrace.build.skipped).toBe(true);
    // BuildAdvisor should NOT have been called because JIT gate deferred
    expect(mockBuildAdvisorAdvise).not.toHaveBeenCalled();
    expect(result.plans).toContainEqual({ type: AIActionType.PassTurn });
  });

  it('calls BuildAdvisor.advise() when brain and gridPoints are provided', async () => {
    mockResolveBuildTarget.mockReturnValue({
      targetCity: 'Frankfurt',
      stopIndex: 0,
      isVictoryBuild: false,
    });

    const buildPlan = {
      type: AIActionType.BuildTrack,
      segments: [{ from: { row: 1, col: 1 }, to: { row: 2, col: 2 }, cost: 2 }],
      targetCity: 'Frankfurt',
    };
    mockBuildAdvisorAdvise.mockResolvedValue({
      action: 'build',
      target: 'Frankfurt',
      waypoints: [],
      reasoning: 'LLM says build here',
    });
    mockResolve.mockResolvedValue({ success: true, plan: buildPlan });

    const route = makeRoute({
      stops: [makeStop('pickup', 'Frankfurt', 'Coal')],
      currentStopIndex: 0,
    });
    const context = makeContext({ citiesOnNetwork: [] });
    const snapshot = makeSnapshot();
    const fakeBrain = {} as any;
    const fakeGridPoints = [{ row: 1, col: 1, name: 'TestCity' }] as any;

    const result = await TurnExecutorPlanner.execute(route, snapshot, context, fakeBrain, fakeGridPoints);

    expect(mockBuildAdvisorAdvise).toHaveBeenCalledWith(snapshot, context, route, fakeGridPoints, fakeBrain);
    expect(result.plans).toContainEqual(buildPlan);
  });

  it('falls back to heuristic when BuildAdvisor returns null', async () => {
    mockResolveBuildTarget.mockReturnValue({
      targetCity: 'Ruhr',
      stopIndex: 0,
      isVictoryBuild: false,
    });

    mockBuildAdvisorAdvise.mockResolvedValue(null); // Advisor fails

    const buildPlan = {
      type: AIActionType.BuildTrack,
      segments: [{ from: { row: 5, col: 5 }, to: { row: 6, col: 6 }, cost: 1 }],
      targetCity: 'Ruhr',
    };
    mockResolve.mockResolvedValue({ success: true, plan: buildPlan });

    const route = makeRoute({
      stops: [makeStop('pickup', 'Ruhr', 'Coal')],
      currentStopIndex: 0,
    });
    const context = makeContext({ citiesOnNetwork: [] });
    const snapshot = makeSnapshot();
    const fakeBrain = {} as any;
    const fakeGridPoints = [{ row: 1, col: 1, name: 'TestCity' }] as any;

    const result = await TurnExecutorPlanner.execute(route, snapshot, context, fakeBrain, fakeGridPoints);

    expect(result.plans).toContainEqual(buildPlan);
    // Should still have called build heuristic
    expect(mockResolve).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'BUILD' }),
      snapshot,
      context,
      expect.anything(),
    );
  });

  it('victory builds skip the JIT gate', async () => {
    mockResolveBuildTarget.mockReturnValue({
      targetCity: 'Madrid',
      stopIndex: -1,
      isVictoryBuild: true,
    });

    const buildPlan = {
      type: AIActionType.BuildTrack,
      segments: [{ from: { row: 1, col: 1 }, to: { row: 2, col: 2 }, cost: 5 }],
      targetCity: 'Madrid',
    };
    mockResolve.mockResolvedValue({ success: true, plan: buildPlan });

    const route = makeRoute({
      stops: [makeStop('pickup', 'Madrid', 'Wine')],
      currentStopIndex: 0,
    });
    const context = makeContext({ citiesOnNetwork: [], money: 300 });
    const snapshot = makeSnapshot();
    const fakeBrain = {} as any;
    const fakeGridPoints = [{ row: 1, col: 1, name: 'TestCity' }] as any;

    await TurnExecutorPlanner.execute(route, snapshot, context, fakeBrain, fakeGridPoints);

    // JIT gate should NOT be called for victory builds
    expect(mockShouldDeferBuild).not.toHaveBeenCalled();
  });
});

// ── filterByDirection (AC12 / R10) ─────────────────────────────────────────
//
// Verifies that when BuildAdvisor returns null, filterByDirection derives
// buildTargetCity from the route via resolveBuildTarget() rather than using
// the current stop city (the old TurnComposer bug).

describe('TurnExecutorPlanner.filterByDirection', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Default grid: bot at row=5,col=5; München at row=3,col=3 (closer to target);
    // Paris at row=8,col=8 (farther from target: Madrid at row=2,col=2)
    const grid = new Map<string, { name?: string; row: number; col: number }>([
      ['3,3', { name: 'München', row: 3, col: 3 }],
      ['8,8', { name: 'Paris', row: 8, col: 8 }],
      ['2,2', { name: 'Madrid', row: 2, col: 2 }],
    ]);
    mockLoadGridPoints.mockReturnValue(grid);
  });

  it('returns all targets when context.position is null', () => {
    const route = makeRoute();
    const context = makeContext({ position: null });
    const result = TurnExecutorPlanner.filterByDirection(
      ['München', 'Paris'],
      context,
      route,
      'Madrid',
    );
    expect(result).toEqual(['München', 'Paris']);
  });

  it('filters to cities closer to explicit advisorBuildTargetCity', () => {
    // Bot at (5,5). Madrid at (2,2). botDist = |5-2|+|5-2| = 6.
    // München at (3,3): candidateDist = |3-2|+|3-2| = 2 ≤ 6 → keep
    // Paris at (8,8): candidateDist = |8-2|+|8-2| = 12 > 6 → exclude
    const route = makeRoute();
    const context = makeContext({ position: { city: 'Berlin', row: 5, col: 5 } });
    const result = TurnExecutorPlanner.filterByDirection(
      ['München', 'Paris'],
      context,
      route,
      'Madrid',
    );
    expect(result).toContain('München');
    expect(result).not.toContain('Paris');
  });

  it('derives buildTargetCity from route via resolveBuildTarget() when advisor returns null (AC12)', () => {
    // AC12: advisorBuildTargetCity is null → should use resolveBuildTarget() to find target
    mockResolveBuildTarget.mockReturnValue({
      targetCity: 'Madrid',
      stopIndex: 1,
      isVictoryBuild: false,
    });

    // Bot at (5,5). resolveBuildTarget returns Madrid (2,2). botDist = 6.
    // München at (3,3): candidateDist = 2 ≤ 6 → keep
    // Paris at (8,8): candidateDist = 12 > 6 → exclude
    const route = makeRoute({
      stops: [makeStop('pickup', 'Berlin', 'Coal'), makeStop('deliver', 'Madrid', 'Coal')],
      currentStopIndex: 0,
    });
    const context = makeContext({ position: { city: 'Berlin', row: 5, col: 5 } });
    const result = TurnExecutorPlanner.filterByDirection(
      ['München', 'Paris'],
      context,
      route,
      null, // null = advisor returned null
    );

    expect(mockResolveBuildTarget).toHaveBeenCalledWith(route, context);
    expect(result).toContain('München');
    expect(result).not.toContain('Paris');
  });

  it('returns all targets when both advisorBuildTargetCity is null and resolveBuildTarget returns null', () => {
    mockResolveBuildTarget.mockReturnValue(null);

    const route = makeRoute();
    const context = makeContext({ position: { city: 'Berlin', row: 5, col: 5 } });
    const result = TurnExecutorPlanner.filterByDirection(
      ['München', 'Paris'],
      context,
      route,
      null,
    );
    expect(result).toEqual(['München', 'Paris']);
  });

  it('excludes cities not found in the grid', () => {
    const route = makeRoute();
    const context = makeContext({ position: { city: 'Berlin', row: 5, col: 5 } });
    const result = TurnExecutorPlanner.filterByDirection(
      ['München', 'UnknownCity'],
      context,
      route,
      'Madrid',
    );
    expect(result).toContain('München');
    expect(result).not.toContain('UnknownCity');
  });

  it('keeps a city that is equidistant to the build target', () => {
    // Bot at (5,5). Madrid at (2,2). botDist = 6.
    // Add an equidistant city at (5,8): dist = |5-2|+|8-2| = 9. No wait — let's use grid adjustment.
    // Actually add a city at exactly dist=6 from Madrid (2,2):
    // e.g. (8,2) → dist = |8-2|+|2-2| = 6. Equidistant → should keep.
    const grid = new Map<string, { name?: string; row: number; col: number }>([
      ['3,3', { name: 'München', row: 3, col: 3 }],
      ['8,2', { name: 'Equidistant', row: 8, col: 2 }],
      ['2,2', { name: 'Madrid', row: 2, col: 2 }],
    ]);
    mockLoadGridPoints.mockReturnValue(grid);

    const route = makeRoute();
    const context = makeContext({ position: { city: 'Berlin', row: 5, col: 5 } });
    const result = TurnExecutorPlanner.filterByDirection(
      ['München', 'Equidistant'],
      context,
      route,
      'Madrid',
    );
    expect(result).toContain('Equidistant'); // equidistant → keep
    expect(result).toContain('München');
  });
});
