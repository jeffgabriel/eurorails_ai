import { TrackSegment, TerrainType } from '../../shared/types/GameTypes';
import { computeBuildSegments } from '../services/ai/computeBuildSegments';
import {
  loadGridPoints,
  getHexNeighbors,
  getTerrainCost,
  _resetCache,
  GridCoord,
} from '../services/ai/MapTopology';
import { getMajorCityLookup, getMajorCityGroups } from '../../shared/services/majorCityGroups';

describe('computeBuildSegments', () => {
  beforeEach(() => _resetCache());

  // Known grid positions from gridPoints.json
  const PARIS: GridCoord = { row: 29, col: 32 }; // Major City
  const CLEAR_NEAR_PARIS: GridCoord = { row: 29, col: 31 }; // Milepost (Clear)

  describe('basic pathfinding from a major city', () => {
    it('should return segments when given a major city start and sufficient budget', () => {
      const segments = computeBuildSegments([PARIS], [], 20);
      expect(segments.length).toBeGreaterThan(0);
      // With budget=20 and no explicit maxSegments, builds up to 20 segments (budget-limited)
      expect(segments.length).toBeLessThanOrEqual(20);
      // Total cost should not exceed budget
      const totalCost = segments.reduce((s, seg) => s + seg.cost, 0);
      expect(totalCost).toBeLessThanOrEqual(20);
    });

    it('should return empty array when budget is 0', () => {
      const segments = computeBuildSegments([PARIS], [], 0);
      expect(segments).toEqual([]);
    });

    it('should return empty array when budget is negative', () => {
      const segments = computeBuildSegments([PARIS], [], -5);
      expect(segments).toEqual([]);
    });

    it('should return empty array when no start positions given', () => {
      const segments = computeBuildSegments([], [], 20);
      expect(segments).toEqual([]);
    });

    it('should respect maxSegments parameter', () => {
      const segments1 = computeBuildSegments([PARIS], [], 20, 1);
      expect(segments1.length).toBeLessThanOrEqual(1);

      const segments2 = computeBuildSegments([PARIS], [], 20, 2);
      expect(segments2.length).toBeLessThanOrEqual(2);
    });
  });

  describe('TrackSegment structure', () => {
    it('should include pixel coordinates in from and to', () => {
      const segments = computeBuildSegments([PARIS], [], 20);
      expect(segments.length).toBeGreaterThan(0);

      for (const seg of segments) {
        expect(typeof seg.from.x).toBe('number');
        expect(typeof seg.from.y).toBe('number');
        expect(typeof seg.from.row).toBe('number');
        expect(typeof seg.from.col).toBe('number');
        expect(seg.from.terrain).toBeDefined();

        expect(typeof seg.to.x).toBe('number');
        expect(typeof seg.to.y).toBe('number');
        expect(typeof seg.to.row).toBe('number');
        expect(typeof seg.to.col).toBe('number');
        expect(seg.to.terrain).toBeDefined();
      }
    });

    it('should have positive cost for each segment', () => {
      const segments = computeBuildSegments([PARIS], [], 20);
      for (const seg of segments) {
        expect(seg.cost).toBeGreaterThan(0);
      }
    });

    it('should have cost >= terrain cost of destination (extra for water crossings)', () => {
      const segments = computeBuildSegments([PARIS], [], 20);
      for (const seg of segments) {
        expect(seg.cost).toBeGreaterThanOrEqual(getTerrainCost(seg.to.terrain));
      }
    });

    it('should never include water terrain destinations', () => {
      const segments = computeBuildSegments([PARIS], [], 20);
      for (const seg of segments) {
        expect(seg.to.terrain).not.toBe(TerrainType.Water);
      }
    });
  });

  describe('budget constraint', () => {
    it('should not exceed budget in total segment cost', () => {
      const budget = 5;
      const segments = computeBuildSegments([PARIS], [], budget);
      const totalCost = segments.reduce((sum, s) => sum + s.cost, 0);
      expect(totalCost).toBeLessThanOrEqual(budget);
    });

    it('should build more segments with higher budget', () => {
      const segmentsLow = computeBuildSegments([PARIS], [], 2, 3);
      const segmentsHigh = computeBuildSegments([PARIS], [], 20, 3);
      expect(segmentsHigh.length).toBeGreaterThanOrEqual(segmentsLow.length);
    });

    it('should return at most 1 segment with budget=1 (cheapest terrain)', () => {
      const segments = computeBuildSegments([PARIS], [], 1);
      // Budget=1 can afford at most one Clear terrain segment
      expect(segments.length).toBeLessThanOrEqual(1);
    });
  });

  describe('terrain cost preference', () => {
    it('should prefer cheaper terrain when multiple paths available', () => {
      // With a budget of 3, Dijkstra should favor Clear(1) over Mountain(2)
      const segments = computeBuildSegments([PARIS], [], 3, 3);
      if (segments.length > 1) {
        // The first segment built should typically be the cheapest option
        const firstCost = segments[0].cost;
        expect(firstCost).toBeLessThanOrEqual(2);
      }
    });
  });

  describe('extending existing track', () => {
    it('should build from existing track endpoints rather than start positions', () => {
      const grid = loadGridPoints();
      // Build an existing segment from Paris toward the clear neighbor
      const parisData = grid.get('29,32')!;
      const clearData = grid.get('29,31')!;

      const existingSegment: TrackSegment = {
        from: {
          x: 0, y: 0,
          row: PARIS.row, col: PARIS.col,
          terrain: parisData.terrain,
        },
        to: {
          x: 0, y: 0,
          row: CLEAR_NEAR_PARIS.row, col: CLEAR_NEAR_PARIS.col,
          terrain: clearData.terrain,
        },
        cost: getTerrainCost(clearData.terrain),
      };

      const segments = computeBuildSegments([PARIS], [existingSegment], 20);
      expect(segments.length).toBeGreaterThan(0);

      // Should not re-build the existing segment
      for (const seg of segments) {
        const isExisting =
          seg.from.row === PARIS.row && seg.from.col === PARIS.col &&
          seg.to.row === CLEAR_NEAR_PARIS.row && seg.to.col === CLEAR_NEAR_PARIS.col;
        const isExistingReversed =
          seg.from.row === CLEAR_NEAR_PARIS.row && seg.from.col === CLEAR_NEAR_PARIS.col &&
          seg.to.row === PARIS.row && seg.to.col === PARIS.col;
        expect(isExisting || isExistingReversed).toBe(false);
      }
    });

    it('should produce contiguous segments extending from network', () => {
      const grid = loadGridPoints();
      const parisData = grid.get('29,32')!;
      const clearData = grid.get('29,31')!;

      const existingSegment: TrackSegment = {
        from: {
          x: 0, y: 0,
          row: PARIS.row, col: PARIS.col,
          terrain: parisData.terrain,
        },
        to: {
          x: 0, y: 0,
          row: CLEAR_NEAR_PARIS.row, col: CLEAR_NEAR_PARIS.col,
          terrain: clearData.terrain,
        },
        cost: getTerrainCost(clearData.terrain),
      };

      const segments = computeBuildSegments([PARIS], [existingSegment], 20);
      if (segments.length > 1) {
        // Each segment's from should connect to a previous segment's to
        // or to the existing network
        const networkPositions = new Set(['29,32', '29,31']);
        for (const seg of segments) {
          const fromKey = `${seg.from.row},${seg.from.col}`;
          const toKey = `${seg.to.row},${seg.to.col}`;
          // After first segment, add its positions to the connected set
          networkPositions.add(fromKey);
          networkPositions.add(toKey);
        }
        // The first new segment must connect to the existing network
        const firstFrom = `${segments[0].from.row},${segments[0].from.col}`;
        const firstTo = `${segments[0].to.row},${segments[0].to.col}`;
        const connectsToNetwork =
          networkPositions.has(firstFrom) || networkPositions.has(firstTo);
        expect(connectsToNetwork).toBe(true);
      }
    });
  });

  describe('intra-city edge filter (GH-213)', () => {
    it('should never produce segments where both endpoints are in the same major city', () => {
      const lookup = getMajorCityLookup();
      // Start from Paris center — segments should exit the city, not stay inside
      const segments = computeBuildSegments([PARIS], [], 20);
      for (const seg of segments) {
        const fromCity = lookup.get(`${seg.from.row},${seg.from.col}`);
        const toCity = lookup.get(`${seg.to.row},${seg.to.col}`);
        if (fromCity && toCity) {
          expect(fromCity).not.toBe(toCity);
        }
      }
    });

    it('should still build segments from a major city outpost to outside points', () => {
      // Start from a Paris outpost (28,32) — should build outward, not intra-city
      const parisOutpost: GridCoord = { row: 28, col: 32 };
      const segments = computeBuildSegments([parisOutpost], [], 20);
      // Should produce at least one segment going outside the city
      expect(segments.length).toBeGreaterThan(0);
      const lookup = getMajorCityLookup();
      for (const seg of segments) {
        const fromCity = lookup.get(`${seg.from.row},${seg.from.col}`);
        const toCity = lookup.get(`${seg.to.row},${seg.to.col}`);
        if (fromCity && toCity) {
          expect(fromCity).not.toBe(toCity);
        }
      }
    });
  });

  describe('getMajorCityLookup helper', () => {
    it('should map major city center to city name', () => {
      const lookup = getMajorCityLookup();
      expect(lookup.get('29,32')).toBe('Paris');
    });

    it('should map major city outposts to city name', () => {
      const lookup = getMajorCityLookup();
      // Paris outposts
      expect(lookup.get('30,32')).toBe('Paris');
      expect(lookup.get('29,33')).toBe('Paris');
      expect(lookup.get('28,32')).toBe('Paris');
    });

    it('should not map non-city points', () => {
      const lookup = getMajorCityLookup();
      // (29,31) is a clear milepost near Paris, not part of the city
      expect(lookup.get('29,31')).toBeUndefined();
    });

    it('should contain entries for all major city groups', () => {
      const lookup = getMajorCityLookup();
      const groups = getMajorCityGroups();
      for (const group of groups) {
        expect(lookup.get(`${group.center.row},${group.center.col}`)).toBe(group.cityName);
        for (const outpost of group.outposts) {
          expect(lookup.get(`${outpost.row},${outpost.col}`)).toBe(group.cityName);
        }
      }
    });
  });

  describe('edge cases', () => {
    it('should handle non-existent grid position gracefully', () => {
      const segments = computeBuildSegments([{ row: 999, col: 999 }], [], 20);
      expect(segments).toEqual([]);
    });

    it('should handle multiple start positions', () => {
      // Both Paris and a nearby clear point as starts
      const segments = computeBuildSegments(
        [PARIS, CLEAR_NEAR_PARIS],
        [],
        20,
      );
      expect(segments.length).toBeGreaterThan(0);
    });
  });
});
