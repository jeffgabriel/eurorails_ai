/**
 * RouteValidator.test.ts — Tests for RouteValidator.validate()
 *
 * Tests that route validation accepts valid routes and prunes infeasible stops.
 */

import { RouteValidator } from '../../services/ai/RouteValidator';
import { TRIP_PLAN_SCHEMA, ROUTE_SCHEMA } from '../../services/ai/schemas';
import {
  StrategicRoute,
  GameContext,
  WorldSnapshot,
  TerrainType,
  DemandContext,
} from '../../../shared/types/GameTypes';
import { GridPointData } from '../../services/ai/MapTopology';

// Mock MapTopology — loadGridPoints and estimateHopDistance return controllable values
const mockGridPoints = new Map<string, GridPointData>();
const mockEstimateHopDistance = jest.fn<number, [number, number, number, number]>(() => 10);
jest.mock('../../services/ai/MapTopology', () => ({
  loadGridPoints: jest.fn(() => mockGridPoints),
  estimateHopDistance: (r1: number, c1: number, r2: number, c2: number) => mockEstimateHopDistance(r1, c1, r2, c2),
  getHexNeighbors: jest.fn(() => []),
  getTerrainCost: jest.fn(() => 1),
  gridToPixel: jest.fn(() => ({ x: 0, y: 0 })),
  _resetCache: jest.fn(),
}));

// ── Fixtures ──────────────────────────────────────────────────────────

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
    estimatedTrackCostToSupply: 0,
    estimatedTrackCostToDelivery: 0,
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
    money: 50,
    trainType: 'Freight',
    speed: 9,
    capacity: 2,
    loads: [],
    connectedMajorCities: ['Berlin'],
    unconnectedMajorCities: [],
    totalMajorCities: 15,
    trackSummary: 'Essen-Berlin corridor',
    turnBuildCost: 0,
    demands: [makeDemand()],
    canDeliver: [],
    canPickup: [],
    ...overrides,
  } as GameContext;
}

function makeSnapshot(money: number = 50): WorldSnapshot {
  return {
    gameId: 'g1',
    gameStatus: 'active',
    turnNumber: 5,
    bot: {
      playerId: 'bot-1',
      userId: 'user-bot-1',
      money,
      position: { row: 10, col: 5 },
      existingSegments: [],
      demandCards: [],
      resolvedDemands: [],
      trainType: 'Freight',
      loads: [],
      botConfig: null,
      connectedMajorCityCount: 2,
    },
    allPlayerTracks: [],
    loadAvailability: {},
  } as WorldSnapshot;
}

function makeRoute(overrides: Partial<StrategicRoute> = {}): StrategicRoute {
  return {
    stops: [
      { action: 'pickup', loadType: 'Coal', city: 'Essen' },
      { action: 'deliver', loadType: 'Coal', city: 'Berlin', demandCardId: 1, payment: 15 },
    ],
    currentStopIndex: 0,
    phase: 'build',
    createdAtTurn: 5,
    reasoning: 'Test route',
    ...overrides,
  };
}

// ── Tests ──────────────────────────────────────────────────────────────

describe('RouteValidator', () => {
  beforeEach(() => {
    mockGridPoints.clear();
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('should validate a route with feasible stops', () => {
    const route = makeRoute();
    const result = RouteValidator.validate(route, makeContext(), makeSnapshot());
    expect(result.valid).toBe(true);
  });

  it('should proceed normally for a standard route', () => {
    const route = makeRoute();
    const result = RouteValidator.validate(route, makeContext(), makeSnapshot());
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  // reorderStopsByProximity tests migrated to RouteOptimizer.test.ts (JIRA-184)

  describe('checkCumulativeBudget — delivery payout credit', () => {
    it('should credit payout from demand.payout when stop.payment is undefined', () => {
      const demand = makeDemand({ payout: 19, estimatedTrackCostToDelivery: 0 });
      const route = makeRoute({
        stops: [
          { action: 'pickup', loadType: 'Coal', city: 'Essen' },
          { action: 'deliver', loadType: 'Coal', city: 'Berlin', demandCardId: 1 },
          // payment intentionally omitted — should fall back to demand.payout
        ],
      });
      const context = makeContext({ demands: [demand] });
      const result = RouteValidator.validate(route, context, makeSnapshot());
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('should use stop.payment when provided (existing behavior)', () => {
      const demand = makeDemand({ payout: 19 });
      const route = makeRoute({
        stops: [
          { action: 'pickup', loadType: 'Coal', city: 'Essen' },
          { action: 'deliver', loadType: 'Coal', city: 'Berlin', demandCardId: 1, payment: 25 },
        ],
      });
      const context = makeContext({ demands: [demand] });
      const result = RouteValidator.validate(route, context, makeSnapshot());
      expect(result.valid).toBe(true);
    });

    it('should keep later stop feasible when earlier delivery payout covers its cost (payment omitted)', () => {
      // Multi-stop route: pickup Steel, deliver Steel (19M payout), pickup Tourists, deliver Tourists
      // Bot starts with 10M — not enough for Tourists delivery track (15M) without Steel payout credit
      const steelDemand = makeDemand({
        cardIndex: 1,
        loadType: 'Steel',
        supplyCity: 'Essen',
        deliveryCity: 'Berlin',
        payout: 19,
        estimatedTrackCostToSupply: 0,
        estimatedTrackCostToDelivery: 0,
        isSupplyOnNetwork: true,
        isDeliveryOnNetwork: true,
      });
      const touristDemand = makeDemand({
        cardIndex: 2,
        loadType: 'Tourists',
        supplyCity: 'Essen',
        deliveryCity: 'Napoli',
        payout: 32,
        estimatedTrackCostToSupply: 0,
        estimatedTrackCostToDelivery: 15,
        isSupplyOnNetwork: true,
        isDeliveryOnNetwork: false,
      });
      const route = makeRoute({
        stops: [
          { action: 'pickup', loadType: 'Steel', city: 'Essen' },
          { action: 'deliver', loadType: 'Steel', city: 'Berlin', demandCardId: 1 },
          // payment omitted — must fall back to steelDemand.payout (19M)
          { action: 'pickup', loadType: 'Tourists', city: 'Essen' },
          { action: 'deliver', loadType: 'Tourists', city: 'Napoli', demandCardId: 2 },
        ],
      });
      const context = makeContext({ demands: [steelDemand, touristDemand] });
      // Bot starts with 10M — after Steel delivery payout (19M), has 29M, enough for Napoli track (15M)
      const result = RouteValidator.validate(route, context, makeSnapshot(10));
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });
  });

  describe('JIRA-93: delivery-less route rejection after pruning', () => {
    it('rejects route with only pickup stops (no delivery stops)', () => {
      // Route has only pickups — no delivery means no payout, no destination
      const route = makeRoute({
        stops: [
          { action: 'pickup', loadType: 'Coal', city: 'Essen' },
          { action: 'pickup', loadType: 'Wine', city: 'Essen' },
        ],
      });
      const context = makeContext({
        demands: [
          makeDemand({ cardIndex: 1, loadType: 'Coal', supplyCity: 'Essen' }),
          makeDemand({ cardIndex: 2, loadType: 'Wine', supplyCity: 'Essen' }),
        ],
      });

      const result = RouteValidator.validate(route, context, makeSnapshot());

      expect(result.valid).toBe(false);
      expect(result.errors).toContain('Route has no delivery stops after pruning — not viable');
    });

    it('accepts route with pickup + delivery after pruning (control case)', () => {
      const route = makeRoute({
        stops: [
          { action: 'pickup', loadType: 'Coal', city: 'Essen' },
          { action: 'deliver', loadType: 'Coal', city: 'Berlin', demandCardId: 1, payment: 15 },
        ],
      });
      const context = makeContext({
        demands: [makeDemand()],
      });

      const result = RouteValidator.validate(route, context, makeSnapshot());

      expect(result.valid).toBe(true);
    });

    it('rejects route where delivery gets budget-pruned, leaving orphaned pickup', () => {
      // Delivery requires expensive track (50M) but bot only has 10M
      // Budget pruning removes delivery → paired pruning removes pickup → zero deliveries → rejected
      const demand = makeDemand({
        estimatedTrackCostToDelivery: 50,
        isDeliveryOnNetwork: false,
      });
      const route = makeRoute({
        stops: [
          { action: 'pickup', loadType: 'Coal', city: 'Essen' },
          { action: 'deliver', loadType: 'Coal', city: 'Berlin', demandCardId: 1, payment: 15 },
        ],
      });
      const context = makeContext({ demands: [demand] });

      const result = RouteValidator.validate(route, context, makeSnapshot(10));

      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes('no delivery stops after pruning') || e.includes('budget'))).toBe(true);
    });
  });

  // ── JIRA-96: $0M cash gate ───────────────────────────────────────────
  describe('JIRA-96: $0M cash gate rejects routes requiring track', () => {
    it('rejects route when bot has $0M and delivery requires track', () => {
      const demand = makeDemand({
        estimatedTrackCostToDelivery: 5,
        isDeliveryOnNetwork: false,
      });
      const route = makeRoute();
      const context = makeContext({ demands: [demand] });

      const result = RouteValidator.validate(route, context, makeSnapshot(0));

      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes('cannot afford track'))).toBe(true);
    });

    it('accepts route when bot has $0M but all cities on network', () => {
      const demand = makeDemand({
        isSupplyOnNetwork: true,
        isDeliveryOnNetwork: true,
        estimatedTrackCostToSupply: 0,
        estimatedTrackCostToDelivery: 0,
      });
      const route = makeRoute();
      const context = makeContext({ demands: [demand] });

      const result = RouteValidator.validate(route, context, makeSnapshot(0));

      expect(result.valid).toBe(true);
    });

    it('partially prunes multi-stop route at $0M when only some stops need track', () => {
      const coalDemand = makeDemand({
        loadType: 'Coal',
        supplyCity: 'Essen',
        deliveryCity: 'Berlin',
        isDeliveryOnNetwork: true,
        estimatedTrackCostToDelivery: 0,
        payout: 15,
      });
      const steelDemand = makeDemand({
        loadType: 'Steel',
        supplyCity: 'Hamburg',
        deliveryCity: 'Frankfurt',
        isDeliveryOnNetwork: false,
        estimatedTrackCostToDelivery: 5,
        payout: 20,
      });
      const route = makeRoute({
        stops: [
          { action: 'pickup', loadType: 'Coal', city: 'Essen' },
          { action: 'deliver', loadType: 'Coal', city: 'Berlin', demandCardId: 1, payment: 15 },
          { action: 'pickup', loadType: 'Steel', city: 'Hamburg' },
          { action: 'deliver', loadType: 'Steel', city: 'Frankfurt', demandCardId: 2, payment: 20 },
        ],
      });
      const context = makeContext({ demands: [coalDemand, steelDemand] });

      const result = RouteValidator.validate(route, context, makeSnapshot(0));

      // Coal route (on network) should survive; Steel route (needs track) should be pruned
      expect(result.valid).toBe(true);
      expect(result.prunedRoute).toBeDefined();
      expect(result.prunedRoute!.stops.some(s => s.loadType === 'Coal')).toBe(true);
      expect(result.prunedRoute!.stops.some(s => s.loadType === 'Steel')).toBe(false);
    });

    it('accepts route when bot has cash and delivery requires track within budget', () => {
      const demand = makeDemand({
        estimatedTrackCostToDelivery: 5,
        isDeliveryOnNetwork: false,
      });
      const route = makeRoute();
      const context = makeContext({ demands: [demand] });

      const result = RouteValidator.validate(route, context, makeSnapshot(10));

      expect(result.valid).toBe(true);
    });
  });

  describe('JIRA-77: null bot position during initial build', () => {
    it('should validate multi-stop route when bot position is null', () => {
      // During initial build, bot has no position (train not placed yet).
      // RouteValidator should skip reorder-by-proximity and keep LLM's original stop order.
      const route = makeRoute({
        stops: [
          { action: 'pickup', loadType: 'Coal', city: 'Essen' },
          { action: 'deliver', loadType: 'Coal', city: 'Berlin', demandCardId: 1, payment: 15 },
        ],
      });
      const snapshot = makeSnapshot();
      snapshot.bot.position = null as any;

      const result = RouteValidator.validate(route, makeContext(), snapshot);
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });
  });

  // JIRA-107: "OnTrain" sentinel prevents phantom pickup stops
  describe('JIRA-107: OnTrain sentinel', () => {
    it('should reject pickup at a city that does not match any demand supplyCity', () => {
      // LLM hallucinates pickup(Fish@SomeCity) but the only Fish demand has supplyCity "OnTrain"
      const route = makeRoute({
        stops: [
          { action: 'pickup', loadType: 'Fish', city: 'Hamburg' },
          { action: 'deliver', loadType: 'Fish', city: 'Berlin', demandCardId: 1, payment: 20 },
        ],
      });
      const context = makeContext({
        demands: [
          makeDemand({
            loadType: 'Fish',
            supplyCity: 'OnTrain',
            deliveryCity: 'Berlin',
            isLoadOnTrain: true,
          }),
        ],
      });
      const result = RouteValidator.validate(route, context, makeSnapshot());
      // The pickup stop should be pruned — Hamburg doesn't match "OnTrain"
      // Route may be invalid if pruning leaves no viable delivery path
      const errors = result.errors ?? [];
      const hasPickupMismatchError = errors.some(e => e.includes('not a known supply city'));
      expect(hasPickupMismatchError).toBe(true);
    });
  });

  // JIRA-121 / JIRA-123 reorderStopsByProximity tests migrated to RouteOptimizer.test.ts (JIRA-184)

  // ── JIRA-123: Same-card conflict detection ──────────────────────────────────

  describe('JIRA-123: same-card conflict detection', () => {
    it('should reject lower-efficiency deliver when two delivers share the same card', () => {
      // Card 1 has two demands: Coal→Berlin (5 M/turn) and Wine→Paris (3 M/turn)
      // Route tries to deliver both — validator should keep Coal (higher efficiency)
      const coalDemand = makeDemand({
        cardIndex: 1,
        loadType: 'Coal',
        supplyCity: 'Essen',
        deliveryCity: 'Berlin',
        payout: 15,
        efficiencyPerTurn: 5,
      });
      const wineDemand = makeDemand({
        cardIndex: 1,
        loadType: 'Wine',
        supplyCity: 'Bordeaux',
        deliveryCity: 'Paris',
        payout: 12,
        efficiencyPerTurn: 3,
      });
      const route = makeRoute({
        stops: [
          { action: 'pickup', loadType: 'Coal', city: 'Essen' },
          { action: 'deliver', loadType: 'Coal', city: 'Berlin', demandCardId: 1, payment: 15 },
          { action: 'pickup', loadType: 'Wine', city: 'Bordeaux' },
          { action: 'deliver', loadType: 'Wine', city: 'Paris', demandCardId: 1, payment: 12 },
        ],
      });
      const context = makeContext({ demands: [coalDemand, wineDemand] });
      const result = RouteValidator.validate(route, context, makeSnapshot());

      // Wine deliver should be pruned (lower efficiency), Coal should survive
      expect(result.valid).toBe(true);
      expect(result.prunedRoute).toBeDefined();
      expect(result.prunedRoute!.stops.some(s => s.loadType === 'Coal' && s.action === 'deliver')).toBe(true);
      expect(result.prunedRoute!.stops.some(s => s.loadType === 'Wine')).toBe(false);
      expect(result.errors.some(e => e.includes('card #1'))).toBe(true);
    });

    it('should pass both delivers when they reference different cards', () => {
      const coalDemand = makeDemand({
        cardIndex: 1,
        loadType: 'Coal',
        supplyCity: 'Essen',
        deliveryCity: 'Berlin',
        payout: 15,
        efficiencyPerTurn: 5,
      });
      const wineDemand = makeDemand({
        cardIndex: 2,
        loadType: 'Wine',
        supplyCity: 'Bordeaux',
        deliveryCity: 'Paris',
        payout: 12,
        efficiencyPerTurn: 3,
      });
      const route = makeRoute({
        stops: [
          { action: 'pickup', loadType: 'Coal', city: 'Essen' },
          { action: 'deliver', loadType: 'Coal', city: 'Berlin', demandCardId: 1, payment: 15 },
          { action: 'pickup', loadType: 'Wine', city: 'Bordeaux' },
          { action: 'deliver', loadType: 'Wine', city: 'Paris', demandCardId: 2, payment: 12 },
        ],
      });
      const context = makeContext({ demands: [coalDemand, wineDemand] });
      const result = RouteValidator.validate(route, context, makeSnapshot());

      expect(result.valid).toBe(true);
      // No pruning needed — no same-card conflict
      const deliverStops = (result.prunedRoute?.stops ?? route.stops).filter(s => s.action === 'deliver');
      expect(deliverStops).toHaveLength(2);
    });

    it('should pass single deliver stop without conflict', () => {
      const route = makeRoute();
      const result = RouteValidator.validate(route, makeContext(), makeSnapshot());
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });
  });

  // JIRA-123 detour-cost threshold tests migrated to RouteOptimizer.test.ts (JIRA-184)

  // ── JIRA-181: Carried-load fix ───────────────────────────────────────────────

  describe('JIRA-181: carried-load DELIVER feasibility', () => {
    it('DELIVER Steel is feasible when bot carries Steel and no PICKUP Steel is in the candidate', () => {
      // Bot is carrying Steel — deliver without any PICKUP stop in the route
      const route = makeRoute({
        stops: [
          { action: 'deliver', loadType: 'Steel', city: 'Berlin', demandCardId: 1, payment: 15 },
        ],
      });
      const context = makeContext({
        demands: [makeDemand({ loadType: 'Steel', supplyCity: 'Ruhr', deliveryCity: 'Berlin', payout: 15 })],
      });
      const snapshot = makeSnapshot();
      snapshot.bot.loads = ['Steel']; // bot carries Steel

      const result = RouteValidator.validate(route, context, snapshot);
      // Should be valid — Steel is carried, so DELIVER is feasible
      expect(result.valid).toBe(true);
      const finalStops = result.prunedRoute?.stops ?? route.stops;
      expect(finalStops.some(s => s.action === 'deliver' && s.loadType === 'Steel')).toBe(true);
    });

    it('DELIVER Ham is infeasible when bot does not carry Ham and no PICKUP Ham is in the candidate (orphan deliver)', () => {
      const route = makeRoute({
        stops: [
          { action: 'deliver', loadType: 'Ham', city: 'Stuttgart', demandCardId: 2, payment: 10 },
        ],
      });
      const context = makeContext({
        demands: [makeDemand({ loadType: 'Ham', supplyCity: 'Frankfurt', deliveryCity: 'Stuttgart', payout: 10 })],
      });
      const snapshot = makeSnapshot();
      snapshot.bot.loads = []; // bot does NOT carry Ham

      const result = RouteValidator.validate(route, context, snapshot);
      // All stops infeasible — DELIVER Ham is orphaned
      expect(result.valid).toBe(false);
    });

    it('DELIVER Steel is infeasible when demandCardId is 0', () => {
      const route = makeRoute({
        stops: [
          { action: 'pickup', loadType: 'Steel', city: 'Ruhr' },
          { action: 'deliver', loadType: 'Steel', city: 'Berlin', demandCardId: 0, payment: 15 },
        ],
      });
      const context = makeContext({
        demands: [makeDemand({ loadType: 'Steel', supplyCity: 'Ruhr', deliveryCity: 'Berlin', payout: 15 })],
      });
      const snapshot = makeSnapshot();

      const result = RouteValidator.validate(route, context, snapshot);
      // DELIVER with demandCardId=0 is rejected (use DROP instead)
      expect(result.valid).toBe(false);
    });

    it('DELIVER Steel is infeasible when demandCardId is unmatched in resolvedDemands', () => {
      const route = makeRoute({
        stops: [
          { action: 'pickup', loadType: 'Steel', city: 'Ruhr' },
          { action: 'deliver', loadType: 'Steel', city: 'Berlin', demandCardId: 999, payment: 15 },
        ],
      });
      const context = makeContext({
        demands: [makeDemand({ loadType: 'Steel', supplyCity: 'Ruhr', deliveryCity: 'Berlin', payout: 15 })],
      });
      const snapshot = makeSnapshot();
      // resolvedDemands is non-empty, but card 999 is not in it
      snapshot.bot.resolvedDemands = [
        { cardId: 1, demands: [{ city: 'Berlin', loadType: 'Coal', payment: 10 }] },
      ];

      const result = RouteValidator.validate(route, context, snapshot);
      // DELIVER with unmatched demandCardId is rejected
      expect(result.valid).toBe(false);
    });

    it('DROP Sheep @ Holland is feasible at any reachable city regardless of demand cards', () => {
      const route = makeRoute({
        stops: [
          { action: 'drop', loadType: 'Sheep', city: 'Holland' },
          { action: 'pickup', loadType: 'Coal', city: 'Essen' },
          { action: 'deliver', loadType: 'Coal', city: 'Berlin', demandCardId: 1, payment: 15 },
        ],
      });
      const context = makeContext({
        demands: [makeDemand({ loadType: 'Coal', supplyCity: 'Essen', deliveryCity: 'Berlin', payout: 15 })],
      });
      const snapshot = makeSnapshot();

      const result = RouteValidator.validate(route, context, snapshot);
      // DROP stop should survive — it's always feasible
      expect(result.valid).toBe(true);
      const finalStops = result.prunedRoute?.stops ?? route.stops;
      expect(finalStops.some(s => s.action === 'drop' && s.loadType === 'Sheep')).toBe(true);
    });

    it('turn-54 Candidate 2 fixture: PICKUP Steel@null, DELIVER Steel@Wroclaw, DELIVER Ham@Stuttgart with carrying [Sheep, Steel] → survives as [DELIVER Steel@Wroclaw]', () => {
      // This is the exact scenario from the JIRA-181 bug report.
      // PICKUP Steel @ null is infeasible (no known supply city).
      // DELIVER Steel @ Wroclaw: Steel IS carried — feasible.
      // DELIVER Ham @ Stuttgart: Ham NOT carried, no PICKUP Ham — infeasible (orphan).
      const route = makeRoute({
        stops: [
          { action: 'pickup', loadType: 'Steel', city: 'null' }, // sentinel city name
          { action: 'deliver', loadType: 'Steel', city: 'Wroclaw', demandCardId: 1, payment: 14 },
          { action: 'deliver', loadType: 'Ham', city: 'Stuttgart', demandCardId: 2, payment: 12 },
        ],
      });
      const context = makeContext({
        demands: [
          makeDemand({ loadType: 'Steel', supplyCity: 'Ruhr', deliveryCity: 'Wroclaw', payout: 14 }),
          makeDemand({ cardIndex: 2, loadType: 'Ham', supplyCity: 'Frankfurt', deliveryCity: 'Stuttgart', payout: 12 }),
        ],
      });
      const snapshot = makeSnapshot();
      snapshot.bot.loads = ['Sheep', 'Steel']; // bot carries Sheep and Steel

      const result = RouteValidator.validate(route, context, snapshot);
      // Route should be valid but pruned — only DELIVER Steel@Wroclaw survives
      expect(result.valid).toBe(true);
      const finalStops = result.prunedRoute?.stops ?? route.stops;
      expect(finalStops).toHaveLength(1);
      expect(finalStops[0]).toMatchObject({ action: 'deliver', loadType: 'Steel', city: 'Wroclaw' });
    });

    it('removed pickup→deliver pair-prune: DELIVER Steel kept when PICKUP Steel pruned but bot carries Steel', () => {
      // Old behavior: PICKUP Steel @ bad-city pruned → DELIVER Steel pruned (bug).
      // New behavior: PICKUP Steel @ bad-city pruned → DELIVER Steel KEPT (bot carries Steel).
      const route = makeRoute({
        stops: [
          { action: 'pickup', loadType: 'Steel', city: 'NonExistentCity' }, // infeasible
          { action: 'deliver', loadType: 'Steel', city: 'Berlin', demandCardId: 1, payment: 15 },
        ],
      });
      const context = makeContext({
        demands: [makeDemand({ loadType: 'Steel', supplyCity: 'Ruhr', deliveryCity: 'Berlin', payout: 15 })],
      });
      const snapshot = makeSnapshot();
      snapshot.bot.loads = ['Steel']; // bot carries Steel

      const result = RouteValidator.validate(route, context, snapshot);
      // PICKUP is infeasible (wrong city), but DELIVER should survive because bot carries Steel
      expect(result.valid).toBe(true);
      const finalStops = result.prunedRoute?.stops ?? route.stops;
      expect(finalStops.some(s => s.action === 'deliver' && s.loadType === 'Steel')).toBe(true);
    });

    it('retained deliver→pickup pair-prune: PICKUP Steel pruned when DELIVER Steel is infeasible (no card)', () => {
      // When the DELIVER is infeasible (wrong delivery city, no demand match),
      // the paired PICKUP should also be pruned.
      const route = makeRoute({
        stops: [
          { action: 'pickup', loadType: 'Steel', city: 'Essen' }, // valid supply city
          { action: 'deliver', loadType: 'Steel', city: 'NonExistentCity', demandCardId: 1, payment: 15 }, // no demand
        ],
      });
      const context = makeContext({
        demands: [makeDemand({ loadType: 'Steel', supplyCity: 'Essen', deliveryCity: 'Berlin', payout: 15 })],
      });
      const snapshot = makeSnapshot();

      const result = RouteValidator.validate(route, context, snapshot);
      // DELIVER is infeasible (no demand for NonExistentCity) → PICKUP is also pruned
      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
    });

    it('regression: single-component trip (no carried loads, standard PICKUP + DELIVER) produces identical validator output to pre-change golden snapshot', () => {
      // Golden snapshot: standard PICKUP Coal @ Essen, DELIVER Coal @ Berlin
      // Validator should accept both stops and return valid=true, no errors, no pruning.
      const route = makeRoute({
        stops: [
          { action: 'pickup', loadType: 'Coal', city: 'Essen' },
          { action: 'deliver', loadType: 'Coal', city: 'Berlin', demandCardId: 1, payment: 15 },
        ],
      });
      const context = makeContext({
        demands: [makeDemand({ loadType: 'Coal', supplyCity: 'Essen', deliveryCity: 'Berlin', payout: 15 })],
      });
      const snapshot = makeSnapshot(); // no carried loads, no resolvedDemands

      const result = RouteValidator.validate(route, context, snapshot);
      // Identical to pre-change: valid, no errors, no pruning
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
      expect(result.prunedRoute).toBeUndefined();
    });
  });
});

// ── JIRA-181: Schema enum tests (standalone) ────────────────────────────────

describe('JIRA-181: Schema enum includes DROP', () => {
  it('TRIP_PLAN_SCHEMA stop action enum includes PICKUP and DELIVER (DROP removed per JIRA-190)', () => {
    const stopSchema = TRIP_PLAN_SCHEMA.properties.candidates.items.properties.stops.items.properties.action;
    expect(stopSchema.enum).toContain('PICKUP');
    expect(stopSchema.enum).toContain('DELIVER');
    // JIRA-190: DROP removed from trip-planner LLM schema to prevent hallucinated drop stops
    expect(stopSchema.enum).not.toContain('DROP');
  });

  it('ROUTE_SCHEMA stop action enum includes PICKUP, DELIVER, and DROP', () => {
    const stopSchema = ROUTE_SCHEMA.properties.route.items.properties.action;
    expect(stopSchema.enum).toContain('PICKUP');
    expect(stopSchema.enum).toContain('DELIVER');
    expect(stopSchema.enum).toContain('DROP');
  });
});
