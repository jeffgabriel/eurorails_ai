/**
 * AIStrategyEngine bearer-auth tests
 *
 * Tests AC3, AC4, AC6, and createBrain/hasLLMApiKey behavior for the
 * ANTHROPIC_AUTH_TOKEN opt-in bearer-token path.
 *
 * Because hasLLMApiKey and resolveAnthropicCredential are private statics,
 * we test them indirectly:
 *   - AC4 (neither set → LLM not used): verify LLMStrategyBrain is not constructed
 *   - AC3/hasLLMApiKey true paths: verify LLMStrategyBrain IS constructed with
 *     the correct credential and authMode
 *   - AC6 (Google provider, ANTHROPIC_AUTH_TOKEN set): verify GoogleAdapter receives
 *     GOOGLE_AI_API_KEY and bearer mode never reaches it
 */

import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';

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

jest.mock('../../services/playerService', () => ({
  PlayerService: {
    setPlayerPosition: jest.fn<() => Promise<any>>().mockResolvedValue(undefined),
    getPlayers: jest.fn<() => Promise<any>>().mockResolvedValue([]),
    updatePlayer: jest.fn<() => Promise<any>>().mockResolvedValue(undefined),
  },
}));

jest.mock('../../services/ai/WorldSnapshotService', () => ({
  capture: jest.fn(),
}));

jest.mock('../../services/ai/ContextBuilder', () => ({
  ContextBuilder: {
    build: jest.fn(),
    serializePrompt: jest.fn(() => 'serialized-prompt'),
    serializeRoutePlanningPrompt: jest.fn(() => 'route-planning-prompt'),
  },
}));

jest.mock('../../services/ai/BotMemory', () => ({
  getMemory: jest.fn(() => ({
    activeRoute: null,
    lastAbandonedRouteKey: null,
    consecutiveLLMFailures: 0,
    discardedOnTurn: null,
  })),
  updateMemory: jest.fn(),
}));

jest.mock('../../services/ai/DecisionLogger', () => ({
  initTurnLog: jest.fn(() => ({ turnId: 'test-turn' })),
  logPhase: jest.fn(),
  flushTurnLog: jest.fn(),
}));

jest.mock('../../services/ai/LLMTranscriptLogger', () => ({
  appendLLMCall: jest.fn(),
}));

jest.mock('../../services/ai/ActionResolver', () => ({
  ActionResolver: {
    resolve: jest.fn(),
    heuristicFallback: jest.fn(),
  },
}));

jest.mock('../../services/ai/RouteEnrichmentAdvisor', () => ({
  RouteEnrichmentAdvisor: {
    enrich: jest.fn(async (route: unknown) => route),
  },
}));

jest.mock('../../services/ai/TurnExecutorPlanner', () => ({
  TurnExecutorPlanner: {
    execute: jest.fn(),
  },
}));

jest.mock('../../services/ai/GuardrailEnforcer', () => ({
  GuardrailEnforcer: {
    checkPlan: jest.fn((plan: unknown) => plan),
  },
}));

jest.mock('../../services/ai/InitialBuildPlanner', () => ({
  InitialBuildPlanner: {
    plan: jest.fn(),
  },
}));

jest.mock('../../services/ai/RouteValidator', () => ({
  RouteValidator: {
    validate: jest.fn(() => ({ valid: true, errors: [] })),
  },
}));

jest.mock('../../services/ai/BuildAdvisor', () => ({
  BuildAdvisor: {
    advise: jest.fn(),
    computeUpgradeAdvice: jest.fn(() => undefined),
  },
}));

// Mock LLMStrategyBrain — spy on constructor args (AC3, AC5)
jest.mock('../../services/ai/LLMStrategyBrain', () => ({
  LLMStrategyBrain: jest.fn().mockImplementation(() => ({
    decideAction: jest.fn(),
    planRoute: jest.fn<(...args: any[]) => Promise<any>>().mockResolvedValue(null),
    modelName: 'claude-haiku-4-5-20251001',
    providerAdapter: {
      resetCallIds: jest.fn(),
      getCallIds: jest.fn(() => []),
      getCallSummaries: jest.fn(() => []),
    },
  })),
}));

// ── Imports (after mocks) ──────────────────────────────────────────────────

import { AIStrategyEngine } from '../../services/ai/AIStrategyEngine';
import { capture } from '../../services/ai/WorldSnapshotService';
import { ContextBuilder } from '../../services/ai/ContextBuilder';
import { LLMStrategyBrain } from '../../services/ai/LLMStrategyBrain';
import { TurnExecutorPlanner } from '../../services/ai/TurnExecutorPlanner';
import { db } from '../../db/index';
import {
  AIActionType,
  WorldSnapshot,
  GameContext,
  BotSkillLevel,
  LLMProvider,
  TrainType,
  TerrainType,
  TrackSegment,
} from '../../../shared/types/GameTypes';

const mockCapture = capture as jest.MockedFunction<typeof capture>;
const mockContextBuild = ContextBuilder.build as jest.MockedFunction<typeof ContextBuilder.build>;
const mockQuery = db.query as unknown as jest.Mock<(...args: any[]) => Promise<any>>;
const mockConnect = (db as any).connect as unknown as jest.Mock<() => Promise<any>>;
const mockTurnExecutorPlannerExecute = TurnExecutorPlanner.execute as jest.MockedFunction<typeof TurnExecutorPlanner.execute>;

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
      botConfig: { skillLevel: BotSkillLevel.Medium, provider: LLMProvider.Anthropic },
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

const defaultCompositionTrace = {
  stage: 'A3',
  A1result: null,
  A2result: null,
  A3result: null,
  finalAction: AIActionType.PassTurn,
};

describe('AIStrategyEngine — bearer auth (AC3, AC4, AC6, AC8)', () => {
  let savedAuthToken: string | undefined;
  let savedApiKey: string | undefined;
  let savedGoogleKey: string | undefined;
  let mockClient: any;

  beforeEach(() => {
    jest.clearAllMocks();

    // Stash and clear env vars before each test
    savedAuthToken = process.env.ANTHROPIC_AUTH_TOKEN;
    savedApiKey = process.env.ANTHROPIC_API_KEY;
    savedGoogleKey = process.env.GOOGLE_AI_API_KEY;
    delete process.env.ANTHROPIC_AUTH_TOKEN;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.GOOGLE_AI_API_KEY;

    mockClient = {
      query: jest.fn<(...args: any[]) => Promise<any>>().mockResolvedValue(mockResult([])),
      release: jest.fn<() => void>(),
    };
    mockConnect.mockResolvedValue(mockClient);
    mockQuery.mockResolvedValue(mockResult([]));

    (LLMStrategyBrain as unknown as jest.MockedClass<typeof LLMStrategyBrain>).mockImplementation(
      (() => ({
        decideAction: jest.fn(),
        planRoute: jest.fn<(...args: any[]) => Promise<any>>().mockResolvedValue(null),
        modelName: 'claude-haiku-4-5-20251001',
        providerAdapter: {
          resetCallIds: jest.fn(),
          getCallIds: jest.fn(() => []),
          getCallSummaries: jest.fn(() => []),
        },
      })) as any,
    );

    mockTurnExecutorPlannerExecute.mockResolvedValue({
      plans: [{ type: AIActionType.PassTurn }],
      updatedRoute: { stops: [], currentStopIndex: 0, phase: 'build' as const, createdAtTurn: 0 },
      compositionTrace: defaultCompositionTrace,
      routeComplete: false,
      routeAbandoned: false,
      hasDelivery: false,
    } as any);
  });

  afterEach(() => {
    // Restore original env vars
    if (savedAuthToken !== undefined) {
      process.env.ANTHROPIC_AUTH_TOKEN = savedAuthToken;
    } else {
      delete process.env.ANTHROPIC_AUTH_TOKEN;
    }
    if (savedApiKey !== undefined) {
      process.env.ANTHROPIC_API_KEY = savedApiKey;
    } else {
      delete process.env.ANTHROPIC_API_KEY;
    }
    if (savedGoogleKey !== undefined) {
      process.env.GOOGLE_AI_API_KEY = savedGoogleKey;
    } else {
      delete process.env.GOOGLE_AI_API_KEY;
    }
  });

  // AC4: neither env var set → bot does not attempt LLM
  it('AC4: with neither ANTHROPIC_AUTH_TOKEN nor ANTHROPIC_API_KEY set, LLMStrategyBrain is NOT constructed', async () => {
    const snapshot = makeSnapshot({ botConfig: { skillLevel: BotSkillLevel.Medium, provider: LLMProvider.Anthropic } });
    const context = makeContext();
    mockCapture.mockResolvedValue(snapshot);
    mockContextBuild.mockResolvedValue(context);

    const result = await AIStrategyEngine.takeTurn('game-1', 'bot-1');

    // Bot falls through to PassTurn because hasLLMApiKey returns false
    expect(result.action).toBe(AIActionType.PassTurn);
    expect(LLMStrategyBrain).not.toHaveBeenCalled();
  });

  // hasLLMApiKey true — only ANTHROPIC_API_KEY set: LLM brain constructed with api-key mode
  it('only ANTHROPIC_API_KEY set: LLMStrategyBrain constructed with apiKey and authMode=api-key', async () => {
    process.env.ANTHROPIC_API_KEY = 'key-ABC';

    const snapshot = makeSnapshot({ botConfig: { skillLevel: BotSkillLevel.Medium, provider: LLMProvider.Anthropic } });
    const context = makeContext();
    mockCapture.mockResolvedValue(snapshot);
    mockContextBuild.mockResolvedValue(context);

    await AIStrategyEngine.takeTurn('game-1', 'bot-1');

    expect(LLMStrategyBrain).toHaveBeenCalled();
    const constructorArg = (LLMStrategyBrain as unknown as jest.MockedClass<typeof LLMStrategyBrain>).mock.calls[0][0];
    expect(constructorArg.apiKey).toBe('key-ABC');
    expect(constructorArg.authMode).toBe('api-key');
  });

  // AC3: both set → bearer wins
  it('AC3: both ANTHROPIC_AUTH_TOKEN and ANTHROPIC_API_KEY set: LLMStrategyBrain constructed with token and authMode=bearer', async () => {
    process.env.ANTHROPIC_AUTH_TOKEN = 'tok-XYZ';
    process.env.ANTHROPIC_API_KEY = 'key-ABC';

    const snapshot = makeSnapshot({ botConfig: { skillLevel: BotSkillLevel.Medium, provider: LLMProvider.Anthropic } });
    const context = makeContext();
    mockCapture.mockResolvedValue(snapshot);
    mockContextBuild.mockResolvedValue(context);

    await AIStrategyEngine.takeTurn('game-1', 'bot-1');

    expect(LLMStrategyBrain).toHaveBeenCalled();
    const constructorArg = (LLMStrategyBrain as unknown as jest.MockedClass<typeof LLMStrategyBrain>).mock.calls[0][0];
    // Bearer token wins over api-key
    expect(constructorArg.apiKey).toBe('tok-XYZ');
    expect(constructorArg.authMode).toBe('bearer');
  });

  // Only ANTHROPIC_AUTH_TOKEN set: brain constructed with token and bearer mode
  it('only ANTHROPIC_AUTH_TOKEN set: LLMStrategyBrain constructed with token and authMode=bearer', async () => {
    process.env.ANTHROPIC_AUTH_TOKEN = 'tok-ONLY';

    const snapshot = makeSnapshot({ botConfig: { skillLevel: BotSkillLevel.Medium, provider: LLMProvider.Anthropic } });
    const context = makeContext();
    mockCapture.mockResolvedValue(snapshot);
    mockContextBuild.mockResolvedValue(context);

    await AIStrategyEngine.takeTurn('game-1', 'bot-1');

    expect(LLMStrategyBrain).toHaveBeenCalled();
    const constructorArg = (LLMStrategyBrain as unknown as jest.MockedClass<typeof LLMStrategyBrain>).mock.calls[0][0];
    expect(constructorArg.apiKey).toBe('tok-ONLY');
    expect(constructorArg.authMode).toBe('bearer');
  });

  // AC6: Google provider — ANTHROPIC_AUTH_TOKEN present does not affect Google credential lookup
  it('AC6: provider=Google with ANTHROPIC_AUTH_TOKEN set still uses GOOGLE_AI_API_KEY (no bearer mode for Google)', async () => {
    process.env.ANTHROPIC_AUTH_TOKEN = 'tok-should-be-ignored';
    process.env.GOOGLE_AI_API_KEY = 'google-key-123';

    const snapshot = makeSnapshot({
      botConfig: { skillLevel: BotSkillLevel.Medium, provider: LLMProvider.Google },
    });
    const context = makeContext();
    mockCapture.mockResolvedValue(snapshot);
    mockContextBuild.mockResolvedValue(context);

    await AIStrategyEngine.takeTurn('game-1', 'bot-1');

    expect(LLMStrategyBrain).toHaveBeenCalled();
    const constructorArg = (LLMStrategyBrain as unknown as jest.MockedClass<typeof LLMStrategyBrain>).mock.calls[0][0];
    expect(constructorArg.apiKey).toBe('google-key-123');
    expect(constructorArg.authMode).toBeUndefined();
  });
});
