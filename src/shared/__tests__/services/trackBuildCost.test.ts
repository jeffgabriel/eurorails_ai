import {
  computeSegmentBuildCost,
  createBuilderTrackIndex,
  createConfigSegmentCostContext,
  FerryChargeMode,
  MAJOR_CITY_ENTRY_COST,
  SegmentCostContext,
  SegmentCostFerry,
  TrackCostCoord,
  TrackCostPoint,
  TrackCostSegment,
} from '../../services/trackBuildCost';
import { getFerryEdges, getMajorCityGroups, getMajorCityLookup } from '../../services/majorCityGroups';
import { getTerrainBuildCost } from '../../config/terrainCosts';
import { getWaterCrossingExtraCost } from '../../config/waterCrossings';
import { TerrainType } from '../../types/GameTypes';
import mileposts from '../../../../configuration/gridPoints.json';
import waterCrossings from '../../../../configuration/waterCrossings.json';

const key = (c: TrackCostCoord): string => `${c.row},${c.col}`;

function point(row: number, col: number, terrain: TerrainType): TrackCostPoint {
  return { row, col, terrain };
}

function context(overrides: Partial<SegmentCostContext> = {}): SegmentCostContext {
  return {
    isMajorCityPoint: (): boolean => false,
    getFerryAt: (): SegmentCostFerry | undefined => undefined,
    hasBuilderTrackAt: (): boolean => false,
    ferryChargeMode: FerryChargeMode.FirstConnectionOnly,
    ...overrides,
  };
}

// Synthetic coordinates far outside the real map, so no water-crossing edge matches.
const A = point(900, 900, TerrainType.Clear);
const B = point(900, 901, TerrainType.Clear);

describe('computeSegmentBuildCost', () => {
  describe('terrain', () => {
    it.each([
      [TerrainType.Clear, 1],
      [TerrainType.Mountain, 2],
      [TerrainType.Alpine, 5],
      [TerrainType.SmallCity, 3],
      [TerrainType.MediumCity, 3],
      [TerrainType.MajorCity, 5],
      [TerrainType.FerryPort, 0],
      [TerrainType.Water, Infinity],
    ])('charges the destination terrain %s -> %s', (terrain: TerrainType, expected: number) => {
      expect(computeSegmentBuildCost(A, { ...B, terrain }, context())).toBe(expected);
    });

    it('ignores the terrain of the origin milepost', () => {
      expect(computeSegmentBuildCost({ ...A, terrain: TerrainType.Alpine }, B, context())).toBe(1);
    });
  });

  describe('major-city entry rule', () => {
    const isMajorCityPoint = (p: TrackCostPoint): boolean => key(p) === key(B);

    it('charges 5 for the first connection into a major-city milepost, whatever its terrain', () => {
      expect(computeSegmentBuildCost(A, B, context({ isMajorCityPoint }))).toBe(MAJOR_CITY_ENTRY_COST);
    });

    it('charges terrain cost once the builder already has track at that milepost', () => {
      const hasBuilderTrackAt = createBuilderTrackIndex([{ from: A, to: B }]);
      expect(computeSegmentBuildCost(A, B, context({ isMajorCityPoint, hasBuilderTrackAt }))).toBe(1);
    });

    it('charges terrain cost when building out of a major city', () => {
      expect(computeSegmentBuildCost(B, A, context({ isMajorCityPoint }))).toBe(1);
    });

    it('charges terrain cost between two major-city mileposts', () => {
      expect(computeSegmentBuildCost(A, B, context({ isMajorCityPoint: (): boolean => true }))).toBe(1);
    });
  });

  describe('ferry ports', () => {
    const farPort: TrackCostCoord = { row: 905, col: 905 };
    const port = point(900, 901, TerrainType.FerryPort);
    const ferry: SegmentCostFerry = { cost: 8, ports: [port, farPort] };
    const getFerryAt = (p: TrackCostPoint): SegmentCostFerry | undefined =>
      key(p) === key(port) ? ferry : undefined;

    it('FirstConnectionOnly: charges the ferry cost when neither port is on the builder\'s track', () => {
      expect(computeSegmentBuildCost(A, port, context({ getFerryAt }))).toBe(8);
    });

    it.each([
      ['the same port', { from: A, to: port }],
      ['the far port', { from: A, to: farPort }],
    ])('FirstConnectionOnly: charges 0 when the builder already touches %s', (_name: string, segment: TrackCostSegment) => {
      const hasBuilderTrackAt = createBuilderTrackIndex([segment]);
      expect(computeSegmentBuildCost(A, port, context({ getFerryAt, hasBuilderTrackAt }))).toBe(0);
    });

    it('EveryConnection: always charges the ferry cost', () => {
      const hasBuilderTrackAt = createBuilderTrackIndex([{ from: A, to: port }, { from: A, to: farPort }]);
      const ctx = context({ getFerryAt, hasBuilderTrackAt, ferryChargeMode: FerryChargeMode.EveryConnection });
      expect(computeSegmentBuildCost(A, port, ctx)).toBe(8);
    });

    it('ferry cost replaces terrain cost and the major-city entry cost', () => {
      const cityPort = { ...port, terrain: TerrainType.SmallCity };
      const ctx = context({ getFerryAt, isMajorCityPoint: (p: TrackCostPoint): boolean => key(p) === key(port) });
      expect(computeSegmentBuildCost(A, cityPort, ctx)).toBe(8);
    });
  });

  describe('water crossings', () => {
    const parse = (edge: string): [TrackCostCoord, TrackCostCoord] => {
      const [a, b] = edge.split('|').map((part: string): TrackCostCoord => {
        const [row, col] = part.split(',').map(Number);
        return { row, col };
      });
      return [a, b];
    };
    const riverOnly = waterCrossings.riverEdges.find(
      (edge: string): boolean => !waterCrossings.nonRiverWaterEdges.includes(edge),
    )!;
    const lake = waterCrossings.nonRiverWaterEdges.find(
      (edge: string): boolean => !waterCrossings.riverEdges.includes(edge),
    )!;

    it('adds 2 for a river, in either direction', () => {
      const [a, b] = parse(riverOnly);
      expect(computeSegmentBuildCost({ ...a, terrain: TerrainType.Clear }, { ...b, terrain: TerrainType.Mountain }, context())).toBe(4);
      expect(computeSegmentBuildCost({ ...b, terrain: TerrainType.Mountain }, { ...a, terrain: TerrainType.Clear }, context())).toBe(3);
    });

    it('adds 3 for a lake / ocean inlet', () => {
      const [a, b] = parse(lake);
      expect(computeSegmentBuildCost({ ...a, terrain: TerrainType.Clear }, { ...b, terrain: TerrainType.Clear }, context())).toBe(4);
    });

    it('adds at most one surcharge per segment and stacks on a 0-cost ferry connection', () => {
      const [a, b] = parse(riverOnly);
      const to = { ...b, terrain: TerrainType.FerryPort };
      const ferry: SegmentCostFerry = { cost: 4, ports: [b, { row: 905, col: 905 }] };
      const ctx = context({
        getFerryAt: (): SegmentCostFerry => ferry,
        hasBuilderTrackAt: (): boolean => true,
      });
      expect(computeSegmentBuildCost({ ...a, terrain: TerrainType.Clear }, to, ctx)).toBe(2);
    });
  });
});

/**
 * Parity on the real map: the shared function, fed only checked-in config data
 * (what a server has), must reproduce both pre-#307 formulas on every edge.
 */
describe('computeSegmentBuildCost parity with the pre-#307 formulas on the real map', () => {
  const terrainByType: Record<string, TerrainType> = {
    'Milepost': TerrainType.Clear,
    'Clear': TerrainType.Clear,
    'Mountain': TerrainType.Mountain,
    'Alpine': TerrainType.Alpine,
    'Small City': TerrainType.SmallCity,
    'Medium City': TerrainType.MediumCity,
    'Major City': TerrainType.MajorCity,
    'Major City Outpost': TerrainType.MajorCity,
    'Ferry Port': TerrainType.FerryPort,
    'Water': TerrainType.Water,
  };

  const ferryEdges = getFerryEdges();
  const ferryCostByKey = new Map<string, number>();
  const ferryPortsByKey = new Map<string, [TrackCostCoord, TrackCostCoord]>();
  for (const ferry of ferryEdges) {
    for (const port of [ferry.pointA, ferry.pointB]) {
      ferryCostByKey.set(key(port), ferry.cost);
      ferryPortsByKey.set(key(port), [ferry.pointA, ferry.pointB]);
    }
  }
  const majorCityLookup = getMajorCityLookup();

  // Server-style grid: terrain straight from the config (Dublin/Belfast stay SmallCity).
  const grid = new Map<string, TrackCostPoint>();
  for (const raw of mileposts as Array<{ GridX: number; GridY: number; Type: string }>) {
    grid.set(`${raw.GridY},${raw.GridX}`, point(raw.GridY, raw.GridX, terrainByType[raw.Type]));
  }

  const edges: Array<[TrackCostPoint, TrackCostPoint]> = [];
  for (const from of grid.values()) {
    if (from.terrain === TerrainType.Water) continue;
    const deltas: Array<[number, number]> = from.row % 2 === 0
      ? [[-1, -1], [-1, 0], [0, -1], [0, 1], [1, -1], [1, 0]]
      : [[-1, 0], [-1, 1], [0, -1], [0, 1], [1, 0], [1, 1]];
    for (const [dr, dc] of deltas) {
      const to = grid.get(`${from.row + dr},${from.col + dc}`);
      if (to) edges.push([from, to]);
    }
  }

  /** Bots before #307: ferry cost if the destination is a ferry port, else terrain; plus water. */
  function legacyBotCost(from: TrackCostPoint, to: TrackCostPoint): number {
    return (ferryCostByKey.get(key(to)) ?? getTerrainBuildCost(to.terrain)) + getWaterCrossingExtraCost(from, to);
  }

  /**
   * Client before #307, restated over config data. On the client every ferry
   * endpoint has FerryPort terrain (base cost 0) and carries its ferryConnection.
   */
  function legacyClientCost(from: TrackCostPoint, to: TrackCostPoint, builderSegments: TrackCostSegment[]): number {
    const touched = new Set<string>();
    for (const segment of builderSegments) {
      touched.add(key(segment.from));
      touched.add(key(segment.to));
    }
    const ferryPorts = ferryPortsByKey.get(key(to));
    let cost = ferryPorts ? 0 : getTerrainBuildCost(to.terrain);
    if (majorCityLookup.has(key(to)) && !majorCityLookup.has(key(from)) && !touched.has(key(to))) {
      cost = 5;
    }
    if (ferryPorts) {
      cost = ferryPorts.some((port: TrackCostCoord): boolean => touched.has(key(port)))
        ? 0
        : ferryCostByKey.get(key(to))!;
    }
    return cost + getWaterCrossingExtraCost(from, to);
  }

  const touch = (coord: TrackCostCoord): TrackCostSegment => ({ from: coord, to: coord });
  const majorPoints = getMajorCityGroups().flatMap(group => [group.center, ...group.outposts]);
  const trackStates: Array<[string, TrackCostSegment[]]> = [
    ['no track', []],
    ['track at every other major-city milepost', majorPoints.filter((_, i) => i % 2 === 0).map(touch)],
    ['track at the near port of every ferry', ferryEdges.map(ferry => touch(ferry.pointA))],
    ['track at the far port of every other ferry', ferryEdges.filter((_, i) => i % 2 === 1).map(ferry => touch(ferry.pointB))],
    ['track at every major-city milepost and every ferry port', [
      ...majorPoints.map(touch),
      ...ferryEdges.flatMap(ferry => [touch(ferry.pointA), touch(ferry.pointB)]),
    ]],
  ];

  function mismatches(
    builderSegments: TrackCostSegment[],
    mode: FerryChargeMode,
    legacy: (from: TrackCostPoint, to: TrackCostPoint) => number,
  ): string[] {
    const ctx = createConfigSegmentCostContext(builderSegments, mode);
    const result: string[] = [];
    for (const [from, to] of edges) {
      const actual = computeSegmentBuildCost(from, to, ctx);
      const expected = legacy(from, to);
      if (actual !== expected) result.push(`${key(from)}->${key(to)}: legacy ${expected}, shared ${actual}`);
    }
    return result;
  }

  it('covers every adjacent pair of mileposts on the map', () => {
    expect(edges.length).toBeGreaterThan(10000);
    expect(ferryCostByKey.size).toBe(18);
    expect(majorPoints.length).toBe(55);
  });

  it.each(trackStates)('client formula (FirstConnectionOnly), %s', (_name: string, segments: TrackCostSegment[]) => {
    expect(mismatches(
      segments,
      FerryChargeMode.FirstConnectionOnly,
      (from: TrackCostPoint, to: TrackCostPoint): number => legacyClientCost(from, to, segments),
    )).toEqual([]);
  });

  it.each(trackStates)('bot formula (EveryConnection), %s', (_name: string, segments: TrackCostSegment[]) => {
    expect(mismatches(segments, FerryChargeMode.EveryConnection, legacyBotCost)).toEqual([]);
  });

  it('client and bot formulas agree everywhere when the builder has no track', () => {
    const differing = edges.filter(
      ([from, to]) => legacyClientCost(from, to, []) !== legacyBotCost(from, to),
    );
    expect(differing).toEqual([]);
  });

  it('client and bot formulas differ only on segments into a ferry port of a line the builder already touches', () => {
    const segments = trackStates[4][1];
    const differing = edges.filter(
      ([from, to]) => legacyClientCost(from, to, segments) !== legacyBotCost(from, to),
    );
    expect(differing.length).toBeGreaterThan(0);
    expect(differing.every(([, to]) => ferryCostByKey.has(key(to)))).toBe(true);
  });
});
