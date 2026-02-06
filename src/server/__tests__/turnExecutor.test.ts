import { TurnExecutor, TurnExecutionResult } from '../services/ai/TurnExecutor';
import { AIActionType } from '../../shared/types/AITypes';
import type { TurnPlan, TurnPlanAction } from '../../shared/types/AITypes';
import { TrainType } from '../../shared/types/GameTypes';
import { LoadType } from '../../shared/types/LoadTypes';

// --- Mocks ---

const mockQuery = jest.fn();
const mockRelease = jest.fn();
const mockConnect = jest.fn().mockResolvedValue({
  query: mockQuery,
  release: mockRelease,
});

jest.mock('../../server/db/index', () => ({
  db: { connect: () => mockConnect() },
}));

const mockDrawCard = jest.fn();
const mockDiscardCard = jest.fn();
const mockGetCard = jest.fn();
const mockReturnDealtCardToTop = jest.fn();
const mockReturnDiscardedCardToDealt = jest.fn();

jest.mock('../services/demandDeckService', () => ({
  demandDeckService: {
    drawCard: () => mockDrawCard(),
    discardCard: (id: number) => mockDiscardCard(id),
    getCard: (id: number) => mockGetCard(id),
    returnDealtCardToTop: (id: number) => mockReturnDealtCardToTop(id),
    returnDiscardedCardToDealt: (id: number) => mockReturnDiscardedCardToDealt(id),
  },
}));

const mockGetTrackState = jest.fn();
jest.mock('../services/trackService', () => ({
  TrackService: {
    getTrackState: (...args: unknown[]) => mockGetTrackState(...args),
  },
}));

const mockEmitToGame = jest.fn();
jest.mock('../services/socketService', () => ({
  emitToGame: (...args: unknown[]) => mockEmitToGame(...args),
}));

// --- Helpers ---

function makeAction(type: AIActionType, parameters: Record<string, unknown> = {}): TurnPlanAction {
  return { type, parameters };
}

function makePlan(actions: TurnPlanAction[]): TurnPlan {
  return {
    actions,
    expectedOutcome: { cashChange: 0, loadsDelivered: 0, trackSegmentsBuilt: 0, newMajorCitiesConnected: 0 },
    totalScore: 0,
    archetype: 'opportunist',
    skillLevel: 'hard',
  };
}

function setupPlayerRow(overrides?: Record<string, unknown>): void {
  mockQuery.mockImplementation((sql: string) => {
    if (typeof sql === 'string' && sql.includes('FROM players')) {
      return {
        rows: [{
          money: 100,
          debtOwed: 0,
          hand: [1, 2, 3],
          loads: [LoadType.Wine, LoadType.Coal],
          turnNumber: 5,
          trainType: TrainType.Freight,
          ...overrides,
        }],
      };
    }
    // Default for BEGIN, COMMIT, UPDATE, INSERT
    return { rows: [] };
  });
}

// --- Tests ---

describe('TurnExecutor', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockConnect.mockResolvedValue({
      query: mockQuery,
      release: mockRelease,
    });
    mockQuery.mockResolvedValue({ rows: [] });
  });

  describe('empty plan', () => {
    it('succeeds with no actions', async () => {
      const plan = makePlan([]);
      const result = await TurnExecutor.execute(plan, 'game-1', 'player-1');
      expect(result.success).toBe(true);
      expect(result.actionResults).toHaveLength(0);
      // Should not start a transaction for empty plan
      expect(mockConnect).not.toHaveBeenCalled();
    });
  });

  describe('PassTurn', () => {
    it('executes PassTurn as no-op', async () => {
      const plan = makePlan([makeAction(AIActionType.PassTurn)]);
      const result = await TurnExecutor.execute(plan, 'game-1', 'player-1');

      expect(result.success).toBe(true);
      expect(result.actionResults).toHaveLength(1);
      expect(result.actionResults[0].actionType).toBe(AIActionType.PassTurn);
      expect(result.actionResults[0].success).toBe(true);
    });
  });

  describe('DeliverLoad', () => {
    it('executes a successful delivery', async () => {
      setupPlayerRow();

      mockGetCard.mockReturnValue({
        id: 1,
        demands: [
          { city: 'Berlin', resource: LoadType.Wine, payment: 30 },
          { city: 'Paris', resource: LoadType.Coal, payment: 25 },
        ],
      });
      mockDrawCard.mockReturnValue({ id: 99 });

      const plan = makePlan([
        makeAction(AIActionType.DeliverLoad, {
          loadType: LoadType.Wine,
          demandCardId: 1,
          city: 'Berlin',
        }),
      ]);

      const result = await TurnExecutor.execute(plan, 'game-1', 'player-1');

      expect(result.success).toBe(true);
      expect(result.actionResults[0].success).toBe(true);

      // Verify DB operations
      expect(mockQuery).toHaveBeenCalledWith('BEGIN');
      expect(mockQuery).toHaveBeenCalledWith('COMMIT');

      // Verify card management
      expect(mockDiscardCard).toHaveBeenCalledWith(1);
      expect(mockDrawCard).toHaveBeenCalled();

      // Verify socket event emitted
      expect(mockEmitToGame).toHaveBeenCalledWith(
        'game-1',
        'ai:action',
        expect.objectContaining({
          action: 'deliver',
          loadType: LoadType.Wine,
          city: 'Berlin',
          payment: 30,
        }),
      );
    });

    it('rolls back on delivery failure (load not on train)', async () => {
      setupPlayerRow({ loads: [LoadType.Coal] }); // No Wine

      mockGetCard.mockReturnValue({
        id: 1,
        demands: [{ city: 'Berlin', resource: LoadType.Wine, payment: 30 }],
      });

      const plan = makePlan([
        makeAction(AIActionType.DeliverLoad, {
          loadType: LoadType.Wine,
          demandCardId: 1,
          city: 'Berlin',
        }),
      ]);

      const result = await TurnExecutor.execute(plan, 'game-1', 'player-1');

      expect(result.success).toBe(false);
      expect(result.error).toContain('not on train');

      // Should have rolled back
      expect(mockQuery).toHaveBeenCalledWith('ROLLBACK');
    });

    it('compensates deck mutations on rollback', async () => {
      // First action succeeds (delivery), second fails
      let queryCount = 0;
      mockQuery.mockImplementation((sql: string) => {
        if (typeof sql === 'string' && sql.includes('FROM players')) {
          queryCount++;
          if (queryCount === 1) {
            return {
              rows: [{
                money: 100, debtOwed: 0, hand: [1, 2, 3],
                loads: [LoadType.Wine, LoadType.Coal], turnNumber: 5,
              }],
            };
          }
          // Second player query for pickup: at capacity
          return {
            rows: [{
              trainType: TrainType.Freight,
              loads: [LoadType.Wine, LoadType.Coal], // still at capacity after delivery removes 1 + pickup adds 1? No, need to think about this
            }],
          };
        }
        return { rows: [] };
      });

      mockGetCard.mockReturnValue({
        id: 1,
        demands: [{ city: 'Berlin', resource: LoadType.Wine, payment: 30 }],
      });
      mockDrawCard.mockReturnValue({ id: 99 });

      // Deliver succeeds, then an unknown action type fails
      const plan = makePlan([
        makeAction(AIActionType.DeliverLoad, {
          loadType: LoadType.Wine, demandCardId: 1, city: 'Berlin',
        }),
        makeAction('BadAction' as AIActionType),
      ]);

      const result = await TurnExecutor.execute(plan, 'game-1', 'player-1');

      expect(result.success).toBe(false);
      expect(result.actionResults[0].success).toBe(true); // Delivery ran within transaction
      expect(result.actionResults[1].success).toBe(false);

      // Deck mutations should have been compensated
      expect(mockReturnDealtCardToTop).toHaveBeenCalledWith(99);
      expect(mockReturnDiscardedCardToDealt).toHaveBeenCalledWith(1);
    });
  });

  describe('PickupLoad', () => {
    it('executes a successful pickup', async () => {
      setupPlayerRow({
        trainType: TrainType.Freight,
        loads: [LoadType.Wine], // capacity 2, carrying 1
      });

      const plan = makePlan([
        makeAction(AIActionType.PickupAndDeliver, {
          loadType: LoadType.Oil,
          city: 'Ploesti',
        }),
      ]);

      const result = await TurnExecutor.execute(plan, 'game-1', 'player-1');

      expect(result.success).toBe(true);
      expect(result.actionResults[0].success).toBe(true);

      // Verify the loads were updated
      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining('UPDATE players SET loads'),
        expect.arrayContaining([[LoadType.Wine, LoadType.Oil]]),
      );

      // Verify socket event
      expect(mockEmitToGame).toHaveBeenCalledWith(
        'game-1',
        'ai:action',
        expect.objectContaining({ action: 'pickup', loadType: LoadType.Oil }),
      );
    });

    it('fails when train is at capacity', async () => {
      setupPlayerRow({
        trainType: TrainType.Freight,
        loads: [LoadType.Wine, LoadType.Coal], // capacity 2, carrying 2
      });

      const plan = makePlan([
        makeAction(AIActionType.PickupAndDeliver, {
          loadType: LoadType.Oil,
          city: 'Ploesti',
        }),
      ]);

      const result = await TurnExecutor.execute(plan, 'game-1', 'player-1');

      expect(result.success).toBe(false);
      expect(result.error).toContain('at capacity');
    });
  });

  describe('BuildTrack', () => {
    it('executes track building with segments', async () => {
      setupPlayerRow({ money: 50 });
      mockGetTrackState.mockResolvedValue({
        segments: [{ from: { row: 10, col: 15 }, to: { row: 10, col: 16 } }],
        totalCost: 5,
        turnBuildCost: 0,
      });

      const newSegments = [
        { from: { row: 10, col: 16 }, to: { row: 10, col: 17 } },
        { from: { row: 10, col: 17 }, to: { row: 11, col: 17 } },
      ];

      const plan = makePlan([
        makeAction(AIActionType.BuildTrack, {
          segments: newSegments,
          estimatedCost: 3,
        }),
      ]);

      const result = await TurnExecutor.execute(plan, 'game-1', 'player-1');

      expect(result.success).toBe(true);
      expect(result.actionResults[0].success).toBe(true);

      // Verify socket event
      expect(mockEmitToGame).toHaveBeenCalledWith(
        'game-1',
        'ai:action',
        expect.objectContaining({ action: 'buildTrack', segmentCount: 2, cost: 3 }),
      );
    });

    it('skips when no segments provided', async () => {
      const plan = makePlan([
        makeAction(AIActionType.BuildTrack, { estimatedCost: 5 }),
      ]);

      const result = await TurnExecutor.execute(plan, 'game-1', 'player-1');

      expect(result.success).toBe(true);
      // BuildTrack with no segments is a no-op
    });

    it('fails when insufficient funds', async () => {
      setupPlayerRow({ money: 0 });
      mockGetTrackState.mockResolvedValue({
        segments: [],
        totalCost: 0,
        turnBuildCost: 0,
      });

      const plan = makePlan([
        makeAction(AIActionType.BuildTrack, {
          segments: [{ from: { row: 0, col: 0 }, to: { row: 0, col: 1 } }],
          estimatedCost: 5,
        }),
      ]);

      const result = await TurnExecutor.execute(plan, 'game-1', 'player-1');

      expect(result.success).toBe(false);
      expect(result.error).toContain('Insufficient funds');
    });
  });

  describe('UpgradeTrain', () => {
    it('executes a successful upgrade', async () => {
      setupPlayerRow({ money: 30, trainType: TrainType.Freight });

      const plan = makePlan([
        makeAction(AIActionType.UpgradeTrain, {
          kind: 'upgrade',
          targetTrainType: TrainType.FastFreight,
        }),
      ]);

      const result = await TurnExecutor.execute(plan, 'game-1', 'player-1');

      expect(result.success).toBe(true);

      // Verify socket event
      expect(mockEmitToGame).toHaveBeenCalledWith(
        'game-1',
        'ai:action',
        expect.objectContaining({
          action: 'upgrade',
          targetTrainType: TrainType.FastFreight,
          cost: 20,
        }),
      );
    });

    it('executes a successful crossgrade', async () => {
      setupPlayerRow({ money: 20, trainType: TrainType.FastFreight });

      const plan = makePlan([
        makeAction(AIActionType.UpgradeTrain, {
          kind: 'crossgrade',
          targetTrainType: TrainType.HeavyFreight,
        }),
      ]);

      const result = await TurnExecutor.execute(plan, 'game-1', 'player-1');

      expect(result.success).toBe(true);
    });

    it('fails with insufficient funds for upgrade', async () => {
      setupPlayerRow({ money: 10, trainType: TrainType.Freight });

      const plan = makePlan([
        makeAction(AIActionType.UpgradeTrain, {
          kind: 'upgrade',
          targetTrainType: TrainType.FastFreight,
        }),
      ]);

      const result = await TurnExecutor.execute(plan, 'game-1', 'player-1');

      expect(result.success).toBe(false);
      expect(result.error).toContain('Insufficient funds');
    });

    it('fails when capacity would drop loads', async () => {
      setupPlayerRow({
        money: 30,
        trainType: TrainType.HeavyFreight,
        loads: [LoadType.Wine, LoadType.Coal, LoadType.Oil], // 3 loads
      });

      const plan = makePlan([
        makeAction(AIActionType.UpgradeTrain, {
          kind: 'crossgrade',
          targetTrainType: TrainType.FastFreight, // capacity 2
        }),
      ]);

      const result = await TurnExecutor.execute(plan, 'game-1', 'player-1');

      expect(result.success).toBe(false);
      expect(result.error).toContain('carrying 3 loads');
    });
  });

  describe('multi-action plan', () => {
    it('executes deliver then build sequence atomically', async () => {
      let queryCallCount = 0;
      mockQuery.mockImplementation((sql: string) => {
        if (typeof sql === 'string' && sql.includes('FROM players')) {
          queryCallCount++;
          if (queryCallCount === 1) {
            // First query: for delivery
            return {
              rows: [{
                money: 50, debtOwed: 0, hand: [1, 2, 3],
                loads: [LoadType.Wine], turnNumber: 5,
              }],
            };
          }
          // Second query: for build track (money updated by delivery)
          return { rows: [{ money: 80 }] };
        }
        return { rows: [] };
      });

      mockGetCard.mockReturnValue({
        id: 1,
        demands: [{ city: 'Berlin', resource: LoadType.Wine, payment: 30 }],
      });
      mockDrawCard.mockReturnValue({ id: 99 });
      mockGetTrackState.mockResolvedValue({
        segments: [], totalCost: 0, turnBuildCost: 0,
      });

      const plan = makePlan([
        makeAction(AIActionType.DeliverLoad, {
          loadType: LoadType.Wine, demandCardId: 1, city: 'Berlin',
        }),
        makeAction(AIActionType.BuildTrack, {
          segments: [{ from: { row: 0, col: 0 }, to: { row: 0, col: 1 } }],
          estimatedCost: 5,
        }),
      ]);

      const result = await TurnExecutor.execute(plan, 'game-1', 'player-1');

      expect(result.success).toBe(true);
      expect(result.actionResults).toHaveLength(2);
      expect(result.actionResults[0].success).toBe(true);
      expect(result.actionResults[1].success).toBe(true);

      // Both should be within same transaction (one BEGIN, one COMMIT)
      const beginCalls = mockQuery.mock.calls.filter(c => c[0] === 'BEGIN');
      const commitCalls = mockQuery.mock.calls.filter(c => c[0] === 'COMMIT');
      expect(beginCalls).toHaveLength(1);
      expect(commitCalls).toHaveLength(1);
    });

    it('rolls back entire transaction if second action fails', async () => {
      let queryCallCount = 0;
      mockQuery.mockImplementation((sql: string) => {
        if (typeof sql === 'string' && sql.includes('FROM players')) {
          queryCallCount++;
          if (queryCallCount === 1) {
            return {
              rows: [{
                money: 50, debtOwed: 0, hand: [1, 2, 3],
                loads: [LoadType.Wine], turnNumber: 5,
              }],
            };
          }
          // Second query: for upgrade with no money left
          return {
            rows: [{
              money: 5, trainType: TrainType.Freight, loads: [],
            }],
          };
        }
        return { rows: [] };
      });

      mockGetCard.mockReturnValue({
        id: 1,
        demands: [{ city: 'Berlin', resource: LoadType.Wine, payment: 30 }],
      });
      mockDrawCard.mockReturnValue({ id: 99 });

      const plan = makePlan([
        makeAction(AIActionType.DeliverLoad, {
          loadType: LoadType.Wine, demandCardId: 1, city: 'Berlin',
        }),
        makeAction(AIActionType.UpgradeTrain, {
          kind: 'upgrade', targetTrainType: TrainType.FastFreight,
        }),
      ]);

      const result = await TurnExecutor.execute(plan, 'game-1', 'player-1');

      expect(result.success).toBe(false);
      expect(result.actionResults[0].success).toBe(true);
      expect(result.actionResults[1].success).toBe(false);

      // Transaction should have been rolled back
      expect(mockQuery).toHaveBeenCalledWith('ROLLBACK');

      // Deck mutations from delivery should be compensated
      expect(mockReturnDealtCardToTop).toHaveBeenCalledWith(99);
      expect(mockReturnDiscardedCardToDealt).toHaveBeenCalledWith(1);
    });
  });

  describe('timing', () => {
    it('tracks total duration', async () => {
      const plan = makePlan([makeAction(AIActionType.PassTurn)]);
      const result = await TurnExecutor.execute(plan, 'game-1', 'player-1');
      expect(result.totalDurationMs).toBeGreaterThanOrEqual(0);
    });

    it('tracks per-action duration', async () => {
      const plan = makePlan([makeAction(AIActionType.PassTurn)]);
      const result = await TurnExecutor.execute(plan, 'game-1', 'player-1');
      expect(result.actionResults[0].durationMs).toBeGreaterThanOrEqual(0);
    });
  });

  describe('unknown action type', () => {
    it('fails on unknown action type', async () => {
      const plan = makePlan([
        makeAction('UnknownAction' as AIActionType),
      ]);
      const result = await TurnExecutor.execute(plan, 'game-1', 'player-1');
      expect(result.success).toBe(false);
      expect(result.error).toContain('Unknown action type');
    });
  });

  describe('socket events', () => {
    it('emits ai:turnComplete after successful execution', async () => {
      const plan = makePlan([makeAction(AIActionType.PassTurn)]);
      const result = await TurnExecutor.execute(plan, 'game-1', 'player-1');

      expect(result.success).toBe(true);
      expect(mockEmitToGame).toHaveBeenCalledWith(
        'game-1',
        'ai:turnComplete',
        expect.objectContaining({
          playerId: 'player-1',
          actionCount: 1,
        }),
      );
    });

    it('does not emit ai:turnComplete on failure', async () => {
      const plan = makePlan([
        makeAction('BadAction' as AIActionType),
      ]);
      await TurnExecutor.execute(plan, 'game-1', 'player-1');

      const turnCompleteCalls = mockEmitToGame.mock.calls.filter(
        (c: unknown[]) => c[1] === 'ai:turnComplete',
      );
      expect(turnCompleteCalls).toHaveLength(0);
    });
  });
});
