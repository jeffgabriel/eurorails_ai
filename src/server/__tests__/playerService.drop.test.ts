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
    returnLoad: jest.Mock;
    setLoadInCity: jest.Mock;
  };

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
      returnLoad: jest.fn().mockResolvedValue({ loadState: {}, droppedLoads: [] }),
      setLoadInCity: jest.fn().mockResolvedValue({ loadState: {}, droppedLoads: [] }),
    };
    (LoadService.getInstance as jest.Mock) = jest.fn().mockReturnValue(mockLoadServiceInstance);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('happy path — native load', () => {
    it('should drop a native load and call returnLoad', async () => {
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
      expect(mockLoadServiceInstance.returnLoad).toHaveBeenCalledWith(cityName, loadType, gameId);
      expect(mockLoadServiceInstance.setLoadInCity).not.toHaveBeenCalled();
    });
  });

  describe('happy path — non-native load', () => {
    it('should drop a non-native load and call setLoadInCity', async () => {
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

      expect(mockLoadServiceInstance.setLoadInCity).toHaveBeenCalledWith(cityName, loadType, gameId);
      expect(mockLoadServiceInstance.returnLoad).not.toHaveBeenCalled();
    });
  });

  describe('validates load removal uses array_remove', () => {
    it('should use array_remove SQL', async () => {
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

      const updateCall = mockClient.query.mock.calls.find(
        (call: any[]) => typeof call[0] === 'string' && call[0].includes('UPDATE players SET loads'),
      );
      expect(updateCall).toBeDefined();
      expect(updateCall![0]).toContain('array_remove');
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

  describe('best-effort LoadService failure', () => {
    it('should succeed even when LoadService city placement fails', async () => {
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

      mockLoadServiceInstance.setLoadInCity.mockRejectedValue(new Error('LoadService down'));

      const consoleSpy = jest.spyOn(console, 'error').mockImplementation();

      // Should not throw — LoadService failure is best-effort
      await PlayerService.dropLoadForPlayer(gameId, playerId, loadType, cityName);

      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('dropLoadForPlayer city placement failed'),
        expect.any(String),
      );

      consoleSpy.mockRestore();
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
