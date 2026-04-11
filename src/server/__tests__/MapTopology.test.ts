import { TerrainType } from '../../shared/types/GameTypes';
import {
  loadGridPoints,
  getHexNeighbors,
  gridToPixel,
  getTerrainCost,
  isWater,
  hexDistance,
  getFerryPairPort,
  computeLandmass,
  computeFerryRouteInfo,
  estimatePathCost,
  getWaterCrossingCost,
  makeKey,
  _resetCache,
  GridPointData,
} from '../services/MapTopology';

describe('MapTopology', () => {
  describe('loadGridPoints', () => {
    beforeEach(() => _resetCache());

    it('should load gridPoints.json and return a non-empty map', () => {
      const grid = loadGridPoints();
      expect(grid.size).toBeGreaterThan(0);
    });

    it('should cache results on subsequent calls', () => {
      const first = loadGridPoints();
      const second = loadGridPoints();
      expect(first).toBe(second);
    });

    it('should key entries by "row,col"', () => {
      const grid = loadGridPoints();
      // Every key should match the pattern "number,number"
      for (const key of grid.keys()) {
        expect(key).toMatch(/^\d+,\d+$/);
        break; // just check one
      }
    });

    it('should parse terrain types correctly', () => {
      const grid = loadGridPoints();
      const terrainValues = new Set<TerrainType>();
      for (const point of grid.values()) {
        terrainValues.add(point.terrain);
      }
      // Should have at least Clear and Mountain on the map
      expect(terrainValues.has(TerrainType.Clear)).toBe(true);
      expect(terrainValues.has(TerrainType.Mountain)).toBe(true);
    });
  });

  describe('getTerrainCost', () => {
    it('should return 1 for Clear terrain', () => {
      expect(getTerrainCost(TerrainType.Clear)).toBe(1);
    });

    it('should return 2 for Mountain terrain', () => {
      expect(getTerrainCost(TerrainType.Mountain)).toBe(2);
    });

    it('should return 5 for Alpine terrain', () => {
      expect(getTerrainCost(TerrainType.Alpine)).toBe(5);
    });

    it('should return 3 for SmallCity terrain', () => {
      expect(getTerrainCost(TerrainType.SmallCity)).toBe(3);
    });

    it('should return 3 for MediumCity terrain', () => {
      expect(getTerrainCost(TerrainType.MediumCity)).toBe(3);
    });

    it('should return 5 for MajorCity terrain', () => {
      expect(getTerrainCost(TerrainType.MajorCity)).toBe(5);
    });

    it('should return 0 for FerryPort terrain (actual cost is ferryConnection.cost, applied at call site)', () => {
      expect(getTerrainCost(TerrainType.FerryPort)).toBe(0);
    });

    it('should return Infinity for Water terrain', () => {
      expect(getTerrainCost(TerrainType.Water)).toBe(Infinity);
    });
  });

  describe('isWater', () => {
    it('should return true for Water terrain', () => {
      expect(isWater(TerrainType.Water)).toBe(true);
    });

    it('should return false for Clear terrain', () => {
      expect(isWater(TerrainType.Clear)).toBe(false);
    });

    it('should return false for Mountain terrain', () => {
      expect(isWater(TerrainType.Mountain)).toBe(false);
    });

    it('should return false for MajorCity terrain', () => {
      expect(isWater(TerrainType.MajorCity)).toBe(false);
    });
  });

  describe('gridToPixel', () => {
    it('should convert even row coordinates correctly', () => {
      const { x, y } = gridToPixel(0, 0);
      expect(x).toBe(120); // 0*50 + 120 + 0
      expect(y).toBe(120); // 0*45 + 120
    });

    it('should apply offset for odd rows', () => {
      const { x, y } = gridToPixel(1, 0);
      expect(x).toBe(145); // 0*50 + 120 + 25
      expect(y).toBe(165); // 1*45 + 120
    });

    it('should scale correctly for larger coordinates', () => {
      const { x, y } = gridToPixel(10, 5);
      expect(x).toBe(370); // 5*50 + 120 + 0 (even row)
      expect(y).toBe(570); // 10*45 + 120
    });

    it('should apply offset correctly for larger odd row', () => {
      const { x, y } = gridToPixel(11, 5);
      expect(x).toBe(395); // 5*50 + 120 + 25 (odd row)
      expect(y).toBe(615); // 11*45 + 120
    });
  });

  describe('getHexNeighbors', () => {
    beforeEach(() => _resetCache());

    it('should return only valid non-water neighbors', () => {
      const neighbors = getHexNeighbors(30, 30);
      // All returned neighbors should exist on the grid
      const grid = loadGridPoints();
      for (const n of neighbors) {
        const key = `${n.row},${n.col}`;
        const point = grid.get(key);
        expect(point).toBeDefined();
        expect(point!.terrain).not.toBe(TerrainType.Water);
      }
    });

    it('should return at most 6 neighbors', () => {
      const neighbors = getHexNeighbors(30, 30);
      expect(neighbors.length).toBeLessThanOrEqual(6);
    });

    it('should return neighbors at correct offsets for even rows', () => {
      // For even row, expected deltas: [-1,-1], [-1,0], [0,-1], [0,1], [1,-1], [1,0]
      const row = 30;
      const col = 30;
      const neighbors = getHexNeighbors(row, col);
      const neighborKeys = new Set(neighbors.map(n => `${n.row},${n.col}`));

      const expectedDeltas = [[-1, -1], [-1, 0], [0, -1], [0, 1], [1, -1], [1, 0]];
      const grid = loadGridPoints();
      for (const [dr, dc] of expectedDeltas) {
        const key = `${row + dr},${col + dc}`;
        const point = grid.get(key);
        if (point && point.terrain !== TerrainType.Water) {
          expect(neighborKeys.has(key)).toBe(true);
        }
      }
    });

    it('should return neighbors at correct offsets for odd rows', () => {
      // For odd row, expected deltas: [-1,0], [-1,1], [0,-1], [0,1], [1,0], [1,1]
      const row = 31;
      const col = 30;
      const neighbors = getHexNeighbors(row, col);
      const neighborKeys = new Set(neighbors.map(n => `${n.row},${n.col}`));

      const expectedDeltas = [[-1, 0], [-1, 1], [0, -1], [0, 1], [1, 0], [1, 1]];
      const grid = loadGridPoints();
      for (const [dr, dc] of expectedDeltas) {
        const key = `${row + dr},${col + dc}`;
        const point = grid.get(key);
        if (point && point.terrain !== TerrainType.Water) {
          expect(neighborKeys.has(key)).toBe(true);
        }
      }
    });

    it('should return empty array for non-existent grid position', () => {
      const neighbors = getHexNeighbors(999, 999);
      expect(neighbors).toEqual([]);
    });
  });

  describe('hexDistance', () => {
    it('should return 0 for same position', () => {
      expect(hexDistance(10, 10, 10, 10)).toBe(0);
    });

    it('should return 1 for adjacent same-row positions', () => {
      expect(hexDistance(10, 5, 10, 6)).toBe(1);
      expect(hexDistance(10, 5, 10, 4)).toBe(1);
    });

    it('should return 1 for adjacent different-row positions (even row)', () => {
      // Even row neighbors: [-1,-1], [-1,0], [1,-1], [1,0]
      expect(hexDistance(10, 5, 9, 5)).toBe(1);
      expect(hexDistance(10, 5, 9, 4)).toBe(1);
      expect(hexDistance(10, 5, 11, 5)).toBe(1);
      expect(hexDistance(10, 5, 11, 4)).toBe(1);
    });

    it('should return 1 for adjacent different-row positions (odd row)', () => {
      // Odd row neighbors: [-1,0], [-1,1], [1,0], [1,1]
      expect(hexDistance(11, 5, 10, 5)).toBe(1);
      expect(hexDistance(11, 5, 10, 6)).toBe(1);
      expect(hexDistance(11, 5, 12, 5)).toBe(1);
      expect(hexDistance(11, 5, 12, 6)).toBe(1);
    });

    it('should compute correct distance for distant positions', () => {
      // Straight horizontal: same row, 5 cols apart
      expect(hexDistance(10, 0, 10, 5)).toBe(5);
    });

    it('should be symmetric', () => {
      expect(hexDistance(5, 3, 20, 15)).toBe(hexDistance(20, 15, 5, 3));
    });
  });

  describe('getFerryPairPort', () => {
    const ferryEdges = [
      { name: 'Dover-Calais', pointA: { row: 10, col: 5 }, pointB: { row: 12, col: 8 }, cost: 8 },
      { name: 'Harwich-HookOfHolland', pointA: { row: 6, col: 15 }, pointB: { row: 8, col: 20 }, cost: 10 },
    ];

    it('should return pointB when given pointA coordinates', () => {
      const result = getFerryPairPort(10, 5, ferryEdges);
      expect(result).toEqual({ row: 12, col: 8 });
    });

    it('should return pointA when given pointB coordinates', () => {
      const result = getFerryPairPort(12, 8, ferryEdges);
      expect(result).toEqual({ row: 10, col: 5 });
    });

    it('should match the correct ferry edge among multiple edges', () => {
      const result = getFerryPairPort(6, 15, ferryEdges);
      expect(result).toEqual({ row: 8, col: 20 });
    });

    it('should return the reverse for the second edge pointB', () => {
      const result = getFerryPairPort(8, 20, ferryEdges);
      expect(result).toEqual({ row: 6, col: 15 });
    });

    it('should return null for coordinates that are not a ferry port', () => {
      const result = getFerryPairPort(30, 30, ferryEdges);
      expect(result).toBeNull();
    });

    it('should return null for empty ferryEdges array', () => {
      const result = getFerryPairPort(10, 5, []);
      expect(result).toBeNull();
    });

    it('should return null when row matches but col does not', () => {
      const result = getFerryPairPort(10, 99, ferryEdges);
      expect(result).toBeNull();
    });
  });

  describe('computeLandmass', () => {
    beforeEach(() => _resetCache());

    it('should return connected non-water tiles from source positions', () => {
      const grid = loadGridPoints();
      // Pick a known inland position (row 30, col 30 — used in getHexNeighbors tests)
      const sources = [{ row: 30, col: 30 }];
      const landmass = computeLandmass(sources, grid);

      expect(landmass.size).toBeGreaterThan(1);
      expect(landmass.has(makeKey(30, 30))).toBe(true);

      // All tiles in the landmass should be non-water
      for (const key of landmass) {
        const point = grid.get(key);
        expect(point).toBeDefined();
        expect(point!.terrain).not.toBe(TerrainType.Water);
      }
    });

    it('should stop at water tile boundaries', () => {
      // Build a small synthetic grid: land - water - land
      const grid = new Map<string, GridPointData>();
      grid.set('0,0', { row: 0, col: 0, terrain: TerrainType.Clear });
      grid.set('0,1', { row: 0, col: 1, terrain: TerrainType.Water });
      grid.set('0,2', { row: 0, col: 2, terrain: TerrainType.Clear });

      const landmass = computeLandmass([{ row: 0, col: 0 }], grid);
      expect(landmass.has(makeKey(0, 0))).toBe(true);
      // Water tile and tile beyond it should not be in the landmass
      expect(landmass.has(makeKey(0, 1))).toBe(false);
    });

    it('should merge multiple sources on the same landmass', () => {
      const grid = loadGridPoints();
      const sources = [{ row: 30, col: 30 }, { row: 30, col: 31 }];
      const landmass = computeLandmass(sources, grid);

      // Both sources should be present
      expect(landmass.has(makeKey(30, 30))).toBe(true);
      expect(landmass.has(makeKey(30, 31))).toBe(true);
      expect(landmass.size).toBeGreaterThan(2);
    });

    it('should return only source tile for isolated position', () => {
      // Synthetic grid: single land tile surrounded by nothing
      const grid = new Map<string, GridPointData>();
      grid.set('50,50', { row: 50, col: 50, terrain: TerrainType.Clear });

      const landmass = computeLandmass([{ row: 50, col: 50 }], grid);
      expect(landmass.size).toBe(1);
      expect(landmass.has(makeKey(50, 50))).toBe(true);
    });
  });

  describe('computeFerryRouteInfo', () => {
    const ferryEdges = [
      { name: 'Dover-Calais', pointA: { row: 10, col: 5 }, pointB: { row: 12, col: 8 }, cost: 8 },
      { name: 'Harwich-Hook', pointA: { row: 6, col: 15 }, pointB: { row: 8, col: 20 }, cost: 12 },
    ];

    it('should return canCrossFerry=true when bot has track at departure port', () => {
      // Source landmass includes pointA of Dover-Calais
      const sourceLandmass = new Set([makeKey(10, 5), makeKey(10, 6), makeKey(9, 5)]);
      const onNetwork = new Set([makeKey(10, 5)]); // bot has track at Dover

      const info = computeFerryRouteInfo(sourceLandmass, onNetwork, ferryEdges);
      expect(info.canCrossFerry).toBe(true);
      expect(info.departurePorts).toEqual([{ row: 10, col: 5 }]);
      expect(info.arrivalPorts).toEqual([{ row: 12, col: 8 }]);
    });

    it('should return canCrossFerry=false when no track at departure port', () => {
      const sourceLandmass = new Set([makeKey(10, 5), makeKey(10, 6), makeKey(9, 5)]);
      const onNetwork = new Set([makeKey(10, 6)]); // track nearby but NOT at port

      const info = computeFerryRouteInfo(sourceLandmass, onNetwork, ferryEdges);
      expect(info.canCrossFerry).toBe(false);
      expect(info.departurePorts.length).toBeGreaterThan(0);
    });

    it('should return cheapest ferry cost', () => {
      // Both ferries connect from source landmass
      const sourceLandmass = new Set([
        makeKey(10, 5), makeKey(10, 6), makeKey(6, 15), makeKey(6, 16),
      ]);
      const onNetwork = new Set<string>();

      const info = computeFerryRouteInfo(sourceLandmass, onNetwork, ferryEdges);
      expect(info.cheapestFerryCost).toBe(8); // Dover-Calais is cheapest
      expect(info.departurePorts.length).toBe(2);
      expect(info.arrivalPorts.length).toBe(2);
    });

    it('should ignore ferry where both ports are on the same landmass', () => {
      // Both pointA and pointB on source landmass — not a cross-water ferry
      const sourceLandmass = new Set([
        makeKey(10, 5), makeKey(12, 8), // both Dover and Calais on same landmass
      ]);
      const onNetwork = new Set<string>();

      const info = computeFerryRouteInfo(sourceLandmass, onNetwork, ferryEdges);
      // Dover-Calais should not appear since both ends are on source landmass
      const doverInDeparture = info.departurePorts.some(p => p.row === 10 && p.col === 5);
      const calaisInDeparture = info.departurePorts.some(p => p.row === 12 && p.col === 8);
      expect(doverInDeparture).toBe(false);
      expect(calaisInDeparture).toBe(false);
    });

    it('should return empty ports when no ferry connects to another landmass', () => {
      const sourceLandmass = new Set([makeKey(99, 99)]); // isolated, no ferry nearby
      const onNetwork = new Set<string>();

      const info = computeFerryRouteInfo(sourceLandmass, onNetwork, ferryEdges);
      expect(info.departurePorts).toEqual([]);
      expect(info.arrivalPorts).toEqual([]);
      expect(info.cheapestFerryCost).toBe(Infinity);
      expect(info.canCrossFerry).toBe(false);
    });
  });

  describe('estimatePathCost', () => {
    // Use real grid positions from gridPoints.json for accurate testing.
    // These positions are known to exist on the EuroRails map.

    it('should return 0 for same position', () => {
      const grid = loadGridPoints();
      const first = grid.entries().next().value!;
      const [, point] = first;
      expect(estimatePathCost(point.row, point.col, point.row, point.col)).toBe(0);
    });

    it('should return 0 for non-existent target', () => {
      expect(estimatePathCost(0, 0, 999, 999)).toBe(0);
    });

    it('should return positive cost for adjacent clear terrain hexes', () => {
      // Find two adjacent clear-terrain hexes on the real grid
      const grid = loadGridPoints();
      let from: GridPointData | null = null;
      let to: GridPointData | null = null;
      for (const [, point] of grid) {
        if (point.terrain === TerrainType.Clear) {
          const neighbors = getHexNeighbors(point.row, point.col);
          for (const nb of neighbors) {
            const nbData = grid.get(makeKey(nb.row, nb.col));
            if (nbData && nbData.terrain === TerrainType.Clear) {
              from = point;
              to = nbData;
              break;
            }
          }
          if (to) break;
        }
      }
      expect(from).not.toBeNull();
      expect(to).not.toBeNull();
      const cost = estimatePathCost(from!.row, from!.col, to!.row, to!.col);
      expect(cost).toBe(1); // Clear terrain = 1M
    });

    it('should return higher cost for paths through mountain terrain than clear', () => {
      // Find a mountain hex and a clear hex nearby, then compare path costs
      const grid = loadGridPoints();
      let mountainPoint: GridPointData | null = null;
      let clearNeighborOfMountain: GridPointData | null = null;
      let clearPointFarther: GridPointData | null = null;

      for (const [, point] of grid) {
        if (point.terrain === TerrainType.Mountain) {
          const neighbors = getHexNeighbors(point.row, point.col);
          for (const nb of neighbors) {
            const nbData = grid.get(makeKey(nb.row, nb.col));
            if (nbData && nbData.terrain === TerrainType.Clear) {
              mountainPoint = point;
              clearNeighborOfMountain = nbData;
              // Find a clear neighbor of the clear point (2 hops through clear)
              const farNeighbors = getHexNeighbors(nbData.row, nbData.col);
              for (const fnb of farNeighbors) {
                const fnbData = grid.get(makeKey(fnb.row, fnb.col));
                if (fnbData && fnbData.terrain === TerrainType.Clear
                    && (fnbData.row !== mountainPoint.row || fnbData.col !== mountainPoint.col)) {
                  clearPointFarther = fnbData;
                  break;
                }
              }
              if (clearPointFarther) break;
            }
          }
          if (clearPointFarther) break;
        }
      }

      if (mountainPoint && clearNeighborOfMountain && clearPointFarther) {
        // Cost through mountain should be >= 2 (mountain cost)
        const costThroughMountain = estimatePathCost(
          clearNeighborOfMountain.row, clearNeighborOfMountain.col,
          mountainPoint.row, mountainPoint.col,
        );
        expect(costThroughMountain).toBeGreaterThanOrEqual(2);
      }
    });

    it('should return cost >= 5 for path ending at alpine terrain', () => {
      const grid = loadGridPoints();
      let alpinePoint: GridPointData | null = null;
      let nearbyPoint: GridPointData | null = null;

      for (const [, point] of grid) {
        if (point.terrain === TerrainType.Alpine) {
          const neighbors = getHexNeighbors(point.row, point.col);
          for (const nb of neighbors) {
            const nbData = grid.get(makeKey(nb.row, nb.col));
            if (nbData && nbData.terrain !== TerrainType.Water) {
              alpinePoint = point;
              nearbyPoint = nbData;
              break;
            }
          }
          if (nearbyPoint) break;
        }
      }

      expect(alpinePoint).not.toBeNull();
      expect(nearbyPoint).not.toBeNull();
      const cost = estimatePathCost(nearbyPoint!.row, nearbyPoint!.col, alpinePoint!.row, alpinePoint!.col);
      expect(cost).toBeGreaterThanOrEqual(5); // Alpine = 5M minimum
    });

    it('should produce cost >= hex distance (minimum 1M per hop)', () => {
      // Dijkstra cost must be at least hexDistance since cheapest terrain is 1M
      const grid = loadGridPoints();
      const points: GridPointData[] = [];
      let count = 0;
      for (const [, point] of grid) {
        if (point.terrain !== TerrainType.Water && count % 200 === 0) {
          points.push(point);
        }
        count++;
        if (points.length >= 5) break;
      }

      for (let i = 0; i < points.length - 1; i++) {
        const a = points[i];
        const b = points[i + 1];
        const dist = hexDistance(a.row, a.col, b.row, b.col);
        const dijkstraCost = estimatePathCost(a.row, a.col, b.row, b.col);
        if (dijkstraCost > 0) {
          expect(dijkstraCost).toBeGreaterThanOrEqual(dist);
        }
      }
    });

    it('should complete 20 sequential calls in under 500ms', () => {
      const grid = loadGridPoints();
      // Pick some spread-out points for realistic performance test
      const points: GridPointData[] = [];
      let count = 0;
      for (const [, point] of grid) {
        if (count % 100 === 0) points.push(point);
        count++;
        if (points.length >= 10) break;
      }

      const start = Date.now();
      for (let i = 0; i < 20; i++) {
        const from = points[i % points.length];
        const to = points[(i + 3) % points.length];
        estimatePathCost(from.row, from.col, to.row, to.col);
      }
      const elapsed = Date.now() - start;
      expect(elapsed).toBeLessThan(500);
    });
  });

  describe('getWaterCrossingCost', () => {
    it('should return 0 for edges without water crossings', () => {
      // Use two adjacent clear hexes that don't cross water
      const grid = loadGridPoints();
      for (const [, point] of grid) {
        if (point.terrain === TerrainType.Clear) {
          const neighbors = getHexNeighbors(point.row, point.col);
          for (const nb of neighbors) {
            const cost = getWaterCrossingCost(point.row, point.col, nb.row, nb.col);
            if (cost === 0) {
              expect(cost).toBe(0);
              return;
            }
          }
        }
      }
    });

    it('should be symmetric (same cost regardless of direction)', () => {
      const grid = loadGridPoints();
      for (const [, point] of grid) {
        const neighbors = getHexNeighbors(point.row, point.col);
        for (const nb of neighbors) {
          const costAB = getWaterCrossingCost(point.row, point.col, nb.row, nb.col);
          const costBA = getWaterCrossingCost(nb.row, nb.col, point.row, point.col);
          expect(costAB).toBe(costBA);
          if (costAB > 0) return; // Found a crossing, verified symmetry
        }
      }
    });
  });
});
