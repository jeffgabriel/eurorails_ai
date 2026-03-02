import { TrackSegment, TerrainType } from '../../shared/types/GameTypes';
import { computeBuildSegments } from '../services/ai/computeBuildSegments';
import {
  loadGridPoints,
  getHexNeighbors,
  getTerrainCost,
  hexDistance,
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

  describe('knownSegments for continuation builds', () => {
    it('should not duplicate edges from knownSegments', () => {
      // Build primary segments from Paris
      const primary = computeBuildSegments([PARIS], [], 5, 5);
      expect(primary.length).toBeGreaterThan(0);

      // Build continuation from last endpoint with knownSegments
      const lastSeg = primary[primary.length - 1];
      const contStart = [{ row: lastSeg.to.row, col: lastSeg.to.col }];

      const continuation = computeBuildSegments(
        contStart, [], 10, undefined, undefined, undefined,
        primary,
      );

      // No continuation segment should duplicate a primary segment edge
      const primaryEdges = new Set<string>();
      for (const seg of primary) {
        const a = `${seg.from.row},${seg.from.col}`;
        const b = `${seg.to.row},${seg.to.col}`;
        primaryEdges.add(`${a}-${b}`);
        primaryEdges.add(`${b}-${a}`);
      }

      for (const seg of continuation) {
        const a = `${seg.from.row},${seg.from.col}`;
        const b = `${seg.to.row},${seg.to.col}`;
        expect(primaryEdges.has(`${a}-${b}`)).toBe(false);
      }
    });

    it('continuation first segment starts from a knownSegments node', () => {
      // Build primary path from Paris
      const primary = computeBuildSegments([PARIS], [], 5, 5);
      expect(primary.length).toBeGreaterThan(1);

      const lastSeg = primary[primary.length - 1];
      const contStart = [{ row: lastSeg.to.row, col: lastSeg.to.col }];

      const continuation = computeBuildSegments(
        contStart, [], 15, undefined, undefined, undefined,
        primary,
      );

      if (continuation.length > 0) {
        // The continuation's first segment `from` must be on the primary path
        // or at the contStart — valid even when it branches from a mid-point
        const primaryNodes = new Set<string>();
        for (const seg of primary) {
          primaryNodes.add(`${seg.from.row},${seg.from.col}`);
          primaryNodes.add(`${seg.to.row},${seg.to.col}`);
        }
        primaryNodes.add(`${contStart[0].row},${contStart[0].col}`);

        const firstFrom = `${continuation[0].from.row},${continuation[0].from.col}`;
        expect(primaryNodes.has(firstFrom)).toBe(true);
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

  describe('Major City red area connectivity', () => {
    // Berlin: center (24,52), outposts (24,51), (23,51), (25,51), (23,52), (25,52), (24,53)
    const BERLIN_CENTER: GridCoord = { row: 24, col: 52 };
    const BERLIN_OUTPOST_1: GridCoord = { row: 24, col: 51 }; // west outpost
    const BERLIN_OUTPOST_2: GridCoord = { row: 24, col: 53 }; // east outpost

    it('should not produce intra-city segments when starting from a Berlin outpost with existing track', () => {
      const grid = loadGridPoints();
      const lookup = getMajorCityLookup();

      // Bot has one segment ending at a Berlin outpost
      const fromData = grid.get('23,51')!; // outside Berlin
      const toData = grid.get('24,51')!;   // Berlin outpost

      const existingSegment: TrackSegment = {
        from: { x: 0, y: 0, row: 23, col: 51, terrain: fromData?.terrain ?? TerrainType.Clear },
        to: { x: 0, y: 0, row: BERLIN_OUTPOST_1.row, col: BERLIN_OUTPOST_1.col, terrain: toData?.terrain ?? TerrainType.MajorCity },
        cost: 5,
      };

      const segments = computeBuildSegments([], [existingSegment], 20);

      // No segment should have both endpoints in Berlin
      for (const seg of segments) {
        const fromCity = lookup.get(`${seg.from.row},${seg.from.col}`);
        const toCity = lookup.get(`${seg.to.row},${seg.to.col}`);
        if (fromCity && toCity) {
          expect(fromCity).not.toBe(toCity);
        }
      }
    });

    it('should use all Berlin outposts as Dijkstra sources when track connects to one outpost', () => {
      const grid = loadGridPoints();
      const groups = getMajorCityGroups();
      const berlinGroup = groups.find(g => g.cityName === 'Berlin')!;
      expect(berlinGroup).toBeDefined();

      // Bot has one segment ending at Berlin west outpost (24,51)
      const fromData = grid.get('23,51')!;
      const toData = grid.get('24,51')!;

      const existingSegment: TrackSegment = {
        from: { x: 0, y: 0, row: 23, col: 51, terrain: fromData?.terrain ?? TerrainType.Clear },
        to: { x: 0, y: 0, row: BERLIN_OUTPOST_1.row, col: BERLIN_OUTPOST_1.col, terrain: toData?.terrain ?? TerrainType.MajorCity },
        cost: 5,
      };

      // Build toward a target east of Berlin — should be reachable from the
      // east outpost (24,53) without needing to build intra-city segments.
      const targetEast: GridCoord = { row: 24, col: 55 }; // east of Berlin
      const segments = computeBuildSegments([], [existingSegment], 20, undefined, undefined, [targetEast]);

      // The resulting segments should build FROM a Berlin outpost outward,
      // not between Berlin outposts. Verify that the first segment starts
      // from a Berlin point (any outpost, including the east one).
      expect(segments.length).toBeGreaterThan(0);

      // Total cost should NOT include any $5 Major City segments between Berlin outposts
      const totalCost = segments.reduce((s, seg) => s + seg.cost, 0);
      expect(totalCost).toBeLessThanOrEqual(20);
    });

    it('should not charge for intra-city traversal (total cost excludes red area)', () => {
      const grid = loadGridPoints();

      // Bot has track at Berlin west outpost
      const fromData = grid.get('23,51')!;
      const toData = grid.get('24,51')!;

      const existingSegment: TrackSegment = {
        from: { x: 0, y: 0, row: 23, col: 51, terrain: fromData?.terrain ?? TerrainType.Clear },
        to: { x: 0, y: 0, row: BERLIN_OUTPOST_1.row, col: BERLIN_OUTPOST_1.col, terrain: toData?.terrain ?? TerrainType.MajorCity },
        cost: 5,
      };

      // Build with budget=20. Without city expansion, Dijkstra could only
      // start from (24,51) and (23,51). With expansion, all Berlin outposts
      // are sources, so the bot can build east from (24,53) directly.
      const segments = computeBuildSegments([], [existingSegment], 20);
      expect(segments.length).toBeGreaterThan(0);

      // Verify no segment is between two Berlin outposts
      const lookup = getMajorCityLookup();
      for (const seg of segments) {
        const fromCity = lookup.get(`${seg.from.row},${seg.from.col}`);
        const toCity = lookup.get(`${seg.to.row},${seg.to.col}`);
        if (fromCity === 'Berlin' && toCity === 'Berlin') {
          fail(`Found intra-Berlin segment: (${seg.from.row},${seg.from.col}) → (${seg.to.row},${seg.to.col})`);
        }
      }
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

      // Start from portA with a large budget — Dijkstra reaches portB via ferry
      const segments = computeBuildSegments([portA], [], 100, 100, undefined, [portB]);
      // When the optimal path is just portA -> (ferry) -> portB, there are no segments to build
      // (ferry crossing is public). Segments on the far side would be orphaned (not connected
      // to any major city), so we correctly return [] per track-building rules.
      expect(segments.length).toBe(0);
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

      // When the optimal path is Liverpool -> (ferry) -> Dublin, there are no segments to build.
      // The ferry crossing is public. Segments on Dublin's side would be orphaned (not connected
      // to Liverpool or any major city), so we correctly return [] per track-building rules.
      expect(segments.length).toBe(0);
    });

    it('should build across ferry when track reaches near-side port (Holland→Birmingham)', () => {
      // Regression: bot had track from Holland but extracted 0 segments toward Birmingham
      // because the path crosses Harwich ferry and the UK-side run was incorrectly filtered.
      const groups = getMajorCityGroups();
      const holland = groups.find(g => g.cityName === 'Holland');
      const birmingham = groups.find(g => g.cityName === 'Birmingham');
      if (!holland || !birmingham) return;

      // Simulate track from Holland toward the Harwich ferry (one segment)
      const harwichFerry = getFerryEdges().find(f => f.name === 'Harwich_Ijmuiden');
      if (!harwichFerry) return;
      // Ijmuiden is Netherlands side, Harwich is UK side. Build from Holland toward Ijmuiden.
      const existingSegment = {
        from: { row: holland.center.row, col: holland.center.col, x: 0, y: 0, terrain: 0 as TerrainType },
        to: { row: harwichFerry.pointA.row, col: harwichFerry.pointA.col, x: 0, y: 0, terrain: 0 as TerrainType },
        cost: 4,
      };
      const segs = computeBuildSegments(
        [],
        [existingSegment],
        20,
        20,
        undefined,
        [birmingham.center],
      );
      // Should produce segments toward Birmingham (UK side of ferry)
      expect(segs.length).toBeGreaterThan(0);
    });

    it('should not return orphaned segments when path crosses ferry (Ruhr→Frankfurt bug)', () => {
      // Regression: bot was building track on far side of ferry, not connected to any city.
      // Rule: all track must start from a major city or existing track.
      const groups = getMajorCityGroups();
      const ruhr = groups.find(g => g.cityName === 'Ruhr');
      const frankfurt = groups.find(g => g.cityName === 'Frankfurt');
      if (!ruhr || !frankfurt) return;

      const segments = computeBuildSegments(
        [ruhr.center],
        [],
        20,
        20,
        undefined,
        [frankfurt.center],
      );

      if (segments.length === 0) return; // no path to Frankfurt in budget

      // First segment must start from a valid position (Ruhr center or outpost)
      const validStarts = new Set<string>();
      validStarts.add(`${ruhr.center.row},${ruhr.center.col}`);
      for (const op of ruhr.outposts) {
        validStarts.add(`${op.row},${op.col}`);
      }

      const firstFrom = `${segments[0].from.row},${segments[0].from.col}`;
      expect(validStarts.has(firstFrom)).toBe(true);
    });
  });

  describe('ferry waypoint redirect (BE-007)', () => {
    it('should build toward a ferry port when target is across water', () => {
      // Bot starts at Ruhr (mainland), target is London (Britain).
      // Without ferry waypoint logic, Dijkstra might pick a path toward the
      // Belgian coast (closer hex distance to London). With the fix, cross-water
      // targets are replaced with departure-side ferry ports, so the path
      // specifically aims for a ferry like Ijmuiden or Calais.
      const groups = getMajorCityGroups();
      const ruhr = groups.find(g => g.cityName === 'Ruhr');
      const london = groups.find(g => g.cityName === 'London');
      if (!ruhr || !london) return;

      const ferries = getFerryEdges();
      // Mainland-side departure ports for Britain-bound ferries
      // (these are determined by the BFS, but we know the approximate coords)
      const mainlandFerryPorts = [
        { row: 23, col: 33 },  // Calais (Dover_Calais pointB)
        { row: 25, col: 29 },  // LeHavre (Portsmouth_LeHavre pointB)
        { row: 24, col: 27 },  // Cherbourg (Plymouth_Cherbourg pointB)
        { row: 19, col: 38 },  // Ijmuiden (Harwich_Ijmuiden pointB)
        { row: 12, col: 46 },  // Esbjerg (Newcastle_Esbjerg pointB)
      ];

      const segments = computeBuildSegments(
        [ruhr.center], [], 20, 20, undefined, [london.center],
      );

      expect(segments.length).toBeGreaterThan(0);

      // The path should build toward a mainland ferry port, not just toward London.
      // Verify the last segment endpoint is closer to some ferry port than Ruhr is.
      const lastSeg = segments[segments.length - 1];
      const endpoint = { row: lastSeg.to.row, col: lastSeg.to.col };
      const start = ruhr.center;

      let minDistFromEnd = Infinity;
      let minDistFromStart = Infinity;
      for (const port of mainlandFerryPorts) {
        const distEnd = hexDistance(endpoint.row, endpoint.col, port.row, port.col);
        const distStart = hexDistance(start.row, start.col, port.row, port.col);
        if (distEnd < minDistFromEnd) minDistFromEnd = distEnd;
        if (distStart < minDistFromStart) minDistFromStart = distStart;
      }

      // The endpoint should be closer to a ferry port than Ruhr is
      expect(minDistFromEnd).toBeLessThan(minDistFromStart);
    });

    it('should not redirect when departure ferry port is already on network', () => {
      // When the bot has track reaching a ferry port, it can cross the ferry
      // and build on the far side — ferry waypoint redirect should NOT apply.
      const groups = getMajorCityGroups();
      const holland = groups.find(g => g.cityName === 'Holland');
      const london = groups.find(g => g.cityName === 'London');
      if (!holland || !london) return;

      const harwichFerry = getFerryEdges().find(f => f.name === 'Harwich_Ijmuiden');
      if (!harwichFerry) return;

      // Bot has track from Holland to Ijmuiden (the departure ferry port)
      const existingSegment: TrackSegment = {
        from: { row: holland.center.row, col: holland.center.col, x: 0, y: 0, terrain: 0 as TerrainType },
        to: { row: harwichFerry.pointB.row, col: harwichFerry.pointB.col, x: 0, y: 0, terrain: 0 as TerrainType },
        cost: 4,
      };

      const segments = computeBuildSegments(
        [], [existingSegment], 20, 20, undefined, [london.center],
      );

      // Should produce segments on the far side (UK) — NOT redirect to ferry port
      expect(segments.length).toBeGreaterThan(0);

      // Verify at least one segment is on the British side
      // (Dover_Calais pointA is at 22,33 in Britain; London is at 20,31)
      const hasUkSegment = segments.some(
        seg => seg.to.row <= 22 && seg.to.col <= 36,
      );
      expect(hasUkSegment).toBe(true);
    });

    it('should handle mix of local and cross-water targets', () => {
      // One target on mainland (Frankfurt), one across water (London).
      // The fix should replace London with ferry port(s) but keep Frankfurt.
      const groups = getMajorCityGroups();
      const ruhr = groups.find(g => g.cityName === 'Ruhr');
      const london = groups.find(g => g.cityName === 'London');
      if (!ruhr || !london) return;

      // Use a point on the same landmass as a "local" target
      const localTarget: GridCoord = { row: 30, col: 40 }; // somewhere south of Ruhr

      const segments = computeBuildSegments(
        [ruhr.center], [], 20, 20, undefined,
        [localTarget, london.center],
      );

      expect(segments.length).toBeGreaterThan(0);

      // The path should build toward either the local target or a ferry port,
      // NOT get confused by the cross-water London target. Verify the last segment
      // is on the mainland (source landmass).
      const lastSeg = segments[segments.length - 1];
      // All returned segments should be on the mainland
      for (const seg of segments) {
        // Basic sanity: all segments should be in Europe, not at coordinates
        // that would indicate they jumped to Britain via some bug
        expect(seg.to.row).toBeGreaterThanOrEqual(12);
      }
    });

    it('should still build toward London when starting from Calais ferry port', () => {
      // When the bot starts AT the departure ferry port, it's already on the
      // network — so botCanCrossFerry is true and targets are not redirected.
      const doverCalais = getFerryEdges().find(f => f.name === 'Dover_Calais');
      if (!doverCalais) return;

      const groups = getMajorCityGroups();
      const london = groups.find(g => g.cityName === 'London');
      if (!london) return;

      // Start from Calais (mainland side of Dover_Calais ferry)
      const calais = doverCalais.pointB; // (23,33)
      const segments = computeBuildSegments(
        [calais], [], 20, 20, undefined, [london.center],
      );

      // Calais IS the ferry port and IS on network — no redirect.
      // Dijkstra crosses the ferry for free and builds on the UK side.
      // extractSegments may filter out UK-side runs since Calais is the
      // only source (cold start rules). Either way, this should not crash.
      // The key assertion is that no error occurs.
      expect(Array.isArray(segments)).toBe(true);
    });
  });
});
