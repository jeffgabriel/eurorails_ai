import { CityArrivalHandler } from '../components/CityArrivalHandler';
import { GameState, GridPoint, TerrainType } from '../../shared/types/GameTypes';
import { PlayerStateService } from '../services/PlayerStateService';

// Mock Phaser scene
const mockScene = {
  scene: {
    launch: jest.fn(),
    stop: jest.fn(),
    bringToTop: jest.fn(),
  },
  input: {
    enabled: true,
  },
} as unknown as Phaser.Scene;

// Mock game state
const mockGameState: GameState = {
  id: 'test-game-id',
  players: [],
  currentPlayerIndex: 0,
  status: 'active',
  maxPlayers: 6,
};

// Mock PlayerStateService
const mockPlayerStateService = {
  getLocalPlayerId: jest.fn().mockReturnValue('test-player-id'),
} as unknown as PlayerStateService;

describe('CityArrivalHandler', () => {
  let handler: CityArrivalHandler;

  beforeEach(() => {
    handler = new CityArrivalHandler(
      mockScene,
      mockGameState,
      mockPlayerStateService
    );
  });

  describe('isCity', () => {
    it('returns true for MajorCity terrain', () => {
      const majorCityPoint: GridPoint = {
        id: '10-20',
        row: 10,
        col: 20,
        terrain: TerrainType.MajorCity,
        x: 100,
        y: 200,
        city: {
          name: 'Berlin',
          type: TerrainType.MajorCity,
          connectedPoints: [],
          availableLoads: [],
        },
      };

      expect(handler.isCity(majorCityPoint)).toBe(true);
    });

    it('returns true for MediumCity terrain', () => {
      const mediumCityPoint: GridPoint = {
        id: '15-25',
        row: 15,
        col: 25,
        terrain: TerrainType.MediumCity,
        x: 150,
        y: 250,
        city: {
          name: 'Hamburg',
          type: TerrainType.MediumCity,
          connectedPoints: [],
          availableLoads: [],
        },
      };

      expect(handler.isCity(mediumCityPoint)).toBe(true);
    });

    it('returns true for SmallCity terrain', () => {
      const smallCityPoint: GridPoint = {
        id: '5-10',
        row: 5,
        col: 10,
        terrain: TerrainType.SmallCity,
        x: 50,
        y: 100,
        city: {
          name: 'Bonn',
          type: TerrainType.SmallCity,
          connectedPoints: [],
          availableLoads: [],
        },
      };

      expect(handler.isCity(smallCityPoint)).toBe(true);
    });

    it('returns true for FerryPort with city data (Dublin)', () => {
      const dublinPoint: GridPoint = {
        id: '12-34',
        row: 12,
        col: 34,
        terrain: TerrainType.FerryPort,
        x: 120,
        y: 340,
        city: {
          name: 'Dublin',
          type: TerrainType.SmallCity,
          connectedPoints: [],
          availableLoads: [],
        },
      };

      expect(handler.isCity(dublinPoint)).toBe(true);
    });

    it('returns true for FerryPort with city data (Belfast)', () => {
      const belfastPoint: GridPoint = {
        id: '8-30',
        row: 8,
        col: 30,
        terrain: TerrainType.FerryPort,
        x: 80,
        y: 300,
        city: {
          name: 'Belfast',
          type: TerrainType.SmallCity,
          connectedPoints: [],
          availableLoads: [],
        },
      };

      expect(handler.isCity(belfastPoint)).toBe(true);
    });

    it('returns false for FerryPort without city data', () => {
      const regularFerryPort: GridPoint = {
        id: '5-10',
        row: 5,
        col: 10,
        terrain: TerrainType.FerryPort,
        x: 50,
        y: 100,
        city: undefined,
      };

      expect(handler.isCity(regularFerryPort)).toBe(false);
    });

    it('returns false for Clear terrain', () => {
      const clearPoint: GridPoint = {
        id: '1-1',
        row: 1,
        col: 1,
        terrain: TerrainType.Clear,
        x: 10,
        y: 10,
      };

      expect(handler.isCity(clearPoint)).toBe(false);
    });

    it('returns false for Mountain terrain', () => {
      const mountainPoint: GridPoint = {
        id: '2-2',
        row: 2,
        col: 2,
        terrain: TerrainType.Mountain,
        x: 20,
        y: 20,
      };

      expect(handler.isCity(mountainPoint)).toBe(false);
    });

    it('returns false for Alpine terrain', () => {
      const alpinePoint: GridPoint = {
        id: '3-3',
        row: 3,
        col: 3,
        terrain: TerrainType.Alpine,
        x: 30,
        y: 30,
      };

      expect(handler.isCity(alpinePoint)).toBe(false);
    });

    it('returns false for Water terrain', () => {
      const waterPoint: GridPoint = {
        id: '4-4',
        row: 4,
        col: 4,
        terrain: TerrainType.Water,
        x: 40,
        y: 40,
      };

      expect(handler.isCity(waterPoint)).toBe(false);
    });
  });

  describe('isSamePoint', () => {
    it('returns true for points at same grid position', () => {
      const point1 = { row: 10, col: 20, x: 100, y: 200 };
      const point2 = { row: 10, col: 20, x: 100, y: 200 };

      expect(handler.isSamePoint(point1, point2)).toBe(true);
    });

    it('returns false for points at different grid positions', () => {
      const point1 = { row: 10, col: 20, x: 100, y: 200 };
      const point2 = { row: 15, col: 25, x: 150, y: 250 };

      expect(handler.isSamePoint(point1, point2)).toBe(false);
    });

    it('returns false when first point is null', () => {
      const point2 = { row: 10, col: 20, x: 100, y: 200 };

      expect(handler.isSamePoint(null, point2)).toBe(false);
    });

    it('returns false when second point is null', () => {
      const point1 = { row: 10, col: 20, x: 100, y: 200 };

      expect(handler.isSamePoint(point1, null)).toBe(false);
    });

    it('returns false when both points are null', () => {
      expect(handler.isSamePoint(null, null)).toBe(false);
    });
  });
});
