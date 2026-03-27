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

import { isStopComplete, resolveBuildTarget } from '../../services/ai/routeHelpers';
import { ActionResolver } from '../../services/ai/ActionResolver';
import { PlanExecutor } from '../../services/ai/PlanExecutor';
import { computeEffectivePathLength } from '../../../shared/services/majorCityGroups';

const mockIsStopComplete = isStopComplete as jest.Mock;
const mockResolveBuildTarget = resolveBuildTarget as jest.Mock;
const mockResolve = ActionResolver.resolve as jest.Mock;
const mockResolveMove = ActionResolver.resolveMove as jest.Mock;
const mockRevalidate = PlanExecutor.revalidateRemainingDeliveries as jest.Mock;
const mockComputeEffectivePathLength = computeEffectivePathLength as jest.Mock;

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

  it('breaks to Phase B when stop city is not on network', async () => {
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
