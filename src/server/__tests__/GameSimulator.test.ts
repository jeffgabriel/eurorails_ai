/**
 * Unit tests for the GameSimulator test harness utility.
 * Validates initialization, turn execution, metric tracking,
 * and snapshot state management.
 */

import {
  GameSimulator,
  createMockSnapshot,
  SimulationMetrics,
  TakeTurnFn,
} from './utils/GameSimulator';
import { BotTurnResult } from '../services/ai/AIStrategyEngine';
import {
  WorldSnapshot,
  AIActionType,
  TrainType,
  TerrainType,
} from '../../shared/types/GameTypes';

// ── Helpers ──────────────────────────────────────────────────────────────

function makeBuildResult(overrides?: Partial<BotTurnResult>): BotTurnResult {
  return {
    action: AIActionType.BuildTrack,
    segmentsBuilt: 3,
    cost: 5,
    durationMs: 10,
    success: true,
    buildTargetCity: 'Berlin',
    ...overrides,
  };
}

function makeMoveResult(overrides?: Partial<BotTurnResult>): BotTurnResult {
  return {
    action: AIActionType.MoveTrain,
    segmentsBuilt: 0,
    cost: 0,
    durationMs: 8,
    success: true,
    movedTo: { row: 12, col: 10 },
    milepostsMoved: 3,
    ...overrides,
  };
}

function makePassResult(overrides?: Partial<BotTurnResult>): BotTurnResult {
  return {
    action: AIActionType.PassTurn,
    segmentsBuilt: 0,
    cost: 0,
    durationMs: 2,
    success: true,
    ...overrides,
  };
}

function makeDeliveryResult(overrides?: Partial<BotTurnResult>): BotTurnResult {
  return {
    action: AIActionType.BuildTrack, // build phase after delivery
    segmentsBuilt: 2,
    cost: 3,
    durationMs: 15,
    success: true,
    movedTo: { row: 15, col: 10 },
    milepostsMoved: 5,
    loadsDelivered: [
      { loadType: 'Coal', city: 'Berlin', payment: 10, cardId: 42 },
    ],
    ...overrides,
  };
}

function makePickupResult(overrides?: Partial<BotTurnResult>): BotTurnResult {
  return {
    action: AIActionType.BuildTrack,
    segmentsBuilt: 1,
    cost: 2,
    durationMs: 12,
    success: true,
    loadsPickedUp: [{ loadType: 'Wine', city: 'Paris' }],
    ...overrides,
  };
}

function makeErrorResult(): BotTurnResult {
  return {
    action: AIActionType.PassTurn,
    segmentsBuilt: 0,
    cost: 0,
    durationMs: 5,
    success: false,
    error: 'Pipeline error: DB connection failed',
  };
}

// ── Tests ────────────────────────────────────────────────────────────────

describe('GameSimulator', () => {
  describe('initialization', () => {
    it('should initialize with a mock snapshot and reset metrics', () => {
      const takeTurn: TakeTurnFn = jest.fn();
      const sim = new GameSimulator(takeTurn);

      const snapshot = createMockSnapshot({ initialMoney: 75 });
      sim.initialize(snapshot);

      const current = sim.getSnapshot();
      expect(current.bot.money).toBe(75);
      expect(current.gameStatus).toBe('active');

      const metrics = sim.getMetrics();
      expect(metrics.turnCount).toBe(0);
      expect(metrics.deliveryCount).toBe(0);
      expect(metrics.totalEarnings).toBe(0);
      expect(metrics.consecutivePassTurns).toBe(0);
      expect(metrics.actionHistory).toEqual([]);
    });

    it('should deep clone the snapshot so external mutation does not affect it', () => {
      const takeTurn: TakeTurnFn = jest.fn();
      const sim = new GameSimulator(takeTurn);

      const snapshot = createMockSnapshot({ initialMoney: 50 });
      sim.initialize(snapshot);

      // Mutate the original -- should not affect simulator
      snapshot.bot.money = 999;
      expect(sim.getSnapshot().bot.money).toBe(50);
    });

    it('should throw if runTurn is called before initialization', async () => {
      const takeTurn: TakeTurnFn = jest.fn();
      const sim = new GameSimulator(takeTurn);

      await expect(sim.runTurn()).rejects.toThrow('GameSimulator not initialized');
    });

    it('should reset metrics on re-initialization', async () => {
      const takeTurn: TakeTurnFn = jest.fn().mockResolvedValue(makeBuildResult());
      const sim = new GameSimulator(takeTurn);

      sim.initialize(createMockSnapshot());
      await sim.runTurn();
      expect(sim.getMetrics().turnCount).toBe(1);

      sim.initialize(createMockSnapshot());
      expect(sim.getMetrics().turnCount).toBe(0);
    });
  });

  describe('createMockSnapshot', () => {
    it('should create a snapshot with sensible defaults', () => {
      const snap = createMockSnapshot();
      expect(snap.gameId).toBe('sim-game-001');
      expect(snap.bot.playerId).toBe('sim-bot-001');
      expect(snap.bot.money).toBe(50);
      expect(snap.bot.trainType).toBe(TrainType.Freight);
      expect(snap.bot.loads).toEqual([]);
      expect(snap.gameStatus).toBe('active');
    });

    it('should allow overriding all config values', () => {
      const snap = createMockSnapshot({
        gameId: 'custom-game',
        botPlayerId: 'custom-bot',
        initialMoney: 100,
        trainType: TrainType.FastFreight,
        initialPosition: { row: 5, col: 5 },
        initialLoads: ['Coal'],
        demandCards: [10, 20],
      });
      expect(snap.gameId).toBe('custom-game');
      expect(snap.bot.playerId).toBe('custom-bot');
      expect(snap.bot.money).toBe(100);
      expect(snap.bot.trainType).toBe(TrainType.FastFreight);
      expect(snap.bot.position).toEqual({ row: 5, col: 5 });
      expect(snap.bot.loads).toEqual(['Coal']);
      expect(snap.bot.demandCards).toEqual([10, 20]);
    });
  });

  describe('runTurn', () => {
    it('should call takeTurnFn with gameId and botPlayerId', async () => {
      const takeTurn: TakeTurnFn = jest.fn().mockResolvedValue(makePassResult());
      const sim = new GameSimulator(takeTurn);
      sim.initialize(createMockSnapshot({ gameId: 'g1', botPlayerId: 'b1' }));

      await sim.runTurn();

      expect(takeTurn).toHaveBeenCalledWith('g1', 'b1');
    });

    it('should increment turnNumber on each call', async () => {
      const takeTurn: TakeTurnFn = jest.fn().mockResolvedValue(makePassResult());
      const sim = new GameSimulator(takeTurn);
      sim.initialize(createMockSnapshot());

      await sim.runTurn();
      expect(sim.getSnapshot().turnNumber).toBe(1);

      await sim.runTurn();
      expect(sim.getSnapshot().turnNumber).toBe(2);
    });

    it('should return the BotTurnResult from takeTurnFn', async () => {
      const expected = makeBuildResult({ segmentsBuilt: 7 });
      const takeTurn: TakeTurnFn = jest.fn().mockResolvedValue(expected);
      const sim = new GameSimulator(takeTurn);
      sim.initialize(createMockSnapshot());

      const result = await sim.runTurn();
      expect(result.segmentsBuilt).toBe(7);
      expect(result.action).toBe(AIActionType.BuildTrack);
    });
  });

  describe('state updates from results', () => {
    it('should update bot position after a move', async () => {
      const takeTurn: TakeTurnFn = jest.fn().mockResolvedValue(
        makeMoveResult({ movedTo: { row: 20, col: 15 } }),
      );
      const sim = new GameSimulator(takeTurn);
      sim.initialize(createMockSnapshot({ initialPosition: { row: 10, col: 10 } }));

      await sim.runTurn();
      expect(sim.getSnapshot().bot.position).toEqual({ row: 20, col: 15 });
    });

    it('should deduct build cost from money', async () => {
      const takeTurn: TakeTurnFn = jest.fn().mockResolvedValue(
        makeBuildResult({ cost: 12 }),
      );
      const sim = new GameSimulator(takeTurn);
      sim.initialize(createMockSnapshot({ initialMoney: 50 }));

      await sim.runTurn();
      expect(sim.getSnapshot().bot.money).toBe(38);
    });

    it('should add delivery payment to money and remove load and card', async () => {
      const takeTurn: TakeTurnFn = jest.fn().mockResolvedValue(
        makeDeliveryResult({
          cost: 0,
          loadsDelivered: [{ loadType: 'Coal', city: 'Berlin', payment: 25, cardId: 42 }],
        }),
      );
      const sim = new GameSimulator(takeTurn);
      sim.initialize(createMockSnapshot({
        initialMoney: 50,
        initialLoads: ['Coal', 'Wine'],
        demandCards: [42, 73],
        resolvedDemands: [
          { cardId: 42, demands: [{ city: 'Berlin', loadType: 'Coal', payment: 25 }] },
          { cardId: 73, demands: [{ city: 'Paris', loadType: 'Wine', payment: 15 }] },
        ],
      }));

      await sim.runTurn();
      const snap = sim.getSnapshot();
      expect(snap.bot.money).toBe(75); // 50 + 25
      expect(snap.bot.loads).toEqual(['Wine']); // Coal removed
      expect(snap.bot.demandCards).toEqual([73]); // card 42 removed
      expect(snap.bot.resolvedDemands).toHaveLength(1);
    });

    it('should add picked up load to bot loads', async () => {
      const takeTurn: TakeTurnFn = jest.fn().mockResolvedValue(
        makePickupResult({ cost: 0, loadsPickedUp: [{ loadType: 'Iron', city: 'Hamburg' }] }),
      );
      const sim = new GameSimulator(takeTurn);
      sim.initialize(createMockSnapshot({ initialLoads: ['Coal'] }));

      await sim.runTurn();
      expect(sim.getSnapshot().bot.loads).toEqual(['Coal', 'Iron']);
    });

    it('should not add load if train is at capacity', async () => {
      const takeTurn: TakeTurnFn = jest.fn().mockResolvedValue(
        makePickupResult({ cost: 0, loadsPickedUp: [{ loadType: 'Iron', city: 'Hamburg' }] }),
      );
      const sim = new GameSimulator(takeTurn);
      // Freight capacity = 2, already full
      sim.initialize(createMockSnapshot({ initialLoads: ['Coal', 'Wine'] }));

      await sim.runTurn();
      expect(sim.getSnapshot().bot.loads).toEqual(['Coal', 'Wine']); // unchanged
    });

    it('should clamp money to 0 if cost exceeds balance', async () => {
      const takeTurn: TakeTurnFn = jest.fn().mockResolvedValue(
        makeBuildResult({ cost: 60 }),
      );
      const sim = new GameSimulator(takeTurn);
      sim.initialize(createMockSnapshot({ initialMoney: 50 }));

      await sim.runTurn();
      expect(sim.getSnapshot().bot.money).toBe(0);
    });
  });

  describe('metric tracking', () => {
    it('should track deliveries and earnings', async () => {
      const takeTurn: TakeTurnFn = jest.fn().mockResolvedValue(
        makeDeliveryResult({
          cost: 0,
          loadsDelivered: [
            { loadType: 'Coal', city: 'Berlin', payment: 10, cardId: 42 },
            { loadType: 'Wine', city: 'Paris', payment: 20, cardId: 73 },
          ],
        }),
      );
      const sim = new GameSimulator(takeTurn);
      sim.initialize(createMockSnapshot({
        initialLoads: ['Coal', 'Wine'],
        demandCards: [42, 73],
        resolvedDemands: [
          { cardId: 42, demands: [{ city: 'Berlin', loadType: 'Coal', payment: 10 }] },
          { cardId: 73, demands: [{ city: 'Paris', loadType: 'Wine', payment: 20 }] },
        ],
      }));

      await sim.runTurn();
      const m = sim.getMetrics();
      expect(m.deliveryCount).toBe(2);
      expect(m.totalEarnings).toBe(30);
    });

    it('should track consecutive pass turns and reset on other actions', async () => {
      let callCount = 0;
      const takeTurn: TakeTurnFn = jest.fn().mockImplementation(() => {
        callCount++;
        if (callCount <= 3) return Promise.resolve(makePassResult());
        return Promise.resolve(makeBuildResult());
      });
      const sim = new GameSimulator(takeTurn);
      sim.initialize(createMockSnapshot());

      await sim.runTurn(); // pass
      expect(sim.getMetrics().consecutivePassTurns).toBe(1);
      await sim.runTurn(); // pass
      expect(sim.getMetrics().consecutivePassTurns).toBe(2);
      await sim.runTurn(); // pass
      expect(sim.getMetrics().consecutivePassTurns).toBe(3);
      await sim.runTurn(); // build
      expect(sim.getMetrics().consecutivePassTurns).toBe(0);
    });

    it('should track action history', async () => {
      let callCount = 0;
      const takeTurn: TakeTurnFn = jest.fn().mockImplementation(() => {
        callCount++;
        if (callCount === 1) return Promise.resolve(makeBuildResult());
        if (callCount === 2) return Promise.resolve(makeMoveResult());
        return Promise.resolve(makePassResult());
      });
      const sim = new GameSimulator(takeTurn);
      sim.initialize(createMockSnapshot());

      await sim.runTurn();
      await sim.runTurn();
      await sim.runTurn();

      expect(sim.getMetrics().actionHistory).toEqual([
        AIActionType.BuildTrack,
        AIActionType.MoveTrain,
        AIActionType.PassTurn,
      ]);
    });

    it('should track build target city', async () => {
      const takeTurn: TakeTurnFn = jest.fn().mockResolvedValue(
        makeBuildResult({ buildTargetCity: 'Milano' }),
      );
      const sim = new GameSimulator(takeTurn);
      sim.initialize(createMockSnapshot());

      await sim.runTurn();
      expect(sim.getMetrics().currentBuildTarget).toBe('Milano');
    });

    it('should track errors', async () => {
      const takeTurn: TakeTurnFn = jest.fn().mockResolvedValue(makeErrorResult());
      const sim = new GameSimulator(takeTurn);
      sim.initialize(createMockSnapshot());

      await sim.runTurn();
      const m = sim.getMetrics();
      expect(m.errors).toHaveLength(1);
      expect(m.errors[0]).toContain('Pipeline error');
    });

    it('should track segments built and track cost', async () => {
      const takeTurn: TakeTurnFn = jest.fn().mockResolvedValue(
        makeBuildResult({ segmentsBuilt: 4, cost: 8 }),
      );
      const sim = new GameSimulator(takeTurn);
      sim.initialize(createMockSnapshot());

      await sim.runTurn();
      await sim.runTurn();
      const m = sim.getMetrics();
      expect(m.totalSegmentsBuilt).toBe(8);
      expect(m.totalTrackCost).toBe(16);
    });
  });

  describe('runTurns', () => {
    it('should run multiple turns and return count of completed', async () => {
      const takeTurn: TakeTurnFn = jest.fn().mockResolvedValue(makeBuildResult());
      const sim = new GameSimulator(takeTurn);
      sim.initialize(createMockSnapshot());

      const completed = await sim.runTurns(5);
      expect(completed).toBe(5);
      expect(sim.getMetrics().turnCount).toBe(5);
    });

    it('should stop early on error result', async () => {
      let callCount = 0;
      const takeTurn: TakeTurnFn = jest.fn().mockImplementation(() => {
        callCount++;
        if (callCount === 3) return Promise.resolve(makeErrorResult());
        return Promise.resolve(makeBuildResult());
      });
      const sim = new GameSimulator(takeTurn);
      sim.initialize(createMockSnapshot());

      const completed = await sim.runTurns(10);
      expect(completed).toBe(3); // 2 successes + 1 error = 3 completed
      expect(sim.getMetrics().turnCount).toBe(3);
    });

    it('should complete a 10-turn simulation', async () => {
      const takeTurn: TakeTurnFn = jest.fn().mockResolvedValue(makeBuildResult({ cost: 3, segmentsBuilt: 2 }));
      const sim = new GameSimulator(takeTurn);
      sim.initialize(createMockSnapshot({ initialMoney: 100 }));

      const completed = await sim.runTurns(10);
      expect(completed).toBe(10);
      expect(sim.getMetrics().turnCount).toBe(10);
      expect(sim.getMetrics().totalSegmentsBuilt).toBe(20);
    });
  });

  describe('snapshot immutability', () => {
    it('should return a copy from getSnapshot that cannot mutate internal state', async () => {
      const takeTurn: TakeTurnFn = jest.fn().mockResolvedValue(makePassResult());
      const sim = new GameSimulator(takeTurn);
      sim.initialize(createMockSnapshot({ initialMoney: 50 }));

      const snap1 = sim.getSnapshot();
      snap1.bot.money = 999;

      const snap2 = sim.getSnapshot();
      expect(snap2.bot.money).toBe(50);
    });

    it('should return a copy from getMetrics that cannot mutate internal state', async () => {
      const takeTurn: TakeTurnFn = jest.fn().mockResolvedValue(makeBuildResult());
      const sim = new GameSimulator(takeTurn);
      sim.initialize(createMockSnapshot());
      await sim.runTurn();

      const m1 = sim.getMetrics();
      m1.deliveryCount = 999;
      m1.actionHistory.push(AIActionType.DiscardHand);

      const m2 = sim.getMetrics();
      expect(m2.deliveryCount).toBe(0);
      expect(m2.actionHistory).toEqual([AIActionType.BuildTrack]);
    });
  });

  describe('performance', () => {
    it('should complete a 10-turn simulation in under 5 seconds', async () => {
      const takeTurn: TakeTurnFn = jest.fn().mockResolvedValue(makeBuildResult());
      const sim = new GameSimulator(takeTurn);
      sim.initialize(createMockSnapshot());

      const start = Date.now();
      await sim.runTurns(10);
      const elapsed = Date.now() - start;

      expect(elapsed).toBeLessThan(5000);
    });
  });
});
