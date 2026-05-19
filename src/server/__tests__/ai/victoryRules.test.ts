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
 */

import {
  computeGameState,
  cheapestUnconnectedMajorConnectorCost,
  cheapestNUnconnectedMajorConnectorCost,
  detectVictoryClinch,
  findFinalVictoryRoute,
} from '../../services/ai/victoryRules';
import { GameState, GameContext, TrainType, WorldSnapshot } from '../../../shared/types/GameTypes';
import type { BotMemoryState, DemandContext } from '../../../shared/types/GameTypes';

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
    const snapshot = makeSnapshot({ trainType: TrainType.Freight, loads: ['Beer'] });
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
    const snapshot = makeSnapshot({ trainType: TrainType.Freight, loads: [] });
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
    const result = findFinalVictoryRoute(snapshot, ctx, makeEndMemory());
    expect(result).toBeNull();
  });

  it('AC5 — returns route when payout covers cash gap AND connector cost', () => {
    const snapshot = makeSnapshot({ trainType: TrainType.Freight, loads: [] });
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
    const result = findFinalVictoryRoute(snapshot, ctx, makeEndMemory());
    expect(result).not.toBeNull();
    expect(result!.cashAtVictory).toBeGreaterThanOrEqual(250);
    expect(result!.majorConnectors).toContain('Madrid');
  });

  // ── AC6: tiebreak — higher cashAtVictory wins when equal turns ─────────
  it('AC6 — picks route with higher cashAtVictory when estimatedTurns are equal', () => {
    const snapshot = makeSnapshot({ trainType: TrainType.Freight, loads: [] });
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
    const result = findFinalVictoryRoute(snapshot, ctx, makeEndMemory());
    expect(result).not.toBeNull();
    // Coal pays 15M → cashAtVictory = 241+15=256 vs Beer pays 10M → 241+10=251
    // Same turns → higher cashAtVictory wins (Coal route)
    expect(result!.totalPayout).toBe(15);
  });

  // ── AC7: train capacity respected ─────────────────────────────────────
  it('AC7 — 2-load train never produces a 3-delivery candidate that exceeds capacity', () => {
    // With Freight (cap=2), we should only get 1- or 2-delivery routes.
    // A single demand of 9M won't clear 250 alone (money=241), but pair might.
    const snapshot = makeSnapshot({ trainType: TrainType.Freight, loads: [] });
    const demands = [
      makeDemand({ cardIndex: 0, payout: 9, isLoadOnTrain: false, isSupplyOnNetwork: true, isDeliveryOnNetwork: true, estimatedTurns: 2 }),
      makeDemand({ cardIndex: 1, payout: 9, isLoadOnTrain: false, isSupplyOnNetwork: true, isDeliveryOnNetwork: true, estimatedTurns: 2 }),
      makeDemand({ cardIndex: 2, payout: 9, isLoadOnTrain: false, isSupplyOnNetwork: true, isDeliveryOnNetwork: true, estimatedTurns: 2 }),
    ];
    const ctx = makeEndContext({ money: 232, demands });
    // 232 + 9+9=18 = 250 → pair exactly covers 250, route feasible
    const result = findFinalVictoryRoute(snapshot, ctx, makeEndMemory());
    expect(result).not.toBeNull();
    // The deliver stops count should be ≤ 2 (cap=2 for Freight)
    const deliverCount = result!.stops.filter((s) => s.action === 'deliver').length;
    expect(deliverCount).toBeLessThanOrEqual(2);
  });

  it('AC7 — 3-load train (HeavyFreight) can produce a 3-delivery candidate', () => {
    const snapshot = makeSnapshot({ trainType: TrainType.HeavyFreight, loads: [] });
    // Need 3 deliveries to reach 250M: money=241, each demand=3M. 3*3=9 → 241+9=250 exactly
    const demands = [
      makeDemand({ cardIndex: 0, payout: 3, isLoadOnTrain: false, isSupplyOnNetwork: true, isDeliveryOnNetwork: true, estimatedTurns: 1 }),
      makeDemand({ cardIndex: 1, payout: 3, isLoadOnTrain: false, isSupplyOnNetwork: true, isDeliveryOnNetwork: true, estimatedTurns: 1 }),
      makeDemand({ cardIndex: 2, payout: 3, isLoadOnTrain: false, isSupplyOnNetwork: true, isDeliveryOnNetwork: true, estimatedTurns: 1 }),
    ];
    const ctx = makeEndContext({ money: 241, demands });
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
    expect(findFinalVictoryRoute(snapshot, ctx, makeEndMemory())).toBeNull();
  });

  // ── reasoning string contains [final-victory] on success ───────────────
  it('includes [final-victory] in reasoning when returning a route', () => {
    const snapshot = makeSnapshot({ trainType: TrainType.Freight, loads: [] });
    const ctx = makeEndContext({
      money: 241,
      demands: [
        makeDemand({
          payout: 10,
          isLoadOnTrain: false,
          isSupplyOnNetwork: true,
          isDeliveryOnNetwork: true,
          estimatedTurns: 2,
        }),
      ],
    });
    const result = findFinalVictoryRoute(snapshot, ctx, makeEndMemory());
    expect(result).not.toBeNull();
    expect(result!.reasoning).toMatch(/^\[final-victory\]/);
  });
});
