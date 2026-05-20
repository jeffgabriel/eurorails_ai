/**
 * RouteValidator.carriedLoadFromContext.test.ts
 *
 * Regression test for JIRA-222: RouteValidator.validate must read carried-load
 * state from context.loads (planner-working-state per JIRA-196/197 contract),
 * not from snapshot.bot.loads (DB-committed state that can lag post-delivery).
 *
 * AC1: Divergent state (context.loads = ['China'], snapshot.bot.loads = []) →
 *      single-stop DELIVER China @ Kaliningrad passes validation.
 * AC2: Both empty (context.loads = [], snapshot.bot.loads = []) →
 *      single-stop DELIVER China @ Kaliningrad fails validation with
 *      error matching "bot does not carry".
 * AC3: Wrong load in context (context.loads = ['Steel'], snapshot.bot.loads = []) →
 *      single-stop DELIVER China @ Kaliningrad fails validation with
 *      error matching "bot does not carry China".
 */

import { RouteValidator } from '../../services/ai/RouteValidator';
import { GameState } from '../../../shared/types/GameTypes';
import type {
  StrategicRoute,
  GameContext,
  WorldSnapshot,
  DemandContext,
} from '../../../shared/types/GameTypes';

// Mock MapTopology — pure predicate test, no topology queries needed
jest.mock('../../services/MapTopology', () => ({
  loadGridPoints: jest.fn(() => new Map()),
  estimateHopDistance: jest.fn(() => 10),
  getHexNeighbors: jest.fn(() => []),
  getTerrainCost: jest.fn(() => 1),
  gridToPixel: jest.fn(() => ({ x: 0, y: 0 })),
  _resetCache: jest.fn(),
}));

// ── Fixtures ──────────────────────────────────────────────────────────────────

function makeDemand(overrides: Partial<DemandContext> = {}): DemandContext {
  return {
    cardIndex: 30,
    loadType: 'China',
    supplyCity: 'Leipzig',
    deliveryCity: 'Kaliningrad',
    payout: 22,
    isSupplyReachable: true,
    isDeliveryReachable: true,
    isSupplyOnNetwork: true,
    isDeliveryOnNetwork: true,
    estimatedTrackCostToSupply: 0,
    estimatedTrackCostToDelivery: 0,
    isLoadAvailable: true,
    isLoadOnTrain: true,
    ferryRequired: false,
    loadChipTotal: 4,
    loadChipCarried: 1,
    estimatedTurns: 3,
    demandScore: 0,
    efficiencyPerTurn: 0,
    networkCitiesUnlocked: 0,
    victoryMajorCitiesEnRoute: 0,
    isAffordable: true,
    projectedFundsAfterDelivery: 100,
    ...overrides,
  };
}

function makeContext(overrides: Partial<GameContext> = {}): GameContext {
  return {
    position: { city: 'Leipzig', row: 10, col: 5 },
    money: 100,
    trainType: 'Freight',
    speed: 9,
    capacity: 2,
    loads: ['China'],
    connectedMajorCities: ['Berlin', 'Kaliningrad'],
    unconnectedMajorCities: [],
    totalMajorCities: 15,
    trackSummary: 'Leipzig-Kaliningrad corridor',
    turnBuildCost: 0,
    demands: [makeDemand()],
    canDeliver: [],
    canPickup: [],
    gameState: GameState.Mid,
    ...overrides,
  } as GameContext;
}

function makeSnapshot(loads: string[] = []): WorldSnapshot {
  return {
    gameId: '1a10d393-10a1-4216-8155-fa1ec62a690f',
    gameStatus: 'active',
    turnNumber: 5,
    bot: {
      playerId: 'bot-1',
      userId: 'user-bot-1',
      money: 100,
      position: { row: 10, col: 5 },
      existingSegments: [],
      demandCards: [],
      resolvedDemands: [],
      trainType: 'Freight',
      loads,
      botConfig: null,
      connectedMajorCityCount: 2,
    },
    allPlayerTracks: [],
    loadAvailability: {},
  } as WorldSnapshot;
}

function makeSingleDeliverRoute(): StrategicRoute {
  return {
    stops: [
      { action: 'deliver', loadType: 'China', city: 'Kaliningrad', demandCardId: 30, payment: 22 },
    ],
    currentStopIndex: 0,
    phase: 'travel',
    createdAtTurn: 5,
    reasoning: 'Post-delivery replan: China already on train, deliver to Kaliningrad',
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('RouteValidator JIRA-222: carried-load gate reads context.loads', () => {
  beforeEach(() => {
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  // AC1: divergent state — context.loads has the load, snapshot.bot.loads is empty
  it('AC1: accepts single-stop DELIVER China@Kaliningrad when context.loads=[China] and snapshot.bot.loads=[]', () => {
    const route = makeSingleDeliverRoute();
    const context = makeContext({ loads: ['China'] });
    const snapshot = makeSnapshot([]); // DB-committed state is empty (post-delivery lag)

    const result = RouteValidator.validate(route, context, snapshot);

    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
    // No error should mention "does not carry"
    result.errors.forEach(err => {
      expect(err).not.toMatch(/does not carry/i);
    });
  });

  // AC2: both empty — no load in context or snapshot, no prior PICKUP → reject
  it('AC2: rejects single-stop DELIVER China@Kaliningrad when context.loads=[] and snapshot.bot.loads=[]', () => {
    const route = makeSingleDeliverRoute();
    const context = makeContext({ loads: [] });
    const snapshot = makeSnapshot([]);

    const result = RouteValidator.validate(route, context, snapshot);

    expect(result.valid).toBe(false);
    const hasCarryError = result.errors.some(err => /bot does not carry/i.test(err));
    expect(hasCarryError).toBe(true);
  });

  // AC3: wrong load type in context — Steel is carried, but China is being delivered → reject
  it('AC3: rejects single-stop DELIVER China@Kaliningrad when context.loads=[Steel] (different load)', () => {
    const route = makeSingleDeliverRoute();
    const context = makeContext({ loads: ['Steel'] }); // different load
    const snapshot = makeSnapshot([]);

    const result = RouteValidator.validate(route, context, snapshot);

    expect(result.valid).toBe(false);
    const hasCarryError = result.errors.some(err => /bot does not carry China/i.test(err));
    expect(hasCarryError).toBe(true);
  });

  // Guard: existing snapshot-only paths still work when both sources are consistent
  it('guard: accepts DELIVER China when both context.loads and snapshot.bot.loads contain China', () => {
    const route = makeSingleDeliverRoute();
    const context = makeContext({ loads: ['China'] });
    const snapshot = makeSnapshot(['China']); // both consistent

    const result = RouteValidator.validate(route, context, snapshot);

    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  // Guard: standard PICKUP→DELIVER route still works (no regression)
  it('guard: standard PICKUP+DELIVER route accepted when context.loads=[] (no carried load needed)', () => {
    const route: StrategicRoute = {
      stops: [
        { action: 'pickup', loadType: 'China', city: 'Leipzig' },
        { action: 'deliver', loadType: 'China', city: 'Kaliningrad', demandCardId: 30, payment: 22 },
      ],
      currentStopIndex: 0,
      phase: 'travel',
      createdAtTurn: 5,
      reasoning: 'Standard pickup-then-deliver route',
    };
    const context = makeContext({ loads: [] }); // nothing carried yet
    const snapshot = makeSnapshot([]);

    const result = RouteValidator.validate(route, context, snapshot);

    expect(result.valid).toBe(true);
  });
});
