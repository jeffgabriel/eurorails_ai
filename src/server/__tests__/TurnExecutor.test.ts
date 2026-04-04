import { TurnExecutor } from '../services/ai/TurnExecutor';
import {
  FeasibleOption,
  WorldSnapshot,
  AIActionType,
  TerrainType,
  TrackSegment,
  TrainType,
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
jest.mock('../../shared/services/majorCityGroups', () => ({
  getMajorCityGroups: jest.fn(() => []),
  getMajorCityLookup: jest.fn(() => new Map()),
  getFerryEdges: jest.fn(() => []),
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
      connectedMajorCityCount: 0,
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

describe('TurnExecutor', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (mockDb.query as jest.Mock).mockResolvedValue({ rows: [] });
  });

  describe('TurnExecutor — handleBuildTrack', () => {
    const mockBuildTrackForPlayer = PlayerService.buildTrackForPlayer as jest.Mock;

    beforeEach(() => {
      jest.clearAllMocks();
      (mockDb.query as jest.Mock).mockResolvedValue({ rows: [] });
      mockBuildTrackForPlayer.mockResolvedValue({ remainingMoney: 47 });
      mockEmitStatePatch.mockResolvedValue(undefined);
    });

    it('should call PlayerService.buildTrackForPlayer with correct params', async () => {
      const seg = makeSegment(3);
      const plan = makeBuildOption([seg]);
      const existingSeg = makeSegment(2);
      const snapshot = makeSnapshot({ existingSegments: [existingSeg] });

      await TurnExecutor.execute(plan, snapshot);

      expect(mockBuildTrackForPlayer).toHaveBeenCalledTimes(1);
      expect(mockBuildTrackForPlayer).toHaveBeenCalledWith(
        'game-1',
        'bot-1',
        [seg],
        [existingSeg],
        3,
      );
    });

    it('should return success result with correct fields', async () => {
      const seg = makeSegment(4);
      const plan = makeBuildOption([seg]);
      mockBuildTrackForPlayer.mockResolvedValue({ remainingMoney: 46 });

      const result = await TurnExecutor.execute(plan, makeSnapshot());

      expect(result.success).toBe(true);
      expect(result.action).toBe(AIActionType.BuildTrack);
      expect(result.cost).toBe(4);
      expect(result.segmentsBuilt).toBe(1);
      expect(result.remainingMoney).toBe(46);
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
    });

    it('should insert audit record (best-effort)', async () => {
      const seg = makeSegment(3);
      const plan = makeBuildOption([seg]);

      await TurnExecutor.execute(plan, makeSnapshot());

      const auditCall = (mockDb.query as jest.Mock).mock.calls.find(
        (call: unknown[]) => typeof call[0] === 'string' && (call[0] as string).includes('bot_turn_audits'),
      );
      expect(auditCall).toBeDefined();
      const params = auditCall![1] as unknown[];
      expect(params[0]).toBe('game-1');
      expect(params[1]).toBe('bot-1');
      expect(params[2]).toBe(3);
      expect(params[3]).toBe('BuildTrack');
      expect(params[5]).toBe(3);
    });

    it('should still succeed when audit insert fails', async () => {
      (mockDb.query as jest.Mock).mockRejectedValueOnce(new Error('bot_turn_audits does not exist'));
      const seg = makeSegment(2);
      const plan = makeBuildOption([seg]);

      const result = await TurnExecutor.execute(plan, makeSnapshot());

      expect(result.success).toBe(true);
      expect(result.action).toBe(AIActionType.BuildTrack);
      expect(result.segmentsBuilt).toBe(1);
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

    it('should still succeed when emitStatePatch throws post-commit', async () => {
      mockEmitStatePatch.mockRejectedValueOnce(new Error('server_seq failed'));
      const seg = makeSegment(2);
      const plan = makeBuildOption([seg]);

      const result = await TurnExecutor.execute(plan, makeSnapshot());

      expect(result.success).toBe(true);
      expect(result.action).toBe(AIActionType.BuildTrack);
      expect(result.segmentsBuilt).toBe(1);
      expect(mockEmitToGame).toHaveBeenCalledWith(
        'game-1',
        'track:updated',
        expect.objectContaining({ gameId: 'game-1', playerId: 'bot-1' }),
      );
    });

    it('should throw when PlayerService.buildTrackForPlayer throws', async () => {
      mockBuildTrackForPlayer.mockRejectedValueOnce(new Error('Insufficient funds'));
      const seg = makeSegment(1);
      const plan = makeBuildOption([seg]);

      await expect(TurnExecutor.execute(plan, makeSnapshot())).rejects.toThrow('Insufficient funds');

      expect(mockEmitToGame).not.toHaveBeenCalled();
      expect(mockEmitStatePatch).not.toHaveBeenCalled();
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
      connectedMajorCityCount: 0,
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
      getSourceCitiesForLoad: jest.fn().mockReturnValue(['Essen']),
    }),
  },
}));

jest.mock('../services/demandDeckService', () => ({
  DemandDeckService: {
    getInstance: jest.fn().mockReturnValue({
      getCard: jest.fn().mockReturnValue({
        id: 99,
        demands: [
          { city: 'Paris', resource: 'Wine', payment: 20 },
          { city: 'Madrid', resource: 'Iron', payment: 15 },
          { city: 'Wien', resource: 'Oil', payment: 12 },
        ],
      }),
      drawCard: jest.fn(),
      discardCard: jest.fn(),
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
      connectedMajorCityCount: 0,
      ...overrides,
    },
    allPlayerTracks: [],
    loadAvailability: { Berlin: ['Coal'] },
  };
}

describe('TurnExecutor — handlePickupLoad', () => {
  const mockPickupLoadForPlayer = PlayerService.pickupLoadForPlayer as jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    (mockDb.query as jest.Mock).mockResolvedValue({ rows: [] });
    mockPickupLoadForPlayer.mockResolvedValue({ updatedLoads: ['Coal'] });
    (PlayerService.getPlayers as jest.Mock).mockResolvedValue([
      { id: 'bot-1', money: 50, trainState: { loads: ['Coal'] } },
    ]);
    mockEmitStatePatch.mockResolvedValue(undefined);
  });

  it('should call PlayerService.pickupLoadForPlayer with correct params', async () => {
    const plan = makePickupPlan('Coal');
    await TurnExecutor.execute(plan, makePickupSnapshot2({ loads: [] }));

    expect(mockPickupLoadForPlayer).toHaveBeenCalledTimes(1);
    expect(mockPickupLoadForPlayer).toHaveBeenCalledWith(
      'game-1',
      'bot-1',
      'Coal',
      expect.any(String), // cityName resolved from position
    );
  });

  it('should return success with zero cost', async () => {
    const plan = makePickupPlan('Iron');
    mockPickupLoadForPlayer.mockResolvedValue({ updatedLoads: ['Iron'] });
    const result = await TurnExecutor.execute(plan, makePickupSnapshot2({ loads: [] }));

    expect(result.success).toBe(true);
    expect(result.action).toBe(AIActionType.PickupLoad);
    expect(result.cost).toBe(0);
    expect(result.remainingMoney).toBe(50);
  });

  it('should update snapshot.bot.loads after pickup', async () => {
    mockPickupLoadForPlayer.mockResolvedValue({ updatedLoads: ['Coal', 'Iron'] });
    const plan = makePickupPlan('Iron');
    const snapshot = makePickupSnapshot2({ loads: ['Coal'] });

    await TurnExecutor.execute(plan, snapshot);

    expect(snapshot.bot.loads).toEqual(['Coal', 'Iron']);
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
    expect(mockPickupLoadForPlayer).not.toHaveBeenCalled();
  });

  it('should still succeed when audit insert fails', async () => {
    (mockDb.query as jest.Mock).mockRejectedValueOnce(new Error('audit table missing'));
    const plan = makePickupPlan('Coal');
    const result = await TurnExecutor.execute(plan, makePickupSnapshot2({ loads: [] }));

    expect(result.success).toBe(true);
    expect(result.action).toBe(AIActionType.PickupLoad);
  });

  it('should insert pickup action into turn_actions table', async () => {
    const { loadGridPoints } = require('../services/ai/MapTopology');
    (loadGridPoints as jest.Mock).mockReturnValue(new Map([
      ['29,32', { row: 29, col: 32, terrain: TerrainType.MajorCity, name: 'Berlin' }],
    ]));

    const plan = makePickupPlan('Coal');
    await TurnExecutor.execute(plan, makePickupSnapshot2({ loads: [] }));

    const turnActionCall = (mockDb.query as jest.Mock).mock.calls.find(
      (call: unknown[]) => typeof call[0] === 'string' && (call[0] as string).includes('turn_actions'),
    );
    expect(turnActionCall).toBeDefined();
    const params = turnActionCall![1] as unknown[];
    expect(params[0]).toBe('bot-1');   // player_id
    expect(params[1]).toBe('game-1');  // game_id
    expect(params[2]).toBe(5);         // turn_number
    const actions = JSON.parse(params[3] as string);
    expect(actions).toEqual([{ kind: 'pickup', city: 'Berlin', loadType: 'Coal' }]);
  });

  it('should still succeed when turn_actions insert fails', async () => {
    const { loadGridPoints } = require('../services/ai/MapTopology');
    (loadGridPoints as jest.Mock).mockReturnValue(new Map([
      ['29,32', { row: 29, col: 32, terrain: TerrainType.MajorCity, name: 'Berlin' }],
    ]));

    // First db.query call = bot_turn_audits (succeeds), second = turn_actions (fails)
    (mockDb.query as jest.Mock)
      .mockResolvedValueOnce({ rows: [] })   // bot_turn_audits
      .mockRejectedValueOnce(new Error('turn_actions insert failed'));  // turn_actions

    const plan = makePickupPlan('Coal');
    const result = await TurnExecutor.execute(plan, makePickupSnapshot2({ loads: [] }));

    expect(result.success).toBe(true);
    expect(result.action).toBe(AIActionType.PickupLoad);
  });

  it('should throw when PlayerService.pickupLoadForPlayer throws', async () => {
    mockPickupLoadForPlayer.mockRejectedValueOnce(new Error('Train at full capacity'));
    const plan = makePickupPlan('Coal');

    await expect(TurnExecutor.execute(plan, makePickupSnapshot2({ loads: [] }))).rejects.toThrow('Train at full capacity');
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
      {
        id: 'bot-1', money: 60, trainState: { loads: [] },
        hand: [
          { id: 99, demands: [{ city: 'Paris', resource: 'Wine', payment: 12 }] },
          { id: 50, demands: [{ city: 'Madrid', resource: 'Oil', payment: 8 }] },
          { id: 51, demands: [{ city: 'Rome', resource: 'Steel', payment: 15 }] },
        ],
      },
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

  it('should emit bot:demandRankingUpdate with refreshed demand ranking after delivery (FE-001)', async () => {
    const { loadGridPoints } = require('../services/ai/MapTopology');
    (loadGridPoints as jest.Mock).mockReturnValue(new Map([
      ['29,32', { row: 29, col: 32, terrain: TerrainType.MajorCity, name: 'Berlin' }],
    ]));

    const plan = makeDeliveryPlan('Coal', 42);
    await TurnExecutor.execute(plan, makePickupSnapshot2());

    // Find the bot:demandRankingUpdate call
    const rankingCall = mockEmitToGame.mock.calls.find(
      (call: unknown[]) => call[1] === 'bot:demandRankingUpdate',
    );
    expect(rankingCall).toBeDefined();
    expect(rankingCall![0]).toBe('game-1');
    const payload = rankingCall![2] as any;
    expect(payload.botPlayerId).toBe('bot-1');
    expect(payload.demandRanking).toBeDefined();
    expect(payload.demandRanking.length).toBeGreaterThan(0);
    // Ranking should be sorted by score descending and have rank numbers
    const ranks = payload.demandRanking.map((d: any) => d.rank);
    expect(ranks).toEqual(ranks.map((_: number, i: number) => i + 1));
    // Each entry should have required fields
    for (const entry of payload.demandRanking) {
      expect(entry).toHaveProperty('loadType');
      expect(entry).toHaveProperty('supplyCity');
      expect(entry).toHaveProperty('deliveryCity');
      expect(entry).toHaveProperty('payout');
      expect(entry).toHaveProperty('score');
      expect(entry).toHaveProperty('rank');
    }
  });

  it('should still succeed when demand ranking emit fails (FE-001)', async () => {
    const { loadGridPoints } = require('../services/ai/MapTopology');
    (loadGridPoints as jest.Mock).mockReturnValue(new Map([
      ['29,32', { row: 29, col: 32, terrain: TerrainType.MajorCity, name: 'Berlin' }],
    ]));

    // Make emitToGame throw for the ranking event
    mockEmitToGame.mockImplementation((_gameId: string, event: string) => {
      if (event === 'bot:demandRankingUpdate') throw new Error('emit failed');
    });

    const plan = makeDeliveryPlan('Coal', 42);
    const result = await TurnExecutor.execute(plan, makePickupSnapshot2());

    // Delivery should still succeed despite ranking emit failure
    expect(result.success).toBe(true);
    expect(result.payment).toBe(10);
    expect(result.newCardId).toBe(99);
  });
});

describe('JIRA-83: MultiAction DELIVER/DROP skip at unnamed milepost', () => {
  it('should skip DELIVER step when bot is not at a named city and continue remaining steps', async () => {
    const { loadGridPoints } = require('../services/ai/MapTopology');
    // Empty grid = no city at bot position
    (loadGridPoints as jest.Mock).mockReturnValue(new Map());

    // Mock PlayerService for build step
    (PlayerService.buildTrackForPlayer as jest.Mock).mockResolvedValue({ remainingMoney: 49 });
    (mockDb.query as jest.Mock).mockResolvedValue({ rows: [] });
    mockEmitStatePatch.mockResolvedValue(undefined);

    const snapshot = makeSnapshot({ position: { row: 5, col: 5 }, money: 50 });

    const multiPlan = {
      type: 'MultiAction' as const,
      steps: [
        {
          type: AIActionType.DeliverLoad,
          load: 'Steel',
          city: 'Berlin',
          cardId: 1,
          payout: 19,
        },
        {
          type: AIActionType.BuildTrack,
          segments: [makeSegment(1)],
          targetCity: 'Berlin',
        },
      ],
    };

    const result = await TurnExecutor.executePlan(multiPlan as any, snapshot);

    // Should succeed — DELIVER skipped, BUILD executed
    expect(result.success).toBe(true);
    expect(result.segmentsBuilt).toBe(1);
  });

  it('should skip DROP step when bot is not at a named city', async () => {
    const { loadGridPoints } = require('../services/ai/MapTopology');
    (loadGridPoints as jest.Mock).mockReturnValue(new Map());

    // Mock PlayerService for build step
    (PlayerService.buildTrackForPlayer as jest.Mock).mockResolvedValue({ remainingMoney: 49 });
    (mockDb.query as jest.Mock).mockResolvedValue({ rows: [] });
    mockEmitStatePatch.mockResolvedValue(undefined);

    const snapshot = makeSnapshot({ position: { row: 5, col: 5 }, money: 50 });

    const multiPlan = {
      type: 'MultiAction' as const,
      steps: [
        {
          type: AIActionType.DropLoad,
          load: 'Steel',
          city: 'Berlin',
        },
        {
          type: AIActionType.BuildTrack,
          segments: [makeSegment(1)],
          targetCity: 'Berlin',
        },
      ],
    };

    const result = await TurnExecutor.executePlan(multiPlan as any, snapshot);

    // Should succeed — DROP skipped, BUILD executed
    expect(result.success).toBe(true);
    expect(result.segmentsBuilt).toBe(1);
  });

  it('should execute DELIVER normally when bot IS at a named city', async () => {
    const { loadGridPoints } = require('../services/ai/MapTopology');
    (loadGridPoints as jest.Mock).mockReturnValue(new Map([
      ['29,32', { row: 29, col: 32, name: 'Berlin', terrain: 2 }],
    ]));

    (PlayerService.deliverLoadForUser as jest.Mock).mockResolvedValue({
      payment: 19,
      updatedMoney: 69,
      newCard: { id: 50, demands: [] },
    });
    mockEmitStatePatch.mockResolvedValue(undefined);
    mockEmitToGame.mockImplementation(() => {});

    const snapshot = makeSnapshot({
      position: { row: 29, col: 32 },
      money: 50,
      loads: ['Steel'],
      demandCards: [1],
    });

    const multiPlan = {
      type: 'MultiAction' as const,
      steps: [
        {
          type: AIActionType.DeliverLoad,
          load: 'Steel',
          city: 'Berlin',
          cardId: 1,
          payout: 19,
        },
      ],
    };

    const result = await TurnExecutor.executePlan(multiPlan as any, snapshot);

    expect(result.success).toBe(true);
    expect(result.payment).toBe(19);
  });
});

describe('TurnExecutor — handleUpgradeTrain', () => {
  const mockPurchaseTrainType = PlayerService.purchaseTrainType as jest.Mock;
  const mockGetPlayers = PlayerService.getPlayers as jest.Mock;

  function makeUpgradeOption(targetTrainType: TrainType, upgradeKind: 'upgrade' | 'crossgrade'): FeasibleOption {
    return {
      action: AIActionType.UpgradeTrain,
      feasible: true,
      reason: 'Upgrade',
      targetTrainType,
      upgradeKind,
      estimatedCost: upgradeKind === 'upgrade' ? 20 : 5,
    };
  }

  beforeEach(() => {
    jest.clearAllMocks();
    (mockDb.query as jest.Mock).mockResolvedValue({ rows: [] });
    mockPurchaseTrainType.mockResolvedValue({
      id: 'bot-1',
      money: 30,
      trainType: TrainType.FastFreight,
    });
    mockGetPlayers.mockResolvedValue([
      { id: 'bot-1', money: 30, trainType: TrainType.FastFreight },
    ]);
    mockEmitStatePatch.mockResolvedValue(undefined);
  });

  it('should call PlayerService.purchaseTrainType with correct params', async () => {
    const plan = makeUpgradeOption(TrainType.FastFreight, 'upgrade');
    const snapshot = makeSnapshot({ trainType: TrainType.Freight, money: 50 });

    await TurnExecutor.execute(plan, snapshot);

    expect(mockPurchaseTrainType).toHaveBeenCalledTimes(1);
    expect(mockPurchaseTrainType).toHaveBeenCalledWith(
      'game-1',
      'user-bot-1',
      'upgrade',
      TrainType.FastFreight,
    );
  });

  it('should return success result with cost 20 for upgrade', async () => {
    const plan = makeUpgradeOption(TrainType.FastFreight, 'upgrade');
    const snapshot = makeSnapshot({ trainType: TrainType.Freight, money: 50 });

    const result = await TurnExecutor.execute(plan, snapshot);

    expect(result.success).toBe(true);
    expect(result.action).toBe(AIActionType.UpgradeTrain);
    expect(result.cost).toBe(20);
    expect(result.remainingMoney).toBe(30); // from purchaseTrainType return value
    expect(result.segmentsBuilt).toBe(0);
  });

  it('should return success result with cost 5 for crossgrade', async () => {
    mockPurchaseTrainType.mockResolvedValue({
      id: 'bot-1',
      money: 45,
      trainType: TrainType.HeavyFreight,
    });
    const plan = makeUpgradeOption(TrainType.HeavyFreight, 'crossgrade');
    const snapshot = makeSnapshot({ trainType: TrainType.FastFreight, money: 50 });

    const result = await TurnExecutor.execute(plan, snapshot);

    expect(result.success).toBe(true);
    expect(result.cost).toBe(5);
    expect(result.remainingMoney).toBe(45);
  });

  it('should update snapshot.bot.trainType after upgrade', async () => {
    const plan = makeUpgradeOption(TrainType.FastFreight, 'upgrade');
    const snapshot = makeSnapshot({ trainType: TrainType.Freight, money: 50 });

    await TurnExecutor.execute(plan, snapshot);

    expect(snapshot.bot.trainType).toBe(TrainType.FastFreight);
  });

  it('should insert audit record (best-effort)', async () => {
    const plan = makeUpgradeOption(TrainType.FastFreight, 'upgrade');
    const snapshot = makeSnapshot({ trainType: TrainType.Freight, money: 50 });

    await TurnExecutor.execute(plan, snapshot);

    const auditCall = (mockDb.query as jest.Mock).mock.calls.find(
      (call: unknown[]) => typeof call[0] === 'string' && (call[0] as string).includes('bot_turn_audits'),
    );
    expect(auditCall).toBeDefined();
    const params = auditCall![1] as unknown[];
    expect(params[0]).toBe('game-1');      // game_id
    expect(params[1]).toBe('bot-1');       // player_id
    expect(params[2]).toBe(3);             // turn_number
    expect(params[3]).toBe(AIActionType.UpgradeTrain); // action
    expect(params[4]).toBe(20);            // cost
    expect(params[5]).toBe(30);            // remaining_money
  });

  it('should still succeed when audit insert fails', async () => {
    (mockDb.query as jest.Mock).mockRejectedValueOnce(new Error('bot_turn_audits does not exist'));
    const plan = makeUpgradeOption(TrainType.FastFreight, 'upgrade');
    const snapshot = makeSnapshot({ trainType: TrainType.Freight, money: 50 });

    const result = await TurnExecutor.execute(plan, snapshot);

    expect(result.success).toBe(true);
    expect(result.action).toBe(AIActionType.UpgradeTrain);
  });

  it('should emit state patch with updated player data (best-effort)', async () => {
    const updatedPlayer = { id: 'bot-1', money: 30, trainType: TrainType.FastFreight };
    mockPurchaseTrainType.mockResolvedValue(updatedPlayer);
    const plan = makeUpgradeOption(TrainType.FastFreight, 'upgrade');
    const snapshot = makeSnapshot({ trainType: TrainType.Freight, money: 50 });

    await TurnExecutor.execute(plan, snapshot);

    expect(mockEmitStatePatch).toHaveBeenCalledWith(
      'game-1',
      expect.objectContaining({ players: [updatedPlayer] }),
    );
  });

  it('should still succeed when socket emit fails', async () => {
    mockEmitStatePatch.mockRejectedValueOnce(new Error('socket error'));
    const plan = makeUpgradeOption(TrainType.FastFreight, 'upgrade');
    const snapshot = makeSnapshot({ trainType: TrainType.Freight, money: 50 });

    const result = await TurnExecutor.execute(plan, snapshot);

    expect(result.success).toBe(true);
  });

  it('should return failure when targetTrainType is missing', async () => {
    const plan: FeasibleOption = {
      action: AIActionType.UpgradeTrain,
      feasible: true,
      reason: 'Upgrade',
    };
    const snapshot = makeSnapshot({ trainType: TrainType.Freight, money: 50 });

    const result = await TurnExecutor.execute(plan, snapshot);

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/targetTrainType/);
    expect(mockPurchaseTrainType).not.toHaveBeenCalled();
  });

  it('should throw when PlayerService.purchaseTrainType throws', async () => {
    mockPurchaseTrainType.mockRejectedValueOnce(new Error('Not your turn'));
    const plan = makeUpgradeOption(TrainType.FastFreight, 'upgrade');
    const snapshot = makeSnapshot({ trainType: TrainType.Freight, money: 50 });

    await expect(TurnExecutor.execute(plan, snapshot)).rejects.toThrow('Not your turn');
  });
});

describe('TurnExecutor — handleDropLoad', () => {
  const mockDropLoadForPlayer = PlayerService.dropLoadForPlayer as jest.Mock;

  function makeDropOption(loadType: string): FeasibleOption {
    return {
      action: AIActionType.DropLoad,
      feasible: true,
      reason: `Drop ${loadType}`,
      loadType: loadType as LoadType,
      targetCity: 'Berlin',
    };
  }

  beforeEach(() => {
    jest.clearAllMocks();
    (mockDb.query as jest.Mock).mockResolvedValue({ rows: [] });
    mockDropLoadForPlayer.mockResolvedValue(undefined);
    (PlayerService.getPlayers as jest.Mock).mockResolvedValue([
      { id: 'bot-1', money: 50, loads: [] },
    ]);
    mockEmitStatePatch.mockResolvedValue(undefined);
  });

  it('should call PlayerService.dropLoadForPlayer with correct params', async () => {
    const { loadGridPoints } = require('../services/ai/MapTopology');
    (loadGridPoints as jest.Mock).mockReturnValue(new Map([
      ['29,32', { row: 29, col: 32, terrain: TerrainType.MajorCity, name: 'Berlin' }],
    ]));

    const plan = makeDropOption('Coal');
    const snapshot = makeSnapshot({ position: { row: 29, col: 32 }, loads: ['Coal'] });

    await TurnExecutor.execute(plan, snapshot);

    expect(mockDropLoadForPlayer).toHaveBeenCalledTimes(1);
    expect(mockDropLoadForPlayer).toHaveBeenCalledWith(
      'game-1',
      'bot-1',
      'Coal',
      'Berlin',
    );
  });

  it('should return success with zero cost', async () => {
    const { loadGridPoints } = require('../services/ai/MapTopology');
    (loadGridPoints as jest.Mock).mockReturnValue(new Map([
      ['29,32', { row: 29, col: 32, terrain: TerrainType.MajorCity, name: 'Berlin' }],
    ]));

    const plan = makeDropOption('Coal');
    const result = await TurnExecutor.execute(plan, makeSnapshot({ position: { row: 29, col: 32 }, loads: ['Coal'] }));

    expect(result.success).toBe(true);
    expect(result.action).toBe(AIActionType.DropLoad);
    expect(result.cost).toBe(0);
    expect(result.remainingMoney).toBe(50);
  });

  it('should update snapshot.bot.loads after drop', async () => {
    const { loadGridPoints } = require('../services/ai/MapTopology');
    (loadGridPoints as jest.Mock).mockReturnValue(new Map([
      ['29,32', { row: 29, col: 32, terrain: TerrainType.MajorCity, name: 'Berlin' }],
    ]));

    const plan = makeDropOption('Coal');
    const snapshot = makeSnapshot({ position: { row: 29, col: 32 }, loads: ['Coal', 'Iron'] });

    await TurnExecutor.execute(plan, snapshot);

    expect(snapshot.bot.loads).toEqual(['Iron']);
  });

  it('should return failure when no loadType specified', async () => {
    const plan: FeasibleOption = {
      action: AIActionType.DropLoad,
      feasible: true,
      reason: 'Drop',
    };
    const result = await TurnExecutor.execute(plan, makeSnapshot());

    expect(result.success).toBe(false);
    expect(result.error).toContain('No loadType');
    expect(mockDropLoadForPlayer).not.toHaveBeenCalled();
  });

  it('should return failure when bot is not at a named city', async () => {
    // Position not in grid points — returns empty city name
    const { loadGridPoints } = require('../services/ai/MapTopology');
    (loadGridPoints as jest.Mock).mockReturnValue(new Map());

    const plan = makeDropOption('Coal');
    const result = await TurnExecutor.execute(plan, makeSnapshot({ position: { row: 99, col: 99 }, loads: ['Coal'] }));

    expect(result.success).toBe(false);
    expect(result.error).toContain('named city');
    expect(mockDropLoadForPlayer).not.toHaveBeenCalled();
  });

  it('should insert audit record (best-effort)', async () => {
    const { loadGridPoints } = require('../services/ai/MapTopology');
    (loadGridPoints as jest.Mock).mockReturnValue(new Map([
      ['29,32', { row: 29, col: 32, terrain: TerrainType.MajorCity, name: 'Berlin' }],
    ]));

    const plan = makeDropOption('Coal');
    await TurnExecutor.execute(plan, makeSnapshot({ position: { row: 29, col: 32 }, loads: ['Coal'] }));

    const auditCall = (mockDb.query as jest.Mock).mock.calls.find(
      (call: unknown[]) => typeof call[0] === 'string' && (call[0] as string).includes('bot_turn_audits'),
    );
    expect(auditCall).toBeDefined();
    const params = auditCall![1] as unknown[];
    expect(params[3]).toBe(AIActionType.DropLoad);
  });

  it('should still succeed when audit insert fails', async () => {
    const { loadGridPoints } = require('../services/ai/MapTopology');
    (loadGridPoints as jest.Mock).mockReturnValue(new Map([
      ['29,32', { row: 29, col: 32, terrain: TerrainType.MajorCity, name: 'Berlin' }],
    ]));
    (mockDb.query as jest.Mock).mockRejectedValueOnce(new Error('audit table missing'));

    const plan = makeDropOption('Coal');
    const result = await TurnExecutor.execute(plan, makeSnapshot({ position: { row: 29, col: 32 }, loads: ['Coal'] }));

    expect(result.success).toBe(true);
  });

  it('should throw when PlayerService.dropLoadForPlayer throws', async () => {
    const { loadGridPoints } = require('../services/ai/MapTopology');
    (loadGridPoints as jest.Mock).mockReturnValue(new Map([
      ['29,32', { row: 29, col: 32, terrain: TerrainType.MajorCity, name: 'Berlin' }],
    ]));
    mockDropLoadForPlayer.mockRejectedValueOnce(new Error('Player is not carrying load'));

    const plan = makeDropOption('Coal');
    await expect(TurnExecutor.execute(plan, makeSnapshot({ position: { row: 29, col: 32 }, loads: ['Coal'] }))).rejects.toThrow('Player is not carrying load');
  });
});

describe('TurnExecutor — handleDiscardHand', () => {
  const mockDiscardHandForPlayer = PlayerService.discardHandForPlayer as jest.Mock;

  function makeDiscardOption(): FeasibleOption {
    return {
      action: AIActionType.DiscardHand,
      feasible: true,
      reason: 'Discard hand',
    };
  }

  beforeEach(() => {
    jest.clearAllMocks();
    (mockDb.query as jest.Mock).mockResolvedValue({ rows: [] });
    mockDiscardHandForPlayer.mockResolvedValue({ newHandIds: [10, 20, 30] });
    (PlayerService.getPlayers as jest.Mock).mockResolvedValue([
      { id: 'bot-1', money: 50, hand: [10, 20, 30] },
    ]);
    mockEmitStatePatch.mockResolvedValue(undefined);
  });

  it('should call PlayerService.discardHandForPlayer with correct params', async () => {
    const plan = makeDiscardOption();
    await TurnExecutor.execute(plan, makeSnapshot({ demandCards: [1, 2, 3] }));

    expect(mockDiscardHandForPlayer).toHaveBeenCalledTimes(1);
    expect(mockDiscardHandForPlayer).toHaveBeenCalledWith('game-1', 'bot-1');
  });

  it('should return success with zero cost', async () => {
    const plan = makeDiscardOption();
    const result = await TurnExecutor.execute(plan, makeSnapshot({ demandCards: [1, 2, 3] }));

    expect(result.success).toBe(true);
    expect(result.action).toBe(AIActionType.DiscardHand);
    expect(result.cost).toBe(0);
    expect(result.remainingMoney).toBe(50);
  });

  it('should update snapshot.bot.demandCards after discard', async () => {
    const plan = makeDiscardOption();
    const snapshot = makeSnapshot({ demandCards: [1, 2, 3] });
    await TurnExecutor.execute(plan, snapshot);

    expect(snapshot.bot.demandCards).toEqual([10, 20, 30]);
  });

  it('should insert audit record (best-effort)', async () => {
    const plan = makeDiscardOption();
    await TurnExecutor.execute(plan, makeSnapshot({ demandCards: [1, 2, 3] }));

    const auditCall = (mockDb.query as jest.Mock).mock.calls.find(
      (call: unknown[]) => typeof call[0] === 'string' && (call[0] as string).includes('bot_turn_audits'),
    );
    expect(auditCall).toBeDefined();
    const params = auditCall![1] as unknown[];
    expect(params[3]).toBe(AIActionType.DiscardHand);
  });

  it('should still succeed when audit insert fails', async () => {
    (mockDb.query as jest.Mock).mockRejectedValueOnce(new Error('audit table missing'));

    const plan = makeDiscardOption();
    const result = await TurnExecutor.execute(plan, makeSnapshot({ demandCards: [1, 2, 3] }));

    expect(result.success).toBe(true);
  });

  it('should emit state patch with updated player data (best-effort)', async () => {
    const plan = makeDiscardOption();
    await TurnExecutor.execute(plan, makeSnapshot({ demandCards: [1, 2, 3] }));

    expect(mockEmitStatePatch).toHaveBeenCalledWith(
      'game-1',
      expect.objectContaining({
        players: expect.arrayContaining([
          expect.objectContaining({ id: 'bot-1' }),
        ]),
      }),
    );
  });

  it('should still succeed when socket emit fails', async () => {
    mockEmitStatePatch.mockRejectedValueOnce(new Error('emit failed'));

    const plan = makeDiscardOption();
    const result = await TurnExecutor.execute(plan, makeSnapshot({ demandCards: [1, 2, 3] }));

    expect(result.success).toBe(true);
  });

  it('should throw when PlayerService.discardHandForPlayer throws', async () => {
    mockDiscardHandForPlayer.mockRejectedValueOnce(new Error('No cards in deck'));

    const plan = makeDiscardOption();
    await expect(TurnExecutor.execute(plan, makeSnapshot({ demandCards: [1, 2, 3] }))).rejects.toThrow('No cards in deck');
  });
});
