import { ContextBuilder } from '../../services/ai/ContextBuilder';
import {
  GridPoint, TerrainType, TrackSegment, TrackNetwork,
  WorldSnapshot, BotSkillLevel, GameStatus,
} from '../../../shared/types/GameTypes';
import { buildTrackNetwork } from '../../../shared/services/TrackNetworkService';

// ── Helper factories ────────────────────────────────────────────────────────

/** Create a minimal GridPoint at a given row/col */
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

/** Create a GridPoint with a city */
function makeCityPoint(
  row: number,
  col: number,
  name: string,
  terrain: TerrainType = TerrainType.SmallCity,
  availableLoads: string[] = [],
): GridPoint {
  return makeGridPoint(row, col, {
    terrain,
    city: { type: terrain, name, availableLoads },
  });
}

/** Create a ferry port GridPoint */
function makeFerryPoint(row: number, col: number, name?: string): GridPoint {
  return makeGridPoint(row, col, {
    terrain: TerrainType.FerryPort,
    ...(name ? { city: { type: TerrainType.FerryPort, name, availableLoads: [] } } : {}),
  });
}

/** Create a TrackSegment between two positions */
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

/**
 * Build a linear chain of segments: (r0,c0) -> (r1,c1) -> (r2,c2) -> ...
 * Returns the segments and the built network.
 */
function buildLinearNetwork(
  points: Array<[number, number]>,
): { segments: TrackSegment[]; network: ReturnType<typeof buildTrackNetwork> } {
  const segments: TrackSegment[] = [];
  for (let i = 0; i < points.length - 1; i++) {
    segments.push(makeSegment(points[i][0], points[i][1], points[i + 1][0], points[i + 1][1]));
  }
  return { segments, network: buildTrackNetwork(segments) };
}

// ── TEST-001: computeReachableCities ────────────────────────────────────────

describe('ContextBuilder.computeReachableCities', () => {

  // ── Basic reachability ──────────────────────────────────────────────────

  describe('basic reachability and speed limits', () => {
    it('should return only the starting city when speed is 0', () => {
      // Network: A(0,0) - (0,1) - B(0,2)
      const { network } = buildLinearNetwork([[0, 0], [0, 1], [0, 2]]);
      const gridPoints = [
        makeCityPoint(0, 0, 'CityA'),
        makeGridPoint(0, 1),
        makeCityPoint(0, 2, 'CityB'),
      ];

      const result = ContextBuilder.computeReachableCities(
        { row: 0, col: 0 }, 0, network, gridPoints,
      );

      expect(result).toEqual(['CityA']);
    });

    it('should return cities within exact speed limit', () => {
      // Linear chain: CityA(0,0) - (0,1) - CityB(0,2) with speed 2
      const { network } = buildLinearNetwork([[0, 0], [0, 1], [0, 2]]);
      const gridPoints = [
        makeCityPoint(0, 0, 'CityA'),
        makeGridPoint(0, 1),
        makeCityPoint(0, 2, 'CityB'),
      ];

      const result = ContextBuilder.computeReachableCities(
        { row: 0, col: 0 }, 2, network, gridPoints,
      );

      expect(result).toContain('CityA');
      expect(result).toContain('CityB');
    });

    it('should not return cities beyond speed limit', () => {
      // Linear: A(0,0) - (0,1) - (0,2) - B(0,3), speed=2
      const { network } = buildLinearNetwork([[0, 0], [0, 1], [0, 2], [0, 3]]);
      const gridPoints = [
        makeCityPoint(0, 0, 'CityA'),
        makeGridPoint(0, 1),
        makeGridPoint(0, 2),
        makeCityPoint(0, 3, 'CityB'),
      ];

      const result = ContextBuilder.computeReachableCities(
        { row: 0, col: 0 }, 2, network, gridPoints,
      );

      expect(result).toContain('CityA');
      expect(result).not.toContain('CityB');
    });

    it('should find cities exactly at speed limit boundary', () => {
      // Linear: A(0,0) - (0,1) - (0,2) - B(0,3), speed=3
      const { network } = buildLinearNetwork([[0, 0], [0, 1], [0, 2], [0, 3]]);
      const gridPoints = [
        makeCityPoint(0, 0, 'CityA'),
        makeGridPoint(0, 1),
        makeGridPoint(0, 2),
        makeCityPoint(0, 3, 'CityB'),
      ];

      const result = ContextBuilder.computeReachableCities(
        { row: 0, col: 0 }, 3, network, gridPoints,
      );

      expect(result).toContain('CityA');
      expect(result).toContain('CityB');
    });

    it('should find multiple cities at different distances', () => {
      // A(0,0) -> mid(0,1) -> B(0,2) -> C(0,3), speed=9
      const { network } = buildLinearNetwork([[0, 0], [0, 1], [0, 2], [0, 3]]);
      const gridPoints = [
        makeCityPoint(0, 0, 'CityA'),
        makeGridPoint(0, 1),
        makeCityPoint(0, 2, 'CityB'),
        makeCityPoint(0, 3, 'CityC'),
      ];

      const result = ContextBuilder.computeReachableCities(
        { row: 0, col: 0 }, 9, network, gridPoints,
      );

      expect(result).toEqual(expect.arrayContaining(['CityA', 'CityB', 'CityC']));
      expect(result).toHaveLength(3);
    });

    it('should handle starting in the middle of a network', () => {
      // A(0,0) - mid(0,1) - B(0,2) - mid(0,3) - C(0,4)
      // Start at (0,2) = CityB, speed 2
      const { network } = buildLinearNetwork([[0, 0], [0, 1], [0, 2], [0, 3], [0, 4]]);
      const gridPoints = [
        makeCityPoint(0, 0, 'CityA'),
        makeGridPoint(0, 1),
        makeCityPoint(0, 2, 'CityB'),
        makeGridPoint(0, 3),
        makeCityPoint(0, 4, 'CityC'),
      ];

      const result = ContextBuilder.computeReachableCities(
        { row: 0, col: 2 }, 2, network, gridPoints,
      );

      expect(result).toEqual(expect.arrayContaining(['CityA', 'CityB', 'CityC']));
    });

    it('should handle speed = 1 reaching an adjacent city', () => {
      // A(0,0) - B(0,1)
      const { network } = buildLinearNetwork([[0, 0], [0, 1]]);
      const gridPoints = [
        makeCityPoint(0, 0, 'CityA'),
        makeCityPoint(0, 1, 'CityB'),
      ];

      const result = ContextBuilder.computeReachableCities(
        { row: 0, col: 0 }, 1, network, gridPoints,
      );

      expect(result).toContain('CityA');
      expect(result).toContain('CityB');
    });
  });

  // ── Ferry node logic ──────────────────────────────────────────────────

  describe('ferry node depth-halving logic', () => {
    it('should halve remaining speed at ferry nodes', () => {
      // A(0,0) -> Ferry(0,1) -> (0,2) -> (0,3) -> B(0,4)
      // Start at A, speed 9. Cost to reach ferry = 1, remaining = 8.
      // Ferry halves: floor((8) / 2) = 4 remaining after ferry.
      // So we can reach 4 more mileposts after ferry: (0,2), (0,3), (0,4), and beyond.
      // B at (0,4) is 3 mileposts after ferry -> reachable.
      const { network } = buildLinearNetwork([[0, 0], [0, 1], [0, 2], [0, 3], [0, 4]]);
      const gridPoints = [
        makeCityPoint(0, 0, 'CityA'),
        makeFerryPoint(0, 1),
        makeGridPoint(0, 2),
        makeGridPoint(0, 3),
        makeCityPoint(0, 4, 'CityB'),
      ];

      const result = ContextBuilder.computeReachableCities(
        { row: 0, col: 0 }, 9, network, gridPoints,
      );

      expect(result).toContain('CityA');
      expect(result).toContain('CityB');
    });

    it('should prevent reaching distant cities when ferry halves speed', () => {
      // A(0,0) -> Ferry(0,1) -> (0,2) -> (0,3) -> (0,4) -> (0,5) -> B(0,6)
      // Speed = 3. Cost to reach ferry = 1, remaining before halving = 2.
      // Ferry halves: floor((2) / 2) = 1 remaining after ferry.
      // Can only reach 1 more milepost after ferry: (0,2).
      // B at (0,6) is 5 away from ferry -> NOT reachable.
      const { network } = buildLinearNetwork([[0, 0], [0, 1], [0, 2], [0, 3], [0, 4], [0, 5], [0, 6]]);
      const gridPoints = [
        makeCityPoint(0, 0, 'CityA'),
        makeFerryPoint(0, 1),
        makeGridPoint(0, 2),
        makeGridPoint(0, 3),
        makeGridPoint(0, 4),
        makeGridPoint(0, 5),
        makeCityPoint(0, 6, 'CityB'),
      ];

      const result = ContextBuilder.computeReachableCities(
        { row: 0, col: 0 }, 3, network, gridPoints,
      );

      expect(result).toContain('CityA');
      expect(result).not.toContain('CityB');
    });

    it('should handle ferry at the start position (speed already halved)', () => {
      // Starting at Ferry(0,0) -> (0,1) -> (0,2) -> B(0,3)
      // Speed = 4, start is a ferry? The BFS logic halves remaining when arriving at
      // a ferry neighbor, not when starting at one. Starting at ferry doesn't halve.
      const { network } = buildLinearNetwork([[0, 0], [0, 1], [0, 2], [0, 3]]);
      const gridPoints = [
        makeFerryPoint(0, 0, 'FerryStart'),
        makeGridPoint(0, 1),
        makeGridPoint(0, 2),
        makeCityPoint(0, 3, 'CityB'),
      ];

      const result = ContextBuilder.computeReachableCities(
        { row: 0, col: 0 }, 4, network, gridPoints,
      );

      // Starting at ferry doesn't halve. Can reach 3 steps: (0,1), (0,2), (0,3)
      expect(result).toContain('FerryStart');
      expect(result).toContain('CityB');
    });

    it('should handle a ferry with named city (ferry-city hybrid)', () => {
      // A(0,0) -> FerryCity(0,1) -> (0,2) -> B(0,3)
      // Speed = 9. Arriving at ferry costs 1 + halves remaining.
      // Remaining at ferry: floor((9-1)/2) = 4. Can reach (0,2) and (0,3).
      const { network } = buildLinearNetwork([[0, 0], [0, 1], [0, 2], [0, 3]]);
      const gridPoints = [
        makeCityPoint(0, 0, 'CityA'),
        makeFerryPoint(0, 1, 'Dublin'),
        makeGridPoint(0, 2),
        makeCityPoint(0, 3, 'CityB'),
      ];

      const result = ContextBuilder.computeReachableCities(
        { row: 0, col: 0 }, 9, network, gridPoints,
      );

      expect(result).toContain('CityA');
      expect(result).toContain('Dublin');
      expect(result).toContain('CityB');
    });

    it('should handle two ferries in sequence', () => {
      // A(0,0) -> Ferry1(0,1) -> (0,2) -> Ferry2(0,3) -> (0,4) -> B(0,5)
      // Speed = 9.
      // A->Ferry1: remaining = floor((9-1)/2) = 4
      // Ferry1->(0,2): remaining = 3
      // (0,2)->Ferry2: remaining = floor((3-1)/2) = 1
      // Ferry2->(0,4): remaining = 0
      // Cannot reach B(0,5)
      const { network } = buildLinearNetwork([[0, 0], [0, 1], [0, 2], [0, 3], [0, 4], [0, 5]]);
      const gridPoints = [
        makeCityPoint(0, 0, 'CityA'),
        makeFerryPoint(0, 1),
        makeGridPoint(0, 2),
        makeFerryPoint(0, 3),
        makeGridPoint(0, 4),
        makeCityPoint(0, 5, 'CityB'),
      ];

      const result = ContextBuilder.computeReachableCities(
        { row: 0, col: 0 }, 9, network, gridPoints,
      );

      expect(result).toContain('CityA');
      expect(result).not.toContain('CityB');
    });

    it('should halve speed correctly: floor((remaining-1)/2)', () => {
      // A(0,0) -> Ferry(0,1) -> B(0,2)
      // Speed = 2. Remaining at start = 2.
      // Arriving at ferry: floor((2-1)/2) = floor(0.5) = 0.
      // So can reach the ferry itself but NOT B.
      const { network } = buildLinearNetwork([[0, 0], [0, 1], [0, 2]]);
      const gridPoints = [
        makeCityPoint(0, 0, 'CityA'),
        makeFerryPoint(0, 1, 'FerryCity'),
        makeCityPoint(0, 2, 'CityB'),
      ];

      const result = ContextBuilder.computeReachableCities(
        { row: 0, col: 0 }, 2, network, gridPoints,
      );

      expect(result).toContain('CityA');
      expect(result).toContain('FerryCity');
      expect(result).not.toContain('CityB');
    });
  });

  // ── Network topology ──────────────────────────────────────────────────

  describe('network topology', () => {
    it('should handle a branching network', () => {
      // Hub(1,1) connected to A(0,1), B(1,2), C(2,1)
      const segments = [
        makeSegment(1, 1, 0, 1),
        makeSegment(1, 1, 1, 2),
        makeSegment(1, 1, 2, 1),
      ];
      const network = buildTrackNetwork(segments);
      const gridPoints = [
        makeCityPoint(1, 1, 'Hub'),
        makeCityPoint(0, 1, 'CityA'),
        makeCityPoint(1, 2, 'CityB'),
        makeCityPoint(2, 1, 'CityC'),
      ];

      const result = ContextBuilder.computeReachableCities(
        { row: 1, col: 1 }, 1, network, gridPoints,
      );

      expect(result).toEqual(expect.arrayContaining(['Hub', 'CityA', 'CityB', 'CityC']));
      expect(result).toHaveLength(4);
    });

    it('should handle a dense network with multiple paths', () => {
      // Grid network: (0,0)-(0,1)-(0,2)
      //               (1,0)-(1,1)-(1,2)
      // All connected horizontally and vertically
      const segments = [
        makeSegment(0, 0, 0, 1), makeSegment(0, 1, 0, 2),
        makeSegment(1, 0, 1, 1), makeSegment(1, 1, 1, 2),
        makeSegment(0, 0, 1, 0), makeSegment(0, 1, 1, 1), makeSegment(0, 2, 1, 2),
      ];
      const network = buildTrackNetwork(segments);
      const gridPoints = [
        makeCityPoint(0, 0, 'NW'), makeGridPoint(0, 1), makeCityPoint(0, 2, 'NE'),
        makeGridPoint(1, 0), makeGridPoint(1, 1), makeCityPoint(1, 2, 'SE'),
      ];

      // Speed 2: can reach (0,1) and (0,2)=NE, or (1,0) and (1,1), or (0,1)+(1,1)
      // SE at (1,2) is 3 edges minimum from (0,0), so NOT reachable with speed 2
      const result2 = ContextBuilder.computeReachableCities(
        { row: 0, col: 0 }, 2, network, gridPoints,
      );
      expect(result2).toContain('NW');
      expect(result2).toContain('NE');
      expect(result2).not.toContain('SE');

      // Speed 3: SE is now reachable (3 edges via (0,0)->(0,1)->(0,2)->(1,2))
      const result3 = ContextBuilder.computeReachableCities(
        { row: 0, col: 0 }, 3, network, gridPoints,
      );
      expect(result3).toContain('NW');
      expect(result3).toContain('NE');
      expect(result3).toContain('SE');
    });

    it('should not reach cities in a disconnected component', () => {
      // Component 1: A(0,0) - (0,1) - B(0,2)
      // Component 2: C(5,0) - (5,1) - D(5,2)  (disconnected)
      const segments1 = [makeSegment(0, 0, 0, 1), makeSegment(0, 1, 0, 2)];
      const segments2 = [makeSegment(5, 0, 5, 1), makeSegment(5, 1, 5, 2)];
      const network = buildTrackNetwork([...segments1, ...segments2]);
      const gridPoints = [
        makeCityPoint(0, 0, 'CityA'), makeGridPoint(0, 1), makeCityPoint(0, 2, 'CityB'),
        makeCityPoint(5, 0, 'CityC'), makeGridPoint(5, 1), makeCityPoint(5, 2, 'CityD'),
      ];

      const result = ContextBuilder.computeReachableCities(
        { row: 0, col: 0 }, 100, network, gridPoints,
      );

      expect(result).toContain('CityA');
      expect(result).toContain('CityB');
      expect(result).not.toContain('CityC');
      expect(result).not.toContain('CityD');
    });

    it('should handle a sparse network (single segment)', () => {
      const { network } = buildLinearNetwork([[0, 0], [0, 1]]);
      const gridPoints = [
        makeCityPoint(0, 0, 'CityA'),
        makeCityPoint(0, 1, 'CityB'),
      ];

      const result = ContextBuilder.computeReachableCities(
        { row: 0, col: 0 }, 1, network, gridPoints,
      );

      expect(result).toEqual(expect.arrayContaining(['CityA', 'CityB']));
    });

    it('should handle a cycle in the network', () => {
      // Triangle: (0,0)-(0,1)-(1,0)-(0,0)
      const segments = [
        makeSegment(0, 0, 0, 1),
        makeSegment(0, 1, 1, 0),
        makeSegment(1, 0, 0, 0),
      ];
      const network = buildTrackNetwork(segments);
      const gridPoints = [
        makeCityPoint(0, 0, 'CityA'),
        makeCityPoint(0, 1, 'CityB'),
        makeCityPoint(1, 0, 'CityC'),
      ];

      const result = ContextBuilder.computeReachableCities(
        { row: 0, col: 0 }, 2, network, gridPoints,
      );

      expect(result).toEqual(expect.arrayContaining(['CityA', 'CityB', 'CityC']));
      expect(result).toHaveLength(3);
    });
  });

  // ── Edge cases ────────────────────────────────────────────────────────

  describe('edge cases', () => {
    it('should return empty when bot is far from the network (> 3 hexes)', () => {
      const { network } = buildLinearNetwork([[0, 0], [0, 1]]);
      const gridPoints = [
        makeCityPoint(0, 0, 'CityA'),
        makeCityPoint(0, 1, 'CityB'),
        makeCityPoint(10, 10, 'CityFar'),
      ];

      const result = ContextBuilder.computeReachableCities(
        { row: 10, col: 10 }, 9, network, gridPoints,
      );

      expect(result).toEqual([]);
    });

    it('should snap to nearest network node when bot is close but off-network', () => {
      // Network: CityA(0,0) - (0,1) - CityB(0,2)
      // Bot at (0,3) — 1 hex from (0,2) but not on network
      const { network } = buildLinearNetwork([[0, 0], [0, 1], [0, 2]]);
      const gridPoints = [
        makeCityPoint(0, 0, 'CityA'),
        makeGridPoint(0, 1),
        makeCityPoint(0, 2, 'CityB'),
      ];

      const result = ContextBuilder.computeReachableCities(
        { row: 0, col: 3 }, 9, network, gridPoints,
      );

      // Should snap to (0,2) which is 1 hex away, then BFS with speed 9-1=8
      expect(result).toContain('CityB');
      expect(result).toContain('CityA');
    });

    it('should reduce speed by snap distance when off-network', () => {
      // Network: CityA(0,0) - (0,1) - CityB(0,2)
      // Bot at (0,3) — 1 hex from CityB(0,2)
      // Speed=2 → adjusted speed=1 after snap → can reach CityB but not CityA (2 hops away)
      const { network } = buildLinearNetwork([[0, 0], [0, 1], [0, 2]]);
      const gridPoints = [
        makeCityPoint(0, 0, 'CityA'),
        makeGridPoint(0, 1),
        makeCityPoint(0, 2, 'CityB'),
      ];

      const result = ContextBuilder.computeReachableCities(
        { row: 0, col: 3 }, 2, network, gridPoints,
      );

      expect(result).toContain('CityB');
      expect(result).not.toContain('CityA');
    });

    it('should return empty when speed is consumed by snap distance', () => {
      // Network: CityA(0,0) - (0,1)
      // Bot at (0,3) — 2 hexes from nearest node (0,1), speed=2 → adjusted=0
      const { network } = buildLinearNetwork([[0, 0], [0, 1]]);
      const gridPoints = [
        makeCityPoint(0, 0, 'CityA'),
        makeGridPoint(0, 1),
      ];

      const result = ContextBuilder.computeReachableCities(
        { row: 0, col: 3 }, 2, network, gridPoints,
      );

      expect(result).toEqual([]);
    });

    it('should handle a network with no cities (only mileposts)', () => {
      const { network } = buildLinearNetwork([[0, 0], [0, 1], [0, 2]]);
      const gridPoints = [
        makeGridPoint(0, 0),
        makeGridPoint(0, 1),
        makeGridPoint(0, 2),
      ];

      const result = ContextBuilder.computeReachableCities(
        { row: 0, col: 0 }, 9, network, gridPoints,
      );

      expect(result).toEqual([]);
    });

    it('should handle network with a single city at start', () => {
      const segments = [makeSegment(0, 0, 0, 1)];
      const network = buildTrackNetwork(segments);
      const gridPoints = [
        makeCityPoint(0, 0, 'OnlyCity'),
        makeGridPoint(0, 1),
      ];

      const result = ContextBuilder.computeReachableCities(
        { row: 0, col: 0 }, 9, network, gridPoints,
      );

      expect(result).toEqual(['OnlyCity']);
    });

    it('should deduplicate major cities with multiple mileposts', () => {
      // Major city "Paris" has two mileposts: (0,0) and (0,1)
      // Both reachable from (0,0)
      const segments = [makeSegment(0, 0, 0, 1)];
      const network = buildTrackNetwork(segments);
      const gridPoints = [
        makeCityPoint(0, 0, 'Paris', TerrainType.MajorCity),
        makeCityPoint(0, 1, 'Paris', TerrainType.MajorCity),
      ];

      const result = ContextBuilder.computeReachableCities(
        { row: 0, col: 0 }, 1, network, gridPoints,
      );

      // Should appear only once despite two mileposts
      expect(result).toEqual(['Paris']);
    });

    it('should handle gridPoints with no matching network nodes', () => {
      const { network } = buildLinearNetwork([[0, 0], [0, 1]]);
      // gridPoints exist at different coordinates than the network
      const gridPoints = [
        makeCityPoint(10, 10, 'Unrelated'),
      ];

      const result = ContextBuilder.computeReachableCities(
        { row: 0, col: 0 }, 9, network, gridPoints,
      );

      // No cities found at network nodes
      expect(result).toEqual([]);
    });

    it('should handle a long chain that exceeds default speed', () => {
      // Chain of 15 points, city at the end
      const coords: Array<[number, number]> = [];
      for (let i = 0; i <= 14; i++) coords.push([0, i]);
      const { network } = buildLinearNetwork(coords);
      const gridPoints: GridPoint[] = coords.map(([r, c]) =>
        c === 14 ? makeCityPoint(r, c, 'FarCity') : makeGridPoint(r, c),
      );
      // Add start city
      gridPoints[0] = makeCityPoint(0, 0, 'StartCity');

      // Speed 9 (Freight default) — FarCity is 14 mileposts away
      const result = ContextBuilder.computeReachableCities(
        { row: 0, col: 0 }, 9, network, gridPoints,
      );

      expect(result).toContain('StartCity');
      expect(result).not.toContain('FarCity');

      // Speed 12 (Fast Freight) — still not enough
      const result2 = ContextBuilder.computeReachableCities(
        { row: 0, col: 0 }, 12, network, gridPoints,
      );
      expect(result2).not.toContain('FarCity');

      // Speed 14 — exactly enough
      const result3 = ContextBuilder.computeReachableCities(
        { row: 0, col: 0 }, 14, network, gridPoints,
      );
      expect(result3).toContain('FarCity');
    });
  });

  // ── BFS correctness with better paths ─────────────────────────────────

  describe('BFS finds optimal path', () => {
    it('should find the shorter path when two paths exist', () => {
      // Diamond: Start(0,0) -> (0,1) -> End(0,2)  (short, 2 edges)
      //          Start(0,0) -> (1,0) -> (1,1) -> (1,2) -> End(0,2)  (long, 4 edges)
      const segments = [
        makeSegment(0, 0, 0, 1), makeSegment(0, 1, 0, 2),
        makeSegment(0, 0, 1, 0), makeSegment(1, 0, 1, 1),
        makeSegment(1, 1, 1, 2), makeSegment(1, 2, 0, 2),
      ];
      const network = buildTrackNetwork(segments);
      const gridPoints = [
        makeCityPoint(0, 0, 'Start'), makeGridPoint(0, 1), makeCityPoint(0, 2, 'End'),
        makeGridPoint(1, 0), makeGridPoint(1, 1), makeGridPoint(1, 2),
      ];

      // Speed 2 — short path is exactly 2 edges, long path is 4
      const result = ContextBuilder.computeReachableCities(
        { row: 0, col: 0 }, 2, network, gridPoints,
      );

      expect(result).toContain('Start');
      expect(result).toContain('End');
    });

    it('should prefer non-ferry path when both exist', () => {
      // Path 1: Start(0,0) -> Ferry(0,1) -> CityB(0,2)  (ferry halves speed)
      // Path 2: Start(0,0) -> (1,0) -> CityB(0,2)  (no ferry, 2 mileposts)
      const segments = [
        makeSegment(0, 0, 0, 1), makeSegment(0, 1, 0, 2),
        makeSegment(0, 0, 1, 0), makeSegment(1, 0, 0, 2),
      ];
      const network = buildTrackNetwork(segments);
      const gridPoints = [
        makeCityPoint(0, 0, 'Start'),
        makeFerryPoint(0, 1),
        makeCityPoint(0, 2, 'CityB'),
        makeGridPoint(1, 0),
      ];

      // Speed 2.
      // Ferry path: Ferry at (0,1) → remaining = floor((2-1)/2) = 0, can't reach CityB
      // Non-ferry path: (1,0) → remaining=1, then CityB → remaining=0. Reachable!
      const result = ContextBuilder.computeReachableCities(
        { row: 0, col: 0 }, 2, network, gridPoints,
      );

      expect(result).toContain('Start');
      expect(result).toContain('CityB');
    });
  });
});

// ── WorldSnapshot factory ───────────────────────────────────────────────────

function makeWorldSnapshot(overrides?: {
  botLoads?: string[];
  botPosition?: { row: number; col: number } | null;
  botSegments?: TrackSegment[];
  botMoney?: number;
  botTrainType?: string;
  opponents?: Array<{
    playerId: string;
    money: number;
    position: { row: number; col: number } | null;
    trainType: string;
    loads: string[];
    trackSummary?: string;
  }>;
  resolvedDemands?: Array<{
    cardId: number;
    demands: Array<{ city: string; loadType: string; payment: number }>;
  }>;
  gameStatus?: GameStatus;
  turnNumber?: number;
}): WorldSnapshot {
  return {
    gameId: 'game-1',
    gameStatus: overrides?.gameStatus ?? 'active',
    turnNumber: overrides?.turnNumber ?? 10,
    bot: {
      playerId: 'bot-1',
      userId: 'user-bot-1',
      money: overrides?.botMoney ?? 50,
      position: overrides?.botPosition !== undefined ? overrides.botPosition : { row: 0, col: 0 },
      existingSegments: overrides?.botSegments ?? [],
      demandCards: [1, 2, 3],
      resolvedDemands: overrides?.resolvedDemands ?? [],
      trainType: overrides?.botTrainType ?? 'freight',
      loads: overrides?.botLoads ?? [],
      botConfig: { skillLevel: 'medium', archetype: 'balanced' },
      connectedMajorCityCount: 0,
    },
    allPlayerTracks: [],
    loadAvailability: {},
    opponents: overrides?.opponents,
  };
}

// ── TEST-002: isLoadRuntimeAvailable ────────────────────────────────────────

describe('ContextBuilder.isLoadRuntimeAvailable', () => {

  describe('with opponent data (Medium/Hard)', () => {
    it('should return true when no copies are on any train', () => {
      const snapshot = makeWorldSnapshot({
        botLoads: [],
        opponents: [
          { playerId: 'p2', money: 50, position: null, trainType: 'freight', loads: [] },
        ],
      });

      expect(ContextBuilder.isLoadRuntimeAvailable('Coal', snapshot)).toBe(true);
    });

    it('should return true when some but not all copies are on trains', () => {
      // Coal has 3 copies. Bot has 1, opponent has 1 = 2 on trains. Still available.
      const snapshot = makeWorldSnapshot({
        botLoads: ['Coal'],
        opponents: [
          { playerId: 'p2', money: 50, position: null, trainType: 'freight', loads: ['Coal'] },
        ],
      });

      expect(ContextBuilder.isLoadRuntimeAvailable('Coal', snapshot)).toBe(true);
    });

    it('should return false when all 3 copies of a standard load are on trains', () => {
      // Coal has 3 copies total
      const snapshot = makeWorldSnapshot({
        botLoads: ['Coal'],
        opponents: [
          { playerId: 'p2', money: 50, position: null, trainType: 'freight', loads: ['Coal', 'Coal'] },
        ],
      });

      expect(ContextBuilder.isLoadRuntimeAvailable('Coal', snapshot)).toBe(false);
    });

    it('should return false when all 4 copies of a 4-copy load are on trains', () => {
      // Wine has 4 copies total
      const snapshot = makeWorldSnapshot({
        botLoads: ['Wine', 'Wine'],
        opponents: [
          { playerId: 'p2', money: 50, position: null, trainType: 'freight', loads: ['Wine'] },
          { playerId: 'p3', money: 50, position: null, trainType: 'freight', loads: ['Wine'] },
        ],
      });

      expect(ContextBuilder.isLoadRuntimeAvailable('Wine', snapshot)).toBe(false);
    });

    it('should return true for 4-copy loads with 3 on trains', () => {
      // Beer has 4 copies
      const snapshot = makeWorldSnapshot({
        botLoads: ['Beer'],
        opponents: [
          { playerId: 'p2', money: 50, position: null, trainType: 'freight', loads: ['Beer', 'Beer'] },
        ],
      });

      expect(ContextBuilder.isLoadRuntimeAvailable('Beer', snapshot)).toBe(true);
    });

    it('should handle multiple opponents', () => {
      // Steel has 3 copies. 1 per player = 3 total on trains.
      const snapshot = makeWorldSnapshot({
        botLoads: ['Steel'],
        opponents: [
          { playerId: 'p2', money: 50, position: null, trainType: 'freight', loads: ['Steel'] },
          { playerId: 'p3', money: 50, position: null, trainType: 'freight', loads: ['Steel'] },
        ],
      });

      expect(ContextBuilder.isLoadRuntimeAvailable('Steel', snapshot)).toBe(false);
    });
  });

  describe('without opponent data (Easy)', () => {
    it('should return true when bot has 0 copies', () => {
      const snapshot = makeWorldSnapshot({ botLoads: [] });
      // No opponents field → optimistic: assume available
      expect(ContextBuilder.isLoadRuntimeAvailable('Coal', snapshot)).toBe(true);
    });

    it('should return true when bot has fewer than 3 copies', () => {
      const snapshot = makeWorldSnapshot({ botLoads: ['Coal', 'Coal'] });
      expect(ContextBuilder.isLoadRuntimeAvailable('Coal', snapshot)).toBe(true);
    });

    it('should return false when bot alone holds 3+ copies', () => {
      const snapshot = makeWorldSnapshot({ botLoads: ['Coal', 'Coal', 'Coal'] });
      expect(ContextBuilder.isLoadRuntimeAvailable('Coal', snapshot)).toBe(false);
    });
  });

  describe('4-copy vs 3-copy load types', () => {
    it('should use 4 as total for Beer, Cheese, Machinery, Oil, Wine', () => {
      const fourCopyLoads = ['Beer', 'Cheese', 'Machinery', 'Oil', 'Wine'];
      for (const loadType of fourCopyLoads) {
        // 3 on trains out of 4 total → available
        const snapshot = makeWorldSnapshot({
          botLoads: [loadType],
          opponents: [
            { playerId: 'p2', money: 50, position: null, trainType: 'freight', loads: [loadType, loadType] },
          ],
        });
        expect(ContextBuilder.isLoadRuntimeAvailable(loadType, snapshot)).toBe(true);
      }
    });

    it('should use 3 as total for standard loads (Coal, Hops, etc.)', () => {
      const threeCopyLoads = ['Coal', 'Hops', 'Steel', 'Oranges'];
      for (const loadType of threeCopyLoads) {
        // 3 on trains out of 3 total → not available
        const snapshot = makeWorldSnapshot({
          botLoads: [loadType],
          opponents: [
            { playerId: 'p2', money: 50, position: null, trainType: 'freight', loads: [loadType, loadType] },
          ],
        });
        expect(ContextBuilder.isLoadRuntimeAvailable(loadType, snapshot)).toBe(false);
      }
    });
  });
});

// ── TEST-002: computeDemandContext (tested via build()) ──────────────────────

describe('ContextBuilder.build — demand context computation', () => {

  // Helper: build grid points with a few cities and a simple network
  function makeTestGridWithNetwork() {
    // Network: Lyon(0,0) - (0,1) - Paris(0,2)
    const segments = [
      makeSegment(0, 0, 0, 1),
      makeSegment(0, 1, 0, 2),
    ];

    const gridPoints: GridPoint[] = [
      makeCityPoint(0, 0, 'Lyon', TerrainType.MajorCity, ['Wine']),
      makeGridPoint(0, 1),
      makeCityPoint(0, 2, 'Paris', TerrainType.MajorCity, ['Cheese']),
      // Off-network cities
      makeCityPoint(5, 5, 'Berlin', TerrainType.MajorCity, ['Steel']),
      makeCityPoint(8, 8, 'London', TerrainType.MajorCity, ['Coal']),
    ];

    return { segments, gridPoints };
  }

  it('should set isLoadOnTrain=true when bot carries the demanded load', async () => {
    const { segments, gridPoints } = makeTestGridWithNetwork();
    const snapshot = makeWorldSnapshot({
      botLoads: ['Wine'],
      botPosition: { row: 0, col: 0 },
      botSegments: segments,
      resolvedDemands: [{
        cardId: 1,
        demands: [{ city: 'Berlin', loadType: 'Wine', payment: 48 }],
      }],
      opponents: [],
    });

    const context = await ContextBuilder.build(snapshot, BotSkillLevel.Medium, gridPoints);
    const demand = context.demands.find(d => d.loadType === 'Wine');

    expect(demand).toBeDefined();
    expect(demand!.isLoadOnTrain).toBe(true);
  });

  it('should set isLoadOnTrain=false when bot does not carry the load', async () => {
    const { segments, gridPoints } = makeTestGridWithNetwork();
    const snapshot = makeWorldSnapshot({
      botLoads: [],
      botPosition: { row: 0, col: 0 },
      botSegments: segments,
      resolvedDemands: [{
        cardId: 1,
        demands: [{ city: 'Berlin', loadType: 'Wine', payment: 48 }],
      }],
      opponents: [],
    });

    const context = await ContextBuilder.build(snapshot, BotSkillLevel.Medium, gridPoints);
    const demand = context.demands.find(d => d.loadType === 'Wine');

    expect(demand).toBeDefined();
    expect(demand!.isLoadOnTrain).toBe(false);
  });

  it('should mark supply as reachable when supply city is within speed', async () => {
    const { segments, gridPoints } = makeTestGridWithNetwork();
    // Bot at Lyon(0,0), Paris(0,2) supplies Cheese, 2 mileposts away
    const snapshot = makeWorldSnapshot({
      botLoads: [],
      botPosition: { row: 0, col: 0 },
      botSegments: segments,
      resolvedDemands: [{
        cardId: 1,
        demands: [{ city: 'Berlin', loadType: 'Cheese', payment: 28 }],
      }],
      opponents: [],
    });

    const context = await ContextBuilder.build(snapshot, BotSkillLevel.Medium, gridPoints);
    const demand = context.demands.find(d => d.loadType === 'Cheese');

    expect(demand).toBeDefined();
    // Paris is on the network and reachable at speed 9
    expect(demand!.isSupplyReachable).toBe(true);
    expect(demand!.supplyCity).toBe('Paris');
  });

  it('should mark delivery as reachable when delivery city is within speed', async () => {
    const { segments, gridPoints } = makeTestGridWithNetwork();
    // Bot at Lyon, delivery at Paris (reachable)
    const snapshot = makeWorldSnapshot({
      botLoads: ['Wine'],
      botPosition: { row: 0, col: 0 },
      botSegments: segments,
      resolvedDemands: [{
        cardId: 1,
        demands: [{ city: 'Paris', loadType: 'Wine', payment: 48 }],
      }],
      opponents: [],
    });

    const context = await ContextBuilder.build(snapshot, BotSkillLevel.Medium, gridPoints);
    const demand = context.demands.find(d => d.loadType === 'Wine' && d.deliveryCity === 'Paris');

    expect(demand).toBeDefined();
    expect(demand!.isDeliveryReachable).toBe(true);
  });

  it('should mark supply and delivery as unreachable when off-network', async () => {
    const { segments, gridPoints } = makeTestGridWithNetwork();
    // Demand: Steel from Berlin -> London. Neither is on the network.
    const snapshot = makeWorldSnapshot({
      botLoads: [],
      botPosition: { row: 0, col: 0 },
      botSegments: segments,
      resolvedDemands: [{
        cardId: 1,
        demands: [{ city: 'London', loadType: 'Steel', payment: 52 }],
      }],
      opponents: [],
    });

    const context = await ContextBuilder.build(snapshot, BotSkillLevel.Medium, gridPoints);
    const demand = context.demands.find(d => d.loadType === 'Steel');

    expect(demand).toBeDefined();
    expect(demand!.isSupplyReachable).toBe(false);
    expect(demand!.isDeliveryReachable).toBe(false);
  });

  it('should estimate track cost > 0 for off-network cities', async () => {
    const { segments, gridPoints } = makeTestGridWithNetwork();
    // Berlin(5,5) is off-network → should have a non-zero estimated track cost
    const snapshot = makeWorldSnapshot({
      botLoads: [],
      botPosition: { row: 0, col: 0 },
      botSegments: segments,
      resolvedDemands: [{
        cardId: 1,
        demands: [{ city: 'Berlin', loadType: 'Wine', payment: 48 }],
      }],
      opponents: [],
    });

    const context = await ContextBuilder.build(snapshot, BotSkillLevel.Medium, gridPoints);
    const demand = context.demands.find(d => d.deliveryCity === 'Berlin');

    expect(demand).toBeDefined();
    expect(demand!.estimatedTrackCostToDelivery).toBeGreaterThan(0);
  });

  it('should set estimatedTrackCost=0 for on-network cities', async () => {
    const { segments, gridPoints } = makeTestGridWithNetwork();
    // Paris is on the network → track cost should be 0
    const snapshot = makeWorldSnapshot({
      botLoads: [],
      botPosition: { row: 0, col: 0 },
      botSegments: segments,
      resolvedDemands: [{
        cardId: 1,
        demands: [{ city: 'Paris', loadType: 'Wine', payment: 48 }],
      }],
      opponents: [],
    });

    const context = await ContextBuilder.build(snapshot, BotSkillLevel.Medium, gridPoints);
    const demand = context.demands.find(d => d.deliveryCity === 'Paris');

    expect(demand).toBeDefined();
    expect(demand!.estimatedTrackCostToDelivery).toBe(0);
  });

  it('should set isLoadAvailable based on runtime availability', async () => {
    const { segments, gridPoints } = makeTestGridWithNetwork();
    // All 3 copies of Steel are on trains → isLoadAvailable = false
    const snapshot = makeWorldSnapshot({
      botLoads: ['Steel'],
      botPosition: { row: 0, col: 0 },
      botSegments: segments,
      opponents: [
        { playerId: 'p2', money: 50, position: null, trainType: 'freight', loads: ['Steel', 'Steel'] },
      ],
      resolvedDemands: [{
        cardId: 1,
        demands: [{ city: 'Paris', loadType: 'Steel', payment: 40 }],
      }],
    });

    const context = await ContextBuilder.build(snapshot, BotSkillLevel.Medium, gridPoints);
    const demand = context.demands.find(d => d.loadType === 'Steel');

    expect(demand).toBeDefined();
    expect(demand!.isLoadAvailable).toBe(false);
  });

  it('should detect ferry requirement at supply/delivery city', async () => {
    // Add a ferry port city to test
    const segments = [makeSegment(0, 0, 0, 1)];
    const gridPoints: GridPoint[] = [
      makeCityPoint(0, 0, 'Lyon', TerrainType.MajorCity, ['Wine']),
      makeGridPoint(0, 1),
      // Ferry city: Dover
      makeGridPoint(3, 3, {
        terrain: TerrainType.FerryPort,
        city: { type: TerrainType.FerryPort, name: 'Dover', availableLoads: ['Coal'] },
      }),
    ];

    const snapshot = makeWorldSnapshot({
      botLoads: [],
      botPosition: { row: 0, col: 0 },
      botSegments: segments,
      resolvedDemands: [{
        cardId: 1,
        demands: [{ city: 'Dover', loadType: 'Wine', payment: 30 }],
      }],
      opponents: [],
    });

    const context = await ContextBuilder.build(snapshot, BotSkillLevel.Medium, gridPoints);
    const demand = context.demands.find(d => d.deliveryCity === 'Dover');

    expect(demand).toBeDefined();
    expect(demand!.ferryRequired).toBe(true);
  });

  it('should set ferryRequired=false when no ferry involved', async () => {
    const { segments, gridPoints } = makeTestGridWithNetwork();
    const snapshot = makeWorldSnapshot({
      botLoads: [],
      botPosition: { row: 0, col: 0 },
      botSegments: segments,
      resolvedDemands: [{
        cardId: 1,
        demands: [{ city: 'Paris', loadType: 'Wine', payment: 48 }],
      }],
      opponents: [],
    });

    const context = await ContextBuilder.build(snapshot, BotSkillLevel.Medium, gridPoints);
    const demand = context.demands.find(d => d.deliveryCity === 'Paris');

    expect(demand).toBeDefined();
    expect(demand!.ferryRequired).toBe(false);
  });

  it('should handle multiple demands across multiple cards', async () => {
    const { segments, gridPoints } = makeTestGridWithNetwork();
    const snapshot = makeWorldSnapshot({
      botLoads: ['Wine'],
      botPosition: { row: 0, col: 0 },
      botSegments: segments,
      resolvedDemands: [
        {
          cardId: 1,
          demands: [
            { city: 'Paris', loadType: 'Wine', payment: 48 },
            { city: 'Berlin', loadType: 'Steel', payment: 52 },
          ],
        },
        {
          cardId: 2,
          demands: [
            { city: 'London', loadType: 'Coal', payment: 44 },
          ],
        },
      ],
      opponents: [],
    });

    const context = await ContextBuilder.build(snapshot, BotSkillLevel.Medium, gridPoints);

    expect(context.demands).toHaveLength(3);
    // Card 1 demands
    const wineDemand = context.demands.find(d => d.loadType === 'Wine');
    expect(wineDemand!.cardIndex).toBe(1);
    expect(wineDemand!.isLoadOnTrain).toBe(true);
    // Card 2 demands
    const coalDemand = context.demands.find(d => d.loadType === 'Coal');
    expect(coalDemand!.cardIndex).toBe(2);
  });

  it('should handle empty resolved demands', async () => {
    const { segments, gridPoints } = makeTestGridWithNetwork();
    const snapshot = makeWorldSnapshot({
      botLoads: [],
      botPosition: { row: 0, col: 0 },
      botSegments: segments,
      resolvedDemands: [],
      opponents: [],
    });

    const context = await ContextBuilder.build(snapshot, BotSkillLevel.Medium, gridPoints);
    expect(context.demands).toEqual([]);
  });

  it('should set supplyCity to "Unknown" when no supply city exists for load', async () => {
    // Create grid with no city that supplies "Uranium"
    const { segments, gridPoints } = makeTestGridWithNetwork();
    const snapshot = makeWorldSnapshot({
      botLoads: [],
      botPosition: { row: 0, col: 0 },
      botSegments: segments,
      resolvedDemands: [{
        cardId: 1,
        demands: [{ city: 'Paris', loadType: 'Uranium', payment: 99 }],
      }],
      opponents: [],
    });

    const context = await ContextBuilder.build(snapshot, BotSkillLevel.Medium, gridPoints);
    const demand = context.demands.find(d => d.loadType === 'Uranium');

    expect(demand).toBeDefined();
    expect(demand!.supplyCity).toBe('Unknown');
    expect(demand!.isSupplyReachable).toBe(false);
  });
});

// ── TEST: serializePrompt — previous turn summary and DELIVER clarity ────────

describe('ContextBuilder.serializePrompt', () => {
  function makeMinimalContext(overrides?: Partial<import('../../../shared/types/GameTypes').GameContext>): import('../../../shared/types/GameTypes').GameContext {
    return {
      position: { city: 'Berlin', row: 10, col: 10 },
      money: 50,
      trainType: 'Freight',
      speed: 9,
      capacity: 2,
      loads: [],
      connectedMajorCities: ['Berlin'],
      totalMajorCities: 8,
      trackSummary: '5 mileposts',
      turnBuildCost: 0,
      demands: [],
      canDeliver: [],
      canPickup: [],
      reachableCities: ['Berlin'],
      citiesOnNetwork: ['Berlin'],
      canUpgrade: false,
      canBuild: true,
      isInitialBuild: false,
      opponents: [],
      phase: 'Early Game',
      turnNumber: 5,
      ...overrides,
    };
  }

  it('should include PREVIOUS TURN section when previousTurnSummary is set', () => {
    const ctx = makeMinimalContext({
      previousTurnSummary: 'Action: BuildTrack. Reasoning: Building toward Hamburg. Plan: Expand north',
    });

    const prompt = ContextBuilder.serializePrompt(ctx, BotSkillLevel.Medium);

    expect(prompt).toContain('PREVIOUS TURN:');
    expect(prompt).toContain('Building toward Hamburg');
    expect(prompt).toContain('PLAN PERSISTENCE: You MUST continue your existing plan');
  });

  it('should NOT include PREVIOUS TURN section when previousTurnSummary is absent', () => {
    const ctx = makeMinimalContext();

    const prompt = ContextBuilder.serializePrompt(ctx, BotSkillLevel.Medium);

    expect(prompt).not.toContain('PREVIOUS TURN:');
  });

  it('should include DELIVER clarity warning', () => {
    const ctx = makeMinimalContext();

    const prompt = ContextBuilder.serializePrompt(ctx, BotSkillLevel.Medium);

    expect(prompt).toContain('Only use DELIVER if a delivery is listed above');
    expect(prompt).toContain('must be AT the delivery city');
  });

  it('should warn about carrying loads without delivery available', () => {
    const ctx = makeMinimalContext({
      loads: ['Coal', 'Wine'],
      canDeliver: [],
    });

    const prompt = ContextBuilder.serializePrompt(ctx, BotSkillLevel.Medium);

    expect(prompt).toContain('carrying [Coal, Wine]');
    expect(prompt).toContain('MOVE toward a delivery city');
    expect(prompt).toContain('do NOT pass your turn');
  });

  it('should NOT warn about carrying loads when delivery IS available', () => {
    const ctx = makeMinimalContext({
      loads: ['Coal'],
      canDeliver: [{ loadType: 'Coal', deliveryCity: 'Berlin', payout: 25, cardIndex: 0 }],
    });

    const prompt = ContextBuilder.serializePrompt(ctx, BotSkillLevel.Medium);

    expect(prompt).not.toContain('do NOT pass your turn');
  });

  it('should include initial build strategy hint during initialBuild phase', () => {
    const ctx = makeMinimalContext({ isInitialBuild: true });

    const prompt = ContextBuilder.serializePrompt(ctx, BotSkillLevel.Medium);

    expect(prompt).toContain('INITIAL BUILD STRATEGY');
    expect(prompt).toContain('Track cost estimates show distance from the nearest major city');
    expect(prompt).toContain('BOTH supply and delivery are cheap');
  });
});

// ── TEST: Cold-start estimateTrackCost via build() ───────────────────────────

// Mock getMajorCityGroups to return controlled test data instead of real board config
jest.mock('../../../shared/services/majorCityGroups', () => ({
  getMajorCityGroups: () => [
    { cityName: 'Berlin', center: { row: 10, col: 10 }, outposts: [] },
    { cityName: 'Paris', center: { row: 20, col: 20 }, outposts: [] },
  ],
}));

describe('ContextBuilder cold-start estimateTrackCost', () => {
  it('should return 0 for a city that IS a major city (distance ≤ 1)', async () => {
    // Berlin is at (10,10) which matches the mocked major city center exactly
    const gridPoints: GridPoint[] = [
      makeCityPoint(10, 10, 'Berlin', TerrainType.MajorCity, ['Steel']),
      makeCityPoint(20, 20, 'Paris', TerrainType.MajorCity, ['Cheese']),
    ];

    const snapshot = makeWorldSnapshot({
      botLoads: [],
      botPosition: null,
      botSegments: [],  // No track — cold-start
      resolvedDemands: [{
        cardId: 1,
        demands: [{ city: 'Berlin', loadType: 'Cheese', payment: 12 }],
      }],
      opponents: [],
      gameStatus: 'initialBuild',
    });

    const context = await ContextBuilder.build(snapshot, BotSkillLevel.Medium, gridPoints);
    const demand = context.demands.find(d => d.deliveryCity === 'Berlin');

    expect(demand).toBeDefined();
    // Berlin IS a major city center, so track cost should be 0
    expect(demand!.estimatedTrackCostToDelivery).toBe(0);
  });

  it('should return positive estimate for a city far from all major cities', async () => {
    // SmallTown at (50,50) is far from both Berlin (10,10) and Paris (20,20)
    const gridPoints: GridPoint[] = [
      makeCityPoint(10, 10, 'Berlin', TerrainType.MajorCity, ['Steel']),
      makeCityPoint(20, 20, 'Paris', TerrainType.MajorCity, []),
      makeCityPoint(50, 50, 'SmallTown', TerrainType.SmallCity, ['Coal']),
    ];

    const snapshot = makeWorldSnapshot({
      botLoads: [],
      botPosition: null,
      botSegments: [],  // No track — cold-start
      resolvedDemands: [{
        cardId: 1,
        demands: [{ city: 'SmallTown', loadType: 'Steel', payment: 30 }],
      }],
      opponents: [],
      gameStatus: 'initialBuild',
    });

    const context = await ContextBuilder.build(snapshot, BotSkillLevel.Medium, gridPoints);
    const demand = context.demands.find(d => d.deliveryCity === 'SmallTown');

    expect(demand).toBeDefined();
    // SmallTown is far from all major cities → positive cost estimate
    expect(demand!.estimatedTrackCostToDelivery).toBeGreaterThan(0);
  });

  it('should return small positive estimate for a city near (but not at) a major city', async () => {
    // NearbyTown at (12, 12) is close to Berlin at (10,10)
    const gridPoints: GridPoint[] = [
      makeCityPoint(10, 10, 'Berlin', TerrainType.MajorCity, ['Steel']),
      makeCityPoint(20, 20, 'Paris', TerrainType.MajorCity, []),
      makeCityPoint(12, 12, 'NearbyTown', TerrainType.SmallCity, []),
    ];

    const snapshot = makeWorldSnapshot({
      botLoads: [],
      botPosition: null,
      botSegments: [],  // No track — cold-start
      resolvedDemands: [{
        cardId: 1,
        demands: [{ city: 'NearbyTown', loadType: 'Steel', payment: 20 }],
      }],
      opponents: [],
      gameStatus: 'initialBuild',
    });

    const context = await ContextBuilder.build(snapshot, BotSkillLevel.Medium, gridPoints);
    const demand = context.demands.find(d => d.deliveryCity === 'NearbyTown');

    expect(demand).toBeDefined();
    // NearbyTown is ~3 hexes from Berlin → small positive cost
    expect(demand!.estimatedTrackCostToDelivery).toBeGreaterThan(0);
    expect(demand!.estimatedTrackCostToDelivery).toBeLessThan(20);
  });

  it('should prefer supply city nearest to a major city during cold-start', async () => {
    // Two supply cities for Wine: Lyon (near Berlin major) and FarVineyard (distant)
    const gridPoints: GridPoint[] = [
      makeCityPoint(10, 10, 'Berlin', TerrainType.MajorCity, []),
      makeCityPoint(11, 11, 'Lyon', TerrainType.SmallCity, ['Wine']),  // Near Berlin
      makeCityPoint(50, 50, 'FarVineyard', TerrainType.SmallCity, ['Wine']),  // Far away
      makeCityPoint(20, 20, 'Paris', TerrainType.MajorCity, []),
    ];

    const snapshot = makeWorldSnapshot({
      botLoads: [],
      botPosition: null,
      botSegments: [],  // No track — cold-start
      resolvedDemands: [{
        cardId: 1,
        demands: [{ city: 'Paris', loadType: 'Wine', payment: 25 }],
      }],
      opponents: [],
      gameStatus: 'initialBuild',
    });

    const context = await ContextBuilder.build(snapshot, BotSkillLevel.Medium, gridPoints);
    const demand = context.demands.find(d => d.loadType === 'Wine');

    expect(demand).toBeDefined();
    // Should pick Lyon (near Berlin) over FarVineyard
    expect(demand!.supplyCity).toBe('Lyon');
  });
});
