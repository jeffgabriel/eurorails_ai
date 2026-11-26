/**
 * #312: server-side movement rules — the per-turn milepost budget and the
 * route a move is charged for.
 */

import {
  computeRemainingMovement,
  findMovePathWithinBudget,
  getTurnMovementAllowance,
  isCityMilepost,
  isCityMilepostOf,
  sumMovementUsed,
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
    expect(result).toEqual({ path: [], ownersUsed: new Set(), mileposts: 0 });
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
