import { getHexNeighbors, loadGridPoints } from '../services/MapTopology';
import {
  buildActionsOf,
  MAX_BUILD_PATH_POINTS,
  parseBuildPath,
  pathToBuildEdges,
  planTrackBuild,
  TrackBuildEdge,
  TrackBuildError,
  TrackBuildErrorCode,
  TrackBuildPlanInput,
} from '../services/trackBuild';
import { getMajorCityLookup } from '../../shared/services/majorCityGroups';
import { getWaterCrossingExtraCost } from '../../shared/config/waterCrossings';
import { TrackCostCoord, TrackCostSegment } from '../../shared/services/trackBuildCost';
import { TerrainType } from '../../shared/types/GameTypes';

/**
 * Build rules of issue #308, on the real map.
 *
 * Mileposts used (row,col):
 * - Berlin: (24,51) and (23,51) are Berlin mileposts; (24,50), (23,50) and
 *   (25,50) are clear mileposts next to (24,51); (23,52)->(23,53) crosses a river.
 * - Milano: (41,42) is a Milano milepost next to alpine (40,43).
 * - Portsmouth–Le Havre ferry (4M): ports (21,28) and (25,29). London milepost
 *   (20,30) -> clear (20,29) -> port (21,28). Across the channel the port
 *   (25,29) touches clear (25,30) and (26,30), which touch each other.
 */

const c = (row: number, col: number): TrackCostCoord => ({ row, col });
const edge = (from: [number, number], to: [number, number]): TrackBuildEdge => ({
  from: c(from[0], from[1]),
  to: c(to[0], to[1]),
});
const track = (...edges: Array<[[number, number], [number, number]]>): TrackCostSegment[] =>
  edges.map(([from, to]: [[number, number], [number, number]]): TrackCostSegment => edge(from, to));

function plan(overrides: Partial<TrackBuildPlanInput> & { edges: TrackBuildEdge[] }): ReturnType<typeof planTrackBuild> {
  return planTrackBuild({
    ownSegments: [],
    otherPlayersSegments: [],
    turnSpent: 0,
    unsettledCost: 0,
    money: 50,
    majorCityStartsThisTurn: [],
    ...overrides,
  });
}

function expectRejection(run: () => unknown, code: TrackBuildErrorCode, httpStatus: number): void {
  let thrown: unknown;
  try {
    run();
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(TrackBuildError);
  const error = thrown as TrackBuildError;
  expect(TrackBuildErrorCode[error.code]).toBe(TrackBuildErrorCode[code]);
  expect(error.httpStatus).toBe(httpStatus);
  expect(error.toResponseBody().code).toBe(TrackBuildErrorCode[code]);
}

describe('planTrackBuild', () => {
  it('uses the mileposts this file assumes', () => {
    const grid = loadGridPoints();
    const cities = getMajorCityLookup();
    expect(cities.get('24,51')).toBe('Berlin');
    expect(cities.get('23,51')).toBe('Berlin');
    expect(cities.get('41,42')).toBe('Milano');
    expect(cities.get('20,30')).toBe('London');
    for (const key of ['24,50', '23,50', '25,50', '20,29', '25,30', '26,30']) {
      expect(grid.get(key)?.terrain).toBe(TerrainType.Clear);
      expect(cities.has(key)).toBe(false);
    }
    expect(grid.get('40,43')?.terrain).toBe(TerrainType.Alpine);
    expect(getWaterCrossingExtraCost(c(23, 52), c(23, 53))).toBe(2);
  });

  describe('legal builds', () => {
    it('builds out of a major city milepost with no track yet', () => {
      const result = plan({ edges: [edge([24, 51], [24, 50])] });
      expect(result.cost).toBe(1);
      expect(result.segments).toHaveLength(1);
      expect(result.segments[0].majorCityStart).toBe('24,51');
      expect(result.segments[0].segment).toMatchObject({
        from: { row: 24, col: 51, terrain: TerrainType.MajorCity },
        to: { row: 24, col: 50, terrain: TerrainType.Clear },
        cost: 1,
      });
      // Pixel coordinates are filled in by the server.
      expect(typeof result.segments[0].segment.to.x).toBe('number');
    });

    it('extends the player\'s own network, in either direction', () => {
      const own = track([[24, 51], [24, 50]]);
      const next = getHexNeighbors(24, 50).find(
        (n: TrackCostCoord): boolean => !getMajorCityLookup().has(`${n.row},${n.col}`),
      )!;
      const forward = plan({ ownSegments: own, edges: [{ from: c(24, 50), to: next }] });
      const backward = plan({ ownSegments: own, edges: [{ from: next, to: c(24, 50) }] });
      expect(forward.segments[0].majorCityStart).toBeUndefined();
      expect(backward.cost).toBe(forward.cost);
    });

    it('chains sections: each may hang off the one before it', () => {
      const result = plan({ edges: [edge([24, 51], [23, 50]), edge([23, 50], [24, 50])] });
      expect(result.segments).toHaveLength(2);
      expect(result.cost).toBe(2);
    });

    it('adds the river surcharge to the destination cost', () => {
      const result = plan({ edges: [edge([23, 52], [23, 53])] });
      expect(result.cost).toBe(1 + 2);
    });

    it('prices alpine at 5M', () => {
      expect(plan({ edges: [edge([41, 42], [40, 43])] }).cost).toBe(5);
    });

    it('charges 5M to enter a major city from the player\'s own track', () => {
      const result = plan({
        ownSegments: track([[24, 51], [23, 50]]),
        edges: [edge([23, 50], [23, 51])],
      });
      expect(result.cost).toBe(5);
      // Arriving in a city is not a section built out of it.
      expect(result.segments[0].majorCityStart).toBeUndefined();
    });

    it('charges a ferry line on the first port only', () => {
      const toFirstPort = plan({ edges: [edge([20, 30], [20, 29]), edge([20, 29], [21, 28])] });
      expect(toFirstPort.segments.map(s => s.segment.cost)).toEqual([
        1 + getWaterCrossingExtraCost(c(20, 30), c(20, 29)),
        4 + getWaterCrossingExtraCost(c(20, 29), c(21, 28)),
      ]);

      // With the near port connected, track may start from the far port, and
      // a section back into that far port is free.
      const own = track([[20, 30], [20, 29]], [[20, 29], [21, 28]]);
      const farSide = plan({
        ownSegments: own,
        edges: [edge([25, 29], [25, 30]), edge([25, 30], [26, 30]), edge([26, 30], [25, 29])],
      });
      expect(farSide.segments[2].segment.cost).toBe(getWaterCrossingExtraCost(c(26, 30), c(25, 29)));
      expect(farSide.cost).toBe(
        1 + getWaterCrossingExtraCost(c(25, 29), c(25, 30)) +
        1 + getWaterCrossingExtraCost(c(25, 30), c(26, 30)) +
        getWaterCrossingExtraCost(c(26, 30), c(25, 29)),
      );
    });

    it('allows exactly the turn budget and exactly the player\'s cash', () => {
      expect(plan({ edges: [edge([24, 51], [24, 50])], turnSpent: 19, money: 1 }).cost).toBe(1);
      expect(plan({ edges: [edge([24, 51], [24, 50])], unsettledCost: 9, money: 10 }).cost).toBe(1);
    });
  });

  describe('rejections', () => {
    it('NothingToBuild when there are no sections', () => {
      expectRejection(() => plan({ edges: [] }), TrackBuildErrorCode.NothingToBuild, 409);
    });

    it('UnknownMilepost for a coordinate off the map', () => {
      expectRejection(() => plan({ edges: [edge([24, 51], [999, 999])] }), TrackBuildErrorCode.UnknownMilepost, 400);
    });

    it('UnknownMilepost for a water milepost', () => {
      const water = [...loadGridPoints().values()].find(p => p.terrain === TerrainType.Water);
      if (!water) return; // the map lists no water mileposts
      const neighbor = c(water.row, water.col + 1);
      expectRejection(
        () => plan({ edges: [{ from: neighbor, to: c(water.row, water.col) }] }),
        TrackBuildErrorCode.UnknownMilepost,
        400,
      );
    });

    it('NotAdjacent for mileposts two apart, and for a section from a milepost to itself', () => {
      expectRejection(() => plan({ edges: [edge([24, 51], [24, 49])] }), TrackBuildErrorCode.NotAdjacent, 400);
      expectRejection(() => plan({ edges: [edge([24, 51], [24, 51])] }), TrackBuildErrorCode.NotAdjacent, 400);
    });

    it('NotAdjacent for the two ports of a ferry line (the crossing is not track)', () => {
      expectRejection(
        () => plan({ ownSegments: track([[20, 29], [21, 28]]), edges: [edge([21, 28], [25, 29])] }),
        TrackBuildErrorCode.NotAdjacent,
        400,
      );
    });

    it('MajorCityRedArea between two mileposts of the same major city', () => {
      expectRejection(() => plan({ edges: [edge([24, 51], [23, 51])] }), TrackBuildErrorCode.MajorCityRedArea, 400);
      expectRejection(() => plan({ edges: [edge([24, 51], [24, 52])] }), TrackBuildErrorCode.MajorCityRedArea, 400);
    });

    it('NotConnected away from the player\'s track and from any major city', () => {
      expectRejection(() => plan({ edges: [edge([24, 50], [23, 50])] }), TrackBuildErrorCode.NotConnected, 409);
    });

    it('NotConnected from the far port of a ferry the player has not reached', () => {
      expectRejection(() => plan({ edges: [edge([25, 29], [25, 30])] }), TrackBuildErrorCode.NotConnected, 409);
    });

    it('NotConnected next to another player\'s track', () => {
      expectRejection(
        () => plan({ otherPlayersSegments: track([[24, 51], [24, 50]]), edges: [edge([24, 50], [23, 50])] }),
        TrackBuildErrorCode.NotConnected,
        409,
      );
    });

    it('RightOfWay over another player\'s track, in either direction', () => {
      const other = track([[24, 51], [24, 50]]);
      expectRejection(
        () => plan({ otherPlayersSegments: other, edges: [edge([24, 51], [24, 50])] }),
        TrackBuildErrorCode.RightOfWay,
        409,
      );
      expectRejection(
        () => plan({ otherPlayersSegments: other, edges: [edge([24, 50], [24, 51])] }),
        TrackBuildErrorCode.RightOfWay,
        409,
      );
    });

    it('RightOfWay over the player\'s own track, and for a section repeated in one build', () => {
      expectRejection(
        () => plan({ ownSegments: track([[24, 51], [24, 50]]), edges: [edge([24, 50], [24, 51])] }),
        TrackBuildErrorCode.RightOfWay,
        409,
      );
      expectRejection(
        () => plan({ edges: [edge([24, 51], [24, 50]), edge([24, 50], [24, 51])] }),
        TrackBuildErrorCode.RightOfWay,
        409,
      );
    });

    it('MajorCityTurnLimit on a third section out of one major city milepost', () => {
      expectRejection(
        () => plan({ edges: [edge([24, 51], [24, 50]), edge([24, 51], [23, 50]), edge([24, 51], [25, 50])] }),
        TrackBuildErrorCode.MajorCityTurnLimit,
        409,
      );
    });

    it('MajorCityTurnLimit counts sections built earlier this turn, and reversed sections', () => {
      expectRejection(
        () => plan({
          ownSegments: track([[24, 51], [24, 50]], [[24, 51], [23, 50]]),
          majorCityStartsThisTurn: ['24,51', '24,51'],
          edges: [edge([25, 50], [24, 51])],
        }),
        TrackBuildErrorCode.MajorCityTurnLimit,
        409,
      );
    });

    it('does not count earlier turns\' track, another milepost\'s sections, or arrivals', () => {
      // Two sections already leave (24,51), but they were built on earlier turns.
      const result = plan({
        ownSegments: track([[24, 51], [24, 50]], [[24, 51], [23, 50]]),
        edges: [edge([24, 51], [25, 50])],
      });
      expect(result.segments[0].majorCityStart).toBe('24,51');

      // Two out of (24,51) this turn do not limit the neighbouring milepost (23,51).
      const otherMilepost = plan({
        majorCityStartsThisTurn: ['24,51', '24,51'],
        edges: [edge([23, 51], [23, 50])],
      });
      expect(otherMilepost.segments[0].majorCityStart).toBe('23,51');

      // Arriving at (24,51) from the network, then two sections out of it.
      const arrival = plan({
        ownSegments: track([[23, 51], [23, 50]]),
        edges: [edge([23, 50], [24, 51]), edge([24, 51], [24, 50]), edge([24, 51], [25, 50])],
      });
      expect(arrival.segments.map(s => s.majorCityStart)).toEqual([undefined, '24,51', '24,51']);
    });

    it('TurnBudgetExceeded when the turn total would pass 20M', () => {
      expectRejection(
        () => plan({ edges: [edge([24, 51], [24, 50])], turnSpent: 20 }),
        TrackBuildErrorCode.TurnBudgetExceeded,
        409,
      );
      expectRejection(
        () => plan({ edges: [edge([41, 42], [40, 43])], turnSpent: 16 }),
        TrackBuildErrorCode.TurnBudgetExceeded,
        409,
      );
    });

    it('InsufficientFunds when cash does not cover unsettled spend plus the build', () => {
      expectRejection(
        () => plan({ edges: [edge([24, 51], [24, 50])], money: 0 }),
        TrackBuildErrorCode.InsufficientFunds,
        409,
      );
      expectRejection(
        () => plan({ edges: [edge([24, 51], [24, 50])], unsettledCost: 10, money: 10 }),
        TrackBuildErrorCode.InsufficientFunds,
        409,
      );
    });
  });
});

describe('parseBuildPath', () => {
  it('accepts a list of coordinates and drops any other fields', () => {
    expect(parseBuildPath([{ row: 24, col: 51, cost: 0 }, { row: 24, col: 50, terrain: 8 }])).toEqual([
      { row: 24, col: 51 },
      { row: 24, col: 50 },
    ]);
  });

  it.each([
    ['missing', undefined],
    ['not a list', { row: 1, col: 1 }],
    ['one point', [{ row: 24, col: 51 }]],
    ['a string coordinate', [{ row: '24', col: 51 }, { row: 24, col: 50 }]],
    ['a fractional coordinate', [{ row: 24.5, col: 51 }, { row: 24, col: 50 }]],
    ['a null entry', [null, { row: 24, col: 50 }]],
    ['too many points', Array.from({ length: MAX_BUILD_PATH_POINTS + 1 }, () => ({ row: 24, col: 51 }))],
  ])('rejects a path that is %s', (_label: string, path: unknown) => {
    expectRejection(() => parseBuildPath(path), TrackBuildErrorCode.InvalidPath, 400);
  });
});

describe('pathToBuildEdges', () => {
  it('skips the stretches of the path that are already the player\'s track', () => {
    const own = track([[24, 51], [24, 50]]);
    expect(pathToBuildEdges([c(24, 51), c(24, 50), c(23, 50)], own)).toEqual([edge([24, 50], [23, 50])]);
    // Stored direction does not matter.
    expect(pathToBuildEdges([c(24, 50), c(24, 51)], own)).toEqual([]);
  });
});

describe('buildActionsOf', () => {
  it('keeps build entries and ignores other actions and malformed rows', () => {
    const build = { kind: 'build', segment: { from: {}, to: {}, cost: 3 } };
    expect(buildActionsOf([{ kind: 'move' }, build, { kind: 'build' }, null])).toEqual([build]);
    expect(buildActionsOf(undefined)).toEqual([]);
    expect(buildActionsOf('[]')).toEqual([]);
  });
});
