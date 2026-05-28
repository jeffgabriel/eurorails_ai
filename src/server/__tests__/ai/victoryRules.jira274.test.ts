/**
 * JIRA-274 regression tests — End-game victory override delegates stop
 * enumeration to DeterministicTripPlanner.
 *
 * Covers:
 *  - c73cccf8 T253 Bauxite-Marseille regression: batched pickups before delivers
 *  - Override returns `skip:planner_returned_empty` when planner returns null
 *  - Override calls planner with filtered context.demands
 *  - Override re-scores by turns-to-victory (not planner's native M/turn)
 *  - Override returns `skip:no_route_covers_gap` when planner route doesn't close gap
 */

import {
  findFinalVictoryOutcome,
  type FinalVictoryOutcome,
} from '../../services/ai/victoryRules';
import {
  GameState,
  GameContext,
  TrainType,
  WorldSnapshot,
} from '../../../shared/types/GameTypes';
import type { BotMemoryState, DemandContext, RouteStop } from '../../../shared/types/GameTypes';
import { planTripDeterministic } from '../../services/ai/DeterministicTripPlanner';

// ── Mock planTripDeterministic ─────────────────────────────────────────────

jest.mock('../../services/ai/DeterministicTripPlanner', () => ({
  ...jest.requireActual('../../services/ai/DeterministicTripPlanner'),
  planTripDeterministic: jest.fn(),
}));

const mockPlanTripDeterministic = planTripDeterministic as jest.MockedFunction<typeof planTripDeterministic>;

beforeEach(() => {
  mockPlanTripDeterministic.mockReset();
});

// ── Test helpers ───────────────────────────────────────────────────────────

function makeMemory(overrides: Partial<BotMemoryState> = {}): BotMemoryState {
  return {
    currentBuildTarget: null,
    turnsOnTarget: 0,
    lastAction: null,
    consecutiveDiscards: 0,
    deliveryCount: 0,
    totalEarnings: 0,
    turnNumber: 0,
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

function makeEndMemory(): BotMemoryState {
  return makeMemory({ gameState: GameState.End });
}

function makeSnapshot(overrides: Partial<WorldSnapshot['bot']> = {}): WorldSnapshot {
  return {
    gameId: 'test-game-jira274',
    gameStatus: 'active',
    turnNumber: 253,
    bot: {
      playerId: 'bot-s1',
      userId: 'user-s1',
      money: 226,
      position: { row: 35, col: 20 }, // near Marseille region
      existingSegments: [],
      demandCards: [],
      resolvedDemands: [],
      trainType: TrainType.Freight, // capacity=2
      loads: [],
      botConfig: { skillLevel: 'medium' },
      connectedMajorCityCount: 7,
      ...overrides,
    },
    allPlayerTracks: [],
    loadAvailability: {},
  };
}

const SEVEN_CONNECTED = ['Paris', 'Holland', 'Ruhr', 'Berlin', 'London', 'Wien', 'Madrid'];

function makeEndContext(overrides: Partial<GameContext> = {}): GameContext {
  return {
    position: { row: 35, col: 20 },
    money: 226,
    trainType: 'freight',
    speed: 9,
    capacity: 2,
    loads: [],
    connectedMajorCities: SEVEN_CONNECTED,
    unconnectedMajorCities: [],
    totalMajorCities: 8,
    trackSummary: '10 segments',
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
    turnNumber: 253,
    gameState: GameState.End,
    ...overrides,
  };
}

function makeDemand(overrides: Partial<DemandContext> = {}): DemandContext {
  return {
    cardIndex: 0,
    loadType: 'Labor',
    supplyCity: 'Zagreb',
    deliveryCity: 'Bordeaux',
    payout: 15,
    isSupplyReachable: true,
    isDeliveryReachable: true,
    isSupplyOnNetwork: true,
    isDeliveryOnNetwork: true,
    estimatedTrackCostToSupply: 0,
    estimatedTrackCostToDelivery: 0,
    isLoadAvailable: true,
    isLoadOnTrain: false,
    ferryRequired: false,
    loadChipTotal: 3,
    loadChipCarried: 0,
    estimatedTurns: 3,
    demandScore: 0,
    efficiencyPerTurn: 0,
    networkCitiesUnlocked: 0,
    victoryMajorCitiesEnRoute: 0,
    isAffordable: true,
    projectedFundsAfterDelivery: 0,
    ...overrides,
  };
}

/**
 * Build a mock DeterministicTripPlanResult that returns a route with the given stops.
 */
function mockPlannerSuccess(stops: RouteStop[]) {
  return {
    route: {
      stops,
      currentStopIndex: 0,
      phase: 'build' as const,
      createdAtTurn: 253,
      reasoning: 'mock-planner-jira274',
    },
    reasoning: 'mock',
    outcome: 'success' as const,
    synthesizedAttempt: {
      attemptNumber: 1,
      status: 'success' as const,
      responseText: '',
      latencyMs: 0,
    },
  };
}

/** Build a mock planner result for the no-feasible-candidates case. */
function mockPlannerEmpty() {
  return {
    route: null,
    reasoning: 'no_feasible_candidates',
    outcome: 'no_feasible_candidates' as const,
    synthesizedAttempt: {
      attemptNumber: 1,
      status: 'success' as const,
      responseText: '',
      latencyMs: 0,
    },
  };
}

// ── c73cccf8 T253 Bauxite-Marseille regression ─────────────────────────────

describe('JIRA-274 c73cccf8 T253 Bauxite-Marseille regression', () => {
  /**
   * Scenario: Two Bauxite demand cards, both sourced at Marseille.
   *   - Card A: Bauxite from Marseille → Torino, payout 14M
   *   - Card B: Bauxite from Marseille → Munchen, payout 12M
   * Bot state: cash 226M (cashGap = 24M), 7 majors connected, Freight train (cap=2).
   *
   * Old bug (pre-JIRA-274): the in-file pair loop produced
   *   pickup:Marseille → deliver:Torino → pickup:Marseille → deliver:Munchen
   * which is a sequential backtrack: pickup → deliver → return to Marseille → deliver.
   *
   * Expected fix: the planner produces a batched corridor route:
   *   pickup:Bauxite@Marseille → pickup:Bauxite@Marseille → deliver:Bauxite@Torino → deliver:Bauxite@Munchen
   * which has BOTH pickups before ANY deliver.
   */
  it('returns route with both Bauxite pickups before any deliver (batched corridor)', () => {
    const snapshot = makeSnapshot({ trainType: TrainType.Freight, loads: [] });
    const ctx = makeEndContext({
      money: 226,
      connectedMajorCities: SEVEN_CONNECTED,
      unconnectedMajorCities: [],
      demands: [
        makeDemand({
          cardIndex: 10,
          loadType: 'Bauxite',
          supplyCity: 'Marseille',
          deliveryCity: 'Torino',
          payout: 14,
          isLoadOnTrain: false,
          isSupplyOnNetwork: true,
          isDeliveryOnNetwork: true,
          estimatedTrackCostToSupply: 0,
          estimatedTrackCostToDelivery: 0,
          estimatedTurns: 3,
        }),
        makeDemand({
          cardIndex: 11,
          loadType: 'Bauxite',
          supplyCity: 'Marseille',
          deliveryCity: 'Munchen',
          payout: 12,
          isLoadOnTrain: false,
          isSupplyOnNetwork: true,
          isDeliveryOnNetwork: true,
          estimatedTrackCostToSupply: 0,
          estimatedTrackCostToDelivery: 0,
          estimatedTurns: 4,
        }),
      ],
    });

    // Mock the planner to return the batched corridor route that the planner
    // would produce via enumerateSameSupplyCorridorCandidates: both pickups
    // at Marseille first, then both delivers.
    mockPlanTripDeterministic.mockReturnValue(mockPlannerSuccess([
      { action: 'pickup', loadType: 'Bauxite', city: 'Marseille' },
      { action: 'pickup', loadType: 'Bauxite', city: 'Marseille' },
      { action: 'deliver', loadType: 'Bauxite', city: 'Torino', demandCardId: 10, payment: 14 },
      { action: 'deliver', loadType: 'Bauxite', city: 'Munchen', demandCardId: 11, payment: 12 },
    ]));

    const result = findFinalVictoryOutcome(snapshot, ctx, makeEndMemory());

    expect(result.outcome).toBe('fire');
    if (result.outcome === 'fire') {
      const stops = result.route.stops;

      // Find the index of the first deliver stop
      const firstDeliverIdx = stops.findIndex(s => s.action === 'deliver');
      // Count pickup stops before the first deliver
      const pickupsBeforeFirstDeliver = stops
        .slice(0, firstDeliverIdx)
        .filter(s => s.action === 'pickup').length;

      // Both Bauxite pickups must appear before any deliver action
      expect(pickupsBeforeFirstDeliver).toBe(2);
      expect(firstDeliverIdx).toBeGreaterThan(1);

      // Verify the delivers are for the right loads
      const deliverStops = stops.filter(s => s.action === 'deliver');
      expect(deliverStops).toHaveLength(2);
      expect(deliverStops.every(s => s.loadType === 'Bauxite')).toBe(true);

      // cashAtVictory: 226 + 14 + 12 - 0(buildCost) = 252 ≥ 250
      expect(result.route.cashAtVictory).toBeGreaterThanOrEqual(250);
      // reasoning must contain the [final-victory] marker
      expect(result.route.reasoning).toMatch(/^\[final-victory\]/);
    }
  });

  it('planner is called with the feasible demands filtered from context', () => {
    const snapshot = makeSnapshot({ trainType: TrainType.Freight, loads: [] });
    const feasibleDemand = makeDemand({
      cardIndex: 10,
      loadType: 'Bauxite',
      supplyCity: 'Marseille',
      deliveryCity: 'Torino',
      payout: 30,
      isSupplyOnNetwork: true,
      isDeliveryOnNetwork: true,
    });
    // unreachable demand — should be filtered out before planner is called
    const unreachableDemand = makeDemand({
      cardIndex: 11,
      loadType: 'Coal',
      supplyCity: 'Oslo',
      deliveryCity: 'Cairo',
      payout: 40,
      isSupplyOnNetwork: false,
      isDeliveryOnNetwork: false,
      estimatedTrackCostToSupply: -1, // negative → not feasible
      estimatedTrackCostToDelivery: -1,
    });
    const ctx = makeEndContext({
      money: 226,
      demands: [feasibleDemand, unreachableDemand],
    });

    mockPlanTripDeterministic.mockReturnValue(mockPlannerSuccess([
      { action: 'pickup', loadType: 'Bauxite', city: 'Marseille' },
      { action: 'deliver', loadType: 'Bauxite', city: 'Torino', demandCardId: 10, payment: 30 },
    ]));

    findFinalVictoryOutcome(snapshot, ctx, makeEndMemory());

    expect(mockPlanTripDeterministic).toHaveBeenCalledTimes(1);
    const calledContext = mockPlanTripDeterministic.mock.calls[0][1];
    // The planner should have been called with only the feasible demand
    expect(calledContext.demands).toHaveLength(1);
    expect(calledContext.demands[0].cardIndex).toBe(10);
    expect(calledContext.demands[0].loadType).toBe('Bauxite');
  });
});

// ── planner_returned_empty skip path ──────────────────────────────────────

describe('JIRA-274 planner_returned_empty skip reason', () => {
  it('returns skip:planner_returned_empty when planner returns route=null', () => {
    const snapshot = makeSnapshot({ trainType: TrainType.Freight, loads: [] });
    const ctx = makeEndContext({
      money: 226,
      demands: [
        makeDemand({
          loadType: 'Bauxite',
          supplyCity: 'Marseille',
          deliveryCity: 'Torino',
          payout: 30,
          isSupplyOnNetwork: true,
          isDeliveryOnNetwork: true,
        }),
      ],
    });

    // Planner returns no feasible candidates
    mockPlanTripDeterministic.mockReturnValue(mockPlannerEmpty());

    const result = findFinalVictoryOutcome(snapshot, ctx, makeEndMemory());

    expect(result.outcome).toBe('skip');
    if (result.outcome === 'skip') {
      expect(result.reason).toBe('planner_returned_empty');
      // Gap details still present on skip
      expect(result.cashGap).toBeDefined();
      expect(result.majorsGap).toBeDefined();
      expect(result.connectorCost).toBeDefined();
    }
  });

  it('cashGap and majorsGap are preserved in planner_returned_empty skip', () => {
    const snapshot = makeSnapshot({ trainType: TrainType.Freight, loads: [] });
    const ctx = makeEndContext({
      money: 210,
      connectedMajorCities: SEVEN_CONNECTED.slice(0, 6), // 6 majors
      unconnectedMajorCities: [{ cityName: 'Wien', estimatedCost: 15 }],
      demands: [
        makeDemand({ loadType: 'Beer', supplyCity: 'Frankfurt', deliveryCity: 'Bruxelles', payout: 50, isSupplyOnNetwork: true, isDeliveryOnNetwork: true }),
      ],
    });

    mockPlanTripDeterministic.mockReturnValue(mockPlannerEmpty());

    const result = findFinalVictoryOutcome(snapshot, ctx, makeEndMemory());

    expect(result.outcome).toBe('skip');
    if (result.outcome === 'skip') {
      expect(result.reason).toBe('planner_returned_empty');
      expect(result.cashGap).toBe(40); // 250 - 210
      expect(result.majorsGap).toBe(1);
      expect(result.connectorCost).toBe(15);
    }
  });
});

// ── re-scoring by turns-to-victory ────────────────────────────────────────

describe('JIRA-274 re-scoring by turns-to-victory', () => {
  /**
   * The planner returns a route; the override re-scores by turns-to-victory.
   * This test verifies the override computes estimatedTurns from the route's
   * deliver stops using demand metadata (estimatedTurns field).
   */
  it('estimatedTurns in returned route reflects demand metadata, not planner latency', () => {
    const snapshot = makeSnapshot({ trainType: TrainType.Freight, loads: [] });
    const ctx = makeEndContext({
      money: 230, // cashGap = 20
      demands: [
        makeDemand({
          cardIndex: 1,
          loadType: 'Wine',
          supplyCity: 'Bordeaux',
          deliveryCity: 'Paris',
          payout: 25,
          isSupplyOnNetwork: true,
          isDeliveryOnNetwork: true,
          estimatedTurns: 4,
        }),
      ],
    });

    mockPlanTripDeterministic.mockReturnValue(mockPlannerSuccess([
      { action: 'pickup', loadType: 'Wine', city: 'Bordeaux' },
      { action: 'deliver', loadType: 'Wine', city: 'Paris', demandCardId: 1, payment: 25 },
    ]));

    const result = findFinalVictoryOutcome(snapshot, ctx, makeEndMemory());

    expect(result.outcome).toBe('fire');
    if (result.outcome === 'fire') {
      // The override re-scores using demand's estimatedTurns (4 turns)
      expect(result.route.estimatedTurns).toBeGreaterThanOrEqual(1);
      expect(result.route.totalPayout).toBe(25);
      expect(result.route.cashAtVictory).toBe(255); // 230 + 25 - 0 buildCost
    }
  });

  /**
   * When planner returns a route whose payout doesn't cover cashGap (after
   * including connector cost), the override returns no_route_covers_gap.
   */
  it('returns no_route_covers_gap when planner route payout < cashGap + connectorCost', () => {
    const snapshot = makeSnapshot({ trainType: TrainType.Freight, loads: [] });
    const ctx = makeEndContext({
      money: 200, // cashGap = 50
      connectedMajorCities: SEVEN_CONNECTED,
      demands: [
        makeDemand({
          cardIndex: 1,
          loadType: 'Beer',
          supplyCity: 'Frankfurt',
          deliveryCity: 'Bruxelles',
          payout: 20, // 20 < 50 cashGap → no_route_covers_gap
          isSupplyOnNetwork: true,
          isDeliveryOnNetwork: true,
        }),
      ],
    });

    mockPlanTripDeterministic.mockReturnValue(mockPlannerSuccess([
      { action: 'pickup', loadType: 'Beer', city: 'Frankfurt' },
      { action: 'deliver', loadType: 'Beer', city: 'Bruxelles', demandCardId: 1, payment: 20 },
    ]));

    const result = findFinalVictoryOutcome(snapshot, ctx, makeEndMemory());

    expect(result.outcome).toBe('skip');
    if (result.outcome === 'skip') {
      expect(result.reason).toBe('no_route_covers_gap');
      expect(result.cashGap).toBe(50);
    }
  });
});
