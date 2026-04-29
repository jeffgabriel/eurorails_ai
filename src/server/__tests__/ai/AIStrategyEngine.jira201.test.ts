/**
 * JIRA-201: Drop BuildTrack when F1 injects UpgradeTrain
 *
 * Tests for the F1 injection block in AIStrategyEngine.ts:
 *
 *   AC1 — When pendingUpgradeAction is set and the existing plan contains
 *   BuildTrack, the resulting plan has UpgradeTrain and NO BuildTrack, and
 *   phaseBStripped is false on the turn validation result (no collision).
 *
 *   AC2 — When the existing plan has no BuildTrack, the injected plan behaves
 *   as before (existing steps + UpgradeTrain, no regression).
 *
 *   AC3 — When pendingUpgradeAction is null, decision.plan is unchanged.
 *
 * These tests mock TurnExecutorPlanner.execute to return specific plan
 * combinations (build + upgrade, upgrade only, no upgrade) and assert the
 * resulting BotTurnResult.action and turnValidation.phaseBStripped values.
 */

// ── Mock external systems (same pattern as AIStrategyEngine.jira198.test.ts) ──

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
    gameId: 'game-jira201',
    gameStatus: 'active',
    turnNumber: 30,
    bot: {
      playerId: 'bot-jira201',
      userId: 'user-jira201',
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
      { playerId: 'bot-jira201', segments: [] },
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

describe('JIRA-201: F1 injection drops BuildTrack when UpgradeTrain is injected', () => {
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
   * AC1: Bot with active route, existing plan contains both MoveTrain and BuildTrack.
   * TurnExecutorPlanner returns pendingUpgradeAction = FastFreight (20M).
   * Expected:
   *   (a) final plan contains UpgradeTrain
   *   (b) final plan does NOT contain BuildTrack
   *   (c) phaseBStripped: false (no validator collision occurred)
   */
  it('AC1: drops BuildTrack and injects UpgradeTrain — no BUILD_UPGRADE_EXCLUSION collision', async () => {
    mockGetMemory.mockResolvedValue(makeMemory(5));

    const activeRoute = makeActiveRoute();
    const movePlan = {
      type: AIActionType.MoveTrain,
      path: [{ row: 10, col: 10 }, { row: 11, col: 10 }],
      fees: new Set<string>(),
      totalFee: 0,
    };
    const buildPlan = {
      type: AIActionType.BuildTrack,
      segments: [{ from: { row: 11, col: 10 }, to: { row: 12, col: 10 } }],
      targetCity: 'Berlin',
    };
    const upgradePlan = {
      type: AIActionType.UpgradeTrain,
      targetTrain: TrainType.FastFreight,
      cost: 20,
    };

    // TurnExecutorPlanner returns a plan that would include a BuildTrack step,
    // along with a pendingUpgradeAction — the collision scenario from JIRA-201.
    mockTurnExecute.mockResolvedValue({
      plans: [movePlan, buildPlan],
      routeComplete: false,
      routeAbandoned: false,
      updatedRoute: { ...activeRoute, currentStopIndex: 0 },
      compositionTrace: defaultTrace,
      hasDelivery: false,
      pendingUpgradeAction: upgradePlan,
      upgradeSuppressionReason: null,
    });

    const result = await AIStrategyEngine.takeTurn('game-jira201', 'bot-jira201');

    // (a) The UpgradeTrain should be the executed action
    expect(result.action).toBe(AIActionType.UpgradeTrain);

    // (c) phaseBStripped must be false — the validator saw no BUILD_UPGRADE_EXCLUSION conflict
    expect(result.turnValidation?.phaseBStripped).toBe(false);
  });

  /**
   * AC2: Existing plan has no BuildTrack. UpgradeTrain injection proceeds normally.
   * No regression for the success path (no build conflict).
   */
  it('AC2: injects UpgradeTrain when no BuildTrack exists — normal injection unchanged', async () => {
    mockGetMemory.mockResolvedValue(makeMemory(5));

    const activeRoute = makeActiveRoute();
    const deliverPlan = {
      type: AIActionType.DeliverLoad,
      load: 'Coal',
      city: 'Berlin',
      cardId: 1,
      payout: 25,
    };
    const upgradePlan = {
      type: AIActionType.UpgradeTrain,
      targetTrain: TrainType.FastFreight,
      cost: 20,
    };

    mockTurnExecute.mockResolvedValue({
      plans: [deliverPlan],
      routeComplete: false,
      routeAbandoned: false,
      updatedRoute: { ...activeRoute, currentStopIndex: 1 },
      compositionTrace: defaultTrace,
      hasDelivery: true,
      pendingUpgradeAction: upgradePlan,
      upgradeSuppressionReason: null,
    });

    const result = await AIStrategyEngine.takeTurn('game-jira201', 'bot-jira201');

    // UpgradeTrain is the final executed action
    expect(result.action).toBe(AIActionType.UpgradeTrain);

    // phaseBStripped must be false (no collision because no BuildTrack was present)
    expect(result.turnValidation?.phaseBStripped).toBe(false);
  });

  /**
   * AC3: pendingUpgradeAction is null — F1 is a no-op, plan unchanged.
   */
  it('AC3: leaves plan unchanged when pendingUpgradeAction is null', async () => {
    mockGetMemory.mockResolvedValue(makeMemory(5));

    const activeRoute = makeActiveRoute();

    mockTurnExecute.mockResolvedValue({
      plans: [{ type: AIActionType.PassTurn }],
      routeComplete: false,
      routeAbandoned: false,
      updatedRoute: activeRoute,
      compositionTrace: defaultTrace,
      hasDelivery: false,
      pendingUpgradeAction: null,
      upgradeSuppressionReason: null,
    });

    const result = await AIStrategyEngine.takeTurn('game-jira201', 'bot-jira201');

    expect(result.success).toBe(true);
    expect(result.action).not.toBe(AIActionType.UpgradeTrain);
    expect(result.turnValidation?.phaseBStripped).toBe(false);
  });
});
