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
  OCPT_BY_PHASE,
  PRUNE_MAX_TURNS,
  PRUNE_MAX_BUILD_M,
  HOP_AVG_COST_M,
  AFFORDABILITY_FLOOR_M,
  classifyGamePhase,
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
  mockSimulateTrip.mockReturnValue({ turnsToComplete: 3, totalBuildCost: 5, feasible: true, minCashRelative: 0, finalCashRelative: 0 });
});

// ── Constants ──────────────────────────────────────────────────────────

describe('Exported constants', () => {
  it('OCPT_BY_PHASE has the expected phase-aware values (early=2, mid=4, late=7)', () => {
    // OCPT now varies by game phase. Early-game favors network-building
    // multi-stop trips (low turn cost); mid-game is slightly below income
    // velocity to favor pair/triple candidates unlocked by JIRA-227/228;
    // late-game punishes long trips because every remaining turn matters
    // for closing out the win condition (7 cities + ECU 250M).
    expect(OCPT_BY_PHASE.early).toBe(2);
    expect(OCPT_BY_PHASE.mid).toBe(4);
    expect(OCPT_BY_PHASE.late).toBe(7);
  });

  it('OCPT (default export) equals OCPT_BY_PHASE.mid for backward compatibility', () => {
    expect(OCPT).toBe(OCPT_BY_PHASE.mid);
    expect(OCPT).toBe(4);
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

  it('OCPT_BY_PHASE source contains calibration history pointing to sweep tooling', () => {
    // The OCPT comment must explain why values are what they are and what
    // triggers a re-tune. Without this, values look arbitrary. The unique
    // phrase tracks the sweep tooling at scripts/ai/sweep-spatial-prune.py.
    const srcPath = path.join(
      __dirname,
      '../../services/ai/DeterministicTripPlanner.ts',
    );
    const src = fs.readFileSync(srcPath, 'utf8');
    const normalized = src.replace(/\r?\n\s*\*\s*/g, ' ').toLowerCase();
    expect(normalized).toContain('sweep-spatial-prune.py');
  });
});

// ── classifyGamePhase ──────────────────────────────────────────────────

describe('classifyGamePhase', () => {
  // LATE triggers
  it('citiesConnected >= 5 → late (regardless of turn)', () => {
    expect(classifyGamePhase(10, 0, 5)).toBe('late');
    expect(classifyGamePhase(10, 0, 7)).toBe('late');
  });

  it('turn >= 80 → late (regardless of cities)', () => {
    expect(classifyGamePhase(80, 0, 0)).toBe('late');
    expect(classifyGamePhase(120, 5, 4)).toBe('late');
  });

  it('turn 60-79 → mid (boundary raised from 60 to 80 to extend mid-phase OCPT=4)', () => {
    // Used to classify late at turn 60+; now stays mid until turn 80 so
    // pair/triple candidates compete with OCPT=4 for an extra 20 turns.
    expect(classifyGamePhase(60, 5, 4)).toBe('mid');
    expect(classifyGamePhase(70, 8, 3)).toBe('mid');
    expect(classifyGamePhase(79, 10, 4)).toBe('mid');
  });

  // EARLY triggers (none of the LATE triggers fired)
  it('turn < 25 → early', () => {
    expect(classifyGamePhase(24, 5, 4)).toBe('early');
    expect(classifyGamePhase(0, 0, 0)).toBe('early');
  });

  it('deliveries < 3 → early (when not late)', () => {
    expect(classifyGamePhase(30, 2, 3)).toBe('early');
    expect(classifyGamePhase(50, 0, 4)).toBe('early');
  });

  it('citiesConnected < 2 → early (when not late)', () => {
    expect(classifyGamePhase(30, 5, 1)).toBe('early');
    expect(classifyGamePhase(40, 10, 0)).toBe('early');
  });

  // MID — past all early triggers, before late triggers
  it('turn >= 25, deliveries >= 3, citiesConnected in [2..4] → mid', () => {
    expect(classifyGamePhase(25, 3, 2)).toBe('mid');
    expect(classifyGamePhase(45, 6, 4)).toBe('mid');
    expect(classifyGamePhase(79, 10, 4)).toBe('mid');
  });

  it('LATE precedence over EARLY when both could match (citiesConnected=5, deliveries=0)', () => {
    expect(classifyGamePhase(5, 0, 5)).toBe('late');
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
    // C(9,2) = 36 pair-row-sets; 4 ordering variants each (both fresh).
    // JIRA-228 added :A-then-B and :B-then-A backhaul variants alongside
    // the existing :AB and :BA.
    expect(pairs.length).toBe(36 * 4);
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

  // ── JIRA-228: fresh-fresh backhaul variants ─────────────────────────
  it('JIRA-228: fresh-fresh pair emits four variants (:AB, :BA, :A-then-B, :B-then-A)', () => {
    type Row = { loadType: string; supplyCity: string | null; deliveryCity: string; payout: number; cardIndex: number; isCarry: boolean };
    const demands: Row[] = [
      { loadType: 'Copper',  supplyCity: 'Wroclaw',  deliveryCity: 'Madrid',     payout: 46, cardIndex: 4,   isCarry: false },
      { loadType: 'Oranges', supplyCity: 'Valencia', deliveryCity: 'Manchester', payout: 40, cardIndex: 122, isCarry: false },
    ];
    const candidates = enumerateCandidates(demands, 2);
    const pairs = candidates.filter((c) => c.id.startsWith('pair:'));
    expect(pairs.length).toBe(4);

    const suffixes = pairs.map((p) => p.id.split(':').pop()).sort();
    expect(suffixes).toEqual(['A-then-B', 'AB', 'B-then-A', 'BA']);
  });

  it('JIRA-228: :A-then-B variant has stops [pickA, delA, pickB, delB]', () => {
    type Row = { loadType: string; supplyCity: string | null; deliveryCity: string; payout: number; cardIndex: number; isCarry: boolean };
    const demands: Row[] = [
      { loadType: 'Copper',  supplyCity: 'Wroclaw',  deliveryCity: 'Madrid',     payout: 46, cardIndex: 4,   isCarry: false },
      { loadType: 'Oranges', supplyCity: 'Valencia', deliveryCity: 'Manchester', payout: 40, cardIndex: 122, isCarry: false },
    ];
    const candidates = enumerateCandidates(demands, 2);
    const aThenB = candidates.find((c) => c.id.endsWith(':A-then-B'));
    expect(aThenB).toBeDefined();
    expect(aThenB!.stops.map((s) => `${s.action}:${s.loadType}@${s.city}`)).toEqual([
      'pickup:Copper@Wroclaw',
      'deliver:Copper@Madrid',
      'pickup:Oranges@Valencia',
      'deliver:Oranges@Manchester',
    ]);
  });

  it('JIRA-228: :B-then-A variant has stops [pickB, delB, pickA, delA]', () => {
    type Row = { loadType: string; supplyCity: string | null; deliveryCity: string; payout: number; cardIndex: number; isCarry: boolean };
    const demands: Row[] = [
      { loadType: 'Copper',  supplyCity: 'Wroclaw',  deliveryCity: 'Madrid',     payout: 46, cardIndex: 4,   isCarry: false },
      { loadType: 'Oranges', supplyCity: 'Valencia', deliveryCity: 'Manchester', payout: 40, cardIndex: 122, isCarry: false },
    ];
    const candidates = enumerateCandidates(demands, 2);
    const bThenA = candidates.find((c) => c.id.endsWith(':B-then-A'));
    expect(bThenA).toBeDefined();
    expect(bThenA!.stops.map((s) => `${s.action}:${s.loadType}@${s.city}`)).toEqual([
      'pickup:Oranges@Valencia',
      'deliver:Oranges@Manchester',
      'pickup:Copper@Wroclaw',
      'deliver:Copper@Madrid',
    ]);
  });

  it('JIRA-228: carry+fresh pair still emits 3 variants (carry branch unchanged)', () => {
    type Row = { loadType: string; supplyCity: string | null; deliveryCity: string; payout: number; cardIndex: number; isCarry: boolean };
    const demands: Row[] = [
      { loadType: 'CarryLoad', supplyCity: null,    deliveryCity: 'CityA', payout: 20, cardIndex: 1, isCarry: true  },
      { loadType: 'FreshLoad', supplyCity: 'CityB', deliveryCity: 'CityC', payout: 15, cardIndex: 2, isCarry: false },
    ];
    const candidates = enumerateCandidates(demands, 2);
    const pairs = candidates.filter((c) => c.id.startsWith('pair:'));
    expect(pairs.length).toBe(3);
    const suffixes = pairs.map((p) => p.id.split(':').pop()).sort();
    expect(suffixes).toEqual(['cA-pB', 'delAfirst', 'pB-cA']);
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

  it('computes correct score: payout=31, turns=3, buildCost=22, OCPT=4 (mid-phase default) → score=-3', () => {
    mockSimulateTrip.mockReturnValueOnce({ turnsToComplete: 3, totalBuildCost: 22, feasible: true, minCashRelative: 0, finalCashRelative: 0 });
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
    // score = (31 - 22) - 4 * 3 = 9 - 12 = -3 (mid-phase OCPT after JIRA-227/228 tuning)
    expect(result.feasible).toBe(true);
    expect(result.buildCost).toBe(22);
    expect(result.turns).toBe(3);
    expect(result.score).toBeCloseTo(-3, 5);
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
    mockSimulateTrip.mockReturnValueOnce({ turnsToComplete: 0, totalBuildCost: 0, feasible: false, minCashRelative: 0, finalCashRelative: 0 });
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

// ── JIRA-223: scoreCandidate affordability gate ───────────────────────

describe('scoreCandidate — affordability gate (JIRA-223)', () => {
  const defaultOpts = {
    ocpt: OCPT,
    pruneMaxTurns: PRUNE_MAX_TURNS,
    pruneMaxBuildM: PRUNE_MAX_BUILD_M,
    hopAvgCostM: HOP_AVG_COST_M,
  };

  const makeCandidate = (id: string) => ({
    id,
    rows: [],
    stops: [
      { action: 'pickup' as const, loadType: 'Fish', city: 'Oslo' },
      { action: 'deliver' as const, loadType: 'Fish', city: 'Bern', demandCardId: 1, payment: 25 },
    ],
    payout: 25,
  });

  it('(AC1) rejects a candidate where snapshot.bot.money + minCashRelative < 0 → feasible: false', () => {
    // bot.money=7, minCashRelative=-25 → projectedMin = 7 + (-25) = -18 < 0
    mockSimulateTrip.mockReturnValueOnce({
      turnsToComplete: 8, totalBuildCost: 30, feasible: true,
      minCashRelative: -25, finalCashRelative: -5,
    });
    const snapshot = makeSnapshot({ money: 7 });
    const result = scoreCandidate(makeCandidate('ac1-test'), { row: 5, col: 5 }, snapshot, defaultOpts);
    expect(result.feasible).toBe(false);
  });

  it('(AC1,AC2) accepts a candidate where snapshot.bot.money + minCashRelative >= 0 with positive final-net', () => {
    // bot.money=30, minCashRelative=-20 → projectedMin = 10 >= 0 → passes gate
    mockSimulateTrip.mockReturnValueOnce({
      turnsToComplete: 3, totalBuildCost: 5, feasible: true,
      minCashRelative: -20, finalCashRelative: 15,
    });
    const snapshot = makeSnapshot({ money: 30 });
    const result = scoreCandidate(makeCandidate('ac1-accept'), { row: 5, col: 5 }, snapshot, defaultOpts);
    expect(result.feasible).toBe(true);
  });

  it('(AC2) rejects a candidate with positive final-net but mid-trip dip below 0', () => {
    // bot.money=10, minCashRelative=-15 → projectedMin = -5 < 0 → rejected
    // Even though finalCashRelative is positive (trip recovers), min dips too far
    mockSimulateTrip.mockReturnValueOnce({
      turnsToComplete: 5, totalBuildCost: 20, feasible: true,
      minCashRelative: -15, finalCashRelative: 10,
    });
    const snapshot = makeSnapshot({ money: 10 });
    const result = scoreCandidate(makeCandidate('ac2-mid-dip'), { row: 5, col: 5 }, snapshot, defaultOpts);
    expect(result.feasible).toBe(false);
  });

  it('(AC4) game b1dd75b7 fixture: pFish@Oslo pFish@Oslo dFish@Bern dFish@Zurich with bot.money=7M → rejected', () => {
    // Reference: game b1dd75b7 stuck-bot scenario
    // Bot starts with 7M cash. Simulated minCashRelative=-25 (needs 32M to build but only has 7M).
    // projectedMin = 7 + (-25) = -18 < 0 → affordability gate rejects.
    const berthFixtureCandidate = {
      id: 'game-b1dd75b7-fixture',
      rows: [],
      stops: [
        { action: 'pickup' as const, loadType: 'Fish', city: 'Oslo' },
        { action: 'pickup' as const, loadType: 'Fish', city: 'Oslo' },
        { action: 'deliver' as const, loadType: 'Fish', city: 'Bern', demandCardId: 1, payment: 20 },
        { action: 'deliver' as const, loadType: 'Fish', city: 'Zurich', demandCardId: 2, payment: 18 },
      ],
      payout: 38,
    };
    mockSimulateTrip.mockReturnValueOnce({
      turnsToComplete: 12, totalBuildCost: 35, feasible: true,
      minCashRelative: -25,   // bot would need 25M more than it has at the worst point
      finalCashRelative: 13,  // trip is technically profitable overall
    });
    const snapshot = makeSnapshot({ money: 7 });
    const result = scoreCandidate(berthFixtureCandidate, { row: 5, col: 5 }, snapshot, defaultOpts);
    expect(result.feasible).toBe(false);
  });

  it('affordability gate rejection logs exactly once with "unaffordable" in log content', () => {
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    mockSimulateTrip.mockReturnValueOnce({
      turnsToComplete: 8, totalBuildCost: 30, feasible: true,
      minCashRelative: -25, finalCashRelative: -5,
    });
    const snapshot = makeSnapshot({ money: 7 });
    scoreCandidate(makeCandidate('log-test'), { row: 5, col: 5 }, snapshot, defaultOpts);
    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(logSpy.mock.calls[0][0]).toContain('affordability gate rejected');
    expect(logSpy.mock.calls[0][0]).toContain('startingCash=7M');
    logSpy.mockRestore();
  });

  it('optional affordabilityFloorM override: floor=4 rejects candidate whose projectedMin=2', () => {
    // bot.money=10, minCashRelative=-8 → projectedMin=2, but floor=4 → rejected
    mockSimulateTrip.mockReturnValueOnce({
      turnsToComplete: 3, totalBuildCost: 10, feasible: true,
      minCashRelative: -8, finalCashRelative: 5,
    });
    const snapshot = makeSnapshot({ money: 10 });
    const result = scoreCandidate(makeCandidate('floor-override'), { row: 5, col: 5 }, snapshot, defaultOpts, { affordabilityFloorM: 4 });
    expect(result.feasible).toBe(false);
  });

  it('optional affordabilityFloorM override: floor=4 accepts candidate whose projectedMin=5', () => {
    // bot.money=15, minCashRelative=-10 → projectedMin=5 >= floor=4 → accepted
    mockSimulateTrip.mockReturnValueOnce({
      turnsToComplete: 3, totalBuildCost: 12, feasible: true,
      minCashRelative: -10, finalCashRelative: 5,
    });
    const snapshot = makeSnapshot({ money: 15 });
    const result = scoreCandidate(makeCandidate('floor-override-pass'), { row: 5, col: 5 }, snapshot, defaultOpts, { affordabilityFloorM: 4 });
    expect(result.feasible).toBe(true);
  });

  it('simulator throws → returns feasible: false via throw path, NOT the affordability path (no log line)', () => {
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    mockSimulateTrip.mockImplementationOnce(() => {
      throw new Error('Simulator error');
    });
    const snapshot = makeSnapshot({ money: 7 });
    const result = scoreCandidate(makeCandidate('throw-not-afford'), { row: 5, col: 5 }, snapshot, defaultOpts);
    expect(result.feasible).toBe(false);
    // Affordability log must NOT fire — the throw path fires console.warn, not console.log
    expect(logSpy).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0][0]).toContain('simulator threw');
    logSpy.mockRestore();
    warnSpy.mockRestore();
  });

  it('AFFORDABILITY_FLOOR_M constant is exported and equals 0', () => {
    expect(AFFORDABILITY_FLOOR_M).toBe(0);
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
    mockSimulateTrip.mockReturnValue({ turnsToComplete: 3, totalBuildCost: 5, feasible: true, minCashRelative: 0, finalCashRelative: 0 });
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
    mockSimulateTrip.mockReturnValue({ turnsToComplete: 2, totalBuildCost: 5, feasible: true, minCashRelative: 0, finalCashRelative: 0 });
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
    mockSimulateTrip.mockReturnValue({ turnsToComplete: 2, totalBuildCost: 5, feasible: true, minCashRelative: 0, finalCashRelative: 0 });
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
    mockSimulateTrip.mockReturnValue({ turnsToComplete: 2, totalBuildCost: 5, feasible: true, minCashRelative: 0, finalCashRelative: 0 });
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
    mockSimulateTrip.mockReturnValue({ turnsToComplete: 1, totalBuildCost: 0, feasible: true, minCashRelative: 0, finalCashRelative: 0 });
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
    mockSimulateTrip.mockReturnValue({ turnsToComplete: 3, totalBuildCost: 10, feasible: true, minCashRelative: 0, finalCashRelative: 0 });
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

// ── Upgrade emission (JIRA-220 follow-up) ─────────────────────────────

describe('planTripDeterministic — upgrade emission', () => {
  // The standing demand fixture used by the upgrade tests below.
  function upgradeDemands() {
    return [makeDemand({ cardIndex: 1, loadType: 'Steel', deliveryCity: 'DeliveryCity', payout: 30 })];
  }

  it('Freight + cash >= upgradeCost + buildCost → emits upgradeOnRoute=fast_freight', () => {
    mockSimulateTrip.mockReturnValue({ turnsToComplete: 3, totalBuildCost: 10, feasible: true, minCashRelative: 0, finalCashRelative: 0 });
    // 100 cash >= 20 (upgrade) + 10 (build) ✓
    const snapshot = makeSnapshot({ trainType: 'freight', money: 100 });
    const result = planTripDeterministic(snapshot, makeContext(upgradeDemands()), makeMemory());
    expect(result.outcome).toBe('success');
    expect(result.route!.upgradeOnRoute).toBe('fast_freight');
  });

  it('Freight + cash exactly upgradeCost + buildCost → emits upgradeOnRoute (boundary inclusive)', () => {
    mockSimulateTrip.mockReturnValue({ turnsToComplete: 3, totalBuildCost: 10, feasible: true, minCashRelative: 0, finalCashRelative: 0 });
    // 30 cash == 20 + 10 — boundary is inclusive (>= rule).
    const snapshot = makeSnapshot({ trainType: 'freight', money: 30 });
    const result = planTripDeterministic(snapshot, makeContext(upgradeDemands()), makeMemory());
    expect(result.route!.upgradeOnRoute).toBe('fast_freight');
  });

  it('Freight + cash < upgradeCost + buildCost → no upgradeOnRoute', () => {
    mockSimulateTrip.mockReturnValue({ turnsToComplete: 3, totalBuildCost: 15, feasible: true, minCashRelative: 0, finalCashRelative: 0 });
    // 25 cash < 20 + 15 — short by 10.
    const snapshot = makeSnapshot({ trainType: 'freight', money: 25 });
    const result = planTripDeterministic(snapshot, makeContext(upgradeDemands()), makeMemory());
    expect(result.outcome).toBe('success');
    expect(result.route!.upgradeOnRoute).toBeUndefined();
  });

  it('Fast Freight + cash sufficient → emits upgradeOnRoute=superfreight', () => {
    mockSimulateTrip.mockReturnValue({ turnsToComplete: 3, totalBuildCost: 5, feasible: true, minCashRelative: 0, finalCashRelative: 0 });
    const snapshot = makeSnapshot({ trainType: 'fast_freight', money: 50 });
    const result = planTripDeterministic(snapshot, makeContext(upgradeDemands()), makeMemory());
    expect(result.route!.upgradeOnRoute).toBe('superfreight');
  });

  it('Heavy Freight + cash sufficient → emits upgradeOnRoute=superfreight', () => {
    mockSimulateTrip.mockReturnValue({ turnsToComplete: 3, totalBuildCost: 5, feasible: true, minCashRelative: 0, finalCashRelative: 0 });
    const snapshot = makeSnapshot({ trainType: 'heavy_freight', money: 50 });
    const result = planTripDeterministic(snapshot, makeContext(upgradeDemands()), makeMemory());
    expect(result.route!.upgradeOnRoute).toBe('superfreight');
  });

  it('Superfreight (top tier) → never emits upgradeOnRoute', () => {
    mockSimulateTrip.mockReturnValue({ turnsToComplete: 3, totalBuildCost: 5, feasible: true, minCashRelative: 0, finalCashRelative: 0 });
    const snapshot = makeSnapshot({ trainType: 'superfreight', money: 1000 });
    const result = planTripDeterministic(snapshot, makeContext(upgradeDemands()), makeMemory());
    expect(result.route!.upgradeOnRoute).toBeUndefined();
  });

  it('reasoning string mentions the upgrade decision when one is emitted', () => {
    mockSimulateTrip.mockReturnValue({ turnsToComplete: 3, totalBuildCost: 10, feasible: true, minCashRelative: 0, finalCashRelative: 0 });
    const snapshot = makeSnapshot({ trainType: 'freight', money: 100 });
    const result = planTripDeterministic(snapshot, makeContext(upgradeDemands()), makeMemory());
    expect(result.route!.reasoning).toContain('Upgrade emitted: fast_freight');
    expect(result.route!.reasoning).toContain('cost 20M');
  });

  it('reasoning string does NOT mention an upgrade when none is emitted', () => {
    mockSimulateTrip.mockReturnValue({ turnsToComplete: 3, totalBuildCost: 5, feasible: true, minCashRelative: 0, finalCashRelative: 0 });
    const snapshot = makeSnapshot({ trainType: 'superfreight', money: 1000 });
    const result = planTripDeterministic(snapshot, makeContext(upgradeDemands()), makeMemory());
    expect(result.route!.reasoning).not.toContain('Upgrade emitted');
  });
});

// ── Phase-aware OCPT (JIRA-220 follow-up) ──────────────────────────────

describe('planTripDeterministic — phase-aware OCPT', () => {
  function singleDemand() {
    return [makeDemand({ cardIndex: 1, loadType: 'Steel', deliveryCity: 'DeliveryCity', payout: 30 })];
  }

  it('default snapshot (turn=5) classifies as EARLY → reasoning shows OCPT=2', () => {
    mockSimulateTrip.mockReturnValue({ turnsToComplete: 3, totalBuildCost: 5, feasible: true, minCashRelative: 0, finalCashRelative: 0 });
    // Default makeSnapshot: turnNumber=5, deliveries=0, connectedMajorCityCount=0 → EARLY
    const result = planTripDeterministic(makeSnapshot(), makeContext(singleDemand()), makeMemory());
    expect(result.outcome).toBe('success');
    expect(result.route!.reasoning).toContain('Phase: early');
    expect(result.route!.reasoning).toContain('OCPT=2');
  });

  it('mid-game state (turn=30, deliveries=5, cities=3) → reasoning shows OCPT=4', () => {
    mockSimulateTrip.mockReturnValue({ turnsToComplete: 3, totalBuildCost: 5, feasible: true, minCashRelative: 0, finalCashRelative: 0 });
    const base = makeSnapshot();
    const snapshot = { ...base, turnNumber: 30, bot: { ...base.bot, connectedMajorCityCount: 3 } };
    const memory = { ...makeMemory(), deliveryCount: 5 };
    const result = planTripDeterministic(snapshot, makeContext(singleDemand()), memory);
    expect(result.route!.reasoning).toContain('Phase: mid');
    expect(result.route!.reasoning).toContain('OCPT=4');
  });

  it('mid-phase boundary extended — turn=70 with 4 cities still mid (was late before T80 boundary)', () => {
    mockSimulateTrip.mockReturnValue({ turnsToComplete: 3, totalBuildCost: 5, feasible: true, minCashRelative: 0, finalCashRelative: 0 });
    const base = makeSnapshot();
    const snapshot = { ...base, turnNumber: 70, bot: { ...base.bot, connectedMajorCityCount: 4 } };
    const memory = { ...makeMemory(), deliveryCount: 6 };
    const result = planTripDeterministic(snapshot, makeContext(singleDemand()), memory);
    expect(result.route!.reasoning).toContain('Phase: mid');
    expect(result.route!.reasoning).toContain('OCPT=4');
  });

  it('late-game state (cities=5) → reasoning shows OCPT=7', () => {
    mockSimulateTrip.mockReturnValue({ turnsToComplete: 3, totalBuildCost: 5, feasible: true, minCashRelative: 0, finalCashRelative: 0 });
    const base = makeSnapshot();
    const snapshot = { ...base, turnNumber: 50, bot: { ...base.bot, connectedMajorCityCount: 5 } };
    const memory = { ...makeMemory(), deliveryCount: 8 };
    const result = planTripDeterministic(snapshot, makeContext(singleDemand()), memory);
    expect(result.route!.reasoning).toContain('Phase: late');
    expect(result.route!.reasoning).toContain('OCPT=7');
  });

  it('late-game by turn (turn=80, 4 cities) → reasoning shows OCPT=7', () => {
    mockSimulateTrip.mockReturnValue({ turnsToComplete: 3, totalBuildCost: 5, feasible: true, minCashRelative: 0, finalCashRelative: 0 });
    const base = makeSnapshot();
    const snapshot = { ...base, turnNumber: 80, bot: { ...base.bot, connectedMajorCityCount: 4 } };
    const memory = { ...makeMemory(), deliveryCount: 10 };
    const result = planTripDeterministic(snapshot, makeContext(singleDemand()), memory);
    expect(result.route!.reasoning).toContain('Phase: late');
    expect(result.route!.reasoning).toContain('OCPT=7');
  });

  it('options.ocpt overrides phase-derived OCPT (phase still surfaced in reasoning)', () => {
    mockSimulateTrip.mockReturnValue({ turnsToComplete: 3, totalBuildCost: 5, feasible: true, minCashRelative: 0, finalCashRelative: 0 });
    // Default snapshot is EARLY → would normally use OCPT=2. Override to 9.
    const result = planTripDeterministic(makeSnapshot(), makeContext(singleDemand()), makeMemory(), { ocpt: 9 });
    expect(result.route!.reasoning).toContain('Phase: early');
    expect(result.route!.reasoning).toContain('OCPT=9');
  });

  it('score reflects phase-derived OCPT — same fixture scores higher in early than late', () => {
    // Fixture: payout 30, turns 4, build 8 → net = 22
    //   EARLY (OCPT=2): score = 22 - 2*4 = 14
    //   MID   (OCPT=4): score = 22 - 4*4 = 6
    //   LATE  (OCPT=7): score = 22 - 7*4 = -6
    mockSimulateTrip.mockReturnValue({ turnsToComplete: 4, totalBuildCost: 8, feasible: true, minCashRelative: 0, finalCashRelative: 0 });
    const demand = [makeDemand({ cardIndex: 1, loadType: 'Steel', deliveryCity: 'DeliveryCity', payout: 30 })];

    const earlyRes = planTripDeterministic(makeSnapshot(), makeContext(demand), makeMemory());

    const baseMid = makeSnapshot();
    const midSnapshot = { ...baseMid, turnNumber: 30, bot: { ...baseMid.bot, connectedMajorCityCount: 3 } };
    const midRes = planTripDeterministic(midSnapshot, makeContext(demand), { ...makeMemory(), deliveryCount: 5 });

    const baseLate = makeSnapshot();
    const lateSnapshot = { ...baseLate, turnNumber: 50, bot: { ...baseLate.bot, connectedMajorCityCount: 5 } };
    const lateRes = planTripDeterministic(lateSnapshot, makeContext(demand), { ...makeMemory(), deliveryCount: 8 });

    expect(earlyRes.route!.reasoning).toContain('score 14.0');
    expect(midRes.route!.reasoning).toContain('score 6.0');
    expect(lateRes.route!.reasoning).toContain('score -6.0');
  });
});

// ── Cash-aware build cap (JIRA-227 Fix B.1) ─────────────────────────────

describe('planTripDeterministic — cash-aware build cap', () => {
  function singleDemand() {
    return [makeDemand({ cardIndex: 1, loadType: 'Steel', deliveryCity: 'DeliveryCity', payout: 30 })];
  }

  it('cash ≤ static cap (130M) → reasoning reports cap as 130M', () => {
    mockSimulateTrip.mockReturnValue({ turnsToComplete: 3, totalBuildCost: 5, feasible: true, minCashRelative: 0, finalCashRelative: 0 });
    const snapshot = makeSnapshot({ money: 100 });
    const result = planTripDeterministic(snapshot, makeContext(singleDemand()), makeMemory());
    expect(result.outcome).toBe('success');
    expect(result.reasoning).toContain('build > 130M');
  });

  it('cash > static cap (cash=161M) → reasoning reports cap raised to 161M', () => {
    mockSimulateTrip.mockReturnValue({ turnsToComplete: 3, totalBuildCost: 5, feasible: true, minCashRelative: 0, finalCashRelative: 0 });
    const snapshot = makeSnapshot({ money: 161 });
    const result = planTripDeterministic(snapshot, makeContext(singleDemand()), makeMemory());
    expect(result.outcome).toBe('success');
    expect(result.reasoning).toContain('build > 161M');
  });

  it('cash much greater than static cap (cash=300M) → cap tracks cash', () => {
    mockSimulateTrip.mockReturnValue({ turnsToComplete: 3, totalBuildCost: 5, feasible: true, minCashRelative: 0, finalCashRelative: 0 });
    const snapshot = makeSnapshot({ money: 300 });
    const result = planTripDeterministic(snapshot, makeContext(singleDemand()), makeMemory());
    expect(result.outcome).toBe('success');
    expect(result.reasoning).toContain('build > 300M');
  });

  it('low cash (cash=10M) → static floor (130M) holds, cap does NOT shrink below it', () => {
    mockSimulateTrip.mockReturnValue({ turnsToComplete: 3, totalBuildCost: 5, feasible: true, minCashRelative: 0, finalCashRelative: 0 });
    const snapshot = makeSnapshot({ money: 10 });
    const result = planTripDeterministic(snapshot, makeContext(singleDemand()), makeMemory());
    expect(result.outcome).toBe('success');
    expect(result.reasoning).toContain('build > 130M');
  });

  it('options.pruneMaxBuildM override bypasses cash-aware logic', () => {
    mockSimulateTrip.mockReturnValue({ turnsToComplete: 3, totalBuildCost: 5, feasible: true, minCashRelative: 0, finalCashRelative: 0 });
    const snapshot = makeSnapshot({ money: 500 });
    const result = planTripDeterministic(
      snapshot,
      makeContext(singleDemand()),
      makeMemory(),
      { pruneMaxBuildM: 50 },
    );
    expect(result.reasoning).toContain('build > 50M');
  });
});
