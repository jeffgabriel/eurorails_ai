/**
 * PathCostEstimator.test.ts
 *
 * Unit tests for the PathCostEstimator module (JIRA-230 R1) and the
 * computeAggregateScore (JIRA-237).
 *
 * Mocking strategy:
 * - Mock `estimateRouteSegment` from RouteDetourEstimator to control return
 *   values without invoking the real Dijkstra.
 * - Mock `loadGridPoints` to control city-name resolution.
 * - Mock `hexDistance` in DeterministicTripPlanner tests to control geometry.
 */

// ── Mocks ──────────────────────────────────────────────────────────────

// Mock RouteDetourEstimator — controls estimateRouteSegment
jest.mock('../../services/ai/RouteDetourEstimator', () => ({
  estimateRouteSegment: jest.fn(),
  simulateTrip: jest.fn(),
}));

// Mock MapTopology — controls city resolution and distance
const mockGrid = new Map<string, { row: number; col: number; terrain: number; name?: string }>();

jest.mock('../../services/ai/MapTopology', () => ({
  loadGridPoints: jest.fn(() => mockGrid),
  hexDistance: jest.fn((r1: number, c1: number, r2: number, c2: number): number => {
    // Simple Chebyshev-style for test determinism
    return Math.max(Math.abs(r2 - r1), Math.abs(c2 - c1));
  }),
}));

// ── Imports (after mocks) ──────────────────────────────────────────────

import { estimateRouteSegment, simulateTrip } from '../../services/ai/RouteDetourEstimator';
import {
  estimateGraphPathCost,
  clearPathCostCache,
  PathCost,
  GridCoord,
} from '../../services/ai/PathCostEstimator';
import { computeAggregateScore } from '../../services/ai/DeterministicTripPlanner';
import { WorldSnapshot, TrackSegment } from '../../../shared/types/GameTypes';

const mockEstimateRouteSegment = estimateRouteSegment as jest.MockedFunction<typeof estimateRouteSegment>;
const mockSimulateTrip = simulateTrip as jest.MockedFunction<typeof simulateTrip>;

// ── Helpers ────────────────────────────────────────────────────────────

/** Add a named city to the mock grid at the given coords */
function addCity(name: string, row: number, col: number): void {
  mockGrid.set(`${row},${col}`, { row, col, terrain: 0, name });
}

/** Minimal WorldSnapshot for tests */
function makeSnapshot(
  segments: Array<{ from: { row: number; col: number }; to: { row: number; col: number } }> = [],
  position?: { row: number; col: number },
): WorldSnapshot {
  return {
    gameId: 'test-game',
    gameStatus: 'active',
    turnNumber: 1,
    bot: {
      playerId: 'bot-1',
      userId: 'user-1',
      money: 100,
      position: position ?? { row: 5, col: 5 },
      existingSegments: segments as WorldSnapshot['bot']['existingSegments'],
      demandCards: [],
      resolvedDemands: [],
      trainType: 'freight',
      loads: [],
      botConfig: { skillLevel: 'medium' },
      connectedMajorCityCount: 0,
    },
    allPlayerTracks: [],
    loadAvailability: {},
  };
}

/** Build a minimal RouteSegmentEstimate return value */
function makeSegmentEstimate(opts: {
  reachable: boolean;
  buildCost?: number;
  pathLength?: number;
}): ReturnType<typeof estimateRouteSegment> {
  return {
    newSegments: [],
    buildCost: opts.reachable ? (opts.buildCost ?? 0) : 0,
    pathLength: opts.reachable ? (opts.pathLength ?? 5) : 0,
    reachable: opts.reachable,
  };
}

/** Build a minimal ScoredCandidate for computeAggregateScore tests */
function makeScoredCandidate(opts: {
  id: string;
  cardIndices: number[];
  startCity: string;
  endCity: string;
  turns: number;
  net: number;
  payout?: number;
}) {
  const stops = [
    { action: 'pickup' as const, city: opts.startCity, loadType: 'Coal' },
    { action: 'deliver' as const, city: opts.endCity, loadType: 'Coal' },
  ];
  return {
    id: opts.id,
    rows: opts.cardIndices.map((ci) => ({
      cardIndex: ci,
      loadType: 'Coal',
      supplyCity: opts.startCity,
      deliveryCity: opts.endCity,
      payout: opts.payout ?? 20,
      isCarry: false,
    })),
    stops,
    payout: opts.payout ?? 20,
    buildCost: 0,
    turns: opts.turns,
    net: opts.net,
    score: opts.net - 4 * opts.turns,
    feasible: true,
    aggregateScore: opts.net / Math.max(opts.turns, 1),
    aggregateFollowup: null,
    aggregateEmptyLegTurns: 0,
    // JIRA-237: builtSegments required on ScoredCandidate; empty array for test fixtures
    builtSegments: [] as TrackSegment[],
  };
}

// ── Setup ──────────────────────────────────────────────────────────────

beforeEach(() => {
  jest.clearAllMocks();
  mockGrid.clear();
  clearPathCostCache();

  // Default cities
  addCity('CityA', 3, 3);
  addCity('CityB', 7, 7);
  addCity('CityC', 10, 10);
  addCity('CityD', 1, 1);
});

// ── PathCostEstimator tests (JIRA-230 R1) ─────────────────────────────

describe('estimateGraphPathCost', () => {
  // ── AC3: Fully-existing path → buildCost: 0 ─────────────────────────

  it('AC3: fully-existing path returns buildCost: 0 and actual graph pathLength', () => {
    // pathLength=8 via existing track (detoured around water/mountains)
    mockEstimateRouteSegment.mockReturnValue(makeSegmentEstimate({ reachable: true, buildCost: 0, pathLength: 8 }));

    const snapshot = makeSnapshot([
      { from: { row: 3, col: 3 }, to: { row: 4, col: 4 } },
      { from: { row: 4, col: 4 }, to: { row: 7, col: 7 } },
    ]);

    const result = estimateGraphPathCost('CityA', 'CityB', snapshot, 9);

    expect(result.reachable).toBe(true);
    expect(result.buildCost).toBe(0);
    expect(result.pathLength).toBe(8);
    // estimatedTurns = ceil(8/9) = 1
    expect(result.estimatedTurns).toBe(1);
  });

  it('AC3: pathLength does NOT equal raw hex distance when existing track detours', () => {
    // pathLength=12 (detoured), not raw Chebyshev distance of 4 between (3,3)→(7,7)
    mockEstimateRouteSegment.mockReturnValue(makeSegmentEstimate({ reachable: true, buildCost: 0, pathLength: 12 }));

    const result = estimateGraphPathCost('CityA', 'CityB', makeSnapshot(), 9);

    expect(result.pathLength).toBe(12);
    // Chebyshev distance between (3,3) and (7,7) = max(4,4) = 4
    expect(result.pathLength).not.toBe(4);
  });

  // ── AC4: One new mountain segment → buildCost: 2 ─────────────────────

  it('AC4: path with one new mountain segment returns buildCost: 2', () => {
    mockEstimateRouteSegment.mockReturnValue(makeSegmentEstimate({ reachable: true, buildCost: 2, pathLength: 6 }));

    const result = estimateGraphPathCost('CityA', 'CityB', makeSnapshot(), 9);

    expect(result.reachable).toBe(true);
    expect(result.buildCost).toBe(2);
    expect(result.pathLength).toBe(6);
    // estimatedTurns = ceil(6/9) = 1
    expect(result.estimatedTurns).toBe(1);
  });

  it('AC4: estimatedTurns uses ceil division correctly (10 mileposts / speed=9 → 2 turns)', () => {
    mockEstimateRouteSegment.mockReturnValue(makeSegmentEstimate({ reachable: true, buildCost: 2, pathLength: 10 }));

    const result = estimateGraphPathCost('CityA', 'CityB', makeSnapshot(), 9);

    expect(result.estimatedTurns).toBe(2);
  });

  // ── AC5: Blocked by opponent → reachable: false ───────────────────────

  it('AC5: blocked by opponent edges returns reachable: false without throwing', () => {
    mockEstimateRouteSegment.mockReturnValue(makeSegmentEstimate({ reachable: false }));

    let result: PathCost | undefined;
    expect(() => {
      result = estimateGraphPathCost('CityA', 'CityB', makeSnapshot(), 12);
    }).not.toThrow();

    expect(result!.reachable).toBe(false);
    expect(result!.buildCost).toBe(0);
    expect(result!.pathLength).toBe(0);
    expect(result!.estimatedTurns).toBe(0);
  });

  // ── Unresolvable city ─────────────────────────────────────────────────

  it('returns reachable: false when fromCity is not in the grid', () => {
    let result: PathCost | undefined;
    expect(() => {
      result = estimateGraphPathCost('UnknownCity', 'CityB', makeSnapshot(), 9);
    }).not.toThrow();

    expect(result!.reachable).toBe(false);
    expect(result!.buildCost).toBe(0);
    expect(result!.pathLength).toBe(0);
    expect(result!.estimatedTurns).toBe(0);
    // estimateRouteSegment must NOT be called when city unresolvable
    expect(mockEstimateRouteSegment).not.toHaveBeenCalled();
  });

  it('returns reachable: false when toCity is not in the grid', () => {
    const result = estimateGraphPathCost('CityA', 'UnknownDestination', makeSnapshot(), 9);
    expect(result.reachable).toBe(false);
    expect(mockEstimateRouteSegment).not.toHaveBeenCalled();
  });

  // ── AC1-cache: Caching ────────────────────────────────────────────────

  it('AC1-cache: two consecutive calls with same args call estimateRouteSegment exactly once', () => {
    mockEstimateRouteSegment.mockReturnValue(makeSegmentEstimate({ reachable: true, buildCost: 0, pathLength: 5 }));

    const snapshot = makeSnapshot();
    const r1 = estimateGraphPathCost('CityA', 'CityB', snapshot, 9);
    const r2 = estimateGraphPathCost('CityA', 'CityB', snapshot, 9);

    expect(mockEstimateRouteSegment).toHaveBeenCalledTimes(1);
    expect(r1).toEqual(r2);
  });

  it('AC1-cache: different speed bypasses cache and calls estimateRouteSegment again', () => {
    mockEstimateRouteSegment.mockReturnValue(makeSegmentEstimate({ reachable: true, buildCost: 0, pathLength: 5 }));

    const snapshot = makeSnapshot();
    estimateGraphPathCost('CityA', 'CityB', snapshot, 9);
    estimateGraphPathCost('CityA', 'CityB', snapshot, 12);

    expect(mockEstimateRouteSegment).toHaveBeenCalledTimes(2);
  });

  it('AC1-cache: different segments hash bypasses cache', () => {
    mockEstimateRouteSegment.mockReturnValue(makeSegmentEstimate({ reachable: true, buildCost: 0, pathLength: 5 }));

    const snapshot1 = makeSnapshot([]);
    const snapshot2 = makeSnapshot([{ from: { row: 1, col: 1 }, to: { row: 2, col: 2 } }]);

    estimateGraphPathCost('CityA', 'CityB', snapshot1, 9);
    estimateGraphPathCost('CityA', 'CityB', snapshot2, 9);

    expect(mockEstimateRouteSegment).toHaveBeenCalledTimes(2);
  });

  it('clearPathCostCache resets cache so next call invokes estimateRouteSegment again', () => {
    mockEstimateRouteSegment.mockReturnValue(makeSegmentEstimate({ reachable: true, buildCost: 0, pathLength: 5 }));

    const snapshot = makeSnapshot();
    estimateGraphPathCost('CityA', 'CityB', snapshot, 9);
    clearPathCostCache();
    estimateGraphPathCost('CityA', 'CityB', snapshot, 9);

    expect(mockEstimateRouteSegment).toHaveBeenCalledTimes(2);
  });

  // ── Multi-coordinate city (major city outposts) ───────────────────────

  it('for major cities with multiple coords, picks the pair with shortest pathLength', () => {
    // CityA has two outposts (row=3,col=3 from beforeEach, plus a new one)
    addCity('CityA', 3, 4); // second outpost

    // First coord pair → pathLength=10, second → pathLength=6
    mockEstimateRouteSegment
      .mockReturnValueOnce(makeSegmentEstimate({ reachable: true, buildCost: 0, pathLength: 10 }))
      .mockReturnValueOnce(makeSegmentEstimate({ reachable: true, buildCost: 0, pathLength: 6 }));

    const result = estimateGraphPathCost('CityA', 'CityB', makeSnapshot(), 9);

    // Picks shorter path
    expect(result.pathLength).toBe(6);
    expect(mockEstimateRouteSegment).toHaveBeenCalledTimes(2);
  });

  it('for major city where one outpost is blocked, uses the reachable outpost', () => {
    addCity('CityA', 3, 4); // second outpost

    // First pair: blocked; second pair: reachable
    mockEstimateRouteSegment
      .mockReturnValueOnce(makeSegmentEstimate({ reachable: false }))
      .mockReturnValueOnce(makeSegmentEstimate({ reachable: true, buildCost: 3, pathLength: 8 }));

    const result = estimateGraphPathCost('CityA', 'CityB', makeSnapshot(), 9);

    expect(result.reachable).toBe(true);
    expect(result.pathLength).toBe(8);
    expect(result.buildCost).toBe(3);
  });

  // ── estimatedTurns edge cases ─────────────────────────────────────────

  it('estimatedTurns is ceil(pathLength / trainSpeed)', () => {
    mockEstimateRouteSegment.mockReturnValue(makeSegmentEstimate({ reachable: true, buildCost: 0, pathLength: 25 }));

    const result = estimateGraphPathCost('CityA', 'CityB', makeSnapshot(), 12);

    // ceil(25/12) = 3
    expect(result.estimatedTurns).toBe(3);
  });

  it('guards against trainSpeed=0 by using max(speed,1)', () => {
    mockEstimateRouteSegment.mockReturnValue(makeSegmentEstimate({ reachable: true, buildCost: 0, pathLength: 5 }));

    let result: PathCost;
    expect(() => {
      result = estimateGraphPathCost('CityA', 'CityB', makeSnapshot(), 0);
    }).not.toThrow();

    // ceil(5/1) = 5
    expect(result!.estimatedTurns).toBe(5);
  });

  // ── BE-001: GridCoord input tests ─────────────────────────────────────

  it('BE-001: accepts GridCoord for from (skips city name resolution)', () => {
    mockEstimateRouteSegment.mockReturnValue(makeSegmentEstimate({ reachable: true, buildCost: 5, pathLength: 7 }));

    const fromCoord: GridCoord = { row: 5, col: 5 };
    const result = estimateGraphPathCost(fromCoord, 'CityB', makeSnapshot(), 9);

    expect(result.reachable).toBe(true);
    expect(result.buildCost).toBe(5);
    expect(result.pathLength).toBe(7);
    // estimateRouteSegment should be called with the coord directly (not via grid resolution)
    expect(mockEstimateRouteSegment).toHaveBeenCalledTimes(1);
    const callArgs = mockEstimateRouteSegment.mock.calls[0];
    expect(callArgs[0]).toEqual({ row: 5, col: 5 });
  });

  it('BE-001: accepts GridCoord for to (skips city name resolution)', () => {
    mockEstimateRouteSegment.mockReturnValue(makeSegmentEstimate({ reachable: true, buildCost: 3, pathLength: 6 }));

    const toCoord: GridCoord = { row: 10, col: 10 };
    const result = estimateGraphPathCost('CityA', toCoord, makeSnapshot(), 9);

    expect(result.reachable).toBe(true);
    expect(result.buildCost).toBe(3);
    const callArgs = mockEstimateRouteSegment.mock.calls[0];
    expect(callArgs[1]).toEqual({ row: 10, col: 10 });
  });

  it('BE-001: accepts GridCoord for both from and to', () => {
    mockEstimateRouteSegment.mockReturnValue(makeSegmentEstimate({ reachable: true, buildCost: 0, pathLength: 4 }));

    const fromCoord: GridCoord = { row: 3, col: 3 };
    const toCoord: GridCoord = { row: 7, col: 7 };
    const result = estimateGraphPathCost(fromCoord, toCoord, makeSnapshot(), 9);

    expect(result.reachable).toBe(true);
    expect(result.estimatedTurns).toBe(1); // ceil(4/9)=1
    // Called once with the exact coords
    expect(mockEstimateRouteSegment).toHaveBeenCalledTimes(1);
    expect(mockEstimateRouteSegment.mock.calls[0][0]).toEqual({ row: 3, col: 3 });
    expect(mockEstimateRouteSegment.mock.calls[0][1]).toEqual({ row: 7, col: 7 });
  });

  it('BE-001: GridCoord input caches correctly — second identical call uses cache', () => {
    mockEstimateRouteSegment.mockReturnValue(makeSegmentEstimate({ reachable: true, buildCost: 0, pathLength: 5 }));

    const fromCoord: GridCoord = { row: 3, col: 3 };
    const snapshot = makeSnapshot();
    estimateGraphPathCost(fromCoord, 'CityB', snapshot, 9);
    estimateGraphPathCost(fromCoord, 'CityB', snapshot, 9);

    // Cache hit: estimateRouteSegment only called once
    expect(mockEstimateRouteSegment).toHaveBeenCalledTimes(1);
  });

  it('BE-001: GridCoord same-point returns trivial result without calling estimateRouteSegment', () => {
    const coord: GridCoord = { row: 5, col: 5 };
    const result = estimateGraphPathCost(coord, coord, makeSnapshot(), 9);

    expect(result.reachable).toBe(true);
    expect(result.buildCost).toBe(0);
    expect(result.pathLength).toBe(1);
    expect(result.estimatedTurns).toBe(1);
    expect(mockEstimateRouteSegment).not.toHaveBeenCalled();
  });

  // JIRA-238: PathCost.newSegments must surface the segments findBuildPath would
  // construct, so callers (DemandEngine.computeBestDemandContext, cheapPrune)
  // can compose snapshots between sequential leg calculations and avoid the
  // leg-independence build-cost double-count.
  it('JIRA-238: newSegments populated on reachable result, matches estimateRouteSegment.newSegments', () => {
    addCity('A', 1, 1);
    addCity('B', 4, 4);
    const built: TrackSegment[] = [
      { from: { row: 1, col: 1, terrain: 0 }, to: { row: 2, col: 2, terrain: 0 } },
      { from: { row: 2, col: 2, terrain: 0 }, to: { row: 3, col: 3, terrain: 0 } },
      { from: { row: 3, col: 3, terrain: 0 }, to: { row: 4, col: 4, terrain: 0 } },
    ];
    mockEstimateRouteSegment.mockReturnValue({
      newSegments: built,
      buildCost: 6,
      pathLength: 4,
      reachable: true,
    });

    const result = estimateGraphPathCost('A', 'B', makeSnapshot(), 9);
    expect(result.reachable).toBe(true);
    expect(result.newSegments).toEqual(built);
  });

  it('JIRA-238: newSegments is empty array for trivial same-point result', () => {
    const coord: GridCoord = { row: 5, col: 5 };
    const result = estimateGraphPathCost(coord, coord, makeSnapshot(), 9);
    expect(result.newSegments).toEqual([]);
  });
});


// ── computeAggregateScore — JIRA-237 chained re-simulation (Defect 1) ──────
//
// When snapshot is provided, computeAggregateScore re-simulates c2 starting
// from c1.endCity against a post-c1 network (bot.network ∪ c1.builtSegments).
// This replaces the JIRA-230 emptyLeg+botToStart approximation with a full
// structural re-simulation that captures all network sharing.

describe('computeAggregateScore — JIRA-237 chained re-simulation (Defect 1)', () => {
  beforeEach(() => {
    addCity('SupplyA', 3, 3);
    addCity('DeliveryA', 7, 7);
    addCity('SupplyC', 10, 10);
    addCity('DeliveryC', 1, 1);
  });

  it('AC6: when snapshot provided, c2 is re-simulated via simulateTrip from c1.endCity (JIRA-237 R3)', () => {
    // When snapshot is passed to computeAggregateScore, it must call simulateTrip
    // for each disjoint c2 candidate.
    const botPos = { row: 5, col: 5 };

    const c1 = makeScoredCandidate({
      id: 'c1',
      cardIndices: [1],
      startCity: 'SupplyA',
      endCity: 'DeliveryA',
      turns: 3,
      net: 20,
      payout: 25,
    });
    c1.builtSegments = []; // no shared segments

    const c2 = makeScoredCandidate({
      id: 'c2',
      cardIndices: [2],
      startCity: 'SupplyC',
      endCity: 'DeliveryC',
      turns: 4,
      net: 18,
      payout: 22,
    });

    const cityToCoords = new Map([
      ['SupplyA', [{ row: 3, col: 3 }]],
      ['DeliveryA', [{ row: 7, col: 7 }]],
      ['SupplyC', [{ row: 10, col: 10 }]],
      ['DeliveryC', [{ row: 1, col: 1 }]],
    ]);

    // Mock simulateTrip to return a feasible result for the chained c2
    mockSimulateTrip.mockReturnValue({
      turnsToComplete: 4,
      totalBuildCost: 5,
      feasible: true,
      minCashRelative: -5,
      finalCashRelative: 17,
      builtSegments: [],
    });

    const snapshot = makeSnapshot([], botPos);
    computeAggregateScore(c1, [c1, c2], cityToCoords, snapshot);

    // simulateTrip should have been called at least once (for the c2 chained re-sim)
    expect(mockSimulateTrip).toHaveBeenCalled();
    // The call should use c1.endCoords as startPos (DeliveryA = row:7, col:7)
    const callArgs = mockSimulateTrip.mock.calls[0];
    expect(callArgs[0]).toEqual({ row: 7, col: 7 }); // c1.endCoords = DeliveryA
    expect(callArgs[1]).toBe(c2.stops); // c2's stops
  });

  it('AC8: aggregate = (c1.net + c2_chained.net) / (c1.turns + c2_chained.turnsToComplete) (JIRA-237 R4)', () => {
    // With chained re-simulation:
    //   c1.net = 20, c1.turns = 3
    //   c2.payout = 22, c2_chained.totalBuildCost = 5, c2_chained.turnsToComplete = 4
    //   c2_chained.net = 22 - 5 = 17
    //   aggregate = (20 + 17) / (3 + 4) = 37 / 7 ≈ 5.286
    const botPos = { row: 5, col: 5 };

    const c1 = makeScoredCandidate({
      id: 'c1',
      cardIndices: [1],
      startCity: 'SupplyA',
      endCity: 'DeliveryA',
      turns: 3,
      net: 20,
      payout: 25,
    });
    c1.builtSegments = [];

    const c2 = makeScoredCandidate({
      id: 'c2',
      cardIndices: [2],
      startCity: 'SupplyC',
      endCity: 'DeliveryC',
      turns: 4,
      net: 18,
      payout: 22,
    });

    const cityToCoords = new Map([
      ['SupplyA', [{ row: 3, col: 3 }]],
      ['DeliveryA', [{ row: 7, col: 7 }]],
      ['SupplyC', [{ row: 10, col: 10 }]],
      ['DeliveryC', [{ row: 1, col: 1 }]],
    ]);

    // c2_chained: 4 turns, 5M build, payout=22 → chained net=17
    mockSimulateTrip.mockReturnValue({
      turnsToComplete: 4,
      totalBuildCost: 5,
      feasible: true,
      minCashRelative: -5,
      finalCashRelative: 17,
      builtSegments: [],
    });

    const snapshot = makeSnapshot([], botPos);
    const result = computeAggregateScore(c1, [c1, c2], cityToCoords, snapshot);

    // JIRA-237 R4: aggregate = (c1.net + c2_chained.net) / (c1.turns + c2_chained.turnsToComplete)
    //   = (20 + (22 - 5)) / (3 + 4) = 37 / 7
    expect(result.aggregate).toBeCloseTo(37 / 7, 4);
    expect(result.followup).toBe(c2);
    // JIRA-237: emptyLegTurns is 0 when chained sim is active (absorbed into turns)
    expect(result.emptyLegTurns).toBe(0);
  });

  it('AC9: all c2 infeasible against post-c1 network → returns c1 standalone velocity (JIRA-237 R5)', () => {
    // When simulateTrip returns feasible:false for every c2, fallback to c1 standalone.
    const botPos = { row: 5, col: 5 };

    const c1 = makeScoredCandidate({
      id: 'c1',
      cardIndices: [1],
      startCity: 'SupplyA',
      endCity: 'DeliveryA',
      turns: 4,
      net: 20,
      payout: 25,
    });
    c1.builtSegments = [];

    const c2 = makeScoredCandidate({
      id: 'c2',
      cardIndices: [2],
      startCity: 'SupplyC',
      endCity: 'DeliveryC',
      turns: 5,
      net: 18,
      payout: 22,
    });

    const cityToCoords = new Map([
      ['SupplyA', [{ row: 3, col: 3 }]],
      ['DeliveryA', [{ row: 7, col: 7 }]],
      ['SupplyC', [{ row: 10, col: 10 }]],
      ['DeliveryC', [{ row: 1, col: 1 }]],
    ]);

    // All c2 chained simulations are infeasible
    mockSimulateTrip.mockReturnValue({
      turnsToComplete: 0,
      totalBuildCost: 0,
      feasible: false,
      minCashRelative: 0,
      finalCashRelative: 0,
      builtSegments: [],
    });

    const snapshot = makeSnapshot([], botPos);
    const result = computeAggregateScore(c1, [c1, c2], cityToCoords, snapshot);

    // R5 / endgame fallback: no feasible follow-up → standalone velocity
    expect(result.aggregate).toBeCloseTo(20 / 4, 6); // c1.net / c1.turns = 5
    expect(result.followup).toBeNull();
    expect(result.emptyLegTurns).toBe(0);
  });

});
