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
    query: jest.fn(),
    connect: jest.fn(),
  },
}));

// Mock socketService
jest.mock('../../services/socketService', () => ({
  emitTurnChange: jest.fn(),
  emitStatePatch: jest.fn().mockResolvedValue(undefined),
  emitToGame: jest.fn(),
  getSocketIO: jest.fn().mockReturnValue(null),
}));

// Mock MapTopology (loaded by OptionGenerator, Scorer, computeBuildSegments)
jest.mock('../../services/ai/MapTopology', () => ({
  loadGridPoints: jest.fn(() => {
    const map = new Map();
    // Paris major city and surroundings for pathfinding
    map.set('29,32', { row: 29, col: 32, terrain: 6, name: 'Paris' });
    map.set('29,31', { row: 29, col: 31, terrain: 1 });
    map.set('28,32', { row: 28, col: 32, terrain: 1 });
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
  _resetCache: jest.fn(),
}));

// Mock computeBuildSegments to control what segments the bot gets
jest.mock('../../services/ai/computeBuildSegments', () => ({
  computeBuildSegments: jest.fn(),
}));

// Mock majorCityGroups
jest.mock('../../../shared/services/majorCityGroups', () => ({
  getMajorCityGroups: jest.fn(() => [
    { cityName: 'Paris', center: { row: 29, col: 32 }, outposts: [] },
    { cityName: 'Berlin', center: { row: 20, col: 50 }, outposts: [] },
  ]),
}));

import { db } from '../../db/index';
import { emitToGame } from '../../services/socketService';
import { AIStrategyEngine } from '../../services/ai/AIStrategyEngine';
import { computeBuildSegments } from '../../services/ai/computeBuildSegments';
import { AIActionType, TerrainType, TrackSegment } from '../../../shared/types/GameTypes';

const mockQuery = db.query as jest.MockedFunction<typeof db.query>;
const mockConnect = (db as any).connect as jest.MockedFunction<any>;
const mockEmitToGame = emitToGame as jest.MockedFunction<typeof emitToGame>;
const mockComputeBuild = computeBuildSegments as jest.MockedFunction<typeof computeBuildSegments>;

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

  beforeEach(() => {
    jest.clearAllMocks();

    // Set up mock transaction client
    mockClient = {
      query: jest.fn().mockResolvedValue(mockResult([])),
      release: jest.fn(),
    };
    mockConnect.mockResolvedValue(mockClient);
  });

  function setupWorldSnapshotQuery(overrides?: any) {
    // WorldSnapshotService.capture: single JOIN query returning all players
    mockQuery.mockResolvedValueOnce(mockResult([
      {
        game_status: 'active',
        player_id: botId,
        money: 50,
        position_row: 29,
        position_col: 32,
        train_type: 'Freight',
        hand: [],
        loads: [],
        is_bot: true,
        bot_config: JSON.stringify({ skillLevel: 'medium', archetype: 'balanced' }),
        current_turn_number: 3,
        segments: JSON.stringify([]),
        ...overrides,
      },
      {
        game_status: 'active',
        player_id: 'human-1',
        money: 40,
        position_row: 20,
        position_col: 50,
        train_type: 'Freight',
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
      setupWorldSnapshotQuery();

      const result = await AIStrategyEngine.takeTurn(gameId, botId);

      // Verify BuildTrack was chosen
      expect(result.action).toBe(AIActionType.BuildTrack);
      expect(result.success).toBe(true);
      expect(result.segmentsBuilt).toBe(1);
      expect(result.cost).toBe(1);

      // Verify UPSERT to player_tracks via transaction client
      const upsertCall = mockClient.query.mock.calls.find(
        (call: any[]) => typeof call[0] === 'string' && call[0].includes('INSERT INTO player_tracks'),
      );
      expect(upsertCall).toBeDefined();

      // Verify money deduction (UPDATE players SET money)
      const moneyCall = mockClient.query.mock.calls.find(
        (call: any[]) => typeof call[0] === 'string' && call[0].includes('UPDATE players SET money'),
      );
      expect(moneyCall).toBeDefined();
      expect(moneyCall[1][0]).toBe(1); // cost
      expect(moneyCall[1][1]).toBe(botId); // player_id

      // Verify audit log (INSERT INTO bot_turn_audits)
      const auditCall = mockClient.query.mock.calls.find(
        (call: any[]) => typeof call[0] === 'string' && call[0].includes('bot_turn_audits'),
      );
      expect(auditCall).toBeDefined();
      const auditParams = auditCall[1];
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

      // Verify transaction management (BEGIN + COMMIT)
      const queries = mockClient.query.mock.calls.map((c: any[]) => c[0]);
      expect(queries[0]).toBe('BEGIN');
      expect(queries[queries.length - 1]).toBe('COMMIT');
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

      // Verify UPSERT contains both existing and new segments
      const upsertCall = mockClient.query.mock.calls.find(
        (call: any[]) => typeof call[0] === 'string' && call[0].includes('INSERT INTO player_tracks'),
      );
      expect(upsertCall).toBeDefined();
      const segments = JSON.parse(upsertCall[1][2]);
      expect(segments).toEqual([existingSeg, newSeg]);
    });
  });

  describe('fallback to PassTurn', () => {
    it('should fall back to PassTurn when no segments can be built', async () => {
      mockComputeBuild.mockReturnValue([]); // No buildable segments
      setupWorldSnapshotQuery();

      const result = await AIStrategyEngine.takeTurn(gameId, botId);

      expect(result.action).toBe(AIActionType.PassTurn);
      expect(result.cost).toBe(0);
      expect(result.segmentsBuilt).toBe(0);
    });

    it('should fall back to PassTurn when bot has no money', async () => {
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

      // Make the transaction UPSERT fail — TurnExecutor will throw
      mockClient.query
        .mockResolvedValueOnce(mockResult([])) // BEGIN
        .mockRejectedValueOnce(new Error('DB write failed')); // UPSERT fails
      // Subsequent calls (ROLLBACK, etc.) fall back to default mockResolvedValue

      const result = await AIStrategyEngine.takeTurn(gameId, botId);

      // Pipeline failed, fell back to PassTurn via retry/fallback
      expect(result.action).toBe(AIActionType.PassTurn);
      expect(result.cost).toBe(0);
    });
  });

  describe('initial build phase', () => {
    it('should build from major city when bot has no existing track', async () => {
      const seg = makeSegment(29, 32, 29, 31, 1);
      mockComputeBuild.mockReturnValue([seg]);
      setupWorldSnapshotQuery({
        game_status: 'initialBuild',
        segments: JSON.stringify([]),
      });

      const result = await AIStrategyEngine.takeTurn(gameId, botId);

      // computeBuildSegments should have been called (OptionGenerator called it)
      expect(mockComputeBuild).toHaveBeenCalled();
      // First arg is start positions - should include major city centers
      const [startPositions] = mockComputeBuild.mock.calls[0];
      expect(startPositions.length).toBeGreaterThan(0);

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
      expect(positionUpdate[1][4]).toBe(botId); // player_id
    });
  });

  describe('socket events', () => {
    it('should NOT emit track:updated on PassTurn', async () => {
      mockComputeBuild.mockReturnValue([]);
      setupWorldSnapshotQuery();

      await AIStrategyEngine.takeTurn(gameId, botId);

      const trackUpdatedCalls = mockEmitToGame.mock.calls.filter(
        (call: any[]) => call[1] === 'track:updated',
      );
      expect(trackUpdatedCalls).toHaveLength(0);
    });

    it('should emit track:updated with correct payload on BuildTrack', async () => {
      const seg = makeSegment(29, 32, 29, 31, 1);
      mockComputeBuild.mockReturnValue([seg]);
      setupWorldSnapshotQuery();

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
      mockComputeBuild.mockReturnValue([]);
      setupWorldSnapshotQuery();

      const result = await AIStrategyEngine.takeTurn(gameId, botId);

      expect(result.durationMs).toBeGreaterThanOrEqual(0);
      expect(typeof result.durationMs).toBe('number');
    });
  });
});
