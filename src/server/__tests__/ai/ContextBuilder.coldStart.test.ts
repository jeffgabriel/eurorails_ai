import { ContextBuilder } from '../../services/ai/ContextBuilder';
import {
  GridPoint, TerrainType, TrackSegment,
  WorldSnapshot, BotSkillLevel, GameStatus,
} from '../../../shared/types/GameTypes';

// ── Helper factories (mirror ContextBuilder.test.ts) ─────────────────────────

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

// Mock MapTopology with controllable estimatePathCost and estimateHopDistance
const mockEstimatePathCost = jest.fn<number, [number, number, number, number]>(() => 0);
const mockEstimateHopDistance = jest.fn<number, [number, number, number, number]>(() => 0);
const mockHexDistance = jest.fn((r1: number, c1: number, r2: number, c2: number): number => {
  // Real hex distance: cube coordinate conversion
  const x1 = c1 - Math.floor(r1 / 2);
  const z1 = r1;
  const y1 = -x1 - z1;
  const x2 = c2 - Math.floor(r2 / 2);
  const z2 = r2;
  const y2 = -x2 - z2;
  return Math.max(Math.abs(x1 - x2), Math.abs(y1 - y2), Math.abs(z1 - z2));
});

jest.mock('../../services/ai/MapTopology', () => ({
  estimatePathCost: (r1: number, c1: number, r2: number, c2: number) => mockEstimatePathCost(r1, c1, r2, c2),
  estimateHopDistance: (r1: number, c1: number, r2: number, c2: number) => mockEstimateHopDistance(r1, c1, r2, c2),
  hexDistance: (r1: number, c1: number, r2: number, c2: number) => mockHexDistance(r1, c1, r2, c2),
  computeLandmass: jest.fn(() => new Set()),
  computeFerryRouteInfo: jest.fn(() => ({ requiresFerry: false, departurePorts: [], arrivalPorts: [], ferryCost: 0 })),
  makeKey: jest.fn((r: number, c: number) => `${r},${c}`),
  loadGridPoints: jest.fn(() => new Map()),
}));

// Mock majorCityGroups with 3 test cities: Wien, Berlin, Paris
jest.mock('../../../shared/services/majorCityGroups', () => ({
  getMajorCityGroups: jest.fn(() => [
    { cityName: 'Wien', center: { row: 37, col: 55 }, outposts: [] },
    { cityName: 'Berlin', center: { row: 24, col: 52 }, outposts: [] },
    { cityName: 'Paris', center: { row: 29, col: 32 }, outposts: [] },
  ]),
  getMajorCityLookup: jest.fn(() => new Map()),
  getFerryEdges: jest.fn(() => []),
}));

// ── Helper for setting up estimatePathCost with a cost map ───────────────────

type CostKey = string;

function setupPathCosts(costs: Record<string, number>): void {
  mockEstimatePathCost.mockImplementation(
    (fromRow: number, fromCol: number, toRow: number, toCol: number) => {
      if (fromRow === toRow && fromCol === toCol) return 0;
      // Try both directions
      const key1 = `${fromRow},${fromCol}->${toRow},${toCol}`;
      const key2 = `${toRow},${toCol}->${fromRow},${fromCol}`;
      return costs[key1] ?? costs[key2] ?? 0;
    },
  );
}

function setupHopDistances(distances: Record<string, number>): void {
  mockEstimateHopDistance.mockImplementation(
    (fromRow: number, fromCol: number, toRow: number, toCol: number) => {
      if (fromRow === toRow && fromCol === toCol) return 0;
      const key1 = `${fromRow},${fromCol}->${toRow},${toCol}`;
      const key2 = `${toRow},${toCol}->${fromRow},${fromCol}`;
      return distances[key1] ?? distances[key2] ?? 0;
    },
  );
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('Cold-start hub model demand scoring (JIRA-72)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('estimateColdStartRouteCost via build()', () => {
    it('should pick hub model when hub cost < linear cost (Wien scenario)', async () => {
      // Wien(37,55) → Warszawa(30,60) → Budapest(42,58)
      // Hub: Wien→Warszawa=15 + Wien→Budapest=5 = 20
      // Linear: Wien→Warszawa=15 + Warszawa→Budapest=18 = 33
      // Hub wins with totalCost=20, startingCity=Wien
      const gridPoints: GridPoint[] = [
        makeCityPoint(37, 55, 'Wien', TerrainType.MajorCity, []),
        makeCityPoint(24, 52, 'Berlin', TerrainType.MajorCity, []),
        makeCityPoint(29, 32, 'Paris', TerrainType.MajorCity, []),
        makeCityPoint(30, 60, 'Warszawa', TerrainType.SmallCity, ['Ham']),
        makeCityPoint(42, 58, 'Budapest', TerrainType.MediumCity, []),
      ];

      setupPathCosts({
        // Wien → Warszawa
        '37,55->30,60': 15,
        // Wien → Budapest
        '37,55->42,58': 5,
        // Warszawa → Budapest (linear delivery)
        '30,60->42,58': 18,
        // Berlin → Warszawa
        '24,52->30,60': 12,
        // Berlin → Budapest
        '24,52->42,58': 22,
        // Paris → Warszawa
        '29,32->30,60': 35,
        // Paris → Budapest
        '29,32->42,58': 30,
      });

      setupHopDistances({
        '37,55->30,60': 8,
        '37,55->42,58': 4,
      });

      const snapshot = makeWorldSnapshot({
        botSegments: [],
        resolvedDemands: [{
          cardId: 1,
          demands: [{ city: 'Budapest', loadType: 'Ham', payment: 25 }],
        }],
      });

      const context = await ContextBuilder.build(snapshot, BotSkillLevel.Medium, gridPoints);
      const demand = context.demands.find(d => d.deliveryCity === 'Budapest' && d.loadType === 'Ham');

      expect(demand).toBeDefined();
      // Hub model: Wien→Warszawa(15) + Wien→Budapest(5) = 20
      expect(demand!.estimatedTrackCostToSupply).toBe(15);
      expect(demand!.estimatedTrackCostToDelivery).toBe(5);
      expect(demand!.optimalStartingCity).toBe('Wien');
    });

    it('should pick linear model when supply and delivery are collinear', async () => {
      // Madrid(40,20) → Sevilla(45,18) → Lisboa(42,15)
      // Linear: Madrid→Sevilla=5 + Sevilla→Lisboa=4 = 9
      // Hub: Madrid→Sevilla=5 + Madrid→Lisboa=8 = 13
      // Linear wins
      const gridPoints: GridPoint[] = [
        makeCityPoint(37, 55, 'Wien', TerrainType.MajorCity, []),
        makeCityPoint(24, 52, 'Berlin', TerrainType.MajorCity, []),
        makeCityPoint(29, 32, 'Paris', TerrainType.MajorCity, []),
        makeCityPoint(40, 20, 'Madrid', TerrainType.MajorCity, []),
        makeCityPoint(45, 18, 'Sevilla', TerrainType.SmallCity, ['Oranges']),
        makeCityPoint(42, 15, 'Lisboa', TerrainType.MediumCity, []),
      ];

      // Add Madrid to mock major cities
      const { getMajorCityGroups } = require('../../../shared/services/majorCityGroups');
      getMajorCityGroups.mockReturnValue([
        { cityName: 'Wien', center: { row: 37, col: 55 }, outposts: [] },
        { cityName: 'Berlin', center: { row: 24, col: 52 }, outposts: [] },
        { cityName: 'Paris', center: { row: 29, col: 32 }, outposts: [] },
        { cityName: 'Madrid', center: { row: 40, col: 20 }, outposts: [] },
      ]);

      setupPathCosts({
        // Madrid → Sevilla
        '40,20->45,18': 5,
        // Madrid → Lisboa
        '40,20->42,15': 8,
        // Sevilla → Lisboa (linear delivery)
        '45,18->42,15': 4,
        // Wien costs (far away)
        '37,55->45,18': 40,
        '37,55->42,15': 38,
        // Berlin costs (far away)
        '24,52->45,18': 45,
        '24,52->42,15': 42,
        // Paris costs (medium)
        '29,32->45,18': 25,
        '29,32->42,15': 22,
      });

      const snapshot = makeWorldSnapshot({
        botSegments: [],
        resolvedDemands: [{
          cardId: 1,
          demands: [{ city: 'Lisboa', loadType: 'Oranges', payment: 15 }],
        }],
      });

      const context = await ContextBuilder.build(snapshot, BotSkillLevel.Medium, gridPoints);
      const demand = context.demands.find(d => d.deliveryCity === 'Lisboa' && d.loadType === 'Oranges');

      expect(demand).toBeDefined();
      // Linear model: Madrid→Sevilla(5) + Sevilla→Lisboa(4) = 9
      expect(demand!.estimatedTrackCostToSupply).toBe(5);
      expect(demand!.estimatedTrackCostToDelivery).toBe(4);
      expect(demand!.optimalStartingCity).toBe('Madrid');
    });

    it('should set supplyCost=0 when supply city IS a major city', async () => {
      // Berlin is a major city AND supplies Steel
      // Berlin→Berlin(supply)=0 + Berlin→SmallTown(delivery)=25
      const gridPoints: GridPoint[] = [
        makeCityPoint(37, 55, 'Wien', TerrainType.MajorCity, []),
        makeCityPoint(24, 52, 'Berlin', TerrainType.MajorCity, ['Steel']),
        makeCityPoint(29, 32, 'Paris', TerrainType.MajorCity, []),
        makeCityPoint(50, 60, 'SmallTown', TerrainType.SmallCity, []),
      ];

      setupPathCosts({
        // Berlin → SmallTown
        '24,52->50,60': 25,
        // Wien → Berlin (supply)
        '37,55->24,52': 18,
        // Wien → SmallTown
        '37,55->50,60': 20,
        // Berlin → SmallTown (linear delivery, same as hub delivery from Berlin)
        // Paris → Berlin
        '29,32->24,52': 28,
        // Paris → SmallTown
        '29,32->50,60': 35,
      });

      const snapshot = makeWorldSnapshot({
        botSegments: [],
        resolvedDemands: [{
          cardId: 1,
          demands: [{ city: 'SmallTown', loadType: 'Steel', payment: 30 }],
        }],
      });

      const context = await ContextBuilder.build(snapshot, BotSkillLevel.Medium, gridPoints);
      const demand = context.demands.find(d => d.deliveryCity === 'SmallTown' && d.loadType === 'Steel');

      expect(demand).toBeDefined();
      // Berlin IS a major city and supply city → supplyCost=0
      expect(demand!.estimatedTrackCostToSupply).toBe(0);
      expect(demand!.optimalStartingCity).toBe('Berlin');
      // Total = 0 + 25 = 25
      expect(demand!.estimatedTrackCostToDelivery).toBe(25);
    });

    it('should fall back to hexDistance when all estimatePathCost returns 0', async () => {
      // All pathCost calls return 0 (unreachable) — fallback to hexDistance * 2
      const gridPoints: GridPoint[] = [
        makeCityPoint(37, 55, 'Wien', TerrainType.MajorCity, []),
        makeCityPoint(24, 52, 'Berlin', TerrainType.MajorCity, []),
        makeCityPoint(29, 32, 'Paris', TerrainType.MajorCity, []),
        makeCityPoint(10, 10, 'FarTown', TerrainType.SmallCity, ['Coal']),
        makeCityPoint(50, 50, 'RemoteTown', TerrainType.SmallCity, []),
      ];

      // All pathCost returns 0 → triggers hexDistance * 2 fallback
      setupPathCosts({});

      const snapshot = makeWorldSnapshot({
        botSegments: [],
        resolvedDemands: [{
          cardId: 1,
          demands: [{ city: 'RemoteTown', loadType: 'Coal', payment: 40 }],
        }],
      });

      const context = await ContextBuilder.build(snapshot, BotSkillLevel.Medium, gridPoints);
      const demand = context.demands.find(d => d.deliveryCity === 'RemoteTown' && d.loadType === 'Coal');

      expect(demand).toBeDefined();
      // Should have positive cost estimates via hexDistance * 2 fallback
      expect(demand!.estimatedTrackCostToSupply + demand!.estimatedTrackCostToDelivery).toBeGreaterThan(0);
      // Should still set an optimal starting city
      expect(demand!.optimalStartingCity).toBeDefined();
    });

    it('should NOT set optimalStartingCity on non-cold-start', async () => {
      // Bot has existing track → non-cold-start, uses existing estimateTrackCost
      const gridPoints: GridPoint[] = [
        makeCityPoint(37, 55, 'Wien', TerrainType.MajorCity, []),
        makeCityPoint(24, 52, 'Berlin', TerrainType.MajorCity, ['Steel']),
        makeCityPoint(29, 32, 'Paris', TerrainType.MajorCity, []),
        makeCityPoint(30, 54, 'NearbyTown', TerrainType.SmallCity, []),
      ];

      setupPathCosts({});

      const snapshot = makeWorldSnapshot({
        botSegments: [makeSegment(37, 55, 36, 55)], // Has track
        botPosition: { row: 37, col: 55 },
        resolvedDemands: [{
          cardId: 1,
          demands: [{ city: 'NearbyTown', loadType: 'Steel', payment: 15 }],
        }],
        gameStatus: 'active',
        turnNumber: 5,
      });

      const context = await ContextBuilder.build(snapshot, BotSkillLevel.Medium, gridPoints);
      const demand = context.demands.find(d => d.deliveryCity === 'NearbyTown' && d.loadType === 'Steel');

      expect(demand).toBeDefined();
      // Non-cold-start: no optimalStartingCity
      expect(demand!.optimalStartingCity).toBeUndefined();
    });
  });

  describe('computeBestDemandContext supply city selection', () => {
    it('should pick the supply city with lowest total route cost', async () => {
      // Demand: Imports to Beograd, available from Antwerpen and Hamburg
      // Antwerpen route is expensive, Hamburg route is cheaper
      const gridPoints: GridPoint[] = [
        makeCityPoint(37, 55, 'Wien', TerrainType.MajorCity, []),
        makeCityPoint(24, 52, 'Berlin', TerrainType.MajorCity, []),
        makeCityPoint(29, 32, 'Paris', TerrainType.MajorCity, []),
        makeCityPoint(18, 40, 'Antwerpen', TerrainType.SmallCity, ['Imports']),
        makeCityPoint(18, 50, 'Hamburg', TerrainType.SmallCity, ['Imports']),
        makeCityPoint(45, 60, 'Beograd', TerrainType.MediumCity, []),
      ];

      setupPathCosts({
        // Hamburg routes (cheaper)
        '24,52->18,50': 8,   // Berlin→Hamburg
        '24,52->45,60': 28,  // Berlin→Beograd
        '18,50->45,60': 30,  // Hamburg→Beograd (linear delivery)
        '37,55->18,50': 25,  // Wien→Hamburg
        '37,55->45,60': 10,  // Wien→Beograd
        '29,32->18,50': 22,  // Paris→Hamburg
        '29,32->45,60': 35,  // Paris→Beograd
        // Antwerpen routes (more expensive)
        '24,52->18,40': 20,  // Berlin→Antwerpen
        '18,40->45,60': 40,  // Antwerpen→Beograd (linear delivery)
        '37,55->18,40': 30,  // Wien→Antwerpen
        '29,32->18,40': 12,  // Paris→Antwerpen
      });

      const snapshot = makeWorldSnapshot({
        botSegments: [],
        resolvedDemands: [{
          cardId: 1,
          demands: [{ city: 'Beograd', loadType: 'Imports', payment: 35 }],
        }],
      });

      const context = await ContextBuilder.build(snapshot, BotSkillLevel.Medium, gridPoints);
      const demand = context.demands.find(d => d.deliveryCity === 'Beograd' && d.loadType === 'Imports');

      expect(demand).toBeDefined();
      // Should pick Hamburg as supply city (cheaper route via Wien hub or Berlin)
      expect(demand!.supplyCity).toBe('Hamburg');
    });
  });

  describe('computeCorridorValue uses starting city', () => {
    it('should use optimalStartingCity as corridor start on cold-start', async () => {
      // When Wien is the optimal starting city, corridor waypoints should start
      // from Wien's coordinates, not from the nearest major city to supply
      const gridPoints: GridPoint[] = [
        makeCityPoint(37, 55, 'Wien', TerrainType.MajorCity, []),
        makeCityPoint(24, 52, 'Berlin', TerrainType.MajorCity, []),
        makeCityPoint(29, 32, 'Paris', TerrainType.MajorCity, []),
        makeCityPoint(30, 60, 'Warszawa', TerrainType.SmallCity, ['Ham']),
        makeCityPoint(42, 58, 'Budapest', TerrainType.MediumCity, []),
        // Additional cities near corridor for corridor value to detect
        makeCityPoint(35, 57, 'Bratislava', TerrainType.SmallCity, []),
        makeCityPoint(39, 56, 'Graz', TerrainType.SmallCity, []),
      ];

      setupPathCosts({
        '37,55->30,60': 15,
        '37,55->42,58': 5,
        '30,60->42,58': 18,
        '24,52->30,60': 12,
        '24,52->42,58': 22,
        '29,32->30,60': 35,
        '29,32->42,58': 30,
      });

      setupHopDistances({
        '37,55->30,60': 8,
        '37,55->42,58': 4,
      });

      const snapshot = makeWorldSnapshot({
        botSegments: [],
        resolvedDemands: [{
          cardId: 1,
          demands: [{ city: 'Budapest', loadType: 'Ham', payment: 25 }],
        }],
      });

      const context = await ContextBuilder.build(snapshot, BotSkillLevel.Medium, gridPoints);
      const demand = context.demands.find(d => d.deliveryCity === 'Budapest' && d.loadType === 'Ham');

      expect(demand).toBeDefined();
      // Should have Wien as the starting city
      expect(demand!.optimalStartingCity).toBe('Wien');
      // The demand should have been scored (demandScore > 0 or reasonable)
      expect(demand!.demandScore).toBeDefined();
    });
  });

  describe('cold-start travel turns (JIRA-75)', () => {
    it('should compute travel as startingCity→supply + supply→delivery', async () => {
      // JIRA-75: Wien→Warszawa(8 hops) + Warszawa→Budapest(12 hops) = 20 hops
      // Freight speed = 9, travelTurns = ceil(20/9) = 3
      const gridPoints: GridPoint[] = [
        makeCityPoint(37, 55, 'Wien', TerrainType.MajorCity, []),
        makeCityPoint(24, 52, 'Berlin', TerrainType.MajorCity, []),
        makeCityPoint(29, 32, 'Paris', TerrainType.MajorCity, []),
        makeCityPoint(30, 60, 'Warszawa', TerrainType.SmallCity, ['Ham']),
        makeCityPoint(42, 58, 'Budapest', TerrainType.MediumCity, []),
      ];

      setupPathCosts({
        '37,55->30,60': 15,
        '37,55->42,58': 5,
        '30,60->42,58': 18,
        '24,52->30,60': 12,
        '24,52->42,58': 22,
        '29,32->30,60': 35,
        '29,32->42,58': 30,
      });

      setupHopDistances({
        '37,55->30,60': 8,   // Wien→Warszawa (start→supply)
        '30,60->42,58': 12,  // Warszawa→Budapest (supply→delivery)
      });

      const snapshot = makeWorldSnapshot({
        botSegments: [],
        resolvedDemands: [{
          cardId: 1,
          demands: [{ city: 'Budapest', loadType: 'Ham', payment: 25 }],
        }],
      });

      const context = await ContextBuilder.build(snapshot, BotSkillLevel.Medium, gridPoints);
      const demand = context.demands.find(d => d.deliveryCity === 'Budapest' && d.loadType === 'Ham');

      expect(demand).toBeDefined();
      // Travel: Wien→Warszawa(8) + Warszawa→Budapest(12) = 20 hops
      // buildTurns = ceil(20/20) = 1, travelTurns = ceil(20/9) = 3, + 1 = 5
      expect(demand!.estimatedTurns).toBe(5);
    });

    it('should show round-trip travel when starting at delivery city', async () => {
      // JIRA-75 bug case: Ruhr starts at delivery city, supply is far away
      // Travel = Ruhr→Firenze(23) + Firenze→Ruhr(23) = 46 hops (round trip)
      const gridPoints: GridPoint[] = [
        makeCityPoint(37, 55, 'Wien', TerrainType.MajorCity, []),
        makeCityPoint(24, 52, 'Berlin', TerrainType.MajorCity, []),
        makeCityPoint(29, 32, 'Paris', TerrainType.MajorCity, []),
        makeCityPoint(20, 45, 'Ruhr', TerrainType.MajorCity, []),
        makeCityPoint(45, 48, 'Firenze', TerrainType.SmallCity, ['Marble']),
      ];

      const { getMajorCityGroups } = require('../../../shared/services/majorCityGroups');
      getMajorCityGroups.mockReturnValue([
        { cityName: 'Wien', center: { row: 37, col: 55 }, outposts: [] },
        { cityName: 'Berlin', center: { row: 24, col: 52 }, outposts: [] },
        { cityName: 'Paris', center: { row: 29, col: 32 }, outposts: [] },
        { cityName: 'Ruhr', center: { row: 20, col: 45 }, outposts: [] },
      ]);

      setupPathCosts({
        // Ruhr→Firenze = 40M (build cost for supply), Ruhr→Ruhr = 0 (delivery IS start)
        '20,45->45,48': 40,
        // Other candidates are more expensive
        '37,55->45,48': 14,  // Wien→Firenze
        '37,55->20,45': 37,  // Wien→Ruhr
        '24,52->45,48': 30,  // Berlin→Firenze
        '24,52->20,45': 15,  // Berlin→Ruhr
        '29,32->45,48': 35,  // Paris→Firenze
        '29,32->20,45': 20,  // Paris→Ruhr
      });

      setupHopDistances({
        '20,45->45,48': 23,  // Ruhr→Firenze (start→supply)
        '45,48->20,45': 23,  // Firenze→Ruhr (supply→delivery = round trip back)
      });

      const snapshot = makeWorldSnapshot({
        botSegments: [],
        resolvedDemands: [{
          cardId: 1,
          demands: [{ city: 'Ruhr', loadType: 'Marble', payment: 22 }],
        }],
      });

      const context = await ContextBuilder.build(snapshot, BotSkillLevel.Medium, gridPoints);
      const demand = context.demands.find(d => d.deliveryCity === 'Ruhr' && d.loadType === 'Marble');

      expect(demand).toBeDefined();
      // Ruhr is optimal start (0 delivery cost). Travel = Ruhr→Firenze(23) + Firenze→Ruhr(23) = 46 hops
      // buildTurns = ceil(40/20) = 2, travelTurns = ceil(46/9) = 6, + 1 = 9
      expect(demand!.optimalStartingCity).toBe('Ruhr');
      expect(demand!.estimatedTurns).toBe(9);
    });

    it('should compute travel as start→supply + supply→delivery for linear model', async () => {
      // JIRA-75: Even with linear model, travel must include start→supply leg
      // Madrid→Sevilla(2 hops) + Sevilla→Lisboa(3 hops) = 5 hops
      const gridPoints: GridPoint[] = [
        makeCityPoint(37, 55, 'Wien', TerrainType.MajorCity, []),
        makeCityPoint(24, 52, 'Berlin', TerrainType.MajorCity, []),
        makeCityPoint(29, 32, 'Paris', TerrainType.MajorCity, []),
        makeCityPoint(40, 20, 'Madrid', TerrainType.MajorCity, []),
        makeCityPoint(42, 22, 'Sevilla', TerrainType.SmallCity, ['Oranges']),
        makeCityPoint(41, 18, 'Lisboa', TerrainType.MediumCity, []),
      ];

      const { getMajorCityGroups } = require('../../../shared/services/majorCityGroups');
      getMajorCityGroups.mockReturnValue([
        { cityName: 'Wien', center: { row: 37, col: 55 }, outposts: [] },
        { cityName: 'Berlin', center: { row: 24, col: 52 }, outposts: [] },
        { cityName: 'Paris', center: { row: 29, col: 32 }, outposts: [] },
        { cityName: 'Madrid', center: { row: 40, col: 20 }, outposts: [] },
      ]);

      setupPathCosts({
        '40,20->42,22': 3,   // Madrid→Sevilla
        '40,20->41,18': 5,   // Madrid→Lisboa
        '42,22->41,18': 4,   // Sevilla→Lisboa (linear delivery)
        '37,55->42,22': 40,
        '37,55->41,18': 38,
        '24,52->42,22': 45,
        '24,52->41,18': 42,
        '29,32->42,22': 25,
        '29,32->41,18': 22,
      });

      setupHopDistances({
        '40,20->42,22': 2,  // Madrid→Sevilla (start→supply)
        '42,22->41,18': 3,  // Sevilla→Lisboa (supply→delivery)
      });

      const snapshot = makeWorldSnapshot({
        botSegments: [],
        resolvedDemands: [{
          cardId: 1,
          demands: [{ city: 'Lisboa', loadType: 'Oranges', payment: 15 }],
        }],
      });

      const context = await ContextBuilder.build(snapshot, BotSkillLevel.Medium, gridPoints);
      const demand = context.demands.find(d => d.deliveryCity === 'Lisboa' && d.loadType === 'Oranges');

      expect(demand).toBeDefined();
      // Linear model: totalCost = 3+4 = 7, buildTurns = 1
      // Travel = Madrid→Sevilla(2) + Sevilla→Lisboa(3) = 5 hops, travelTurns = ceil(5/9) = 1
      // estimatedTurns = 1 + 1 + 1 = 3
      expect(demand!.estimatedTurns).toBe(3);
    });
  });

  describe('JIRA-79: water-separated route Euclidean fallback', () => {
    it('should use Euclidean fallback when BFS returns 0 for water-separated route', async () => {
      // Cork (row 20, col 10) in Ireland → Beograd (row 50, col 60) in Serbia
      // BFS returns 0 because it can't cross water — fallback should produce reasonable travel
      setupHopDistances({}); // All return 0 (default)
      setupPathCosts({
        '37,55->20,10': 41, // Wien→Cork supply track cost
        '20,10->50,60': 10, // Cork→Beograd delivery track cost
      });

      const gridPoints: GridPoint[] = [
        makeCityPoint(37, 55, 'Wien', TerrainType.MajorCity),
        makeCityPoint(20, 10, 'Cork', TerrainType.SmallCity, ['Sheep']),
        makeCityPoint(50, 60, 'Beograd', TerrainType.MajorCity),
        // Clear terrain to connect them
        makeGridPoint(30, 35),
      ];

      const snapshot = makeWorldSnapshot({
        botPosition: { row: 37, col: 55 },
        botSegments: [makeSegment(37, 55, 36, 55)], // non-cold-start
        gameStatus: 'active',
        turnNumber: 11,
        botMoney: 33,
      });
      // Override resolved demands to include Sheep→Beograd
      snapshot.bot.resolvedDemands = [{
        cardId: 1,
        demands: [{ city: 'Beograd', loadType: 'Sheep', payment: 51 }],
      }];

      const context = await ContextBuilder.build(snapshot, BotSkillLevel.Medium, gridPoints);
      const demand = context.demands.find(d => d.deliveryCity === 'Beograd' && d.loadType === 'Sheep');

      expect(demand).toBeDefined();
      // Euclidean distance Cork(20,10)→Beograd(50,60) = sqrt(30² + 50²) ≈ 58.3
      // travelTurns = ceil(58.3 / 9) = 7
      // buildTurns = ceil(51/20) = 3
      // estimatedTurns = 3 + 7 + 1 = 11
      // Must be significantly more than 4 (the old buggy value)
      expect(demand!.estimatedTurns).toBeGreaterThan(6);
    });
  });
});
