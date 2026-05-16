/**
 * StrategicContextBuilder.test.ts — Unit tests for all four block builders
 * and the top-level build() function.
 *
 * All tests use pure in-memory fixtures — no LLM calls, no DB.
 */

import {
  build,
  buildVictoryTargets,
  buildCapitalProjection,
  buildHandStaleness,
  buildOpponents,
  renderStrategicContext,
} from '../../services/ai/StrategicContextBuilder';
import {
  HAND_STALE_THRESHOLD_TURNS,
  VICTORY_TARGETS_COUNT,
  RECENT_DELIVERIES_WINDOW,
} from '../../services/ai/StrategicConstants';
import {
  WorldSnapshot,
  GameContext,
  BotMemoryState,
  TrainType,
  BotSkillLevel,
  DemandContext,
  AIActionType,
  GameState,
} from '../../../shared/types/GameTypes';

// ── Mocks ────────────────────────────────────────────────────────────

jest.mock('../../services/ai/connectedMajorCities', () => ({
  getConnectedMajorCityCount: jest.fn((_segments: unknown[]) => {
    // Return 3 cities connected by default for any non-empty segments
    return (_segments as unknown[]).length > 0 ? 3 : 0;
  }),
}));

// ── Fixtures ─────────────────────────────────────────────────────────

function makeSnapshot(overrides: Partial<WorldSnapshot> = {}): WorldSnapshot {
  return {
    gameId: 'game-1',
    gameStatus: 'active',
    turnNumber: 10,
    bot: {
      playerId: 'bot-1',
      userId: 'user-1',
      money: 120,
      position: { row: 5, col: 5 },
      existingSegments: [],
      demandCards: [1, 2, 3],
      resolvedDemands: [],
      trainType: TrainType.Freight,
      loads: [],
      botConfig: { skillLevel: BotSkillLevel.Medium },
      connectedMajorCityCount: 3,
    },
    allPlayerTracks: [],
    loadAvailability: {},
    ...overrides,
  };
}

function makeMemory(overrides: Partial<BotMemoryState> = {}): BotMemoryState {
  return {
    currentBuildTarget: null,
    turnsOnTarget: 0,
    lastAction: null,
    consecutiveDiscards: 0,
    deliveryCount: 5,
    totalEarnings: 100,
    turnNumber: 10,
    activeRoute: null,
    turnsOnRoute: 0,
    routeHistory: [],
    consecutiveLlmFailures: 0,
    recentDeliveries: [],
    cardAcquisitionTurn: {},
    ...overrides,
  };
}

function makeDemand(overrides: Partial<DemandContext> = {}): DemandContext {
  return {
    cardIndex: 1,
    loadType: 'Coal',
    supplyCity: 'Essen',
    deliveryCity: 'Berlin',
    payout: 15,
    isSupplyReachable: true,
    isDeliveryReachable: true,
    isSupplyOnNetwork: true,
    isDeliveryOnNetwork: true,
    estimatedTrackCostToSupply: 5,
    estimatedTrackCostToDelivery: 8,
    isLoadAvailable: true,
    isLoadOnTrain: false,
    ferryRequired: false,
    loadChipTotal: 4,
    loadChipCarried: 0,
    estimatedTurns: 4,
    demandScore: 3,
    efficiencyPerTurn: 3,
    networkCitiesUnlocked: 2,
    victoryMajorCitiesEnRoute: 0,
    isAffordable: true,
    projectedFundsAfterDelivery: 135,
    ...overrides,
  };
}

function makeContext(overrides: Partial<GameContext> = {}): GameContext {
  return {
    position: { city: 'Berlin', row: 10, col: 15 },
    money: 120,
    trainType: TrainType.Freight,
    speed: 9,
    capacity: 2,
    loads: [],
    connectedMajorCities: ['Berlin', 'Paris', 'Wien'],
    unconnectedMajorCities: [
      { cityName: 'London', estimatedCost: 25 },
      { cityName: 'Madrid', estimatedCost: 40 },
      { cityName: 'Milano', estimatedCost: 15 },
      { cityName: 'Moskva', estimatedCost: 55 },
      { cityName: 'Athina', estimatedCost: 60 },
    ],
    totalMajorCities: 8,
    trackSummary: '10 segments',
    turnBuildCost: 0,
    demands: [makeDemand({ cardIndex: 1 }), makeDemand({ cardIndex: 2, deliveryCity: 'Paris' })],
    canDeliver: [],
    canPickup: [],
    reachableCities: ['Berlin', 'Ruhr'],
    citiesOnNetwork: ['Berlin', 'Ruhr'],
    canUpgrade: false,
    canBuild: true,
    isInitialBuild: false,
    opponents: [],
    phase: 'mid',
    turnNumber: 10,
    gameState: GameState.Mid,
    ...overrides,
  };
}

// ── buildVictoryTargets ──────────────────────────────────────────────

describe('buildVictoryTargets', () => {
  it('returns up to VICTORY_TARGETS_COUNT rows sorted by estimatedCost ascending', () => {
    const context = makeContext();
    const targets = buildVictoryTargets(context);

    expect(targets.length).toBeLessThanOrEqual(VICTORY_TARGETS_COUNT);
    expect(targets.length).toBe(VICTORY_TARGETS_COUNT);

    // Should be sorted ascending by estimatedCost
    for (let i = 1; i < targets.length; i++) {
      expect(targets[i].estimatedCost).toBeGreaterThanOrEqual(targets[i - 1].estimatedCost);
    }

    // Cheapest should be Milano (15M)
    expect(targets[0].cityName).toBe('Milano');
    expect(targets[0].estimatedCost).toBe(15);
  });

  it('returns empty array when unconnectedMajorCities is empty', () => {
    const context = makeContext({ unconnectedMajorCities: [] });
    const targets = buildVictoryTargets(context);
    expect(targets).toEqual([]);
  });

  it('counts handAffinityCount from demand cards delivering to that city', () => {
    const context = makeContext({
      unconnectedMajorCities: [{ cityName: 'Paris', estimatedCost: 20 }],
      demands: [
        makeDemand({ cardIndex: 1, deliveryCity: 'Paris' }),
        makeDemand({ cardIndex: 2, deliveryCity: 'Paris' }),
        makeDemand({ cardIndex: 3, deliveryCity: 'Berlin' }),
      ],
    });

    const targets = buildVictoryTargets(context);
    expect(targets.length).toBe(1);
    expect(targets[0].cityName).toBe('Paris');
    expect(targets[0].handAffinityCount).toBe(2);
  });

  it('returns handAffinityCount 0 when no demands deliver to the city', () => {
    const context = makeContext({
      unconnectedMajorCities: [{ cityName: 'Moskva', estimatedCost: 55 }],
      demands: [makeDemand({ cardIndex: 1, deliveryCity: 'Berlin' })],
    });

    const targets = buildVictoryTargets(context);
    expect(targets[0].handAffinityCount).toBe(0);
  });
});

// ── buildCapitalProjection ───────────────────────────────────────────

describe('buildCapitalProjection', () => {
  it('computes correct recentIncomeVelocity from rolling window', () => {
    const snapshot = makeSnapshot({ bot: { ...makeSnapshot().bot, money: 80 } });
    const memory = makeMemory({
      recentDeliveries: [
        { turn: 5, payout: 20 },
        { turn: 7, payout: 30 },
        { turn: 9, payout: 10 },
      ],
    });

    const projection = buildCapitalProjection(snapshot, memory);

    expect(projection.cash).toBe(80);
    expect(projection.targetGap).toBe(170); // 250 - 80
    expect(projection.recentIncomeVelocity).toBeCloseTo(20, 5); // (20+30+10)/3
    expect(projection.projectedTurnsToVictoryCash).toBe(Math.ceil(170 / 20)); // 9
  });

  it('returns recentIncomeVelocity 0 and sentinel when recentDeliveries is empty', () => {
    const snapshot = makeSnapshot({ bot: { ...makeSnapshot().bot, money: 50 } });
    const memory = makeMemory({ recentDeliveries: [] });

    const projection = buildCapitalProjection(snapshot, memory);

    expect(projection.recentIncomeVelocity).toBe(0);
    expect(projection.projectedTurnsToVictoryCash).toBe(999999);
  });

  it('returns recentIncomeVelocity 0 when recentDeliveries is undefined', () => {
    const snapshot = makeSnapshot({ bot: { ...makeSnapshot().bot, money: 100 } });
    const memory = makeMemory({ recentDeliveries: undefined });

    const projection = buildCapitalProjection(snapshot, memory);

    expect(projection.recentIncomeVelocity).toBe(0);
    expect(projection.projectedTurnsToVictoryCash).toBe(999999);
  });

  it('caps rolling window at RECENT_DELIVERIES_WINDOW entries', () => {
    const deliveries = Array.from({ length: RECENT_DELIVERIES_WINDOW + 2 }, (_, i) => ({
      turn: i + 1,
      payout: 10,
    }));
    const snapshot = makeSnapshot({ bot: { ...makeSnapshot().bot, money: 150 } });
    const memory = makeMemory({ recentDeliveries: deliveries });

    const projection = buildCapitalProjection(snapshot, memory);

    // All payouts are 10, so velocity = 10 regardless of window size
    expect(projection.recentIncomeVelocity).toBe(10);
  });

  it('returns targetGap 0 when cash already exceeds victory threshold', () => {
    const snapshot = makeSnapshot({ bot: { ...makeSnapshot().bot, money: 300 } });
    const memory = makeMemory({ recentDeliveries: [{ turn: 9, payout: 20 }] });

    const projection = buildCapitalProjection(snapshot, memory);

    expect(projection.targetGap).toBe(0);
    expect(projection.projectedTurnsToVictoryCash).toBe(0); // ceil(0/20) = 0
  });
});

// ── buildHandStaleness ───────────────────────────────────────────────

describe('buildHandStaleness', () => {
  it('flags cards held >= HAND_STALE_THRESHOLD_TURNS as stale', () => {
    const context = makeContext({
      turnNumber: 20,
      demands: [
        makeDemand({ cardIndex: 1 }),
        makeDemand({ cardIndex: 2 }),
      ],
    });
    const memory = makeMemory({
      cardAcquisitionTurn: {
        1: 5,   // held 15 turns → stale
        2: 15,  // held 5 turns → not stale
      },
    });

    const staleness = buildHandStaleness(context, memory);

    expect(staleness.length).toBe(2);

    const card1 = staleness.find(r => r.cardIndex === 1)!;
    expect(card1.turnsHeld).toBe(15);
    expect(card1.isStale).toBe(true);

    const card2 = staleness.find(r => r.cardIndex === 2)!;
    expect(card2.turnsHeld).toBe(5);
    expect(card2.isStale).toBe(false);
  });

  it('returns turnsHeld 0 and isStale false when cardAcquisitionTurn entry is missing', () => {
    const context = makeContext({
      turnNumber: 30,
      demands: [makeDemand({ cardIndex: 99 })],
    });
    const memory = makeMemory({ cardAcquisitionTurn: {} });

    const staleness = buildHandStaleness(context, memory);

    expect(staleness.length).toBe(1);
    expect(staleness[0].turnsHeld).toBe(0);
    expect(staleness[0].isStale).toBe(false);
  });

  it('deduplicates demand cards by cardIndex', () => {
    const context = makeContext({
      turnNumber: 10,
      demands: [
        makeDemand({ cardIndex: 1, loadType: 'Coal' }),
        makeDemand({ cardIndex: 1, loadType: 'Oil' }), // same card, different demand
        makeDemand({ cardIndex: 2 }),
      ],
    });
    const memory = makeMemory({ cardAcquisitionTurn: { 1: 5, 2: 9 } });

    const staleness = buildHandStaleness(context, memory);

    expect(staleness.length).toBe(2); // Only 2 unique card indices
  });

  it('returns empty array when demands is empty', () => {
    const context = makeContext({ demands: [] });
    const memory = makeMemory({ cardAcquisitionTurn: { 1: 5 } });

    const staleness = buildHandStaleness(context, memory);

    expect(staleness).toEqual([]);
  });

  it('exact threshold: turnsHeld === HAND_STALE_THRESHOLD_TURNS is stale', () => {
    const context = makeContext({
      turnNumber: 10 + HAND_STALE_THRESHOLD_TURNS,
      demands: [makeDemand({ cardIndex: 1 })],
    });
    const memory = makeMemory({ cardAcquisitionTurn: { 1: 10 } });

    const staleness = buildHandStaleness(context, memory);
    expect(staleness[0].turnsHeld).toBe(HAND_STALE_THRESHOLD_TURNS);
    expect(staleness[0].isStale).toBe(true);
  });
});

// ── buildOpponents ───────────────────────────────────────────────────

describe('buildOpponents', () => {
  it('excludes the bot itself', () => {
    const snapshot = makeSnapshot({
      opponents: [
        { playerId: 'bot-1', money: 50, position: null, trainType: TrainType.Freight, loads: [] },
        { playerId: 'player-2', money: 80, position: null, trainType: TrainType.FastFreight, loads: [] },
      ],
    });

    const opponents = buildOpponents(snapshot);

    expect(opponents).toHaveLength(1);
    expect(opponents[0].playerId).toBe('player-2');
  });

  it('returns empty array when no opponents', () => {
    const snapshot = makeSnapshot({ opponents: [] });
    const opponents = buildOpponents(snapshot);
    expect(opponents).toEqual([]);
  });

  it('returns empty array when opponents is undefined', () => {
    const snapshot = makeSnapshot({ opponents: undefined });
    const opponents = buildOpponents(snapshot);
    expect(opponents).toEqual([]);
  });

  it('flags the player with lowest projectedTurnsFromWin as isLeading', () => {
    const { getConnectedMajorCityCount } = require('../../services/ai/connectedMajorCities');
    // Player with 5 cities connected is closer to win than player with 3
    (getConnectedMajorCityCount as jest.Mock)
      .mockReturnValueOnce(5)  // player-2: 2 cities needed = 10 turns
      .mockReturnValueOnce(3); // player-3: 4 cities needed = 20 turns

    const snapshot = makeSnapshot({
      opponents: [
        { playerId: 'player-2', money: 80, position: null, trainType: TrainType.Freight, loads: [] },
        { playerId: 'player-3', money: 50, position: null, trainType: TrainType.Freight, loads: [] },
      ],
      allPlayerTracks: [
        { playerId: 'player-2', segments: [{ from: { x: 0, y: 0, row: 0, col: 0, terrain: 1 }, to: { x: 1, y: 1, row: 0, col: 1, terrain: 1 }, cost: 1 }] },
        { playerId: 'player-3', segments: [] },
      ],
    });

    const opponents = buildOpponents(snapshot);

    const p2 = opponents.find(o => o.playerId === 'player-2')!;
    const p3 = opponents.find(o => o.playerId === 'player-3')!;

    expect(p2.citiesConnected).toBe(5);
    expect(p3.citiesConnected).toBe(3);
    expect(p2.isLeading).toBe(true);
    expect(p3.isLeading).toBe(false);
  });

  it('degrades gracefully when allPlayerTracks is empty', () => {
    const snapshot = makeSnapshot({
      opponents: [
        { playerId: 'player-2', money: 100, position: null, trainType: TrainType.Freight, loads: [] },
      ],
      allPlayerTracks: [],
    });

    const { getConnectedMajorCityCount } = require('../../services/ai/connectedMajorCities');
    (getConnectedMajorCityCount as jest.Mock).mockReturnValueOnce(0);

    const opponents = buildOpponents(snapshot);
    expect(opponents).toHaveLength(1);
    expect(opponents[0].citiesConnected).toBe(0);
  });
});

// ── build (main entry) ───────────────────────────────────────────────

describe('build', () => {
  it('returns a StrategicContext with all four blocks plus phaseSnapshot', () => {
    const snapshot = makeSnapshot();
    const context = makeContext();
    const memory = makeMemory({ recentDeliveries: [{ turn: 9, payout: 15 }] });

    const ctx = build(snapshot, context, memory);

    expect(ctx.phaseSnapshot.turn).toBe(10);
    expect(ctx.phaseSnapshot.deliveries).toBe(5);
    expect(ctx.phaseSnapshot.citiesConnected).toBe(3);
    expect(Array.isArray(ctx.victoryTargets)).toBe(true);
    expect(ctx.capital).toBeDefined();
    expect(Array.isArray(ctx.handStaleness)).toBe(true);
    expect(Array.isArray(ctx.opponents)).toBe(true);
  });

  it('degrades gracefully with missing/empty memory fields', () => {
    const snapshot = makeSnapshot({ opponents: [] });
    const context = makeContext({ unconnectedMajorCities: [], demands: [] });
    const memory = makeMemory({ recentDeliveries: undefined, cardAcquisitionTurn: undefined });

    expect(() => build(snapshot, context, memory)).not.toThrow();

    const ctx = build(snapshot, context, memory);
    expect(ctx.victoryTargets).toEqual([]);
    expect(ctx.capital.recentIncomeVelocity).toBe(0);
    expect(ctx.handStaleness).toEqual([]);
    expect(ctx.opponents).toEqual([]);
  });

  it('degrades gracefully with single-player snapshot (no opponents)', () => {
    const snapshot = makeSnapshot({ opponents: undefined, allPlayerTracks: [] });
    const context = makeContext();
    const memory = makeMemory();

    expect(() => build(snapshot, context, memory)).not.toThrow();
    const ctx = build(snapshot, context, memory);
    expect(ctx.opponents).toEqual([]);
  });
});

// ── renderStrategicContext ───────────────────────────────────────────

describe('renderStrategicContext', () => {
  it('renders all four blocks and the header', () => {
    const snapshot = makeSnapshot();
    const context = makeContext();
    const memory = makeMemory({
      recentDeliveries: [{ turn: 9, payout: 20 }],
      cardAcquisitionTurn: { 1: 5, 2: 9 },
    });
    const ctx = build(snapshot, context, memory);
    const rendered = renderStrategicContext(ctx);

    expect(rendered).toContain('STRATEGIC CONTEXT');
    expect(rendered).toContain('VICTORY TARGETS');
    expect(rendered).toContain('CAPITAL PROJECTION');
    expect(rendered).toContain('HAND STALENESS');
  });

  it('renders "all major cities connected" when victoryTargets is empty', () => {
    const snapshot = makeSnapshot();
    const context = makeContext({ unconnectedMajorCities: [] });
    const memory = makeMemory();
    const ctx = build(snapshot, context, memory);
    const rendered = renderStrategicContext(ctx);

    expect(rendered).toContain('all major cities connected');
  });

  it('renders OPPONENTS section when opponents exist', () => {
    const { getConnectedMajorCityCount } = require('../../services/ai/connectedMajorCities');
    (getConnectedMajorCityCount as jest.Mock).mockReturnValue(4);

    const snapshot = makeSnapshot({
      opponents: [
        { playerId: 'player-2', money: 80, position: null, trainType: TrainType.Freight, loads: [] },
      ],
      allPlayerTracks: [{ playerId: 'player-2', segments: [] }],
    });
    const context = makeContext();
    const memory = makeMemory();
    const ctx = build(snapshot, context, memory);
    const rendered = renderStrategicContext(ctx);

    expect(rendered).toContain('OPPONENTS');
    expect(rendered).toContain('player-2');
  });
});
