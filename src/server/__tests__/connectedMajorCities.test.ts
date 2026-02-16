/**
 * Tests for connectedMajorCities — server-side utility to count major cities
 * connected by a player's track network.
 */

import { TrackSegment, TerrainType } from '../../shared/types/GameTypes';
import { MajorCityGroup, FerryEdge } from '../../shared/services/majorCityGroups';

// Mock the shared service before import
jest.mock('../../shared/services/majorCityGroups');

import { getMajorCityGroups, getFerryEdges } from '../../shared/services/majorCityGroups';
import { getConnectedMajorCityCount } from '../services/ai/connectedMajorCities';

const mockGetMajorCityGroups = getMajorCityGroups as jest.Mock;
const mockGetFerryEdges = getFerryEdges as jest.Mock;

/** Helper to create a TrackSegment — only row/col are used by the algorithm. */
function seg(fromRow: number, fromCol: number, toRow: number, toCol: number): TrackSegment {
  return {
    from: { x: 0, y: 0, row: fromRow, col: fromCol, terrain: TerrainType.Clear },
    to: { x: 0, y: 0, row: toRow, col: toCol, terrain: TerrainType.Clear },
    cost: 1,
  };
}

// Standard mock city groups used across most tests
const standardCityGroups: MajorCityGroup[] = [
  { cityName: 'Paris', center: { row: 20, col: 10 }, outposts: [{ row: 20, col: 11 }, { row: 21, col: 10 }] },
  { cityName: 'Berlin', center: { row: 15, col: 30 }, outposts: [{ row: 15, col: 31 }] },
  { cityName: 'London', center: { row: 10, col: 5 }, outposts: [{ row: 10, col: 6 }] },
  { cityName: 'Madrid', center: { row: 40, col: 8 }, outposts: [] },
  { cityName: 'Roma', center: { row: 35, col: 25 }, outposts: [{ row: 35, col: 26 }] },
  { cityName: 'Wien', center: { row: 25, col: 35 }, outposts: [] },
  { cityName: 'Amsterdam', center: { row: 8, col: 15 }, outposts: [] },
  { cityName: 'Bruxelles', center: { row: 12, col: 12 }, outposts: [] },
];

beforeEach(() => {
  mockGetMajorCityGroups.mockReturnValue(standardCityGroups);
  mockGetFerryEdges.mockReturnValue([]);
});

afterEach(() => {
  jest.clearAllMocks();
});

describe('getConnectedMajorCityCount', () => {
  it('returns 0 for empty segments', () => {
    expect(getConnectedMajorCityCount([])).toBe(0);
  });

  it('returns 1 when track touches a single major city', () => {
    // Track goes through Paris center
    const segments = [seg(20, 10, 20, 9)];
    expect(getConnectedMajorCityCount(segments)).toBe(1);
  });

  it('returns 1 when track touches only an outpost of a major city', () => {
    // Track goes through Paris outpost (20,11) not center
    const segments = [seg(20, 11, 19, 11)];
    expect(getConnectedMajorCityCount(segments)).toBe(1);
  });

  it('returns 2 when two cities are connected', () => {
    // Paris center to Berlin center via intermediate point
    const segments = [
      seg(20, 10, 18, 15),
      seg(18, 15, 15, 30),
    ];
    expect(getConnectedMajorCityCount(segments)).toBe(2);
  });

  it('counts all cities in a linear chain', () => {
    // Paris -> Berlin -> London -> Madrid (4 cities)
    const segments = [
      seg(20, 10, 15, 30), // Paris -> Berlin
      seg(15, 30, 10, 5),  // Berlin -> London
      seg(10, 5, 40, 8),   // London -> Madrid
    ];
    expect(getConnectedMajorCityCount(segments)).toBe(4);
  });

  it('returns 7+ for a fully connected 7-city network', () => {
    const segments = [
      seg(20, 10, 15, 30), // Paris -> Berlin
      seg(15, 30, 10, 5),  // Berlin -> London
      seg(10, 5, 40, 8),   // London -> Madrid
      seg(40, 8, 35, 25),  // Madrid -> Roma
      seg(35, 25, 25, 35), // Roma -> Wien
      seg(25, 35, 8, 15),  // Wien -> Amsterdam
    ];
    expect(getConnectedMajorCityCount(segments)).toBeGreaterThanOrEqual(7);
  });

  describe('disconnected components', () => {
    it('returns the count from the largest component', () => {
      // Component 1: Paris-Berlin (2 cities)
      // Component 2: London alone (1 city)
      const segments = [
        seg(20, 10, 15, 30), // Paris -> Berlin
        seg(10, 5, 10, 4),   // London -> nowhere
      ];
      expect(getConnectedMajorCityCount(segments)).toBe(2);
    });

    it('handles two equal-sized components by picking one', () => {
      // Component 1: Paris-Berlin (2 cities)
      // Component 2: Roma-Wien (2 cities)
      const segments = [
        seg(20, 10, 15, 30), // Paris -> Berlin
        seg(35, 25, 25, 35), // Roma -> Wien
      ];
      // Either component has 2 cities — should return 2
      expect(getConnectedMajorCityCount(segments)).toBe(2);
    });

    it('ignores track segments that touch no major cities', () => {
      // Track in the middle of nowhere
      const segments = [seg(50, 50, 51, 50)];
      expect(getConnectedMajorCityCount(segments)).toBe(0);
    });
  });

  describe('implicit major city connectivity', () => {
    it('connects tracks entering the same city via different outposts', () => {
      // Track 1 enters Paris center (20,10), track 2 enters Paris outpost (21,10)
      // They should be connected via the city's internal rail network
      const segments = [
        seg(20, 9, 20, 10),  // west -> Paris center
        seg(20, 10, 15, 30), // Paris center -> Berlin
        seg(22, 10, 21, 10), // south -> Paris outpost
        seg(21, 10, 40, 8),  // Paris outpost -> Madrid
      ];
      // Paris center and outpost are implicitly connected, so Berlin+Paris+Madrid = 3
      expect(getConnectedMajorCityCount(segments)).toBe(3);
    });

    it('does not create implicit edges when only one outpost is in the graph', () => {
      // Only one Paris point in graph — no implicit edges needed
      const segments = [seg(20, 10, 20, 9)]; // Paris center only
      expect(getConnectedMajorCityCount(segments)).toBe(1);
    });
  });

  describe('ferry connections', () => {
    it('connects components when both ferry endpoints are in the graph', () => {
      mockGetFerryEdges.mockReturnValue([
        { name: 'Channel', pointA: { row: 10, col: 6 }, pointB: { row: 12, col: 12 }, cost: 8 } as FerryEdge,
      ]);

      // London (outpost at 10,6) and Bruxelles (center at 12,12) are on opposite sides of a ferry
      // Each has track but they're not connected by track
      const segments = [
        seg(10, 5, 10, 6),   // London center -> London outpost (ferry port)
        seg(12, 12, 12, 13), // Bruxelles center -> east
      ];

      // Ferry connects London outpost to Bruxelles → 2 cities
      expect(getConnectedMajorCityCount(segments)).toBe(2);
    });

    it('does not connect via ferry when only one endpoint is in the graph', () => {
      mockGetFerryEdges.mockReturnValue([
        { name: 'Channel', pointA: { row: 10, col: 6 }, pointB: { row: 50, col: 50 }, cost: 8 } as FerryEdge,
      ]);

      // London outpost at ferry port, but other side has no track
      const segments = [seg(10, 5, 10, 6)];

      expect(getConnectedMajorCityCount(segments)).toBe(1);
    });

    it('connects multi-city networks via ferry bridge', () => {
      mockGetFerryEdges.mockReturnValue([
        { name: 'Channel', pointA: { row: 15, col: 31 }, pointB: { row: 8, col: 15 }, cost: 8 } as FerryEdge,
      ]);

      // Network 1: Paris -> Berlin (outpost at 15,31 = ferry endpoint)
      // Network 2: Amsterdam (center at 8,15 = ferry endpoint) -> Bruxelles
      const segments = [
        seg(20, 10, 15, 30), // Paris -> Berlin center
        seg(15, 30, 15, 31), // Berlin center -> Berlin outpost (ferry port)
        seg(8, 15, 12, 12),  // Amsterdam -> Bruxelles
      ];

      // Ferry connects Berlin outpost to Amsterdam → all 4 cities in one component
      expect(getConnectedMajorCityCount(segments)).toBe(4);
    });
  });

  describe('edge cases', () => {
    it('handles single-segment track that spans two cities', () => {
      // Direct segment from Paris to Berlin (unusual but valid)
      const segments = [seg(20, 10, 15, 30)];
      expect(getConnectedMajorCityCount(segments)).toBe(2);
    });

    it('handles duplicate segments gracefully', () => {
      const segments = [
        seg(20, 10, 15, 30),
        seg(20, 10, 15, 30), // duplicate
      ];
      expect(getConnectedMajorCityCount(segments)).toBe(2);
    });

    it('handles no major city groups', () => {
      mockGetMajorCityGroups.mockReturnValue([]);
      const segments = [seg(20, 10, 15, 30)];
      expect(getConnectedMajorCityCount(segments)).toBe(0);
    });

    it('handles circular track network', () => {
      // Ring: Paris -> Berlin -> Wien -> Roma -> Paris
      const segments = [
        seg(20, 10, 15, 30), // Paris -> Berlin
        seg(15, 30, 25, 35), // Berlin -> Wien
        seg(25, 35, 35, 25), // Wien -> Roma
        seg(35, 25, 20, 10), // Roma -> Paris
      ];
      expect(getConnectedMajorCityCount(segments)).toBe(4);
    });
  });
});
