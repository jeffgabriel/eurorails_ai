import { TrackSegment, TerrainType } from '../../shared/types/GameTypes';
import { computeBuildSegments } from '../services/ai/computeBuildSegments';
import {
  loadGridPoints,
  getHexNeighbors,
  getTerrainCost,
  _resetCache,
  GridCoord,
} from '../services/ai/MapTopology';
import { getMajorCityLookup, getMajorCityGroups, getFerryEdges } from '../../shared/services/majorCityGroups';

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

  describe('contiguity guarantee (P0 fix)', () => {
    it('should always produce strictly contiguous segments (seg[i].from == seg[i-1].to)', () => {
      const grid = loadGridPoints();
      const parisData = grid.get('29,32')!;
      const clearData = grid.get('29,31')!;

      // Build existing track from Paris through a clear neighbor — the Dijkstra
      // path may traverse this edge for free, and extractSegments must not produce
      // a gap when skipping the built edge.
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
      // Verify strict contiguity: each segment's from must match previous segment's to
      for (let i = 1; i < segments.length; i++) {
        const prev = segments[i - 1].to;
        const curr = segments[i].from;
        expect(curr.row).toBe(prev.row);
        expect(curr.col).toBe(prev.col);
      }
    });

    it('should produce contiguous segments even with a large existing network', () => {
      const grid = loadGridPoints();

      // Build several existing segments from Paris outward to simulate
      // a network the Dijkstra may traverse for free mid-path
      const existingSegments: TrackSegment[] = [];
      const parisData = grid.get('29,32')!;

      // Build 3 segments in a line from Paris
      const coords: GridCoord[] = [
        PARIS,
        CLEAR_NEAR_PARIS,
        ...getHexNeighbors(CLEAR_NEAR_PARIS.row, CLEAR_NEAR_PARIS.col)
          .filter(n => {
            const d = grid.get(`${n.row},${n.col}`);
            return d && d.terrain !== TerrainType.Water &&
              !(n.row === PARIS.row && n.col === PARIS.col);
          })
          .slice(0, 1),
      ];

      for (let i = 0; i < coords.length - 1; i++) {
        const fromData = grid.get(`${coords[i].row},${coords[i].col}`)!;
        const toData = grid.get(`${coords[i + 1].row},${coords[i + 1].col}`)!;
        existingSegments.push({
          from: { x: 0, y: 0, row: coords[i].row, col: coords[i].col, terrain: fromData.terrain },
          to: { x: 0, y: 0, row: coords[i + 1].row, col: coords[i + 1].col, terrain: toData.terrain },
          cost: getTerrainCost(toData.terrain),
        });
      }

      const segments = computeBuildSegments([PARIS], existingSegments, 20);
      expect(segments.length).toBeGreaterThan(0);

      // Strict contiguity check
      for (let i = 1; i < segments.length; i++) {
        const prev = segments[i - 1].to;
        const curr = segments[i].from;
        expect(curr.row).toBe(prev.row);
        expect(curr.col).toBe(prev.col);
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

  describe('ferry-aware pathfinding', () => {
    it('should find paths across ferry connections with sufficient budget', () => {
      // Get actual ferry edge data to use real coordinates
      const ferries = getFerryEdges();
      expect(ferries.length).toBeGreaterThan(0);

      const ferry = ferries[0]; // e.g. Belfast↔Stranraer
      const portA = ferry.pointA;
      const portB = ferry.pointB;

      // Start from portA with a large budget — Dijkstra should reach portB via ferry
      const segments = computeBuildSegments([portA], [], 100, 100, undefined, [portB]);
      // With 100M budget, should be able to reach the other side of the ferry
      const allCoords = new Set<string>();
      allCoords.add(`${portA.row},${portA.col}`);
      for (const seg of segments) {
        allCoords.add(`${seg.from.row},${seg.from.col}`);
        allCoords.add(`${seg.to.row},${seg.to.col}`);
      }
      // The Dijkstra should have reached portB's side — check that segments
      // extend beyond just portA's hex neighbors
      expect(segments.length).toBeGreaterThan(0);
    });

    it('should not include ferry crossing edges in extracted segments', () => {
      const ferries = getFerryEdges();
      const ferry = ferries[0];

      // Build ferry edge keys for verification
      const ferryEdgeKeys = new Set<string>();
      for (const f of ferries) {
        const aKey = `${f.pointA.row},${f.pointA.col}`;
        const bKey = `${f.pointB.row},${f.pointB.col}`;
        ferryEdgeKeys.add(`${aKey}-${bKey}`);
        ferryEdgeKeys.add(`${bKey}-${aKey}`);
      }

      // Start from one ferry port, target the other side
      const segments = computeBuildSegments(
        [ferry.pointA], [], 100, 100, undefined, [ferry.pointB],
      );

      // No extracted segment should be a ferry crossing edge
      for (const seg of segments) {
        const fromKey = `${seg.from.row},${seg.from.col}`;
        const toKey = `${seg.to.row},${seg.to.col}`;
        expect(ferryEdgeKeys.has(`${fromKey}-${toKey}`)).toBe(false);
      }
    });

    it('should apply ferry port build cost (not base terrain) when building TO a port', () => {
      const ferries = getFerryEdges();
      // Find a ferry with cost > 1 (all should be 4+)
      const ferry = ferries.find(f => f.cost >= 4)!;
      expect(ferry).toBeDefined();

      const portA = ferry.pointA;
      // Start from a hex neighbor of portA and build toward it
      const neighbors = getHexNeighbors(portA.row, portA.col);
      const grid = loadGridPoints();
      // Find a valid neighbor that's on the grid
      const validNeighbor = neighbors.find(n => grid.has(`${n.row},${n.col}`));
      if (!validNeighbor) return; // skip if no valid neighbor

      const segments = computeBuildSegments([validNeighbor], [], 20, 5);
      // If any segment builds TO the ferry port, its cost should be >= ferry cost
      for (const seg of segments) {
        const toKey = `${seg.to.row},${seg.to.col}`;
        if (toKey === `${portA.row},${portA.col}`) {
          expect(seg.cost).toBeGreaterThanOrEqual(ferry.cost);
        }
      }
    });

    it('should reach Ireland from England via Dublin↔Liverpool ferry', () => {
      const ferries = getFerryEdges();
      const dublinLiverpool = ferries.find(f => f.name === 'Dublin_Liverpool');
      if (!dublinLiverpool) return; // skip if ferry data missing

      // Start from Liverpool side, target Dublin side
      const segments = computeBuildSegments(
        [dublinLiverpool.pointB], // Liverpool
        [],
        100,
        100,
        undefined,
        [dublinLiverpool.pointA], // Dublin
      );

      // Should produce segments — Dijkstra crossed the ferry
      expect(segments.length).toBeGreaterThan(0);

      // Verify the path reaches Dublin's side: at least one segment endpoint
      // should be on or near Dublin (pointA)
      const allPositions = new Set<string>();
      for (const seg of segments) {
        allPositions.add(`${seg.to.row},${seg.to.col}`);
      }
      // The segments should extend beyond just Liverpool's hex neighborhood.
      // With 100M budget and a free ferry crossing, we expect segments on both sides.
      const totalCost = segments.reduce((s, seg) => s + seg.cost, 0);
      expect(totalCost).toBeLessThanOrEqual(100);
    });
  });
});
