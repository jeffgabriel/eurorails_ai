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
  },
}));

// Mock BotMemory
jest.mock('../../services/ai/BotMemory', () => ({
  getMemory: jest.fn(() => ({
    turnNumber: 0,
    consecutivePassTurns: 0,
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
  },
}));

// Mock TurnComposer — passthrough (TurnComposer has its own test suite)
jest.mock('../../services/ai/TurnComposer', () => ({
  TurnComposer: {
    compose: jest.fn((plan: any) => Promise.resolve(plan)),
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
  },
}));

// Mock LLMStrategyBrain
jest.mock('../../services/ai/LLMStrategyBrain', () => ({
  LLMStrategyBrain: jest.fn().mockImplementation(() => ({
    decideAction: jest.fn(),
    planRoute: jest.fn(),
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
  let mockPlanRoute: jest.Mock<() => Promise<any>>;

  beforeEach(() => {
    jest.clearAllMocks();

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
    mockPlanRoute = jest.fn<() => Promise<any>>().mockResolvedValue(null);
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
    it('should force DELIVER when LLM chose BUILD but delivery is available', async () => {
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

      // LLM chose BUILD, but guardrail should override to DELIVER
      mockDecideAction.mockResolvedValue({
        plan: { type: AIActionType.BuildTrack, segments: [makeSegment(10, 11, 10, 12)] },
        reasoning: 'Extend network',
        planHorizon: '3 turns',
        model: 'claude-sonnet-4-20250514',
        latencyMs: 300,
        retried: false,
      });

      const result = await AIStrategyEngine.takeTurn('game-1', 'bot-1');

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

    it('should PassTurn during initialBuild when planRoute returns null', async () => {
      process.env.ANTHROPIC_API_KEY = 'test-key';

      const snapshot = makeSnapshot({
        botConfig: { skillLevel: 'medium' },
      } as any);
      const context = makeContext({ isInitialBuild: true, canBuild: true });

      mockCapture.mockResolvedValue(snapshot);
      mockContextBuild.mockResolvedValue(context);

      // planRoute fails
      mockPlanRoute.mockResolvedValue(null);

      const result = await AIStrategyEngine.takeTurn('game-1', 'bot-1');

      expect(result.action).toBe(AIActionType.PassTurn);
      expect(result.reasoning).toContain('llm-failed');
      expect(mockPlanRoute).toHaveBeenCalled();
      // heuristicFallback should NOT have been called
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
        consecutivePassTurns: 0,
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
        consecutivePassTurns: 0,
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
        consecutivePassTurns: 0,
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

    it('should PassTurn when route planning fails (no heuristic fallback)', async () => {
      // Reset memory to default (no active route)
      mockGetMemory.mockReturnValue({
        turnNumber: 0,
        consecutivePassTurns: 0,
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
      mockPlanRoute.mockResolvedValue(null);

      const result = await AIStrategyEngine.takeTurn('game-1', 'bot-1');

      expect(result.action).toBe(AIActionType.PassTurn);
      expect(result.reasoning).toContain('llm-failed');
      expect(mockPlanRoute).toHaveBeenCalled();
      // heuristicFallback should NOT have been called
      expect(mockHeuristicFallback).not.toHaveBeenCalled();

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

  describe('LLM failure → PassTurn (BE-002)', () => {
    it('should PassTurn when LLM planRoute returns null — not heuristic fallback', async () => {
      process.env.ANTHROPIC_API_KEY = 'test-key';

      mockGetMemory.mockReturnValue({
        turnNumber: 5,
        consecutivePassTurns: 0,
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
      mockPlanRoute.mockResolvedValue(null);

      const result = await AIStrategyEngine.takeTurn('game-1', 'bot-1');

      // Should be PassTurn, not a heuristic fallback action
      expect(result.action).toBe(AIActionType.PassTurn);
      expect(result.reasoning).toContain('llm-failed');
      expect(result.reasoning).not.toContain('heuristic');

      // heuristicFallback should NOT have been called
      expect(mockHeuristicFallback).not.toHaveBeenCalled();

      delete process.env.ANTHROPIC_API_KEY;
    });
  });

  describe('delivery clears active route (BE-004/BE-006)', () => {
    it('should clear activeRoute when TurnComposer produces a MultiAction with DeliverLoad', async () => {
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
        consecutivePassTurns: 0,
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
      mockTurnComposerCompose.mockResolvedValue({
        type: 'MultiAction' as const,
        steps: [
          { type: AIActionType.MoveTrain, path: [{ row: 10, col: 10 }, { row: 10, col: 11 }], fees: new Set(), totalFee: 0 },
          { type: AIActionType.DeliverLoad, load: 'Steel', city: 'Paris', cardId: 10, payout: 15 },
        ],
      });

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
        consecutivePassTurns: 0,
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
      mockTurnComposerCompose.mockResolvedValue({
        type: 'MultiAction' as const,
        steps: [
          { type: AIActionType.BuildTrack, segments: [makeSegment(10, 10, 10, 11)] },
          { type: AIActionType.DeliverLoad, load: 'Wine', city: 'München', cardId: 99, payout: 12 },
        ],
      });

      await AIStrategyEngine.takeTurn('game-1', 'bot-1');

      // Even though the delivery doesn't match the route stop, the route should
      // be cleared because a delivery means a new demand card was drawn
      expect(mockUpdateMemory).toHaveBeenCalled();
      const patch = mockUpdateMemory.mock.calls[0][2] as any;
      expect(patch.activeRoute).toBeNull();

      delete process.env.ANTHROPIC_API_KEY;
    });
  });
});
