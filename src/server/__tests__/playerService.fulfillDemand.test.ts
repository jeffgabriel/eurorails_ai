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
    discardEventCard: jest.fn(),
    drawCard: jest.fn(),
    returnDealtCardToTop: jest.fn(),
    returnDiscardedCardToDealt: jest.fn(),
  },
}));

const { __mockClient: mockClient } = jest.requireMock('../db/index') as {
  __mockClient: { query: jest.Mock; release: jest.Mock };
};

/** Helper to create a demand CardDrawResult mock value */
function demandResult(id: number) {
  return { type: 'demand' as const, card: { id, demands: [] } };
}

/** Helper to create an event CardDrawResult mock value */
function eventResult(id: number) {
  return {
    type: 'event' as const,
    card: {
      id,
      type: 'Strike' as const, // EventCardType.Strike
      title: 'Strike!',
      description: 'Test event card',
      effectConfig: { type: 'Strike' as const, variant: 'coastal' as const, coastalRadius: 3 },
    },
  };
}

describe('PlayerService.fulfillDemand', () => {
  const gameId = 'game-123';
  const playerId = 'player-456';
  const city = 'Paris';
  const loadType = 'Coal';
  const cardId = 5;

  beforeEach(() => {
    jest.clearAllMocks();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  function setupPlayerDb(hand: number[] = [cardId, 2, 3]): void {
    mockClient.query.mockImplementation((sql: string) => {
      if (sql === 'BEGIN' || sql === 'COMMIT') return Promise.resolve();
      if (sql.includes('SELECT hand, loads')) {
        return Promise.resolve({ rows: [{ hand, loads: ['Coal'] }] });
      }
      if (sql.includes('UPDATE players')) {
        return Promise.resolve({ rows: [] });
      }
      return Promise.resolve({ rows: [] });
    });
  }

  describe('demand card flow (happy path)', () => {
    it('should return the new demand card after fulfilling a demand', async () => {
      setupPlayerDb();
      (demandDeckService.drawCard as jest.Mock).mockReturnValueOnce(demandResult(99));

      const result = await PlayerService.fulfillDemand(gameId, playerId, city, loadType, cardId);

      expect(result.newCard).toBeDefined();
      expect(result.newCard.id).toBe(99);
    });

    it('should draw exactly one card when first draw is a demand card', async () => {
      setupPlayerDb();
      (demandDeckService.drawCard as jest.Mock).mockReturnValueOnce(demandResult(99));

      await PlayerService.fulfillDemand(gameId, playerId, city, loadType, cardId);

      expect(demandDeckService.drawCard).toHaveBeenCalledTimes(1);
    });

    it('should update the player hand in the database', async () => {
      setupPlayerDb([cardId, 2, 3]);
      (demandDeckService.drawCard as jest.Mock).mockReturnValueOnce(demandResult(99));

      await PlayerService.fulfillDemand(gameId, playerId, city, loadType, cardId);

      const updateCall = mockClient.query.mock.calls.find(
        (call: any[]) => typeof call[0] === 'string' && call[0].includes('UPDATE players'),
      );
      expect(updateCall).toBeDefined();
      // New hand replaces cardId with new card id 99
      expect(updateCall![1][0]).toEqual([99, 2, 3]);
    });

    it('should commit the transaction on success', async () => {
      setupPlayerDb();
      (demandDeckService.drawCard as jest.Mock).mockReturnValueOnce(demandResult(99));

      await PlayerService.fulfillDemand(gameId, playerId, city, loadType, cardId);

      expect(mockClient.query).toHaveBeenCalledWith('COMMIT');
      expect(mockClient.release).toHaveBeenCalled();
    });
  });

  describe('event card stub behavior', () => {
    it('should discard event cards and return next demand card', async () => {
      setupPlayerDb();
      (demandDeckService.drawCard as jest.Mock)
        .mockReturnValueOnce(eventResult(121))
        .mockReturnValueOnce(demandResult(99));

      const result = await PlayerService.fulfillDemand(gameId, playerId, city, loadType, cardId);

      expect(result.newCard.id).toBe(99);
      expect(demandDeckService.discardEventCard).toHaveBeenCalledTimes(1);
      expect(demandDeckService.discardEventCard).toHaveBeenCalledWith(121);
    });

    it('should discard multiple consecutive event cards before returning a demand card', async () => {
      setupPlayerDb();
      (demandDeckService.drawCard as jest.Mock)
        .mockReturnValueOnce(eventResult(121))
        .mockReturnValueOnce(eventResult(130))
        .mockReturnValueOnce(demandResult(99));

      const result = await PlayerService.fulfillDemand(gameId, playerId, city, loadType, cardId);

      expect(result.newCard.id).toBe(99);
      expect(demandDeckService.discardEventCard).toHaveBeenCalledTimes(2);
      expect(demandDeckService.discardEventCard).toHaveBeenCalledWith(121);
      expect(demandDeckService.discardEventCard).toHaveBeenCalledWith(130);
    });

    it('should log a warning when an event card is drawn', async () => {
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

      setupPlayerDb();
      (demandDeckService.drawCard as jest.Mock)
        .mockReturnValueOnce(eventResult(125))
        .mockReturnValueOnce(demandResult(99));

      await PlayerService.fulfillDemand(gameId, playerId, city, loadType, cardId);

      expect(warnSpy).toHaveBeenCalledTimes(1);
      const warnMessage = warnSpy.mock.calls[0][0] as string;
      expect(warnMessage).toContain('125');
    });

    it('should not call discardEventCard when only demand cards are drawn', async () => {
      setupPlayerDb();
      (demandDeckService.drawCard as jest.Mock).mockReturnValueOnce(demandResult(99));

      await PlayerService.fulfillDemand(gameId, playerId, city, loadType, cardId);

      expect(demandDeckService.discardEventCard).not.toHaveBeenCalled();
    });

    it('should draw again after event card until demand card found', async () => {
      setupPlayerDb();
      (demandDeckService.drawCard as jest.Mock)
        .mockReturnValueOnce(eventResult(121))
        .mockReturnValueOnce(demandResult(50));

      await PlayerService.fulfillDemand(gameId, playerId, city, loadType, cardId);

      // drawCard called twice: event card + demand card
      expect(demandDeckService.drawCard).toHaveBeenCalledTimes(2);
    });
  });

  describe('error handling', () => {
    it('should throw when player is not found', async () => {
      mockClient.query.mockImplementation((sql: string) => {
        if (sql === 'BEGIN' || sql === 'ROLLBACK') return Promise.resolve();
        if (sql.includes('SELECT hand, loads')) {
          return Promise.resolve({ rows: [] });
        }
        return Promise.resolve({ rows: [] });
      });

      await expect(
        PlayerService.fulfillDemand(gameId, playerId, city, loadType, cardId),
      ).rejects.toThrow('Player not found');
    });

    it('should throw when deck is exhausted (all cards are null)', async () => {
      setupPlayerDb();
      (demandDeckService.drawCard as jest.Mock).mockReturnValue(null);

      await expect(
        PlayerService.fulfillDemand(gameId, playerId, city, loadType, cardId),
      ).rejects.toThrow('Failed to draw new card');
    });

    it('should throw when deck is exhausted after event cards', async () => {
      setupPlayerDb();
      (demandDeckService.drawCard as jest.Mock)
        .mockReturnValueOnce(eventResult(121))
        .mockReturnValueOnce(null);

      await expect(
        PlayerService.fulfillDemand(gameId, playerId, city, loadType, cardId),
      ).rejects.toThrow('Failed to draw new card');
    });

    it('should rollback transaction on DB error', async () => {
      mockClient.query.mockImplementation((sql: string) => {
        if (sql === 'BEGIN' || sql === 'ROLLBACK') return Promise.resolve();
        if (sql.includes('SELECT hand, loads')) {
          return Promise.reject(new Error('DB read error'));
        }
        return Promise.resolve({ rows: [] });
      });

      await expect(
        PlayerService.fulfillDemand(gameId, playerId, city, loadType, cardId),
      ).rejects.toThrow('DB read error');

      expect(mockClient.query).toHaveBeenCalledWith('ROLLBACK');
      expect(mockClient.release).toHaveBeenCalled();
    });
  });
});
