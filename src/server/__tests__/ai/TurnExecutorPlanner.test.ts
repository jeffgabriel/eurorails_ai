/**
 * TurnExecutorPlanner unit tests.
 *
 * Tests the shell execute() entry point and helper methods:
 * - skipCompletedStops: advances past completed stops
 * - assertStopIndexNotDecreased: invariant guard
 * - execute(): returns PassTurn stub, resolves build target, handles route complete
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

import { isStopComplete, resolveBuildTarget } from '../../services/ai/routeHelpers';

const mockIsStopComplete = isStopComplete as jest.Mock;
const mockResolveBuildTarget = resolveBuildTarget as jest.Mock;

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
    id: 'route-1',
    stops: [makeStop('pickup', 'Paris'), makeStop('deliver', 'Berlin')],
    currentStopIndex: 0,
    startingCity: 'Paris',
    buildTargetCity: null,
    ...overrides,
  };
}

function makeContext(overrides: Partial<GameContext> = {}): GameContext {
  return {
    money: 100,
    speed: 9,
    loads: [],
    demands: [],
    citiesOnNetwork: [],
    connectedMajorCities: [],
    unconnectedMajorCities: [],
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
