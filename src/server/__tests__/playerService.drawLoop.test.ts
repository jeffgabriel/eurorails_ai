/**
 * Unit tests for addActiveEffect wiring in the draw loops of:
 * - PlayerService.fulfillDemand
 * - PlayerService.deliverLoadForUser
 * - PlayerService.discardHandForPlayer (via discardHandCore)
 */

import { PlayerService } from '../services/playerService';
import { demandDeckService } from '../services/demandDeckService';
import { EventCardService } from '../services/EventCardService';
import { activeEffectManager } from '../services/ActiveEffectManager';
import { EventCardType } from '../../shared/types/EventCard';

// Mock socketService
jest.mock('../services/socketService', () => ({
  emitTurnChange: jest.fn(),
  emitStatePatch: jest.fn().mockResolvedValue(undefined),
  getSocketIO: jest.fn().mockReturnValue(null),
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
    getCard: jest.fn(),
  },
}));

// Mock EventCardService
jest.mock('../services/EventCardService', () => ({
  EventCardService: {
    processEventCard: jest.fn(),
  },
}));

// Mock ActiveEffectManager
jest.mock('../services/ActiveEffectManager', () => ({
  activeEffectManager: {
    addActiveEffect: jest.fn().mockResolvedValue(undefined),
    cleanupExpiredEffects: jest.fn().mockResolvedValue({ expiredCardIds: [] }),
    consumeLostTurn: jest.fn().mockResolvedValue(false),
    getMovementRestrictions: jest.fn().mockResolvedValue([]),
    getBuildRestrictions: jest.fn().mockResolvedValue([]),
    getPickupDeliveryRestrictions: jest.fn().mockResolvedValue([]),
  },
}));

const { __mockClient: mockClient } = jest.requireMock('../db/index') as {
  __mockClient: { query: jest.Mock; release: jest.Mock };
};

const mockAddActiveEffect = activeEffectManager.addActiveEffect as jest.Mock;
const mockProcessEventCard = EventCardService.processEventCard as jest.Mock;

// ── Test fixtures ─────────────────────────────────────────────────────────────

function demandResult(id: number) {
  return { type: 'demand' as const, card: { id, demands: [] } };
}

function eventCardResult(id: number) {
  return {
    type: 'event' as const,
    card: {
      id,
      type: EventCardType.Strike,
      title: 'Strike!',
      description: 'Test event',
      effectConfig: { type: EventCardType.Strike, variant: 'coastal' as const, coastalRadius: 3 },
    },
  };
}

/** EventCardResult with persistentEffectDescriptor */
function persistentResult(cardId: number, descriptor = { cardId, drawingPlayerId: 'p1', drawingPlayerIndex: 0, expiresAfterTurnNumber: 2, affectedZone: [] }) {
  return {
    cardId,
    cardType: EventCardType.Strike,
    drawingPlayerId: 'p1',
    affectedZone: [],
    perPlayerEffects: [],
    floodSegmentsRemoved: [],
    persistentEffectDescriptor: descriptor,
  };
}

/** EventCardResult for Flood with floodedRiver */
function floodPersistentResult(cardId: number, riverName: string, descriptor = { cardId, drawingPlayerId: 'p1', drawingPlayerIndex: 0, expiresAfterTurnNumber: 2, affectedZone: [] as string[] }) {
  return {
    cardId,
    cardType: EventCardType.Flood,
    drawingPlayerId: 'p1',
    affectedZone: [] as string[],
    perPlayerEffects: [],
    floodSegmentsRemoved: [],
    persistentEffectDescriptor: descriptor,
    floodedRiver: riverName,
  };
}

function floodEventCardResult(id: number) {
  return {
    type: 'event' as const,
    card: {
      id,
      type: EventCardType.Flood,
      title: 'Flood!',
      description: 'Test flood event',
      effectConfig: { type: EventCardType.Flood, river: 'Rhine' },
    },
  };
}

/** EventCardResult WITHOUT persistentEffectDescriptor (e.g. ExcessProfitTax) */
function nonPersistentResult(cardId: number) {
  return {
    cardId,
    cardType: EventCardType.ExcessProfitTax,
    drawingPlayerId: 'p1',
    affectedZone: [],
    perPlayerEffects: [],
    floodSegmentsRemoved: [],
  };
}

// ── fulfillDemand draw loop ───────────────────────────────────────────────────

describe('PlayerService.fulfillDemand — draw loop addActiveEffect', () => {
  const gameId = 'game-1';
  const playerId = 'player-1';
  const cardId = 5;

  beforeEach(() => {
    jest.clearAllMocks();
    mockClient.query.mockImplementation((sql: string) => {
      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return Promise.resolve();
      if (sql.includes('SELECT hand, loads')) {
        return Promise.resolve({ rows: [{ hand: [cardId, 2, 3], loads: [] }] });
      }
      if (sql.includes('UPDATE players')) return Promise.resolve({ rows: [] });
      return Promise.resolve({ rows: [] });
    });
  });

  it('should call addActiveEffect when processEventCard returns persistentEffectDescriptor', async () => {
    const descriptor = { cardId: 121, drawingPlayerId: playerId, drawingPlayerIndex: 0, expiresAfterTurnNumber: 2, affectedZone: [] };
    mockProcessEventCard.mockResolvedValue(persistentResult(121, descriptor));
    (demandDeckService.drawCard as jest.Mock)
      .mockReturnValueOnce(eventCardResult(121))
      .mockReturnValueOnce(demandResult(99));

    await PlayerService.fulfillDemand(gameId, playerId, 'Paris', 'Coal', cardId);

    expect(mockAddActiveEffect).toHaveBeenCalledTimes(1);
    expect(mockAddActiveEffect).toHaveBeenCalledWith(
      gameId,
      descriptor,
      EventCardType.Strike,
      [],
      expect.anything(), // client
      undefined, // floodedRiver
    );
  });

  it('should NOT call addActiveEffect when persistentEffectDescriptor is absent', async () => {
    mockProcessEventCard.mockResolvedValue(nonPersistentResult(124));
    (demandDeckService.drawCard as jest.Mock)
      .mockReturnValueOnce(eventCardResult(124))
      .mockReturnValueOnce(demandResult(99));

    await PlayerService.fulfillDemand(gameId, playerId, 'Paris', 'Coal', cardId);

    expect(mockAddActiveEffect).not.toHaveBeenCalled();
  });

  it('should call addActiveEffect for each persistent event card in sequence', async () => {
    const desc1 = { cardId: 121, drawingPlayerId: playerId, drawingPlayerIndex: 0, expiresAfterTurnNumber: 2, affectedZone: [] };
    const desc2 = { cardId: 130, drawingPlayerId: playerId, drawingPlayerIndex: 0, expiresAfterTurnNumber: 2, affectedZone: [] };
    mockProcessEventCard
      .mockResolvedValueOnce(persistentResult(121, desc1))
      .mockResolvedValueOnce(persistentResult(130, desc2));
    (demandDeckService.drawCard as jest.Mock)
      .mockReturnValueOnce(eventCardResult(121))
      .mockReturnValueOnce(eventCardResult(130))
      .mockReturnValueOnce(demandResult(99));

    await PlayerService.fulfillDemand(gameId, playerId, 'Paris', 'Coal', cardId);

    expect(mockAddActiveEffect).toHaveBeenCalledTimes(2);
  });

  it('should pass floodedRiver to addActiveEffect for Flood events', async () => {
    const descriptor = { cardId: 133, drawingPlayerId: playerId, drawingPlayerIndex: 0, expiresAfterTurnNumber: 2, affectedZone: [] as string[] };
    mockProcessEventCard.mockResolvedValue(floodPersistentResult(133, 'Rhine', descriptor));
    (demandDeckService.drawCard as jest.Mock)
      .mockReturnValueOnce(floodEventCardResult(133))
      .mockReturnValueOnce(demandResult(99));

    await PlayerService.fulfillDemand(gameId, playerId, 'Paris', 'Coal', cardId);

    expect(mockAddActiveEffect).toHaveBeenCalledTimes(1);
    expect(mockAddActiveEffect).toHaveBeenCalledWith(
      gameId,
      descriptor,
      EventCardType.Flood,
      [],
      expect.anything(), // client
      'Rhine',
    );
  });

  it('should still draw until demand card after persisting effects', async () => {
    mockProcessEventCard.mockResolvedValue(persistentResult(121));
    (demandDeckService.drawCard as jest.Mock)
      .mockReturnValueOnce(eventCardResult(121))
      .mockReturnValueOnce(demandResult(99));

    const result = await PlayerService.fulfillDemand(gameId, playerId, 'Paris', 'Coal', cardId);

    expect(result.newCard.id).toBe(99);
    expect(demandDeckService.drawCard).toHaveBeenCalledTimes(2);
  });
});

// ── discardHandForPlayer draw loop ────────────────────────────────────────────

describe('PlayerService.discardHandForPlayer — draw loop addActiveEffect', () => {
  const gameId = 'game-1';
  const playerId = 'player-1';

  beforeEach(() => {
    jest.clearAllMocks();
    mockClient.query.mockImplementation((sql: string) => {
      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return Promise.resolve();
      if (sql.includes('SELECT hand') && sql.includes('FOR UPDATE')) {
        return Promise.resolve({ rows: [{ hand: [1, 2, 3] }] });
      }
      if (sql.includes('UPDATE players')) return Promise.resolve({ rows: [] });
      return Promise.resolve({ rows: [] });
    });
  });

  it('should call addActiveEffect when drawing persistent event card in discard loop', async () => {
    const descriptor = { cardId: 130, drawingPlayerId: playerId, drawingPlayerIndex: 0, expiresAfterTurnNumber: 3, affectedZone: [] };
    mockProcessEventCard.mockResolvedValue(persistentResult(130, descriptor));
    // need to draw 3 demand cards; first slot has an event card
    (demandDeckService.drawCard as jest.Mock)
      .mockReturnValueOnce(eventCardResult(130))
      .mockReturnValueOnce(demandResult(10))
      .mockReturnValueOnce(demandResult(11))
      .mockReturnValueOnce(demandResult(12));

    await PlayerService.discardHandForPlayer(gameId, playerId);

    expect(mockAddActiveEffect).toHaveBeenCalledTimes(1);
    expect(mockAddActiveEffect).toHaveBeenCalledWith(
      gameId,
      descriptor,
      EventCardType.Strike,
      [],
      expect.anything(),
      undefined, // floodedRiver
    );
  });

  it('should NOT call addActiveEffect for non-persistent event cards in discard loop', async () => {
    mockProcessEventCard.mockResolvedValue(nonPersistentResult(124));
    (demandDeckService.drawCard as jest.Mock)
      .mockReturnValueOnce(eventCardResult(124))
      .mockReturnValueOnce(demandResult(10))
      .mockReturnValueOnce(demandResult(11))
      .mockReturnValueOnce(demandResult(12));

    await PlayerService.discardHandForPlayer(gameId, playerId);

    expect(mockAddActiveEffect).not.toHaveBeenCalled();
  });

  it('should call addActiveEffect multiple times for multiple persistent events in discard loop', async () => {
    const desc1 = { cardId: 121, drawingPlayerId: playerId, drawingPlayerIndex: 0, expiresAfterTurnNumber: 2, affectedZone: [] };
    const desc2 = { cardId: 130, drawingPlayerId: playerId, drawingPlayerIndex: 0, expiresAfterTurnNumber: 2, affectedZone: [] };
    mockProcessEventCard
      .mockResolvedValueOnce(persistentResult(121, desc1))
      .mockResolvedValueOnce(persistentResult(130, desc2));
    (demandDeckService.drawCard as jest.Mock)
      .mockReturnValueOnce(eventCardResult(121))
      .mockReturnValueOnce(eventCardResult(130))
      .mockReturnValueOnce(demandResult(10))
      .mockReturnValueOnce(demandResult(11))
      .mockReturnValueOnce(demandResult(12));

    await PlayerService.discardHandForPlayer(gameId, playerId);

    expect(mockAddActiveEffect).toHaveBeenCalledTimes(2);
  });
});

// ── deliverLoadForUser draw loop ────────────────────────────────────────────

describe('PlayerService.deliverLoadForUser — draw loop addActiveEffect', () => {
  const gameId = 'game-1';
  const userId = 'user-1';
  const playerId = 'player-1';
  const cardId = 5;

  beforeEach(() => {
    jest.clearAllMocks();
    mockClient.query.mockImplementation((sql: string, params?: any[]) => {
      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return Promise.resolve();
      // Player SELECT FOR UPDATE
      if (sql.includes('SELECT id, money') && sql.includes('user_id')) {
        return Promise.resolve({
          rows: [{
            id: playerId,
            money: 100,
            debtOwed: 0,
            hand: [cardId, 2, 3],
            loads: ['Coal'],
            turnNumber: 1,
          }],
        });
      }
      // Game current_player_index
      if (sql.includes('current_player_index') && sql.includes('games')) {
        return Promise.resolve({ rows: [{ current_player_index: 0 }] });
      }
      // Active player lookup
      if (sql.includes('ORDER BY created_at ASC LIMIT 1 OFFSET')) {
        return Promise.resolve({ rows: [{ id: playerId }] });
      }
      if (sql.includes('UPDATE players')) return Promise.resolve({ rows: [] });
      return Promise.resolve({ rows: [] });
    });

    // Mock getCard to return a valid demand card
    (demandDeckService.getCard as jest.Mock).mockReturnValue({
      id: cardId,
      demands: [{ city: 'Berlin', resource: 'Coal', payment: 10 }],
    });

    // Mock getPickupDeliveryRestrictions to return empty
    (activeEffectManager.getPickupDeliveryRestrictions as jest.Mock).mockResolvedValue([]);
  });

  it('should call addActiveEffect when processEventCard returns persistentEffectDescriptor', async () => {
    const descriptor = { cardId: 121, drawingPlayerId: playerId, drawingPlayerIndex: 0, expiresAfterTurnNumber: 2, affectedZone: [] };
    mockProcessEventCard.mockResolvedValue(persistentResult(121, descriptor));
    (demandDeckService.drawCard as jest.Mock)
      .mockReturnValueOnce(eventCardResult(121))
      .mockReturnValueOnce(demandResult(99));

    await PlayerService.deliverLoadForUser(gameId, userId, 'Berlin', 'Coal' as any, cardId);

    expect(mockAddActiveEffect).toHaveBeenCalledTimes(1);
    expect(mockAddActiveEffect).toHaveBeenCalledWith(
      gameId,
      descriptor,
      EventCardType.Strike,
      [],
      expect.anything(),
      undefined,
    );
  });

  it('should NOT call addActiveEffect when persistentEffectDescriptor is absent', async () => {
    mockProcessEventCard.mockResolvedValue(nonPersistentResult(124));
    (demandDeckService.drawCard as jest.Mock)
      .mockReturnValueOnce(eventCardResult(124))
      .mockReturnValueOnce(demandResult(99));

    await PlayerService.deliverLoadForUser(gameId, userId, 'Berlin', 'Coal' as any, cardId);

    expect(mockAddActiveEffect).not.toHaveBeenCalled();
  });

  it('should pass floodedRiver to addActiveEffect for Flood events', async () => {
    const descriptor = { cardId: 133, drawingPlayerId: playerId, drawingPlayerIndex: 0, expiresAfterTurnNumber: 2, affectedZone: [] as string[] };
    mockProcessEventCard.mockResolvedValue(floodPersistentResult(133, 'Danube', descriptor));
    (demandDeckService.drawCard as jest.Mock)
      .mockReturnValueOnce(floodEventCardResult(133))
      .mockReturnValueOnce(demandResult(99));

    await PlayerService.deliverLoadForUser(gameId, userId, 'Berlin', 'Coal' as any, cardId);

    expect(mockAddActiveEffect).toHaveBeenCalledTimes(1);
    expect(mockAddActiveEffect).toHaveBeenCalledWith(
      gameId,
      descriptor,
      EventCardType.Flood,
      [],
      expect.anything(),
      'Danube',
    );
  });
});
