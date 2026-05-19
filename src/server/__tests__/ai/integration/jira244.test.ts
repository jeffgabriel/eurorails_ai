/**
 * JIRA-244 Integration Test — Ferry-aware citiesOnNetwork + A3 disambiguation
 *
 * AC2: Reconstructs s1's t20-equivalent snapshot from game c990fa47-bfc1-4437-9fc3-f148034c32f6:
 *   - Bot has segments reaching Liverpool (13,29)
 *   - Carrying Cheese
 *   - Active route: deliver Cheese to Dublin
 *
 * After Fix A (ferry-aware citiesOnNetwork), Dublin is included in context.citiesOnNetwork,
 * so A2 fires and moves the bot toward Dublin via the Liverpool ferry.
 * A2 terminationReason must NOT be 'stop_city_not_on_network'.
 *
 * The test hand-constructs a minimal segment list that reaches Liverpool. Per spec:
 * "use ~5 segments that get to Liverpool from a starting position like (15,30)"
 */

// ── Mocks (hoisted by Jest) ────────────────────────────────────────────────

jest.mock('../../../services/ai/routeHelpers', () => {
  const real = jest.requireActual('../../../services/ai/routeHelpers');
  return {
    isStopComplete: jest.fn(() => false),
    resolveBuildTarget: jest.fn(() => null),
    getNetworkFrontier: jest.fn(() => []),
    isDeliveryComplete: jest.fn(() => false),
    isRouteImpossible: jest.fn(() => false),
    applyStopEffectToLocalState: jest.fn((...args: Parameters<typeof real.applyStopEffectToLocalState>) =>
      real.applyStopEffectToLocalState(...args),
    ),
  };
});

jest.mock('../../../services/ai/computeBuildSegments', () => ({
  computeBuildSegments: jest.fn(() => []),
}));

jest.mock('../../../../shared/services/trackUsageFees', () => ({
  buildUnionTrackGraph: jest.fn(() => ({
    adjacency: new Map(),
    edgeOwners: new Map(),
  })),
}));

jest.mock('../../../../shared/services/computeTrackUsageFees', () => ({
  computeTrackUsageFees: jest.fn(() => 0),
}));

jest.mock('../../../services/ai/ActionResolver', () => ({
  ActionResolver: {
    resolve: jest.fn(),
    resolveMove: jest.fn(),
  },
}));

jest.mock('../../../services/ai/PostDeliveryReplanner', () => ({
  PostDeliveryReplanner: {
    replan: jest.fn(),
  },
}));

jest.mock('../../../services/ai/TurnExecutor', () => ({
  TurnExecutor: {
    executePlan: jest.fn().mockResolvedValue({
      success: true,
      action: 'DeliverLoad',
      cost: 0,
      segmentsBuilt: 0,
      remainingMoney: 100,
      durationMs: 1,
    }),
  },
}));

jest.mock('../../../services/ai/BotMemory', () => ({
  getMemory: jest.fn(() => ({
    currentBuildTarget: null,
    turnsOnTarget: 0,
    lastAction: null,
    noProgressTurns: 0,
    consecutiveDiscards: 0,
    deliveryCount: 0,
    totalEarnings: 0,
    turnNumber: 20,
    activeRoute: null,
    turnsOnRoute: 5,
    routeHistory: [],
    lastReasoning: null,
    lastPlanHorizon: null,
    previousRouteStops: null,
    consecutiveLlmFailures: 0,
  })),
}));

jest.mock('../../../services/ai/WorldSnapshotService', () => ({
  capture: jest.fn().mockResolvedValue(null),
}));

jest.mock('../../../services/ai/ContextBuilder', () => ({
  ContextBuilder: {
    rebuildDemands: jest.fn(() => []),
    rebuildCanDeliver: jest.fn(() => []),
  },
}));

jest.mock('../../../services/ai/RouteEnrichmentAdvisor', () => ({
  RouteEnrichmentAdvisor: {
    enrich: jest.fn((route: unknown) => Promise.resolve(route)),
  },
}));

jest.mock('../../../services/ai/RouteDetourEstimator', () => ({
  computeCandidateDetourCosts: jest.fn(() => []),
  MAX_DETOUR_TURNS: 3,
  OPPORTUNITY_COST_PER_TURN_M: 5,
}));

jest.mock('../../../../shared/constants/gameRules', () => ({
  TURN_BUILD_BUDGET: 20,
}));

// ── Real modules (not mocked) ─────────────────────────────────────────────
// NetworkContext, buildTrackNetwork, getFerryEdges — use real implementations
// to exercise Fix A (ferry-aware citiesOnNetwork).

// ── Imports ───────────────────────────────────────────────────────────────

import { MovementPhasePlanner } from '../../../services/ai/MovementPhasePlanner';
import { TurnExecutorPlanner, CompositionTrace } from '../../../services/ai/TurnExecutorPlanner';
import { NetworkContext } from '../../../services/ai/context/NetworkContext';
import { AIActionType, TerrainType, GameState } from '../../../../shared/types/GameTypes';
import type {
  StrategicRoute,
  RouteStop,
  GameContext,
  WorldSnapshot,
  GridPoint,
  TrackSegment,
} from '../../../../shared/types/GameTypes';
import { buildTrackNetwork } from '../../../../shared/services/TrackNetworkService';
import { ActionResolver } from '../../../services/ai/ActionResolver';

const mockResolveMove = ActionResolver.resolveMove as jest.Mock;

// ── Grid-point helpers ────────────────────────────────────────────────────

function makeGP(
  row: number, col: number,
  overrides: Partial<GridPoint> = {},
): GridPoint {
  return {
    id: `gp-${row}-${col}`,
    x: col * 40,
    y: row * 40,
    row,
    col,
    terrain: TerrainType.Clear,
    city: undefined,
    ...overrides,
  };
}

function makeCityGP(row: number, col: number, name: string, terrain: TerrainType): GridPoint {
  return makeGP(row, col, {
    terrain,
    city: { type: terrain, name, availableLoads: [] },
    name,
  });
}

function makeSeg(fromRow: number, fromCol: number, toRow: number, toCol: number): TrackSegment {
  return {
    from: { x: fromCol * 40, y: fromRow * 40, row: fromRow, col: fromCol, terrain: TerrainType.Clear },
    to: { x: toCol * 40, y: toRow * 40, row: toRow, col: toCol, terrain: TerrainType.Clear },
    cost: 1,
  };
}

// ── Minimal s1-equivalent segment list ────────────────────────────────────
//
// Hand-constructed: ~5 segments approaching Liverpool from (15,30),
// ending at Liverpool ferry port (13,29). No Dublin endpoint in segments.
//
// This reproduces the key feature of s1's actual track at t20:
// the bot has built to Liverpool but NOT to Dublin.

function makeS1Segments(): TrackSegment[] {
  return [
    makeSeg(15, 30, 15, 29),
    makeSeg(15, 29, 14, 29),
    makeSeg(14, 29, 14, 28),
    makeSeg(14, 28, 13, 28),
    makeSeg(13, 28, 13, 29), // endpoint at Liverpool ferry port (13,29)
  ];
}

// ── Grid points needed for the test ──────────────────────────────────────
//
// Minimal grid covering the segment endpoints + Dublin + Liverpool.
// Real getFerryEdges() resolves ferry coords from gridPoints.json,
// so we only need these for NetworkContext.compute() and the move path.

function makeTestGridPoints(): GridPoint[] {
  return [
    makeCityGP(10, 24, 'Dublin', TerrainType.MajorCity),
    makeGP(13, 29, { terrain: TerrainType.FerryPort }),  // Liverpool ferry port
    makeGP(13, 28),
    makeGP(14, 28),
    makeGP(14, 29),
    makeGP(15, 29),
    makeGP(15, 30),
  ];
}

// ── Route and context factories ───────────────────────────────────────────

function makeDeliverDublinRoute(): StrategicRoute {
  const stop: RouteStop = { action: 'deliver', city: 'Dublin', loadType: 'Cheese' };
  return {
    stops: [stop],
    currentStopIndex: 0,
    phase: 'travel',
    startingCity: 'Liverpool',
    createdAtTurn: 15,
    reasoning: 'Deliver Cheese to Dublin via Liverpool ferry',
  };
}

function makeS1Snapshot(segments: TrackSegment[]): WorldSnapshot {
  return {
    gameId: 'c990fa47-bfc1-4437-9fc3-f148034c32f6',
    gameStatus: 'active',
    turnNumber: 20,
    bot: {
      playerId: 's1',
      userId: 'user-s1',
      money: 120,
      position: { row: 13, col: 29 }, // At Liverpool ferry port
      existingSegments: segments,
      demandCards: [31],
      resolvedDemands: [],
      trainType: 'Freight',
      loads: ['Cheese'],
      botConfig: { skillLevel: 'medium' as const },
      connectedMajorCityCount: 2,
    },
    allPlayerTracks: [],
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

// ── AC2 Integration Test ──────────────────────────────────────────────────

describe('JIRA-244 AC2: s1 t20 — ferry-aware citiesOnNetwork enables delivery to Dublin', () => {
  let segments: TrackSegment[];
  let snapshot: WorldSnapshot;
  let gridPoints: GridPoint[];
  let context: GameContext;

  beforeEach(() => {
    jest.clearAllMocks();

    jest.spyOn(TurnExecutorPlanner, 'skipCompletedStops')
      .mockImplementation((route: StrategicRoute) => route);
    jest.spyOn(TurnExecutorPlanner, 'revalidateRemainingDeliveries')
      .mockImplementation((route: StrategicRoute) => route);
    jest.spyOn(TurnExecutorPlanner, 'isBotAtCity')
      .mockReturnValue(false);

    segments = makeS1Segments();
    snapshot = makeS1Snapshot(segments);
    gridPoints = makeTestGridPoints();

    // Compute real citiesOnNetwork using the REAL NetworkContext (Fix A under test)
    const network = buildTrackNetwork(segments);
    const networkResult = NetworkContext.computeCitiesOnNetwork(network, gridPoints);

    context = {
      position: { row: 13, col: 29 }, // At Liverpool
      money: 120,
      speed: 9,
      capacity: 2,
      loads: ['Cheese'],
      demands: [],
      citiesOnNetwork: networkResult, // REAL result — should include 'Dublin' after Fix A
      connectedMajorCities: [],
      unconnectedMajorCities: [],
      totalMajorCities: 12,
      trackSummary: '5 mileposts. Backbone: Liverpool',
      turnBuildCost: 0,
      canDeliver: [],
      canPickup: [],
      reachableCities: [],
      canUpgrade: false,
      canBuild: true,
      isInitialBuild: false,
      opponents: [],
      phase: 'travel',
      turnNumber: 20,
      trainType: 'Freight',
      gameState: GameState.Mid,
    };
  });

  it('Fix A: NetworkContext.computeCitiesOnNetwork includes Dublin when segments reach Liverpool', () => {
    // Verify that Fix A works as expected — Dublin appears in citiesOnNetwork
    const network = buildTrackNetwork(segments);
    const result = NetworkContext.computeCitiesOnNetwork(network, gridPoints);
    expect(result).toContain('Dublin');
  });

  it('AC2: MovementPhasePlanner emits MoveTrain toward Dublin (not PassTurn), a2.terminationReason !== stop_city_not_on_network', async () => {
    // Pre-check: Fix A has put Dublin in citiesOnNetwork
    expect(context.citiesOnNetwork).toContain('Dublin');

    // Mock resolveMove to return a successful move path crossing Liverpool→Dublin ferry
    mockResolveMove.mockResolvedValue({
      success: true,
      plan: {
        type: AIActionType.MoveTrain,
        path: [
          { row: 13, col: 29 }, // Liverpool ferry port (start)
          { row: 10, col: 24 }, // Dublin (ferry crossing destination)
        ],
        milesUsed: 9,
        cost: 0,
        trackUsageFees: [],
      },
    });

    const { computeEffectivePathLength } = jest.requireMock(
      '../../../../shared/services/majorCityGroups',
    );
    if (computeEffectivePathLength) {
      (computeEffectivePathLength as jest.Mock).mockReturnValue(9);
    }

    const route = makeDeliverDublinRoute();
    const trace = makeTrace();

    const result = await MovementPhasePlanner.run(route, snapshot, context, trace, undefined, gridPoints);

    // Primary assertion: bot moved toward Dublin (not stuck on PassTurn)
    const hasMovePlan = result.accumulatedPlans.some(p => p.type === AIActionType.MoveTrain);
    expect(hasMovePlan).toBe(true);

    // No PassTurn emitted from MovementPhasePlanner
    const hasPassTurn = result.accumulatedPlans.some(p => p.type === AIActionType.PassTurn);
    expect(hasPassTurn).toBe(false);

    // A2 did not exit with stop_city_not_on_network — it found Dublin on network
    expect(trace.a2.terminationReason).not.toBe('stop_city_not_on_network');

    // resolveMove was called with Dublin as the target
    expect(mockResolveMove).toHaveBeenCalled();
    const firstCall = mockResolveMove.mock.calls[0];
    expect(firstCall[0]).toEqual({ to: 'Dublin' });
  });
});
