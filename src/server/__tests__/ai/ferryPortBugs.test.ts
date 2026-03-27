/**
 * JIRA-110: Ferry port handling bug fix tests.
 *
 * Tests 4 bug fixes:
 *   Bug 1: findCityMilepost now includes FerryPort terrain (tested via real grid data)
 *   Bug 2: computeReachableCities now includes FerryPort city names
 *   Bug 3: milepostsMoved uses computeEffectivePathLength
 *   Bug 4: truncatePathToEffectiveBudget enforces ferry port boundaries
 */

// ─── Mocks (hoisted by Jest) ───────────────────────────────────────────────
jest.mock('../../services/ai/ActionResolver', () => ({
  ActionResolver: {
    resolve: jest.fn(),
    cloneSnapshot: jest.fn(),
    applyPlanToState: jest.fn(),
  },
}));
// PlanExecutor deleted — no longer needed
jest.mock('../../services/ai/MapTopology', () => ({
  loadGridPoints: jest.fn(() => new Map()),
  getHexNeighbors: jest.fn(() => []),
  getTerrainCost: jest.fn(() => 1),
  gridToPixel: jest.fn(() => ({ x: 0, y: 0 })),
  getFerryPairPort: jest.fn(() => null),
  _resetCache: jest.fn(),
}));
jest.mock('../../../shared/services/trackUsageFees', () => ({
  buildUnionTrackGraph: jest.fn(() => ({ adjacency: new Map(), edgeOwners: new Map() })),
  computeTrackUsageForMove: jest.fn(() => ({ feeTotal: 0, ownersUsed: [], ownersPaid: [] })),
}));
jest.mock('../../services/ai/computeBuildSegments', () => ({
  computeBuildSegments: jest.fn(() => []),
}));

// ─── Imports ───────────────────────────────────────────────────────────────

import { ContextBuilder } from '../../services/ai/ContextBuilder';
import { loadGridPoints, getFerryPairPort } from '../../services/ai/MapTopology';
import { computeEffectivePathLength, getMajorCityLookup } from '../../../shared/services/majorCityGroups';
import {
  GridPoint,
  TerrainType,
  TrackSegment,
} from '../../../shared/types/GameTypes';

const mockLoadGridPoints = loadGridPoints as jest.Mock;

// ─── Helper factories ──────────────────────────────────────────────────────

function makeGridPoint(
  row: number,
  col: number,
  overrides?: Partial<GridPoint>,
): GridPoint {
  return {
    id: `gp-${row}-${col}`,
    x: col * 40,
    y: row * 40,
    row,
    col,
    terrain: TerrainType.Clear,
    city: undefined,
    ...overrides,
  };
}

function makeCityPoint(
  row: number, col: number, name: string,
  terrain: TerrainType = TerrainType.SmallCity,
): GridPoint {
  return makeGridPoint(row, col, {
    terrain,
    city: { type: terrain, name, availableLoads: [] },
  });
}

/** FerryPort GridPoint — has top-level `name` but NO `city` property (matches real data) */
function makeFerryPortPoint(row: number, col: number, name: string): GridPoint {
  return makeGridPoint(row, col, {
    terrain: TerrainType.FerryPort,
    name,
  });
}

function makeSegment(
  fromRow: number, fromCol: number,
  toRow: number, toCol: number,
): TrackSegment {
  return {
    from: { x: fromCol * 40, y: fromRow * 40, row: fromRow, col: fromCol, terrain: TerrainType.Clear },
    to: { x: toCol * 40, y: toRow * 40, row: toRow, col: toCol, terrain: TerrainType.Clear },
    cost: 1,
  };
}

/** Build a minimal track network from segments (real implementation) */
function buildNetwork(segments: TrackSegment[]) {
  const nodes = new Set<string>();
  const edges = new Map<string, Set<string>>();
  for (const seg of segments) {
    const fk = `${seg.from.row},${seg.from.col}`;
    const tk = `${seg.to.row},${seg.to.col}`;
    nodes.add(fk);
    nodes.add(tk);
    if (!edges.has(fk)) edges.set(fk, new Set());
    if (!edges.has(tk)) edges.set(tk, new Set());
    edges.get(fk)!.add(tk);
    edges.get(tk)!.add(fk);
  }
  return { nodes, edges };
}

// ─── Bug 2: computeReachableCities includes FerryPort cities ───────────────

describe('Bug 2: computeReachableCities — FerryPort city inclusion', () => {
  it('should include a FerryPort city when bot is positioned at that ferry port', () => {
    const gridPoints: GridPoint[] = [
      makeFerryPortPoint(22, 33, 'Dover'),
      makeGridPoint(22, 32),
    ];

    const segments = [makeSegment(22, 32, 22, 33)];
    const network = buildNetwork(segments);

    const result = ContextBuilder.computeReachableCities(
      { row: 22, col: 33 }, 9, network, gridPoints,
    );

    expect(result).toContain('Dover');
  });

  it('should include a FerryPort city within BFS range on the track network', () => {
    const gridPoints: GridPoint[] = [
      makeGridPoint(22, 31),
      makeGridPoint(22, 32),
      makeFerryPortPoint(22, 33, 'Dover'),
    ];

    const segments = [
      makeSegment(22, 31, 22, 32),
      makeSegment(22, 32, 22, 33),
    ];
    const network = buildNetwork(segments);

    const result = ContextBuilder.computeReachableCities(
      { row: 22, col: 31 }, 9, network, gridPoints,
    );

    expect(result).toContain('Dover');
  });

  it('should still include regular cities (regression)', () => {
    const gridPoints: GridPoint[] = [
      makeGridPoint(10, 10),
      makeCityPoint(10, 11, 'Birmingham', TerrainType.MediumCity),
    ];

    const segments = [makeSegment(10, 10, 10, 11)];
    const network = buildNetwork(segments);

    const result = ContextBuilder.computeReachableCities(
      { row: 10, col: 10 }, 9, network, gridPoints,
    );

    expect(result).toContain('Birmingham');
  });

  it('should not duplicate city names when both city and name properties exist', () => {
    const gridPoints: GridPoint[] = [
      makeGridPoint(5, 5),
      makeGridPoint(5, 6, {
        terrain: TerrainType.FerryPort,
        name: 'Dublin',
        city: { type: TerrainType.FerryPort, name: 'Dublin', availableLoads: [] },
      }),
    ];

    const segments = [makeSegment(5, 5, 5, 6)];
    const network = buildNetwork(segments);

    const result = ContextBuilder.computeReachableCities(
      { row: 5, col: 5 }, 9, network, gridPoints,
    );

    const dublinCount = result.filter(c => c === 'Dublin').length;
    expect(dublinCount).toBe(1);
  });
});

// ─── Bug 3: computeEffectivePathLength discounts intra-city hops ───────────

describe('Bug 3: computeEffectivePathLength — intra-city hops are free', () => {
  it('should discount intra-city edges from path length', () => {
    // Use a custom lookup with known city assignments
    const lookup = new Map<string, string>([
      ['10,10', 'TestCity'],
      ['10,11', 'TestCity'],
    ]);

    // Path: external(9,10) → city(10,10) → city(10,11) [free] → external(11,11)
    const path = [
      { row: 9, col: 10 },
      { row: 10, col: 10 },  // TestCity
      { row: 10, col: 11 },  // TestCity (intra-city = free)
      { row: 11, col: 11 },  // external
    ];

    const rawLength = path.length - 1; // 3
    const effectiveLength = computeEffectivePathLength(path, lookup);

    // 1 free intra-city edge: effective = 2
    expect(effectiveLength).toBe(2);
    expect(effectiveLength).toBeLessThan(rawLength);
  });

  it('should count all edges when no intra-city hops exist', () => {
    const lookup = new Map<string, string>();

    const path = [
      { row: 1, col: 1 },
      { row: 2, col: 2 },
      { row: 3, col: 3 },
    ];

    const effectiveLength = computeEffectivePathLength(path, lookup);
    expect(effectiveLength).toBe(2); // raw = effective when no city hops
  });
});

// Bug 4: truncatePathToEffectiveBudget was a private method of TurnComposer (now deleted).
// This functionality is no longer needed in the new TurnExecutorPlanner architecture.

// ─── JIRA-121 Bug 2: BFS ferry teleportation when bot starts at ferry port ──

const mockGetFerryPairPort = getFerryPairPort as jest.Mock;

describe('JIRA-121 Bug 2: BFS ferry teleportation from ferry port start', () => {
  it('should include cities reachable via ferry teleportation when bot starts at a ferry port', () => {
    // Bot starts at Dover (ferry port at 22,33)
    // Paired port is Calais (22,35)
    // Dublin is 2 hops from Calais: Calais(22,35) → (22,36) → Dublin(22,37)
    const gridPoints: GridPoint[] = [
      makeFerryPortPoint(22, 33, 'Dover'),
      makeGridPoint(22, 32),
      makeFerryPortPoint(22, 35, 'Calais'),
      makeGridPoint(22, 36),
      makeCityPoint(22, 37, 'Dublin', TerrainType.MajorCity),
    ];

    // Network: Dover has track to (22,32), and Calais has track to (22,36) → Dublin
    const segments = [
      makeSegment(22, 32, 22, 33),  // track to Dover
      makeSegment(22, 35, 22, 36),  // track from Calais
      makeSegment(22, 36, 22, 37),  // track to Dublin
    ];
    const network = buildNetwork(segments);

    // Mock: getFerryPairPort returns Calais when called for Dover
    mockGetFerryPairPort.mockReturnValueOnce({ row: 22, col: 35 });

    const result = ContextBuilder.computeReachableCities(
      { row: 22, col: 33 }, 5, network, gridPoints,
    );

    expect(result).toContain('Dublin');
    expect(result).toContain('Calais');
  });

  it('should NOT teleport when bot is at a ferry port but paired port is not on network', () => {
    const gridPoints: GridPoint[] = [
      makeFerryPortPoint(22, 33, 'Dover'),
      makeGridPoint(22, 32),
      makeFerryPortPoint(22, 35, 'Calais'),
    ];

    const segments = [
      makeSegment(22, 32, 22, 33),  // track to Dover only
    ];
    const network = buildNetwork(segments);

    // Paired port exists but is NOT on the network
    mockGetFerryPairPort.mockReturnValueOnce({ row: 22, col: 35 });

    const result = ContextBuilder.computeReachableCities(
      { row: 22, col: 33 }, 5, network, gridPoints,
    );

    // Should still include Dover (starting position) but NOT Calais (not on network)
    expect(result).toContain('Dover');
    expect(result).not.toContain('Calais');
  });
});
