import {
  isIntraCityEdge,
  computeEffectivePathLength,
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

  it('returns 0 for a path entirely within a single major city', () => {
    // Berlin: center (10,10), outposts (9,10), (11,10), (10,9), (10,11)
    const path = [
      { row: 9, col: 10 },
      { row: 10, col: 10 },
      { row: 11, col: 10 },
    ];
    expect(computeEffectivePathLength(path, lookup)).toBe(0);
  });

  it('counts only non-intra-city edges for a path entering and exiting a city', () => {
    // outside -> Berlin outpost -> Berlin center -> Berlin outpost -> outside
    const path = [
      { row: 8, col: 10 },   // outside
      { row: 9, col: 10 },   // Berlin outpost (enter)
      { row: 10, col: 10 },  // Berlin center (intra-city, free)
      { row: 11, col: 10 },  // Berlin outpost (intra-city, free)
      { row: 12, col: 10 },  // outside (exit)
    ];
    // Edges: outside->outpost (1), outpost->center (0), center->outpost (0), outpost->outside (1) = 2
    expect(computeEffectivePathLength(path, lookup)).toBe(2);
  });

  it('handles a path with mixed intra-city and external segments', () => {
    // outside -> Berlin outpost -> Berlin center -> Berlin outpost -> outside -> outside
    const path = [
      { row: 8, col: 10 },   // outside
      { row: 9, col: 10 },   // Berlin outpost
      { row: 10, col: 10 },  // Berlin center
      { row: 10, col: 11 },  // Berlin outpost
      { row: 12, col: 12 },  // outside
      { row: 13, col: 12 },  // outside
    ];
    // Edges: 1 + 0 + 0 + 1 + 1 = 3
    expect(computeEffectivePathLength(path, lookup)).toBe(3);
  });

  it('returns 0 for a single-point path', () => {
    const path = [{ row: 10, col: 10 }];
    expect(computeEffectivePathLength(path, lookup)).toBe(0);
  });

  it('returns 0 for an empty path', () => {
    expect(computeEffectivePathLength([], lookup)).toBe(0);
  });
});
