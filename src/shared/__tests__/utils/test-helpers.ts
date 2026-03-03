import type { MajorCityGroup } from '../../services/majorCityGroups';

/**
 * Creates a mock MajorCityGroup for testing.
 * Defaults to a Berlin-like city with center at (10,10) and 4 outposts.
 */
export function createMockMajorCityGroup(
  overrides: Partial<MajorCityGroup> = {},
): MajorCityGroup {
  return {
    cityName: 'Berlin',
    center: { row: 10, col: 10 },
    outposts: [
      { row: 9, col: 10 },
      { row: 11, col: 10 },
      { row: 10, col: 9 },
      { row: 10, col: 11 },
    ],
    ...overrides,
  };
}

/**
 * Builds a MajorCityLookup map from an array of MajorCityGroups.
 * Maps each "row,col" key to its city name for center + all outposts.
 */
export function buildMockMajorCityLookup(
  groups: MajorCityGroup[],
): Map<string, string> {
  const lookup = new Map<string, string>();
  for (const group of groups) {
    lookup.set(`${group.center.row},${group.center.col}`, group.cityName);
    for (const outpost of group.outposts) {
      lookup.set(`${outpost.row},${outpost.col}`, group.cityName);
    }
  }
  return lookup;
}

/**
 * Standard set of mock major city groups for tests.
 * Includes Berlin (center 10,10) and Vienna (center 30,30).
 */
export const MOCK_MAJOR_CITY_GROUPS: MajorCityGroup[] = [
  createMockMajorCityGroup(),
  createMockMajorCityGroup({
    cityName: 'Vienna',
    center: { row: 30, col: 30 },
    outposts: [
      { row: 29, col: 30 },
      { row: 31, col: 30 },
      { row: 30, col: 29 },
      { row: 30, col: 31 },
    ],
  }),
];

/**
 * Pre-built lookup from MOCK_MAJOR_CITY_GROUPS.
 */
export const MOCK_MAJOR_CITY_LOOKUP = buildMockMajorCityLookup(
  MOCK_MAJOR_CITY_GROUPS,
);
