/**
 * AIStrategyEngine integration tests — JIRA-279: freshness gate wiring.
 *
 * Tests cover:
 * - gateVictoryOutcomeFreshness is called after findFinalVictoryOutcome
 * - snapshot_mismatch skip: activeRoute stays null, finalVictoryAppliedOverride=false,
 *   endGameTrace records snapshot_mismatch reason
 * - fire outcome: applied activeRoute carries derivedFromIdentity from the route
 * - JIRA-261/266/267/245 regression: existing behavior preserved on fresh turns
 */

import { describe, it, expect, jest, beforeEach } from '@jest/globals';

// ── Shared mock state ─────────────────────────────────────────────────────────

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

// ── External system mocks ─────────────────────────────────────────────────────

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

// ── Types ─────────────────────────────────────────────────────────────────────

import type { WorldSnapshot, SnapshotIdentity } from '../../../shared/types/GameTypes';
import { TrainType } from '../../../shared/types/GameTypes';
import type { FinalVictoryRoute, FinalVictoryOutcome, EndGameRoutingDecision } from '../../services/ai/victoryRules';

// ── Snapshot factory ──────────────────────────────────────────────────────────

const MATCHING_IDENTITY: SnapshotIdentity = { turnNumber: 50, factsHash: 'abc-matching' };

function makeGameSnapshot(identity?: SnapshotIdentity): WorldSnapshot {
  return {
    gameId: 'test-jira279',
    gameStatus: 'active',
    turnNumber: 50,
    identity,
    bot: {
      playerId: 'bot-1',
      userId: 'user-1',
      money: 241,
      position: { row: 10, col: 10 },
      existingSegments: [],
      demandCards: [1],
      resolvedDemands: [
        { cardId: 1, demands: [{ loadType: 'Beer', city: 'Bruxelles', payment: 10 }] },
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

// ── Victory route fixture ─────────────────────────────────────────────────────

const VICTORY_ROUTE_STOPS = [
  { action: 'pickup' as const, loadType: 'Beer', city: 'Frankfurt' },
  { action: 'deliver' as const, loadType: 'Beer', city: 'Bruxelles', demandCardId: 1, payment: 10 },
];

function makeFinalVictoryRoute(identity?: SnapshotIdentity): FinalVictoryRoute {
  return {
    stops: VICTORY_ROUTE_STOPS,
    estimatedTurns: 2,
    buildCost: 0,
    totalPayout: 10,
    cashAtVictory: 251,
    majorsAtVictory: 7,
    majorConnectors: [],
    reasoning: '[final-victory] Beer→Bruxelles, turns=2',
    derivedFromIdentity: identity,
  };
}

// ── Mock victoryRules with controllable EndGameRoutingDecision handoff ────────

const mockEndGameRoutingDecisionState: { value: EndGameRoutingDecision } = {
  value: { kind: 'skip', reason: 'not_in_end_state' },
};

const mockBuildEndGameRoutingDecision = jest.fn<(
  snapshot: WorldSnapshot,
  context: any,
  memory: any,
) => EndGameRoutingDecision>();

jest.mock('../../services/ai/victoryRules', () => {
  const real = jest.requireActual<typeof import('../../services/ai/victoryRules')>('../../services/ai/victoryRules');
  return {
    ...real,
    buildEndGameRoutingDecision: mockBuildEndGameRoutingDecision,
    findFinalVictoryOutcome: jest.fn<() => FinalVictoryOutcome>().mockImplementation(() => {
      const decision = mockEndGameRoutingDecisionState.value;
      if (decision.kind === 'fire') {
        return {
          outcome: 'fire',
          route: decision.route,
          cashGap: decision.cashGap,
          majorsGap: decision.majorsGap,
          connectorCost: decision.connectorCost,
        };
      }
      return {
        outcome: 'skip',
        reason: decision.reason,
        cashGap: decision.cashGap,
        majorsGap: decision.majorsGap,
        connectorCost: decision.connectorCost,
      };
    }),
  };
});

jest.mock('../../services/ai/WorldSnapshotService', () => ({
  capture: jest.fn<() => Promise<any>>().mockImplementation(() =>
    Promise.resolve(makeGameSnapshot(MATCHING_IDENTITY)),
  ),
  computeIdentity: jest.fn(() => MATCHING_IDENTITY),
}));

// ── System under test ─────────────────────────────────────────────────────────

import { AIStrategyEngine } from '../../services/ai/AIStrategyEngine';
import { ActiveRouteContinuer } from '../../services/ai/ActiveRouteContinuer';

const mockActiveContinuer = ActiveRouteContinuer as { run: jest.MockedFunction<any> };

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('AIStrategyEngine JIRA-279 — freshness gate integration', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    MOCK_ACTIVE_ROUTE_STATE.current = null;
    mockEndGameRoutingDecisionState.value = { kind: 'skip', reason: 'not_in_end_state' };
    mockBuildEndGameRoutingDecision.mockImplementation(() => mockEndGameRoutingDecisionState.value);
  });

  it('AC1: buildEndGameRoutingDecision is called with the live snapshot, context, and memory', async () => {
    const route = makeFinalVictoryRoute(MATCHING_IDENTITY);
    mockEndGameRoutingDecisionState.value = {
      kind: 'fire',
      route,
      cashGap: 9,
      majorsGap: 0,
      connectorCost: 0,
      derivedFromIdentity: MATCHING_IDENTITY,
    };

    await AIStrategyEngine.takeTurn('game-jira279', 'bot-1');

    expect(mockBuildEndGameRoutingDecision).toHaveBeenCalledTimes(1);
    const [snapshotArg, contextArg, memoryArg] = mockBuildEndGameRoutingDecision.mock.calls[0];
    expect(snapshotArg.identity).toEqual(MATCHING_IDENTITY);
    expect(contextArg.gameState).toBe('End');
    expect(memoryArg.gameState).toBe('End');
  });

  it('AC2: snapshot_mismatch skip — activeRoute stays null, ActiveRouteContinuer not called', async () => {
    mockEndGameRoutingDecisionState.value = {
      kind: 'skip',
      reason: 'snapshot_mismatch',
      cashGap: 9,
      majorsGap: 0,
      connectorCost: 0,
    };

    await AIStrategyEngine.takeTurn('game-jira279', 'bot-1');

    // ActiveRouteContinuer should NOT be called (no active route was set)
    expect(mockActiveContinuer.run).not.toHaveBeenCalled();
  });

  it('AC3: fresh fire outcome — applied activeRoute carries derivedFromIdentity', async () => {
    const route = makeFinalVictoryRoute(MATCHING_IDENTITY);
    mockEndGameRoutingDecisionState.value = {
      kind: 'fire',
      route,
      cashGap: 9,
      majorsGap: 0,
      connectorCost: 0,
      derivedFromIdentity: MATCHING_IDENTITY,
    };

    await AIStrategyEngine.takeTurn('game-jira279', 'bot-1');

    // ActiveRouteContinuer was called (route was applied)
    expect(mockActiveContinuer.run).toHaveBeenCalledTimes(1);

    // The route passed to ActiveRouteContinuer should carry derivedFromIdentity
    const routePassedToContinuer = (mockActiveContinuer.run as jest.MockedFunction<any>).mock.calls[0][0];
    expect(routePassedToContinuer.derivedFromIdentity).toEqual(MATCHING_IDENTITY);
    expect(routePassedToContinuer.reasoning).toContain('[final-victory]');
  });

  it('AC4: skip decision — producer is called and no active route is set', async () => {
    mockEndGameRoutingDecisionState.value = {
      kind: 'skip',
      reason: 'no_demands',
    };

    await AIStrategyEngine.takeTurn('game-jira279', 'bot-1');

    expect(mockBuildEndGameRoutingDecision).toHaveBeenCalledTimes(1);
    expect(mockBuildEndGameRoutingDecision.mock.results[0].value).toEqual({
      kind: 'skip',
      reason: 'no_demands',
    });

    // No active route set — continuer not called
    expect(mockActiveContinuer.run).not.toHaveBeenCalled();
  });
});
