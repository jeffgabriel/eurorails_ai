/**
 * AIStrategyEngine integration tests — TEST-007
 *
 * Tests the full takeTurn pipeline:
 *   WorldSnapshot.capture → ContextBuilder.build → LLMStrategyBrain.decideAction
 *   → GuardrailEnforcer.checkPlan → TurnExecutor.executePlan
 *
 * External dependencies (DB, socket, LLM providers) are mocked.
 * Internal pipeline components interact as in production.
 */

import { describe, it, expect, beforeEach, jest } from '@jest/globals';

// ── Mock external systems ─────────────────────────────────────────────────

jest.mock('../../db/index', () => ({
  db: {
    query: jest.fn<() => Promise<any>>(),
    connect: jest.fn<() => Promise<any>>(),
  },
}));

jest.mock('../../services/socketService', () => ({
  emitTurnChange: jest.fn<() => void>(),
  emitStatePatch: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
  emitToGame: jest.fn<() => void>(),
  getSocketIO: jest.fn<() => any>().mockReturnValue(null),
}));

jest.mock('../../services/ai/MapTopology', () => ({
  loadGridPoints: jest.fn(() => new Map()),
  getHexNeighbors: jest.fn(() => []),
  getTerrainCost: jest.fn(() => 1),
  gridToPixel: jest.fn(() => ({ x: 100, y: 200 })),
  _resetCache: jest.fn(),
}));

jest.mock('../../../shared/services/majorCityGroups', () => ({
  getMajorCityGroups: jest.fn(() => []),
  getMajorCityLookup: jest.fn(() => new Map()),
  getFerryEdges: jest.fn(() => []),
  computeEffectivePathLength: jest.fn((path: Array<{ row: number; col: number }>) => Math.max(0, path.length - 1)),
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
    moveTrainForUser: jest.fn(),
    updateCurrentPlayerIndex: jest.fn(),
    deliverLoadForUser: jest.fn(),
    getPlayers: jest.fn<(...args: any[]) => Promise<any>>().mockResolvedValue([]),
  },
}));

// Mock BotMemory
jest.mock('../../services/ai/BotMemory', () => ({
  getMemory: jest.fn(() => ({
    turnNumber: 0,
    noProgressTurns: 0,
    consecutiveDiscards: 0,
    lastAction: null,
    activeRoute: null,
    turnsOnRoute: 0,
    routeHistory: [],
  })),
  updateMemory: jest.fn(),
}));

// Mock RouteValidator
jest.mock('../../services/ai/RouteValidator', () => ({
  RouteValidator: {
    reorderStopsByProximity: jest.fn((stops: any) => stops),
  },
}));

// Mock TurnExecutorPlanner — the new unified turn planner replacing PlanExecutor+TurnComposer
const defaultCompositionTrace = {
  inputPlan: [], outputPlan: [],
  moveBudget: { total: 9, used: 0, wasted: 0 },
  a1: { citiesScanned: 0, opportunitiesFound: 0 },
  a2: { iterations: 0, terminationReason: 'none' },
  a3: { movePreprended: false },
  build: { target: null, cost: 0, skipped: true, upgradeConsidered: false },
  pickups: [], deliveries: [],
};
jest.mock('../../services/ai/TurnExecutorPlanner', () => ({
  TurnExecutorPlanner: {
    execute: jest.fn(),
    filterByDirection: jest.fn((targets: any) => targets),
    findDeadLoads: jest.fn(() => []),
    revalidateRemainingDeliveries: jest.fn((route: any) => route),
  },
}));

// Mock ActionResolver
jest.mock('../../services/ai/ActionResolver', () => ({
  ActionResolver: {
    resolve: jest.fn(),
    heuristicFallback: jest.fn(),
    cloneSnapshot: jest.fn((snapshot: any) => ({
      ...snapshot,
      bot: { ...snapshot.bot, loads: [...snapshot.bot.loads], existingSegments: [...snapshot.bot.existingSegments], demandCards: [...snapshot.bot.demandCards], resolvedDemands: snapshot.bot.resolvedDemands.map((rd: any) => ({ ...rd, demands: [...rd.demands] })) },
      allPlayerTracks: snapshot.allPlayerTracks.map((pt: any) => ({ ...pt, segments: [...pt.segments] })),
    })),
    applyPlanToState: jest.fn(),
  },
}));

// Mock TripPlanner (JIRA-126: replaces brain.planRoute for initial route planning)
// Delegates planTrip(snapshot, context, gridPoints, memory) → brain.planRoute(snapshot, context, gridPoints, ...)
// so existing mockPlanRoute setups continue to work.
jest.mock('../../services/ai/TripPlanner', () => ({
  TripPlanner: jest.fn().mockImplementation((brain: any) => ({
    planTrip: jest.fn(async (snapshot: any, context: any, gridPoints: any, memory: any) => {
      const result = await brain.planRoute(
        snapshot, context, gridPoints,
        memory?.lastAbandonedRouteKey,
        memory?.previousRouteStops,
      );
      if (!result || !result.route) return { route: null, llmLog: result?.llmLog ?? [] };
      return {
        candidates: [],
        chosen: -1,
        route: result.route,
        llmLatencyMs: result.latencyMs ?? 0,
        llmTokens: result.tokenUsage ?? { input: 0, output: 0 },
        llmLog: result.llmLog ?? [],
      };
    }),
  })),
}));

// TurnComposer has been deleted — its methods are now on TurnExecutorPlanner (already mocked above)

// Mock DecisionLogger
jest.mock('../../services/ai/DecisionLogger', () => ({
  initTurnLog: jest.fn(),
  logPhase: jest.fn(),
  flushTurnLog: jest.fn(),
}));

// Mock WorldSnapshotService
jest.mock('../../services/ai/WorldSnapshotService', () => ({
  capture: jest.fn(),
}));

// Mock ContextBuilder
jest.mock('../../services/ai/ContextBuilder', () => ({
  ContextBuilder: {
    build: jest.fn(),
    serializePrompt: jest.fn(() => 'serialized-prompt'),
    rebuildDemands: jest.fn(() => []),
    computeEnRoutePickups: jest.fn(() => []),
    // JIRA-161: computeUpgradeAdvice is now public static and called from takeTurn
    computeUpgradeAdvice: jest.fn(() => undefined),
  },
}));

// Mock LLMStrategyBrain
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

// ── Imports (after mocks) ─────────────────────────────────────────────────

import { AIStrategyEngine } from '../../services/ai/AIStrategyEngine';
import { capture } from '../../services/ai/WorldSnapshotService';
import { ContextBuilder } from '../../services/ai/ContextBuilder';
import { LLMStrategyBrain } from '../../services/ai/LLMStrategyBrain';
import { ActionResolver } from '../../services/ai/ActionResolver';
import { TurnExecutorPlanner } from '../../services/ai/TurnExecutorPlanner';
import { RouteEnrichmentAdvisor } from '../../services/ai/RouteEnrichmentAdvisor';
import { db } from '../../db/index';
import { emitToGame } from '../../services/socketService';
import { getMemory, updateMemory } from '../../services/ai/BotMemory';
import { loadGridPoints } from '../../services/ai/MapTopology';
import { PlayerService } from '../../services/playerService';
import {
  AIActionType,
  WorldSnapshot,
  GameContext,
  BotSkillLevel,
  TrainType,
  TerrainType,
  TrackSegment,
  DeliveryOpportunity,
  StrategicRoute,
} from '../../../shared/types/GameTypes';

const mockCapture = capture as jest.MockedFunction<typeof capture>;
const mockContextBuild = ContextBuilder.build as jest.MockedFunction<typeof ContextBuilder.build>;
const mockQuery = db.query as unknown as jest.Mock<(...args: any[]) => Promise<any>>;
const mockConnect = (db as any).connect as unknown as jest.Mock<() => Promise<any>>;
const mockEmitToGame = emitToGame as jest.MockedFunction<typeof emitToGame>;
const mockTurnExecutorPlannerExecute = TurnExecutorPlanner.execute as jest.MockedFunction<typeof TurnExecutorPlanner.execute>;
const mockGetMemory = getMemory as jest.MockedFunction<typeof getMemory>;
const mockHeuristicFallback = ActionResolver.heuristicFallback as jest.MockedFunction<typeof ActionResolver.heuristicFallback>;
const mockUpdateMemory = updateMemory as jest.MockedFunction<typeof updateMemory>;

/** Returns a mock LLMStrategyBrain instance with providerAdapter (required by JIRA-143 call tracking). */
function makeMockBrain(overrides: Record<string, any> = {}): any {
  return {
    decideAction: jest.fn(),
    planRoute: jest.fn(),
    modelName: 'claude-haiku-4-5-20251001',
    providerAdapter: {
      resetCallIds: jest.fn(),
      getCallIds: jest.fn(() => []),
      getCallSummaries: jest.fn(() => []),
    },
    ...overrides,
  };
}

// ── Factory helpers ───────────────────────────────────────────────────────

function makeSegment(fromRow: number, fromCol: number, toRow: number, toCol: number, cost: number = 1): TrackSegment {
  return {
    from: { x: 0, y: 0, row: fromRow, col: fromCol, terrain: TerrainType.Clear },
    to: { x: 0, y: 0, row: toRow, col: toCol, terrain: TerrainType.Clear },
    cost,
  };
}

function makeSnapshot(overrides: Partial<WorldSnapshot['bot']> = {}): WorldSnapshot {
  return {
    gameId: 'game-1',
    gameStatus: 'active',
    turnNumber: 5,
    bot: {
      playerId: 'bot-1',
      userId: 'user-bot-1',
      money: 50,
      position: { row: 10, col: 10 },
      existingSegments: [makeSegment(10, 10, 10, 11)],
      demandCards: [1],
      resolvedDemands: [],
      trainType: TrainType.Freight,
      loads: [],
      botConfig: null,
      ferryHalfSpeed: false,
      connectedMajorCityCount: 0,
      ...overrides,
    } as WorldSnapshot['bot'],
    allPlayerTracks: [
      { playerId: 'bot-1', segments: [makeSegment(10, 10, 10, 11)] },
    ],
    loadAvailability: {},
  };
}

function makeContext(overrides: Partial<GameContext> = {}): GameContext {
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
    turnNumber: 5,
    ...overrides,
  };
}

function mockResult(rows: any[]) {
  return { rows, command: '', rowCount: rows.length, oid: 0, fields: [] };
}

/**
 * Helper: set up TurnExecutorPlanner.execute mock with PlanExecutorResult-compatible shape.
 * Converts the old { plan, routeComplete, routeAbandoned, updatedRoute, description } shape
 * to the new TurnExecutorResult shape: { plans[], routeComplete, routeAbandoned, updatedRoute, compositionTrace, hasDelivery }.
 */
function mockTurnExecResult(opts: {
  plan: any;
  routeComplete: boolean;
  routeAbandoned: boolean;
  updatedRoute: any;
  description?: string;
  hasDelivery?: boolean;
}): any {
  const plan = opts.plan;
  const hasDelivery = opts.hasDelivery ?? (
    plan.type === AIActionType.DeliverLoad ||
    (plan.type === 'MultiAction' && plan.steps?.some((s: any) => s.type === AIActionType.DeliverLoad))
  );
  return {
    plans: plan.type === AIActionType.PassTurn ? [] : [plan],
    routeComplete: opts.routeComplete,
    routeAbandoned: opts.routeAbandoned,
    updatedRoute: opts.updatedRoute,
    compositionTrace: defaultCompositionTrace,
    hasDelivery,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────

describe('AIStrategyEngine.takeTurn (Integration)', () => {
  let mockClient: any;
  let mockDecideAction: jest.Mock<() => Promise<any>>;
  let mockPlanRoute: jest.Mock<(...args: any[]) => Promise<any>>;

  beforeEach(() => {
    jest.clearAllMocks();

    // Re-set all mock implementations explicitly — clearAllMocks only resets
    // call history, NOT mockReturnValue/mockImplementation. Without these
    // re-sets, mock behavior from a previous test leaks into the next one.

    // Set up mock transaction client for TurnExecutor
    mockClient = {
      query: jest.fn<(...args: any[]) => Promise<any>>().mockResolvedValue(mockResult([])),
      release: jest.fn<() => void>(),
    };
    mockConnect.mockResolvedValue(mockClient);

    // Default query responses
    mockQuery.mockResolvedValue(mockResult([]));

    // Set up LLMStrategyBrain mock
    mockDecideAction = jest.fn<() => Promise<any>>();
    mockPlanRoute = jest.fn<(...args: any[]) => Promise<any>>().mockResolvedValue(null);
    (LLMStrategyBrain as unknown as jest.MockedClass<typeof LLMStrategyBrain>).mockImplementation(
      (() => ({
        decideAction: mockDecideAction,
        planRoute: mockPlanRoute,
        modelName: 'claude-haiku-4-5-20251001',
        providerAdapter: {
          resetCallIds: jest.fn(),
          getCallIds: jest.fn(() => []),
          getCallSummaries: jest.fn(() => []),
        },
      })) as any,
    );

    // Default TurnExecutorPlanner.execute — returns PassTurn with no route changes
    mockTurnExecutorPlannerExecute.mockResolvedValue({
      plans: [{ type: AIActionType.PassTurn }],
      updatedRoute: { stops: [], currentStopIndex: 0, phase: 'build' as const, createdAtTurn: 0 },
      compositionTrace: defaultCompositionTrace,
      routeComplete: false,
      routeAbandoned: false,
      hasDelivery: false,
    } as any);
  });

  describe('successful turn — BuildTrack', () => {
    it('should execute full pipeline: capture → context → decide → guardrail → execute', async () => {
      const seg = makeSegment(10, 11, 10, 12, 1);

      // Provide API key so LLM path is taken
      process.env.ANTHROPIC_API_KEY = 'test-key';

      // Need botConfig with skillLevel for createBrain
      const snapshotWithConfig = makeSnapshot({
        botConfig: { skillLevel: 'medium' },
      } as any);
      const context = makeContext();
      mockCapture.mockResolvedValue(snapshotWithConfig);
      mockContextBuild.mockResolvedValue(context);

      // Simulate LLM planning a route
      const route: StrategicRoute = {
        stops: [{ action: 'pickup', loadType: 'Steel', city: 'Berlin' }],
        currentStopIndex: 0,
        phase: 'build' as const,
        reasoning: 'Build toward Berlin',
        createdAtTurn: 3,
      };
      mockPlanRoute.mockResolvedValue({
        route,
        model: 'claude-sonnet-4-20250514',
        latencyMs: 500,
      });

      // PlanExecutor returns a build plan
      mockTurnExecutorPlannerExecute.mockResolvedValue(mockTurnExecResult({
        plan: { type: AIActionType.BuildTrack, segments: [seg] },
        routeComplete: false,
        routeAbandoned: false,
        updatedRoute: route,
        description: 'Building toward Berlin',
      }));

      const result = await AIStrategyEngine.takeTurn('game-1', 'bot-1');

      expect(result.action).toBe(AIActionType.BuildTrack);
      expect(result.success).toBe(true);
      expect(result.reasoning).toContain('Build toward Berlin');
      expect(result.durationMs).toBeGreaterThanOrEqual(0);

      // Pipeline stages were invoked
      expect(mockCapture).toHaveBeenCalledWith('game-1', 'bot-1');
      expect(mockContextBuild).toHaveBeenCalled();
      expect(mockPlanRoute).toHaveBeenCalled();

      delete process.env.ANTHROPIC_API_KEY;
    });
  });

  describe('successful turn — PassTurn (no API key)', () => {
    it('should pass turn directly when no LLM API key is available', async () => {
      delete process.env.ANTHROPIC_API_KEY;

      const snapshot = makeSnapshot({ botConfig: null } as any);
      const context = makeContext();

      mockCapture.mockResolvedValue(snapshot);
      mockContextBuild.mockResolvedValue(context);

      const result = await AIStrategyEngine.takeTurn('game-1', 'bot-1');

      // Without API key, should PassTurn directly (no heuristic fallback)
      expect(result.action).toBe(AIActionType.PassTurn);
      expect(result.reasoning).toContain('no-api-key');

      // LLMStrategyBrain should NOT have been created
      expect(LLMStrategyBrain).not.toHaveBeenCalled();
      // heuristicFallback should NOT have been called
      expect(mockHeuristicFallback).not.toHaveBeenCalled();
    });
  });

  describe('guardrail override — force DELIVER', () => {
    it('should force DELIVER when LLM route chose BUILD but delivery is available', async () => {
      process.env.ANTHROPIC_API_KEY = 'test-key';

      const delivery: DeliveryOpportunity = {
        loadType: 'Coal',
        deliveryCity: 'Berlin',
        payout: 25,
        cardIndex: 0,
      };

      const snapshot = makeSnapshot({
        botConfig: { skillLevel: 'medium' },
        loads: ['Coal'],
        resolvedDemands: [
          { cardId: 42, demands: [{ city: 'Berlin', loadType: 'Coal', payment: 25 }] },
        ],
      } as any);
      const context = makeContext({ canDeliver: [delivery] });

      mockCapture.mockResolvedValue(snapshot);
      mockContextBuild.mockResolvedValue(context);

      // LLM route planning succeeds with a route
      const route: StrategicRoute = {
        stops: [{ action: 'pickup', loadType: 'Steel', city: 'Ruhr' }],
        currentStopIndex: 0,
        phase: 'build' as const,
        reasoning: 'Extend network',
        createdAtTurn: 3,
      };
      mockPlanRoute.mockResolvedValue({
        route,
        model: 'claude-sonnet-4-20250514',
        latencyMs: 300,
      });

      // PlanExecutor returns a BUILD plan
      mockTurnExecutorPlannerExecute.mockResolvedValue(mockTurnExecResult({
        plan: { type: AIActionType.BuildTrack, segments: [makeSegment(10, 11, 10, 12)] },
        routeComplete: false,
        routeAbandoned: false,
        updatedRoute: route,
        description: 'Building toward Ruhr',
      }));

      const result = await AIStrategyEngine.takeTurn('game-1', 'bot-1');

      // Guardrail should override BUILD to DELIVER
      expect(result.action).toBe(AIActionType.DeliverLoad);
      expect(result.guardrailOverride).toBe(true);
      expect(result.guardrailReason).toContain('Forced DELIVER');
      expect(result.guardrailReason).toContain('Coal');

      delete process.env.ANTHROPIC_API_KEY;
    });
  });

  describe('initial build uses LLM route planning', () => {
    it('should use InitialBuildPlanner (not LLM) during initialBuild', async () => {
      // JIRA-142b: InitialBuildPlanner replaces LLM for initial build — bypasses planRoute entirely.
      process.env.ANTHROPIC_API_KEY = 'test-key';

      const snapshot = makeSnapshot({
        botConfig: { skillLevel: 'medium' },
      } as any);
      const context = makeContext({ isInitialBuild: true, canBuild: true });

      mockCapture.mockResolvedValue(snapshot);
      mockContextBuild.mockResolvedValue(context);

      const route: StrategicRoute = {
        stops: [{ action: 'pickup', loadType: 'Steel', city: 'Ruhr' }],
        currentStopIndex: 0,
        phase: 'build' as const,
        startingCity: 'Ruhr',
        reasoning: 'Build from Ruhr for quick first delivery',
        createdAtTurn: 3,
      };

      mockTurnExecutorPlannerExecute.mockResolvedValue(mockTurnExecResult({
        plan: { type: AIActionType.BuildTrack, segments: [makeSegment(10, 10, 10, 11)] },
        routeComplete: false,
        routeAbandoned: false,
        updatedRoute: route,
        description: 'Building toward Ruhr',
      }));

      const result = await AIStrategyEngine.takeTurn('game-1', 'bot-1');

      expect(result.action).toBe(AIActionType.BuildTrack);
      // InitialBuildPlanner uses 'initial-build-planner' model tag
      expect(result.model).toBe('initial-build-planner');
      // planRoute is NOT called — InitialBuildPlanner is computed, not LLM
      expect(mockPlanRoute).not.toHaveBeenCalled();

      delete process.env.ANTHROPIC_API_KEY;
    });

    it('should use InitialBuildPlanner during initialBuild regardless of LLM key', async () => {
      // JIRA-142b: InitialBuildPlanner is always used for initial build — no LLM fallback needed.
      process.env.ANTHROPIC_API_KEY = 'test-key';

      const snapshot = makeSnapshot({
        botConfig: { skillLevel: 'medium' },
      } as any);
      const context = makeContext({ isInitialBuild: true, canBuild: true });

      mockCapture.mockResolvedValue(snapshot);
      mockContextBuild.mockResolvedValue(context);

      const route: StrategicRoute = {
        stops: [{ action: 'pickup', loadType: 'Steel', city: 'Ruhr' }],
        currentStopIndex: 0,
        phase: 'build' as const,
        startingCity: 'Ruhr',
        reasoning: 'Build from Ruhr for quick first delivery',
        createdAtTurn: 3,
      };

      mockTurnExecutorPlannerExecute.mockResolvedValue(mockTurnExecResult({
        plan: { type: AIActionType.BuildTrack, segments: [makeSegment(10, 10, 10, 11)] },
        routeComplete: false,
        routeAbandoned: false,
        updatedRoute: route,
        description: 'Building toward Ruhr',
      }));

      const result = await AIStrategyEngine.takeTurn('game-1', 'bot-1');

      // InitialBuildPlanner always produces a result — no PassTurn from LLM failure
      expect(result.action).toBe(AIActionType.BuildTrack);
      expect(result.model).toBe('initial-build-planner');
      // heuristicFallback is NOT called — InitialBuildPlanner handles it
      expect(mockHeuristicFallback).not.toHaveBeenCalled();

      delete process.env.ANTHROPIC_API_KEY;
    });
  });

  describe('route persistence in BotMemory', () => {
    it('should store activeRoute in memory after successful planRoute', async () => {
      process.env.ANTHROPIC_API_KEY = 'test-key';

      const snapshot = makeSnapshot({
        botConfig: { skillLevel: 'medium' },
      } as any);
      // Use non-initial-build context so planRoute is called
      const context = makeContext({ canBuild: true });

      mockCapture.mockResolvedValue(snapshot);
      mockContextBuild.mockResolvedValue(context);

      const route: StrategicRoute = {
        stops: [
          { action: 'pickup', loadType: 'Steel', city: 'Ruhr' },
          { action: 'deliver', loadType: 'Steel', city: 'Paris', demandCardId: 22, payment: 6 },
        ],
        currentStopIndex: 0,
        phase: 'build',
        startingCity: 'Ruhr',
        reasoning: 'Quick first delivery',
        createdAtTurn: 3,
      };
      mockPlanRoute.mockResolvedValue({
        route,
        model: 'claude-sonnet-4-20250514',
        latencyMs: 300,
      });

      const updatedRoute: StrategicRoute = { ...route, currentStopIndex: 0, phase: 'build' };
      mockTurnExecutorPlannerExecute.mockResolvedValue(mockTurnExecResult({
        plan: { type: AIActionType.BuildTrack, segments: [makeSegment(10, 10, 10, 11)] },
        routeComplete: false,
        routeAbandoned: false,
        updatedRoute,
        description: 'Building toward Ruhr',
      }));

      await AIStrategyEngine.takeTurn('game-1', 'bot-1');

      // Verify updateMemory was called with activeRoute
      expect(mockUpdateMemory).toHaveBeenCalled();
      const memoryCall = mockUpdateMemory.mock.calls[0];
      expect(memoryCall[0]).toBe('game-1');
      expect(memoryCall[1]).toBe('bot-1');
      const patch = memoryCall[2] as any;
      expect(patch.activeRoute).toBeDefined();
      expect(patch.activeRoute.startingCity).toBe('Ruhr');
      expect(patch.activeRoute.stops).toHaveLength(2);
      expect(patch.turnsOnRoute).toBe(1);

      delete process.env.ANTHROPIC_API_KEY;
    });

    it('should clear activeRoute when route is completed', async () => {
      const route: StrategicRoute = {
        stops: [{ action: 'deliver', loadType: 'Coal', city: 'Berlin', demandCardId: 1, payment: 25 }],
        currentStopIndex: 0,
        phase: 'travel' as const,
        createdAtTurn: 3,
        reasoning: 'Deliver coal',
      };

      mockGetMemory.mockReturnValue({
        turnNumber: 4,
        noProgressTurns: 0,
        consecutiveDiscards: 0,
        lastAction: null,
        activeRoute: route,
        turnsOnRoute: 2,
        routeHistory: [],
        currentBuildTarget: null,
        turnsOnTarget: 0,
        deliveryCount: 0,
        totalEarnings: 0,
        consecutiveLlmFailures: 0,
      });

      const snapshot = makeSnapshot({
        botConfig: { skillLevel: 'medium' },
      } as any);
      const context = makeContext();
      mockCapture.mockResolvedValue(snapshot);
      mockContextBuild.mockResolvedValue(context);

      // TurnExecutorPlanner reports route complete with a PassTurn action
      // (avoids real TurnExecutor delivery execution which requires additional mocks)
      mockTurnExecutorPlannerExecute.mockResolvedValue({
        plans: [],  // PassTurn equivalent — no actions
        routeComplete: true,
        routeAbandoned: false,
        updatedRoute: route,
        compositionTrace: defaultCompositionTrace,
        hasDelivery: false,
      } as any);

      // Mock heuristicFallback so continuation code doesn't throw
      mockHeuristicFallback.mockResolvedValue({ success: false });

      await AIStrategyEngine.takeTurn('game-1', 'bot-1');

      // Find the updateMemory call that sets activeRoute
      expect(mockUpdateMemory).toHaveBeenCalled();
      const allPatches = mockUpdateMemory.mock.calls.map((c: any[]) => c[2]);
      const routePatch = allPatches.find((p: any) => 'activeRoute' in p);
      expect(routePatch).toBeDefined();
      expect(routePatch.activeRoute).toBeNull();
      expect(routePatch.turnsOnRoute).toBe(0);
      expect(routePatch.routeHistory).toBeDefined();
      expect(routePatch.routeHistory.length).toBeGreaterThan(0);
    });
  });

  describe('pipeline error fallback', () => {
    it('should fall back to PassTurn when WorldSnapshot.capture throws', async () => {
      mockCapture.mockRejectedValue(new Error('DB connection failed'));

      const result = await AIStrategyEngine.takeTurn('game-1', 'bot-1');

      expect(result.action).toBe(AIActionType.PassTurn);
      expect(result.success).toBe(false);
      expect(result.error).toContain('DB connection failed');
      expect(result.cost).toBe(0);
    });

    it('should fall back to PassTurn when ContextBuilder.build throws', async () => {
      mockCapture.mockResolvedValue(makeSnapshot());
      mockContextBuild.mockRejectedValue(new Error('Context build error'));

      const result = await AIStrategyEngine.takeTurn('game-1', 'bot-1');

      expect(result.action).toBe(AIActionType.PassTurn);
      expect(result.success).toBe(false);
      expect(result.error).toContain('Context build error');
    });
  });

  describe('duration tracking', () => {
    it('should include durationMs in result', async () => {
      mockCapture.mockResolvedValue(makeSnapshot());
      mockContextBuild.mockResolvedValue(makeContext());

      const result = await AIStrategyEngine.takeTurn('game-1', 'bot-1');

      expect(result.durationMs).toBeGreaterThanOrEqual(0);
      expect(typeof result.durationMs).toBe('number');
    });
  });

  describe('decision gate — active route auto-execution', () => {
    it('should auto-execute from active route without calling LLM', async () => {
      const route: StrategicRoute = {
        stops: [
          { action: 'pickup', loadType: 'Coal', city: 'Berlin' },
          { action: 'deliver', loadType: 'Coal', city: 'Paris', demandCardId: 1, payment: 25 },
        ],
        currentStopIndex: 0,
        phase: 'build',
        createdAtTurn: 3,
        reasoning: 'Test route',
      };

      // Set memory with active route
      mockGetMemory.mockReturnValue({
        turnNumber: 4,
        noProgressTurns: 0,
        consecutiveDiscards: 0,
        lastAction: null,
        activeRoute: route,
        turnsOnRoute: 1,
        routeHistory: [],
        currentBuildTarget: null,
        turnsOnTarget: 0,
        deliveryCount: 0,
        totalEarnings: 0,
        consecutiveLlmFailures: 0,
      });

      const snapshot = makeSnapshot({
        botConfig: { skillLevel: 'medium' },
      } as any);
      const context = makeContext();
      mockCapture.mockResolvedValue(snapshot);
      mockContextBuild.mockResolvedValue(context);

      process.env.ANTHROPIC_API_KEY = 'test-key';

      // PlanExecutor returns a build plan
      mockTurnExecutorPlannerExecute.mockResolvedValue(mockTurnExecResult({
        plan: { type: AIActionType.BuildTrack, segments: [makeSegment(10, 10, 10, 11)] },
        routeComplete: false,
        routeAbandoned: false,
        updatedRoute: route,
        description: 'Building toward Berlin',
      }));

      const result = await AIStrategyEngine.takeTurn('game-1', 'bot-1');

      expect(result.action).toBe(AIActionType.BuildTrack);
      expect(result.reasoning).toContain('route-executor');
      // LLM decideAction should NOT have been called — brain is created for Phase B BuildAdvisor
      // but the route executor path doesn't call decideAction
      expect(mockDecideAction).not.toHaveBeenCalled();

      delete process.env.ANTHROPIC_API_KEY;
    });

    it('should consult LLM for new route when no active route', async () => {
      // Reset memory to default (no active route)
      mockGetMemory.mockReturnValue({
        turnNumber: 0,
        noProgressTurns: 0,
        consecutiveDiscards: 0,
        lastAction: null,
        activeRoute: null,
        turnsOnRoute: 0,
        routeHistory: [],
        currentBuildTarget: null,
        turnsOnTarget: 0,
        deliveryCount: 0,
        totalEarnings: 0,
        consecutiveLlmFailures: 0,
      });

      process.env.ANTHROPIC_API_KEY = 'test-key';

      const route: StrategicRoute = {
        stops: [
          { action: 'pickup', loadType: 'Coal', city: 'Berlin' },
        ],
        currentStopIndex: 0,
        phase: 'build',
        createdAtTurn: 5,
        reasoning: 'New route',
      };

      const snapshot = makeSnapshot({
        botConfig: { skillLevel: 'medium' },
      } as any);
      const context = makeContext();
      mockCapture.mockResolvedValue(snapshot);
      mockContextBuild.mockResolvedValue(context);

      // planRoute returns a new route
      mockPlanRoute.mockResolvedValue({
        route,
        model: 'claude-sonnet-4-20250514',
        latencyMs: 500,
        tokenUsage: { input: 100, output: 50 },
      });

      // PlanExecutor executes first step
      mockTurnExecutorPlannerExecute.mockResolvedValue(mockTurnExecResult({
        plan: { type: AIActionType.PassTurn },
        routeComplete: false,
        routeAbandoned: false,
        updatedRoute: route,
        description: 'Building toward Berlin',
      }));

      const result = await AIStrategyEngine.takeTurn('game-1', 'bot-1');

      expect(result.reasoning).toContain('route-planned');
      expect(mockPlanRoute).toHaveBeenCalled();

      delete process.env.ANTHROPIC_API_KEY;
    });

    it('should try heuristicFallback when route planning fails, PassTurn only if both fail', async () => {
      // Reset memory to default (no active route)
      mockGetMemory.mockReturnValue({
        turnNumber: 0,
        noProgressTurns: 0,
        consecutiveDiscards: 0,
        lastAction: null,
        activeRoute: null,
        turnsOnRoute: 0,
        routeHistory: [],
        currentBuildTarget: null,
        turnsOnTarget: 0,
        deliveryCount: 0,
        totalEarnings: 0,
        consecutiveLlmFailures: 0,
      });

      process.env.ANTHROPIC_API_KEY = 'test-key';

      const snapshot = makeSnapshot({
        botConfig: { skillLevel: 'medium' },
      } as any);
      const context = makeContext();
      mockCapture.mockResolvedValue(snapshot);
      mockContextBuild.mockResolvedValue(context);

      // planRoute returns null (failed)
      mockPlanRoute.mockResolvedValue({ route: null, llmLog: [] });

      // heuristicFallback also fails → PassTurn
      mockHeuristicFallback.mockResolvedValue({ success: false });

      const result = await AIStrategyEngine.takeTurn('game-1', 'bot-1');

      expect(result.action).toBe(AIActionType.PassTurn);
      expect(result.reasoning).toContain('llm-failed');
      expect(mockPlanRoute).toHaveBeenCalled();
      // heuristicFallback SHOULD have been called
      expect(mockHeuristicFallback).toHaveBeenCalledWith({ ...context, consecutiveLlmFailures: 0 }, snapshot, { llmFailed: true });

      delete process.env.ANTHROPIC_API_KEY;
    });

    it('JIRA-63: should propagate llmLog into heuristic fallback decision', async () => {
      mockGetMemory.mockReturnValue({
        turnNumber: 0,
        noProgressTurns: 0,
        consecutiveDiscards: 0,
        lastAction: null,
        activeRoute: null,
        turnsOnRoute: 0,
        routeHistory: [],
        currentBuildTarget: null,
        turnsOnTarget: 0,
        deliveryCount: 0,
        totalEarnings: 0,
        consecutiveLlmFailures: 0,
      });

      process.env.ANTHROPIC_API_KEY = 'test-key';

      const snapshot = makeSnapshot({
        botConfig: { skillLevel: 'medium' },
      } as any);
      const context = makeContext();
      mockCapture.mockResolvedValue(snapshot);
      mockContextBuild.mockResolvedValue(context);

      // planRoute fails but returns llmLog with attempt details
      const failedLlmLog = [
        { attemptNumber: 1, status: 'parse_error' as const, responseText: 'bad json', error: 'Invalid JSON', latencyMs: 150 },
        { attemptNumber: 2, status: 'api_error' as const, responseText: '', error: 'Rate limited', latencyMs: 200 },
      ];
      mockPlanRoute.mockResolvedValue({ route: null, llmLog: failedLlmLog });

      // heuristicFallback succeeds with a BuildTrack plan
      mockHeuristicFallback.mockResolvedValue({
        success: true,
        plan: { type: AIActionType.BuildTrack, segments: [], targetCity: 'Berlin' },
      });

      const result = await AIStrategyEngine.takeTurn('game-1', 'bot-1');

      expect(result.reasoning).toContain('heuristic-fallback');
      expect(result.llmLog).toEqual(failedLlmLog);
      expect(result.llmLog).toHaveLength(2);
      expect(result.llmLog![0].status).toBe('parse_error');
      expect(result.llmLog![1].status).toBe('api_error');

      delete process.env.ANTHROPIC_API_KEY;
    });
  });

  describe('auto-placement', () => {
    it('should auto-place bot when no position but has track', async () => {
      const { getMajorCityLookup } = require('../../../shared/services/majorCityGroups');
      const lookupMap = new Map();
      lookupMap.set('10,10', 'TestCity');
      (getMajorCityLookup as jest.Mock).mockReturnValue(lookupMap);

      const snapshot = makeSnapshot({
        position: null,
        existingSegments: [makeSegment(10, 10, 10, 11)],
      } as any);
      mockCapture.mockResolvedValue(snapshot);
      mockContextBuild.mockResolvedValue(makeContext());

      await AIStrategyEngine.takeTurn('game-1', 'bot-1');

      // Should have called UPDATE players SET position_row
      const positionUpdate = mockQuery.mock.calls.find(
        (call: any[]) => typeof call[0] === 'string' && call[0].includes('UPDATE players SET position_row'),
      );
      expect(positionUpdate).toBeDefined();
    });
  });

  describe('initial build — LLM route planning', () => {
    it('should use InitialBuildPlanner (not LLM planRoute) during initialBuild gameStatus', async () => {
      // JIRA-142b: InitialBuildPlanner replaces LLM for initial build.
      process.env.ANTHROPIC_API_KEY = 'test-key';

      const snapshot = makeSnapshot({
        botConfig: { skillLevel: 'medium' },
      } as any);
      snapshot.gameStatus = 'initialBuild';
      const context = makeContext({ isInitialBuild: true, canBuild: true });

      mockCapture.mockResolvedValue(snapshot);
      mockContextBuild.mockResolvedValue(context);

      const route: StrategicRoute = {
        stops: [{ action: 'pickup', loadType: 'Steel', city: 'Ruhr' }],
        currentStopIndex: 0,
        phase: 'build' as const,
        startingCity: 'Ruhr',
        reasoning: 'Quick first delivery from Ruhr',
        createdAtTurn: 3,
      };

      mockTurnExecutorPlannerExecute.mockResolvedValue(mockTurnExecResult({
        plan: { type: AIActionType.BuildTrack, segments: [makeSegment(10, 11, 10, 12)] },
        routeComplete: false,
        routeAbandoned: false,
        updatedRoute: route,
        description: 'Building toward Ruhr',
      }));

      const result = await AIStrategyEngine.takeTurn('game-1', 'bot-1');

      expect(result.action).toBe(AIActionType.BuildTrack);
      // InitialBuildPlanner uses 'initial-build-planner' model tag, not 'route-planned'
      expect(result.model).toBe('initial-build-planner');
      // planRoute is NOT called during initialBuild — InitialBuildPlanner is computed
      expect(mockPlanRoute).not.toHaveBeenCalled();

      delete process.env.ANTHROPIC_API_KEY;
    });
  });

  describe('LLM failure → heuristic fallback (BE-004)', () => {
    it('should use heuristicFallback BUILD when LLM planRoute returns null', async () => {
      process.env.ANTHROPIC_API_KEY = 'test-key';

      mockGetMemory.mockReturnValue({
        turnNumber: 5,
        noProgressTurns: 0,
        consecutiveDiscards: 0,
        lastAction: null,
        activeRoute: null,
        turnsOnRoute: 0,
        routeHistory: [],
        currentBuildTarget: null,
        turnsOnTarget: 0,
        deliveryCount: 0,
        totalEarnings: 0,
        consecutiveLlmFailures: 0,
      });

      const snapshot = makeSnapshot({
        botConfig: { skillLevel: 'medium' },
      } as any);
      const context = makeContext();
      mockCapture.mockResolvedValue(snapshot);
      mockContextBuild.mockResolvedValue(context);

      // LLM planRoute returns null (failure)
      mockPlanRoute.mockResolvedValue({ route: null, llmLog: [] });

      // heuristicFallback returns a BUILD plan
      const buildPlan = { type: AIActionType.BuildTrack as const, segments: [makeSegment(10, 10, 10, 11)], targetCity: 'Berlin' };
      mockHeuristicFallback.mockResolvedValue({ success: true, plan: buildPlan });

      const result = await AIStrategyEngine.takeTurn('game-1', 'bot-1');

      expect(result.action).toBe(AIActionType.BuildTrack);
      expect(result.reasoning).toContain('heuristic-fallback');
      expect(mockHeuristicFallback).toHaveBeenCalledWith({ ...context, consecutiveLlmFailures: 0 }, snapshot, { llmFailed: true });

      delete process.env.ANTHROPIC_API_KEY;
    });

    it('should PassTurn when both LLM and heuristicFallback fail', async () => {
      process.env.ANTHROPIC_API_KEY = 'test-key';

      mockGetMemory.mockReturnValue({
        turnNumber: 5,
        noProgressTurns: 0,
        consecutiveDiscards: 0,
        lastAction: null,
        activeRoute: null,
        turnsOnRoute: 0,
        routeHistory: [],
        currentBuildTarget: null,
        turnsOnTarget: 0,
        deliveryCount: 0,
        totalEarnings: 0,
        consecutiveLlmFailures: 0,
      });

      const snapshot = makeSnapshot({
        botConfig: { skillLevel: 'medium' },
      } as any);
      const context = makeContext();
      mockCapture.mockResolvedValue(snapshot);
      mockContextBuild.mockResolvedValue(context);

      // LLM planRoute returns null (failure)
      mockPlanRoute.mockResolvedValue({ route: null, llmLog: [] });

      // heuristicFallback also fails
      mockHeuristicFallback.mockResolvedValue({ success: false });

      const result = await AIStrategyEngine.takeTurn('game-1', 'bot-1');

      expect(result.action).toBe(AIActionType.PassTurn);
      expect(result.reasoning).toContain('llm-failed');
      expect(result.reasoning).toContain('heuristic fallback both failed');
      expect(mockHeuristicFallback).toHaveBeenCalledWith({ ...context, consecutiveLlmFailures: 0 }, snapshot, { llmFailed: true });

      delete process.env.ANTHROPIC_API_KEY;
    });

    it('should PassTurn when heuristicFallback returns PassTurn plan', async () => {
      process.env.ANTHROPIC_API_KEY = 'test-key';

      mockGetMemory.mockReturnValue({
        turnNumber: 5,
        noProgressTurns: 0,
        consecutiveDiscards: 0,
        lastAction: null,
        activeRoute: null,
        turnsOnRoute: 0,
        routeHistory: [],
        currentBuildTarget: null,
        turnsOnTarget: 0,
        deliveryCount: 0,
        totalEarnings: 0,
        consecutiveLlmFailures: 0,
      });

      const snapshot = makeSnapshot({
        botConfig: { skillLevel: 'medium' },
      } as any);
      const context = makeContext();
      mockCapture.mockResolvedValue(snapshot);
      mockContextBuild.mockResolvedValue(context);

      // LLM planRoute returns null
      mockPlanRoute.mockResolvedValue({ route: null, llmLog: [] });

      // heuristicFallback returns PassTurn (nothing useful to do)
      mockHeuristicFallback.mockResolvedValue({
        success: true,
        plan: { type: AIActionType.PassTurn },
      });

      const result = await AIStrategyEngine.takeTurn('game-1', 'bot-1');

      // Should still PassTurn since heuristic returned PassTurn
      expect(result.action).toBe(AIActionType.PassTurn);
      expect(result.reasoning).toContain('llm-failed');
      expect(mockHeuristicFallback).toHaveBeenCalled();

      delete process.env.ANTHROPIC_API_KEY;
    });
  });

  describe('delivery clears active route (BE-004/BE-006)', () => {
    it('should clear activeRoute when TurnExecutorPlanner produces a MultiAction with DeliverLoad', async () => {
      process.env.ANTHROPIC_API_KEY = 'test-key';

      (LLMStrategyBrain as any).mockImplementation(() => makeMockBrain());

      const route: StrategicRoute = {
        stops: [
          { action: 'pickup', loadType: 'Steel', city: 'Ruhr' },
          { action: 'deliver', loadType: 'Steel', city: 'Paris', demandCardId: 10, payment: 15 },
        ],
        currentStopIndex: 1,
        phase: 'travel' as const,
        reasoning: 'Deliver Steel to Paris',
        createdAtTurn: 3,
      };

      mockGetMemory.mockReturnValue({
        turnNumber: 7,
        noProgressTurns: 0,
        consecutiveDiscards: 0,
        lastAction: null,
        activeRoute: route,
        turnsOnRoute: 3,
        routeHistory: [],
        currentBuildTarget: null,
        turnsOnTarget: 0,
        deliveryCount: 0,
        totalEarnings: 0,
        consecutiveLlmFailures: 0,
      });

      const snapshot = makeSnapshot({
        botConfig: { skillLevel: 'medium' },
        loads: ['Steel'],
      } as any);
      const context = makeContext({ loads: ['Steel'] });
      mockCapture.mockResolvedValue(snapshot);
      mockContextBuild.mockResolvedValue(context);

      // TurnExecutorPlanner produces a MultiAction plan with Move + Deliver (Phase A)
      mockTurnExecutorPlannerExecute.mockResolvedValue({
        plans: [
          { type: AIActionType.MoveTrain, path: [{ row: 10, col: 10 }, { row: 10, col: 11 }], fees: new Set(), totalFee: 0 },
          { type: AIActionType.DeliverLoad, load: 'Steel', city: 'Paris', cardId: 10, payout: 15 },
        ],
        routeComplete: true,
        routeAbandoned: false,
        updatedRoute: route,
        compositionTrace: defaultCompositionTrace,
        hasDelivery: true,
      } as any);

      await AIStrategyEngine.takeTurn('game-1', 'bot-1');

      // Verify activeRoute was cleared (set to null) in memory update
      expect(mockUpdateMemory).toHaveBeenCalled();
      const patch = mockUpdateMemory.mock.calls[0][2] as any;
      // Route should be completed
      expect(patch.activeRoute).toBeNull();
      expect(patch.turnsOnRoute).toBe(0);

      delete process.env.ANTHROPIC_API_KEY;
    });

    it('should clear activeRoute for non-route deliveries too (force re-planning)', async () => {
      process.env.ANTHROPIC_API_KEY = 'test-key';

      (LLMStrategyBrain as any).mockImplementation(() => makeMockBrain());

      const route: StrategicRoute = {
        stops: [
          { action: 'pickup', loadType: 'Coal', city: 'Essen' },
          { action: 'deliver', loadType: 'Coal', city: 'Berlin', demandCardId: 5, payment: 20 },
        ],
        currentStopIndex: 0,
        phase: 'build' as const,
        reasoning: 'Deliver Coal to Berlin',
        createdAtTurn: 3,
      };

      mockGetMemory.mockReturnValue({
        turnNumber: 6,
        noProgressTurns: 0,
        consecutiveDiscards: 0,
        lastAction: null,
        activeRoute: route,
        turnsOnRoute: 2,
        routeHistory: [],
        currentBuildTarget: null,
        turnsOnTarget: 0,
        deliveryCount: 0,
        totalEarnings: 0,
        consecutiveLlmFailures: 0,
      });

      const snapshot = makeSnapshot({
        botConfig: { skillLevel: 'medium' },
        loads: ['Wine'],
      } as any);
      const context = makeContext({ loads: ['Wine'] });
      mockCapture.mockResolvedValue(snapshot);
      mockContextBuild.mockResolvedValue(context);

      // TurnExecutorPlanner returns BuildTrack + DeliverLoad (for a DIFFERENT load not on route)
      mockTurnExecutorPlannerExecute.mockResolvedValue({
        plans: [
          { type: AIActionType.BuildTrack, segments: [makeSegment(10, 10, 10, 11)] },
          { type: AIActionType.DeliverLoad, load: 'Wine', city: 'München', cardId: 99, payout: 12 },
        ],
        routeComplete: false,
        routeAbandoned: false,
        updatedRoute: route,
        compositionTrace: defaultCompositionTrace,
        hasDelivery: true,
      } as any);

      await AIStrategyEngine.takeTurn('game-1', 'bot-1');

      // Even though the delivery doesn't match the route stop, the route should
      // be cleared because a delivery means a new demand card was drawn
      expect(mockUpdateMemory).toHaveBeenCalled();
      const patch = mockUpdateMemory.mock.calls[0][2] as any;
      expect(patch.activeRoute).toBeNull();

      delete process.env.ANTHROPIC_API_KEY;
    });
  });

  describe('route completion continuation (BE-003)', () => {
    it('JIRA-97: should NOT chain BUILD from heuristicFallback after route completes (no validated route)', async () => {
      const route: StrategicRoute = {
        stops: [{ action: 'deliver', loadType: 'Coal', city: 'Berlin', demandCardId: 1, payment: 25 }],
        currentStopIndex: 0,
        phase: 'travel' as const,
        createdAtTurn: 3,
        reasoning: 'Deliver coal',
      };

      mockGetMemory.mockReturnValue({
        turnNumber: 4,
        noProgressTurns: 0,
        consecutiveDiscards: 0,
        lastAction: null,
        activeRoute: route,
        turnsOnRoute: 2,
        routeHistory: [],
        currentBuildTarget: null,
        turnsOnTarget: 0,
        deliveryCount: 0,
        totalEarnings: 0,
        consecutiveLlmFailures: 0,
      });

      const snapshot = makeSnapshot({
        botConfig: { skillLevel: 'medium' },
        loads: ['Coal'],
      } as any);
      const context = makeContext({ loads: ['Coal'] });
      mockCapture.mockResolvedValue(snapshot);
      mockContextBuild.mockResolvedValue(context);

      // PlanExecutor returns delivery + routeComplete
      mockTurnExecutorPlannerExecute.mockResolvedValue(mockTurnExecResult({
        plan: { type: AIActionType.DeliverLoad, load: 'Coal', city: 'Berlin', cardId: 1, payout: 25 },
        routeComplete: true,
        routeAbandoned: false,
        updatedRoute: route,
        description: 'Delivered Coal to Berlin',
      }));

      // heuristicFallback returns a BUILD action for continuation
      const buildPlan = { type: AIActionType.BuildTrack as const, segments: [makeSegment(10, 10, 10, 11)], targetCity: 'Paris' };
      mockHeuristicFallback.mockResolvedValue({ success: true, plan: buildPlan });

      await AIStrategyEngine.takeTurn('game-1', 'bot-1');

      // Should have called heuristicFallback for continuation
      expect(mockHeuristicFallback).toHaveBeenCalled();

      // Route should be cleared in memory (routeComplete)
      expect(mockUpdateMemory).toHaveBeenCalled();
      const patch = mockUpdateMemory.mock.calls[0][2] as any;
      expect(patch.activeRoute).toBeNull();
      expect(patch.routeHistory).toBeDefined();
      expect(patch.routeHistory[0].outcome).toBe('completed');
    });

    it('JIRA-97: should chain MOVE from heuristicFallback after route completes (non-build allowed)', async () => {
      const route: StrategicRoute = {
        stops: [{ action: 'deliver', loadType: 'Coal', city: 'Berlin', demandCardId: 1, payment: 25 }],
        currentStopIndex: 0,
        phase: 'travel' as const,
        createdAtTurn: 3,
        reasoning: 'Deliver coal',
      };

      mockGetMemory.mockReturnValue({
        turnNumber: 4,
        noProgressTurns: 0,
        consecutiveDiscards: 0,
        lastAction: null,
        activeRoute: route,
        turnsOnRoute: 2,
        routeHistory: [],
        currentBuildTarget: null,
        turnsOnTarget: 0,
        deliveryCount: 0,
        totalEarnings: 0,
        consecutiveLlmFailures: 0,
      });

      const snapshot = makeSnapshot({
        botConfig: { skillLevel: 'medium' },
        loads: ['Coal'],
      } as any);
      const context = makeContext({ loads: ['Coal'] });
      mockCapture.mockResolvedValue(snapshot);
      mockContextBuild.mockResolvedValue(context);

      // PlanExecutor returns delivery + routeComplete
      mockTurnExecutorPlannerExecute.mockResolvedValue(mockTurnExecResult({
        plan: { type: AIActionType.DeliverLoad, load: 'Coal', city: 'Berlin', cardId: 1, payout: 25 },
        routeComplete: true,
        routeAbandoned: false,
        updatedRoute: route,
        description: 'Delivered Coal to Berlin',
      }));

      // heuristicFallback returns a MOVE action for continuation
      const movePlan = { type: AIActionType.MoveTrain as const, path: [{ row: 10, col: 10 }, { row: 10, col: 11 }], fees: new Set<string>(), totalFee: 0 };
      mockHeuristicFallback.mockResolvedValue({ success: true, plan: movePlan });

      await AIStrategyEngine.takeTurn('game-1', 'bot-1');

      // Should have called heuristicFallback for continuation
      expect(mockHeuristicFallback).toHaveBeenCalled();
    });

    it('should not chain continuation when heuristicFallback fails', async () => {
      const route: StrategicRoute = {
        stops: [{ action: 'deliver', loadType: 'Coal', city: 'Berlin', demandCardId: 1, payment: 25 }],
        currentStopIndex: 0,
        phase: 'travel' as const,
        createdAtTurn: 3,
        reasoning: 'Deliver coal',
      };

      mockGetMemory.mockReturnValue({
        turnNumber: 4,
        noProgressTurns: 0,
        consecutiveDiscards: 0,
        lastAction: null,
        activeRoute: route,
        turnsOnRoute: 2,
        routeHistory: [],
        currentBuildTarget: null,
        turnsOnTarget: 0,
        deliveryCount: 0,
        totalEarnings: 0,
        consecutiveLlmFailures: 0,
      });

      const snapshot = makeSnapshot({
        botConfig: { skillLevel: 'medium' },
        loads: ['Coal'],
      } as any);
      const context = makeContext({ loads: ['Coal'] });
      mockCapture.mockResolvedValue(snapshot);
      mockContextBuild.mockResolvedValue(context);

      // PlanExecutor returns delivery + routeComplete
      mockTurnExecutorPlannerExecute.mockResolvedValue(mockTurnExecResult({
        plan: { type: AIActionType.DeliverLoad, load: 'Coal', city: 'Berlin', cardId: 1, payout: 25 },
        routeComplete: true,
        routeAbandoned: false,
        updatedRoute: route,
        description: 'Delivered Coal to Berlin',
      }));

      // heuristicFallback fails — no continuation
      mockHeuristicFallback.mockResolvedValue({ success: false });

      await AIStrategyEngine.takeTurn('game-1', 'bot-1');

      // heuristicFallback should have been called for continuation attempt
      expect(mockHeuristicFallback).toHaveBeenCalled();
      // Route should be cleared in memory (routeComplete)
      expect(mockUpdateMemory).toHaveBeenCalled();
      const patch = mockUpdateMemory.mock.calls[0][2] as any;
      expect(patch.activeRoute).toBeNull();
    });

    it('JIRA-99: should preserve replacement route in memory when TurnExecutorPlanner internally replanned', async () => {
      // JIRA-99: Stage 3d (post-delivery replan) is now internal to TurnExecutorPlanner.
      // When TurnExecutorPlanner returns routeComplete=false with updatedRoute=newRoute,
      // AIStrategyEngine should store the new route in memory.
      process.env.ANTHROPIC_API_KEY = 'test-key';

      const oldRoute: StrategicRoute = {
        stops: [{ action: 'deliver', loadType: 'Tourists', city: 'Torino', demandCardId: 1, payment: 19 }],
        currentStopIndex: 0,
        phase: 'travel' as const,
        createdAtTurn: 5,
        reasoning: 'Deliver tourists to Torino',
      };

      mockGetMemory.mockReturnValue({
        turnNumber: 8,
        noProgressTurns: 0,
        consecutiveDiscards: 0,
        lastAction: AIActionType.MoveTrain,
        activeRoute: oldRoute,
        turnsOnRoute: 3,
        routeHistory: [],
        currentBuildTarget: null,
        turnsOnTarget: 0,
        deliveryCount: 1,
        totalEarnings: 19,
        consecutiveLlmFailures: 0,
      });

      const snapshot = makeSnapshot({
        botConfig: { skillLevel: 'medium', provider: 'anthropic' },
        loads: ['Tourists'],
      } as any);
      const context = makeContext({ loads: ['Tourists'] });
      mockCapture.mockResolvedValue(snapshot);
      mockContextBuild.mockResolvedValue(context);

      // TurnExecutorPlanner internally performed delivery + replan.
      // Returns routeComplete=false with the new replacement route.
      const newRoute: StrategicRoute = {
        stops: [{ action: 'pickup', loadType: 'Steel', city: 'Ruhr' }],
        currentStopIndex: 0,
        phase: 'build' as const,
        createdAtTurn: 8,
        reasoning: 'Pick up steel from Ruhr',
      };
      mockTurnExecutorPlannerExecute.mockResolvedValue({
        plans: [{ type: AIActionType.DeliverLoad, load: 'Tourists', city: 'Torino', cardId: 1, payout: 19 }],
        routeComplete: false,  // new route active — NOT completed
        routeAbandoned: false,
        updatedRoute: newRoute,  // TurnExecutorPlanner replanned internally
        compositionTrace: defaultCompositionTrace,
        hasDelivery: true,
      } as any);

      // JIRA-64: After delivery, AIStrategyEngine rebuilds demands to check for stale route stops.
      // Mock rebuildDemands to include the new route's loadType so JIRA-64 doesn't invalidate it.
      (ContextBuilder.rebuildDemands as jest.Mock).mockReturnValue([
        {
          cardIndex: 0, loadType: 'Steel', supplyCity: 'Ruhr', deliveryCity: 'Berlin',
          payout: 20, isSupplyReachable: true, isDeliveryReachable: true,
          isSupplyOnNetwork: true, isDeliveryOnNetwork: true,
          estimatedTrackCostToSupply: 0, estimatedTrackCostToDelivery: 0,
          isLoadAvailable: true, isLoadOnTrain: false, ferryRequired: false,
          loadChipTotal: 2, loadChipCarried: 0, estimatedTurns: 2,
          demandScore: 8, efficiencyPerTurn: 4, networkCitiesUnlocked: 0, victoryMajorCitiesEnRoute: 0,
        },
      ] as any[]);
      // DeliverLoad in plans requires PlayerService.deliverLoadForUser to not throw
      (PlayerService.deliverLoadForUser as any).mockResolvedValue({
        payment: 19, updatedMoney: 69, newCard: { id: 50, demands: [] },
      });

      await AIStrategyEngine.takeTurn('game-1', 'bot-1');

      // JIRA-99: Memory should save the NEW replacement route returned by TurnExecutorPlanner
      expect(mockUpdateMemory).toHaveBeenCalled();
      const allPatches99 = mockUpdateMemory.mock.calls.map((c: any[]) => c[2]);
      const routePatch99 = allPatches99.find((p: any) => p.activeRoute !== undefined && p.activeRoute !== null);
      expect(routePatch99).toBeDefined();
      expect(routePatch99.activeRoute).toEqual(newRoute);

      delete process.env.ANTHROPIC_API_KEY;
    });

    it('should not call heuristicFallback continuation when route was abandoned', async () => {
      const route: StrategicRoute = {
        stops: [{ action: 'pickup', loadType: 'Coal', city: 'Berlin' }],
        currentStopIndex: 0,
        phase: 'build' as const,
        createdAtTurn: 3,
        reasoning: 'Pick up coal',
      };

      mockGetMemory.mockReturnValue({
        turnNumber: 4,
        noProgressTurns: 0,
        consecutiveDiscards: 0,
        lastAction: null,
        activeRoute: route,
        turnsOnRoute: 2,
        routeHistory: [],
        currentBuildTarget: null,
        turnsOnTarget: 0,
        deliveryCount: 0,
        totalEarnings: 0,
        consecutiveLlmFailures: 0,
      });

      const snapshot = makeSnapshot({
        botConfig: { skillLevel: 'medium' },
      } as any);
      const context = makeContext();
      mockCapture.mockResolvedValue(snapshot);
      mockContextBuild.mockResolvedValue(context);

      // PlanExecutor returns abandoned (not completed)
      mockTurnExecutorPlannerExecute.mockResolvedValue(mockTurnExecResult({
        plan: { type: AIActionType.PassTurn },
        routeComplete: false,
        routeAbandoned: true,
        updatedRoute: route,
        description: 'Route abandoned — cannot reach pickup',
      }));

      await AIStrategyEngine.takeTurn('game-1', 'bot-1');

      // routeWasCompleted is false, so continuation logic should NOT trigger
      // heuristicFallback might be called by post-guardrail safety, but not by continuation
      // Verify memory shows abandoned route, not completed route
      expect(mockUpdateMemory).toHaveBeenCalled();
      const patch = mockUpdateMemory.mock.calls[0][2] as any;
      expect(patch.activeRoute).toBeNull();
      expect(patch.routeHistory).toBeDefined();
      const lastEntry = patch.routeHistory[patch.routeHistory.length - 1];
      expect(lastEntry.outcome).toBe('abandoned');
    });

    it('JIRA-103: should store new route in memory when TurnExecutorPlanner replanned after delivery', async () => {
      // JIRA-103: Stage 3d (planRoute retry with budgetHint) is now internal to TurnExecutorPlanner.
      // AIStrategyEngine simply uses the updatedRoute returned by TurnExecutorPlanner.
      process.env.ANTHROPIC_API_KEY = 'test-key';

      const oldRoute: StrategicRoute = {
        stops: [{ action: 'deliver', loadType: 'Coal', city: 'Berlin', demandCardId: 1, payment: 25 }],
        currentStopIndex: 0,
        phase: 'travel' as const,
        createdAtTurn: 5,
        reasoning: 'Deliver coal to Berlin',
      };

      mockGetMemory.mockReturnValue({
        turnNumber: 6,
        noProgressTurns: 0,
        consecutiveDiscards: 0,
        lastAction: null,
        activeRoute: oldRoute,
        turnsOnRoute: 1,
        routeHistory: [],
        currentBuildTarget: null,
        turnsOnTarget: 0,
        deliveryCount: 0,
        totalEarnings: 0,
        consecutiveLlmFailures: 0,
      });

      const snapshot = makeSnapshot({
        botConfig: { skillLevel: 'medium' },
        loads: ['Coal'],
      } as any);
      const context = makeContext({ loads: ['Coal'] });
      mockCapture.mockResolvedValue(snapshot);
      mockContextBuild.mockResolvedValue(context);

      // TurnExecutorPlanner internally did delivery + planRoute retry, returning new route.
      const retryRoute: StrategicRoute = {
        stops: [{ action: 'pickup', loadType: 'Steel', city: 'Ruhr' }],
        currentStopIndex: 0,
        phase: 'build' as const,
        createdAtTurn: 6,
        reasoning: 'Pick up steel as cheap nearby option',
      };
      mockTurnExecutorPlannerExecute.mockResolvedValue({
        plans: [{ type: AIActionType.DeliverLoad, load: 'Coal', city: 'Berlin', cardId: 1, payout: 25 }],
        routeComplete: false,  // new route active after internal replan
        routeAbandoned: false,
        updatedRoute: retryRoute,
        compositionTrace: defaultCompositionTrace,
        hasDelivery: true,
      } as any);

      // JIRA-64: After delivery, AIStrategyEngine rebuilds demands to check for stale route stops.
      // Mock rebuildDemands to include the new route's loadType so JIRA-64 doesn't invalidate it.
      (ContextBuilder.rebuildDemands as jest.Mock).mockReturnValue([
        {
          cardIndex: 0, loadType: 'Steel', supplyCity: 'Ruhr', deliveryCity: 'Berlin',
          payout: 20, isSupplyReachable: true, isDeliveryReachable: true,
          isSupplyOnNetwork: true, isDeliveryOnNetwork: true,
          estimatedTrackCostToSupply: 0, estimatedTrackCostToDelivery: 0,
          isLoadAvailable: true, isLoadOnTrain: false, ferryRequired: false,
          loadChipTotal: 2, loadChipCarried: 0, estimatedTurns: 2,
          demandScore: 8, efficiencyPerTurn: 4, networkCitiesUnlocked: 0, victoryMajorCitiesEnRoute: 0,
        },
      ] as any[]);

      // DeliverLoad in plans requires PlayerService.deliverLoadForUser to not throw
      (PlayerService.deliverLoadForUser as any).mockResolvedValue({
        payment: 25, updatedMoney: 75, newCard: { id: 50, demands: [] },
      });

      await AIStrategyEngine.takeTurn('game-1', 'bot-1');

      // Memory should save the new route from TurnExecutorPlanner's internal replan
      expect(mockUpdateMemory).toHaveBeenCalled();
      const allPatches103 = mockUpdateMemory.mock.calls.map((c: any[]) => c[2]);
      const routePatch103 = allPatches103.find((p: any) => p.activeRoute !== undefined && p.activeRoute !== null);
      expect(routePatch103).toBeDefined();
      expect(routePatch103.activeRoute).toEqual(retryRoute);

      delete process.env.ANTHROPIC_API_KEY;
    });

    it('JIRA-103: should call heuristicFallback continuation when route completes with no internal replan', async () => {
      // When TurnExecutorPlanner returns routeComplete=true (no internal replan possible),
      // AIStrategyEngine calls heuristicFallback for continuation.
      process.env.ANTHROPIC_API_KEY = 'test-key';

      const oldRoute: StrategicRoute = {
        stops: [{ action: 'deliver', loadType: 'Coal', city: 'Berlin', demandCardId: 1, payment: 25 }],
        currentStopIndex: 0,
        phase: 'travel' as const,
        createdAtTurn: 5,
        reasoning: 'Deliver coal',
      };

      mockGetMemory.mockReturnValue({
        turnNumber: 6,
        noProgressTurns: 0,
        consecutiveDiscards: 0,
        lastAction: null,
        activeRoute: oldRoute,
        turnsOnRoute: 1,
        routeHistory: [],
        currentBuildTarget: null,
        turnsOnTarget: 0,
        deliveryCount: 0,
        totalEarnings: 0,
        consecutiveLlmFailures: 0,
      });

      const snapshot = makeSnapshot({
        botConfig: { skillLevel: 'medium' },
        loads: ['Coal'],
      } as any);
      const context = makeContext({ loads: ['Coal'] });
      mockCapture.mockResolvedValue(snapshot);
      mockContextBuild.mockResolvedValue(context);

      // TurnExecutorPlanner completed the route, no internal replan
      mockTurnExecutorPlannerExecute.mockResolvedValue(mockTurnExecResult({
        plan: { type: AIActionType.DeliverLoad, load: 'Coal', city: 'Berlin', cardId: 1, payout: 25 },
        routeComplete: true,
        routeAbandoned: false,
        updatedRoute: oldRoute,
        description: 'Delivered Coal to Berlin',
      }));

      const movePlan = { type: AIActionType.MoveTrain as const, path: [{ row: 10, col: 10 }, { row: 10, col: 11 }], fees: new Set<string>(), totalFee: 0 };
      mockHeuristicFallback.mockResolvedValue({ success: true, plan: movePlan });

      await AIStrategyEngine.takeTurn('game-1', 'bot-1');

      // heuristicFallback should have been called for continuation
      expect(mockHeuristicFallback).toHaveBeenCalled();

      delete process.env.ANTHROPIC_API_KEY;
    });

    it('JIRA-103: should NOT retry planRoute when route was abandoned (not completed)', async () => {
      process.env.ANTHROPIC_API_KEY = 'test-key';

      const route: StrategicRoute = {
        stops: [{ action: 'pickup', loadType: 'Coal', city: 'Berlin' }],
        currentStopIndex: 0,
        phase: 'build' as const,
        createdAtTurn: 3,
        reasoning: 'Pick up coal',
      };

      mockGetMemory.mockReturnValue({
        turnNumber: 4,
        noProgressTurns: 0,
        consecutiveDiscards: 0,
        lastAction: null,
        activeRoute: route,
        turnsOnRoute: 2,
        routeHistory: [],
        currentBuildTarget: null,
        turnsOnTarget: 0,
        deliveryCount: 0,
        totalEarnings: 0,
        consecutiveLlmFailures: 0,
      });

      const snapshot = makeSnapshot({
        botConfig: { skillLevel: 'medium' },
      } as any);
      const context = makeContext();
      mockCapture.mockResolvedValue(snapshot);
      mockContextBuild.mockResolvedValue(context);

      // Route abandoned, not completed
      mockTurnExecutorPlannerExecute.mockResolvedValue(mockTurnExecResult({
        plan: { type: AIActionType.PassTurn },
        routeComplete: false,
        routeAbandoned: true,
        updatedRoute: route,
        description: 'Route abandoned',
      }));

      // planRoute mock — should only be called if code incorrectly retries
      const mockPlanRouteFn = jest.fn<(...args: any[]) => Promise<any>>()
        .mockResolvedValue({ route: null, llmLog: [] });
      (LLMStrategyBrain as any).mockImplementation(() => makeMockBrain({ planRoute: mockPlanRouteFn }));

      await AIStrategyEngine.takeTurn('game-1', 'bot-1');

      // planRoute should NOT have been called (abandoned, not completed)
      expect(mockPlanRouteFn).not.toHaveBeenCalled();

      delete process.env.ANTHROPIC_API_KEY;
    });
  });

  describe('JIRA-19: LLM metadata in BotTurnResult', () => {
    it('should populate model/latency/tokenUsage/retried from LLM route planning', async () => {
      process.env.ANTHROPIC_API_KEY = 'test-key';

      mockGetMemory.mockReturnValue({
        turnNumber: 0,
        noProgressTurns: 0,
        consecutiveDiscards: 0,
        lastAction: null,
        activeRoute: null,
        turnsOnRoute: 0,
        routeHistory: [],
        currentBuildTarget: null,
        turnsOnTarget: 0,
        deliveryCount: 0,
        totalEarnings: 0,
        consecutiveLlmFailures: 0,
      });

      const snapshot = makeSnapshot({
        botConfig: { skillLevel: 'medium' },
      } as any);
      const context = makeContext();
      mockCapture.mockResolvedValue(snapshot);
      mockContextBuild.mockResolvedValue(context);

      const route: StrategicRoute = {
        stops: [{ action: 'pickup', loadType: 'Steel', city: 'Berlin' }],
        currentStopIndex: 0,
        phase: 'build' as const,
        reasoning: 'Build toward Berlin',
        createdAtTurn: 5,
      };
      mockPlanRoute.mockResolvedValue({
        route,
        model: 'claude-sonnet-4-20250514',
        latencyMs: 750,
        tokenUsage: { input: 200, output: 80 },
      });

      mockTurnExecutorPlannerExecute.mockResolvedValue(mockTurnExecResult({
        plan: { type: AIActionType.BuildTrack, segments: [makeSegment(10, 10, 10, 11)] },
        routeComplete: false,
        routeAbandoned: false,
        updatedRoute: route,
        description: 'Building toward Berlin',
      }));

      const result = await AIStrategyEngine.takeTurn('game-1', 'bot-1');

      // TripPlanner wraps LLM calls; model is 'trip-planner' at the AIStrategyEngine level.
      // The underlying LLM model is captured inside TripPlanner's result but not surfaced here.
      expect(result.model).toBe('trip-planner');
      expect(result.llmLatencyMs).toBe(750);
      expect(result.tokenUsage).toEqual({ input: 200, output: 80 });
      expect(result.retried).toBe(false);

      delete process.env.ANTHROPIC_API_KEY;
    });

    it('should set model="route-executor" and llmLatencyMs=0 for active route path', async () => {
      const route: StrategicRoute = {
        stops: [{ action: 'pickup', loadType: 'Coal', city: 'Berlin' }],
        currentStopIndex: 0,
        phase: 'build' as const,
        createdAtTurn: 3,
        reasoning: 'Test route',
      };

      mockGetMemory.mockReturnValue({
        turnNumber: 4,
        noProgressTurns: 0,
        consecutiveDiscards: 0,
        lastAction: null,
        activeRoute: route,
        turnsOnRoute: 1,
        routeHistory: [],
        currentBuildTarget: null,
        turnsOnTarget: 0,
        deliveryCount: 0,
        totalEarnings: 0,
        consecutiveLlmFailures: 0,
      });

      const snapshot = makeSnapshot({
        botConfig: { skillLevel: 'medium' },
      } as any);
      const context = makeContext();
      mockCapture.mockResolvedValue(snapshot);
      mockContextBuild.mockResolvedValue(context);

      mockTurnExecutorPlannerExecute.mockResolvedValue(mockTurnExecResult({
        plan: { type: AIActionType.BuildTrack, segments: [makeSegment(10, 10, 10, 11)] },
        routeComplete: false,
        routeAbandoned: false,
        updatedRoute: route,
        description: 'Building toward Berlin',
      }));

      const result = await AIStrategyEngine.takeTurn('game-1', 'bot-1');

      expect(result.model).toBe('route-executor');
      expect(result.llmLatencyMs).toBe(0);
      expect(result.tokenUsage).toBeUndefined();
      expect(result.retried).toBe(false);
    });

    it('should set model="no-api-key" when no LLM API key configured', async () => {
      delete process.env.ANTHROPIC_API_KEY;
      delete process.env.GOOGLE_AI_API_KEY;

      mockGetMemory.mockReturnValue({
        turnNumber: 0,
        noProgressTurns: 0,
        consecutiveDiscards: 0,
        lastAction: null,
        activeRoute: null,
        turnsOnRoute: 0,
        routeHistory: [],
        currentBuildTarget: null,
        turnsOnTarget: 0,
        deliveryCount: 0,
        totalEarnings: 0,
        consecutiveLlmFailures: 0,
      });

      const snapshot = makeSnapshot({ botConfig: null } as any);
      const context = makeContext();
      mockCapture.mockResolvedValue(snapshot);
      mockContextBuild.mockResolvedValue(context);

      const result = await AIStrategyEngine.takeTurn('game-1', 'bot-1');

      expect(result.model).toBe('no-api-key');
      expect(result.llmLatencyMs).toBe(0);
      expect(result.tokenUsage).toBeUndefined();
      expect(result.retried).toBe(false);
    });

    it('should set model="heuristic-fallback" when LLM fails and heuristic succeeds', async () => {
      process.env.ANTHROPIC_API_KEY = 'test-key';

      mockGetMemory.mockReturnValue({
        turnNumber: 5,
        noProgressTurns: 0,
        consecutiveDiscards: 0,
        lastAction: null,
        activeRoute: null,
        turnsOnRoute: 0,
        routeHistory: [],
        currentBuildTarget: null,
        turnsOnTarget: 0,
        deliveryCount: 0,
        totalEarnings: 0,
        consecutiveLlmFailures: 0,
      });

      const snapshot = makeSnapshot({
        botConfig: { skillLevel: 'medium' },
      } as any);
      const context = makeContext();
      mockCapture.mockResolvedValue(snapshot);
      mockContextBuild.mockResolvedValue(context);

      mockPlanRoute.mockResolvedValue({ route: null, llmLog: [] });
      mockHeuristicFallback.mockResolvedValue({
        success: true,
        plan: { type: AIActionType.BuildTrack, segments: [makeSegment(10, 10, 10, 11)], targetCity: 'Berlin' },
      });

      const result = await AIStrategyEngine.takeTurn('game-1', 'bot-1');

      expect(result.model).toBe('heuristic-fallback');
      expect(result.llmLatencyMs).toBe(0);
      expect(result.tokenUsage).toBeUndefined();
      expect(result.retried).toBe(false);

      delete process.env.ANTHROPIC_API_KEY;
    });

    it('should set model="pipeline-error" when pipeline throws', async () => {
      mockCapture.mockRejectedValue(new Error('DB failure'));

      const result = await AIStrategyEngine.takeTurn('game-1', 'bot-1');

      expect(result.model).toBe('pipeline-error');
      expect(result.llmLatencyMs).toBe(0);
      expect(result.tokenUsage).toBeUndefined();
      expect(result.retried).toBe(false);
    });
  });

  describe('BE-009: pipeline error audit records', () => {
    beforeEach(() => {
      // Reset getMemory to default since other tests may set mockReturnValue
      mockGetMemory.mockReturnValue({
        turnNumber: 0,
        noProgressTurns: 0,
        consecutiveDiscards: 0,
        lastAction: null,
        activeRoute: null,
        turnsOnRoute: 0,
        routeHistory: [],
      } as any);
    });

    it('should insert bot_turn_audits record when pipeline throws', async () => {
      mockCapture.mockRejectedValue(new Error('Snapshot capture failed'));
      mockQuery.mockResolvedValue({ rows: [] });

      await AIStrategyEngine.takeTurn('game-1', 'bot-1');

      const auditCall = mockQuery.mock.calls.find(
        (call: any[]) => typeof call[0] === 'string' && call[0].includes('bot_turn_audits'),
      );
      expect(auditCall).toBeDefined();
      expect(auditCall![0]).toContain('INSERT INTO bot_turn_audits');
      // Verify params: game_id, player_id, turn_number, action, cost, remaining_money, duration_ms, details
      const params = auditCall![1] as any[];
      expect(params[0]).toBe('game-1');     // game_id
      expect(params[1]).toBe('bot-1');      // player_id
      expect(params[2]).toBe(1);            // turn_number (memory.turnNumber=0 + 1)
      expect(params[3]).toBe('PassTurn');   // action
      expect(params[4]).toBe(0);            // cost
      // Verify details JSON contains error info
      const details = JSON.parse(params[7]);
      expect(details.source).toBe('pipeline-error');
      expect(details.error).toBe('Snapshot capture failed');
      expect(details.stack).toBeDefined();
    });

    it('should not crash when audit INSERT itself fails', async () => {
      mockCapture.mockRejectedValue(new Error('Pipeline boom'));
      mockQuery.mockRejectedValue(new Error('bot_turn_audits does not exist'));

      const result = await AIStrategyEngine.takeTurn('game-1', 'bot-1');

      // Pipeline error is returned normally — audit failure is swallowed
      expect(result.action).toBe('PassTurn');
      expect(result.error).toBe('Pipeline boom');
      expect(result.model).toBe('pipeline-error');
    });

    it('should include stack trace in audit details', async () => {
      mockCapture.mockRejectedValue(new Error('Stack trace test'));
      mockQuery.mockResolvedValue({ rows: [] });

      await AIStrategyEngine.takeTurn('game-1', 'bot-1');

      const auditCall = mockQuery.mock.calls.find(
        (call: any[]) => typeof call[0] === 'string' && call[0].includes('bot_turn_audits'),
      );
      expect(auditCall).toBeDefined();
      const details = JSON.parse((auditCall![1] as any[])[7]);
      expect(details.stack).toContain('Stack trace test');
      expect(details.stack).toContain('Error');
    });

    it('should handle non-Error objects in audit details', async () => {
      mockCapture.mockRejectedValue('string error');
      mockQuery.mockResolvedValue({ rows: [] });

      await AIStrategyEngine.takeTurn('game-1', 'bot-1');

      const auditCall = mockQuery.mock.calls.find(
        (call: any[]) => typeof call[0] === 'string' && call[0].includes('bot_turn_audits'),
      );
      expect(auditCall).toBeDefined();
      const details = JSON.parse((auditCall![1] as any[])[7]);
      expect(details.source).toBe('pipeline-error');
      expect(details.error).toBe('string error');
      expect(details.stack).toBeUndefined();
    });
  });

  describe('BE-010: preserve remaining route context after delivery', () => {
    beforeEach(() => {
      mockGetMemory.mockReturnValue({
        turnNumber: 0,
        noProgressTurns: 0,
        consecutiveDiscards: 0,
        lastAction: null,
        activeRoute: null,
        turnsOnRoute: 0,
        routeHistory: [],
        currentBuildTarget: null,
        turnsOnTarget: 0,
        deliveryCount: 0,
        totalEarnings: 0,
      } as any);
    });

    it('should store remaining route stops in memory when delivery clears active route', async () => {
      process.env.ANTHROPIC_API_KEY = 'test-key';

      (LLMStrategyBrain as any).mockImplementation(() => makeMockBrain());

      const route: StrategicRoute = {
        stops: [
          { action: 'pickup', loadType: 'Coal', city: 'Essen' },
          { action: 'deliver', loadType: 'Coal', city: 'Berlin', demandCardId: 5, payment: 20 },
          { action: 'pickup', loadType: 'Steel', city: 'Ruhr' },
          { action: 'deliver', loadType: 'Steel', city: 'Paris', demandCardId: 10, payment: 15 },
        ],
        currentStopIndex: 1, // Working on delivering Coal to Berlin
        phase: 'travel' as const,
        reasoning: 'Multi-stop route',
        createdAtTurn: 3,
      };

      mockGetMemory.mockReturnValue({
        turnNumber: 7,
        noProgressTurns: 0,
        consecutiveDiscards: 0,
        lastAction: null,
        activeRoute: route,
        turnsOnRoute: 3,
        routeHistory: [],
        currentBuildTarget: null,
        turnsOnTarget: 0,
        deliveryCount: 0,
        totalEarnings: 0,
      } as any);

      const snapshot = makeSnapshot({
        botConfig: { skillLevel: 'medium' },
        loads: ['Coal'],
      } as any);
      const context = makeContext({ loads: ['Coal'] });
      mockCapture.mockResolvedValue(snapshot);
      mockContextBuild.mockResolvedValue(context);

      // TurnExecutorPlanner produces Move + non-route DeliverLoad (opportunistic delivery)
      mockTurnExecutorPlannerExecute.mockResolvedValue({
        plans: [
          { type: AIActionType.MoveTrain, path: [{ row: 10, col: 10 }, { row: 10, col: 11 }], fees: new Set(), totalFee: 0 },
          { type: AIActionType.DeliverLoad, load: 'Wine', city: 'München', cardId: 99, payout: 12 },
        ],
        routeComplete: false,
        routeAbandoned: false,
        updatedRoute: route,
        compositionTrace: defaultCompositionTrace,
        hasDelivery: true,
      } as any);

      await AIStrategyEngine.takeTurn('game-1', 'bot-1');

      expect(mockUpdateMemory).toHaveBeenCalled();
      const patch = mockUpdateMemory.mock.calls[0][2] as any;
      // activeRoute should be cleared
      expect(patch.activeRoute).toBeNull();
      // previousRouteStops should contain remaining stops from currentStopIndex onward
      expect(patch.previousRouteStops).toBeDefined();
      expect(patch.previousRouteStops).toHaveLength(3); // stops 1, 2, 3 (from index 1)
      expect(patch.previousRouteStops[0]).toEqual(expect.objectContaining({ action: 'deliver', loadType: 'Coal', city: 'Berlin' }));
      expect(patch.previousRouteStops[1]).toEqual(expect.objectContaining({ action: 'pickup', loadType: 'Steel', city: 'Ruhr' }));
      expect(patch.previousRouteStops[2]).toEqual(expect.objectContaining({ action: 'deliver', loadType: 'Steel', city: 'Paris' }));

      delete process.env.ANTHROPIC_API_KEY;
    });

    it('should pass previousRouteStops from memory to planRoute on next turn', async () => {
      process.env.ANTHROPIC_API_KEY = 'test-key';

      const previousStops = [
        { action: 'pickup' as const, loadType: 'Steel', city: 'Ruhr' },
        { action: 'deliver' as const, loadType: 'Steel', city: 'Paris', demandCardId: 10, payment: 15 },
      ];

      mockGetMemory.mockReturnValue({
        turnNumber: 8,
        noProgressTurns: 0,
        consecutiveDiscards: 0,
        lastAction: null,
        activeRoute: null, // No active route — will consult LLM
        turnsOnRoute: 0,
        routeHistory: [],
        currentBuildTarget: null,
        turnsOnTarget: 0,
        deliveryCount: 1,
        totalEarnings: 20,
        previousRouteStops: previousStops,
        lastAbandonedRouteKey: null,
      } as any);

      const snapshot = makeSnapshot({
        botConfig: { skillLevel: 'medium' },
      } as any);
      const context = makeContext();
      mockCapture.mockResolvedValue(snapshot);
      mockContextBuild.mockResolvedValue(context);

      // LLM plans a new route
      mockPlanRoute.mockResolvedValue({
        route: {
          stops: [{ action: 'pickup', loadType: 'Oil', city: 'Baku' }],
          currentStopIndex: 0,
          phase: 'build',
          reasoning: 'New plan',
          createdAtTurn: 8,
        },
        model: 'test-model',
        latencyMs: 100,
      });

      // PlanExecutor runs the first step
      mockTurnExecutorPlannerExecute.mockResolvedValue(mockTurnExecResult({
        plan: { type: AIActionType.BuildTrack, segments: [makeSegment(10, 10, 10, 11)] },
        routeComplete: false,
        routeAbandoned: false,
        updatedRoute: {
          stops: [{ action: 'pickup', loadType: 'Oil', city: 'Baku' }],
          currentStopIndex: 0,
          phase: 'build',
          reasoning: 'New plan',
          createdAtTurn: 8,
        },
        description: 'Building toward Baku',
      }));

      await AIStrategyEngine.takeTurn('game-1', 'bot-1');

      // Verify planRoute was called with previousRouteStops
      expect(mockPlanRoute).toHaveBeenCalledWith(
        expect.anything(), // snapshot
        expect.anything(), // context
        expect.anything(), // gridPoints
        null,              // lastAbandonedRouteKey
        previousStops,     // previousRouteStops (BE-010)
      );

      // With a new active route, previousRouteStops should be cleared
      expect(mockUpdateMemory).toHaveBeenCalled();
      const patch = mockUpdateMemory.mock.calls[0][2] as any;
      expect(patch.previousRouteStops).toBeNull();

      delete process.env.ANTHROPIC_API_KEY;
    });

    it('should not set previousRouteStops when route is completed (all stops done)', async () => {
      process.env.ANTHROPIC_API_KEY = 'test-key';

      const route: StrategicRoute = {
        stops: [
          { action: 'deliver', loadType: 'Coal', city: 'Berlin', demandCardId: 1, payment: 25 },
        ],
        currentStopIndex: 0,
        phase: 'travel' as const,
        reasoning: 'Single delivery',
        createdAtTurn: 5,
      };

      mockGetMemory.mockReturnValue({
        turnNumber: 6,
        noProgressTurns: 0,
        consecutiveDiscards: 0,
        lastAction: null,
        activeRoute: route,
        turnsOnRoute: 1,
        routeHistory: [],
        currentBuildTarget: null,
        turnsOnTarget: 0,
        deliveryCount: 0,
        totalEarnings: 0,
      } as any);

      const snapshot = makeSnapshot({
        botConfig: { skillLevel: 'medium' },
        loads: ['Coal'],
      } as any);
      const context = makeContext({ loads: ['Coal'] });
      mockCapture.mockResolvedValue(snapshot);
      mockContextBuild.mockResolvedValue(context);

      // PlanExecutor returns route complete
      mockTurnExecutorPlannerExecute.mockResolvedValue(mockTurnExecResult({
        plan: { type: AIActionType.DeliverLoad, load: 'Coal', city: 'Berlin', cardId: 1, payout: 25 },
        routeComplete: true,
        routeAbandoned: false,
        updatedRoute: route,
        description: 'Delivered Coal to Berlin',
      }));

      mockHeuristicFallback.mockResolvedValue({ success: false, error: 'no options' });

      await AIStrategyEngine.takeTurn('game-1', 'bot-1');

      const patch = mockUpdateMemory.mock.calls[0][2] as any;
      // Route was completed — previousRouteStops should be null (no remaining stops to pass)
      expect(patch.previousRouteStops).toBeNull();
      // Route should be logged as completed
      expect(patch.routeHistory).toBeDefined();
      expect(patch.routeHistory[0]?.outcome).toBe('completed');

      delete process.env.ANTHROPIC_API_KEY;
    });

    it('should handle null previousRouteStops in memory gracefully', async () => {
      process.env.ANTHROPIC_API_KEY = 'test-key';

      mockGetMemory.mockReturnValue({
        turnNumber: 10,
        noProgressTurns: 0,
        consecutiveDiscards: 0,
        lastAction: null,
        activeRoute: null,
        turnsOnRoute: 0,
        routeHistory: [],
        currentBuildTarget: null,
        turnsOnTarget: 0,
        deliveryCount: 2,
        totalEarnings: 40,
        previousRouteStops: null,
        lastAbandonedRouteKey: null,
      } as any);

      const snapshot = makeSnapshot({
        botConfig: { skillLevel: 'medium' },
      } as any);
      const context = makeContext();
      mockCapture.mockResolvedValue(snapshot);
      mockContextBuild.mockResolvedValue(context);

      mockPlanRoute.mockResolvedValue({ route: null, llmLog: [] });
      mockHeuristicFallback.mockResolvedValue({
        success: true,
        plan: { type: AIActionType.PassTurn },
      });

      await AIStrategyEngine.takeTurn('game-1', 'bot-1');

      // planRoute should still be called with null previousRouteStops
      expect(mockPlanRoute).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        expect.anything(),
        null,
        null,
      );

      delete process.env.ANTHROPIC_API_KEY;
    });
  });

  describe('JIRA-31: llmLog threading in BotTurnResult', () => {
    it('should thread llmLog from planRoute into BotTurnResult', async () => {
      process.env.ANTHROPIC_API_KEY = 'test-key';

      mockGetMemory.mockReturnValue({
        turnNumber: 0,
        noProgressTurns: 0,
        consecutiveDiscards: 0,
        lastAction: null,
        activeRoute: null,
        turnsOnRoute: 0,
        routeHistory: [],
        currentBuildTarget: null,
        turnsOnTarget: 0,
        deliveryCount: 0,
        totalEarnings: 0,
        consecutiveLlmFailures: 0,
      });

      const snapshot = makeSnapshot({
        botConfig: { skillLevel: 'medium' },
      } as any);
      const context = makeContext();
      mockCapture.mockResolvedValue(snapshot);
      mockContextBuild.mockResolvedValue(context);

      const route: StrategicRoute = {
        stops: [{ action: 'pickup', loadType: 'Steel', city: 'Berlin' }],
        currentStopIndex: 0,
        phase: 'build' as const,
        reasoning: 'Build toward Berlin',
        createdAtTurn: 5,
      };
      const mockLlmLog = [
        { attemptNumber: 1, status: 'validation_error' as const, responseText: 'bad route', error: 'Route infeasible', latencyMs: 200 },
        { attemptNumber: 2, status: 'success' as const, responseText: '{"stops":[...]}', latencyMs: 350 },
      ];
      mockPlanRoute.mockResolvedValue({
        route,
        model: 'claude-sonnet-4-20250514',
        latencyMs: 550,
        tokenUsage: { input: 200, output: 80 },
        llmLog: mockLlmLog,
      });

      mockTurnExecutorPlannerExecute.mockResolvedValue(mockTurnExecResult({
        plan: { type: AIActionType.BuildTrack, segments: [makeSegment(10, 10, 10, 11)] },
        routeComplete: false,
        routeAbandoned: false,
        updatedRoute: route,
        description: 'Building toward Berlin',
      }));

      const result = await AIStrategyEngine.takeTurn('game-1', 'bot-1');

      expect(result.llmLog).toBeDefined();
      expect(result.llmLog).toHaveLength(2);
      expect(result.llmLog![0].status).toBe('validation_error');
      expect(result.llmLog![0].error).toBe('Route infeasible');
      expect(result.llmLog![1].status).toBe('success');

      delete process.env.ANTHROPIC_API_KEY;
    });

    it('should thread llmLog from decideAction into BotTurnResult', async () => {
      process.env.ANTHROPIC_API_KEY = 'test-key';

      const route: StrategicRoute = {
        stops: [{ action: 'pickup', loadType: 'Coal', city: 'Berlin' }],
        currentStopIndex: 0,
        phase: 'travel' as const,
        createdAtTurn: 3,
        reasoning: 'Test route',
      };

      mockGetMemory.mockReturnValue({
        turnNumber: 4,
        noProgressTurns: 0,
        consecutiveDiscards: 0,
        lastAction: null,
        activeRoute: route,
        turnsOnRoute: 1,
        routeHistory: [],
        currentBuildTarget: null,
        turnsOnTarget: 0,
        deliveryCount: 0,
        totalEarnings: 0,
        consecutiveLlmFailures: 0,
      });

      const snapshot = makeSnapshot({
        botConfig: { skillLevel: 'medium' },
      } as any);
      const context = makeContext();
      mockCapture.mockResolvedValue(snapshot);
      mockContextBuild.mockResolvedValue(context);

      mockTurnExecutorPlannerExecute.mockResolvedValue(mockTurnExecResult({
        plan: { type: AIActionType.MoveTrain, path: [{ row: 10, col: 11 }], fees: new Set<string>(), totalFee: 0 },
        routeComplete: false,
        routeAbandoned: false,
        updatedRoute: route,
        description: 'Moving toward Berlin',
      }));

      const result = await AIStrategyEngine.takeTurn('game-1', 'bot-1');

      // Active route path doesn't call LLM, so llmLog should be undefined
      expect(result.llmLog).toBeUndefined();

      delete process.env.ANTHROPIC_API_KEY;
    });

    it('should have no llmLog when no API key configured', async () => {
      delete process.env.ANTHROPIC_API_KEY;
      delete process.env.GOOGLE_AI_API_KEY;

      mockGetMemory.mockReturnValue({
        turnNumber: 0,
        noProgressTurns: 0,
        consecutiveDiscards: 0,
        lastAction: null,
        activeRoute: null,
        turnsOnRoute: 0,
        routeHistory: [],
        currentBuildTarget: null,
        turnsOnTarget: 0,
        deliveryCount: 0,
        totalEarnings: 0,
        consecutiveLlmFailures: 0,
      });

      const snapshot = makeSnapshot({ botConfig: null } as any);
      const context = makeContext();
      mockCapture.mockResolvedValue(snapshot);
      mockContextBuild.mockResolvedValue(context);

      const result = await AIStrategyEngine.takeTurn('game-1', 'bot-1');

      expect(result.llmLog).toBeUndefined();
    });
  });

  describe('JIRA-61: route invalidation after DiscardHand', () => {
    it('should clear activeRoute when discard removes demand cards referenced by route', async () => {
      // Bot has an active route: pickup Flowers at Holland → deliver to Wien
      const route: StrategicRoute = {
        stops: [
          { action: 'pickup', loadType: 'Flowers', city: 'Holland' },
          { action: 'deliver', loadType: 'Flowers', city: 'Wien', demandCardId: 5, payment: 18 },
        ],
        currentStopIndex: 0,
        phase: 'travel' as const,
        createdAtTurn: 29,
        reasoning: 'test',
      };

      mockGetMemory.mockReturnValue({
        turnNumber: 31,
        noProgressTurns: 0,
        consecutiveDiscards: 0,
        lastAction: AIActionType.MoveTrain,
        activeRoute: route,
        turnsOnRoute: 2,
        routeHistory: [],
        deliveryCount: 0,
        totalEarnings: 0,
        currentBuildTarget: null,
        turnsOnTarget: 0,
        consecutiveLlmFailures: 0,
      });

      const snapshot = makeSnapshot({ botConfig: null } as any);
      const context = makeContext({
        demands: [
          {
            cardIndex: 0, loadType: 'Flowers', supplyCity: 'Holland', deliveryCity: 'Wien',
            payout: 18, isSupplyReachable: false, isDeliveryReachable: false,
            isSupplyOnNetwork: true, isDeliveryOnNetwork: false,
            estimatedTrackCostToSupply: 0, estimatedTrackCostToDelivery: 10,
            isLoadAvailable: true, isLoadOnTrain: false, ferryRequired: false,
            loadChipTotal: 4, loadChipCarried: 0, estimatedTurns: 5,
            demandScore: 5, efficiencyPerTurn: 1, networkCitiesUnlocked: 0, victoryMajorCitiesEnRoute: 0,
          },
        ] as any[],
      });
      mockCapture.mockResolvedValue(snapshot);
      mockContextBuild.mockResolvedValue(context);

      // PlanExecutor returns DiscardHand (heuristic fallback or guardrail)
      mockTurnExecutorPlannerExecute.mockResolvedValue(mockTurnExecResult({
        plan: { type: AIActionType.DiscardHand },
        routeComplete: false,
        routeAbandoned: false,
        updatedRoute: route,
        description: 'Discarding hand',
      }));

      // After discard, rebuildDemands returns NEW demands WITHOUT Flowers
      const mockRebuildDemands = ContextBuilder.rebuildDemands as jest.Mock;
      mockRebuildDemands.mockReturnValue([
        {
          cardIndex: 0, loadType: 'Sheep', supplyCity: 'Bilbao', deliveryCity: 'Stuttgart',
          payout: 30, isSupplyReachable: false, isDeliveryReachable: false,
          isSupplyOnNetwork: false, isDeliveryOnNetwork: true,
          estimatedTrackCostToSupply: 15, estimatedTrackCostToDelivery: 0,
          isLoadAvailable: true, isLoadOnTrain: false, ferryRequired: false,
          loadChipTotal: 4, loadChipCarried: 0, estimatedTurns: 8,
          demandScore: 4, efficiencyPerTurn: 0.5, networkCitiesUnlocked: 0, victoryMajorCitiesEnRoute: 0,
        },
      ]);

      await AIStrategyEngine.takeTurn('game-1', 'bot-1');

      // Verify updateMemory clears the stale route
      expect(mockUpdateMemory).toHaveBeenCalled();
      const patch = mockUpdateMemory.mock.calls[0][2] as any;
      expect(patch.activeRoute).toBeNull();
      expect(patch.turnsOnRoute).toBe(0);
    });
  });

  describe('JIRA-64: demand refresh after delivery', () => {
    it('should refresh context.demands when delivery occurs', async () => {
      // Bot has an active route delivering Steel to Berlin
      const route: StrategicRoute = {
        stops: [
          { action: 'deliver', loadType: 'Steel', city: 'Berlin', demandCardId: 1, payment: 19 },
        ],
        currentStopIndex: 0,
        phase: 'travel' as const,
        createdAtTurn: 3,
        reasoning: 'test',
      };

      mockGetMemory.mockReturnValue({
        turnNumber: 5,
        noProgressTurns: 0,
        consecutiveDiscards: 0,
        lastAction: AIActionType.MoveTrain,
        activeRoute: route,
        turnsOnRoute: 2,
        routeHistory: [],
        deliveryCount: 1,
        totalEarnings: 19,
        currentBuildTarget: null,
        turnsOnTarget: 0,
        consecutiveLlmFailures: 0,
      });

      const snapshot = makeSnapshot({
        botConfig: { skillLevel: 'medium' },
        loads: ['Steel'],
      } as any);
      const context = makeContext({
        demands: [
          {
            cardIndex: 0, loadType: 'Steel', supplyCity: 'Ruhr', deliveryCity: 'Berlin',
            payout: 19, isSupplyReachable: false, isDeliveryReachable: true,
            isSupplyOnNetwork: true, isDeliveryOnNetwork: true,
            estimatedTrackCostToSupply: 0, estimatedTrackCostToDelivery: 0,
            isLoadAvailable: true, isLoadOnTrain: true, ferryRequired: false,
            loadChipTotal: 4, loadChipCarried: 1, estimatedTurns: 1,
            demandScore: 19, efficiencyPerTurn: 19, networkCitiesUnlocked: 0, victoryMajorCitiesEnRoute: 0,
          },
        ] as any[],
      });
      mockCapture.mockResolvedValue(snapshot);
      mockContextBuild.mockResolvedValue(context);

      // Set up loadGridPoints to return a city at the bot's position
      const gridMap = new Map();
      gridMap.set('10,10', { row: 10, col: 10, name: 'Berlin', terrain: 2 });
      (loadGridPoints as any).mockReturnValue(gridMap);

      // Mock PlayerService.deliverLoadForUser to return payment
      (PlayerService.deliverLoadForUser as any).mockResolvedValue({
        payment: 19,
        updatedMoney: 69,
        newCard: { id: 50, demands: [] },
      });

      // PlanExecutor delivers load (payment > 0 triggers hadDelivery)
      mockTurnExecutorPlannerExecute.mockResolvedValue(mockTurnExecResult({
        plan: { type: AIActionType.DeliverLoad, load: 'Steel', city: 'Berlin', cardId: 1, payout: 19 },
        routeComplete: true,
        routeAbandoned: false,
        updatedRoute: { ...route, currentStopIndex: 1 },
        description: 'Delivering Steel to Berlin',
      }));

      // After delivery, rebuildDemands returns NEW demands with the drawn card
      const mockRebuildDemands = ContextBuilder.rebuildDemands as jest.Mock;
      mockRebuildDemands.mockReturnValue([
        {
          cardIndex: 0, loadType: 'Copper', supplyCity: 'Katowice', deliveryCity: 'Manchester',
          payout: 30, isSupplyReachable: false, isDeliveryReachable: false,
          isSupplyOnNetwork: false, isDeliveryOnNetwork: false,
          estimatedTrackCostToSupply: 10, estimatedTrackCostToDelivery: 20,
          isLoadAvailable: true, isLoadOnTrain: false, ferryRequired: false,
          loadChipTotal: 4, loadChipCarried: 0, estimatedTurns: 8,
          demandScore: 4, efficiencyPerTurn: 0.5, networkCitiesUnlocked: 0, victoryMajorCitiesEnRoute: 0,
        },
      ]);

      await AIStrategyEngine.takeTurn('game-1', 'bot-1');

      // Verify rebuildDemands was called (delivery refresh + JIRA-85 ranking rebuild)
      expect(mockRebuildDemands).toHaveBeenCalled();
      // Verify capture called 3 times: initial + post-delivery + JIRA-85 ranking snapshot
      expect(mockCapture).toHaveBeenCalledTimes(3);
    });

    it('should clear activeRoute after delivery when refreshed demands lack route load type', async () => {
      // Bot has an active route: pickup Wine at Bordeaux → deliver to Praha
      // After delivering, the new card drawn doesn't include Wine
      const route: StrategicRoute = {
        stops: [
          { action: 'deliver', loadType: 'Wine', city: 'Praha', demandCardId: 3, payment: 15 },
          { action: 'pickup', loadType: 'Wine', city: 'Bordeaux' },
          { action: 'deliver', loadType: 'Wine', city: 'Berlin', demandCardId: 7, payment: 22 },
        ],
        currentStopIndex: 1,
        phase: 'travel' as const,
        createdAtTurn: 5,
        reasoning: 'test',
      };

      mockGetMemory.mockReturnValue({
        turnNumber: 8,
        noProgressTurns: 0,
        consecutiveDiscards: 0,
        lastAction: AIActionType.MoveTrain,
        activeRoute: route,
        turnsOnRoute: 3,
        routeHistory: [],
        deliveryCount: 1,
        totalEarnings: 15,
        currentBuildTarget: null,
        turnsOnTarget: 0,
        consecutiveLlmFailures: 0,
      });

      const snapshot = makeSnapshot({
        botConfig: { skillLevel: 'medium' },
        loads: ['Wine'],
      } as any);
      const context = makeContext({
        demands: [
          {
            cardIndex: 0, loadType: 'Wine', supplyCity: 'Bordeaux', deliveryCity: 'Praha',
            payout: 15, isSupplyReachable: false, isDeliveryReachable: true,
            isSupplyOnNetwork: true, isDeliveryOnNetwork: true,
            estimatedTrackCostToSupply: 0, estimatedTrackCostToDelivery: 0,
            isLoadAvailable: true, isLoadOnTrain: true, ferryRequired: false,
            loadChipTotal: 4, loadChipCarried: 1, estimatedTurns: 2,
            demandScore: 8, efficiencyPerTurn: 4, networkCitiesUnlocked: 0, victoryMajorCitiesEnRoute: 0,
          },
        ] as any[],
      });
      mockCapture.mockResolvedValue(snapshot);
      mockContextBuild.mockResolvedValue(context);

      // Set up loadGridPoints to return a city at the bot's position
      const gridMap = new Map();
      gridMap.set('10,10', { row: 10, col: 10, name: 'Praha', terrain: 2 });
      (loadGridPoints as any).mockReturnValue(gridMap);

      // Mock PlayerService.deliverLoadForUser to return payment
      (PlayerService.deliverLoadForUser as any).mockResolvedValue({
        payment: 15,
        updatedMoney: 65,
        newCard: { id: 51, demands: [] },
      });

      // PlanExecutor delivers Wine to Praha (payment > 0 triggers hadDelivery)
      mockTurnExecutorPlannerExecute.mockResolvedValue(mockTurnExecResult({
        plan: { type: AIActionType.DeliverLoad, load: 'Wine', city: 'Praha', cardId: 3, payout: 15 },
        routeComplete: false,
        routeAbandoned: false,
        updatedRoute: route,
        description: 'Delivering Wine to Praha',
      }));

      // After delivery, rebuildDemands returns NEW demands WITHOUT Wine
      const mockRebuildDemands = ContextBuilder.rebuildDemands as jest.Mock;
      mockRebuildDemands.mockReturnValue([
        {
          cardIndex: 0, loadType: 'Coal', supplyCity: 'Essen', deliveryCity: 'Roma',
          payout: 25, isSupplyReachable: false, isDeliveryReachable: false,
          isSupplyOnNetwork: true, isDeliveryOnNetwork: false,
          estimatedTrackCostToSupply: 0, estimatedTrackCostToDelivery: 15,
          isLoadAvailable: true, isLoadOnTrain: false, ferryRequired: false,
          loadChipTotal: 4, loadChipCarried: 0, estimatedTurns: 7,
          demandScore: 4, efficiencyPerTurn: 0.5, networkCitiesUnlocked: 0, victoryMajorCitiesEnRoute: 0,
        },
      ]);

      await AIStrategyEngine.takeTurn('game-1', 'bot-1');

      // Verify route was invalidated because Wine is no longer in demands
      expect(mockUpdateMemory).toHaveBeenCalled();
      const patch = mockUpdateMemory.mock.calls[0][2] as any;
      expect(patch.activeRoute).toBeNull();
      expect(patch.turnsOnRoute).toBe(0);
    });

    it('should NOT call rebuildDemands when no delivery occurred', async () => {
      mockGetMemory.mockReturnValue({
        turnNumber: 5,
        noProgressTurns: 0,
        consecutiveDiscards: 0,
        lastAction: null,
        activeRoute: null,
        turnsOnRoute: 0,
        routeHistory: [],
        deliveryCount: 0,
        totalEarnings: 0,
        currentBuildTarget: null,
        turnsOnTarget: 0,
        consecutiveLlmFailures: 0,
      });

      const snapshot = makeSnapshot({
        botConfig: { skillLevel: 'medium' },
      } as any);
      const context = makeContext();
      mockCapture.mockResolvedValue(snapshot);
      mockContextBuild.mockResolvedValue(context);

      // PlanExecutor returns BuildTrack (no delivery, payment = 0)
      const route: StrategicRoute = {
        stops: [{ action: 'pickup', loadType: 'Steel', city: 'Berlin' }],
        currentStopIndex: 0,
        phase: 'build' as const,
        createdAtTurn: 3,
        reasoning: 'test',
      };

      process.env.ANTHROPIC_API_KEY = 'test-key';
      mockPlanRoute.mockResolvedValue({
        route,
        model: 'claude-sonnet-4-20250514',
        latencyMs: 500,
      });
      mockTurnExecutorPlannerExecute.mockResolvedValue(mockTurnExecResult({
        plan: { type: AIActionType.BuildTrack, segments: [makeSegment(10, 11, 10, 12, 1)] },
        routeComplete: false,
        routeAbandoned: false,
        updatedRoute: route,
        description: 'Building toward Berlin',
      }));

      const mockRebuildDemands = ContextBuilder.rebuildDemands as jest.Mock;

      await AIStrategyEngine.takeTurn('game-1', 'bot-1');

      // JIRA-85: rebuildDemands is now always called for final ranking (unconditional rebuild)
      expect(mockRebuildDemands).toHaveBeenCalledTimes(1);
      // capture called twice: initial + ranking snapshot
      expect(mockCapture).toHaveBeenCalledTimes(2);

      delete process.env.ANTHROPIC_API_KEY;
    });
  });

  describe('JIRA-90: Post-delivery A2 movement reclamation', () => {
    /**
     * Setup: Route with single deliver stop (last stop) + A2 heuristic moves after delivery.
     * TurnComposer produces: [DELIVER, MOVE(heuristic)] with wasted=0 (A2 used all budget).
     * The fix should reclaim the heuristic MOVE's mileposts for LLM-guided replanning.
     */
    function setupRouteCompletedWithA2Movement() {
      process.env.ANTHROPIC_API_KEY = 'test-key';

      const route: StrategicRoute = {
        stops: [
          { action: 'deliver', loadType: 'Potatoes', city: 'Antwerpen', demandCardId: 1, payment: 15 },
        ],
        currentStopIndex: 0,
        phase: 'travel' as const,
        createdAtTurn: 3,
        reasoning: 'Deliver potatoes',
      };

      mockGetMemory.mockReturnValue({
        turnNumber: 8,
        noProgressTurns: 0,
        consecutiveDiscards: 0,
        lastAction: AIActionType.MoveTrain,
        activeRoute: route,
        turnsOnRoute: 3,
        routeHistory: [],
        deliveryCount: 2,
        totalEarnings: 30,
        currentBuildTarget: null,
        turnsOnTarget: 0,
        consecutiveLlmFailures: 0,
      });

      const snapshot = makeSnapshot({ botConfig: { skillLevel: 'medium', provider: 'anthropic' }, loads: ['Potatoes'] } as any);
      const context = makeContext({
        loads: ['Potatoes'],
        demands: [{
          cardIndex: 0, loadType: 'Coal', supplyCity: 'Essen', deliveryCity: 'Roma',
          payout: 28, isSupplyReachable: true, isDeliveryReachable: false,
          isSupplyOnNetwork: true, isDeliveryOnNetwork: false,
          estimatedTrackCostToSupply: 0, estimatedTrackCostToDelivery: 10,
          isLoadAvailable: true, isLoadOnTrain: false, ferryRequired: false,
          loadChipTotal: 4, loadChipCarried: 0, estimatedTurns: 5,
          demandScore: 6, efficiencyPerTurn: 1.2, networkCitiesUnlocked: 0, victoryMajorCitiesEnRoute: 0,
        }] as any[],
      });
      mockCapture.mockResolvedValue(snapshot);
      mockContextBuild.mockResolvedValue(context);
      (ContextBuilder.rebuildDemands as jest.Mock).mockReturnValue(context.demands);

      mockTurnExecutorPlannerExecute.mockResolvedValue(mockTurnExecResult({
        plan: { type: AIActionType.DeliverLoad, load: 'Potatoes', city: 'Antwerpen', cardId: 1, payout: 15 },
        routeComplete: true,
        routeAbandoned: false,
        updatedRoute: route,
        description: 'Delivering Potatoes to Antwerpen',
      }));

      const gridMap = new Map();
      gridMap.set('10,10', { row: 10, col: 10, name: 'Antwerpen', terrain: 2 });
      (loadGridPoints as any).mockReturnValue(gridMap);
      (PlayerService.deliverLoadForUser as any).mockResolvedValue({
        payment: 15, updatedMoney: 65, newCard: { id: 50, demands: [] },
      });

      return route;
    }

    afterEach(() => {
      delete process.env.ANTHROPIC_API_KEY;
    });

    it('should clear activeRoute and call heuristicFallback continuation when route completes', async () => {
      // JIRA-90: Stage 3d (planRoute after delivery) is now internal to TurnExecutorPlanner.
      // When routeComplete=true, AIStrategyEngine calls heuristicFallback for continuation movement.
      setupRouteCompletedWithA2Movement();

      const movePlan = { type: AIActionType.MoveTrain as const, path: [{ row: 10, col: 10 }, { row: 10, col: 11 }], fees: new Set<string>(), totalFee: 0 };
      mockHeuristicFallback.mockResolvedValue({ success: true, plan: movePlan });

      await AIStrategyEngine.takeTurn('game-1', 'bot-1');

      // Route should be cleared when complete
      expect(mockUpdateMemory).toHaveBeenCalled();
      const patch = mockUpdateMemory.mock.calls[0][2] as any;
      expect(patch.activeRoute).toBeNull();

      // heuristicFallback called for continuation movement
      expect(mockHeuristicFallback).toHaveBeenCalled();
    });

    it('should not throw when heuristicFallback returns null after route completion', async () => {
      // JIRA-90: When TurnExecutorPlanner completes route and heuristicFallback has no action,
      // ASE should gracefully produce a PassTurn result.
      setupRouteCompletedWithA2Movement();

      mockHeuristicFallback.mockResolvedValue({ success: false });

      // Should not throw — falls through gracefully to PassTurn
      await expect(AIStrategyEngine.takeTurn('game-1', 'bot-1')).resolves.toBeDefined();
    });

  });

  describe('JIRA-91: Post-delivery fresh context for LLM calls', () => {
    /**
     * Setup: Delivery mid-turn triggers Stage 3d. JIRA-91 ensures the LLM call
     * receives fresh post-delivery state (new demand card, updated money, correct loads)
     * by executing delivery steps against the DB before calling capture().
     */
    function setupDeliveryWithFreshContext(routeCompleted: boolean) {
      process.env.ANTHROPIC_API_KEY = 'test-key';

      const route: StrategicRoute = routeCompleted
        ? {
            stops: [
              { action: 'deliver', loadType: 'Beer', city: 'Bruxelles', demandCardId: 1, payment: 10 },
            ],
            currentStopIndex: 0,
            phase: 'travel' as const,
            createdAtTurn: 3,
            reasoning: 'Deliver beer',
          }
        : {
            stops: [
              { action: 'deliver', loadType: 'Beer', city: 'Bruxelles', demandCardId: 1, payment: 10 },
              { action: 'pickup', loadType: 'Chocolate', city: 'Bern' },
            ],
            currentStopIndex: 0,
            phase: 'travel' as const,
            createdAtTurn: 3,
            reasoning: 'Deliver beer then pickup chocolate',
          };

      mockGetMemory.mockReturnValue({
        turnNumber: 5,
        noProgressTurns: 0,
        consecutiveDiscards: 0,
        lastAction: AIActionType.MoveTrain,
        activeRoute: route,
        turnsOnRoute: 2,
        routeHistory: [],
        deliveryCount: 1,
        totalEarnings: 15,
        currentBuildTarget: null,
        turnsOnTarget: 0,
        consecutiveLlmFailures: 0,
      });

      // Pre-delivery snapshot: carrying Beer, old demand card
      const preDeliverySnap = makeSnapshot({
        botConfig: { skillLevel: 'medium', provider: 'anthropic' },
        loads: ['Beer'],
        money: 50,
      } as any);

      // Post-delivery snapshot: no Beer, new demand card, updated money
      const postDeliverySnap = makeSnapshot({
        botConfig: { skillLevel: 'medium', provider: 'anthropic' },
        loads: [],
        money: 60,
        demandCards: [1, 50], // card 50 is the newly drawn replacement
      } as any);

      const preDeliveryContext = makeContext({
        loads: ['Beer'],
        money: 50,
        demands: [{
          cardIndex: 0, loadType: 'Wine', supplyCity: 'Bordeaux', deliveryCity: 'London',
          payout: 22, isSupplyReachable: true, isDeliveryReachable: false,
          isSupplyOnNetwork: true, isDeliveryOnNetwork: false,
          estimatedTrackCostToSupply: 0, estimatedTrackCostToDelivery: 8,
          isLoadAvailable: true, isLoadOnTrain: false, ferryRequired: false,
          loadChipTotal: 4, loadChipCarried: 0, estimatedTurns: 4,
          demandScore: 5, efficiencyPerTurn: 1.0, networkCitiesUnlocked: 0, victoryMajorCitiesEnRoute: 0,
        }] as any[],
      });

      // Post-delivery context includes the newly drawn demand card
      const postDeliveryContext = makeContext({
        loads: [],
        money: 60,
        demands: [
          {
            cardIndex: 0, loadType: 'Wine', supplyCity: 'Bordeaux', deliveryCity: 'London',
            payout: 22, isSupplyReachable: true, isDeliveryReachable: false,
            isSupplyOnNetwork: true, isDeliveryOnNetwork: false,
            estimatedTrackCostToSupply: 0, estimatedTrackCostToDelivery: 8,
            isLoadAvailable: true, isLoadOnTrain: false, ferryRequired: false,
            loadChipTotal: 4, loadChipCarried: 0, estimatedTurns: 4,
            demandScore: 5, efficiencyPerTurn: 1.0, networkCitiesUnlocked: 0, victoryMajorCitiesEnRoute: 0,
          },
          {
            cardIndex: 1, loadType: 'Chocolate', supplyCity: 'Bern', deliveryCity: 'Hamburg',
            payout: 18, isSupplyReachable: true, isDeliveryReachable: true,
            isSupplyOnNetwork: true, isDeliveryOnNetwork: true,
            estimatedTrackCostToSupply: 0, estimatedTrackCostToDelivery: 0,
            isLoadAvailable: true, isLoadOnTrain: false, ferryRequired: false,
            loadChipTotal: 3, loadChipCarried: 0, estimatedTurns: 3,
            demandScore: 7, efficiencyPerTurn: 2.3, networkCitiesUnlocked: 0, victoryMajorCitiesEnRoute: 0,
          },
        ] as any[],
      });

      // capture() returns pre-delivery on first call, post-delivery on subsequent calls
      let captureCallCount = 0;
      mockCapture.mockImplementation(async () => {
        captureCallCount++;
        return captureCallCount === 1 ? preDeliverySnap : postDeliverySnap;
      });

      // ContextBuilder.build returns pre-delivery on first call, post-delivery on subsequent
      let contextBuildCallCount = 0;
      mockContextBuild.mockImplementation(async () => {
        contextBuildCallCount++;
        return contextBuildCallCount === 1 ? preDeliveryContext : postDeliveryContext;
      });

      (ContextBuilder.rebuildDemands as jest.Mock).mockReturnValue(postDeliveryContext.demands);

      mockTurnExecutorPlannerExecute.mockResolvedValue(mockTurnExecResult({
        plan: { type: AIActionType.DeliverLoad, load: 'Beer', city: 'Bruxelles', cardId: 1, payout: 10 },
        routeComplete: routeCompleted,
        routeAbandoned: false,
        updatedRoute: route,
        description: 'Delivering Beer to Bruxelles',
      }));

      const gridMap = new Map();
      gridMap.set('10,10', { row: 10, col: 10, name: 'Bruxelles', terrain: 2 });
      (loadGridPoints as any).mockReturnValue(gridMap);
      (PlayerService.deliverLoadForUser as any).mockResolvedValue({
        payment: 10, updatedMoney: 60, newCard: { id: 50, demands: [] },
      });

      return { preDeliverySnap, postDeliverySnap, preDeliveryContext, postDeliveryContext, route };
    }

    afterEach(() => {
      delete process.env.ANTHROPIC_API_KEY;
    });

    it('should clear activeRoute and call heuristicFallback continuation when route completed via delivery', async () => {
      // JIRA-91: Stage 3d (planRoute after delivery) is now internal to TurnExecutorPlanner.
      // When routeComplete=true (delivery finished route), AIStrategyEngine clears the route
      // and calls heuristicFallback for continuation movement.
      setupDeliveryWithFreshContext(true);

      const movePlan = { type: AIActionType.MoveTrain as const, path: [{ row: 10, col: 10 }, { row: 10, col: 11 }], fees: new Set<string>(), totalFee: 0 };
      mockHeuristicFallback.mockResolvedValue({ success: true, plan: movePlan });

      await AIStrategyEngine.takeTurn('game-1', 'bot-1');

      // Route should be cleared when complete
      expect(mockUpdateMemory).toHaveBeenCalled();
      const patch = mockUpdateMemory.mock.calls[0][2] as any;
      expect(patch.activeRoute).toBeNull();
    });

    it('should call capture multiple times per turn when delivery occurs', async () => {
      setupDeliveryWithFreshContext(true);

      const newRoute: StrategicRoute = {
        stops: [{ action: 'pickup', loadType: 'Chocolate', city: 'Bern' }],
        currentStopIndex: 0,
        phase: 'travel' as const,
        createdAtTurn: 5,
        reasoning: 'Pick up chocolate',
      };
      const mockPlanRouteFn = jest.fn<(...args: any[]) => Promise<any>>().mockResolvedValue({
        route: newRoute,
        model: 'claude-haiku-4-5-20251001',
        latencyMs: 200,
        llmLog: [],
      });
      (LLMStrategyBrain as any).mockImplementation(() => ({
        decideAction: jest.fn(),
        planRoute: mockPlanRouteFn,
        modelName: 'claude-haiku-4-5-20251001',
        providerAdapter: {
          resetCallIds: jest.fn(),
          getCallIds: jest.fn(() => []),
          getCallSummaries: jest.fn(() => []),
        },
      }));

      await AIStrategyEngine.takeTurn('game-1', 'bot-1');

      // capture() is called: initial (Stage 1) + JIRA-64 post-delivery refresh + JIRA-85 ranking snapshot
      expect(mockCapture.mock.calls.length).toBeGreaterThanOrEqual(2);
    });
  });

  // ── JIRA-89 fix: Dead load drop execution ──────────────────────────────
  describe('JIRA-89: dead load drop execution', () => {
    const mockFindDeadLoads = TurnExecutorPlanner.findDeadLoads as jest.MockedFunction<typeof TurnExecutorPlanner.findDeadLoads>;

    function setupWithRoute(snapshotOverrides: any = {}, deadLoads: string[] = []) {
      process.env.ANTHROPIC_API_KEY = 'test-key';

      // Ensure no activeRoute from previous tests — forces the LLM/planRoute branch
      mockGetMemory.mockReturnValue({
        turnNumber: 0,
        noProgressTurns: 0,
        consecutiveDiscards: 0,
        lastAction: null,
        activeRoute: null,
        turnsOnRoute: 0,
        routeHistory: [],
        currentBuildTarget: null,
        turnsOnTarget: 0,
        deliveryCount: 0,
        totalEarnings: 0,
        consecutiveLlmFailures: 0,
      });

      const snapshot = makeSnapshot({
        botConfig: { skillLevel: 'medium' },
        position: { row: 10, col: 10 },
        loads: ['Hops', 'Wine'],
        resolvedDemands: [{ cardId: 1, demands: [{ city: 'Berlin', loadType: 'Steel', payment: 20 }] }],
        ...snapshotOverrides,
      } as any);
      const context = makeContext();
      mockCapture.mockResolvedValue(snapshot);
      mockContextBuild.mockResolvedValue(context);
      mockFindDeadLoads.mockReturnValue(deadLoads);

      // Mock loadGridPointsMap to return a city at bot's position
      const { loadGridPoints } = require('../../services/ai/MapTopology');
      (loadGridPoints as jest.Mock).mockReturnValue(new Map([
        ['10,10', { name: 'TestCity' }],
      ]));

      const route = {
        stops: [{ action: 'pickup' as const, loadType: 'Steel', city: 'Berlin' }],
        currentStopIndex: 0,
        phase: 'travel' as const,
        reasoning: 'test',
        createdAtTurn: 1,
      };
      mockPlanRoute.mockResolvedValue({
        route,
        model: 'claude-sonnet-4-20250514',
        latencyMs: 100,
        llmLog: [],
      });

      // Mock PlanExecutor.execute to return a valid plan
      mockTurnExecutorPlannerExecute.mockResolvedValue(mockTurnExecResult({
        plan: { type: AIActionType.MoveTrain, path: [{ row: 10, col: 10 }, { row: 10, col: 11 }], fees: new Set<string>(), totalFee: 0 },
        routeComplete: false,
        routeAbandoned: false,
        updatedRoute: route,
        description: 'Moving toward Berlin',
      }));

      // Mock TurnExecutor to return successfully
      mockClient.query.mockResolvedValue(mockResult([]));

      return snapshot;
    }

    afterEach(() => {
      delete process.env.ANTHROPIC_API_KEY;
    });

    it('should mutate snapshot.bot.loads and log dead load drop at a city', async () => {
      const snapshot = setupWithRoute({}, ['Hops']);

      const result = await AIStrategyEngine.takeTurn('game-1', 'bot-1');

      // snapshot.bot.loads should have Hops removed before downstream code
      // (splice happens in the dead load block, before PlanExecutor.execute)
      expect(snapshot.bot.loads).not.toContain('Hops');
      // secondaryDelivery log should record the dead load drop
      expect(result.secondaryDelivery).toBeDefined();
      expect(result.secondaryDelivery!.action).toBe('dead_load_drop');
      expect(result.secondaryDelivery!.deadLoadsDropped).toEqual(['Hops']);
    });

    it('should mutate snapshot.bot.loads for multiple dead loads', async () => {
      const snapshot = setupWithRoute({}, ['Hops', 'Wine']);

      const result = await AIStrategyEngine.takeTurn('game-1', 'bot-1');

      // Both dead loads should be removed from snapshot
      expect(snapshot.bot.loads).not.toContain('Hops');
      expect(snapshot.bot.loads).not.toContain('Wine');
      expect(result.secondaryDelivery).toBeDefined();
      expect(result.secondaryDelivery!.deadLoadsDropped).toEqual(['Hops', 'Wine']);
    });

    it('should not drop loads when bot is not at a city', async () => {
      process.env.ANTHROPIC_API_KEY = 'test-key';

      const snapshot = makeSnapshot({
        botConfig: { skillLevel: 'medium' },
        position: { row: 5, col: 5 },
        loads: ['Hops'],
        resolvedDemands: [],
      } as any);
      mockCapture.mockResolvedValue(snapshot);
      mockContextBuild.mockResolvedValue(makeContext());
      mockFindDeadLoads.mockReturnValue(['Hops']);

      // loadGridPointsMap returns no city at bot's position
      const { loadGridPoints } = require('../../services/ai/MapTopology');
      (loadGridPoints as jest.Mock).mockReturnValue(new Map());

      const route = {
        stops: [{ action: 'pickup' as const, loadType: 'Steel', city: 'Berlin' }],
        currentStopIndex: 0,
        phase: 'travel' as const,
        reasoning: 'test',
        createdAtTurn: 1,
      };
      mockPlanRoute.mockResolvedValue({ route, model: 'test', latencyMs: 0, llmLog: [] });
      mockTurnExecutorPlannerExecute.mockResolvedValue(mockTurnExecResult({
        plan: { type: AIActionType.MoveTrain, path: [{ row: 5, col: 5 }, { row: 5, col: 6 }], fees: new Set<string>(), totalFee: 0 },
        routeComplete: false,
        routeAbandoned: false,
        updatedRoute: route,
        description: 'Moving',
      }));
      mockClient.query.mockResolvedValue(mockResult([]));

      await AIStrategyEngine.takeTurn('game-1', 'bot-1');

      // Loads should NOT be mutated — bot not at city
      expect(snapshot.bot.loads).toEqual(['Hops']);
    });

    it('should not create drop actions when no dead loads exist', async () => {
      const snapshot = setupWithRoute({}, []);

      const result = await AIStrategyEngine.takeTurn('game-1', 'bot-1');

      // No dead load drop should be logged
      expect(result.secondaryDelivery).toBeUndefined();
      // Loads should remain unchanged
      expect(snapshot.bot.loads).toEqual(['Hops', 'Wine']);
    });
  });

  // ── JIRA-116: movementPath includes early-executed MOVE segments ──────
  describe('JIRA-116: movementPath includes early-executed MOVE segments', () => {
    afterEach(() => {
      delete process.env.ANTHROPIC_API_KEY;
    });

    it('should include MOVE paths from early-executed steps in movementPath', async () => {
      process.env.ANTHROPIC_API_KEY = 'test-key';

      const route: StrategicRoute = {
        stops: [
          { action: 'deliver', loadType: 'Beer', city: 'Bruxelles', demandCardId: 1, payment: 10 },
          { action: 'pickup', loadType: 'Chocolate', city: 'Bern' },
        ],
        currentStopIndex: 0,
        phase: 'travel' as const,
        createdAtTurn: 3,
        reasoning: 'Deliver beer then pickup chocolate',
      };

      mockGetMemory.mockReturnValue({
        turnNumber: 5, noProgressTurns: 0, consecutiveDiscards: 0,
        lastAction: AIActionType.MoveTrain, activeRoute: route,
        turnsOnRoute: 2, routeHistory: [], deliveryCount: 1, totalEarnings: 15,
        currentBuildTarget: null, turnsOnTarget: 0, consecutiveLlmFailures: 0,
      });

      const preDeliverySnap = makeSnapshot({
        botConfig: { skillLevel: 'medium', provider: 'anthropic' },
        loads: ['Beer'], money: 50,
      } as any);
      const postDeliverySnap = makeSnapshot({
        botConfig: { skillLevel: 'medium', provider: 'anthropic' },
        loads: [], money: 60, demandCards: [1, 50],
      } as any);

      let captureCallCount = 0;
      mockCapture.mockImplementation(async () => {
        captureCallCount++;
        return captureCallCount === 1 ? preDeliverySnap : postDeliverySnap;
      });

      const preContext = makeContext({ loads: ['Beer'], money: 50, demands: [] as any[] });
      const postContext = makeContext({ loads: [], money: 60, demands: [] as any[] });
      let contextCallCount = 0;
      mockContextBuild.mockImplementation(async () => {
        contextCallCount++;
        return contextCallCount === 1 ? preContext : postContext;
      });
      (ContextBuilder.rebuildDemands as jest.Mock).mockReturnValue([]);

      // TurnExecutorPlanner returns a MultiAction plan with MOVE + DELIVER (A3 move prepended)
      const earlyMovePath = [{ row: 10, col: 10 }, { row: 11, col: 11 }, { row: 12, col: 12 }];
      mockTurnExecutorPlannerExecute.mockResolvedValue({
        plans: [
          { type: AIActionType.MoveTrain, path: earlyMovePath, to: 'Bruxelles', fees: new Set(), totalFee: 0 },
          { type: AIActionType.DeliverLoad, load: 'Beer', city: 'Bruxelles', cardId: 1, payout: 10 },
        ],
        routeComplete: false,
        routeAbandoned: false,
        updatedRoute: route,
        compositionTrace: { ...defaultCompositionTrace, a3: { movePreprended: true } },
        hasDelivery: true,
      } as any);

      // Grid for city lookup in handleMoveTrain/handleDeliverLoad
      const gridMap = new Map();
      gridMap.set('10,10', { row: 10, col: 10, name: 'Berlin', terrain: 2 });
      gridMap.set('12,12', { row: 12, col: 12, name: 'Bruxelles', terrain: 2 });
      (loadGridPoints as any).mockReturnValue(gridMap);

      // PlayerService mocks for early execution
      (PlayerService.moveTrainForUser as any).mockResolvedValue({
        feeTotal: 0, updatedMoney: 50, affectedPlayerIds: ['bot-1'],
      });
      (PlayerService.deliverLoadForUser as any).mockResolvedValue({
        payment: 10, updatedMoney: 60, newCard: { id: 50, demands: [] },
      });

      (LLMStrategyBrain as any).mockImplementation(() => ({
        decideAction: jest.fn(),
        planRoute: jest.fn(),
        modelName: 'claude-haiku-4-5-20251001',
        providerAdapter: {
          resetCallIds: jest.fn(),
          getCallIds: jest.fn(() => []),
          getCallSummaries: jest.fn(() => []),
        },
      }));

      const result = await AIStrategyEngine.takeTurn('game-1', 'bot-1');

      // movementPath should include the MOVE path from TurnExecutorPlanner plans
      expect(result.movementPath).toBeDefined();
      expect(result.movementPath).toEqual(earlyMovePath);
    });

    it('should not include movementPath when no early execution occurs (no delivery)', async () => {
      // No API key → no early execution path
      delete process.env.ANTHROPIC_API_KEY;

      mockGetMemory.mockReturnValue({
        turnNumber: 5, noProgressTurns: 0, consecutiveDiscards: 0,
        lastAction: null, activeRoute: null, turnsOnRoute: 0,
        routeHistory: [], deliveryCount: 0, totalEarnings: 0,
        currentBuildTarget: null, turnsOnTarget: 0, consecutiveLlmFailures: 0,
      });

      const snapshot = makeSnapshot({ botConfig: null } as any);
      mockCapture.mockResolvedValue(snapshot);
      mockContextBuild.mockResolvedValue(makeContext());

      // TurnExecutorPlanner returns a PASS (no delivery → no movement path)
      mockTurnExecutorPlannerExecute.mockResolvedValue(mockTurnExecResult({
        plan: { type: AIActionType.PassTurn },
        routeComplete: false, routeAbandoned: false, updatedRoute: undefined as unknown as StrategicRoute, description: 'Pass',
      }));

      // Heuristic fallback returns a PASS (no movement)
      mockHeuristicFallback.mockResolvedValue({
        success: true,
        plan: { type: AIActionType.PassTurn },
      });

      const result = await AIStrategyEngine.takeTurn('game-1', 'bot-1');

      // No movement → no movementPath
      expect(result.movementPath).toBeUndefined();
    });
  });

  // ── JIRA-129: activeRoute reflects new route from post-delivery TripPlanner replan ──
  describe('JIRA-129: activeRoute updated after post-delivery TripPlanner replan', () => {
    /**
     * Post-delivery TripPlanner replan is now handled internally by TurnExecutorPlanner.
     * AIStrategyEngine receives the replanned route via execResult.updatedRoute.
     *
     * When TurnExecutorPlanner successfully replans:
     *   - routeComplete = false (new route is active, not complete)
     *   - updatedRoute = the new route from TripPlanner
     *   → AIStrategyEngine sets activeRoute = updatedRoute
     *
     * When TurnExecutorPlanner fails to replan (TripPlanner returned null / threw):
     *   - routeComplete = true (original route was the only one)
     *   - updatedRoute = old route
     *   → AIStrategyEngine sets routeWasCompleted, memory.activeRoute = null
     */
    const oldRoute: StrategicRoute = {
      stops: [
        { action: 'deliver', loadType: 'Oil', city: 'Holland', demandCardId: 1, payment: 20 },
      ],
      currentStopIndex: 0,
      phase: 'travel' as const,
      createdAtTurn: 2,
      reasoning: 'Deliver oil to Holland',
    };

    const newRoute: StrategicRoute = {
      stops: [
        { action: 'pickup', loadType: 'Cars', city: 'München' },
        { action: 'deliver', loadType: 'Cars', city: 'Manchester', demandCardId: 5, payment: 30 },
      ],
      currentStopIndex: 0,
      phase: 'travel' as const,
      createdAtTurn: 5,
      reasoning: 'Pick up cars for Manchester',
    };

    function setupBase() {
      process.env.ANTHROPIC_API_KEY = 'test-key';

      mockGetMemory.mockReturnValue({
        turnNumber: 4,
        noProgressTurns: 0,
        consecutiveDiscards: 0,
        lastAction: null,
        activeRoute: oldRoute,
        turnsOnRoute: 2,
        routeHistory: [],
        currentBuildTarget: null,
        turnsOnTarget: 0,
        deliveryCount: 1,
        totalEarnings: 20,
        consecutiveLlmFailures: 0,
      });

      const snapshot = makeSnapshot({ botConfig: { skillLevel: 'medium' } } as any);
      const context = makeContext();
      mockCapture.mockResolvedValue(snapshot);
      mockContextBuild.mockResolvedValue(context);
      return { snapshot, context };
    }

    afterEach(() => {
      delete process.env.ANTHROPIC_API_KEY;
    });

    it('should reflect new route in activeRoute when TurnExecutorPlanner internally replanned', async () => {
      setupBase();

      // TurnExecutorPlanner delivered Oil and internally called TripPlanner which returned newRoute.
      // Since the new route is not complete, it returns routeComplete=false with updatedRoute=newRoute.
      mockTurnExecutorPlannerExecute.mockResolvedValue({
        plans: [
          { type: AIActionType.DeliverLoad, load: 'Oil', city: 'Holland', cardId: 1, payout: 20 },
        ],
        routeComplete: false,
        routeAbandoned: false,
        updatedRoute: newRoute,
        compositionTrace: defaultCompositionTrace,
        hasDelivery: true,
      } as any);

      // JIRA-64: rebuildDemands must include Cars so route isn't invalidated
      (ContextBuilder.rebuildDemands as jest.Mock).mockReturnValue([
        { loadType: 'Cars', supplyCity: 'München', deliveryCity: 'Manchester', demandCardId: 5, payout: 30, estimatedTurns: 3 },
      ]);

      const result = await AIStrategyEngine.takeTurn('game-1', 'bot-1');

      // activeRoute should be the new route returned by TurnExecutorPlanner
      expect(result.activeRoute).not.toBeNull();
      expect(result.activeRoute!.stops[0].city).toBe('München');
      expect(result.activeRoute!.stops[0].loadType).toBe('Cars');
      expect(result.activeRoute!.reasoning).toBe('Pick up cars for Manchester');
    });

    it('should clear activeRoute in memory when original route completes with no new replan', async () => {
      setupBase();

      // TurnExecutorPlanner completed the old route with no successful internal replan.
      mockTurnExecutorPlannerExecute.mockResolvedValue(mockTurnExecResult({
        plan: { type: AIActionType.DeliverLoad, load: 'Oil', city: 'Holland', cardId: 1, payout: 20 },
        routeComplete: true,
        routeAbandoned: false,
        updatedRoute: oldRoute,
        description: 'Delivered Oil to Holland',
        hasDelivery: true,
      }));

      await AIStrategyEngine.takeTurn('game-1', 'bot-1');

      // Memory should have activeRoute cleared when route completes
      expect(mockUpdateMemory).toHaveBeenCalled();
      const patch = mockUpdateMemory.mock.calls[0][2] as any;
      expect(patch.activeRoute).toBeNull();
    });

    it('should NOT set activeRoute to new route when TurnExecutorPlanner returns routeAbandoned', async () => {
      setupBase();

      mockTurnExecutorPlannerExecute.mockResolvedValue(mockTurnExecResult({
        plan: { type: AIActionType.PassTurn },
        routeComplete: false,
        routeAbandoned: true,
        updatedRoute: oldRoute,
        description: 'Route abandoned',
      }));

      await AIStrategyEngine.takeTurn('game-1', 'bot-1');

      expect(mockUpdateMemory).toHaveBeenCalled();
      const patch = mockUpdateMemory.mock.calls[0][2] as any;
      // Route abandoned → activeRoute cleared in memory
      expect(patch.activeRoute).toBeNull();
    });
  });

  // ── JIRA-156 P2: RouteEnrichmentAdvisor called after initial TripPlanner route ──
  describe('JIRA-156 P2: RouteEnrichmentAdvisor enrich() called after new route creation', () => {
    afterEach(() => {
      delete process.env.ANTHROPIC_API_KEY;
    });

    it('should call RouteEnrichmentAdvisor.enrich() after TripPlanner creates a new route when hexGrid is populated', async () => {
      process.env.ANTHROPIC_API_KEY = 'test-key';

      // Snapshot with hexGrid so gridPoints.length > 0 gate passes
      const hexGrid = [
        { id: '0,0', row: 0, col: 0, x: 0, y: 0, terrain: 2, city: { type: 2, name: 'Berlin', availableLoads: [] } },
        { id: '1,0', row: 1, col: 0, x: 0, y: 50, terrain: 0, city: undefined },
      ];
      const snapshot = { ...makeSnapshot({ botConfig: { skillLevel: 'medium' } } as any), hexGrid };
      const context = makeContext();
      mockCapture.mockResolvedValue(snapshot);
      mockContextBuild.mockResolvedValue(context);

      // No active route — TripPlanner path is taken
      mockGetMemory.mockReturnValue({
        turnNumber: 0,
        noProgressTurns: 0,
        consecutiveDiscards: 0,
        lastAction: null,
        activeRoute: null,
        turnsOnRoute: 0,
        routeHistory: [],
        currentBuildTarget: null,
        turnsOnTarget: 0,
        deliveryCount: 0,
        totalEarnings: 0,
        consecutiveLlmFailures: 0,
      });

      const route: StrategicRoute = {
        stops: [
          { action: 'pickup', loadType: 'Coal', city: 'Berlin' },
          { action: 'deliver', loadType: 'Coal', city: 'Paris', demandCardId: 1, payment: 15 },
        ],
        currentStopIndex: 0,
        phase: 'build' as const,
        createdAtTurn: 5,
        reasoning: 'Coal to Paris',
      };

      mockPlanRoute.mockResolvedValue({
        route,
        model: 'claude-sonnet-4-20250514',
        latencyMs: 300,
        tokenUsage: { input: 100, output: 50 },
      });

      mockTurnExecutorPlannerExecute.mockResolvedValue(mockTurnExecResult({
        plan: { type: AIActionType.BuildTrack, segments: [makeSegment(10, 10, 10, 11)] },
        routeComplete: false,
        routeAbandoned: false,
        updatedRoute: route,
        description: 'Building toward Berlin',
      }));

      await AIStrategyEngine.takeTurn('game-1', 'bot-1');

      // RouteEnrichmentAdvisor.enrich should have been called with the new route + snapshot + context + brain + gridPoints
      expect(RouteEnrichmentAdvisor.enrich).toHaveBeenCalledTimes(1);
      const [enrichRoute, enrichSnapshot, enrichContext, , enrichGrid] =
        (RouteEnrichmentAdvisor.enrich as jest.Mock).mock.calls[0];
      expect(enrichRoute.stops[0].city).toBe('Berlin');
      expect(enrichSnapshot.hexGrid).toBe(hexGrid);
      expect(enrichContext).toBe(context);
      expect(enrichGrid).toEqual(hexGrid);
    });

    it('should NOT call RouteEnrichmentAdvisor.enrich() when hexGrid is empty', async () => {
      process.env.ANTHROPIC_API_KEY = 'test-key';

      // Snapshot without hexGrid → gridPoints = []
      const snapshot = makeSnapshot({ botConfig: { skillLevel: 'medium' } } as any);
      const context = makeContext();
      mockCapture.mockResolvedValue(snapshot);
      mockContextBuild.mockResolvedValue(context);

      mockGetMemory.mockReturnValue({
        turnNumber: 0,
        noProgressTurns: 0,
        consecutiveDiscards: 0,
        lastAction: null,
        activeRoute: null,
        turnsOnRoute: 0,
        routeHistory: [],
        currentBuildTarget: null,
        turnsOnTarget: 0,
        deliveryCount: 0,
        totalEarnings: 0,
        consecutiveLlmFailures: 0,
      });

      const route: StrategicRoute = {
        stops: [{ action: 'pickup', loadType: 'Coal', city: 'Berlin' }],
        currentStopIndex: 0,
        phase: 'build' as const,
        createdAtTurn: 5,
        reasoning: 'test',
      };

      mockPlanRoute.mockResolvedValue({ route, model: 'claude-sonnet-4-20250514', latencyMs: 100 });
      mockTurnExecutorPlannerExecute.mockResolvedValue(mockTurnExecResult({
        plan: { type: AIActionType.PassTurn },
        routeComplete: false,
        routeAbandoned: false,
        updatedRoute: route,
        description: 'Pass',
      }));

      await AIStrategyEngine.takeTurn('game-1', 'bot-1');

      // gridPoints.length === 0 → enrich() should NOT be called
      expect(RouteEnrichmentAdvisor.enrich).not.toHaveBeenCalled();
    });

    it('should use the enriched route (from enrich() return value) for execution', async () => {
      process.env.ANTHROPIC_API_KEY = 'test-key';

      const hexGrid = [
        { id: '0,0', row: 0, col: 0, x: 0, y: 0, terrain: 2, city: { type: 2, name: 'Berlin', availableLoads: [] } },
      ];
      const snapshot = { ...makeSnapshot({ botConfig: { skillLevel: 'medium' } } as any), hexGrid };
      const context = makeContext();
      mockCapture.mockResolvedValue(snapshot);
      mockContextBuild.mockResolvedValue(context);

      mockGetMemory.mockReturnValue({
        turnNumber: 0,
        noProgressTurns: 0,
        consecutiveDiscards: 0,
        lastAction: null,
        activeRoute: null,
        turnsOnRoute: 0,
        routeHistory: [],
        currentBuildTarget: null,
        turnsOnTarget: 0,
        deliveryCount: 0,
        totalEarnings: 0,
        consecutiveLlmFailures: 0,
      });

      const originalRoute: StrategicRoute = {
        stops: [{ action: 'pickup', loadType: 'Coal', city: 'Berlin' }],
        currentStopIndex: 0,
        phase: 'build' as const,
        createdAtTurn: 5,
        reasoning: 'Original',
      };

      const enrichedRoute: StrategicRoute = {
        stops: [
          { action: 'pickup', loadType: 'Coal', city: 'Berlin' },
          { action: 'deliver', loadType: 'Coal', city: 'Paris', payment: 12 },
        ],
        currentStopIndex: 0,
        phase: 'build' as const,
        createdAtTurn: 5,
        reasoning: 'Enriched by advisor',
      };

      mockPlanRoute.mockResolvedValue({ route: originalRoute, model: 'claude-sonnet-4-20250514', latencyMs: 100 });

      // Override the mock to return enrichedRoute instead of passing through
      (RouteEnrichmentAdvisor.enrich as jest.Mock).mockResolvedValue(enrichedRoute);

      mockTurnExecutorPlannerExecute.mockResolvedValue(mockTurnExecResult({
        plan: { type: AIActionType.BuildTrack, segments: [makeSegment(10, 10, 10, 11)] },
        routeComplete: false,
        routeAbandoned: false,
        updatedRoute: enrichedRoute,
        description: 'Building',
      }));

      await AIStrategyEngine.takeTurn('game-1', 'bot-1');

      // TurnExecutorPlanner should have been called with the enriched route (not the original)
      const [execRoute] = mockTurnExecutorPlannerExecute.mock.calls[0];
      expect(execRoute.stops).toHaveLength(2);
      expect(execRoute.reasoning).toBe('Enriched by advisor');
    });
  });

  describe('JIRA-170: Auto-deliver before LLM consultation', () => {
    const defaultMemory = {
      turnNumber: 0,
      noProgressTurns: 0,
      consecutiveDiscards: 0,
      lastAction: null,
      activeRoute: null,
      turnsOnRoute: 0,
      routeHistory: [],
      currentBuildTarget: null,
      turnsOnTarget: 0,
      deliveryCount: 0,
      totalEarnings: 0,
      consecutiveLlmFailures: 0,
    };

    beforeEach(() => {
      process.env.ANTHROPIC_API_KEY = 'test-key';
      mockGetMemory.mockReturnValue(defaultMemory);
      // Set up loadGridPoints so TurnExecutor.handleDeliverLoad can resolve city name
      const gridMap = new Map();
      gridMap.set('10,10', { row: 10, col: 10, name: 'Berlin', terrain: 2 });
      gridMap.set('10,11', { row: 10, col: 11, name: 'Paris', terrain: 2 });
      (loadGridPoints as any).mockReturnValue(gridMap);
    });

    afterEach(() => {
      delete process.env.ANTHROPIC_API_KEY;
    });

    it('AC1/AC2: auto-delivers before TripPlanner when canDeliver is non-empty and no active route', async () => {
      const delivery: DeliveryOpportunity = {
        loadType: 'Coal',
        deliveryCity: 'Berlin',
        payout: 25,
        cardIndex: 42,
      };

      const snapshot = makeSnapshot({
        botConfig: { skillLevel: 'medium' },
        loads: ['Coal'],
        resolvedDemands: [
          { cardId: 42, demands: [{ city: 'Berlin', loadType: 'Coal', payment: 25 }] },
        ],
      } as any);
      const freshSnapshot = makeSnapshot({
        botConfig: { skillLevel: 'medium' },
        loads: [],
        resolvedDemands: [
          { cardId: 99, demands: [{ city: 'Paris', loadType: 'Steel', payment: 30 }] },
        ],
      } as any);
      const context = makeContext({ canDeliver: [delivery] });
      const freshContext = makeContext({ canDeliver: [], demands: [] });

      // First capture returns original snapshot, second capture (after delivery) returns fresh snapshot
      mockCapture
        .mockResolvedValueOnce(snapshot)
        .mockResolvedValueOnce(freshSnapshot)
        .mockResolvedValue(freshSnapshot); // subsequent captures for ranking etc.

      mockContextBuild
        .mockResolvedValueOnce(context)
        .mockResolvedValueOnce(freshContext); // after auto-delivery refresh

      // PlayerService.deliverLoadForUser succeeds
      (PlayerService.deliverLoadForUser as any).mockResolvedValue({
        payment: 25,
        updatedMoney: 75,
        newCard: { id: 99, demands: [{ city: 'Paris', loadType: 'Steel', payment: 30 }] },
      });

      // LLM plans a new route after delivery
      const newRoute: StrategicRoute = {
        stops: [{ action: 'pickup', loadType: 'Steel', city: 'Ruhr' }],
        currentStopIndex: 0,
        phase: 'build' as const,
        reasoning: 'New trip after delivery',
        createdAtTurn: 5,
      };
      mockPlanRoute.mockResolvedValue({
        route: newRoute,
        model: 'claude-sonnet-4-20250514',
        latencyMs: 400,
        llmLog: [],
      });

      mockTurnExecutorPlannerExecute.mockResolvedValue(mockTurnExecResult({
        plan: { type: AIActionType.BuildTrack, segments: [makeSegment(10, 10, 10, 11)] },
        routeComplete: false,
        routeAbandoned: false,
        updatedRoute: newRoute,
      }));

      const result = await AIStrategyEngine.takeTurn('game-1', 'bot-1');

      // Delivery was executed via PlayerService
      expect(PlayerService.deliverLoadForUser).toHaveBeenCalledWith(
        'game-1',
        snapshot.bot.userId,
        'Berlin',
        'Coal',
        42,
      );

      // Context was refreshed (capture called at least twice: initial + post-delivery)
      const captureCallCount = (mockCapture as jest.MockedFunction<typeof capture>).mock.calls.length;
      expect(captureCallCount).toBeGreaterThanOrEqual(2);

      // TripPlanner was still called (LLM consulted after delivery)
      expect(mockPlanRoute).toHaveBeenCalled();

      // Result should include the auto-delivered load
      expect(result.loadsDelivered).toBeDefined();
      expect(result.loadsDelivered).toContainEqual({
        loadType: 'Coal',
        city: 'Berlin',
        payment: 25,
        cardId: 42,
      });
    });

    it('AC3: BotTurnResult includes delivery payment and cardId from auto-delivered loads', async () => {
      const delivery: DeliveryOpportunity = {
        loadType: 'Steel',
        deliveryCity: 'Berlin',
        payout: 30,
        cardIndex: 77,
      };

      const snapshot = makeSnapshot({
        botConfig: { skillLevel: 'medium' },
        loads: ['Steel'],
        resolvedDemands: [
          { cardId: 77, demands: [{ city: 'Berlin', loadType: 'Steel', payment: 30 }] },
        ],
      } as any);
      const freshSnapshot = makeSnapshot({ botConfig: { skillLevel: 'medium' } } as any);

      mockCapture
        .mockResolvedValueOnce(snapshot)
        .mockResolvedValue(freshSnapshot);
      mockContextBuild
        .mockResolvedValueOnce(makeContext({ canDeliver: [delivery] }))
        .mockResolvedValue(makeContext({ canDeliver: [] }));

      (PlayerService.deliverLoadForUser as any).mockResolvedValue({
        payment: 30,
        updatedMoney: 80,
        newCard: { id: 100, demands: [] },
      });

      mockPlanRoute.mockResolvedValue({ route: null, llmLog: [] });
      mockHeuristicFallback.mockResolvedValue({ success: false });

      const result = await AIStrategyEngine.takeTurn('game-1', 'bot-1');

      expect(result.loadsDelivered).toBeDefined();
      expect(result.loadsDelivered).toContainEqual({
        loadType: 'Steel',
        city: 'Berlin',
        payment: 30,
        cardId: 77,
      });
    });

    it('AC4: auto-delivery failure does not block TripPlanner from executing', async () => {
      const delivery: DeliveryOpportunity = {
        loadType: 'Coal',
        deliveryCity: 'Berlin',
        payout: 25,
        cardIndex: 42,
      };

      const snapshot = makeSnapshot({
        botConfig: { skillLevel: 'medium' },
        loads: ['Coal'],
        resolvedDemands: [
          { cardId: 42, demands: [{ city: 'Berlin', loadType: 'Coal', payment: 25 }] },
        ],
      } as any);

      mockCapture.mockResolvedValue(snapshot);
      mockContextBuild.mockResolvedValue(makeContext({ canDeliver: [delivery] }));

      // PlayerService.deliverLoadForUser throws — simulates delivery failure
      (PlayerService.deliverLoadForUser as any).mockRejectedValue(new Error('Delivery DB error'));

      const newRoute: StrategicRoute = {
        stops: [{ action: 'pickup', loadType: 'Steel', city: 'Ruhr' }],
        currentStopIndex: 0,
        phase: 'build' as const,
        reasoning: 'Fallback route',
        createdAtTurn: 5,
      };
      mockPlanRoute.mockResolvedValue({
        route: newRoute,
        model: 'claude-sonnet-4-20250514',
        latencyMs: 300,
        llmLog: [],
      });

      mockTurnExecutorPlannerExecute.mockResolvedValue(mockTurnExecResult({
        plan: { type: AIActionType.PassTurn },
        routeComplete: false,
        routeAbandoned: false,
        updatedRoute: newRoute,
      }));

      const result = await AIStrategyEngine.takeTurn('game-1', 'bot-1');

      // TripPlanner still called despite delivery failure
      expect(mockPlanRoute).toHaveBeenCalled();
      // No auto-delivered loads since delivery failed
      expect(result.loadsDelivered).toBeUndefined();
    });

    it('AC5: bot with active route at delivery city → no auto-delivery (TripPlanner NOT consulted)', async () => {
      const activeRoute: StrategicRoute = {
        stops: [{ action: 'deliver', loadType: 'Coal', city: 'Berlin', demandCardId: 42, payment: 25 }],
        currentStopIndex: 0,
        phase: 'travel' as const,
        reasoning: 'Delivering coal',
        createdAtTurn: 3,
      };

      mockGetMemory.mockReturnValue({
        ...defaultMemory,
        activeRoute,
        turnsOnRoute: 1,
      });

      const snapshot = makeSnapshot({ botConfig: { skillLevel: 'medium' } } as any);
      mockCapture.mockResolvedValue(snapshot);
      mockContextBuild.mockResolvedValue(makeContext({
        canDeliver: [{ loadType: 'Coal', deliveryCity: 'Berlin', payout: 25, cardIndex: 42 }],
      }));

      mockTurnExecutorPlannerExecute.mockResolvedValue(mockTurnExecResult({
        plan: { type: AIActionType.DeliverLoad, load: 'Coal', city: 'Berlin', cardId: 42, payout: 25 },
        routeComplete: true,
        routeAbandoned: false,
        updatedRoute: activeRoute,
        hasDelivery: true,
      }));

      await AIStrategyEngine.takeTurn('game-1', 'bot-1');

      // When there's an active route, the route executor branch handles delivery
      // (not our JIRA-170 auto-delivery code). The LLM (TripPlanner) is NOT consulted.
      // Auto-delivery (JIRA-170) only fires in the no-active-route branch.
      expect(mockPlanRoute).not.toHaveBeenCalled();
      // TurnExecutorPlanner IS called (for the active route branch)
      expect(mockTurnExecutorPlannerExecute).toHaveBeenCalled();
    });

    it('AC6: bot not at delivery city (canDeliver empty) → normal TripPlanner flow unchanged', async () => {
      const snapshot = makeSnapshot({ botConfig: { skillLevel: 'medium' } } as any);
      const context = makeContext({ canDeliver: [] }); // No deliveries available

      mockCapture.mockResolvedValue(snapshot);
      mockContextBuild.mockResolvedValue(context);

      const newRoute: StrategicRoute = {
        stops: [{ action: 'pickup', loadType: 'Steel', city: 'Ruhr' }],
        currentStopIndex: 0,
        phase: 'build' as const,
        reasoning: 'Plan next trip',
        createdAtTurn: 5,
      };
      mockPlanRoute.mockResolvedValue({
        route: newRoute,
        model: 'claude-sonnet-4-20250514',
        latencyMs: 300,
        llmLog: [],
      });

      mockTurnExecutorPlannerExecute.mockResolvedValue(mockTurnExecResult({
        plan: { type: AIActionType.PassTurn },
        routeComplete: false,
        routeAbandoned: false,
        updatedRoute: newRoute,
      }));

      await AIStrategyEngine.takeTurn('game-1', 'bot-1');

      // Auto-delivery should NOT have been attempted
      expect(PlayerService.deliverLoadForUser).not.toHaveBeenCalled();
      // TripPlanner still consulted normally
      expect(mockPlanRoute).toHaveBeenCalled();
      // capture called only the standard number of times (no extra post-delivery capture)
      // Initial capture + ranking capture(s) — not an extra capture for auto-delivery refresh
    });

    it('AC7: multiple deliverable loads → all auto-delivered before LLM consultation', async () => {
      const deliveries: DeliveryOpportunity[] = [
        { loadType: 'Coal', deliveryCity: 'Berlin', payout: 25, cardIndex: 42 },
        { loadType: 'Steel', deliveryCity: 'Berlin', payout: 20, cardIndex: 43 },
      ];

      const snapshot = makeSnapshot({
        botConfig: { skillLevel: 'medium' },
        loads: ['Coal', 'Steel'],
        resolvedDemands: [
          { cardId: 42, demands: [{ city: 'Berlin', loadType: 'Coal', payment: 25 }] },
          { cardId: 43, demands: [{ city: 'Berlin', loadType: 'Steel', payment: 20 }] },
        ],
      } as any);
      const freshSnapshot = makeSnapshot({ botConfig: { skillLevel: 'medium' } } as any);

      mockCapture
        .mockResolvedValueOnce(snapshot)
        .mockResolvedValue(freshSnapshot);
      mockContextBuild
        .mockResolvedValueOnce(makeContext({ canDeliver: deliveries }))
        .mockResolvedValue(makeContext({ canDeliver: [] }));

      (PlayerService.deliverLoadForUser as any).mockResolvedValue({
        payment: 25,
        updatedMoney: 75,
        newCard: { id: 100, demands: [] },
      });

      mockPlanRoute.mockResolvedValue({ route: null, llmLog: [] });
      mockHeuristicFallback.mockResolvedValue({ success: false });

      const result = await AIStrategyEngine.takeTurn('game-1', 'bot-1');

      // Both deliveries were attempted
      expect(PlayerService.deliverLoadForUser).toHaveBeenCalledTimes(2);
      // Both loads in result
      expect(result.loadsDelivered).toHaveLength(2);
      expect(result.loadsDelivered).toContainEqual({ loadType: 'Coal', city: 'Berlin', payment: 25, cardId: 42 });
      expect(result.loadsDelivered).toContainEqual({ loadType: 'Steel', city: 'Berlin', payment: 25, cardId: 43 });
    });
  });

});
