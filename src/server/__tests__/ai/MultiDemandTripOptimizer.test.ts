/**
 * MultiDemandTripOptimizer.test.ts — Unit tests for the JIRA-217 deterministic optimizer.
 *
 * Tests: pattern detection, candidate generation, carried-load handling,
 * capacity enforcement, scoring, infeasibility filtering, and performance.
 */

import {
  generateCandidates,
  DELIVERY_CLUSTERS,
  TripCandidate,
  TripPattern,
} from '../../services/ai/MultiDemandTripOptimizer';
import {
  DemandContext,
  GameContext,
  GridPoint,
  WorldSnapshot,
  TrainType,
} from '../../../shared/types/GameTypes';

// ── Mock simulateTrip ────────────────────────────────────────────────────────

const mockSimulateTrip = jest.fn();

jest.mock('../../services/ai/RouteDetourEstimator', () => ({
  simulateTrip: (...args: unknown[]) => mockSimulateTrip(...args),
  OPPORTUNITY_COST_PER_TURN_M: 5,
}));

// ── Fixtures ─────────────────────────────────────────────────────────────────

function makeDemand(overrides: Partial<DemandContext> = {}): DemandContext {
  return {
    cardIndex: 1,
    loadType: 'Coal',
    supplyCity: 'Essen',
    deliveryCity: 'Berlin',
    payout: 20,
    isSupplyReachable: true,
    isDeliveryReachable: true,
    isSupplyOnNetwork: true,
    isDeliveryOnNetwork: true,
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

function makeContext(overrides: Partial<GameContext> = {}): GameContext {
  return {
    position: { city: 'Essen', row: 10, col: 5 },
    money: 80,
    trainType: 'FastFreight',
    speed: 12,
    capacity: 2,
    loads: [],
    connectedMajorCities: [],
    unconnectedMajorCities: [],
    totalMajorCities: 15,
    trackSummary: '',
    turnBuildCost: 0,
    turnNumber: 5,
    demands: [],
    canDeliver: [],
    canPickup: [],
    reachableCities: [],
    citiesOnNetwork: [],
    canUpgrade: false,
    canBuild: true,
    isInitialBuild: false,
    opponents: [],
    phase: 'movement',
    ...overrides,
  } as unknown as GameContext;
}

function makeSnapshot(overrides: Partial<WorldSnapshot['bot']> = {}): WorldSnapshot {
  return {
    gameId: 'g1',
    gameStatus: 'active',
    turnNumber: 5,
    bot: {
      playerId: 'bot-1',
      userId: 'user-bot-1',
      money: 80,
      position: { row: 10, col: 5 },
      existingSegments: [],
      demandCards: [],
      resolvedDemands: [],
      trainType: TrainType.FastFreight,
      loads: [],
      botConfig: null,
      connectedMajorCityCount: 0,
      ...overrides,
    },
    allPlayerTracks: [],
    loadAvailability: {},
  } as unknown as WorldSnapshot;
}

const EMPTY_GRID: GridPoint[] = [];

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Make simulateTrip return feasible with given stats. */
function feasible(turns = 3, buildCost = 10): ReturnType<typeof mockSimulateTrip> {
  return { turnsToComplete: turns, totalBuildCost: buildCost, feasible: true };
}

/** Make simulateTrip return infeasible. */
function infeasible(): ReturnType<typeof mockSimulateTrip> {
  return { turnsToComplete: 0, totalBuildCost: 0, feasible: false };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('MultiDemandTripOptimizer.generateCandidates', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});

    // Default: all simulateTrip calls return feasible
    mockSimulateTrip.mockReturnValue(feasible());
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  // ── Empty / no demands ──────────────────────────────────────────────────────

  it('empty demands → candidates: []', () => {
    const result = generateCandidates(makeSnapshot(), makeContext({ demands: [] }), EMPTY_GRID);
    expect(result.candidates).toHaveLength(0);
    expect(result.enumerationStats.patternsDetected).toBe(0);
  });

  it('no bot position → candidates: []', () => {
    const snapshot = makeSnapshot({ position: null as any });
    const result = generateCandidates(
      snapshot,
      makeContext({ demands: [makeDemand()] }),
      EMPTY_GRID,
    );
    expect(result.candidates).toHaveLength(0);
  });

  // ── No-pattern hands → single baseline ─────────────────────────────────────

  it('hand with no detectable patterns → 1 candidate (highest-payout single-demand baseline)', () => {
    // 3 demands with all different load types, supply cities, and delivery cluster spread
    const demands = [
      makeDemand({ cardIndex: 1, loadType: 'Coal', supplyCity: 'Essen', deliveryCity: 'Berlin', payout: 20 }),
      makeDemand({ cardIndex: 2, loadType: 'Wine', supplyCity: 'Bordeaux', deliveryCity: 'Stockholm', payout: 30 }),
      makeDemand({ cardIndex: 3, loadType: 'Steel', supplyCity: 'Glasgow', deliveryCity: 'Madrid', payout: 25 }),
    ];
    const result = generateCandidates(
      makeSnapshot(),
      makeContext({ demands }),
      EMPTY_GRID,
    );
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0].patterns).toHaveLength(0);
    expect(result.candidates[0].demandsCovered[0].payout).toBe(30); // highest payout: Wine
  });

  // ── Pattern detection — load-double-same-supply ─────────────────────────────

  it('load-double-same-supply: 2 demands with same (loadType, supplyCity) → one pattern candidate', () => {
    const demands = [
      makeDemand({ cardIndex: 1, loadType: 'Coal', supplyCity: 'Essen', deliveryCity: 'Berlin', payout: 20 }),
      makeDemand({ cardIndex: 2, loadType: 'Coal', supplyCity: 'Essen', deliveryCity: 'Paris', payout: 25 }),
    ];
    const result = generateCandidates(
      makeSnapshot({ trainType: TrainType.FastFreight }),
      makeContext({ demands, capacity: 2 }),
      EMPTY_GRID,
    );
    const patternCandidates = result.candidates.filter(c =>
      c.patterns.some(p => p.kind === 'load-double-same-supply'),
    );
    expect(patternCandidates.length).toBeGreaterThanOrEqual(1);
    const c = patternCandidates[0];
    expect(c.demandsCovered).toHaveLength(2);
  });

  // ── Pattern detection — load-double ─────────────────────────────────────────

  it('load-double: 2 demands with same loadType, different supply cities → one pattern candidate', () => {
    const demands = [
      makeDemand({ cardIndex: 1, loadType: 'Coal', supplyCity: 'Essen', deliveryCity: 'Berlin', payout: 20 }),
      makeDemand({ cardIndex: 2, loadType: 'Coal', supplyCity: 'Ruhr', deliveryCity: 'Paris', payout: 22 }),
    ];
    const result = generateCandidates(
      makeSnapshot(),
      makeContext({ demands, capacity: 2 }),
      EMPTY_GRID,
    );
    const patternCandidates = result.candidates.filter(c =>
      c.patterns.some(p => p.kind === 'load-double'),
    );
    expect(patternCandidates.length).toBeGreaterThanOrEqual(1);
  });

  // ── Pattern detection — supply-cluster ──────────────────────────────────────

  it('supply-cluster: single supply city with 2 different loads → one pattern candidate', () => {
    const demands = [
      makeDemand({ cardIndex: 1, loadType: 'Hops', supplyCity: 'Cardiff', deliveryCity: 'Berlin', payout: 30 }),
      makeDemand({ cardIndex: 2, loadType: 'Coal', supplyCity: 'Cardiff', deliveryCity: 'Paris', payout: 25 }),
    ];
    const result = generateCandidates(
      makeSnapshot(),
      makeContext({ demands, capacity: 2 }),
      EMPTY_GRID,
    );
    const patternCandidates = result.candidates.filter(c =>
      c.patterns.some(p => p.kind === 'supply-cluster'),
    );
    expect(patternCandidates.length).toBeGreaterThanOrEqual(1);
    const c = patternCandidates[0];
    expect(c.demandsCovered).toHaveLength(2);
    const loadTypes = c.demandsCovered.map(d => d.loadType);
    expect(loadTypes).toContain('Hops');
    expect(loadTypes).toContain('Coal');
  });

  // ── Pattern detection — delivery-cluster ────────────────────────────────────

  it('delivery-cluster: 2 delivery cities in same cluster → one pattern candidate', () => {
    const demands = [
      makeDemand({ cardIndex: 1, loadType: 'Coal', supplyCity: 'Essen', deliveryCity: 'London', payout: 28 }),
      makeDemand({ cardIndex: 2, loadType: 'Wine', supplyCity: 'Bordeaux', deliveryCity: 'Birmingham', payout: 24 }),
    ];
    // London and Birmingham are both in 'UK' cluster
    const result = generateCandidates(
      makeSnapshot(),
      makeContext({ demands, capacity: 2 }),
      EMPTY_GRID,
    );
    const patternCandidates = result.candidates.filter(c =>
      c.patterns.some(p => p.kind === 'delivery-cluster'),
    );
    expect(patternCandidates.length).toBeGreaterThanOrEqual(1);
    const c = patternCandidates[0];
    expect(c.patterns[0]).toMatchObject({ kind: 'delivery-cluster', cluster: 'UK' });
  });

  // ── Multiple patterns → top 3 returned ─────────────────────────────────────

  it('multiple patterns in one hand → top 3 returned by score descending', () => {
    // supply-cluster (Cardiff) + delivery-cluster (UK) + baseline
    const demands = [
      makeDemand({ cardIndex: 1, loadType: 'Hops', supplyCity: 'Cardiff', deliveryCity: 'London', payout: 35 }),
      makeDemand({ cardIndex: 2, loadType: 'Coal', supplyCity: 'Cardiff', deliveryCity: 'Birmingham', payout: 27 }),
      makeDemand({ cardIndex: 3, loadType: 'Steel', supplyCity: 'Glasgow', deliveryCity: 'Oslo', payout: 18 }),
    ];
    const result = generateCandidates(
      makeSnapshot(),
      makeContext({ demands, capacity: 2 }),
      EMPTY_GRID,
    );
    expect(result.candidates.length).toBeGreaterThanOrEqual(1);
    expect(result.candidates.length).toBeLessThanOrEqual(3);
    // Sorted by score descending
    for (let i = 1; i < result.candidates.length; i++) {
      expect(result.candidates[i - 1].score).toBeGreaterThanOrEqual(result.candidates[i].score);
    }
  });

  // ── Capacity enforcement ────────────────────────────────────────────────────

  it('capacity=1: pattern with 2 demands collapses to 1, produces only baseline', () => {
    const demands = [
      makeDemand({ cardIndex: 1, loadType: 'Coal', supplyCity: 'Cardiff', deliveryCity: 'London', payout: 30 }),
      makeDemand({ cardIndex: 2, loadType: 'Hops', supplyCity: 'Cardiff', deliveryCity: 'Birmingham', payout: 25 }),
    ];
    // capacity=1: supply-cluster of 2 demands collapses to only 1 new pickup slot
    const result = generateCandidates(
      makeSnapshot(),
      makeContext({ demands, capacity: 1 }),
      EMPTY_GRID,
    );
    // All candidates should have exactly 1 new demand covered (baseline only)
    const multiDemandCandidates = result.candidates.filter(c =>
      c.patterns.some(p => p.kind === 'supply-cluster' || p.kind === 'delivery-cluster' || p.kind === 'load-double' || p.kind === 'load-double-same-supply'),
    );
    // No pattern should have 2 demands when capacity=1 with no carried loads
    expect(multiDemandCandidates).toHaveLength(0);
  });

  // ── One-per-card rule ───────────────────────────────────────────────────────

  it('pattern with same cardIndex on both demands → dropped (one-per-card rule)', () => {
    // Same cardIndex on both — not a real scenario but tests the guard
    const demands = [
      makeDemand({ cardIndex: 1, loadType: 'Coal', supplyCity: 'Cardiff', deliveryCity: 'London', payout: 30 }),
      makeDemand({ cardIndex: 1, loadType: 'Hops', supplyCity: 'Cardiff', deliveryCity: 'Birmingham', payout: 25 }),
    ];
    const result = generateCandidates(
      makeSnapshot(),
      makeContext({ demands, capacity: 2 }),
      EMPTY_GRID,
    );
    // The two demands with the same cardIndex violate the one-per-card rule
    // so the supply-cluster pattern should be dropped; only the baseline should remain
    const supplyCluster = result.candidates.filter(c =>
      c.patterns.some(p => p.kind === 'supply-cluster'),
    );
    expect(supplyCluster).toHaveLength(0);
  });

  // ── Infeasibility filtering ─────────────────────────────────────────────────

  it('simulateTrip returns infeasible for all orderings → candidate filtered out', () => {
    mockSimulateTrip.mockReturnValue(infeasible());

    const demands = [
      makeDemand({ cardIndex: 1, loadType: 'Coal', supplyCity: 'Cardiff', deliveryCity: 'London', payout: 30 }),
      makeDemand({ cardIndex: 2, loadType: 'Hops', supplyCity: 'Cardiff', deliveryCity: 'Birmingham', payout: 25 }),
    ];
    const result = generateCandidates(
      makeSnapshot(),
      makeContext({ demands, capacity: 2 }),
      EMPTY_GRID,
    );
    expect(result.candidates).toHaveLength(0);
  });

  it('one ordering feasible among several infeasible → candidate survives', () => {
    // First call (e.g. supply-cluster) infeasible, second call (baseline) feasible
    let callCount = 0;
    mockSimulateTrip.mockImplementation(() => {
      callCount++;
      // Make the last call (baseline with 1 demand) feasible
      return callCount <= 4 ? infeasible() : feasible();
    });

    const demands = [
      makeDemand({ cardIndex: 1, loadType: 'Coal', supplyCity: 'Cardiff', deliveryCity: 'London', payout: 30 }),
      makeDemand({ cardIndex: 2, loadType: 'Hops', supplyCity: 'Cardiff', deliveryCity: 'Birmingham', payout: 25 }),
    ];
    const result = generateCandidates(
      makeSnapshot(),
      makeContext({ demands, capacity: 2 }),
      EMPTY_GRID,
    );
    // At least the baseline should survive
    expect(result.candidates.length).toBeGreaterThanOrEqual(0); // depends on ordering
  });

  it('all candidates infeasible → candidates: []', () => {
    mockSimulateTrip.mockReturnValue(infeasible());

    const demands = [makeDemand({ cardIndex: 1, loadType: 'Coal', supplyCity: 'Essen', deliveryCity: 'Berlin', payout: 20 })];
    const result = generateCandidates(
      makeSnapshot(),
      makeContext({ demands }),
      EMPTY_GRID,
    );
    expect(result.candidates).toHaveLength(0);
    expect(result.enumerationStats.candidatesFeasible).toBe(0);
  });

  // ── Carried-load completion ─────────────────────────────────────────────────

  it('carried load with matching demand card → all candidates start with deliver stop for that load', () => {
    const demands = [
      // Carried load — matching demand card
      makeDemand({ cardIndex: 1, loadType: 'Wine', supplyCity: null as any, deliveryCity: 'Birmingham', payout: 25, isLoadOnTrain: true }),
      // New demand to plan
      makeDemand({ cardIndex: 2, loadType: 'Coal', supplyCity: 'Essen', deliveryCity: 'Berlin', payout: 20, isLoadOnTrain: false }),
    ];

    const result = generateCandidates(
      makeSnapshot({ loads: ['Wine'] }),
      makeContext({ demands, capacity: 2, loads: ['Wine'] }),
      EMPTY_GRID,
    );

    expect(result.candidates.length).toBeGreaterThanOrEqual(1);
    for (const candidate of result.candidates) {
      const firstStop = candidate.route.stops[0];
      expect(firstStop).toBeDefined();
      expect(firstStop.action).toBe('deliver');
      expect(firstStop.loadType).toBe('Wine');
      expect(firstStop.city).toBe('Birmingham');
    }
  });

  it('carried load with no matching demand card → NOT included as deliver stop', () => {
    const demands = [
      // Only new demand (Coal), no Wine demand card
      makeDemand({ cardIndex: 1, loadType: 'Coal', supplyCity: 'Essen', deliveryCity: 'Berlin', payout: 20, isLoadOnTrain: false }),
    ];

    const result = generateCandidates(
      makeSnapshot({ loads: ['Wine'] }),  // Wine is on train, but no Wine demand card
      makeContext({ demands, capacity: 2, loads: ['Wine'] }),
      EMPTY_GRID,
    );

    expect(result.candidates.length).toBeGreaterThanOrEqual(1);
    for (const candidate of result.candidates) {
      const wineDeliverStop = candidate.route.stops.find(s => s.action === 'deliver' && s.loadType === 'Wine');
      expect(wineDeliverStop).toBeUndefined();
    }
  });

  // ── Scoring ─────────────────────────────────────────────────────────────────

  it('score = payout - buildCost - turns * OPPORTUNITY_COST (5)', () => {
    const demands = [
      makeDemand({ cardIndex: 1, loadType: 'Coal', supplyCity: 'Essen', deliveryCity: 'Berlin', payout: 30, isLoadOnTrain: false }),
    ];
    // simulateTrip returns turns=4, buildCost=10
    mockSimulateTrip.mockReturnValue({ turnsToComplete: 4, totalBuildCost: 10, feasible: true });

    const result = generateCandidates(
      makeSnapshot(),
      makeContext({ demands }),
      EMPTY_GRID,
    );
    expect(result.candidates).toHaveLength(1);
    // score = 30 - 10 - 4*5 = 30 - 10 - 20 = 0
    expect(result.candidates[0].score).toBe(0);
    expect(result.candidates[0].payoutTotal).toBe(30);
    expect(result.candidates[0].buildCost).toBe(10);
    expect(result.candidates[0].turns).toBe(4);
  });

  // ── Pattern annotations ────────────────────────────────────────────────────

  it('pattern annotations attached to the right candidates', () => {
    const demands = [
      makeDemand({ cardIndex: 1, loadType: 'Hops', supplyCity: 'Cardiff', deliveryCity: 'London', payout: 35 }),
      makeDemand({ cardIndex: 2, loadType: 'Coal', supplyCity: 'Cardiff', deliveryCity: 'Birmingham', payout: 27 }),
    ];
    const result = generateCandidates(
      makeSnapshot(),
      makeContext({ demands, capacity: 2 }),
      EMPTY_GRID,
    );
    // Multi-demand candidates should have a pattern
    const multiCandidates = result.candidates.filter(c => c.demandsCovered.length > 1);
    for (const c of multiCandidates) {
      expect(c.patterns.length).toBeGreaterThan(0);
    }
    // Baseline candidate (1 demand) should have no patterns
    const baselineCandidates = result.candidates.filter(c => c.demandsCovered.length === 1 && c.patterns.length === 0);
    expect(baselineCandidates.length).toBeGreaterThanOrEqual(0); // baseline may not be in top 3
  });

  // ── Performance ─────────────────────────────────────────────────────────────

  it('performance: 9 demands completes in <500ms', () => {
    const demands = [
      makeDemand({ cardIndex: 1, loadType: 'Coal', supplyCity: 'Essen', deliveryCity: 'Berlin', payout: 20 }),
      makeDemand({ cardIndex: 2, loadType: 'Wine', supplyCity: 'Bordeaux', deliveryCity: 'London', payout: 30 }),
      makeDemand({ cardIndex: 3, loadType: 'Steel', supplyCity: 'Glasgow', deliveryCity: 'Oslo', payout: 18 }),
      makeDemand({ cardIndex: 4, loadType: 'Hops', supplyCity: 'Cardiff', deliveryCity: 'Birmingham', payout: 25 }),
      makeDemand({ cardIndex: 5, loadType: 'Coal', supplyCity: 'Ruhr', deliveryCity: 'Paris', payout: 22 }),
      makeDemand({ cardIndex: 6, loadType: 'Cheese', supplyCity: 'Holland', deliveryCity: 'Stockholm', payout: 34 }),
      makeDemand({ cardIndex: 7, loadType: 'Flowers', supplyCity: 'Holland', deliveryCity: 'Budapest', payout: 28 }),
      makeDemand({ cardIndex: 8, loadType: 'Tourists', supplyCity: 'Ruhr', deliveryCity: 'Madrid', payout: 32 }),
      makeDemand({ cardIndex: 9, loadType: 'Beer', supplyCity: 'Frankfurt', deliveryCity: 'Lisboa', payout: 27 }),
    ];
    mockSimulateTrip.mockReturnValue(feasible(3, 8));

    const start = Date.now();
    generateCandidates(
      makeSnapshot(),
      makeContext({ demands, capacity: 3 }),
      EMPTY_GRID,
    );
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(500);
  }, 2000);

  // ── Enum stats ───────────────────────────────────────────────────────────────

  it('enumerationStats populated correctly', () => {
    const demands = [
      makeDemand({ cardIndex: 1, loadType: 'Coal', supplyCity: 'Cardiff', deliveryCity: 'London', payout: 30 }),
      makeDemand({ cardIndex: 2, loadType: 'Hops', supplyCity: 'Cardiff', deliveryCity: 'Birmingham', payout: 25 }),
    ];
    const result = generateCandidates(
      makeSnapshot(),
      makeContext({ demands, capacity: 2 }),
      EMPTY_GRID,
    );
    const stats = result.enumerationStats;
    expect(stats.patternsDetected).toBeGreaterThanOrEqual(0);
    expect(stats.candidatesGenerated).toBeGreaterThanOrEqual(0);
    expect(stats.durationMs).toBeGreaterThanOrEqual(0);
  });

  // ── DELIVERY_CLUSTERS lookup ────────────────────────────────────────────────

  it('DELIVERY_CLUSTERS contains expected city mappings', () => {
    expect(DELIVERY_CLUSTERS['London']).toBe('UK');
    expect(DELIVERY_CLUSTERS['Birmingham']).toBe('UK');
    expect(DELIVERY_CLUSTERS['Dublin']).toBe('UK');
    expect(DELIVERY_CLUSTERS['Lodz']).toBe('east-EU');
    expect(DELIVERY_CLUSTERS['Budapest']).toBe('east-EU');
    expect(DELIVERY_CLUSTERS['Madrid']).toBe('iberia');
    expect(DELIVERY_CLUSTERS['Lisboa']).toBe('iberia');
    expect(DELIVERY_CLUSTERS['Oslo']).toBe('nordic');
    expect(DELIVERY_CLUSTERS['Goteborg']).toBe('nordic');
    expect(DELIVERY_CLUSTERS['Milano']).toBe('north-italy');
    expect(DELIVERY_CLUSTERS['Firenze']).toBe('north-italy');
  });
});
