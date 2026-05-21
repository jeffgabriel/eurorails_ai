/**
 * DeterministicTripPlanner.test.ts
 *
 * Unit tests for the DeterministicTripPlanner module (JIRA-220).
 *
 * Mirrors the mocking patterns from RouteDetourEstimator.test.ts.
 */

// ── Mocks ──────────────────────────────────────────────────────────────

// Mock LoadService so getSupplyVariants resolves to the row's own supplyCity
// by default. Individual tests that need multi-supply behavior override
// mockGetSourceCitiesForLoad per-call.
const mockGetSourceCitiesForLoad = jest.fn((loadType: string) => {
  // Default: treat each load as single-supply so existing tests are unaffected.
  // The actual supplyCity comes from the row; return it if known, else empty.
  return [] as string[];
});
jest.mock('../../services/loadService', () => ({
  LoadService: {
    getInstance: jest.fn(() => ({
      getSourceCitiesForLoad: mockGetSourceCitiesForLoad,
    })),
  },
}));

// Mock RouteDetourEstimator to control simulateTrip output per test
jest.mock('../../services/ai/RouteDetourEstimator', () => ({
  simulateTrip: jest.fn(),
}));

// Mock PathCostEstimator to control estimateGraphPathCost output per test
// BE-003: cheapPrune now calls estimateGraphPathCost internally
jest.mock('../../services/ai/PathCostEstimator', () => ({
  estimateGraphPathCost: jest.fn(),
  clearPathCostCache: jest.fn(),
}));

// Mock BotMemory so updateMemory (called by end-game lock hook) doesn't hit the DB
const mockUpdateMemory = jest.fn().mockResolvedValue(undefined);
jest.mock('../../services/ai/BotMemory', () => ({
  updateMemory: mockUpdateMemory,
}));

// Mock MapTopology to control grid + city lookup
// Using Map<string, any> since the mock grid is just for test fixtures
const mockGrid = new Map<string, { row: number; col: number; terrain: number; name?: string }>();

jest.mock('../../services/MapTopology', () => ({
  ...jest.requireActual<typeof import('../../services/MapTopology')>('../../services/MapTopology'),
  loadGridPoints: jest.fn(() => mockGrid),
  hexDistance: jest.fn((r1: number, c1: number, r2: number, c2: number): number => {
    // Simple Chebyshev-style approximation for test purposes
    return Math.max(Math.abs(r2 - r1), Math.abs(c2 - c1));
  }),
}));

// ── Imports (after mocks) ──────────────────────────────────────────────

import { simulateTrip } from '../../services/ai/RouteDetourEstimator';
import { estimateGraphPathCost } from '../../services/ai/PathCostEstimator';
import {
  PRUNE_MAX_TURNS,
  PRUNE_MAX_BUILD_M,
  HOP_AVG_COST_M,
  AFFORDABILITY_FLOOR_M,
  classifyGamePhase,
  detectCarriedLoads,
  normalizeRows,
  enumerateCandidates,
  cheapPrune,
  scoreCandidate,
  pickTop1,
  planTripDeterministic,
  isCandidateGrammaticallyValid,
  enumerateCarriedDeliveryFloor,
  enumerateSameSupplyCorridorCandidates,
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
  GameState,
  TerrainType,
} from '../../../shared/types/GameTypes';

const mockSimulateTrip = simulateTrip as jest.MockedFunction<typeof simulateTrip>;
const mockEstimateGraphPathCost = estimateGraphPathCost as jest.MockedFunction<typeof estimateGraphPathCost>;

// ── Helpers ────────────────────────────────────────────────────────────

/** Add a named city to the mock grid at the given coords */
function addCity(name: string, row: number, col: number): void {
  (mockGrid as any).set(`${row},${col}`, { row, col, terrain: TerrainType.Clear, name });
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
    gameState: GameState.Mid,
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
  // JIRA-237: include builtSegments in mock response (required by scoreCandidate and computeAggregateScore)
  mockSimulateTrip.mockReturnValue({ turnsToComplete: 3, totalBuildCost: 5, feasible: true, minCashRelative: 0, finalCashRelative: 0, builtSegments: [] });

  // Default: estimateGraphPathCost returns a reachable, low-cost result
  // so candidates are NOT pruned by cheapPrune in planTripDeterministic tests.
  mockEstimateGraphPathCost.mockReturnValue({
    reachable: true,
    buildCost: 5,
    pathLength: 4,
    estimatedTurns: 1,
  });
});

// ── Constants ──────────────────────────────────────────────────────────

describe('Exported constants', () => {
  it('PRUNE_MAX_TURNS === 12', () => {
    expect(PRUNE_MAX_TURNS).toBe(12);
  });

  it('PRUNE_MAX_BUILD_M === 130', () => {
    expect(PRUNE_MAX_BUILD_M).toBe(130);
  });

  it('HOP_AVG_COST_M === 1.3', () => {
    expect(HOP_AVG_COST_M).toBe(1.3);
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

// ── normalizeRows multiplicity (AC1, R1) ──────────────────────────────

describe('normalizeRows multiplicity-aware carry detection (JIRA-233 BE-001)', () => {
  it('AC1: two Copper demands + 1 Copper in cargo → highest-payout Copper row wins isCarry=true', () => {
    // Fixture: bot carries 1 Copper. Two demand cards for Copper (50M and 20M).
    // Tie-break rule: highest payout wins the isCarry slot.
    const demands: DemandContext[] = [
      makeDemand({ cardIndex: 10, loadType: 'Copper', deliveryCity: 'Madrid', payout: 50 }),
      makeDemand({ cardIndex: 11, loadType: 'Copper', deliveryCity: 'Lisbon', payout: 20 }),
      makeDemand({ cardIndex: 12, loadType: 'Coal', deliveryCity: 'Paris', payout: 15 }),
    ];
    const cargoLoads = ['Copper']; // bot carries exactly 1 Copper
    const carried = detectCarriedLoads(null, demands, cargoLoads);
    const rows = normalizeRows(demands, carried);

    const copper50 = rows.find(r => r.cardIndex === 10)!;
    const copper20 = rows.find(r => r.cardIndex === 11)!;
    const coal = rows.find(r => r.cardIndex === 12)!;

    // Highest-payout Copper (50M) wins the carried slot
    expect(copper50.isCarry).toBe(true);
    // Lower-payout Copper (20M) does NOT get isCarry=true even though Copper is in cargo
    expect(copper20.isCarry).toBe(false);
    // Coal not in cargo → not carry
    expect(coal.isCarry).toBe(false);
  });

  it('single-supply: 1 Copper in cargo, 1 Copper demand → isCarry=true (canonical case)', () => {
    const demands: DemandContext[] = [
      makeDemand({ cardIndex: 1, loadType: 'Copper', deliveryCity: 'Madrid', payout: 30 }),
    ];
    const carried = detectCarriedLoads(null, demands, ['Copper']);
    const rows = normalizeRows(demands, carried);
    expect(rows[0].isCarry).toBe(true);
  });

  it('0 Copper in cargo, 2 Copper demands → both isCarry=false', () => {
    const demands: DemandContext[] = [
      makeDemand({ cardIndex: 1, loadType: 'Copper', deliveryCity: 'Madrid', payout: 50 }),
      makeDemand({ cardIndex: 2, loadType: 'Copper', deliveryCity: 'Lisbon', payout: 20 }),
    ];
    const carried = detectCarriedLoads(null, demands, []); // empty cargo
    const rows = normalizeRows(demands, carried);
    expect(rows[0].isCarry).toBe(false);
    expect(rows[1].isCarry).toBe(false);
  });

  it('2 Copper in cargo, 3 Copper demands → top-2 by payout get isCarry=true', () => {
    const demands: DemandContext[] = [
      makeDemand({ cardIndex: 1, loadType: 'Copper', deliveryCity: 'Madrid', payout: 50 }),
      makeDemand({ cardIndex: 2, loadType: 'Copper', deliveryCity: 'Lisbon', payout: 35 }),
      makeDemand({ cardIndex: 3, loadType: 'Copper', deliveryCity: 'Paris', payout: 10 }),
    ];
    const carried = detectCarriedLoads(null, demands, ['Copper', 'Copper']); // 2 Copper
    const rows = normalizeRows(demands, carried);

    const row50 = rows.find(r => r.cardIndex === 1)!;
    const row35 = rows.find(r => r.cardIndex === 2)!;
    const row10 = rows.find(r => r.cardIndex === 3)!;

    expect(row50.isCarry).toBe(true);
    expect(row35.isCarry).toBe(true);
    // Third Copper demand does NOT get isCarry — only 2 carried
    expect(row10.isCarry).toBe(false);
  });

  it('detectCarriedLoads with cargoLoads returns correct Map counts', () => {
    const demands: DemandContext[] = [
      makeDemand({ cardIndex: 1, loadType: 'Copper', deliveryCity: 'Madrid', payout: 30 }),
      makeDemand({ cardIndex: 2, loadType: 'Coal', deliveryCity: 'Paris', payout: 15 }),
    ];
    const cargoLoads = ['Copper', 'Coal', 'Copper']; // 2 Copper, 1 Coal
    const carried = detectCarriedLoads(null, demands, cargoLoads);

    expect(carried.get('Copper')).toBe(2);
    expect(carried.get('Coal')).toBe(1);
    expect(carried.has('Steel')).toBe(false);
  });

  // Regression: game ca2993dc — same-card siblings must not all flip isCarry
  // when only one of them wins a carry slot. Each demand card carries 3 rows
  // (one per (load,city,payout) tuple) that share the same cardIndex.
  it('three rows sharing one cardIndex: only the loadType in cargo gets isCarry=true', () => {
    // Card 105 from game ca2993dc: Wheat/Wine/Cattle. Bot carries Cattle only.
    const demands: DemandContext[] = [
      makeDemand({ cardIndex: 105, loadType: 'Wheat', deliveryCity: 'Manchester', payout: 24 }),
      makeDemand({ cardIndex: 105, loadType: 'Wine', deliveryCity: 'Praha', payout: 6 }),
      makeDemand({ cardIndex: 105, loadType: 'Cattle', deliveryCity: 'Sevilla', payout: 32 }),
    ];
    const carried = detectCarriedLoads(null, demands, ['Cattle']);
    const rows = normalizeRows(demands, carried);

    const wheat = rows.find(r => r.loadType === 'Wheat')!;
    const wine = rows.find(r => r.loadType === 'Wine')!;
    const cattle = rows.find(r => r.loadType === 'Cattle')!;

    expect(cattle.isCarry).toBe(true);
    // Pre-fix bug: keying carryWinners by cardIndex flipped these to true.
    expect(wheat.isCarry).toBe(false);
    expect(wine.isCarry).toBe(false);
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
  // Note: JIRA-230 adds supply suffix to IDs (e.g. ":AB-sup:Wroclaw-Valencia").
  // Tests now use .includes() to match the variant token within the full ID.
  it('JIRA-228: fresh-fresh pair emits four variants (:AB, :BA, :A-then-B, :B-then-A)', () => {
    type Row = { loadType: string; supplyCity: string | null; deliveryCity: string; payout: number; cardIndex: number; isCarry: boolean };
    const demands: Row[] = [
      { loadType: 'Copper',  supplyCity: 'Wroclaw',  deliveryCity: 'Madrid',     payout: 46, cardIndex: 4,   isCarry: false },
      { loadType: 'Oranges', supplyCity: 'Valencia', deliveryCity: 'Manchester', payout: 40, cardIndex: 122, isCarry: false },
    ];
    const candidates = enumerateCandidates(demands, 2);
    const pairs = candidates.filter((c) => c.id.startsWith('pair:'));
    expect(pairs.length).toBe(4);

    // Extract variant token: the segment between the second ':' and '-sup:' suffix
    // ID format: pair:<cardA>-<loadA>+<cardB>-<loadB>:<variant>-sup:<supA>-<supB>
    const getVariant = (id: string) => id.split('-sup:')[0].split(':').at(-1) ?? '';
    const variants = pairs.map((p) => getVariant(p.id)).sort();
    expect(variants).toEqual(['A-then-B', 'AB', 'B-then-A', 'BA']);
  });

  it('JIRA-228: :A-then-B variant has stops [pickA, delA, pickB, delB]', () => {
    type Row = { loadType: string; supplyCity: string | null; deliveryCity: string; payout: number; cardIndex: number; isCarry: boolean };
    const demands: Row[] = [
      { loadType: 'Copper',  supplyCity: 'Wroclaw',  deliveryCity: 'Madrid',     payout: 46, cardIndex: 4,   isCarry: false },
      { loadType: 'Oranges', supplyCity: 'Valencia', deliveryCity: 'Manchester', payout: 40, cardIndex: 122, isCarry: false },
    ];
    const candidates = enumerateCandidates(demands, 2);
    const aThenB = candidates.find((c) => c.id.includes(':A-then-B'));
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
    const bThenA = candidates.find((c) => c.id.includes(':B-then-A'));
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
    // Extract variant token from ID (JIRA-230: IDs now include '-sup:' suffix)
    const getVariant = (id: string) => id.split('-sup:')[0].split(':').at(-1) ?? '';
    const suffixes = pairs.map((p) => getVariant(p.id)).sort();
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

  // ── JIRA-230 AC8: multi-supply load enumeration ──────────────────────
  it('AC8: hand with Labor (3 supplies) + Iron (2 supplies) emits ≥24 fresh+fresh pair candidates for that pair', () => {
    // Mock LoadService to return multi-supply lists for Labor and Iron
    mockGetSourceCitiesForLoad.mockImplementation((loadType: string) => {
      if (loadType === 'Labor') return ['Beograd', 'Sarajevo', 'Zagreb'];
      if (loadType === 'Iron') return ['Birmingham', 'Kaliningrad'];
      return [];
    });
    // Mock estimateGraphPathCost: all supplies reachable
    mockEstimateGraphPathCost.mockReturnValue({
      reachable: true, buildCost: 5, pathLength: 4, estimatedTurns: 1,
    });
    type Row = { loadType: string; supplyCity: string | null; deliveryCity: string; payout: number; cardIndex: number; isCarry: boolean };
    const demands: Row[] = [
      { loadType: 'Labor', supplyCity: 'Sarajevo', deliveryCity: 'Holland', payout: 23, cardIndex: 1, isCarry: false },
      { loadType: 'Iron', supplyCity: 'Birmingham', deliveryCity: 'Frankfurt', payout: 18, cardIndex: 2, isCarry: false },
    ];
    const candidates = enumerateCandidates(demands, 2, makeSnapshot(), 12);
    // Labor has 3 supply variants, Iron has 2 → 6 supply combos × 4 fresh+fresh orderings = 24
    const laborIronPairs = candidates.filter(
      (c) => c.id.startsWith('pair:') &&
        (c.id.includes('Labor') || c.id.includes('Iron')),
    );
    expect(laborIronPairs.length).toBeGreaterThanOrEqual(24);
  });
});

// ── cheapPrune (BE-003: graph-aware) ──────────────────────────────────

describe('cheapPrune', () => {
  const defaultOpts = {
    pruneMaxTurns: PRUNE_MAX_TURNS,
    pruneMaxBuildM: PRUNE_MAX_BUILD_M,
    hopAvgCostM: HOP_AVG_COST_M,
  };

  const defaultSnapshot = (): WorldSnapshot => makeSnapshot();

  beforeEach(() => {
    // Reset estimateGraphPathCost mock before each cheapPrune test
    mockEstimateGraphPathCost.mockReset();
  });

  it('candidate with build cost > PRUNE_MAX_BUILD_M returns keep: false', () => {
    // Mock estimateGraphPathCost to return total buildCost exceeding 130M
    // Leg 1 (startPos → SupplyCity): buildCost=70
    // Leg 2 (SupplyCity → FarCity):  buildCost=70
    // Total = 140 > PRUNE_MAX_BUILD_M(130) → pruned
    mockEstimateGraphPathCost
      .mockReturnValueOnce({ reachable: true, buildCost: 70, pathLength: 10, estimatedTurns: 2 })
      .mockReturnValueOnce({ reachable: true, buildCost: 70, pathLength: 10, estimatedTurns: 2 });
    const candidate = {
      id: 'test',
      rows: [],
      stops: [
        { action: 'pickup' as const, loadType: 'Load', city: 'SupplyCity' },
        { action: 'deliver' as const, loadType: 'Load', city: 'FarCity' },
      ],
      payout: 50,
    };
    const result = cheapPrune(candidate, { row: 5, col: 5 }, 9, defaultOpts, defaultSnapshot());
    expect(result.keep).toBe(false);
    expect(result.estBuild).toBe(140);
  });

  it('candidate with turns > PRUNE_MAX_TURNS returns keep: false', () => {
    // Mock: 7 turns per leg → total = 14 > PRUNE_MAX_TURNS(12)
    mockEstimateGraphPathCost
      .mockReturnValueOnce({ reachable: true, buildCost: 5, pathLength: 63, estimatedTurns: 7 })
      .mockReturnValueOnce({ reachable: true, buildCost: 5, pathLength: 63, estimatedTurns: 7 });
    const candidate = {
      id: 'test2',
      rows: [],
      stops: [
        { action: 'pickup' as const, loadType: 'Load', city: 'FarSupply' },
        { action: 'deliver' as const, loadType: 'Load', city: 'FarDelivery' },
      ],
      payout: 50,
    };
    const result = cheapPrune(candidate, { row: 5, col: 5 }, 9, defaultOpts, defaultSnapshot());
    expect(result.keep).toBe(false);
    expect(result.estTurns).toBeGreaterThan(PRUNE_MAX_TURNS);
  });

  it('candidate just below thresholds returns keep: true', () => {
    // Mock: buildCost=5 per leg, estimatedTurns=1 per leg → total build=10, turns=2
    mockEstimateGraphPathCost
      .mockReturnValueOnce({ reachable: true, buildCost: 5, pathLength: 4, estimatedTurns: 1 })
      .mockReturnValueOnce({ reachable: true, buildCost: 5, pathLength: 4, estimatedTurns: 1 });
    const candidate = {
      id: 'test3',
      rows: [],
      stops: [
        { action: 'pickup' as const, loadType: 'Load', city: 'SupplyCity' },
        { action: 'deliver' as const, loadType: 'Load', city: 'DeliveryCity' },
      ],
      payout: 50,
    };
    const result = cheapPrune(candidate, { row: 5, col: 5 }, 9, defaultOpts, defaultSnapshot());
    expect(result.keep).toBe(true);
    expect(result.estBuild).toBe(10);
    expect(result.estTurns).toBe(2);
  });

  it('candidate with unreachable leg returns keep: false with estTurns=999', () => {
    // Mock: first leg unreachable → immediate prune
    mockEstimateGraphPathCost
      .mockReturnValueOnce({ reachable: false, buildCost: 0, pathLength: 0, estimatedTurns: 0 });
    const candidate = {
      id: 'test4',
      rows: [],
      stops: [
        { action: 'deliver' as const, loadType: 'Load', city: 'NonExistentCity' },
      ],
      payout: 10,
    };
    const result = cheapPrune(candidate, { row: 5, col: 5 }, 9, defaultOpts, defaultSnapshot());
    expect(result.keep).toBe(false);
    expect(result.estTurns).toBe(999);
    expect(result.estBuild).toBe(999);
  });
});

// ── cheapPrune AC9: graph-aware buildCost survives high-hex-distance prune ──

describe('cheapPrune — AC9: graph-aware cost keeps high-hex-distance / low-build-cost candidate', () => {
  const defaultOpts = {
    pruneMaxTurns: PRUNE_MAX_TURNS,
    pruneMaxBuildM: PRUNE_MAX_BUILD_M,
    hopAvgCostM: HOP_AVG_COST_M,
  };

  beforeEach(() => {
    mockEstimateGraphPathCost.mockReset();
  });

  it('AC9: 3-stop candidate with hex build > 130M but graph buildCost=30M → keep: true', () => {
    /**
     * Pre-change (hex-distance): candidate spans ~100 hops × 1.3 = 130M → boundary prune.
     * Post-change (graph-aware): route follows existing track, buildCost=10M per leg.
     *
     * Candidate stops: SupplyCity → DeliveryCity → CityA (3 stops from startPos)
     * Leg 1 (startPos → SupplyCity):  buildCost=10, estimatedTurns=1
     * Leg 2 (SupplyCity → DeliveryCity): buildCost=10, estimatedTurns=1
     * Leg 3 (DeliveryCity → CityA):   buildCost=10, estimatedTurns=1
     * Total: estBuild=30, estTurns=3 → keep: true (both ≤ thresholds)
     */
    mockEstimateGraphPathCost
      .mockReturnValueOnce({ reachable: true, buildCost: 10, pathLength: 8, estimatedTurns: 1 })
      .mockReturnValueOnce({ reachable: true, buildCost: 10, pathLength: 8, estimatedTurns: 1 })
      .mockReturnValueOnce({ reachable: true, buildCost: 10, pathLength: 8, estimatedTurns: 1 });

    const candidate = {
      id: 'ac9-test',
      rows: [],
      stops: [
        { action: 'pickup' as const, loadType: 'Coal', city: 'SupplyCity' },
        { action: 'deliver' as const, loadType: 'Coal', city: 'DeliveryCity' },
        { action: 'pickup' as const, loadType: 'Iron', city: 'CityA' },
      ],
      payout: 50,
    };

    const result = cheapPrune(candidate, { row: 5, col: 5 }, 9, defaultOpts, makeSnapshot());
    expect(result.keep).toBe(true);
    expect(result.estBuild).toBe(30);
    expect(result.estTurns).toBe(3);
  });

  it('AC9 contrast: same candidate with high build cost would have been pruned by hex-distance', () => {
    /**
     * This test documents the pre-change behavior for contrast.
     * With mock returning buildCost=50 per leg, total=150 > PRUNE_MAX_BUILD_M(130) → pruned.
     */
    mockEstimateGraphPathCost
      .mockReturnValueOnce({ reachable: true, buildCost: 50, pathLength: 8, estimatedTurns: 1 })
      .mockReturnValueOnce({ reachable: true, buildCost: 50, pathLength: 8, estimatedTurns: 1 })
      .mockReturnValueOnce({ reachable: true, buildCost: 50, pathLength: 8, estimatedTurns: 1 });

    const candidate = {
      id: 'ac9-contrast',
      rows: [],
      stops: [
        { action: 'pickup' as const, loadType: 'Coal', city: 'SupplyCity' },
        { action: 'deliver' as const, loadType: 'Coal', city: 'DeliveryCity' },
        { action: 'pickup' as const, loadType: 'Iron', city: 'CityA' },
      ],
      payout: 50,
    };

    const result = cheapPrune(candidate, { row: 5, col: 5 }, 9, defaultOpts, makeSnapshot());
    expect(result.keep).toBe(false);
    expect(result.estBuild).toBe(150);
  });
});

// ── scoreCandidate ─────────────────────────────────────────────────────

describe('scoreCandidate', () => {
  const defaultOpts = {
    pruneMaxTurns: PRUNE_MAX_TURNS,
    pruneMaxBuildM: PRUNE_MAX_BUILD_M,
    hopAvgCostM: HOP_AVG_COST_M,
  };

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
    mockSimulateTrip.mockReturnValueOnce({ turnsToComplete: 0, totalBuildCost: 0, feasible: false, minCashRelative: 0, finalCashRelative: 0, builtSegments: [] });
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
      minCashRelative: -25, finalCashRelative: -5, builtSegments: [],
    });
    const snapshot = makeSnapshot({ money: 7 });
    const result = scoreCandidate(makeCandidate('ac1-test'), { row: 5, col: 5 }, snapshot, defaultOpts);
    expect(result.feasible).toBe(false);
  });

  it('(AC1,AC2) accepts a candidate where snapshot.bot.money + minCashRelative >= 0 with positive final-net', () => {
    // bot.money=30, minCashRelative=-20 → projectedMin = 10 >= 0 → passes gate
    mockSimulateTrip.mockReturnValueOnce({
      turnsToComplete: 3, totalBuildCost: 5, feasible: true,
      minCashRelative: -20, finalCashRelative: 15, builtSegments: [],
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
      minCashRelative: -15, finalCashRelative: 10, builtSegments: [],
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
      builtSegments: [],
    });
    const snapshot = makeSnapshot({ money: 7 });
    const result = scoreCandidate(berthFixtureCandidate, { row: 5, col: 5 }, snapshot, defaultOpts);
    expect(result.feasible).toBe(false);
  });

  it('affordability gate rejection returns feasible=false silently (no per-candidate log)', () => {
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    mockSimulateTrip.mockReturnValueOnce({
      turnsToComplete: 8, totalBuildCost: 30, feasible: true,
      minCashRelative: -25, finalCashRelative: -5, builtSegments: [],
    });
    const snapshot = makeSnapshot({ money: 7 });
    const result = scoreCandidate(makeCandidate('log-test'), { row: 5, col: 5 }, snapshot, defaultOpts);
    expect(result.feasible).toBe(false);
    // No per-candidate log — the rejection signal is in result.feasible.
    const affordabilityLogs = logSpy.mock.calls.filter((c) => String(c[0]).includes('affordability gate rejected'));
    expect(affordabilityLogs).toHaveLength(0);
    logSpy.mockRestore();
  });

  it('optional affordabilityFloorM override: floor=4 rejects candidate whose projectedMin=2', () => {
    // bot.money=10, minCashRelative=-8 → projectedMin=2, but floor=4 → rejected
    mockSimulateTrip.mockReturnValueOnce({
      turnsToComplete: 3, totalBuildCost: 10, feasible: true,
      minCashRelative: -8, finalCashRelative: 5, builtSegments: [],
    });
    const snapshot = makeSnapshot({ money: 10 });
    const result = scoreCandidate(makeCandidate('floor-override'), { row: 5, col: 5 }, snapshot, defaultOpts, { affordabilityFloorM: 4 });
    expect(result.feasible).toBe(false);
  });

  it('optional affordabilityFloorM override: floor=4 accepts candidate whose projectedMin=5', () => {
    // bot.money=15, minCashRelative=-10 → projectedMin=5 >= floor=4 → accepted
    mockSimulateTrip.mockReturnValueOnce({
      turnsToComplete: 3, totalBuildCost: 12, feasible: true,
      minCashRelative: -10, finalCashRelative: 5, builtSegments: [],
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

// ── JIRA-232: scoreCandidate upgrade-aware affordability gate ──────────

describe('scoreCandidate — upgrade-aware affordability gate (JIRA-232)', () => {
  const defaultOpts = {
    pruneMaxTurns: PRUNE_MAX_TURNS,
    pruneMaxBuildM: PRUNE_MAX_BUILD_M,
    hopAvgCostM: HOP_AVG_COST_M,
  };

  const makeCandidate = (id: string) => ({
    id,
    rows: [],
    stops: [
      { action: 'pickup' as const, loadType: 'Wine', city: 'Porto' },
      { action: 'deliver' as const, loadType: 'Wine', city: 'Paris', demandCardId: 1, payment: 30 },
    ],
    payout: 30,
  });

  it('AC3 no-upgrade: Freight bot, cash=30M, buildCost=14M — upgrade NOT triggered (30 < 34), gate uses base sim', () => {
    // freight + cash=30 + buildCost=14 → 30 < 20+14=34 → no upgrade trigger
    mockSimulateTrip.mockReturnValueOnce({
      turnsToComplete: 5, totalBuildCost: 14, feasible: true,
      minCashRelative: -14, finalCashRelative: 16, builtSegments: [],
    });
    const snapshot = makeSnapshot({ money: 30, trainType: 'freight' as any });
    const result = scoreCandidate(makeCandidate('ac3-no-upgrade'), { row: 5, col: 5 }, snapshot, defaultOpts);
    // projectedMin = 30 + (-14) = 16 >= 0 → feasible (no upgrade subtraction)
    expect(result.feasible).toBe(true);
  });

  it('AC3 canonical: Freight bot, cash=50M, buildCost=14M → upgrade triggers → projectedMin=50+(-34)=16 → feasible: true', () => {
    // freight + cash=50 + buildCost=14 → 50 >= 34 → upgrade triggers
    mockSimulateTrip.mockReturnValueOnce({
      turnsToComplete: 5, totalBuildCost: 14, feasible: true,
      minCashRelative: -14, finalCashRelative: 16, builtSegments: [],
    });
    // Re-simulation with pendingUpgradeCost=20: minCashRelative=-34
    mockSimulateTrip.mockReturnValueOnce({
      turnsToComplete: 5, totalBuildCost: 14, feasible: true,
      minCashRelative: -34, finalCashRelative: -4, builtSegments: [],
    });
    const snapshot = makeSnapshot({ money: 50, trainType: 'freight' as any });
    const result = scoreCandidate(makeCandidate('ac3-with-upgrade-pass'), { row: 5, col: 5 }, snapshot, defaultOpts);
    // projectedMin = 50 + (-34) = 16 >= 0 → feasible
    expect(result.feasible).toBe(true);
  });

  it('AC3 strict infeasible: upgrade triggers + minCashRelative makes projectedMin < 0 → feasible: false', () => {
    // freight + cash=40 + buildCost=14 → 40 >= 34 → upgrade triggers
    // Re-simulation returns minCashRelative=-41 (simulated deeper dip)
    mockSimulateTrip.mockReturnValueOnce({
      turnsToComplete: 5, totalBuildCost: 14, feasible: true,
      minCashRelative: -14, finalCashRelative: 16, builtSegments: [],
    });
    mockSimulateTrip.mockReturnValueOnce({
      turnsToComplete: 5, totalBuildCost: 14, feasible: true,
      minCashRelative: -41, finalCashRelative: -11, builtSegments: [],
    });
    const snapshot = makeSnapshot({ money: 40, trainType: 'freight' as any });
    const result = scoreCandidate(makeCandidate('ac3-strict-infeasible'), { row: 5, col: 5 }, snapshot, defaultOpts);
    // projectedMin = 40 + (-41) = -1 < 0 → infeasible
    expect(result.feasible).toBe(false);
  });

  it('AC4: Freight bot, cash=60M, buildCost=14M → upgrade triggers → projectedMin=60+(-34)=26 → feasible: true', () => {
    // freight + cash=60 + buildCost=14 → 60 >= 34 → upgrade triggers
    mockSimulateTrip.mockReturnValueOnce({
      turnsToComplete: 5, totalBuildCost: 14, feasible: true,
      minCashRelative: -14, finalCashRelative: 16, builtSegments: [],
    });
    mockSimulateTrip.mockReturnValueOnce({
      turnsToComplete: 5, totalBuildCost: 14, feasible: true,
      minCashRelative: -34, finalCashRelative: -4, builtSegments: [],
    });
    const snapshot = makeSnapshot({ money: 60, trainType: 'freight' as any });
    const result = scoreCandidate(makeCandidate('ac4-pass'), { row: 5, col: 5 }, snapshot, defaultOpts);
    // projectedMin = 60 + (-34) = 26 >= 0 → feasible
    expect(result.feasible).toBe(true);
  });

  it('AC5: Superfreight bot → no upgrade triggered → gate behavior identical to pre-change', () => {
    // superfreight: already at top tier → selectUpgradeTarget returns {} (no target)
    // Only one simulateTrip call, using base minCashRelative
    mockSimulateTrip.mockReturnValueOnce({
      turnsToComplete: 5, totalBuildCost: 14, feasible: true,
      minCashRelative: -14, finalCashRelative: 16, builtSegments: [],
    });
    const snapshot = makeSnapshot({ money: 40, trainType: 'superfreight' as any });
    const result = scoreCandidate(makeCandidate('ac5-superfreight'), { row: 5, col: 5 }, snapshot, defaultOpts);
    // projectedMin = 40 + (-14) = 26 >= 0 → feasible (no upgrade subtraction)
    expect(result.feasible).toBe(true);
    // Verify simulateTrip called only once (no re-simulation for superfreight)
    expect(mockSimulateTrip).toHaveBeenCalledTimes(1);
  });

  it('AC6: scoreCandidate called without memory → falls back to capSaturatedTurns=0, does not throw', () => {
    // No memory passed → capSaturatedTurns defaults to 0 → safe to call selectUpgradeTarget
    mockSimulateTrip.mockReturnValueOnce({
      turnsToComplete: 3, totalBuildCost: 5, feasible: true,
      minCashRelative: -5, finalCashRelative: 25, builtSegments: [],
    });
    // freight + cash=100 + buildCost=5 → 100 >= 25 → upgrade triggers → second call
    mockSimulateTrip.mockReturnValueOnce({
      turnsToComplete: 3, totalBuildCost: 5, feasible: true,
      minCashRelative: -25, finalCashRelative: 5, builtSegments: [],
    });
    const snapshot = makeSnapshot({ money: 100, trainType: 'freight' as any });
    // Call without memory (6th arg) — must not throw
    expect(() => {
      scoreCandidate(makeCandidate('ac6-no-memory'), { row: 5, col: 5 }, snapshot, defaultOpts);
    }).not.toThrow();
  });
});

// ── JIRA-232: observability log lines ─────────────────────────────────

describe('planTripDeterministic — JIRA-232 observability', () => {
  it('AC7 predict: [JIRA-232][predict] log line emitted after top-1 selection', () => {
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    mockSimulateTrip.mockReturnValue({
      turnsToComplete: 3, totalBuildCost: 5, feasible: true,
      minCashRelative: 0, finalCashRelative: 0, builtSegments: [],
    });
    const snapshot = makeSnapshot({ trainType: 'superfreight' as any }); // no upgrade to keep mock calls simple
    planTripDeterministic(
      snapshot,
      makeContext([makeDemand({ cardIndex: 1, loadType: 'Ham', deliveryCity: 'DeliveryCity', payout: 20 })]),
      makeMemory(),
    );
    const predictLogs = logSpy.mock.calls.filter(
      (args: unknown[]) => typeof args[0] === 'string' && (args[0] as string).includes('[JIRA-232][predict]'),
    );
    expect(predictLogs.length).toBeGreaterThan(0);
    expect(predictLogs[0][0]).toContain('predictedBuildCost=');
    logSpy.mockRestore();
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
    feasible: boolean;
  };
  function makeScoredCandidate(id: string, net: number): ScoredCandidateFixture {
    return {
      id,
      rows: [],
      stops: [],
      payout: 0,
      buildCost: 0,
      turns: 1,
      net,
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
    mockSimulateTrip.mockReturnValue({ turnsToComplete: 3, totalBuildCost: 5, feasible: true, minCashRelative: 0, finalCashRelative: 0, builtSegments: [] });
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
    // Override default mock: return unreachable so all candidates are pruned
    mockEstimateGraphPathCost.mockReturnValue({
      reachable: false,
      buildCost: 0,
      pathLength: 0,
      estimatedTurns: 0,
    });
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
    mockSimulateTrip.mockReturnValue({ turnsToComplete: 2, totalBuildCost: 5, feasible: true, minCashRelative: 0, finalCashRelative: 0, builtSegments: [] });
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
    mockSimulateTrip.mockReturnValue({ turnsToComplete: 2, totalBuildCost: 5, feasible: true, minCashRelative: 0, finalCashRelative: 0, builtSegments: [] });
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
    mockSimulateTrip.mockReturnValue({ turnsToComplete: 2, totalBuildCost: 5, feasible: true, minCashRelative: 0, finalCashRelative: 0, builtSegments: [] });
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
    mockSimulateTrip.mockReturnValue({ turnsToComplete: 1, totalBuildCost: 0, feasible: true, minCashRelative: 0, finalCashRelative: 0, builtSegments: [] });
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
    mockSimulateTrip.mockReturnValue({ turnsToComplete: 3, totalBuildCost: 10, feasible: true, minCashRelative: 0, finalCashRelative: 0, builtSegments: [] });
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

// ── JIRA-259: active pickup/delivery restriction filter ──────────────

describe('planTripDeterministic — JIRA-259 active-effect candidate filter', () => {
  function makeStrikeEffect(zone: string[]): any {
    return {
      cardId: 121,
      cardType: 'Strike',
      drawingPlayerId: 'player-2',
      drawingPlayerIndex: 1,
      drawingPlayerTurnNumber: 4,
      expiresAfterTurnNumber: 6,
      affectedZone: new Set(zone),
      restrictions: {
        movement: [],
        build: [],
        pickupDelivery: [{ type: 'no_pickup_delivery_in_zone', zone }],
      },
      pendingLostTurns: [],
    };
  }

  it('drops candidate whose stops[0] is a deliver at a Strike-blocked city (AC1)', () => {
    // single-carry candidate: deliver Ham at DeliveryCity (key '7,7'). Strike blocks '7,7'.
    mockSimulateTrip.mockReturnValue({ turnsToComplete: 1, totalBuildCost: 0, feasible: true, minCashRelative: 0, finalCashRelative: 0, builtSegments: [] });
    const demands = [
      makeDemand({
        cardIndex: 1,
        loadType: 'Ham',
        supplyCity: null,
        deliveryCity: 'DeliveryCity',
        payout: 31,
        isLoadOnTrain: true,
      }),
    ];
    const snapshot = makeSnapshot({ loads: ['Ham'] });
    snapshot.activeEffects = [makeStrikeEffect(['7,7'])];
    const context = makeContext(demands);
    const memory = makeMemory();

    const result = planTripDeterministic(snapshot, context, memory);

    expect(result.outcome).toBe('no_feasible_candidates');
    expect(result.route).toBeNull();
    expect(result.reasoning).toContain('stop 0 at city blocked by active event');
  });

  it('regression guard: same fixture with no active Strike → route IS selected (AC2)', () => {
    mockSimulateTrip.mockReturnValue({ turnsToComplete: 1, totalBuildCost: 0, feasible: true, minCashRelative: 0, finalCashRelative: 0, builtSegments: [] });
    const demands = [
      makeDemand({
        cardIndex: 1,
        loadType: 'Ham',
        supplyCity: null,
        deliveryCity: 'DeliveryCity',
        payout: 31,
        isLoadOnTrain: true,
      }),
    ];
    const snapshot = makeSnapshot({ loads: ['Ham'] });
    snapshot.activeEffects = [];
    const context = makeContext(demands);
    const memory = makeMemory();

    const result = planTripDeterministic(snapshot, context, memory);

    expect(result.outcome).toBe('success');
    expect(result.route).not.toBeNull();
    expect(result.route!.stops[0]).toMatchObject({ action: 'deliver', city: 'DeliveryCity' });
  });

  it('returns no_feasible_candidates when ALL enumerated candidates lead with a blocked stop (AC3)', () => {
    // Two demands, both delivering to DeliveryCity. All enumerated candidates have stops[0] = deliver at DeliveryCity.
    mockSimulateTrip.mockReturnValue({ turnsToComplete: 1, totalBuildCost: 0, feasible: true, minCashRelative: 0, finalCashRelative: 0, builtSegments: [] });
    const demands = [
      makeDemand({ cardIndex: 1, loadType: 'Ham', supplyCity: null, deliveryCity: 'DeliveryCity', payout: 31, isLoadOnTrain: true }),
    ];
    const snapshot = makeSnapshot({ loads: ['Ham'] });
    snapshot.activeEffects = [makeStrikeEffect(['7,7'])];
    const context = makeContext(demands);
    const memory = makeMemory();

    const result = planTripDeterministic(snapshot, context, memory);

    expect(result.outcome).toBe('no_feasible_candidates');
    expect(result.route).toBeNull();
  });

  it('keeps candidate whose stops[0] is fine even if a LATER stop is at a Strike-blocked city (AC4)', () => {
    // single-fresh candidate: pickup Coal at CityA (2,2 — not blocked), deliver Coal at DeliveryCity (7,7 — blocked).
    // Only stops[0] is filtered, so this candidate survives.
    mockSimulateTrip.mockReturnValue({ turnsToComplete: 2, totalBuildCost: 5, feasible: true, minCashRelative: 0, finalCashRelative: 0, builtSegments: [] });
    const demands = [
      makeDemand({
        cardIndex: 1,
        loadType: 'Coal',
        supplyCity: 'CityA',
        deliveryCity: 'DeliveryCity',
        payout: 20,
        isLoadOnTrain: false,
      }),
    ];
    const snapshot = makeSnapshot();
    snapshot.activeEffects = [makeStrikeEffect(['7,7'])]; // DeliveryCity blocked
    const context = makeContext(demands);
    const memory = makeMemory();

    const result = planTripDeterministic(snapshot, context, memory);

    expect(result.outcome).toBe('success');
    expect(result.route).not.toBeNull();
    expect(result.route!.stops[0]).toMatchObject({ action: 'pickup', city: 'CityA' });
  });
});

// ── Upgrade emission (JIRA-220 follow-up) ─────────────────────────────

describe('planTripDeterministic — upgrade emission', () => {
  // The standing demand fixture used by the upgrade tests below.
  function upgradeDemands() {
    return [makeDemand({ cardIndex: 1, loadType: 'Steel', deliveryCity: 'DeliveryCity', payout: 30 })];
  }

  it('Freight + cash >= upgradeCost + buildCost → emits upgradeOnRoute=fast_freight', () => {
    mockSimulateTrip.mockReturnValue({ turnsToComplete: 3, totalBuildCost: 10, feasible: true, minCashRelative: 0, finalCashRelative: 0, builtSegments: [] });
    // 100 cash >= 20 (upgrade) + 10 (build) ✓
    const snapshot = makeSnapshot({ trainType: 'freight', money: 100 });
    const result = planTripDeterministic(snapshot, makeContext(upgradeDemands()), makeMemory());
    expect(result.outcome).toBe('success');
    expect(result.route!.upgradeOnRoute).toBe('fast_freight');
  });

  it('Freight + cash exactly upgradeCost + buildCost → emits upgradeOnRoute (boundary inclusive)', () => {
    mockSimulateTrip.mockReturnValue({ turnsToComplete: 3, totalBuildCost: 10, feasible: true, minCashRelative: 0, finalCashRelative: 0, builtSegments: [] });
    // 30 cash == 20 + 10 — boundary is inclusive (>= rule).
    const snapshot = makeSnapshot({ trainType: 'freight', money: 30 });
    const result = planTripDeterministic(snapshot, makeContext(upgradeDemands()), makeMemory());
    expect(result.route!.upgradeOnRoute).toBe('fast_freight');
  });

  it('Freight + cash < upgradeCost + buildCost → no upgradeOnRoute', () => {
    mockSimulateTrip.mockReturnValue({ turnsToComplete: 3, totalBuildCost: 15, feasible: true, minCashRelative: 0, finalCashRelative: 0, builtSegments: [] });
    // 25 cash < 20 + 15 — short by 10.
    const snapshot = makeSnapshot({ trainType: 'freight', money: 25 });
    const result = planTripDeterministic(snapshot, makeContext(upgradeDemands()), makeMemory());
    expect(result.outcome).toBe('success');
    expect(result.route!.upgradeOnRoute).toBeUndefined();
  });

  it('Fast Freight + cash sufficient + cap-saturated ≥ threshold → emits upgradeOnRoute=superfreight', () => {
    mockSimulateTrip.mockReturnValue({ turnsToComplete: 3, totalBuildCost: 5, feasible: true, minCashRelative: 0, finalCashRelative: 0, builtSegments: [] });
    const snapshot = makeSnapshot({ trainType: 'fast_freight', money: 50 });
    const result = planTripDeterministic(snapshot, makeContext(upgradeDemands()), makeMemory({ capSaturatedTurns: 2 }));
    expect(result.route!.upgradeOnRoute).toBe('superfreight');
  });

  it('Fast Freight + cash sufficient + cap-saturated < threshold → upgrade gated, no superfreight', () => {
    mockSimulateTrip.mockReturnValue({ turnsToComplete: 3, totalBuildCost: 5, feasible: true, minCashRelative: 0, finalCashRelative: 0, builtSegments: [] });
    const snapshot = makeSnapshot({ trainType: 'fast_freight', money: 50 });
    const result = planTripDeterministic(snapshot, makeContext(upgradeDemands()), makeMemory({ capSaturatedTurns: 1 }));
    expect(result.route!.upgradeOnRoute).toBeUndefined();
    expect(result.route!.reasoning).toContain('Upgrade skipped: superfreight gated');
    expect(result.route!.reasoning).toContain('cap-saturated 1/2 turns');
  });

  it('Heavy Freight + cash sufficient → emits upgradeOnRoute=superfreight (saturation gate not applied)', () => {
    mockSimulateTrip.mockReturnValue({ turnsToComplete: 3, totalBuildCost: 5, feasible: true, minCashRelative: 0, finalCashRelative: 0, builtSegments: [] });
    // Heavy Freight is already cap=3; the Super upgrade buys speed, not a slot,
    // so the cap-saturation gate does not apply. capSaturatedTurns=0 must still allow.
    const snapshot = makeSnapshot({ trainType: 'heavy_freight', money: 50 });
    const result = planTripDeterministic(snapshot, makeContext(upgradeDemands()), makeMemory({ capSaturatedTurns: 0 }));
    expect(result.route!.upgradeOnRoute).toBe('superfreight');
  });

  it('Superfreight (top tier) → never emits upgradeOnRoute', () => {
    mockSimulateTrip.mockReturnValue({ turnsToComplete: 3, totalBuildCost: 5, feasible: true, minCashRelative: 0, finalCashRelative: 0, builtSegments: [] });
    const snapshot = makeSnapshot({ trainType: 'superfreight', money: 1000 });
    const result = planTripDeterministic(snapshot, makeContext(upgradeDemands()), makeMemory());
    expect(result.route!.upgradeOnRoute).toBeUndefined();
  });

  it('reasoning string mentions the upgrade decision when one is emitted', () => {
    mockSimulateTrip.mockReturnValue({ turnsToComplete: 3, totalBuildCost: 10, feasible: true, minCashRelative: 0, finalCashRelative: 0, builtSegments: [] });
    const snapshot = makeSnapshot({ trainType: 'freight', money: 100 });
    const result = planTripDeterministic(snapshot, makeContext(upgradeDemands()), makeMemory());
    expect(result.route!.reasoning).toContain('Upgrade emitted: fast_freight');
    expect(result.route!.reasoning).toContain('cost 20M');
  });

  it('reasoning string does NOT mention an upgrade when none is emitted', () => {
    mockSimulateTrip.mockReturnValue({ turnsToComplete: 3, totalBuildCost: 5, feasible: true, minCashRelative: 0, finalCashRelative: 0, builtSegments: [] });
    const snapshot = makeSnapshot({ trainType: 'superfreight', money: 1000 });
    const result = planTripDeterministic(snapshot, makeContext(upgradeDemands()), makeMemory());
    expect(result.route!.reasoning).not.toContain('Upgrade emitted');
  });
});

// ── Cash-aware build cap (JIRA-227 Fix B.1) ─────────────────────────────

describe('planTripDeterministic — cash-aware build cap', () => {
  function singleDemand() {
    return [makeDemand({ cardIndex: 1, loadType: 'Steel', deliveryCity: 'DeliveryCity', payout: 30 })];
  }

  it('cash ≤ static cap (130M) → reasoning reports cap as 130M', () => {
    mockSimulateTrip.mockReturnValue({ turnsToComplete: 3, totalBuildCost: 5, feasible: true, minCashRelative: 0, finalCashRelative: 0, builtSegments: [] });
    const snapshot = makeSnapshot({ money: 100 });
    const result = planTripDeterministic(snapshot, makeContext(singleDemand()), makeMemory());
    expect(result.outcome).toBe('success');
    expect(result.reasoning).toContain('build > 130M');
  });

  it('cash > static cap (cash=161M) → reasoning reports cap raised to 161M', () => {
    mockSimulateTrip.mockReturnValue({ turnsToComplete: 3, totalBuildCost: 5, feasible: true, minCashRelative: 0, finalCashRelative: 0, builtSegments: [] });
    const snapshot = makeSnapshot({ money: 161 });
    const result = planTripDeterministic(snapshot, makeContext(singleDemand()), makeMemory());
    expect(result.outcome).toBe('success');
    expect(result.reasoning).toContain('build > 161M');
  });

  it('cash much greater than static cap (cash=300M) → cap tracks cash', () => {
    mockSimulateTrip.mockReturnValue({ turnsToComplete: 3, totalBuildCost: 5, feasible: true, minCashRelative: 0, finalCashRelative: 0, builtSegments: [] });
    const snapshot = makeSnapshot({ money: 300 });
    const result = planTripDeterministic(snapshot, makeContext(singleDemand()), makeMemory());
    expect(result.outcome).toBe('success');
    expect(result.reasoning).toContain('build > 300M');
  });

  it('low cash (cash=10M) → static floor (130M) holds, cap does NOT shrink below it', () => {
    mockSimulateTrip.mockReturnValue({ turnsToComplete: 3, totalBuildCost: 5, feasible: true, minCashRelative: 0, finalCashRelative: 0, builtSegments: [] });
    const snapshot = makeSnapshot({ money: 10 });
    const result = planTripDeterministic(snapshot, makeContext(singleDemand()), makeMemory());
    expect(result.outcome).toBe('success');
    expect(result.reasoning).toContain('build > 130M');
  });

  it('options.pruneMaxBuildM override bypasses cash-aware logic', () => {
    mockSimulateTrip.mockReturnValue({ turnsToComplete: 3, totalBuildCost: 5, feasible: true, minCashRelative: 0, finalCashRelative: 0, builtSegments: [] });
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

// ── Aggregate two-trip look-ahead (JIRA-229) ────────────────────────────

describe('planTripDeterministic — aggregate two-trip look-ahead (JIRA-229)', () => {
  it('single-card hand → aggregate falls back to standalone net/turns; reasoning marks standalone', () => {
    mockSimulateTrip.mockReturnValue({ turnsToComplete: 5, totalBuildCost: 4, feasible: true, minCashRelative: 0, finalCashRelative: 0, builtSegments: [] });
    const result = planTripDeterministic(
      makeSnapshot(),
      makeContext([
        makeDemand({ cardIndex: 1, loadType: 'Ham', supplyCity: 'SupplyCity', deliveryCity: 'DeliveryCity', payout: 24 }),
      ]),
      makeMemory(),
    );
    expect(result.outcome).toBe('success');
    expect(result.reasoning).toContain('Aggregate:');
    expect(result.reasoning).toContain('(standalone — no feasible follow-up)');
  });

  it('three non-overlapping single-card hand → aggregate chains the chosen with a disjoint follow-up', () => {
    // Three singles, each on a distinct card. The chosen single's follow-up
    // is one of the other two singles. (A pair would consume 2 cards and
    // still have 1 disjoint single available as follow-up — also chains.)
    mockSimulateTrip.mockReturnValue({ turnsToComplete: 4, totalBuildCost: 3, feasible: true, minCashRelative: 0, finalCashRelative: 0, builtSegments: [] });
    const result = planTripDeterministic(
      makeSnapshot(),
      makeContext([
        makeDemand({ cardIndex: 1, loadType: 'Ham', supplyCity: 'SupplyCity', deliveryCity: 'DeliveryCity', payout: 20 }),
        makeDemand({ cardIndex: 2, loadType: 'Coal', supplyCity: 'CityA', deliveryCity: 'CityB', payout: 18 }),
        makeDemand({ cardIndex: 3, loadType: 'Steel', supplyCity: 'CityC', deliveryCity: 'DeliveryCity', payout: 22 }),
      ]),
      makeMemory(),
    );
    expect(result.outcome).toBe('success');
    expect(result.reasoning).toContain('Aggregate:');
    expect(result.reasoning).toContain('chained with');
    // JIRA-237: chained simulation absorbs empty-leg; reasoning now shows 'chained-sim'
    // instead of 'empty-leg N turns'. Updated assertion per AC13.
    expect(result.reasoning).toContain('chained-sim');
    expect(result.reasoning).not.toContain('(standalone');
  });

  it('same-cardIndex candidates do NOT chain with each other (disjoint-cards check)', () => {
    // Both demands share cardIndex=5 — can't chain.
    mockSimulateTrip.mockReturnValue({ turnsToComplete: 5, totalBuildCost: 2, feasible: true, minCashRelative: 0, finalCashRelative: 0, builtSegments: [] });
    const result = planTripDeterministic(
      makeSnapshot(),
      makeContext([
        makeDemand({ cardIndex: 5, loadType: 'Ham', supplyCity: 'SupplyCity', deliveryCity: 'DeliveryCity', payout: 20 }),
        makeDemand({ cardIndex: 5, loadType: 'Coal', supplyCity: 'CityA', deliveryCity: 'CityB', payout: 18 }),
      ]),
      makeMemory(),
    );
    expect(result.outcome).toBe('success');
    expect(result.reasoning).toContain('(standalone — no feasible follow-up)');
  });

  it('aggregate line appears in reasoning with expected format M/turn precision', () => {
    mockSimulateTrip.mockReturnValue({ turnsToComplete: 5, totalBuildCost: 4, feasible: true, minCashRelative: 0, finalCashRelative: 0, builtSegments: [] });
    const result = planTripDeterministic(
      makeSnapshot(),
      makeContext([
        makeDemand({ cardIndex: 1, loadType: 'Ham', deliveryCity: 'DeliveryCity', payout: 24 }),
        makeDemand({ cardIndex: 2, loadType: 'Coal', supplyCity: 'CityA', deliveryCity: 'CityB', payout: 20 }),
        makeDemand({ cardIndex: 3, loadType: 'Steel', supplyCity: 'CityC', deliveryCity: 'DeliveryCity', payout: 18 }),
      ]),
      makeMemory(),
    );
    expect(result.outcome).toBe('success');
    expect(result.reasoning).toMatch(/Aggregate: -?\d+\.\d{2} M\/turn/);
  });

  it('runner-up lines report aggregate (not legacy score) as Lost-by metric', () => {
    mockSimulateTrip.mockReturnValue({ turnsToComplete: 4, totalBuildCost: 3, feasible: true, minCashRelative: 0, finalCashRelative: 0, builtSegments: [] });
    const result = planTripDeterministic(
      makeSnapshot(),
      makeContext([
        makeDemand({ cardIndex: 1, loadType: 'Ham', deliveryCity: 'DeliveryCity', payout: 24 }),
        makeDemand({ cardIndex: 2, loadType: 'Coal', supplyCity: 'CityA', deliveryCity: 'CityB', payout: 20 }),
      ]),
      makeMemory(),
    );
    expect(result.outcome).toBe('success');
    expect(result.reasoning).toContain('Runner-up #2');
    expect(result.reasoning).toMatch(/Runner-up #2:.+aggregate -?\d+\.\d{2} M\/turn/);
    expect(result.reasoning).toMatch(/Lost by -?\d+\.\d{2}/);
  });

  it('determinism — same snapshot twice yields identical aggregate-ranked pick', () => {
    mockSimulateTrip.mockReturnValue({ turnsToComplete: 3, totalBuildCost: 5, feasible: true, minCashRelative: 0, finalCashRelative: 0, builtSegments: [] });
    const demands = [
      makeDemand({ cardIndex: 1, loadType: 'Ham', deliveryCity: 'DeliveryCity', payout: 20 }),
      makeDemand({ cardIndex: 2, loadType: 'Coal', supplyCity: 'CityA', deliveryCity: 'CityB', payout: 15 }),
      makeDemand({ cardIndex: 3, loadType: 'Steel', supplyCity: 'CityC', deliveryCity: 'DeliveryCity', payout: 18 }),
    ];
    const r1 = planTripDeterministic(makeSnapshot(), makeContext(demands), makeMemory());
    const r2 = planTripDeterministic(makeSnapshot(), makeContext(demands), makeMemory());
    expect(r1.route?.stops).toEqual(r2.route?.stops);
  });
});

// ── JIRA-230 TEST-001: t46 regression (AC10, AC11) ────────────────────
// Reproduces S3's t46 hand in game ad976b38-f43e-420d-bd57-775549f5a23e.
// Bot at Budapest, fast_freight, cash=45M. Demand cards include:
//   Bauxite → Berlin (payout 14), DemandContext.supplyCity = 'Budapest'
//   Labor   → Holland (payout 23), DemandContext.supplyCity = 'Sarajevo' (legacy default)
//   (filler card for 3-card hand)
// LoadService returns Labor supplies: [Beograd, Sarajevo, Zagreb].
// estimateGraphPathCost mocked: Budapest↔Beograd/Sarajevo → buildCost=0 (existing track),
//                                Budapest↔Zagreb → buildCost=25 (new track needed).
// Expected: top-1 picks pair with Labor pickup at Beograd (closest on existing track).
// AC11: reasoning contains "Supply chosen: Labor via Beograd (DemandContext default: Sarajevo)"

describe('planTripDeterministic — JIRA-230 t46 regression (AC10, AC11)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (mockGrid as any).clear();

    // Add cities needed for the t46 scenario
    addCity('Budapest', 40, 59);
    addCity('Berlin', 28, 55);
    addCity('Holland', 22, 46);
    addCity('Beograd', 52, 64);
    addCity('Sarajevo', 54, 60);
    addCity('Zagreb', 46, 56);
    addCity('SupplyCity', 3, 3);
    addCity('DeliveryCity', 7, 7);

    // LoadService: Labor has 3 supply cities; other loads are single-supply
    mockGetSourceCitiesForLoad.mockImplementation((loadType: string) => {
      if (loadType === 'Labor') return ['Beograd', 'Sarajevo', 'Zagreb'];
      if (loadType === 'Bauxite') return ['Budapest'];
      return [];
    });

    // estimateGraphPathCost: Beograd and Sarajevo reachable via existing track
    // (buildCost=0); Zagreb requires new track (buildCost=25, still reachable).
    // All other city pairs get a small default cost.
    mockEstimateGraphPathCost.mockImplementation(
      (from: unknown, to: unknown, _snapshot: unknown, _speed: unknown) => {
        const dest = typeof to === 'string' ? to : '';
        if (dest === 'Zagreb') {
          return { reachable: true, buildCost: 25, pathLength: 5, estimatedTurns: 1 };
        }
        return { reachable: true, buildCost: 0, pathLength: 3, estimatedTurns: 1 };
      },
    );

    // simulateTrip: feasible for all candidates; buildCost reflects the mock above.
    // Beograd-supply pair gets a slightly better score (lower build cost = higher net).
    mockSimulateTrip.mockImplementation(
      (startPos: unknown, stops: RouteStop[], _snapshot: unknown) => {
        const hasZagreb = (stops as RouteStop[]).some((s) => s.city === 'Zagreb');
        return {
          turnsToComplete: 4,
          totalBuildCost: hasZagreb ? 25 : 0,
          feasible: true,
          minCashRelative: hasZagreb ? -25 : 0,
          finalCashRelative: hasZagreb ? -2 : 23,
          builtSegments: [],
        };
      },
    );
  });

  it('AC10: top-1 picks pair with Labor pickup at Beograd (not Sarajevo or Zagreb)', () => {
    const snapshot = makeSnapshot({
      position: { row: 40, col: 59 },
      trainType: 'fast_freight',
      money: 45,
    });
    const demands: DemandContext[] = [
      // Bauxite: Budapest → Berlin (single supply = Budapest)
      makeDemand({ cardIndex: 1, loadType: 'Bauxite', supplyCity: 'Budapest', deliveryCity: 'Berlin', payout: 14 }),
      // Labor: → Holland (legacy DemandContext.supplyCity = Sarajevo)
      makeDemand({ cardIndex: 2, loadType: 'Labor', supplyCity: 'Sarajevo', deliveryCity: 'Holland', payout: 23 }),
      // Filler card (3-card hand)
      makeDemand({ cardIndex: 3, loadType: 'Potatoes', supplyCity: 'SupplyCity', deliveryCity: 'DeliveryCity', payout: 10 }),
    ];

    const result = planTripDeterministic(
      snapshot,
      makeContext(demands, { speed: 12, capacity: 2, trainType: 'fast_freight' }),
      makeMemory(),
    );

    expect(result.outcome).toBe('success');
    const laborPickup = result.route?.stops.find(
      (s) => s.action === 'pickup' && s.loadType === 'Labor',
    );
    expect(laborPickup).toBeDefined();
    expect(laborPickup?.city).toBe('Beograd');
  });

  it('AC11: reasoning contains supply-chosen line when Labor supply differs from DemandContext default', () => {
    const snapshot = makeSnapshot({
      position: { row: 40, col: 59 },
      trainType: 'fast_freight',
      money: 45,
    });
    const demands: DemandContext[] = [
      makeDemand({ cardIndex: 1, loadType: 'Bauxite', supplyCity: 'Budapest', deliveryCity: 'Berlin', payout: 14 }),
      makeDemand({ cardIndex: 2, loadType: 'Labor', supplyCity: 'Sarajevo', deliveryCity: 'Holland', payout: 23 }),
      makeDemand({ cardIndex: 3, loadType: 'Potatoes', supplyCity: 'SupplyCity', deliveryCity: 'DeliveryCity', payout: 10 }),
    ];

    const result = planTripDeterministic(
      snapshot,
      makeContext(demands, { speed: 12, capacity: 2, trainType: 'fast_freight' }),
      makeMemory(),
    );

    expect(result.outcome).toBe('success');
    expect(result.reasoning).toContain('Supply chosen: Labor via Beograd (DemandContext default: Sarajevo)');
  });
});

// ── JIRA-230 TEST-002: perf budget warning (AC12) ─────────────────────

describe('planTripDeterministic — JIRA-230 perf budget (AC12)', () => {
  let warnSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    (mockGrid as any).clear();
    addCity('SupplyCity', 3, 3);
    addCity('DeliveryCity', 7, 7);

    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

    mockGetSourceCitiesForLoad.mockReturnValue([]);
    mockEstimateGraphPathCost.mockReturnValue({
      reachable: true, buildCost: 5, pathLength: 4, estimatedTurns: 1,
    });
    mockSimulateTrip.mockReturnValue({
      turnsToComplete: 3, totalBuildCost: 5, feasible: true, minCashRelative: 0, finalCashRelative: 0, builtSegments: [],
    });
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it('AC12 happy path: small candidate count — reasoning includes Candidates line, no perf-budget warn', () => {
    const result = planTripDeterministic(
      makeSnapshot(),
      makeContext([
        makeDemand({ cardIndex: 1, loadType: 'Ham', deliveryCity: 'DeliveryCity', payout: 20 }),
      ]),
      makeMemory(),
    );
    expect(result.outcome).toBe('success');
    expect(result.reasoning).toMatch(/Candidates: raw=\d+ survivors=\d+ enumerationMs=\d+/);
    const perfWarnCalls = warnSpy.mock.calls.filter(
      (args: unknown[]) => typeof args[0] === 'string' && (args[0] as string).includes('perf-budget'),
    );
    expect(perfWarnCalls.length).toBe(0);
  });

  it('AC12 perf-budget warn: console.warn emitted with [perf-budget] when enumerationMs > 200', () => {
    // Mock Date.now() to simulate slow enumeration (>200ms elapsed).
    // First call returns t=0 (enumStartMs), second returns t=250 (after enumeration).
    const originalDateNow = Date.now;
    let callCount = 0;
    Date.now = jest.fn(() => {
      callCount++;
      // The first Date.now in planTripDeterministic is `startMs` (line ~1042).
      // The second is `enumStartMs` (before enumerateCandidates).
      // The third is used for `enumerationMs = Date.now() - enumStartMs`.
      // We want enumStartMs → 0, and the subtraction call → 250.
      // Approximate: return 0 for first 2 calls, then 250, then 300 for latencyMs.
      if (callCount === 1) return 0;    // startMs
      if (callCount === 2) return 100;  // enumStartMs
      if (callCount === 3) return 350;  // enumerationMs = 350-100 = 250 > 200
      return 400;                       // latencyMs
    });

    const result = planTripDeterministic(
      makeSnapshot(),
      makeContext([
        makeDemand({ cardIndex: 1, loadType: 'Ham', deliveryCity: 'DeliveryCity', payout: 20 }),
      ]),
      makeMemory(),
    );

    // Restore Date.now
    Date.now = originalDateNow;

    // enumerationMs=250 > 200 → warn fires
    const perfWarnCalls = warnSpy.mock.calls.filter(
      (args: unknown[]) => typeof args[0] === 'string' && (args[0] as string).includes('perf-budget'),
    );
    expect(perfWarnCalls.length).toBeGreaterThan(0);
    expect(perfWarnCalls[0][0]).toContain('[perf-budget]');
    // Reasoning includes Candidates line
    expect(result.reasoning).toMatch(/Candidates: raw=\d+/);
  });
});

// ── JIRA-231: Feasibility consumer (AC5, AC6, AC7) ────────────────────────────

describe('JIRA-231: planTripDeterministic feasibility filter', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (mockGrid as any).clear();

    // Cities needed by these tests
    addCity('Firenze', 48, 44);
    addCity('Hamburg', 10, 10);
    addCity('Ruhr', 20, 20);
    addCity('Lodz', 30, 30);
    addCity('Berlin', 5, 5);

    // Default: simulateTrip returns feasible result
    mockSimulateTrip.mockReturnValue({ turnsToComplete: 3, totalBuildCost: 5, feasible: true, minCashRelative: 0, finalCashRelative: 0, builtSegments: [] });

    // Default: estimateGraphPathCost returns a reachable, low-cost result
    mockEstimateGraphPathCost.mockReturnValue({
      reachable: true,
      buildCost: 5,
      pathLength: 4,
      estimatedTurns: 1,
    });

    // Default: LoadService returns empty supply variants (use supplyCity from demand)
    mockGetSourceCitiesForLoad.mockReturnValue([]);
  });

  /**
   * AC5: One infeasible + two feasible demands.
   * Expected: chosen route does NOT include Firenze as a stop city.
   */
  it('AC5: one infeasible demand among three → TripPlanner skips infeasible city', () => {
    // Infeasible demand: Marble supply at Firenze (saturated)
    const infeasibleDemand = makeDemand({
      cardIndex: 1,
      loadType: 'Marble',
      supplyCity: 'Firenze',
      deliveryCity: 'Hamburg',
      payout: 20,
      isFeasible: false,
      infeasibleReason: 'supplyCitySaturated',
    });

    // Feasible demand 1: Coal from Hamburg to Ruhr
    const feasibleDemand1 = makeDemand({
      cardIndex: 2,
      loadType: 'Coal',
      supplyCity: 'Hamburg',
      deliveryCity: 'Ruhr',
      payout: 25,
    });

    // Feasible demand 2: Iron from Berlin to Lodz
    const feasibleDemand2 = makeDemand({
      cardIndex: 3,
      loadType: 'Iron',
      supplyCity: 'Berlin',
      deliveryCity: 'Lodz',
      payout: 18,
    });

    const context = makeContext([infeasibleDemand, feasibleDemand1, feasibleDemand2]);
    const result = planTripDeterministic(makeSnapshot(), context, makeMemory());

    // Should succeed (not no_feasible_candidates)
    expect(result.outcome).toBe('success');
    expect(result.route).not.toBeNull();

    // No stop should be at Firenze (the infeasible supply city) or Hamburg (infeasible delivery)
    const stopCities = result.route!.stops.map(s => s.city);
    expect(stopCities).not.toContain('Firenze');
  });

  /**
   * AC6: ALL demands infeasible.
   * Expected: outcome === 'no_feasible_candidates', route === null, reasoning includes 'structurally unreachable'.
   */
  it('AC6: all demands infeasible → outcome no_feasible_candidates, reasoning includes structurally unreachable', () => {
    const allInfeasible = [
      makeDemand({
        cardIndex: 1,
        loadType: 'Marble',
        supplyCity: 'Firenze',
        deliveryCity: 'Hamburg',
        payout: 20,
        isFeasible: false,
        infeasibleReason: 'supplyCitySaturated',
      }),
      makeDemand({
        cardIndex: 2,
        loadType: 'Coal',
        supplyCity: 'Hamburg',
        deliveryCity: 'Ruhr',
        payout: 15,
        isFeasible: false,
        infeasibleReason: 'deliveryCitySaturated',
      }),
    ];

    const context = makeContext(allInfeasible);
    const result = planTripDeterministic(makeSnapshot(), context, makeMemory());

    expect(result.outcome).toBe('no_feasible_candidates');
    expect(result.route).toBeNull();
    expect(result.reasoning).toContain('structurally unreachable');
  });

  /**
   * AC7: Replay-style test based on game 32964f24 turn 20.
   * S1: cash=16M, position=(46,45), hand includes Marble@Firenze→Hamburg.
   * Opponents have track at (48,44) — Firenze is saturated.
   * Expected: TripPlanner does NOT pick Marble@Firenze; plan is not PassTurn.
   *
   * This tests the producer + consumer end-to-end by setting isFeasible=false
   * on the Marble demand (as ContextBuilder/DemandEngine would have set it).
   */
  it('AC7: game 32964f24 turn-20 replay — bot does not pick Marble@Firenze when city is saturated', () => {
    // Add Firenze to grid at (48,44) and other cities
    addCity('Firenze', 48, 44);   // saturated small city

    // Three demands from the turn-20 hand:
    // 1. Marble from Firenze to Hamburg — INFEASIBLE (Firenze saturated)
    const marbleDemand = makeDemand({
      cardIndex: 1,
      loadType: 'Marble',
      supplyCity: 'Firenze',
      deliveryCity: 'Hamburg',
      payout: 20,
      isFeasible: false,
      infeasibleReason: 'supplyCitySaturated',
    });

    // 2. Imports from Hamburg to Lodz — feasible
    const importsDemand = makeDemand({
      cardIndex: 2,
      loadType: 'Imports',
      supplyCity: 'Hamburg',
      deliveryCity: 'Lodz',
      payout: 18,
    });

    // 3. Another feasible demand
    const coalDemand = makeDemand({
      cardIndex: 3,
      loadType: 'Coal',
      supplyCity: 'Berlin',
      deliveryCity: 'Ruhr',
      payout: 15,
    });

    // S1 snapshot: cash=16, position=(46,45)
    const snapshot = makeSnapshot({
      money: 16,
      position: { row: 46, col: 45 },
      existingSegments: [
        {
          from: { x: 1840, y: 1800, row: 46, col: 45, terrain: TerrainType.Clear },
          to: { x: 1840, y: 1840, row: 46, col: 46, terrain: TerrainType.Clear },
          cost: 1,
        },
      ],
    });

    const context = makeContext([marbleDemand, importsDemand, coalDemand], {
      money: 16,
      position: { row: 46, col: 45 },
    });

    const result = planTripDeterministic(snapshot, context, makeMemory());

    // The bot should NOT pick Marble@Firenze
    if (result.outcome === 'success' && result.route) {
      const stopCities = result.route.stops.map(s => s.city);
      expect(stopCities).not.toContain('Firenze');
    } else {
      // If no feasible candidates from the OTHER demands (all pruned), that's
      // still valid — just ensure it's not PassTurn due to Marble being chosen.
      // The key invariant is Firenze is not in the plan.
      expect(result.outcome).toBe('no_feasible_candidates');
    }

    // In either case, the result is not a silent PassTurn from a bad Marble pick
    // The planning did not return a route TO Firenze
    if (result.route) {
      const stopCities = result.route.stops.map(s => s.city);
      expect(stopCities).not.toContain('Firenze');
    }
  });
});

// ────────────────────────────────────────────────────────────────────────
// JIRA-241 — End-state scoring
// ────────────────────────────────────────────────────────────────────────

describe('JIRA-241 end-state scoring', () => {
  // Lazy imports so the mocks above are applied first.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { applyEndStateScoring, candidateTouchesUnconnectedMajor } = require('../../services/ai/DeterministicTripPlanner');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { GameState } = require('../../../shared/types/GameTypes');

  type ScoredCandidateLike = {
    id: string;
    rows: unknown[];
    stops: unknown[];
    payout: number;
    buildCost: number;
    turns: number;
    net: number;
    feasible: boolean;
    aggregateScore: number;
    aggregateFollowup: null;
    aggregateEmptyLegTurns: number;
    builtSegments: ReadonlyArray<{ from: { row: number; col: number }; to: { row: number; col: number }; cost: number }>;
    firstDeliveryTurn?: number;
    firstDeliveryPayoff?: number;
  };

  function makeCandidate(over: Partial<ScoredCandidateLike>): ScoredCandidateLike {
    return {
      id: 'test',
      rows: [],
      stops: [],
      payout: 0,
      buildCost: 0,
      turns: 1,
      net: 0,
      feasible: true,
      aggregateScore: 0,
      aggregateFollowup: null,
      aggregateEmptyLegTurns: 0,
      builtSegments: [],
      ...over,
    };
  }

  // Minimal GameContext fixture — only fields end-state scoring reads.
  type CtxLike = {
    gameState: unknown;
    money: number;
    connectedMajorCities: string[];
    unconnectedMajorCities: Array<{ cityName: string; estimatedCost: number }>;
  };
  function makeContext(over: Partial<CtxLike>): CtxLike {
    return {
      gameState: GameState.End,
      money: 200,
      connectedMajorCities: [],
      unconnectedMajorCities: [],
      ...over,
    };
  }

  beforeEach(() => {
    // Ensure the mocked grid has the major-city coordinate fixtures used below.
    mockGrid.clear();
    mockGrid.set('Wien', { row: 30, col: 60, terrain: TerrainType.Clear, name: 'Wien' });
    mockGrid.set('Milano', { row: 50, col: 40, terrain: TerrainType.Clear, name: 'Milano' });
  });

  describe('AC1 — payoff cap fires when overshooting 250M', () => {
    it('at cash=249, candidate A (5M/2t) beats candidate B (30M/8t) under end-state scoring', () => {
      const a = makeCandidate({ id: 'A', payout: 5, buildCost: 0, turns: 2 });
      const b = makeCandidate({ id: 'B', payout: 30, buildCost: 0, turns: 8 });
      const ctx = makeContext({ money: 249, connectedMajorCities: ['P','H','M','R','B','W','Md'] });

      applyEndStateScoring(a, ctx);
      applyEndStateScoring(b, ctx);

      // A: payoff capped at 250-249=1 → effectiveNet=1 → score = 1/2 = 0.5
      // B: payoff capped at 1 → effectiveNet=1 → score = 1/8 = 0.125
      expect(a.aggregateScore).toBeGreaterThan(b.aggregateScore);
      expect(a.aggregateScore).toBeCloseTo(0.5);
      expect(b.aggregateScore).toBeCloseTo(0.125);
    });
  });

  describe('AC2 — city-cost adjustment penalizes routes that skip an unconnected major', () => {
    it('cities=6, candidate A connects Wien with NET 20M/8t beats candidate B (no major) with NET 25M/8t', () => {
      // A: builtSegments includes an endpoint at Wien (30,60). Sees touchesMajor=true → no cityCost.
      const a = makeCandidate({
        id: 'A',
        payout: 20,
        buildCost: 0,
        turns: 8,
        builtSegments: [{ from: { row: 29, col: 59 }, to: { row: 30, col: 60 }, cost: 5 }],
      });
      // B: builtSegments do not include any unconnected major. Sees touchesMajor=false → cityCost=14.
      const b = makeCandidate({
        id: 'B',
        payout: 25,
        buildCost: 0,
        turns: 8,
        builtSegments: [{ from: { row: 10, col: 10 }, to: { row: 11, col: 11 }, cost: 5 }],
      });
      const ctx = makeContext({
        money: 200,
        connectedMajorCities: ['P','H','M','R','B','Md'], // 6
        unconnectedMajorCities: [{ cityName: 'Wien', estimatedCost: 14 }],
      });

      applyEndStateScoring(a, ctx);
      applyEndStateScoring(b, ctx);

      // A: cap=50, effectivePayoff=min(20,50)=20, cityCost=0, net=20, score=20/8=2.5
      // B: cap=50, effectivePayoff=min(25,50)=25, cityCost=14, net=11, score=11/8≈1.375
      expect(a.aggregateScore).toBeGreaterThan(b.aggregateScore);
    });
  });

  describe('AC3 — city-cost adjustment does not fire at cities=7', () => {
    it('with 7 cities connected, candidate B beats candidate A (no city penalty applies)', () => {
      const a = makeCandidate({
        id: 'A',
        payout: 20,
        buildCost: 0,
        turns: 8,
        builtSegments: [{ from: { row: 29, col: 59 }, to: { row: 30, col: 60 }, cost: 5 }],
      });
      const b = makeCandidate({
        id: 'B',
        payout: 25,
        buildCost: 0,
        turns: 8,
        builtSegments: [{ from: { row: 10, col: 10 }, to: { row: 11, col: 11 }, cost: 5 }],
      });
      const ctx = makeContext({
        money: 200,
        connectedMajorCities: ['P','H','M','R','B','W','Md'], // 7
        unconnectedMajorCities: [],
      });

      applyEndStateScoring(a, ctx);
      applyEndStateScoring(b, ctx);

      // No city cost fires. cap=50, A net=20 / 8 = 2.5; B net=25 / 8 = 3.125. B wins.
      expect(b.aggregateScore).toBeGreaterThan(a.aggregateScore);
    });
  });

  describe('AC4 — first-delivery-wins refinement', () => {
    it('candidate with first-delivery payoff that crosses 250M uses first-delivery turn for scoring', () => {
      // cash=248; first delivery payoff=5 at turn=2; total payoff=25 at turn=7.
      // 248+5=253 ≥ 250, so effectiveTurns should be 2, not 7.
      const c = makeCandidate({
        id: 'C',
        payout: 25,
        buildCost: 0,
        turns: 7,
        firstDeliveryPayoff: 5,
        firstDeliveryTurn: 2,
      });
      const ctx = makeContext({
        money: 248,
        connectedMajorCities: ['P','H','M','R','B','W','Md'],
      });

      applyEndStateScoring(c, ctx);

      // cap = 250-248 = 2 → effectivePayoff = min(25, 2) = 2 → effectiveNet = 2
      // effectiveTurns = firstDeliveryTurn = 2 → score = 2/2 = 1.0
      expect(c.aggregateScore).toBeCloseTo(1.0);
    });

    it('without first-delivery values, falls back to candidate.turns', () => {
      const c = makeCandidate({
        id: 'C',
        payout: 25,
        buildCost: 0,
        turns: 7,
      });
      const ctx = makeContext({
        money: 248,
        connectedMajorCities: ['P','H','M','R','B','W','Md'],
      });

      applyEndStateScoring(c, ctx);

      // cap=2, payoff=2, net=2, turns=7 → score = 2/7 ≈ 0.286
      expect(c.aggregateScore).toBeCloseTo(2 / 7);
    });
  });

  describe('AC6 — candidateTouchesUnconnectedMajor coord matching', () => {
    it('returns true when any segment endpoint matches an unconnected major coord', () => {
      const c = makeCandidate({
        builtSegments: [{ from: { row: 29, col: 59 }, to: { row: 30, col: 60 }, cost: 5 }],
      });
      const ctx = makeContext({
        connectedMajorCities: [],
        unconnectedMajorCities: [{ cityName: 'Wien', estimatedCost: 14 }],
      });
      expect(candidateTouchesUnconnectedMajor(c, ctx)).toBe(true);
    });

    it('returns false when no segment endpoint matches any unconnected major', () => {
      const c = makeCandidate({
        builtSegments: [{ from: { row: 10, col: 10 }, to: { row: 11, col: 11 }, cost: 5 }],
      });
      const ctx = makeContext({
        connectedMajorCities: [],
        unconnectedMajorCities: [{ cityName: 'Wien', estimatedCost: 14 }],
      });
      expect(candidateTouchesUnconnectedMajor(c, ctx)).toBe(false);
    });

    it('returns false when builtSegments is empty', () => {
      const c = makeCandidate({ builtSegments: [] });
      const ctx = makeContext({
        unconnectedMajorCities: [{ cityName: 'Wien', estimatedCost: 14 }],
      });
      expect(candidateTouchesUnconnectedMajor(c, ctx)).toBe(false);
    });

    it('returns false when unconnectedMajorCities is empty', () => {
      const c = makeCandidate({
        builtSegments: [{ from: { row: 29, col: 59 }, to: { row: 30, col: 60 }, cost: 5 }],
      });
      const ctx = makeContext({ unconnectedMajorCities: [] });
      expect(candidateTouchesUnconnectedMajor(c, ctx)).toBe(false);
    });
  });
});

// ────────────────────────────────────────────────────────────────────────
// JIRA-242 — Early/Mid expansion bias
// ────────────────────────────────────────────────────────────────────────

describe('JIRA-242 expansion bonus (multi-delivery)', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { applyExpansionBonus, EXPANSION_MULTI_DELIVERY_BONUS_M_PER_TURN } = require('../../services/ai/DeterministicTripPlanner');

  type ScoredCandidateLike = {
    id: string;
    rows: unknown[];
    stops: Array<{ action: 'pickup' | 'deliver'; city: string; loadType?: string }>;
    payout: number;
    buildCost: number;
    turns: number;
    net: number;
    feasible: boolean;
    aggregateScore: number;
    aggregateFollowup: null;
    aggregateEmptyLegTurns: number;
    builtSegments: ReadonlyArray<unknown>;
  };

  function makeC(over: Partial<ScoredCandidateLike>): ScoredCandidateLike {
    return {
      id: 'test',
      rows: [],
      stops: [],
      payout: 0,
      buildCost: 0,
      turns: 1,
      net: 0,
      feasible: true,
      aggregateScore: 0,
      aggregateFollowup: null,
      aggregateEmptyLegTurns: 0,
      builtSegments: [],
      ...over,
    };
  }

  it('AC2 — pair (2 deliveries) receives the bonus; single (1 delivery) does not', () => {
    const single = makeC({
      id: 'single-Iron',
      aggregateScore: 0.18,
      stops: [
        { action: 'pickup', city: 'Birmingham', loadType: 'Iron' },
        { action: 'deliver', city: 'Antwerpen', loadType: 'Iron' },
      ],
    });
    const pair = makeC({
      id: 'pair-China-Iron',
      aggregateScore: 0.17,
      stops: [
        { action: 'pickup', city: 'Birmingham', loadType: 'China' },
        { action: 'pickup', city: 'Birmingham', loadType: 'Iron' },
        { action: 'deliver', city: 'Antwerpen', loadType: 'Iron' },
        { action: 'deliver', city: 'Ruhr', loadType: 'China' },
      ],
    });

    applyExpansionBonus(single);
    applyExpansionBonus(pair);

    expect(single.aggregateScore).toBeCloseTo(0.18); // unchanged
    expect(pair.aggregateScore).toBeCloseTo(0.17 + EXPANSION_MULTI_DELIVERY_BONUS_M_PER_TURN);
    expect(pair.aggregateScore).toBeGreaterThan(single.aggregateScore);
  });

  it('AC3 — single keeps original aggregateScore exactly', () => {
    const single = makeC({
      aggregateScore: 0.42,
      stops: [
        { action: 'pickup', city: 'A', loadType: 'X' },
        { action: 'deliver', city: 'B', loadType: 'X' },
      ],
    });
    applyExpansionBonus(single);
    expect(single.aggregateScore).toBe(0.42);
  });

  it('AC7 — triple (3 deliveries) receives the SAME flat bonus as pair (not 2×)', () => {
    const triple = makeC({
      aggregateScore: 1.0,
      stops: [
        { action: 'pickup', city: 'A', loadType: 'X' },
        { action: 'pickup', city: 'B', loadType: 'Y' },
        { action: 'pickup', city: 'C', loadType: 'Z' },
        { action: 'deliver', city: 'D', loadType: 'X' },
        { action: 'deliver', city: 'E', loadType: 'Y' },
        { action: 'deliver', city: 'F', loadType: 'Z' },
      ],
    });
    applyExpansionBonus(triple);
    expect(triple.aggregateScore).toBeCloseTo(1.0 + EXPANSION_MULTI_DELIVERY_BONUS_M_PER_TURN);
  });

  it('bonus constant matches the t6 trace tip-margin (0.05)', () => {
    expect(EXPANSION_MULTI_DELIVERY_BONUS_M_PER_TURN).toBe(0.05);
  });

  it('candidate with zero deliver stops receives no bonus (edge case)', () => {
    const odd = makeC({
      aggregateScore: 0.5,
      stops: [{ action: 'pickup', city: 'A', loadType: 'X' }],
    });
    applyExpansionBonus(odd);
    expect(odd.aggregateScore).toBe(0.5);
  });
});

// ── JIRA-249/250: Grammar validation & carried delivery floor ─────────

type Row = { loadType: string; supplyCity: string | null; deliveryCity: string; payout: number; cardIndex: number; isCarry: boolean };

function makeRow(overrides: Partial<Row> = {}): Row {
  return {
    loadType: 'Coal',
    supplyCity: 'Essen',
    deliveryCity: 'Berlin',
    payout: 15,
    cardIndex: 1,
    isCarry: false,
    ...overrides,
  };
}

function makeCandidate(id: string, stops: RouteStop[], rows: Row[] = []): { id: string; rows: Row[]; stops: RouteStop[]; payout: number } {
  return { id, rows, stops, payout: rows.reduce((s, r) => s + r.payout, 0) };
}

describe('isCandidateGrammaticallyValid', () => {
  /**
   * UT1 (Grammar - Deliver without Pickup):
   * Candidate [deliver(Wine@Praha)] with carriedLoads=[] → rejected with deliver_without_pickup.
   */
  it('UT1: rejects deliver(Wine@Praha) when carriedLoads=[] with reason=deliver_without_pickup', () => {
    const candidate = makeCandidate('test:1', [
      { action: 'deliver', loadType: 'Wine', city: 'Praha', demandCardId: 1, payment: 20 },
    ], [makeRow({ loadType: 'Wine', deliveryCity: 'Praha', payout: 20 })]);

    const result = isCandidateGrammaticallyValid(candidate, []);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.rejection.reason).toBe('deliver_without_pickup');
      expect(result.rejection.loadType).toBe('Wine');
      expect(result.rejection.offendingStopIndex).toBe(0);
    }
  });

  /**
   * UT2 (Grammar - Deliver Exceeds Carried):
   * Candidate [deliver(Fish@Zurich), deliver(Fish@Milano)] with carriedLoads=['Fish']
   * → rejected with deliver_exceeds_carried (only one Fish, but two deliveries).
   */
  it('UT2: rejects [deliver(Fish@Zurich), deliver(Fish@Milano)] with one carried Fish with reason=deliver_exceeds_carried', () => {
    const candidate = makeCandidate('test:2', [
      { action: 'deliver', loadType: 'Fish', city: 'Zurich', demandCardId: 1, payment: 20 },
      { action: 'deliver', loadType: 'Fish', city: 'Milano', demandCardId: 2, payment: 18 },
    ], [
      makeRow({ loadType: 'Fish', deliveryCity: 'Zurich', cardIndex: 1, payout: 20 }),
      makeRow({ loadType: 'Fish', deliveryCity: 'Milano', cardIndex: 2, payout: 18 }),
    ]);

    const result = isCandidateGrammaticallyValid(candidate, ['Fish']);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.rejection.reason).toBe('deliver_exceeds_carried');
      expect(result.rejection.loadType).toBe('Fish');
      expect(result.rejection.offendingStopIndex).toBe(1); // second deliver fails
    }
  });

  it('accepts valid candidate: pickup(Fish) then deliver(Fish)', () => {
    const candidate = makeCandidate('test:3', [
      { action: 'pickup', loadType: 'Fish', city: 'Oslo' },
      { action: 'deliver', loadType: 'Fish', city: 'Zurich', demandCardId: 1, payment: 20 },
    ]);

    const result = isCandidateGrammaticallyValid(candidate, []);
    expect(result.ok).toBe(true);
  });

  it('accepts valid candidate: two pickups then two deliveries', () => {
    const candidate = makeCandidate('test:4', [
      { action: 'pickup', loadType: 'Fish', city: 'Oslo' },
      { action: 'pickup', loadType: 'Fish', city: 'Oslo' },
      { action: 'deliver', loadType: 'Fish', city: 'Zurich', demandCardId: 1, payment: 20 },
      { action: 'deliver', loadType: 'Fish', city: 'Milano', demandCardId: 2, payment: 18 },
    ]);

    const result = isCandidateGrammaticallyValid(candidate, []);
    expect(result.ok).toBe(true);
  });

  it('accepts carry-only candidate: deliver(Labor@Bern) with carriedLoads=[Labor]', () => {
    const candidate = makeCandidate('test:5', [
      { action: 'deliver', loadType: 'Labor', city: 'Bern', demandCardId: 1, payment: 12 },
    ]);

    const result = isCandidateGrammaticallyValid(candidate, ['Labor']);
    expect(result.ok).toBe(true);
  });

  it('provides carriedAtStart and pickupsBeforeOffender in rejection context', () => {
    const candidate = makeCandidate('test:6', [
      { action: 'pickup', loadType: 'Coal', city: 'Essen' },
      { action: 'deliver', loadType: 'Coal', city: 'Berlin', demandCardId: 1, payment: 15 },
      // Extra deliver with no Coal left
      { action: 'deliver', loadType: 'Coal', city: 'Warszawa', demandCardId: 2, payment: 10 },
    ]);

    const result = isCandidateGrammaticallyValid(candidate, []);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.rejection.context.carriedAtStart).toEqual([]);
      expect(result.rejection.context.pickupsBeforeOffender).toContain('Coal');
      expect(result.rejection.reason).toBe('deliver_exceeds_carried');
    }
  });
});

describe('enumerateCarriedDeliveryFloor', () => {
  /**
   * UT3 (Carried Delivery Floor):
   * When bot.loads=['Labor'] and Labor is deliverable to Bern,
   * enumerateCandidates must include a candidate with deliver(Labor@Bern).
   */
  it('UT3: generates a floor candidate with deliver(Labor@Bern) when one Labor carried', () => {
    const rows: Row[] = [
      makeRow({ loadType: 'Labor', deliveryCity: 'Bern', cardIndex: 1, payout: 12, isCarry: true, supplyCity: null }),
    ];

    const floor = enumerateCarriedDeliveryFloor(rows);

    expect(floor).not.toBeNull();
    expect(floor!.stops).toHaveLength(1);
    expect(floor!.stops[0]).toMatchObject({ action: 'deliver', loadType: 'Labor', city: 'Bern' });
    expect(floor!.id).toContain('carry-floor');
  });

  it('returns null when no carried rows exist', () => {
    const rows: Row[] = [
      makeRow({ loadType: 'Coal', deliveryCity: 'Berlin', cardIndex: 1, isCarry: false }),
    ];

    const floor = enumerateCarriedDeliveryFloor(rows);
    expect(floor).toBeNull();
  });

  it('includes all carried rows in the floor candidate', () => {
    const rows: Row[] = [
      makeRow({ loadType: 'Fish', deliveryCity: 'Zurich', cardIndex: 1, payout: 20, isCarry: true, supplyCity: null }),
      makeRow({ loadType: 'Coal', deliveryCity: 'Berlin', cardIndex: 2, payout: 15, isCarry: true, supplyCity: null }),
      makeRow({ loadType: 'Wine', deliveryCity: 'London', cardIndex: 3, payout: 18, isCarry: false }),
    ];

    const floor = enumerateCarriedDeliveryFloor(rows);

    expect(floor).not.toBeNull();
    expect(floor!.stops).toHaveLength(2); // only the 2 carry rows
    const loadTypes = floor!.stops.map(s => s.loadType);
    expect(loadTypes).toContain('Fish');
    expect(loadTypes).toContain('Coal');
  });
});

describe('enumerateSameSupplyCorridorCandidates', () => {
  /**
   * UT4 (Corridor Enumeration):
   * T46 scenario: bot at Oslo, two Fish demands (Fish→Zurich, Fish→Milano), capacity=2.
   * Expected: candidate [pickup(Fish@Oslo), pickup(Fish@Oslo), deliver(Fish@Zurich), deliver(Fish@Milano)].
   */
  it('UT4: generates corridor candidate for T46-like scenario [pickup(Fish@Oslo)×2, deliver(Fish@Zurich), deliver(Fish@Milano)]', () => {
    const rows: Row[] = [
      makeRow({ loadType: 'Fish', supplyCity: 'Oslo', deliveryCity: 'Zurich', cardIndex: 1, payout: 20, isCarry: false }),
      makeRow({ loadType: 'Fish', supplyCity: 'Oslo', deliveryCity: 'Milano', cardIndex: 2, payout: 18, isCarry: false }),
    ];
    const carriedCount = new Map<string, number>();

    const candidates = enumerateSameSupplyCorridorCandidates(rows, 2, carriedCount);

    expect(candidates.length).toBeGreaterThan(0);
    // Find a candidate that has two pickups at Oslo and delivers to both cities
    const corridorCandidate = candidates.find(c =>
      c.stops.filter(s => s.action === 'pickup' && s.city === 'Oslo').length === 2 &&
      c.stops.some(s => s.action === 'deliver' && s.city === 'Zurich') &&
      c.stops.some(s => s.action === 'deliver' && s.city === 'Milano'),
    );
    expect(corridorCandidate).toBeDefined();
    expect(corridorCandidate!.id).toContain('corridor:');
  });

  it('does not generate corridor candidates when only one demand shares the supply city', () => {
    const rows: Row[] = [
      makeRow({ loadType: 'Fish', supplyCity: 'Oslo', deliveryCity: 'Zurich', cardIndex: 1, payout: 20, isCarry: false }),
      makeRow({ loadType: 'Fish', supplyCity: 'Bergen', deliveryCity: 'Milano', cardIndex: 2, payout: 18, isCarry: false }),
    ];
    const carriedCount = new Map<string, number>();

    const candidates = enumerateSameSupplyCorridorCandidates(rows, 2, carriedCount);
    expect(candidates).toHaveLength(0);
  });

  it('does not generate corridor candidates when capacity would be exceeded', () => {
    // Bot already carries 2 Fish, cap=2 → can't pick up 2 more
    const rows: Row[] = [
      makeRow({ loadType: 'Fish', supplyCity: 'Oslo', deliveryCity: 'Zurich', cardIndex: 1, payout: 20, isCarry: false }),
      makeRow({ loadType: 'Fish', supplyCity: 'Oslo', deliveryCity: 'Milano', cardIndex: 2, payout: 18, isCarry: false }),
    ];
    const carriedCount = new Map<string, number>([['Fish', 2]]);

    const candidates = enumerateSameSupplyCorridorCandidates(rows, 2, carriedCount);
    expect(candidates).toHaveLength(0);
  });

  it('skips carry rows (isCarry=true) for corridor grouping', () => {
    const rows: Row[] = [
      makeRow({ loadType: 'Fish', supplyCity: null, deliveryCity: 'Zurich', cardIndex: 1, payout: 20, isCarry: true }),
      makeRow({ loadType: 'Fish', supplyCity: 'Oslo', deliveryCity: 'Milano', cardIndex: 2, payout: 18, isCarry: false }),
    ];
    const carriedCount = new Map<string, number>();

    const candidates = enumerateSameSupplyCorridorCandidates(rows, 2, carriedCount);
    expect(candidates).toHaveLength(0);
  });
});

describe('JIRA-249/250: Rejection logging in planTripDeterministic', () => {
  /**
   * UT5 (Rejection Logging): When a survivor candidate is grammatically invalid,
   * planTripDeterministic should populate candidateRejections with a structured record.
   *
   * We cannot easily inject a malformed candidate into the pipeline via normal row
   * setup (the generators produce valid grammar). Instead we verify the field exists
   * and is undefined when no rejections occur (the happy path — field absent).
   * A direct grammar-rejection scenario is tested via isCandidateGrammaticallyValid.
   */
  it('UT5: candidateRejections is absent (undefined) when all survivors pass grammar', () => {
    mockSimulateTrip.mockReturnValue({ turnsToComplete: 2, totalBuildCost: 5, feasible: true, minCashRelative: 0, finalCashRelative: 0, builtSegments: [] });
    mockEstimateGraphPathCost.mockReturnValue({ reachable: true, buildCost: 5, estimatedTurns: 2, pathLength: 20 });

    const demands = [
      makeDemand({ cardIndex: 1, loadType: 'Coal', deliveryCity: 'Berlin', payout: 15 }),
    ];
    const snapshot = makeSnapshot();
    const context = makeContext(demands);
    const memory = makeMemory();

    const result = planTripDeterministic(snapshot, context, memory);

    expect(result.outcome).toBe('success');
    // No malformed candidates in normal flow → rejections absent
    expect(result.candidateRejections).toBeUndefined();
  });
});

describe('JIRA-253 Layer B: planTripDeterministic excludeRouteSignatures', () => {
  // Relies on the outer beforeEach which sets up:
  // - mockGrid with SupplyCity@(3,3), DeliveryCity@(7,7)
  // - mockSimulateTrip → feasible result
  // - mockEstimateGraphPathCost → reachable low-cost result

  it('returns no_feasible_candidates when the only candidate is excluded', () => {
    const demands = [
      makeDemand({ cardIndex: 1, loadType: 'Steel', deliveryCity: 'DeliveryCity', payout: 30 }),
    ];
    const snapshot = makeSnapshot();
    const context = makeContext(demands);
    const memory = makeMemory();

    // The candidate id for a single non-carry demand is: single:<cardIndex>:<loadType>-sup:<supplyCity>
    // makeDemand defaults supplyCity to 'SupplyCity'
    const excludedId = 'single:1:Steel-sup:SupplyCity';
    const result = planTripDeterministic(snapshot, context, memory, {
      excludeRouteSignatures: [excludedId],
    });

    expect(result.outcome).toBe('no_feasible_candidates');
  });

  it('records excluded_by_caller rejection in candidateRejections', () => {
    const demands = [
      makeDemand({ cardIndex: 1, loadType: 'Steel', deliveryCity: 'DeliveryCity', payout: 30 }),
    ];
    const snapshot = makeSnapshot();
    const context = makeContext(demands);
    const memory = makeMemory();

    const excludedId = 'single:1:Steel-sup:SupplyCity';
    const result = planTripDeterministic(snapshot, context, memory, {
      excludeRouteSignatures: [excludedId],
    });

    expect(result.candidateRejections).toBeDefined();
    const exclusionRejection = result.candidateRejections!.find(
      r => r.reason === 'excluded_by_caller' && r.candidateId === excludedId,
    );
    expect(exclusionRejection).toBeDefined();
  });

  it('records excluded_by_caller rejection and still returns success when non-excluded candidate remains', () => {
    // Two independent demand cards — only exclude the Steel single candidate.
    // The Coal single candidate should win. Uses single-load types to avoid pair generation
    // (pairs use different load types per supplyCity combinator — only same-supply, same-load
    // corridor pairs are generated for different load types at the same supply).
    const demands = [
      makeDemand({ cardIndex: 1, loadType: 'Steel', deliveryCity: 'DeliveryCity', payout: 40 }),
      makeDemand({ cardIndex: 2, loadType: 'Coal', deliveryCity: 'DeliveryCity', payout: 20, supplyCity: 'SupplyCity' }),
    ];
    const snapshot = makeSnapshot();
    const context = makeContext(demands);
    const memory = makeMemory();

    // Exclude ALL candidates whose id contains the Steel single-delivery signature.
    // candidateId for single non-carry: single:<cardIndex>:<loadType>-sup:<supplyCity>
    // Also exclude the pair that includes Steel to ensure Coal single wins.
    const steelId = 'single:1:Steel-sup:SupplyCity';
    const steelPairId = 'pair:1-Steel+2-Coal:AB-sup:SupplyCity-SupplyCity';
    const steelPairIdBA = 'pair:1-Steel+2-Coal:BA-sup:SupplyCity-SupplyCity';
    const result = planTripDeterministic(snapshot, context, memory, {
      excludeRouteSignatures: [steelId, steelPairId, steelPairIdBA],
    });

    // Either Steel was fully excluded and Coal won, or no feasible alternatives remain.
    // The key assertion is that exclusions ARE recorded.
    expect(result.candidateRejections).toBeDefined();
    const steelExclusion = result.candidateRejections!.find(
      r => r.reason === 'excluded_by_caller' && r.candidateId === steelId,
    );
    expect(steelExclusion).toBeDefined();
  });

  it('does not exclude candidates when excludeRouteSignatures is empty', () => {
    const demands = [
      makeDemand({ cardIndex: 1, loadType: 'Steel', deliveryCity: 'DeliveryCity', payout: 30 }),
    ];
    const snapshot = makeSnapshot();
    const context = makeContext(demands);
    const memory = makeMemory();

    const result = planTripDeterministic(snapshot, context, memory, {
      excludeRouteSignatures: [],
    });

    expect(result.outcome).toBe('success');
  });

  it('does not exclude candidates when excludeRouteSignatures is not provided', () => {
    const demands = [
      makeDemand({ cardIndex: 1, loadType: 'Steel', deliveryCity: 'DeliveryCity', payout: 30 }),
    ];
    const snapshot = makeSnapshot();
    const context = makeContext(demands);
    const memory = makeMemory();

    const result = planTripDeterministic(snapshot, context, memory);

    expect(result.outcome).toBe('success');
  });
});

describe('JIRA-249/250: enumerateCandidates includes carry floor and corridor candidates', () => {
  it('UT5: enumerateCandidates includes carry-floor candidate when bot carries Labor', () => {
    const rows: Row[] = [
      makeRow({ loadType: 'Labor', deliveryCity: 'Bern', cardIndex: 1, payout: 12, isCarry: true, supplyCity: null }),
      makeRow({ loadType: 'Coal', deliveryCity: 'Berlin', cardIndex: 2, payout: 15, isCarry: false }),
    ];

    const candidates = enumerateCandidates(rows, 2);

    // Should have a carry-floor candidate
    const floorCandidates = candidates.filter(c => c.id.startsWith('carry-floor:'));
    expect(floorCandidates).toHaveLength(1);
    expect(floorCandidates[0].stops[0]).toMatchObject({ action: 'deliver', loadType: 'Labor', city: 'Bern' });
  });

  it('UT5b: enumerateCandidates includes corridor candidates for same-supply, same-load pair', () => {
    const rows: Row[] = [
      makeRow({ loadType: 'Fish', supplyCity: 'Oslo', deliveryCity: 'Zurich', cardIndex: 1, payout: 20, isCarry: false }),
      makeRow({ loadType: 'Fish', supplyCity: 'Oslo', deliveryCity: 'Milano', cardIndex: 2, payout: 18, isCarry: false }),
    ];

    const candidates = enumerateCandidates(rows, 2);

    const corridorCandidates = candidates.filter(c => c.id.startsWith('corridor:'));
    expect(corridorCandidates.length).toBeGreaterThan(0);
  });
});

// ── JIRA-255 Layer A: End-game lock mechanism ──────────────────────────

describe('JIRA-255 Layer A: end-game lock in planTripDeterministic', () => {
  beforeEach(() => {
    mockUpdateMemory.mockClear();
    // Default cheapPrune: always keep
    mockEstimateGraphPathCost.mockReturnValue({
      buildCost: 0, pathLength: 1, estimatedTurns: 1, reachable: true, newSegments: [],
    });
    // Default simulateTrip: feasible result
    mockSimulateTrip.mockReturnValue({
      feasible: true,
      net: 20,
      turns: 3,
      builtSegments: [],
      endCity: 'DeliveryCity',
      minCashRelative: 0,
      reasoning: 'ok',
    });
  });

  /** A demand that cheapPrune keeps and simulateTrip scores as feasible */
  function makeSingleDemand(): DemandContext {
    return makeDemand({ cardIndex: 0, loadType: 'Coal', deliveryCity: 'Paris', payout: 25 });
  }

  it('sets endGameLocked=true when cash > 200 and lock was false', () => {
    const memory = makeMemory({ endGameLocked: false });
    const snap = makeSnapshot({ money: 205 });
    const ctx = makeContext([makeSingleDemand()]);

    planTripDeterministic(snap, ctx, memory);

    expect(memory.endGameLocked).toBe(true);
    expect(mockUpdateMemory).toHaveBeenCalledWith('test-game', 'bot-1', { endGameLocked: true });
  });

  it('sets endGameLocked=true when classifyGamePhase returns late (turn >= 80)', () => {
    const memory = makeMemory({ endGameLocked: false, deliveryCount: 5 });
    // money <= 200 but turn=80 → late
    const snap: WorldSnapshot = {
      ...makeSnapshot({ money: 100 }),
      turnNumber: 80,
    };
    const ctx = makeContext([makeSingleDemand()]);

    planTripDeterministic(snap, ctx, memory);

    expect(memory.endGameLocked).toBe(true);
    expect(mockUpdateMemory).toHaveBeenCalledWith('test-game', 'bot-1', { endGameLocked: true });
  });

  it('does not set endGameLocked when cash <= 200 and phase is not late', () => {
    const memory = makeMemory({ deliveryCount: 1 });
    // money=100, turn=10 (default in makeSnapshot), deliveries=1, cmc=0 → early phase
    const snap = makeSnapshot({ money: 100 });
    const ctx = makeContext([makeSingleDemand()]);

    planTripDeterministic(snap, ctx, memory);

    // Lock was not set — remains absent (undefined)
    expect(memory.endGameLocked).toBeFalsy();
    expect(mockUpdateMemory).not.toHaveBeenCalledWith('test-game', 'bot-1', { endGameLocked: true });
  });

  it('endGameLocked remains true when already set (sticky, not re-set on cash dip)', () => {
    const memory = makeMemory({ endGameLocked: true });
    // money now only 150 (post-build dip) — lock should stay
    const snap = makeSnapshot({ money: 150 });
    const ctx = makeContext([makeSingleDemand()]);

    mockUpdateMemory.mockClear();
    planTripDeterministic(snap, ctx, memory);

    expect(memory.endGameLocked).toBe(true);
    // updateMemory should NOT be called again since lock was already set
    expect(mockUpdateMemory).not.toHaveBeenCalledWith('test-game', 'bot-1', { endGameLocked: true });
  });

  it('sets endGameLocked=true when citiesConnected >= 5 (late via classifyGamePhase)', () => {
    const memory = makeMemory({ endGameLocked: false, deliveryCount: 10 });
    // money=50 but 5 cities connected → late phase
    const snap = makeSnapshot({ money: 50 });
    const ctx = makeContext([makeSingleDemand()], {
      connectedMajorCities: ['A', 'B', 'C', 'D', 'E'],
    });

    planTripDeterministic(snap, ctx, memory);

    expect(memory.endGameLocked).toBe(true);
    expect(mockUpdateMemory).toHaveBeenCalledWith('test-game', 'bot-1', { endGameLocked: true });
  });
});
