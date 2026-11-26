import { db } from '../db/index';
import { PlayerService } from '../services/playerService';
import { LoadService } from '../services/loadService';
import { LoadType } from '../../shared/types/LoadTypes';

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

// Mock LoadService
jest.mock('../services/loadService');

const { __mockClient: mockClient } = jest.requireMock('../db/index') as {
  __mockClient: { query: jest.Mock; release: jest.Mock };
};

describe('PlayerService.dropLoadForPlayer', () => {
  const gameId = 'game-123';
  const playerId = 'player-456';
  const loadType = LoadType.Coal;
  const cityName = 'Berlin';

  let mockLoadServiceInstance: {
    isLoadAvailableAtCity: jest.Mock;
  };

  const loadChipCalls = (): any[][] =>
    mockClient.query.mock.calls.filter(
      (call: any[]) => typeof call[0] === 'string' && call[0].includes('load_chips'),
    );

  beforeEach(() => {
    jest.clearAllMocks();

    mockClient.query.mockImplementation((sql: string) => {
      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') {
        return Promise.resolve();
      }
      return Promise.resolve({ rows: [] });
    });

    mockLoadServiceInstance = {
      isLoadAvailableAtCity: jest.fn().mockReturnValue(false),
    };
    (LoadService.getInstance as jest.Mock) = jest.fn().mockReturnValue(mockLoadServiceInstance);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('happy path — native load', () => {
    it('should return a native load to the tray without leaving a chip in the city', async () => {
      mockLoadServiceInstance.isLoadAvailableAtCity.mockReturnValue(true);

      mockClient.query.mockImplementation((sql: string) => {
        if (sql === 'BEGIN' || sql === 'COMMIT') return Promise.resolve();
        if (sql.includes('SELECT loads')) {
          return Promise.resolve({
            rows: [{ loads: [LoadType.Coal, LoadType.Oil] }],
          });
        }
        if (sql.includes('UPDATE players SET loads')) {
          return Promise.resolve({ rows: [] });
        }
        return Promise.resolve({ rows: [] });
      });

      await PlayerService.dropLoadForPlayer(gameId, playerId, loadType, cityName);

      expect(mockLoadServiceInstance.isLoadAvailableAtCity).toHaveBeenCalledWith(loadType, cityName);
      expect(loadChipCalls()).toHaveLength(0);
    });
  });

  describe('happy path — non-native load', () => {
    it('should leave a non-native load in the city and return a chip already there to the tray', async () => {
      mockLoadServiceInstance.isLoadAvailableAtCity.mockReturnValue(false);

      mockClient.query.mockImplementation((sql: string) => {
        if (sql === 'BEGIN' || sql === 'COMMIT') return Promise.resolve();
        if (sql.includes('SELECT loads')) {
          return Promise.resolve({
            rows: [{ loads: [LoadType.Coal] }],
          });
        }
        if (sql.includes('UPDATE players SET loads')) {
          return Promise.resolve({ rows: [] });
        }
        return Promise.resolve({ rows: [] });
      });

      await PlayerService.dropLoadForPlayer(gameId, playerId, loadType, cityName);

      const chipCalls = loadChipCalls();
      expect(chipCalls).toHaveLength(2);
      // First the chip already lying in the city goes back to the tray...
      expect(chipCalls[0][0]).toContain('UPDATE load_chips SET is_dropped = false');
      expect(chipCalls[0][1]).toEqual([cityName, gameId]);
      // ...then the dropped load takes its place.
      expect(chipCalls[1][0]).toContain('INSERT INTO load_chips');
      expect(chipCalls[1][1]).toEqual([gameId, loadType, cityName]);

      const sqlCalls = mockClient.query.mock.calls.map((call: any[]) => call[0] as string);
      expect(sqlCalls.indexOf(chipCalls[1][0])).toBeLessThan(sqlCalls.indexOf('COMMIT'));
    });
  });

  describe('load removal', () => {
    const runDropWithLoads = async (loads: LoadType[]): Promise<unknown[]> => {
      mockClient.query.mockImplementation((sql: string) => {
        if (sql === 'BEGIN' || sql === 'COMMIT') return Promise.resolve();
        if (sql.includes('SELECT loads')) {
          return Promise.resolve({ rows: [{ loads }] });
        }
        return Promise.resolve({ rows: [] });
      });

      await PlayerService.dropLoadForPlayer(gameId, playerId, loadType, cityName);

      const updateCall = mockClient.query.mock.calls.find(
        (call: any[]) => typeof call[0] === 'string' && call[0].includes('UPDATE players SET loads'),
      );
      expect(updateCall).toBeDefined();
      expect(updateCall![0]).not.toContain('array_remove');
      return updateCall![1];
    };

    it('should remove the only copy of the load', async () => {
      const params = await runDropWithLoads([LoadType.Coal, LoadType.Oil]);
      expect(params).toEqual([[LoadType.Oil], playerId, gameId]);
    });

    it('should remove only one copy when carrying duplicates', async () => {
      const params = await runDropWithLoads([LoadType.Coal, LoadType.Oil, LoadType.Coal]);
      expect(params).toEqual([[LoadType.Oil, LoadType.Coal], playerId, gameId]);
    });
  });

  describe('player not carrying load', () => {
    it('should throw when player does not have the load', async () => {
      mockClient.query.mockImplementation((sql: string) => {
        if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return Promise.resolve();
        if (sql.includes('SELECT loads')) {
          return Promise.resolve({
            rows: [{ loads: [LoadType.Oil, LoadType.Wine] }],
          });
        }
        return Promise.resolve({ rows: [] });
      });

      await expect(
        PlayerService.dropLoadForPlayer(gameId, playerId, loadType, cityName),
      ).rejects.toThrow('Player is not carrying load: Coal');
    });

    it('should throw when player has empty loads', async () => {
      mockClient.query.mockImplementation((sql: string) => {
        if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return Promise.resolve();
        if (sql.includes('SELECT loads')) {
          return Promise.resolve({
            rows: [{ loads: [] }],
          });
        }
        return Promise.resolve({ rows: [] });
      });

      await expect(
        PlayerService.dropLoadForPlayer(gameId, playerId, loadType, cityName),
      ).rejects.toThrow('Player is not carrying load: Coal');
    });

    it('should rollback on validation error', async () => {
      mockClient.query.mockImplementation((sql: string) => {
        if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return Promise.resolve();
        if (sql.includes('SELECT loads')) {
          return Promise.resolve({
            rows: [{ loads: [LoadType.Oil] }],
          });
        }
        return Promise.resolve({ rows: [] });
      });

      await expect(
        PlayerService.dropLoadForPlayer(gameId, playerId, loadType, cityName),
      ).rejects.toThrow();

      expect(mockClient.query).toHaveBeenCalledWith('ROLLBACK');
      expect(mockClient.release).toHaveBeenCalled();
    });
  });

  describe('player not found', () => {
    it('should throw when player does not exist', async () => {
      mockClient.query.mockImplementation((sql: string) => {
        if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return Promise.resolve();
        if (sql.includes('SELECT loads')) {
          return Promise.resolve({ rows: [] });
        }
        return Promise.resolve({ rows: [] });
      });

      await expect(
        PlayerService.dropLoadForPlayer(gameId, playerId, loadType, cityName),
      ).rejects.toThrow('Player not found in game');
    });
  });

  describe('transaction rollback on DB failure', () => {
    it('should rollback and rethrow when UPDATE fails', async () => {
      mockClient.query.mockImplementation((sql: string) => {
        if (sql === 'BEGIN' || sql === 'ROLLBACK') return Promise.resolve();
        if (sql.includes('SELECT loads')) {
          return Promise.resolve({
            rows: [{ loads: [LoadType.Coal] }],
          });
        }
        if (sql.includes('UPDATE players SET loads')) {
          return Promise.reject(new Error('DB write error'));
        }
        return Promise.resolve({ rows: [] });
      });

      await expect(
        PlayerService.dropLoadForPlayer(gameId, playerId, loadType, cityName),
      ).rejects.toThrow('DB write error');

      expect(mockClient.query).toHaveBeenCalledWith('ROLLBACK');
      expect(mockClient.release).toHaveBeenCalled();
    });
  });

  describe('city placement failure', () => {
    it('should roll back the drop when the city placement fails', async () => {
      mockClient.query.mockImplementation((sql: string) => {
        if (sql === 'BEGIN' || sql === 'ROLLBACK') return Promise.resolve();
        if (sql.includes('SELECT loads')) {
          return Promise.resolve({
            rows: [{ loads: [LoadType.Coal] }],
          });
        }
        if (sql.includes('INSERT INTO load_chips')) {
          return Promise.reject(new Error('load_chips write error'));
        }
        return Promise.resolve({ rows: [] });
      });

      await expect(
        PlayerService.dropLoadForPlayer(gameId, playerId, loadType, cityName),
      ).rejects.toThrow('load_chips write error');

      expect(mockClient.query).toHaveBeenCalledWith('ROLLBACK');
      expect(mockClient.query).not.toHaveBeenCalledWith('COMMIT');
    });
  });

  describe('null loads edge case', () => {
    it('should handle null loads array gracefully', async () => {
      mockClient.query.mockImplementation((sql: string) => {
        if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return Promise.resolve();
        if (sql.includes('SELECT loads')) {
          return Promise.resolve({
            rows: [{ loads: null }],
          });
        }
        return Promise.resolve({ rows: [] });
      });

      await expect(
        PlayerService.dropLoadForPlayer(gameId, playerId, loadType, cityName),
      ).rejects.toThrow('Player is not carrying load: Coal');
    });
  });
});
