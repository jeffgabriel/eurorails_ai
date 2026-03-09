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

// Mock MapTopology — loadGridPoints returns a controllable Map
const mockGridPoints = new Map<string, GridPointData>();
jest.mock('../../services/ai/MapTopology', () => ({
  loadGridPoints: jest.fn(() => mockGridPoints),
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
});
