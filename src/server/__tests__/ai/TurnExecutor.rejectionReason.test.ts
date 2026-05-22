/**
 * TurnExecutor rejection-reason plumbing tests (JIRA-256 Phase 4, Layer 6).
 *
 * Verifies that when PlayerService throws ActionRestrictionError,
 * TurnExecutor catches it and returns a structured ExecutionResult with
 * rejectionReason populated.
 */

import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import {
  WorldSnapshot,
  AIActionType,
  TrainType,
  TerrainType,
  TrackSegment,
} from '../../../shared/types/GameTypes';
import { FeasibleOption } from '../../../shared/types/GameTypes';

// ── Mock dependencies ────────────────────────────────────────────────────────

jest.mock('../../db/index', () => ({
  db: { query: jest.fn(), connect: jest.fn() },
}));

jest.mock('../../services/socketService', () => ({
  emitToGame: jest.fn<() => void>(),
  emitStatePatch: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
}));

jest.mock('../../services/playerService', () => ({
  PlayerService: {
    buildTrackForPlayer: jest.fn<() => Promise<any>>(),
    moveTrainForUser: jest.fn<() => Promise<any>>(),
    pickupLoadForPlayer: jest.fn<() => Promise<any>>(),
    deliverLoadForUser: jest.fn<() => Promise<any>>(),
    dropLoadForPlayer: jest.fn<() => Promise<any>>(),
    upgradeTrainForPlayer: jest.fn<() => Promise<any>>(),
    discardHandForPlayer: jest.fn<() => Promise<any>>(),
    getPlayers: jest.fn<() => Promise<any[]>>().mockResolvedValue([]),
  },
  // Re-export the real ActionRestrictionError class so instanceof checks work in TurnExecutor
  ActionRestrictionError: class ActionRestrictionError extends Error {
    constructor(
      public readonly code: string,
      message: string,
    ) {
      super(message);
      this.name = 'ActionRestrictionError';
    }
  },
}));

jest.mock('../../services/MapTopology', () => ({
  loadGridPoints: jest.fn(() => new Map()),
  gridToPixel: jest.fn(() => ({ x: 0, y: 0 })),
}));

jest.mock('../../../shared/services/majorCityGroups', () => ({
  getMajorCityGroups: jest.fn(() => []),
  getMajorCityLookup: jest.fn(() => new Map()),
  getFerryEdges: jest.fn(() => []),
}));

jest.mock('../../../shared/services/cityPositionResolver', () => ({
  getCityNameAtPosition: jest.fn(() => 'Hamburg'),
}));

import { TurnExecutor } from '../../services/ai/TurnExecutor';
import { PlayerService, ActionRestrictionError } from '../../services/playerService';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeSnapshot(): WorldSnapshot {
  return {
    gameId: 'game-1',
    gameStatus: 'active',
    turnNumber: 3,
    bot: {
      playerId: 'bot-1',
      userId: 'user-bot-1',
      money: 50,
      position: { row: 10, col: 10 },
      existingSegments: [],
      demandCards: [],
      resolvedDemands: [],
      trainType: TrainType.Freight,
      loads: [],
      botConfig: null,
      connectedMajorCityCount: 0,
      pendingFloodRebuilds: [],
    },
    allPlayerTracks: [],
    loadAvailability: {},
    activeEffects: [],
  };
}

function makeSegment(): TrackSegment {
  return {
    from: { x: 0, y: 0, row: 10, col: 10, terrain: TerrainType.MajorCity },
    to: { x: 0, y: 0, row: 10, col: 11, terrain: TerrainType.Clear },
    cost: 1,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('TurnExecutor — rejection reason plumbing (JIRA-256)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('BuildTrack', () => {
    it('returns rejectionReason when PlayerService throws ActionRestrictionError', async () => {
      (PlayerService.buildTrackForPlayer as jest.Mock<any>).mockRejectedValueOnce(
        new ActionRestrictionError('RAIL_STRIKE_BLOCKED', 'Build blocked by Rail Strike'),
      );

      const plan: FeasibleOption = {
        action: AIActionType.BuildTrack,
        feasible: true,
        reason: 'test',
        segments: [makeSegment()],
        estimatedCost: 1,
      };

      const result = await TurnExecutor.execute(plan, makeSnapshot());

      expect(result.success).toBe(false);
      expect(result.rejectionReason).toBeDefined();
      expect(result.rejectionReason!.code).toBe('RAIL_STRIKE_BLOCKED');
      expect(result.rejectionReason!.message).toBe('Build blocked by Rail Strike');
      expect(result.error).toBe('Build blocked by Rail Strike');
    });

    it('does NOT catch non-ActionRestrictionError errors', async () => {
      (PlayerService.buildTrackForPlayer as jest.Mock<any>).mockRejectedValueOnce(
        new Error('Insufficient funds'),
      );

      const plan: FeasibleOption = {
        action: AIActionType.BuildTrack,
        feasible: true,
        reason: 'test',
        segments: [makeSegment()],
        estimatedCost: 1,
      };

      await expect(TurnExecutor.execute(plan, makeSnapshot())).rejects.toThrow('Insufficient funds');
    });
  });

  describe('MoveTrain', () => {
    it('returns rejectionReason when PlayerService throws ActionRestrictionError', async () => {
      (PlayerService.moveTrainForUser as jest.Mock<any>).mockRejectedValueOnce(
        new ActionRestrictionError('SNOW_BLOCKED_TERRAIN', 'Movement blocked by Snow'),
      );

      const plan: FeasibleOption = {
        action: AIActionType.MoveTrain,
        feasible: true,
        reason: 'test',
        movementPath: [{ row: 10, col: 10 }, { row: 10, col: 11 }],
        mileposts: 1,
      };

      const result = await TurnExecutor.execute(plan, makeSnapshot());

      expect(result.success).toBe(false);
      expect(result.rejectionReason).toBeDefined();
      expect(result.rejectionReason!.code).toBe('SNOW_BLOCKED_TERRAIN');
    });
  });

  describe('PickupLoad', () => {
    it('returns rejectionReason when PlayerService throws ActionRestrictionError', async () => {
      (PlayerService.pickupLoadForPlayer as jest.Mock<any>).mockRejectedValueOnce(
        new ActionRestrictionError('COASTAL_STRIKE_BLOCKED', 'Pickup blocked by Coastal Strike'),
      );

      const plan: FeasibleOption = {
        action: AIActionType.PickupLoad,
        feasible: true,
        reason: 'test',
        loadType: 'Coal' as any,
        targetCity: 'Hamburg',
      };

      const snapshot = makeSnapshot();
      snapshot.bot.position = { row: 10, col: 10 }; // simulate being at a city

      const result = await TurnExecutor.execute(plan, snapshot);

      expect(result.success).toBe(false);
      expect(result.rejectionReason).toBeDefined();
      expect(result.rejectionReason!.code).toBe('COASTAL_STRIKE_BLOCKED');
    });
  });

  describe('DeliverLoad', () => {
    it('returns rejectionReason when PlayerService throws ActionRestrictionError', async () => {
      (PlayerService.deliverLoadForUser as jest.Mock<any>).mockRejectedValueOnce(
        new ActionRestrictionError('COASTAL_STRIKE_BLOCKED', 'Delivery blocked by Coastal Strike'),
      );

      const snapshot = makeSnapshot();
      snapshot.bot.loads = ['Coal'];
      snapshot.bot.position = { row: 10, col: 10 };

      const plan: FeasibleOption = {
        action: AIActionType.DeliverLoad,
        feasible: true,
        reason: 'test',
        loadType: 'Coal' as any,
        targetCity: 'Hamburg',
        cardId: 42,
        payment: 10,
      };

      const result = await TurnExecutor.execute(plan, snapshot);

      expect(result.success).toBe(false);
      expect(result.rejectionReason).toBeDefined();
      expect(result.rejectionReason!.code).toBe('COASTAL_STRIKE_BLOCKED');
    });
  });
});
