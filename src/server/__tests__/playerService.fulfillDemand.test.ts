import { db } from '../db/index';
import { PlayerService } from '../services/playerService';
import { demandDeckService } from '../services/demandDeckService';
import { EventCardService } from '../services/EventCardService';

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

// Mock EventCardService — prevents real DB calls when event cards are drawn
jest.mock('../services/EventCardService', () => ({
  EventCardService: {
    processEventCard: jest.fn().mockResolvedValue({
      cardId: 0,
      cardType: 'Strike',
      drawingPlayerId: '',
      affectedZone: [],
      perPlayerEffects: [],
      floodSegmentsRemoved: [],
    }),
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

  describe('event card integration behavior (BE-005)', () => {
    it('should call EventCardService.processEventCard when an event card is drawn', async () => {
      setupPlayerDb();
      (demandDeckService.drawCard as jest.Mock)
        .mockReturnValueOnce(eventResult(121))
        .mockReturnValueOnce(demandResult(99));

      await PlayerService.fulfillDemand(gameId, playerId, city, loadType, cardId);

      expect(EventCardService.processEventCard).toHaveBeenCalledTimes(1);
      expect(EventCardService.processEventCard).toHaveBeenCalledWith(
        gameId,
        expect.objectContaining({ id: 121 }),
        playerId,
        expect.anything(), // client
      );
    });

    it('should discard the event card after processing it', async () => {
      setupPlayerDb();
      (demandDeckService.drawCard as jest.Mock)
        .mockReturnValueOnce(eventResult(121))
        .mockReturnValueOnce(demandResult(99));

      await PlayerService.fulfillDemand(gameId, playerId, city, loadType, cardId);

      expect(demandDeckService.discardEventCard).toHaveBeenCalledTimes(1);
      expect(demandDeckService.discardEventCard).toHaveBeenCalledWith(121);
    });

    it('should draw exactly one replacement card after processing an event card', async () => {
      setupPlayerDb();
      (demandDeckService.drawCard as jest.Mock)
        .mockReturnValueOnce(eventResult(121))
        .mockReturnValueOnce(demandResult(99));

      const result = await PlayerService.fulfillDemand(gameId, playerId, city, loadType, cardId);

      // drawCard called exactly twice: event card + one replacement
      expect(demandDeckService.drawCard).toHaveBeenCalledTimes(2);
      expect(result.newCard.id).toBe(99);
    });

    it('should use the replacement card (even if it is an event card) — Project 3 handles the full loop', async () => {
      setupPlayerDb();
      // First draw: event card, second draw (replacement): another event card
      (demandDeckService.drawCard as jest.Mock)
        .mockReturnValueOnce(eventResult(121))
        .mockReturnValueOnce(eventResult(130));

      const result = await PlayerService.fulfillDemand(gameId, playerId, city, loadType, cardId);

      // Only first event card is processed; second draw is the replacement used as-is
      expect(EventCardService.processEventCard).toHaveBeenCalledTimes(1);
      expect(demandDeckService.drawCard).toHaveBeenCalledTimes(2);
      expect(result.newCard.id).toBe(130);
    });

    it('should log an info message (not warn) when an event card is drawn', async () => {
      const infoSpy = jest.spyOn(console, 'info').mockImplementation(() => {});

      setupPlayerDb();
      (demandDeckService.drawCard as jest.Mock)
        .mockReturnValueOnce(eventResult(125))
        .mockReturnValueOnce(demandResult(99));

      await PlayerService.fulfillDemand(gameId, playerId, city, loadType, cardId);

      expect(infoSpy).toHaveBeenCalledTimes(1);
      const infoMessage = infoSpy.mock.calls[0][0] as string;
      expect(infoMessage).toContain('125');
    });

    it('should not call EventCardService.processEventCard when only demand cards are drawn', async () => {
      setupPlayerDb();
      (demandDeckService.drawCard as jest.Mock).mockReturnValueOnce(demandResult(99));

      await PlayerService.fulfillDemand(gameId, playerId, city, loadType, cardId);

      expect(EventCardService.processEventCard).not.toHaveBeenCalled();
      expect(demandDeckService.discardEventCard).not.toHaveBeenCalled();
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

    it('should throw when deck is exhausted (first draw is null)', async () => {
      setupPlayerDb();
      (demandDeckService.drawCard as jest.Mock).mockReturnValue(null);

      await expect(
        PlayerService.fulfillDemand(gameId, playerId, city, loadType, cardId),
      ).rejects.toThrow('Failed to draw new card');
    });

    it('should throw when deck is exhausted after processing one event card', async () => {
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
