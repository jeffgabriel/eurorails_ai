import { db } from '../db/index';
import { PlayerService } from '../services/playerService';
import { demandDeckService } from '../services/demandDeckService';

// Mock socketService to prevent real socket emissions
jest.mock('../services/socketService', () => ({
  emitTurnChange: jest.fn(),
  emitStatePatch: jest.fn().mockResolvedValue(undefined),
}));

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

// Mock DemandDeckService
jest.mock('../services/demandDeckService', () => ({
  demandDeckService: {
    discardCard: jest.fn(),
    drawCard: jest.fn(),
    returnDealtCardToTop: jest.fn(),
    returnDiscardedCardToDealt: jest.fn(),
  },
}));

const { __mockClient: mockClient } = jest.requireMock('../db/index') as {
  __mockClient: { query: jest.Mock; release: jest.Mock };
};

describe('PlayerService.discardHandForPlayer', () => {
  const gameId = 'game-123';
  const playerId = 'player-456';

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
    it('should discard hand and draw 3 new cards', async () => {
      (demandDeckService.drawCard as jest.Mock)
        .mockReturnValueOnce({ id: 10, city: 'Berlin', demands: [] })
        .mockReturnValueOnce({ id: 20, city: 'Paris', demands: [] })
        .mockReturnValueOnce({ id: 30, city: 'Roma', demands: [] });

      mockClient.query.mockImplementation((sql: string) => {
        if (sql === 'BEGIN' || sql === 'COMMIT') return Promise.resolve();
        if (sql.includes('SELECT hand')) {
          return Promise.resolve({
            rows: [{ hand: [1, 2, 3] }],
          });
        }
        if (sql.includes('UPDATE players')) {
          return Promise.resolve({ rows: [] });
        }
        return Promise.resolve({ rows: [] });
      });

      const result = await PlayerService.discardHandForPlayer(gameId, playerId);

      expect(result.newHandIds).toEqual([10, 20, 30]);
      expect(mockClient.query).toHaveBeenCalledWith('BEGIN');
      expect(mockClient.query).toHaveBeenCalledWith('COMMIT');
      expect(mockClient.release).toHaveBeenCalled();
    });

    it('should discard each old card via demandDeckService', async () => {
      (demandDeckService.drawCard as jest.Mock)
        .mockReturnValueOnce({ id: 10 })
        .mockReturnValueOnce({ id: 20 })
        .mockReturnValueOnce({ id: 30 });

      mockClient.query.mockImplementation((sql: string) => {
        if (sql === 'BEGIN' || sql === 'COMMIT') return Promise.resolve();
        if (sql.includes('SELECT hand')) {
          return Promise.resolve({ rows: [{ hand: [5, 6, 7] }] });
        }
        if (sql.includes('UPDATE players')) {
          return Promise.resolve({ rows: [] });
        }
        return Promise.resolve({ rows: [] });
      });

      await PlayerService.discardHandForPlayer(gameId, playerId);

      expect(demandDeckService.discardCard).toHaveBeenCalledTimes(3);
      expect(demandDeckService.discardCard).toHaveBeenCalledWith(5);
      expect(demandDeckService.discardCard).toHaveBeenCalledWith(6);
      expect(demandDeckService.discardCard).toHaveBeenCalledWith(7);
    });

    it('should use FOR UPDATE row locking', async () => {
      (demandDeckService.drawCard as jest.Mock)
        .mockReturnValueOnce({ id: 10 })
        .mockReturnValueOnce({ id: 20 })
        .mockReturnValueOnce({ id: 30 });

      mockClient.query.mockImplementation((sql: string) => {
        if (sql === 'BEGIN' || sql === 'COMMIT') return Promise.resolve();
        if (sql.includes('SELECT hand')) {
          return Promise.resolve({ rows: [{ hand: [] }] });
        }
        if (sql.includes('UPDATE players')) {
          return Promise.resolve({ rows: [] });
        }
        return Promise.resolve({ rows: [] });
      });

      await PlayerService.discardHandForPlayer(gameId, playerId);

      const selectCall = mockClient.query.mock.calls.find(
        (call: any[]) => typeof call[0] === 'string' && call[0].includes('SELECT hand'),
      );
      expect(selectCall![0]).toContain('FOR UPDATE');
    });

    it('should NOT advance the game turn', async () => {
      (demandDeckService.drawCard as jest.Mock)
        .mockReturnValueOnce({ id: 10 })
        .mockReturnValueOnce({ id: 20 })
        .mockReturnValueOnce({ id: 30 });

      mockClient.query.mockImplementation((sql: string) => {
        if (sql === 'BEGIN' || sql === 'COMMIT') return Promise.resolve();
        if (sql.includes('SELECT hand')) {
          return Promise.resolve({ rows: [{ hand: [1, 2, 3] }] });
        }
        if (sql.includes('UPDATE players')) {
          return Promise.resolve({ rows: [] });
        }
        return Promise.resolve({ rows: [] });
      });

      await PlayerService.discardHandForPlayer(gameId, playerId);

      // No turn advancement queries should be made
      const turnCalls = mockClient.query.mock.calls.filter(
        (call: any[]) => typeof call[0] === 'string' && (
          call[0].includes('current_turn_number') ||
          call[0].includes('current_player_index')
        ),
      );
      expect(turnCalls).toHaveLength(0);
    });

    it('should handle null hand gracefully', async () => {
      (demandDeckService.drawCard as jest.Mock)
        .mockReturnValueOnce({ id: 10 })
        .mockReturnValueOnce({ id: 20 })
        .mockReturnValueOnce({ id: 30 });

      mockClient.query.mockImplementation((sql: string) => {
        if (sql === 'BEGIN' || sql === 'COMMIT') return Promise.resolve();
        if (sql.includes('SELECT hand')) {
          return Promise.resolve({ rows: [{ hand: null }] });
        }
        if (sql.includes('UPDATE players')) {
          return Promise.resolve({ rows: [] });
        }
        return Promise.resolve({ rows: [] });
      });

      const result = await PlayerService.discardHandForPlayer(gameId, playerId);

      expect(result.newHandIds).toEqual([10, 20, 30]);
      // No cards to discard
      expect(demandDeckService.discardCard).not.toHaveBeenCalled();
    });
  });

  describe('player not found', () => {
    it('should throw when player does not exist', async () => {
      mockClient.query.mockImplementation((sql: string) => {
        if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return Promise.resolve();
        if (sql.includes('SELECT hand')) {
          return Promise.resolve({ rows: [] });
        }
        return Promise.resolve({ rows: [] });
      });

      await expect(
        PlayerService.discardHandForPlayer(gameId, playerId),
      ).rejects.toThrow('Player not found in game');
    });
  });

  describe('draw failure', () => {
    it('should throw when deck is empty', async () => {
      (demandDeckService.drawCard as jest.Mock)
        .mockReturnValueOnce({ id: 10 })
        .mockReturnValueOnce(null); // deck exhausted

      mockClient.query.mockImplementation((sql: string) => {
        if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return Promise.resolve();
        if (sql.includes('SELECT hand')) {
          return Promise.resolve({ rows: [{ hand: [1, 2, 3] }] });
        }
        return Promise.resolve({ rows: [] });
      });

      await expect(
        PlayerService.discardHandForPlayer(gameId, playerId),
      ).rejects.toThrow('Failed to draw new demand card');
    });
  });

  describe('transaction rollback on DB failure', () => {
    it('should rollback when hand UPDATE fails', async () => {
      (demandDeckService.drawCard as jest.Mock)
        .mockReturnValueOnce({ id: 10 })
        .mockReturnValueOnce({ id: 20 })
        .mockReturnValueOnce({ id: 30 });

      mockClient.query.mockImplementation((sql: string) => {
        if (sql === 'BEGIN' || sql === 'ROLLBACK') return Promise.resolve();
        if (sql.includes('SELECT hand')) {
          return Promise.resolve({ rows: [{ hand: [1, 2, 3] }] });
        }
        if (sql.includes('UPDATE players')) {
          return Promise.reject(new Error('DB write error'));
        }
        return Promise.resolve({ rows: [] });
      });

      await expect(
        PlayerService.discardHandForPlayer(gameId, playerId),
      ).rejects.toThrow('DB write error');

      expect(mockClient.query).toHaveBeenCalledWith('ROLLBACK');
      expect(mockClient.release).toHaveBeenCalled();
    });

    it('should rollback when SELECT fails', async () => {
      mockClient.query.mockImplementation((sql: string) => {
        if (sql === 'BEGIN' || sql === 'ROLLBACK') return Promise.resolve();
        if (sql.includes('SELECT hand')) {
          return Promise.reject(new Error('DB read error'));
        }
        return Promise.resolve({ rows: [] });
      });

      await expect(
        PlayerService.discardHandForPlayer(gameId, playerId),
      ).rejects.toThrow('DB read error');

      expect(mockClient.query).toHaveBeenCalledWith('ROLLBACK');
      expect(mockClient.release).toHaveBeenCalled();
    });
  });
});

describe('PlayerService.discardHandForUser — regression', () => {
  const gameId = 'game-123';
  const userId = 'user-789';
  const playerId = 'player-456';

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

  function setupHappyPath(): void {
    let queryCount = 0;
    (demandDeckService.drawCard as jest.Mock)
      .mockReturnValueOnce({ id: 10 })
      .mockReturnValueOnce({ id: 20 })
      .mockReturnValueOnce({ id: 30 });

    mockClient.query.mockImplementation((sql: string, params?: any[]) => {
      if (sql === 'BEGIN' || sql === 'COMMIT') return Promise.resolve();
      // Player lookup by user_id
      if (sql.includes('SELECT') && sql.includes('user_id')) {
        return Promise.resolve({
          rows: [{ id: playerId, hand: [1, 2, 3], turnNumber: 1 }],
        });
      }
      // Game state
      if (sql.includes('SELECT current_player_index')) {
        return Promise.resolve({
          rows: [{ current_player_index: 0 }],
        });
      }
      // Active player check
      if (sql.includes('SELECT id FROM players') && sql.includes('OFFSET')) {
        return Promise.resolve({
          rows: [{ id: playerId }],
        });
      }
      // Track build cost check
      if (sql.includes('turn_build_cost')) {
        return Promise.resolve({ rows: [{ turn_build_cost: 0 }] });
      }
      // Turn actions check
      if (sql.includes('turn_actions')) {
        return Promise.resolve({ rows: [] });
      }
      // Hand UPDATE
      if (sql.includes('UPDATE players') && sql.includes('hand')) {
        return Promise.resolve({ rows: [] });
      }
      // Turn number increment
      if (sql.includes('current_turn_number')) {
        return Promise.resolve({ rows: [] });
      }
      // Player count
      if (sql.includes('COUNT')) {
        return Promise.resolve({ rows: [{ count: 2 }] });
      }
      // Advance game turn
      if (sql.includes('UPDATE games')) {
        return Promise.resolve({ rows: [] });
      }
      // Next player lookup
      if (sql.includes('SELECT id, name FROM players')) {
        return Promise.resolve({
          rows: [{ id: 'next-player-id', name: 'Next Player' }],
        });
      }
      return Promise.resolve({ rows: [] });
    });
  }

  it('should advance the game turn (increment current_player_index)', async () => {
    setupHappyPath();

    const result = await PlayerService.discardHandForUser(gameId, userId);

    expect(result.currentPlayerIndex).toBe(1); // (0 + 1) % 2
    expect(result.nextPlayerId).toBe('next-player-id');

    // Verify turn advancement queries were made
    const turnNumberCall = mockClient.query.mock.calls.find(
      (call: any[]) => typeof call[0] === 'string' && call[0].includes('current_turn_number'),
    );
    expect(turnNumberCall).toBeDefined();

    const gameUpdateCall = mockClient.query.mock.calls.find(
      (call: any[]) => typeof call[0] === 'string' && call[0].includes('UPDATE games'),
    );
    expect(gameUpdateCall).toBeDefined();
  });

  it('should discard old cards and draw 3 new ones', async () => {
    setupHappyPath();

    await PlayerService.discardHandForUser(gameId, userId);

    expect(demandDeckService.discardCard).toHaveBeenCalledTimes(3);
    expect(demandDeckService.discardCard).toHaveBeenCalledWith(1);
    expect(demandDeckService.discardCard).toHaveBeenCalledWith(2);
    expect(demandDeckService.discardCard).toHaveBeenCalledWith(3);
    expect(demandDeckService.drawCard).toHaveBeenCalledTimes(3);
  });

  it('should reject when not the active player', async () => {
    mockClient.query.mockImplementation((sql: string) => {
      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return Promise.resolve();
      if (sql.includes('SELECT') && sql.includes('user_id')) {
        return Promise.resolve({
          rows: [{ id: playerId, hand: [1, 2, 3], turnNumber: 1 }],
        });
      }
      if (sql.includes('SELECT current_player_index')) {
        return Promise.resolve({ rows: [{ current_player_index: 0 }] });
      }
      if (sql.includes('SELECT id FROM players') && sql.includes('OFFSET')) {
        return Promise.resolve({ rows: [{ id: 'different-player' }] });
      }
      return Promise.resolve({ rows: [] });
    });

    await expect(
      PlayerService.discardHandForUser(gameId, userId),
    ).rejects.toThrow('Not your turn');
  });

  it('should rollback on failure and release client', async () => {
    mockClient.query.mockImplementation((sql: string) => {
      if (sql === 'BEGIN' || sql === 'ROLLBACK') return Promise.resolve();
      if (sql.includes('SELECT') && sql.includes('user_id')) {
        return Promise.reject(new Error('DB error'));
      }
      return Promise.resolve({ rows: [] });
    });

    await expect(
      PlayerService.discardHandForUser(gameId, userId),
    ).rejects.toThrow('DB error');

    expect(mockClient.query).toHaveBeenCalledWith('ROLLBACK');
    expect(mockClient.release).toHaveBeenCalled();
  });
});
