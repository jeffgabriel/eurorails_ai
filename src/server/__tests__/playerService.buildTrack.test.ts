import { db } from '../db/index';
import { PlayerService } from '../services/playerService';
import { TrackSegment } from '../../shared/types/TrackTypes';
import { TerrainType } from '../../shared/types/GameTypes';

// Mock the database module
jest.mock('../db/index', () => {
  const mockClient = {
    query: jest.fn(),
    release: jest.fn(),
  };
  return {
    db: {
      connect: jest.fn().mockResolvedValue(mockClient),
      query: jest.fn(),
    },
    __mockClient: mockClient,
  };
});

const { __mockClient: mockClient } = jest.requireMock('../db/index') as {
  __mockClient: { query: jest.Mock; release: jest.Mock };
};

describe('PlayerService.buildTrackForPlayer', () => {
  const gameId = 'game-123';
  const playerId = 'player-456';

  const existingSegments: TrackSegment[] = [
    { from: { x: 0, y: 0, row: 1, col: 1, terrain: TerrainType.Clear }, to: { x: 1, y: 0, row: 1, col: 2, terrain: TerrainType.Clear }, cost: 1 },
  ];
  const newSegments: TrackSegment[] = [
    { from: { x: 1, y: 0, row: 1, col: 2, terrain: TerrainType.Clear }, to: { x: 1, y: 1, row: 2, col: 2, terrain: TerrainType.Mountain }, cost: 2 },
    { from: { x: 1, y: 1, row: 2, col: 2, terrain: TerrainType.Mountain }, to: { x: 1, y: 2, row: 3, col: 2, terrain: TerrainType.Alpine }, cost: 5 },
  ];
  const cost = 7; // sum of new segments

  beforeEach(() => {
    jest.clearAllMocks();

    mockClient.query.mockImplementation((sql: string) => {
      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') {
        return Promise.resolve();
      }
      return Promise.resolve({ rows: [] });
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('happy path', () => {
    it('should build track and deduct money', async () => {
      mockClient.query.mockImplementation((sql: string, params?: any[]) => {
        if (sql === 'BEGIN' || sql === 'COMMIT') return Promise.resolve();
        if (sql.includes('SELECT money')) {
          return Promise.resolve({ rows: [{ money: 50 }] });
        }
        if (sql.includes('INSERT INTO player_tracks')) {
          return Promise.resolve({ rows: [] });
        }
        if (sql.includes('UPDATE players SET money')) {
          return Promise.resolve({ rows: [{ money: 43 }] });
        }
        return Promise.resolve({ rows: [] });
      });

      const result = await PlayerService.buildTrackForPlayer(
        gameId, playerId, newSegments, existingSegments, cost,
      );

      expect(result.remainingMoney).toBe(43);
      expect(mockClient.query).toHaveBeenCalledWith('BEGIN');
      expect(mockClient.query).toHaveBeenCalledWith('COMMIT');
      expect(mockClient.release).toHaveBeenCalled();
    });

    it('should use FOR UPDATE row locking on money check', async () => {
      mockClient.query.mockImplementation((sql: string) => {
        if (sql === 'BEGIN' || sql === 'COMMIT') return Promise.resolve();
        if (sql.includes('SELECT money')) {
          return Promise.resolve({ rows: [{ money: 50 }] });
        }
        if (sql.includes('INSERT INTO player_tracks')) {
          return Promise.resolve({ rows: [] });
        }
        if (sql.includes('UPDATE players SET money')) {
          return Promise.resolve({ rows: [{ money: 43 }] });
        }
        return Promise.resolve({ rows: [] });
      });

      await PlayerService.buildTrackForPlayer(
        gameId, playerId, newSegments, existingSegments, cost,
      );

      const selectCall = mockClient.query.mock.calls.find(
        (call: any[]) => typeof call[0] === 'string' && call[0].includes('SELECT money'),
      );
      expect(selectCall![0]).toContain('FOR UPDATE');
    });

    it('should UPSERT player_tracks with combined segments', async () => {
      mockClient.query.mockImplementation((sql: string, params?: any[]) => {
        if (sql === 'BEGIN' || sql === 'COMMIT') return Promise.resolve();
        if (sql.includes('SELECT money')) {
          return Promise.resolve({ rows: [{ money: 50 }] });
        }
        if (sql.includes('INSERT INTO player_tracks')) {
          return Promise.resolve({ rows: [] });
        }
        if (sql.includes('UPDATE players SET money')) {
          return Promise.resolve({ rows: [{ money: 43 }] });
        }
        return Promise.resolve({ rows: [] });
      });

      await PlayerService.buildTrackForPlayer(
        gameId, playerId, newSegments, existingSegments, cost,
      );

      const upsertCall = mockClient.query.mock.calls.find(
        (call: any[]) => typeof call[0] === 'string' && call[0].includes('INSERT INTO player_tracks'),
      );
      expect(upsertCall).toBeDefined();
      expect(upsertCall![0]).toContain('ON CONFLICT');
      // Verify combined segments are passed
      const params = upsertCall![1]!;
      expect(params[0]).toBe(gameId);       // $1 game_id
      expect(params[1]).toBe(playerId);     // $2 player_id
      const parsed = JSON.parse(params[2]); // $3 segments JSON
      expect(parsed).toHaveLength(3);       // 1 existing + 2 new
      expect(params[3]).toBe(8);            // $4 totalCost (1+2+5)
      expect(params[4]).toBe(7);            // $5 turn_build_cost (cost param)
    });

    it('should build with empty existing segments', async () => {
      mockClient.query.mockImplementation((sql: string) => {
        if (sql === 'BEGIN' || sql === 'COMMIT') return Promise.resolve();
        if (sql.includes('SELECT money')) {
          return Promise.resolve({ rows: [{ money: 20 }] });
        }
        if (sql.includes('INSERT INTO player_tracks')) {
          return Promise.resolve({ rows: [] });
        }
        if (sql.includes('UPDATE players SET money')) {
          return Promise.resolve({ rows: [{ money: 13 }] });
        }
        return Promise.resolve({ rows: [] });
      });

      const result = await PlayerService.buildTrackForPlayer(
        gameId, playerId, newSegments, [], cost,
      );

      expect(result.remainingMoney).toBe(13);
    });
  });

  describe('insufficient funds', () => {
    it('should throw when player has less money than cost', async () => {
      mockClient.query.mockImplementation((sql: string) => {
        if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return Promise.resolve();
        if (sql.includes('SELECT money')) {
          return Promise.resolve({ rows: [{ money: 5 }] });
        }
        return Promise.resolve({ rows: [] });
      });

      await expect(
        PlayerService.buildTrackForPlayer(gameId, playerId, newSegments, existingSegments, cost),
      ).rejects.toThrow('Insufficient funds: need 7, have 5');
    });

    it('should rollback on insufficient funds', async () => {
      mockClient.query.mockImplementation((sql: string) => {
        if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return Promise.resolve();
        if (sql.includes('SELECT money')) {
          return Promise.resolve({ rows: [{ money: 3 }] });
        }
        return Promise.resolve({ rows: [] });
      });

      await expect(
        PlayerService.buildTrackForPlayer(gameId, playerId, newSegments, existingSegments, cost),
      ).rejects.toThrow();

      expect(mockClient.query).toHaveBeenCalledWith('ROLLBACK');
      expect(mockClient.release).toHaveBeenCalled();
    });
  });

  describe('player not found', () => {
    it('should throw when player does not exist', async () => {
      mockClient.query.mockImplementation((sql: string) => {
        if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return Promise.resolve();
        if (sql.includes('SELECT money')) {
          return Promise.resolve({ rows: [] });
        }
        return Promise.resolve({ rows: [] });
      });

      await expect(
        PlayerService.buildTrackForPlayer(gameId, playerId, newSegments, existingSegments, cost),
      ).rejects.toThrow('Player not found in game');
    });
  });

  describe('transaction rollback on DB failure', () => {
    it('should rollback when UPSERT fails', async () => {
      mockClient.query.mockImplementation((sql: string) => {
        if (sql === 'BEGIN' || sql === 'ROLLBACK') return Promise.resolve();
        if (sql.includes('SELECT money')) {
          return Promise.resolve({ rows: [{ money: 50 }] });
        }
        if (sql.includes('INSERT INTO player_tracks')) {
          return Promise.reject(new Error('UPSERT failed'));
        }
        return Promise.resolve({ rows: [] });
      });

      await expect(
        PlayerService.buildTrackForPlayer(gameId, playerId, newSegments, existingSegments, cost),
      ).rejects.toThrow('UPSERT failed');

      expect(mockClient.query).toHaveBeenCalledWith('ROLLBACK');
      expect(mockClient.release).toHaveBeenCalled();
    });

    it('should rollback when money UPDATE fails', async () => {
      mockClient.query.mockImplementation((sql: string) => {
        if (sql === 'BEGIN' || sql === 'ROLLBACK') return Promise.resolve();
        if (sql.includes('SELECT money')) {
          return Promise.resolve({ rows: [{ money: 50 }] });
        }
        if (sql.includes('INSERT INTO player_tracks')) {
          return Promise.resolve({ rows: [] });
        }
        if (sql.includes('UPDATE players SET money')) {
          return Promise.reject(new Error('Money update failed'));
        }
        return Promise.resolve({ rows: [] });
      });

      await expect(
        PlayerService.buildTrackForPlayer(gameId, playerId, newSegments, existingSegments, cost),
      ).rejects.toThrow('Money update failed');

      expect(mockClient.query).toHaveBeenCalledWith('ROLLBACK');
    });

    it('should not call UPDATE if UPSERT fails (atomicity)', async () => {
      mockClient.query.mockImplementation((sql: string) => {
        if (sql === 'BEGIN' || sql === 'ROLLBACK') return Promise.resolve();
        if (sql.includes('SELECT money')) {
          return Promise.resolve({ rows: [{ money: 50 }] });
        }
        if (sql.includes('INSERT INTO player_tracks')) {
          return Promise.reject(new Error('UPSERT failed'));
        }
        return Promise.resolve({ rows: [] });
      });

      await expect(
        PlayerService.buildTrackForPlayer(gameId, playerId, newSegments, existingSegments, cost),
      ).rejects.toThrow();

      const updateCalls = mockClient.query.mock.calls.filter(
        (call: any[]) => typeof call[0] === 'string' && call[0].includes('UPDATE players SET money'),
      );
      expect(updateCalls).toHaveLength(0);
    });
  });
});
