/**
 * DemandContext.test.ts — Unit tests for the DemandContext computation module.
 * JIRA-195: Slice 1 — ContextBuilder decomposition.
 */

import { DemandContext } from '../../services/ai/context/DemandContext';
import {
  WorldSnapshot,
  GridPoint,
  TerrainType,
  TrackSegment,
  BotSkillLevel,
  GameStatus,
  TrainType,
  BotMemoryState,
  StrategicRoute,
} from '../../../shared/types/GameTypes';

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
  estimatePathCost: jest.fn(() => 10),
  estimateHopDistance: jest.fn(() => 5),
  hexDistance: jest.fn((r1: number, c1: number, r2: number, c2: number): number => {
    const x1 = c1 - Math.floor(r1 / 2);
    const z1 = r1;
    const y1 = -x1 - z1;
    const x2 = c2 - Math.floor(r2 / 2);
    const z2 = r2;
    const y2 = -x2 - z2;
    return Math.max(Math.abs(x1 - x2), Math.abs(y1 - y2), Math.abs(z1 - z2));
  }),
  computeLandmass: jest.fn(() => new Set()),
  computeFerryRouteInfo: jest.fn(() => ({ requiresFerry: false, departurePorts: [], arrivalPorts: [], ferryCost: 0 })),
  makeKey: jest.fn((r: number, c: number) => `${r},${c}`),
  loadGridPoints: jest.fn(() => new Map()),
  getFerryPairPort: jest.fn(() => null),
}));

jest.mock('../../services/ai/connectedMajorCities', () => ({
  getConnectedMajorCities: jest.fn(() => []),
}));

// ── Helper factories ────────────────────────────────────────────────────────

function makeGridPoint(row: number, col: number, overrides?: Partial<GridPoint>): GridPoint {
  return {
    id: `gp-${row}-${col}`, x: col * 40, y: row * 40, row, col,
    terrain: TerrainType.Clear, city: undefined, ...overrides,
  };
}

function makeCityPoint(row: number, col: number, name: string, availableLoads: string[] = []): GridPoint {
  return makeGridPoint(row, col, {
    terrain: TerrainType.SmallCity,
    city: { type: TerrainType.SmallCity, name, availableLoads },
  });
}

function makeSegment(fromRow: number, fromCol: number, toRow: number, toCol: number): TrackSegment {
  return {
    from: { x: fromCol * 40, y: fromRow * 40, row: fromRow, col: fromCol, terrain: TerrainType.Clear },
    to: { x: toCol * 40, y: toRow * 40, row: toRow, col: toCol, terrain: TerrainType.Clear },
    cost: 1,
  };
}

function makeSnapshot(overrides: {
  position?: { row: number; col: number } | null;
  loads?: string[];
  segments?: TrackSegment[];
  money?: number;
  trainType?: string;
  gameStatus?: GameStatus;
  resolvedDemands?: WorldSnapshot['bot']['resolvedDemands'];
  loadAvailability?: Record<string, string[]>;
}): WorldSnapshot {
  return {
    gameId: 'test-game',
    gameStatus: overrides.gameStatus ?? 'active',
    turnNumber: 10,
    bot: {
      playerId: 'bot-1', userId: 'user-1',
      money: overrides.money ?? 80,
      position: overrides.position !== undefined ? overrides.position : null,
      existingSegments: overrides.segments ?? [],
      demandCards: [1, 2, 3],
      resolvedDemands: overrides.resolvedDemands ?? [
        { cardId: 1, demands: [{ city: 'Wien', loadType: 'Steel', payment: 22 }] },
      ],
      trainType: overrides.trainType ?? TrainType.Freight,
      loads: overrides.loads ?? [],
      botConfig: { skillLevel: BotSkillLevel.Medium },
      connectedMajorCityCount: 0,
    },
    allPlayerTracks: [],
    loadAvailability: overrides.loadAvailability ?? { Ruhr: ['Steel'] },
  };
}

function makeMemoryWithRoute(stops: Array<{ action: 'pickup' | 'deliver' | 'drop'; loadType: string; city: string }>): BotMemoryState {
  return {
    currentBuildTarget: null, turnsOnTarget: 0, lastAction: null, consecutiveDiscards: 0,
    deliveryCount: 2, totalEarnings: 40, turnNumber: 9,
    activeRoute: {
      stops, currentStopIndex: 0, phase: 'travel',
      createdAtTurn: 5, reasoning: 'test',
    } as StrategicRoute,
    turnsOnRoute: 3, routeHistory: [], lastReasoning: null, lastPlanHorizon: null,
    previousRouteStops: null, consecutiveLlmFailures: 0,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('DemandContext.computeCanDeliver', () => {
  it('returns empty when no position', () => {
    const snapshot = makeSnapshot({ position: null });
    const result = DemandContext.computeCanDeliver(snapshot, []);
    expect(result).toEqual([]);
  });

  it('returns empty when not at a city', () => {
    const snapshot = makeSnapshot({ position: { row: 0, col: 0 } });
    const gridPoints = [makeGridPoint(0, 0)]; // no city
    const result = DemandContext.computeCanDeliver(snapshot, gridPoints);
    expect(result).toEqual([]);
  });

  it('returns delivery opportunity when at correct city with demanded load', () => {
    const snapshot = makeSnapshot({
      position: { row: 0, col: 0 },
      loads: ['Steel'],
      resolvedDemands: [{ cardId: 1, demands: [{ city: 'Wien', loadType: 'Steel', payment: 22 }] }],
    });
    const gridPoints = [makeCityPoint(0, 0, 'Wien')];
    const result = DemandContext.computeCanDeliver(snapshot, gridPoints);
    expect(result).toHaveLength(1);
    expect(result[0].loadType).toBe('Steel');
    expect(result[0].payout).toBe(22);
  });

  it('returns empty when at city but wrong load on train', () => {
    const snapshot = makeSnapshot({
      position: { row: 0, col: 0 },
      loads: ['Coal'],
      resolvedDemands: [{ cardId: 1, demands: [{ city: 'Wien', loadType: 'Steel', payment: 22 }] }],
    });
    const gridPoints = [makeCityPoint(0, 0, 'Wien')];
    const result = DemandContext.computeCanDeliver(snapshot, gridPoints);
    expect(result).toEqual([]);
  });
});

describe('DemandContext.computeCanPickup', () => {
  it('returns empty when no position', () => {
    const snapshot = makeSnapshot({ position: null });
    const result = DemandContext.computeCanPickup(snapshot, []);
    expect(result).toEqual([]);
  });

  it('returns empty during initialBuild', () => {
    const snapshot = makeSnapshot({ gameStatus: 'initialBuild', position: { row: 0, col: 0 } });
    const gridPoints = [makeCityPoint(0, 0, 'Ruhr', ['Steel'])];
    const result = DemandContext.computeCanPickup(snapshot, gridPoints);
    expect(result).toEqual([]);
  });

  it('returns empty when bot is at capacity', () => {
    const snapshot = makeSnapshot({
      position: { row: 0, col: 0 },
      loads: ['Coal', 'Steel'], // 2/2 capacity for Freight
      trainType: TrainType.Freight,
      loadAvailability: { Ruhr: ['Iron'] },
    });
    const gridPoints = [makeCityPoint(0, 0, 'Ruhr', ['Iron'])];
    const result = DemandContext.computeCanPickup(snapshot, gridPoints);
    expect(result).toEqual([]);
  });

  it('returns opportunity when at supply city with demanded load', () => {
    const snapshot = makeSnapshot({
      position: { row: 0, col: 0 },
      loads: [],
      resolvedDemands: [{ cardId: 1, demands: [{ city: 'Wien', loadType: 'Steel', payment: 22 }] }],
      loadAvailability: { Ruhr: ['Steel'] },
    });
    const gridPoints = [makeCityPoint(0, 0, 'Ruhr', ['Steel'])];
    const result = DemandContext.computeCanPickup(snapshot, gridPoints);
    expect(result).toHaveLength(1);
    expect(result[0].loadType).toBe('Steel');
    expect(result[0].bestPayout).toBe(22);
  });
});

describe('DemandContext.computeEnRoutePickups', () => {
  it('returns empty when no routeStops', () => {
    const snapshot = makeSnapshot({});
    const result = DemandContext.computeEnRoutePickups(snapshot, [], []);
    expect(result).toEqual([]);
  });

  it('returns empty during initialBuild', () => {
    const snapshot = makeSnapshot({ gameStatus: 'initialBuild' });
    const stops = [{ action: 'pickup' as const, loadType: 'Steel', city: 'Ruhr' }];
    const result = DemandContext.computeEnRoutePickups(snapshot, stops, []);
    expect(result).toEqual([]);
  });
});

describe('DemandContext.compute', () => {
  it('enRoutePickups is undefined when memory has no activeRoute', () => {
    const snapshot = makeSnapshot({});
    const memory: BotMemoryState = {
      currentBuildTarget: null, turnsOnTarget: 0, lastAction: null, consecutiveDiscards: 0,
      deliveryCount: 0, totalEarnings: 0, turnNumber: 0, activeRoute: null,
      turnsOnRoute: 0, routeHistory: [], lastReasoning: null, lastPlanHorizon: null,
      previousRouteStops: null, consecutiveLlmFailures: 0,
    };
    const result = DemandContext.compute(snapshot, memory, [], null, [], [], []);
    expect(result.enRoutePickups).toBeUndefined();
  });

  it('enRoutePickups is defined when memory has activeRoute.stops', () => {
    const snapshot = makeSnapshot({
      resolvedDemands: [{ cardId: 1, demands: [{ city: 'Wien', loadType: 'Steel', payment: 22 }] }],
      loadAvailability: { Ruhr: ['Steel'] },
    });
    const memory = makeMemoryWithRoute([{ action: 'pickup', loadType: 'Steel', city: 'Ruhr' }]);
    const gridPoints = [
      makeCityPoint(0, 0, 'Ruhr', ['Steel']),
      makeCityPoint(1, 1, 'Wien'),
    ];
    const result = DemandContext.compute(snapshot, memory, gridPoints, null, [], [], []);
    expect(result.enRoutePickups).toBeDefined();
    expect(Array.isArray(result.enRoutePickups)).toBe(true);
  });
});
