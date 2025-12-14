import { MovementCostCalculator } from '../components/MovementCostCalculator';
import { PlayerTrackState, GridPoint, TerrainType, Point } from '../../shared/types/GameTypes';

// Mock the mapConfig import
jest.mock('../config/mapConfig', () => ({
  majorCityGroups: {
    'Berlin': [
      { GridX: 10, GridY: 10 }, // center
      { GridX: 9, GridY: 9 },   // perimeter 1
      { GridX: 11, GridY: 9 },  // perimeter 2
      { GridX: 12, GridY: 10 }, // perimeter 3
      { GridX: 11, GridY: 11 }, // perimeter 4
      { GridX: 9, GridY: 11 },  // perimeter 5
      { GridX: 8, GridY: 10 }   // perimeter 6
    ],
    'Paris': [
      { GridX: 20, GridY: 20 }, // center
      { GridX: 19, GridY: 19 }, // perimeter 1
      { GridX: 21, GridY: 19 }, // perimeter 2
      { GridX: 22, GridY: 20 }, // perimeter 3
      { GridX: 21, GridY: 21 }, // perimeter 4
      { GridX: 19, GridY: 21 }, // perimeter 5
      { GridX: 18, GridY: 20 }  // perimeter 6
    ],
    'Madrid': [
      { GridX: 15, GridY: 49 }, // center (approximated) - GridX=col, GridY=row
      { GridX: 15, GridY: 49 }, // perimeter 1 - starting position from console (49,15) = row 49, col 15
      { GridX: 16, GridY: 48 }, // perimeter 2 - target from console (48,16) = row 48, col 16
      { GridX: 17, GridY: 48 }, // perimeter 3
      { GridX: 17, GridY: 49 }, // perimeter 4
      { GridX: 16, GridY: 50 }, // perimeter 5
      { GridX: 15, GridY: 50 }  // perimeter 6
    ]
  }
}));

describe('MovementCostCalculator', () => {
  let calculator: MovementCostCalculator;
  let mockPlayerTrackState: PlayerTrackState;
  let mockAllPoints: GridPoint[];

  beforeEach(() => {
    calculator = new MovementCostCalculator();
    
    // Create a simple track with some segments
    mockPlayerTrackState = {
      gameId: 'test-game',
      playerId: 'test-player',
      segments: [
        {
          from: { row: 1, col: 1, x: 0, y: 0, terrain: TerrainType.Clear },
          to: { row: 1, col: 2, x: 0, y: 0, terrain: TerrainType.Clear },
          cost: 1
        },
        {
          from: { row: 1, col: 2, x: 0, y: 0, terrain: TerrainType.Clear },
          to: { row: 1, col: 3, x: 0, y: 0, terrain: TerrainType.Clear },
          cost: 1
        },
        {
          from: { row: 1, col: 3, x: 0, y: 0, terrain: TerrainType.Clear },
          to: { row: 2, col: 3, x: 0, y: 0, terrain: TerrainType.Clear },
          cost: 1
        },
        // Connect to Berlin perimeter node
        {
          from: { row: 2, col: 3, x: 0, y: 0, terrain: TerrainType.Clear },
          to: { row: 9, col: 9, x: 0, y: 0, terrain: TerrainType.MajorCity },
          cost: 1
        }
      ],
      totalCost: 4,
      turnBuildCost: 0,
      lastBuildTimestamp: new Date()
    };

    // Mock points including major city centers and perimeter nodes
    mockAllPoints = [
      {
        id: 'berlin-center',
        row: 10,
        col: 10,
        x: 100,
        y: 100,
        terrain: TerrainType.MajorCity,
        city: {
          type: TerrainType.MajorCity,
          name: 'Berlin',
          connectedPoints: [
            { row: 9, col: 9 },
            { row: 11, col: 9 },
            { row: 12, col: 10 },
            { row: 11, col: 11 },
            { row: 9, col: 11 },
            { row: 8, col: 10 }
          ],
          availableLoads: []
        }
      },
      {
        id: 'paris-center',
        row: 20,
        col: 20,
        x: 200,
        y: 200,
        terrain: TerrainType.MajorCity,
        city: {
          type: TerrainType.MajorCity,
          name: 'Paris',
          connectedPoints: [
            { row: 19, col: 19 },
            { row: 21, col: 19 },
            { row: 22, col: 20 },
            { row: 21, col: 21 },
            { row: 19, col: 21 },
            { row: 18, col: 20 }
          ],
          availableLoads: []
        }
      },
      // Regular points
      {
        id: 'point-1-1',
        row: 1,
        col: 1,
        x: 10,
        y: 10,
        terrain: TerrainType.Clear
      },
      {
        id: 'point-1-2',
        row: 1,
        col: 2,
        x: 20,
        y: 10,
        terrain: TerrainType.Clear
      }
    ];
  });

  describe('City identification', () => {
    it('should identify nodes in major cities', () => {
      const berlinPerimeter: Point = { row: 9, col: 9, x: 0, y: 0 };
      const parisPerimeter: Point = { row: 19, col: 19, x: 0, y: 0 };
      const normalPoint: Point = { row: 5, col: 5, x: 0, y: 0 };

      expect(calculator.isNodeInMajorCity(berlinPerimeter)).toBe(true);
      expect(calculator.isNodeInMajorCity(parisPerimeter)).toBe(true);
      expect(calculator.isNodeInMajorCity(normalPoint)).toBe(false);
    });

    it('should identify city names correctly', () => {
      const berlinPerimeter: Point = { row: 9, col: 9, x: 0, y: 0 };
      const parisPerimeter: Point = { row: 19, col: 19, x: 0, y: 0 };

      expect(calculator.getCityForNode(berlinPerimeter)).toBe('Berlin');
      expect(calculator.getCityForNode(parisPerimeter)).toBe('Paris');
    });

    it('should identify nodes in same city', () => {
      const berlinPerimeter1: Point = { row: 9, col: 9, x: 0, y: 0 };
      const berlinPerimeter2: Point = { row: 11, col: 9, x: 0, y: 0 };
      const parisPerimeter: Point = { row: 19, col: 19, x: 0, y: 0 };

      expect(calculator.areNodesInSameCity(berlinPerimeter1, berlinPerimeter2)).toBe(true);
      expect(calculator.areNodesInSameCity(berlinPerimeter1, parisPerimeter)).toBe(false);
    });
  });

  describe('Movement cost calculation', () => {
    it('should return 0 cost for same position', () => {
      const point: Point = { row: 5, col: 5, x: 0, y: 0 };
      const result = calculator.calculateMovementCost(point, point, mockPlayerTrackState, mockAllPoints);
      
      expect(result.isValid).toBe(true);
      expect(result.totalCost).toBe(0);
      expect(result.segments).toHaveLength(0);
    });

    it('should handle major city center to perimeter movement', () => {
      const berlinCenter: Point = { row: 10, col: 10, x: 0, y: 0 };
      const berlinPerimeter: Point = { row: 9, col: 9, x: 0, y: 0 };
      
      const result = calculator.calculateMovementCost(berlinCenter, berlinPerimeter, null, mockAllPoints);
      
      expect(result.isValid).toBe(true);
      expect(result.totalCost).toBe(0);
      expect(result.segments).toHaveLength(1);
      expect(result.segments[0].type).toBe('city_internal');
    });

    it('should calculate normal track movement', () => {
      const from: Point = { row: 1, col: 1, x: 0, y: 0 };
      const to: Point = { row: 1, col: 3, x: 0, y: 0 };
      
      const result = calculator.calculateMovementCost(from, to, mockPlayerTrackState, mockAllPoints);
      
      expect(result.isValid).toBe(true);
      expect(result.totalCost).toBe(2); // Two segments: 1->2, 2->3
      expect(result.segments).toHaveLength(2);
      expect(result.segments.every(s => s.type === 'normal')).toBe(true);
    });

    it('should fail when no valid path exists', () => {
      const from: Point = { row: 1, col: 1, x: 0, y: 0 };
      const to: Point = { row: 10, col: 10, x: 0, y: 0 }; // Not connected to track
      
      const result = calculator.calculateMovementCost(from, to, mockPlayerTrackState, mockAllPoints);
      
      expect(result.isValid).toBe(false);
      expect(result.totalCost).toBe(-1);
      expect(result.errorMessage).toBeDefined();
    });

    it('should handle major city internal transit with fixed cost', () => {
      const berlinPerimeter1: Point = { row: 9, col: 9, x: 0, y: 0 };
      const berlinPerimeter2: Point = { row: 11, col: 9, x: 0, y: 0 };
      
      // Create track that connects these perimeter nodes directly
      const trackWithCityConnection: PlayerTrackState = {
        gameId: 'test-game',
        playerId: 'test-player',
        segments: [
          {
            from: { ...berlinPerimeter1, terrain: TerrainType.MajorCity },
            to: { ...berlinPerimeter2, terrain: TerrainType.MajorCity },
            cost: 1
          }
        ],
        totalCost: 1,
        turnBuildCost: 0,
        lastBuildTimestamp: new Date()
      };
      
      const result = calculator.calculateMovementCost(
        berlinPerimeter1, 
        berlinPerimeter2, 
        trackWithCityConnection, 
        mockAllPoints
      );
      
      expect(result.isValid).toBe(true);
      expect(result.totalCost).toBe(1); // City internal movement always costs 1
      expect(result.segments).toHaveLength(1);
      expect(result.segments[0].type).toBe('city_internal');
    });

    it('should reject movement when no track data and not major city case', () => {
      const from: Point = { row: 5, col: 5, x: 0, y: 0 };
      const to: Point = { row: 6, col: 6, x: 0, y: 0 };
      
      const result = calculator.calculateMovementCost(from, to, null, mockAllPoints);
      
      expect(result.isValid).toBe(false);
      expect(result.totalCost).toBe(-1);
      expect(result.errorMessage).toContain('No track data available');
    });

    it('should handle starting from unconnected city perimeter node (Madrid scenario)', () => {
      // Madrid perimeter nodes based on console output
      const madridPerimeter1: Point = { row: 49, col: 15, x: 797.5, y: 2060 }; // Starting position
      const madridPerimeter2: Point = { row: 48, col: 16, x: 0, y: 0 };          // Adjacent perimeter
      const valenciaConnection: Point = { row: 40, col: 20, x: 0, y: 0 };        // Connected to track
      
      // Create track that has connection from city but not to the starting perimeter node
      const trackFromMadrid: PlayerTrackState = {
        gameId: 'test-game',
        playerId: 'test-player',
        segments: [
          // Track continues from a different Madrid perimeter node (not the starting one)
          {
            from: { ...madridPerimeter2, terrain: TerrainType.MajorCity },
            to: { ...valenciaConnection, terrain: TerrainType.Clear },
            cost: 1
          },
          // More track segments...
          {
            from: { ...valenciaConnection, terrain: TerrainType.Clear },
            to: { row: 39, col: 21, x: 0, y: 0, terrain: TerrainType.Clear },
            cost: 1
          }
        ],
        totalCost: 2,
        turnBuildCost: 0,
        lastBuildTimestamp: new Date()
      };

      // Mock Madrid city data
      const madridCityPoints: GridPoint[] = [
        {
          id: 'madrid-center',
          row: 49,
          col: 16, // Approximate center
          x: 800,
          y: 2000,
          terrain: TerrainType.MajorCity,
          city: {
            type: TerrainType.MajorCity,
            name: 'Madrid',
            connectedPoints: [
              { row: 49, col: 15 }, // Starting perimeter
              { row: 48, col: 16 }, // Target perimeter  
              { row: 48, col: 17 },
              { row: 49, col: 17 },
              { row: 50, col: 16 },
              { row: 50, col: 15 }
            ],
            availableLoads: []
          }
        },
        ...mockAllPoints
      ];

      // Movement within same city should be free even if starting node not on track
      const result = calculator.calculateMovementCost(
        madridPerimeter1, 
        madridPerimeter2, 
        trackFromMadrid, 
        madridCityPoints
      );
      expect(result.isValid).toBe(true);
      expect(result.totalCost).toBe(0); // Should be 0 cost for city internal movement from unconnected start
      expect(result.segments).toHaveLength(1);
      expect(result.segments[0].type).toBe('city_internal');
      expect(result.segments[0].cost).toBe(0);
    });
  });

  describe('Path analysis and segment classification', () => {
    it('should classify city entry movement', () => {
      const external: Point = { row: 1, col: 1, x: 0, y: 0 };
      const cityPerimeter: Point = { row: 9, col: 9, x: 0, y: 0 };
      
      // Create track connecting external to city
      const trackWithCityEntry: PlayerTrackState = {
        gameId: 'test-game',
        playerId: 'test-player',
        segments: [
          {
            from: { ...external, terrain: TerrainType.Clear },
            to: { ...cityPerimeter, terrain: TerrainType.MajorCity },
            cost: 1
          }
        ],
        totalCost: 1,
        turnBuildCost: 0,
        lastBuildTimestamp: new Date()
      };
      
      const result = calculator.calculateMovementCost(external, cityPerimeter, trackWithCityEntry, mockAllPoints);
      
      expect(result.isValid).toBe(true);
      expect(result.segments).toHaveLength(1);
      expect(result.segments[0].type).toBe('city_entry');
      expect(result.segments[0].cost).toBe(1);
    });

    it('should classify city exit movement', () => {
      const cityPerimeter: Point = { row: 9, col: 9, x: 0, y: 0 };
      const external: Point = { row: 1, col: 1, x: 0, y: 0 };
      
      // Create track connecting city to external
      const trackWithCityExit: PlayerTrackState = {
        gameId: 'test-game',
        playerId: 'test-player',
        segments: [
          {
            from: { ...cityPerimeter, terrain: TerrainType.MajorCity },
            to: { ...external, terrain: TerrainType.Clear },
            cost: 1
          }
        ],
        totalCost: 1,
        turnBuildCost: 0,
        lastBuildTimestamp: new Date()
      };
      
      const result = calculator.calculateMovementCost(cityPerimeter, external, trackWithCityExit, mockAllPoints);
      
      expect(result.isValid).toBe(true);
      expect(result.segments).toHaveLength(1);
      expect(result.segments[0].type).toBe('city_exit');
      expect(result.segments[0].cost).toBe(1);
    });
  });
});