/**
 * NetworkContext.test.ts — Unit tests for the NetworkContext computation module.
 * JIRA-195: Slice 1 — ContextBuilder decomposition.
 */

import { NetworkContext } from '../../services/ai/context/NetworkContext';
import {
  WorldSnapshot,
  GridPoint,
  TerrainType,
  TrackSegment,
  BotSkillLevel,
  GameStatus,
  TrainType,
} from '../../../shared/types/GameTypes';
import { buildTrackNetwork } from '../../../shared/services/TrackNetworkService';

// ── Mocks ─────────────────────────────────────────────────────────────────────

jest.mock('../../../shared/services/majorCityGroups', () => ({
  getMajorCityGroups: jest.fn(() => [
    { cityName: 'Wien', center: { row: 37, col: 55 }, outposts: [] },
    { cityName: 'Berlin', center: { row: 24, col: 52 }, outposts: [] },
    { cityName: 'Paris', center: { row: 29, col: 32 }, outposts: [] },
  ]),
  getFerryEdges: jest.fn(() => []),
}));

jest.mock('../../services/ai/MapTopology', () => ({
  hexDistance: jest.fn((r1: number, c1: number, r2: number, c2: number): number => {
    const x1 = c1 - Math.floor(r1 / 2);
    const z1 = r1;
    const y1 = -x1 - z1;
    const x2 = c2 - Math.floor(r2 / 2);
    const z2 = r2;
    const y2 = -x2 - z2;
    return Math.max(Math.abs(x1 - x2), Math.abs(y1 - y2), Math.abs(z1 - z2));
  }),
  estimatePathCost: jest.fn(() => 15),
  getFerryPairPort: jest.fn(() => null),
}));

jest.mock('../../services/ai/connectedMajorCities', () => ({
  getConnectedMajorCities: jest.fn(() => []),
}));

// ── Helper factories ────────────────────────────────────────────────────────

function makeGridPoint(row: number, col: number, overrides?: Partial<GridPoint>): GridPoint {
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

function makeCityPoint(row: number, col: number, name: string, terrain: TerrainType = TerrainType.SmallCity): GridPoint {
  return makeGridPoint(row, col, { terrain, city: { type: terrain, name, availableLoads: [] } });
}

function makeSegment(fromRow: number, fromCol: number, toRow: number, toCol: number): TrackSegment {
  return {
    from: { x: fromCol * 40, y: fromRow * 40, row: fromRow, col: fromCol, terrain: TerrainType.Clear },
    to: { x: toCol * 40, y: toRow * 40, row: toRow, col: toCol, terrain: TerrainType.Clear },
    cost: 1,
  };
}

function makeSnapshot(overrides: {
  trainType?: string;
  money?: number;
  turnNumber?: number;
  gameStatus?: GameStatus;
  position?: { row: number; col: number } | null;
  segments?: TrackSegment[];
}): WorldSnapshot {
  return {
    gameId: 'test-game',
    gameStatus: overrides.gameStatus ?? 'playing',
    turnNumber: overrides.turnNumber ?? 10,
    bot: {
      playerId: 'bot-1',
      userId: 'user-1',
      money: overrides.money ?? 80,
      position: overrides.position !== undefined ? overrides.position : null,
      existingSegments: overrides.segments ?? [],
      demandCards: [1, 2, 3],
      resolvedDemands: [],
      trainType: overrides.trainType ?? TrainType.Freight,
      loads: [],
      botConfig: { skillLevel: BotSkillLevel.Medium },
      connectedMajorCityCount: 0,
    },
    allPlayerTracks: [],
    loadAvailability: {},
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('NetworkContext.computeReachableCities', () => {
  it('returns empty when speed is 0', () => {
    const segments = [makeSegment(0, 0, 0, 1), makeSegment(0, 1, 0, 2)];
    const network = buildTrackNetwork(segments);
    const gridPoints = [makeCityPoint(0, 0, 'CityA'), makeGridPoint(0, 1), makeCityPoint(0, 2, 'CityB')];
    const result = NetworkContext.computeReachableCities({ row: 0, col: 0 }, 0, network, gridPoints);
    expect(result).toContain('CityA');
    expect(result).not.toContain('CityB');
  });

  it('returns city at starting position', () => {
    const segments = [makeSegment(0, 0, 0, 1)];
    const network = buildTrackNetwork(segments);
    const gridPoints = [makeCityPoint(0, 0, 'StartCity'), makeGridPoint(0, 1)];
    const result = NetworkContext.computeReachableCities({ row: 0, col: 0 }, 9, network, gridPoints);
    expect(result).toContain('StartCity');
  });

  it('returns cities within speed limit', () => {
    // A-B-C: speed 2 can reach C from A
    const segments = [makeSegment(0, 0, 0, 1), makeSegment(0, 1, 0, 2)];
    const network = buildTrackNetwork(segments);
    const gridPoints = [makeCityPoint(0, 0, 'CityA'), makeGridPoint(0, 1), makeCityPoint(0, 2, 'CityB')];
    const result = NetworkContext.computeReachableCities({ row: 0, col: 0 }, 2, network, gridPoints);
    expect(result).toContain('CityA');
    expect(result).toContain('CityB');
  });

  it('does not include cities beyond speed limit', () => {
    const segments = [makeSegment(0, 0, 0, 1), makeSegment(0, 1, 0, 2), makeSegment(0, 2, 0, 3)];
    const network = buildTrackNetwork(segments);
    const gridPoints = [
      makeCityPoint(0, 0, 'CityA'),
      makeGridPoint(0, 1),
      makeGridPoint(0, 2),
      makeCityPoint(0, 3, 'CityB'),
    ];
    // speed 2 can't reach CityB at distance 3
    const result = NetworkContext.computeReachableCities({ row: 0, col: 0 }, 2, network, gridPoints);
    expect(result).not.toContain('CityB');
  });

  it('returns empty array when no network', () => {
    const segments: TrackSegment[] = [];
    const network = buildTrackNetwork(segments);
    const gridPoints = [makeCityPoint(0, 0, 'CityA')];
    const result = NetworkContext.computeReachableCities({ row: 0, col: 0 }, 9, network, gridPoints);
    expect(result).toEqual([]);
  });
});

describe('NetworkContext.computeCitiesOnNetwork', () => {
  it('returns all cities on the network regardless of distance', () => {
    const segments = [makeSegment(0, 0, 0, 1), makeSegment(0, 1, 0, 2), makeSegment(0, 2, 0, 3)];
    const network = buildTrackNetwork(segments);
    const gridPoints = [
      makeCityPoint(0, 0, 'CityA'),
      makeGridPoint(0, 1),
      makeCityPoint(0, 2, 'CityC'),
      makeCityPoint(0, 3, 'CityD'),
    ];
    const result = NetworkContext.computeCitiesOnNetwork(network, gridPoints);
    expect(result).toContain('CityA');
    expect(result).toContain('CityC');
    expect(result).toContain('CityD');
  });

  it('returns empty for empty network', () => {
    const network = buildTrackNetwork([]);
    const result = NetworkContext.computeCitiesOnNetwork(network, []);
    expect(result).toEqual([]);
  });
});

describe('NetworkContext.computePhase', () => {
  it('returns Initial Build when gameStatus is initialBuild', () => {
    const snapshot = makeSnapshot({ gameStatus: 'initialBuild' });
    const result = NetworkContext.computePhase(snapshot, []);
    expect(result).toBe('Initial Build');
  });

  it('returns Early Game when few cities and low money', () => {
    const snapshot = makeSnapshot({ money: 50 });
    const result = NetworkContext.computePhase(snapshot, ['Berlin']);
    expect(result).toBe('Early Game');
  });

  it('returns Mid Game with 3+ connected major cities', () => {
    const snapshot = makeSnapshot({ money: 50 });
    const result = NetworkContext.computePhase(snapshot, ['Berlin', 'Paris', 'Wien']);
    expect(result).toBe('Mid Game');
  });

  it('returns Mid Game when money >= 80', () => {
    const snapshot = makeSnapshot({ money: 80 });
    const result = NetworkContext.computePhase(snapshot, []);
    expect(result).toBe('Mid Game');
  });

  it('returns Late Game with 5+ cities and 150M+', () => {
    const snapshot = makeSnapshot({ money: 160 });
    const result = NetworkContext.computePhase(snapshot, ['a', 'b', 'c', 'd', 'e']);
    expect(result).toBe('Late Game');
  });

  it('returns Victory Imminent with 5+ cities and 250M+', () => {
    const snapshot = makeSnapshot({ money: 260 });
    const result = NetworkContext.computePhase(snapshot, ['a', 'b', 'c', 'd', 'e']);
    expect(result).toBe('Victory Imminent');
  });

  it('returns Victory Imminent with 6+ cities and 230M+', () => {
    const snapshot = makeSnapshot({ money: 235 });
    const result = NetworkContext.computePhase(snapshot, ['a', 'b', 'c', 'd', 'e', 'f']);
    expect(result).toBe('Victory Imminent');
  });
});

describe('NetworkContext.compute', () => {
  it('returns network=null when no segments', () => {
    const snapshot = makeSnapshot({ segments: [], position: null });
    const result = NetworkContext.compute(snapshot, []);
    expect(result.network).toBeNull();
    expect(result.reachableCities).toEqual([]);
    expect(result.citiesOnNetwork).toEqual([]);
  });

  it('returns phase based on gameStatus', () => {
    const snapshot = makeSnapshot({ gameStatus: 'initialBuild' });
    const result = NetworkContext.compute(snapshot, []);
    expect(result.phase).toBe('Initial Build');
  });

  it('includes positionCityName when at a city', () => {
    const snapshot = makeSnapshot({
      position: { row: 0, col: 0 },
      segments: [makeSegment(0, 0, 0, 1)],
    });
    const gridPoints = [makeCityPoint(0, 0, 'StartCity'), makeGridPoint(0, 1)];
    const result = NetworkContext.compute(snapshot, gridPoints);
    expect(result.positionCityName).toBe('StartCity');
  });

  it('positionCityName is undefined when not at a city', () => {
    const snapshot = makeSnapshot({ position: { row: 0, col: 1 }, segments: [makeSegment(0, 0, 0, 1)] });
    const gridPoints = [makeCityPoint(0, 0, 'StartCity'), makeGridPoint(0, 1)];
    const result = NetworkContext.compute(snapshot, gridPoints);
    expect(result.positionCityName).toBeUndefined();
  });
});
