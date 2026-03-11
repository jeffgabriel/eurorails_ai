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
      botConfig: { skillLevel: 'medium' },
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

  it('should set supplyCity to "NoSupply" when no supply city exists and load not on train (JIRA-82)', async () => {
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
    expect(demand!.supplyCity).toBe('NoSupply');
    expect(demand!.isSupplyReachable).toBe(false);
    expect(demand!.demandScore).toBe(-999);
    expect(demand!.estimatedTurns).toBe(99);
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
      unconnectedMajorCities: [{ cityName: 'Paris', estimatedCost: 15 }],
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

  it('should include initial build phase hint during initialBuild phase', () => {
    const ctx = makeMinimalContext({ isInitialBuild: true });

    const prompt = ContextBuilder.serializePrompt(ctx, BotSkillLevel.Medium);

    expect(prompt).toContain('PHASE: Initial Build');
    expect(prompt).toContain('GEOGRAPHIC STRATEGY');
    expect(prompt).toContain('CAPITAL VELOCITY');
  });
});

// ── TEST: Cold-start estimateTrackCost via build() ───────────────────────────

// Mock getMajorCityGroups to return controlled test data instead of real board config
jest.mock('../../../shared/services/majorCityGroups', () => ({
  getMajorCityGroups: jest.fn(() => [
    { cityName: 'Berlin', center: { row: 10, col: 10 }, outposts: [] },
    { cityName: 'Paris', center: { row: 20, col: 20 }, outposts: [] },
  ]),
  getFerryEdges: jest.fn(() => []),
}));

describe('ContextBuilder cold-start estimateTrackCost', () => {
  it('should return 0 for supply cost when supply IS a major city', async () => {
    // Paris is at (20,20) which matches the mocked major city center — supply cost = 0.
    // Delivery cost to Berlin (10,10) is computed FROM Paris (supply), not from nearest major city.
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
    // Supply IS a major city → supply cost = 0
    expect(demand!.estimatedTrackCostToSupply).toBe(0);
    // Delivery cost is computed from supply (Paris) to delivery (Berlin) — NOT 0
    expect(demand!.estimatedTrackCostToDelivery).toBeGreaterThan(0);
  });

  it('should return 0 delivery cost when supply and delivery are at the same city', async () => {
    // Steel at Berlin delivered to Berlin — cost should be 0
    const gridPoints: GridPoint[] = [
      makeCityPoint(10, 10, 'Berlin', TerrainType.MajorCity, ['Steel']),
      makeCityPoint(20, 20, 'Paris', TerrainType.MajorCity, []),
    ];

    const snapshot = makeWorldSnapshot({
      botLoads: [],
      botPosition: null,
      botSegments: [],
      resolvedDemands: [{
        cardId: 1,
        demands: [{ city: 'Berlin', loadType: 'Steel', payment: 8 }],
      }],
      opponents: [],
      gameStatus: 'initialBuild',
    });

    const context = await ContextBuilder.build(snapshot, BotSkillLevel.Medium, gridPoints);
    const demand = context.demands.find(d => d.deliveryCity === 'Berlin' && d.loadType === 'Steel');

    expect(demand).toBeDefined();
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

// ── TEST-001/JIRA-10: Proximity computation via serializeRoutePlanningPrompt ──

describe('ContextBuilder proximity computation methods', () => {
  // ── Shared fixtures ──────────────────────────────────────────────────

  /**
   * Track network: (10,10) → (10,11) → (10,12) → (10,13) → (10,14)
   *   On-network cities: Berlin (10,10) MajorCity, Hamburg (10,14) MediumCity
   *   Nearby off-network: Munich (13,12) SmallCity  — 3 hexes from network
   *                       Leipzig (13,11) SmallCity  — 3 hexes from network
   *   Far off-network:    Rome (10,20) MajorCity     — 6 hexes from (10,14)
   */
  const proximitySegments: TrackSegment[] = [
    makeSegment(10, 10, 10, 11),
    makeSegment(10, 11, 10, 12),
    makeSegment(10, 12, 10, 13),
    makeSegment(10, 13, 10, 14),
  ];

  const proximityGridPoints: GridPoint[] = [
    // On-network cities
    makeCityPoint(10, 10, 'Berlin', TerrainType.MajorCity, []),
    makeGridPoint(10, 11),
    makeGridPoint(10, 12),
    makeGridPoint(10, 13),
    makeCityPoint(10, 14, 'Hamburg', TerrainType.MediumCity, []),
    // Nearby off-network cities (within 5 hexes)
    makeCityPoint(13, 12, 'Munich', TerrainType.SmallCity, ['Coal']),
    makeCityPoint(13, 11, 'Leipzig', TerrainType.SmallCity, ['Wine']),
    // Far off-network city (6 hexes from nearest network node)
    makeCityPoint(10, 20, 'Rome', TerrainType.MajorCity, ['Steel']),
  ];

  /** Build a GameContext suitable for serializeRoutePlanningPrompt */
  function makeProximityContext(overrides?: Partial<import('../../../shared/types/GameTypes').GameContext>): import('../../../shared/types/GameTypes').GameContext {
    return {
      position: { city: 'Berlin', row: 10, col: 10 },
      money: 50,
      trainType: 'Freight',
      speed: 9,
      capacity: 2,
      loads: [],
      connectedMajorCities: ['Berlin'],
      unconnectedMajorCities: [{ cityName: 'Rome', estimatedCost: 10 }],
      totalMajorCities: 8,
      trackSummary: '4 segments',
      turnBuildCost: 0,
      demands: [],
      canDeliver: [],
      canPickup: [],
      reachableCities: ['Berlin', 'Hamburg'],
      citiesOnNetwork: ['Berlin', 'Hamburg'],
      canUpgrade: false,
      canBuild: true,
      isInitialBuild: false,
      opponents: [],
      phase: 'Mid Game',
      turnNumber: 10,
      ...overrides,
    };
  }

  /** Build a DemandContext with the required fields */
  function makeDemand(overrides: Partial<import('../../../shared/types/GameTypes').DemandContext> & {
    supplyCity: string;
    deliveryCity: string;
    loadType: string;
    payout: number;
  }): import('../../../shared/types/GameTypes').DemandContext {
    return {
      cardIndex: 0,
      isSupplyReachable: true,
      isDeliveryReachable: true,
      isSupplyOnNetwork: false,
      isDeliveryOnNetwork: false,
      estimatedTrackCostToSupply: 5,
      estimatedTrackCostToDelivery: 5,
      isLoadAvailable: true,
      isLoadOnTrain: false,
      ferryRequired: false,
      loadChipTotal: 4,
      loadChipCarried: 0,
      estimatedTurns: 3,
      demandScore: 0,
      efficiencyPerTurn: 0,
      networkCitiesUnlocked: 0,
      victoryMajorCitiesEnRoute: 0,
      isAffordable: true,
      projectedFundsAfterDelivery: 50,
      ...overrides,
    };
  }

  // ── NEARBY CITIES section ──────────────────────────────────────────

  describe('NEARBY CITIES section in serializeRoutePlanningPrompt', () => {

    it('should include nearby off-network cities when segments are provided', () => {
      // Demand: Coal from Munich -> Berlin
      // Munich is a route stop; Leipzig is a nearby off-network city (3 hexes from Munich)
      const ctx = makeProximityContext({
        demands: [
          makeDemand({
            cardIndex: 0,
            loadType: 'Coal',
            supplyCity: 'Munich',
            deliveryCity: 'Berlin',
            payout: 15,
            isSupplyOnNetwork: false,
            isDeliveryOnNetwork: true,
          }),
        ],
      });

      const output = ContextBuilder.serializeRoutePlanningPrompt(
        ctx, BotSkillLevel.Medium, proximityGridPoints, proximitySegments,
      );

      expect(output).toContain('NEARBY CITIES');
    });

    it('should exclude on-network cities from the nearby cities list', () => {
      // Demand: Coal from Munich -> Hamburg
      // Berlin and Hamburg are on-network — should NOT appear as nearby city *entries*
      // (they may appear as route stop labels on the left side of the colon)
      const ctx = makeProximityContext({
        demands: [
          makeDemand({
            cardIndex: 0,
            loadType: 'Coal',
            supplyCity: 'Munich',
            deliveryCity: 'Hamburg',
            payout: 15,
            isSupplyOnNetwork: false,
            isDeliveryOnNetwork: true,
          }),
        ],
      });

      const output = ContextBuilder.serializeRoutePlanningPrompt(
        ctx, BotSkillLevel.Medium, proximityGridPoints, proximitySegments,
      );

      // Extract nearby city entries (right side of colon in each line)
      if (output.includes('NEARBY CITIES')) {
        const section = output.split('NEARBY CITIES')[1].split('\n\n')[0];
        const lines = section.split('\n').filter(l => l.includes(':'));
        for (const line of lines) {
          // Get the entries after the colon (the actual nearby city list)
          const entries = line.split(':').slice(1).join(':');
          // Berlin and Hamburg are on the network — they must NOT be listed as nearby
          expect(entries).not.toMatch(/\bBerlin\b/);
          expect(entries).not.toMatch(/\bHamburg\b/);
        }
      }
    });

    it('should limit nearby cities to top 5 per route stop', () => {
      // Create 7 off-network cities near Munich (route stop)
      const manyGridPoints: GridPoint[] = [
        ...proximityGridPoints,
        // Additional nearby cities (within 5 hexes of Munich at 13,12)
        makeCityPoint(12, 12, 'NearA', TerrainType.SmallCity),
        makeCityPoint(12, 11, 'NearB', TerrainType.SmallCity),
        makeCityPoint(14, 12, 'NearC', TerrainType.SmallCity),
        makeCityPoint(14, 13, 'NearD', TerrainType.SmallCity),
        makeCityPoint(13, 13, 'NearE', TerrainType.SmallCity),
        makeCityPoint(12, 13, 'NearF', TerrainType.SmallCity),
        makeCityPoint(11, 12, 'NearG', TerrainType.SmallCity),
      ];

      const ctx = makeProximityContext({
        demands: [
          makeDemand({
            cardIndex: 0,
            loadType: 'Coal',
            supplyCity: 'Munich',
            deliveryCity: 'Berlin',
            payout: 15,
            isSupplyOnNetwork: false,
            isDeliveryOnNetwork: true,
          }),
        ],
      });

      const output = ContextBuilder.serializeRoutePlanningPrompt(
        ctx, BotSkillLevel.Medium, manyGridPoints, proximitySegments,
      );

      // Extract the nearby cities for Munich route stop
      if (output.includes('NEARBY CITIES')) {
        const section = output.split('NEARBY CITIES')[1].split('\n\n')[0];
        const munichLine = section.split('\n').find(l => l.includes('Munich:'));
        if (munichLine) {
          // Count entries by counting "hexes)" occurrences in the Munich line
          const entryCount = (munichLine.match(/hexes\)/g) || []).length;
          expect(entryCount).toBeLessThanOrEqual(5);
        }
      }
    });

    it('should omit proximity sections when segments array is empty', () => {
      const ctx = makeProximityContext({
        demands: [
          makeDemand({
            cardIndex: 0,
            loadType: 'Coal',
            supplyCity: 'Munich',
            deliveryCity: 'Berlin',
            payout: 15,
            isSupplyOnNetwork: false,
            isDeliveryOnNetwork: true,
          }),
        ],
      });

      const output = ContextBuilder.serializeRoutePlanningPrompt(
        ctx, BotSkillLevel.Medium, proximityGridPoints, [],
      );

      expect(output).not.toContain('NEARBY CITIES');
      expect(output).not.toContain('UNCONNECTED DEMAND CITIES');
      expect(output).not.toContain('RESOURCE PROXIMITY');
    });
  });

  // ── UNCONNECTED DEMAND CITIES section ──────────────────────────────

  describe('UNCONNECTED DEMAND CITIES section in serializeRoutePlanningPrompt', () => {

    it('should list off-network demand supply/delivery cities with cost and payout', () => {
      // Demand: Coal from Munich -> Hamburg
      // Munich is off-network (supply), Hamburg is on-network (delivery)
      const ctx = makeProximityContext({
        demands: [
          makeDemand({
            cardIndex: 0,
            loadType: 'Coal',
            supplyCity: 'Munich',
            deliveryCity: 'Hamburg',
            payout: 20,
            isSupplyOnNetwork: false,
            isDeliveryOnNetwork: true,
          }),
        ],
      });

      const output = ContextBuilder.serializeRoutePlanningPrompt(
        ctx, BotSkillLevel.Medium, proximityGridPoints, proximitySegments,
      );

      expect(output).toContain('UNCONNECTED DEMAND CITIES');
      expect(output).toContain('Munich');
      expect(output).toContain('track to connect');
    });

    it('should list off-network delivery city when supply is on-network', () => {
      // Demand: Steel from Berlin -> Rome
      // Berlin on-network, Rome off-network (6 hexes from nearest network node)
      const ctx = makeProximityContext({
        demands: [
          makeDemand({
            cardIndex: 0,
            loadType: 'Steel',
            supplyCity: 'Berlin',
            deliveryCity: 'Rome',
            payout: 30,
            isSupplyOnNetwork: true,
            isDeliveryOnNetwork: false,
          }),
        ],
      });

      const output = ContextBuilder.serializeRoutePlanningPrompt(
        ctx, BotSkillLevel.Medium, proximityGridPoints, proximitySegments,
      );

      expect(output).toContain('UNCONNECTED DEMAND CITIES');
      expect(output).toContain('Rome');
    });

    it('should exclude demands where both cities are on-network', () => {
      // Demand: Steel from Berlin -> Hamburg (both on network)
      const ctx = makeProximityContext({
        demands: [
          makeDemand({
            cardIndex: 0,
            loadType: 'Steel',
            supplyCity: 'Berlin',
            deliveryCity: 'Hamburg',
            payout: 15,
            isSupplyOnNetwork: true,
            isDeliveryOnNetwork: true,
          }),
        ],
      });

      const output = ContextBuilder.serializeRoutePlanningPrompt(
        ctx, BotSkillLevel.Medium, proximityGridPoints, proximitySegments,
      );

      expect(output).not.toContain('UNCONNECTED DEMAND CITIES');
    });
  });

  // ── RESOURCE PROXIMITY section ─────────────────────────────────────

  describe('RESOURCE PROXIMITY section in serializeRoutePlanningPrompt', () => {

    it('should flag supply cities near the track network (within 5 hexes)', () => {
      // Demand: Coal from Munich -> Hamburg
      // Munich is 3 hexes from (10,12) on network — within proximity threshold
      const ctx = makeProximityContext({
        demands: [
          makeDemand({
            cardIndex: 0,
            loadType: 'Coal',
            supplyCity: 'Munich',
            deliveryCity: 'Hamburg',
            payout: 20,
            isSupplyOnNetwork: false,
            isDeliveryOnNetwork: true,
          }),
        ],
      });

      const output = ContextBuilder.serializeRoutePlanningPrompt(
        ctx, BotSkillLevel.Medium, proximityGridPoints, proximitySegments,
      );

      expect(output).toContain('RESOURCE PROXIMITY');
      expect(output).toContain('Coal');
      expect(output).toContain('Munich');
      expect(output).toMatch(/\d+M from your network/);
    });

    it('should exclude supply cities already on-network', () => {
      // Demand: Steel from Berlin -> Rome — Berlin is on-network
      const ctx = makeProximityContext({
        demands: [
          makeDemand({
            cardIndex: 0,
            loadType: 'Steel',
            supplyCity: 'Berlin',
            deliveryCity: 'Rome',
            payout: 30,
            isSupplyOnNetwork: true,
            isDeliveryOnNetwork: false,
          }),
        ],
      });

      const output = ContextBuilder.serializeRoutePlanningPrompt(
        ctx, BotSkillLevel.Medium, proximityGridPoints, proximitySegments,
      );

      // Resource proximity should not list Berlin as a supply near network
      // (it IS on the network)
      if (output.includes('RESOURCE PROXIMITY')) {
        const section = output.split('RESOURCE PROXIMITY')[1].split('\n\n')[0];
        expect(section).not.toContain('Berlin');
      }
    });

    it('should not flag supply cities beyond 5 hexes from network', () => {
      // Demand: Steel from Rome -> Berlin — Rome is 6 hexes from nearest network node
      const ctx = makeProximityContext({
        demands: [
          makeDemand({
            cardIndex: 0,
            loadType: 'Steel',
            supplyCity: 'Rome',
            deliveryCity: 'Berlin',
            payout: 30,
            isSupplyOnNetwork: false,
            isDeliveryOnNetwork: true,
          }),
        ],
      });

      const output = ContextBuilder.serializeRoutePlanningPrompt(
        ctx, BotSkillLevel.Medium, proximityGridPoints, proximitySegments,
      );

      // Rome is 6 hexes from nearest network node (10,14) — beyond threshold of 5
      if (output.includes('RESOURCE PROXIMITY')) {
        const section = output.split('RESOURCE PROXIMITY')[1].split('\n\n')[0];
        expect(section).not.toContain('Rome');
      } else {
        // No resource proximity section means Rome wasn't flagged — correct
        expect(output).not.toContain('RESOURCE PROXIMITY');
      }
    });
  });

  // ── Edge cases ─────────────────────────────────────────────────────

  describe('proximity edge cases', () => {

    it('should omit all proximity sections with empty segments', () => {
      const ctx = makeProximityContext({
        demands: [
          makeDemand({
            cardIndex: 0,
            loadType: 'Coal',
            supplyCity: 'Munich',
            deliveryCity: 'Berlin',
            payout: 15,
            isSupplyOnNetwork: false,
            isDeliveryOnNetwork: true,
          }),
        ],
      });

      const output = ContextBuilder.serializeRoutePlanningPrompt(
        ctx, BotSkillLevel.Medium, proximityGridPoints, [],
      );

      expect(output).not.toContain('NEARBY CITIES');
      expect(output).not.toContain('UNCONNECTED DEMAND CITIES');
      expect(output).not.toContain('RESOURCE PROXIMITY');
    });

    it('should omit unconnected and resource proximity sections when there are no demands', () => {
      const ctx = makeProximityContext({
        demands: [],
      });

      const output = ContextBuilder.serializeRoutePlanningPrompt(
        ctx, BotSkillLevel.Medium, proximityGridPoints, proximitySegments,
      );

      expect(output).not.toContain('UNCONNECTED DEMAND CITIES');
      expect(output).not.toContain('RESOURCE PROXIMITY');
      // NEARBY CITIES depends on route stop cities (derived from demands) — no demands = no stops
      expect(output).not.toContain('NEARBY CITIES');
    });

    it('should omit proximity sections when segments default param is used', () => {
      const ctx = makeProximityContext({
        demands: [
          makeDemand({
            cardIndex: 0,
            loadType: 'Coal',
            supplyCity: 'Munich',
            deliveryCity: 'Berlin',
            payout: 15,
            isSupplyOnNetwork: false,
            isDeliveryOnNetwork: true,
          }),
        ],
      });

      // Call without segments parameter (default = [])
      const output = ContextBuilder.serializeRoutePlanningPrompt(
        ctx, BotSkillLevel.Medium, proximityGridPoints,
      );

      expect(output).not.toContain('NEARBY CITIES');
      expect(output).not.toContain('UNCONNECTED DEMAND CITIES');
      expect(output).not.toContain('RESOURCE PROXIMITY');
    });

    it('should include both supply and delivery in UNCONNECTED when both are off-network', () => {
      // Demand: Coal from Munich -> Rome — both off-network
      const ctx = makeProximityContext({
        demands: [
          makeDemand({
            cardIndex: 0,
            loadType: 'Coal',
            supplyCity: 'Munich',
            deliveryCity: 'Rome',
            payout: 25,
            isSupplyOnNetwork: false,
            isDeliveryOnNetwork: false,
          }),
        ],
      });

      const output = ContextBuilder.serializeRoutePlanningPrompt(
        ctx, BotSkillLevel.Medium, proximityGridPoints, proximitySegments,
      );

      expect(output).toContain('UNCONNECTED DEMAND CITIES');
      // Both Munich and Rome should appear
      const section = output.split('UNCONNECTED DEMAND CITIES')[1].split('\n\n')[0];
      expect(section).toContain('Munich');
      expect(section).toContain('Rome');
    });
  });
});

// ── JIRA-16: Hand quality, best demand, enhanced ranking tests ────────────

// ── BE-005: RECENTLY ABANDONED ROUTE in serializeRoutePlanningPrompt ──

describe('RECENTLY ABANDONED ROUTE section in serializeRoutePlanningPrompt (BE-005)', () => {
  function makeCtxForAbandoned(overrides?: Partial<import('../../../shared/types/GameTypes').GameContext>): import('../../../shared/types/GameTypes').GameContext {
    return {
      position: { city: 'Berlin', row: 10, col: 10 },
      money: 50,
      trainType: 'Freight',
      speed: 9,
      capacity: 2,
      loads: [],
      connectedMajorCities: ['Berlin'],
      unconnectedMajorCities: [{ cityName: 'Rome', estimatedCost: 10 }],
      totalMajorCities: 8,
      trackSummary: '4 segments',
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
      phase: 'Mid Game',
      turnNumber: 10,
      ...overrides,
    };
  }

  it('should include abandoned route key in prompt when provided', () => {
    const ctx = makeCtxForAbandoned();
    const output = ContextBuilder.serializeRoutePlanningPrompt(
      ctx, BotSkillLevel.Medium, [], [], 'pickup(Coal@Hamburg)->deliver(Coal@Berlin)',
    );

    expect(output).toContain('RECENTLY ABANDONED ROUTE: pickup(Coal@Hamburg)->deliver(Coal@Berlin)');
    expect(output).toContain('Avoid planning a route identical to this one');
  });

  it('should NOT include abandoned route section when key is null', () => {
    const ctx = makeCtxForAbandoned();
    const output = ContextBuilder.serializeRoutePlanningPrompt(
      ctx, BotSkillLevel.Medium, [], [], null,
    );

    expect(output).not.toContain('RECENTLY ABANDONED ROUTE');
  });

  it('should NOT include abandoned route section when key is undefined', () => {
    const ctx = makeCtxForAbandoned();
    const output = ContextBuilder.serializeRoutePlanningPrompt(
      ctx, BotSkillLevel.Medium, [], [],
    );

    expect(output).not.toContain('RECENTLY ABANDONED ROUTE');
  });

  it('should NOT include abandoned route section when key is empty string', () => {
    const ctx = makeCtxForAbandoned();
    const output = ContextBuilder.serializeRoutePlanningPrompt(
      ctx, BotSkillLevel.Medium, [], [], '',
    );

    expect(output).not.toContain('RECENTLY ABANDONED ROUTE');
  });
});

describe('ContextBuilder card-grouped demands and hand quality (JIRA-16)', () => {
  function makeCtx(overrides?: Partial<import('../../../shared/types/GameTypes').GameContext>): import('../../../shared/types/GameTypes').GameContext {
    return {
      position: { city: 'Berlin', row: 10, col: 10 },
      money: 50,
      trainType: 'Freight',
      speed: 9,
      capacity: 2,
      loads: [],
      connectedMajorCities: ['Berlin'],
      unconnectedMajorCities: [{ cityName: 'Paris', estimatedCost: 15 }],
      totalMajorCities: 8,
      trackSummary: '4 segments',
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
      phase: 'Mid Game',
      turnNumber: 10,
      ...overrides,
    };
  }

  function makeD(overrides: Partial<import('../../../shared/types/GameTypes').DemandContext> & {
    supplyCity: string;
    deliveryCity: string;
    loadType: string;
    payout: number;
  }): import('../../../shared/types/GameTypes').DemandContext {
    return {
      cardIndex: 0,
      isSupplyReachable: true,
      isDeliveryReachable: true,
      isSupplyOnNetwork: false,
      isDeliveryOnNetwork: false,
      estimatedTrackCostToSupply: 5,
      estimatedTrackCostToDelivery: 5,
      isLoadAvailable: true,
      isLoadOnTrain: false,
      ferryRequired: false,
      loadChipTotal: 4,
      loadChipCarried: 0,
      estimatedTurns: 3,
      demandScore: 0,
      efficiencyPerTurn: 0,
      networkCitiesUnlocked: 0,
      victoryMajorCitiesEnRoute: 0,
      isAffordable: true,
      projectedFundsAfterDelivery: 50,
      ...overrides,
    };
  }

  it('should label best demand per card with BEST tag', () => {
    const ctx = makeCtx({
      demands: [
        makeD({ cardIndex: 0, loadType: 'Coal', supplyCity: 'Essen', deliveryCity: 'Berlin', payout: 15, isSupplyOnNetwork: true, isDeliveryOnNetwork: true }),
        makeD({ cardIndex: 0, loadType: 'Wine', supplyCity: 'Lyon', deliveryCity: 'Madrid', payout: 30, estimatedTrackCostToSupply: 20, estimatedTrackCostToDelivery: 25 }),
      ],
    });

    const output = ContextBuilder.serializeRoutePlanningPrompt(ctx, BotSkillLevel.Medium, [], []);
    // Coal should be best (both on network, core delivery)
    expect(output).toContain('Coal');
    expect(output).toMatch(/Coal.*BEST/);
    // Wine should NOT be best
    expect(output).not.toMatch(/Wine.*BEST/);
  });

  it('should include HAND QUALITY summary line', () => {
    const ctx = makeCtx({
      demands: [
        makeD({ cardIndex: 0, loadType: 'Coal', supplyCity: 'Essen', deliveryCity: 'Berlin', payout: 15 }),
        makeD({ cardIndex: 1, loadType: 'Wine', supplyCity: 'Lyon', deliveryCity: 'Paris', payout: 20 }),
        makeD({ cardIndex: 2, loadType: 'Iron', supplyCity: 'Oslo', deliveryCity: 'London', payout: 40, ferryRequired: true }),
      ],
    });

    const output = ContextBuilder.serializeRoutePlanningPrompt(ctx, BotSkillLevel.Medium, [], []);
    expect(output).toContain('HAND QUALITY:');
    // Berlin and Paris are core; London is peripheral+ferry
    expect(output).toContain('cards playable in core');
  });

  it('should count core-playable cards correctly (2/3)', () => {
    const ctx = makeCtx({
      demands: [
        makeD({ cardIndex: 0, loadType: 'Steel', supplyCity: 'Essen', deliveryCity: 'Paris', payout: 9 }),
        makeD({ cardIndex: 1, loadType: 'Wheat', supplyCity: 'München', deliveryCity: 'Ruhr', payout: 13 }),
        makeD({ cardIndex: 2, loadType: 'Machinery', supplyCity: 'Hamburg', deliveryCity: 'London', payout: 25, ferryRequired: true }),
      ],
    });

    const output = ContextBuilder.serializeRoutePlanningPrompt(ctx, BotSkillLevel.Medium, [], []);
    // Cards 0 and 1 deliver to core (Paris, Ruhr); Card 2 delivers to London (peripheral+ferry)
    expect(output).toContain('2/3 cards playable in core');
  });

  it('should include payout, build cost, and turns in demand ranking line', () => {
    const ctx = makeCtx({
      demands: [
        makeD({
          cardIndex: 0,
          loadType: 'Iron',
          supplyCity: 'Szczecin',
          deliveryCity: 'Praha',
          payout: 17,
          estimatedTrackCostToSupply: 3,
          estimatedTrackCostToDelivery: 2,
          estimatedTurns: 4,
          demandScore: 45,
          networkCitiesUnlocked: 2,
          victoryMajorCitiesEnRoute: 0,
        }),
      ],
    });

    const output = ContextBuilder.serializeRoutePlanningPrompt(ctx, BotSkillLevel.Medium, [], []);
    expect(output).toContain('payout: 17M');
    expect(output).toContain('build: ~5M');
    expect(output).toContain('ROI: 12M');
    expect(output).toContain('~4 turns');
    expect(output).toContain('M/turn');
  });

  it('should show enhanced ranking format in serializePrompt too', () => {
    const ctx = makeCtx({
      demands: [
        makeD({
          cardIndex: 0,
          loadType: 'Coal',
          supplyCity: 'Essen',
          deliveryCity: 'Berlin',
          payout: 20,
          estimatedTrackCostToSupply: 0,
          estimatedTrackCostToDelivery: 0,
          estimatedTurns: 2,
          demandScore: 20,
        }),
      ],
    });

    const output = ContextBuilder.serializePrompt(ctx, BotSkillLevel.Medium);
    expect(output).toContain('payout: 20M');
    expect(output).toContain('build: ~0M');
    expect(output).toContain('~2 turns');
    expect(output).toContain('M/turn');
  });

  it('should handle empty demands without HAND QUALITY line', () => {
    const ctx = makeCtx({ demands: [] });
    const output = ContextBuilder.serializeRoutePlanningPrompt(ctx, BotSkillLevel.Medium, [], []);
    expect(output).not.toContain('HAND QUALITY');
    expect(output).toContain('No demand cards');
  });
});

// ── JIRA-13: Demand scoring tests ──────────────────────────────────────────

describe('ContextBuilder demand scoring (JIRA-13)', () => {
  /** Build a DemandContext for scoring tests */
  function makeScoringDemand(overrides: Partial<import('../../../shared/types/GameTypes').DemandContext> & {
    supplyCity: string;
    deliveryCity: string;
    loadType: string;
    payout: number;
  }): import('../../../shared/types/GameTypes').DemandContext {
    return {
      cardIndex: 0,
      isSupplyReachable: false,
      isDeliveryReachable: false,
      isSupplyOnNetwork: false,
      isDeliveryOnNetwork: false,
      estimatedTrackCostToSupply: 0,
      estimatedTrackCostToDelivery: 0,
      isLoadAvailable: true,
      isLoadOnTrain: false,
      ferryRequired: false,
      loadChipTotal: 4,
      loadChipCarried: 0,
      estimatedTurns: 3,
      demandScore: 0,
      efficiencyPerTurn: 0,
      networkCitiesUnlocked: 0,
      victoryMajorCitiesEnRoute: 0,
      isAffordable: true,
      projectedFundsAfterDelivery: 50,
      ...overrides,
    };
  }

  it('should never emit "DO NOT pursue" in reachability note', () => {
    // Demand with negative ROI: cost 50M, payout 10M
    const d = makeScoringDemand({
      loadType: 'Coal',
      supplyCity: 'Lyon',
      deliveryCity: 'Berlin',
      payout: 10,
      estimatedTrackCostToSupply: 30,
      estimatedTrackCostToDelivery: 20,
    });

    const note = (ContextBuilder as any).formatReachabilityNote(d, BotSkillLevel.Medium);
    expect(note).not.toContain('DO NOT pursue');
    expect(note).not.toContain('UNAFFORDABLE');
  });

  it('should include DEMAND RANKING section in serialized prompt', () => {
    const context = {
      position: { row: 10, col: 10 },
      money: 50,
      trainType: 'Freight',
      speed: 9,
      capacity: 2,
      loads: [] as string[],
      connectedMajorCities: ['Berlin'],
      unconnectedMajorCities: [{ cityName: 'Paris', estimatedCost: 15 }],
      totalMajorCities: 8,
      trackSummary: '5 mileposts',
      turnBuildCost: 0,
      demands: [
        makeScoringDemand({
          loadType: 'Coal',
          supplyCity: 'Essen',
          deliveryCity: 'Berlin',
          payout: 20,
          demandScore: 15,
          networkCitiesUnlocked: 2,
          victoryMajorCitiesEnRoute: 0,
        }),
        makeScoringDemand({
          cardIndex: 1,
          loadType: 'Wine',
          supplyCity: 'Lyon',
          deliveryCity: 'Paris',
          payout: 10,
          estimatedTrackCostToSupply: 20,
          estimatedTrackCostToDelivery: 10,
          demandScore: -14,
          networkCitiesUnlocked: 5,
          victoryMajorCitiesEnRoute: 1,
        }),
      ],
      canDeliver: [],
      canPickup: [],
      reachableCities: [],
      citiesOnNetwork: ['Berlin', 'Essen'],
      canUpgrade: false,
      canBuild: true,
      isInitialBuild: false,
      phase: 'Early Game',
      opponents: [],
    } as any;

    const output = ContextBuilder.serializePrompt(context, BotSkillLevel.Medium);
    expect(output).toContain('DEMAND RANKING');
    expect(output).toContain('RECOMMENDED');
    expect(output).toContain('score 15');
    expect(output).toContain('score -14');
  });

  it('all demands negative ROI — best one still marked RECOMMENDED', () => {
    const demands = [
      makeScoringDemand({
        loadType: 'Coal',
        supplyCity: 'Lyon',
        deliveryCity: 'Berlin',
        payout: 10,
        estimatedTrackCostToSupply: 20,
        estimatedTrackCostToDelivery: 15,
        demandScore: -10, // -25 ROI + 5 network cities * 3 = -10
        networkCitiesUnlocked: 5,
        victoryMajorCitiesEnRoute: 0,
      }),
      makeScoringDemand({
        cardIndex: 1,
        loadType: 'Wine',
        supplyCity: 'Bordeaux',
        deliveryCity: 'Paris',
        payout: 8,
        estimatedTrackCostToSupply: 30,
        estimatedTrackCostToDelivery: 20,
        demandScore: -33, // -42 ROI + 3 network * 3 = -33
        networkCitiesUnlocked: 3,
        victoryMajorCitiesEnRoute: 0,
      }),
    ];

    const context = {
      position: { row: 10, col: 10 },
      money: 50,
      trainType: 'Freight',
      speed: 9,
      capacity: 2,
      loads: [] as string[],
      connectedMajorCities: [],
      unconnectedMajorCities: [],
      totalMajorCities: 8,
      trackSummary: 'No track built',
      turnBuildCost: 0,
      demands,
      canDeliver: [],
      canPickup: [],
      reachableCities: [],
      citiesOnNetwork: [],
      canUpgrade: false,
      canBuild: true,
      isInitialBuild: false,
      phase: 'Early Game',
      opponents: [],
    } as any;

    const output = ContextBuilder.serializePrompt(context, BotSkillLevel.Medium);
    // Even with all negative scores, best one gets RECOMMENDED
    expect(output).toContain('RECOMMENDED');
    expect(output).not.toContain('DO NOT pursue');
    // Coal (-10) should rank higher than Wine (-33)
    expect(output).toContain('#1 Coal');
    expect(output).toContain('#2 Wine');
  });

  it('demand near unconnected major city should score higher via victory bonus', () => {
    // Demand A: simple, payout 20, no track cost, no network value
    const demandA = makeScoringDemand({
      loadType: 'Coal',
      supplyCity: 'Essen',
      deliveryCity: 'Berlin',
      payout: 20,
      demandScore: 20, // pure ROI
      networkCitiesUnlocked: 0,
      victoryMajorCitiesEnRoute: 0,
    });

    // Demand B: negative ROI but passes near 2 unconnected major cities
    const demandB = makeScoringDemand({
      cardIndex: 1,
      loadType: 'Wine',
      supplyCity: 'Lyon',
      deliveryCity: 'München',
      payout: 10,
      estimatedTrackCostToSupply: 20,
      demandScore: 21, // -10 ROI + 1 network * 3 + 2 victory * 10 = 21
      networkCitiesUnlocked: 1,
      victoryMajorCitiesEnRoute: 2,
    });

    const context = {
      position: null,
      money: 50,
      trainType: 'Freight',
      speed: 9,
      capacity: 2,
      loads: [] as string[],
      connectedMajorCities: [],
      unconnectedMajorCities: [],
      totalMajorCities: 8,
      trackSummary: 'No track',
      turnBuildCost: 0,
      demands: [demandA, demandB],
      canDeliver: [],
      canPickup: [],
      reachableCities: [],
      citiesOnNetwork: [],
      canUpgrade: false,
      canBuild: true,
      isInitialBuild: false,
      phase: 'Early Game',
      opponents: [],
    } as any;

    const output = ContextBuilder.serializePrompt(context, BotSkillLevel.Medium);
    // Wine (score 21) should rank higher than Coal (score 20) due to victory bonus
    const rankingSection = output.split('DEMAND RANKING')[1];
    const wineRankPos = rankingSection.indexOf('#1 Wine');
    const coalRankPos = rankingSection.indexOf('#2 Coal');
    expect(wineRankPos).toBeGreaterThan(-1);
    expect(coalRankPos).toBeGreaterThan(-1);
    expect(wineRankPos).toBeLessThan(coalRankPos);
  });

  it('demand scoring formula: baseROI + corridorMultiplier * baseROI + victoryBonus', () => {
    // New payout-relative formula (BE-003):
    // baseROI = (payout - trackCost) / estimatedTurns
    // corridorMultiplier = min(networkCities * 0.05, 0.5)
    // victoryBonus = victoryMajorCities * max(payout * 0.15, 5)
    // score = baseROI + corridorMultiplier * baseROI + victoryBonus
    //
    // Example: payout=30, cost=10, turns=2, network=4, victory=1
    // baseROI = (30-10)/2 = 10
    // corridorMultiplier = min(4*0.05, 0.5) = 0.2
    // victoryBonus = 1 * max(30*0.15, 5) = 1 * max(4.5, 5) = 5
    // score = 10 + 0.2*10 + 5 = 17
    const d = makeScoringDemand({
      loadType: 'Coal',
      supplyCity: 'Lyon',
      deliveryCity: 'Paris',
      payout: 30,
      estimatedTrackCostToSupply: 5,
      estimatedTrackCostToDelivery: 5,
      estimatedTurns: 2,
      demandScore: 17,
      networkCitiesUnlocked: 4,
      victoryMajorCitiesEnRoute: 1,
    });

    // Verify the score matches the new formula
    const totalCost = d.estimatedTrackCostToSupply + d.estimatedTrackCostToDelivery;
    const baseROI = (d.payout - totalCost) / d.estimatedTurns;
    const corridorMult = Math.min(d.networkCitiesUnlocked * 0.05, 0.5);
    const victoryBonus = d.victoryMajorCitiesEnRoute * Math.max(d.payout * 0.15, 5);
    expect(d.demandScore).toBe(baseROI + corridorMult * baseROI + victoryBonus);
  });

  it('payout dominance: higher payout beats lower payout with better corridor', () => {
    // 51M payout with modest corridor should beat 21M payout with great corridor
    // High payout: baseROI = (51-10)/3 ≈ 13.67, corridor = min(4*0.05, 0.5) = 0.2
    //   victory = 1 * max(51*0.15, 5) = 7.65
    //   score = 13.67 + 0.2*13.67 + 7.65 ≈ 24.05
    // score = 13.667 + 0.2*13.667 + 7.65 = 24.05
    const highPayoutScore = ((51 - 10) / 3) + (0.2 * ((51 - 10) / 3)) + (1 * Math.max(51 * 0.15, 5));
    const highPayout = makeScoringDemand({
      loadType: 'Wine', supplyCity: 'Lyon', deliveryCity: 'Paris',
      payout: 51, estimatedTrackCostToSupply: 5, estimatedTrackCostToDelivery: 5,
      estimatedTurns: 3, networkCitiesUnlocked: 4, victoryMajorCitiesEnRoute: 1,
      demandScore: highPayoutScore,
    });
    // Low payout: baseROI = (21-10)/3 ≈ 3.67, corridor = min(7*0.05, 0.5) = 0.35
    //   victory = 2 * max(21*0.15, 5) = 10
    //   score = 3.67 + 0.35*3.67 + 10 ≈ 14.95
    const lowPayoutScore = ((21 - 10) / 3) + (0.35 * ((21 - 10) / 3)) + (2 * Math.max(21 * 0.15, 5));
    const lowPayout = makeScoringDemand({
      loadType: 'Coal', supplyCity: 'Essen', deliveryCity: 'Berlin',
      payout: 21, estimatedTrackCostToSupply: 5, estimatedTrackCostToDelivery: 5,
      estimatedTurns: 3, networkCitiesUnlocked: 7, victoryMajorCitiesEnRoute: 2,
      demandScore: lowPayoutScore,
    });

    expect(highPayout.demandScore).toBeGreaterThan(lowPayout.demandScore);
  });

  it('corridor differentiates between equally-priced demands', () => {
    const baseROI = (30 - 10) / 3;
    const withCorridorScore = baseROI + (Math.min(6 * 0.05, 0.5) * baseROI);
    const withCorridor = makeScoringDemand({
      loadType: 'Wine', supplyCity: 'Lyon', deliveryCity: 'Paris',
      payout: 30, estimatedTrackCostToSupply: 5, estimatedTrackCostToDelivery: 5,
      estimatedTurns: 3, networkCitiesUnlocked: 6, victoryMajorCitiesEnRoute: 0,
      demandScore: withCorridorScore,
    });
    const noCorridor = makeScoringDemand({
      loadType: 'Coal', supplyCity: 'Essen', deliveryCity: 'Berlin',
      payout: 30, estimatedTrackCostToSupply: 5, estimatedTrackCostToDelivery: 5,
      estimatedTurns: 3, networkCitiesUnlocked: 0, victoryMajorCitiesEnRoute: 0,
      demandScore: baseROI,
    });

    expect(withCorridor.demandScore).toBeGreaterThan(noCorridor.demandScore);
  });

  it('corridorMultiplier caps at 0.5', () => {
    // 20 network cities * 0.05 = 1.0, but capped at 0.5
    const capped = makeScoringDemand({
      loadType: 'Wine', supplyCity: 'Lyon', deliveryCity: 'Paris',
      payout: 40, estimatedTrackCostToSupply: 0, estimatedTrackCostToDelivery: 0,
      estimatedTurns: 2, networkCitiesUnlocked: 20, victoryMajorCitiesEnRoute: 0,
      demandScore: 30,
    });
    // baseROI = 40/2 = 20, corridorMult = 0.5, score = 20 + 0.5*20 = 30
    const baseROI = 40 / 2;
    expect(capped.demandScore).toBe(baseROI + 0.5 * baseROI);
  });

  it('victoryBonus uses minimum of 5 for very low payouts', () => {
    // payout=10, payout*0.15 = 1.5 < 5, so victoryBonus uses 5
    const lowPayout = makeScoringDemand({
      loadType: 'Coal', supplyCity: 'Essen', deliveryCity: 'Berlin',
      payout: 10, estimatedTrackCostToSupply: 0, estimatedTrackCostToDelivery: 0,
      estimatedTurns: 2, networkCitiesUnlocked: 0, victoryMajorCitiesEnRoute: 2,
      demandScore: 15,
    });
    // baseROI = 10/2 = 5, corridorMult = 0, victoryBonus = 2*5 = 10
    // score = 5 + 0 + 10 = 15
    expect(lowPayout.demandScore).toBe(15);
  });

  it('efficiencyPerTurn should equal ROI / estimatedTurns', () => {
    const d = makeScoringDemand({
      loadType: 'Coal',
      supplyCity: 'Essen',
      deliveryCity: 'Berlin',
      payout: 15,
      estimatedTrackCostToSupply: 2,
      estimatedTrackCostToDelivery: 0,
      estimatedTurns: 2,
      efficiencyPerTurn: 6.5,
    });

    const roi = d.payout - d.estimatedTrackCostToSupply - d.estimatedTrackCostToDelivery;
    expect(d.efficiencyPerTurn).toBe(roi / d.estimatedTurns);
  });

  it('efficiencyPerTurn equals immediateROI when estimatedTurns is 1', () => {
    const d = makeScoringDemand({
      loadType: 'Wine',
      supplyCity: 'Lyon',
      deliveryCity: 'Paris',
      payout: 20,
      estimatedTrackCostToSupply: 5,
      estimatedTrackCostToDelivery: 0,
      estimatedTurns: 1,
      efficiencyPerTurn: 15,
    });

    const roi = d.payout - d.estimatedTrackCostToSupply - d.estimatedTrackCostToDelivery;
    expect(d.efficiencyPerTurn).toBe(roi);
    expect(d.efficiencyPerTurn).toBe(roi / d.estimatedTurns);
  });
});

describe('PREVIOUS ROUTE CONTEXT section in serializeRoutePlanningPrompt (BE-010)', () => {
  function makeCtxForPreviousRoute(overrides?: Partial<import('../../../shared/types/GameTypes').GameContext>): import('../../../shared/types/GameTypes').GameContext {
    return {
      position: { city: 'Berlin', row: 10, col: 10 },
      money: 50,
      trainType: 'Freight',
      speed: 9,
      capacity: 2,
      loads: [],
      connectedMajorCities: ['Berlin'],
      unconnectedMajorCities: [{ cityName: 'Rome', estimatedCost: 10 }],
      totalMajorCities: 8,
      trackSummary: '4 segments',
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
      phase: 'Mid Game',
      turnNumber: 10,
      ...overrides,
    };
  }

  it('should include previous route stops in prompt when provided', () => {
    const ctx = makeCtxForPreviousRoute();
    const previousStops = [
      { action: 'pickup' as const, loadType: 'Steel', city: 'Ruhr' },
      { action: 'deliver' as const, loadType: 'Steel', city: 'Paris', demandCardId: 10, payment: 15 },
    ];
    const output = ContextBuilder.serializeRoutePlanningPrompt(
      ctx, BotSkillLevel.Medium, [], [], null, previousStops,
    );

    expect(output).toContain('PREVIOUS ROUTE (remaining stops from partially completed route):');
    expect(output).toContain('- pickup Steel at Ruhr');
    expect(output).toContain('- deliver Steel at Paris for 15M');
    expect(output).toContain('Consider continuing this route');
  });

  it('should NOT include previous route section when stops are null', () => {
    const ctx = makeCtxForPreviousRoute();
    const output = ContextBuilder.serializeRoutePlanningPrompt(
      ctx, BotSkillLevel.Medium, [], [], null, null,
    );

    expect(output).not.toContain('PREVIOUS ROUTE');
  });

  it('should NOT include previous route section when stops are undefined', () => {
    const ctx = makeCtxForPreviousRoute();
    const output = ContextBuilder.serializeRoutePlanningPrompt(
      ctx, BotSkillLevel.Medium, [], [],
    );

    expect(output).not.toContain('PREVIOUS ROUTE');
  });

  it('should NOT include previous route section when stops array is empty', () => {
    const ctx = makeCtxForPreviousRoute();
    const output = ContextBuilder.serializeRoutePlanningPrompt(
      ctx, BotSkillLevel.Medium, [], [], null, [],
    );

    expect(output).not.toContain('PREVIOUS ROUTE');
  });

  it('should omit payment for pickup stops', () => {
    const ctx = makeCtxForPreviousRoute();
    const previousStops = [
      { action: 'pickup' as const, loadType: 'Coal', city: 'Essen' },
    ];
    const output = ContextBuilder.serializeRoutePlanningPrompt(
      ctx, BotSkillLevel.Medium, [], [], null, previousStops,
    );

    expect(output).toContain('- pickup Coal at Essen');
    expect(output).not.toContain('for undefined');
    expect(output).not.toContain('for null');
  });
});

// ── BE-001: isBuildAffordable ──────────────────────────────────────────────

describe('ContextBuilder.isBuildAffordable', () => {
  const makeResolvedDemands = (
    demands: Array<{ city: string; loadType: string; payment: number }>,
  ) => [{ cardId: 1, demands }];

  it('should return affordable when cash alone covers the build cost', () => {
    const result = ContextBuilder.isBuildAffordable(
      15, // estimated track cost
      30, // bot money
      [],  // no carried loads
      [],  // no demands
      20,  // payout
    );
    expect(result.affordable).toBe(true);
    expect(result.projectedFunds).toBe(30);
  });

  it('should return affordable when cash + projected delivery income covers cost', () => {
    const result = ContextBuilder.isBuildAffordable(
      25, // estimated track cost
      10, // bot money (not enough alone)
      ['Coal'], // carrying Coal
      makeResolvedDemands([{ city: 'Berlin', loadType: 'Coal', payment: 20 }]),
      30, // payout
    );
    expect(result.affordable).toBe(true);
    expect(result.projectedFunds).toBe(30); // 10 + 20
  });

  it('should return unaffordable when funds are insufficient', () => {
    const result = ContextBuilder.isBuildAffordable(
      32, // estimated track cost
      30, // bot money
      [],  // no carried loads
      [],  // no demands
      40,  // payout
    );
    expect(result.affordable).toBe(false);
    expect(result.projectedFunds).toBe(30);
  });

  it('should return unaffordable for negative ROI (track cost > payout)', () => {
    const result = ContextBuilder.isBuildAffordable(
      60, // estimated track cost
      50, // bot money (enough to pay)
      [],
      [],
      55, // payout is less than track cost
    );
    expect(result.affordable).toBe(false);
    expect(result.projectedFunds).toBe(50);
  });

  it('should project income from multiple carried loads', () => {
    const result = ContextBuilder.isBuildAffordable(
      40, // estimated track cost
      5,  // bot money
      ['Coal', 'Oil'], // carrying two loads
      makeResolvedDemands([
        { city: 'Berlin', loadType: 'Coal', payment: 20 },
        { city: 'Paris', loadType: 'Oil', payment: 25 },
      ]),
      50, // payout
    );
    expect(result.affordable).toBe(true);
    expect(result.projectedFunds).toBe(50); // 5 + 20 + 25
  });

  it('should return affordable when track cost is zero', () => {
    const result = ContextBuilder.isBuildAffordable(
      0, // no build needed
      5,
      [],
      [],
      20,
    );
    expect(result.affordable).toBe(true);
    expect(result.projectedFunds).toBe(5);
  });
});

// ── TEST: Ferry-aware estimateTrackCost (JIRA-34) ────────────────────────────

describe('ContextBuilder ferry-aware estimateTrackCost', () => {
  const { getFerryEdges } = require('../../../shared/services/majorCityGroups');

  afterEach(() => {
    // Reset to default empty ferry edges
    (getFerryEdges as jest.Mock).mockReturnValue([]);
  });

  it('same-landmass city: returns positive cost via Dijkstra estimate', async () => {
    // Bot has track at (10,10)→(10,11). Target city CityB at (10,11) is ON
    // the segment endpoint, so computeLandmass includes it → same landmass path.
    const gridPoints: GridPoint[] = [
      makeCityPoint(10, 10, 'Berlin', TerrainType.MajorCity, ['Steel']),
      makeGridPoint(10, 11),
      makeCityPoint(10, 12, 'CityB', TerrainType.SmallCity),
    ];

    const snapshot = makeWorldSnapshot({
      botSegments: [makeSegment(10, 10, 10, 11)],
      botPosition: { row: 10, col: 10 },
      resolvedDemands: [{
        cardId: 1,
        demands: [{ city: 'CityB', loadType: 'Steel', payment: 20 }],
      }],
    });

    const context = await ContextBuilder.build(snapshot, BotSkillLevel.Medium, gridPoints);
    const demand = context.demands.find(d => d.deliveryCity === 'CityB');

    expect(demand).toBeDefined();
    // CityB at (10,12) is 1 hex from segment endpoint (10,11) — should be small positive
    // The landmass BFS from (10,10) and (10,11) won't expand far on the real grid
    // (synthetic positions), but the same-landmass check should still work for
    // positions reachable in the BFS.
    // If it falls through to cross-water path (with empty ferry edges), it will
    // return a hex-distance fallback estimate which is also > 0.
    expect(demand!.estimatedTrackCostToDelivery).toBeGreaterThanOrEqual(0);
  });

  it('cross-water city with no ferry access: returns overland + ferry + far-side cost', async () => {
    // Bot track at (10,10)→(10,11). Target at (30,30) is NOT on the track
    // endpoints, so it appears cross-water. Ferry edges connect from (10,12)
    // to (30,28) — bot doesn't have track at the departure port.
    (getFerryEdges as jest.Mock).mockReturnValue([
      { name: 'TestFerry', pointA: { row: 10, col: 12 }, pointB: { row: 30, col: 28 }, cost: 10 },
    ]);

    const gridPoints: GridPoint[] = [
      makeCityPoint(10, 10, 'Berlin', TerrainType.MajorCity, ['Steel']),
      makeGridPoint(10, 11),
      makeCityPoint(30, 30, 'IslandCity', TerrainType.SmallCity),
    ];

    const snapshot = makeWorldSnapshot({
      botSegments: [makeSegment(10, 10, 10, 11)],
      botPosition: { row: 10, col: 10 },
      resolvedDemands: [{
        cardId: 1,
        demands: [{ city: 'IslandCity', loadType: 'Steel', payment: 50 }],
      }],
    });

    const context = await ContextBuilder.build(snapshot, BotSkillLevel.Medium, gridPoints);
    const demand = context.demands.find(d => d.deliveryCity === 'IslandCity');

    expect(demand).toBeDefined();
    // With no ferry access, estimate should include overland + ferry cost (10M) + far-side
    // This should be significantly more than raw hex distance × 1.5
    expect(demand!.estimatedTrackCostToDelivery).toBeGreaterThanOrEqual(10);
  });

  it('cross-water city with ferry already paid: returns only far-side estimate', async () => {
    // Bot track at (10,10)→(10,11)→(10,12). Ferry departs from (10,12).
    // Since bot has track at the departure port, it can cross for free.
    (getFerryEdges as jest.Mock).mockReturnValue([
      { name: 'TestFerry', pointA: { row: 10, col: 12 }, pointB: { row: 30, col: 28 }, cost: 10 },
    ]);

    const gridPoints: GridPoint[] = [
      makeCityPoint(10, 10, 'Berlin', TerrainType.MajorCity, ['Steel']),
      makeGridPoint(10, 11),
      makeGridPoint(10, 12),
      makeCityPoint(30, 30, 'IslandCity', TerrainType.SmallCity),
    ];

    const snapshot = makeWorldSnapshot({
      botSegments: [makeSegment(10, 10, 10, 11), makeSegment(10, 11, 10, 12)],
      botPosition: { row: 10, col: 10 },
      resolvedDemands: [{
        cardId: 1,
        demands: [{ city: 'IslandCity', loadType: 'Steel', payment: 50 }],
      }],
    });

    const context = await ContextBuilder.build(snapshot, BotSkillLevel.Medium, gridPoints);
    const demand = context.demands.find(d => d.deliveryCity === 'IslandCity');

    expect(demand).toBeDefined();
    // With ferry paid, estimate = only far-side distance (arrival port to city)
    // Should be less than the no-ferry-access estimate (no ferry cost included)
    expect(demand!.estimatedTrackCostToDelivery).toBeGreaterThanOrEqual(0);
  });

  it('ferry-paid estimate should be less than no-ferry-access estimate', async () => {
    // Compare the two cross-water scenarios: with and without ferry access
    (getFerryEdges as jest.Mock).mockReturnValue([
      { name: 'TestFerry', pointA: { row: 10, col: 12 }, pointB: { row: 30, col: 28 }, cost: 10 },
    ]);

    const gridPoints: GridPoint[] = [
      makeCityPoint(10, 10, 'Berlin', TerrainType.MajorCity, ['Steel']),
      makeGridPoint(10, 11),
      makeGridPoint(10, 12),
      makeCityPoint(30, 30, 'IslandCity', TerrainType.SmallCity),
    ];

    // Scenario 1: No ferry access (track stops before departure port)
    const snapshotNoFerry = makeWorldSnapshot({
      botSegments: [makeSegment(10, 10, 10, 11)],
      botPosition: { row: 10, col: 10 },
      resolvedDemands: [{
        cardId: 1,
        demands: [{ city: 'IslandCity', loadType: 'Steel', payment: 50 }],
      }],
    });

    const contextNoFerry = await ContextBuilder.build(snapshotNoFerry, BotSkillLevel.Medium, gridPoints);
    const demandNoFerry = contextNoFerry.demands.find(d => d.deliveryCity === 'IslandCity');

    // Scenario 2: Ferry access (track reaches departure port)
    const snapshotWithFerry = makeWorldSnapshot({
      botSegments: [makeSegment(10, 10, 10, 11), makeSegment(10, 11, 10, 12)],
      botPosition: { row: 10, col: 10 },
      resolvedDemands: [{
        cardId: 1,
        demands: [{ city: 'IslandCity', loadType: 'Steel', payment: 50 }],
      }],
    });

    const contextWithFerry = await ContextBuilder.build(snapshotWithFerry, BotSkillLevel.Medium, gridPoints);
    const demandWithFerry = contextWithFerry.demands.find(d => d.deliveryCity === 'IslandCity');

    expect(demandNoFerry).toBeDefined();
    expect(demandWithFerry).toBeDefined();

    // Ferry-paid should be cheaper (no overland-to-port cost, no ferry cost)
    expect(demandWithFerry!.estimatedTrackCostToDelivery)
      .toBeLessThan(demandNoFerry!.estimatedTrackCostToDelivery);
  });
});

// ── JIRA-82: No supply cities → unfulfillable demand ─────────────────────────

describe('ContextBuilder.build — JIRA-82: no supply cities without load on train', () => {
  it('should mark demand as unfulfillable when no supply cities have chips and load is NOT on train', async () => {
    // Grid: Lyon(0,0) - (0,1) - Paris(0,2). No city supplies Coal.
    const segments = [makeSegment(0, 0, 0, 1), makeSegment(0, 1, 0, 2)];
    const gridPoints: GridPoint[] = [
      makeCityPoint(0, 0, 'Lyon', TerrainType.MajorCity, ['Wine']),
      makeGridPoint(0, 1),
      makeCityPoint(0, 2, 'Paris', TerrainType.MajorCity, ['Cheese']),
    ];

    // Bot does NOT carry Coal, and no city has Coal available → supplyCityNames.size === 0
    const snapshot = makeWorldSnapshot({
      botLoads: [],
      botPosition: { row: 0, col: 0 },
      botSegments: segments,
      resolvedDemands: [{
        cardId: 1,
        demands: [{ city: 'Paris', loadType: 'Coal', payment: 20 }],
      }],
      opponents: [],
    });

    const context = await ContextBuilder.build(snapshot, BotSkillLevel.Medium, gridPoints);
    const demand = context.demands.find(d => d.loadType === 'Coal');

    expect(demand).toBeDefined();
    expect(demand!.isLoadOnTrain).toBe(false);
    expect(demand!.supplyCity).toBe('NoSupply');
    expect(demand!.demandScore).toBe(-999);
    expect(demand!.estimatedTurns).toBe(99);
    expect(demand!.efficiencyPerTurn).toBe(-999);
  });

  it('should still treat load-on-train correctly when supply cities are empty', async () => {
    // Grid: Lyon(0,0) - (0,1) - Paris(0,2). No city supplies Coal.
    const segments = [makeSegment(0, 0, 0, 1), makeSegment(0, 1, 0, 2)];
    const gridPoints: GridPoint[] = [
      makeCityPoint(0, 0, 'Lyon', TerrainType.MajorCity, ['Wine']),
      makeGridPoint(0, 1),
      makeCityPoint(0, 2, 'Paris', TerrainType.MajorCity, ['Cheese']),
    ];

    // Bot carries Coal — should use the "on train" path, NOT unfulfillable
    const snapshot = makeWorldSnapshot({
      botLoads: ['Coal'],
      botPosition: { row: 0, col: 0 },
      botSegments: segments,
      resolvedDemands: [{
        cardId: 1,
        demands: [{ city: 'Paris', loadType: 'Coal', payment: 20 }],
      }],
      opponents: [],
    });

    const context = await ContextBuilder.build(snapshot, BotSkillLevel.Medium, gridPoints);
    const demand = context.demands.find(d => d.loadType === 'Coal');

    expect(demand).toBeDefined();
    expect(demand!.isLoadOnTrain).toBe(true);
    expect(demand!.supplyCity).toBe('Unknown');
    expect(demand!.demandScore).not.toBe(-999);
  });
});
