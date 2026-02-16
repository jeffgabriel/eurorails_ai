import { AIStrategyEngine } from '../services/ai/AIStrategyEngine';
import { capture } from '../services/ai/WorldSnapshotService';
import { OptionGenerator } from '../services/ai/OptionGenerator';
import { Scorer } from '../services/ai/Scorer';
import { validate } from '../services/ai/PlanValidator';
import { TurnExecutor } from '../services/ai/TurnExecutor';
import {
  WorldSnapshot,
  FeasibleOption,
  AIActionType,
  TerrainType,
  TrackSegment,
} from '../../shared/types/GameTypes';
import { emitToGame } from '../services/socketService';
import { db } from '../db/index';
import { getMajorCityGroups, getFerryEdges } from '../../shared/services/majorCityGroups';

// Mock all pipeline services
jest.mock('../services/ai/WorldSnapshotService');
jest.mock('../services/ai/OptionGenerator');
jest.mock('../services/ai/Scorer');
jest.mock('../services/ai/PlanValidator');
jest.mock('../services/ai/TurnExecutor');
jest.mock('../services/socketService', () => ({
  emitToGame: jest.fn(),
}));
jest.mock('../db/index', () => ({
  db: { query: jest.fn().mockResolvedValue({ rows: [] }) },
}));
jest.mock('../../shared/services/majorCityGroups');
jest.mock('../services/ai/MapTopology', () => ({
  loadGridPoints: jest.fn(() => new Map()),
  getHexNeighbors: jest.fn(() => []),
  getTerrainCost: jest.fn(() => 1),
  gridToPixel: jest.fn(() => ({ x: 100, y: 200 })),
  _resetCache: jest.fn(),
}));

const mockCapture = capture as jest.Mock;
const mockGenerate = OptionGenerator.generate as jest.Mock;
const mockScore = Scorer.score as jest.Mock;
const mockValidate = validate as jest.Mock;
const mockExecute = TurnExecutor.execute as jest.Mock;
const mockGetMajorCityGroups = getMajorCityGroups as jest.Mock;
const mockGetFerryEdges = getFerryEdges as jest.Mock;

function makeSegment(cost: number): TrackSegment {
  return {
    from: { x: 0, y: 0, row: 29, col: 32, terrain: TerrainType.MajorCity },
    to: { x: 0, y: 0, row: 29, col: 31, terrain: TerrainType.Clear },
    cost,
  };
}

function makeSnapshot(overrides?: Partial<WorldSnapshot['bot']>): WorldSnapshot {
  return {
    gameId: 'game-1',
    gameStatus: 'active',
    turnNumber: 3,
    bot: {
      playerId: 'bot-1',
      userId: 'user-bot-1',
      money: 50,
      position: { row: 29, col: 32 },
      existingSegments: [],
      demandCards: [],
      resolvedDemands: [],
      trainType: 'Freight',
      loads: [],
      botConfig: null,
      connectedMajorCityCount: 0,
      ...overrides,
    },
    allPlayerTracks: [],
    loadAvailability: {},
  };
}

function makeBuildOption(cost: number = 3): FeasibleOption {
  return {
    action: AIActionType.BuildTrack,
    feasible: true,
    reason: 'Build track',
    segments: [makeSegment(cost)],
    estimatedCost: cost,
  };
}

function makePassOption(): FeasibleOption {
  return {
    action: AIActionType.PassTurn,
    feasible: true,
    reason: 'Always an option',
  };
}

describe('AIStrategyEngine', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetMajorCityGroups.mockReturnValue([
      { cityName: 'Paris', center: { row: 29, col: 32 }, outposts: [] },
    ]);
    mockGetFerryEdges.mockReturnValue([]);
  });

  describe('happy path — BuildTrack', () => {
    it('should orchestrate pipeline: capture → generate → score → validate → execute', async () => {
      const snapshot = makeSnapshot();
      const buildOption = makeBuildOption();
      const scored = [buildOption, makePassOption()];

      mockCapture.mockResolvedValue(snapshot);
      mockGenerate.mockReturnValue([buildOption, makePassOption()]);
      mockScore.mockReturnValue(scored);
      mockValidate.mockReturnValue({ valid: true, reason: 'ok' });
      mockExecute.mockResolvedValue({
        success: true,
        action: AIActionType.BuildTrack,
        cost: 3,
        segmentsBuilt: 1,
        durationMs: 10,
      });

      const result = await AIStrategyEngine.takeTurn('game-1', 'bot-1');

      expect(mockCapture).toHaveBeenCalledWith('game-1', 'bot-1');
      // generate() is called with (snapshot, actions, memory) — verify first arg
      expect(mockGenerate).toHaveBeenCalledWith(snapshot, expect.any(Set), expect.any(Object));
      expect(mockScore).toHaveBeenCalled();
      expect(mockValidate).toHaveBeenCalledWith(buildOption, snapshot);
      expect(mockExecute).toHaveBeenCalledWith(buildOption, snapshot);
      expect(result.action).toBe(AIActionType.BuildTrack);
      expect(result.success).toBe(true);
      expect(result.segmentsBuilt).toBe(1);
      expect(result.cost).toBe(3);
    });
  });

  describe('auto-placement', () => {
    it('should auto-place bot when position is null and has track', async () => {
      const seg = makeSegment(1);
      const snapshot = makeSnapshot({
        position: null,
        existingSegments: [seg],
      });

      mockCapture.mockResolvedValue(snapshot);
      mockGenerate.mockReturnValue([makePassOption()]);
      mockScore.mockReturnValue([makePassOption()]);
      mockValidate.mockReturnValue({ valid: true, reason: 'ok' });
      mockExecute.mockResolvedValue({
        success: true,
        action: AIActionType.PassTurn,
        cost: 0,
        segmentsBuilt: 0,
        durationMs: 5,
      });

      await AIStrategyEngine.takeTurn('game-1', 'bot-1');

      // Should have called db.query to UPDATE position
      expect((db.query as jest.Mock)).toHaveBeenCalledWith(
        expect.stringContaining('UPDATE players SET position_row'),
        expect.arrayContaining(['bot-1']),
      );
    });

    it('should NOT auto-place bot when position exists', async () => {
      const snapshot = makeSnapshot({ position: { row: 10, col: 10 } });

      mockCapture.mockResolvedValue(snapshot);
      mockGenerate.mockReturnValue([makePassOption()]);
      mockScore.mockReturnValue([makePassOption()]);
      mockValidate.mockReturnValue({ valid: true, reason: 'ok' });
      mockExecute.mockResolvedValue({
        success: true,
        action: AIActionType.PassTurn,
        cost: 0,
        segmentsBuilt: 0,
        durationMs: 5,
      });

      await AIStrategyEngine.takeTurn('game-1', 'bot-1');

      expect((db.query as jest.Mock)).not.toHaveBeenCalledWith(
        expect.stringContaining('UPDATE players SET position_row'),
        expect.anything(),
      );
    });

    it('should NOT auto-place bot when no existing track', async () => {
      const snapshot = makeSnapshot({ position: null, existingSegments: [] });

      mockCapture.mockResolvedValue(snapshot);
      mockGenerate.mockReturnValue([makePassOption()]);
      mockScore.mockReturnValue([makePassOption()]);
      mockValidate.mockReturnValue({ valid: true, reason: 'ok' });
      mockExecute.mockResolvedValue({
        success: true,
        action: AIActionType.PassTurn,
        cost: 0,
        segmentsBuilt: 0,
        durationMs: 5,
      });

      await AIStrategyEngine.takeTurn('game-1', 'bot-1');

      expect((db.query as jest.Mock)).not.toHaveBeenCalledWith(
        expect.stringContaining('UPDATE players SET position_row'),
        expect.anything(),
      );
    });
  });

  describe('fallback to PassTurn — no valid options', () => {
    it('should fall back to PassTurn when all options fail validation', async () => {
      const snapshot = makeSnapshot();
      const buildOption = makeBuildOption();

      mockCapture.mockResolvedValue(snapshot);
      mockGenerate.mockReturnValue([buildOption, makePassOption()]);
      mockScore.mockReturnValue([buildOption, makePassOption()]);
      mockValidate.mockReturnValue({ valid: false, reason: 'Invalid' });
      mockExecute.mockResolvedValue({
        success: true,
        action: AIActionType.PassTurn,
        cost: 0,
        segmentsBuilt: 0,
        durationMs: 5,
      });

      const result = await AIStrategyEngine.takeTurn('game-1', 'bot-1');

      expect(result.action).toBe(AIActionType.PassTurn);
      expect(result.cost).toBe(0);
    });

    it('should fall back to PassTurn when only infeasible options exist', async () => {
      const infeasible: FeasibleOption = {
        action: AIActionType.BuildTrack,
        feasible: false,
        reason: 'No money',
      };
      const snapshot = makeSnapshot();

      mockCapture.mockResolvedValue(snapshot);
      mockGenerate.mockReturnValue([infeasible, makePassOption()]);
      mockScore.mockReturnValue([infeasible, makePassOption()]);
      mockValidate.mockReturnValue({ valid: true, reason: 'ok' });
      mockExecute.mockResolvedValue({
        success: true,
        action: AIActionType.PassTurn,
        cost: 0,
        segmentsBuilt: 0,
        durationMs: 5,
      });

      const result = await AIStrategyEngine.takeTurn('game-1', 'bot-1');

      // Infeasible breaks the loop, falls back to PassTurn
      expect(result.action).toBe(AIActionType.PassTurn);
    });
  });

  describe('retry mechanism', () => {
    it('should retry with next option on execution failure', async () => {
      const snapshot = makeSnapshot();
      const option1 = makeBuildOption(3);
      const option2 = makeBuildOption(5);

      mockCapture.mockResolvedValue(snapshot);
      mockGenerate.mockReturnValue([option1, option2, makePassOption()]);
      mockScore.mockReturnValue([option1, option2, makePassOption()]);
      mockValidate.mockReturnValue({ valid: true, reason: 'ok' });
      mockExecute
        .mockResolvedValueOnce({
          success: false,
          action: AIActionType.BuildTrack,
          cost: 0,
          segmentsBuilt: 0,
          durationMs: 5,
          error: 'DB error',
        })
        .mockResolvedValueOnce({
          success: true,
          action: AIActionType.BuildTrack,
          cost: 5,
          segmentsBuilt: 1,
          durationMs: 10,
        });

      const result = await AIStrategyEngine.takeTurn('game-1', 'bot-1');

      expect(mockExecute).toHaveBeenCalledTimes(2);
      expect(result.success).toBe(true);
      expect(result.action).toBe(AIActionType.BuildTrack);
    });

    it('should fall back to PassTurn after MAX_RETRIES failures', async () => {
      const snapshot = makeSnapshot();
      const opt1 = makeBuildOption(1);
      const opt2 = makeBuildOption(2);
      const opt3 = makeBuildOption(3);

      mockCapture.mockResolvedValue(snapshot);
      mockGenerate.mockReturnValue([opt1, opt2, opt3, makePassOption()]);
      mockScore.mockReturnValue([opt1, opt2, opt3, makePassOption()]);
      mockValidate.mockReturnValue({ valid: true, reason: 'ok' });
      mockExecute
        .mockResolvedValueOnce({ success: false, action: AIActionType.BuildTrack, cost: 0, segmentsBuilt: 0, durationMs: 5, error: 'fail1' })
        .mockResolvedValueOnce({ success: false, action: AIActionType.BuildTrack, cost: 0, segmentsBuilt: 0, durationMs: 5, error: 'fail2' })
        .mockResolvedValueOnce({ success: false, action: AIActionType.BuildTrack, cost: 0, segmentsBuilt: 0, durationMs: 5, error: 'fail3' })
        .mockResolvedValueOnce({ success: true, action: AIActionType.PassTurn, cost: 0, segmentsBuilt: 0, durationMs: 5 });

      const result = await AIStrategyEngine.takeTurn('game-1', 'bot-1');

      // 3 retries + 1 PassTurn fallback = 4 execute calls
      expect(mockExecute).toHaveBeenCalledTimes(4);
      expect(result.action).toBe(AIActionType.PassTurn);
    });
  });

  describe('error handling', () => {
    it('should return PassTurn result on snapshot capture failure', async () => {
      mockCapture.mockRejectedValue(new Error('DB connection failed'));

      const result = await AIStrategyEngine.takeTurn('game-1', 'bot-1');

      expect(result.action).toBe(AIActionType.PassTurn);
      expect(result.success).toBe(false);
      expect(result.error).toBe('DB connection failed');
    });
  });

  describe('bot:turn-complete result', () => {
    it('should include durationMs in result', async () => {
      const snapshot = makeSnapshot();

      mockCapture.mockResolvedValue(snapshot);
      mockGenerate.mockReturnValue([makePassOption()]);
      mockScore.mockReturnValue([makePassOption()]);
      mockValidate.mockReturnValue({ valid: true, reason: 'ok' });
      mockExecute.mockResolvedValue({
        success: true,
        action: AIActionType.PassTurn,
        cost: 0,
        segmentsBuilt: 0,
        durationMs: 5,
      });

      const result = await AIStrategyEngine.takeTurn('game-1', 'bot-1');

      expect(result.durationMs).toBeGreaterThanOrEqual(0);
      expect(result.action).toBe(AIActionType.PassTurn);
      expect(result.segmentsBuilt).toBe(0);
      expect(result.cost).toBe(0);
    });
  });
});

/* ────────────────────────────────────────────────────────────────────────
 * TEST-005: Integration test for two-phase bot turn (movement + building)
 * ──────────────────────────────────────────────────────────────────────── */

function makeMoveOption(mileposts: number = 3): FeasibleOption {
  const path = Array.from({ length: mileposts + 1 }, (_, i) => ({ row: 10 + i, col: 10 }));
  return {
    action: AIActionType.MoveTrain,
    feasible: true,
    reason: 'Move toward demand city',
    movementPath: path,
    targetPosition: path[path.length - 1],
    mileposts,
    estimatedCost: 4, // track usage fee
    targetCity: 'Berlin',
  };
}

describe('AIStrategyEngine — two-phase turn', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetMajorCityGroups.mockReturnValue([
      { cityName: 'Paris', center: { row: 29, col: 32 }, outposts: [] },
    ]);
    mockGetFerryEdges.mockReturnValue([]);
  });

  it('should move AND build in same turn', async () => {
    const snapshot = makeSnapshot({ position: { row: 10, col: 10 } });
    const moveOpt = makeMoveOption(3);
    const buildOpt = makeBuildOption(5);

    mockCapture.mockResolvedValue(snapshot);

    // Phase 1: generate returns move + build + pass; move is feasible
    // Phase 2: after move, generate returns build + pass
    let generateCallCount = 0;
    mockGenerate.mockImplementation(() => {
      generateCallCount++;
      if (generateCallCount === 1) {
        // First call: includes all options
        return [moveOpt, buildOpt, makePassOption()];
      }
      // Second call (phase 2): includes build + pass
      return [buildOpt, makePassOption()];
    });

    mockScore.mockImplementation((options: FeasibleOption[]) => {
      // Return in score order — just pass through
      return options.map((o, i) => ({ ...o, score: 100 - i }));
    });
    mockValidate.mockReturnValue({ valid: true, reason: 'ok' });

    // First execute = MoveTrain, second execute = BuildTrack
    mockExecute
      .mockResolvedValueOnce({
        success: true,
        action: AIActionType.MoveTrain,
        cost: 4,
        segmentsBuilt: 0,
        remainingMoney: 46,
        durationMs: 5,
      })
      .mockResolvedValueOnce({
        success: true,
        action: AIActionType.BuildTrack,
        cost: 5,
        segmentsBuilt: 1,
        remainingMoney: 41,
        durationMs: 10,
      });

    const result = await AIStrategyEngine.takeTurn('game-1', 'bot-1');

    // Should have executed twice: once for move, once for build
    expect(mockExecute).toHaveBeenCalledTimes(2);
    // Final result should be from the build phase
    expect(result.action).toBe(AIActionType.BuildTrack);
    expect(result.segmentsBuilt).toBe(1);
    expect(result.cost).toBe(5);
    expect(result.success).toBe(true);
    // Movement data should be included in result
    expect(result.movedTo).toBeDefined();
    expect(result.milepostsMoved).toBe(3);
    expect(result.trackUsageFee).toBeDefined();
  });

  it('should continue to building when movement fails', async () => {
    const snapshot = makeSnapshot({ position: { row: 10, col: 10 } });
    const moveOpt = makeMoveOption(3);
    const buildOpt = makeBuildOption(5);

    mockCapture.mockResolvedValue(snapshot);

    let generateCallCount = 0;
    mockGenerate.mockImplementation(() => {
      generateCallCount++;
      if (generateCallCount === 1) {
        return [moveOpt, buildOpt, makePassOption()];
      }
      return [buildOpt, makePassOption()];
    });

    mockScore.mockImplementation((options: FeasibleOption[]) => {
      return options.map((o, i) => ({ ...o, score: 100 - i }));
    });
    mockValidate.mockReturnValue({ valid: true, reason: 'ok' });

    // MoveTrain throws, BuildTrack succeeds
    mockExecute
      .mockRejectedValueOnce(new Error('Move failed'))
      .mockResolvedValueOnce({
        success: true,
        action: AIActionType.BuildTrack,
        cost: 5,
        segmentsBuilt: 1,
        remainingMoney: 45,
        durationMs: 10,
      });

    const result = await AIStrategyEngine.takeTurn('game-1', 'bot-1');

    // Build phase should still succeed even though movement failed
    expect(result.action).toBe(AIActionType.BuildTrack);
    expect(result.segmentsBuilt).toBe(1);
    expect(result.success).toBe(true);
    // No movement data since movement failed
    expect(result.movedTo).toBeUndefined();
  });

  it('should update snapshot between phases for consistent state', async () => {
    const snapshot = makeSnapshot({ position: { row: 10, col: 10 }, money: 50 });
    const moveOpt = makeMoveOption(2);

    mockCapture.mockResolvedValue(snapshot);

    let generateCallCount = 0;
    mockGenerate.mockImplementation(() => {
      generateCallCount++;
      if (generateCallCount === 1) {
        return [moveOpt, makePassOption()];
      }
      // Phase 2: return just PassTurn
      return [makePassOption()];
    });

    mockScore.mockImplementation((options: FeasibleOption[]) => {
      return options.map((o, i) => ({ ...o, score: 100 - i }));
    });
    mockValidate.mockReturnValue({ valid: true, reason: 'ok' });

    mockExecute
      .mockResolvedValueOnce({
        success: true,
        action: AIActionType.MoveTrain,
        cost: 4,
        segmentsBuilt: 0,
        remainingMoney: 46,
        durationMs: 5,
      })
      .mockResolvedValueOnce({
        success: true,
        action: AIActionType.PassTurn,
        cost: 0,
        segmentsBuilt: 0,
        remainingMoney: 46,
        durationMs: 3,
      });

    await AIStrategyEngine.takeTurn('game-1', 'bot-1');

    // Verify snapshot was updated between phases
    // After Phase 1, snapshot.bot.money should be updated to remainingMoney
    expect(snapshot.bot.money).toBe(46);
    // Position should be updated to final move destination
    expect(snapshot.bot.position).toEqual({ row: 12, col: 10 });
  });

  it('should skip movement phase during initialBuild', async () => {
    const snapshot = makeSnapshot({ position: { row: 10, col: 10 } });
    // Override gameStatus to initialBuild
    (snapshot as any).gameStatus = 'initialBuild';

    mockCapture.mockResolvedValue(snapshot);

    mockGenerate.mockReturnValue([makeBuildOption(3), makePassOption()]);
    mockScore.mockImplementation((options: FeasibleOption[]) => {
      return options.map((o, i) => ({ ...o, score: 100 - i }));
    });
    mockValidate.mockReturnValue({ valid: true, reason: 'ok' });
    mockExecute.mockResolvedValue({
      success: true,
      action: AIActionType.BuildTrack,
      cost: 3,
      segmentsBuilt: 1,
      remainingMoney: 47,
      durationMs: 8,
    });

    const result = await AIStrategyEngine.takeTurn('game-1', 'bot-1');

    // Should only call execute once (building phase only, no movement)
    expect(mockExecute).toHaveBeenCalledTimes(1);
    expect(result.action).toBe(AIActionType.BuildTrack);
    expect(result.movedTo).toBeUndefined();
  });
});

/* ────────────────────────────────────────────────────────────────────────
 * TEST-005: AIStrategyEngine multi-action turn with pickup/delivery
 * ──────────────────────────────────────────────────────────────────────── */

import { LoadType } from '../../shared/types/LoadTypes';

function makeDeliveryOption(loadType: string, payment: number, cardId: number): FeasibleOption {
  return {
    action: AIActionType.DeliverLoad,
    feasible: true,
    reason: `Deliver ${loadType}`,
    loadType: loadType as LoadType,
    targetCity: 'Berlin',
    cardId,
    payment,
  };
}

function makePickupOption2(loadType: string): FeasibleOption {
  return {
    action: AIActionType.PickupLoad,
    feasible: true,
    reason: `Pick up ${loadType}`,
    loadType: loadType as LoadType,
    targetCity: 'Hamburg',
  };
}

describe('AIStrategyEngine — multi-action turn with loads', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetMajorCityGroups.mockReturnValue([
      { cityName: 'Paris', center: { row: 29, col: 32 }, outposts: [] },
    ]);
    mockGetFerryEdges.mockReturnValue([]);
  });

  it('should execute Phase 0 delivery at current position before movement', async () => {
    const snapshot = makeSnapshot({
      position: { row: 10, col: 10 },
      loads: ['Coal'],
      resolvedDemands: [{ cardId: 42, demands: [{ city: 'Berlin', loadType: 'Coal', payment: 10 }] }],
      demandCards: [42],
    });

    const deliveryOpt = makeDeliveryOption('Coal', 10, 42);

    mockCapture.mockResolvedValue(snapshot);

    let generateCallCount = 0;
    mockGenerate.mockImplementation(() => {
      generateCallCount++;
      if (generateCallCount <= 2) {
        // Phase 0: delivery available, then pickup check (no pickups)
        return [deliveryOpt, makePassOption()];
      }
      // Later phases: no more load actions, just build/pass
      return [makePassOption()];
    });

    mockScore.mockImplementation((options: FeasibleOption[]) => {
      return options.map((o, i) => ({ ...o, score: 100 - i }));
    });
    mockValidate.mockReturnValue({ valid: true, reason: 'ok' });

    mockExecute.mockResolvedValue({
      success: true,
      action: AIActionType.DeliverLoad,
      cost: 0,
      segmentsBuilt: 0,
      remainingMoney: 60,
      durationMs: 5,
      payment: 10,
      newCardId: 99,
    });

    const result = await AIStrategyEngine.takeTurn('game-1', 'bot-1');

    // Delivery should have been executed
    expect(mockExecute).toHaveBeenCalled();
    // Result should include loadsDelivered
    expect(result.loadsDelivered).toBeDefined();
    expect(result.loadsDelivered!.length).toBeGreaterThanOrEqual(1);
    expect(result.loadsDelivered![0].loadType).toBe('Coal');
    expect(result.loadsDelivered![0].payment).toBe(10);
  });

  it('should execute Phase 1.5 pickup after movement', async () => {
    const snapshot = makeSnapshot({
      position: { row: 10, col: 10 },
      loads: [],
    });

    const moveOpt = makeMoveOption(3);
    const pickupOpt = makePickupOption2('Iron');

    mockCapture.mockResolvedValue(snapshot);

    let generateCallCount = 0;
    mockGenerate.mockImplementation(() => {
      generateCallCount++;
      if (generateCallCount <= 2) {
        // Phase 0: no loads to deliver or pick up initially
        return [makePassOption()];
      }
      if (generateCallCount === 3) {
        // Phase 1: movement
        return [moveOpt, makePassOption()];
      }
      if (generateCallCount <= 5) {
        // Phase 1.5: pickup available at new position
        return [pickupOpt, makePassOption()];
      }
      // Phase 2: build
      return [makePassOption()];
    });

    mockScore.mockImplementation((options: FeasibleOption[]) => {
      return options.map((o, i) => ({ ...o, score: 100 - i }));
    });
    mockValidate.mockReturnValue({ valid: true, reason: 'ok' });

    mockExecute
      .mockResolvedValueOnce({ // MoveTrain
        success: true,
        action: AIActionType.MoveTrain,
        cost: 4,
        segmentsBuilt: 0,
        remainingMoney: 46,
        durationMs: 5,
      })
      .mockResolvedValueOnce({ // PickupLoad
        success: true,
        action: AIActionType.PickupLoad,
        cost: 0,
        segmentsBuilt: 0,
        remainingMoney: 46,
        durationMs: 3,
      })
      .mockResolvedValueOnce({ // PassTurn (Phase 2)
        success: true,
        action: AIActionType.PassTurn,
        cost: 0,
        segmentsBuilt: 0,
        remainingMoney: 46,
        durationMs: 2,
      });

    const result = await AIStrategyEngine.takeTurn('game-1', 'bot-1');

    // Should have pickup data
    expect(result.loadsPickedUp).toBeDefined();
    expect(result.loadsPickedUp!.length).toBeGreaterThanOrEqual(1);
    expect(result.loadsPickedUp![0].loadType).toBe('Iron');
    // Movement should still be tracked
    expect(result.movedTo).toBeDefined();
  });

  it('should re-capture snapshot after Phase 0 state changes', async () => {
    const snapshot = makeSnapshot({
      position: { row: 10, col: 10 },
      loads: ['Coal'],
      resolvedDemands: [{ cardId: 42, demands: [{ city: 'Berlin', loadType: 'Coal', payment: 10 }] }],
      demandCards: [42],
    });

    const deliveryOpt = makeDeliveryOption('Coal', 10, 42);

    mockCapture.mockResolvedValue(snapshot);

    let generateCallCount = 0;
    mockGenerate.mockImplementation(() => {
      generateCallCount++;
      if (generateCallCount === 1) return [deliveryOpt];
      return [makePassOption()];
    });

    mockScore.mockImplementation((options: FeasibleOption[]) => {
      return options.map((o, i) => ({ ...o, score: 100 - i }));
    });
    mockValidate.mockReturnValue({ valid: true, reason: 'ok' });

    mockExecute.mockResolvedValue({
      success: true,
      action: AIActionType.DeliverLoad,
      cost: 0,
      segmentsBuilt: 0,
      remainingMoney: 60,
      durationMs: 5,
      payment: 10,
      newCardId: 99,
    });

    await AIStrategyEngine.takeTurn('game-1', 'bot-1');

    // capture should be called at least twice: initial + re-capture after Phase 0
    expect(mockCapture.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('should include empty loadsPickedUp/loadsDelivered as undefined when no load actions', async () => {
    const snapshot = makeSnapshot();

    mockCapture.mockResolvedValue(snapshot);
    mockGenerate.mockReturnValue([makePassOption()]);
    mockScore.mockReturnValue([makePassOption()]);
    mockValidate.mockReturnValue({ valid: true, reason: 'ok' });
    mockExecute.mockResolvedValue({
      success: true,
      action: AIActionType.PassTurn,
      cost: 0,
      segmentsBuilt: 0,
      durationMs: 5,
    });

    const result = await AIStrategyEngine.takeTurn('game-1', 'bot-1');

    expect(result.loadsPickedUp).toBeUndefined();
    expect(result.loadsDelivered).toBeUndefined();
  });
});
