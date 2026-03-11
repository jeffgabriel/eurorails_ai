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

// Mock PlanExecutor
jest.mock('../../services/ai/PlanExecutor', () => ({
  PlanExecutor: {
    execute: jest.fn(),
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

// Mock TurnComposer — passthrough (TurnComposer has its own test suite)
jest.mock('../../services/ai/TurnComposer', () => ({
  TurnComposer: {
    compose: jest.fn((plan: any) => Promise.resolve({ plan, trace: { inputPlan: [], outputPlan: [], moveBudget: { total: 9, used: 0, wasted: 0 }, a1: { citiesScanned: 0, opportunitiesFound: 0 }, a2: { iterations: 0, terminationReason: 'none' }, a3: { movePreprended: false }, build: { target: null, cost: 0, skipped: true, upgradeConsidered: false }, pickups: [], deliveries: [] } })),
  },
}));

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
  },
}));

// Mock LLMStrategyBrain
jest.mock('../../services/ai/LLMStrategyBrain', () => ({
  LLMStrategyBrain: jest.fn().mockImplementation(() => ({
    decideAction: jest.fn(),
    planRoute: jest.fn(),
    reEvaluateRoute: jest.fn(),
  })),
}));

// ── Imports (after mocks) ─────────────────────────────────────────────────

import { AIStrategyEngine } from '../../services/ai/AIStrategyEngine';
import { capture } from '../../services/ai/WorldSnapshotService';
import { ContextBuilder } from '../../services/ai/ContextBuilder';
import { LLMStrategyBrain } from '../../services/ai/LLMStrategyBrain';
import { ActionResolver } from '../../services/ai/ActionResolver';
import { PlanExecutor } from '../../services/ai/PlanExecutor';
import { TurnComposer } from '../../services/ai/TurnComposer';
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
const mockPlanExecutorExecute = PlanExecutor.execute as jest.MockedFunction<typeof PlanExecutor.execute>;
const mockGetMemory = getMemory as jest.MockedFunction<typeof getMemory>;
const mockHeuristicFallback = ActionResolver.heuristicFallback as jest.MockedFunction<typeof ActionResolver.heuristicFallback>;
const mockUpdateMemory = updateMemory as jest.MockedFunction<typeof updateMemory>;
const mockTurnComposerCompose = TurnComposer.compose as jest.MockedFunction<typeof TurnComposer.compose>;

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
      (() => ({ decideAction: mockDecideAction, planRoute: mockPlanRoute })) as any,
    );
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
      mockPlanExecutorExecute.mockResolvedValue({
        plan: { type: AIActionType.BuildTrack, segments: [seg] },
        routeComplete: false,
        routeAbandoned: false,
        updatedRoute: route,
        description: 'Building toward Berlin',
      });

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
      mockPlanExecutorExecute.mockResolvedValue({
        plan: { type: AIActionType.BuildTrack, segments: [makeSegment(10, 11, 10, 12)] },
        routeComplete: false,
        routeAbandoned: false,
        updatedRoute: route,
        description: 'Building toward Ruhr',
      });

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
    it('should call planRoute during initialBuild when LLM key is present', async () => {
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
      mockPlanRoute.mockResolvedValue({
        route,
        model: 'claude-sonnet-4-20250514',
        latencyMs: 200,
      });

      mockPlanExecutorExecute.mockResolvedValue({
        plan: { type: AIActionType.BuildTrack, segments: [makeSegment(10, 10, 10, 11)] },
        routeComplete: false,
        routeAbandoned: false,
        updatedRoute: route,
        description: 'Building toward Ruhr',
      });

      const result = await AIStrategyEngine.takeTurn('game-1', 'bot-1');

      expect(result.action).toBe(AIActionType.BuildTrack);
      expect(result.reasoning).toContain('route-planned');
      // LLM SHOULD have been called
      expect(LLMStrategyBrain).toHaveBeenCalled();
      expect(mockPlanRoute).toHaveBeenCalled();

      delete process.env.ANTHROPIC_API_KEY;
    });

    it('should try heuristicFallback during initialBuild when planRoute returns null', async () => {
      process.env.ANTHROPIC_API_KEY = 'test-key';

      const snapshot = makeSnapshot({
        botConfig: { skillLevel: 'medium' },
      } as any);
      const context = makeContext({ isInitialBuild: true, canBuild: true });

      mockCapture.mockResolvedValue(snapshot);
      mockContextBuild.mockResolvedValue(context);

      // planRoute fails
      mockPlanRoute.mockResolvedValue({ route: null, llmLog: [] });

      // heuristicFallback also fails → PassTurn
      mockHeuristicFallback.mockResolvedValue({ success: false });

      const result = await AIStrategyEngine.takeTurn('game-1', 'bot-1');

      expect(result.action).toBe(AIActionType.PassTurn);
      expect(result.reasoning).toContain('llm-failed');
      expect(mockPlanRoute).toHaveBeenCalled();
      // heuristicFallback SHOULD have been called before PassTurn
      expect(mockHeuristicFallback).toHaveBeenCalledWith(context, snapshot);

      delete process.env.ANTHROPIC_API_KEY;
    });
  });

  describe('route persistence in BotMemory', () => {
    it('should store activeRoute in memory after successful planRoute', async () => {
      process.env.ANTHROPIC_API_KEY = 'test-key';

      const snapshot = makeSnapshot({
        botConfig: { skillLevel: 'medium' },
      } as any);
      const context = makeContext({ isInitialBuild: true, canBuild: true });

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
      mockPlanExecutorExecute.mockResolvedValue({
        plan: { type: AIActionType.BuildTrack, segments: [makeSegment(10, 10, 10, 11)] },
        routeComplete: false,
        routeAbandoned: false,
        updatedRoute,
        description: 'Building toward Ruhr',
      });

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
      });

      const snapshot = makeSnapshot({
        botConfig: { skillLevel: 'medium' },
      } as any);
      const context = makeContext();
      mockCapture.mockResolvedValue(snapshot);
      mockContextBuild.mockResolvedValue(context);

      // PlanExecutor reports route complete
      mockPlanExecutorExecute.mockResolvedValue({
        plan: { type: AIActionType.DeliverLoad, load: 'Coal', city: 'Berlin', cardId: 1, payout: 25 },
        routeComplete: true,
        routeAbandoned: false,
        updatedRoute: route,
        description: 'Delivered Coal to Berlin',
      });

      await AIStrategyEngine.takeTurn('game-1', 'bot-1');

      expect(mockUpdateMemory).toHaveBeenCalled();
      const patch = mockUpdateMemory.mock.calls[0][2] as any;
      expect(patch.activeRoute).toBeNull();
      expect(patch.turnsOnRoute).toBe(0);
      expect(patch.routeHistory).toBeDefined();
      expect(patch.routeHistory.length).toBeGreaterThan(0);
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
      });

      const snapshot = makeSnapshot({
        botConfig: { skillLevel: 'medium' },
      } as any);
      const context = makeContext();
      mockCapture.mockResolvedValue(snapshot);
      mockContextBuild.mockResolvedValue(context);

      process.env.ANTHROPIC_API_KEY = 'test-key';

      // PlanExecutor returns a build plan
      mockPlanExecutorExecute.mockResolvedValue({
        plan: { type: AIActionType.BuildTrack, segments: [makeSegment(10, 10, 10, 11)] },
        routeComplete: false,
        routeAbandoned: false,
        updatedRoute: route,
        description: 'Building toward Berlin',
      });

      const result = await AIStrategyEngine.takeTurn('game-1', 'bot-1');

      expect(result.action).toBe(AIActionType.BuildTrack);
      expect(result.reasoning).toContain('route-executor');
      // LLM should NOT have been called
      expect(LLMStrategyBrain).not.toHaveBeenCalled();

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
      mockPlanExecutorExecute.mockResolvedValue({
        plan: { type: AIActionType.PassTurn },
        routeComplete: false,
        routeAbandoned: false,
        updatedRoute: route,
        description: 'Building toward Berlin',
      });

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
      expect(mockHeuristicFallback).toHaveBeenCalledWith(context, snapshot);

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
    it('should call planRoute during initialBuild with LLM key', async () => {
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
      mockPlanRoute.mockResolvedValue({
        route,
        model: 'claude-sonnet-4-20250514',
        latencyMs: 200,
      });

      mockPlanExecutorExecute.mockResolvedValue({
        plan: { type: AIActionType.BuildTrack, segments: [makeSegment(10, 11, 10, 12)] },
        routeComplete: false,
        routeAbandoned: false,
        updatedRoute: route,
        description: 'Building toward Ruhr',
      });

      const result = await AIStrategyEngine.takeTurn('game-1', 'bot-1');

      expect(result.action).toBe(AIActionType.BuildTrack);
      expect(result.reasoning).toContain('route-planned');
      // LLM SHOULD have been called during initialBuild
      expect(LLMStrategyBrain).toHaveBeenCalled();
      expect(mockPlanRoute).toHaveBeenCalled();

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
      expect(mockHeuristicFallback).toHaveBeenCalledWith(context, snapshot);

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
      expect(mockHeuristicFallback).toHaveBeenCalledWith(context, snapshot);

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
    it('should clear activeRoute when TurnComposer produces a MultiAction with DeliverLoad', async () => {
      process.env.ANTHROPIC_API_KEY = 'test-key';

      // JIRA-83: preDeliveryRoute is now captured even for route-completing deliveries,
      // so re-eval will fire. Mock it to abandon (route is done).
      (LLMStrategyBrain as any).mockImplementation(() => ({
        decideAction: jest.fn(),
        planRoute: jest.fn(),
        reEvaluateRoute: (jest.fn() as jest.Mock<(...args: any[]) => Promise<any>>).mockResolvedValue({ decision: 'abandon', reasoning: 'route completed' }),
      }));

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
      });

      const snapshot = makeSnapshot({
        botConfig: { skillLevel: 'medium' },
        loads: ['Steel'],
      } as any);
      const context = makeContext({ loads: ['Steel'] });
      mockCapture.mockResolvedValue(snapshot);
      mockContextBuild.mockResolvedValue(context);

      // PlanExecutor returns a move plan (not yet delivering)
      mockPlanExecutorExecute.mockResolvedValue({
        plan: { type: AIActionType.MoveTrain, path: [{ row: 10, col: 10 }, { row: 10, col: 11 }], fees: new Set(), totalFee: 0 },
        routeComplete: false,
        routeAbandoned: false,
        updatedRoute: route,
        description: 'Moving toward Paris',
      });

      // TurnComposer enriches with a delivery step (scanPathOpportunities detected opportunity)
      mockTurnComposerCompose.mockResolvedValue({ plan: {
        type: 'MultiAction' as const,
        steps: [
          { type: AIActionType.MoveTrain, path: [{ row: 10, col: 10 }, { row: 10, col: 11 }], fees: new Set(), totalFee: 0 },
          { type: AIActionType.DeliverLoad, load: 'Steel', city: 'Paris', cardId: 10, payout: 15 },
        ],
      }, trace: {} } as any);

      await AIStrategyEngine.takeTurn('game-1', 'bot-1');

      // Verify activeRoute was cleared (set to null) in memory update
      expect(mockUpdateMemory).toHaveBeenCalled();
      const patch = mockUpdateMemory.mock.calls[0][2] as any;
      // Route should be completed because the delivery matches the last stop
      expect(patch.activeRoute).toBeNull();
      expect(patch.turnsOnRoute).toBe(0);

      delete process.env.ANTHROPIC_API_KEY;
    });

    it('should clear activeRoute for non-route deliveries too (force re-planning)', async () => {
      process.env.ANTHROPIC_API_KEY = 'test-key';

      // JIRA-84: hadDelivery is now true for composed deliveries, triggering re-eval.
      // Mock reEvaluateRoute to abandon (orphaned stops → LLM would abandon).
      (LLMStrategyBrain as any).mockImplementation(() => ({
        decideAction: jest.fn(),
        planRoute: jest.fn(),
        reEvaluateRoute: (jest.fn() as jest.Mock<(...args: any[]) => Promise<any>>).mockResolvedValue({ decision: 'abandon', reasoning: 'orphaned stops' }),
      }));

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
      });

      const snapshot = makeSnapshot({
        botConfig: { skillLevel: 'medium' },
        loads: ['Wine'],
      } as any);
      const context = makeContext({ loads: ['Wine'] });
      mockCapture.mockResolvedValue(snapshot);
      mockContextBuild.mockResolvedValue(context);

      // PlanExecutor returns a build plan
      mockPlanExecutorExecute.mockResolvedValue({
        plan: { type: AIActionType.BuildTrack, segments: [makeSegment(10, 10, 10, 11)] },
        routeComplete: false,
        routeAbandoned: false,
        updatedRoute: route,
        description: 'Building toward Essen',
      });

      // TurnComposer enriches with a delivery for a DIFFERENT load (not on route)
      mockTurnComposerCompose.mockResolvedValue({ plan: {
        type: 'MultiAction' as const,
        steps: [
          { type: AIActionType.BuildTrack, segments: [makeSegment(10, 10, 10, 11)] },
          { type: AIActionType.DeliverLoad, load: 'Wine', city: 'München', cardId: 99, payout: 12 },
        ],
      }, trace: {} } as any);

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
    it('should chain BUILD from heuristicFallback after route completes', async () => {
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
      });

      const snapshot = makeSnapshot({
        botConfig: { skillLevel: 'medium' },
        loads: ['Coal'],
      } as any);
      const context = makeContext({ loads: ['Coal'] });
      mockCapture.mockResolvedValue(snapshot);
      mockContextBuild.mockResolvedValue(context);

      // PlanExecutor returns delivery + routeComplete
      mockPlanExecutorExecute.mockResolvedValue({
        plan: { type: AIActionType.DeliverLoad, load: 'Coal', city: 'Berlin', cardId: 1, payout: 25 },
        routeComplete: true,
        routeAbandoned: false,
        updatedRoute: route,
        description: 'Delivered Coal to Berlin',
      });

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
      });

      const snapshot = makeSnapshot({
        botConfig: { skillLevel: 'medium' },
        loads: ['Coal'],
      } as any);
      const context = makeContext({ loads: ['Coal'] });
      mockCapture.mockResolvedValue(snapshot);
      mockContextBuild.mockResolvedValue(context);

      // PlanExecutor returns delivery + routeComplete
      mockPlanExecutorExecute.mockResolvedValue({
        plan: { type: AIActionType.DeliverLoad, load: 'Coal', city: 'Berlin', cardId: 1, payout: 25 },
        routeComplete: true,
        routeAbandoned: false,
        updatedRoute: route,
        description: 'Delivered Coal to Berlin',
      });

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
      });

      const snapshot = makeSnapshot({
        botConfig: { skillLevel: 'medium' },
      } as any);
      const context = makeContext();
      mockCapture.mockResolvedValue(snapshot);
      mockContextBuild.mockResolvedValue(context);

      // PlanExecutor returns abandoned (not completed)
      mockPlanExecutorExecute.mockResolvedValue({
        plan: { type: AIActionType.PassTurn },
        routeComplete: false,
        routeAbandoned: true,
        updatedRoute: route,
        description: 'Route abandoned — cannot reach pickup',
      });

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

      mockPlanExecutorExecute.mockResolvedValue({
        plan: { type: AIActionType.BuildTrack, segments: [makeSegment(10, 10, 10, 11)] },
        routeComplete: false,
        routeAbandoned: false,
        updatedRoute: route,
        description: 'Building toward Berlin',
      });

      const result = await AIStrategyEngine.takeTurn('game-1', 'bot-1');

      expect(result.model).toBe('claude-sonnet-4-20250514');
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
      });

      const snapshot = makeSnapshot({
        botConfig: { skillLevel: 'medium' },
      } as any);
      const context = makeContext();
      mockCapture.mockResolvedValue(snapshot);
      mockContextBuild.mockResolvedValue(context);

      mockPlanExecutorExecute.mockResolvedValue({
        plan: { type: AIActionType.BuildTrack, segments: [makeSegment(10, 10, 10, 11)] },
        routeComplete: false,
        routeAbandoned: false,
        updatedRoute: route,
        description: 'Building toward Berlin',
      });

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
      // Reset TurnComposer to passthrough (clearAllMocks doesn't reset mockResolvedValue)
      mockTurnComposerCompose.mockImplementation((plan: any) => Promise.resolve({ plan, trace: { inputPlan: [], outputPlan: [], moveBudget: { total: 9, used: 0, wasted: 0 }, a1: { citiesScanned: 0, opportunitiesFound: 0 }, a2: { iterations: 0, terminationReason: 'none' }, a3: { movePreprended: false }, build: { target: null, cost: 0, skipped: true, upgradeConsidered: false }, pickups: [], deliveries: [] } }));
    });

    it('should store remaining route stops in memory when delivery clears active route', async () => {
      process.env.ANTHROPIC_API_KEY = 'test-key';

      // JIRA-84: hadDelivery is now true for composed deliveries, triggering re-eval.
      // Mock reEvaluateRoute to abandon (orphaned stops → LLM would abandon).
      (LLMStrategyBrain as any).mockImplementation(() => ({
        decideAction: jest.fn(),
        planRoute: jest.fn(),
        reEvaluateRoute: (jest.fn() as jest.Mock<(...args: any[]) => Promise<any>>).mockResolvedValue({ decision: 'abandon', reasoning: 'orphaned stops' }),
      }));

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

      // PlanExecutor returns a move toward Berlin
      mockPlanExecutorExecute.mockResolvedValue({
        plan: { type: AIActionType.MoveTrain, path: [{ row: 10, col: 10 }, { row: 10, col: 11 }], fees: new Set(), totalFee: 0 },
        routeComplete: false,
        routeAbandoned: false,
        updatedRoute: route,
        description: 'Moving toward Berlin',
      });

      // TurnComposer enriches with a delivery that does NOT match the current route stop
      // (non-route delivery, e.g., an opportunistic one)
      mockTurnComposerCompose.mockResolvedValue({ plan: {
        type: 'MultiAction' as const,
        steps: [
          { type: AIActionType.MoveTrain, path: [{ row: 10, col: 10 }, { row: 10, col: 11 }], fees: new Set(), totalFee: 0 },
          { type: AIActionType.DeliverLoad, load: 'Wine', city: 'München', cardId: 99, payout: 12 },
        ],
      }, trace: {} } as any);

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
      mockPlanExecutorExecute.mockResolvedValue({
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
      });

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
      mockPlanExecutorExecute.mockResolvedValue({
        plan: { type: AIActionType.DeliverLoad, load: 'Coal', city: 'Berlin', cardId: 1, payout: 25 },
        routeComplete: true,
        routeAbandoned: false,
        updatedRoute: route,
        description: 'Delivered Coal to Berlin',
      });

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

      mockPlanExecutorExecute.mockResolvedValue({
        plan: { type: AIActionType.BuildTrack, segments: [makeSegment(10, 10, 10, 11)] },
        routeComplete: false,
        routeAbandoned: false,
        updatedRoute: route,
        description: 'Building toward Berlin',
      });

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
      });

      const snapshot = makeSnapshot({
        botConfig: { skillLevel: 'medium' },
      } as any);
      const context = makeContext();
      mockCapture.mockResolvedValue(snapshot);
      mockContextBuild.mockResolvedValue(context);

      mockPlanExecutorExecute.mockResolvedValue({
        plan: { type: AIActionType.MoveTrain, path: [{ row: 10, col: 11 }], fees: new Set<string>(), totalFee: 0 },
        routeComplete: false,
        routeAbandoned: false,
        updatedRoute: route,
        description: 'Moving toward Berlin',
      });

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
      mockPlanExecutorExecute.mockResolvedValue({
        plan: { type: AIActionType.DiscardHand },
        routeComplete: false,
        routeAbandoned: false,
        updatedRoute: route,
        description: 'Discarding hand',
      });

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
      mockPlanExecutorExecute.mockResolvedValue({
        plan: { type: AIActionType.DeliverLoad, load: 'Steel', city: 'Berlin', cardId: 1, payout: 19 },
        routeComplete: true,
        routeAbandoned: false,
        updatedRoute: { ...route, currentStopIndex: 1 },
        description: 'Delivering Steel to Berlin',
      });

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
      mockPlanExecutorExecute.mockResolvedValue({
        plan: { type: AIActionType.DeliverLoad, load: 'Wine', city: 'Praha', cardId: 3, payout: 15 },
        routeComplete: false,
        routeAbandoned: false,
        updatedRoute: route,
        description: 'Delivering Wine to Praha',
      });

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
      mockPlanExecutorExecute.mockResolvedValue({
        plan: { type: AIActionType.BuildTrack, segments: [makeSegment(10, 11, 10, 12, 1)] },
        routeComplete: false,
        routeAbandoned: false,
        updatedRoute: route,
        description: 'Building toward Berlin',
      });

      const mockRebuildDemands = ContextBuilder.rebuildDemands as jest.Mock;

      await AIStrategyEngine.takeTurn('game-1', 'bot-1');

      // JIRA-85: rebuildDemands is now always called for final ranking (unconditional rebuild)
      expect(mockRebuildDemands).toHaveBeenCalledTimes(1);
      // capture called twice: initial + ranking snapshot
      expect(mockCapture).toHaveBeenCalledTimes(2);

      delete process.env.ANTHROPIC_API_KEY;
    });
  });

  describe('JIRA-64 Part 2: post-delivery LLM re-evaluation', () => {
    /** Helper: set up a delivery scenario with active route and API key */
    function setupDeliveryWithRoute() {
      process.env.ANTHROPIC_API_KEY = 'test-key';

      const route: StrategicRoute = {
        stops: [
          { action: 'deliver', loadType: 'Steel', city: 'Berlin', demandCardId: 1, payment: 19 },
          { action: 'pickup', loadType: 'Coal', city: 'Essen' },
          { action: 'deliver', loadType: 'Coal', city: 'Roma', demandCardId: 2, payment: 28 },
        ],
        currentStopIndex: 1,
        phase: 'travel' as const,
        createdAtTurn: 3,
        reasoning: 'test',
      };

      mockGetMemory.mockReturnValue({
        turnNumber: 7,
        noProgressTurns: 0,
        consecutiveDiscards: 0,
        lastAction: AIActionType.MoveTrain,
        activeRoute: route,
        turnsOnRoute: 4,
        routeHistory: [],
        deliveryCount: 1,
        totalEarnings: 19,
        currentBuildTarget: null,
        turnsOnTarget: 0,
      });

      const snapshot = makeSnapshot({
        botConfig: { skillLevel: 'medium', provider: 'anthropic' },
        loads: ['Steel'],
      } as any);
      const context = makeContext({
        demands: [
          {
            cardIndex: 0, loadType: 'Coal', supplyCity: 'Essen', deliveryCity: 'Roma',
            payout: 28, isSupplyReachable: true, isDeliveryReachable: false,
            isSupplyOnNetwork: true, isDeliveryOnNetwork: false,
            estimatedTrackCostToSupply: 0, estimatedTrackCostToDelivery: 10,
            isLoadAvailable: true, isLoadOnTrain: false, ferryRequired: false,
            loadChipTotal: 4, loadChipCarried: 0, estimatedTurns: 5,
            demandScore: 6, efficiencyPerTurn: 1.2, networkCitiesUnlocked: 0, victoryMajorCitiesEnRoute: 0,
          },
        ] as any[],
      });
      mockCapture.mockResolvedValue(snapshot);
      mockContextBuild.mockResolvedValue(context);

      // Set up delivery execution
      const gridMap = new Map();
      gridMap.set('10,10', { row: 10, col: 10, name: 'Berlin', terrain: 2 });
      (loadGridPoints as any).mockReturnValue(gridMap);
      (PlayerService.deliverLoadForUser as any).mockResolvedValue({
        payment: 19,
        updatedMoney: 69,
        newCard: { id: 50, demands: [] },
      });

      mockPlanExecutorExecute.mockResolvedValue({
        plan: { type: AIActionType.DeliverLoad, load: 'Steel', city: 'Berlin', cardId: 1, payout: 19 },
        routeComplete: false,
        routeAbandoned: false,
        updatedRoute: route,
        description: 'Delivering Steel to Berlin',
      });

      // Rebuild demands returns refreshed list including Coal
      (ContextBuilder.rebuildDemands as jest.Mock).mockReturnValue([
        {
          cardIndex: 0, loadType: 'Coal', supplyCity: 'Essen', deliveryCity: 'Roma',
          payout: 28, isSupplyReachable: true, isDeliveryReachable: false,
          isSupplyOnNetwork: true, isDeliveryOnNetwork: false,
          estimatedTrackCostToSupply: 0, estimatedTrackCostToDelivery: 10,
          isLoadAvailable: true, isLoadOnTrain: false, ferryRequired: false,
          loadChipTotal: 4, loadChipCarried: 0, estimatedTurns: 5,
          demandScore: 6, efficiencyPerTurn: 1.2, networkCitiesUnlocked: 0, victoryMajorCitiesEnRoute: 0,
        },
      ]);

      return route;
    }

    afterEach(() => {
      delete process.env.ANTHROPIC_API_KEY;
    });

    it('should continue route when re-evaluation returns "continue"', async () => {
      setupDeliveryWithRoute();

      const mockReEval = jest.fn<(...args: any[]) => Promise<any>>().mockResolvedValue({
        decision: 'continue',
        reasoning: 'Current route is still optimal',
      });
      (LLMStrategyBrain as unknown as jest.MockedClass<typeof LLMStrategyBrain>).mockImplementation(
        (() => ({ decideAction: jest.fn(), planRoute: jest.fn(), reEvaluateRoute: mockReEval })) as any,
      );

      await AIStrategyEngine.takeTurn('game-1', 'bot-1');

      expect(mockReEval).toHaveBeenCalled();
      // Route should NOT be cleared (continue)
      const patch = mockUpdateMemory.mock.calls[0][2] as any;
      expect(patch.activeRoute).not.toBeNull();
    });

    it('should update route when re-evaluation returns "amend"', async () => {
      setupDeliveryWithRoute();

      const amendedStops = [
        { action: 'pickup', loadType: 'Coal', city: 'Essen' },
        { action: 'deliver', loadType: 'Coal', city: 'Wien', demandCardId: 5, payment: 20 },
      ];

      const mockReEval = jest.fn<(...args: any[]) => Promise<any>>().mockResolvedValue({
        decision: 'amend',
        amendedStops,
        reasoning: 'New card suggests shorter delivery to Wien',
      });
      (LLMStrategyBrain as unknown as jest.MockedClass<typeof LLMStrategyBrain>).mockImplementation(
        (() => ({ decideAction: jest.fn(), planRoute: jest.fn(), reEvaluateRoute: mockReEval })) as any,
      );

      await AIStrategyEngine.takeTurn('game-1', 'bot-1');

      expect(mockReEval).toHaveBeenCalled();
      const patch = mockUpdateMemory.mock.calls[0][2] as any;
      // Route should be updated with amended stops
      expect(patch.activeRoute).toBeDefined();
      expect(patch.activeRoute.stops).toEqual(amendedStops);
      expect(patch.activeRoute.currentStopIndex).toBe(0);
    });

    it('should clear route when re-evaluation returns "abandon"', async () => {
      setupDeliveryWithRoute();

      const mockReEval = jest.fn<(...args: any[]) => Promise<any>>().mockResolvedValue({
        decision: 'abandon',
        reasoning: 'New demand card is much better than current route',
      });
      (LLMStrategyBrain as unknown as jest.MockedClass<typeof LLMStrategyBrain>).mockImplementation(
        (() => ({ decideAction: jest.fn(), planRoute: jest.fn(), reEvaluateRoute: mockReEval })) as any,
      );

      await AIStrategyEngine.takeTurn('game-1', 'bot-1');

      expect(mockReEval).toHaveBeenCalled();
      const patch = mockUpdateMemory.mock.calls[0][2] as any;
      expect(patch.activeRoute).toBeNull();
      expect(patch.turnsOnRoute).toBe(0);
    });

    it('should continue route when re-evaluation returns null (LLM failure)', async () => {
      setupDeliveryWithRoute();

      const mockReEval = jest.fn<(...args: any[]) => Promise<any>>().mockResolvedValue(null);
      (LLMStrategyBrain as unknown as jest.MockedClass<typeof LLMStrategyBrain>).mockImplementation(
        (() => ({ decideAction: jest.fn(), planRoute: jest.fn(), reEvaluateRoute: mockReEval })) as any,
      );

      await AIStrategyEngine.takeTurn('game-1', 'bot-1');

      expect(mockReEval).toHaveBeenCalled();
      // Route should NOT be cleared (null = continue)
      const patch = mockUpdateMemory.mock.calls[0][2] as any;
      expect(patch.activeRoute).not.toBeNull();
    });

    it('should continue route when re-evaluation throws', async () => {
      setupDeliveryWithRoute();

      const mockReEval = jest.fn<(...args: any[]) => Promise<any>>().mockRejectedValue(new Error('LLM timeout'));
      (LLMStrategyBrain as unknown as jest.MockedClass<typeof LLMStrategyBrain>).mockImplementation(
        (() => ({ decideAction: jest.fn(), planRoute: jest.fn(), reEvaluateRoute: mockReEval })) as any,
      );

      await AIStrategyEngine.takeTurn('game-1', 'bot-1');

      expect(mockReEval).toHaveBeenCalled();
      // Route should NOT be cleared (error = continue)
      const patch = mockUpdateMemory.mock.calls[0][2] as any;
      expect(patch.activeRoute).not.toBeNull();
    });

    it('should NOT call reEvaluateRoute when no active route', async () => {
      process.env.ANTHROPIC_API_KEY = 'test-key';

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
      });

      const snapshot = makeSnapshot({
        botConfig: { skillLevel: 'medium', provider: 'anthropic' },
        loads: ['Steel'],
      } as any);
      const context = makeContext();
      mockCapture.mockResolvedValue(snapshot);
      mockContextBuild.mockResolvedValue(context);

      // Set up delivery
      const gridMap = new Map();
      gridMap.set('10,10', { row: 10, col: 10, name: 'Berlin', terrain: 2 });
      (loadGridPoints as any).mockReturnValue(gridMap);
      (PlayerService.deliverLoadForUser as any).mockResolvedValue({
        payment: 19,
        updatedMoney: 69,
        newCard: { id: 50, demands: [] },
      });

      // Route planning returns a new route (since no active route)
      const route: StrategicRoute = {
        stops: [{ action: 'pickup', loadType: 'Coal', city: 'Essen' }],
        currentStopIndex: 0,
        phase: 'build' as const,
        createdAtTurn: 5,
        reasoning: 'test',
      };
      mockPlanRoute.mockResolvedValue({
        route,
        model: 'claude-sonnet-4-20250514',
        latencyMs: 500,
      });
      mockPlanExecutorExecute.mockResolvedValue({
        plan: { type: AIActionType.BuildTrack, segments: [makeSegment(10, 11, 10, 12, 1)] },
        routeComplete: false,
        routeAbandoned: false,
        updatedRoute: route,
        description: 'Building toward Essen',
      });

      (ContextBuilder.rebuildDemands as jest.Mock).mockReturnValue([]);

      const mockReEval = jest.fn();
      (LLMStrategyBrain as unknown as jest.MockedClass<typeof LLMStrategyBrain>).mockImplementation(
        (() => ({ decideAction: jest.fn(), planRoute: mockPlanRoute, reEvaluateRoute: mockReEval })) as any,
      );

      await AIStrategyEngine.takeTurn('game-1', 'bot-1');

      // reEvaluateRoute should NOT have been called (no active route at delivery time)
      expect(mockReEval).not.toHaveBeenCalled();
    });
  });

  describe('JIRA-83: preDeliveryRoute captured for route-completing deliveries', () => {
    it('should set preDeliveryRoute when routeWasCompleted=true so re-eval can fire', async () => {
      process.env.ANTHROPIC_API_KEY = 'test-key';

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
        deliveryCount: 0,
        totalEarnings: 0,
        currentBuildTarget: null,
        turnsOnTarget: 0,
      });

      const snapshot = makeSnapshot({ botConfig: { skillLevel: 'medium' }, loads: ['Steel'] } as any);
      const context = makeContext({ loads: ['Steel'] });
      mockCapture.mockResolvedValue(snapshot);
      mockContextBuild.mockResolvedValue(context);

      mockPlanExecutorExecute.mockResolvedValue({
        plan: { type: AIActionType.MoveTrain, path: [{ row: 10, col: 10 }, { row: 10, col: 11 }], fees: new Set(), totalFee: 0 },
        routeComplete: false,
        routeAbandoned: false,
        updatedRoute: route,
        description: 'Moving toward Paris',
      });

      // TurnComposer produces delivery (last stop → routeWasCompleted)
      mockTurnComposerCompose.mockResolvedValue({ plan: {
        type: 'MultiAction' as const,
        steps: [
          { type: AIActionType.MoveTrain, path: [{ row: 10, col: 10 }, { row: 10, col: 11 }], fees: new Set(), totalFee: 0 },
          { type: AIActionType.DeliverLoad, load: 'Steel', city: 'Paris', cardId: 10, payout: 15 },
        ],
      }, trace: { inputPlan: [], outputPlan: [], moveBudget: { total: 9, used: 2, wasted: 0 }, a1: { citiesScanned: 0, opportunitiesFound: 0 }, a2: { iterations: 0, terminationReason: 'none' }, a3: { movePreprended: false }, build: { target: null, cost: 0, skipped: true, upgradeConsidered: false }, pickups: [], deliveries: [] } } as any);

      // Mock reEvaluateRoute to verify it gets called with the completed route
      const mockReEval = jest.fn<(...args: any[]) => Promise<any>>().mockResolvedValue({
        decision: 'abandon',
        reasoning: 'route completed, need new plan',
      });
      (LLMStrategyBrain as any).mockImplementation(() => ({
        decideAction: jest.fn(),
        planRoute: jest.fn(),
        reEvaluateRoute: mockReEval,
      }));

      await AIStrategyEngine.takeTurn('game-1', 'bot-1');

      // Re-eval should have been called because preDeliveryRoute was captured
      // even though routeWasCompleted=true
      expect(mockReEval).toHaveBeenCalled();

      delete process.env.ANTHROPIC_API_KEY;
    });
  });

  describe('JIRA-83: Post-composition re-eval with A2 "no valid target"', () => {
    function setupA2NoTargetScenario() {
      process.env.ANTHROPIC_API_KEY = 'test-key';

      const route: StrategicRoute = {
        stops: [
          { action: 'deliver', loadType: 'Steel', city: 'Berlin', demandCardId: 1, payment: 19 },
          { action: 'pickup', loadType: 'Coal', city: 'Essen' },
        ],
        currentStopIndex: 0,
        phase: 'travel' as const,
        createdAtTurn: 3,
        reasoning: 'test',
      };

      mockGetMemory.mockReturnValue({
        turnNumber: 7,
        noProgressTurns: 0,
        consecutiveDiscards: 0,
        lastAction: AIActionType.MoveTrain,
        activeRoute: route,
        turnsOnRoute: 4,
        routeHistory: [],
        deliveryCount: 1,
        totalEarnings: 19,
        currentBuildTarget: null,
        turnsOnTarget: 0,
      });

      const snapshot = makeSnapshot({ botConfig: { skillLevel: 'medium', provider: 'anthropic' }, loads: ['Steel'] } as any);
      const context = makeContext({
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

      mockPlanExecutorExecute.mockResolvedValue({
        plan: { type: AIActionType.DeliverLoad, load: 'Steel', city: 'Berlin', cardId: 1, payout: 19 },
        routeComplete: false,
        routeAbandoned: false,
        updatedRoute: route,
        description: 'Delivering Steel to Berlin',
      });

      const gridMap = new Map();
      gridMap.set('10,10', { row: 10, col: 10, name: 'Berlin', terrain: 2 });
      (loadGridPoints as any).mockReturnValue(gridMap);
      (PlayerService.deliverLoadForUser as any).mockResolvedValue({
        payment: 19, updatedMoney: 69, newCard: { id: 50, demands: [] },
      });

      // TurnComposer produces delivery + A2 "no valid target" with wasted budget
      mockTurnComposerCompose.mockResolvedValue({ plan: {
        type: 'MultiAction' as const,
        steps: [
          { type: AIActionType.DeliverLoad, load: 'Steel', city: 'Berlin', cardId: 1, payout: 19 },
        ],
      }, trace: {
        inputPlan: ['DeliverLoad'], outputPlan: ['DeliverLoad'],
        moveBudget: { total: 9, used: 2, wasted: 7 },
        a1: { citiesScanned: 0, opportunitiesFound: 0 },
        a2: { iterations: 1, terminationReason: 'no valid target' },
        a3: { movePreprended: false },
        build: { target: null, cost: 0, skipped: true, upgradeConsidered: false },
        pickups: [], deliveries: [{ load: 'Steel', city: 'Berlin' }],
      } } as any);

      return route;
    }

    afterEach(() => {
      delete process.env.ANTHROPIC_API_KEY;
    });

    it('should call reEvaluateRoute when A2 terminates with "no valid target" and budget remains', async () => {
      setupA2NoTargetScenario();

      const mockReEval = jest.fn<(...args: any[]) => Promise<any>>().mockResolvedValue({
        decision: 'amend',
        amendedStops: [{ action: 'pickup', loadType: 'Coal', city: 'Essen' }],
        reasoning: 'Pickup coal next',
      });
      (LLMStrategyBrain as any).mockImplementation(() => ({
        decideAction: jest.fn(),
        planRoute: jest.fn(),
        reEvaluateRoute: mockReEval,
      }));

      await AIStrategyEngine.takeTurn('game-1', 'bot-1');

      expect(mockReEval).toHaveBeenCalled();
    });

    it('should skip re-eval when plan already has queued DELIVER step', async () => {
      setupA2NoTargetScenario();

      // Override TurnComposer to include TWO DELIVER steps
      mockTurnComposerCompose.mockResolvedValue({ plan: {
        type: 'MultiAction' as const,
        steps: [
          { type: AIActionType.DeliverLoad, load: 'Steel', city: 'Berlin', cardId: 1, payout: 19 },
          { type: AIActionType.DeliverLoad, load: 'Coal', city: 'Essen', cardId: 2, payout: 28 },
        ],
      }, trace: {
        inputPlan: ['DeliverLoad'], outputPlan: ['DeliverLoad', 'DeliverLoad'],
        moveBudget: { total: 9, used: 2, wasted: 7 },
        a1: { citiesScanned: 0, opportunitiesFound: 0 },
        a2: { iterations: 1, terminationReason: 'no valid target' },
        a3: { movePreprended: false },
        build: { target: null, cost: 0, skipped: true, upgradeConsidered: false },
        pickups: [], deliveries: [{ load: 'Steel', city: 'Berlin' }, { load: 'Coal', city: 'Essen' }],
      } } as any);

      const mockReEval = jest.fn();
      (LLMStrategyBrain as any).mockImplementation(() => ({
        decideAction: jest.fn(),
        planRoute: jest.fn(),
        reEvaluateRoute: mockReEval,
      }));

      await AIStrategyEngine.takeTurn('game-1', 'bot-1');

      // Re-eval should NOT be called — plan already has productive queued delivery
      expect(mockReEval).not.toHaveBeenCalled();
    });

    it('should gracefully fallback when re-eval throws an error', async () => {
      setupA2NoTargetScenario();

      const mockReEval = jest.fn<(...args: any[]) => Promise<any>>().mockRejectedValue(
        new Error('LLM API timeout'),
      );
      (LLMStrategyBrain as any).mockImplementation(() => ({
        decideAction: jest.fn(),
        planRoute: jest.fn(),
        reEvaluateRoute: mockReEval,
      }));

      // Should not throw — graceful fallback keeps existing plan
      const result = await AIStrategyEngine.takeTurn('game-1', 'bot-1');
      expect(result.success).toBe(true);
    });
  });
});
