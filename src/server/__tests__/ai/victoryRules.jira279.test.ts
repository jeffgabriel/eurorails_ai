/**
 * victoryRules unit tests — JIRA-279: freshness gate and money migration
 *
 * Tests cover:
 * - findFinalVictoryOutcome: derivedFromIdentity stamp on fire outcome
 * - findFinalVictoryOutcome: cashGap and cashAtVictory derive from snapshot.bot.money
 * - gateVictoryOutcomeFreshness: fire + matching identity → unchanged
 * - gateVictoryOutcomeFreshness: fire + differing factsHash → snapshot_mismatch skip
 * - gateVictoryOutcomeFreshness: fire + undefined liveIdentity → unchanged (legacy no-op)
 * - gateVictoryOutcomeFreshness: fire + undefined derivedFromIdentity → unchanged (legacy no-op)
 * - gateVictoryOutcomeFreshness: non-fire outcome → unchanged
 * - buildEndGameTrace: snapshot_mismatch skip flows into victoryRouteProjection
 */

import {
  findFinalVictoryOutcome,
  gateVictoryOutcomeFreshness,
  buildEndGameTrace,
  type FinalVictoryOutcome,
} from '../../services/ai/victoryRules';
import {
  GameState,
  TrainType,
  VICTORY_INITIAL_THRESHOLD,
} from '../../../shared/types/GameTypes';
import type {
  GameContext,
  BotMemoryState,
  WorldSnapshot,
  SnapshotIdentity,
  DemandContext,
  RouteStop,
} from '../../../shared/types/GameTypes';

// ── Mock planTripDeterministic ─────────────────────────────────────────────

jest.mock('../../services/ai/DeterministicTripPlanner', () => ({
  ...jest.requireActual('../../services/ai/DeterministicTripPlanner'),
  planTripDeterministic: jest.fn(),
}));

import { planTripDeterministic } from '../../services/ai/DeterministicTripPlanner';
const mockPlanTripDeterministic = planTripDeterministic as jest.MockedFunction<typeof planTripDeterministic>;

// ── Helpers ────────────────────────────────────────────────────────────────

function makeIdentity(turnNumber = 50, factsHash = 'abc123'): SnapshotIdentity {
  return { turnNumber, factsHash };
}

function makeSnapshot(
  botOverrides: Partial<WorldSnapshot['bot']> = {},
  identity?: SnapshotIdentity,
): WorldSnapshot {
  return {
    gameId: 'test-game',
    gameStatus: 'active',
    turnNumber: 50,
    identity,
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
      ...botOverrides,
    },
    allPlayerTracks: [],
    loadAvailability: {},
  };
}

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

const SEVEN_CONNECTED = [
  'Berlin', 'Paris', 'Madrid', 'Rome', 'Vienna', 'Warsaw', 'London',
];

function makeEndContext(overrides: Partial<GameContext> = {}): GameContext {
  return {
    position: { row: 10, col: 10 },
    money: 210,
    trainType: TrainType.Freight,
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
    turnNumber: 50,
    gameState: GameState.End,
    ...overrides,
  };
}

function makeEndMemory(): BotMemoryState {
  return makeMemory({ gameState: GameState.End });
}

function makeDemand(overrides: Partial<DemandContext> = {}): DemandContext {
  return {
    cardIndex: 0,
    loadType: 'Beer',
    deliveryCity: 'Paris',
    payout: 15,
    isDeliveryOnNetwork: true,
    isSupplyOnNetwork: true,
    isSupplyReachable: true,
    isDeliveryReachable: true,
    supplyCity: 'Brussels',
    estimatedTrackCostToSupply: 0,
    estimatedTrackCostToDelivery: 0,
    isLoadAvailable: true,
    isLoadOnTrain: false,
    ferryRequired: false,
    loadChipTotal: 4,
    loadChipCarried: 0,
    estimatedTurns: 2,
    demandScore: 10,
    efficiencyPerTurn: 5,
    networkCitiesUnlocked: 0,
    victoryMajorCitiesEnRoute: 0,
    isAffordable: true,
    projectedFundsAfterDelivery: 250,
    ...overrides,
  };
}

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

beforeEach(() => {
  mockPlanTripDeterministic.mockReset();
});

// ── findFinalVictoryOutcome — derivedFromIdentity stamp ────────────────────

describe('findFinalVictoryOutcome — JIRA-279 derivedFromIdentity stamp', () => {
  it('AC1: fire outcome carries route.derivedFromIdentity === snapshot.identity', () => {
    const identity = makeIdentity(50, 'hash-abc');
    // money=210, cashGap=max(0,250-210)=40; payout=50 → netPayout=50 > 40 → fire
    const snapshot = makeSnapshot({ money: 210, trainType: TrainType.Freight, loads: [] }, identity);
    const demand = makeDemand({ cardIndex: 0, loadType: 'Beer', deliveryCity: 'Paris', payout: 50 });
    const ctx = makeEndContext({ money: 210, demands: [demand] });

    mockPlanTripDeterministic.mockReturnValue(
      mockPlannerSuccess([
        { action: 'pickup', city: 'Brussels', loadType: 'Beer' },
        { action: 'deliver', city: 'Paris', loadType: 'Beer', payment: 50 },
      ]),
    );

    const result = findFinalVictoryOutcome(snapshot, ctx, makeEndMemory());
    expect(result.outcome).toBe('fire');
    if (result.outcome === 'fire') {
      expect(result.route.derivedFromIdentity).toBe(identity);
      expect(result.route.derivedFromIdentity).toStrictEqual({ turnNumber: 50, factsHash: 'hash-abc' });
    }
  });

  it('AC1b: fire outcome with undefined snapshot.identity → derivedFromIdentity is undefined', () => {
    // No identity on snapshot (legacy path)
    // money=210, cashGap=40; payout=50 → netPayout=50 > 40 → fire
    const snapshot = makeSnapshot({ money: 210, trainType: TrainType.Freight, loads: [] });
    const demand = makeDemand({ cardIndex: 0, loadType: 'Beer', deliveryCity: 'Paris', payout: 50 });
    const ctx = makeEndContext({ money: 210, demands: [demand] });

    mockPlanTripDeterministic.mockReturnValue(
      mockPlannerSuccess([
        { action: 'pickup', city: 'Brussels', loadType: 'Beer' },
        { action: 'deliver', city: 'Paris', loadType: 'Beer', payment: 50 },
      ]),
    );

    const result = findFinalVictoryOutcome(snapshot, ctx, makeEndMemory());
    expect(result.outcome).toBe('fire');
    if (result.outcome === 'fire') {
      expect(result.route.derivedFromIdentity).toBeUndefined();
    }
  });
});

// ── findFinalVictoryOutcome — money migration ──────────────────────────────

describe('findFinalVictoryOutcome — JIRA-279 money reads from snapshot.bot.money', () => {
  it('AC2: cashGap is computed from snapshot.bot.money, not context.money', () => {
    // snapshot.bot.money = 200, context.money = 999 (deliberately different)
    // cashGap = max(0, 250-200) = 50; payout=100 → netPayout=100 > 50 → fire
    const identity = makeIdentity(50, 'hash-cashgap');
    const snapshot = makeSnapshot({ money: 200, trainType: TrainType.Freight, loads: [] }, identity);
    const demand = makeDemand({ cardIndex: 0, loadType: 'Beer', deliveryCity: 'Paris', payout: 100 });
    const ctx = makeEndContext({ money: 999, demands: [demand] });

    mockPlanTripDeterministic.mockReturnValue(
      mockPlannerSuccess([
        { action: 'pickup', city: 'Brussels', loadType: 'Beer' },
        { action: 'deliver', city: 'Paris', loadType: 'Beer', payment: 100 },
      ]),
    );

    const result = findFinalVictoryOutcome(snapshot, ctx, makeEndMemory());
    expect(result.outcome).toBe('fire');
    if (result.outcome === 'fire') {
      // cashGap = max(0, 250 - 200) = 50 (from snapshot.bot.money=200, NOT context.money=999)
      expect(result.cashGap).toBe(Math.max(0, VICTORY_INITIAL_THRESHOLD - 200));
      expect(result.cashGap).not.toBe(Math.max(0, VICTORY_INITIAL_THRESHOLD - 999));
    }
  });

  it('AC3: cashAtVictory is computed from snapshot.bot.money, not context.money', () => {
    // snapshot.bot.money = 200, context.money = 999 (deliberately different)
    // cashGap = max(0, 250-200) = 50; payout=60 → netPayout=60 > 50 → fire
    // cashAtVictory = 200 + 60 - buildCost (not 999 + 60 - buildCost)
    const identity = makeIdentity(50, 'hash-cavatv');
    const snapshot = makeSnapshot({ money: 200, trainType: TrainType.Freight, loads: [] }, identity);
    const demand = makeDemand({ cardIndex: 0, loadType: 'Beer', deliveryCity: 'Paris', payout: 60 });
    const ctx = makeEndContext({ money: 999, demands: [demand] });

    mockPlanTripDeterministic.mockReturnValue(
      mockPlannerSuccess([
        { action: 'pickup', city: 'Brussels', loadType: 'Beer' },
        { action: 'deliver', city: 'Paris', loadType: 'Beer', payment: 60 },
      ]),
    );

    const result = findFinalVictoryOutcome(snapshot, ctx, makeEndMemory());
    expect(result.outcome).toBe('fire');
    if (result.outcome === 'fire') {
      // cashAtVictory uses snapshot.bot.money (200), not context.money (999)
      // 200 + 60 - buildCost; context.money=999 would give 999+60-buildCost >> 200+60-buildCost
      expect(result.route.cashAtVictory).toBeLessThan(999 + 60);
      expect(result.route.cashAtVictory).toBeGreaterThanOrEqual(200);
    }
  });
});

// ── gateVictoryOutcomeFreshness ────────────────────────────────────────────

describe('gateVictoryOutcomeFreshness', () => {
  const matchingIdentity = makeIdentity(50, 'hash-match');

  const fireOutcome: FinalVictoryOutcome = {
    outcome: 'fire',
    cashGap: 40,
    majorsGap: 0,
    connectorCost: 0,
    route: {
      stops: [
        { action: 'pickup', city: 'Brussels', loadType: 'Beer' },
        { action: 'deliver', city: 'Paris', loadType: 'Beer' },
      ],
      estimatedTurns: 3,
      buildCost: 5,
      totalPayout: 50,
      cashAtVictory: 255,
      majorsAtVictory: 7,
      majorConnectors: [],
      reasoning: '[final-victory] Beer→Paris',
      derivedFromIdentity: matchingIdentity,
    },
  };

  it('AC4: fire + matching identity → returns the same fire outcome unchanged', () => {
    const result = gateVictoryOutcomeFreshness(fireOutcome, matchingIdentity);
    expect(result).toBe(fireOutcome); // reference equality — no new object
    expect(result.outcome).toBe('fire');
  });

  it('AC5: fire + differing factsHash → returns snapshot_mismatch skip preserving cashGap/majorsGap/connectorCost', () => {
    const staleIdentity = makeIdentity(50, 'DIFFERENT-HASH');
    const result = gateVictoryOutcomeFreshness(fireOutcome, staleIdentity);
    expect(result.outcome).toBe('skip');
    if (result.outcome === 'skip') {
      expect(result.reason).toBe('snapshot_mismatch');
      expect(result.cashGap).toBe(40);
      expect(result.majorsGap).toBe(0);
      expect(result.connectorCost).toBe(0);
    }
  });

  it('AC5b: fire + differing turnNumber only → returns snapshot_mismatch skip', () => {
    const staleTurn = makeIdentity(99, 'hash-match'); // same hash, different turn
    const result = gateVictoryOutcomeFreshness(fireOutcome, staleTurn);
    expect(result.outcome).toBe('skip');
    if (result.outcome === 'skip') {
      expect(result.reason).toBe('snapshot_mismatch');
    }
  });

  it('AC6: fire + undefined liveIdentity → returns fire unchanged (legacy no-op)', () => {
    const result = gateVictoryOutcomeFreshness(fireOutcome, undefined);
    expect(result).toBe(fireOutcome);
    expect(result.outcome).toBe('fire');
  });

  it('AC7: fire + undefined derivedFromIdentity → returns fire unchanged (legacy no-op)', () => {
    const noStampFire: FinalVictoryOutcome = {
      ...fireOutcome,
      route: { ...fireOutcome.route, derivedFromIdentity: undefined },
    } as FinalVictoryOutcome;
    const liveIdentity = makeIdentity(50, 'hash-live');
    const result = gateVictoryOutcomeFreshness(noStampFire, liveIdentity);
    expect(result).toBe(noStampFire);
    expect(result.outcome).toBe('fire');
  });

  it('AC8: non-fire skip outcome → returned unchanged', () => {
    const skipOutcome: FinalVictoryOutcome = {
      outcome: 'skip',
      reason: 'no_demands',
    };
    const result = gateVictoryOutcomeFreshness(skipOutcome, matchingIdentity);
    expect(result).toBe(skipOutcome);
    expect(result.outcome).toBe('skip');
    if (result.outcome === 'skip') {
      expect(result.reason).toBe('no_demands');
    }
  });

  it('AC8b: non-fire skip outcome with reason not_in_end_state → returned unchanged', () => {
    const skipOutcome: FinalVictoryOutcome = {
      outcome: 'skip',
      reason: 'not_in_end_state',
    };
    const result = gateVictoryOutcomeFreshness(skipOutcome, undefined);
    expect(result).toBe(skipOutcome);
  });
});

// ── buildEndGameTrace — snapshot_mismatch skip ─────────────────────────────

describe('buildEndGameTrace — snapshot_mismatch skip renders into victoryRouteProjection', () => {
  it('renders snapshot_mismatch skip into victoryRouteProjection.outcome=skip with correct reason', () => {
    const snapshotMismatchSkip: FinalVictoryOutcome = {
      outcome: 'skip',
      reason: 'snapshot_mismatch',
      cashGap: 40,
      majorsGap: 0,
      connectorCost: 0,
    };
    const ctx = makeEndContext({ money: 210 });
    const trace = buildEndGameTrace(ctx, makeEndMemory(), snapshotMismatchSkip, false, null);

    expect(trace.victoryRouteProjection.outcome).toBe('skip');
    if (trace.victoryRouteProjection.outcome === 'skip') {
      expect(trace.victoryRouteProjection.reason).toBe('snapshot_mismatch');
    }
  });
});
