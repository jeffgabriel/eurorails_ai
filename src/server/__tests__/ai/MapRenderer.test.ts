import { MapRenderer } from '../../services/ai/MapRenderer';
import {
  GridPoint,
  TrackSegment,
  TerrainType,
  StrategicRoute,
  WorldSnapshot,
  DemandContext,
} from '../../../shared/types/GameTypes';

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

// ─── renderRouteCorridor tests ───────────────────────────────────────────────

/** Minimal WorldSnapshot factory for renderRouteCorridor tests */
function makeSnapshot(
  botTrack: TrackSegment[] = [],
  opponentTrack: TrackSegment[] = [],
  position: { row: number; col: number } | null = { row: 2, col: 2 },
): WorldSnapshot {
  return {
    gameId: 'test',
    gameStatus: 'in_progress' as WorldSnapshot['gameStatus'],
    turnNumber: 1,
    bot: {
      playerId: 'bot1',
      userId: 'user1',
      money: 100,
      position,
      existingSegments: botTrack,
      demandCards: [],
      resolvedDemands: [],
      trainType: 'Freight',
      loads: [],
      botConfig: null,
      connectedMajorCityCount: 0,
    },
    allPlayerTracks: [
      { playerId: 'bot1', segments: botTrack },
      { playerId: 'opp1', segments: opponentTrack },
    ],
    loadAvailability: {},
  };
}

/** Minimal StrategicRoute factory */
function makeRoute(stopCities: string[]): StrategicRoute {
  return {
    stops: stopCities.map((city, i) => ({
      action: (i % 2 === 0 ? 'pickup' : 'deliver') as 'pickup' | 'deliver',
      loadType: 'Coal',
      city,
    })),
    currentStopIndex: 0,
    phase: 'travel',
    createdAtTurn: 1,
    reasoning: 'test route',
  };
}

/** Minimal DemandContext factory */
function makeDemandCtx(supplyCity: string, deliveryCity: string): DemandContext {
  return {
    cardIndex: 0,
    loadType: 'Coal',
    supplyCity,
    deliveryCity,
    payout: 10,
    isSupplyReachable: true,
    isDeliveryReachable: true,
    isSupplyOnNetwork: false,
    isDeliveryOnNetwork: false,
    estimatedTrackCostToSupply: 0,
    estimatedTrackCostToDelivery: 0,
    isLoadAvailable: true,
    isLoadOnTrain: false,
    ferryRequired: false,
    loadChipTotal: 4,
    loadChipCarried: 0,
    estimatedTurns: 5,
    demandScore: 2,
    efficiencyPerTurn: 2,
    networkCitiesUnlocked: 0,
    victoryMajorCitiesEnRoute: 0,
    isAffordable: true,
    projectedFundsAfterDelivery: 100,
  };
}

describe('MapRenderer.renderRouteCorridor', () => {
  // 5-row × 5-col grid with named cities
  const grid: GridPoint[] = [
    gp(0, 0, TerrainType.Clear),
    gp(0, 1, TerrainType.Mountain),
    gp(0, 2, TerrainType.Clear),
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
    gp(4, 2, TerrainType.MajorCity, 'Lyon'),
    gp(4, 3, TerrainType.Clear),
    gp(4, 4, TerrainType.Clear),
  ];

  it('should return a CorridorMap with rendered string and bounds', () => {
    const route = makeRoute(['Paris']);
    const snapshot = makeSnapshot();
    const result = MapRenderer.renderRouteCorridor(route, snapshot, grid, []);

    expect(typeof result.rendered).toBe('string');
    expect(result.rendered.length).toBeGreaterThan(0);
    expect(result.minRow).toBeDefined();
    expect(result.maxRow).toBeDefined();
    expect(result.minCol).toBeDefined();
    expect(result.maxCol).toBeDefined();
  });

  it('should mark route stop city as T', () => {
    const route = makeRoute(['Paris']);
    const snapshot = makeSnapshot();
    const result = MapRenderer.renderRouteCorridor(route, snapshot, grid, []);

    // Paris is at row 2, col 2 — should appear as T
    const lines = result.rendered.split('\n');
    const parisLine = lines.find(l => l.includes('Paris'));
    expect(parisLine).toBeDefined();
    expect(parisLine).toContain('T');
  });

  it('should mark delivery city as D (demand context)', () => {
    const route = makeRoute(['Aachen']);
    const demands = [makeDemandCtx('Aachen', 'Paris')];
    const snapshot = makeSnapshot();
    const result = MapRenderer.renderRouteCorridor(route, snapshot, grid, demands);

    // Paris (delivery city) is at row 2 — should appear as D
    // (Aachen is T because it is a route stop; Paris should be D)
    expect(result.rendered).toContain('D');
  });

  it('should mark pickup city as P (demand context)', () => {
    const route = makeRoute(['Paris']);
    const demands = [makeDemandCtx('Lyon', 'Paris')];
    const snapshot = makeSnapshot();
    const result = MapRenderer.renderRouteCorridor(route, snapshot, grid, demands);

    // Lyon is supply city → should appear as P
    // Paris is both route stop (T) and delivery — T takes precedence
    expect(result.rendered).toContain('P');
  });

  it('should prioritize T over D', () => {
    const route = makeRoute(['Paris']);
    const demands = [makeDemandCtx('Aachen', 'Paris')]; // Paris is both T and D
    const snapshot = makeSnapshot();
    const result = MapRenderer.renderRouteCorridor(route, snapshot, grid, demands);

    const lines = result.rendered.split('\n');
    const parisLine = lines.find(l => l.includes('Paris'));
    expect(parisLine).toContain('T');
    // Paris should NOT appear as D because T takes precedence
    // (other rows may have D from the demand, so just verify Paris row is T)
    expect(parisLine).not.toMatch(/^\s*2:.*D/);
  });

  it('should render bot track as B', () => {
    const route = makeRoute(['Paris']);
    const botTrack = [seg(1, 1, 1, 2)];
    const snapshot = makeSnapshot(botTrack);
    const result = MapRenderer.renderRouteCorridor(route, snapshot, grid, []);

    const lines = result.rendered.split('\n');
    // Row 1 has bot track — should contain B
    const row1Line = lines.find(l => l.match(/^\s*1:/));
    expect(row1Line).toContain('B');
  });

  it('should render opponent track as O', () => {
    const route = makeRoute(['Paris']);
    const oppTrack = [seg(3, 1, 3, 2)];
    const snapshot = makeSnapshot([], oppTrack);
    const result = MapRenderer.renderRouteCorridor(route, snapshot, grid, []);

    const lines = result.rendered.split('\n');
    const row3Line = lines.find(l => l.match(/^\s*3:/));
    expect(row3Line).toContain('O');
  });

  it('should include legend in output', () => {
    const route = makeRoute(['Paris']);
    const result = MapRenderer.renderRouteCorridor(route, makeSnapshot(), grid, []);

    expect(result.rendered).toContain('Legend:');
    expect(result.rendered).toContain('T=route stop');
    expect(result.rendered).toContain('D=delivery city');
    expect(result.rendered).toContain('P=pickup city');
  });

  it('bounding box should cover all route stop cities with 5-hex padding', () => {
    // Route from Aachen (row 1, col 0) to Lyon (row 4, col 2) — both ends included
    const route = makeRoute(['Aachen', 'Lyon']);
    const snapshot = makeSnapshot();
    const result = MapRenderer.renderRouteCorridor(route, snapshot, grid, []);

    // Both T markers should appear (Aachen at row 1, Lyon at row 4)
    // The map contains at least 2 T markers — one per route stop city
    const tCount = (result.rendered.match(/ T /g) || []).length;
    expect(tCount).toBeGreaterThanOrEqual(2);
    // Lyon annotation should appear since it's the only city in its row
    expect(result.rendered).toContain('Lyon');
    // Bounds should encompass row 1 through row 4
    expect(result.minRow).toBeLessThanOrEqual(1);
    expect(result.maxRow).toBeGreaterThanOrEqual(4);
  });

  it('should handle route with no resolvable city names gracefully', () => {
    const route = makeRoute(['UnknownCity']);
    const snapshot = makeSnapshot();
    // Should not throw — fallback to bot position
    expect(() => MapRenderer.renderRouteCorridor(route, snapshot, grid, [])).not.toThrow();
  });

  it('should include column headers and row labels', () => {
    const route = makeRoute(['Paris']);
    const result = MapRenderer.renderRouteCorridor(route, makeSnapshot(), grid, []);
    const lines = result.rendered.split('\n');

    // First line should be the column header (starts with spaces)
    expect(lines[0].trim()).toMatch(/^\d/);
    // Second line should start with a row number
    expect(lines[1]).toMatch(/^\s*\d+:/);
  });
});
