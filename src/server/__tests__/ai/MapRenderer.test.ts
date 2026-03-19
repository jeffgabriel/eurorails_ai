import { MapRenderer } from '../../services/ai/MapRenderer';
import { GridPoint, TrackSegment, TerrainType } from '../../../shared/types/GameTypes';

/** Helper to create a GridPoint */
function gp(row: number, col: number, terrain: TerrainType, cityName?: string): GridPoint {
  return {
    id: `${row},${col}`,
    x: col * 50,
    y: row * 50,
    row,
    col,
    terrain,
    city: cityName ? { type: terrain, name: cityName, availableLoads: [] } : undefined,
  };
}

/** Helper to create a TrackSegment */
function seg(fromRow: number, fromCol: number, toRow: number, toCol: number): TrackSegment {
  return {
    from: { x: 0, y: 0, row: fromRow, col: fromCol, terrain: TerrainType.Clear },
    to: { x: 0, y: 0, row: toRow, col: toCol, terrain: TerrainType.Clear },
    cost: 1,
  };
}

describe('MapRenderer', () => {
  // Small 5x5 grid for testing
  const smallGrid: GridPoint[] = [
    gp(0, 0, TerrainType.Clear),
    gp(0, 1, TerrainType.Mountain),
    gp(0, 2, TerrainType.Alpine),
    gp(0, 3, TerrainType.Clear),
    gp(0, 4, TerrainType.Clear),
    gp(1, 0, TerrainType.SmallCity, 'Aachen'),
    gp(1, 1, TerrainType.Clear),
    gp(1, 2, TerrainType.Clear),
    gp(1, 3, TerrainType.MediumCity, 'Bruxelles'),
    gp(1, 4, TerrainType.Clear),
    gp(2, 0, TerrainType.Clear),
    gp(2, 1, TerrainType.Clear),
    gp(2, 2, TerrainType.MajorCity, 'Paris'),
    gp(2, 3, TerrainType.Clear),
    gp(2, 4, TerrainType.Clear),
    gp(3, 0, TerrainType.Clear),
    gp(3, 1, TerrainType.Clear),
    gp(3, 2, TerrainType.Clear),
    gp(3, 3, TerrainType.Clear),
    gp(3, 4, TerrainType.Water),
    gp(4, 0, TerrainType.Clear),
    gp(4, 1, TerrainType.Clear),
    gp(4, 2, TerrainType.Clear),
    gp(4, 3, TerrainType.Clear),
    gp(4, 4, TerrainType.Clear),
  ];

  describe('calculateBounds', () => {
    it('should calculate bounds enclosing frontier and target with padding', () => {
      const frontier = [{ row: 1, col: 1 }];
      const target = { row: 3, col: 3 };
      const bounds = MapRenderer.calculateBounds(frontier, target, 20, smallGrid);

      // padding = max(20/4, 5) = 5, but clamped to grid (0-4)
      expect(bounds.minRow).toBe(0);
      expect(bounds.maxRow).toBe(4);
      expect(bounds.minCol).toBe(0);
      expect(bounds.maxCol).toBe(4);
    });

    it('should use minimum 5 padding even for small corridorSize', () => {
      const frontier = [{ row: 2, col: 2 }];
      const target = { row: 2, col: 2 };
      // corridorSize=4 → padding = max(1, 5) = 5
      const bounds = MapRenderer.calculateBounds(frontier, target, 4, smallGrid);

      expect(bounds.minRow).toBe(0); // 2-5 clamped to 0
      expect(bounds.maxRow).toBe(4); // 2+5 clamped to 4
    });

    it('should handle multiple frontier points', () => {
      const frontier = [{ row: 0, col: 0 }, { row: 4, col: 4 }];
      const target = { row: 2, col: 2 };
      const bounds = MapRenderer.calculateBounds(frontier, target, 20, smallGrid);

      expect(bounds.minRow).toBe(0);
      expect(bounds.maxRow).toBe(4);
    });
  });

  describe('terrain encoding', () => {
    it('should encode terrain types correctly', () => {
      const result = MapRenderer.renderCorridor(
        [],  // no bot track
        [],  // no opponent tracks
        smallGrid,
        [{ row: 0, col: 0 }],
        { row: 4, col: 4 },
        4,   // small corridorSize to capture full grid
      );

      const lines = result.rendered.split('\n');
      // Row 0: . m A . .
      expect(lines[0]).toContain('.');
      expect(lines[0]).toContain('m');
      expect(lines[0]).toContain('A');

      // Row 1: s . . M .  (SmallCity=s, MediumCity=M)
      expect(lines[1][0]).toBe('s');
      expect(lines[1][3]).toBe('M');

      // Row 2: . . * . .  (MajorCity=*)
      expect(lines[2][2]).toBe('*');

      // Row 3, col 4: ~ (Water)
      expect(lines[3][4]).toBe('~');
    });
  });

  describe('track rendering', () => {
    it('should render bot track as B', () => {
      const botTrack = [seg(1, 1, 1, 2)];
      const result = MapRenderer.renderCorridor(
        botTrack,
        [],
        smallGrid,
        [{ row: 0, col: 0 }],
        { row: 4, col: 4 },
        4,
      );

      const lines = result.rendered.split('\n');
      // Row 1, col 1 and col 2 should be B (bot track)
      expect(lines[1][1]).toBe('B');
      expect(lines[1][2]).toBe('B');
    });

    it('should render opponent track as O', () => {
      const opponentTracks = [[seg(3, 1, 3, 2)]];
      const result = MapRenderer.renderCorridor(
        [],
        opponentTracks,
        smallGrid,
        [{ row: 0, col: 0 }],
        { row: 4, col: 4 },
        4,
      );

      const lines = result.rendered.split('\n');
      expect(lines[3][1]).toBe('O');
      expect(lines[3][2]).toBe('O');
    });

    it('should prioritize bot track over opponent track', () => {
      const botTrack = [seg(2, 1, 2, 1)];
      const opponentTracks = [[seg(2, 1, 2, 1)]]; // same position
      const result = MapRenderer.renderCorridor(
        botTrack,
        opponentTracks,
        smallGrid,
        [{ row: 0, col: 0 }],
        { row: 4, col: 4 },
        4,
      );

      const lines = result.rendered.split('\n');
      expect(lines[2][1]).toBe('B'); // Bot wins
    });
  });

  describe('target city and annotations', () => {
    it('should mark target city as T', () => {
      const result = MapRenderer.renderCorridor(
        [],
        [],
        smallGrid,
        [{ row: 0, col: 0 }],
        { row: 2, col: 2 },  // Paris
        4,
      );

      const lines = result.rendered.split('\n');
      expect(lines[2][2]).toBe('T'); // Target overrides MajorCity
    });

    it('should prioritize target over bot track', () => {
      const botTrack = [seg(2, 2, 2, 2)];
      const result = MapRenderer.renderCorridor(
        botTrack,
        [],
        smallGrid,
        [{ row: 0, col: 0 }],
        { row: 2, col: 2 },
        4,
      );

      const lines = result.rendered.split('\n');
      expect(lines[2][2]).toBe('T'); // Target wins over bot track
    });

    it('should annotate city names on the right side', () => {
      const result = MapRenderer.renderCorridor(
        [],
        [],
        smallGrid,
        [{ row: 0, col: 0 }],
        { row: 4, col: 4 },
        4,
      );

      const lines = result.rendered.split('\n');
      // Row 1 has SmallCity Aachen at col 0 and MediumCity Bruxelles at col 3
      // Last annotation for row 1 should be Bruxelles (overwrites Aachen in map)
      expect(lines[1]).toContain('Bruxelles');

      // Row 2 has MajorCity Paris at col 2
      expect(lines[2]).toContain('Paris');
    });
  });

  describe('legend', () => {
    it('should include legend in output', () => {
      const result = MapRenderer.renderCorridor(
        [],
        [],
        smallGrid,
        [{ row: 0, col: 0 }],
        { row: 4, col: 4 },
        4,
      );

      expect(result.rendered).toContain('Legend:');
      expect(result.rendered).toContain('B=bot track');
      expect(result.rendered).toContain('T=build target');
    });
  });

  describe('return value', () => {
    it('should return CorridorMap with bounds', () => {
      const result = MapRenderer.renderCorridor(
        [],
        [],
        smallGrid,
        [{ row: 1, col: 1 }],
        { row: 3, col: 3 },
        4,
      );

      expect(result.minRow).toBeDefined();
      expect(result.maxRow).toBeDefined();
      expect(result.minCol).toBeDefined();
      expect(result.maxCol).toBeDefined();
      expect(typeof result.rendered).toBe('string');
      expect(result.rendered.length).toBeGreaterThan(0);
    });
  });
});
