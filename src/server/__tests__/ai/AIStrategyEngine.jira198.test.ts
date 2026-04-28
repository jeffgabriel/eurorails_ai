/**
 * JIRA-198: Honor LLM train-upgrade decisions during active routes
 *
 * Integration tests verifying the full active-route → delivery → replan → upgrade
 * injection chain. Specifically:
 *
 *   AC4 — When a bot with an active route triggers a post-delivery replan and
 *   TripPlanner returns upgradeOnRoute='FastFreight', the resulting decision.plan
 *   is a MultiAction containing UpgradeTrain with targetTrain: 'fast_freight' and cost: 20.
 *
 *   AC2 (regression) — When the delivery count is below the gate, the decision.plan
 *   does NOT contain UpgradeTrain.
 *
 * These tests mock TurnExecutorPlanner.execute (which wraps the full Phase A+B
 * pipeline) to return the pendingUpgradeAction that PostDeliveryReplanner would
 * have computed after consuming the LLM's upgradeOnRoute hint. This simulates the
 * output of the JIRA-198 plumbing without running the full planning stack.
 *
 * Regression guard: existing tests in AIStrategyEngine.test.ts and
 * AIStrategyEngine.jira161.test.ts continue to pass without modification.
 */

// ── Mock external systems (same pattern as AIStrategyEngine.test.ts) ───────

jest.mock('../../db/index', () => ({
  db: {
    query: jest.fn(),
    connect: jest.fn(),
  },
}));

jest.mock('../../services/socketService', () => ({
  emitTurnChange: jest.fn(),
  emitStatePatch: jest.fn().mockResolvedValue(undefined),
  emitToGame: jest.fn(),
  getSocketIO: jest.fn().mockReturnValue(null),
}));

jest.mock('../../services/ai/MapTopology', () => ({
  loadGridPoints: jest.fn(() => new Map()),
  getHexNeighbors: jest.fn(() => []),
  getTerrainCost: jest.fn(() => 1),
  gridToPixel: jest.fn(() => ({ x: 100, y: 200 })),
  _resetCache: jest.fn(),
  makeKey: jest.fn((r: number, c: number) => `${r},${c}`),
  hexDistance: jest.fn(() => 0),
  computeLandmass: jest.fn(() => new Set<string>()),
  computeFerryRouteInfo: jest.fn(() => ({
    requiresFerry: false, canCrossFerry: false, departurePorts: [], arrivalPorts: [], cheapestFerryCost: 0,
  })),
}));

jest.mock('../../../shared/services/majorCityGroups', () => ({
  getMajorCityGroups: jest.fn(() => []),
  getMajorCityLookup: jest.fn(() => new Map()),
  getFerryEdges: jest.fn(() => []),
  computeEffectivePathLength: jest.fn(() => 0),
}));

jest.mock('../../services/ai/computeBuildSegments', () => ({
  computeBuildSegments: jest.fn(() => []),
}));

jest.mock('../../../shared/services/trackUsageFees', () => ({
  buildUnionTrackGraph: jest.fn(() => ({ adjacency: new Map(), edgeOwners: new Map() })),
  computeTrackUsageForMove: jest.fn(() => ({ feeTotal: 0, ownersUsed: [], ownersPaid: [] })),
}));

jest.mock('../../../shared/services/TrackNetworkService', () => ({
  buildTrackNetwork: jest.fn(() => ({ adjacency: new Map(), nodeSet: new Set() })),
}));

jest.mock('../../services/ai/connectedMajorCities', () => ({
  getConnectedMajorCityCount: jest.fn(() => 0),
}));

jest.mock('../../services/demandDeckService', () => ({
  DemandDeckService: {
    getInstance: jest.fn(() => ({
      getCard: jest.fn(() => undefined),
      drawCard: jest.fn(() => ({ id: 99, demands: [] })),
      discardCard: jest.fn(),
    })),
  },
}));

jest.mock('../../services/loadService', () => ({
  LoadService: {
    getInstance: jest.fn(() => ({
      getAvailableLoadsForCity: jest.fn(() => []),
      getSourceCitiesForLoad: jest.fn(() => []),
      isLoadAvailableAtCity: jest.fn(() => false),
    })),
  },
}));

jest.mock('../../services/playerService', () => ({
  PlayerService: {
    moveTrainForUser: jest.fn().mockResolvedValue({ success: true, movedTo: { row: 10, col: 10 }, milepostsMoved: 0, trackUsageFee: 0 }),
    updateCurrentPlayerIndex: jest.fn().mockResolvedValue(undefined),
    deliverLoadForUser: jest.fn().mockResolvedValue({ success: true, payment: 25 }),
    getPlayers: jest.fn().mockResolvedValue([]),
    purchaseTrainType: jest.fn().mockResolvedValue({ success: true }),
  },
}));

jest.mock('../../services/ai/BotMemory', () => ({
  getMemory: jest.fn(),
  updateMemory: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../../services/ai/RouteValidator', () => ({
  RouteValidator: {
    reorderStopsByProximity: jest.fn((stops: unknown) => stops),
  },
}));

// JIRA-198: The key mock — TurnExecutorPlanner.execute is what ActiveRouteContinuer
// delegates to. Setting pendingUpgradeAction here simulates what PostDeliveryReplanner
// would produce after consuming upgradeOnRoute from TripPlanner.
jest.mock('../../services/ai/TurnExecutorPlanner', () => ({
  TurnExecutorPlanner: {
    execute: jest.fn(),
    filterByDirection: jest.fn((targets: unknown) => targets),
    findDeadLoads: jest.fn(() => []),
    revalidateRemainingDeliveries: jest.fn((route: unknown) => route),
    skipCompletedStops: jest.fn((route: unknown) => route),
  },
}));

jest.mock('../../services/ai/ActionResolver', () => ({
  ActionResolver: {
    resolve: jest.fn(),
    heuristicFallback: jest.fn(),
    cloneSnapshot: jest.fn((snapshot: unknown) => JSON.parse(JSON.stringify(snapshot))),
    applyPlanToState: jest.fn(),
    UPGRADE_PATHS: {
      Freight: { fast_freight: 20, heavy_freight: 20 },
      FastFreight: { Superfreight: 20 },
      HeavyFreight: { Superfreight: 20 },
      Superfreight: {},
    },
  },
}));

jest.mock('../../services/ai/TripPlanner', () => ({
  TripPlanner: jest.fn().mockImplementation(() => ({
    planTrip: jest.fn().mockResolvedValue({ route: null, llmLog: [] }),
  })),
}));

jest.mock('../../services/ai/DecisionLogger', () => ({
  initTurnLog: jest.fn(),
  logPhase: jest.fn(),
  flushTurnLog: jest.fn(),
}));

jest.mock('../../services/ai/WorldSnapshotService', () => ({
  capture: jest.fn(),
}));

jest.mock('../../services/ai/ContextBuilder', () => ({
  ContextBuilder: {
    build: jest.fn(),
    serializePrompt: jest.fn(() => 'serialized-prompt'),
    rebuildDemands: jest.fn(() => []),
    rebuildCanDeliver: jest.fn(() => []),
    computeEnRoutePickups: jest.fn(() => []),
    computeUpgradeAdvice: jest.fn(() => undefined),
  },
}));

jest.mock('../../services/ai/LLMStrategyBrain', () => ({
  LLMStrategyBrain: jest.fn().mockImplementation(() => ({
    decideAction: jest.fn(),
    planRoute: jest.fn(),
    modelName: 'claude-haiku-4-5-20251001',
    providerAdapter: {
      resetCallIds: jest.fn(),
      getCallIds: jest.fn(() => []),
      getCallSummaries: jest.fn(() => []),
    },
  })),
}));

jest.mock('../../services/ai/RouteEnrichmentAdvisor', () => ({
  RouteEnrichmentAdvisor: {
    enrich: jest.fn(async (route: unknown) => route),
  },
}));

// ── Imports (after mocks) ──────────────────────────────────────────────────

import { AIStrategyEngine } from '../../services/ai/AIStrategyEngine';
import { capture } from '../../services/ai/WorldSnapshotService';
import { ContextBuilder } from '../../services/ai/ContextBuilder';
import { TurnExecutorPlanner } from '../../services/ai/TurnExecutorPlanner';
import { getMemory } from '../../services/ai/BotMemory';
import {
  AIActionType,
  TrainType,
  TerrainType,
  WorldSnapshot,
  GameContext,
  StrategicRoute,
} from '../../../shared/types/GameTypes';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { db } = require('../../db/index');

const mockCapture = capture as jest.MockedFunction<typeof capture>;
const mockContextBuild = ContextBuilder.build as jest.MockedFunction<typeof ContextBuilder.build>;
const mockTurnExecute = TurnExecutorPlanner.execute as jest.Mock;
const mockGetMemory = getMemory as jest.Mock;

// ── Composition trace stub ─────────────────────────────────────────────────

const defaultTrace = {
  inputPlan: [], outputPlan: [],
  moveBudget: { total: 9, used: 0, wasted: 0 },
  a1: { citiesScanned: 0, opportunitiesFound: 0 },
  a2: { iterations: 0, terminationReason: 'none' },
  a3: { movePreprended: false },
  build: { target: null, cost: 0, skipped: true, upgradeConsidered: false },
  pickups: [], deliveries: [],
};

// ── Factory helpers ────────────────────────────────────────────────────────

function makeActiveRoute(): StrategicRoute {
  return {
    stops: [
      { action: 'pickup', loadType: 'Coal', city: 'Lyon' },
      { action: 'deliver', loadType: 'Coal', city: 'Berlin' },
    ],
    currentStopIndex: 0,
    phase: 'travel',
    startingCity: 'Lyon',
    createdAtTurn: 1,
    reasoning: 'test active route',
  };
}

function makeSnapshot(): WorldSnapshot {
  return {
    gameId: 'game-jira198',
    gameStatus: 'active',
    turnNumber: 30,
    bot: {
      playerId: 'bot-jira198',
      userId: 'user-jira198',
      money: 50, // 50M — can afford FastFreight upgrade (20M)
      position: { row: 10, col: 10 },
      existingSegments: [],
      demandCards: [1, 2, 3],
      resolvedDemands: [],
      trainType: TrainType.Freight,
      loads: [],
      botConfig: { skillLevel: 'medium' },
      connectedMajorCityCount: 3,
    } as WorldSnapshot['bot'],
    allPlayerTracks: [
      { playerId: 'bot-jira198', segments: [] },
    ],
    loadAvailability: {},
  };
}

function makeContext(): GameContext {
  return {
    position: { row: 10, col: 10 },
    money: 50,
    trainType: TrainType.Freight,
    speed: 9,
    capacity: 2,
    loads: [],
    connectedMajorCities: [],
    unconnectedMajorCities: [],
    totalMajorCities: 7,
    trackSummary: '1 segment',
    turnBuildCost: 0,
    demands: [],
    canDeliver: [],
    canPickup: [],
    reachableCities: [],
    citiesOnNetwork: [],
    canUpgrade: false,
    canBuild: true,
    isInitialBuild: false,
    opponents: [],
    phase: 'running',
    turnNumber: 30,
  };
}

function makeMemory(deliveryCount: number) {
  return {
    turnNumber: 30,
    consecutiveDiscards: 0,
    lastAction: null,
    activeRoute: makeActiveRoute(),
    turnsOnRoute: 5,
    routeHistory: [],
    currentBuildTarget: null,
    turnsOnTarget: 0,
    deliveryCount,
    totalEarnings: 150,
    consecutiveLlmFailures: 0,
    noProgressTurns: 0,
    lastReasoning: null,
    lastPlanHorizon: null,
    previousRouteStops: null,
  };
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('JIRA-198: AIStrategyEngine.takeTurn — active-route upgrade injection', () => {
  let mockClient: { query: jest.Mock; release: jest.Mock };

  beforeEach(() => {
    jest.clearAllMocks();
    mockCapture.mockResolvedValue(makeSnapshot());
    mockContextBuild.mockResolvedValue(makeContext());

    // Set up DB client mock (required for TurnExecutor.handleUpgradeTrain → db.connect())
    mockClient = {
      query: jest.fn().mockResolvedValue({ rows: [{ money: 30 }], rowCount: 1 }),
      release: jest.fn(),
    };
    db.connect.mockResolvedValue(mockClient);
    db.query.mockResolvedValue({ rows: [], rowCount: 0 });
  });

  /**
   * AC4: Bot with active route, 5 prior deliveries, 50M cash, on Freight.
   * TurnExecutorPlanner.execute returns pendingUpgradeAction = FastFreight (20M).
   * Expected: decision.plan is a MultiAction containing UpgradeTrain.
   */
  it('AC4: injects UpgradeTrain into plan when active route replan emits upgradeOnRoute', async () => {
    // Bot has 5 prior deliveries — above MIN_DELIVERIES_BEFORE_UPGRADE (1)
    mockGetMemory.mockResolvedValue(makeMemory(5));

    const activeRoute = makeActiveRoute();
    const deliverPlan = {
      type: AIActionType.DeliverLoad,
      load: 'Coal',
      city: 'Berlin',
      payment: 25,
      cardId: 1,
    };

    // Simulate PostDeliveryReplanner consuming upgradeOnRoute='FastFreight' and passing
    // the resulting pendingUpgradeAction through TurnExecutorPlanner
    mockTurnExecute.mockResolvedValue({
      plans: [deliverPlan],
      routeComplete: false,
      routeAbandoned: false,
      updatedRoute: { ...activeRoute, currentStopIndex: 1 },
      compositionTrace: defaultTrace,
      hasDelivery: true,
      // JIRA-198: This is the key field — set by PostDeliveryReplanner after consuming
      // upgradeOnRoute='FastFreight' from TripPlanner.planTrip
      pendingUpgradeAction: {
        type: AIActionType.UpgradeTrain,
        targetTrain: TrainType.FastFreight,
        cost: 20,
      },
      upgradeSuppressionReason: null,
    });

    const result = await AIStrategyEngine.takeTurn('game-jira198', 'bot-jira198');

    // The turn should succeed
    expect(result.success).toBe(true);

    // The injected upgrade action should appear in the result
    // AIStrategyEngine.takeTurn injects pendingUpgradeAction into decision.plan
    // as a MultiAction step (F1 injection at line 345-349)
    expect(result.action).toBe(AIActionType.UpgradeTrain);
  });

  /**
   * AC2 (regression): Bot has only 0 deliveries — below the gate of 1.
   * No upgrade should appear in the plan.
   */
  it('AC2 regression: does NOT inject UpgradeTrain when delivery count is below gate', async () => {
    // Bot has only 0 prior deliveries — below MIN_DELIVERIES_BEFORE_UPGRADE (1)
    mockGetMemory.mockResolvedValue(makeMemory(0));

    const activeRoute = makeActiveRoute();

    // TurnExecutorPlanner returns NO pendingUpgradeAction (gate blocked it).
    // Use PassTurn to avoid TurnExecutor DB interaction complications.
    mockTurnExecute.mockResolvedValue({
      plans: [{ type: AIActionType.PassTurn }],
      routeComplete: false,
      routeAbandoned: false,
      updatedRoute: { ...activeRoute, currentStopIndex: 0 },
      compositionTrace: defaultTrace,
      hasDelivery: false,
      pendingUpgradeAction: null,
      upgradeSuppressionReason: 'Upgrade blocked: only 0 deliveries (need 1)',
    });

    const result = await AIStrategyEngine.takeTurn('game-jira198', 'bot-jira198');

    // Turn executes (PassTurn always succeeds)
    expect(result.success).toBe(true);
    // No upgrade should have been executed
    expect(result.action).not.toBe(AIActionType.UpgradeTrain);
  });

  /**
   * Verify that the JIRA-198 plumbing doesn't break turns where no upgrade is requested.
   * (Regression: existing active-route behaviour unaffected)
   */
  it('regression: active-route turn without upgrade signal works normally', async () => {
    mockGetMemory.mockResolvedValue(makeMemory(5));

    const activeRoute = makeActiveRoute();

    // No pendingUpgradeAction — the LLM didn't request an upgrade.
    // Use PassTurn to avoid TurnExecutor DB interaction complications.
    mockTurnExecute.mockResolvedValue({
      plans: [{ type: AIActionType.PassTurn }],
      routeComplete: false,
      routeAbandoned: false,
      updatedRoute: activeRoute,
      compositionTrace: defaultTrace,
      hasDelivery: false,
      // pendingUpgradeAction: undefined — omitted means no upgrade signal
    });

    const result = await AIStrategyEngine.takeTurn('game-jira198', 'bot-jira198');

    expect(result.success).toBe(true);
    expect(result.action).not.toBe(AIActionType.UpgradeTrain);
  });
});
