import { TerrainType } from '../../shared/types/GameTypes';
import {
  loadGridPoints,
  getHexNeighbors,
  gridToPixel,
  getTerrainCost,
  isWater,
  _resetCache,
} from '../services/ai/MapTopology';

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
});
