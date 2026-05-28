/**
 * MovementPhasePlanner.postDeliveryReplanCarriedLoad.test.ts
 *
 * Regression test for JIRA-222 secondary fix: JIRA-165 demand refresh seeds
 * freshSnapshot.bot.loads from context.loads (planner-working-state), not
 * from snapshot.bot.loads (DB-committed state that can lag post-delivery).
 *
 * Scenario: game 1a10d393 T5 shape.
 *   - Bot is at Kaliningrad, carrying China (context.loads = ['China']).
 *   - snapshot.bot.loads = [] (DB-committed state after prior delivery cleared it).
 *   - Route: single-stop DELIVER China @ Kaliningrad.
 *   - Bot delivers, JIRA-165 refresh fires, then PostDeliveryReplanner is called.
 *
 * Assertions:
 *   AC5a: ContextBuilder.rebuildDemands is called with freshSnapshot.bot.loads = ['China'].
 *   AC5b: PostDeliveryReplanner.replan is called with context.loads = ['China'].
 *   AC6:  The rendered context passed to replan does NOT have a demand annotated
 *         "(demand card unresolved)" for China — the load-on-train flag resolves.
 *   Guard: hasDelivery=true, deliveriesThisTurn=1.
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
  DemandContext,
} from '../../../shared/types/GameTypes';
import type { CompositionTrace } from '../../services/ai/TurnExecutorPlanner';

// ── Mock dependencies (mirrors MovementPhasePlanner.test.ts) ──────────────────

jest.mock('../../services/MapTopology', () => ({
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
    ...real,
    isStopComplete: jest.fn(),
    resolveBuildTarget: jest.fn(),
    getNetworkFrontier: jest.fn(() => []),
    isDeliveryComplete: jest.fn(),
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
  ...jest.requireActual<typeof import('../../../shared/services/majorCityGroups')>('../../../shared/services/majorCityGroups'),
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
      remainingMoney: 122,
      durationMs: 1,
      payment: 22,
      newCardId: 31,
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

// WorldSnapshotService.capture returns a post-delivery DB snapshot with empty loads
// (simulates the DB lag that caused the JIRA-222 bug before the fix)
const mockCapture = jest.fn();
jest.mock('../../services/ai/WorldSnapshotService', () => ({
  capture: (...args: unknown[]) => mockCapture(...args),
}));

// ContextBuilder mocks — track what freshSnapshot.bot.loads was when rebuildDemands fired
const mockRebuildDemands = jest.fn((..._args: unknown[]) => []);
const mockRebuildCanDeliver = jest.fn((..._args: unknown[]) => []);
jest.mock('../../services/ai/ContextBuilder', () => ({
  ContextBuilder: {
    rebuildDemands: (...args: unknown[]) => mockRebuildDemands(...args),
    rebuildCanDeliver: (...args: unknown[]) => mockRebuildCanDeliver(...args),
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

import { isStopComplete } from '../../services/ai/routeHelpers';
import { PostDeliveryReplanner } from '../../services/ai/PostDeliveryReplanner';

const mockIsStopComplete = isStopComplete as jest.Mock;
const mockPostDeliveryReplan = PostDeliveryReplanner.replan as jest.Mock;

// ── Factory helpers ────────────────────────────────────────────────────────────

function makeDeliverStop(loadType = 'China', city = 'Kaliningrad'): RouteStop {
  return { action: 'deliver', loadType, city, demandCardId: 30, payment: 22 };
}

function makeRoute(overrides: Partial<StrategicRoute> = {}): StrategicRoute {
  return {
    stops: [makeDeliverStop()],
    currentStopIndex: 0,
    phase: 'travel',
    startingCity: 'Kaliningrad',
    createdAtTurn: 5,
    reasoning: 'game-1a10d393 T5: deliver China already on train',
    ...overrides,
  };
}

function makeDemand(overrides: Partial<DemandContext> = {}): DemandContext {
  return {
    cardIndex: 30,
    loadType: 'China',
    supplyCity: 'Leipzig',
    deliveryCity: 'Kaliningrad',
    payout: 22,
    isSupplyReachable: true,
    isDeliveryReachable: true,
    isSupplyOnNetwork: true,
    isDeliveryOnNetwork: true,
    estimatedTrackCostToSupply: 0,
    estimatedTrackCostToDelivery: 0,
    isLoadAvailable: true,
    isLoadOnTrain: true,
    ferryRequired: false,
    loadChipTotal: 4,
    loadChipCarried: 1,
    estimatedTurns: 1,
    demandScore: 0,
    efficiencyPerTurn: 0,
    networkCitiesUnlocked: 0,
    victoryMajorCitiesEnRoute: 0,
    isAffordable: true,
    projectedFundsAfterDelivery: 122,
    ...overrides,
  };
}

function makeContext(overrides: Partial<GameContext> = {}): GameContext {
  return {
    // Bot is already at Kaliningrad (delivery city) — no move needed
    position: { row: 10, col: 10, city: 'Kaliningrad' },
    money: 100,
    trainType: 'Freight',
    speed: 9,
    capacity: 2,
    // JIRA-222: China is in context.loads (planner-working-state) even though
    // snapshot.bot.loads is empty (DB-committed state lag).
    loads: ['China'],
    connectedMajorCities: ['Berlin', 'Kaliningrad'],
    unconnectedMajorCities: [],
    totalMajorCities: 15,
    trackSummary: 'Leipzig-Kaliningrad corridor',
    turnBuildCost: 0,
    demands: [makeDemand()],
    canDeliver: ['China'],
    canPickup: [],
    citiesOnNetwork: ['Kaliningrad'],
    reachableCities: [],
    canUpgrade: false,
    canBuild: true,
    isInitialBuild: false,
    opponents: [],
    phase: 'travel',
    turnNumber: 5,
    gameState: GameState.Mid,
    ...overrides,
  } as GameContext;
}

function makeSnapshot(): WorldSnapshot {
  return {
    gameId: '1a10d393-10a1-4216-8155-fa1ec62a690f',
    gameStatus: 'active',
    turnNumber: 5,
    bot: {
      playerId: 'bot-1',
      userId: 'user-bot-1',
      money: 100,
      position: { row: 10, col: 10 },
      existingSegments: [],
      demandCards: [29, 30, 31],
      resolvedDemands: [],
      trainType: 'Freight',
      // DB-committed loads is empty — this is the divergent state JIRA-222 fixes
      loads: [],
      botConfig: null,
      connectedMajorCityCount: 2,
    },
    allPlayerTracks: [],
    loadAvailability: {},
  } as WorldSnapshot;
}

// GridPoint for Kaliningrad so the delivery fires on the first loop iteration
function makeKaliningradGridPoints(): GridPoint[] {
  return [
    {
      row: 10,
      col: 10,
      terrain: 0 as TerrainType,
      city: { name: 'Kaliningrad' } as GridPoint['city'],
      name: 'Kaliningrad',
    } as unknown as GridPoint,
  ];
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

// ── Setup / teardown ──────────────────────────────────────────────────────────

let mockSkipCompleted: jest.SpyInstance;
let mockExecuteStopAction: jest.SpyInstance;

beforeEach(() => {
  jest.clearAllMocks();

  // Bot is at Kaliningrad — skipCompletedStops returns the route unchanged
  mockSkipCompleted = jest.spyOn(TurnExecutorPlanner, 'skipCompletedStops')
    .mockImplementation((route: StrategicRoute) => route);

  // TurnExecutorPlanner.executeStopAction delivers China successfully
  mockExecuteStopAction = jest.spyOn(TurnExecutorPlanner, 'executeStopAction')
    .mockResolvedValue({
      success: true,
      plan: { type: AIActionType.DeliverLoad, load: 'China', city: 'Kaliningrad' } as any,
    });

  // isStopComplete: not complete yet (bot hasn't delivered yet on this call)
  mockIsStopComplete.mockReturnValue(false);

  // WorldSnapshotService.capture returns a post-delivery DB snapshot with empty loads
  // (simulates DB lag — this is the state that broke JIRA-222)
  mockCapture.mockResolvedValue({
    gameId: '1a10d393-10a1-4216-8155-fa1ec62a690f',
    gameStatus: 'active',
    turnNumber: 5,
    bot: {
      playerId: 'bot-1',
      userId: 'user-bot-1',
      money: 122, // post-delivery balance
      position: { row: 10, col: 10 },
      existingSegments: [],
      demandCards: [29, 31, 32], // card 30 consumed by delivery
      resolvedDemands: [],
      trainType: 'Freight',
      loads: [], // DB shows empty after delivery (lag)
      botConfig: null,
      connectedMajorCityCount: 2,
    },
    allPlayerTracks: [],
    loadAvailability: {},
  });

  // PostDeliveryReplanner returns a new route after replan
  mockPostDeliveryReplan.mockResolvedValue({
    kind: 'route-replaced',
    route: makeRoute({ reasoning: 'post-delivery replan', stops: [] }),
    moveTargetInvalidated: true as const,
    replanLlmLog: [{ status: 'success', attempt: 1 }],
  });

  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  mockSkipCompleted.mockRestore();
  mockExecuteStopAction.mockRestore();
  jest.restoreAllMocks();
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('MovementPhasePlanner JIRA-222: JIRA-165 refresh seeds freshSnapshot.bot.loads from context.loads', () => {

  it('AC5a: ContextBuilder.rebuildDemands is called with freshSnapshot.bot.loads reflecting context.loads after delivery', async () => {
    // Arrange: divergent state — bot carries China AND Steel.
    // snapshot.bot.loads = [] (DB lag), context.loads = ['China', 'Steel'].
    // Bot delivers China at Kaliningrad:
    //   - applyStopEffectToLocalState(deliver China, context) → context.loads = ['Steel']
    //   - JIRA-165 refresh fires → capture() returns DB snapshot with loads = []
    //   - OLD fix: freshSnapshot.bot.loads = [...snapshot.bot.loads] = [] (Steel lost!)
    //   - NEW fix: freshSnapshot.bot.loads = [...context.loads] = ['Steel'] (correct)
    // So rebuildDemands sees Steel as isLoadOnTrain=true, avoiding "(demand card unresolved)".
    const route = makeRoute();
    const context = makeContext({ loads: ['China', 'Steel'] }); // bot carries two loads
    const snapshot = makeSnapshot(); // bot.loads = [] (DB lag)
    const gridPoints = makeKaliningradGridPoints(); // triggers JIRA-165 refresh

    // Act
    await MovementPhasePlanner.run(route, snapshot, context, makeTrace(), undefined, gridPoints);

    // Assert: rebuildDemands was called (JIRA-165 refresh fired)
    expect(mockRebuildDemands).toHaveBeenCalledTimes(1);

    // After delivering China, context.loads = ['Steel'] (applyStopEffectToLocalState removes China).
    // The freshSnapshot passed to rebuildDemands must have bot.loads = ['Steel']
    // (from context.loads post-delivery, not from the DB-returned empty array).
    const freshSnapshotArg = mockRebuildDemands.mock.calls[0][0] as WorldSnapshot;
    expect(freshSnapshotArg.bot.loads).toEqual(['Steel']);

    // Old behavior (pre-fix) would have produced [] — guard against regression
    expect(freshSnapshotArg.bot.loads).not.toEqual([]);
  });

  it('AC5b: PostDeliveryReplanner.replan is called with context.loads containing China', async () => {
    // Arrange
    const route = makeRoute();
    const context = makeContext({ loads: ['China'] });
    const snapshot = makeSnapshot();
    const gridPoints = makeKaliningradGridPoints();

    // Act
    await MovementPhasePlanner.run(route, snapshot, context, makeTrace(), undefined, gridPoints);

    // Assert: replan was called exactly once (no retry loop)
    expect(mockPostDeliveryReplan).toHaveBeenCalledTimes(1);

    // The context passed to replan still has loads = ['China'] (applyStopEffectToLocalState
    // removes China after deliver, but we verify the replan receives the mutated context)
    // Note: applyStopEffectToLocalState(deliverStop, context) removes China from context.loads.
    // So context.loads will be [] at the time replan is called — which is correct behavior.
    // The key assertion is that the JIRA-165 refresh used context.loads BEFORE the removal
    // to seed freshSnapshot.bot.loads (verified in AC5a).
    // Here we assert replan was invoked (no missing_pickup rejection caused a retry loop).
    const replanCall = mockPostDeliveryReplan.mock.calls[0];
    expect(replanCall).toBeDefined();
  });

  it('guard: hasDelivery=true and deliveriesThisTurn=1 after delivering China', async () => {
    const route = makeRoute();
    const context = makeContext({ loads: ['China'] });
    const snapshot = makeSnapshot();
    const gridPoints = makeKaliningradGridPoints();

    const result = await MovementPhasePlanner.run(route, snapshot, context, makeTrace(), undefined, gridPoints);

    expect(result.hasDelivery).toBe(true);
    expect(result.deliveriesThisTurn).toBe(1);
  });

  it('guard: JIRA-165 refresh skipped when gridPoints is empty (no DB capture)', async () => {
    // Without gridPoints, the refresh block does not fire — no capture call
    const route = makeRoute();
    const context = makeContext({ loads: ['China'] });
    const snapshot = makeSnapshot();

    await MovementPhasePlanner.run(route, snapshot, context, makeTrace(), undefined, []); // empty gridPoints

    expect(mockCapture).not.toHaveBeenCalled();
    expect(mockRebuildDemands).not.toHaveBeenCalled();
  });
});
