/**
 * Unit tests for TurnExecutor.
 * Tests plan execution, action dispatch, and error handling.
 */

import { makeSnapshot, makeSegment } from './helpers/testFixtures';
import { TurnExecutor } from '../../ai/TurnExecutor';
import { AIActionType } from '../../ai/types';
import type { FeasibleOption, TurnPlan } from '../../ai/types';
import { TrainType, TerrainType } from '../../../shared/types/GameTypes';
import { LoadType } from '../../../shared/types/LoadTypes';

// --- Mocks ---

// Mock majorCityGroups
jest.mock('../../../shared/services/majorCityGroups', () => ({
  getMajorCityGroups: () => [],
  getFerryEdges: () => [],
}));

// Mock PlayerService
const mockMoveTrainForUser = jest.fn().mockResolvedValue({
  feeTotal: 0,
  ownersUsed: [],
  ownersPaid: [],
  affectedPlayerIds: ['bot-1'],
  updatedPosition: { row: 1, col: 2 },
  updatedMoney: 50,
});

const mockDeliverLoadForUser = jest.fn().mockResolvedValue({
  payment: 20,
  repayment: 0,
  updatedMoney: 70,
  updatedDebtOwed: 0,
  updatedLoads: [],
  newCard: { id: 99, demands: [] },
});

const mockPurchaseTrainType = jest.fn().mockResolvedValue({
  id: 'bot-1',
  trainType: TrainType.FastFreight,
  money: 30,
});

jest.mock('../../services/playerService', () => ({
  PlayerService: {
    moveTrainForUser: (...args: any[]) => mockMoveTrainForUser(...args),
    deliverLoadForUser: (...args: any[]) => mockDeliverLoadForUser(...args),
    purchaseTrainType: (...args: any[]) => mockPurchaseTrainType(...args),
  },
}));

// Mock TrackService
const mockGetTrackState = jest.fn().mockResolvedValue(null);

jest.mock('../../services/trackService', () => ({
  TrackService: {
    getTrackState: (...args: any[]) => mockGetTrackState(...args),
  },
}));

// Mock LoadService
const mockReturnLoad = jest.fn().mockResolvedValue({
  loadState: { loadType: 'Coal', availableCount: 4, totalCount: 4, cities: [] },
  droppedLoads: [],
});
const mockPickupDroppedLoad = jest.fn().mockResolvedValue({
  loadState: { loadType: 'Coal', availableCount: 3, totalCount: 4, cities: [] },
  droppedLoads: [],
});

jest.mock('../../services/loadService', () => ({
  loadService: {
    returnLoad: (...args: any[]) => mockReturnLoad(...args),
    pickupDroppedLoad: (...args: any[]) => mockPickupDroppedLoad(...args),
  },
}));

// Mock database
const mockQuery = jest.fn();
const mockRelease = jest.fn();
const mockConnect = jest.fn().mockResolvedValue({
  query: mockQuery,
  release: mockRelease,
});

jest.mock('../../db/index', () => ({
  db: {
    connect: () => mockConnect(),
  },
}));

// --- Helpers ---

function makePassAction(): FeasibleOption {
  return {
    type: AIActionType.PassTurn,
    description: 'Pass turn',
    feasible: true,
    params: { type: AIActionType.PassTurn },
  };
}

function makeDeliverAction(overrides: Partial<{
  movePath: any[];
  city: string;
  loadType: LoadType;
  demandCardId: number;
  demandIndex: number;
}> = {}): FeasibleOption {
  return {
    type: AIActionType.DeliverLoad,
    description: 'Deliver Coal to Berlin',
    feasible: true,
    params: {
      type: AIActionType.DeliverLoad,
      movePath: overrides.movePath ?? [{ row: 1, col: 1 }, { row: 1, col: 2 }],
      city: overrides.city ?? 'Berlin',
      loadType: overrides.loadType ?? LoadType.Coal,
      demandCardId: overrides.demandCardId ?? 1,
      demandIndex: overrides.demandIndex ?? 0,
    },
  };
}

function makeBuildAction(overrides: Partial<{
  segments: any[];
  totalCost: number;
}> = {}): FeasibleOption {
  return {
    type: AIActionType.BuildTrack,
    description: 'Build track',
    feasible: true,
    params: {
      type: AIActionType.BuildTrack,
      segments: overrides.segments ?? [
        makeSegment(1, 1, TerrainType.Clear, 1, 2, TerrainType.Clear, 1),
      ],
      totalCost: overrides.totalCost ?? 1,
    },
  };
}

function makeUpgradeAction(overrides: Partial<{
  targetTrainType: TrainType;
  kind: 'upgrade' | 'crossgrade';
  cost: number;
}> = {}): FeasibleOption {
  return {
    type: AIActionType.UpgradeTrain,
    description: 'Upgrade to Fast Freight',
    feasible: true,
    params: {
      type: AIActionType.UpgradeTrain,
      targetTrainType: overrides.targetTrainType ?? TrainType.FastFreight,
      kind: overrides.kind ?? 'upgrade',
      cost: overrides.cost ?? 20,
    },
  };
}

function makePickupAndDeliverAction(overrides: Partial<{
  pickupPath: any[];
  pickupCity: string;
  pickupLoadType: LoadType;
  deliverPath: any[];
  deliverCity: string;
  demandCardId: number;
  demandIndex: number;
}> = {}): FeasibleOption {
  return {
    type: AIActionType.PickupAndDeliver,
    description: 'Pickup Coal and deliver to Berlin',
    feasible: true,
    params: {
      type: AIActionType.PickupAndDeliver,
      pickupPath: overrides.pickupPath ?? [{ row: 1, col: 1 }, { row: 1, col: 2 }],
      pickupCity: overrides.pickupCity ?? 'Essen',
      pickupLoadType: overrides.pickupLoadType ?? LoadType.Coal,
      deliverPath: overrides.deliverPath ?? [],
      deliverCity: overrides.deliverCity ?? 'Berlin',
      demandCardId: overrides.demandCardId ?? 1,
      demandIndex: overrides.demandIndex ?? 0,
    },
  };
}

// --- Tests ---

describe('TurnExecutor', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Setup default DB mock responses
    mockQuery.mockResolvedValue({ rows: [] });
  });

  describe('execute - PassTurn', () => {
    it('should succeed with zero side effects for PassTurn', async () => {
      const snapshot = makeSnapshot();
      const plan: TurnPlan = { actions: [makePassAction()] };

      const result = await TurnExecutor.execute(plan, snapshot);

      expect(result.success).toBe(true);
      expect(result.actionsExecuted).toBe(1);
      expect(result.error).toBeUndefined();
      expect(result.durationMs).toBeGreaterThanOrEqual(0);

      // No service calls should have been made
      expect(mockMoveTrainForUser).not.toHaveBeenCalled();
      expect(mockDeliverLoadForUser).not.toHaveBeenCalled();
      expect(mockPurchaseTrainType).not.toHaveBeenCalled();
    });
  });

  describe('execute - empty plan', () => {
    it('should succeed with zero actions for empty plan', async () => {
      const snapshot = makeSnapshot();
      const plan: TurnPlan = { actions: [] };

      const result = await TurnExecutor.execute(plan, snapshot);

      expect(result.success).toBe(true);
      expect(result.actionsExecuted).toBe(0);
    });
  });

  describe('execute - DeliverLoad', () => {
    it('should move along path and deliver the load', async () => {
      const snapshot = makeSnapshot({
        carriedLoads: [LoadType.Coal],
      });
      const plan: TurnPlan = {
        actions: [
          makeDeliverAction({
            movePath: [
              { row: 1, col: 1 },
              { row: 1, col: 2 },
              { row: 1, col: 3 },
            ],
          }),
        ],
      };

      const result = await TurnExecutor.execute(plan, snapshot);

      expect(result.success).toBe(true);
      expect(result.actionsExecuted).toBe(1);

      // Should have called moveTrainForUser for each step (skipping first)
      expect(mockMoveTrainForUser).toHaveBeenCalledTimes(2);
      expect(mockMoveTrainForUser).toHaveBeenCalledWith({
        gameId: 'test-game',
        userId: 'bot-user-1',
        to: { row: 1, col: 2 },
        movementCost: 1,
      });
      expect(mockMoveTrainForUser).toHaveBeenCalledWith({
        gameId: 'test-game',
        userId: 'bot-user-1',
        to: { row: 1, col: 3 },
        movementCost: 1,
      });

      // Should have called deliverLoadForUser
      expect(mockDeliverLoadForUser).toHaveBeenCalledWith(
        'test-game',
        'bot-user-1',
        'Berlin',
        LoadType.Coal,
        1,
      );

      // Should have called returnLoad (best-effort)
      expect(mockReturnLoad).toHaveBeenCalledWith('Berlin', LoadType.Coal, 'test-game');
    });

    it('should skip movement for empty movePath', async () => {
      const snapshot = makeSnapshot({ carriedLoads: [LoadType.Coal] });
      const plan: TurnPlan = {
        actions: [makeDeliverAction({ movePath: [] })],
      };

      const result = await TurnExecutor.execute(plan, snapshot);

      expect(result.success).toBe(true);
      expect(mockMoveTrainForUser).not.toHaveBeenCalled();
      expect(mockDeliverLoadForUser).toHaveBeenCalled();
    });

    it('should skip movement for single-point movePath (already at city)', async () => {
      const snapshot = makeSnapshot({ carriedLoads: [LoadType.Coal] });
      const plan: TurnPlan = {
        actions: [makeDeliverAction({ movePath: [{ row: 1, col: 1 }] })],
      };

      const result = await TurnExecutor.execute(plan, snapshot);

      expect(result.success).toBe(true);
      expect(mockMoveTrainForUser).not.toHaveBeenCalled();
      expect(mockDeliverLoadForUser).toHaveBeenCalled();
    });
  });

  describe('execute - BuildTrack', () => {
    it('should build track and deduct money atomically', async () => {
      // Mock DB for the build transaction
      mockQuery
        .mockResolvedValueOnce({ rows: [] }) // BEGIN
        .mockResolvedValueOnce({ rows: [] }) // UPSERT player_tracks
        .mockResolvedValueOnce({ rows: [] }) // UPDATE players money
        .mockResolvedValueOnce({ rows: [] }); // COMMIT

      const snapshot = makeSnapshot({ money: 50 });
      const plan: TurnPlan = { actions: [makeBuildAction({ totalCost: 3 })] };

      const result = await TurnExecutor.execute(plan, snapshot);

      expect(result.success).toBe(true);
      expect(result.actionsExecuted).toBe(1);

      // Should have read existing track state
      expect(mockGetTrackState).toHaveBeenCalledWith('test-game', 'bot-1');

      // Should have started a transaction
      expect(mockQuery).toHaveBeenCalledWith('BEGIN');
      expect(mockQuery).toHaveBeenCalledWith('COMMIT');
      expect(mockRelease).toHaveBeenCalled();
    });

    it('should skip build for empty segments', async () => {
      const snapshot = makeSnapshot();
      const plan: TurnPlan = {
        actions: [makeBuildAction({ segments: [], totalCost: 0 })],
      };

      const result = await TurnExecutor.execute(plan, snapshot);

      expect(result.success).toBe(true);
      expect(mockGetTrackState).not.toHaveBeenCalled();
      expect(mockConnect).not.toHaveBeenCalled();
    });

    it('should rollback and return failure on DB error', async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [] }) // BEGIN
        .mockRejectedValueOnce(new Error('DB constraint violation')); // UPSERT fails

      const snapshot = makeSnapshot();
      const plan: TurnPlan = { actions: [makeBuildAction()] };

      const result = await TurnExecutor.execute(plan, snapshot);

      expect(result.success).toBe(false);
      expect(result.actionsExecuted).toBe(0);
      expect(result.error).toContain('DB constraint violation');

      // Should have rolled back
      expect(mockQuery).toHaveBeenCalledWith('ROLLBACK');
      expect(mockRelease).toHaveBeenCalled();
    });
  });

  describe('execute - UpgradeTrain', () => {
    it('should call purchaseTrainType with correct params', async () => {
      const snapshot = makeSnapshot({ money: 50 });
      const plan: TurnPlan = {
        actions: [makeUpgradeAction({
          targetTrainType: TrainType.FastFreight,
          kind: 'upgrade',
          cost: 20,
        })],
      };

      const result = await TurnExecutor.execute(plan, snapshot);

      expect(result.success).toBe(true);
      expect(mockPurchaseTrainType).toHaveBeenCalledWith(
        'test-game',
        'bot-user-1',
        'upgrade',
        TrainType.FastFreight,
      );
    });

    it('should return failure when upgrade fails', async () => {
      mockPurchaseTrainType.mockRejectedValueOnce(new Error('Insufficient funds'));

      const snapshot = makeSnapshot({ money: 5 });
      const plan: TurnPlan = { actions: [makeUpgradeAction()] };

      const result = await TurnExecutor.execute(plan, snapshot);

      expect(result.success).toBe(false);
      expect(result.error).toContain('Insufficient funds');
    });
  });

  describe('execute - PickupAndDeliver', () => {
    it('should move to pickup city and add load to player', async () => {
      // Mock DB for pickup transaction
      mockQuery
        .mockResolvedValueOnce({ rows: [] }) // BEGIN
        .mockResolvedValueOnce({ rows: [{ id: 'bot-1', loads: [] }] }) // SELECT player
        .mockResolvedValueOnce({ rows: [] }) // UPDATE loads
        .mockResolvedValueOnce({ rows: [] }); // COMMIT

      const snapshot = makeSnapshot();
      const plan: TurnPlan = {
        actions: [makePickupAndDeliverAction({
          pickupPath: [{ row: 1, col: 1 }, { row: 1, col: 2 }],
          deliverPath: [],
        })],
      };

      const result = await TurnExecutor.execute(plan, snapshot);

      expect(result.success).toBe(true);

      // Should have moved to pickup city
      expect(mockMoveTrainForUser).toHaveBeenCalledWith({
        gameId: 'test-game',
        userId: 'bot-user-1',
        to: { row: 1, col: 2 },
        movementCost: 1,
      });

      // Should have updated player loads in DB
      expect(mockQuery).toHaveBeenCalledWith('BEGIN');
      expect(mockQuery).toHaveBeenCalledWith('COMMIT');
    });

    it('should also deliver if deliverPath is provided', async () => {
      // Mock DB for pickup transaction
      mockQuery
        .mockResolvedValueOnce({ rows: [] }) // BEGIN
        .mockResolvedValueOnce({ rows: [{ id: 'bot-1', loads: [] }] }) // SELECT player
        .mockResolvedValueOnce({ rows: [] }) // UPDATE loads
        .mockResolvedValueOnce({ rows: [] }); // COMMIT

      const snapshot = makeSnapshot();
      const plan: TurnPlan = {
        actions: [makePickupAndDeliverAction({
          pickupPath: [{ row: 1, col: 1 }, { row: 1, col: 2 }],
          deliverPath: [{ row: 1, col: 2 }, { row: 1, col: 3 }],
        })],
      };

      const result = await TurnExecutor.execute(plan, snapshot);

      expect(result.success).toBe(true);

      // Movement: 1 hop for pickup, 1 hop for delivery
      expect(mockMoveTrainForUser).toHaveBeenCalledTimes(2);

      // Should have called deliverLoadForUser
      expect(mockDeliverLoadForUser).toHaveBeenCalled();
    });

    it('should call pickupDroppedLoad when load is a dropped load', async () => {
      // Mock DB for pickup transaction
      mockQuery
        .mockResolvedValueOnce({ rows: [] }) // BEGIN
        .mockResolvedValueOnce({ rows: [{ id: 'bot-1', loads: [] }] }) // SELECT player
        .mockResolvedValueOnce({ rows: [] }) // UPDATE loads
        .mockResolvedValueOnce({ rows: [] }); // COMMIT

      const droppedLoads = new Map<string, LoadType[]>();
      droppedLoads.set('Essen', [LoadType.Coal]);

      const snapshot = makeSnapshot({ droppedLoads });
      const plan: TurnPlan = {
        actions: [makePickupAndDeliverAction({
          pickupCity: 'Essen',
          pickupLoadType: LoadType.Coal,
          deliverPath: [],
        })],
      };

      const result = await TurnExecutor.execute(plan, snapshot);

      expect(result.success).toBe(true);
      expect(mockPickupDroppedLoad).toHaveBeenCalledWith('Essen', LoadType.Coal, 'test-game');
    });
  });

  describe('execute - multi-action plans', () => {
    it('should execute all actions in sequence', async () => {
      // Mock DB for build transaction
      mockQuery
        .mockResolvedValueOnce({ rows: [] }) // BEGIN
        .mockResolvedValueOnce({ rows: [] }) // UPSERT tracks
        .mockResolvedValueOnce({ rows: [] }) // UPDATE money
        .mockResolvedValueOnce({ rows: [] }); // COMMIT

      const snapshot = makeSnapshot({ carriedLoads: [LoadType.Coal], money: 50 });
      const plan: TurnPlan = {
        actions: [
          makeDeliverAction({ movePath: [{ row: 1, col: 1 }, { row: 1, col: 2 }] }),
          makeBuildAction({ totalCost: 3 }),
        ],
      };

      const result = await TurnExecutor.execute(plan, snapshot);

      expect(result.success).toBe(true);
      expect(result.actionsExecuted).toBe(2);

      // Delivery should have been called first
      expect(mockDeliverLoadForUser).toHaveBeenCalled();
      // Then track build
      expect(mockGetTrackState).toHaveBeenCalled();
    });

    it('should stop at first failure and report partial progress', async () => {
      // First action (deliver) fails
      mockDeliverLoadForUser.mockRejectedValueOnce(new Error('Load not on train'));

      const snapshot = makeSnapshot({ money: 50 });
      const plan: TurnPlan = {
        actions: [
          makeDeliverAction(),
          makeBuildAction(),
        ],
      };

      const result = await TurnExecutor.execute(plan, snapshot);

      expect(result.success).toBe(false);
      expect(result.actionsExecuted).toBe(0); // Failed on first action
      expect(result.error).toContain('Load not on train');

      // BuildTrack should NOT have been attempted
      expect(mockGetTrackState).not.toHaveBeenCalled();
    });
  });

  describe('execute - BuildTowardMajorCity', () => {
    it('should build segments same as BuildTrack', async () => {
      // Mock DB for build transaction
      mockQuery
        .mockResolvedValueOnce({ rows: [] }) // BEGIN
        .mockResolvedValueOnce({ rows: [] }) // UPSERT tracks
        .mockResolvedValueOnce({ rows: [] }) // UPDATE money
        .mockResolvedValueOnce({ rows: [] }); // COMMIT

      const snapshot = makeSnapshot({ money: 50 });
      const plan: TurnPlan = {
        actions: [{
          type: AIActionType.BuildTowardMajorCity,
          description: 'Build toward Berlin',
          feasible: true as const,
          params: {
            type: AIActionType.BuildTowardMajorCity,
            targetCity: 'Berlin',
            segments: [makeSegment(1, 1, TerrainType.Clear, 1, 2, TerrainType.Clear, 1)],
            totalCost: 1,
          },
        }],
      };

      const result = await TurnExecutor.execute(plan, snapshot);

      expect(result.success).toBe(true);
      expect(mockGetTrackState).toHaveBeenCalled();
    });
  });

  describe('execution timing', () => {
    it('should include durationMs in result', async () => {
      const snapshot = makeSnapshot();
      const plan: TurnPlan = { actions: [makePassAction()] };

      const result = await TurnExecutor.execute(plan, snapshot);

      expect(typeof result.durationMs).toBe('number');
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
    });
  });
});
