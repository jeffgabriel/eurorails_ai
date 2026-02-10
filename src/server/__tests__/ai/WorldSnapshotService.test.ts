/**
 * Unit tests for WorldSnapshotService.
 * Tests game state capture, immutability, and correct field mapping.
 */

import { makeSnapshot, makeGridPoint, makeSegment } from './helpers/testFixtures';
import { TrainType, TerrainType } from '../../../shared/types/GameTypes';
import type { PlayerTrackState, GameState } from '../../../shared/types/GameTypes';
import { LoadType } from '../../../shared/types/LoadTypes';
import type { WorldSnapshot } from '../../ai/types';
import { WorldSnapshotService } from '../../ai/WorldSnapshotService';

// --- Mocks ---

jest.mock('../../services/gameService');
jest.mock('../../services/trackService');
jest.mock('../../services/loadService');
jest.mock('../../../shared/services/majorCityGroups', () => ({
  getMajorCityGroups: () => [
    {
      cityName: 'TestCity',
      center: { row: 5, col: 5 },
      outposts: [{ row: 5, col: 4 }, { row: 5, col: 6 }],
    },
    {
      cityName: 'OtherCity',
      center: { row: 10, col: 10 },
      outposts: [{ row: 10, col: 9 }],
    },
  ],
  getFerryEdges: () => [],
}));

// Mock gridPoints.json to avoid loading the full config in tests
jest.mock('../../../../configuration/gridPoints.json', () => [
  { Id: 'mp-1', GridX: 5, GridY: 5, Type: 'Major City', Name: 'TestCity' },
  { Id: 'mp-2', GridX: 4, GridY: 5, Type: 'Major City Outpost', Name: 'TestCity' },
  { Id: 'mp-3', GridX: 10, GridY: 10, Type: 'Major City', Name: 'OtherCity' },
  { Id: 'mp-4', GridX: 3, GridY: 3, Type: 'Small City', Name: 'SmallTown' },
  { Id: 'mp-5', GridX: 1, GridY: 1, Type: 'Clear' },
  { Id: 'mp-6', GridX: 2, GridY: 2, Type: 'Mountain' },
], { virtual: true });

import { GameService } from '../../services/gameService';
import { TrackService } from '../../services/trackService';
import { LoadService } from '../../services/loadService';

const mockGetGame = GameService.getGame as jest.MockedFunction<typeof GameService.getGame>;
const mockGetAllTracks = TrackService.getAllTracks as jest.MockedFunction<typeof TrackService.getAllTracks>;
const mockGetInstance = LoadService.getInstance as jest.MockedFunction<typeof LoadService.getInstance>;

// --- Helpers ---

function makeMockGameState(overrides: Partial<GameState> = {}): GameState {
  return {
    id: 'game-1',
    currentPlayerIndex: 0,
    status: 'active',
    maxPlayers: 6,
    players: [
      {
        id: 'bot-player-1',
        userId: 'bot-user-1',
        name: 'Bot Alpha',
        color: '#ff0000',
        money: 75,
        debtOwed: 0,
        trainType: TrainType.FastFreight,
        turnNumber: 5,
        trainState: {
          position: { x: 250, y: 225, row: 5, col: 5 },
          remainingMovement: 8,
          movementHistory: [],
          loads: [LoadType.Coal],
        },
        hand: [{ id: 1, demands: [{ city: 'TestCity', resource: LoadType.Steel, payment: 20 }] }],
      },
      {
        id: 'opp-1',
        userId: 'opp-user-1',
        name: 'Human Player',
        color: '#00ff00',
        money: 120,
        debtOwed: 5,
        trainType: TrainType.HeavyFreight,
        turnNumber: 5,
        trainState: {
          position: { x: 500, y: 450, row: 10, col: 10 },
          remainingMovement: 3,
          movementHistory: [],
          loads: [LoadType.Wine, LoadType.Wheat],
        },
        hand: [],
      },
    ],
    ...overrides,
  } as GameState;
}

function makeMockTracks(): PlayerTrackState[] {
  return [
    {
      playerId: 'bot-player-1',
      gameId: 'game-1',
      segments: [
        makeSegment(5, 5, TerrainType.MajorCity, 5, 4, TerrainType.MajorCity, 5),
        makeSegment(5, 4, TerrainType.MajorCity, 4, 4, TerrainType.Clear, 1),
      ],
      totalCost: 6,
      turnBuildCost: 3,
      lastBuildTimestamp: new Date(),
    },
    {
      playerId: 'opp-1',
      gameId: 'game-1',
      segments: [
        makeSegment(10, 10, TerrainType.MajorCity, 10, 9, TerrainType.MajorCity, 5),
      ],
      totalCost: 5,
      turnBuildCost: 0,
      lastBuildTimestamp: new Date(),
    },
  ];
}

function setupMocks(
  gameState: GameState | null = makeMockGameState(),
  tracks: PlayerTrackState[] = makeMockTracks(),
): void {
  mockGetGame.mockResolvedValue(gameState);
  mockGetAllTracks.mockResolvedValue(tracks);
  mockGetInstance.mockReturnValue({
    getAvailableLoadsForCity: jest.fn((city: string) => {
      if (city === 'TestCity') return [LoadType.Steel, LoadType.Coal];
      if (city === 'SmallTown') return [LoadType.Wheat];
      return [];
    }),
    getDroppedLoads: jest.fn().mockResolvedValue([
      { city_name: 'TestCity', type: LoadType.Wine },
      { city_name: 'TestCity', type: LoadType.Cheese },
    ]),
  } as any);
}

// --- Tests ---

describe('WorldSnapshotService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('capture', () => {
    it('should return a complete WorldSnapshot with all required fields', async () => {
      setupMocks();

      const snapshot = await WorldSnapshotService.capture('game-1', 'bot-player-1', 'bot-user-1');

      expect(snapshot.gameId).toBe('game-1');
      expect(snapshot.botPlayerId).toBe('bot-player-1');
      expect(snapshot.botUserId).toBe('bot-user-1');
      expect(snapshot.gamePhase).toBe('active');
      expect(snapshot.turnBuildCostSoFar).toBe(3);
      expect(snapshot.position).toEqual({ x: 250, y: 225, row: 5, col: 5 });
      expect(snapshot.money).toBe(75);
      expect(snapshot.debtOwed).toBe(0);
      expect(snapshot.trainType).toBe(TrainType.FastFreight);
      expect(snapshot.remainingMovement).toBe(8);
      expect(snapshot.carriedLoads).toEqual([LoadType.Coal]);
      expect(snapshot.demandCards).toHaveLength(1);
      expect(snapshot.trackSegments).toHaveLength(2);
      expect(snapshot.allPlayerTracks).toHaveLength(2);
      expect(snapshot.opponents).toHaveLength(1);
      expect(snapshot.mapPoints.length).toBeGreaterThan(0);
      expect(snapshot.activeEvents).toEqual([]);
    });

    it('should correctly populate opponent data', async () => {
      setupMocks();

      const snapshot = await WorldSnapshotService.capture('game-1', 'bot-player-1', 'bot-user-1');

      expect(snapshot.opponents).toHaveLength(1);
      const opp = snapshot.opponents[0];
      expect(opp.playerId).toBe('opp-1');
      expect(opp.name).toBe('Human Player');
      expect(opp.money).toBe(120);
      expect(opp.trainType).toBe(TrainType.HeavyFreight);
      expect(opp.position).toEqual({ x: 500, y: 450, row: 10, col: 10 });
      expect(opp.loads).toEqual([LoadType.Wine, LoadType.Wheat]);
      expect(opp.trackSegmentCount).toBe(1);
      // Opponent has track at (10,10)-(10,9) which touches OtherCity center
      expect(opp.majorCitiesConnected).toBe(1);
    });

    it('should populate load availability from LoadService', async () => {
      setupMocks();

      const snapshot = await WorldSnapshotService.capture('game-1', 'bot-player-1', 'bot-user-1');

      expect(snapshot.loadAvailability.get('TestCity')).toEqual([LoadType.Steel, LoadType.Coal]);
      expect(snapshot.loadAvailability.get('SmallTown')).toEqual([LoadType.Wheat]);
    });

    it('should populate dropped loads grouped by city', async () => {
      setupMocks();

      const snapshot = await WorldSnapshotService.capture('game-1', 'bot-player-1', 'bot-user-1');

      const testCityDropped = snapshot.droppedLoads.get('TestCity');
      expect(testCityDropped).toEqual([LoadType.Wine, LoadType.Cheese]);
    });

    it('should set gamePhase to initialBuild when game status is initialBuild', async () => {
      const gameState = makeMockGameState({ status: 'initialBuild' as any });
      setupMocks(gameState);

      const snapshot = await WorldSnapshotService.capture('game-1', 'bot-player-1', 'bot-user-1');

      expect(snapshot.gamePhase).toBe('initialBuild');
    });

    it('should count connected major cities for the bot', async () => {
      setupMocks();

      const snapshot = await WorldSnapshotService.capture('game-1', 'bot-player-1', 'bot-user-1');

      // Bot has segments touching (5,5) and (5,4) which are TestCity center and outpost
      expect(snapshot.connectedMajorCities).toBe(1);
    });

    it('should handle bot with no track gracefully', async () => {
      setupMocks(makeMockGameState(), [
        // Only opponent track, no bot track
        {
          playerId: 'opp-1',
          gameId: 'game-1',
          segments: [],
          totalCost: 0,
          turnBuildCost: 0,
          lastBuildTimestamp: new Date(),
        },
      ]);

      const snapshot = await WorldSnapshotService.capture('game-1', 'bot-player-1', 'bot-user-1');

      expect(snapshot.trackSegments).toEqual([]);
      expect(snapshot.connectedMajorCities).toBe(0);
      expect(snapshot.turnBuildCostSoFar).toBe(0);
    });

    it('should handle bot with no position (not yet placed)', async () => {
      const gameState = makeMockGameState();
      gameState.players[0].trainState = {
        position: null as any,
        remainingMovement: 0,
        movementHistory: [],
        loads: [],
      };
      setupMocks(gameState);

      const snapshot = await WorldSnapshotService.capture('game-1', 'bot-player-1', 'bot-user-1');

      expect(snapshot.position).toBeNull();
      expect(snapshot.remainingMovement).toBe(0);
      expect(snapshot.carriedLoads).toEqual([]);
    });

    it('should throw when game is not found', async () => {
      setupMocks(null);

      await expect(
        WorldSnapshotService.capture('nonexistent', 'bot-player-1', 'bot-user-1'),
      ).rejects.toThrow('Game not found: nonexistent');
    });

    it('should throw when bot player is not found in game', async () => {
      setupMocks();

      await expect(
        WorldSnapshotService.capture('game-1', 'wrong-bot-id', 'bot-user-1'),
      ).rejects.toThrow('Bot player not found: wrong-bot-id in game game-1');
    });

    it('should fetch game state and tracks in parallel', async () => {
      setupMocks();

      await WorldSnapshotService.capture('game-1', 'bot-player-1', 'bot-user-1');

      // Both should be called (verified by having results)
      expect(mockGetGame).toHaveBeenCalledWith('game-1', 'bot-user-1');
      expect(mockGetAllTracks).toHaveBeenCalledWith('game-1');
    });
  });

  describe('snapshot immutability (deep freeze)', () => {
    it('should freeze the top-level snapshot object', async () => {
      setupMocks();

      const snapshot = await WorldSnapshotService.capture('game-1', 'bot-player-1', 'bot-user-1');

      expect(Object.isFrozen(snapshot)).toBe(true);
    });

    it('should freeze nested arrays', async () => {
      setupMocks();

      const snapshot = await WorldSnapshotService.capture('game-1', 'bot-player-1', 'bot-user-1');

      expect(Object.isFrozen(snapshot.carriedLoads)).toBe(true);
      expect(Object.isFrozen(snapshot.trackSegments)).toBe(true);
      expect(Object.isFrozen(snapshot.opponents)).toBe(true);
      expect(Object.isFrozen(snapshot.demandCards)).toBe(true);
      expect(Object.isFrozen(snapshot.activeEvents)).toBe(true);
    });

    it('should freeze nested objects', async () => {
      setupMocks();

      const snapshot = await WorldSnapshotService.capture('game-1', 'bot-player-1', 'bot-user-1');

      if (snapshot.position) {
        expect(Object.isFrozen(snapshot.position)).toBe(true);
      }
      if (snapshot.opponents.length > 0) {
        expect(Object.isFrozen(snapshot.opponents[0])).toBe(true);
      }
    });

    it('should freeze Map objects', async () => {
      setupMocks();

      const snapshot = await WorldSnapshotService.capture('game-1', 'bot-player-1', 'bot-user-1');

      expect(Object.isFrozen(snapshot.loadAvailability)).toBe(true);
      expect(Object.isFrozen(snapshot.droppedLoads)).toBe(true);
    });

    it('should throw in strict mode when attempting to modify frozen snapshot', async () => {
      setupMocks();

      const snapshot = await WorldSnapshotService.capture('game-1', 'bot-player-1', 'bot-user-1');

      // In strict mode (TypeScript default), assigning to frozen object throws
      expect(() => {
        (snapshot as any).money = 999;
      }).toThrow();
    });
  });

  describe('test fixture helpers (regression)', () => {
    it('should create a default snapshot with sensible defaults', () => {
      const snapshot = makeSnapshot();

      expect(snapshot.botPlayerId).toBe('bot-1');
      expect(snapshot.money).toBe(50);
      expect(snapshot.trainType).toBe(TrainType.Freight);
      expect(snapshot.remainingMovement).toBe(9);
      expect(snapshot.carriedLoads).toEqual([]);
      expect(snapshot.trackSegments).toEqual([]);
      expect(snapshot.opponents).toEqual([]);
    });

    it('should allow overriding specific fields', () => {
      const snapshot = makeSnapshot({
        money: 100,
        trainType: TrainType.FastFreight,
        remainingMovement: 12,
        carriedLoads: [LoadType.Coal],
      });

      expect(snapshot.money).toBe(100);
      expect(snapshot.trainType).toBe(TrainType.FastFreight);
      expect(snapshot.remainingMovement).toBe(12);
      expect(snapshot.carriedLoads).toEqual([LoadType.Coal]);
    });

    it('should not share references between snapshots', () => {
      const snapshot1 = makeSnapshot();
      const snapshot2 = makeSnapshot();

      snapshot1.carriedLoads.push(LoadType.Wine);

      expect(snapshot2.carriedLoads).toEqual([]);
    });

    it('should create grid points with correct data', () => {
      const point = makeGridPoint(3, 7, TerrainType.Clear);

      expect(point.row).toBe(3);
      expect(point.col).toBe(7);
      expect(point.terrain).toBe(TerrainType.Clear);
      expect(point.city).toBeUndefined();
    });
  });
});
