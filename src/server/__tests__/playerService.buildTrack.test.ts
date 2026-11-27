import { PlayerService } from '../services/playerService';
import { TrackSegment } from '../../shared/types/TrackTypes';
import { TerrainType } from '../../shared/types/GameTypes';

/**
 * Transaction behaviour of PlayerService.buildTrackForPlayer (the bot build
 * path) against a mocked database: locking, the UPSERT, the charge, rollback.
 * The build rules themselves are covered in trackBuild.test.ts, and the whole
 * path against a real database in trackBuildRoutes.integration.test.ts.
 */

// Mock the database module
jest.mock('../db/index', () => {
  const mockClient = {
    query: jest.fn(),
    release: jest.fn(),
  };
  return {
    db: {
      connect: jest.fn().mockResolvedValue(mockClient),
      query: jest.fn().mockResolvedValue({ rows: [] }),
    },
    __mockClient: mockClient,
  };
});

const { __mockClient: mockClient } = jest.requireMock('../db/index') as {
  __mockClient: { query: jest.Mock; release: jest.Mock };
};
const mockPool = (jest.requireMock('../db/index') as { db: { query: jest.Mock } }).db;

function segment(
  from: [number, number],
  to: [number, number],
  terrain: TerrainType,
  cost: number,
): TrackSegment {
  return {
    from: { x: 0, y: 0, row: from[0], col: from[1], terrain: TerrainType.MajorCity },
    to: { x: 0, y: 0, row: to[0], col: to[1], terrain },
    cost,
  };
}

describe('PlayerService.buildTrackForPlayer', () => {
  const gameId = 'game-123';
  const playerId = 'player-456';

  // Real mileposts: (41,42) is a Milano milepost; its neighbours (40,42) and
  // (41,43) are mountain (2M) and (40,43) is alpine (5M).
  const existingSegments: TrackSegment[] = [segment([41, 42], [40, 42], TerrainType.Mountain, 2)];
  // The caller's costs are deliberately wrong: the server must ignore them.
  const newSegments: TrackSegment[] = [
    segment([41, 42], [41, 43], TerrainType.Mountain, 0),
    segment([41, 42], [40, 43], TerrainType.Alpine, 99),
  ];
  const serverCost = 7; // 2 (mountain) + 5 (alpine)

  /** Answer the queries buildTrackForPlayer makes, by the SQL they contain. */
  function mockDatabase(opts: {
    money?: number | null;
    stored?: TrackSegment[];
    failOn?: { sql: string; message: string };
  } = {}): void {
    const { money = 50, stored = existingSegments, failOn } = opts;
    mockClient.query.mockImplementation((sql: string, params?: unknown[]) => {
      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return Promise.resolve();
      if (failOn && sql.includes(failOn.sql)) return Promise.reject(new Error(failOn.message));
      if (sql.includes('SELECT money')) {
        return Promise.resolve({ rows: money === null ? [] : [{ money, current_turn_number: 3 }] });
      }
      if (sql.includes('FROM player_tracks')) {
        return Promise.resolve({
          rows: stored.length === 0
            ? []
            : [{ player_id: playerId, segments: stored, turn_build_cost: 0, pending_flood_rebuilds: [] }],
        });
      }
      if (sql.includes('UPDATE players SET money')) {
        return Promise.resolve({ rows: [{ money: money! - Number(params?.[0]) }] });
      }
      return Promise.resolve({ rows: [] });
    });
  }

  function queryCall(fragment: string): unknown[] | undefined {
    return mockClient.query.mock.calls.find(
      (call: unknown[]) => typeof call[0] === 'string' && call[0].includes(fragment),
    );
  }

  beforeEach(() => {
    jest.clearAllMocks();
    mockDatabase();
  });

  describe('happy path', () => {
    it('builds track, charges the recomputed cost and commits', async () => {
      const result = await PlayerService.buildTrackForPlayer(gameId, playerId, newSegments);

      expect(result.cost).toBe(serverCost);
      expect(result.remainingMoney).toBe(50 - serverCost);
      expect(result.segments.map((seg: TrackSegment): number => seg.cost)).toEqual([2, 5]);
      expect(mockClient.query).toHaveBeenCalledWith('BEGIN');
      expect(mockClient.query).toHaveBeenCalledWith('COMMIT');
      expect(mockClient.release).toHaveBeenCalled();
    });

    it('locks the player row and every track row in the game', async () => {
      await PlayerService.buildTrackForPlayer(gameId, playerId, newSegments);

      expect(queryCall('SELECT money')![0]).toContain('FOR UPDATE');
      const trackRead = queryCall('FROM player_tracks')!;
      expect(trackRead[0]).toContain('FOR UPDATE');
      expect(trackRead[1]).toEqual([gameId]);
    });

    it('UPSERTs the track read from the database plus the new sections', async () => {
      await PlayerService.buildTrackForPlayer(gameId, playerId, newSegments);

      const upsertCall = queryCall('INSERT INTO player_tracks')!;
      expect(upsertCall[0]).toContain('ON CONFLICT');
      const params = upsertCall[1] as unknown[];
      expect(params[0]).toBe(gameId);                  // $1 game_id
      expect(params[1]).toBe(playerId);                // $2 player_id
      const parsed = JSON.parse(params[2] as string);  // $3 segments JSON
      expect(parsed).toHaveLength(3);                  // 1 stored + 2 new
      expect(params[3]).toBe(2 + serverCost);          // $4 total_cost
      // $5 turn_build_cost: a bot is charged at once, so nothing is left unsettled
      expect(params[4]).toBe(0);
    });

    it('logs one build action per section for the turn', async () => {
      await PlayerService.buildTrackForPlayer(gameId, playerId, newSegments);

      const params = queryCall('INSERT INTO turn_actions')![1] as unknown[];
      expect(params.slice(0, 3)).toEqual([playerId, gameId, 3]);
      const actions = JSON.parse(params[3] as string);
      expect(actions).toHaveLength(2);
      expect(actions[0]).toMatchObject({ kind: 'build', majorCityStart: '41,42', segment: { cost: 2 } });
    });

    it('builds from a major city when the player has no track row yet', async () => {
      mockDatabase({ money: 20, stored: [] });

      const result = await PlayerService.buildTrackForPlayer(gameId, playerId, newSegments);

      expect(result.remainingMoney).toBe(13);
    });

    it('reads everything on the transaction client, never through the pool', async () => {
      await PlayerService.buildTrackForPlayer(gameId, playerId, newSegments);

      expect(mockPool.query).not.toHaveBeenCalled();
    });
  });

  describe('insufficient funds', () => {
    it('throws when the player has less money than the recomputed cost', async () => {
      mockDatabase({ money: 5 });

      await expect(
        PlayerService.buildTrackForPlayer(gameId, playerId, newSegments),
      ).rejects.toThrow('Insufficient funds: need 7, have 5');
    });

    it('rolls back on insufficient funds', async () => {
      mockDatabase({ money: 3 });

      await expect(
        PlayerService.buildTrackForPlayer(gameId, playerId, newSegments),
      ).rejects.toThrow();

      expect(mockClient.query).toHaveBeenCalledWith('ROLLBACK');
      expect(mockClient.release).toHaveBeenCalled();
      expect(queryCall('INSERT INTO player_tracks')).toBeUndefined();
    });
  });

  describe('player not found', () => {
    it('throws when the player does not exist', async () => {
      mockDatabase({ money: null });

      await expect(
        PlayerService.buildTrackForPlayer(gameId, playerId, newSegments),
      ).rejects.toThrow('Player not found in game');
    });
  });

  describe('transaction rollback on DB failure', () => {
    it('rolls back when the UPSERT fails', async () => {
      mockDatabase({ failOn: { sql: 'INSERT INTO player_tracks', message: 'UPSERT failed' } });

      await expect(
        PlayerService.buildTrackForPlayer(gameId, playerId, newSegments),
      ).rejects.toThrow('UPSERT failed');

      expect(mockClient.query).toHaveBeenCalledWith('ROLLBACK');
      expect(mockClient.release).toHaveBeenCalled();
    });

    it('rolls back when the money UPDATE fails', async () => {
      mockDatabase({ failOn: { sql: 'UPDATE players SET money', message: 'Money update failed' } });

      await expect(
        PlayerService.buildTrackForPlayer(gameId, playerId, newSegments),
      ).rejects.toThrow('Money update failed');

      expect(mockClient.query).toHaveBeenCalledWith('ROLLBACK');
    });

    it('does not charge if the UPSERT fails (atomicity)', async () => {
      mockDatabase({ failOn: { sql: 'INSERT INTO player_tracks', message: 'UPSERT failed' } });

      await expect(
        PlayerService.buildTrackForPlayer(gameId, playerId, newSegments),
      ).rejects.toThrow();

      expect(queryCall('UPDATE players SET money')).toBeUndefined();
    });
  });
});
