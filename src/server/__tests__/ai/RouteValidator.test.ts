/**
 * RouteValidator.test.ts — Tests for RouteValidator.validate()
 *
 * Tests that route validation accepts valid routes and prunes infeasible stops.
 */

import { RouteValidator } from '../../services/ai/RouteValidator';
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

  describe('reorderStopsByProximity', () => {
    beforeEach(() => {
      // Set up grid points for test cities
      mockGridPoints.set('10,5', { row: 10, col: 5, terrain: TerrainType.MajorCity, name: 'Essen' });
      mockGridPoints.set('30,20', { row: 30, col: 20, terrain: TerrainType.MajorCity, name: 'Ruhr' });
      mockGridPoints.set('12,7', { row: 12, col: 7, terrain: TerrainType.MajorCity, name: 'Valencia' });
      mockGridPoints.set('25,15', { row: 25, col: 15, terrain: TerrainType.MajorCity, name: 'Berlin' });
      mockGridPoints.set('40,25', { row: 40, col: 25, terrain: TerrainType.MajorCity, name: 'Praha' });
    });

    it('should reorder closer pickup before farther pickup', () => {
      // Bot at Essen (10,5). Valencia (12,7) is closer than Ruhr (30,20).
      mockEstimateHopDistance.mockImplementation(
        (fromRow: number, fromCol: number, toRow: number, toCol: number) => {
          // Essen→Valencia = 3, Essen→Ruhr = 20, Valencia→Ruhr = 18, Ruhr→Berlin = 10, Valencia→Berlin = 15
          if (fromRow === 10 && toRow === 12) return 3;   // Essen→Valencia
          if (fromRow === 10 && toRow === 30) return 20;  // Essen→Ruhr
          if (fromRow === 12 && toRow === 30) return 18;  // Valencia→Ruhr
          if (fromRow === 12 && toRow === 25) return 15;  // Valencia→Berlin
          if (fromRow === 30 && toRow === 25) return 10;  // Ruhr→Berlin
          if (fromRow === 30 && toRow === 12) return 18;  // Ruhr→Valencia
          return 10;
        },
      );

      const stops = [
        { action: 'pickup' as const, loadType: 'Steel', city: 'Ruhr' },
        { action: 'deliver' as const, loadType: 'Steel', city: 'Berlin', demandCardId: 1, payment: 15 },
        { action: 'pickup' as const, loadType: 'Oranges', city: 'Valencia' },
        { action: 'deliver' as const, loadType: 'Oranges', city: 'Ruhr', demandCardId: 2, payment: 10 },
      ];

      const result = RouteValidator.reorderStopsByProximity(
        stops,
        { row: 10, col: 5 },
        mockGridPoints,
      );

      // Valencia (3 hops) should come before Ruhr (20 hops)
      expect(result[0]).toEqual(expect.objectContaining({ action: 'pickup', city: 'Valencia' }));
      // Oranges deliver at Ruhr should follow Oranges pickup
      const orangesPickupIdx = result.findIndex(s => s.action === 'pickup' && s.loadType === 'Oranges');
      const orangesDeliverIdx = result.findIndex(s => s.action === 'deliver' && s.loadType === 'Oranges');
      expect(orangesPickupIdx).toBeLessThan(orangesDeliverIdx);
    });

    it('should maintain pickup-before-delivery constraint', () => {
      mockEstimateHopDistance.mockImplementation(
        (fromRow: number, _fromCol: number, toRow: number, _toCol: number) => {
          // Make Berlin (deliver city) closer than Essen (pickup city)
          if (toRow === 25) return 2;  // →Berlin: very close
          if (toRow === 10) return 15; // →Essen: far
          return 10;
        },
      );

      const stops = [
        { action: 'pickup' as const, loadType: 'Coal', city: 'Essen' },
        { action: 'deliver' as const, loadType: 'Coal', city: 'Berlin', demandCardId: 1, payment: 15 },
      ];

      const result = RouteValidator.reorderStopsByProximity(
        stops,
        { row: 30, col: 20 }, // bot far from both
        mockGridPoints,
      );

      // Even though Berlin is closer, pickup must come before deliver
      expect(result[0]).toEqual(expect.objectContaining({ action: 'pickup', city: 'Essen' }));
      expect(result[1]).toEqual(expect.objectContaining({ action: 'deliver', city: 'Berlin' }));
    });

    it('should return single-stop route unchanged', () => {
      const stops = [
        { action: 'pickup' as const, loadType: 'Coal', city: 'Essen' },
      ];

      const result = RouteValidator.reorderStopsByProximity(
        stops,
        { row: 10, col: 5 },
        mockGridPoints,
      );

      expect(result).toEqual(stops);
      expect(result).toHaveLength(1);
    });

    it('should not change already-optimal order', () => {
      mockEstimateHopDistance.mockImplementation(
        (_fromRow: number, _fromCol: number, toRow: number, _toCol: number) => {
          if (toRow === 10) return 2;  // Essen: closest
          if (toRow === 25) return 5;  // Berlin: second
          return 20;
        },
      );

      const stops = [
        { action: 'pickup' as const, loadType: 'Coal', city: 'Essen' },
        { action: 'deliver' as const, loadType: 'Coal', city: 'Berlin', demandCardId: 1, payment: 15 },
      ];

      const result = RouteValidator.reorderStopsByProximity(
        stops,
        { row: 8, col: 4 }, // near Essen
        mockGridPoints,
      );

      // Order should be unchanged: pickup Essen then deliver Berlin
      expect(result[0]).toBe(stops[0]);
      expect(result[1]).toBe(stops[1]);
    });

    it('should handle same-city pickup and deliver correctly', () => {
      mockEstimateHopDistance.mockImplementation(
        (_fromRow: number, _fromCol: number, toRow: number, _toCol: number) => {
          if (toRow === 30) return 5;  // Ruhr
          if (toRow === 40) return 20; // Praha
          return 10;
        },
      );

      const stops = [
        { action: 'pickup' as const, loadType: 'Steel', city: 'Ruhr' },
        { action: 'deliver' as const, loadType: 'Oranges', city: 'Ruhr', demandCardId: 2, payment: 10 },
        { action: 'deliver' as const, loadType: 'Steel', city: 'Praha', demandCardId: 1, payment: 20 },
      ];

      const result = RouteValidator.reorderStopsByProximity(
        stops,
        { row: 10, col: 5 },
        mockGridPoints,
      );

      // Steel pickup must come before Steel deliver
      const steelPickupIdx = result.findIndex(s => s.action === 'pickup' && s.loadType === 'Steel');
      const steelDeliverIdx = result.findIndex(s => s.action === 'deliver' && s.loadType === 'Steel');
      expect(steelPickupIdx).toBeLessThan(steelDeliverIdx);
    });
  });

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
});
