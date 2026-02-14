import { TurnExecutor } from '../services/ai/TurnExecutor';
import {
  FeasibleOption,
  WorldSnapshot,
  AIActionType,
  TerrainType,
  TrackSegment,
} from '../../shared/types/GameTypes';
import { emitToGame, emitStatePatch } from '../services/socketService';
import { db } from '../db/index';
import { PlayerService } from '../services/playerService';

// Mock dependencies
jest.mock('../services/socketService', () => ({
  emitToGame: jest.fn(),
  emitStatePatch: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../db/index', () => ({
  db: {
    connect: jest.fn(),
    query: jest.fn(),
  },
}));
jest.mock('../services/playerService');
jest.mock('../services/ai/MapTopology', () => ({
  loadGridPoints: jest.fn(() => new Map()),
  getHexNeighbors: jest.fn(() => []),
  getTerrainCost: jest.fn(() => 1),
  gridToPixel: jest.fn(() => ({ x: 500, y: 600 })),
  _resetCache: jest.fn(),
}));

const mockEmitToGame = emitToGame as jest.Mock;
const mockEmitStatePatch = emitStatePatch as jest.Mock;
const mockDb = db as jest.Mocked<typeof db>;
const mockMoveTrainForUser = PlayerService.moveTrainForUser as jest.Mock;

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
      ...overrides,
    },
    allPlayerTracks: [],
    loadAvailability: {},
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
  });

  describe('BuildTrack — successful execution', () => {
    it('should UPSERT track state directly into player_tracks', async () => {
      const seg = makeSegment(3);
      const plan = makeBuildOption([seg]);
      const snapshot = makeSnapshot();

      await TurnExecutor.execute(plan, snapshot);

      const upsertCall = mockClient.query.mock.calls.find(
        (call: unknown[]) => typeof call[0] === 'string' && (call[0] as string).includes('INSERT INTO player_tracks'),
      );
      expect(upsertCall).toBeDefined();
      const params = upsertCall![1] as unknown[];
      expect(params[0]).toBe('game-1');
      expect(params[1]).toBe('bot-1');
      expect(JSON.parse(params[2] as string)).toEqual([seg]);
      expect(params[3]).toBe(3); // total_cost
      expect(params[4]).toBe(3); // turn_build_cost
    });

    it('should append to existing segments', async () => {
      const existingSeg = makeSegment(2);
      const newSeg = makeSegment(1);
      const plan = makeBuildOption([newSeg]);
      const snapshot = makeSnapshot({ existingSegments: [existingSeg] });

      await TurnExecutor.execute(plan, snapshot);

      const upsertCall = mockClient.query.mock.calls.find(
        (call: unknown[]) => typeof call[0] === 'string' && (call[0] as string).includes('INSERT INTO player_tracks'),
      );
      expect(upsertCall).toBeDefined();
      const params = upsertCall![1] as unknown[];
      expect(JSON.parse(params[2] as string)).toEqual([existingSeg, newSeg]);
      expect(params[3]).toBe(3); // total_cost (2 + 1)
    });

    it('should deduct money from bot player', async () => {
      const seg = makeSegment(5);
      const plan = makeBuildOption([seg]);
      const snapshot = makeSnapshot();

      await TurnExecutor.execute(plan, snapshot);

      const moneyCall = mockClient.query.mock.calls.find(
        (call: unknown[]) => typeof call[0] === 'string' && (call[0] as string).includes('UPDATE players SET money'),
      );
      expect(moneyCall).toBeDefined();
      expect(moneyCall![1]).toEqual([5, 'bot-1']);
    });

    it('should insert audit record post-commit via db.query', async () => {
      const seg = makeSegment(3);
      const plan = makeBuildOption([seg]);
      const snapshot = makeSnapshot();

      await TurnExecutor.execute(plan, snapshot);

      // Audit INSERT now goes through db.query (best-effort, outside transaction)
      const auditCall = (mockDb.query as jest.Mock).mock.calls.find(
        (call: unknown[]) => typeof call[0] === 'string' && (call[0] as string).includes('bot_turn_audits'),
      );
      expect(auditCall).toBeDefined();
      const params = auditCall![1] as unknown[];
      expect(params[0]).toBe('game-1');        // game_id
      expect(params[1]).toBe('bot-1');         // player_id
      expect(params[2]).toBe(3);               // turn_number
      expect(params[3]).toBe('BuildTrack');    // action
      expect(params[5]).toBe(3);               // cost
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
          gameId: 'game-1',
          playerId: 'bot-1',
        }),
      );
    });

    it('should emit state patch with updated money post-commit', async () => {
      const seg = makeSegment(2);
      const plan = makeBuildOption([seg]);

      await TurnExecutor.execute(plan, makeSnapshot());

      expect(mockEmitStatePatch).toHaveBeenCalledWith(
        'game-1',
        expect.objectContaining({
          players: expect.arrayContaining([
            expect.objectContaining({ id: 'bot-1' }),
          ]),
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

    it('should still succeed when BuildTrack audit insert fails', async () => {
      // First db.query call will be the audit INSERT — make it fail
      (mockDb.query as jest.Mock).mockRejectedValueOnce(new Error('bot_turn_audits does not exist'));
      const seg = makeSegment(2);
      const plan = makeBuildOption([seg]);

      const result = await TurnExecutor.execute(plan, makeSnapshot());

      // Track save succeeded (transaction committed) — result should still be success
      expect(result.success).toBe(true);
      expect(result.action).toBe(AIActionType.BuildTrack);
      expect(result.segmentsBuilt).toBe(1);
      // Verify the transaction still committed
      const queries = mockClient.query.mock.calls.map((c: unknown[]) => c[0]);
      expect(queries).toContain('COMMIT');
      expect(queries).not.toContain('ROLLBACK');
    });

    it('should still succeed when emitStatePatch throws post-commit', async () => {
      mockEmitStatePatch.mockRejectedValueOnce(new Error('server_seq failed'));
      const seg = makeSegment(2);
      const plan = makeBuildOption([seg]);

      const result = await TurnExecutor.execute(plan, makeSnapshot());

      // DB write succeeded — result should still be success
      expect(result.success).toBe(true);
      expect(result.action).toBe(AIActionType.BuildTrack);
      expect(result.segmentsBuilt).toBe(1);
      // track:updated should have been called before emitStatePatch threw
      expect(mockEmitToGame).toHaveBeenCalledWith(
        'game-1',
        'track:updated',
        expect.objectContaining({ gameId: 'game-1', playerId: 'bot-1' }),
      );
    });
  });

  describe('BuildTrack — failure and rollback', () => {
    it('should ROLLBACK and throw on DB failure', async () => {
      mockClient.query
        .mockResolvedValueOnce({ rows: [] })   // BEGIN
        .mockRejectedValueOnce(new Error('DB write failed')); // UPSERT fails

      const seg = makeSegment(1);
      const plan = makeBuildOption([seg]);

      await expect(TurnExecutor.execute(plan, makeSnapshot())).rejects.toThrow('DB write failed');

      const queries = mockClient.query.mock.calls.map((c: unknown[]) => c[0]);
      expect(queries).toContain('BEGIN');
      expect(queries).toContain('ROLLBACK');
      expect(queries).not.toContain('COMMIT');
    });

    it('should NOT emit socket events on failure', async () => {
      mockClient.query
        .mockResolvedValueOnce({ rows: [] })
        .mockRejectedValueOnce(new Error('fail'));

      const seg = makeSegment(1);
      const plan = makeBuildOption([seg]);

      await expect(TurnExecutor.execute(plan, makeSnapshot())).rejects.toThrow();

      expect(mockEmitToGame).not.toHaveBeenCalled();
      expect(mockEmitStatePatch).not.toHaveBeenCalled();
    });

    it('should release client even on failure', async () => {
      mockClient.query
        .mockResolvedValueOnce({ rows: [] })
        .mockRejectedValueOnce(new Error('fail'));

      const seg = makeSegment(1);
      const plan = makeBuildOption([seg]);

      await expect(TurnExecutor.execute(plan, makeSnapshot())).rejects.toThrow();

      expect(mockClient.release).toHaveBeenCalledTimes(1);
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

    it('should NOT acquire a transaction client for PassTurn', async () => {
      const plan = makePassOption();

      await TurnExecutor.execute(plan, makeSnapshot());

      expect(mockDb.connect).not.toHaveBeenCalled();
    });

    it('should NOT emit track:updated for PassTurn', async () => {
      const plan = makePassOption();

      await TurnExecutor.execute(plan, makeSnapshot());

      expect(mockEmitToGame).not.toHaveBeenCalled();
    });

    it('should return success result with zero cost', async () => {
      const plan = makePassOption();

      const result = await TurnExecutor.execute(plan, makeSnapshot());

      expect(result.success).toBe(true);
      expect(result.action).toBe(AIActionType.PassTurn);
      expect(result.cost).toBe(0);
      expect(result.segmentsBuilt).toBe(0);
    });

    it('should still succeed when audit insert fails', async () => {
      (mockDb.query as jest.Mock).mockRejectedValueOnce(new Error('bot_turn_audits does not exist'));
      const plan = makePassOption();

      const result = await TurnExecutor.execute(plan, makeSnapshot());

      // Audit failure is best-effort — result should still be success
      expect(result.success).toBe(true);
      expect(result.action).toBe(AIActionType.PassTurn);
    });
  });
});

/* ────────────────────────────────────────────────────────────────────────
 * TEST-004: TurnExecutor.handleMoveTrain
 * ──────────────────────────────────────────────────────────────────────── */

function makeMoveOption(movementPath: { row: number; col: number }[]): FeasibleOption {
  return {
    action: AIActionType.MoveTrain,
    feasible: true,
    reason: 'Move toward demand city',
    movementPath,
    targetPosition: movementPath[movementPath.length - 1],
    mileposts: movementPath.length - 1,
    estimatedCost: 0,
  };
}

function makeMoveSnapshot(overrides?: Partial<WorldSnapshot['bot']>): WorldSnapshot {
  return {
    gameId: 'game-1',
    gameStatus: 'active',
    turnNumber: 5,
    bot: {
      playerId: 'bot-1',
      userId: 'user-bot-1',
      money: 50,
      position: { row: 10, col: 10 },
      existingSegments: [],
      demandCards: [42],
      resolvedDemands: [],
      trainType: 'Freight',
      loads: [],
      botConfig: null,
      ...overrides,
    },
    allPlayerTracks: [],
    loadAvailability: {},
  };
}

const mockGetPlayers = PlayerService.getPlayers as jest.Mock;

describe('TurnExecutor — handleMoveTrain', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (mockDb.query as jest.Mock).mockResolvedValue({ rows: [] });
    mockMoveTrainForUser.mockResolvedValue({
      feeTotal: 4,
      ownersUsed: ['player-2'],
      ownersPaid: [{ playerId: 'player-2', amount: 4 }],
      affectedPlayerIds: ['bot-1', 'player-2'],
      updatedPosition: { row: 12, col: 10, x: 500, y: 600 },
      updatedMoney: 46,
    });
    mockGetPlayers.mockResolvedValue([
      { id: 'bot-1', money: 46, trainState: { position: { row: 12, col: 10, x: 500, y: 600 } } },
      { id: 'player-2', money: 96 },
    ]);
  });

  it('should call PlayerService.moveTrainForUser with correct params including pixel coords', async () => {
    const path = [
      { row: 10, col: 10 },
      { row: 11, col: 10 },
      { row: 12, col: 10 },
    ];
    const plan = makeMoveOption(path);

    await TurnExecutor.execute(plan, makeMoveSnapshot());

    expect(mockMoveTrainForUser).toHaveBeenCalledTimes(1);
    expect(mockMoveTrainForUser).toHaveBeenCalledWith({
      gameId: 'game-1',
      userId: 'user-bot-1',
      to: expect.objectContaining({ row: 12, col: 10 }),
    });
    // Verify pixel coords are passed
    const callArgs = mockMoveTrainForUser.mock.calls[0][0];
    expect(callArgs.to.x).toBeDefined();
    expect(callArgs.to.y).toBeDefined();
  });

  it('should return success result with fee as cost', async () => {
    const path = [
      { row: 10, col: 10 },
      { row: 11, col: 10 },
    ];
    const plan = makeMoveOption(path);

    const result = await TurnExecutor.execute(plan, makeMoveSnapshot());

    expect(result.success).toBe(true);
    expect(result.action).toBe(AIActionType.MoveTrain);
    expect(result.cost).toBe(4); // feeTotal from moveTrainForUser
    expect(result.remainingMoney).toBe(46); // updatedMoney from moveTrainForUser
    expect(result.segmentsBuilt).toBe(0);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('should insert audit record post-commit', async () => {
    const path = [
      { row: 10, col: 10 },
      { row: 11, col: 10 },
    ];
    const plan = makeMoveOption(path);

    await TurnExecutor.execute(plan, makeMoveSnapshot());

    const auditCall = (mockDb.query as jest.Mock).mock.calls.find(
      (call: unknown[]) => typeof call[0] === 'string' && (call[0] as string).includes('bot_turn_audits'),
    );
    expect(auditCall).toBeDefined();
    const params = auditCall![1] as unknown[];
    expect(params[0]).toBe('game-1');      // game_id
    expect(params[1]).toBe('bot-1');       // player_id
    expect(params[2]).toBe(5);            // turn_number
    expect(params[3]).toBe('MoveTrain');  // action
    expect(params[4]).toBe(4);            // cost (feeTotal)
    expect(params[5]).toBe(46);           // remaining_money
  });

  it('should handle moveTrainForUser failure gracefully', async () => {
    mockMoveTrainForUser.mockRejectedValueOnce(new Error('Player not found in game'));

    const path = [
      { row: 10, col: 10 },
      { row: 11, col: 10 },
    ];
    const plan = makeMoveOption(path);

    await expect(TurnExecutor.execute(plan, makeMoveSnapshot())).rejects.toThrow('Player not found in game');
  });

  it('should return failure for empty movement path', async () => {
    const plan: FeasibleOption = {
      action: AIActionType.MoveTrain,
      feasible: true,
      reason: 'Move',
      movementPath: [],
      mileposts: 0,
    };

    const result = await TurnExecutor.execute(plan, makeMoveSnapshot());

    expect(result.success).toBe(false);
    expect(result.error).toContain('Empty movement path');
    expect(mockMoveTrainForUser).not.toHaveBeenCalled();
  });

  it('should still succeed when audit insert fails', async () => {
    (mockDb.query as jest.Mock).mockRejectedValueOnce(new Error('audit table missing'));

    const path = [
      { row: 10, col: 10 },
      { row: 11, col: 10 },
    ];
    const plan = makeMoveOption(path);

    const result = await TurnExecutor.execute(plan, makeMoveSnapshot());

    expect(result.success).toBe(true);
    expect(result.action).toBe(AIActionType.MoveTrain);
  });

  it('should emit state patch after successful move', async () => {
    const path = [
      { row: 10, col: 10 },
      { row: 11, col: 10 },
    ];
    const plan = makeMoveOption(path);

    await TurnExecutor.execute(plan, makeMoveSnapshot());

    expect(mockEmitStatePatch).toHaveBeenCalledWith(
      'game-1',
      expect.objectContaining({
        players: expect.arrayContaining([
          expect.objectContaining({ id: 'bot-1' }),
        ]),
      }),
    );
  });
});

/* ────────────────────────────────────────────────────────────────────────
 * TEST-004: TurnExecutor.handlePickupLoad / handleDeliverLoad
 * ──────────────────────────────────────────────────────────────────────── */

import { LoadType } from '../../shared/types/LoadTypes';
import { LoadService } from '../services/loadService';

jest.mock('../services/loadService', () => ({
  LoadService: {
    getInstance: jest.fn().mockReturnValue({
      pickupDroppedLoad: jest.fn().mockResolvedValue(undefined),
    }),
  },
}));

const mockDeliverLoadForUser = PlayerService.deliverLoadForUser as jest.Mock;

function makePickupPlan(loadType: string): FeasibleOption {
  return {
    action: AIActionType.PickupLoad,
    feasible: true,
    reason: `Pick up ${loadType}`,
    loadType: loadType as LoadType,
    targetCity: 'Berlin',
  };
}

function makeDeliveryPlan(loadType: string, cardId: number): FeasibleOption {
  return {
    action: AIActionType.DeliverLoad,
    feasible: true,
    reason: `Deliver ${loadType}`,
    loadType: loadType as LoadType,
    targetCity: 'Berlin',
    cardId,
    payment: 10,
  };
}

function makePickupSnapshot2(overrides?: Partial<WorldSnapshot['bot']>): WorldSnapshot {
  return {
    gameId: 'game-1',
    gameStatus: 'active',
    turnNumber: 5,
    bot: {
      playerId: 'bot-1',
      userId: 'user-bot-1',
      money: 50,
      position: { row: 29, col: 32 },
      existingSegments: [],
      demandCards: [42],
      resolvedDemands: [
        { cardId: 42, demands: [{ city: 'Berlin', loadType: 'Coal', payment: 10 }] },
      ],
      trainType: 'Freight',
      loads: ['Coal'],
      botConfig: null,
      ...overrides,
    },
    allPlayerTracks: [],
    loadAvailability: { Berlin: ['Coal'] },
  };
}

describe('TurnExecutor — handlePickupLoad', () => {
  let mockClient2: ReturnType<typeof makeMockClient>;

  beforeEach(() => {
    jest.clearAllMocks();
    mockClient2 = makeMockClient();
    (mockDb.connect as jest.Mock).mockResolvedValue(mockClient2);
    (mockDb.query as jest.Mock).mockResolvedValue({ rows: [] });
    (PlayerService.getPlayers as jest.Mock).mockResolvedValue([
      { id: 'bot-1', money: 50, trainState: { loads: ['Coal'] } },
    ]);
  });

  it('should append load to player via array_append SQL', async () => {
    const plan = makePickupPlan('Coal');
    await TurnExecutor.execute(plan, makePickupSnapshot2({ loads: [] }));

    const appendCall = mockClient2.query.mock.calls.find(
      (call: unknown[]) => typeof call[0] === 'string' && (call[0] as string).includes('array_append'),
    );
    expect(appendCall).toBeDefined();
    expect(appendCall![1]).toEqual(['Coal', 'bot-1']);
  });

  it('should return success with zero cost', async () => {
    const plan = makePickupPlan('Iron');
    const result = await TurnExecutor.execute(plan, makePickupSnapshot2({ loads: [] }));

    expect(result.success).toBe(true);
    expect(result.action).toBe(AIActionType.PickupLoad);
    expect(result.cost).toBe(0);
    expect(result.remainingMoney).toBe(50);
  });

  it('should return failure when no loadType specified', async () => {
    const plan: FeasibleOption = {
      action: AIActionType.PickupLoad,
      feasible: true,
      reason: 'Pick up',
    };
    const result = await TurnExecutor.execute(plan, makePickupSnapshot2());

    expect(result.success).toBe(false);
    expect(result.error).toContain('No loadType');
  });

  it('should still succeed when audit insert fails', async () => {
    (mockDb.query as jest.Mock).mockRejectedValueOnce(new Error('audit table missing'));
    const plan = makePickupPlan('Coal');
    const result = await TurnExecutor.execute(plan, makePickupSnapshot2({ loads: [] }));

    expect(result.success).toBe(true);
    expect(result.action).toBe(AIActionType.PickupLoad);
  });
});

describe('TurnExecutor — handleDeliverLoad', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (mockDb.query as jest.Mock).mockResolvedValue({ rows: [] });
    (mockDeliverLoadForUser as jest.Mock).mockResolvedValue({
      payment: 10,
      newCard: { id: 99 },
      updatedMoney: 60,
    });
    (PlayerService.getPlayers as jest.Mock).mockResolvedValue([
      { id: 'bot-1', money: 60, trainState: { loads: [] } },
    ]);
  });

  it('should delegate to PlayerService.deliverLoadForUser', async () => {
    const { loadGridPoints } = require('../services/ai/MapTopology');
    (loadGridPoints as jest.Mock).mockReturnValue(new Map([
      ['29,32', { row: 29, col: 32, terrain: TerrainType.MajorCity, name: 'Berlin' }],
    ]));

    const plan = makeDeliveryPlan('Coal', 42);
    await TurnExecutor.execute(plan, makePickupSnapshot2());

    expect(mockDeliverLoadForUser).toHaveBeenCalledWith(
      'game-1', 'user-bot-1', 'Berlin', 'Coal', 42,
    );
  });

  it('should return success with payment and new card ID', async () => {
    const { loadGridPoints } = require('../services/ai/MapTopology');
    (loadGridPoints as jest.Mock).mockReturnValue(new Map([
      ['29,32', { row: 29, col: 32, terrain: TerrainType.MajorCity, name: 'Berlin' }],
    ]));

    const plan = makeDeliveryPlan('Coal', 42);
    const result = await TurnExecutor.execute(plan, makePickupSnapshot2());

    expect(result.success).toBe(true);
    expect(result.action).toBe(AIActionType.DeliverLoad);
    expect(result.payment).toBe(10);
    expect(result.newCardId).toBe(99);
    expect(result.remainingMoney).toBe(60);
  });

  it('should return failure when loadType or cardId missing', async () => {
    const plan: FeasibleOption = {
      action: AIActionType.DeliverLoad,
      feasible: true,
      reason: 'Deliver',
    };
    const result = await TurnExecutor.execute(plan, makePickupSnapshot2());

    expect(result.success).toBe(false);
    expect(result.error).toContain('requires loadType and cardId');
  });

  it('should return failure when bot is not at a named city', async () => {
    const { loadGridPoints } = require('../services/ai/MapTopology');
    (loadGridPoints as jest.Mock).mockReturnValue(new Map()); // empty grid = no city

    const plan = makeDeliveryPlan('Coal', 42);
    const result = await TurnExecutor.execute(plan, makePickupSnapshot2());

    expect(result.success).toBe(false);
    expect(result.error).toContain('not at a named city');
  });
});
