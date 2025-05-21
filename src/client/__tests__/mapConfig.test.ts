import { mapConfig } from '../config/mapConfig';
import { GridPoint, TerrainType } from '../../shared/types/GameTypes';

describe('mapConfig', () => {
  describe('ferry connections', () => {
    it('should load ferry connections with correct structure', () => {
      expect(mapConfig.ferryConnections).toBeDefined();
      expect(Array.isArray(mapConfig.ferryConnections)).toBe(true);
      
      // Test first ferry connection
      const firstFerry = mapConfig.ferryConnections![0];
      expect(firstFerry).toHaveProperty('Name');
      expect(firstFerry).toHaveProperty('connections');
      expect(firstFerry).toHaveProperty('cost');
      
      // Test connections array
      expect(firstFerry.connections).toHaveLength(2);
      expect(firstFerry.connections[0]).toBeInstanceOf(Object);
      expect(firstFerry.connections[1]).toBeInstanceOf(Object);
      
      // Test that connections are valid GridPoints
      const [point1, point2] = firstFerry.connections;
      expect(point1).toHaveProperty('x');
      expect(point1).toHaveProperty('y');
      expect(point1).toHaveProperty('col');
      expect(point1).toHaveProperty('row');
      expect(point1).toHaveProperty('terrain');
      expect(point1.terrain).toBe(TerrainType.FerryPort);
      
      expect(point2).toHaveProperty('x');
      expect(point2).toHaveProperty('y');
      expect(point2).toHaveProperty('col');
      expect(point2).toHaveProperty('row');
      expect(point2).toHaveProperty('terrain');
      expect(point2.terrain).toBe(TerrainType.FerryPort);
    });

    it('should have valid costs for ferry connections', () => {
      mapConfig.ferryConnections!.forEach(ferry => {
        expect(typeof ferry.cost).toBe('number');
        expect(ferry.cost).toBeGreaterThan(0);
      });
    });

    it('should have unique names for ferry connections', () => {
      const names = mapConfig.ferryConnections!.map(f => f.Name);
      const uniqueNames = new Set(names);
      expect(uniqueNames.size).toBe(names.length);
    });
  });
}); 