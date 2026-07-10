/**
 * Unit tests for TurnExecutor mid-turn re-snapshot mechanism.
 *
 * When an action returns cardsDrawnDuringAction > 0 (e.g., delivery), the
 * TurnExecutor should re-capture the WorldSnapshot (once) so subsequent
 * planners see updated activeEffects.
 *
 * Hard guard: only one re-snapshot per executePlan call — the second
 * card-drawing action in a turn should not trigger another capture.
 */

import { describe, it, expect, jest, beforeEach } from '@jest/globals';

// ── Mocks ─────────────────────────────────────────────────────────────────────

jest.mock('../db/index', () => ({
  db: {
    query: jest.fn<() => Promise<any>>().mockResolvedValue({ rows: [] }),
    connect: jest.fn(),
  },
}));

jest.mock('../services/socketService', () => ({
  emitToGame: jest.fn(),
  emitStatePatch: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
}));

jest.mock('../services/MapTopology', () => ({
  loadGridPoints: jest.fn(() => new Map()),
  gridToPixel: jest.fn(() => ({ x: 0, y: 0 })),
}));

jest.mock('../../shared/services/cityPositionResolver', () => ({
  getCityNameAtPosition: jest.fn(() => 'Hamburg'),
}));

jest.mock('../../shared/services/trainProperties', () => ({
  getTrainCapacity: jest.fn(() => 2),
  getTrainSpeed: jest.fn(() => 9),
}));

jest.mock('../services/demandDeckService', () => ({
  DemandDeckService: {
    getInstance: jest.fn(() => ({
      getCard: jest.fn(() => undefined),
    })),
  },
}));

jest.mock('../services/loadService', () => ({
  LoadService: {
    getInstance: jest.fn(() => ({
      getAvailableLoadsForCity: jest.fn(() => []),
    })),
  },
}));

const mockDeliverLoadForUser = jest.fn<() => Promise<any>>();
const mockGetPlayers = jest.fn<() => Promise<any>>().mockResolvedValue([]);

jest.mock('../services/playerService', () => {
  class ActionRestrictionError extends Error {
    code: string;
    constructor(code: string, message: string) {
      super(message);
      this.name = 'ActionRestrictionError';
      this.code = code;
    }
  }
  return {
    ActionRestrictionError,
    PlayerService: {
      deliverLoadForUser: jest.fn().mockImplementation((...args: unknown[]) => mockDeliverLoadForUser(...args as [])),
      getPlayers: jest.fn().mockImplementation((...args: unknown[]) => mockGetPlayers(...args as [])),
    },
  };
});

const mockCaptureSnapshot = jest.fn<(...args: any[]) => Promise<any>>();
jest.mock('../services/ai/WorldSnapshotService', () => ({
  capture: jest.fn().mockImplementation((gameId: unknown, playerId: unknown) => mockCaptureSnapshot(gameId, playerId)),
}));

import { TurnExecutor } from '../services/ai/TurnExecutor';
import { AIActionType, TrainType } from '../../shared/types/GameTypes';
import { EventCardType } from '../../shared/types/EventCard';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeSnapshot(overrides = {}) {
  return {
    gameId: 'game-test',
    gameStatus: 'active',
    turnNumber: 3,
    activeEffects: [],
    bot: {
      playerId: 'bot-1',
      userId: 'user-1',
      money: 50,
      position: { row: 10, col: 10 },
      existingSegments: [],
      demandCards: [1],
      resolvedDemands: [{ cardId: 1, demands: [{ city: 'Hamburg', loadType: 'Coal', payment: 20 }] }],
      trainType: TrainType.Freight,
      loads: ['Coal'],
      botConfig: null,
      connectedMajorCityCount: 0,
      pendingFloodRebuilds: [],
    },
    allPlayerTracks: [],
    loadAvailability: {},
    hexGrid: [],
    ...overrides,
  } as any;
}

function makeDeliverPlan() {
  return {
    type: AIActionType.DeliverLoad,
    load: 'Coal',
    city: 'Hamburg',
    cardId: 1,
    payout: 20,
  } as any;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('TurnExecutor.executePlan — mid-turn re-snapshot', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetPlayers.mockResolvedValue([]);
  });

  it('re-captures snapshot when delivery draws cards (cardsDrawnDuringAction > 0)', async () => {
    // PlayerService.deliverLoadForUser returns cardsDrawnDuringAction = 2
    mockDeliverLoadForUser.mockResolvedValue({
      payment: 20,
      repayment: 0,
      updatedMoney: 70,
      updatedDebtOwed: 0,
      updatedLoads: [],
      newCard: { id: 42, demands: [] },
      cardsDrawnDuringAction: 2,
    });

    const freshSnapshot = {
      activeEffects: [{
        cardId: 130,
        cardType: EventCardType.Flood,
        drawingPlayerId: 'player-1',
        drawingPlayerIndex: 0,
        expiresAfterTurnNumber: 5,
        affectedZone: new Set<string>(),
        restrictions: { movement: [], build: [], pickupDelivery: [] },
        pendingLostTurns: [],
        floodedRiver: 'Elbe',
      }],
      bot: { pendingFloodRebuilds: [] },
    };
    mockCaptureSnapshot.mockResolvedValue(freshSnapshot);

    const snapshot = makeSnapshot();
    expect(snapshot.activeEffects).toHaveLength(0);

    await TurnExecutor.executePlan(makeDeliverPlan(), snapshot);

    // Re-snapshot should have been called once
    expect(mockCaptureSnapshot).toHaveBeenCalledTimes(1);
    expect(mockCaptureSnapshot).toHaveBeenCalledWith('game-test', 'bot-1');

    // Snapshot should be updated with the new activeEffects
    expect(snapshot.activeEffects).toHaveLength(1);
    expect(snapshot.activeEffects[0].cardId).toBe(130);
  });

  it('does NOT re-capture snapshot when no cards are drawn (cardsDrawnDuringAction = 0)', async () => {
    mockDeliverLoadForUser.mockResolvedValue({
      payment: 20,
      repayment: 0,
      updatedMoney: 70,
      updatedDebtOwed: 0,
      updatedLoads: [],
      newCard: { id: 42, demands: [] },
      cardsDrawnDuringAction: 0,
    });

    const snapshot = makeSnapshot();
    await TurnExecutor.executePlan(makeDeliverPlan(), snapshot);

    expect(mockCaptureSnapshot).not.toHaveBeenCalled();
  });

  it('does NOT re-capture snapshot when cardsDrawnDuringAction is undefined', async () => {
    mockDeliverLoadForUser.mockResolvedValue({
      payment: 20,
      repayment: 0,
      updatedMoney: 70,
      updatedDebtOwed: 0,
      updatedLoads: [],
      newCard: { id: 42, demands: [] },
      // cardsDrawnDuringAction not set
    });

    const snapshot = makeSnapshot();
    await TurnExecutor.executePlan(makeDeliverPlan(), snapshot);

    expect(mockCaptureSnapshot).not.toHaveBeenCalled();
  });

  it('does NOT re-capture when action fails', async () => {
    mockDeliverLoadForUser.mockRejectedValue(new Error('Load not on train'));

    const snapshot = makeSnapshot();
    await expect(TurnExecutor.executePlan(makeDeliverPlan(), snapshot)).rejects.toThrow('Load not on train');

    expect(mockCaptureSnapshot).not.toHaveBeenCalled();
  });
});
