import { ContextBuilder } from '../../services/ai/ContextBuilder';
import {
  GridPoint, TerrainType, TrackSegment,
  WorldSnapshot, BotSkillLevel, GameStatus,
} from '../../../shared/types/GameTypes';

// ── Helper factories ─────────────────────────────────────────────────────────

function makeGridPoint(
  row: number,
  col: number,
  overrides?: Partial<GridPoint>,
): GridPoint {
  return {
    id: `gp-${row}-${col}`,
    x: col * 40,
    y: row * 40,
    row,
    col,
    terrain: TerrainType.Clear,
    city: undefined,
    ...overrides,
  };
}

function makeCityPoint(
  row: number,
  col: number,
  name: string,
  terrain: TerrainType = TerrainType.SmallCity,
  availableLoads: string[] = [],
): GridPoint {
  return makeGridPoint(row, col, {
    terrain,
    city: { type: terrain, name, availableLoads },
  });
}

function makeSegment(
  fromRow: number, fromCol: number,
  toRow: number, toCol: number,
): TrackSegment {
  return {
    from: { x: fromCol * 40, y: fromRow * 40, row: fromRow, col: fromCol, terrain: TerrainType.Clear },
    to: { x: toCol * 40, y: toRow * 40, row: toRow, col: toCol, terrain: TerrainType.Clear },
    cost: 1,
  };
}

function makeWorldSnapshot(overrides?: {
  botLoads?: string[];
  botPosition?: { row: number; col: number } | null;
  botSegments?: TrackSegment[];
  botMoney?: number;
  botTrainType?: string;
  resolvedDemands?: Array<{
    cardId: number;
    demands: Array<{ city: string; loadType: string; payment: number }>;
  }>;
  opponents?: Array<{
    playerId: string;
    money: number;
    position: { row: number; col: number } | null;
    trainType: string;
    loads: string[];
    trackSummary?: string;
  }>;
  gameStatus?: GameStatus;
  turnNumber?: number;
}): WorldSnapshot {
  return {
    gameId: 'game-1',
    gameStatus: overrides?.gameStatus ?? 'initialBuild',
    turnNumber: overrides?.turnNumber ?? 1,
    bot: {
      playerId: 'bot-1',
      userId: 'user-bot-1',
      money: overrides?.botMoney ?? 50,
      position: overrides?.botPosition !== undefined ? overrides.botPosition : null,
      existingSegments: overrides?.botSegments ?? [],
      demandCards: [1, 2, 3],
      resolvedDemands: overrides?.resolvedDemands ?? [],
      trainType: overrides?.botTrainType ?? 'freight',
      loads: overrides?.botLoads ?? [],
      botConfig: { skillLevel: 'medium' },
      connectedMajorCityCount: 0,
    },
    allPlayerTracks: [],
    loadAvailability: {},
    opponents: overrides?.opponents,
  };
}

// ── Mocks ────────────────────────────────────────────────────────────────────

const mockEstimatePathCost = jest.fn<number, [number, number, number, number]>(() => 0);
const mockEstimateHopDistance = jest.fn<number, [number, number, number, number]>(() => 0);
const mockHexDistance = jest.fn((r1: number, c1: number, r2: number, c2: number): number => {
  const x1 = c1 - Math.floor(r1 / 2);
  const z1 = r1;
  const y1 = -x1 - z1;
  const x2 = c2 - Math.floor(r2 / 2);
  const z2 = r2;
  const y2 = -x2 - z2;
  return Math.max(Math.abs(x1 - x2), Math.abs(y1 - y2), Math.abs(z1 - z2));
});

const mockComputeLandmass = jest.fn(() => new Set<string>());
const mockComputeFerryRouteInfo = jest.fn(() => ({
  requiresFerry: false,
  canCrossFerry: false,
  departurePorts: [],
  arrivalPorts: [],
  cheapestFerryCost: 0,
}));

jest.mock('../../services/ai/MapTopology', () => ({
  estimatePathCost: (r1: number, c1: number, r2: number, c2: number) => mockEstimatePathCost(r1, c1, r2, c2),
  estimateHopDistance: (r1: number, c1: number, r2: number, c2: number) => mockEstimateHopDistance(r1, c1, r2, c2),
  hexDistance: (r1: number, c1: number, r2: number, c2: number) => mockHexDistance(r1, c1, r2, c2),
  computeLandmass: (...args: any[]) => mockComputeLandmass(...args),
  computeFerryRouteInfo: (...args: any[]) => mockComputeFerryRouteInfo(...args),
  makeKey: jest.fn((r: number, c: number) => `${r},${c}`),
  loadGridPoints: jest.fn(() => new Map()),
}));

jest.mock('../../../shared/services/majorCityGroups', () => ({
  getMajorCityGroups: jest.fn(() => [
    { cityName: 'Wien', center: { row: 37, col: 55 }, outposts: [] },
    { cityName: 'Berlin', center: { row: 24, col: 52 }, outposts: [] },
    { cityName: 'Paris', center: { row: 29, col: 32 }, outposts: [] },
  ]),
  getFerryEdges: jest.fn(() => []),
}));

// ── Helper for setting up estimatePathCost with a cost map ───────────────────

function setupPathCosts(costs: Record<string, number>): void {
  mockEstimatePathCost.mockImplementation(
    (fromRow: number, fromCol: number, toRow: number, toCol: number) => {
      if (fromRow === toRow && fromCol === toCol) return 0;
      const key1 = `${fromRow},${fromCol}->${toRow},${toCol}`;
      const key2 = `${toRow},${toCol}->${fromRow},${fromCol}`;
      return costs[key1] ?? costs[key2] ?? 0;
    },
  );
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('JIRA-127: Build Cost Estimator Accuracy', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('applyBudgetPenalty', () => {
    // Access private static method for direct testing
    const applyBudgetPenalty = (ContextBuilder as any).applyBudgetPenalty.bind(ContextBuilder);

    it('should return cost unchanged when <= 20M', () => {
      expect(applyBudgetPenalty(15)).toBe(15);
      expect(applyBudgetPenalty(20)).toBe(20);
      expect(applyBudgetPenalty(0)).toBe(0);
    });

    it('should apply 15% penalty per extra turn when cost > 20M', () => {
      // 25M: ceil(25/20)-1 = 1 extra turn → 25 * (1 + 0.15*1) = 28.75
      expect(applyBudgetPenalty(25)).toBeCloseTo(28.75, 2);
      // 40M: ceil(40/20)-1 = 1 extra turn → 40 * (1 + 0.15*1) = 46
      expect(applyBudgetPenalty(40)).toBeCloseTo(46, 2);
      // 41M: ceil(41/20)-1 = 2 extra turns → 41 * (1 + 0.15*2) = 53.3
      expect(applyBudgetPenalty(41)).toBeCloseTo(53.3, 2);
      // 60M: ceil(60/20)-1 = 2 extra turns → 60 * (1 + 0.15*2) = 78
      expect(applyBudgetPenalty(60)).toBeCloseTo(78, 2);
    });

    it('should scale penalty for large costs', () => {
      // 100M: ceil(100/20)-1 = 4 extra turns → 100 * (1 + 0.15*4) = 160
      expect(applyBudgetPenalty(100)).toBeCloseTo(160, 2);
    });
  });

  describe('multi-source frontier estimation (same-landmass)', () => {
    it('should use minimum cost from top 5 frontier nodes, not single closest by hexDistance', async () => {
      // Scenario: Bot has track with endpoints at (10,10), (10,11), (10,14), (10,15), (10,16).
      // Target city at (15,12).
      // Endpoint (10,11) is closest by hexDistance but has expensive Dijkstra path (mountain route).
      // Endpoint (10,14) is further by hexDistance but has cheap Dijkstra path (clear terrain).
      // With single-source (old behavior), we'd pick (10,11) and get cost 30.
      // With multi-source (new behavior), we also try (10,14) and find cost 10 → pick 10.
      const gridPoints: GridPoint[] = [
        makeCityPoint(10, 10, 'Berlin', TerrainType.MajorCity, ['Steel']),
        makeGridPoint(10, 11),
        makeGridPoint(10, 14),
        makeGridPoint(10, 15),
        makeGridPoint(10, 16),
        makeCityPoint(15, 12, 'TargetCity', TerrainType.SmallCity),
      ];

      // Make computeLandmass return a set that includes all track endpoints AND the target city
      mockComputeLandmass.mockReturnValue(new Set([
        '10,10', '10,11', '10,14', '10,15', '10,16', '15,12',
      ]));

      setupPathCosts({
        // (10,10) → target: expensive (mountain range)
        '10,10->15,12': 30,
        // (10,11) → target: expensive (mountain route — hex-closest but cost-worst)
        '10,11->15,12': 30,
        // (10,14) → target: cheap (clear terrain detour)
        '10,14->15,12': 10,
        // (10,15) → target: moderate
        '10,15->15,12': 18,
        // (10,16) → target: moderate
        '10,16->15,12': 20,
      });

      const snapshot = makeWorldSnapshot({
        botSegments: [
          makeSegment(10, 10, 10, 11),
          makeSegment(10, 14, 10, 15),
          makeSegment(10, 15, 10, 16),
        ],
        botPosition: { row: 10, col: 10 },
        resolvedDemands: [{
          cardId: 1,
          demands: [{ city: 'TargetCity', loadType: 'Steel', payment: 20 }],
        }],
      });

      const context = await ContextBuilder.build(snapshot, BotSkillLevel.Medium, gridPoints);
      const demand = context.demands.find(d => d.deliveryCity === 'TargetCity');

      expect(demand).toBeDefined();
      // Multi-source should find the cheapest path (10) not the hex-closest path (30)
      // Cost 10 is <= 20M so no budget penalty
      expect(demand!.estimatedTrackCostToDelivery).toBe(10);
    });

    it('should apply budget penalty when same-landmass estimate exceeds 20M', async () => {
      const gridPoints: GridPoint[] = [
        makeCityPoint(10, 10, 'Berlin', TerrainType.MajorCity, ['Steel']),
        makeGridPoint(10, 11),
        makeCityPoint(20, 20, 'FarCity', TerrainType.SmallCity),
      ];

      mockComputeLandmass.mockReturnValue(new Set([
        '10,10', '10,11', '20,20',
      ]));

      // Cost = 35M → 1 extra turn → 35 * 1.15 = 40.25 → rounded to 40
      setupPathCosts({
        '10,10->20,20': 35,
        '10,11->20,20': 35,
      });

      const snapshot = makeWorldSnapshot({
        botSegments: [makeSegment(10, 10, 10, 11)],
        botPosition: { row: 10, col: 10 },
        resolvedDemands: [{
          cardId: 1,
          demands: [{ city: 'FarCity', loadType: 'Steel', payment: 60 }],
        }],
      });

      const context = await ContextBuilder.build(snapshot, BotSkillLevel.Medium, gridPoints);
      const demand = context.demands.find(d => d.deliveryCity === 'FarCity');

      expect(demand).toBeDefined();
      // 35M * (1 + 0.15 * 1) = 40.25 → rounded to 40
      expect(demand!.estimatedTrackCostToDelivery).toBe(40);
    });
  });

  describe('increased fallback terrain multiplier (4.0)', () => {
    it('should use 4.0 multiplier in cold-start fallback when Dijkstra returns 0', async () => {
      // City far from any major city, Dijkstra returns 0 (unreachable).
      // The cold-start estimator uses hub model which picks the optimal starting
      // major city, so the exact delivery cost depends on multiple estimation paths.
      // We verify the estimate is positive and higher than old 3.0 multiplier.
      const gridPoints: GridPoint[] = [
        makeCityPoint(24, 52, 'Berlin', TerrainType.MajorCity, ['Steel']),
        makeCityPoint(29, 32, 'Paris', TerrainType.MajorCity, []),
        makeCityPoint(50, 50, 'RemoteCity', TerrainType.SmallCity, []),
      ];

      // All estimatePathCost returns 0 → triggers fallback
      setupPathCosts({});

      const snapshot = makeWorldSnapshot({
        botLoads: [],
        botPosition: null,
        botSegments: [],
        resolvedDemands: [{
          cardId: 1,
          demands: [{ city: 'RemoteCity', loadType: 'Steel', payment: 30 }],
        }],
        opponents: [],
        gameStatus: 'initialBuild',
      });

      const context = await ContextBuilder.build(snapshot, BotSkillLevel.Medium, gridPoints);
      const demand = context.demands.find(d => d.deliveryCity === 'RemoteCity');

      expect(demand).toBeDefined();
      // The cold-start path produces a positive estimate via fallback
      expect(demand!.estimatedTrackCostToDelivery).toBeGreaterThan(0);
      // The 4.0 multiplier should produce a meaningfully higher estimate
      // than the old 3.0 would (at minimum > 20M for distant cities)
      expect(demand!.estimatedTrackCostToDelivery).toBeGreaterThan(20);
    });

    it('should use 4.0 multiplier in same-landmass fallback when Dijkstra returns 0', async () => {
      const gridPoints: GridPoint[] = [
        makeCityPoint(10, 10, 'Berlin', TerrainType.MajorCity, ['Steel']),
        makeGridPoint(10, 11),
        makeCityPoint(20, 20, 'UnreachableCity', TerrainType.SmallCity),
      ];

      mockComputeLandmass.mockReturnValue(new Set([
        '10,10', '10,11', '20,20',
      ]));

      // All Dijkstra returns 0 — triggers fallback path
      setupPathCosts({});

      const snapshot = makeWorldSnapshot({
        botSegments: [makeSegment(10, 10, 10, 11)],
        botPosition: { row: 10, col: 10 },
        resolvedDemands: [{
          cardId: 1,
          demands: [{ city: 'UnreachableCity', loadType: 'Steel', payment: 40 }],
        }],
      });

      const context = await ContextBuilder.build(snapshot, BotSkillLevel.Medium, gridPoints);
      const demand = context.demands.find(d => d.deliveryCity === 'UnreachableCity');

      expect(demand).toBeDefined();
      // bestHexDist is from closest endpoint to target city
      // (10,11) to (20,20): hexDistance
      const hexDist = mockHexDistance(10, 11, 20, 20);
      const rawFallback = Math.round(hexDist * 4.0) + 3; // +3 SmallCity
      const extraTurns = Math.ceil(rawFallback / 20) - 1;
      const expected = extraTurns > 0
        ? Math.round(rawFallback * (1 + 0.15 * extraTurns))
        : rawFallback;
      expect(demand!.estimatedTrackCostToDelivery).toBe(expected);
    });
  });

  describe('cross-water and cold-start with budget penalty', () => {
    it('should apply budget penalty to cross-water ferry cost estimates', async () => {
      const { getFerryEdges } = require('../../../shared/services/majorCityGroups');
      (getFerryEdges as jest.Mock).mockReturnValue([
        { name: 'TestFerry', pointA: { row: 10, col: 12 }, pointB: { row: 30, col: 28 }, cost: 10 },
      ]);

      const gridPoints: GridPoint[] = [
        makeCityPoint(10, 10, 'Berlin', TerrainType.MajorCity, ['Steel']),
        makeGridPoint(10, 11),
        makeCityPoint(30, 30, 'IslandCity', TerrainType.SmallCity),
      ];

      // Cross-water: bot has no track at departure port
      // computeLandmass doesn't include target → cross-water path
      mockComputeLandmass.mockReturnValue(new Set(['10,10', '10,11']));
      mockComputeFerryRouteInfo.mockReturnValue({
        requiresFerry: true,
        canCrossFerry: false,
        departurePorts: [{ row: 10, col: 12 }],
        arrivalPorts: [{ row: 30, col: 28 }],
        cheapestFerryCost: 10,
      });

      // Near-side: track endpoint (10,11) → departure port (10,12) = 5M
      // Far-side: arrival port (30,28) → target (30,30) = 8M
      // Total: 5 + 10 (ferry) + 8 = 23M → 1 extra turn → 23 * 1.15 = 26.45 → 26
      setupPathCosts({
        '10,11->10,12': 5,
        '10,10->10,12': 7,
        '30,28->30,30': 8,
      });

      const snapshot = makeWorldSnapshot({
        botSegments: [makeSegment(10, 10, 10, 11)],
        botPosition: { row: 10, col: 10 },
        resolvedDemands: [{
          cardId: 1,
          demands: [{ city: 'IslandCity', loadType: 'Steel', payment: 50 }],
        }],
      });

      const context = await ContextBuilder.build(snapshot, BotSkillLevel.Medium, gridPoints);
      const demand = context.demands.find(d => d.deliveryCity === 'IslandCity');

      expect(demand).toBeDefined();
      // Total: 5 + 10 + 8 = 23M, with budget penalty: round(23 * 1.15) = round(26.45) = 26
      expect(demand!.estimatedTrackCostToDelivery).toBe(26);

      // Reset ferry mocks
      (getFerryEdges as jest.Mock).mockReturnValue([]);
    });

    it('should apply budget penalty to cold-start fromCity estimates', async () => {
      const gridPoints: GridPoint[] = [
        makeCityPoint(24, 52, 'Berlin', TerrainType.MajorCity, ['Steel']),
        makeCityPoint(29, 32, 'Paris', TerrainType.MajorCity, []),
        makeCityPoint(10, 10, 'SupplyCity', TerrainType.SmallCity, ['Steel']),
        makeCityPoint(40, 40, 'DeliveryCity', TerrainType.SmallCity),
      ];

      // Cold-start: fromCity path from SupplyCity to DeliveryCity = 35M
      setupPathCosts({
        '10,10->40,40': 35,
        // Major city → supply for supply cost estimation
        '24,52->10,10': 12,
        '29,32->10,10': 15,
      });

      const snapshot = makeWorldSnapshot({
        botLoads: [],
        botPosition: null,
        botSegments: [],
        resolvedDemands: [{
          cardId: 1,
          demands: [{ city: 'DeliveryCity', loadType: 'Steel', payment: 60 }],
        }],
        opponents: [],
        gameStatus: 'initialBuild',
      });

      const context = await ContextBuilder.build(snapshot, BotSkillLevel.Medium, gridPoints);
      const demand = context.demands.find(d => d.deliveryCity === 'DeliveryCity');

      expect(demand).toBeDefined();
      // Delivery cost: 35M → budget penalty: 35 * (1 + 0.15 * 1) = 40.25 → 40
      expect(demand!.estimatedTrackCostToDelivery).toBe(40);
    });
  });
});
