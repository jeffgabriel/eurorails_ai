import { WorldSnapshotService } from '../services/ai/WorldSnapshotService';
import { PlayerService } from '../services/playerService';
import { TrackService } from '../services/trackService';
import { LoadService } from '../services/loadService';
import { TrainType, TerrainType } from '../../shared/types/GameTypes';
import type { Player, PlayerTrackState, TrackSegment } from '../../shared/types/GameTypes';
import type { LoadState } from '../../shared/types/LoadTypes';
import { LoadType } from '../../shared/types/LoadTypes';
import type { DemandCard } from '../../shared/types/DemandCard';
import { getMajorCityGroups } from '../../shared/services/majorCityGroups';

// Mock dependencies
jest.mock('../services/playerService');
jest.mock('../services/trackService');
jest.mock('../services/loadService');
jest.mock('../../shared/services/majorCityGroups');
jest.mock('../../../configuration/gridPoints.json', () => [
  { Id: 'gp-1', GridX: 0, GridY: 0, Type: 'Clear' },
  { Id: 'gp-2', GridX: 1, GridY: 0, Type: 'Mountain' },
  { Id: 'gp-3', GridX: 0, GridY: 1, Type: 'Major City', Name: 'Berlin' },
  { Id: 'gp-4', GridX: 1, GridY: 1, Type: 'Major City Outpost', Name: 'Berlin' },
  { Id: 'gp-5', GridX: 2, GridY: 2, Type: 'Major City', Name: 'Paris' },
  { Id: 'gp-6', GridX: 3, GridY: 3, Type: 'Major City', Name: 'London' },
  { Id: 'gp-7', GridX: 4, GridY: 4, Type: 'Small City', Name: 'Bordeaux' },
  { Id: 'gp-8', GridX: 5, GridY: 5, Type: 'Medium City', Name: 'Lyon' },
  { Id: 'gp-9', GridX: 6, GridY: 6, Type: 'Alpine' },
  { Id: 'gp-10', GridX: 7, GridY: 7, Type: 'Ferry Port', Name: 'Dover' },
  { Id: 'gp-11', GridX: 8, GridY: 8, Type: 'Water' },
], { virtual: true });

const mockGetPlayers = PlayerService.getPlayers as jest.Mock;
const mockGetAllTracks = TrackService.getAllTracks as jest.Mock;
const mockGetMajorCityGroups = getMajorCityGroups as jest.Mock;

const mockGetAllLoadStates = jest.fn();
(LoadService.getInstance as jest.Mock).mockReturnValue({
  getAllLoadStates: mockGetAllLoadStates,
});

const GAME_ID = 'game-1';
const BOT_ID = 'bot-1';

const mockDemandCards: DemandCard[] = [
  {
    id: 1,
    demands: [
      { city: 'Berlin', resource: LoadType.Beer, payment: 20 },
      { city: 'Paris', resource: LoadType.Wine, payment: 30 },
      { city: 'Roma', resource: LoadType.Marble, payment: 25 },
    ],
  },
  {
    id: 2,
    demands: [
      { city: 'London', resource: LoadType.Coal, payment: 18 },
      { city: 'Madrid', resource: LoadType.Oranges, payment: 22 },
      { city: 'Wien', resource: LoadType.Cheese, payment: 15 },
    ],
  },
  {
    id: 3,
    demands: [
      { city: 'Istanbul', resource: LoadType.Oil, payment: 40 },
      { city: 'Hamburg', resource: LoadType.Fish, payment: 12 },
      { city: 'Milano', resource: LoadType.Cars, payment: 35 },
    ],
  },
];

function makeSegment(fromRow: number, fromCol: number, toRow: number, toCol: number): TrackSegment {
  return {
    from: { x: 0, y: 0, row: fromRow, col: fromCol, terrain: TerrainType.Clear },
    to: { x: 0, y: 0, row: toRow, col: toCol, terrain: TerrainType.Clear },
    cost: 1,
  };
}

function makeBotPlayer(overrides: Partial<Player> = {}): Player {
  return {
    id: BOT_ID,
    userId: 'bot-user-1',
    name: 'TestBot',
    color: '#FF0000',
    money: 100,
    trainType: TrainType.Freight,
    turnNumber: 5,
    trainState: {
      position: { x: 100, y: 200, row: 10, col: 15 },
      remainingMovement: 9,
      movementHistory: [],
      loads: [LoadType.Wine, LoadType.Coal],
    },
    hand: mockDemandCards,
    isAI: true,
    aiDifficulty: 'medium',
    aiArchetype: 'freight_optimizer',
    ...overrides,
  };
}

function makeHumanPlayer(overrides: Partial<Player> = {}): Player {
  return {
    id: 'human-1',
    userId: 'human-user-1',
    name: 'Human Player',
    color: '#0000FF',
    money: 80,
    trainType: TrainType.FastFreight,
    turnNumber: 5,
    trainState: {
      position: { x: 300, y: 400, row: 20, col: 25 },
      remainingMovement: 12,
      movementHistory: [],
      loads: [LoadType.Beer],
    },
    hand: [],
    ...overrides,
  };
}

const botSegments: TrackSegment[] = [
  makeSegment(10, 15, 11, 15),  // (10,15) <-> (11,15)
  makeSegment(11, 15, 12, 16),  // (11,15) <-> (12,16)
  makeSegment(12, 16, 0, 1),    // connects toward Berlin outpost at (1,1)
  makeSegment(0, 1, 1, 1),      // reaches Berlin outpost (1,1)
  makeSegment(1, 1, 2, 2),      // reaches Paris center (2,2)
];

const humanSegments: TrackSegment[] = [
  makeSegment(20, 25, 21, 25),
];

function makeAllTracks(): PlayerTrackState[] {
  return [
    {
      playerId: BOT_ID,
      gameId: GAME_ID,
      segments: botSegments,
      totalCost: 5,
      turnBuildCost: 0,
      lastBuildTimestamp: new Date(),
    },
    {
      playerId: 'human-1',
      gameId: GAME_ID,
      segments: humanSegments,
      totalCost: 1,
      turnBuildCost: 0,
      lastBuildTimestamp: new Date(),
    },
  ];
}

const mockLoadStates: LoadState[] = [
  { loadType: 'Wine', availableCount: 4, totalCount: 4, cities: ['Bordeaux', 'Porto'] },
  { loadType: 'Coal', availableCount: 3, totalCount: 3, cities: ['Newcastle', 'Essen'] },
  { loadType: 'Beer', availableCount: 4, totalCount: 4, cities: ['Munchen', 'Dublin'] },
  { loadType: 'Oil', availableCount: 3, totalCount: 3, cities: ['Ploiesti'] },
];

const mockMajorCityGroups = [
  { cityName: 'Berlin', center: { row: 1, col: 0 }, outposts: [{ row: 1, col: 1 }] },
  { cityName: 'Paris', center: { row: 2, col: 2 }, outposts: [] },
  { cityName: 'London', center: { row: 3, col: 3 }, outposts: [] },
];

function setupDefaultMocks(): void {
  mockGetPlayers.mockResolvedValue([makeBotPlayer(), makeHumanPlayer()]);
  mockGetAllTracks.mockResolvedValue(makeAllTracks());
  mockGetAllLoadStates.mockResolvedValue(mockLoadStates);
  mockGetMajorCityGroups.mockReturnValue(mockMajorCityGroups);
}

describe('WorldSnapshotService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    setupDefaultMocks();
  });

  describe('capture', () => {
    it('returns a snapshot with all expected fields populated', async () => {
      const snapshot = await WorldSnapshotService.capture(GAME_ID, BOT_ID);

      expect(snapshot.botPlayerId).toBe(BOT_ID);
      expect(snapshot.botPosition).toEqual({ x: 100, y: 200, row: 10, col: 15 });
      expect(snapshot.cash).toBe(100);
      expect(snapshot.trainType).toBe(TrainType.Freight);
      expect(snapshot.turnNumber).toBe(5);
      expect(snapshot.demandCards).toHaveLength(3);
      expect(snapshot.demandCards).toEqual(mockDemandCards);
      expect(snapshot.carriedLoads).toEqual([LoadType.Wine, LoadType.Coal]);
      expect(snapshot.otherPlayers).toHaveLength(1);
      expect(snapshot.globalLoadAvailability).toBeDefined();
      expect(snapshot.globalLoadAvailability.length).toBe(4);
      expect(snapshot.activeEvents).toBeDefined();
      expect(Array.isArray(snapshot.activeEvents)).toBe(true);
      expect(snapshot.mapTopology).toBeDefined();
      expect(snapshot.mapTopology.length).toBeGreaterThan(0);
      expect(snapshot.majorCityConnectionStatus).toBeDefined();
      expect(snapshot.majorCityConnectionStatus instanceof Map).toBe(true);
      expect(snapshot.trackNetworkGraph).toBeDefined();
      expect(snapshot.trackNetworkGraph instanceof Map).toBe(true);
      expect(snapshot.snapshotHash).toBeDefined();
      expect(typeof snapshot.snapshotHash).toBe('string');
      expect(snapshot.snapshotHash.length).toBe(16);
    });

    it('snapshot is deeply frozen (Object.isFrozen on snapshot and nested objects)', async () => {
      const snapshot = await WorldSnapshotService.capture(GAME_ID, BOT_ID);

      // Top-level snapshot is frozen
      expect(Object.isFrozen(snapshot)).toBe(true);

      // Nested arrays are frozen
      expect(Object.isFrozen(snapshot.demandCards)).toBe(true);
      expect(Object.isFrozen(snapshot.carriedLoads)).toBe(true);
      expect(Object.isFrozen(snapshot.otherPlayers)).toBe(true);
      expect(Object.isFrozen(snapshot.globalLoadAvailability)).toBe(true);
      expect(Object.isFrozen(snapshot.activeEvents)).toBe(true);
      expect(Object.isFrozen(snapshot.mapTopology)).toBe(true);

      // Objects within nested arrays are frozen
      expect(Object.isFrozen(snapshot.demandCards[0])).toBe(true);
      expect(Object.isFrozen(snapshot.otherPlayers[0])).toBe(true);
      expect(Object.isFrozen(snapshot.globalLoadAvailability[0])).toBe(true);

      // Map objects are frozen
      expect(Object.isFrozen(snapshot.trackNetworkGraph)).toBe(true);
      expect(Object.isFrozen(snapshot.majorCityConnectionStatus)).toBe(true);

      // Position is frozen
      expect(Object.isFrozen(snapshot.botPosition)).toBe(true);

      // Attempting to mutate should throw in strict mode
      expect(() => {
        (snapshot as any).cash = 999;
      }).toThrow();
    });

    it('throws when bot player is not found in the game', async () => {
      mockGetPlayers.mockResolvedValue([makeHumanPlayer()]);

      await expect(
        WorldSnapshotService.capture(GAME_ID, BOT_ID),
      ).rejects.toThrow(`Bot player ${BOT_ID} not found in game ${GAME_ID}`);
    });

    it('correctly builds track network graph from segments', async () => {
      const snapshot = await WorldSnapshotService.capture(GAME_ID, BOT_ID);

      const graph = snapshot.trackNetworkGraph;

      // Bot has segments: (10,15)-(11,15), (11,15)-(12,16), (12,16)-(0,1), (0,1)-(1,1), (1,1)-(2,2)
      // Verify all nodes exist
      expect(graph.has('10,15')).toBe(true);
      expect(graph.has('11,15')).toBe(true);
      expect(graph.has('12,16')).toBe(true);
      expect(graph.has('0,1')).toBe(true);
      expect(graph.has('1,1')).toBe(true);
      expect(graph.has('2,2')).toBe(true);

      // Verify bidirectional adjacency
      expect(graph.get('10,15')!.has('11,15')).toBe(true);
      expect(graph.get('11,15')!.has('10,15')).toBe(true);
      expect(graph.get('11,15')!.has('12,16')).toBe(true);
      expect(graph.get('12,16')!.has('11,15')).toBe(true);
      expect(graph.get('12,16')!.has('0,1')).toBe(true);
      expect(graph.get('0,1')!.has('12,16')).toBe(true);
      expect(graph.get('0,1')!.has('1,1')).toBe(true);
      expect(graph.get('1,1')!.has('0,1')).toBe(true);
      expect(graph.get('1,1')!.has('2,2')).toBe(true);
      expect(graph.get('2,2')!.has('1,1')).toBe(true);

      // Human track should NOT be in the bot's track network
      expect(graph.has('20,25')).toBe(false);
      expect(graph.has('21,25')).toBe(false);
    });

    it('adjusts load availability by subtracting carried loads', async () => {
      const snapshot = await WorldSnapshotService.capture(GAME_ID, BOT_ID);

      // Bot carries Wine + Coal, Human carries Beer
      const wineState = snapshot.globalLoadAvailability.find(s => s.loadType === 'Wine');
      const coalState = snapshot.globalLoadAvailability.find(s => s.loadType === 'Coal');
      const beerState = snapshot.globalLoadAvailability.find(s => s.loadType === 'Beer');
      const oilState = snapshot.globalLoadAvailability.find(s => s.loadType === 'Oil');

      expect(wineState!.availableCount).toBe(3); // 4 - 1 carried by bot
      expect(coalState!.availableCount).toBe(2); // 3 - 1 carried by bot
      expect(beerState!.availableCount).toBe(3); // 4 - 1 carried by human
      expect(oilState!.availableCount).toBe(3); // 3 - 0 carried by anyone
    });

    it('does not reduce load availability below zero', async () => {
      // Set available count to 0 before subtraction
      mockGetAllLoadStates.mockResolvedValue([
        { loadType: 'Wine', availableCount: 0, totalCount: 4, cities: ['Bordeaux'] },
      ]);

      const snapshot = await WorldSnapshotService.capture(GAME_ID, BOT_ID);

      const wineState = snapshot.globalLoadAvailability.find(s => s.loadType === 'Wine');
      expect(wineState!.availableCount).toBe(0); // Math.max(0, 0 - 1) = 0
    });

    it('calculates major city connection status correctly', async () => {
      const snapshot = await WorldSnapshotService.capture(GAME_ID, BOT_ID);

      const connectionStatus = snapshot.majorCityConnectionStatus;

      // Bot track reaches Berlin outpost (1,1) and Paris center (2,2)
      // Berlin center is at (1,0) -- not directly in graph,
      // but outpost at (1,1) IS in graph
      expect(connectionStatus.get('Berlin')).toBe(true);

      // Paris center at (2,2) is in the graph
      expect(connectionStatus.get('Paris')).toBe(true);

      // London center at (3,3) is NOT in the graph
      expect(connectionStatus.get('London')).toBe(false);
    });

    it('marks all major cities as disconnected when bot has no track', async () => {
      mockGetAllTracks.mockResolvedValue([
        {
          playerId: 'human-1',
          gameId: GAME_ID,
          segments: humanSegments,
          totalCost: 1,
          turnBuildCost: 0,
          lastBuildTimestamp: new Date(),
        },
      ]);

      const snapshot = await WorldSnapshotService.capture(GAME_ID, BOT_ID);

      const connectionStatus = snapshot.majorCityConnectionStatus;
      expect(connectionStatus.get('Berlin')).toBe(false);
      expect(connectionStatus.get('Paris')).toBe(false);
      expect(connectionStatus.get('London')).toBe(false);
    });

    it('generates a unique snapshot hash', async () => {
      const snapshot1 = await WorldSnapshotService.capture(GAME_ID, BOT_ID);

      // Small delay to ensure different Date.now() in hash
      await new Promise(resolve => setTimeout(resolve, 2));
      const snapshot2 = await WorldSnapshotService.capture(GAME_ID, BOT_ID);

      expect(typeof snapshot1.snapshotHash).toBe('string');
      expect(typeof snapshot2.snapshotHash).toBe('string');
      expect(snapshot1.snapshotHash.length).toBe(16);
      expect(snapshot2.snapshotHash.length).toBe(16);
      expect(snapshot1.snapshotHash).not.toBe(snapshot2.snapshotHash);
    });

    it('other players snapshot includes correct fields', async () => {
      const snapshot = await WorldSnapshotService.capture(GAME_ID, BOT_ID);

      expect(snapshot.otherPlayers).toHaveLength(1);
      const other = snapshot.otherPlayers[0];

      expect(other.playerId).toBe('human-1');
      expect(other.position).toEqual({ x: 300, y: 400, row: 20, col: 25 });
      expect(other.trainType).toBe(TrainType.FastFreight);
      expect(other.cash).toBe(80);
      expect(other.carriedLoads).toEqual([LoadType.Beer]);
      expect(typeof other.connectedMajorCities).toBe('number');
    });

    it('other players snapshot excludes the bot player', async () => {
      const secondHuman = makeHumanPlayer({
        id: 'human-2',
        userId: 'human-user-2',
        name: 'Second Human',
        money: 60,
      });
      mockGetPlayers.mockResolvedValue([makeBotPlayer(), makeHumanPlayer(), secondHuman]);

      const snapshot = await WorldSnapshotService.capture(GAME_ID, BOT_ID);

      expect(snapshot.otherPlayers).toHaveLength(2);
      const playerIds = snapshot.otherPlayers.map(p => p.playerId);
      expect(playerIds).toContain('human-1');
      expect(playerIds).toContain('human-2');
      expect(playerIds).not.toContain(BOT_ID);
    });

    it('uses cached map topology on subsequent calls', async () => {
      const snapshot1 = await WorldSnapshotService.capture(GAME_ID, BOT_ID);
      const snapshot2 = await WorldSnapshotService.capture(GAME_ID, BOT_ID);

      // Both snapshots should have the same map topology content
      expect(snapshot1.mapTopology.length).toBeGreaterThan(0);
      expect(snapshot1.mapTopology.length).toBe(snapshot2.mapTopology.length);

      // Topology points should have expected structure
      const point = snapshot1.mapTopology[0];
      expect(point).toHaveProperty('id');
      expect(point).toHaveProperty('row');
      expect(point).toHaveProperty('col');
      expect(point).toHaveProperty('terrain');
    });

    it('handles bot player with null position', async () => {
      const botWithNoPosition = makeBotPlayer();
      botWithNoPosition.trainState.position = null as any;
      mockGetPlayers.mockResolvedValue([botWithNoPosition, makeHumanPlayer()]);

      const snapshot = await WorldSnapshotService.capture(GAME_ID, BOT_ID);

      expect(snapshot.botPosition).toBeNull();
    });

    it('handles bot with no track segments', async () => {
      mockGetAllTracks.mockResolvedValue([
        {
          playerId: 'human-1',
          gameId: GAME_ID,
          segments: humanSegments,
          totalCost: 1,
          turnBuildCost: 0,
          lastBuildTimestamp: new Date(),
        },
      ]);

      const snapshot = await WorldSnapshotService.capture(GAME_ID, BOT_ID);

      expect(snapshot.trackNetworkGraph.size).toBe(0);
    });

    it('handles empty load states', async () => {
      mockGetAllLoadStates.mockResolvedValue([]);

      const snapshot = await WorldSnapshotService.capture(GAME_ID, BOT_ID);

      expect(snapshot.globalLoadAvailability).toEqual([]);
    });

    it('handles bot with no carried loads', async () => {
      const botWithNoLoads = makeBotPlayer();
      botWithNoLoads.trainState.loads = [];
      mockGetPlayers.mockResolvedValue([botWithNoLoads, makeHumanPlayer()]);

      const snapshot = await WorldSnapshotService.capture(GAME_ID, BOT_ID);

      expect(snapshot.carriedLoads).toEqual([]);

      // Load availability should only be decremented by human's carried loads
      const beerState = snapshot.globalLoadAvailability.find(s => s.loadType === 'Beer');
      expect(beerState!.availableCount).toBe(3); // 4 - 1 from human
      const wineState = snapshot.globalLoadAvailability.find(s => s.loadType === 'Wine');
      expect(wineState!.availableCount).toBe(4); // 4 - 0
    });

    it('handles multiple carried loads of the same type', async () => {
      const botWithDuplicateLoads = makeBotPlayer();
      botWithDuplicateLoads.trainState.loads = [LoadType.Wine, LoadType.Wine];
      mockGetPlayers.mockResolvedValue([botWithDuplicateLoads, makeHumanPlayer()]);

      const snapshot = await WorldSnapshotService.capture(GAME_ID, BOT_ID);

      const wineState = snapshot.globalLoadAvailability.find(s => s.loadType === 'Wine');
      expect(wineState!.availableCount).toBe(2); // 4 - 2 carried by bot
    });

    it('passes correct gameId and botPlayerId to service calls', async () => {
      await WorldSnapshotService.capture(GAME_ID, BOT_ID);

      expect(mockGetPlayers).toHaveBeenCalledWith(GAME_ID, BOT_ID);
      expect(mockGetAllTracks).toHaveBeenCalledWith(GAME_ID);
    });

    it('handles other player with null position', async () => {
      const humanNoPos = makeHumanPlayer();
      humanNoPos.trainState.position = null as any;
      mockGetPlayers.mockResolvedValue([makeBotPlayer(), humanNoPos]);

      const snapshot = await WorldSnapshotService.capture(GAME_ID, BOT_ID);

      expect(snapshot.otherPlayers[0].position).toBeNull();
    });

    it('maps terrain types correctly in map topology', async () => {
      const snapshot = await WorldSnapshotService.capture(GAME_ID, BOT_ID);

      const topology = snapshot.mapTopology;

      // Find specific terrain types from our mock gridPoints.json
      const clearPoint = topology.find(p => p.row === 0 && p.col === 0);
      const mountainPoint = topology.find(p => p.row === 0 && p.col === 1);
      const majorCityPoint = topology.find(p => p.row === 1 && p.col === 0);
      const alpinePoint = topology.find(p => p.row === 6 && p.col === 6);
      const ferryPoint = topology.find(p => p.row === 7 && p.col === 7);
      const waterPoint = topology.find(p => p.row === 8 && p.col === 8);

      expect(clearPoint?.terrain).toBe(TerrainType.Clear);
      expect(mountainPoint?.terrain).toBe(TerrainType.Mountain);
      expect(majorCityPoint?.terrain).toBe(TerrainType.MajorCity);
      expect(alpinePoint?.terrain).toBe(TerrainType.Alpine);
      expect(ferryPoint?.terrain).toBe(TerrainType.FerryPort);
      expect(waterPoint?.terrain).toBe(TerrainType.Water);
    });

    it('includes city data for city terrain types in map topology', async () => {
      const snapshot = await WorldSnapshotService.capture(GAME_ID, BOT_ID);

      const berlinCenter = snapshot.mapTopology.find(p => p.row === 1 && p.col === 0);
      expect(berlinCenter?.city).toBeDefined();
      expect(berlinCenter?.city?.name).toBe('Berlin');
      expect(berlinCenter?.city?.type).toBe(TerrainType.MajorCity);

      const smallCity = snapshot.mapTopology.find(p => p.row === 4 && p.col === 4);
      expect(smallCity?.city).toBeDefined();
      expect(smallCity?.city?.name).toBe('Bordeaux');
      expect(smallCity?.city?.type).toBe(TerrainType.SmallCity);

      const mediumCity = snapshot.mapTopology.find(p => p.row === 5 && p.col === 5);
      expect(mediumCity?.city).toBeDefined();
      expect(mediumCity?.city?.name).toBe('Lyon');
      expect(mediumCity?.city?.type).toBe(TerrainType.MediumCity);
    });

    it('calculates connectedMajorCities for other players', async () => {
      // Human has track from (20,25) to (21,25) which doesn't reach any major city
      const snapshot = await WorldSnapshotService.capture(GAME_ID, BOT_ID);

      const other = snapshot.otherPlayers[0];
      expect(other.connectedMajorCities).toBe(0);
    });

    it('preserves totalCount in adjusted load states', async () => {
      const snapshot = await WorldSnapshotService.capture(GAME_ID, BOT_ID);

      const wineState = snapshot.globalLoadAvailability.find(s => s.loadType === 'Wine');
      expect(wineState!.totalCount).toBe(4); // totalCount should not change
      expect(wineState!.cities).toEqual(['Bordeaux', 'Porto']); // cities should not change
    });

    it('returns activeEvents as an empty array when events are not yet integrated', async () => {
      const snapshot = await WorldSnapshotService.capture(GAME_ID, BOT_ID);

      expect(snapshot.activeEvents).toEqual([]);
    });
  });
});
