import {
  isIntraCityEdge,
  computeEffectivePathLength,
  getMajorCityInternalEdges,
  getMajorCityLookup,
} from '../../services/majorCityGroups';
import {
  buildMockMajorCityLookup,
  MOCK_MAJOR_CITY_GROUPS,
} from '../utils/test-helpers';

const lookup = buildMockMajorCityLookup(MOCK_MAJOR_CITY_GROUPS);

describe('isIntraCityEdge', () => {
  it('returns true for two points within the same major city', () => {
    // Berlin center (10,10) to Berlin outpost (9,10)
    expect(isIntraCityEdge('10,10', '9,10', lookup)).toBe(true);
  });

  it('returns true for two outposts of the same city', () => {
    // Berlin outpost (9,10) to Berlin outpost (11,10)
    expect(isIntraCityEdge('9,10', '11,10', lookup)).toBe(true);
  });

  it('returns false for points in different major cities', () => {
    // Berlin center (10,10) to Vienna center (30,30)
    expect(isIntraCityEdge('10,10', '30,30', lookup)).toBe(false);
  });

  it('returns false when one point is in a city and the other is outside', () => {
    // Berlin center (10,10) to non-city point (20,20)
    expect(isIntraCityEdge('10,10', '20,20', lookup)).toBe(false);
  });

  it('returns false when both points are outside any city', () => {
    expect(isIntraCityEdge('20,20', '25,25', lookup)).toBe(false);
  });

  it('returns false for an empty lookup', () => {
    const emptyLookup = new Map<string, string>();
    expect(isIntraCityEdge('10,10', '9,10', emptyLookup)).toBe(false);
  });
});

describe('computeEffectivePathLength', () => {
  it('returns path.length - 1 for a path entirely outside any city', () => {
    const path = [
      { row: 20, col: 20 },
      { row: 21, col: 20 },
      { row: 22, col: 20 },
    ];
    expect(computeEffectivePathLength(path, lookup)).toBe(2);
  });

  it('counts every milepost entered inside a single major city', () => {
    // Berlin: center (10,10), outposts (9,10), (11,10), (10,9), (10,11)
    const path = [
      { row: 9, col: 10 },
      { row: 10, col: 10 },
      { row: 11, col: 10 },
    ];
    expect(computeEffectivePathLength(path, lookup)).toBe(2);
  });

  it('counts the center and both outer mileposts for a path entering and exiting a city', () => {
    // outside -> Berlin outpost -> Berlin center -> Berlin outpost -> outside
    const path = [
      { row: 8, col: 10 },   // outside
      { row: 9, col: 10 },   // Berlin outpost (enter)
      { row: 10, col: 10 },  // Berlin center
      { row: 11, col: 10 },  // Berlin outpost
      { row: 12, col: 10 },  // outside (exit)
    ];
    // The red area is shared space, not free space: 4 mileposts entered.
    expect(computeEffectivePathLength(path, lookup)).toBe(4);
  });

  it('needs no city lookup', () => {
    expect(computeEffectivePathLength([{ row: 9, col: 10 }, { row: 10, col: 10 }])).toBe(1);
  });

  it('returns 0 for a single-point path', () => {
    const path = [{ row: 10, col: 10 }];
    expect(computeEffectivePathLength(path, lookup)).toBe(0);
  });

  it('returns 0 for an empty path', () => {
    expect(computeEffectivePathLength([], lookup)).toBe(0);
  });
});

describe('getMajorCityInternalEdges', () => {
  const key = (p: { row: number; col: number }): string => `${p.row},${p.col}`;
  const edgeSet = (cities?: Parameters<typeof getMajorCityInternalEdges>[0]): Set<string> =>
    new Set(getMajorCityInternalEdges(cities).map((e) => [key(e.from), key(e.to)].sort().join('|')));

  // A full city on the hex grid: center on an even row, six outer mileposts.
  const city = {
    cityName: 'Hexville',
    center: { row: 10, col: 10 },
    outposts: [
      { row: 9, col: 9 }, { row: 9, col: 10 },
      { row: 10, col: 9 }, { row: 10, col: 11 },
      { row: 11, col: 9 }, { row: 11, col: 10 },
    ],
  };

  it('joins the center to every outer milepost', () => {
    const edges = edgeSet([city]);
    for (const outpost of city.outposts) {
      expect(edges.has([key(city.center), key(outpost)].sort().join('|'))).toBe(true);
    }
  });

  it('joins each outer milepost to its two neighbours on the ring, and to no other', () => {
    const edges = edgeSet([city]);
    const ring = ['9,9|9,10', '9,10|10,11', '10,11|11,10', '11,10|11,9', '11,9|10,9', '10,9|9,9']
      .map((e) => e.split('|').sort().join('|'));
    for (const edge of ring) {
      expect(edges.has(edge)).toBe(true);
    }
    // 6 spokes + 6 ring edges; opposite outer mileposts are not joined.
    expect(edges.size).toBe(12);
    expect(edges.has(['9,9', '11,10'].sort().join('|'))).toBe(false);
  });

  it('gives every real major city only edges between hex neighbours of the same city', () => {
    const cityLookup = getMajorCityLookup();
    const edges = getMajorCityInternalEdges();
    expect(edges.length).toBeGreaterThan(0);
    for (const edge of edges) {
      expect(cityLookup.get(key(edge.from))).toBeDefined();
      expect(cityLookup.get(key(edge.from))).toBe(cityLookup.get(key(edge.to)));
      expect(Math.abs(edge.from.row - edge.to.row)).toBeLessThanOrEqual(1);
      expect(Math.abs(edge.from.col - edge.to.col)).toBeLessThanOrEqual(1);
    }
  });
});
