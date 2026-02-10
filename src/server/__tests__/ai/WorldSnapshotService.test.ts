/**
 * Unit tests for WorldSnapshotService.
 * Tests game state capture, immutability, and correct field mapping.
 *
 * Note: WorldSnapshotService implementation is pending (BE-001).
 * These tests define expected behavior and will be updated when the service is implemented.
 */

import { makeSnapshot, makeGridPoint } from './helpers/testFixtures';
import { TrainType, TerrainType } from '../../../shared/types/GameTypes';
import { LoadType } from '../../../shared/types/LoadTypes';
import type { WorldSnapshot } from '../../ai/types';

// Mock majorCityGroups
jest.mock('../../../shared/services/majorCityGroups', () => ({
  getMajorCityGroups: () => [
    {
      cityName: 'TestCity',
      center: { row: 5, col: 5 },
      outposts: [{ row: 5, col: 4 }, { row: 5, col: 6 }],
    },
  ],
  getFerryEdges: () => [],
}));

describe('WorldSnapshotService', () => {
  describe('snapshot creation via test fixtures', () => {
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

    it('should preserve non-overridden defaults when overriding', () => {
      const snapshot = makeSnapshot({ money: 200 });

      expect(snapshot.money).toBe(200);
      expect(snapshot.botPlayerId).toBe('bot-1');
      expect(snapshot.trainType).toBe(TrainType.Freight);
    });
  });

  describe('snapshot immutability', () => {
    it('should not share references between snapshots', () => {
      const snapshot1 = makeSnapshot();
      const snapshot2 = makeSnapshot();

      snapshot1.carriedLoads.push(LoadType.Wine);

      expect(snapshot2.carriedLoads).toEqual([]);
    });

    it('should not share map references between snapshots', () => {
      const snapshot1 = makeSnapshot();
      const snapshot2 = makeSnapshot();

      snapshot1.loadAvailability.set('Berlin', [LoadType.Coal]);

      expect(snapshot2.loadAvailability.size).toBe(0);
    });
  });

  describe('grid point creation', () => {
    it('should create a grid point with correct coordinates', () => {
      const point = makeGridPoint(3, 7, TerrainType.Clear);

      expect(point.row).toBe(3);
      expect(point.col).toBe(7);
      expect(point.terrain).toBe(TerrainType.Clear);
      expect(point.city).toBeUndefined();
    });

    it('should create a grid point with city data', () => {
      const point = makeGridPoint(5, 5, TerrainType.MajorCity, 'Berlin');

      expect(point.city).toBeDefined();
      expect(point.city!.name).toBe('Berlin');
      expect(point.city!.type).toBe(TerrainType.MajorCity);
    });
  });
});
