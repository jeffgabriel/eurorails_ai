import { TurnExecutor } from '../services/ai/TurnExecutor';
import {
  FeasibleOption,
  WorldSnapshot,
  AIActionType,
  TerrainType,
  TrackSegment,
} from '../../shared/types/GameTypes';
import { TrackService } from '../services/trackService';
import { emitToGame } from '../services/socketService';
import { db } from '../db/index';

// Mock dependencies
jest.mock('../services/trackService');
jest.mock('../services/socketService', () => ({
  emitToGame: jest.fn(),
}));
jest.mock('../db/index', () => ({
  db: {
    connect: jest.fn(),
    query: jest.fn(),
  },
}));

const mockTrackService = TrackService as jest.Mocked<typeof TrackService>;
const mockEmitToGame = emitToGame as jest.Mock;
const mockDb = db as jest.Mocked<typeof db>;

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

function makeBuildOption(segments: TrackSegment[]): FeasibleOption {
  return {
    action: AIActionType.BuildTrack,
    feasible: true,
    reason: 'Build track',
    segments,
    estimatedCost: segments.reduce((s, seg) => s + seg.cost, 0),
  };
}

function makePassOption(): FeasibleOption {
  return {
    action: AIActionType.PassTurn,
    feasible: true,
    reason: 'Always an option',
  };
}

// Shared mock client for transaction tests
function makeMockClient() {
  return {
    query: jest.fn().mockResolvedValue({ rows: [] }),
    release: jest.fn(),
  };
}

describe('TurnExecutor', () => {
  let mockClient: ReturnType<typeof makeMockClient>;

  beforeEach(() => {
    jest.clearAllMocks();
    mockClient = makeMockClient();
    (mockDb.connect as jest.Mock).mockResolvedValue(mockClient);
    (mockDb.query as jest.Mock).mockResolvedValue({ rows: [] });
    mockTrackService.saveTrackState.mockResolvedValue(undefined);
  });

  describe('BuildTrack — successful execution', () => {
    it('should save track state with appended segments', async () => {
      const seg = makeSegment(3);
      const plan = makeBuildOption([seg]);
      const snapshot = makeSnapshot();

      await TurnExecutor.execute(plan, snapshot);

      expect(mockTrackService.saveTrackState).toHaveBeenCalledTimes(1);
      const [gameId, playerId, trackState] = mockTrackService.saveTrackState.mock.calls[0];
      expect(gameId).toBe('game-1');
      expect(playerId).toBe('bot-1');
      expect(trackState.segments).toEqual([seg]);
      expect(trackState.turnBuildCost).toBe(3);
    });

    it('should append to existing segments', async () => {
      const existingSeg = makeSegment(2);
      const newSeg = makeSegment(1);
      const plan = makeBuildOption([newSeg]);
      const snapshot = makeSnapshot({ existingSegments: [existingSeg] });

      await TurnExecutor.execute(plan, snapshot);

      const [, , trackState] = mockTrackService.saveTrackState.mock.calls[0];
      expect(trackState.segments).toEqual([existingSeg, newSeg]);
      expect(trackState.totalCost).toBe(3);
    });

    it('should deduct money from bot player', async () => {
      const seg = makeSegment(5);
      const plan = makeBuildOption([seg]);
      const snapshot = makeSnapshot();

      await TurnExecutor.execute(plan, snapshot);

      // Find the UPDATE players SET money call
      const moneyCall = mockClient.query.mock.calls.find(
        (call: unknown[]) => typeof call[0] === 'string' && call[0].includes('UPDATE players SET money'),
      );
      expect(moneyCall).toBeDefined();
      expect(moneyCall![1]).toEqual([5, 'game-1', 'bot-1']);
    });

    it('should insert audit record', async () => {
      const seg = makeSegment(3);
      const plan = makeBuildOption([seg]);
      const snapshot = makeSnapshot();

      await TurnExecutor.execute(plan, snapshot);

      const auditCall = mockClient.query.mock.calls.find(
        (call: unknown[]) => typeof call[0] === 'string' && call[0].includes('bot_turn_audits'),
      );
      expect(auditCall).toBeDefined();
      const params = auditCall![1] as unknown[];
      expect(params[0]).toBe('game-1');        // game_id
      expect(params[1]).toBe('bot-1');         // player_id
      expect(params[2]).toBe(3);               // turn_number
      expect(params[3]).toBe('BuildTrack');    // action
      expect(params[5]).toBe(3);               // cost
      expect(params[6]).toBe(47);              // remaining_money (50 - 3)
    });

    it('should use BEGIN and COMMIT for transaction', async () => {
      const seg = makeSegment(1);
      const plan = makeBuildOption([seg]);

      await TurnExecutor.execute(plan, makeSnapshot());

      const queries = mockClient.query.mock.calls.map((c: unknown[]) => c[0]);
      expect(queries[0]).toBe('BEGIN');
      expect(queries[queries.length - 1]).toBe('COMMIT');
    });

    it('should emit track:updated event post-commit', async () => {
      const seg = makeSegment(2);
      const plan = makeBuildOption([seg]);

      await TurnExecutor.execute(plan, makeSnapshot());

      expect(mockEmitToGame).toHaveBeenCalledWith(
        'game-1',
        'track:updated',
        expect.objectContaining({
          playerId: 'bot-1',
          segments: [seg],
          turnBuildCost: 2,
        }),
      );
    });

    it('should release client after execution', async () => {
      const seg = makeSegment(1);
      const plan = makeBuildOption([seg]);

      await TurnExecutor.execute(plan, makeSnapshot());

      expect(mockClient.release).toHaveBeenCalledTimes(1);
    });

    it('should return success result with correct fields', async () => {
      const seg = makeSegment(4);
      const plan = makeBuildOption([seg]);

      const result = await TurnExecutor.execute(plan, makeSnapshot());

      expect(result.success).toBe(true);
      expect(result.action).toBe(AIActionType.BuildTrack);
      expect(result.cost).toBe(4);
      expect(result.segmentsBuilt).toBe(1);
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
      expect(result.error).toBeUndefined();
    });
  });

  describe('BuildTrack — failure and rollback', () => {
    it('should ROLLBACK on TrackService failure', async () => {
      mockTrackService.saveTrackState.mockRejectedValue(new Error('DB write failed'));
      const seg = makeSegment(1);
      const plan = makeBuildOption([seg]);

      const result = await TurnExecutor.execute(plan, makeSnapshot());

      expect(result.success).toBe(false);
      expect(result.error).toBe('DB write failed');
      const queries = mockClient.query.mock.calls.map((c: unknown[]) => c[0]);
      expect(queries).toContain('BEGIN');
      expect(queries).toContain('ROLLBACK');
      expect(queries).not.toContain('COMMIT');
    });

    it('should NOT emit socket events on failure', async () => {
      mockTrackService.saveTrackState.mockRejectedValue(new Error('fail'));
      const seg = makeSegment(1);
      const plan = makeBuildOption([seg]);

      await TurnExecutor.execute(plan, makeSnapshot());

      expect(mockEmitToGame).not.toHaveBeenCalled();
    });

    it('should release client even on failure', async () => {
      mockTrackService.saveTrackState.mockRejectedValue(new Error('fail'));
      const seg = makeSegment(1);
      const plan = makeBuildOption([seg]);

      await TurnExecutor.execute(plan, makeSnapshot());

      expect(mockClient.release).toHaveBeenCalledTimes(1);
    });

    it('should return error result with zero cost', async () => {
      mockTrackService.saveTrackState.mockRejectedValue(new Error('boom'));
      const seg = makeSegment(5);
      const plan = makeBuildOption([seg]);

      const result = await TurnExecutor.execute(plan, makeSnapshot());

      expect(result.success).toBe(false);
      expect(result.cost).toBe(0);
      expect(result.segmentsBuilt).toBe(0);
      expect(result.error).toBe('boom');
    });
  });

  describe('PassTurn execution', () => {
    it('should insert audit record for PassTurn', async () => {
      const plan = makePassOption();

      await TurnExecutor.execute(plan, makeSnapshot());

      const auditCall = (mockDb.query as jest.Mock).mock.calls.find(
        (call: unknown[]) => typeof call[0] === 'string' && (call[0] as string).includes('bot_turn_audits'),
      );
      expect(auditCall).toBeDefined();
      const params = auditCall![1] as unknown[];
      expect(params[3]).toBe('PassTurn');     // action
      expect(params[4]).toBe(0);              // cost
      expect(params[5]).toBe(50);             // remaining_money (unchanged)
    });

    it('should NOT call TrackService for PassTurn', async () => {
      const plan = makePassOption();

      await TurnExecutor.execute(plan, makeSnapshot());

      expect(mockTrackService.saveTrackState).not.toHaveBeenCalled();
    });

    it('should NOT emit track:updated for PassTurn', async () => {
      const plan = makePassOption();

      await TurnExecutor.execute(plan, makeSnapshot());

      expect(mockEmitToGame).not.toHaveBeenCalled();
    });

    it('should NOT acquire a transaction client for PassTurn', async () => {
      const plan = makePassOption();

      await TurnExecutor.execute(plan, makeSnapshot());

      expect(mockDb.connect).not.toHaveBeenCalled();
    });

    it('should return success result with zero cost', async () => {
      const plan = makePassOption();

      const result = await TurnExecutor.execute(plan, makeSnapshot());

      expect(result.success).toBe(true);
      expect(result.action).toBe(AIActionType.PassTurn);
      expect(result.cost).toBe(0);
      expect(result.segmentsBuilt).toBe(0);
    });
  });
});
