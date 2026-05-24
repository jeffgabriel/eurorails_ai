/**
 * JIRA-245 — findFinalVictoryRoute integration wiring test (AC12).
 *
 * Light coverage: verifies that AIStrategyEngine.takeTurn replaces activeRoute
 * with a route whose first stop matches findFinalVictoryRoute's output when it
 * returns non-null.
 *
 * All external dependencies (DB, socket, LLM, BotMemory) are mocked. The test
 * exercises the real takeTurn function with a mocked victoryRules module so we
 * can control findFinalVictoryRoute's return value and verify downstream wiring.
 */

import { describe, it, expect, jest, beforeEach } from '@jest/globals';

// ── Shared mock context object — defined before jest.mock calls ───────────────

const MOCK_GAME_CONTEXT = {
  position: { row: 10, col: 10 },
  money: 241,
  trainType: 'Freight',
  speed: 9,
  capacity: 2,
  loads: [],
  connectedMajorCities: ['Paris', 'Holland', 'Ruhr', 'Berlin', 'London', 'Wien', 'Madrid'],
  unconnectedMajorCities: [],
  totalMajorCities: 8,
  trackSummary: '10 segments',
  turnBuildCost: 0,
  demands: [
    {
      cardIndex: 1,
      loadType: 'Beer',
      supplyCity: 'Frankfurt',
      deliveryCity: 'Bruxelles',
      payout: 10,
      isSupplyReachable: true,
      isDeliveryReachable: true,
      isSupplyOnNetwork: true,
      isDeliveryOnNetwork: true,
      estimatedTrackCostToSupply: 0,
      estimatedTrackCostToDelivery: 0,
      isLoadAvailable: true,
      isLoadOnTrain: false,
      ferryRequired: false,
      loadChipTotal: 3,
      loadChipCarried: 0,
      estimatedTurns: 2,
      demandScore: 5,
      efficiencyPerTurn: 2.5,
      networkCitiesUnlocked: 0,
      victoryMajorCitiesEnRoute: 0,
      isAffordable: true,
      projectedFundsAfterDelivery: 251,
    },
  ],
  canDeliver: [],
  canPickup: [],
  reachableCities: [],
  citiesOnNetwork: ['Frankfurt', 'Bruxelles'],
  canUpgrade: false,
  canBuild: true,
  isInitialBuild: false,
  opponents: [],
  phase: 'running',
  turnNumber: 50,
  gameState: 'End',
  consecutiveLlmFailures: 0,
};

const MOCK_ACTIVE_ROUTE_STATE: { current: any } = { current: null };

const MOCK_ACTIVE_ROUTE_CONTINUER_RESULT = {
  decision: {
    plan: { type: 'PassTurn' },
    reasoning: '[mock] active route continued',
    planHorizon: 'Immediate',
    model: 'mock',
    latencyMs: 0,
    retried: false,
    userPrompt: 'mock',
  },
  activeRoute: null,
  routeWasCompleted: false,
  routeWasAbandoned: false,
  hasDelivery: false,
  execCompositionTrace: null,
  pendingUpgradeAction: null,
  upgradeSuppressionReason: null,
};

// ── Mock all external systems ─────────────────────────────────────────────────

jest.mock('../../db/index', () => ({
  db: {
    query: jest.fn<() => Promise<any>>().mockResolvedValue({ rows: [] }),
    connect: jest.fn<() => Promise<any>>(),
  },
}));

jest.mock('../../services/socketService', () => ({
  emitTurnChange: jest.fn<() => void>(),
  emitStatePatch: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
  emitToGame: jest.fn<() => void>(),
  getSocketIO: jest.fn<() => any>().mockReturnValue(null),
}));

jest.mock('../../services/MapTopology', () => ({
  loadGridPoints: jest.fn(() => new Map()),
  getHexNeighbors: jest.fn(() => []),
  getTerrainCost: jest.fn(() => 1),
  gridToPixel: jest.fn(() => ({ x: 100, y: 200 })),
  _resetCache: jest.fn(),
  estimatePathCost: jest.fn(() => 0),
  estimateHopDistance: jest.fn(() => 0),
  hexDistance: jest.fn(() => 0),
  computeLandmass: jest.fn(() => new Set<string>()),
  computeFerryRouteInfo: jest.fn(() => ({
    requiresFerry: false,
    canCrossFerry: false,
    departurePorts: [],
    arrivalPorts: [],
    cheapestFerryCost: 0,
  })),
  makeKey: jest.fn((r: number, c: number) => `${r},${c}`),
}));

jest.mock('../../../shared/services/majorCityGroups', () => ({
  ...jest.requireActual<typeof import('../../../shared/services/majorCityGroups')>('../../../shared/services/majorCityGroups'),
  getMajorCityGroups: jest.fn(() => []),
  getMajorCityLookup: jest.fn(() => new Map()),
  getFerryEdges: jest.fn(() => []),
  computeEffectivePathLength: jest.fn(() => 0),
  isIntraCityEdge: jest.fn(() => false),
}));

jest.mock('../../services/ai/computeBuildSegments', () => ({
  computeBuildSegments: jest.fn(() => []),
}));

jest.mock('../../../shared/services/trackUsageFees', () => ({
  buildUnionTrackGraph: jest.fn(() => ({
    adjacency: new Map(),
    edgeOwners: new Map(),
  })),
  computeTrackUsageForMove: jest.fn(() => ({
    feeTotal: 0,
    ownersUsed: [],
    ownersPaid: [],
  })),
}));

jest.mock('../../../shared/services/TrackNetworkService', () => ({
  buildTrackNetwork: jest.fn(() => ({
    adjacency: new Map(),
    nodeSet: new Set(),
  })),
}));

jest.mock('../../services/ai/connectedMajorCities', () => ({
  ...jest.requireActual<typeof import('../../services/ai/connectedMajorCities')>('../../services/ai/connectedMajorCities'),
  getConnectedMajorCityCount: jest.fn(() => 7),
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
    moveTrainForUser: jest.fn(),
    updateCurrentPlayerIndex: jest.fn(),
    deliverLoadForUser: jest.fn(),
    getPlayers: jest.fn<(...args: any[]) => Promise<any>>().mockResolvedValue([]),
  },
}));

jest.mock('../../services/ai/BotMemory', () => ({
  getMemory: jest.fn(() =>
    Promise.resolve({
      turnNumber: 50,
      consecutiveDiscards: 0,
      lastAction: null,
      activeRoute: MOCK_ACTIVE_ROUTE_STATE.current,
      turnsOnRoute: 0,
      routeHistory: [],
      gameState: 'End',
      deliveryCount: 10,
      totalEarnings: 200,
      consecutiveLlmFailures: 0,
    }),
  ),
  updateMemory: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
}));

jest.mock('../../services/ai/RouteValidator', () => ({
  RouteValidator: {
    reorderStopsByProximity: jest.fn((stops: any) => stops),
  },
}));

jest.mock('../../services/ai/TurnExecutorPlanner', () => ({
  TurnExecutorPlanner: {
    execute: jest.fn<() => Promise<any>>().mockResolvedValue({
      plan: [],
      compositionTrace: {
        inputPlan: [], outputPlan: [],
        moveBudget: { total: 9, used: 0, wasted: 0 },
        a1: { citiesScanned: 0, opportunitiesFound: 0 },
        a2: { iterations: 0, terminationReason: 'none' },
        a3: { movePreprended: false },
        build: { target: null, cost: 0, skipped: true, upgradeConsidered: false },
        pickups: [], deliveries: [],
      },
      hasDelivery: false,
      previousRouteStops: null,
      routeWasCompleted: false,
      routeWasAbandoned: false,
      secondaryDeliveryLog: undefined,
      pendingUpgradeAction: null,
      upgradeSuppressionReason: null,
    }),
    filterByDirection: jest.fn((targets: any) => targets),
    findDeadLoads: jest.fn(() => []),
    revalidateRemainingDeliveries: jest.fn((route: any) => route),
  },
}));

jest.mock('../../services/ai/ActionResolver', () => ({
  ActionResolver: {
    resolve: jest.fn<() => any>().mockReturnValue({ action: 'PassTurn', details: {} }),
    heuristicFallback: jest.fn(),
    cloneSnapshot: jest.fn((snapshot: any) => ({
      ...snapshot,
      bot: {
        ...snapshot.bot,
        loads: [...snapshot.bot.loads],
        existingSegments: [...snapshot.bot.existingSegments],
        demandCards: [...snapshot.bot.demandCards],
        resolvedDemands: [],
      },
      allPlayerTracks: snapshot.allPlayerTracks.map((pt: any) => ({ ...pt, segments: [...pt.segments] })),
    })),
    applyPlanToState: jest.fn(),
  },
}));

jest.mock('../../services/ai/TripPlanner', () => ({
  TripPlanner: jest.fn().mockImplementation(() => ({
    planTrip: jest.fn<() => Promise<any>>().mockResolvedValue({
      route: null,
      llmLatencyMs: 0,
      llmTokens: { input: 0, output: 0 },
      llmLog: [],
    }),
  })),
}));

jest.mock('../../services/ai/DecisionLogger', () => ({
  initTurnLog: jest.fn(),
  logPhase: jest.fn(),
  flushTurnLog: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
}));

jest.mock('../../services/ai/NewRoutePlanner', () => ({
  NewRoutePlanner: {
    run: jest.fn<() => Promise<any>>().mockResolvedValue({
      activeRoute: null,
      decision: { action: 'PassTurn', details: {}, reasoning: 'no route' },
      execCompositionTrace: null,
      deadLoadDropActions: [],
      autoDeliveredLoads: [],
      tripPlanResult: null,
      snapshot: null,
      context: null,
      routeWasCompleted: false,
      routeWasAbandoned: false,
      hasDelivery: false,
      pendingUpgradeAction: null,
      upgradeSuppressionReason: null,
    }),
  },
}));

jest.mock('../../services/ai/InitialBuildRunner', () => ({
  InitialBuildRunner: {
    run: jest.fn<() => Promise<any>>().mockResolvedValue({
      activeRoute: null,
      decision: { action: 'PassTurn', details: {}, reasoning: 'initial build' },
      execCompositionTrace: null,
      evaluatedOptions: [],
      evaluatedPairings: [],
    }),
  },
}));

jest.mock('../../services/ai/ActiveRouteContinuer', () => ({
  ActiveRouteContinuer: {
    run: jest.fn<() => Promise<any>>().mockResolvedValue(MOCK_ACTIVE_ROUTE_CONTINUER_RESULT),
  },
}));

jest.mock('../../services/ai/GuardrailEnforcer', () => ({
  GuardrailEnforcer: {
    checkPlan: jest.fn((plan: any) => ({ plan, overridden: false, reason: null })),
  },
}));

jest.mock('../../services/ai/TurnExecutor', () => ({
  TurnExecutor: {
    executePlan: jest.fn<() => Promise<any>>().mockResolvedValue({
      action: 'PassTurn',
      segmentsBuilt: 0,
      cost: 0,
      durationMs: 0,
      success: true,
    }),
  },
}));

jest.mock('../../services/ai/LLMTranscriptLogger', () => ({
  appendLLMCall: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
}));

jest.mock('../../services/ai/prompts/ContextSerializer', () => ({
  ContextSerializer: {
    serializePrompt: jest.fn(() => 'mock-prompt'),
  },
}));

jest.mock('../../services/ai/ContextBuilder', () => ({
  ContextBuilder: {
    build: jest.fn<() => Promise<any>>().mockResolvedValue(MOCK_GAME_CONTEXT),
    rebuildDemands: jest.fn<() => any[]>().mockReturnValue(MOCK_GAME_CONTEXT.demands),
    computeUpgradeAdvice: jest.fn(() => undefined),
    buildEnRoutePickups: jest.fn(() => []),
  },
}));

import type { WorldSnapshot } from '../../../shared/types/GameTypes';
import { TrainType } from '../../../shared/types/GameTypes';

function makeGameSnapshot(): WorldSnapshot {
  return {
    gameId: 'test-jira245',
    gameStatus: 'active',
    turnNumber: 50,
    bot: {
      playerId: 'bot-1',
      userId: 'user-1',
      money: 241,
      position: { row: 10, col: 10 },
      existingSegments: [],
      demandCards: [1, 2, 3],
      resolvedDemands: [
        { cardId: 1, demands: [{ loadType: 'Beer', city: 'Bruxelles', payment: 10 }] },
        { cardId: 2, demands: [{ loadType: 'Coal', city: 'Paris', payment: 15 }] },
        { cardId: 3, demands: [{ loadType: 'Labor', city: 'Frankfurt', payment: 12 }] },
      ],
      trainType: TrainType.Freight,
      loads: [],
      botConfig: { skillLevel: 'hard' },
      connectedMajorCityCount: 7,
    },
    allPlayerTracks: [],
    loadAvailability: { Frankfurt: ['Beer'] },
  };
}

jest.mock('../../services/ai/WorldSnapshotService', () => ({
  capture: jest.fn<() => Promise<any>>().mockImplementation(() => Promise.resolve(makeGameSnapshot())),
}));

// ── Mock victoryRules to control findFinalVictoryRoute ───────────────────────
import type { FinalVictoryRoute } from '../../services/ai/victoryRules';

const mockFindFinalVictoryRoute = jest.fn<() => FinalVictoryRoute | null>();

jest.mock('../../services/ai/victoryRules', () => {
  const real = jest.requireActual<typeof import('../../services/ai/victoryRules')>('../../services/ai/victoryRules');
  return {
    ...real,
    findFinalVictoryRoute: mockFindFinalVictoryRoute,
  };
});

// ── Import system under test ──────────────────────────────────────────────────
import { AIStrategyEngine } from '../../services/ai/AIStrategyEngine';
import { updateMemory } from '../../services/ai/BotMemory';

const mockUpdateMemory = updateMemory as jest.MockedFunction<typeof updateMemory>;

// ── Constants ─────────────────────────────────────────────────────────────────

const VICTORY_ROUTE_STOPS = [
  { action: 'pickup' as const, loadType: 'Beer', city: 'Frankfurt' },
  { action: 'deliver' as const, loadType: 'Beer', city: 'Bruxelles', demandCardId: 1, payment: 10 },
];

const FINAL_VICTORY_ROUTE: FinalVictoryRoute = {
  stops: VICTORY_ROUTE_STOPS,
  estimatedTurns: 2,
  buildCost: 0,
  totalPayout: 10,
  cashAtVictory: 251,
  majorsAtVictory: 7,
  majorConnectors: [],
  reasoning: '[final-victory] Beer→Bruxelles, turns=2, build=0M, payout=10M, cash@victory=251M, majors@victory=7',
};

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('JIRA-245 AIStrategyEngine integration — findFinalVictoryRoute wiring (AC12)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    MOCK_ACTIVE_ROUTE_STATE.current = null;
  });

  it('AC12 — when findFinalVictoryRoute returns non-null, activeRoute is replaced with a route whose first stop matches', async () => {
    // Arrange: findFinalVictoryRoute returns a victory route
    mockFindFinalVictoryRoute.mockReturnValue(FINAL_VICTORY_ROUTE);

    // Act: run takeTurn
    await AIStrategyEngine.takeTurn('game-test-jira245', 'bot-1');

    // Assert: updateMemory was called with the new activeRoute containing the victory stops.
    // AIStrategyEngine calls updateMemory at the end with a memoryPatch that includes activeRoute.
    const memoryCalls = mockUpdateMemory.mock.calls;
    expect(memoryCalls.length).toBeGreaterThan(0);

    // Find the updateMemory call that includes activeRoute (the post-turn memory flush).
    const patchWithRoute = memoryCalls.find((call) => {
      const patch = call[2] as Record<string, any> | undefined;
      return patch && patch.activeRoute != null;
    });

    // If no patch directly includes activeRoute, check that findFinalVictoryRoute was called
    // (the ActiveRouteContinuer will clear activeRoute to null in its mock return).
    // The key assertion is that findFinalVictoryRoute was invoked and the route was SET
    // (even if the ActiveRouteContinuer mock subsequently clears it).
    expect(mockFindFinalVictoryRoute).toHaveBeenCalledTimes(1);

    // Verify that ActiveRouteContinuer.run was called (meaning activeRoute was non-null when
    // it reached the route-continuation branch — proof that the victory route was assigned).
    const { ActiveRouteContinuer } = require('../../services/ai/ActiveRouteContinuer');
    expect(ActiveRouteContinuer.run).toHaveBeenCalledTimes(1);

    // The route passed to ActiveRouteContinuer should have the victory route's first stop
    // as its first element and the [final-victory] reasoning string.
    const routePassedToContinuer = (ActiveRouteContinuer.run as jest.MockedFunction<any>).mock.calls[0][0];
    expect(routePassedToContinuer.stops[0]).toMatchObject({
      action: VICTORY_ROUTE_STOPS[0].action,
      loadType: VICTORY_ROUTE_STOPS[0].loadType,
      city: VICTORY_ROUTE_STOPS[0].city,
    });
    expect(routePassedToContinuer.reasoning).toContain('[final-victory]');
  });

  it('AC12 — when findFinalVictoryRoute returns null, it falls through to detectVictoryClinch path', async () => {
    // Arrange: findFinalVictoryRoute returns null
    mockFindFinalVictoryRoute.mockReturnValue(null);

    // Act: run takeTurn — should not throw; falls through to the else branch
    await expect(AIStrategyEngine.takeTurn('game-test-jira245', 'bot-1')).resolves.not.toThrow();

    // findFinalVictoryRoute was invoked exactly once
    expect(mockFindFinalVictoryRoute).toHaveBeenCalledTimes(1);

    // ActiveRouteContinuer should NOT have been called (no activeRoute was set)
    const { ActiveRouteContinuer } = require('../../services/ai/ActiveRouteContinuer');
    expect(ActiveRouteContinuer.run).not.toHaveBeenCalled();
  });

  it('AC12 — idempotency: does not replace activeRoute if already targeting first stop', async () => {
    // Arrange: bot already has an activeRoute targeting the first stop of the victory route
    const existingRoute = {
      stops: VICTORY_ROUTE_STOPS,
      currentStopIndex: 0,
      phase: 'travel',
      createdAtTurn: 49,
      reasoning: '[final-victory] existing route from prior turn',
    };
    MOCK_ACTIVE_ROUTE_STATE.current = existingRoute;

    // getMemory returns the existing route
    const { getMemory } = require('../../services/ai/BotMemory');
    (getMemory as jest.MockedFunction<any>).mockResolvedValueOnce({
      turnNumber: 50,
      consecutiveDiscards: 0,
      lastAction: null,
      activeRoute: existingRoute,
      turnsOnRoute: 1,
      routeHistory: [],
      gameState: 'End',
      deliveryCount: 10,
      totalEarnings: 200,
      consecutiveLlmFailures: 0,
    });

    mockFindFinalVictoryRoute.mockReturnValue(FINAL_VICTORY_ROUTE);

    // Act
    await AIStrategyEngine.takeTurn('game-test-jira245', 'bot-1');

    // findFinalVictoryRoute was called
    expect(mockFindFinalVictoryRoute).toHaveBeenCalledTimes(1);

    // ActiveRouteContinuer IS still called — the existing route remains the activeRoute
    // (idempotency means we don't re-assign, but the existing route still runs).
    const { ActiveRouteContinuer } = require('../../services/ai/ActiveRouteContinuer');
    expect(ActiveRouteContinuer.run).toHaveBeenCalledTimes(1);

    // The route passed should be the EXISTING route (same object), not a new one
    const routePassedToContinuer = (ActiveRouteContinuer.run as jest.MockedFunction<any>).mock.calls[0][0];
    expect(routePassedToContinuer).toBe(existingRoute);
  });
});

// ── JIRA-261: idempotency check now compares full remaining-stops sequence ────

describe('JIRA-261 — findFinalVictoryRoute override idempotency uses full-sequence match', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    MOCK_ACTIVE_ROUTE_STATE.current = null;
  });

  it('AC1 — divergent routes (matching first stop, divergent later stops) → override fires', async () => {
    // Game 8350cffa s3 T68 scenario: 4-stop deterministic route vs 6-stop victory
    // route sharing first stop. Pre-fix the override was suppressed by the
    // first-stop-only check; post-fix it must fire because the rest diverges.
    const existingDeterministic = {
      stops: [
        { action: 'pickup' as const, loadType: 'Ham', city: 'Warszawa' },
        { action: 'deliver' as const, loadType: 'Ham', city: 'Glasgow' },
        { action: 'pickup' as const, loadType: 'Oil', city: 'Beograd' },
        { action: 'deliver' as const, loadType: 'Oil', city: 'Hamburg' },
      ],
      currentStopIndex: 0,
      phase: 'travel',
      createdAtTurn: 67,
      reasoning: '[deterministic-top-1] Ham + Oil chain',
    };
    MOCK_ACTIVE_ROUTE_STATE.current = existingDeterministic;
    const { getMemory } = require('../../services/ai/BotMemory');
    (getMemory as jest.MockedFunction<any>).mockResolvedValueOnce({
      turnNumber: 68, consecutiveDiscards: 0, lastAction: null,
      activeRoute: existingDeterministic, turnsOnRoute: 1, routeHistory: [],
      gameState: 'End', deliveryCount: 6, totalEarnings: 223, consecutiveLlmFailures: 0,
    });

    const victoryRoute: FinalVictoryRoute = {
      stops: [
        { action: 'pickup', loadType: 'Ham', city: 'Warszawa' },       // ← first stop matches
        { action: 'deliver', loadType: 'Ham', city: 'Glasgow' },
        { action: 'pickup', loadType: 'Oranges', city: 'Sevilla' },    // ← diverges here
        { action: 'deliver', loadType: 'Oranges', city: 'London', demandCardId: 3, payment: 34 },
        { action: 'pickup', loadType: 'Oil', city: 'Beograd' },
        { action: 'deliver', loadType: 'Oil', city: 'Hamburg', demandCardId: 18, payment: 22 },
      ],
      estimatedTurns: 13, buildCost: 66, totalPayout: 99,
      cashAtVictory: 256, majorsAtVictory: 7, majorConnectors: ['London', 'Paris', 'Hamburg', 'Madrid'],
      reasoning: '[final-victory] Ham→Glasgow, Oranges→London, Oil→Hamburg',
    };
    mockFindFinalVictoryRoute.mockReturnValue(victoryRoute);

    await AIStrategyEngine.takeTurn('game-jira261', 'bot-1');

    const { ActiveRouteContinuer } = require('../../services/ai/ActiveRouteContinuer');
    expect(ActiveRouteContinuer.run).toHaveBeenCalledTimes(1);

    // Critical assertion: ActiveRouteContinuer received the VICTORY route (6 stops),
    // not the existing deterministic route (4 stops).
    const routePassedToContinuer = (ActiveRouteContinuer.run as jest.MockedFunction<any>).mock.calls[0][0];
    expect(routePassedToContinuer.stops).toHaveLength(6);
    expect(routePassedToContinuer.stops[2]).toMatchObject({
      action: 'pickup', loadType: 'Oranges', city: 'Sevilla',
    });
    expect(routePassedToContinuer.stops[3]).toMatchObject({
      action: 'deliver', loadType: 'Oranges', city: 'London',
    });
    expect(routePassedToContinuer.reasoning).toContain('[final-victory]');
  });

  it('AC2 — identical plans (existing == proposed) → override SUPPRESSED (no churn)', async () => {
    const stops = [
      { action: 'pickup' as const, loadType: 'Beer', city: 'Frankfurt' },
      { action: 'deliver' as const, loadType: 'Beer', city: 'Bruxelles', demandCardId: 1, payment: 10 },
    ];
    const existing = {
      stops,
      currentStopIndex: 0,
      phase: 'travel',
      createdAtTurn: 49,
      reasoning: '[final-victory] existing',
    };
    MOCK_ACTIVE_ROUTE_STATE.current = existing;
    const { getMemory } = require('../../services/ai/BotMemory');
    (getMemory as jest.MockedFunction<any>).mockResolvedValueOnce({
      turnNumber: 50, consecutiveDiscards: 0, lastAction: null,
      activeRoute: existing, turnsOnRoute: 1, routeHistory: [],
      gameState: 'End', deliveryCount: 10, totalEarnings: 200, consecutiveLlmFailures: 0,
    });

    const proposed: FinalVictoryRoute = {
      stops, // same reference, but the check uses structural equality
      estimatedTurns: 2, buildCost: 0, totalPayout: 10,
      cashAtVictory: 251, majorsAtVictory: 7, majorConnectors: [],
      reasoning: '[final-victory] proposed (identical plan, fresh reasoning)',
    };
    mockFindFinalVictoryRoute.mockReturnValue(proposed);

    await AIStrategyEngine.takeTurn('game-jira261', 'bot-1');

    const { ActiveRouteContinuer } = require('../../services/ai/ActiveRouteContinuer');
    const routePassedToContinuer = (ActiveRouteContinuer.run as jest.MockedFunction<any>).mock.calls[0][0];
    // Existing route preserved (same reference) — no override.
    expect(routePassedToContinuer).toBe(existing);
  });

  it('AC3 — currentStopIndex > 0 with remaining-slice equal to proposed → SUPPRESS', async () => {
    // Bot has completed 2 of 4 stops. Remaining slice is `[pickup B, deliver B]`.
    // Proposed victory route is `[pickup B, deliver B]`. Same plan from current
    // position → suppress (no churn).
    const existing = {
      stops: [
        { action: 'pickup' as const, loadType: 'A', city: 'X' }, // completed
        { action: 'deliver' as const, loadType: 'A', city: 'Y' }, // completed
        { action: 'pickup' as const, loadType: 'B', city: 'Z' },
        { action: 'deliver' as const, loadType: 'B', city: 'W' },
      ],
      currentStopIndex: 2,
      phase: 'travel',
      createdAtTurn: 60,
      reasoning: 'mid-route',
    };
    MOCK_ACTIVE_ROUTE_STATE.current = existing;
    const { getMemory } = require('../../services/ai/BotMemory');
    (getMemory as jest.MockedFunction<any>).mockResolvedValueOnce({
      turnNumber: 65, consecutiveDiscards: 0, lastAction: null,
      activeRoute: existing, turnsOnRoute: 5, routeHistory: [],
      gameState: 'End', deliveryCount: 8, totalEarnings: 250, consecutiveLlmFailures: 0,
    });

    const proposed: FinalVictoryRoute = {
      stops: [
        { action: 'pickup', loadType: 'B', city: 'Z' },
        { action: 'deliver', loadType: 'B', city: 'W' },
      ],
      estimatedTurns: 3, buildCost: 5, totalPayout: 30,
      cashAtVictory: 275, majorsAtVictory: 7, majorConnectors: [],
      reasoning: '[final-victory] B-only',
    };
    mockFindFinalVictoryRoute.mockReturnValue(proposed);

    await AIStrategyEngine.takeTurn('game-jira261', 'bot-1');

    const { ActiveRouteContinuer } = require('../../services/ai/ActiveRouteContinuer');
    const routePassedToContinuer = (ActiveRouteContinuer.run as jest.MockedFunction<any>).mock.calls[0][0];
    expect(routePassedToContinuer).toBe(existing);
  });

  it('AC5 — same load type, different delivery city → override fires', async () => {
    // First stop matches on (action, loadType) but city differs → still must override.
    const existing = {
      stops: [
        { action: 'pickup' as const, loadType: 'Beer', city: 'Frankfurt' },
        { action: 'deliver' as const, loadType: 'Beer', city: 'Bruxelles' },
      ],
      currentStopIndex: 0,
      phase: 'travel',
      createdAtTurn: 49,
      reasoning: 'existing',
    };
    MOCK_ACTIVE_ROUTE_STATE.current = existing;
    const { getMemory } = require('../../services/ai/BotMemory');
    (getMemory as jest.MockedFunction<any>).mockResolvedValueOnce({
      turnNumber: 50, consecutiveDiscards: 0, lastAction: null,
      activeRoute: existing, turnsOnRoute: 1, routeHistory: [],
      gameState: 'End', deliveryCount: 10, totalEarnings: 200, consecutiveLlmFailures: 0,
    });

    const proposed: FinalVictoryRoute = {
      stops: [
        { action: 'pickup', loadType: 'Beer', city: 'Frankfurt' },     // same
        { action: 'deliver', loadType: 'Beer', city: 'London' },       // ← different city
      ],
      estimatedTurns: 3, buildCost: 0, totalPayout: 10,
      cashAtVictory: 260, majorsAtVictory: 7, majorConnectors: ['London'],
      reasoning: '[final-victory] Beer→London (re-routed)',
    };
    mockFindFinalVictoryRoute.mockReturnValue(proposed);

    await AIStrategyEngine.takeTurn('game-jira261', 'bot-1');

    const { ActiveRouteContinuer } = require('../../services/ai/ActiveRouteContinuer');
    const routePassedToContinuer = (ActiveRouteContinuer.run as jest.MockedFunction<any>).mock.calls[0][0];
    expect(routePassedToContinuer.stops[1]).toMatchObject({
      action: 'deliver', loadType: 'Beer', city: 'London',
    });
  });
});
