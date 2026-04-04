import { describe, it, expect, beforeEach, jest } from '@jest/globals';

/**
 * Integration test: Bot Build Track Flow
 *
 * Tests the full AI pipeline from AIStrategyEngine.takeTurn through
 * to TurnExecutor, verifying that bots correctly build track, money
 * is deducted, audit logs are created, and socket events fire.
 * Uses mocked DB and socket to verify the full pipeline.
 */

// Mock db before importing services
jest.mock('../../db/index', () => ({
  db: {
    query: jest.fn<() => Promise<any>>(),
    connect: jest.fn<() => Promise<any>>(),
  },
}));

// Mock socketService
jest.mock('../../services/socketService', () => ({
  emitTurnChange: jest.fn<() => void>(),
  emitStatePatch: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
  emitToGame: jest.fn<() => void>(),
  getSocketIO: jest.fn<() => any>().mockReturnValue(null),
}));

// Mock MapTopology (loaded by ActionResolver, ContextBuilder, computeBuildSegments)
jest.mock('../../services/ai/MapTopology', () => ({
  loadGridPoints: jest.fn(() => {
    const map = new Map();
    // Paris major city and surroundings for pathfinding
    map.set('29,32', { row: 29, col: 32, terrain: 6, name: 'Paris' });
    map.set('29,31', { row: 29, col: 31, terrain: 1 });
    map.set('28,32', { row: 28, col: 32, terrain: 1 });
    // Berlin major city (demand target)
    map.set('20,50', { row: 20, col: 50, terrain: 6, name: 'Berlin' });
    map.set('20,49', { row: 20, col: 49, terrain: 1 });
    return map;
  }),
  getHexNeighbors: jest.fn((row: number, col: number) => {
    // Return simple neighbors for Paris area
    if (row === 29 && col === 32) return [{ row: 29, col: 31 }, { row: 28, col: 32 }];
    if (row === 29 && col === 31) return [{ row: 29, col: 32 }, { row: 28, col: 32 }];
    return [];
  }),
  getTerrainCost: jest.fn((terrain: number) => {
    if (terrain === 6) return 5; // MajorCity
    return 1; // Clear
  }),
  gridToPixel: jest.fn(() => ({ x: 100, y: 200 })),
  hexDistance: jest.fn((r1: number, c1: number, r2: number, c2: number) => {
    return Math.abs(r1 - r2) + Math.abs(c1 - c2);
  }),
  makeKey: jest.fn((row: number, col: number) => `${row},${col}`),
  isWater: jest.fn(() => false),
  getFerryPairPort: jest.fn(() => null),
  estimateHopDistance: jest.fn(() => 10),
  estimatePathCost: jest.fn(() => 5),
  computeLandmass: jest.fn(() => new Set<string>()),
  computeFerryRouteInfo: jest.fn(() => ({ canCrossFerry: false, departurePorts: [], arrivalPorts: [], cheapestFerryCost: Infinity })),
  _resetCache: jest.fn(),
}));

// Mock computeBuildSegments to control what segments the bot gets
jest.mock('../../services/ai/computeBuildSegments', () => ({
  computeBuildSegments: jest.fn(),
}));

// Mock majorCityGroups — outposts are the buildable entry points around a city center
jest.mock('../../../shared/services/majorCityGroups', () => ({
  getMajorCityGroups: jest.fn(() => [
    { cityName: 'Paris', center: { row: 29, col: 32 }, outposts: [{ row: 29, col: 31 }, { row: 28, col: 32 }] },
    { cityName: 'Berlin', center: { row: 20, col: 50 }, outposts: [{ row: 20, col: 49 }] },
  ]),
  getMajorCityLookup: jest.fn(() => {
    const m = new Map();
    m.set('29,32', 'Paris');
    m.set('29,31', 'Paris');
    m.set('28,32', 'Paris');
    m.set('20,50', 'Berlin');
    m.set('20,49', 'Berlin');
    return m;
  }),
  getFerryEdges: jest.fn(() => []),
}));

// Mock connectedMajorCities (used by WorldSnapshotService)
jest.mock('../../services/ai/connectedMajorCities', () => ({
  getConnectedMajorCityCount: jest.fn(() => 0),
}));

// Mock BotMemory to inject active routes so PlanExecutor drives decisions
// (heuristic fallback was removed in BE-002; without an LLM key or active route, bot passes)
jest.mock('../../services/ai/BotMemory', () => ({
  getMemory: jest.fn(),
  updateMemory: jest.fn(),
  clearMemory: jest.fn(),
}));

// Mock trackUsageFees (used by ActionResolver for movement validation)
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

// Mock TrackNetworkService (used by ContextBuilder for reachability)
jest.mock('../../../shared/services/TrackNetworkService', () => ({
  buildTrackNetwork: jest.fn(() => ({
    nodes: new Set<string>(),
    edges: new Map<string, Set<string>>(),
  })),
}));

// Mock DemandDeckService (used by WorldSnapshotService for demand resolution)
jest.mock('../../services/demandDeckService', () => ({
  DemandDeckService: {
    getInstance: jest.fn(() => ({
      getCard: jest.fn((cardId: number) => {
        if (cardId === 1) {
          return {
            id: 1,
            demands: [
              { city: 'Berlin', resource: 'Steel', payment: 50 },
            ],
          };
        }
        return undefined;
      }),
    })),
  },
}));

// Mock LoadService (used by WorldSnapshotService and ContextBuilder)
jest.mock('../../services/loadService', () => ({
  LoadService: {
    getInstance: jest.fn(() => ({
      getAvailableLoadsForCity: jest.fn(() => []),
      getSourceCitiesForLoad: jest.fn(() => ['Berlin']),
      isLoadAvailableAtCity: jest.fn(() => false),
    })),
  },
}));

// Mock PlayerService (used by TurnExecutor for MoveTrain, BuildTrack, etc.)
jest.mock('../../services/playerService', () => ({
  PlayerService: {
    moveTrainForUser: jest.fn(),
    updateCurrentPlayerIndex: jest.fn(),
    buildTrackForPlayer: jest.fn<(...args: any[]) => Promise<any>>().mockResolvedValue({ remainingMoney: 47 }),
    getPlayers: jest.fn<(...args: any[]) => Promise<any>>().mockResolvedValue([]),
  },
}));

import { db } from '../../db/index';
import { emitToGame } from '../../services/socketService';
import { AIStrategyEngine } from '../../services/ai/AIStrategyEngine';
import { computeBuildSegments } from '../../services/ai/computeBuildSegments';
import { getMemory, updateMemory } from '../../services/ai/BotMemory';
import { PlayerService } from '../../services/playerService';
import { AIActionType, TerrainType, TrackSegment, StrategicRoute } from '../../../shared/types/GameTypes';

const mockQuery = db.query as unknown as jest.Mock<(...args: any[]) => Promise<any>>;
const mockConnect = (db as any).connect as unknown as jest.Mock<() => Promise<any>>;
const mockEmitToGame = emitToGame as jest.MockedFunction<typeof emitToGame>;
const mockComputeBuild = computeBuildSegments as jest.MockedFunction<typeof computeBuildSegments>;
const mockGetMemory = getMemory as jest.MockedFunction<typeof getMemory>;
const mockBuildTrackForPlayer = PlayerService.buildTrackForPlayer as jest.Mock<(...args: any[]) => Promise<any>>;

/** Default route targeting Berlin (not on network) — drives PlanExecutor to BUILD */
function makeBuildRoute(): StrategicRoute {
  return {
    stops: [
      { action: 'pickup', loadType: 'Steel', city: 'Berlin' },
      { action: 'deliver', loadType: 'Steel', city: 'Paris', demandCardId: 1, payment: 50 },
    ],
    currentStopIndex: 0,
    phase: 'build',
    createdAtTurn: 1,
    reasoning: 'Test route for integration',
  };
}

function mockResult(rows: any[]) {
  return { rows, command: '', rowCount: rows.length, oid: 0, fields: [] };
}

function makeSegment(fromRow: number, fromCol: number, toRow: number, toCol: number, cost: number): TrackSegment {
  return {
    from: { x: 0, y: 0, row: fromRow, col: fromCol, terrain: TerrainType.MajorCity },
    to: { x: 0, y: 0, row: toRow, col: toCol, terrain: TerrainType.Clear },
    cost,
  };
}

describe('Bot Build Track Flow (Integration)', () => {
  const gameId = 'game-build-1';
  const botId = 'bot-paris';
  let mockClient: any;
  const originalAnthropicKey = process.env.ANTHROPIC_API_KEY;
  const originalGoogleKey = process.env.GOOGLE_AI_API_KEY;

  beforeEach(() => {
    jest.clearAllMocks();
    // Remove API keys so bot won't attempt real LLM calls
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.GOOGLE_AI_API_KEY;

    // Default db.query return — returns valid snapshot data so any capture() call
    // (including the rankingSnapshot at JIRA-85 line 611) gets valid rows.
    // Audit INSERTs ignore the return value, so this is safe as default.
    mockQuery.mockResolvedValue(mockResult([
      {
        game_status: 'active',
        player_id: botId,
        user_id: 'user-bot-paris',
        money: 50,
        position_row: 29,
        position_col: 32,
        train_type: 'freight',
        hand: [1],
        loads: [],
        is_bot: true,
        bot_config: JSON.stringify({ skillLevel: 'medium' }),
        current_turn_number: 3,
        segments: JSON.stringify([]),
      },
      {
        game_status: 'active',
        player_id: 'human-1',
        user_id: 'user-human-1',
        money: 40,
        position_row: 20,
        position_col: 50,
        train_type: 'freight',
        hand: [],
        loads: [],
        is_bot: false,
        bot_config: null,
        current_turn_number: 3,
        segments: JSON.stringify([]),
      },
    ]));

    // Set up mock transaction client
    mockClient = {
      query: jest.fn<() => Promise<any>>().mockResolvedValue(mockResult([])),
      release: jest.fn<() => void>(),
    };
    mockConnect.mockResolvedValue(mockClient);

    // Default memory: active route targeting Berlin (drives PlanExecutor BUILD decisions)
    mockGetMemory.mockReturnValue({
      currentBuildTarget: null,
      turnsOnTarget: 0,
      lastAction: null,
      noProgressTurns: 0,
      consecutiveDiscards: 0,
      deliveryCount: 0,
      totalEarnings: 0,
      turnNumber: 2,
      activeRoute: makeBuildRoute(),
      turnsOnRoute: 1,
      routeHistory: [],
      lastReasoning: null,
      lastPlanHorizon: null,
    });
  });

  afterAll(() => {
    // Restore env vars
    if (originalAnthropicKey) process.env.ANTHROPIC_API_KEY = originalAnthropicKey;
    if (originalGoogleKey) process.env.GOOGLE_AI_API_KEY = originalGoogleKey;
  });

  function setupWorldSnapshotQuery(overrides?: any) {
    // WorldSnapshotService.capture: single JOIN query returning all players
    mockQuery.mockResolvedValueOnce(mockResult([
      {
        game_status: 'active',
        player_id: botId,
        user_id: 'user-bot-paris',
        money: 50,
        position_row: 29,
        position_col: 32,
        train_type: 'freight',
        hand: [1],
        loads: [],
        is_bot: true,
        bot_config: JSON.stringify({ skillLevel: 'medium' }),
        current_turn_number: 3,
        segments: JSON.stringify([]),
        ...overrides,
      },
      {
        game_status: 'active',
        player_id: 'human-1',
        user_id: 'user-human-1',
        money: 40,
        position_row: 20,
        position_col: 50,
        train_type: 'freight',
        hand: [],
        loads: [],
        is_bot: false,
        bot_config: null,
        current_turn_number: 3,
        segments: JSON.stringify([]),
      },
    ]));
  }

  describe('happy path — bot builds track', () => {
    it('should build track segments, deduct money, save audit, and emit events', async () => {
      const seg = makeSegment(29, 32, 29, 31, 1);
      mockComputeBuild.mockReturnValue([seg]);
      // PlanExecutor needs existing track to build toward route target
      const existingSeg = makeSegment(29, 32, 28, 32, 1);
      setupWorldSnapshotQuery({ segments: JSON.stringify([existingSeg]) });

      const result = await AIStrategyEngine.takeTurn(gameId, botId);

      // Verify BuildTrack was chosen
      expect(result.action).toBe(AIActionType.BuildTrack);
      expect(result.success).toBe(true);
      expect(result.segmentsBuilt).toBe(1);
      expect(result.cost).toBe(1);

      // Verify PlayerService.buildTrackForPlayer was called with correct params
      expect(mockBuildTrackForPlayer).toHaveBeenCalledTimes(1);
      expect(mockBuildTrackForPlayer).toHaveBeenCalledWith(
        gameId,
        botId,
        [seg],
        [existingSeg],
        1,
      );

      // Verify audit log (INSERT INTO bot_turn_audits) — via db.query (best-effort, post-commit)
      const auditCall = mockQuery.mock.calls.find(
        (call: any[]) => typeof call[0] === 'string' && call[0].includes('bot_turn_audits'),
      );
      expect(auditCall).toBeDefined();
      const auditParams = auditCall![1];
      expect(auditParams[0]).toBe(gameId);
      expect(auditParams[1]).toBe(botId);
      expect(auditParams[3]).toBe('BuildTrack');

      // Verify track:updated socket event (codebase format: {gameId, playerId, timestamp})
      expect(mockEmitToGame).toHaveBeenCalledWith(
        gameId,
        'track:updated',
        expect.objectContaining({
          gameId,
          playerId: botId,
        }),
      );
    });

    it('should append to existing segments when bot already has track', async () => {
      const existingSeg = makeSegment(29, 32, 29, 31, 1);
      const newSeg = makeSegment(29, 31, 28, 32, 1);
      mockComputeBuild.mockReturnValue([newSeg]);
      setupWorldSnapshotQuery({
        segments: JSON.stringify([existingSeg]),
      });

      const result = await AIStrategyEngine.takeTurn(gameId, botId);

      expect(result.action).toBe(AIActionType.BuildTrack);

      // Verify PlayerService received both existing and new segments
      expect(mockBuildTrackForPlayer).toHaveBeenCalledWith(
        gameId,
        botId,
        [newSeg],
        [existingSeg],
        1,
      );
    });
  });

  describe('fallback to PassTurn', () => {
    it('should fall back to PassTurn when no active route and no LLM key', async () => {
      // No active route → no LLM key → PassTurn
      mockGetMemory.mockReturnValue({
        currentBuildTarget: null, turnsOnTarget: 0, lastAction: null,
        noProgressTurns: 0, consecutiveDiscards: 0, deliveryCount: 0,
        totalEarnings: 0, turnNumber: 2, activeRoute: null, turnsOnRoute: 0,
        routeHistory: [], lastReasoning: null, lastPlanHorizon: null,
      });
      mockComputeBuild.mockReturnValue([]);
      setupWorldSnapshotQuery();

      const result = await AIStrategyEngine.takeTurn(gameId, botId);

      expect(result.action).toBe(AIActionType.PassTurn);
      expect(result.cost).toBe(0);
      expect(result.segmentsBuilt).toBe(0);
    });

    it('should fall back to PassTurn when bot has no money and build fails', async () => {
      mockComputeBuild.mockReturnValue([]);
      setupWorldSnapshotQuery({ money: 0 });

      const result = await AIStrategyEngine.takeTurn(gameId, botId);

      expect(result.action).toBe(AIActionType.PassTurn);
      expect(result.cost).toBe(0);
    });

    it('should fall back to PassTurn on execution failure', async () => {
      const seg = makeSegment(29, 32, 29, 31, 1);
      mockComputeBuild.mockReturnValue([seg]);
      setupWorldSnapshotQuery();

      // Make PlayerService.buildTrackForPlayer fail — TurnExecutor will throw
      mockBuildTrackForPlayer.mockRejectedValueOnce(new Error('DB write failed'));

      const result = await AIStrategyEngine.takeTurn(gameId, botId);

      // Pipeline failed, fell back to PassTurn via retry/fallback
      expect(result.action).toBe(AIActionType.PassTurn);
      expect(result.cost).toBe(0);
    });
  });

  describe('initial build phase', () => {
    it('should build track during initialBuild using active route', async () => {
      // PlanExecutor: isInitialBuild + Berlin not on network → BUILD toward Berlin
      const seg = makeSegment(29, 32, 29, 31, 1);
      mockComputeBuild.mockReturnValue([seg]);
      setupWorldSnapshotQuery({
        game_status: 'initialBuild',
        segments: JSON.stringify([]),
      });

      const result = await AIStrategyEngine.takeTurn(gameId, botId);

      expect(result.action).toBe(AIActionType.BuildTrack);
      expect(result.success).toBe(true);
    });

    it('should build track during initial phase when bot has existing segments', async () => {
      const existingSeg = makeSegment(29, 32, 28, 32, 1);
      const newSeg = makeSegment(28, 32, 29, 31, 1);
      mockComputeBuild.mockReturnValue([newSeg]);
      setupWorldSnapshotQuery({
        game_status: 'initialBuild',
        segments: JSON.stringify([existingSeg]),
      });

      const result = await AIStrategyEngine.takeTurn(gameId, botId);

      expect(mockComputeBuild).toHaveBeenCalled();
      expect(result.action).toBe(AIActionType.BuildTrack);
      expect(result.success).toBe(true);
    });
  });

  describe('auto-placement', () => {
    it('should auto-place bot at nearest major city when no position but has track', async () => {
      const existingSeg = makeSegment(29, 32, 29, 31, 1);
      mockComputeBuild.mockReturnValue([]);
      setupWorldSnapshotQuery({
        position_row: null,
        position_col: null,
        segments: JSON.stringify([existingSeg]),
      });

      await AIStrategyEngine.takeTurn(gameId, botId);

      // Should have called UPDATE players SET position_row
      const positionUpdate = mockQuery.mock.calls.find(
        (call: any[]) => typeof call[0] === 'string' && call[0].includes('UPDATE players SET position_row'),
      );
      expect(positionUpdate).toBeDefined();
      expect(positionUpdate![1][4]).toBe(botId); // player_id
    });
  });

  describe('socket events', () => {
    it('should NOT emit track:updated on PassTurn', async () => {
      // No active route → PassTurn
      mockGetMemory.mockReturnValue({
        currentBuildTarget: null, turnsOnTarget: 0, lastAction: null,
        noProgressTurns: 0, consecutiveDiscards: 0, deliveryCount: 0,
        totalEarnings: 0, turnNumber: 2, activeRoute: null, turnsOnRoute: 0,
        routeHistory: [], lastReasoning: null, lastPlanHorizon: null,
      });
      mockComputeBuild.mockReturnValue([]);
      setupWorldSnapshotQuery();

      await AIStrategyEngine.takeTurn(gameId, botId);

      const trackUpdatedCalls = mockEmitToGame.mock.calls.filter(
        (call: any[]) => call[1] === 'track:updated',
      );
      expect(trackUpdatedCalls).toHaveLength(0);
    });

    it('should emit track:updated with correct payload on BuildTrack', async () => {
      // Active route drives BUILD toward Berlin → track:updated emitted
      const existingSeg = makeSegment(29, 32, 28, 32, 1);
      const seg = makeSegment(28, 32, 29, 31, 1);
      mockComputeBuild.mockReturnValue([seg]);
      setupWorldSnapshotQuery({ segments: JSON.stringify([existingSeg]) });

      await AIStrategyEngine.takeTurn(gameId, botId);

      expect(mockEmitToGame).toHaveBeenCalledWith(
        gameId,
        'track:updated',
        expect.objectContaining({
          gameId,
          playerId: botId,
        }),
      );
    });
  });

  describe('duration tracking', () => {
    it('should include durationMs in result', async () => {
      // No active route → PassTurn (simplest path for timing test)
      mockGetMemory.mockReturnValue({
        currentBuildTarget: null, turnsOnTarget: 0, lastAction: null,
        noProgressTurns: 0, consecutiveDiscards: 0, deliveryCount: 0,
        totalEarnings: 0, turnNumber: 2, activeRoute: null, turnsOnRoute: 0,
        routeHistory: [], lastReasoning: null, lastPlanHorizon: null,
      });
      mockComputeBuild.mockReturnValue([]);
      setupWorldSnapshotQuery();

      const result = await AIStrategyEngine.takeTurn(gameId, botId);

      expect(result.durationMs).toBeGreaterThanOrEqual(0);
      expect(typeof result.durationMs).toBe('number');
    });
  });
});
