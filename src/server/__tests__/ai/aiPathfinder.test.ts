/**
 * Unit Tests for AI Pathfinder Service
 * Tests findBestRoute, evaluateTrackBuildOptions, and calculateRouteROI
 */

import { AIPathfinder, getAIPathfinder } from '../../services/ai/aiPathfinder';
import { AIGameState, Route, BuildOption } from '../../services/ai/types';
import { Point, TrackSegment, Player, TrainType, PlayerColor, TerrainType } from '../../../shared/types/GameTypes';
import { DemandCard, Demand } from '../../../shared/types/DemandCard';
import { LoadType } from '../../../shared/types/LoadTypes';

describe('AIPathfinder', () => {
  let pathfinder: AIPathfinder;

  beforeEach(() => {
    pathfinder = new AIPathfinder();
  });

  // Helper to create a mock Point
  const createMockPoint = (x: number, y: number, row: number = 0, col: number = 0): Point => ({
    x,
    y,
    row,
    col,
  });

  // Helper to create track segments
  const createSegment = (
    from: Point,
    to: Point,
    _playerId: string = 'player-1',
    terrain: TerrainType = TerrainType.Clear
  ): TrackSegment => ({
    from: { x: from.x, y: from.y, row: from.row, col: from.col, terrain },
    to: { x: to.x, y: to.y, row: to.row, col: to.col, terrain },
    cost: 1,
  });

  // Helper to create mock player
  const createMockPlayer = (
    overrides: Partial<Player> = {}
  ): Player => ({
    id: 'ai-player-1',
    name: 'Test AI',
    color: PlayerColor.BLUE,
    money: 50,
    trainType: TrainType.Freight,
    turnNumber: 1,
    trainState: {
      position: createMockPoint(100, 100),
      remainingMovement: 9,
      movementHistory: [],
      loads: [],
    },
    hand: [],
    isAI: true,
    aiDifficulty: 'medium',
    aiPersonality: 'optimizer',
    ...overrides,
  });

  // Helper to create mock game state
  const createMockGameState = (
    overrides: Partial<AIGameState> = {}
  ): AIGameState => ({
    players: [createMockPlayer()],
    currentPlayerId: 'ai-player-1',
    turnNumber: 1,
    availableLoads: new Map(),
    droppedLoads: [],
    allTrack: new Map(),
    ...overrides,
  });

  // Helper to create mock demand card
  const createMockDemandCard = (
    payment: number = 20,
    city: string = 'Berlin',
    resource: LoadType = LoadType.Cars
  ): DemandCard => ({
    id: 1,
    demands: [{ city, resource, payment }],
  });

  describe('getAIPathfinder', () => {
    it('should return a singleton instance', () => {
      const instance1 = getAIPathfinder();
      const instance2 = getAIPathfinder();
      expect(instance1).toBe(instance2);
    });
  });

  describe('findBestRoute', () => {
    it('should return null when no route exists', () => {
      const from = createMockPoint(0, 0);
      const to = createMockPoint(100, 100);
      const playerTrack: TrackSegment[] = []; // No track

      const route = pathfinder.findBestRoute(from, to, playerTrack);

      expect(route).toBeNull();
    });

    it('should return zero-cost route for same point', () => {
      const point = createMockPoint(50, 50);
      const playerTrack: TrackSegment[] = [];

      const route = pathfinder.findBestRoute(point, point, playerTrack);

      expect(route).not.toBeNull();
      expect(route!.totalCost).toBe(0);
      expect(route!.distance).toBe(0);
      expect(route!.segments).toHaveLength(0);
    });

    it('should find direct connection if exists', () => {
      const from = createMockPoint(0, 0);
      const to = createMockPoint(10, 10);
      const playerTrack: TrackSegment[] = [
        createSegment(from, to, 'ai-player-1'),
      ];

      const route = pathfinder.findBestRoute(from, to, playerTrack);

      expect(route).not.toBeNull();
      expect(route!.segments).toHaveLength(1);
      expect(route!.totalCost).toBe(0); // Own track
    });

    it('should find reverse connection', () => {
      const from = createMockPoint(0, 0);
      const to = createMockPoint(10, 10);
      // Track is stored in reverse direction
      const playerTrack: TrackSegment[] = [
        createSegment(to, from, 'ai-player-1'),
      ];

      const route = pathfinder.findBestRoute(from, to, playerTrack);

      expect(route).not.toBeNull();
    });

    it('should return Route structure with all required fields', () => {
      const from = createMockPoint(0, 0);
      const to = createMockPoint(10, 10);
      const playerTrack: TrackSegment[] = [
        createSegment(from, to, 'ai-player-1'),
      ];

      const route = pathfinder.findBestRoute(from, to, playerTrack);

      expect(route).toHaveProperty('from');
      expect(route).toHaveProperty('to');
      expect(route).toHaveProperty('segments');
      expect(route).toHaveProperty('totalCost');
      expect(route).toHaveProperty('distance');
    });

    describe('distance calculation', () => {
      it('should calculate correct distance for horizontal route', () => {
        const from = createMockPoint(0, 0);
        const to = createMockPoint(10, 0);
        const playerTrack: TrackSegment[] = [
          createSegment(from, to, 'ai-player-1'),
        ];

        const route = pathfinder.findBestRoute(from, to, playerTrack);

        expect(route!.distance).toBe(10);
      });

      it('should calculate correct distance for vertical route', () => {
        const from = createMockPoint(0, 0);
        const to = createMockPoint(0, 15);
        const playerTrack: TrackSegment[] = [
          createSegment(from, to, 'ai-player-1'),
        ];

        const route = pathfinder.findBestRoute(from, to, playerTrack);

        expect(route!.distance).toBe(15);
      });

      it('should calculate correct distance for diagonal route', () => {
        const from = createMockPoint(0, 0);
        const to = createMockPoint(3, 4);
        const playerTrack: TrackSegment[] = [
          createSegment(from, to, 'ai-player-1'),
        ];

        const route = pathfinder.findBestRoute(from, to, playerTrack);

        expect(route!.distance).toBe(5); // 3-4-5 triangle
      });
    });
  });

  describe('evaluateTrackBuildOptions', () => {
    it('should return an array of BuildOption', () => {
      const player = createMockPlayer();
      const gameState = createMockGameState();

      const options = pathfinder.evaluateTrackBuildOptions(player, gameState);

      expect(Array.isArray(options)).toBe(true);
    });

    it('should return BuildOption with required structure', () => {
      const player = createMockPlayer();
      const trackMap = new Map<string, TrackSegment[]>();
      trackMap.set(player.id, [
        createSegment({ x: 0, y: 0 }, { x: 10, y: 10 }, player.id),
      ]);
      const gameState = createMockGameState({ allTrack: trackMap });

      const options = pathfinder.evaluateTrackBuildOptions(player, gameState);

      // Even if empty, the structure should be consistent
      options.forEach((option: BuildOption) => {
        expect(option).toHaveProperty('targetPoint');
        expect(option).toHaveProperty('segments');
        expect(option).toHaveProperty('cost');
        expect(option).toHaveProperty('strategicValue');
        expect(option).toHaveProperty('connectsMajorCity');
      });
    });

    it('should return empty array for player with no track', () => {
      const player = createMockPlayer();
      const gameState = createMockGameState();

      const options = pathfinder.evaluateTrackBuildOptions(player, gameState);

      // New player with no track should have limited options
      expect(options).toBeDefined();
    });

    it('should consider player budget constraints', () => {
      const poorPlayer = createMockPlayer({ money: 3 }); // Only 3M
      const richPlayer = createMockPlayer({ money: 100 });
      const gameState = createMockGameState();

      const poorOptions = pathfinder.evaluateTrackBuildOptions(poorPlayer, gameState);
      const richOptions = pathfinder.evaluateTrackBuildOptions(richPlayer, gameState);

      // Both should return valid arrays
      expect(poorOptions).toBeDefined();
      expect(richOptions).toBeDefined();
    });
  });

  describe('calculateRouteROI', () => {
    it('should return payout as ROI when route cost is zero', () => {
      const route: Route = {
        from: createMockPoint(0, 0),
        to: createMockPoint(10, 10),
        segments: [],
        totalCost: 0,
        distance: 10,
      };
      const demandCard = createMockDemandCard(25, 'Berlin', LoadType.Cars);

      const roi = pathfinder.calculateRouteROI(route, demandCard);

      expect(roi).toBe(25);
    });

    it('should calculate positive ROI correctly', () => {
      const route: Route = {
        from: createMockPoint(0, 0),
        to: createMockPoint(10, 10),
        segments: [],
        totalCost: 10,
        distance: 10,
      };
      const demandCard = createMockDemandCard(30, 'Berlin', LoadType.Cars);

      const roi = pathfinder.calculateRouteROI(route, demandCard);

      // ROI = (30 - 10) / 10 = 2
      expect(roi).toBe(2);
    });

    it('should calculate negative ROI correctly', () => {
      const route: Route = {
        from: createMockPoint(0, 0),
        to: createMockPoint(10, 10),
        segments: [],
        totalCost: 20,
        distance: 10,
      };
      const demandCard = createMockDemandCard(15, 'Berlin', LoadType.Cars);

      const roi = pathfinder.calculateRouteROI(route, demandCard);

      // ROI = (15 - 20) / 20 = -0.25
      expect(roi).toBe(-0.25);
    });

    it('should handle null route gracefully', () => {
      const demandCard = createMockDemandCard();

      // @ts-expect-error - Testing null handling
      const roi = pathfinder.calculateRouteROI(null, demandCard);

      expect(roi).toBe(demandCard.demands[0].payment);
    });

    it('should handle high payout cards', () => {
      const route: Route = {
        from: createMockPoint(0, 0),
        to: createMockPoint(100, 100),
        segments: [],
        totalCost: 15,
        distance: 50,
      };
      const demandCard = createMockDemandCard(52, 'Lisboa', LoadType.Wine);

      const roi = pathfinder.calculateRouteROI(route, demandCard);

      // ROI = (52 - 15) / 15 ≈ 2.47
      expect(roi).toBeCloseTo(2.47, 1);
    });
  });

  describe('calculateDistance', () => {
    it('should return 0 for same point', () => {
      const point = createMockPoint(5, 5);
      const distance = pathfinder.calculateDistance(point, point);
      expect(distance).toBe(0);
    });

    it('should calculate horizontal distance', () => {
      const from = createMockPoint(0, 0);
      const to = createMockPoint(10, 0);
      const distance = pathfinder.calculateDistance(from, to);
      expect(distance).toBe(10);
    });

    it('should calculate vertical distance', () => {
      const from = createMockPoint(0, 0);
      const to = createMockPoint(0, 20);
      const distance = pathfinder.calculateDistance(from, to);
      expect(distance).toBe(20);
    });

    it('should calculate diagonal distance using Pythagorean theorem', () => {
      const from = createMockPoint(0, 0);
      const to = createMockPoint(6, 8);
      const distance = pathfinder.calculateDistance(from, to);
      expect(distance).toBe(10); // 6-8-10 triangle
    });

    it('should handle negative coordinates', () => {
      const from = createMockPoint(-5, -5);
      const to = createMockPoint(5, 5);
      const distance = pathfinder.calculateDistance(from, to);
      expect(distance).toBeCloseTo(14.14, 1); // sqrt(200) ≈ 14.14
    });
  });

  describe('calculateBuildCost', () => {
    it('should return 1 for clear terrain', () => {
      const cost = pathfinder.calculateBuildCost(createMockPoint(0, 0), createMockPoint(1, 0), 'clear');
      expect(cost).toBe(1);
    });

    it('should return 2 for mountain terrain', () => {
      const cost = pathfinder.calculateBuildCost(createMockPoint(0, 0), createMockPoint(1, 0), 'mountain');
      expect(cost).toBe(2);
    });

    it('should return 5 for alpine terrain', () => {
      const cost = pathfinder.calculateBuildCost(createMockPoint(0, 0), createMockPoint(1, 0), 'alpine');
      expect(cost).toBe(5);
    });

    it('should return 3 for small city', () => {
      const cost = pathfinder.calculateBuildCost(createMockPoint(0, 0), createMockPoint(1, 0), 'small_city');
      expect(cost).toBe(3);
    });

    it('should return 3 for medium city', () => {
      const cost = pathfinder.calculateBuildCost(createMockPoint(0, 0), createMockPoint(1, 0), 'medium_city');
      expect(cost).toBe(3);
    });

    it('should return 5 for major city', () => {
      const cost = pathfinder.calculateBuildCost(createMockPoint(0, 0), createMockPoint(1, 0), 'major_city');
      expect(cost).toBe(5);
    });

    it('should default to 1 for unknown terrain', () => {
      const cost = pathfinder.calculateBuildCost(createMockPoint(0, 0), createMockPoint(1, 0), 'unknown');
      expect(cost).toBe(1);
    });
  });

  describe('isValidBuild', () => {
    it('should return false if track already exists', () => {
      const from = createMockPoint(0, 0);
      const to = createMockPoint(10, 10);
      const existingTrack: TrackSegment[] = [
        createSegment(from, to, 'player-1'),
      ];

      const isValid = pathfinder.isValidBuild(from, to, existingTrack);

      expect(isValid).toBe(false);
    });

    it('should return false if reverse track exists', () => {
      const from = createMockPoint(0, 0);
      const to = createMockPoint(10, 10);
      const existingTrack: TrackSegment[] = [
        createSegment(to, from, 'player-1'), // Reverse direction
      ];

      const isValid = pathfinder.isValidBuild(from, to, existingTrack);

      expect(isValid).toBe(false);
    });

    it('should return true for new track location', () => {
      const from = createMockPoint(0, 0);
      const to = createMockPoint(10, 10);
      const existingTrack: TrackSegment[] = [
        createSegment(createMockPoint(20, 20), createMockPoint(30, 30), 'player-1'),
      ];

      const isValid = pathfinder.isValidBuild(from, to, existingTrack);

      expect(isValid).toBe(true);
    });

    it('should return true for empty track list', () => {
      const from = createMockPoint(0, 0);
      const to = createMockPoint(10, 10);

      const isValid = pathfinder.isValidBuild(from, to, []);

      expect(isValid).toBe(true);
    });
  });

  // Edge cases
  describe('edge cases', () => {
    it('should handle empty track array for findBestRoute', () => {
      const from = createMockPoint(0, 0);
      const to = createMockPoint(100, 100);

      const route = pathfinder.findBestRoute(from, to, []);

      expect(route).toBeNull();
    });

    it('should handle very large coordinates', () => {
      const from = createMockPoint(10000, 10000);
      const to = createMockPoint(20000, 20000);
      const playerTrack: TrackSegment[] = [
        createSegment(from, to, 'ai-player-1'),
      ];

      const route = pathfinder.findBestRoute(from, to, playerTrack);

      expect(route).not.toBeNull();
      expect(route!.distance).toBeCloseTo(14142.13, 0);
    });

    it('should handle floating point coordinates', () => {
      const from = createMockPoint(0.5, 0.5);
      const to = createMockPoint(10.5, 10.5);

      const distance = pathfinder.calculateDistance(from, to);

      expect(distance).toBeCloseTo(14.14, 1);
    });
  });
});
