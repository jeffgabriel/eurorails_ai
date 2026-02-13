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
import { getMajorCityGroups } from '../../shared/services/majorCityGroups';

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
      money: 50,
      position: { row: 29, col: 32 },
      existingSegments: [],
      demandCards: [],
      trainType: 'Freight',
      loads: [],
      botConfig: null,
      ...overrides,
    },
    allPlayerTracks: [],
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
      expect(mockGenerate).toHaveBeenCalledWith(snapshot);
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
