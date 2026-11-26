/**
 * #312: server-side movement rules — the per-turn milepost budget and the
 * route a move is charged for.
 * #313: event modifiers — half rate, blocked mileposts, Rail Strike.
 */

import {
  MovePathStop,
  MovementBudgetState,
  MovementEventRules,
  NO_MOVEMENT_EVENT_RULES,
  applyHalfRate,
  beginMoveAt,
  computeRemainingMovement,
  enterMilepost,
  findMovePathWithinBudget,
  getTurnMovementAllowance,
  halfRateAllowance,
  hasNoMovementEventRules,
  isCityMilepost,
  isCityMilepostOf,
  isEdgeStruck,
  movementEventRulesFrom,
  readTurnMovementState,
  remainingMovementAt,
  sumMovementUsed,
  walkMovePath,
} from '../services/trainMovement';
import { getFerryEdges } from '../../shared/services/majorCityGroups';
import { TerrainType, TrainType } from '../../shared/types/GameTypes';
import { PlayerTrackState, TrackSegment } from '../../shared/types/TrackTypes';

const ME = 'player-me';
const OPPONENT = 'player-opponent';

type Node = { row: number; col: number };

function segment(from: Node, to: Node): TrackSegment {
  return {
    from: { x: 0, y: 0, row: from.row, col: from.col, terrain: TerrainType.Clear },
    to: { x: 0, y: 0, row: to.row, col: to.col, terrain: TerrainType.Clear },
    cost: 1,
  };
}

function track(playerId: string, segments: TrackSegment[]): PlayerTrackState {
  return {
    playerId,
    gameId: 'game-1',
    segments,
    totalCost: segments.length,
    turnBuildCost: 0,
    lastBuildTimestamp: new Date(),
  };
}

/** A straight line of `edges` segments along an off-map row (no cities, no ferries). */
function line(row: number, startCol: number, edges: number): TrackSegment[] {
  const segments: TrackSegment[] = [];
  for (let i = 0; i < edges; i++) {
    segments.push(segment({ row, col: startCol + i }, { row, col: startCol + i + 1 }));
  }
  return segments;
}

describe('getTurnMovementAllowance', () => {
  it('is the train type speed', () => {
    expect(getTurnMovementAllowance(TrainType.Freight)).toBe(9);
    expect(getTurnMovementAllowance(TrainType.HeavyFreight)).toBe(9);
    expect(getTurnMovementAllowance(TrainType.FastFreight)).toBe(12);
    expect(getTurnMovementAllowance(TrainType.Superfreight)).toBe(12);
  });

  it('applies modifiers in order and never goes below zero', () => {
    const halfRate = (allowance: number): number => Math.ceil(allowance / 2);
    expect(getTurnMovementAllowance(TrainType.Freight, [halfRate])).toBe(5);
    expect(getTurnMovementAllowance(TrainType.FastFreight, [halfRate])).toBe(6);
    expect(getTurnMovementAllowance(TrainType.Freight, [halfRate, (a: number): number => a - 10])).toBe(0);
  });
});

describe('sumMovementUsed', () => {
  it('sums the segment costs', () => {
    expect(sumMovementUsed([{ cost: 3 }, { cost: 4 }])).toBe(7);
  });

  it('counts negative, zero, non-numeric and missing costs as zero', () => {
    expect(
      sumMovementUsed([{ cost: 3 }, { cost: -100 }, { cost: 0 }, { cost: '5' }, { cost: NaN }, {}, null]),
    ).toBe(3);
  });

  it('is zero when there is no movement path', () => {
    expect(sumMovementUsed(null)).toBe(0);
    expect(sumMovementUsed(undefined)).toBe(0);
    expect(sumMovementUsed('nonsense')).toBe(0);
  });
});

describe('computeRemainingMovement', () => {
  it('is the allowance minus the movement used', () => {
    expect(computeRemainingMovement(TrainType.Freight, [{ cost: 4 }])).toBe(5);
    expect(computeRemainingMovement(TrainType.FastFreight, [])).toBe(12);
  });

  it('cannot be raised above the allowance by a negative cost', () => {
    expect(computeRemainingMovement(TrainType.Freight, [{ cost: -50 }])).toBe(9);
  });

  it('never goes below zero', () => {
    expect(computeRemainingMovement(TrainType.Freight, [{ cost: 20 }])).toBe(0);
  });
});

describe('isCityMilepost / isCityMilepostOf', () => {
  it('accepts major city centres and outposts, medium and small cities', () => {
    expect(isCityMilepost(24, 52)).toBe(true); // Berlin centre
    expect(isCityMilepost(24, 51)).toBe(true); // Berlin outpost
    expect(isCityMilepost(31, 53)).toBe(true); // Praha (medium)
    expect(isCityMilepost(39, 34)).toBe(true); // Lyon (small)
  });

  it('rejects ferry ports, plain mileposts and positions off the map', () => {
    expect(isCityMilepost(10, 33)).toBe(false); // Newcastle ferry port
    expect(isCityMilepost(1000, 1000)).toBe(false);
  });

  it('matches a position to its own city only', () => {
    expect(isCityMilepostOf(24, 52, 'Berlin')).toBe(true);
    expect(isCityMilepostOf(24, 51, 'Berlin')).toBe(true);
    expect(isCityMilepostOf(24, 52, 'Paris')).toBe(false);
    expect(isCityMilepostOf(31, 53, 'Praha')).toBe(true);
    // The Newcastle ferry port carries the city's name but is not the city.
    expect(isCityMilepostOf(9, 32, 'Newcastle')).toBe(true);
    expect(isCityMilepostOf(10, 33, 'Newcastle')).toBe(false);
  });
});

describe('findMovePathWithinBudget', () => {
  it('counts one milepost per track edge', () => {
    const result = findMovePathWithinBudget({
      allTracks: [track(ME, line(1000, 1000, 12))],
      from: { row: 1000, col: 1000 },
      to: { row: 1000, col: 1007 },
      currentPlayerId: ME,
      maxMileposts: 9,
    });
    expect(result?.mileposts).toBe(7);
    expect(result?.path).toHaveLength(7);
    expect(result?.path[0].from).toEqual({ row: 1000, col: 1000 });
    expect(result?.path[6].to).toEqual({ row: 1000, col: 1007 });
    expect(result?.ownersUsed.size).toBe(0);
  });

  it('returns a zero-length path when the train does not move', () => {
    const result = findMovePathWithinBudget({
      allTracks: [],
      from: { row: 1000, col: 1000 },
      to: { row: 1000, col: 1000 },
      currentPlayerId: ME,
      maxMileposts: 0,
    });
    expect(result).toEqual({
      path: [],
      ownersUsed: new Set(),
      mileposts: 0,
      stateAfter: { remaining: 0, halfRateApplied: false },
    });
  });

  it('returns null when the destination is farther than the budget', () => {
    const allTracks = [track(ME, line(1000, 1000, 12))];
    const args = { allTracks, from: { row: 1000, col: 1000 }, currentPlayerId: ME };
    expect(findMovePathWithinBudget({ ...args, to: { row: 1000, col: 1009 }, maxMileposts: 9 })?.mileposts).toBe(9);
    expect(findMovePathWithinBudget({ ...args, to: { row: 1000, col: 1010 }, maxMileposts: 9 })).toBeNull();
    expect(findMovePathWithinBudget({ ...args, to: { row: 1000, col: 1001 }, maxMileposts: 0 })).toBeNull();
  });

  it('returns null when there is no track connection', () => {
    const result = findMovePathWithinBudget({
      allTracks: [track(ME, line(1000, 1000, 2))],
      from: { row: 1000, col: 1000 },
      to: { row: 1500, col: 1500 },
      currentPlayerId: ME,
      maxMileposts: 12,
    });
    expect(result).toBeNull();
  });

  describe('own route against an opponent shortcut', () => {
    // My own route from A to B is 5 mileposts; the opponent owns a 1-milepost shortcut.
    const a: Node = { row: 1000, col: 1000 };
    const b: Node = { row: 1000, col: 1005 };
    const allTracks = [
      track(ME, line(1000, 1000, 5)),
      track(OPPONENT, [segment(a, b)]),
    ];

    it('uses the own route, with no fee, when it fits in the budget', () => {
      const result = findMovePathWithinBudget({ allTracks, from: a, to: b, currentPlayerId: ME, maxMileposts: 9 });
      expect(result?.mileposts).toBe(5);
      expect(result?.ownersUsed.size).toBe(0);
    });

    it('uses the opponent shortcut, and reports its owner, when the own route does not fit', () => {
      const result = findMovePathWithinBudget({ allTracks, from: a, to: b, currentPlayerId: ME, maxMileposts: 3 });
      expect(result?.mileposts).toBe(1);
      expect(Array.from(result?.ownersUsed ?? [])).toEqual([OPPONENT]);
    });

    it('does not use the shortcut when its owner is not an allowed opponent', () => {
      const args = { allTracks, from: a, to: b, currentPlayerId: ME, maxMileposts: 3 };
      expect(findMovePathWithinBudget({ ...args, allowedOpponentIds: new Set<string>() })).toBeNull();
      expect(findMovePathWithinBudget({ ...args, allowedOpponentIds: new Set(['someone-else']) })).toBeNull();
    });

    it('uses the shortcut when its owner is an allowed opponent', () => {
      const result = findMovePathWithinBudget({
        allTracks,
        from: a,
        to: b,
        currentPlayerId: ME,
        maxMileposts: 3,
        allowedOpponentIds: new Set([OPPONENT]),
      });
      expect(result?.mileposts).toBe(1);
      expect(Array.from(result?.ownersUsed ?? [])).toEqual([OPPONENT]);
    });

    it('still uses own track when no opponent is allowed', () => {
      const result = findMovePathWithinBudget({
        allTracks,
        from: a,
        to: b,
        currentPlayerId: ME,
        maxMileposts: 9,
        allowedOpponentIds: new Set<string>(),
      });
      expect(result?.mileposts).toBe(5);
      expect(result?.ownersUsed.size).toBe(0);
    });

    it('charges the mileposts of the route it returns, never a mix of the two', () => {
      for (let budget = 0; budget <= 12; budget++) {
        const result = findMovePathWithinBudget({ allTracks, from: a, to: b, currentPlayerId: ME, maxMileposts: budget });
        if (budget === 0) {
          expect(result).toBeNull();
        } else if (budget < 5) {
          expect(result?.mileposts).toBe(1);
          expect(result?.ownersUsed.size).toBe(1);
        } else {
          expect(result?.mileposts).toBe(5);
          expect(result?.ownersUsed.size).toBe(0);
        }
      }
    });
  });

  it('picks the fewest opponent edges, then the fewest mileposts', () => {
    // Two routes from A to D that both run on one opponent edge: A-B-D (2) and A-C1-C2-D (3).
    const a: Node = { row: 1000, col: 1000 };
    const b: Node = { row: 1001, col: 1000 };
    const c1: Node = { row: 1002, col: 1000 };
    const c2: Node = { row: 1002, col: 1001 };
    const d: Node = { row: 1000, col: 1002 };
    const allTracks = [
      // The longer route is listed first so insertion order cannot pick the winner.
      track(ME, [segment(a, c1), segment(c1, c2), segment(a, b)]),
      track(OPPONENT, [segment(c2, d), segment(b, d)]),
    ];
    const result = findMovePathWithinBudget({ allTracks, from: a, to: d, currentPlayerId: ME, maxMileposts: 9 });
    expect(result?.mileposts).toBe(2);
    expect(result?.path.map((edge) => edge.to)).toEqual([b, d]);
  });

  it('does not count movement inside one major city (red area)', () => {
    // Berlin: outpost (24,51) -> centre (24,52) -> outpost (24,53), no track needed.
    const result = findMovePathWithinBudget({
      allTracks: [],
      from: { row: 24, col: 51 },
      to: { row: 24, col: 53 },
      currentPlayerId: ME,
      maxMileposts: 0,
    });
    expect(result?.mileposts).toBe(0);
    expect(result?.path).toHaveLength(2);
  });

  it('does not count a ferry edge (ferry rules are issue #314)', () => {
    const ferry = getFerryEdges()[0];
    const landing: Node = { row: 2000, col: 2000 };
    const beyond: Node = { row: 2000, col: 2001 };
    const allTracks = [track(ME, [segment(ferry.pointB, landing), segment(landing, beyond)])];
    const result = findMovePathWithinBudget({
      allTracks,
      from: ferry.pointA,
      to: beyond,
      currentPlayerId: ME,
      maxMileposts: 2,
    });
    expect(result?.mileposts).toBe(2);
    expect(result?.path).toHaveLength(3);
  });
});

// ── #313: event modifiers ────────────────────────────────────────────────────

const ROW = 1000;
const at = (col: number): Node => ({ row: ROW, col });
const key = (col: number): string => `${ROW},${col}`;

function rules(partial: {
  halfRate?: string[];
  blocked?: string[];
  struck?: string[];
}): MovementEventRules {
  return {
    halfRateZone: new Set(partial.halfRate ?? []),
    blockedMileposts: new Set(partial.blocked ?? []),
    struckPlayerIds: new Set(partial.struck ?? []),
  };
}

const fresh = (remaining: number): MovementBudgetState => ({ remaining, halfRateApplied: false });

describe('movementEventRulesFrom', () => {
  it('collects the stored restrictions of Snow and the Rail Strike', () => {
    const result = movementEventRulesFrom([
      { type: 'half_rate', zone: ['1,1', '1,2'] },
      { type: 'blocked_terrain', zone: ['1,2'] },
      { type: 'no_movement_on_player_rail', targetPlayerId: OPPONENT },
    ]);
    expect(Array.from(result.halfRateZone)).toEqual(['1,1', '1,2']);
    expect(Array.from(result.blockedMileposts)).toEqual(['1,2']);
    expect(Array.from(result.struckPlayerIds)).toEqual([OPPONENT]);
    expect(hasNoMovementEventRules(result)).toBe(false);
  });

  it('restricts nothing for no restrictions or malformed ones', () => {
    expect(hasNoMovementEventRules(movementEventRulesFrom([]))).toBe(true);
    expect(hasNoMovementEventRules(movementEventRulesFrom(null))).toBe(true);
    expect(
      hasNoMovementEventRules(
        movementEventRulesFrom([null, { type: 'half_rate' }, { type: 'no_movement_on_player_rail' }]),
      ),
    ).toBe(true);
  });
});

describe('half rate', () => {
  it('halves a full allowance to 5 (Freight, Heavy Freight) and 6 (Fast Freight, Superfreight)', () => {
    expect(getTurnMovementAllowance(TrainType.Freight, [halfRateAllowance])).toBe(5);
    expect(getTurnMovementAllowance(TrainType.HeavyFreight, [halfRateAllowance])).toBe(5);
    expect(getTurnMovementAllowance(TrainType.FastFreight, [halfRateAllowance])).toBe(6);
    expect(getTurnMovementAllowance(TrainType.Superfreight, [halfRateAllowance])).toBe(6);
  });

  it('halves what is left, rounding up, and only once', () => {
    const once = applyHalfRate(fresh(5));
    expect(once).toEqual({ remaining: 3, halfRateApplied: true });
    expect(applyHalfRate(once)).toEqual(once);
    expect(applyHalfRate(fresh(1)).remaining).toBe(1);
    expect(applyHalfRate(fresh(0)).remaining).toBe(0);
  });

  it('applies to a train standing in the zone when it starts a move', () => {
    const zone = rules({ halfRate: [key(0)] });
    expect(beginMoveAt(fresh(9), key(0), zone)).toEqual({ remaining: 5, halfRateApplied: true });
    expect(beginMoveAt(fresh(9), key(1), zone)).toEqual(fresh(9));
    // already halved this turn: nothing more is taken
    expect(beginMoveAt({ remaining: 4, halfRateApplied: true }, key(0), zone).remaining).toBe(4);
  });

  it('halves what is left after the step that enters the zone', () => {
    const zone = rules({ halfRate: [key(4)] });
    // 9 allowance, 3 used: the 4th milepost enters the zone, 5 left -> 3
    expect(enterMilepost(fresh(6), key(4), false, zone)).toEqual({ remaining: 3, halfRateApplied: true });
    expect(enterMilepost(fresh(6), key(3), false, zone)).toEqual(fresh(5));
    // a free edge (major city red area, ferry line) into the zone uses no milepost but still halves
    expect(enterMilepost(fresh(6), key(4), true, zone)).toEqual({ remaining: 3, halfRateApplied: true });
    expect(enterMilepost(fresh(0), key(3), false, zone)).toBeNull();
    expect(enterMilepost(fresh(0), key(3), true, zone)).toEqual(fresh(0));
  });
});

describe('readTurnMovementState', () => {
  it('is the full allowance before the first move', () => {
    expect(readTurnMovementState(TrainType.Freight, [])).toEqual(fresh(9));
    expect(readTurnMovementState(TrainType.FastFreight, null)).toEqual(fresh(12));
  });

  it('starts at half rate when the turn does (the input for #314)', () => {
    expect(readTurnMovementState(TrainType.Freight, [], true)).toEqual({ remaining: 5, halfRateApplied: true });
    expect(readTurnMovementState(TrainType.Superfreight, [], true)).toEqual({ remaining: 6, halfRateApplied: true });
  });

  it('continues from the state stored on the last segment', () => {
    const path = [
      { cost: 2, remainingAfter: 7, halfRate: false },
      { cost: 2, remainingAfter: 3, halfRate: true },
    ];
    expect(readTurnMovementState(TrainType.Freight, path)).toEqual({ remaining: 3, halfRateApplied: true });
  });

  it('falls back to the summed costs for a segment written without state', () => {
    expect(readTurnMovementState(TrainType.Freight, [{ cost: 4 }])).toEqual(fresh(5));
  });

  it('never trusts a stored remainder above the train speed, or below zero', () => {
    expect(readTurnMovementState(TrainType.Freight, [{ cost: 1, remainingAfter: 99, halfRate: false }]).remaining).toBe(9);
    expect(readTurnMovementState(TrainType.Freight, [{ cost: 1, remainingAfter: -3, halfRate: false }]).remaining).toBe(0);
  });
});

describe('remainingMovementAt', () => {
  const zone = rules({ halfRate: [key(4)] });

  it('reports half rate for a train standing in the zone', () => {
    expect(remainingMovementAt(TrainType.Freight, [], at(4), zone)).toBe(5);
    expect(remainingMovementAt(TrainType.FastFreight, [], at(4), zone)).toBe(6);
    expect(remainingMovementAt(TrainType.Freight, [], at(3), zone)).toBe(9);
    expect(remainingMovementAt(TrainType.Freight, [], null, zone)).toBe(9);
  });

  it('halves what is left when the event starts after the train has moved', () => {
    const moved = [{ cost: 4, remainingAfter: 5, halfRate: false }];
    expect(remainingMovementAt(TrainType.Freight, moved, at(4), zone)).toBe(3);
    expect(remainingMovementAt(TrainType.Freight, moved, at(4), NO_MOVEMENT_EVENT_RULES)).toBe(5);
  });
});

describe('isEdgeStruck', () => {
  const strike = rules({ struck: [OPPONENT] });

  it('is true for track owned only by a striking player', () => {
    expect(isEdgeStruck([OPPONENT], strike)).toBe(true);
    expect(isEdgeStruck(new Set([OPPONENT]), strike)).toBe(true);
  });

  it('is false for other track and for ownerless edges', () => {
    expect(isEdgeStruck([ME], strike)).toBe(false);
    expect(isEdgeStruck([ME, OPPONENT], strike)).toBe(false);
    expect(isEdgeStruck([], strike)).toBe(false);
    expect(isEdgeStruck(undefined, strike)).toBe(false);
    expect(isEdgeStruck([OPPONENT], NO_MOVEMENT_EVENT_RULES)).toBe(false);
  });
});

describe('findMovePathWithinBudget with event rules', () => {
  const myLine = [track(ME, line(ROW, 0, 13))];
  const find = (
    to: Node,
    eventRules: MovementEventRules,
    start: MovementBudgetState = fresh(9),
    allTracks: PlayerTrackState[] = myLine,
    from: Node = at(0),
  ): ReturnType<typeof findMovePathWithinBudget> =>
    findMovePathWithinBudget({
      allTracks,
      from,
      to,
      currentPlayerId: ME,
      maxMileposts: start.remaining,
      halfRateApplied: start.halfRateApplied,
      eventRules,
    });

  it('reports the budget after a move with no events', () => {
    const result = find(at(4), NO_MOVEMENT_EVENT_RULES);
    expect(result?.mileposts).toBe(4);
    expect(result?.stateAfter).toEqual(fresh(5));
  });

  it('halves the rest of a single move that starts outside the zone and enters it', () => {
    // zone from milepost 4 on: 4 mileposts to enter, 5 left -> 3, so 7 is the farthest
    const zone = rules({ halfRate: [4, 5, 6, 7, 8, 9].map(key) });
    const reachable = find(at(7), zone);
    expect(reachable?.mileposts).toBe(7);
    expect(reachable?.stateAfter).toEqual({ remaining: 0, halfRateApplied: true });
    expect(find(at(8), zone)).toBeNull();
    expect(find(at(4), zone)?.stateAfter).toEqual({ remaining: 3, halfRateApplied: true });
  });

  it('rounds up for a Fast Freight entering the zone on an odd remainder', () => {
    // 12 allowance, 5 mileposts to enter: 7 left -> 4
    const zone = rules({ halfRate: [5, 6, 7, 8, 9, 10].map(key) });
    expect(find(at(9), zone, fresh(12))?.stateAfter.remaining).toBe(0);
    expect(find(at(10), zone, fresh(12))).toBeNull();
  });

  it('does not halve again once half rate applies', () => {
    const zone = rules({ halfRate: [2, 3].map(key) });
    const result = find(at(3), zone, { remaining: 5, halfRateApplied: true });
    expect(result?.stateAfter).toEqual({ remaining: 2, halfRateApplied: true });
  });

  it('never enters a blocked milepost, and goes around one when it can', () => {
    const blocked = rules({ blocked: [key(2)] });
    expect(find(at(3), blocked)).toBeNull();
    expect(find(at(1), blocked)?.mileposts).toBe(1);

    // a detour over row 1001 around the blocked milepost
    const detour = [
      segment(at(1), { row: 1001, col: 1 }),
      segment({ row: 1001, col: 1 }, { row: 1001, col: 2 }),
      segment({ row: 1001, col: 2 }, { row: 1001, col: 3 }),
      segment({ row: 1001, col: 3 }, at(3)),
    ];
    const around = find(at(3), blocked, fresh(9), [track(ME, [...line(ROW, 0, 13), ...detour])]);
    expect(around?.mileposts).toBe(5);
    expect(around?.path.some((edge) => edge.to.row === ROW && edge.to.col === 2)).toBe(false);
  });

  it('lets a train leave a blocked milepost it already stands on', () => {
    const blocked = rules({ blocked: [key(0)] });
    expect(find(at(2), blocked)?.mileposts).toBe(2);
  });

  it('does not use the track of a striking player, whoever moves', () => {
    const opponentLine = [track(OPPONENT, line(ROW, 0, 5))];
    expect(find(at(3), NO_MOVEMENT_EVENT_RULES, fresh(9), opponentLine)?.mileposts).toBe(3);
    expect(find(at(3), rules({ struck: [OPPONENT] }), fresh(9), opponentLine)).toBeNull();
    // the striking player cannot move on their own track either
    expect(find(at(3), rules({ struck: [ME] }))).toBeNull();
    // a strike on someone else's track does not stop a train on its own track
    expect(find(at(3), rules({ struck: [OPPONENT] }))?.mileposts).toBe(3);
  });

  it('routes around struck track over other track', () => {
    const own = track(ME, [
      segment(at(0), { row: 1001, col: 0 }),
      segment({ row: 1001, col: 0 }, { row: 1001, col: 1 }),
      segment({ row: 1001, col: 1 }, at(1)),
    ]);
    const shortcut = track(OPPONENT, [segment(at(0), at(1))]);
    const result = find(at(1), rules({ struck: [OPPONENT] }), fresh(2), [own, shortcut]);
    // without the strike the 1-milepost shortcut is the only route that fits in 2
    expect(find(at(1), NO_MOVEMENT_EVENT_RULES, fresh(2), [own, shortcut])?.mileposts).toBe(1);
    expect(result).toBeNull();
    expect(find(at(1), rules({ struck: [OPPONENT] }), fresh(3), [own, shortcut])?.ownersUsed.size).toBe(0);
  });
});

describe('walkMovePath', () => {
  const path = [0, 1, 2, 3, 4, 5, 6].map(at);

  it('walks the whole path when nothing stops it', () => {
    const result = walkMovePath(path, fresh(9), NO_MOVEMENT_EVENT_RULES);
    expect(result).toEqual({ edgesTravelled: 6, state: fresh(3), stoppedBy: MovePathStop.None });
  });

  it('stops when half rate uses up the movement', () => {
    // enter the zone at milepost 2: 7 left -> 4, so mileposts 3..6 are reachable; start with 6: 4 left -> 2
    const zone = rules({ halfRate: [2, 3, 4, 5, 6].map(key) });
    const result = walkMovePath(path, fresh(6), zone);
    expect(result.edgesTravelled).toBe(4);
    expect(result.stoppedBy).toBe(MovePathStop.OutOfMovement);
    expect(result.state).toEqual({ remaining: 0, halfRateApplied: true });
  });

  it('stops before a blocked milepost', () => {
    const result = walkMovePath(path, fresh(9), rules({ blocked: [key(3)] }));
    expect(result.edgesTravelled).toBe(2);
    expect(result.stoppedBy).toBe(MovePathStop.BlockedMilepost);
  });

  it('stops before track under a Rail Strike', () => {
    const owners = (index: number): string[] => (index < 2 ? [ME] : [OPPONENT]);
    const result = walkMovePath(path, fresh(9), rules({ struck: [OPPONENT] }), owners);
    expect(result.edgesTravelled).toBe(2);
    expect(result.stoppedBy).toBe(MovePathStop.RailStrike);
  });
});
