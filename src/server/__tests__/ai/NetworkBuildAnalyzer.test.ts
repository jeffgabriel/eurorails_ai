/**
 * NetworkBuildAnalyzer.test.ts — Unit tests for findNearestNetworkPoint and detectParallelPath.
 *
 * Uses a small hex grid subset with mocked MapTopology for deterministic testing.
 */

import { NetworkBuildAnalyzer } from '../../services/ai/NetworkBuildAnalyzer';
import { TerrainType, TrackSegment } from '../../../shared/types/GameTypes';
import { GridPointData } from '../../services/ai/MapTopology';

// ── Mock MapTopology ────────────────────────────────────────────────────
// Use even-q offset hex grid neighbors matching the real implementation.
// For simplicity, we implement real hex neighbor logic inline.
function evenQHexNeighbors(row: number, col: number): { row: number; col: number }[] {
  const isEvenCol = col % 2 === 0;
  if (isEvenCol) {
    return [
      { row: row - 1, col },     // N
      { row: row + 1, col },     // S
      { row: row - 1, col: col - 1 }, // NW
      { row, col: col - 1 },     // SW
      { row: row - 1, col: col + 1 }, // NE
      { row, col: col + 1 },     // SE
    ];
  } else {
    return [
      { row: row - 1, col },     // N
      { row: row + 1, col },     // S
      { row, col: col - 1 },     // NW
      { row: row + 1, col: col - 1 }, // SW
      { row, col: col + 1 },     // NE
      { row: row + 1, col: col + 1 }, // SE
    ];
  }
}

jest.mock('../../services/ai/MapTopology', () => ({
  getHexNeighbors: (row: number, col: number) => evenQHexNeighbors(row, col),
  getTerrainCost: (terrain: number) => {
    switch (terrain) {
      case 1: return 1;  // Clear
      case 2: return 2;  // Mountain
      case 3: return 5;  // Alpine
      case 6: return 5;  // MajorCity
      case 8: return Infinity; // Water
      default: return 1;
    }
  },
  makeKey: (row: number, col: number) => `${row},${col}`,
  loadGridPoints: jest.fn(),
  gridToPixel: jest.fn(),
  hexDistance: jest.fn(),
  _resetCache: jest.fn(),
}));

jest.mock('../../../shared/services/majorCityGroups', () => ({
  getFerryEdges: jest.fn(() => []),
}));

// ── Test Grid Setup ─────────────────────────────────────────────────────
// A small 7x7 grid of clear terrain for testing
function buildTestGrid(overrides: Map<string, Partial<GridPointData>> = new Map()): Map<string, GridPointData> {
  const grid = new Map<string, GridPointData>();
  for (let row = 0; row < 7; row++) {
    for (let col = 0; col < 7; col++) {
      const key = `${row},${col}`;
      const base: GridPointData = { row, col, terrain: TerrainType.Clear };
      const override = overrides.get(key);
      grid.set(key, override ? { ...base, ...override } : base);
    }
  }
  return grid;
}

function makeSegment(fromR: number, fromC: number, toR: number, toC: number, cost = 1): TrackSegment {
  return {
    from: { x: 0, y: 0, row: fromR, col: fromC, terrain: TerrainType.Clear },
    to: { x: 0, y: 0, row: toR, col: toC, terrain: TerrainType.Clear },
    cost,
  };
}

// ── findNearestNetworkPoint Tests ───────────────────────────────────────

describe('NetworkBuildAnalyzer.findNearestNetworkPoint', () => {
  const gridPoints = buildTestGrid();

  it('returns null for empty network', () => {
    const result = NetworkBuildAnalyzer.findNearestNetworkPoint(
      { row: 3, col: 3 }, new Set(), gridPoints,
    );
    expect(result).toBeNull();
  });

  it('returns distance 0 when target is on the network', () => {
    const networkNodes = new Set(['3,3']);
    const result = NetworkBuildAnalyzer.findNearestNetworkPoint(
      { row: 3, col: 3 }, networkNodes, gridPoints,
    );
    expect(result).toEqual({ point: { row: 3, col: 3 }, distance: 0, buildCost: 0 });
  });

  it('finds adjacent network node at distance 1', () => {
    // Place a network node adjacent to target (3,3)
    // Even col 4: neighbors of (3,3) include (2,3), (4,3), (2,2), (3,2), (2,4), (3,4)
    // Col 3 is odd: neighbors include (2,3), (4,3), (3,2), (4,2), (3,4), (4,4)
    const networkNodes = new Set(['2,3']); // N neighbor of (3,3)
    const result = NetworkBuildAnalyzer.findNearestNetworkPoint(
      { row: 3, col: 3 }, networkNodes, gridPoints,
    );
    expect(result).not.toBeNull();
    expect(result!.distance).toBe(1);
    expect(result!.point).toEqual({ row: 2, col: 3 });
    expect(result!.buildCost).toBe(1); // clear terrain = 1M
  });

  it('returns null when network is beyond maxDistance', () => {
    const networkNodes = new Set(['0,0']); // far from (3,3)
    const result = NetworkBuildAnalyzer.findNearestNetworkPoint(
      { row: 3, col: 3 }, networkNodes, gridPoints, 1, // very short maxDistance
    );
    expect(result).toBeNull();
  });

  it('accumulates terrain cost through mountains', () => {
    const mountainGrid = buildTestGrid(new Map([
      ['2,3', { row: 2, col: 3, terrain: TerrainType.Mountain }],
    ]));
    const networkNodes = new Set(['2,3']);
    const result = NetworkBuildAnalyzer.findNearestNetworkPoint(
      { row: 3, col: 3 }, networkNodes, mountainGrid,
    );
    expect(result).not.toBeNull();
    expect(result!.buildCost).toBe(2); // mountain = 2M
  });

  it('skips unbuildable water terrain', () => {
    // Block direct path with water, but leave an alternate route
    const waterGrid = buildTestGrid(new Map([
      ['2,3', { row: 2, col: 3, terrain: TerrainType.Water }],
    ]));
    // Network node at (1,3) — direct N path through (2,3) blocked by water
    const networkNodes = new Set(['1,3']);
    const result = NetworkBuildAnalyzer.findNearestNetworkPoint(
      { row: 3, col: 3 }, networkNodes, waterGrid,
    );
    // Should still find (1,3) via alternate route (distance > 1)
    expect(result).not.toBeNull();
    expect(result!.point).toEqual({ row: 1, col: 3 });
    expect(result!.distance).toBeGreaterThan(1);
  });
});

// ── detectParallelPath Tests ────────────────────────────────────────────

describe('NetworkBuildAnalyzer.detectParallelPath', () => {
  const gridPoints = buildTestGrid();

  it('returns not parallel for short paths (< 3 points)', () => {
    const result = NetworkBuildAnalyzer.detectParallelPath(
      [{ row: 1, col: 1 }, { row: 2, col: 1 }],
      [makeSegment(1, 2, 2, 2)],
      gridPoints,
    );
    expect(result.isParallel).toBe(false);
  });

  it('returns not parallel when no existing segments', () => {
    const result = NetworkBuildAnalyzer.detectParallelPath(
      [{ row: 1, col: 1 }, { row: 2, col: 1 }, { row: 3, col: 1 }, { row: 4, col: 1 }],
      [],
      gridPoints,
    );
    expect(result.isParallel).toBe(false);
  });

  it('returns not parallel with 2 nearby segments (below threshold)', () => {
    // Existing track at col 2, proposed path at col 1
    // Only 2 points near existing — not enough for parallel (threshold is 3)
    const existingSegments = [
      makeSegment(1, 2, 2, 2),
    ];
    // A path with 3 points, but only 2 should be detected near (1,2) and (2,2)
    const result = NetworkBuildAnalyzer.detectParallelPath(
      [{ row: 1, col: 1 }, { row: 2, col: 1 }, { row: 5, col: 5 }],
      existingSegments,
      gridPoints,
    );
    expect(result.isParallel).toBe(false);
  });

  it('detects parallel when 3+ consecutive points near existing track', () => {
    // Build a vertical track from (1,3) to (4,3)
    const existingSegments = [
      makeSegment(1, 3, 2, 3),
      makeSegment(2, 3, 3, 3),
      makeSegment(3, 3, 4, 3),
    ];
    // Proposed path runs parallel 1 hex away at col 4
    // Col 4 is even, so neighbors of (1,4) include (0,3), (1,3)... — (1,3) is on network
    const proposedPath = [
      { row: 1, col: 4 },
      { row: 2, col: 4 },
      { row: 3, col: 4 },
      { row: 4, col: 4 },
    ];
    const result = NetworkBuildAnalyzer.detectParallelPath(
      proposedPath, existingSegments, gridPoints,
    );
    expect(result.isParallel).toBe(true);
    expect(result.parallelSegmentCount).toBeGreaterThanOrEqual(3);
    expect(result.suggestedWaypoint).toBeDefined();
    expect(result.existingTrackNearby).toBeDefined();
    expect(result.existingTrackNearby!.length).toBeGreaterThan(0);
  });

  it('does not flag intersection as parallel', () => {
    // Existing track at (3,3)
    const existingSegments = [
      makeSegment(2, 3, 3, 3),
      makeSegment(3, 3, 4, 3),
    ];
    // Path crosses through the existing track (includes (3,3) which is ON network)
    const proposedPath = [
      { row: 3, col: 2 },
      { row: 3, col: 3 }, // ON the network — intersection, not parallel
      { row: 3, col: 4 },
    ];
    const result = NetworkBuildAnalyzer.detectParallelPath(
      proposedPath, existingSegments, gridPoints,
    );
    // Point (3,3) is ON the network so counts as intersection, not parallel
    // The other points may or may not be near — but the intersection breaks the chain
    expect(result.parallelSegmentCount).toBeLessThan(3);
  });

  it('does not flag non-consecutive nearby segments as parallel', () => {
    // Existing track at col 3
    const existingSegments = [
      makeSegment(1, 3, 2, 3),
      makeSegment(2, 3, 3, 3),
    ];
    // Path with gaps: 2 near, 1 far, 2 near — should not be consecutive
    const proposedPath = [
      { row: 1, col: 4 }, // near (1,3)
      { row: 2, col: 4 }, // near (2,3)
      { row: 3, col: 6 }, // far from any network
      { row: 4, col: 4 }, // near... but no network at (4,3)
      { row: 5, col: 4 }, // no network nearby
    ];
    const result = NetworkBuildAnalyzer.detectParallelPath(
      proposedPath, existingSegments, gridPoints,
    );
    // Max consecutive nearby is 2, below threshold of 3
    expect(result.isParallel).toBe(false);
  });
});

// ── shouldSkipAnalysis Tests ────────────────────────────────────────────

describe('NetworkBuildAnalyzer.shouldSkipAnalysis', () => {
  it('returns true for empty segments', () => {
    expect(NetworkBuildAnalyzer.shouldSkipAnalysis([])).toBe(true);
  });

  it('returns true for 2 segments', () => {
    const segs = [makeSegment(1, 1, 2, 1), makeSegment(2, 1, 3, 1)];
    expect(NetworkBuildAnalyzer.shouldSkipAnalysis(segs)).toBe(true);
  });

  it('returns false for 3+ segments', () => {
    const segs = [
      makeSegment(1, 1, 2, 1),
      makeSegment(2, 1, 3, 1),
      makeSegment(3, 1, 4, 1),
    ];
    expect(NetworkBuildAnalyzer.shouldSkipAnalysis(segs)).toBe(false);
  });
});

// ── loadFerryData Tests ───────────────────────────────────────────────

describe('NetworkBuildAnalyzer.loadFerryData', () => {
  const { getFerryEdges } = require('../../../shared/services/majorCityGroups');

  beforeEach(() => {
    NetworkBuildAnalyzer._resetFerryCache();
    getFerryEdges.mockClear();
  });

  it('returns ferry edges from getFerryEdges', () => {
    const mockEdges = [
      { name: 'TestFerry', pointA: { row: 1, col: 1 }, pointB: { row: 5, col: 5 }, cost: 4 },
    ];
    getFerryEdges.mockReturnValue(mockEdges);
    const result = NetworkBuildAnalyzer.loadFerryData();
    expect(result).toEqual(mockEdges);
    expect(getFerryEdges).toHaveBeenCalledTimes(1);
  });

  it('caches result after first call', () => {
    const mockEdges = [
      { name: 'TestFerry', pointA: { row: 1, col: 1 }, pointB: { row: 5, col: 5 }, cost: 4 },
    ];
    getFerryEdges.mockReturnValue(mockEdges);
    NetworkBuildAnalyzer.loadFerryData();
    NetworkBuildAnalyzer.loadFerryData();
    expect(getFerryEdges).toHaveBeenCalledTimes(1);
  });

  it('returns empty array on error', () => {
    getFerryEdges.mockImplementation(() => { throw new Error('file not found'); });
    const result = NetworkBuildAnalyzer.loadFerryData();
    expect(result).toEqual([]);
  });
});

// ── findNearbyFerryPorts Tests ────────────────────────────────────────

describe('NetworkBuildAnalyzer.findNearbyFerryPorts', () => {
  const gridPoints = buildTestGrid();

  // Test ferry: portA at (1,2), portB at (5,5), cost 8M
  const testFerryData = [
    { name: 'Test_Ferry', pointA: { row: 1, col: 2 }, pointB: { row: 5, col: 5 }, cost: 8 },
  ];

  it('returns opportunity when network is 2 segments from ferry port', () => {
    // Network node at (3,2) — 2 hops from ferry portA (1,2)
    const networkNodes = new Set(['3,2']);
    const result = NetworkBuildAnalyzer.findNearbyFerryPorts(
      networkNodes, gridPoints, testFerryData, 4,
    );
    // Should find portA side opportunity
    const portAOpps = result.filter(o => o.ferryPort.row === 1 && o.ferryPort.col === 2);
    expect(portAOpps.length).toBe(1);
    expect(portAOpps[0].ferryName).toBe('Test_Ferry');
    expect(portAOpps[0].spurCost).toBeGreaterThan(0);
    expect(portAOpps[0].ferryCost).toBe(8);
    expect(portAOpps[0].destinationSide).toEqual({ row: 5, col: 5 });
  });

  it('returns empty array when network is beyond maxDistance from all ferries', () => {
    // Network node far from any ferry port
    const networkNodes = new Set(['6,6']);
    const result = NetworkBuildAnalyzer.findNearbyFerryPorts(
      networkNodes, gridPoints, testFerryData, 1, // very short maxDistance
    );
    // portA at (1,2) is far from (6,6), portB at (5,5) — check if (6,6) is within 1 of (5,5)
    // (5,5) neighbors for odd col: (4,5),(6,5),(5,4),(6,4),(5,6),(6,6) — (6,6) IS a neighbor
    // So portB side may find it. Let's use a truly far node instead.
    const farNodes = new Set(['0,6']);
    const farResult = NetworkBuildAnalyzer.findNearbyFerryPorts(
      farNodes, gridPoints, testFerryData, 1,
    );
    expect(farResult.length).toBe(0);
  });

  it('returns opportunity with spurCost 0 when network is directly at ferry port', () => {
    // Network directly at portA
    const networkNodes = new Set(['1,2']);
    const result = NetworkBuildAnalyzer.findNearbyFerryPorts(
      networkNodes, gridPoints, testFerryData, 4,
    );
    const portAOpps = result.filter(o => o.ferryPort.row === 1 && o.ferryPort.col === 2);
    expect(portAOpps.length).toBe(1);
    expect(portAOpps[0].spurCost).toBe(0);
    expect(portAOpps[0].networkPoint).toEqual({ row: 1, col: 2 });
  });

  it('returns multiple ferry opportunities sorted by spurCost', () => {
    const multiFerryData = [
      { name: 'Cheap_Ferry', pointA: { row: 2, col: 2 }, pointB: { row: 6, col: 6 }, cost: 4 },
      { name: 'Far_Ferry', pointA: { row: 4, col: 4 }, pointB: { row: 6, col: 1 }, cost: 8 },
    ];
    // Network at (3,3) — closer to (2,2) than to (4,4) via BFS
    const networkNodes = new Set(['3,3']);
    const result = NetworkBuildAnalyzer.findNearbyFerryPorts(
      networkNodes, gridPoints, multiFerryData, 4,
    );
    expect(result.length).toBeGreaterThan(0);
    // Verify sorted by spurCost ascending
    for (let i = 1; i < result.length; i++) {
      expect(result[i].spurCost).toBeGreaterThanOrEqual(result[i - 1].spurCost);
    }
  });

  it('returns empty array when ferry data is empty', () => {
    const networkNodes = new Set(['3,3']);
    const result = NetworkBuildAnalyzer.findNearbyFerryPorts(
      networkNodes, gridPoints, [], 4,
    );
    expect(result).toEqual([]);
  });
});

// ── findSpurOpportunities Tests ───────────────────────────────────────

describe('NetworkBuildAnalyzer.findSpurOpportunities', () => {
  const gridPoints = buildTestGrid();

  it('returns SpurOpportunity when demand city is 2 segments from network', () => {
    const networkNodes = new Set(['3,3']);
    const demandCities = [{ city: 'TestCity', position: { row: 1, col: 3 } }];
    const result = NetworkBuildAnalyzer.findSpurOpportunities(
      networkNodes, demandCities, gridPoints, 3,
    );
    expect(result.length).toBe(1);
    expect(result[0].city).toBe('TestCity');
    expect(result[0].spurSegments).toBe(2);
    expect(result[0].spurCost).toBeGreaterThan(0);
    expect(result[0].nearestNetworkPoint).toEqual({ row: 3, col: 3 });
  });

  it('does not return city already on the network', () => {
    const networkNodes = new Set(['3,3']);
    const demandCities = [{ city: 'OnNetwork', position: { row: 3, col: 3 } }];
    const result = NetworkBuildAnalyzer.findSpurOpportunities(
      networkNodes, demandCities, gridPoints, 3,
    );
    expect(result.length).toBe(0);
  });

  it('does not return city beyond maxDistance', () => {
    const networkNodes = new Set(['0,0']);
    const demandCities = [{ city: 'FarCity', position: { row: 6, col: 6 } }];
    const result = NetworkBuildAnalyzer.findSpurOpportunities(
      networkNodes, demandCities, gridPoints, 2, // very short maxDistance
    );
    expect(result.length).toBe(0);
  });

  it('returns multiple demand cities sorted by spurCost', () => {
    // Network at (3,3): city at (2,3) is 1 hop, city at (5,3) is 2 hops
    const networkNodes = new Set(['3,3']);
    const demandCities = [
      { city: 'FarCity', position: { row: 5, col: 3 } },
      { city: 'NearCity', position: { row: 2, col: 3 } },
    ];
    const result = NetworkBuildAnalyzer.findSpurOpportunities(
      networkNodes, demandCities, gridPoints, 3,
    );
    expect(result.length).toBe(2);
    // Sorted by spurCost ascending — NearCity should be first
    expect(result[0].city).toBe('NearCity');
    expect(result[0].spurCost).toBeLessThanOrEqual(result[1].spurCost);
  });

  it('returns empty array when demandCities is empty', () => {
    const networkNodes = new Set(['3,3']);
    const result = NetworkBuildAnalyzer.findSpurOpportunities(
      networkNodes, [], gridPoints, 3,
    );
    expect(result).toEqual([]);
  });
});
