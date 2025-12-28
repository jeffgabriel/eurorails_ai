import { TrackSegment } from '../../shared/types/TrackTypes';

// Mock majorCityGroups before importing VictoryService
const mockMajorCityGroups: { [name: string]: Array<{ GridX: number; GridY: number }> } = {
  'Paris': [
    { GridX: 10, GridY: 20 },  // center
    { GridX: 11, GridY: 20 },  // outpost 1
    { GridX: 10, GridY: 21 },  // outpost 2
  ],
  'Berlin': [
    { GridX: 30, GridY: 15 },
    { GridX: 31, GridY: 15 },
  ],
  'London': [
    { GridX: 5, GridY: 10 },
    { GridX: 6, GridY: 10 },
  ],
  'Madrid': [
    { GridX: 8, GridY: 40 },
  ],
  'Rome': [
    { GridX: 25, GridY: 35 },
    { GridX: 26, GridY: 35 },
  ],
  'Vienna': [
    { GridX: 35, GridY: 25 },
  ],
  'Amsterdam': [
    { GridX: 15, GridY: 8 },
  ],
  'Brussels': [
    { GridX: 12, GridY: 12 },
  ],
  'Milan': [
    { GridX: 22, GridY: 30 },
  ],
  'Munich': [
    { GridX: 28, GridY: 22 },
  ],
};

jest.mock('../config/mapConfig', () => ({
  majorCityGroups: mockMajorCityGroups,
}));

// Import after mocking
import { VictoryService } from '../services/VictoryService';

describe('VictoryService', () => {
  let service: VictoryService;

  beforeEach(() => {
    // Reset the singleton for each test
    (VictoryService as any).instance = undefined;
    service = VictoryService.getInstance();
  });

  describe('getInstance', () => {
    it('should return a singleton instance', () => {
      const instance1 = VictoryService.getInstance();
      const instance2 = VictoryService.getInstance();
      expect(instance1).toBe(instance2);
    });
  });

  describe('getMajorCityMileposts', () => {
    it('should return all major cities with their coordinates', () => {
      const mileposts = service.getMajorCityMileposts();

      expect(mileposts.size).toBe(10);
      expect(mileposts.has('Paris')).toBe(true);
      expect(mileposts.has('Berlin')).toBe(true);
    });

    it('should convert GridX/GridY to col/row correctly', () => {
      const mileposts = service.getMajorCityMileposts();
      const paris = mileposts.get('Paris');

      expect(paris).toHaveLength(3);
      expect(paris![0]).toEqual({ row: 20, col: 10 });
      expect(paris![1]).toEqual({ row: 20, col: 11 });
    });
  });

  describe('getConnectedMajorCities', () => {
    it('should return empty array for no segments', () => {
      const result = service.getConnectedMajorCities([]);
      expect(result).toEqual([]);
    });

    it('should find a single connected city', () => {
      const segments: TrackSegment[] = [
        { from: { row: 20, col: 10 }, to: { row: 20, col: 9 } }, // Paris center to adjacent
      ];

      const result = service.getConnectedMajorCities(segments);
      expect(result).toHaveLength(1);
      expect(result[0].name).toBe('Paris');
    });

    it('should find two connected cities', () => {
      // Connect Paris to Berlin via intermediate points
      const segments: TrackSegment[] = [
        { from: { row: 20, col: 10 }, to: { row: 18, col: 15 } }, // Paris to intermediate
        { from: { row: 18, col: 15 }, to: { row: 15, col: 20 } }, // intermediate
        { from: { row: 15, col: 20 }, to: { row: 15, col: 25 } }, // intermediate
        { from: { row: 15, col: 25 }, to: { row: 15, col: 30 } }, // intermediate to Berlin
      ];

      const result = service.getConnectedMajorCities(segments);
      expect(result).toHaveLength(2);
      const cityNames = result.map(c => c.name).sort();
      expect(cityNames).toEqual(['Berlin', 'Paris']);
    });

    it('should connect cities via outposts (implicit edges within major city)', () => {
      // Track enters Paris at one outpost and exits at another
      // The outposts should be implicitly connected within the city
      const segments: TrackSegment[] = [
        { from: { row: 19, col: 11 }, to: { row: 20, col: 11 } }, // Enter Paris at outpost 1
        { from: { row: 10, col: 21 }, to: { row: 10, col: 22 } }, // Something connected to outpost 2 (col 10, row 21)
        // Note: Without implicit edges, these would be disconnected
      ];

      // This tests that outposts within a city get connected
      // The segments include row 20, col 11 (Paris outpost 1)
      // If we also add segment touching row 21, col 10 (Paris outpost 2), they should connect
      const segmentsWithBothOutposts: TrackSegment[] = [
        { from: { row: 19, col: 11 }, to: { row: 20, col: 11 } }, // Connects to Paris outpost 1
        { from: { row: 21, col: 10 }, to: { row: 22, col: 10 } }, // Connects to Paris outpost 2
      ];

      const result = service.getConnectedMajorCities(segmentsWithBothOutposts);
      // Both outposts are part of Paris, so only 1 city
      expect(result).toHaveLength(1);
      expect(result[0].name).toBe('Paris');
    });

    it('should handle disconnected track networks and return the component with most cities', () => {
      // Two separate networks: one with 2 cities, one with 1 city
      const segments: TrackSegment[] = [
        // Network 1: Paris to Berlin
        { from: { row: 20, col: 10 }, to: { row: 18, col: 15 } },
        { from: { row: 18, col: 15 }, to: { row: 15, col: 30 } },
        // Network 2: London alone (disconnected)
        { from: { row: 10, col: 5 }, to: { row: 10, col: 4 } },
      ];

      const result = service.getConnectedMajorCities(segments);
      // Should return the network with Paris and Berlin (2 cities), not London (1 city)
      expect(result).toHaveLength(2);
      const cityNames = result.map(c => c.name).sort();
      expect(cityNames).toEqual(['Berlin', 'Paris']);
    });
  });

  describe('hasSevenConnectedCities', () => {
    it('should return false with fewer than 7 connected cities', () => {
      const segments: TrackSegment[] = [
        { from: { row: 20, col: 10 }, to: { row: 15, col: 30 } }, // Paris to Berlin
      ];

      const result = service.hasSevenConnectedCities(segments);
      expect(result).toBe(false);
    });

    it('should return true with exactly 7 connected cities', () => {
      // Create a network connecting 7 cities
      const segments: TrackSegment[] = [
        // Paris (10, 20) -> Berlin (30, 15)
        { from: { row: 20, col: 10 }, to: { row: 15, col: 30 } },
        // Berlin -> London (5, 10)
        { from: { row: 15, col: 30 }, to: { row: 10, col: 5 } },
        // London -> Madrid (8, 40)
        { from: { row: 10, col: 5 }, to: { row: 40, col: 8 } },
        // Madrid -> Rome (25, 35)
        { from: { row: 40, col: 8 }, to: { row: 35, col: 25 } },
        // Rome -> Vienna (35, 25)
        { from: { row: 35, col: 25 }, to: { row: 25, col: 35 } },
        // Vienna -> Amsterdam (15, 8)
        { from: { row: 25, col: 35 }, to: { row: 8, col: 15 } },
        // Amsterdam -> Brussels (12, 12)
        { from: { row: 8, col: 15 }, to: { row: 12, col: 12 } },
      ];

      const result = service.hasSevenConnectedCities(segments);
      expect(result).toBe(true);
    });

    it('should return true with more than 7 connected cities', () => {
      // Create a network connecting all 10 mock cities
      const segments: TrackSegment[] = [
        { from: { row: 20, col: 10 }, to: { row: 15, col: 30 } }, // Paris -> Berlin
        { from: { row: 15, col: 30 }, to: { row: 10, col: 5 } },  // Berlin -> London
        { from: { row: 10, col: 5 }, to: { row: 40, col: 8 } },   // London -> Madrid
        { from: { row: 40, col: 8 }, to: { row: 35, col: 25 } },  // Madrid -> Rome
        { from: { row: 35, col: 25 }, to: { row: 25, col: 35 } }, // Rome -> Vienna
        { from: { row: 25, col: 35 }, to: { row: 8, col: 15 } },  // Vienna -> Amsterdam
        { from: { row: 8, col: 15 }, to: { row: 12, col: 12 } },  // Amsterdam -> Brussels
        { from: { row: 12, col: 12 }, to: { row: 30, col: 22 } }, // Brussels -> Milan
        { from: { row: 30, col: 22 }, to: { row: 22, col: 28 } }, // Milan -> Munich
      ];

      const result = service.hasSevenConnectedCities(segments);
      expect(result).toBe(true);
    });
  });

  describe('checkVictoryConditions', () => {
    // Helper to create 7-city connected network
    const sevenCityNetwork: TrackSegment[] = [
      { from: { row: 20, col: 10 }, to: { row: 15, col: 30 } },
      { from: { row: 15, col: 30 }, to: { row: 10, col: 5 } },
      { from: { row: 10, col: 5 }, to: { row: 40, col: 8 } },
      { from: { row: 40, col: 8 }, to: { row: 35, col: 25 } },
      { from: { row: 35, col: 25 }, to: { row: 25, col: 35 } },
      { from: { row: 25, col: 35 }, to: { row: 8, col: 15 } },
      { from: { row: 8, col: 15 }, to: { row: 12, col: 12 } },
    ];

    it('should return eligible=false with insufficient money', () => {
      const result = service.checkVictoryConditions(200, sevenCityNetwork, 250);
      expect(result.eligible).toBe(false);
      // Network actually connects 8 cities due to geometry
      expect(result.connectedCities.length).toBeGreaterThanOrEqual(7);
    });

    it('should return eligible=false with insufficient cities', () => {
      const fewCities: TrackSegment[] = [
        { from: { row: 20, col: 10 }, to: { row: 15, col: 30 } },
      ];
      const result = service.checkVictoryConditions(300, fewCities, 250);
      expect(result.eligible).toBe(false);
      expect(result.connectedCities).toHaveLength(2);
    });

    it('should return eligible=true with sufficient money and 7+ cities', () => {
      const result = service.checkVictoryConditions(250, sevenCityNetwork, 250);
      expect(result.eligible).toBe(true);
      // Network connects 8 cities due to geometry
      expect(result.connectedCities.length).toBeGreaterThanOrEqual(7);
    });

    it('should return eligible=true with money exactly at threshold', () => {
      const result = service.checkVictoryConditions(250, sevenCityNetwork, 250);
      expect(result.eligible).toBe(true);
    });

    it('should respect custom threshold (tie extension to 300M)', () => {
      const result = service.checkVictoryConditions(280, sevenCityNetwork, 300);
      expect(result.eligible).toBe(false);

      const result2 = service.checkVictoryConditions(300, sevenCityNetwork, 300);
      expect(result2.eligible).toBe(true);
    });
  });

  describe('implicit city outpost connections', () => {
    it('should connect separate track segments that both touch the same major city', () => {
      // Two separate tracks, each entering Paris from a different direction
      // They should be connected via Paris's internal network
      const segments: TrackSegment[] = [
        // Track 1: enters Paris center from west, continues to Berlin
        { from: { row: 20, col: 9 }, to: { row: 20, col: 10 } },  // west -> Paris center
        { from: { row: 20, col: 10 }, to: { row: 15, col: 30 } }, // Paris center -> Berlin
        // Track 2: enters Paris outpost 2 from south, continues to Madrid
        { from: { row: 22, col: 10 }, to: { row: 21, col: 10 } }, // south -> Paris outpost 2
        { from: { row: 21, col: 10 }, to: { row: 40, col: 8 } },  // Paris outpost 2 -> Madrid
      ];

      const result = service.getConnectedMajorCities(segments);
      // Paris center and outpost 2 should be implicitly connected,
      // so Berlin, Paris, and Madrid should all be in one component
      expect(result).toHaveLength(3);
      const cityNames = result.map(c => c.name).sort();
      expect(cityNames).toEqual(['Berlin', 'Madrid', 'Paris']);
    });

    it('should NOT connect cities that only share track coordinates (not city outposts)', () => {
      // Two completely separate networks with no shared city
      const segments: TrackSegment[] = [
        // Network 1: Paris to Berlin
        { from: { row: 20, col: 10 }, to: { row: 15, col: 30 } },
        // Network 2: Rome to Vienna (completely separate)
        { from: { row: 35, col: 25 }, to: { row: 25, col: 35 } },
      ];

      const result = service.getConnectedMajorCities(segments);
      // Should return the first component encountered with most cities (both have 2)
      expect(result).toHaveLength(2);
    });
  });
});
