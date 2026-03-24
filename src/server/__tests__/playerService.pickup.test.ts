import { db } from '../db/index';
import { PlayerService } from '../services/playerService';
import { LoadService } from '../services/loadService';
import { LoadType } from '../../shared/types/LoadTypes';
import { TrainType } from '../../shared/types/GameTypes';

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

// Access the mock client
const { __mockClient: mockClient } = jest.requireMock('../db/index') as {
  __mockClient: { query: jest.Mock; release: jest.Mock };
};

describe('PlayerService.pickupLoadForPlayer', () => {
  const gameId = 'game-123';
  const playerId = 'player-456';
  const loadType = LoadType.Coal;
  const cityName = 'Berlin';

  let mockLoadServiceInstance: { pickupDroppedLoad: jest.Mock };

  beforeEach(() => {
    jest.clearAllMocks();

    // Default: BEGIN, COMMIT succeed
    mockClient.query.mockImplementation((sql: string) => {
      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') {
        return Promise.resolve();
      }
      return Promise.resolve({ rows: [] });
    });

    // Setup LoadService mock
    mockLoadServiceInstance = {
      pickupDroppedLoad: jest.fn().mockResolvedValue({
        loadState: {},
        droppedLoads: [],
      }),
    };
    (LoadService.getInstance as jest.Mock) = jest.fn().mockReturnValue(mockLoadServiceInstance);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('happy path', () => {
    it('should pick up a load for a Freight train with space', async () => {
      mockClient.query.mockImplementation((sql: string, params?: any[]) => {
        if (sql === 'BEGIN' || sql === 'COMMIT') return Promise.resolve();
        if (sql.includes('SELECT loads')) {
          return Promise.resolve({
            rows: [{ loads: [LoadType.Oil], trainType: TrainType.Freight }],
          });
        }
        if (sql.includes('UPDATE players SET loads')) {
          return Promise.resolve({
            rows: [{ loads: [LoadType.Oil, LoadType.Coal] }],
          });
        }
        return Promise.resolve({ rows: [] });
      });

      const result = await PlayerService.pickupLoadForPlayer(gameId, playerId, loadType, cityName);

      expect(result.updatedLoads).toEqual([LoadType.Oil, LoadType.Coal]);
      expect(mockClient.query).toHaveBeenCalledWith('BEGIN');
      expect(mockClient.query).toHaveBeenCalledWith('COMMIT');
      expect(mockClient.release).toHaveBeenCalled();
    });

    it('should pick up a load for an empty Heavy Freight train', async () => {
      mockClient.query.mockImplementation((sql: string) => {
        if (sql === 'BEGIN' || sql === 'COMMIT') return Promise.resolve();
        if (sql.includes('SELECT loads')) {
          return Promise.resolve({
            rows: [{ loads: [], trainType: TrainType.HeavyFreight }],
          });
        }
        if (sql.includes('UPDATE players SET loads')) {
          return Promise.resolve({
            rows: [{ loads: [LoadType.Coal] }],
          });
        }
        return Promise.resolve({ rows: [] });
      });

      const result = await PlayerService.pickupLoadForPlayer(gameId, playerId, loadType, cityName);

      expect(result.updatedLoads).toEqual([LoadType.Coal]);
    });

    it('should use FOR UPDATE row locking in the SELECT query', async () => {
      mockClient.query.mockImplementation((sql: string) => {
        if (sql === 'BEGIN' || sql === 'COMMIT') return Promise.resolve();
        if (sql.includes('SELECT loads')) {
          return Promise.resolve({
            rows: [{ loads: [], trainType: TrainType.Freight }],
          });
        }
        if (sql.includes('UPDATE players SET loads')) {
          return Promise.resolve({
            rows: [{ loads: [LoadType.Coal] }],
          });
        }
        return Promise.resolve({ rows: [] });
      });

      await PlayerService.pickupLoadForPlayer(gameId, playerId, loadType, cityName);

      const selectCall = mockClient.query.mock.calls.find(
        (call: any[]) => typeof call[0] === 'string' && call[0].includes('SELECT loads'),
      );
      expect(selectCall).toBeDefined();
      expect(selectCall![0]).toContain('FOR UPDATE');
    });

    it('should call LoadService.pickupDroppedLoad for best-effort cleanup', async () => {
      mockClient.query.mockImplementation((sql: string) => {
        if (sql === 'BEGIN' || sql === 'COMMIT') return Promise.resolve();
        if (sql.includes('SELECT loads')) {
          return Promise.resolve({
            rows: [{ loads: [], trainType: TrainType.Freight }],
          });
        }
        if (sql.includes('UPDATE players SET loads')) {
          return Promise.resolve({
            rows: [{ loads: [LoadType.Coal] }],
          });
        }
        return Promise.resolve({ rows: [] });
      });

      await PlayerService.pickupLoadForPlayer(gameId, playerId, loadType, cityName);

      expect(mockLoadServiceInstance.pickupDroppedLoad).toHaveBeenCalledWith(
        cityName,
        loadType,
        gameId,
      );
    });

    it('should not call LoadService when cityName is empty', async () => {
      mockClient.query.mockImplementation((sql: string) => {
        if (sql === 'BEGIN' || sql === 'COMMIT') return Promise.resolve();
        if (sql.includes('SELECT loads')) {
          return Promise.resolve({
            rows: [{ loads: [], trainType: TrainType.Freight }],
          });
        }
        if (sql.includes('UPDATE players SET loads')) {
          return Promise.resolve({
            rows: [{ loads: [LoadType.Coal] }],
          });
        }
        return Promise.resolve({ rows: [] });
      });

      await PlayerService.pickupLoadForPlayer(gameId, playerId, loadType, '');

      expect(mockLoadServiceInstance.pickupDroppedLoad).not.toHaveBeenCalled();
    });
  });

  describe('capacity exceeded', () => {
    it('should throw when Freight train is at capacity (2 loads)', async () => {
      mockClient.query.mockImplementation((sql: string) => {
        if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return Promise.resolve();
        if (sql.includes('SELECT loads')) {
          return Promise.resolve({
            rows: [{ loads: [LoadType.Oil, LoadType.Wine], trainType: TrainType.Freight }],
          });
        }
        return Promise.resolve({ rows: [] });
      });

      await expect(
        PlayerService.pickupLoadForPlayer(gameId, playerId, loadType, cityName),
      ).rejects.toThrow('Train at full capacity (2/2)');
    });

    it('should throw when HeavyFreight train is at capacity (3 loads)', async () => {
      mockClient.query.mockImplementation((sql: string) => {
        if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return Promise.resolve();
        if (sql.includes('SELECT loads')) {
          return Promise.resolve({
            rows: [{
              loads: [LoadType.Oil, LoadType.Wine, LoadType.Coal],
              trainType: TrainType.HeavyFreight,
            }],
          });
        }
        return Promise.resolve({ rows: [] });
      });

      await expect(
        PlayerService.pickupLoadForPlayer(gameId, playerId, loadType, cityName),
      ).rejects.toThrow('Train at full capacity (3/3)');
    });

    it('should rollback transaction on capacity error', async () => {
      mockClient.query.mockImplementation((sql: string) => {
        if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return Promise.resolve();
        if (sql.includes('SELECT loads')) {
          return Promise.resolve({
            rows: [{ loads: [LoadType.Oil, LoadType.Wine], trainType: TrainType.Freight }],
          });
        }
        return Promise.resolve({ rows: [] });
      });

      await expect(
        PlayerService.pickupLoadForPlayer(gameId, playerId, loadType, cityName),
      ).rejects.toThrow();

      expect(mockClient.query).toHaveBeenCalledWith('ROLLBACK');
      expect(mockClient.release).toHaveBeenCalled();
    });
  });

  describe('player not found', () => {
    it('should throw when player does not exist in the game', async () => {
      mockClient.query.mockImplementation((sql: string) => {
        if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return Promise.resolve();
        if (sql.includes('SELECT loads')) {
          return Promise.resolve({ rows: [] });
        }
        return Promise.resolve({ rows: [] });
      });

      await expect(
        PlayerService.pickupLoadForPlayer(gameId, playerId, loadType, cityName),
      ).rejects.toThrow('Player not found in game');
    });
  });

  describe('transaction rollback on DB failure', () => {
    it('should rollback and rethrow when UPDATE fails', async () => {
      mockClient.query.mockImplementation((sql: string) => {
        if (sql === 'BEGIN' || sql === 'ROLLBACK') return Promise.resolve();
        if (sql.includes('SELECT loads')) {
          return Promise.resolve({
            rows: [{ loads: [], trainType: TrainType.Freight }],
          });
        }
        if (sql.includes('UPDATE players SET loads')) {
          return Promise.reject(new Error('DB write error'));
        }
        return Promise.resolve({ rows: [] });
      });

      await expect(
        PlayerService.pickupLoadForPlayer(gameId, playerId, loadType, cityName),
      ).rejects.toThrow('DB write error');

      expect(mockClient.query).toHaveBeenCalledWith('ROLLBACK');
      expect(mockClient.release).toHaveBeenCalled();
    });

    it('should rollback and rethrow when SELECT fails', async () => {
      mockClient.query.mockImplementation((sql: string) => {
        if (sql === 'BEGIN' || sql === 'ROLLBACK') return Promise.resolve();
        if (sql.includes('SELECT loads')) {
          return Promise.reject(new Error('DB read error'));
        }
        return Promise.resolve({ rows: [] });
      });

      await expect(
        PlayerService.pickupLoadForPlayer(gameId, playerId, loadType, cityName),
      ).rejects.toThrow('DB read error');

      expect(mockClient.query).toHaveBeenCalledWith('ROLLBACK');
    });
  });

  describe('best-effort LoadService failure', () => {
    it('should succeed even when LoadService.pickupDroppedLoad fails', async () => {
      mockClient.query.mockImplementation((sql: string) => {
        if (sql === 'BEGIN' || sql === 'COMMIT') return Promise.resolve();
        if (sql.includes('SELECT loads')) {
          return Promise.resolve({
            rows: [{ loads: [], trainType: TrainType.Freight }],
          });
        }
        if (sql.includes('UPDATE players SET loads')) {
          return Promise.resolve({
            rows: [{ loads: [LoadType.Coal] }],
          });
        }
        return Promise.resolve({ rows: [] });
      });

      mockLoadServiceInstance.pickupDroppedLoad.mockRejectedValue(new Error('Load service down'));

      const consoleSpy = jest.spyOn(console, 'error').mockImplementation();

      const result = await PlayerService.pickupLoadForPlayer(gameId, playerId, loadType, cityName);

      expect(result.updatedLoads).toEqual([LoadType.Coal]);
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('pickupLoadForPlayer dropped-load clear failed'),
        expect.any(String),
      );

      consoleSpy.mockRestore();
    });
  });

  describe('loads array edge cases', () => {
    it('should handle null loads array gracefully', async () => {
      mockClient.query.mockImplementation((sql: string) => {
        if (sql === 'BEGIN' || sql === 'COMMIT') return Promise.resolve();
        if (sql.includes('SELECT loads')) {
          return Promise.resolve({
            rows: [{ loads: null, trainType: TrainType.Freight }],
          });
        }
        if (sql.includes('UPDATE players SET loads')) {
          return Promise.resolve({
            rows: [{ loads: [LoadType.Coal] }],
          });
        }
        return Promise.resolve({ rows: [] });
      });

      const result = await PlayerService.pickupLoadForPlayer(gameId, playerId, loadType, cityName);

      expect(result.updatedLoads).toEqual([LoadType.Coal]);
    });
  });
});
