/**
 * DeterministicTripPlanner.test.ts
 *
 * Unit tests for the DeterministicTripPlanner module (JIRA-220).
 *
 * Mirrors the mocking patterns from RouteDetourEstimator.test.ts.
 */

import * as fs from 'fs';
import * as path from 'path';

// ── Mocks ──────────────────────────────────────────────────────────────

// Mock RouteDetourEstimator to control simulateTrip output per test
jest.mock('../../services/ai/RouteDetourEstimator', () => ({
  simulateTrip: jest.fn(),
}));

// Mock MapTopology to control grid + city lookup
// Using Map<string, any> since the mock grid is just for test fixtures
const mockGrid = new Map<string, { row: number; col: number; terrain: number; name?: string }>();

jest.mock('../../services/ai/MapTopology', () => ({
  loadGridPoints: jest.fn(() => mockGrid),
  hexDistance: jest.fn((r1: number, c1: number, r2: number, c2: number): number => {
    // Simple Chebyshev-style approximation for test purposes
    return Math.max(Math.abs(r2 - r1), Math.abs(c2 - c1));
  }),
}));

// ── Imports (after mocks) ──────────────────────────────────────────────

import { simulateTrip } from '../../services/ai/RouteDetourEstimator';
import {
  OCPT,
  PRUNE_MAX_TURNS,
  PRUNE_MAX_BUILD_M,
  HOP_AVG_COST_M,
  detectCarriedLoads,
  enumerateCandidates,
  cheapPrune,
  scoreCandidate,
  pickTop1,
  planTripDeterministic,
  DeterministicTripPlanResult,
} from '../../services/ai/DeterministicTripPlanner';
import {
  WorldSnapshot,
  GameContext,
  BotMemoryState,
  DemandContext,
  StrategicRoute,
  RouteStop,
  AIActionType,
  TrainType,
} from '../../../shared/types/GameTypes';

const mockSimulateTrip = simulateTrip as jest.MockedFunction<typeof simulateTrip>;

// ── Helpers ────────────────────────────────────────────────────────────

/** Add a named city to the mock grid at the given coords */
function addCity(name: string, row: number, col: number): void {
  (mockGrid as any).set(`${row},${col}`, { row, col, terrain: 0, name });
}

/** Create a minimal DemandContext row */
function makeDemand(overrides: Partial<DemandContext> & {
  cardIndex: number;
  loadType: string;
  deliveryCity: string;
  payout: number;
}): DemandContext {
  const defaults: DemandContext = {
    cardIndex: overrides.cardIndex,
    loadType: overrides.loadType,
    supplyCity: 'SupplyCity',
    deliveryCity: overrides.deliveryCity,
    payout: overrides.payout,
    isLoadOnTrain: false,
    isSupplyReachable: true,
    isDeliveryReachable: true,
    isSupplyOnNetwork: true,
    isDeliveryOnNetwork: true,
    estimatedTrackCostToSupply: 0,
    estimatedTrackCostToDelivery: 0,
    isLoadAvailable: true,
    ferryRequired: false,
    loadChipTotal: 4,
    loadChipCarried: 0,
    estimatedTurns: 3,
    demandScore: 10,
    efficiencyPerTurn: 5,
    networkCitiesUnlocked: 0,
    victoryMajorCitiesEnRoute: 0,
    isAffordable: true,
    projectedFundsAfterDelivery: 100,
  };
  return { ...defaults, ...overrides };
}

/** Create a minimal BotMemoryState */
function makeMemory(overrides: Partial<BotMemoryState> = {}): BotMemoryState {
  return {
    currentBuildTarget: null,
    turnsOnTarget: 0,
    lastAction: null,
    consecutiveDiscards: 0,
    deliveryCount: 0,
    totalEarnings: 0,
    turnNumber: 1,
    activeRoute: null,
    turnsOnRoute: 0,
    routeHistory: [],
    lastAbandonedRouteKey: null,
    lastReasoning: null,
    lastPlanHorizon: null,
    previousRouteStops: null,
    consecutiveLlmFailures: 0,
    ...overrides,
  };
}

/** Create a minimal WorldSnapshot */
function makeSnapshot(overrides: Partial<WorldSnapshot['bot']> = {}): WorldSnapshot {
  return {
    gameId: 'test-game',
    gameStatus: 'active',
    turnNumber: 5,
    bot: {
      playerId: 'bot-1',
      userId: 'user-1',
      money: 100,
      position: { row: 5, col: 5 },
      existingSegments: [],
      demandCards: [],
      resolvedDemands: [],
      trainType: 'freight',
      loads: [],
      botConfig: { skillLevel: 'medium' },
      connectedMajorCityCount: 0,
      ...overrides,
    },
    allPlayerTracks: [],
    loadAvailability: {},
  };
}

/** Create a minimal GameContext */
function makeContext(demands: DemandContext[], overrides: Partial<GameContext> = {}): GameContext {
  return {
    position: { row: 5, col: 5 },
    money: 100,
    trainType: 'freight',
    speed: 9,
    capacity: 2,
    loads: [],
    connectedMajorCities: [],
    unconnectedMajorCities: [],
    totalMajorCities: 7,
    trackSummary: '',
    turnBuildCost: 0,
    demands,
    canDeliver: [],
    canPickup: [],
    reachableCities: [],
    citiesOnNetwork: [],
    canUpgrade: false,
    canBuild: true,
    isInitialBuild: false,
    opponents: [],
    phase: 'active',
    turnNumber: 5,
    ...overrides,
  };
}

/** Create a StrategicRoute */
function makeRoute(stops: RouteStop[], overrides: Partial<StrategicRoute> = {}): StrategicRoute {
  return {
    stops,
    currentStopIndex: 0,
    phase: 'build',
    createdAtTurn: 1,
    reasoning: 'test',
    ...overrides,
  };
}

// ── Setup ──────────────────────────────────────────────────────────────

beforeEach(() => {
  jest.clearAllMocks();
  (mockGrid as any).clear();

  // Default cities for most tests
  addCity('SupplyCity', 3, 3);
  addCity('DeliveryCity', 7, 7);
  addCity('CityA', 2, 2);
  addCity('CityB', 8, 8);
  addCity('CityC', 4, 9);

  // Default: simulateTrip returns feasible result
  mockSimulateTrip.mockReturnValue({ turnsToComplete: 3, totalBuildCost: 5, feasible: true });
});

// ── Constants ──────────────────────────────────────────────────────────

describe('Exported constants', () => {
  it('OCPT === 8', () => {
    expect(OCPT).toBe(8);
  });

  it('PRUNE_MAX_TURNS === 12', () => {
    expect(PRUNE_MAX_TURNS).toBe(12);
  });

  it('PRUNE_MAX_BUILD_M === 130', () => {
    expect(PRUNE_MAX_BUILD_M).toBe(130);
  });

  it('HOP_AVG_COST_M === 1.3', () => {
    expect(HOP_AVG_COST_M).toBe(1.3);
  });

  it('OCPT source contains calibration phrase "must be re-tuned"', () => {
    const srcPath = path.join(
      __dirname,
      '../../services/ai/DeterministicTripPlanner.ts',
    );
    const src = fs.readFileSync(srcPath, 'utf8');
    // The spec says grep for the unique phrase "must be re-tuned".
    // In the verbatim comment this spans two lines as:
    //   "OCPT MUST be\n     * re-tuned."
    // So we normalize multi-line comment continuation and check case-insensitively.
    const normalized = src.replace(/\r?\n\s*\*\s*/g, ' ').toLowerCase();
    expect(normalized).toContain('must be re-tuned');
  });
});

// ── detectCarriedLoads ─────────────────────────────────────────────────

describe('detectCarriedLoads', () => {
  it('demand with isLoadOnTrain: true produces carry flag', () => {
    const demands = [
      makeDemand({ cardIndex: 1, loadType: 'Ham', deliveryCity: 'Stuttgart', payout: 12, isLoadOnTrain: true }),
    ];
    const result = detectCarriedLoads(null, demands);
    expect(result.has('Ham')).toBe(true);
  });

  it('activeRoute with deliver-without-pickup implies carry; logs warn when canonical=false', () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const demands = [
      makeDemand({
        cardIndex: 5,
        loadType: 'Ham',
        supplyCity: 'Berlin', // non-null supplyCity — canonical says not carrying
        deliveryCity: 'Stuttgart',
        payout: 12,
        isLoadOnTrain: false,
      }),
    ];
    const route = makeRoute([
      // deliver without preceding pickup — implicit carry
      { action: 'deliver', loadType: 'Ham', city: 'Stuttgart', demandCardId: 5, payment: 12 },
    ]);
    const result = detectCarriedLoads(route, demands);
    expect(result.has('Ham')).toBe(true);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0][0]).toContain('signal mismatch');
    warnSpy.mockRestore();
  });

  it('activeRoute null + isLoadOnTrain=false → no carry flag', () => {
    const demands = [
      makeDemand({ cardIndex: 1, loadType: 'Steel', deliveryCity: 'Paris', payout: 10, isLoadOnTrain: false }),
    ];
    const result = detectCarriedLoads(null, demands);
    expect(result.has('Steel')).toBe(false);
  });

  it('activeRoute with pickup before deliver → no implicit carry', () => {
    const demands = [
      makeDemand({ cardIndex: 2, loadType: 'Coal', deliveryCity: 'Lyon', payout: 8, isLoadOnTrain: false }),
    ];
    const route = makeRoute([
      { action: 'pickup', loadType: 'Coal', city: 'SupplyCity' },
      { action: 'deliver', loadType: 'Coal', city: 'Lyon', demandCardId: 2, payment: 8 },
    ]);
    const result = detectCarriedLoads(route, demands);
    expect(result.has('Coal')).toBe(false);
  });
});

// ── enumerateCandidates ────────────────────────────────────────────────

describe('enumerateCandidates', () => {
  it('9 distinct demands with cap=2 → singles + pairs, no cap-3 triples', () => {
    // NormalizedDemandRow is an internal type — use explicit type annotation
    type Row = { loadType: string; supplyCity: string | null; deliveryCity: string; payout: number; cardIndex: number; isCarry: boolean };
    const demands: Row[] = [];
    // Build 9 demands with distinct cardIndex
    for (let i = 0; i < 9; i++) {
      demands.push({
        loadType: `Load${i}`,
        supplyCity: 'SupplyCity',
        deliveryCity: 'DeliveryCity',
        payout: 10 + i,
        cardIndex: i + 10, // distinct card indices
        isCarry: false,
      });
    }
    const candidates = enumerateCandidates(demands, 2);
    const singles = candidates.filter((c) => c.id.startsWith('single:'));
    const pairs = candidates.filter((c) => c.id.startsWith('pair:'));
    const triples = candidates.filter((c) => c.id.startsWith('triple:'));

    expect(singles.length).toBe(9);
    // C(9,2) = 36 pair-row-sets; 2 ordering variants each (both fresh)
    expect(pairs.length).toBe(36 * 2);
    // cap=2 → no 3-fresh triples (require cap≥3)
    // With cap=2 and all non-carry, genTriples returns 0 (all 3-fresh triples are blocked)
    expect(triples.length).toBe(0);
  });

  it('same-cardIndex pair is NOT generated', () => {
    const demands = [
      { loadType: 'Marble', supplyCity: 'CityA', deliveryCity: 'DeliveryCity', payout: 15, cardIndex: 64, isCarry: false },
      { loadType: 'Cork', supplyCity: 'CityB', deliveryCity: 'DeliveryCity', payout: 12, cardIndex: 64, isCarry: false },
    ];
    const candidates = enumerateCandidates(demands, 2);
    const pairs = candidates.filter((c) => c.id.startsWith('pair:'));
    expect(pairs.length).toBe(0);
  });

  it('cap=3 enables 3-fresh triple variants', () => {
    const demands = [
      { loadType: 'LoadA', supplyCity: 'CityA', deliveryCity: 'DeliveryCity', payout: 10, cardIndex: 1, isCarry: false },
      { loadType: 'LoadB', supplyCity: 'CityB', deliveryCity: 'DeliveryCity', payout: 11, cardIndex: 2, isCarry: false },
      { loadType: 'LoadC', supplyCity: 'CityC', deliveryCity: 'DeliveryCity', payout: 12, cardIndex: 3, isCarry: false },
    ];
    const candidates = enumerateCandidates(demands, 3);
    const triples = candidates.filter((c) => c.id.startsWith('triple:'));
    // 3-fresh: 1 variant for C(3,3)=1 group
    expect(triples.length).toBeGreaterThan(0);
    expect(triples.some((t) => t.id.includes('3f-ABC'))).toBe(true);
  });

  it('carry + 2-fresh triple produces correct variants (1c2f variants)', () => {
    const demands = [
      { loadType: 'CarryLoad', supplyCity: null, deliveryCity: 'CityA', payout: 20, cardIndex: 1, isCarry: true },
      { loadType: 'LoadB', supplyCity: 'CityB', deliveryCity: 'DeliveryCity', payout: 11, cardIndex: 2, isCarry: false },
      { loadType: 'LoadC', supplyCity: 'CityC', deliveryCity: 'DeliveryCity', payout: 12, cardIndex: 3, isCarry: false },
    ];
    const candidates = enumerateCandidates(demands, 2);
    const triples = candidates.filter((c) => c.id.startsWith('triple:'));
    // 1 carry + 2 fresh → 1c2f variants
    expect(triples.some((t) => t.id.includes('1c2f'))).toBe(true);
  });
});

// ── cheapPrune ─────────────────────────────────────────────────────────

describe('cheapPrune', () => {
  const defaultOpts = {
    ocpt: OCPT,
    pruneMaxTurns: PRUNE_MAX_TURNS,
    pruneMaxBuildM: PRUNE_MAX_BUILD_M,
    hopAvgCostM: HOP_AVG_COST_M,
  };

  beforeEach(() => {
    // Use cities added in the outer beforeEach
    // SupplyCity at (3,3), DeliveryCity at (7,7)
  });

  it('candidate with build cost > PRUNE_MAX_BUILD_M returns keep: false', () => {
    // hexDistance from (5,5) to (3,3) = max(2,2)=2; to (7,7) = max(2,2)=2; total=4 hops
    // But we need estBuild > 130: need totalHops * 1.3 > 130 → totalHops > 100
    // Let's put the delivery city very far away
    addCity('FarCity', 200, 200);
    const candidate = {
      id: 'test',
      rows: [],
      stops: [
        { action: 'pickup' as const, loadType: 'Load', city: 'SupplyCity' },
        { action: 'deliver' as const, loadType: 'Load', city: 'FarCity' },
      ],
      payout: 50,
    };
    // hexDistance mock: max(|200-3|, |200-3|) = 197 from SupplyCity to FarCity
    // from startPos (5,5) to SupplyCity (3,3): max(2,2)=2
    // from SupplyCity (3,3) to FarCity (200,200): max(197,197)=197
    // total = 199; estBuild = 199 * 1.3 = 258.7 > 130 → pruned
    const result = cheapPrune(candidate, { row: 5, col: 5 }, 9, defaultOpts);
    expect(result.keep).toBe(false);
  });

  it('candidate with turns > PRUNE_MAX_TURNS returns keep: false', () => {
    // To exceed 12 turns at speed 9: need totalHops > 108
    // Place cities at row/col offset 60
    addCity('FarSupply', 65, 65);
    addCity('FarDelivery', 130, 130);
    const candidate = {
      id: 'test2',
      rows: [],
      stops: [
        { action: 'pickup' as const, loadType: 'Load', city: 'FarSupply' },
        { action: 'deliver' as const, loadType: 'Load', city: 'FarDelivery' },
      ],
      payout: 50,
    };
    // from (5,5) to (65,65): 60 hops; to (130,130): 65 hops; total = 125
    // estTurns = ceil(125/9) = 14 > 12 → pruned
    const result = cheapPrune(candidate, { row: 5, col: 5 }, 9, defaultOpts);
    expect(result.keep).toBe(false);
    expect(result.estTurns).toBeGreaterThan(PRUNE_MAX_TURNS);
  });

  it('candidate just below thresholds returns keep: true', () => {
    // SupplyCity at (3,3), DeliveryCity at (7,7)
    // from (5,5) to (3,3): 2 hops; to (7,7): 4 hops; total = 6
    // estTurns = ceil(6/9) = 1 ≤ 12 ✓
    // estBuild = 6 * 1.3 = 7.8 ≤ 130 ✓
    const candidate = {
      id: 'test3',
      rows: [],
      stops: [
        { action: 'pickup' as const, loadType: 'Load', city: 'SupplyCity' },
        { action: 'deliver' as const, loadType: 'Load', city: 'DeliveryCity' },
      ],
      payout: 50,
    };
    const result = cheapPrune(candidate, { row: 5, col: 5 }, 9, defaultOpts);
    expect(result.keep).toBe(true);
  });

  it('candidate with unknown city returns keep: false', () => {
    const candidate = {
      id: 'test4',
      rows: [],
      stops: [
        { action: 'deliver' as const, loadType: 'Load', city: 'NonExistentCity' },
      ],
      payout: 10,
    };
    const result = cheapPrune(candidate, { row: 5, col: 5 }, 9, defaultOpts);
    expect(result.keep).toBe(false);
  });
});

// ── scoreCandidate ─────────────────────────────────────────────────────

describe('scoreCandidate', () => {
  const defaultOpts = {
    ocpt: OCPT,
    pruneMaxTurns: PRUNE_MAX_TURNS,
    pruneMaxBuildM: PRUNE_MAX_BUILD_M,
    hopAvgCostM: HOP_AVG_COST_M,
  };

  it('computes correct score: payout=31, turns=3, buildCost=22, OCPT=8 → score=-15', () => {
    mockSimulateTrip.mockReturnValueOnce({ turnsToComplete: 3, totalBuildCost: 22, feasible: true });
    const snapshot = makeSnapshot();
    const candidate = {
      id: 'test-score',
      rows: [],
      stops: [
        { action: 'pickup' as const, loadType: 'Load', city: 'SupplyCity' },
        { action: 'deliver' as const, loadType: 'Load', city: 'DeliveryCity', demandCardId: 1, payment: 31 },
      ],
      payout: 31,
    };
    const result = scoreCandidate(candidate, { row: 5, col: 5 }, snapshot, defaultOpts);
    // score = (31 - 22) - 8 * 3 = 9 - 24 = -15
    expect(result.feasible).toBe(true);
    expect(result.buildCost).toBe(22);
    expect(result.turns).toBe(3);
    expect(result.score).toBeCloseTo(-15, 5);
    expect(result.net).toBeCloseTo(9, 5);
  });

  it('simulator throws → returns feasible: false, no rethrow, console.warn called once', () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    mockSimulateTrip.mockImplementationOnce(() => {
      throw new Error('Simulator error');
    });
    const snapshot = makeSnapshot();
    const candidate = {
      id: 'throw-test',
      rows: [],
      stops: [{ action: 'deliver' as const, loadType: 'Load', city: 'DeliveryCity', demandCardId: 1, payment: 10 }],
      payout: 10,
    };
    const result = scoreCandidate(candidate, { row: 5, col: 5 }, snapshot, defaultOpts);
    expect(result.feasible).toBe(false);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0][0]).toContain('throw-test');
    warnSpy.mockRestore();
  });

  it('infeasible simulator result → returns feasible: false', () => {
    mockSimulateTrip.mockReturnValueOnce({ turnsToComplete: 0, totalBuildCost: 0, feasible: false });
    const snapshot = makeSnapshot();
    const candidate = {
      id: 'infeasible-test',
      rows: [],
      stops: [{ action: 'deliver' as const, loadType: 'Load', city: 'DeliveryCity', demandCardId: 1, payment: 10 }],
      payout: 10,
    };
    const result = scoreCandidate(candidate, { row: 5, col: 5 }, snapshot, defaultOpts);
    expect(result.feasible).toBe(false);
  });
});

// ── pickTop1 ───────────────────────────────────────────────────────────

describe('pickTop1', () => {
  // ScoredCandidate is internal — mirror its shape here for test fixtures
  type ScoredCandidateFixture = {
    id: string;
    rows: unknown[];
    stops: RouteStop[];
    payout: number;
    buildCost: number;
    turns: number;
    net: number;
    score: number;
    feasible: boolean;
  };
  function makeScoredCandidate(id: string, score: number): ScoredCandidateFixture {
    return {
      id,
      rows: [],
      stops: [],
      payout: 0,
      buildCost: 0,
      turns: 1,
      net: score,
      score,
      feasible: true,
    };
  }

  it('empty array returns null', () => {
    expect(pickTop1([])).toBeNull();
  });

  it('sorted scores [10, 5, 8] return id of the 10-score candidate', () => {
    const candidates = [
      makeScoredCandidate('score-10', 10),
      makeScoredCandidate('score-5', 5),
      makeScoredCandidate('score-8', 8),
    ];
    const result = pickTop1(candidates as any[]);
    expect(result?.id).toBe('score-10');
  });

  it('single candidate is returned', () => {
    const candidates = [makeScoredCandidate('only-one', 7)];
    const result = pickTop1(candidates as any[]);
    expect(result?.id).toBe('only-one');
  });
});

// ── planTripDeterministic ──────────────────────────────────────────────

describe('planTripDeterministic', () => {
  it('same snapshot, two consecutive calls — identical route returned (determinism)', () => {
    mockSimulateTrip.mockReturnValue({ turnsToComplete: 3, totalBuildCost: 5, feasible: true });
    const demands = [
      makeDemand({ cardIndex: 1, loadType: 'Ham', deliveryCity: 'DeliveryCity', payout: 20 }),
    ];
    const snapshot = makeSnapshot();
    const context = makeContext(demands);
    const memory = makeMemory();

    const result1 = planTripDeterministic(snapshot, context, memory);
    const result2 = planTripDeterministic(snapshot, context, memory);

    expect(result1.outcome).toBe('success');
    expect(result2.outcome).toBe('success');
    expect(result1.route?.stops).toEqual(result2.route?.stops);
  });

  it('empty hand → outcome: no_feasible_candidates, route null', () => {
    const snapshot = makeSnapshot();
    const context = makeContext([]);
    const memory = makeMemory();

    const result = planTripDeterministic(snapshot, context, memory);
    expect(result.outcome).toBe('no_feasible_candidates');
    expect(result.route).toBeNull();
  });

  it('all candidates pruned → outcome: no_feasible_candidates, route null', () => {
    // Create demands with cities not in the grid (will fail prune)
    const demands = [
      makeDemand({
        cardIndex: 1,
        loadType: 'Steel',
        supplyCity: 'UnknownCity1',
        deliveryCity: 'UnknownCity2',
        payout: 10,
      }),
    ];
    const snapshot = makeSnapshot();
    const context = makeContext(demands);
    const memory = makeMemory();

    const result = planTripDeterministic(snapshot, context, memory);
    expect(result.outcome).toBe('no_feasible_candidates');
    expect(result.route).toBeNull();
  });

  it('simulator throws on every candidate → outcome: no_feasible_candidates', () => {
    mockSimulateTrip.mockImplementation(() => {
      throw new Error('All broken');
    });
    const demands = [
      makeDemand({ cardIndex: 1, loadType: 'Ham', deliveryCity: 'DeliveryCity', payout: 20 }),
    ];
    const snapshot = makeSnapshot();
    const context = makeContext(demands);
    const memory = makeMemory();

    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const result = planTripDeterministic(snapshot, context, memory);
    expect(result.outcome).toBe('no_feasible_candidates');
    expect(result.route).toBeNull();
    warnSpy.mockRestore();
  });

  it('verbose reasoning contains required substrings', () => {
    mockSimulateTrip.mockReturnValue({ turnsToComplete: 2, totalBuildCost: 5, feasible: true });
    const demands = [
      makeDemand({ cardIndex: 1, loadType: 'Ham', deliveryCity: 'DeliveryCity', payout: 20 }),
      makeDemand({ cardIndex: 2, loadType: 'Coal', supplyCity: 'CityA', deliveryCity: 'CityB', payout: 15 }),
    ];
    const snapshot = makeSnapshot();
    const context = makeContext(demands);
    const memory = makeMemory();

    const result = planTripDeterministic(snapshot, context, memory);
    expect(result.outcome).toBe('success');
    expect(result.reasoning).toContain('[deterministic-top-1]');
    expect(result.reasoning).toContain('Picked:');
    expect(result.reasoning).toContain('Survivors after spatial prune:');
  });

  it('when ≥2 candidates feasible, reasoning contains Runner-up #2', () => {
    // Both candidates must survive prune and be feasible
    mockSimulateTrip.mockReturnValue({ turnsToComplete: 2, totalBuildCost: 5, feasible: true });
    const demands = [
      makeDemand({ cardIndex: 1, loadType: 'Ham', deliveryCity: 'DeliveryCity', payout: 20 }),
      makeDemand({ cardIndex: 2, loadType: 'Coal', supplyCity: 'CityA', deliveryCity: 'CityB', payout: 15 }),
    ];
    const snapshot = makeSnapshot();
    const context = makeContext(demands);
    const memory = makeMemory();

    const result = planTripDeterministic(snapshot, context, memory);
    expect(result.outcome).toBe('success');
    expect(result.reasoning).toContain('Runner-up #2');
  });

  it('returns a synthesizedAttempt with model: deterministic', () => {
    mockSimulateTrip.mockReturnValue({ turnsToComplete: 2, totalBuildCost: 5, feasible: true });
    const demands = [
      makeDemand({ cardIndex: 1, loadType: 'Ham', deliveryCity: 'DeliveryCity', payout: 20 }),
    ];
    const snapshot = makeSnapshot();
    const context = makeContext(demands);
    const memory = makeMemory();

    const result = planTripDeterministic(snapshot, context, memory);
    expect(result.synthesizedAttempt).toBeDefined();
    expect(result.synthesizedAttempt.responseText).toContain('deterministic');
  });

  it('carry demand uses deliver-only stop (no pickup)', () => {
    mockSimulateTrip.mockReturnValue({ turnsToComplete: 1, totalBuildCost: 0, feasible: true });
    const demands = [
      makeDemand({
        cardIndex: 1,
        loadType: 'Ham',
        supplyCity: null,
        deliveryCity: 'DeliveryCity',
        payout: 25,
        isLoadOnTrain: true,
      }),
    ];
    const snapshot = makeSnapshot();
    const context = makeContext(demands);
    const memory = makeMemory();

    const result = planTripDeterministic(snapshot, context, memory);
    expect(result.outcome).toBe('success');
    const stops = result.route!.stops;
    expect(stops.every((s) => s.action !== 'pickup')).toBe(true);
    expect(stops[0].action).toBe('deliver');
  });

  it('route has correct structure (createdAtTurn, phase, currentStopIndex)', () => {
    mockSimulateTrip.mockReturnValue({ turnsToComplete: 3, totalBuildCost: 10, feasible: true });
    const demands = [
      makeDemand({ cardIndex: 1, loadType: 'Steel', deliveryCity: 'DeliveryCity', payout: 30 }),
    ];
    const snapshot = makeSnapshot();
    const context = makeContext(demands);
    const memory = makeMemory();

    const result = planTripDeterministic(snapshot, context, memory);
    expect(result.outcome).toBe('success');
    expect(result.route!.currentStopIndex).toBe(0);
    expect(result.route!.phase).toBe('build');
    expect(result.route!.createdAtTurn).toBe(snapshot.turnNumber);
  });
});
