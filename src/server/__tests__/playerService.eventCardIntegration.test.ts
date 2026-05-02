/**
 * Unit tests for PlayerService × EventCardService integration (BE-005).
 *
 * Verifies that:
 * - deliverLoadForUser calls EventCardService.processEventCard when an event card is drawn
 * - discardHandCore calls EventCardService.processEventCard for each event card drawn during
 *   the 3-card replacement loop
 * - After processEventCard returns, the event card is discarded and exactly one replacement
 *   card is drawn (for single-draw paths like deliverLoadForUser)
 */

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
      // Default: return empty rows so activeEffectManager queries don't fail
      query: jest.fn().mockResolvedValue({ rows: [] }),
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
    getCard: jest.fn(),
    returnDealtCardToTop: jest.fn(),
    returnDiscardedCardToDealt: jest.fn(),
    returnDiscardedEventCardToDrawPile: jest.fn(),
  },
}));

// Mock EventCardService — prevents real DB calls during event card processing
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

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeDemandCard(id: number, city = 'Paris', resource = 'Coal', payment = 10) {
  return {
    type: 'demand' as const,
    card: { id, demands: [{ city, resource, payment }] },
  };
}

function makeEventCard(id: number) {
  return {
    type: 'event' as const,
    card: {
      id,
      type: 'Strike' as const,
      title: 'Strike!',
      description: 'Test event card',
      effectConfig: { type: 'Strike' as const, variant: 'coastal' as const, coastalRadius: 3 },
    },
  };
}

// ── Tests: discardHandCore (via discardHandForPlayer) ─────────────────────────
// These tests use discardHandForPlayer which has simpler DB setup requirements

describe('PlayerService.discardHandForPlayer × EventCardService (BE-005)', () => {
  const gameId = 'game-002';
  const playerId = 'player-002';

  beforeEach(() => {
    jest.clearAllMocks();
    mockClient.query.mockImplementation((sql: string) => {
      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return Promise.resolve();
      // SELECT hand FOR UPDATE
      if (sql.includes('SELECT hand')) {
        return Promise.resolve({ rows: [{ hand: [1, 2, 3] }] });
      }
      if (sql.includes('UPDATE players')) {
        return Promise.resolve({ rows: [] });
      }
      return Promise.resolve({ rows: [] });
    });
  });

  it('calls EventCardService.processEventCard when an event card is drawn during hand replacement', async () => {
    (demandDeckService.drawCard as jest.Mock)
      .mockReturnValueOnce(makeEventCard(121))
      .mockReturnValueOnce(makeDemandCard(10))
      .mockReturnValueOnce(makeDemandCard(20))
      .mockReturnValueOnce(makeDemandCard(30));

    await PlayerService.discardHandForPlayer(gameId, playerId);

    expect(EventCardService.processEventCard).toHaveBeenCalledTimes(1);
    expect(EventCardService.processEventCard).toHaveBeenCalledWith(
      gameId,
      expect.objectContaining({ id: 121 }),
      playerId,
      expect.anything(), // client
    );
  });

  it('calls EventCardService.processEventCard for each event card in the replacement loop', async () => {
    (demandDeckService.drawCard as jest.Mock)
      .mockReturnValueOnce(makeEventCard(121))
      .mockReturnValueOnce(makeEventCard(122))
      .mockReturnValueOnce(makeDemandCard(10))
      .mockReturnValueOnce(makeDemandCard(20))
      .mockReturnValueOnce(makeDemandCard(30));

    await PlayerService.discardHandForPlayer(gameId, playerId);

    expect(EventCardService.processEventCard).toHaveBeenCalledTimes(2);
    expect(EventCardService.processEventCard).toHaveBeenCalledWith(
      gameId,
      expect.objectContaining({ id: 121 }),
      playerId,
      expect.anything(),
    );
    expect(EventCardService.processEventCard).toHaveBeenCalledWith(
      gameId,
      expect.objectContaining({ id: 122 }),
      playerId,
      expect.anything(),
    );
  });

  it('discards each event card after processing it', async () => {
    (demandDeckService.drawCard as jest.Mock)
      .mockReturnValueOnce(makeEventCard(121))
      .mockReturnValueOnce(makeDemandCard(10))
      .mockReturnValueOnce(makeDemandCard(20))
      .mockReturnValueOnce(makeDemandCard(30));

    await PlayerService.discardHandForPlayer(gameId, playerId);

    expect(demandDeckService.discardEventCard).toHaveBeenCalledWith(121);
  });

  it('continues drawing demand cards after event card until 3 are collected', async () => {
    (demandDeckService.drawCard as jest.Mock)
      .mockReturnValueOnce(makeEventCard(125))
      .mockReturnValueOnce(makeDemandCard(10))
      .mockReturnValueOnce(makeDemandCard(20))
      .mockReturnValueOnce(makeDemandCard(30));

    const result = await PlayerService.discardHandForPlayer(gameId, playerId);

    expect(result.newHandIds).toEqual([10, 20, 30]);
    // drawCard: 1 event + 3 demand = 4 calls total
    expect(demandDeckService.drawCard).toHaveBeenCalledTimes(4);
  });

  it('does not call EventCardService.processEventCard when only demand cards are drawn', async () => {
    (demandDeckService.drawCard as jest.Mock)
      .mockReturnValueOnce(makeDemandCard(10))
      .mockReturnValueOnce(makeDemandCard(20))
      .mockReturnValueOnce(makeDemandCard(30));

    await PlayerService.discardHandForPlayer(gameId, playerId);

    expect(EventCardService.processEventCard).not.toHaveBeenCalled();
  });

  it('passes the active transaction client to processEventCard', async () => {
    (demandDeckService.drawCard as jest.Mock)
      .mockReturnValueOnce(makeEventCard(125))
      .mockReturnValueOnce(makeDemandCard(10))
      .mockReturnValueOnce(makeDemandCard(20))
      .mockReturnValueOnce(makeDemandCard(30));

    await PlayerService.discardHandForPlayer(gameId, playerId);

    const callArgs = (EventCardService.processEventCard as jest.Mock).mock.calls[0];
    // 4th argument should be the mockClient (the active PoolClient transaction)
    expect(callArgs[3]).toBe(mockClient);
  });
});

// ── Tests: deliverLoadForUser ─────────────────────────────────────────────────
// These tests use deliverLoadForUser with full DB mock setup for its validation path

describe('PlayerService.deliverLoadForUser × EventCardService (BE-005)', () => {
  const gameId = 'game-001';
  const userId = 'user-001';
  const city = 'Paris';
  const resource = 'Coal';
  const cardId = 5;
  const playerId = 'player-001';

  beforeEach(() => {
    jest.clearAllMocks();

    // Set up getCard mock to return a valid demand card matching the delivery
    (demandDeckService.getCard as jest.Mock).mockReturnValue({
      id: cardId,
      demands: [{ city, resource, payment: 10 }],
    });

    // Set up comprehensive DB mock for deliverLoadForUser path
    mockClient.query.mockImplementation((sql: string) => {
      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') {
        return Promise.resolve();
      }
      // Player row with FOR UPDATE
      if (sql.includes('SELECT id, money')) {
        return Promise.resolve({
          rows: [{
            id: playerId,
            money: 50,
            debtOwed: 0,
            hand: [cardId, 2, 3],
            loads: [resource],
            turnNumber: 1,
          }],
        });
      }
      // Game row for current_player_index
      if (sql.includes('SELECT current_player_index')) {
        return Promise.resolve({ rows: [{ current_player_index: 0 }] });
      }
      // Active player query
      if (sql.includes('SELECT id FROM players WHERE game_id')) {
        return Promise.resolve({ rows: [{ id: playerId }] });
      }
      // UPDATE players, INSERT INTO turn_actions
      if (sql.includes('UPDATE players') || sql.includes('INSERT INTO turn_actions')) {
        return Promise.resolve({ rows: [] });
      }
      return Promise.resolve({ rows: [] });
    });
  });

  it('calls EventCardService.processEventCard when an event card is drawn during hand replacement', async () => {
    (demandDeckService.drawCard as jest.Mock)
      .mockReturnValueOnce(makeEventCard(121))
      .mockReturnValueOnce(makeDemandCard(99));

    await PlayerService.deliverLoadForUser(gameId, userId, city, resource as any, cardId);

    expect(EventCardService.processEventCard).toHaveBeenCalledTimes(1);
    expect(EventCardService.processEventCard).toHaveBeenCalledWith(
      gameId,
      expect.objectContaining({ id: 121 }),
      playerId,
      expect.anything(), // client
    );
  });

  it('discards the event card after processing it', async () => {
    (demandDeckService.drawCard as jest.Mock)
      .mockReturnValueOnce(makeEventCard(121))
      .mockReturnValueOnce(makeDemandCard(99));

    await PlayerService.deliverLoadForUser(gameId, userId, city, resource as any, cardId);

    expect(demandDeckService.discardEventCard).toHaveBeenCalledWith(121);
  });

  it('keeps drawing until a demand card is found', async () => {
    (demandDeckService.drawCard as jest.Mock)
      .mockReturnValueOnce(makeEventCard(121))
      .mockReturnValueOnce(makeEventCard(130))
      .mockReturnValueOnce(makeDemandCard(99));

    await PlayerService.deliverLoadForUser(gameId, userId, city, resource as any, cardId);

    expect(EventCardService.processEventCard).toHaveBeenCalledTimes(2);
    expect(demandDeckService.drawCard).toHaveBeenCalledTimes(3);
  });

  it('does not call EventCardService.processEventCard when only demand cards are drawn', async () => {
    (demandDeckService.drawCard as jest.Mock).mockReturnValueOnce(makeDemandCard(99));

    await PlayerService.deliverLoadForUser(gameId, userId, city, resource as any, cardId);

    expect(EventCardService.processEventCard).not.toHaveBeenCalled();
  });

  it('passes the active transaction client to processEventCard', async () => {
    (demandDeckService.drawCard as jest.Mock)
      .mockReturnValueOnce(makeEventCard(130))
      .mockReturnValueOnce(makeDemandCard(99));

    await PlayerService.deliverLoadForUser(gameId, userId, city, resource as any, cardId);

    const callArgs = (EventCardService.processEventCard as jest.Mock).mock.calls[0];
    // 4th argument should be the mockClient (the active PoolClient transaction)
    expect(callArgs[3]).toBe(mockClient);
  });

  it('throws when deck is exhausted after processing an event card', async () => {
    (demandDeckService.drawCard as jest.Mock)
      .mockReturnValueOnce(makeEventCard(121))
      .mockReturnValueOnce(null); // deck exhausted after event

    await expect(
      PlayerService.deliverLoadForUser(gameId, userId, city, resource as any, cardId),
    ).rejects.toThrow('Failed to draw new card');
  });
});
