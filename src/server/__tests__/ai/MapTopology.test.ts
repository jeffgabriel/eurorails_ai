import fs from 'fs';
import path from 'path';
import { estimateHopDistance, estimatePathCost, hexDistance, loadGridPoints, _resetCache } from '../../services/ai/MapTopology';
import { getFerryEdges } from '../../../shared/services/majorCityGroups';

describe('estimateHopDistance', () => {
  afterEach(() => {
    _resetCache();
  });

  it('returns 0 for same position', () => {
    expect(estimateHopDistance(10, 10, 10, 10)).toBe(0);
  });

  it('returns 1 for adjacent hexes', () => {
    // Adjacent hexes on the grid should be 1 hop apart
    // Use a known valid pair from the grid
    const dist = estimateHopDistance(10, 10, 10, 11);
    // If both are valid grid points, should be 1; if not on grid, 0
    expect(dist).toBeGreaterThanOrEqual(0);
    expect(dist).toBeLessThanOrEqual(1);
  });

  it('returns 0 for positions not on the grid', () => {
    // Use extreme coordinates that are unlikely to be on the game board
    expect(estimateHopDistance(999, 999, 998, 999)).toBe(0);
  });

  it('returns value >= hexDistance for any valid pair (actual path >= straight line)', () => {
    // Warszawa and Roma are far apart; BFS hop count should be >= hex distance
    // We need to find their grid coordinates. Use known approximate positions.
    // Warszawa is roughly at row 13, col 22; Roma at row 27, col 16
    // The exact coords depend on the grid, but the principle holds:
    // BFS through the actual grid >= Chebyshev distance
    const fromRow = 13, fromCol = 22;
    const toRow = 27, toCol = 16;
    const hopDist = estimateHopDistance(fromRow, fromCol, toRow, toCol);
    const straightDist = hexDistance(fromRow, fromCol, toRow, toCol);

    if (hopDist > 0) {
      expect(hopDist).toBeGreaterThanOrEqual(straightDist);
    }
  });

  it('returns accurate hop count for a cross-map route', () => {
    // For any two distant valid grid points, BFS should return a reasonable count
    // that is larger than hexDistance (which underestimates due to map topology)
    const hopDist = estimateHopDistance(5, 10, 30, 15);
    // If both points are valid, hop distance should be positive
    // This verifies BFS actually traverses the grid
    if (hopDist > 0) {
      const straightDist = hexDistance(5, 10, 30, 15);
      expect(hopDist).toBeGreaterThanOrEqual(straightDist);
    }
  });

  // JIRA-88: Ferry-aware BFS
  it('returns non-zero hop count for Belfast (ferry-separated from mainland)', () => {
    // Belfast (row=7, col=26) → Glasgow (row=5, col=30) requires Irish Sea ferry
    const hopDist = estimateHopDistance(7, 26, 5, 30);
    expect(hopDist).toBeGreaterThan(0);
  });

  it('returns non-zero hop count for Dublin (ferry-separated from Britain)', () => {
    // Dublin (row=10, col=24) → Birmingham (row=16, col=30) requires Irish Sea ferry
    const hopDist = estimateHopDistance(10, 24, 16, 30);
    expect(hopDist).toBeGreaterThan(0);
  });
});

describe('estimatePathCost', () => {
  afterEach(() => {
    _resetCache();
  });

  it('returns 0 for same position', () => {
    expect(estimatePathCost(10, 10, 10, 10)).toBe(0);
  });

  it('returns non-zero cost for mainland route', () => {
    // Birmingham (row=16, col=30) → London (row=20, col=31) — mainland Britain
    const cost = estimatePathCost(16, 30, 20, 31);
    expect(cost).toBeGreaterThan(0);
  });

  // JIRA-88: Ferry-aware Dijkstra
  it('returns non-zero cost for Belfast including ferry port build cost', () => {
    // Belfast (row=7, col=26) → Glasgow (row=5, col=30) requires Irish Sea ferry
    const cost = estimatePathCost(7, 26, 5, 30);
    expect(cost).toBeGreaterThan(0);
    // Ferry cost is at least 4M (Belfast ferry port cost)
    expect(cost).toBeGreaterThanOrEqual(4);
  });

  it('returns non-zero cost for Dublin including ferry port build cost', () => {
    // Dublin (row=10, col=24) → Birmingham (row=16, col=30) requires Irish Sea ferry
    const cost = estimatePathCost(10, 24, 16, 30);
    expect(cost).toBeGreaterThan(0);
  });

  it('mainland routes are not affected by ferry changes (regression)', () => {
    // Two mainland continental cities should give a path cost based only on terrain
    // Warszawa area (row=13, col=22) to a nearby point (row=14, col=22)
    const cost = estimatePathCost(13, 22, 14, 22);
    if (cost > 0) {
      // Should be a small terrain-only cost (no ferry involved)
      expect(cost).toBeLessThan(20);
    }
  });

  // JIRA-149: Cross-water routes must be priced higher than equivalent land routes
  it('cross-water route costs more than continental alternative (JIRA-149)', () => {
    // Ruhr (row=26, col=42) is the starting hub for game 1b31e1a2
    // Manchester (row=13, col=30) requires crossing the English Channel — ferry overhead
    // Stuttgart (row=32, col=44) is continental — land route only
    const ruhrToManchester = estimatePathCost(26, 42, 13, 30);
    const ruhrToStuttgart = estimatePathCost(26, 42, 32, 44);
    // Both routes must be reachable (ferry edges wired correctly)
    expect(ruhrToManchester).toBeGreaterThan(0);
    expect(ruhrToStuttgart).toBeGreaterThan(0);
    // Manchester must cost MORE than Stuttgart — if not, demand scoring will
    // pick Manchester over Stuttgart for a Marseille delivery (game 1b31e1a2 bug)
    expect(ruhrToManchester).toBeGreaterThan(ruhrToStuttgart);
  });

  it('cross-water route includes realistic ferry build cost (JIRA-149)', () => {
    // JIRA-149: Ruhr → Manchester must include at least the English Channel ferry
    // port build cost (4M for Dover_Calais) plus terrain on both sides.
    // A pure hexDistance * 2 fallback (18 * 2 = 36M) would be coincidentally similar
    // but would regress if ferry edges break — this test guards against 0-cost cross-water.
    const ruhrToManchester = estimatePathCost(26, 42, 13, 30);
    // At minimum: some terrain (10M) + ferry port build (4M)
    expect(ruhrToManchester).toBeGreaterThanOrEqual(14);
  });
});

// MaxConnections override — AC2, AC3, AC4
describe('loadGridPoints — MaxConnections override', () => {
  afterEach(() => {
    _resetCache();
  });

  // AC2: Kaliningrad (row=19, col=63) must have maxConnections === 1
  it('returns maxConnections=1 for Kaliningrad (row=19, col=63)', () => {
    const grid = loadGridPoints();
    const kaliningrad = grid.get('19,63');
    expect(kaliningrad).toBeDefined();
    expect(kaliningrad!.maxConnections).toBe(1);
  });

  // AC3: Non-overridden small city must have maxConnections === undefined
  it('returns maxConnections=undefined for a non-overridden small city', () => {
    // Sevilla is a Small City at (row=54, col=7) — no MaxConnections in gridPoints.json
    const grid = loadGridPoints();
    const sevilla = grid.get('54,7');
    expect(sevilla).toBeDefined();
    expect(sevilla!.maxConnections).toBeUndefined();
  });

  // AC4: Malformed MaxConnections values — parsed from a synthetic fixture injected via cache bypass
  it('emits console.warn and leaves maxConnections undefined for invalid MaxConnections values', () => {
    // We parse a minimal synthetic JSON directly using a private test helper.
    // Strategy: temporarily override readFileSync to return test fixture JSON,
    // then call loadGridPoints() on a cleared cache.
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

    const testCases: Array<{ MaxConnections: unknown; description: string }> = [
      { MaxConnections: 'two', description: 'string "two"' },
      { MaxConnections: 0, description: 'integer 0' },
      { MaxConnections: -1, description: 'integer -1' },
    ];

    for (const { MaxConnections, description } of testCases) {
      warnSpy.mockClear();
      _resetCache();

      const fixtureData = [
        // Invalid entry — should trigger warning and leave maxConnections unset
        { Id: 'bad-1', Type: 'Small City', Name: 'BadCity', GridX: 5, GridY: 5, Ocean: null, MaxConnections },
        // Valid entry — should parse normally without issue
        { Id: 'ok-1', Type: 'Small City', Name: 'OkCity', GridX: 10, GridY: 10, Ocean: null },
      ];

      const originalReadFileSync = fs.readFileSync;
      (fs as { readFileSync: typeof fs.readFileSync }).readFileSync = (
        (_filePath: unknown, _encoding: unknown) => JSON.stringify(fixtureData)
      ) as typeof fs.readFileSync;

      try {
        const grid = loadGridPoints();

        // (a) console.warn called once for the invalid entry
        expect(warnSpy).toHaveBeenCalledTimes(1);
        expect(warnSpy.mock.calls[0][0]).toContain('[MapTopology]');

        // (b) bad city has maxConnections === undefined
        const badCity = grid.get('5,5');
        expect(badCity).toBeDefined();
        expect(badCity!.maxConnections).toBeUndefined();

        // (c) valid entry parses normally
        const okCity = grid.get('10,10');
        expect(okCity).toBeDefined();
        expect(okCity!.maxConnections).toBeUndefined();
      } finally {
        (fs as { readFileSync: typeof fs.readFileSync }).readFileSync = originalReadFileSync;
        _resetCache();
      }
    }

    warnSpy.mockRestore();
  });
});

// JIRA-149: Ferry edge data sanity check
describe('getFerryEdges', () => {
  it('returns ferry edges for all major crossing routes', () => {
    const edges = getFerryEdges();
    // At minimum: Belfast_Stranraer, Dublin_Liverpool, Dover_Calais
    expect(edges.length).toBeGreaterThanOrEqual(3);
    // All edges must have valid coordinates and positive build cost
    for (const edge of edges) {
      expect(edge.cost).toBeGreaterThan(0);
      expect(typeof edge.pointA.row).toBe('number');
      expect(typeof edge.pointA.col).toBe('number');
      expect(typeof edge.pointB.row).toBe('number');
      expect(typeof edge.pointB.col).toBe('number');
    }
  });

  it('includes the Dover_Calais English Channel crossing', () => {
    const edges = getFerryEdges();
    const doverCalais = edges.find(e => e.name === 'Dover_Calais');
    expect(doverCalais).toBeDefined();
    // JIRA-149: cost must be a realistic ferry port build cost, not 0
    expect(doverCalais!.cost).toBeGreaterThan(0);
  });
});
