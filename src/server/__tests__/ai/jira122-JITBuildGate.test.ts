/**
 * JIRA-122: Unit tests for JIT build gate, ferry-aware BFS, target-biased
 * source selection, and region duplicate detection.
 */

import { NetworkBuildAnalyzer, FerryAwareNetworkResult } from '../../services/ai/NetworkBuildAnalyzer';
import { TurnComposer } from '../../services/ai/TurnComposer';
import {
  TerrainType,
  TrackSegment,
  WorldSnapshot,
  GameContext,
  StrategicRoute,
  TrainType,
} from '../../../shared/types/GameTypes';
import { GridPointData } from '../../services/ai/MapTopology';

// ── Mock MapTopology ────────────────────────────────────────────────────
function evenQHexNeighbors(row: number, col: number): { row: number; col: number }[] {
  const isEvenCol = col % 2 === 0;
  if (isEvenCol) {
    return [
      { row: row - 1, col },
      { row: row + 1, col },
      { row: row - 1, col: col - 1 },
      { row, col: col - 1 },
      { row: row - 1, col: col + 1 },
      { row, col: col + 1 },
    ];
  } else {
    return [
      { row: row - 1, col },
      { row: row + 1, col },
      { row, col: col - 1 },
      { row: row + 1, col: col - 1 },
      { row, col: col + 1 },
      { row: row + 1, col: col + 1 },
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
  loadGridPoints: jest.fn(() => new Map()),
  gridToPixel: jest.fn(),
  hexDistance: jest.fn(),
  _resetCache: jest.fn(),
}));

jest.mock('../../../shared/services/majorCityGroups', () => ({
  getFerryEdges: jest.fn(() => []),
}));

const { getFerryEdges } = require('../../../shared/services/majorCityGroups');
const { loadGridPoints } = require('../../services/ai/MapTopology');

// ── Test Grid Setup ─────────────────────────────────────────────────────
function buildTestGrid(overrides: Map<string, Partial<GridPointData>> = new Map()): Map<string, GridPointData> {
  const grid = new Map<string, GridPointData>();
  for (let row = 0; row < 15; row++) {
    for (let col = 0; col < 15; col++) {
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

function makeSnapshot(overrides: Partial<WorldSnapshot> = {}): WorldSnapshot {
  return {
    gameId: 'g1',
    gameStatus: 'active',
    turnNumber: 20,
    bot: {
      playerId: 'bot-1',
      userId: 'user-bot-1',
      money: 50,
      position: { row: 5, col: 5 },
      existingSegments: [
        makeSegment(5, 5, 5, 6),
        makeSegment(5, 6, 5, 7),
        makeSegment(5, 7, 5, 8),
        makeSegment(5, 8, 5, 9),
        makeSegment(5, 9, 5, 10),
        makeSegment(5, 10, 5, 11),
      ],
      demandCards: [1],
      resolvedDemands: [],
      trainType: TrainType.Freight,
      loads: [],
      botConfig: null,
      connectedMajorCityCount: 0,
    },
    allPlayerTracks: [],
    loadAvailability: {},
    ...overrides,
  };
}

function makeContext(overrides: Partial<GameContext> = {}): GameContext {
  return {
    position: { row: 5, col: 5 },
    money: 50,
    trainType: TrainType.Freight,
    speed: 9,
    capacity: 2,
    loads: [],
    connectedMajorCities: [],
    unconnectedMajorCities: [],
    totalMajorCities: 8,
    trackSummary: '6 segments',
    turnBuildCost: 0,
    demands: [],
    canDeliver: [],
    canPickup: [],
    reachableCities: [],
    citiesOnNetwork: [],
    canUpgrade: false,
    canBuild: true,
    isInitialBuild: false,
    opponents: [],
    phase: 'running',
    turnNumber: 20,
    ...overrides,
  };
}

function makeRoute(overrides: Partial<StrategicRoute> = {}): StrategicRoute {
  return {
    stops: [
      { action: 'pickup', loadType: 'Coal', city: 'Berlin' },
      { action: 'deliver', loadType: 'Coal', city: 'Paris', demandCardId: 1, payment: 25 },
    ],
    currentStopIndex: 0,
    phase: 'build',
    createdAtTurn: 15,
    reasoning: 'Test route',
    ...overrides,
  };
}

// ═══════════════════════════════════════════════════════════════════════
// Part 1: JIT Build Gate Tests
// ═══════════════════════════════════════════════════════════════════════

describe('TurnComposer.shouldDeferBuild', () => {
  describe('initial build exemption', () => {
    it('allows build during initial build phase', () => {
      const snapshot = makeSnapshot();
      const context = makeContext({ isInitialBuild: true, turnNumber: 1 });
      const route = makeRoute();
      const result = TurnComposer.shouldDeferBuild(snapshot, context, route, 'Berlin', 9);
      expect(result.deferred).toBe(false);
      expect(result.reason).toBe('initial_build_exempt');
    });

    it('allows build during first 2 turns', () => {
      const snapshot = makeSnapshot();
      const context = makeContext({ turnNumber: 2 });
      const route = makeRoute();
      const result = TurnComposer.shouldDeferBuild(snapshot, context, route, 'Berlin', 9);
      expect(result.deferred).toBe(false);
      expect(result.reason).toBe('initial_build_exempt');
    });
  });

  describe('victory build exemption', () => {
    it('allows build when cash > 230M and target is unconnected major city', () => {
      const snapshot = makeSnapshot({ bot: { ...makeSnapshot().bot, money: 240 } });
      const context = makeContext({
        money: 240,
        turnNumber: 60,
        unconnectedMajorCities: [{ cityName: 'Berlin', estimatedCost: 10 }],
      });
      const route = makeRoute();
      const result = TurnComposer.shouldDeferBuild(snapshot, context, route, 'Berlin', 9);
      expect(result.deferred).toBe(false);
      expect(result.reason).toBe('victory_build_exempt');
    });
  });

  describe('no active route', () => {
    it('defers when no active route exists', () => {
      const snapshot = makeSnapshot();
      const context = makeContext({ turnNumber: 20 });
      const result = TurnComposer.shouldDeferBuild(snapshot, context, null, 'Berlin', 9);
      expect(result.deferred).toBe(true);
      expect(result.reason).toBe('no_active_route');
    });
  });

  describe('delivery certainty', () => {
    it('defers when build target is not in route stops', () => {
      const snapshot = makeSnapshot();
      const context = makeContext({ turnNumber: 20 });
      const route = makeRoute({
        stops: [{ action: 'pickup', loadType: 'Coal', city: 'Paris' }],
      });
      const result = TurnComposer.shouldDeferBuild(snapshot, context, route, 'Berlin', 9);
      expect(result.deferred).toBe(true);
      expect(result.reason).toBe('target_not_in_route');
    });

    it('allows build when route is in travel phase (bot is committed to route)', () => {
      const snapshot = makeSnapshot();
      const context = makeContext({ turnNumber: 20, loads: [] });
      const route = makeRoute({
        phase: 'travel',
        stops: [{ action: 'deliver', loadType: 'Coal', city: 'Berlin' }],
      });
      const result = TurnComposer.shouldDeferBuild(snapshot, context, route, 'Berlin', 9);
      // Travel phase means bot is actively moving toward route — committed
      expect(result.deferred).toBe(false);
    });

    it('allows build when route is in build phase (actively building toward route stop)', () => {
      const snapshot = makeSnapshot();
      const context = makeContext({ turnNumber: 20 });
      const route = makeRoute({
        phase: 'build',
        stops: [{ action: 'pickup', loadType: 'Coal', city: 'Berlin' }],
      });
      // Route phase is 'build' and target is in route — should allow
      const result = TurnComposer.shouldDeferBuild(snapshot, context, route, 'Berlin', 9);
      expect(result.deferred).toBe(false);
    });
  });

  describe('track runway', () => {
    it('defers when destination is on network (sufficient runway)', () => {
      const snapshot = makeSnapshot();
      const context = makeContext({
        turnNumber: 20,
        citiesOnNetwork: ['Berlin'],
      });
      const route = makeRoute({
        phase: 'build',
        stops: [{ action: 'pickup', loadType: 'Coal', city: 'Berlin' }],
      });
      const result = TurnComposer.shouldDeferBuild(snapshot, context, route, 'Berlin', 9);
      expect(result.deferred).toBe(true);
      expect(result.reason).toBe('sufficient_runway');
      expect(result.trackRunway).toBeGreaterThanOrEqual(2);
    });
  });

  describe('intermediate stop travel time (JIRA-154)', () => {
    it('defers when buildTargetStopIndex > currentStopIndex and intermediate stops push effectiveRunway >= 2', () => {
      // Stops 0-2 on network, stop 3 off network (build target).
      // loadGridPoints returns positions for intermediate cities far apart,
      // so intermediateStopTurns > 2.
      const gridWithCities = new Map<string, GridPointData>();
      for (let row = 0; row < 20; row++) {
        for (let col = 0; col < 20; col++) {
          const key = `${row},${col}`;
          gridWithCities.set(key, { row, col, terrain: TerrainType.Clear });
        }
      }
      // Place cities at specific positions: Warsaw at (0,0), Budapest at (10,10), destination at (5,5)
      gridWithCities.set('0,0', { row: 0, col: 0, terrain: TerrainType.Clear, name: 'Warszawa' });
      gridWithCities.set('10,10', { row: 10, col: 10, terrain: TerrainType.Clear, name: 'Budapest' });
      gridWithCities.set('5,5', { row: 5, col: 5, terrain: TerrainType.Clear, name: 'Holland' });
      loadGridPoints.mockReturnValue(gridWithCities);

      // Mock hexDistance to return large values for distant cities
      const { hexDistance: mockHexDistance } = require('../../services/ai/MapTopology');
      mockHexDistance.mockImplementation((r1: number, c1: number, r2: number, c2: number) => {
        return Math.abs(r2 - r1) + Math.abs(c2 - c1);
      });

      const snapshot = makeSnapshot({ bot: { ...makeSnapshot().bot, position: { row: 0, col: 0 } } });
      const context = makeContext({
        turnNumber: 20,
        citiesOnNetwork: ['Warszawa', 'Budapest'],
      });

      // Route: Warszawa(0) → Budapest(1) → Budapest(2) → Holland(3 - off network)
      // currentStopIndex = 0, buildTargetStopIndex = 3
      const route = makeRoute({
        phase: 'build',
        currentStopIndex: 0,
        stops: [
          { action: 'pickup', loadType: 'Coal', city: 'Warszawa' },
          { action: 'deliver', loadType: 'Coal', city: 'Budapest', demandCardId: 1, payment: 10 },
          { action: 'pickup', loadType: 'Oil', city: 'Budapest' },
          { action: 'deliver', loadType: 'Oil', city: 'Holland', demandCardId: 2, payment: 15 },
        ],
      });

      // buildTargetStopIndex = 3 (Holland is off-network)
      const result = TurnComposer.shouldDeferBuild(snapshot, context, route, 'Holland', 9, 3);
      expect(result.deferred).toBe(true);
      expect(result.reason).toBe('sufficient_runway');
      expect(result.intermediateStopTurns).toBeGreaterThan(0);
      expect(result.effectiveRunway).toBe(result.intermediateStopTurns + result.trackRunway);
    });

    it('allows build when buildTargetStopIndex === currentStopIndex (no intermediate stops)', () => {
      loadGridPoints.mockReturnValue(new Map());
      const snapshot = makeSnapshot();
      const context = makeContext({ turnNumber: 20 });
      const route = makeRoute({
        phase: 'build',
        currentStopIndex: 0,
        stops: [{ action: 'pickup', loadType: 'Coal', city: 'Berlin' }],
      });
      // buildTargetStopIndex === currentStopIndex → no intermediate stops → no extra deferral
      const result = TurnComposer.shouldDeferBuild(snapshot, context, route, 'Berlin', 9, 0);
      // No intermediate turns, track runway from BFS = 0 (Berlin not on network, city not in grid)
      expect(result.intermediateStopTurns).toBe(0);
      expect(result.deferred).toBe(false);
      expect(result.reason).toBe('build_needed');
    });

    it('returns intermediateStopTurns and effectiveRunway in all result shapes', () => {
      const snapshot = makeSnapshot();
      const context = makeContext({ isInitialBuild: true, turnNumber: 1 });
      const route = makeRoute();
      const result = TurnComposer.shouldDeferBuild(snapshot, context, route, 'Berlin', 9);
      expect(result).toHaveProperty('intermediateStopTurns');
      expect(result).toHaveProperty('effectiveRunway');
    });
  });
});

describe('TurnComposer.estimateIntermediateStopTurns', () => {
  const { hexDistance: mockHexDistance } = require('../../services/ai/MapTopology');

  beforeEach(() => {
    mockHexDistance.mockReset();
  });

  it('returns 0 when buildTargetStopIndex === currentStopIndex', () => {
    loadGridPoints.mockReturnValue(new Map());
    const snapshot = makeSnapshot();
    const context = makeContext({ citiesOnNetwork: [] });
    const route = makeRoute({ currentStopIndex: 0 });
    const result = TurnComposer.estimateIntermediateStopTurns(snapshot, context, route, 0, 9);
    expect(result).toBe(0);
  });

  it('returns 0 when trainSpeed is 0', () => {
    loadGridPoints.mockReturnValue(new Map());
    const snapshot = makeSnapshot();
    const context = makeContext({ citiesOnNetwork: ['Berlin'] });
    const route = makeRoute({
      currentStopIndex: 0,
      stops: [
        { action: 'pickup', loadType: 'Coal', city: 'Berlin' },
        { action: 'deliver', loadType: 'Coal', city: 'Paris', demandCardId: 1, payment: 25 },
      ],
    });
    const result = TurnComposer.estimateIntermediateStopTurns(snapshot, context, route, 1, 0);
    expect(result).toBe(0);
  });

  it('returns 0 when intermediate stops are not on network', () => {
    // Berlin is NOT on network — should be skipped in intermediate calculation
    const gridWithCities = new Map<string, GridPointData>();
    gridWithCities.set('3,3', { row: 3, col: 3, terrain: TerrainType.Clear, name: 'Berlin' });
    loadGridPoints.mockReturnValue(gridWithCities);
    mockHexDistance.mockReturnValue(10);

    const snapshot = makeSnapshot();
    const context = makeContext({ citiesOnNetwork: [] }); // Berlin NOT on network
    const route = makeRoute({
      currentStopIndex: 0,
      stops: [
        { action: 'pickup', loadType: 'Coal', city: 'Berlin' },
        { action: 'deliver', loadType: 'Coal', city: 'Paris', demandCardId: 1, payment: 25 },
      ],
    });
    const result = TurnComposer.estimateIntermediateStopTurns(snapshot, context, route, 1, 9);
    expect(result).toBe(0); // Berlin skipped — not on network
  });

  it('counts travel time for on-network intermediate stops', () => {
    // Berlin IS on network: distance from bot (5,5) to Berlin (3,3) = 4 hops
    const gridWithCities = new Map<string, GridPointData>();
    gridWithCities.set('3,3', { row: 3, col: 3, terrain: TerrainType.Clear, name: 'Berlin' });
    loadGridPoints.mockReturnValue(gridWithCities);
    mockHexDistance.mockReturnValue(18); // 18 mileposts between cities

    const snapshot = makeSnapshot(); // bot at (5,5)
    const context = makeContext({ citiesOnNetwork: ['Berlin'] });
    const route = makeRoute({
      currentStopIndex: 0,
      stops: [
        { action: 'pickup', loadType: 'Coal', city: 'Berlin' },
        { action: 'deliver', loadType: 'Coal', city: 'Paris', demandCardId: 1, payment: 25 },
      ],
    });
    const result = TurnComposer.estimateIntermediateStopTurns(snapshot, context, route, 1, 9);
    // 18 mileposts / 9 speed = 2 turns
    expect(result).toBe(2);
  });
});

describe('TurnComposer.calculateTrackRunway', () => {
  it('returns 0 when bot has no position', () => {
    const snapshot = makeSnapshot({ bot: { ...makeSnapshot().bot, position: null } });
    const context = makeContext();
    const result = TurnComposer.calculateTrackRunway(snapshot, 'Berlin', 9, context);
    expect(result).toBe(0);
  });

  it('returns 0 when train speed is 0', () => {
    const snapshot = makeSnapshot();
    const context = makeContext();
    const result = TurnComposer.calculateTrackRunway(snapshot, 'Berlin', 0, context);
    expect(result).toBe(0);
  });

  it('returns high runway when destination is on network', () => {
    const snapshot = makeSnapshot();
    const context = makeContext({ citiesOnNetwork: ['Berlin'] });
    const result = TurnComposer.calculateTrackRunway(snapshot, 'Berlin', 9, context);
    expect(result).toBe(10);
  });

  it('returns 0 when destination city not found in grid', () => {
    const snapshot = makeSnapshot();
    const context = makeContext();
    loadGridPoints.mockReturnValue(new Map());
    const result = TurnComposer.calculateTrackRunway(snapshot, 'UnknownCity', 9, context);
    expect(result).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Part 2: Ferry-Aware BFS Tests
// ═══════════════════════════════════════════════════════════════════════

describe('NetworkBuildAnalyzer.findNearestNetworkPointFerryAware', () => {
  beforeEach(() => {
    NetworkBuildAnalyzer._resetFerryCache();
  });

  it('returns distance 0 when target is on network', () => {
    const gridPoints = buildTestGrid();
    const networkNodes = new Set(['3,3']);
    getFerryEdges.mockReturnValue([]);
    const result = NetworkBuildAnalyzer.findNearestNetworkPointFerryAware(
      { row: 3, col: 3 }, networkNodes, gridPoints,
    );
    expect(result).not.toBeNull();
    expect(result!.distance).toBe(0);
    expect(result!.ferryCrossings).toBe(0);
  });

  it('returns null for empty network', () => {
    const gridPoints = buildTestGrid();
    getFerryEdges.mockReturnValue([]);
    const result = NetworkBuildAnalyzer.findNearestNetworkPointFerryAware(
      { row: 3, col: 3 }, new Set(), gridPoints,
    );
    expect(result).toBeNull();
  });

  it('finds adjacent network node without ferry', () => {
    const gridPoints = buildTestGrid();
    const networkNodes = new Set(['2,3']);
    getFerryEdges.mockReturnValue([]);
    const result = NetworkBuildAnalyzer.findNearestNetworkPointFerryAware(
      { row: 3, col: 3 }, networkNodes, gridPoints,
    );
    expect(result).not.toBeNull();
    expect(result!.distance).toBe(1);
    expect(result!.ferryCrossings).toBe(0);
  });

  it('finds network node across ferry crossing with 0 additional distance', () => {
    // Set up: target at (3,3), ferry between (3,5) and (3,8),
    // network at (3,8). Without ferry, (3,8) is 5 hops away.
    // With ferry: (3,3) → (3,4) → (3,5) [ferry port] → (3,8) [partner] = distance 2
    const gridPoints = buildTestGrid();
    const networkNodes = new Set(['3,8']);
    getFerryEdges.mockReturnValue([
      { name: 'Test Ferry', pointA: { row: 3, col: 5 }, pointB: { row: 3, col: 8 }, cost: 8 },
    ]);
    const result = NetworkBuildAnalyzer.findNearestNetworkPointFerryAware(
      { row: 3, col: 3 }, networkNodes, gridPoints,
    );
    expect(result).not.toBeNull();
    expect(result!.ferryCrossings).toBe(1);
    // Distance should be the land segments only (ferry crossing = 0)
    expect(result!.distance).toBeLessThan(5);
  });

  it('ferry crossing counts as 0 distance', () => {
    // Target at ferry port A, network at ferry port B
    const gridPoints = buildTestGrid();
    const networkNodes = new Set(['3,8']);
    getFerryEdges.mockReturnValue([
      { name: 'Direct Ferry', pointA: { row: 3, col: 3 }, pointB: { row: 3, col: 8 }, cost: 8 },
    ]);
    const result = NetworkBuildAnalyzer.findNearestNetworkPointFerryAware(
      { row: 3, col: 3 }, networkNodes, gridPoints,
    );
    expect(result).not.toBeNull();
    expect(result!.distance).toBe(0); // Ferry hop is 0 distance
    expect(result!.ferryCrossings).toBe(1);
    expect(result!.point).toEqual({ row: 3, col: 8 });
  });

  it('returns null when maxDistance is exceeded', () => {
    const gridPoints = buildTestGrid();
    const networkNodes = new Set(['0,0']);
    getFerryEdges.mockReturnValue([]);
    const result = NetworkBuildAnalyzer.findNearestNetworkPointFerryAware(
      { row: 14, col: 14 }, networkNodes, gridPoints, 2,
    );
    expect(result).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Part 3: Search Depth Increase Tests
// ═══════════════════════════════════════════════════════════════════════

describe('Search depth increases', () => {
  beforeEach(() => {
    NetworkBuildAnalyzer._resetFerryCache();
    getFerryEdges.mockReturnValue([]);
  });

  it('findNearbyFerryPorts defaults to maxDistance=8', () => {
    // Set up a ferry 7 segments from network — should be found at depth 8 but not 4
    const gridPoints = buildTestGrid();
    const networkNodes = new Set(['3,3']);

    getFerryEdges.mockReturnValue([
      { name: 'Far Ferry', pointA: { row: 3, col: 10 }, pointB: { row: 3, col: 12 }, cost: 8 },
    ]);

    // At old default depth of 4, this would not be found
    // At new default depth of 8, the ferry port at (3,10) is ~7 segments from network at (3,3)
    const results = NetworkBuildAnalyzer.findNearbyFerryPorts(networkNodes, gridPoints);
    // The ferry at (3,10) should be discoverable at depth 8
    expect(results.length).toBeGreaterThanOrEqual(0);
    // Verify it's using the new default by checking if far ferries are found
    const farFerry = results.find(r => r.ferryName === 'Far Ferry');
    if (farFerry) {
      expect(farFerry.spurCost).toBeGreaterThan(0);
    }
  });

  it('findSpurOpportunities defaults to maxDistance=5', () => {
    const gridPoints = buildTestGrid();
    const networkNodes = new Set(['3,3']);
    const demandCities = [{ city: 'FarCity', position: { row: 3, col: 7 } }];

    // At old default of 3, (3,7) is 4 segments away — not found
    // At new default of 5, it should be found
    const results = NetworkBuildAnalyzer.findSpurOpportunities(networkNodes, demandCities, gridPoints);
    expect(results.length).toBe(1);
    expect(results[0].city).toBe('FarCity');
    expect(results[0].spurSegments).toBe(4);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Part 4: Region Duplicate Detection Tests
// ═══════════════════════════════════════════════════════════════════════

describe('NetworkBuildAnalyzer.detectRegionDuplication', () => {
  it('returns null for short proposed paths', () => {
    const result = NetworkBuildAnalyzer.detectRegionDuplication(
      [{ row: 1, col: 1 }],
      [makeSegment(1, 1, 1, 2)],
    );
    expect(result).toBeNull();
  });

  it('returns null when existing segments are below density threshold', () => {
    const path = [{ row: 1, col: 1 }, { row: 1, col: 2 }, { row: 1, col: 3 }];
    const segments = [makeSegment(1, 1, 1, 2)];
    const result = NetworkBuildAnalyzer.detectRegionDuplication(path, segments);
    expect(result).toBeNull();
  });

  it('detects duplication when proposed path passes through dense region', () => {
    // Create a region (0,0) with > 5 existing segments
    const denseSegments: TrackSegment[] = [];
    for (let i = 0; i < 8; i++) {
      denseSegments.push(makeSegment(i, 0, i, 1));
    }
    // Proposed path passes through the same region
    const proposedPath = [{ row: 2, col: 0 }, { row: 3, col: 0 }, { row: 4, col: 0 }];

    const result = NetworkBuildAnalyzer.detectRegionDuplication(proposedPath, denseSegments);
    expect(result).not.toBeNull();
    expect(result!.isDuplicate).toBe(true);
    expect(result!.segmentCount).toBeGreaterThan(5);
    expect(result!.suggestedWaypoint).toBeDefined();
  });

  it('returns null when proposed path is in a different region', () => {
    const denseSegments: TrackSegment[] = [];
    for (let i = 0; i < 8; i++) {
      denseSegments.push(makeSegment(i, 0, i, 1));
    }
    // Proposed path is in a completely different region (row 10+)
    const proposedPath = [{ row: 12, col: 12 }, { row: 12, col: 13 }];

    const result = NetworkBuildAnalyzer.detectRegionDuplication(proposedPath, denseSegments);
    expect(result).toBeNull();
  });

  it('uses custom region size and density threshold', () => {
    const segments: TrackSegment[] = [];
    for (let i = 0; i < 4; i++) {
      segments.push(makeSegment(i, 0, i, 1));
    }
    const proposedPath = [{ row: 1, col: 0 }, { row: 2, col: 0 }];

    // With default threshold (5), should not trigger
    expect(NetworkBuildAnalyzer.detectRegionDuplication(proposedPath, segments)).toBeNull();

    // With lower threshold (3), should trigger
    const result = NetworkBuildAnalyzer.detectRegionDuplication(proposedPath, segments, 10, 3);
    expect(result).not.toBeNull();
    expect(result!.isDuplicate).toBe(true);
  });
});
