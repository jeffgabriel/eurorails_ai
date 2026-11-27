/**
 * #313: ActionResolver.resolveMove under active event effects.
 *
 * The server refuses a move that breaks an event's movement rule (Snow half
 * rate and blocked mileposts, Rail Strike). The bot chooses its own route, so
 * resolveMove must stop the route where the server would refuse to go on;
 * otherwise the bot's move is rejected and the rest of its turn is lost.
 */

import { ActionResolver } from '../../services/ai/ActionResolver';
import {
  GameContext,
  LLMActionIntent,
  WorldSnapshot,
  TrainType,
  TerrainType,
  TrackSegment,
  TurnPlanMoveTrain,
} from '../../../shared/types/GameTypes';
import { ActiveEffect, EventCardType, MovementRestriction } from '../../../shared/types/EventCard';
import type { TrackUsageComputation, PathEdge } from '../../../shared/services/trackUsageFees';

// ─── Mock modules ─────────────────────────────────────────────────────────────

jest.mock('../../services/ai/computeBuildSegments', () => ({
  computeBuildSegments: jest.fn(() => []),
}));
jest.mock('../../../shared/services/trackUsageFees', () => {
  const actual = jest.requireActual('../../../shared/services/trackUsageFees');
  return { ...actual, computeTrackUsageForMove: jest.fn() };
});
jest.mock('../../services/MapTopology');
jest.mock('../../../shared/services/majorCityGroups', () => {
  const actual = jest.requireActual('../../../shared/services/majorCityGroups');
  return {
    ...actual,
    getMajorCityGroups: jest.fn().mockReturnValue([]),
    getMajorCityLookup: jest.fn().mockReturnValue(new Map()),
    getFerryEdges: jest.fn().mockReturnValue([]),
  };
});

import { computeTrackUsageForMove } from '../../../shared/services/trackUsageFees';
import { loadGridPoints } from '../../services/MapTopology';
import { getMajorCityGroups, getMajorCityLookup, getFerryEdges } from '../../../shared/services/majorCityGroups';

const mockComputeTrackUsageForMove = computeTrackUsageForMove as jest.MockedFunction<typeof computeTrackUsageForMove>;
const mockLoadGridPoints = loadGridPoints as jest.MockedFunction<typeof loadGridPoints>;

// ─── Geometry ─────────────────────────────────────────────────────────────────

const BOT = 'bot-player';
const OPPONENT = 'opponent-player';
const ROW = 10;
const at = (col: number): { row: number; col: number } => ({ row: ROW, col });
const key = (col: number): string => `${ROW},${col}`;
/** The target: milepost 12, twelve edges from the bot's start at milepost 0. */
const TARGET = at(12);

function makeSegment(fromCol: number, toCol: number): TrackSegment {
  return {
    from: { x: 0, y: 0, row: ROW, col: fromCol, terrain: TerrainType.Clear },
    to: { x: 0, y: 0, row: ROW, col: toCol, terrain: TerrainType.Clear },
    cost: 1,
  };
}

/** A straight path of edges from milepost 0 to `lastCol`; `ownerOf` names each edge's owner. */
function straightUsage(lastCol: number, ownerOf: (edgeIndex: number) => string = () => BOT): TrackUsageComputation {
  const path: PathEdge[] = [];
  for (let i = 0; i < lastCol; i++) {
    path.push({ from: at(i), to: at(i + 1), ownerPlayerIds: [ownerOf(i)] });
  }
  return { isValid: true, path, ownersUsed: new Set() };
}

function effect(cardType: EventCardType, movement: MovementRestriction[]): ActiveEffect {
  return {
    cardId: 131,
    cardType,
    drawingPlayerId: OPPONENT,
    drawingPlayerIndex: 1,
    expiresAfterTurnNumber: 99,
    affectedZone: new Set<string>(),
    restrictions: { movement, build: [], pickupDelivery: [] },
    pendingLostTurns: [],
  };
}

function snow(halfRate: string[], blocked: string[] = []): ActiveEffect {
  return effect(EventCardType.Snow, [
    { type: 'half_rate', zone: halfRate },
    { type: 'blocked_terrain', zone: blocked },
  ]);
}

function makeSnapshot(activeEffects: ActiveEffect[], trainType: TrainType = TrainType.Freight): WorldSnapshot {
  const segments = [makeSegment(0, 1)];
  return {
    gameId: 'test-event-rules',
    gameStatus: 'active',
    turnNumber: 1,
    bot: {
      playerId: BOT,
      userId: 'test-user',
      money: 300,
      position: at(0),
      existingSegments: segments,
      demandCards: [],
      resolvedDemands: [],
      trainType,
      loads: [],
      botConfig: { skillLevel: 'medium' },
      ferryHalfSpeed: false,
      connectedMajorCityCount: 0,
    },
    allPlayerTracks: [{ playerId: BOT, segments }],
    loadAvailability: {},
    ferryEdges: [],
    activeEffects,
  };
}

async function resolveToTarget(snapshot: WorldSnapshot, budget?: number): Promise<{ row: number; col: number }[] | null> {
  const result = await ActionResolver.resolveMove({ toRow: TARGET.row, toCol: TARGET.col }, snapshot, budget);
  return result.success ? (result.plan as TurnPlanMoveTrain).path : null;
}

describe('ActionResolver.resolveMove — event movement rules (#313)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (getFerryEdges as jest.Mock).mockReturnValue([]);
    (getMajorCityGroups as jest.Mock).mockReturnValue([]);
    (getMajorCityLookup as jest.Mock).mockReturnValue(new Map());
    mockLoadGridPoints.mockReturnValue(new Map());
    mockComputeTrackUsageForMove.mockReturnValue(straightUsage(12));
  });

  it('moves the full speed when no effect is active', async () => {
    const path = await resolveToTarget(makeSnapshot([]), 9);
    expect(path).toHaveLength(10);
    expect(path?.[9]).toEqual(at(9));
  });

  it('halves the rest of the move on entering a Snow zone (round up)', async () => {
    // zone from milepost 4: 4 mileposts in, 5 left -> 3, so the bot stops at 7
    const zone = [4, 5, 6, 7, 8, 9, 10, 11, 12].map(key);
    const path = await resolveToTarget(makeSnapshot([snow(zone)]), 9);
    expect(path?.[path.length - 1]).toEqual(at(7));
  });

  it('starts at half rate when the bot stands in the zone and no budget is passed', async () => {
    const zone = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map(key);
    const freight = await resolveToTarget(makeSnapshot([snow(zone)]));
    expect(freight?.[freight.length - 1]).toEqual(at(5));
    const fast = await resolveToTarget(makeSnapshot([snow(zone)], TrainType.FastFreight));
    expect(fast?.[fast.length - 1]).toEqual(at(6));
  });

  it('does not halve again a budget the planner already halved for a bot in the zone', async () => {
    const zone = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map(key);
    const path = await resolveToTarget(makeSnapshot([snow(zone)]), 5);
    expect(path?.[path.length - 1]).toEqual(at(5));
  });

  it('does not halve again when the turn was already halved and the bot re-enters a zone', async () => {
    // The bot stands outside the zone with 5 left of an already halved turn.
    const zone = [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map(key);
    const snapshot = makeSnapshot([snow(zone)]);
    const again = await ActionResolver.resolveMove({ toRow: TARGET.row, toCol: TARGET.col }, snapshot, 5);
    const once = await ActionResolver.resolveMove({ toRow: TARGET.row, toCol: TARGET.col }, snapshot, 5, true);
    const lastOf = (result: typeof once): { row: number; col: number } | undefined => {
      const path = result.success ? (result.plan as TurnPlanMoveTrain).path : [];
      return path[path.length - 1];
    };
    // Without the flag the 3 left on entering are halved to 2: stop at 4.
    expect(lastOf(again)).toEqual(at(4));
    expect(lastOf(once)).toEqual(at(5));
  });

  it('stops before a Snow-blocked milepost', async () => {
    const path = await resolveToTarget(makeSnapshot([snow([], [key(3)])]), 9);
    expect(path?.[path.length - 1]).toEqual(at(2));
  });

  it('fails the move when the first milepost is blocked', async () => {
    expect(await resolveToTarget(makeSnapshot([snow([], [key(1)])]), 9)).toBeNull();
  });

  it('stops before track under a Rail Strike', async () => {
    // the bot's own track for 3 edges, then the striking opponent's
    mockComputeTrackUsageForMove.mockReturnValue(straightUsage(12, (i) => (i < 3 ? BOT : OPPONENT)));
    const strike = effect(EventCardType.Strike, [
      { type: 'no_movement_on_player_rail', targetPlayerId: OPPONENT },
    ]);
    const plan = await ActionResolver.resolveMove({ toRow: TARGET.row, toCol: TARGET.col }, makeSnapshot([strike]), 9);
    expect(plan.success).toBe(true);
    const move = plan.plan as TurnPlanMoveTrain;
    expect(move.path[move.path.length - 1]).toEqual(at(3));
    // the struck track was not used, so there is no fee for it
    expect(move.totalFee).toBe(0);
  });

  it('does not move at all when the bot itself is on strike', async () => {
    const strike = effect(EventCardType.Strike, [
      { type: 'no_movement_on_player_rail', targetPlayerId: BOT },
    ]);
    expect(await resolveToTarget(makeSnapshot([strike]), 9)).toBeNull();
  });
});

describe('ActionResolver.resolve (multi-action) — half rate across MOVE steps (#313)', () => {
  /** A straight route between whatever two mileposts of ROW the resolver asks for. */
  function mockStraightRoutes(): void {
    mockComputeTrackUsageForMove.mockImplementation(({ from, to }) => {
      const path: PathEdge[] = [];
      for (let col = from.col; col < to.col; col++) {
        path.push({ from: at(col), to: at(col + 1), ownerPlayerIds: [BOT] });
      }
      return { isValid: path.length > 0, path, ownersUsed: new Set<string>() };
    });
  }

  async function resolveTwoMoves(snapshot: WorldSnapshot, firstCol: number): Promise<TurnPlanMoveTrain[]> {
    const intent = {
      actions: [
        { action: 'MOVE', details: { toRow: String(ROW), toCol: String(firstCol) } },
        { action: 'MOVE', details: { toRow: String(TARGET.row), toCol: String(TARGET.col) } },
      ],
      reasoning: 'two moves',
    } as unknown as LLMActionIntent;
    const context = { speed: 9 } as unknown as GameContext;
    const result = await ActionResolver.resolve(intent, snapshot, context);
    expect(result.success).toBe(true);
    if (!result.plan || result.plan.type !== 'MultiAction') throw new Error('expected a MultiAction plan');
    return result.plan.steps as TurnPlanMoveTrain[];
  }

  const endOf = (plan: TurnPlanMoveTrain): { row: number; col: number } => plan.path[plan.path.length - 1];

  beforeEach(() => {
    jest.clearAllMocks();
    (getFerryEdges as jest.Mock).mockReturnValue([]);
    (getMajorCityGroups as jest.Mock).mockReturnValue([]);
    (getMajorCityLookup as jest.Mock).mockReturnValue(new Map());
    mockLoadGridPoints.mockReturnValue(new Map());
    mockStraightRoutes();
  });

  it('gives the second move the plain remainder when no effect is active', async () => {
    const steps = await resolveTwoMoves(makeSnapshot([]), 4);
    expect(endOf(steps[0])).toEqual(at(4));
    expect(endOf(steps[1])).toEqual(at(9)); // 9 - 4 = 5 more
  });

  it('halves what is left after a first move that enters the zone', async () => {
    // zone from milepost 4: the first move uses 4 and enters it, 5 left -> 3
    const zone = [4, 5, 6, 7, 8, 9, 10, 11, 12].map(key);
    const steps = await resolveTwoMoves(makeSnapshot([snow(zone)]), 4);
    expect(endOf(steps[0])).toEqual(at(4));
    expect(endOf(steps[1])).toEqual(at(7));
  });

  it('starts at half rate when the bot stands in the zone, and halves only once', async () => {
    const zone = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map(key);
    const steps = await resolveTwoMoves(makeSnapshot([snow(zone)]), 2);
    expect(endOf(steps[0])).toEqual(at(2));
    expect(endOf(steps[1])).toEqual(at(5)); // 5 in all
  });
});
