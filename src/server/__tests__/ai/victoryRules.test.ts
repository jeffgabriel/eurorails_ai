/**
 * victoryRules unit tests — computeGameState, cheapestUnconnectedMajorConnectorCost,
 * cheapestNUnconnectedMajorConnectorCost, detectVictoryClinch, findFinalVictoryRoute
 *
 * Tests cover:
 * - computeGameState: latching rules (once End, never reverts; cash threshold)
 * - cheapestUnconnectedMajorConnectorCost: already connected, partial, empty list
 * - cheapestNUnconnectedMajorConnectorCost: n=0, n>available, n=partial
 * - detectVictoryClinch: regression tests for JIRA-243
 * - findFinalVictoryRoute: JIRA-245 AC1-AC11
 *
 * JIRA-274: findFinalVictoryOutcome now delegates stop enumeration to
 * planTripDeterministic. Tests that exercise the fire/skip paths mock the
 * planner so assertions focus on the override's re-scoring and skip logic
 * rather than the planner's internal enumeration (which has its own tests).
 */

import {
  computeGameState,
  cheapestUnconnectedMajorConnectorCost,
  cheapestNUnconnectedMajorConnectorCost,
  detectVictoryClinch,
  findFinalVictoryRoute,
  findFinalVictoryOutcome,
  buildEndGameTrace,
  buildEffectiveCarrySet,
  validateRouteCarryPreconditions,
  type FinalVictoryOutcome,
} from '../../services/ai/victoryRules';
import { GameState, GameContext, TrainType, WorldSnapshot } from '../../../shared/types/GameTypes';
import type { BotMemoryState, DemandContext, RouteStop } from '../../../shared/types/GameTypes';

// ── Mock planTripDeterministic ─────────────────────────────────────────────
// JIRA-274: findFinalVictoryOutcome delegates to the deterministic planner.
// All tests that exercise fire/skip paths must configure this mock to return
// the desired planner response — assertions test the override's cash-gap
// feasibility check and re-scoring, not the planner's path-finding.

jest.mock('../../services/ai/DeterministicTripPlanner', () => ({
  ...jest.requireActual('../../services/ai/DeterministicTripPlanner'),
  planTripDeterministic: jest.fn(),
}));

import { planTripDeterministic } from '../../services/ai/DeterministicTripPlanner';
const mockPlanTripDeterministic = planTripDeterministic as jest.MockedFunction<typeof planTripDeterministic>;

/**
 * Build a mock DeterministicTripPlanResult that returns a route with the
 * given stops, for use in findFinalVictoryOutcome tests.
 */
function mockPlannerSuccess(stops: RouteStop[]) {
  return {
    route: {
      stops,
      currentStopIndex: 0,
      phase: 'build' as const,
      createdAtTurn: 1,
      reasoning: 'mock-planner',
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

// ── Helpers ────────────────────────────────────────────────────────────────

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

function makeContext(overrides: Partial<GameContext> = {}): GameContext {
  return {
    position: { row: 10, col: 10 },
    money: 50,
    trainType: 'freight',
    speed: 9,
    capacity: 2,
    loads: [],
    connectedMajorCities: [],
    unconnectedMajorCities: [],
    totalMajorCities: 8,
    trackSummary: '1 segment',
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
    turnNumber: 5,
    gameState: GameState.Mid,
    ...overrides,
  };
}

// Reset planTripDeterministic mock between tests
beforeEach(() => {
  mockPlanTripDeterministic.mockReset();
});

// ── computeGameState ───────────────────────────────────────────────────────

describe('computeGameState', () => {
  describe('AC1a — cash below threshold, no prior memory → Mid (turn ≥ 26)', () => {
    it('returns Mid when cash is 150 and gameState is undefined at turn 30', () => {
      const memory = makeMemory({ gameState: undefined });
      expect(computeGameState({ money: 150, turnNumber: 30 }, memory)).toBe(GameState.Mid);
    });
  });

  describe('AC1b — cash above threshold, no prior memory → latches to End', () => {
    it('returns End when cash is 201 and gameState is undefined', () => {
      const memory = makeMemory({ gameState: undefined });
      expect(computeGameState({ money: 201, turnNumber: 30 }, memory)).toBe(GameState.End);
    });
  });

  describe('AC1c — already End in memory + cash below threshold → stays End', () => {
    it('returns End when cash is 180 but gameState is already End', () => {
      const memory = makeMemory({ gameState: GameState.End });
      expect(computeGameState({ money: 180, turnNumber: 30 }, memory)).toBe(GameState.End);
    });
  });

  describe('AC1d — already End in memory + cash above threshold → stays End', () => {
    it('returns End when cash is 300 and gameState is already End', () => {
      const memory = makeMemory({ gameState: GameState.End });
      expect(computeGameState({ money: 300, turnNumber: 30 }, memory)).toBe(GameState.End);
    });
  });

  describe('boundary conditions', () => {
    it('returns Mid when cash is exactly 200 (threshold is exclusive: > 200)', () => {
      const memory = makeMemory({ gameState: undefined });
      expect(computeGameState({ money: 200, turnNumber: 30 }, memory)).toBe(GameState.Mid);
    });

    it('returns End when cash is 200.01', () => {
      const memory = makeMemory({ gameState: undefined });
      expect(computeGameState({ money: 200.01, turnNumber: 30 }, memory)).toBe(GameState.End);
    });
  });

  // ── JIRA-242: turn-based Initial/Early/Mid brackets ──────────────────
  describe('JIRA-242 turn-based phase brackets', () => {
    const memory = makeMemory({ gameState: undefined });

    it('returns Initial at turn 1 (setup-build turn)', () => {
      expect(computeGameState({ money: 50, turnNumber: 1 }, memory)).toBe(GameState.Initial);
    });

    it('returns Initial at turn 3 (last initial turn)', () => {
      expect(computeGameState({ money: 50, turnNumber: 3 }, memory)).toBe(GameState.Initial);
    });

    it('returns Early at turn 4 (first early turn)', () => {
      expect(computeGameState({ money: 50, turnNumber: 4 }, memory)).toBe(GameState.Early);
    });

    it('returns Early at turn 25 (last early turn)', () => {
      expect(computeGameState({ money: 50, turnNumber: 25 }, memory)).toBe(GameState.Early);
    });

    it('returns Mid at turn 26 (first mid turn)', () => {
      expect(computeGameState({ money: 50, turnNumber: 26 }, memory)).toBe(GameState.Mid);
    });

    it('End cash trigger takes precedence over Early turn bracket', () => {
      expect(computeGameState({ money: 250, turnNumber: 10 }, memory)).toBe(GameState.End);
    });

    it('End cash trigger takes precedence over Initial turn bracket', () => {
      expect(computeGameState({ money: 250, turnNumber: 2 }, memory)).toBe(GameState.End);
    });

    it('End latch survives turn-based brackets', () => {
      const latchedEnd = makeMemory({ gameState: GameState.End });
      expect(computeGameState({ money: 50, turnNumber: 4 }, latchedEnd)).toBe(GameState.End);
    });
  });
});

// ── cheapestUnconnectedMajorConnectorCost ──────────────────────────────────

describe('cheapestUnconnectedMajorConnectorCost', () => {
  describe('when all major cities are connected (>= 7)', () => {
    it('returns 0 when connectedMajorCities.length >= 7', () => {
      const ctx = makeContext({
        connectedMajorCities: ['A', 'B', 'C', 'D', 'E', 'F', 'G'],
        unconnectedMajorCities: [{ cityName: 'H', estimatedCost: 15 }],
      });
      expect(cheapestUnconnectedMajorConnectorCost(ctx)).toBe(0);
    });

    it('returns 0 when connectedMajorCities.length exceeds 7', () => {
      const ctx = makeContext({
        connectedMajorCities: ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'],
        unconnectedMajorCities: [],
      });
      expect(cheapestUnconnectedMajorConnectorCost(ctx)).toBe(0);
    });
  });

  describe('when some major cities are unconnected', () => {
    it('returns estimatedCost of the first (cheapest) unconnected city', () => {
      const ctx = makeContext({
        connectedMajorCities: ['A', 'B', 'C'],
        unconnectedMajorCities: [
          { cityName: 'Paris', estimatedCost: 8 },
          { cityName: 'Roma', estimatedCost: 20 },
        ],
      });
      expect(cheapestUnconnectedMajorConnectorCost(ctx)).toBe(8);
    });
  });

  describe('when unconnectedMajorCities is empty', () => {
    it('returns 0 when unconnectedMajorCities is empty (and < 7 connected)', () => {
      const ctx = makeContext({
        connectedMajorCities: ['A', 'B'],
        unconnectedMajorCities: [],
      });
      expect(cheapestUnconnectedMajorConnectorCost(ctx)).toBe(0);
    });
  });
});

// ── detectVictoryClinch (JIRA-243) ────────────────────────────────────────

function makeDemand(overrides: Partial<DemandContext> = {}): DemandContext {
  return {
    cardIndex: 0,
    loadType: 'Labor',
    supplyCity: 'Zagreb',
    deliveryCity: 'Bordeaux',
    payout: 34,
    isSupplyReachable: true,
    isDeliveryReachable: true,
    isSupplyOnNetwork: true,
    isDeliveryOnNetwork: true,
    estimatedTrackCostToSupply: 0,
    estimatedTrackCostToDelivery: 0,
    isLoadAvailable: true,
    isLoadOnTrain: true,
    ferryRequired: false,
    loadChipTotal: 3,
    loadChipCarried: 1,
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

const SEVEN_CONNECTED = ['Paris', 'Holland', 'Ruhr', 'Berlin', 'London', 'Wien', 'Madrid'];

describe('detectVictoryClinch', () => {
  it('returns the clinch when carrying a load with a matching demand that clears 250M and 7 majors are connected', () => {
    const ctx = makeContext({
      money: 226,
      connectedMajorCities: SEVEN_CONNECTED,
      demands: [makeDemand({ cardIndex: 78, loadType: 'Labor', deliveryCity: 'Bordeaux', payout: 34 })],
    });
    expect(detectVictoryClinch(ctx)).toEqual({
      loadType: 'Labor',
      deliveryCity: 'Bordeaux',
      payout: 34,
      cardIndex: 78,
    });
  });

  it('returns null when fewer than 7 majors are connected', () => {
    const ctx = makeContext({
      money: 226,
      connectedMajorCities: ['A', 'B', 'C', 'D', 'E', 'F'], // 6
      demands: [makeDemand({ payout: 100 })],
    });
    expect(detectVictoryClinch(ctx)).toBeNull();
  });

  it('returns null when no carried demand reaches 250M post-delivery', () => {
    const ctx = makeContext({
      money: 200,
      connectedMajorCities: SEVEN_CONNECTED,
      demands: [makeDemand({ payout: 30 })], // 200 + 30 = 230 < 250
    });
    expect(detectVictoryClinch(ctx)).toBeNull();
  });

  it('returns null when the load is not on the train (no carry)', () => {
    const ctx = makeContext({
      money: 226,
      connectedMajorCities: SEVEN_CONNECTED,
      demands: [makeDemand({ isLoadOnTrain: false })],
    });
    expect(detectVictoryClinch(ctx)).toBeNull();
  });

  it('returns null when the delivery city is not on the bot network', () => {
    const ctx = makeContext({
      money: 226,
      connectedMajorCities: SEVEN_CONNECTED,
      demands: [makeDemand({ isDeliveryOnNetwork: false })],
    });
    expect(detectVictoryClinch(ctx)).toBeNull();
  });

  it('picks the highest-payout carried demand when multiple qualify', () => {
    const ctx = makeContext({
      money: 226,
      connectedMajorCities: SEVEN_CONNECTED,
      demands: [
        makeDemand({ cardIndex: 1, loadType: 'Labor', deliveryCity: 'Bordeaux', payout: 30 }),
        makeDemand({ cardIndex: 2, loadType: 'Wine', deliveryCity: 'Roma', payout: 45 }),
      ],
    });
    expect(detectVictoryClinch(ctx)).toEqual({
      loadType: 'Wine',
      deliveryCity: 'Roma',
      payout: 45,
      cardIndex: 2,
    });
  });

  it('boundary: returns the clinch when cash + payout equals exactly 250M', () => {
    const ctx = makeContext({
      money: 216,
      connectedMajorCities: SEVEN_CONNECTED,
      demands: [makeDemand({ payout: 34 })], // 216 + 34 = 250 exactly
    });
    expect(detectVictoryClinch(ctx)).not.toBeNull();
  });

  it('returns null when demands array is empty', () => {
    const ctx = makeContext({
      money: 300,
      connectedMajorCities: SEVEN_CONNECTED,
      demands: [],
    });
    expect(detectVictoryClinch(ctx)).toBeNull();
  });
});

// ── cheapestNUnconnectedMajorConnectorCost (JIRA-245) ─────────────────────

describe('cheapestNUnconnectedMajorConnectorCost', () => {
  it('AC8 — returns {cost:0, cityNames:[]} when n=0', () => {
    const ctx = makeContext({
      connectedMajorCities: ['A', 'B'],
      unconnectedMajorCities: [
        { cityName: 'Paris', estimatedCost: 8 },
        { cityName: 'Roma', estimatedCost: 12 },
      ],
    });
    expect(cheapestNUnconnectedMajorConnectorCost(ctx, 0)).toEqual({ cost: 0, cityNames: [] });
  });

  it('AC9 — returns sum of all when n > available length (no throw)', () => {
    const ctx = makeContext({
      connectedMajorCities: ['A', 'B'],
      unconnectedMajorCities: [
        { cityName: 'Paris', estimatedCost: 8 },
        { cityName: 'Roma', estimatedCost: 12 },
      ],
    });
    // n=5 but only 2 available — should return sum of both
    expect(cheapestNUnconnectedMajorConnectorCost(ctx, 5)).toEqual({
      cost: 20,
      cityNames: ['Paris', 'Roma'],
    });
  });

  it('returns cost and names for n=1 (cheapest only)', () => {
    const ctx = makeContext({
      connectedMajorCities: ['A', 'B', 'C'],
      unconnectedMajorCities: [
        { cityName: 'Paris', estimatedCost: 8 },
        { cityName: 'Roma', estimatedCost: 20 },
        { cityName: 'Madrid', estimatedCost: 15 },
      ],
    });
    expect(cheapestNUnconnectedMajorConnectorCost(ctx, 1)).toEqual({
      cost: 8,
      cityNames: ['Paris'],
    });
  });

  it('returns cost and names for n=2', () => {
    const ctx = makeContext({
      connectedMajorCities: ['A', 'B', 'C'],
      unconnectedMajorCities: [
        { cityName: 'Paris', estimatedCost: 8 },
        { cityName: 'Roma', estimatedCost: 12 },
        { cityName: 'Madrid', estimatedCost: 20 },
      ],
    });
    expect(cheapestNUnconnectedMajorConnectorCost(ctx, 2)).toEqual({
      cost: 20,
      cityNames: ['Paris', 'Roma'],
    });
  });

  it('AC11 — existing cheapestUnconnectedMajorConnectorCost still works after refactor to delegate', () => {
    const ctx = makeContext({
      connectedMajorCities: ['A', 'B', 'C'],
      unconnectedMajorCities: [
        { cityName: 'Paris', estimatedCost: 8 },
        { cityName: 'Roma', estimatedCost: 20 },
      ],
    });
    expect(cheapestUnconnectedMajorConnectorCost(ctx)).toBe(8);
  });
});

// ── findFinalVictoryRoute (JIRA-245) ──────────────────────────────────────

function makeSnapshot(overrides: Partial<WorldSnapshot['bot']> = {}): WorldSnapshot {
  return {
    gameId: 'test-game',
    gameStatus: 'active',
    turnNumber: 50,
    bot: {
      playerId: 'bot-1',
      userId: 'user-1',
      money: 210,
      position: { row: 10, col: 10 },
      existingSegments: [],
      demandCards: [],
      resolvedDemands: [],
      trainType: TrainType.Freight,
      loads: [],
      botConfig: { skillLevel: 'hard' },
      connectedMajorCityCount: 7,
      ...overrides,
    },
    allPlayerTracks: [],
    loadAvailability: {},
  };
}

function makeEndContext(overrides: Partial<GameContext> = {}): GameContext {
  return makeContext({
    money: 241,
    gameState: GameState.End,
    connectedMajorCities: SEVEN_CONNECTED,
    unconnectedMajorCities: [],
    ...overrides,
  });
}

function makeEndMemory(): BotMemoryState {
  return makeMemory({ gameState: GameState.End });
}

describe('findFinalVictoryRoute', () => {
  // ── AC1: returns null when gameState !== End ───────────────────────────
  it('AC1 — returns null when gameState is Mid', () => {
    const snapshot = makeSnapshot();
    const ctx = makeContext({ money: 241, gameState: GameState.Mid, demands: [makeDemand()] });
    expect(findFinalVictoryRoute(snapshot, ctx, makeEndMemory())).toBeNull();
  });

  it('AC1 — returns null when gameState is Early', () => {
    const snapshot = makeSnapshot();
    const ctx = makeContext({ money: 241, gameState: GameState.Early, demands: [makeDemand()] });
    expect(findFinalVictoryRoute(snapshot, ctx, makeEndMemory())).toBeNull();
  });

  it('AC1 — returns null when gameState is Initial', () => {
    const snapshot = makeSnapshot();
    const ctx = makeContext({ money: 241, gameState: GameState.Initial, demands: [makeDemand()] });
    expect(findFinalVictoryRoute(snapshot, ctx, makeEndMemory())).toBeNull();
  });

  // ── AC2: returns null when context.demands is empty ────────────────────
  it('AC2 — returns null when demands is empty', () => {
    const snapshot = makeSnapshot();
    const ctx = makeEndContext({ demands: [] });
    expect(findFinalVictoryRoute(snapshot, ctx, makeEndMemory())).toBeNull();
  });

  // ── AC3: single-stop deliver-only (carried load) ───────────────────────
  // Covers the JIRA-243 c990fa47 case: load on train + matching demand + delivery on network.
  it('AC3 — returns deliver-only route when carried load + matching demand + delivery on network covers 250M', () => {
    const snapshot = makeSnapshot({ trainType: TrainType.Freight, loads: ['Beer'], money: 240 });
    // money=240, payout=10 → cashAtVictory=250
    const ctx = makeEndContext({
      money: 240,
      connectedMajorCities: SEVEN_CONNECTED,
      demands: [
        makeDemand({
          loadType: 'Beer',
          deliveryCity: 'Bruxelles',
          payout: 10,
          isLoadOnTrain: true,
          isDeliveryOnNetwork: true,
          isSupplyOnNetwork: true,
          estimatedTrackCostToSupply: 0,
          estimatedTrackCostToDelivery: 0,
          estimatedTurns: 1,
        }),
      ],
    });
    // JIRA-274: planner returns deliver-only stop (carry case — no pickup needed)
    mockPlanTripDeterministic.mockReturnValue(mockPlannerSuccess([
      { action: 'deliver', loadType: 'Beer', city: 'Bruxelles', demandCardId: 0, payment: 10 },
    ]));
    const result = findFinalVictoryRoute(snapshot, ctx, makeEndMemory());
    expect(result).not.toBeNull();
    // Should be a single deliver stop (no pickup — load is on train)
    expect(result!.stops).toHaveLength(1);
    expect(result!.stops[0]).toMatchObject({ action: 'deliver', loadType: 'Beer', city: 'Bruxelles' });
    expect(result!.cashAtVictory).toBeGreaterThanOrEqual(250);
    expect(result!.reasoning).toContain('[final-victory]');
  });

  // ── AC4: two-stop (pickup + deliver) route for 95f0aadc case ──────────
  // Bot has 7 majors, 241M cash, Beer→Bruxelles 10M; supply and delivery on network.
  it('AC4 — returns pickup+deliver route when supply and delivery on network and cash clears 250M', () => {
    const snapshot = makeSnapshot({ trainType: TrainType.Freight, loads: [], money: 241 });
    const ctx = makeEndContext({
      money: 241,
      connectedMajorCities: SEVEN_CONNECTED,
      demands: [
        makeDemand({
          loadType: 'Beer',
          supplyCity: 'Frankfurt',
          deliveryCity: 'Bruxelles',
          payout: 10,
          isLoadOnTrain: false,
          isSupplyOnNetwork: true,
          isDeliveryOnNetwork: true,
          estimatedTrackCostToSupply: 0,
          estimatedTrackCostToDelivery: 0,
          estimatedTurns: 2,
        }),
      ],
    });
    // JIRA-274: planner returns pickup+deliver route
    mockPlanTripDeterministic.mockReturnValue(mockPlannerSuccess([
      { action: 'pickup', loadType: 'Beer', city: 'Frankfurt' },
      { action: 'deliver', loadType: 'Beer', city: 'Bruxelles', demandCardId: 0, payment: 10 },
    ]));
    const result = findFinalVictoryRoute(snapshot, ctx, makeEndMemory());
    expect(result).not.toBeNull();
    expect(result!.stops.some((s) => s.action === 'pickup')).toBe(true);
    expect(result!.stops.some((s) => s.action === 'deliver')).toBe(true);
    expect(result!.cashAtVictory).toBeGreaterThanOrEqual(250);
    expect(result!.majorsAtVictory).toBeGreaterThanOrEqual(7);
  });

  // ── AC5: connector cost factored when fewer than 7 majors ─────────────
  it('AC5 — returns null when payout does not cover both cash gap AND connector cost', () => {
    const snapshot = makeSnapshot({ trainType: TrainType.Freight, loads: [] });
    // 6 majors connected → need 1 more connector at cost 8M
    // money=240, cashGap=10, connectorCost=8, need payout >= 18 but payout=9 → infeasible
    const ctx = makeEndContext({
      money: 240,
      connectedMajorCities: SEVEN_CONNECTED.slice(0, 6),
      unconnectedMajorCities: [{ cityName: 'Madrid', estimatedCost: 8 }],
      demands: [
        makeDemand({
          loadType: 'Beer',
          supplyCity: 'Frankfurt',
          deliveryCity: 'Bruxelles',
          payout: 9, // 240+9=249 < 250+8 connector cost → infeasible
          isLoadOnTrain: false,
          isSupplyOnNetwork: true,
          isDeliveryOnNetwork: true,
          estimatedTrackCostToSupply: 0,
          estimatedTrackCostToDelivery: 0,
          estimatedTurns: 2,
        }),
      ],
    });
    // JIRA-274: planner returns a route but the override rejects it (gap check fails)
    mockPlanTripDeterministic.mockReturnValue(mockPlannerSuccess([
      { action: 'pickup', loadType: 'Beer', city: 'Frankfurt' },
      { action: 'deliver', loadType: 'Beer', city: 'Bruxelles', demandCardId: 0, payment: 9 },
    ]));
    const result = findFinalVictoryRoute(snapshot, ctx, makeEndMemory());
    expect(result).toBeNull();
  });

  it('AC5 — returns route when payout covers cash gap AND connector cost', () => {
    const snapshot = makeSnapshot({ trainType: TrainType.Freight, loads: [], money: 240 });
    // 6 majors → connectorCost=8, money=240, cashGap=10, need payout>=18; payout=20 → feasible
    const ctx = makeEndContext({
      money: 240,
      connectedMajorCities: SEVEN_CONNECTED.slice(0, 6),
      unconnectedMajorCities: [{ cityName: 'Madrid', estimatedCost: 8 }],
      demands: [
        makeDemand({
          loadType: 'Beer',
          supplyCity: 'Frankfurt',
          deliveryCity: 'Bruxelles',
          payout: 20,
          isLoadOnTrain: false,
          isSupplyOnNetwork: true,
          isDeliveryOnNetwork: true,
          estimatedTrackCostToSupply: 0,
          estimatedTrackCostToDelivery: 0,
          estimatedTurns: 2,
        }),
      ],
    });
    // JIRA-274: planner returns the route; override checks gap and fires
    mockPlanTripDeterministic.mockReturnValue(mockPlannerSuccess([
      { action: 'pickup', loadType: 'Beer', city: 'Frankfurt' },
      { action: 'deliver', loadType: 'Beer', city: 'Bruxelles', demandCardId: 0, payment: 20 },
    ]));
    const result = findFinalVictoryRoute(snapshot, ctx, makeEndMemory());
    expect(result).not.toBeNull();
    expect(result!.cashAtVictory).toBeGreaterThanOrEqual(250);
    expect(result!.majorConnectors).toContain('Madrid');
  });

  // ── AC6: tiebreak — higher cashAtVictory wins when equal turns ─────────
  // JIRA-274: With delegation, the override fires with the planner's route.
  // The planner is mocked to return Coal (higher payout, higher cashAtVictory).
  it('AC6 — picks route with higher cashAtVictory when estimatedTurns are equal', () => {
    const snapshot = makeSnapshot({ trainType: TrainType.Freight, loads: [], money: 241 });
    const ctx = makeEndContext({
      money: 241,
      connectedMajorCities: SEVEN_CONNECTED,
      demands: [
        makeDemand({
          cardIndex: 1,
          loadType: 'Beer',
          supplyCity: 'Frankfurt',
          deliveryCity: 'Bruxelles',
          payout: 10,
          isLoadOnTrain: false,
          isSupplyOnNetwork: true,
          isDeliveryOnNetwork: true,
          estimatedTrackCostToSupply: 0,
          estimatedTrackCostToDelivery: 0,
          estimatedTurns: 2,
        }),
        makeDemand({
          cardIndex: 2,
          loadType: 'Coal',
          supplyCity: 'Ruhr',
          deliveryCity: 'Paris',
          payout: 15,
          isLoadOnTrain: false,
          isSupplyOnNetwork: true,
          isDeliveryOnNetwork: true,
          estimatedTrackCostToSupply: 0,
          estimatedTrackCostToDelivery: 0,
          estimatedTurns: 2, // same turns as Beer
        }),
      ],
    });
    // JIRA-274: planner returns Coal route (higher M/turn velocity due to payout)
    mockPlanTripDeterministic.mockReturnValue(mockPlannerSuccess([
      { action: 'pickup', loadType: 'Coal', city: 'Ruhr' },
      { action: 'deliver', loadType: 'Coal', city: 'Paris', demandCardId: 2, payment: 15 },
    ]));
    const result = findFinalVictoryRoute(snapshot, ctx, makeEndMemory());
    expect(result).not.toBeNull();
    // Coal pays 15M → cashAtVictory = 241+15=256 vs Beer pays 10M → 241+10=251
    // Same turns → higher cashAtVictory wins (Coal route)
    expect(result!.totalPayout).toBe(15);
  });

  // ── AC7: train capacity respected ─────────────────────────────────────
  // JIRA-274: capacity enforcement is delegated to planTripDeterministic.
  // The test verifies the override fires when the planner returns a valid
  // capacity-respecting route (≤2 delivers for Freight).
  it('AC7 — 2-load train never produces a 3-delivery candidate that exceeds capacity', () => {
    // With Freight (cap=2), we should only get 1- or 2-delivery routes.
    // A single demand of 9M won't clear 250 alone (money=232), but pair covers it.
    const snapshot = makeSnapshot({ trainType: TrainType.Freight, loads: [], money: 232 });
    const demands = [
      makeDemand({ cardIndex: 0, loadType: 'A', supplyCity: 'CityA', deliveryCity: 'DelivA', payout: 9, isLoadOnTrain: false, isSupplyOnNetwork: true, isDeliveryOnNetwork: true, estimatedTurns: 2 }),
      makeDemand({ cardIndex: 1, loadType: 'B', supplyCity: 'CityB', deliveryCity: 'DelivB', payout: 9, isLoadOnTrain: false, isSupplyOnNetwork: true, isDeliveryOnNetwork: true, estimatedTurns: 2 }),
      makeDemand({ cardIndex: 2, loadType: 'C', supplyCity: 'CityC', deliveryCity: 'DelivC', payout: 9, isLoadOnTrain: false, isSupplyOnNetwork: true, isDeliveryOnNetwork: true, estimatedTurns: 2 }),
    ];
    const ctx = makeEndContext({ money: 232, demands });
    // 232 + 9+9=18 = 250 → pair exactly covers 250, route feasible
    // JIRA-274: planner returns a 2-delivery route (capacity-respecting)
    mockPlanTripDeterministic.mockReturnValue(mockPlannerSuccess([
      { action: 'pickup', loadType: 'A', city: 'CityA' },
      { action: 'pickup', loadType: 'B', city: 'CityB' },
      { action: 'deliver', loadType: 'A', city: 'DelivA', demandCardId: 0, payment: 9 },
      { action: 'deliver', loadType: 'B', city: 'DelivB', demandCardId: 1, payment: 9 },
    ]));
    const result = findFinalVictoryRoute(snapshot, ctx, makeEndMemory());
    expect(result).not.toBeNull();
    // The deliver stops count should be ≤ 2 (cap=2 for Freight)
    const deliverCount = result!.stops.filter((s) => s.action === 'deliver').length;
    expect(deliverCount).toBeLessThanOrEqual(2);
  });

  it('AC7 — 3-load train (HeavyFreight) can produce a 3-delivery candidate', () => {
    const snapshot = makeSnapshot({ trainType: TrainType.HeavyFreight, loads: [], money: 241 });
    // Need 3 deliveries to reach 250M: money=241, each demand=3M. 3*3=9 → 241+9=250 exactly
    const demands = [
      makeDemand({ cardIndex: 0, loadType: 'A', supplyCity: 'CityA', deliveryCity: 'DelivA', payout: 3, isLoadOnTrain: false, isSupplyOnNetwork: true, isDeliveryOnNetwork: true, estimatedTurns: 1 }),
      makeDemand({ cardIndex: 1, loadType: 'B', supplyCity: 'CityB', deliveryCity: 'DelivB', payout: 3, isLoadOnTrain: false, isSupplyOnNetwork: true, isDeliveryOnNetwork: true, estimatedTurns: 1 }),
      makeDemand({ cardIndex: 2, loadType: 'C', supplyCity: 'CityC', deliveryCity: 'DelivC', payout: 3, isLoadOnTrain: false, isSupplyOnNetwork: true, isDeliveryOnNetwork: true, estimatedTurns: 1 }),
    ];
    const ctx = makeEndContext({ money: 241, demands });
    // JIRA-274: planner returns a 3-delivery route (HeavyFreight cap=3)
    mockPlanTripDeterministic.mockReturnValue(mockPlannerSuccess([
      { action: 'pickup', loadType: 'A', city: 'CityA' },
      { action: 'pickup', loadType: 'B', city: 'CityB' },
      { action: 'pickup', loadType: 'C', city: 'CityC' },
      { action: 'deliver', loadType: 'A', city: 'DelivA', demandCardId: 0, payment: 3 },
      { action: 'deliver', loadType: 'B', city: 'DelivB', demandCardId: 1, payment: 3 },
      { action: 'deliver', loadType: 'C', city: 'DelivC', demandCardId: 2, payment: 3 },
    ]));
    const result = findFinalVictoryRoute(snapshot, ctx, makeEndMemory());
    expect(result).not.toBeNull();
    const deliverCount = result!.stops.filter((s) => s.action === 'deliver').length;
    expect(deliverCount).toBeLessThanOrEqual(3);
  });

  // ── AC10: existing detectVictoryClinch tests unaffected ────────────────
  // (The full detectVictoryClinch suite above confirms this — AC10 is implicit.)

  // ── AC11: cheapestUnconnectedMajorConnectorCost still works as wrapper ─
  // (Tested in the cheapestNUnconnectedMajorConnectorCost suite above.)

  // ── Additional: returns null when no demand covers cash gap ────────────
  it('returns null when no demand can satisfy the cash gap (payout too low)', () => {
    const snapshot = makeSnapshot({ trainType: TrainType.Freight, loads: [] });
    // money=220, cashGap=30; only demand pays 5M → infeasible
    const ctx = makeEndContext({
      money: 220,
      demands: [
        makeDemand({
          loadType: 'Beer',
          supplyCity: 'Frankfurt',
          deliveryCity: 'Bruxelles',
          payout: 5,
          isLoadOnTrain: false,
          isSupplyOnNetwork: true,
          isDeliveryOnNetwork: true,
          estimatedTrackCostToSupply: 0,
          estimatedTrackCostToDelivery: 0,
          estimatedTurns: 2,
        }),
      ],
    });
    // JIRA-274: planner returns a route but override rejects it (payout < cashGap)
    mockPlanTripDeterministic.mockReturnValue(mockPlannerSuccess([
      { action: 'pickup', loadType: 'Beer', city: 'Frankfurt' },
      { action: 'deliver', loadType: 'Beer', city: 'Bruxelles', demandCardId: 0, payment: 5 },
    ]));
    expect(findFinalVictoryRoute(snapshot, ctx, makeEndMemory())).toBeNull();
  });

  // ── reasoning string contains [final-victory] on success ───────────────
  it('includes [final-victory] in reasoning when returning a route', () => {
    const snapshot = makeSnapshot({ trainType: TrainType.Freight, loads: [], money: 241 });
    const ctx = makeEndContext({
      money: 241,
      demands: [
        makeDemand({
          loadType: 'Labor',
          supplyCity: 'Zagreb',
          deliveryCity: 'Bordeaux',
          payout: 10,
          isLoadOnTrain: false,
          isSupplyOnNetwork: true,
          isDeliveryOnNetwork: true,
          estimatedTurns: 2,
        }),
      ],
    });
    // JIRA-274: planner returns a valid route
    mockPlanTripDeterministic.mockReturnValue(mockPlannerSuccess([
      { action: 'pickup', loadType: 'Labor', city: 'Zagreb' },
      { action: 'deliver', loadType: 'Labor', city: 'Bordeaux', demandCardId: 0, payment: 10 },
    ]));
    const result = findFinalVictoryRoute(snapshot, ctx, makeEndMemory());
    expect(result).not.toBeNull();
    expect(result!.reasoning).toMatch(/^\[final-victory\]/);
  });
});

// ── findFinalVictoryOutcome (JIRA-265) ───────────────────────────────────────

describe('findFinalVictoryOutcome', () => {
  // JIRA-265 AC2: skip-reason exposure on the null path
  it('returns skip:not_in_end_state when context.gameState is not End', () => {
    const snapshot = makeSnapshot();
    const ctx = makeEndContext({ gameState: GameState.Mid, demands: [makeDemand()] });
    const result = findFinalVictoryOutcome(snapshot, ctx, makeEndMemory());
    expect(result.outcome).toBe('skip');
    if (result.outcome === 'skip') expect(result.reason).toBe('not_in_end_state');
  });

  it('returns skip:no_demands when demand hand is empty', () => {
    const snapshot = makeSnapshot();
    const ctx = makeEndContext({ demands: [] });
    const result = findFinalVictoryOutcome(snapshot, ctx, makeEndMemory());
    expect(result.outcome).toBe('skip');
    if (result.outcome === 'skip') expect(result.reason).toBe('no_demands');
  });

  it('returns skip:victory_met when both gaps are zero (game should have ended)', () => {
    const snapshot = makeSnapshot({ money: 250 });
    const ctx = makeEndContext({
      money: 250,
      connectedMajorCities: ['A', 'B', 'C', 'D', 'E', 'F', 'G'],
      demands: [makeDemand()],
    });
    const result = findFinalVictoryOutcome(snapshot, ctx, makeEndMemory());
    expect(result.outcome).toBe('skip');
    if (result.outcome === 'skip') expect(result.reason).toBe('victory_met');
  });

  it('returns skip:no_route_covers_gap when no candidate clears the cashGap', () => {
    const snapshot = makeSnapshot({ trainType: TrainType.Freight, loads: [], money: 200 });
    // cashGap = 250 - 200 = 50M. Only demand pays $10M with on-network supply/delivery.
    const ctx = makeEndContext({
      money: 200,
      demands: [
        makeDemand({ loadType: 'Beer', supplyCity: 'Frankfurt', deliveryCity: 'Bruxelles', payout: 10, isLoadOnTrain: false, isSupplyOnNetwork: true, isDeliveryOnNetwork: true }),
      ],
    });
    // JIRA-274: planner returns a route but override rejects it (payout < cashGap)
    mockPlanTripDeterministic.mockReturnValue(mockPlannerSuccess([
      { action: 'pickup', loadType: 'Beer', city: 'Frankfurt' },
      { action: 'deliver', loadType: 'Beer', city: 'Bruxelles', demandCardId: 0, payment: 10 },
    ]));
    const result = findFinalVictoryOutcome(snapshot, ctx, makeEndMemory());
    expect(result.outcome).toBe('skip');
    if (result.outcome === 'skip') {
      expect(result.reason).toBe('no_route_covers_gap');
      expect(result.cashGap).toBe(50);
    }
  });

  it('returns fire with route + gap details when a feasible candidate exists', () => {
    const snapshot = makeSnapshot({ trainType: TrainType.Freight, loads: [], money: 241 });
    const ctx = makeEndContext({
      money: 241,
      demands: [
        makeDemand({
          loadType: 'Labor', supplyCity: 'Zagreb', deliveryCity: 'Bordeaux',
          payout: 10, isLoadOnTrain: false, isSupplyOnNetwork: true, isDeliveryOnNetwork: true, estimatedTurns: 2,
        }),
      ],
    });
    // JIRA-274: planner returns a route that covers the gap
    mockPlanTripDeterministic.mockReturnValue(mockPlannerSuccess([
      { action: 'pickup', loadType: 'Labor', city: 'Zagreb' },
      { action: 'deliver', loadType: 'Labor', city: 'Bordeaux', demandCardId: 0, payment: 10 },
    ]));
    const result = findFinalVictoryOutcome(snapshot, ctx, makeEndMemory());
    expect(result.outcome).toBe('fire');
    if (result.outcome === 'fire') {
      expect(result.route.reasoning).toMatch(/^\[final-victory\]/);
      expect(result.cashGap).toBe(9);
    }
  });

  it('legacy findFinalVictoryRoute still returns route on fire and null on skip', () => {
    const snapshot = makeSnapshot({ money: 241 });
    const ctxSkip = makeEndContext({ demands: [] });
    // no_demands path — planner not called
    expect(findFinalVictoryRoute(snapshot, ctxSkip, makeEndMemory())).toBeNull();

    const ctxFire = makeEndContext({
      money: 241,
      demands: [
        makeDemand({ loadType: 'Labor', supplyCity: 'Zagreb', deliveryCity: 'Bordeaux', payout: 10, isLoadOnTrain: false, isSupplyOnNetwork: true, isDeliveryOnNetwork: true, estimatedTurns: 2 }),
      ],
    });
    // JIRA-274: planner returns a valid route
    mockPlanTripDeterministic.mockReturnValue(mockPlannerSuccess([
      { action: 'pickup', loadType: 'Labor', city: 'Zagreb' },
      { action: 'deliver', loadType: 'Labor', city: 'Bordeaux', demandCardId: 0, payment: 10 },
    ]));
    expect(findFinalVictoryRoute(snapshot, ctxFire, makeEndMemory())).not.toBeNull();
  });
});

// ── buildEndGameTrace (JIRA-265) ─────────────────────────────────────────────

describe('buildEndGameTrace', () => {
  it('JIRA-265 AC1: trace populated with cashGap/majorsGap/cheapestConnectors/fullWinCostM', () => {
    const ctx = makeEndContext({
      money: 210,
      connectedMajorCities: ['Ruhr', 'Berlin', 'Madrid', 'London'],
      unconnectedMajorCities: [
        { cityName: 'Holland', estimatedCost: 20 },
        { cityName: 'Paris', estimatedCost: 15 },
        { cityName: 'Wien', estimatedCost: 25 },
        { cityName: 'Milano', estimatedCost: 30 },
      ],
    });
    const memory = makeEndMemory();
    const skipOutcome: FinalVictoryOutcome = { outcome: 'skip', reason: 'no_route_covers_gap', cashGap: 40, majorsGap: 3, connectorCost: 60 };
    const trace = buildEndGameTrace(ctx, memory, skipOutcome, false, null);

    expect(trace.inEndGame).toBe(true);
    expect(trace.cashGapM).toBe(40);
    expect(trace.majorsGap).toBe(3);
    expect(trace.cheapestConnectors).toEqual([
      { cityName: 'Holland', costM: 20 },
      { cityName: 'Paris', costM: 15 },
      { cityName: 'Wien', costM: 25 },
    ]);
    expect(trace.fullWinCostM).toBe(100); // 40 + 20 + 15 + 25
  });

  it('JIRA-265 AC2: victoryRouteProjection carries skip reason', () => {
    const ctx = makeEndContext({ money: 210 });
    const skipOutcome: FinalVictoryOutcome = { outcome: 'skip', reason: 'no_feasible_demands' };
    const trace = buildEndGameTrace(ctx, makeEndMemory(), skipOutcome, false, null);
    expect(trace.victoryRouteProjection.outcome).toBe('skip');
    if (trace.victoryRouteProjection.outcome === 'skip') {
      expect(trace.victoryRouteProjection.reason).toBe('no_feasible_demands');
    }
  });

  it('JIRA-265 AC3: victoryRouteProjection carries fire details + appliedOverride flag', () => {
    const ctx = makeEndContext({ money: 241 });
    const fireOutcome: FinalVictoryOutcome = {
      outcome: 'fire',
      cashGap: 9, majorsGap: 0, connectorCost: 0,
      route: {
        stops: [
          { action: 'pickup', loadType: 'Beer', city: 'Munchen' },
          { action: 'deliver', loadType: 'Beer', city: 'Hamburg', demandCardId: 1, payment: 9 },
        ],
        estimatedTurns: 3, buildCost: 0, totalPayout: 9,
        cashAtVictory: 250, majorsAtVictory: 7,
        majorConnectors: [],
        reasoning: '[final-victory] Beer→Hamburg, turns=3, build=0M, payout=9M, cash@victory=250M, majors@victory=7',
      },
    };
    const trace = buildEndGameTrace(ctx, makeEndMemory(), fireOutcome, true, null);
    expect(trace.victoryRouteProjection.outcome).toBe('fire');
    if (trace.victoryRouteProjection.outcome === 'fire') {
      expect(trace.victoryRouteProjection.turns).toBe(3);
      expect(trace.victoryRouteProjection.payoutM).toBe(9);
      expect(trace.victoryRouteProjection.cashAtVictory).toBe(250);
      expect(trace.victoryRouteProjection.appliedOverride).toBe(true);
      expect(trace.victoryRouteProjection.stops).toEqual([
        'pickup:Beer@Munchen',
        'deliver:Beer@Hamburg',
      ]);
    }
  });

  it('JIRA-265 AC7-component: activePlanProjection.willClinch reflects route payouts + connector deliveries', () => {
    const ctx = makeEndContext({
      money: 228,
      connectedMajorCities: ['Ruhr', 'Berlin', 'Madrid', 'London', 'Wien', 'Paris', 'Milano'], // 7 already
      unconnectedMajorCities: [{ cityName: 'Holland', estimatedCost: 20 }],
    });
    const activeRoute = {
      stops: [
        { action: 'deliver' as const, loadType: 'Copper', city: 'Cardiff', demandCardId: 99, payment: 31 },
      ],
      currentStopIndex: 0,
      phase: 'travel' as const,
      createdAtTurn: 76,
      reasoning: 'test',
    };
    const skipOutcome: FinalVictoryOutcome = { outcome: 'skip', reason: 'no_route_covers_gap' };
    const trace = buildEndGameTrace(ctx, makeEndMemory(), skipOutcome, false, activeRoute);
    expect(trace.activePlanProjection).toBeDefined();
    expect(trace.activePlanProjection!.projectedCash).toBe(259); // 228 + 31
    expect(trace.activePlanProjection!.projectedMajors).toBe(7); // already 7, Cardiff not a major
    expect(trace.activePlanProjection!.willClinch).toBe(true); // 259 >= 250 AND 7 >= 7
    expect(trace.activePlanProjection!.remainingStops).toBe(1);
  });

  it('activePlanProjection.willClinch=false when projectedCash insufficient', () => {
    const ctx = makeEndContext({
      money: 200,
      connectedMajorCities: ['A', 'B', 'C', 'D', 'E', 'F', 'G'],
    });
    const activeRoute = {
      stops: [
        { action: 'deliver' as const, loadType: 'X', city: 'CityX', demandCardId: 1, payment: 10 },
      ],
      currentStopIndex: 0,
      phase: 'travel' as const,
      createdAtTurn: 50,
      reasoning: 'test',
    };
    const skipOutcome: FinalVictoryOutcome = { outcome: 'skip', reason: 'no_route_covers_gap' };
    const trace = buildEndGameTrace(ctx, makeEndMemory(), skipOutcome, false, activeRoute);
    expect(trace.activePlanProjection!.projectedCash).toBe(210);
    expect(trace.activePlanProjection!.willClinch).toBe(false); // 210 < 250
  });

  it('activePlanProjection undefined when activeRoute is null', () => {
    const ctx = makeEndContext({ money: 210 });
    const skipOutcome: FinalVictoryOutcome = { outcome: 'skip', reason: 'no_route_covers_gap' };
    const trace = buildEndGameTrace(ctx, makeEndMemory(), skipOutcome, false, null);
    expect(trace.activePlanProjection).toBeUndefined();
  });
});

// ── buildEffectiveCarrySet (JIRA-267 Fix B) ──────────────────────────────────

describe('buildEffectiveCarrySet — multiplicity-aware carry detection', () => {
  it('AC3: one Fish chip + three Fish demands → only highest-payout demand is effectively carried', () => {
    const demands = [
      makeDemand({ cardIndex: 1, loadType: 'Fish', deliveryCity: 'Bern', payout: 37 }),
      makeDemand({ cardIndex: 2, loadType: 'Fish', deliveryCity: 'Milano', payout: 27 }),
      makeDemand({ cardIndex: 3, loadType: 'Fish', deliveryCity: 'Holland', payout: 23 }),
    ];
    const effective = buildEffectiveCarrySet(demands, ['Fish']);
    expect(effective.has(1)).toBe(true);  // Fish→Bern wins the slot (highest payout)
    expect(effective.has(2)).toBe(false); // Fish→Milano not carried
    expect(effective.has(3)).toBe(false); // Fish→Holland not carried
  });

  it('AC4: three Fish chips + three Fish demands → all three marked carried', () => {
    const demands = [
      makeDemand({ cardIndex: 1, loadType: 'Fish', deliveryCity: 'Bern', payout: 37 }),
      makeDemand({ cardIndex: 2, loadType: 'Fish', deliveryCity: 'Milano', payout: 27 }),
      makeDemand({ cardIndex: 3, loadType: 'Fish', deliveryCity: 'Holland', payout: 23 }),
    ];
    const effective = buildEffectiveCarrySet(demands, ['Fish', 'Fish', 'Fish']);
    expect(effective.has(1)).toBe(true);
    expect(effective.has(2)).toBe(true);
    expect(effective.has(3)).toBe(true);
  });

  it('mixed cargo + mixed demands: each loadType handled independently', () => {
    const demands = [
      makeDemand({ cardIndex: 1, loadType: 'Fish', deliveryCity: 'Bern', payout: 37 }),
      makeDemand({ cardIndex: 2, loadType: 'Fish', deliveryCity: 'Holland', payout: 23 }),
      makeDemand({ cardIndex: 3, loadType: 'Coal', deliveryCity: 'Berlin', payout: 30 }),
      makeDemand({ cardIndex: 4, loadType: 'Coal', deliveryCity: 'Paris', payout: 18 }),
    ];
    // One Fish chip → only Bern (higher payout). One Coal chip → only Berlin.
    const effective = buildEffectiveCarrySet(demands, ['Fish', 'Coal']);
    expect(effective.has(1)).toBe(true);
    expect(effective.has(2)).toBe(false);
    expect(effective.has(3)).toBe(true);
    expect(effective.has(4)).toBe(false);
  });

  it('empty cargo → no effective carries', () => {
    const demands = [
      makeDemand({ cardIndex: 1, loadType: 'Fish', deliveryCity: 'Bern', payout: 37 }),
    ];
    const effective = buildEffectiveCarrySet(demands, []);
    expect(effective.size).toBe(0);
  });

  it('more chips than matching demands → only as many cards as exist get marked', () => {
    const demands = [
      makeDemand({ cardIndex: 1, loadType: 'Fish', deliveryCity: 'Bern', payout: 37 }),
    ];
    // 3 chips, but only 1 demand exists for the loadType
    const effective = buildEffectiveCarrySet(demands, ['Fish', 'Fish', 'Fish']);
    expect(effective.size).toBe(1);
    expect(effective.has(1)).toBe(true);
  });
});

// ── findFinalVictoryOutcome carry-deliver distance + multiplicity (JIRA-267) ─

describe('findFinalVictoryOutcome — JIRA-267 distance-aware + multiplicity-aware carry handling', () => {
  it('AC2 replay (game 29c0255f Sonnet T85) — picks Holland (closest) not Bern (farthest) when carrying one Fish chip', () => {
    // Reconstructed from logs/game-29c0255f-1374-4304-a003-8f2dfc4ed257.ndjson
    // Sonnet T85 turn-start state: bot near Aberdeen at (7,29) post-pickup,
    // one Fish chip on board, three Fish demand cards, all delivery cities
    // on-network. Pre-JIRA-267: all three carry-deliver candidates estimate
    // at 1 turn → tiebreak on cashAtVictory DESC picks Bern (highest payout).
    // After JIRA-267: only the highest-payout Fish demand (Bern) is marked
    // effective-carry; Milano/Holland become pickup+deliver candidates with
    // path-aware turn estimates. For Bern's single-carry candidate, the
    // distance from (7,29) to Bern (37,40) is ~30 hex / 12 speed = 3 turns.
    // For Holland's pickup+deliver candidate, d.estimatedTurns is ~2 turns
    // (single short trip from a near-Aberdeen position). Holland wins on
    // turns despite the lower payout.
    const snapshot = makeSnapshot({
      trainType: TrainType.Superfreight,
      position: { row: 7, col: 29 }, // near Aberdeen, from T84 positionEnd in log
      loads: ['Fish'],
      money: 228,
    });
    const ctx = makeEndContext({
      money: 228,
      // Sonnet had 7 majors at T84 — city condition met; this turn is about closing cashGap.
      connectedMajorCities: ['Paris', 'Holland', 'Ruhr', 'Berlin', 'London', 'Wien', 'Madrid'],
      unconnectedMajorCities: [],
      demands: [
        makeDemand({
          cardIndex: 1, loadType: 'Fish', supplyCity: 'Aberdeen', deliveryCity: 'Bern',
          payout: 37, isLoadOnTrain: true, isSupplyOnNetwork: true, isDeliveryOnNetwork: true,
          estimatedTurns: 4, // path-aware (irrelevant for carry branch post-fix)
        }),
        makeDemand({
          cardIndex: 2, loadType: 'Fish', supplyCity: 'Aberdeen', deliveryCity: 'Milano',
          payout: 27, isLoadOnTrain: true, isSupplyOnNetwork: true, isDeliveryOnNetwork: true,
          estimatedTurns: 5,
        }),
        makeDemand({
          cardIndex: 3, loadType: 'Fish', supplyCity: 'Aberdeen', deliveryCity: 'Holland',
          payout: 23, isLoadOnTrain: true, isSupplyOnNetwork: true, isDeliveryOnNetwork: true,
          estimatedTurns: 2, // path-aware (used by Holland's pickup+deliver candidate post-fix)
        }),
      ],
    });

    // JIRA-274: mock planner to return Holland route (closest delivery → fewest turns)
    mockPlanTripDeterministic.mockReturnValue(mockPlannerSuccess([
      { action: 'deliver', loadType: 'Fish', city: 'Holland', demandCardId: 3, payment: 23 },
    ]));
    const result = findFinalVictoryOutcome(snapshot, ctx, makeEndMemory());

    expect(result.outcome).toBe('fire');
    if (result.outcome === 'fire') {
      const deliveryStop = result.route.stops.find(s => s.action === 'deliver');
      expect(deliveryStop?.city).toBe('Holland'); // closest, beats Bern on turns
    }
  });

  it('AC6 (no regression — Sonnet T84 pre-pickup): picks Holland via path-aware pickup+deliver turns', () => {
    // Same demand cards, but Fish NOT yet on the train. All three Fish demands
    // become pickup+deliver candidates with d.estimatedTurns from ContextBuilder.
    // Holland (lowest estimatedTurns) wins. This is the unchanged behavior of
    // the existing non-carry path; the test guards against regression.
    const snapshot = makeSnapshot({
      trainType: TrainType.Superfreight,
      position: { row: 7, col: 29 },
      loads: [], // Fish not yet picked up
      money: 228,
    });
    const ctx = makeEndContext({
      money: 228,
      connectedMajorCities: ['Paris', 'Holland', 'Ruhr', 'Berlin', 'London', 'Wien', 'Madrid'],
      unconnectedMajorCities: [],
      demands: [
        makeDemand({
          cardIndex: 1, loadType: 'Fish', supplyCity: 'Aberdeen', deliveryCity: 'Bern',
          payout: 37, isLoadOnTrain: false, isSupplyOnNetwork: true, isDeliveryOnNetwork: true,
          estimatedTurns: 9,
        }),
        makeDemand({
          cardIndex: 2, loadType: 'Fish', supplyCity: 'Aberdeen', deliveryCity: 'Milano',
          payout: 27, isLoadOnTrain: false, isSupplyOnNetwork: true, isDeliveryOnNetwork: true,
          estimatedTurns: 8,
        }),
        makeDemand({
          cardIndex: 3, loadType: 'Fish', supplyCity: 'Aberdeen', deliveryCity: 'Holland',
          payout: 23, isLoadOnTrain: false, isSupplyOnNetwork: true, isDeliveryOnNetwork: true,
          estimatedTurns: 6,
        }),
      ],
    });

    // JIRA-274: mock planner to return Holland route (lowest estimatedTurns)
    mockPlanTripDeterministic.mockReturnValue(mockPlannerSuccess([
      { action: 'pickup', loadType: 'Fish', city: 'Aberdeen' },
      { action: 'deliver', loadType: 'Fish', city: 'Holland', demandCardId: 3, payment: 23 },
    ]));
    const result = findFinalVictoryOutcome(snapshot, ctx, makeEndMemory());

    expect(result.outcome).toBe('fire');
    if (result.outcome === 'fire') {
      const deliveryStop = result.route.stops.find(s => s.action === 'deliver');
      expect(deliveryStop?.city).toBe('Holland'); // wins on lowest estimatedTurns
    }
  });

  it('distance-aware carry estimate distinguishes near vs far delivery cities', () => {
    // Same payout for two carry-deliver candidates — only distance should
    // determine the winner. Pre-JIRA-267 both would tie at 1 turn and the
    // tiebreak on cashAtVictory DESC would be arbitrary. After: closer city wins.
    const snapshot = makeSnapshot({
      trainType: TrainType.Freight, // speed 9
      position: { row: 10, col: 10 },
      loads: ['Wine'],
      money: 230,
    });
    const ctx = makeEndContext({
      money: 230, // cashGap = 20
      connectedMajorCities: ['Paris', 'Holland', 'Ruhr', 'Berlin', 'London', 'Wien', 'Madrid'],
      unconnectedMajorCities: [],
      demands: [
        // Holland at (20,38) — distance ~28 from (10,10) = ceil(28/9) = 4 turns
        makeDemand({
          cardIndex: 1, loadType: 'Wine', deliveryCity: 'Holland', payout: 30,
          isLoadOnTrain: true, isDeliveryOnNetwork: true,
        }),
        // Aberdeen at (2,34) — distance ~24 from (10,10) = ceil(24/9) = 3 turns
        // (closer than Holland from this position; same payout)
        makeDemand({
          cardIndex: 2, loadType: 'Wine', deliveryCity: 'Aberdeen', payout: 30,
          isLoadOnTrain: true, isDeliveryOnNetwork: true,
        }),
      ],
    });

    // Only one chip → buildEffectiveCarrySet marks only one as effective carry
    // (tiebreak on payout — both 30M; insertion order or first match). The other
    // becomes a pickup+deliver candidate, which loses because supply/delivery
    // distance would be larger than the carry case. Whichever wins, the
    // outcome.route.stops should have at least one carry delivery.
    //
    // JIRA-274: mock planner to return a deliver stop for Aberdeen (closer city).
    // The re-scoring in the override computes estimatedTurns from demand metadata,
    // which uses hexDistance from bot position → delivery. Aberdeen is ~3 turns away.
    mockPlanTripDeterministic.mockReturnValue(mockPlannerSuccess([
      { action: 'deliver', loadType: 'Wine', city: 'Aberdeen', demandCardId: 2, payment: 30 },
    ]));
    const result = findFinalVictoryOutcome(snapshot, ctx, makeEndMemory());
    expect(result.outcome).toBe('fire');
    // The key assertion: distance-aware estimate runs; the chosen route has
    // turns > 1 (proving the constant-1 bug is gone).
    if (result.outcome === 'fire') {
      expect(result.route.estimatedTurns).toBeGreaterThanOrEqual(2);
    }
  });
});

// ── JIRA-273: validateRouteCarryPreconditions ─────────────────────────────

describe('validateRouteCarryPreconditions (JIRA-273)', () => {
  function makeRoute(stops: Array<{ action: 'pickup' | 'deliver' | 'drop'; loadType: string; city: string }>) {
    return {
      stops,
      currentStopIndex: 0,
      phase: 'travel' as const,
      createdAtTurn: 0,
      reasoning: 'test route',
    };
  }

  it('pickup+deliver with empty cargo → ok', () => {
    const r = makeRoute([
      { action: 'pickup', loadType: 'Imports', city: 'Hamburg' },
      { action: 'deliver', loadType: 'Imports', city: 'Budapest' },
    ]);
    expect(validateRouteCarryPreconditions(r, [])).toEqual({ ok: true });
  });

  it('deliver-only with matching cargo → ok', () => {
    const r = makeRoute([{ action: 'deliver', loadType: 'Imports', city: 'Budapest' }]);
    expect(validateRouteCarryPreconditions(r, ['Imports'])).toEqual({ ok: true });
  });

  it('deliver-only with empty cargo → reject', () => {
    const r = makeRoute([{ action: 'deliver', loadType: 'Imports', city: 'Budapest' }]);
    const result = validateRouteCarryPreconditions(r, []);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain('deliver Imports@Budapest');
      expect(result.reason).toContain('stop 0');
    }
  });

  it('two delivers of same loadType, only one in cargo → reject second', () => {
    const r = makeRoute([
      { action: 'deliver', loadType: 'Imports', city: 'Budapest' },
      { action: 'deliver', loadType: 'Imports', city: 'Wien' },
    ]);
    const result = validateRouteCarryPreconditions(r, ['Imports']);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain('stop 1');
    }
  });

  it('mixed route: pickup A + deliver A + deliver B with B in cargo → ok', () => {
    const r = makeRoute([
      { action: 'pickup', loadType: 'Imports', city: 'Hamburg' },
      { action: 'deliver', loadType: 'Imports', city: 'Budapest' },
      { action: 'deliver', loadType: 'Sheep', city: 'Wroclaw' },
    ]);
    expect(validateRouteCarryPreconditions(r, ['Sheep'])).toEqual({ ok: true });
  });

  it('empty route → ok', () => {
    expect(validateRouteCarryPreconditions(makeRoute([]), [])).toEqual({ ok: true });
  });

  it('multiplicity: two pickups + two delivers of same loadType, empty cargo → ok', () => {
    const r = makeRoute([
      { action: 'pickup', loadType: 'Imports', city: 'Hamburg' },
      { action: 'pickup', loadType: 'Imports', city: 'Antwerpen' },
      { action: 'deliver', loadType: 'Imports', city: 'Budapest' },
      { action: 'deliver', loadType: 'Imports', city: 'Wien' },
    ]);
    expect(validateRouteCarryPreconditions(r, [])).toEqual({ ok: true });
  });

  it('JIRA-273 reproduction: c73cccf8 T244 shape — deliver Imports + deliver Sheep with cargo=[Oil] → reject', () => {
    const r = makeRoute([
      { action: 'deliver', loadType: 'Imports', city: 'Budapest' },
      { action: 'deliver', loadType: 'Sheep', city: 'Wroclaw' },
    ]);
    const result = validateRouteCarryPreconditions(r, ['Oil']);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain('Imports');
      expect(result.reason).toContain('Oil'); // cargoLoads is mentioned in the reason
    }
  });

  it('drop action does not consume a slot for later delivers', () => {
    // Drop is intentionally a no-op for the validator — present for completeness.
    const r = makeRoute([
      { action: 'pickup', loadType: 'Imports', city: 'Hamburg' },
      { action: 'drop', loadType: 'Imports', city: 'Berlin' },
      // After drop, no Imports remaining — a later deliver would fail.
    ]);
    expect(validateRouteCarryPreconditions(r, [])).toEqual({ ok: true });
  });
});
