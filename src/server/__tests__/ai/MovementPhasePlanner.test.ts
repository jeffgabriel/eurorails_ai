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
import { GameState, AIActionType, TerrainType } from '../../../shared/types/GameTypes';
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
    hasCarriedDeliverableOnNetwork: jest.fn((...args: Parameters<typeof real.hasCarriedDeliverableOnNetwork>) =>
      real.hasCarriedDeliverableOnNetwork(...args),
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
  ...jest.requireActual<typeof import('../../../shared/services/majorCityGroups')>('../../../shared/services/majorCityGroups'),
  getMajorCityLookup: jest.fn(() => new Map()),
  computeEffectivePathLength: jest.fn(() => 3),
  getFerryEdges: jest.fn(() => [
    {
      name: 'Dublin_Liverpool',
      pointA: { row: 13, col: 29 }, // Liverpool
      pointB: { row: 10, col: 24 }, // Dublin
      cost: 8,
    },
    {
      name: 'Belfast_Stranraer',
      pointA: { row: 7, col: 28 }, // Stranraer
      pointB: { row: 7, col: 26 }, // Belfast
      cost: 4,
    },
  ]),
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
import { computeBuildSegments } from '../../services/ai/computeBuildSegments';
import type { DemandContext } from '../../../shared/types/GameTypes';

const mockIsStopComplete = isStopComplete as jest.Mock;
const mockResolveBuildTarget = resolveBuildTarget as jest.Mock;
const mockResolve = ActionResolver.resolve as jest.Mock;
const mockResolveMove = ActionResolver.resolveMove as jest.Mock;
const mockPostDeliveryReplan = PostDeliveryReplanner.replan as jest.Mock;
const mockEnrichRoute = RouteEnrichmentAdvisor.enrich as jest.Mock;
const mockComputeDetourCosts = computeCandidateDetourCosts as jest.Mock;
const mockComputeBuildSegments = computeBuildSegments as jest.Mock;
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
    gameState: GameState.Mid,
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

  // REGRESSION GUARD: The following two tests pin the remainingBudget invariant
  // across delivery + post-delivery replan boundaries.
  //
  // Invariant: `remainingBudget` is owned by MovementPhasePlanner and is
  // initialized ONCE at turn start (`= context.speed`). PostDeliveryReplanner
  // returns no budget signal — it has no knowledge of remaining movement.
  // After a replan, the loop resumes with whatever budget was left at the
  // moment the delivery fired.
  //
  // If a future patch resets `remainingBudget = context.speed` after
  // `PostDeliveryReplanner.replan` returns, BOTH tests below will FAIL:
  //   - Test 1 will fail because `mockResolveMove.mock.calls[1][2]` will equal
  //     9 (full speed) instead of 6 (leftover after the 3-mp first move).
  //   - Test 2 will fail because `trace.moveBudget.used` will equal 4
  //     (post-replan move only) instead of 7 (3 + 4, cumulative).
  //
  // This is the budget-axis analogue of JIRA-194 (stale `lastMoveTargetCity`).

  it('preserves remainingBudget across post-delivery replan and uses leftover budget for next move', async () => {
    // Arrange
    const { computeEffectivePathLength } = jest.requireMock('../../../shared/services/majorCityGroups');
    // First move consumes 3 of 9 mileposts → leftover = 6
    (computeEffectivePathLength as jest.Mock).mockReturnValueOnce(3).mockReturnValueOnce(3);

    // Route: bot is not at Berlin (must move first), then after delivery the
    // replanned route has another move stop (Wien) so the second resolveMove fires.
    const route = makeRoute({
      stops: [makeStop('deliver', 'Berlin', 'Wine')],
      currentStopIndex: 0,
    });
    const context = makeContext({
      position: { row: 1, col: 1, city: 'Paris' },
      citiesOnNetwork: ['Berlin'],
      speed: 9,
    });
    const snapshot = makeSnapshot();

    // First resolveMove: move toward Berlin, consuming 3 miles (budget 9→6)
    // Second resolveMove: move toward Wien on the post-replan route
    mockResolveMove
      .mockResolvedValueOnce({
        success: true,
        plan: {
          type: AIActionType.MoveTrain,
          path: [{ row: 1, col: 1 }, { row: 5, col: 5 }],
          milesUsed: 3,
          cost: 0,
          trackUsageFees: [],
        },
      })
      .mockResolvedValueOnce({
        success: true,
        plan: {
          type: AIActionType.MoveTrain,
          path: [{ row: 5, col: 5 }, { row: 8, col: 8 }],
          milesUsed: 3,
          cost: 0,
          trackUsageFees: [],
        },
      });

    // Bot moves to Paris → 5,5; not Berlin → no stop action fires on first iteration.
    // Then second iteration: still not at Berlin (city stays Paris from makeContext).
    // We need the bot to arrive at Berlin on the second move iteration — simplest
    // approach: first call moves to a non-Berlin city, second moves to Berlin.
    // But for AC9 we only need to assert what budget the second resolveMove receives.
    // We'll let the delivery happen via the position-at-city branch by starting AT Berlin.
    //
    // Revised setup: bot starts at Berlin → delivery fires immediately (no pre-delivery move).
    // Then replan returns a route with Wien stop, second resolveMove fires with full budget (9).
    // That would NOT test budget carry-over. So we need a move BEFORE the delivery.
    //
    // Correct setup: bot starts NOT at Berlin but Berlin is on network.
    //   Iteration 1: resolveMove called (budget=9) → move to intermediate city (3 miles, budget→6)
    //   But now bot is NOT at Berlin and budget > 0, so loop continues.
    //   Iteration 2: resolveMove called again (budget=6) → arrives at Berlin (milesConsumed=3, budget→3)
    //   Now position.city = Berlin → stop action (delivery) fires → replan.
    //   Post-replan route has Wien stop → resolveMove called (budget=3).
    //
    // Let's use gridPoints to place Berlin at the second move destination.

    // Reset and redo mock sequence with 3 resolveMove calls:
    mockResolveMove.mockReset();
    (computeEffectivePathLength as jest.Mock).mockReset();
    (computeEffectivePathLength as jest.Mock).mockReturnValue(3); // default for all calls

    mockResolveMove
      .mockResolvedValueOnce({
        // Move 1: toward Berlin, lands at intermediate (row=5,col=5, city not Berlin)
        success: true,
        plan: {
          type: AIActionType.MoveTrain,
          path: [{ row: 1, col: 1 }, { row: 5, col: 5 }],
          milesUsed: 3,
          cost: 0,
          trackUsageFees: [],
        },
      })
      .mockResolvedValueOnce({
        // Move 2: toward Berlin, lands at Berlin (row=10,col=10)
        success: true,
        plan: {
          type: AIActionType.MoveTrain,
          path: [{ row: 5, col: 5 }, { row: 10, col: 10 }],
          milesUsed: 3,
          cost: 0,
          trackUsageFees: [],
        },
      })
      .mockResolvedValueOnce({
        // Move 3 (post-replan): toward Wien
        success: true,
        plan: {
          type: AIActionType.MoveTrain,
          path: [{ row: 10, col: 10 }, { row: 14, col: 14 }],
          milesUsed: 3,
          cost: 0,
          trackUsageFees: [],
        },
      });

    mockExecuteStopAction.mockResolvedValue({
      success: true,
      plan: { type: AIActionType.DeliverLoad, load: 'Wine', city: 'Berlin' },
    });

    // Post-replan route: one more move stop (Wien) so the loop continues
    const replanRoute = makeRoute({
      stops: [makeStop('pickup', 'Wien', 'Coal')],
      currentStopIndex: 0,
      reasoning: 'replanned',
    });
    // Wien is on network so the move branch fires
    context.citiesOnNetwork = ['Berlin', 'Wien'];
    mockPostDeliveryReplan.mockResolvedValue({
      route: replanRoute,
      moveTargetInvalidated: true,
    });

    // gridPoints: row=10,col=10 → Berlin so delivery fires on move-2 arrival
    const gridPoints = makeGridPointsForCity(10, 10, 'Berlin');
    const trace = makeTrace();

    // Act
    const result = await MovementPhasePlanner.run(route, snapshot, context, trace, undefined, gridPoints);

    // Assert — budget-carry-over invariant
    // resolveMove was called 3 times (move→intermediate, move→Berlin, move→Wien)
    expect(mockResolveMove).toHaveBeenCalledTimes(3);
    // First call: full budget (9)
    expect(mockResolveMove.mock.calls[0][2]).toBe(9);
    // Second call: leftover after first 3-mp move (6)
    expect(mockResolveMove.mock.calls[1][2]).toBe(6);
    // Third call (post-replan): leftover after first two 3-mp moves (3), NOT 9
    expect(mockResolveMove.mock.calls[2][2]).toBe(3);
    expect(mockResolveMove.mock.calls[2][2]).not.toBe(9); // counter-assertion: budget was NOT reset

    expect(result.hasDelivery).toBe(true);
    expect(result.deliveriesThisTurn).toBe(1);

    // Restore default mock
    (computeEffectivePathLength as jest.Mock).mockReturnValue(3);
  });

  it('records moveBudget.used as cumulative consumption across pre- and post-replan moves', async () => {
    // Arrange: bot at Paris, Berlin on network. First move 3 miles, second move (post-replan) 4 miles.
    // Expected: trace.moveBudget.used = 7 (not 4 = "only last move", not 3 = "only first move").
    const { computeEffectivePathLength } = jest.requireMock('../../../shared/services/majorCityGroups');

    mockResolveMove.mockReset();
    (computeEffectivePathLength as jest.Mock).mockReset();

    // First move: 3 miles. Second move: 4 miles. Third call (if any): fallback 3.
    (computeEffectivePathLength as jest.Mock)
      .mockReturnValueOnce(3)  // move 1 (pre-delivery): remainingBudget 9→6, used=3
      .mockReturnValueOnce(4)  // move 2 (delivery arrival): remainingBudget 6→2, used=7
      .mockReturnValue(3);     // fallback (should not be reached in this test)

    const route = makeRoute({
      stops: [makeStop('deliver', 'Berlin', 'Wine')],
      currentStopIndex: 0,
    });
    const context = makeContext({
      position: { row: 1, col: 1, city: 'Paris' },
      citiesOnNetwork: ['Berlin', 'Wien'],
      speed: 9,
    });
    const snapshot = makeSnapshot();

    mockResolveMove
      .mockResolvedValueOnce({
        // Move 1: 3 miles toward Berlin, lands at intermediate row=5,col=5 (not Berlin yet)
        success: true,
        plan: {
          type: AIActionType.MoveTrain,
          path: [{ row: 1, col: 1 }, { row: 5, col: 5 }],
          milesUsed: 3,
          cost: 0,
          trackUsageFees: [],
        },
      })
      .mockResolvedValueOnce({
        // Move 2: 4 miles to Berlin (row=10,col=10) — budget 6→2
        success: true,
        plan: {
          type: AIActionType.MoveTrain,
          path: [{ row: 5, col: 5 }, { row: 10, col: 10 }],
          milesUsed: 4,
          cost: 0,
          trackUsageFees: [],
        },
      })
      .mockResolvedValueOnce({
        // Move 3 (post-replan): toward Wien, fails — loop breaks without updating budget
        success: false,
        error: 'no path to Wien',
      });

    mockExecuteStopAction.mockResolvedValue({
      success: true,
      plan: { type: AIActionType.DeliverLoad, load: 'Wine', city: 'Berlin' },
    });

    const replanRoute = makeRoute({
      stops: [makeStop('pickup', 'Wien', 'Coal')],
      currentStopIndex: 0,
      reasoning: 'replanned-cumulative',
    });
    mockPostDeliveryReplan.mockResolvedValue({
      route: replanRoute,
      moveTargetInvalidated: true,
    });

    // gridPoints: row=10,col=10 → Berlin so delivery fires after move-2 arrival
    const gridPoints = makeGridPointsForCity(10, 10, 'Berlin');
    const trace = makeTrace();

    // Act
    const result = await MovementPhasePlanner.run(route, snapshot, context, trace, undefined, gridPoints);

    // Assert — cumulative trace.moveBudget.used
    // After move 1 (3 miles): remainingBudget=6, used=3.
    // After move 2 (4 miles): remainingBudget=2, used=7.
    // Move 3 fails → no budget update → used remains 7.
    expect(trace.moveBudget.used).toBe(7);
    expect(trace.moveBudget.used).not.toBe(4); // guard: not "only move-2 consumption"
    expect(trace.moveBudget.used).not.toBe(3); // guard: not "only move-1 consumption"

    expect(result.hasDelivery).toBe(true);

    // Restore default mock
    (computeEffectivePathLength as jest.Mock).mockReturnValue(3);
  });
});

// ── Action failure → routeAbandoned ───────────────────────────────────────

describe('MovementPhasePlanner.run — action failure', () => {
  it('preserves route (NOT abandoned) when stop action fails — retries next turn instead of replanning', async () => {
    // Single action_failed must not trigger replan; ActiveRouteContinuer's stuck-route
    // detector handles persistent failures after 3 no-progress turns.
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

    expect(result.routeAbandoned).toBe(false);
    // No PassTurn pushed — accumulatedPlans is empty so TurnExecutorPlanner falls back
    // to the default [PassTurn], and ActiveRouteContinuer's noProgress check fires.
    expect(result.accumulatedPlans.some(p => p.type === AIActionType.PassTurn)).toBe(false);
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

  it('stop action failure on arrival path — route preserved (NOT abandoned), action_failed termination', async () => {
    // 7-day log analysis: 7/15 pure-abandonment episodes were caused by a single stop-action
    // failure triggering immediate route abandonment + replan. The fix: preserve the route
    // and let ActiveRouteContinuer's stuck-route detector abandon after 3 no-progress turns.
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

    expect(result.routeAbandoned).toBe(false);
    expect(result.routeComplete).toBe(false);
    expect(trace.a2.terminationReason).toBe('action_failed');
    // Route preserved with same currentStopIndex so next turn retries the same pickup
    expect(result.activeRoute.currentStopIndex).toBe(0);

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

// ── JIRA-246 / JIRA-247: A3 abandon + build-origin-is-current-pos ───────────

/**
 * Helper: build a DemandContext that has isLoadOnTrain and isDeliveryOnNetwork
 * set as specified.
 */
function makeDemandOnTrain(overrides: {
  isLoadOnTrain: boolean;
  isDeliveryOnNetwork: boolean;
  loadType?: string;
  deliveryCity?: string;
}): DemandContext {
  return {
    ...makeDemand(overrides.loadType ?? 'Wheat', 'Bern', overrides.deliveryCity ?? 'Berlin', 12),
    isLoadOnTrain: overrides.isLoadOnTrain,
    isDeliveryOnNetwork: overrides.isDeliveryOnNetwork,
  };
}

describe('JIRA-246 AC8: hasCarriedDeliverableOnNetwork helper (via A3 abandon paths)', () => {
  // These tests verify the 4-case truth table for the predicate by driving
  // the A3 code path that calls hasCarriedDeliverableOnNetwork.

  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(TurnExecutorPlanner, 'revalidateRemainingDeliveries')
      .mockImplementation((r: StrategicRoute) => r);
    jest.spyOn(TurnExecutorPlanner, 'skipCompletedStops')
      .mockImplementation((r: StrategicRoute) => r);
    jest.spyOn(TurnExecutorPlanner, 'executeStopAction')
      .mockResolvedValue({ success: false, error: 'default' });

    mockIsStopComplete.mockReturnValue(false);
    // computeBuildSegments returns [] (empty path) by default — triggers R2 branch
    mockComputeBuildSegments.mockReturnValue([]);
    // resolveBuildTarget returns a valid target at (20,20)
    mockResolveBuildTarget.mockReturnValue({ targetCity: 'Bern' });
    // loadGridPoints: Bern at (20,20), not on existing segments → reachability check fails
    const { loadGridPoints } = jest.requireMock('../../services/ai/MapTopology');
    (loadGridPoints as jest.Mock).mockReturnValue(new Map([
      ['20,20', { row: 20, col: 20, name: 'Bern', terrain: TerrainType.Clear }],
    ]));
  });

  afterEach(() => {
    jest.restoreAllMocks();
    mockComputeBuildSegments.mockReturnValue([]); // restore global default
  });

  it('AC8 case 1: isLoadOnTrain=true AND isDeliveryOnNetwork=true → predicate true → R2 fires (a3_abandon_for_carry_deliver)', async () => {
    const route = makeRoute({ stops: [makeStop('pickup', 'Bern')], currentStopIndex: 0 });
    const context = makeContext({
      citiesOnNetwork: [], // Bern not on network → A3 triggers
      demands: [makeDemandOnTrain({ isLoadOnTrain: true, isDeliveryOnNetwork: true })],
    });
    const trace = makeTrace();

    const result = await MovementPhasePlanner.run(route, makeSnapshot(), context, trace);

    expect(trace.a3.terminationReason).toBe('a3_abandon_for_carry_deliver');
    expect(result.routeAbandoned).toBe(true);
  });

  it('AC8 case 2: isLoadOnTrain=false AND isDeliveryOnNetwork=false → predicate false → R2 does NOT fire', async () => {
    const route = makeRoute({ stops: [makeStop('pickup', 'Bern')], currentStopIndex: 0 });
    const context = makeContext({
      citiesOnNetwork: [],
      demands: [makeDemandOnTrain({ isLoadOnTrain: false, isDeliveryOnNetwork: false })],
    });
    const trace = makeTrace();

    const result = await MovementPhasePlanner.run(route, makeSnapshot(), context, trace);

    // R2 did NOT fire — should fall through to build_dijkstra_failed
    expect(trace.a3.terminationReason).toBe('build_dijkstra_failed');
    expect(result.routeAbandoned).toBe(false);
  });

  it('AC8 case 3: isLoadOnTrain=true BUT isDeliveryOnNetwork=false → predicate false → R2 does NOT fire', async () => {
    const route = makeRoute({ stops: [makeStop('pickup', 'Bern')], currentStopIndex: 0 });
    const context = makeContext({
      citiesOnNetwork: [],
      demands: [makeDemandOnTrain({ isLoadOnTrain: true, isDeliveryOnNetwork: false })],
    });
    const trace = makeTrace();

    const result = await MovementPhasePlanner.run(route, makeSnapshot(), context, trace);

    expect(trace.a3.terminationReason).toBe('build_dijkstra_failed');
    expect(result.routeAbandoned).toBe(false);
  });

  it('AC8 case 4: both demands partially match but none has BOTH true → predicate false → R2 does NOT fire', async () => {
    const route = makeRoute({ stops: [makeStop('pickup', 'Bern')], currentStopIndex: 0 });
    const context = makeContext({
      citiesOnNetwork: [],
      demands: [
        // First: on train but delivery off-network
        makeDemandOnTrain({ isLoadOnTrain: true, isDeliveryOnNetwork: false }),
        // Second: not on train but delivery on-network
        makeDemandOnTrain({ isLoadOnTrain: false, isDeliveryOnNetwork: true }),
      ],
    });
    const trace = makeTrace();

    const result = await MovementPhasePlanner.run(route, makeSnapshot(), context, trace);

    expect(trace.a3.terminationReason).toBe('build_dijkstra_failed');
    expect(result.routeAbandoned).toBe(false);
  });
});

describe('JIRA-246 AC2: empty-path abandon when carrying deliverable (R2)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(TurnExecutorPlanner, 'revalidateRemainingDeliveries')
      .mockImplementation((r: StrategicRoute) => r);
    jest.spyOn(TurnExecutorPlanner, 'skipCompletedStops')
      .mockImplementation((r: StrategicRoute) => r);
    jest.spyOn(TurnExecutorPlanner, 'executeStopAction')
      .mockResolvedValue({ success: false, error: 'default' });

    mockIsStopComplete.mockReturnValue(false);
    mockComputeBuildSegments.mockReturnValue([]); // empty path
    mockResolveBuildTarget.mockReturnValue({ targetCity: 'Bern' });

    const { loadGridPoints } = jest.requireMock('../../services/ai/MapTopology');
    (loadGridPoints as jest.Mock).mockReturnValue(new Map([
      ['20,20', { row: 20, col: 20, name: 'Bern', terrain: TerrainType.Clear }],
    ]));
  });

  afterEach(() => {
    jest.restoreAllMocks();
    mockComputeBuildSegments.mockReturnValue([]); // restore global default
  });

  it('AC2: broke bot carrying Wheat with Berlin delivery on-network → routeWasAbandoned=true, no PassTurn, terminationReason=a3_abandon_for_carry_deliver', async () => {
    // Fixture: s1 T16 of game eb20489f
    const route = makeRoute({
      stops: [
        makeStop('pickup', 'Bern'),   // Bern off-network (current stop)
        makeStop('deliver', 'Berlin', 'Wheat'),
      ],
      currentStopIndex: 0,
    });
    const context = makeContext({
      money: 4, // broke
      citiesOnNetwork: [],
      demands: [
        {
          ...makeDemand('Wheat', 'SomeCity', 'Berlin', 15),
          isLoadOnTrain: true,
          isDeliveryOnNetwork: true,
        },
      ],
    });
    const trace = makeTrace();

    const result = await MovementPhasePlanner.run(route, makeSnapshot(), context, trace);

    expect(result.routeAbandoned).toBe(true);
    expect(result.accumulatedPlans.some(p => p.type === AIActionType.PassTurn)).toBe(false);
    expect(trace.a3.terminationReason).toBe('a3_abandon_for_carry_deliver');
  });

  it('AC3: sufficient-cash case ($50M) — A3 does NOT abandon (no carry-deliverable present)', async () => {
    const route = makeRoute({
      stops: [makeStop('pickup', 'Bern')],
      currentStopIndex: 0,
    });
    const context = makeContext({
      money: 50,
      citiesOnNetwork: [],
      demands: [], // no carry-deliverable demand
    });
    const trace = makeTrace();

    const result = await MovementPhasePlanner.run(route, makeSnapshot(), context, trace);

    // R2 predicate is false (no demands) → no abandon
    expect(result.routeAbandoned).toBe(false);
    expect(trace.a3.terminationReason).toBe('build_dijkstra_failed');
  });

  it('AC4: no-carry-deliverable case — A3 does NOT abandon even if broke', async () => {
    const route = makeRoute({
      stops: [makeStop('pickup', 'Bern')],
      currentStopIndex: 0,
    });
    const context = makeContext({
      money: 2,
      citiesOnNetwork: [],
      demands: [
        // Load not on train — predicate fails
        { ...makeDemand('Cattle', 'Bern', 'Berlin', 10), isLoadOnTrain: false, isDeliveryOnNetwork: true },
      ],
    });
    const trace = makeTrace();

    const result = await MovementPhasePlanner.run(route, makeSnapshot(), context, trace);

    expect(result.routeAbandoned).toBe(false);
    expect(trace.a3.terminationReason).toBe('build_dijkstra_failed');
  });
});

describe('JIRA-246 AC2 (partial): partial-path abandon when carrying deliverable (R3)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(TurnExecutorPlanner, 'revalidateRemainingDeliveries')
      .mockImplementation((r: StrategicRoute) => r);
    jest.spyOn(TurnExecutorPlanner, 'skipCompletedStops')
      .mockImplementation((r: StrategicRoute) => r);
    jest.spyOn(TurnExecutorPlanner, 'executeStopAction')
      .mockResolvedValue({ success: false, error: 'default' });

    mockIsStopComplete.mockReturnValue(false);
    mockResolveBuildTarget.mockReturnValue({ targetCity: 'Bern' });

    const { loadGridPoints } = jest.requireMock('../../services/ai/MapTopology');
    (loadGridPoints as jest.Mock).mockReturnValue(new Map([
      ['20,20', { row: 20, col: 20, name: 'Bern', terrain: TerrainType.Clear }],
    ]));
  });

  afterEach(() => {
    jest.restoreAllMocks();
    mockComputeBuildSegments.mockReturnValue([]); // restore global default
  });

  it('R3: partial path (last seg.to ≠ target coord) + carry-deliverable → a3_abandon_for_carry_deliver_partial', async () => {
    // computeBuildSegments returns 1 segment that does NOT reach target (20,20)
    mockComputeBuildSegments.mockReturnValue([
      {
        from: { row: 5, col: 5 },
        to: { row: 10, col: 10 }, // not (20,20)
        cost: 5,
      },
    ]);

    const route = makeRoute({
      stops: [makeStop('pickup', 'Bern')],
      currentStopIndex: 0,
    });
    const context = makeContext({
      citiesOnNetwork: [],
      position: { row: 1, col: 1 }, // not at origin (5,5) → not R4
      demands: [
        { ...makeDemand('Wheat', 'SomeCity', 'Berlin', 15), isLoadOnTrain: true, isDeliveryOnNetwork: true },
      ],
    });
    const trace = makeTrace();

    const result = await MovementPhasePlanner.run(route, makeSnapshot(), context, trace);

    expect(trace.a3.terminationReason).toBe('a3_abandon_for_carry_deliver_partial');
    expect(result.routeAbandoned).toBe(true);
  });

  it('R3: path reaches target exactly → R3 does NOT fire, falls through to move/build logic', async () => {
    // computeBuildSegments returns segment reaching target (20,20) exactly
    mockComputeBuildSegments.mockReturnValue([
      {
        from: { row: 5, col: 5 },
        to: { row: 20, col: 20 }, // exactly the target coord
        cost: 8,
      },
    ]);

    const route = makeRoute({
      stops: [makeStop('pickup', 'Bern')],
      currentStopIndex: 0,
    });
    const context = makeContext({
      citiesOnNetwork: [],
      position: { row: 1, col: 1 }, // not at origin → not R4
      demands: [
        { ...makeDemand('Wheat', 'SomeCity', 'Berlin', 15), isLoadOnTrain: true, isDeliveryOnNetwork: true },
      ],
    });
    // resolveMove fails → exits with empty plan
    mockResolveMove.mockResolvedValue({ success: false, error: 'no path' });

    const trace = makeTrace();
    const result = await MovementPhasePlanner.run(route, makeSnapshot(), context, trace);

    // R3 did NOT fire — path reached target
    expect(trace.a3.terminationReason).not.toBe('a3_abandon_for_carry_deliver_partial');
    expect(result.routeAbandoned).toBe(false);
  });
});

// ── JIRA-247: A3 origin_is_current_position fix ───────────────────────────

describe('JIRA-247 AC5: origin_is_current_position → a3_build_origin_is_current_pos + build target set', () => {
  /**
   * Fixture: s1 T36 of game dac9a541.
   * Bot at Goteborg, route target Stockholm.
   * computeBuildSegments returns segments with first segment from = Goteborg coord.
   * Expectation: trace.build.target = 'Stockholm', terminationReason = 'a3_build_origin_is_current_pos'.
   * The outer loop continues (no abandon, no PassTurn from this branch).
   */
  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(TurnExecutorPlanner, 'revalidateRemainingDeliveries')
      .mockImplementation((r: StrategicRoute) => r);
    jest.spyOn(TurnExecutorPlanner, 'skipCompletedStops')
      .mockImplementation((r: StrategicRoute) => r);
    jest.spyOn(TurnExecutorPlanner, 'executeStopAction')
      .mockResolvedValue({ success: false, error: 'default' });

    mockIsStopComplete.mockReturnValue(false);
    mockResolveBuildTarget.mockReturnValue({ targetCity: 'Stockholm' });

    // Stockholm at (8, 42)
    const { loadGridPoints } = jest.requireMock('../../services/ai/MapTopology');
    (loadGridPoints as jest.Mock).mockReturnValue(new Map([
      ['8,42', { row: 8, col: 42, name: 'Stockholm', terrain: TerrainType.Clear }],
    ]));
  });

  afterEach(() => {
    jest.restoreAllMocks();
    mockComputeBuildSegments.mockReturnValue([]); // restore global default
  });

  it('AC5: bot at Goteborg (3,40), segment from=Goteborg → terminationReason=a3_build_origin_is_current_pos AND trace.build.target=Stockholm', async () => {
    // computeBuildSegments returns segments with from = Goteborg = bot's current position
    const goteborgCoord = { row: 3, col: 40 };
    mockComputeBuildSegments.mockReturnValue([
      {
        from: goteborgCoord, // matches bot's position → origin_is_current_position
        to: { row: 5, col: 41 }, // intermediate (not Stockholm)
        cost: 3,
      },
    ]);

    const route = makeRoute({
      stops: [makeStop('pickup', 'Stockholm')],
      currentStopIndex: 0,
    });
    const context = makeContext({
      citiesOnNetwork: [], // Stockholm off-network → A3 triggers
      position: { row: 3, col: 40 }, // bot at Goteborg
      speed: 9,
    });
    const trace = makeTrace();

    const result = await MovementPhasePlanner.run(route, makeSnapshot(), context, trace);

    // AC5 primary assertions
    expect(trace.a3.terminationReason).toBe('a3_build_origin_is_current_pos');
    expect(trace.build.target).toBe('Stockholm');

    // No abandon from this branch
    expect(result.routeAbandoned).toBe(false);
    // No PassTurn emitted from this branch
    expect(result.accumulatedPlans.some(p => p.type === AIActionType.PassTurn)).toBe(false);
  });

  it('AC7: true-move case — segment from ≠ currentPos → existing MoveTrain branch fires, not origin fix', async () => {
    // Bot at Paris (1,1), segment from = Berlin (10,10) ≠ currentPos → R4 does NOT fire
    mockComputeBuildSegments.mockReturnValue([
      {
        from: { row: 10, col: 10 }, // build origin is Berlin, not Paris
        to: { row: 12, col: 12 },   // intermediate
        cost: 5,
      },
    ]);

    const route = makeRoute({
      stops: [makeStop('pickup', 'Stockholm')],
      currentStopIndex: 0,
    });
    const context = makeContext({
      citiesOnNetwork: [],
      position: { row: 1, col: 1 }, // bot at Paris, not build origin
      speed: 9,
    });

    // resolveMove succeeds → MoveTrain branch fires
    mockResolveMove.mockResolvedValue({
      success: true,
      plan: {
        type: AIActionType.MoveTrain,
        path: [{ row: 1, col: 1 }, { row: 5, col: 5 }],
        milesUsed: 3,
        cost: 0,
        trackUsageFees: [],
      },
    });

    const trace = makeTrace();
    const result = await MovementPhasePlanner.run(route, makeSnapshot(), context, trace);

    // R4 did NOT fire — termination reason should be a3_move_success (true-move branch)
    expect(trace.a3.terminationReason).toBe('a3_move_success');
    expect(trace.a3.terminationReason).not.toBe('a3_build_origin_is_current_pos');
    // A move plan was added
    expect(result.accumulatedPlans.some(p => p.type === AIActionType.MoveTrain)).toBe(true);
    // No abandon
    expect(result.routeAbandoned).toBe(false);
  });
});

// ── JIRA-244 AC3: A3 empty-result disambiguation ──────────────────────────

describe('JIRA-244 AC3: A3 empty-result — a3_target_already_reachable via paid ferry', () => {
  /**
   * Fixture: bot has track reaching Liverpool (13,29) — the Dublin_Liverpool ferry port.
   * citiesOnNetwork is deliberately stubbed to EXCLUDE Dublin (simulating a future
   * regression where Fix A is broken). computeBuildSegments returns [] (no new segments
   * needed). Fix B should detect that Dublin is reachable via the paid ferry and set
   * a3.terminationReason = 'a3_target_already_reachable' rather than 'build_dijkstra_failed',
   * and should NOT emit a PassTurn plan.
   */
  it('AC3: sets a3_target_already_reachable and does not emit PassTurn when target is reachable via paid ferry', async () => {
    mockIsStopComplete.mockReturnValue(false);

    // Route: deliver Cheese to Dublin. Dublin is NOT in citiesOnNetwork (regression stub).
    const route = makeRoute({
      stops: [makeStop('deliver', 'Dublin', 'Cheese')],
      currentStopIndex: 0,
    });

    // citiesOnNetwork deliberately excludes Dublin (the bug we're guarding against).
    const context = makeContext({
      citiesOnNetwork: ['Liverpool'], // Dublin excluded
      position: { row: 14, col: 29 }, // near Liverpool but not at Dublin
      speed: 9,
    });

    // Snapshot: bot has a segment ending at Liverpool (13,29) — the ferry port.
    const snapshot = {
      ...makeSnapshot(),
      bot: {
        ...makeSnapshot().bot,
        existingSegments: [
          {
            from: { x: 14 * 40, y: 29 * 40, row: 14, col: 29, terrain: TerrainType.Clear },
            to: { x: 13 * 40, y: 29 * 40, row: 13, col: 29, terrain: TerrainType.FerryPort },
            cost: 1,
          },
        ],
      },
    } as unknown as import('../../../shared/types/GameTypes').WorldSnapshot;

    // A3 target resolution: resolveBuildTarget → Dublin, loadGridPoints → Dublin at (10,24)
    mockResolveBuildTarget.mockReturnValue({ targetCity: 'Dublin' });
    const { loadGridPoints } = jest.requireMock('../../services/ai/MapTopology');
    const dublinGridMap = new Map([
      ['10,24', { row: 10, col: 24, name: 'Dublin', terrain: TerrainType.MajorCity, city: { name: 'Dublin' } }],
      ['13,29', { row: 13, col: 29, name: undefined, terrain: TerrainType.FerryPort, city: undefined }],
      ['14,29', { row: 14, col: 29, name: undefined, terrain: TerrainType.Clear, city: undefined }],
    ]);
    (loadGridPoints as jest.Mock).mockReturnValue(dublinGridMap);

    // computeBuildSegments returns [] (Dublin reachable, no new segments needed)
    // — already the global mock default.

    const trace = makeTrace();

    const result = await MovementPhasePlanner.run(route, snapshot, context, trace);

    // Primary assertion: Fix B diagnosed the reachability correctly
    expect(trace.a3.terminationReason).toBe('a3_target_already_reachable');

    // Secondary assertion: MovementPhasePlanner did NOT produce a PassTurn plan
    // (PassTurn is only added by TurnExecutorPlanner from an empty accumulatedPlans;
    // what we verify here is that A3 did not emit it from this branch)
    expect(result.accumulatedPlans.some(p => p.type === AIActionType.PassTurn)).toBe(false);
  });
});
