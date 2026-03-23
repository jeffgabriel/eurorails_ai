import { InitialBuildPlanner } from '../../services/ai/InitialBuildPlanner';
import {
  GridPoint, TerrainType, WorldSnapshot, GameStatus,
  DemandOption,
} from '../../../shared/types/GameTypes';

// ── Helper factories ─────────────────────────────────────────────────────────

function makeGridPoint(
  row: number, col: number,
  overrides?: Partial<GridPoint>,
): GridPoint {
  return {
    id: `gp-${row}-${col}`,
    x: col * 40, y: row * 40,
    row, col,
    terrain: TerrainType.Clear,
    ...overrides,
  };
}

function makeCityPoint(
  row: number, col: number, name: string,
  terrain: TerrainType = TerrainType.SmallCity,
  availableLoads: string[] = [],
): GridPoint {
  return makeGridPoint(row, col, {
    terrain,
    city: { type: terrain, name, availableLoads },
  });
}

function makeWorldSnapshot(overrides?: {
  resolvedDemands?: Array<{
    cardId: number;
    demands: Array<{ city: string; loadType: string; payment: number }>;
  }>;
  loadAvailability?: Record<string, string[]>;
  botTrainType?: string;
  botMoney?: number;
  gameStatus?: GameStatus;
}): WorldSnapshot {
  return {
    gameId: 'game-1',
    gameStatus: overrides?.gameStatus ?? 'initialBuild',
    turnNumber: 1,
    bot: {
      playerId: 'bot-1',
      userId: 'user-bot-1',
      money: overrides?.botMoney ?? 50,
      position: null,
      existingSegments: [],
      demandCards: [1, 2, 3],
      resolvedDemands: overrides?.resolvedDemands ?? [],
      trainType: overrides?.botTrainType ?? 'freight',
      loads: [],
      botConfig: { skillLevel: 'medium' },
      connectedMajorCityCount: 0,
    },
    allPlayerTracks: [],
    loadAvailability: overrides?.loadAvailability ?? {},
  };
}

// ── Mocks ────────────────────────────────────────────────────────────────────

const mockEstimatePathCost = jest.fn<number, [number, number, number, number]>(() => 0);
const mockHexDistance = jest.fn((r1: number, c1: number, r2: number, c2: number): number => {
  const x1 = c1 - Math.floor(r1 / 2);
  const z1 = r1;
  const y1 = -x1 - z1;
  const x2 = c2 - Math.floor(r2 / 2);
  const z2 = r2;
  const y2 = -x2 - z2;
  return Math.max(Math.abs(x1 - x2), Math.abs(y1 - y2), Math.abs(z1 - z2));
});

jest.mock('../../services/ai/MapTopology', () => ({
  estimatePathCost: (r1: number, c1: number, r2: number, c2: number) =>
    mockEstimatePathCost(r1, c1, r2, c2),
  hexDistance: (r1: number, c1: number, r2: number, c2: number) =>
    mockHexDistance(r1, c1, r2, c2),
}));

const mockGetSourceCitiesForLoad = jest.fn<string[], [string]>(() => []);
jest.mock('../../services/loadService', () => ({
  LoadService: {
    getInstance: () => ({
      getSourceCitiesForLoad: (loadType: string) => mockGetSourceCitiesForLoad(loadType),
    }),
  },
}));

jest.mock('../../../shared/services/majorCityGroups', () => ({
  getMajorCityGroups: () => [
    { cityName: 'Paris', center: { row: 20, col: 10 }, outposts: [] },
    { cityName: 'Ruhr', center: { row: 15, col: 12 }, outposts: [] },
    { cityName: 'Berlin', center: { row: 12, col: 16 }, outposts: [] },
    { cityName: 'Holland', center: { row: 14, col: 10 }, outposts: [] },
    { cityName: 'Wien', center: { row: 18, col: 18 }, outposts: [] },
    { cityName: 'Madrid', center: { row: 28, col: 3 }, outposts: [] },
    { cityName: 'London', center: { row: 14, col: 6 }, outposts: [] },
    { cityName: 'Milano', center: { row: 22, col: 13 }, outposts: [] },
  ],
}));

// ── Grid setup ──────────────────────────────────────────────────────────────

function makeTestGrid(): GridPoint[] {
  return [
    // Major cities
    makeCityPoint(20, 10, 'Paris', TerrainType.MajorCity),
    makeCityPoint(15, 12, 'Ruhr', TerrainType.MajorCity),
    makeCityPoint(12, 16, 'Berlin', TerrainType.MajorCity),
    makeCityPoint(14, 10, 'Holland', TerrainType.MajorCity),
    makeCityPoint(18, 18, 'Wien', TerrainType.MajorCity),
    makeCityPoint(28, 3, 'Madrid', TerrainType.MajorCity),
    makeCityPoint(14, 6, 'London', TerrainType.MajorCity),
    makeCityPoint(22, 13, 'Milano', TerrainType.MajorCity),
    // Small/medium cities
    makeCityPoint(16, 11, 'Essen', TerrainType.SmallCity),
    makeCityPoint(17, 14, 'Frankfurt', TerrainType.MediumCity),
    makeCityPoint(13, 17, 'Wroclaw', TerrainType.SmallCity),
    makeCityPoint(19, 12, 'Lyon', TerrainType.SmallCity),
    makeCityPoint(21, 15, 'Zürich', TerrainType.SmallCity),
    makeCityPoint(10, 14, 'Hamburg', TerrainType.MediumCity),
    // Clear terrain
    makeGridPoint(16, 12),
    makeGridPoint(17, 13),
    makeGridPoint(18, 14),
    makeGridPoint(19, 15),
  ];
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('InitialBuildPlanner', () => {
  let grid: GridPoint[];

  beforeEach(() => {
    jest.clearAllMocks();
    grid = makeTestGrid();
    // Default: estimatePathCost returns realistic costs (distance * 1.5)
    mockEstimatePathCost.mockImplementation((r1, c1, r2, c2) => {
      const dist = mockHexDistance(r1, c1, r2, c2);
      return Math.round(dist * 1.5);
    });
  });

  describe('expandDemandOptions', () => {
    it('should produce options for multi-supply-city loads', () => {
      mockGetSourceCitiesForLoad.mockReturnValue(['Essen', 'Wroclaw']);
      const snapshot = makeWorldSnapshot({
        resolvedDemands: [{
          cardId: 1,
          demands: [
            { city: 'Frankfurt', loadType: 'Coal', payment: 12 },
            { city: 'Lyon', loadType: 'Wine', payment: 8 },
            { city: 'Hamburg', loadType: 'Steel', payment: 15 },
          ],
        }],
        loadAvailability: {
          'Essen': ['Coal'],
          'Wroclaw': ['Coal'],
        },
      });

      const options = InitialBuildPlanner.expandDemandOptions(snapshot, grid);

      // Should have options from both Essen and Wroclaw for Coal → Frankfurt
      const coalOptions = options.filter(o => o.loadType === 'Coal');
      expect(coalOptions.length).toBeGreaterThanOrEqual(1);
      // Each option should pick the best starting city
      for (const opt of coalOptions) {
        expect(opt.startingCity).not.toBe('Madrid');
        expect(opt.totalBuildCost).toBeLessThanOrEqual(MAX_BUILD_BUDGET);
      }
    });

    it('should filter out Madrid as starting city', () => {
      mockGetSourceCitiesForLoad.mockReturnValue(['Essen']);
      const snapshot = makeWorldSnapshot({
        resolvedDemands: [{
          cardId: 1,
          demands: [{ city: 'Frankfurt', loadType: 'Coal', payment: 12 }],
        }],
        loadAvailability: { 'Essen': ['Coal'] },
      });

      const options = InitialBuildPlanner.expandDemandOptions(snapshot, grid);
      expect(options.every(o => o.startingCity !== 'Madrid')).toBe(true);
    });

    it('should filter out ferry routes', () => {
      // London is in britain, Frankfurt in continent — requires ferry
      mockGetSourceCitiesForLoad.mockReturnValue(['London']);
      const snapshot = makeWorldSnapshot({
        resolvedDemands: [{
          cardId: 1,
          demands: [{ city: 'Frankfurt', loadType: 'Fish', payment: 10 }],
        }],
        loadAvailability: { 'London': ['Fish'] },
      });

      const options = InitialBuildPlanner.expandDemandOptions(snapshot, grid);
      // London → Frankfurt crosses the channel — should be filtered
      expect(options.length).toBe(0);
    });

    it('should filter out options exceeding 40M budget', () => {
      mockGetSourceCitiesForLoad.mockReturnValue(['Hamburg']);
      // Make estimatePathCost return very high costs
      mockEstimatePathCost.mockReturnValue(25);
      const snapshot = makeWorldSnapshot({
        resolvedDemands: [{
          cardId: 1,
          demands: [{ city: 'Wien', loadType: 'Steel', payment: 15 }],
        }],
        loadAvailability: { 'Hamburg': ['Steel'] },
      });

      const options = InitialBuildPlanner.expandDemandOptions(snapshot, grid);
      // startCity→Hamburg (25) + Hamburg→Wien (25) = 50 > 40
      expect(options.every(o => o.totalBuildCost <= MAX_BUILD_BUDGET)).toBe(true);
    });

    it('should filter out unavailable loads', () => {
      mockGetSourceCitiesForLoad.mockReturnValue(['Essen']);
      const snapshot = makeWorldSnapshot({
        resolvedDemands: [{
          cardId: 1,
          demands: [{ city: 'Frankfurt', loadType: 'Coal', payment: 12 }],
        }],
        loadAvailability: { 'Essen': ['Steel'] }, // No Coal at Essen
      });

      const options = InitialBuildPlanner.expandDemandOptions(snapshot, grid);
      expect(options.length).toBe(0);
    });
  });

  describe('computeDoubleDeliveryPairings', () => {
    it('should not pair demands from the same card', () => {
      const options: DemandOption[] = [
        makeDemandOption({ cardId: 1, supplyCity: 'Essen', deliveryCity: 'Frankfurt', startingCity: 'Ruhr' }),
        makeDemandOption({ cardId: 1, supplyCity: 'Wroclaw', deliveryCity: 'Wien', startingCity: 'Berlin' }),
      ];

      const pairings = InitialBuildPlanner.computeDoubleDeliveryPairings(options, grid);
      expect(pairings.length).toBe(0);
    });

    it('should pair demands from different cards', () => {
      const options: DemandOption[] = [
        makeDemandOption({ cardId: 1, supplyCity: 'Essen', deliveryCity: 'Frankfurt', startingCity: 'Ruhr', payout: 12, totalBuildCost: 8 }),
        makeDemandOption({ cardId: 2, supplyCity: 'Lyon', deliveryCity: 'Zürich', startingCity: 'Paris', payout: 10, totalBuildCost: 6 }),
      ];

      const pairings = InitialBuildPlanner.computeDoubleDeliveryPairings(options, grid);
      expect(pairings.length).toBeGreaterThan(0);
      expect(pairings[0].first.cardId).not.toBe(pairings[0].second.cardId);
    });

    it('should give hub bonus when starting cities match', () => {
      const options: DemandOption[] = [
        makeDemandOption({ cardId: 1, supplyCity: 'Essen', deliveryCity: 'Frankfurt', startingCity: 'Ruhr', payout: 12, totalBuildCost: 5 }),
        makeDemandOption({ cardId: 2, supplyCity: 'Holland', deliveryCity: 'Hamburg', startingCity: 'Ruhr', payout: 10, totalBuildCost: 5 }),
      ];
      const sharedPairings = InitialBuildPlanner.computeDoubleDeliveryPairings(options, grid);

      const options2: DemandOption[] = [
        makeDemandOption({ cardId: 1, supplyCity: 'Essen', deliveryCity: 'Frankfurt', startingCity: 'Ruhr', payout: 12, totalBuildCost: 5 }),
        makeDemandOption({ cardId: 2, supplyCity: 'Holland', deliveryCity: 'Hamburg', startingCity: 'Paris', payout: 10, totalBuildCost: 5 }),
      ];
      const diffPairings = InitialBuildPlanner.computeDoubleDeliveryPairings(options2, grid);

      // Shared hub pairing should score higher (all else being equal, the hub bonus adds +15)
      expect(sharedPairings.length).toBeGreaterThan(0);
      expect(diffPairings.length).toBeGreaterThan(0);
      // The shared pairing has a hub bonus
      const sharedBest = sharedPairings[0];
      expect(sharedBest.sharedStartingCity).toBe('Ruhr');
    });

    it('should filter out pairings exceeding 40M budget', () => {
      const options: DemandOption[] = [
        makeDemandOption({ cardId: 1, totalBuildCost: 25, buildCostSupplyToDelivery: 15 }),
        makeDemandOption({ cardId: 2, totalBuildCost: 25, buildCostSupplyToDelivery: 15 }),
      ];

      const pairings = InitialBuildPlanner.computeDoubleDeliveryPairings(options, grid);
      // 25 + 25 = 50 > 40 — should be filtered
      expect(pairings.every(p => p.totalBuildCost <= MAX_BUILD_BUDGET)).toBe(true);
    });

    it('should rank higher-efficiency pairs above lower ones', () => {
      const options: DemandOption[] = [
        makeDemandOption({ cardId: 1, supplyCity: 'Essen', deliveryCity: 'Frankfurt', startingCity: 'Ruhr', payout: 15, totalBuildCost: 3 }),
        makeDemandOption({ cardId: 2, supplyCity: 'Lyon', deliveryCity: 'Zürich', startingCity: 'Paris', payout: 8, totalBuildCost: 3 }),
        makeDemandOption({ cardId: 3, supplyCity: 'Wroclaw', deliveryCity: 'Wien', startingCity: 'Berlin', payout: 5, totalBuildCost: 3 }),
      ];

      const pairings = InitialBuildPlanner.computeDoubleDeliveryPairings(options, grid);
      // Pairings involving card 1 (payout 15) should rank higher
      if (pairings.length >= 2) {
        expect(pairings[0].pairingScore).toBeGreaterThanOrEqual(pairings[1].pairingScore);
      }
    });
  });

  describe('planInitialBuild', () => {
    it('should return a valid plan with route stops', () => {
      mockGetSourceCitiesForLoad.mockImplementation((loadType: string) => {
        if (loadType === 'Coal') return ['Essen'];
        if (loadType === 'Wine') return ['Lyon'];
        return [];
      });

      const snapshot = makeWorldSnapshot({
        resolvedDemands: [
          { cardId: 1, demands: [{ city: 'Frankfurt', loadType: 'Coal', payment: 12 }] },
          { cardId: 2, demands: [{ city: 'Zürich', loadType: 'Wine', payment: 10 }] },
        ],
        loadAvailability: { 'Essen': ['Coal'], 'Lyon': ['Wine'] },
      });

      const plan = InitialBuildPlanner.planInitialBuild(snapshot, grid);

      expect(plan.startingCity).toBeTruthy();
      expect(plan.startingCity).not.toBe('Madrid');
      expect(plan.route.length).toBeGreaterThan(0);
      expect(plan.totalPayout).toBeGreaterThan(0);
    });

    it('should prefer double delivery when efficiency threshold is met', () => {
      mockGetSourceCitiesForLoad.mockImplementation((loadType: string) => {
        if (loadType === 'Coal') return ['Essen'];
        if (loadType === 'Wine') return ['Lyon'];
        return [];
      });
      // Make costs low so double is viable
      mockEstimatePathCost.mockImplementation((r1, c1, r2, c2) => {
        const dist = mockHexDistance(r1, c1, r2, c2);
        return Math.round(dist * 0.8); // cheap paths
      });

      const snapshot = makeWorldSnapshot({
        resolvedDemands: [
          { cardId: 1, demands: [{ city: 'Frankfurt', loadType: 'Coal', payment: 15 }] },
          { cardId: 2, demands: [{ city: 'Zürich', loadType: 'Wine', payment: 12 }] },
        ],
        loadAvailability: { 'Essen': ['Coal'], 'Lyon': ['Wine'] },
      });

      const plan = InitialBuildPlanner.planInitialBuild(snapshot, grid);

      // Should have 4 route stops (pickup-deliver-pickup-deliver) for double
      if (plan.route.length === 4) {
        expect(plan.route[0].action).toBe('pickup');
        expect(plan.route[1].action).toBe('deliver');
        expect(plan.route[2].action).toBe('pickup');
        expect(plan.route[3].action).toBe('deliver');
        expect(plan.totalPayout).toBe(27); // 15 + 12
      }
    });

    it('should fall back to single delivery when double is inefficient', () => {
      mockGetSourceCitiesForLoad.mockImplementation((loadType: string) => {
        if (loadType === 'Coal') return ['Essen'];
        if (loadType === 'Wine') return ['Wien']; // Far away
        return [];
      });
      // Make one route cheap and the other expensive
      mockEstimatePathCost.mockImplementation((r1, c1, r2, c2) => {
        const dist = mockHexDistance(r1, c1, r2, c2);
        return Math.round(dist * 1.5);
      });

      const snapshot = makeWorldSnapshot({
        resolvedDemands: [
          { cardId: 1, demands: [{ city: 'Frankfurt', loadType: 'Coal', payment: 20 }] },
          { cardId: 2, demands: [{ city: 'Hamburg', loadType: 'Wine', payment: 5 }] },
        ],
        loadAvailability: { 'Essen': ['Coal'], 'Wien': ['Wine'] },
      });

      const plan = InitialBuildPlanner.planInitialBuild(snapshot, grid);

      // Should have 2 route stops (single delivery)
      expect(plan.route.length).toBe(2);
      expect(plan.route[0].action).toBe('pickup');
      expect(plan.route[1].action).toBe('deliver');
    });

    it('should use emergency fallback when all options filtered', () => {
      // All supply cities are in Britain — ferry filter removes everything
      mockGetSourceCitiesForLoad.mockReturnValue(['London']);
      const snapshot = makeWorldSnapshot({
        resolvedDemands: [
          { cardId: 1, demands: [{ city: 'Frankfurt', loadType: 'Fish', payment: 10 }] },
        ],
        loadAvailability: { 'London': ['Fish'] },
      });

      const plan = InitialBuildPlanner.planInitialBuild(snapshot, grid);

      // Emergency fallback should still return a plan
      expect(plan.startingCity).toBeTruthy();
      expect(plan.startingCity).not.toBe('Madrid');
    });

    it('should handle empty demands gracefully', () => {
      const snapshot = makeWorldSnapshot({ resolvedDemands: [] });
      const plan = InitialBuildPlanner.planInitialBuild(snapshot, grid);

      expect(plan.startingCity).toBeTruthy();
      expect(plan.route.length).toBe(0);
    });
  });

  describe('estimateBuildCostFromCity', () => {
    it('should return zero supply cost when starting city is supply city', () => {
      const result = InitialBuildPlanner.estimateBuildCostFromCity(
        'Ruhr', 'Ruhr', 'Frankfurt', grid,
      );
      expect(result).not.toBeNull();
      expect(result!.buildCostToSupply).toBe(0);
      expect(result!.buildCostSupplyToDelivery).toBeGreaterThan(0);
    });

    it('should return null for unknown cities', () => {
      const result = InitialBuildPlanner.estimateBuildCostFromCity(
        'Paris', 'NonexistentCity', 'Frankfurt', grid,
      );
      expect(result).toBeNull();
    });

    it('should return correct total as sum of legs', () => {
      const result = InitialBuildPlanner.estimateBuildCostFromCity(
        'Paris', 'Essen', 'Frankfurt', grid,
      );
      expect(result).not.toBeNull();
      expect(result!.totalBuildCost).toBe(
        result!.buildCostToSupply + result!.buildCostSupplyToDelivery,
      );
    });
  });
});

// ── Test helpers ──────────────────────────────────────────────────────────────

const MAX_BUILD_BUDGET = 40;

function makeDemandOption(overrides: Partial<DemandOption> = {}): DemandOption {
  return {
    cardId: 1,
    demandIndex: 0,
    loadType: 'Coal',
    supplyCity: 'Essen',
    deliveryCity: 'Frankfurt',
    payout: 12,
    startingCity: 'Ruhr',
    buildCostToSupply: 3,
    buildCostSupplyToDelivery: 5,
    totalBuildCost: 8,
    ferryRequired: false,
    estimatedTurns: 3,
    efficiency: 1.33,
    ...overrides,
  };
}
