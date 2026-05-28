/**
 * Unit tests for TurnExecutor rejection plumbing — verifies that
 * ActionRestrictionError thrown by PlayerService is caught per handler
 * and surfaces as ExecutionResult.rejectionReason.
 *
 * Other errors are expected to propagate (not be swallowed).
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
      markLoadAsTaken: jest.fn(),
    })),
  },
}));

// Mock PlayerService — we'll configure specific methods per test
const mockBuildTrackForPlayer = jest.fn<() => Promise<any>>();
const mockMoveTrainForUser = jest.fn<() => Promise<any>>();
const mockPickupLoadForPlayer = jest.fn<() => Promise<any>>();
const mockDeliverLoadForUser = jest.fn<() => Promise<any>>();
const mockGetPlayers = jest.fn<() => Promise<any>>().mockResolvedValue([]);

jest.mock('../services/playerService', () => {
  // Re-export real ActionRestrictionError class so tests can use it
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
      buildTrackForPlayer: jest.fn().mockImplementation((...args: unknown[]) => mockBuildTrackForPlayer(...args as [])),
      moveTrainForUser: jest.fn().mockImplementation((...args: unknown[]) => mockMoveTrainForUser(...args as [])),
      pickupLoadForPlayer: jest.fn().mockImplementation((...args: unknown[]) => mockPickupLoadForPlayer(...args as [])),
      deliverLoadForUser: jest.fn().mockImplementation((...args: unknown[]) => mockDeliverLoadForUser(...args as [])),
      getPlayers: jest.fn().mockImplementation((...args: unknown[]) => mockGetPlayers(...args as [])),
    },
  };
});

import { TurnExecutor } from '../services/ai/TurnExecutor';
import { AIActionType, TrainType } from '../../shared/types/GameTypes';
import { TerrainType } from '../../shared/types/GameTypes';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeSnapshot() {
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
  } as any;
}

function makeRestrictionError(code: string, message: string) {
  const { ActionRestrictionError } = jest.requireMock('../services/playerService') as any;
  return new ActionRestrictionError(code, message);
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('TurnExecutor — rejection plumbing (ActionRestrictionError)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('handleBuildTrack', () => {
    it('populates rejectionReason when PlayerService.buildTrackForPlayer throws ActionRestrictionError', async () => {
      const error = makeRestrictionError('SNOW_BLOCKED_TERRAIN', 'Build blocked by Snow');
      mockBuildTrackForPlayer.mockRejectedValue(error);

      const plan = {
        type: AIActionType.BuildTrack,
        segments: [{
          from: { row: 10, col: 10, x: 0, y: 0, terrain: TerrainType.Clear },
          to: { row: 10, col: 11, x: 0, y: 0, terrain: TerrainType.Alpine },
          cost: 5,
        }],
      };

      const result = await TurnExecutor.executePlan(plan as any, makeSnapshot());

      expect(result.success).toBe(false);
      expect(result.rejectionReason).toBeDefined();
      expect(result.rejectionReason?.code).toBe('SNOW_BLOCKED_TERRAIN');
      expect(result.rejectionReason?.message).toContain('blocked');
    });

    it('re-throws non-ActionRestrictionError from buildTrackForPlayer', async () => {
      mockBuildTrackForPlayer.mockRejectedValue(new Error('DB connection failed'));

      const plan = {
        type: AIActionType.BuildTrack,
        segments: [{
          from: { row: 10, col: 10, x: 0, y: 0, terrain: TerrainType.Clear },
          to: { row: 10, col: 11, x: 0, y: 0, terrain: TerrainType.Clear },
          cost: 1,
        }],
      };

      await expect(TurnExecutor.executePlan(plan as any, makeSnapshot())).rejects.toThrow('DB connection failed');
    });
  });

  describe('handleMoveTrain', () => {
    it('populates rejectionReason when PlayerService.moveTrainForUser throws ActionRestrictionError', async () => {
      const error = makeRestrictionError('RAIL_STRIKE_BLOCKED', 'Movement blocked by Rail Strike');
      mockMoveTrainForUser.mockRejectedValue(error);

      const plan = {
        type: AIActionType.MoveTrain,
        path: [{ row: 10, col: 10 }, { row: 10, col: 11 }],
      };

      const result = await TurnExecutor.executePlan(plan as any, makeSnapshot());

      expect(result.success).toBe(false);
      expect(result.rejectionReason).toBeDefined();
      expect(result.rejectionReason?.code).toBe('RAIL_STRIKE_BLOCKED');
    });

    it('re-throws non-ActionRestrictionError from moveTrainForUser', async () => {
      mockMoveTrainForUser.mockRejectedValue(new Error('Network timeout'));

      const plan = {
        type: AIActionType.MoveTrain,
        path: [{ row: 10, col: 10 }, { row: 10, col: 11 }],
      };

      await expect(TurnExecutor.executePlan(plan as any, makeSnapshot())).rejects.toThrow('Network timeout');
    });
  });

  describe('handlePickupLoad', () => {
    it('populates rejectionReason when PlayerService.pickupLoadForPlayer throws ActionRestrictionError', async () => {
      const error = makeRestrictionError('COASTAL_STRIKE_BLOCKED', 'Pickup blocked by Strike');
      mockPickupLoadForPlayer.mockRejectedValue(error);

      const plan = {
        type: AIActionType.PickupLoad,
        load: 'Coal',
        city: 'Hamburg',
      };

      const result = await TurnExecutor.executePlan(plan as any, makeSnapshot());

      expect(result.success).toBe(false);
      expect(result.rejectionReason).toBeDefined();
      expect(result.rejectionReason?.code).toBe('COASTAL_STRIKE_BLOCKED');
    });
  });

  describe('handleDeliverLoad', () => {
    it('populates rejectionReason when PlayerService.deliverLoadForUser throws ActionRestrictionError', async () => {
      const error = makeRestrictionError('COASTAL_STRIKE_BLOCKED', 'Delivery blocked by Strike');
      mockDeliverLoadForUser.mockRejectedValue(error);

      const plan = {
        type: AIActionType.DeliverLoad,
        load: 'Coal',
        city: 'Hamburg',
        cardId: 1,
        payout: 20,
      };

      const result = await TurnExecutor.executePlan(plan as any, makeSnapshot());

      expect(result.success).toBe(false);
      expect(result.rejectionReason).toBeDefined();
      expect(result.rejectionReason?.code).toBe('COASTAL_STRIKE_BLOCKED');
    });

    it('re-throws non-ActionRestrictionError from deliverLoadForUser', async () => {
      mockDeliverLoadForUser.mockRejectedValue(new Error('Demand card not in hand'));

      const plan = {
        type: AIActionType.DeliverLoad,
        load: 'Coal',
        city: 'Hamburg',
        cardId: 1,
        payout: 20,
      };

      await expect(TurnExecutor.executePlan(plan as any, makeSnapshot())).rejects.toThrow('Demand card not in hand');
    });
  });
});
