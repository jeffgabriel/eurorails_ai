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

  describe('coordinate labels', () => {
    it('should include column header with correct column numbers', () => {
      const result = MapRenderer.renderCorridor(
        [],
        [],
        smallGrid,
        [{ row: 0, col: 0 }],
        { row: 4, col: 4 },
        4,
      );

      const lines = result.rendered.split('\n');
      // First line is column header
      const header = lines[0];
      expect(header).toContain('0');
      expect(header).toContain('1');
      expect(header).toContain('2');
      expect(header).toContain('3');
      expect(header).toContain('4');
    });

    it('should prefix each row with its row number', () => {
      const result = MapRenderer.renderCorridor(
        [],
        [],
        smallGrid,
        [{ row: 0, col: 0 }],
        { row: 4, col: 4 },
        4,
      );

      const lines = result.rendered.split('\n');
      // Skip header (line 0), grid rows start at line 1
      expect(lines[1]).toMatch(/^\s*0:\s/);
      expect(lines[2]).toMatch(/^\s*1:\s/);
      expect(lines[3]).toMatch(/^\s*2:\s/);
      expect(lines[4]).toMatch(/^\s*3:\s/);
      expect(lines[5]).toMatch(/^\s*4:\s/);
    });

    it('should align terrain chars with column headers using 4-char cells', () => {
      const result = MapRenderer.renderCorridor(
        [],
        [],
        smallGrid,
        [{ row: 0, col: 0 }],
        { row: 4, col: 4 },
        4,
      );

      const lines = result.rendered.split('\n');
      const header = lines[0];
      const row0 = lines[1];
      // Row label is 5 chars ("  0: "), header indent is 5 chars ("     ")
      // Both use 4-char cells after that
      expect(header.substring(0, 5)).toBe('     ');
      expect(row0.substring(0, 5)).toMatch(/^\s*0:\s$/);
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
      // Line 0 is now the column header; grid rows start at line 1
      // Row 0: . m A . .
      expect(lines[1]).toContain('.');
      expect(lines[1]).toContain('m');
      expect(lines[1]).toContain('A');

      // Row 1: s . . M .  (SmallCity=s, MediumCity=M)
      expect(lines[2]).toContain('s');
      expect(lines[2]).toContain('M');

      // Row 2: . . * . .  (MajorCity=*)
      expect(lines[3]).toContain('*');

      // Row 3, col 4: ~ (Water)
      expect(lines[4]).toContain('~');
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
      // Row 1 is grid line index 2 (header + row 0 first)
      expect(lines[2]).toContain('B');
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
      // Row 3 is grid line index 4
      expect(lines[4]).toContain('O');
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
      // Row 2 is grid line index 3
      expect(lines[3]).toContain('B');
      expect(lines[3]).not.toContain('O');
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
      // Row 2 is grid line index 3 (header + rows 0,1)
      expect(lines[3]).toContain('T'); // Target overrides MajorCity
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
      // Row 2 is grid line index 3
      expect(lines[3]).toContain('T'); // Target wins over bot track
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
      // Row 1 is grid line index 2 (header offset)
      expect(lines[2]).toContain('Bruxelles');

      // Row 2 is grid line index 3
      expect(lines[3]).toContain('Paris');
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
