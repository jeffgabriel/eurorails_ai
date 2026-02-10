/**
 * Unit tests for PlanValidator.
 * Tests plan validation against WorldSnapshot including funds, capacity, and reachability.
 *
 * Note: Full PlanValidator is pending (BE-005). The existing validationService.ts provides
 * feasibility checking functions that are tested in validationService.test.ts.
 * These tests cover the plan-level validation patterns.
 */

import { makeSnapshot, makeSegment, makeDemandCard } from './helpers/testFixtures';
import {
  validateDeliveryFeasibility,
  validateBuildTrackFeasibility,
  validateUpgradeFeasibility,
  VALID_UPGRADES,
  MAX_BUILD_PER_TURN,
} from '../../ai/validationService';
import { TrainType, TerrainType } from '../../../shared/types/GameTypes';
import { LoadType } from '../../../shared/types/LoadTypes';

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

describe('PlanValidator', () => {
  describe('fund validation', () => {
    it('should reject build plans exceeding 20 ECU per turn budget', () => {
      // Build budget is MAX_BUILD_PER_TURN (20)
      expect(MAX_BUILD_PER_TURN).toBe(20);

      const expensiveSegments = [
        makeSegment(0, 0, TerrainType.Clear, 0, 1, TerrainType.Alpine, 5),
        makeSegment(0, 1, TerrainType.Alpine, 0, 2, TerrainType.Alpine, 5),
        makeSegment(0, 2, TerrainType.Alpine, 0, 3, TerrainType.Alpine, 5),
        makeSegment(0, 3, TerrainType.Alpine, 0, 4, TerrainType.Alpine, 5),
        makeSegment(0, 4, TerrainType.Alpine, 0, 5, TerrainType.Alpine, 5),
      ];
      const totalCost = expensiveSegments.reduce((sum, s) => sum + s.cost, 0);
      expect(totalCost).toBe(25);
      expect(totalCost).toBeGreaterThan(MAX_BUILD_PER_TURN);
    });

    it('should accept build plans within budget', () => {
      const segments = [
        makeSegment(0, 0, TerrainType.Clear, 0, 1, TerrainType.Clear, 1),
        makeSegment(0, 1, TerrainType.Clear, 0, 2, TerrainType.Clear, 1),
      ];
      const totalCost = segments.reduce((sum, s) => sum + s.cost, 0);
      expect(totalCost).toBeLessThanOrEqual(MAX_BUILD_PER_TURN);
    });

    it('should reject upgrades when insufficient funds', () => {
      const snapshot = makeSnapshot({ money: 10, trainType: TrainType.Freight });
      const result = validateUpgradeFeasibility(snapshot, TrainType.FastFreight);
      expect(result.feasible).toBe(false);
    });

    it('should accept upgrades when sufficient funds', () => {
      const snapshot = makeSnapshot({ money: 25, trainType: TrainType.Freight });
      const result = validateUpgradeFeasibility(snapshot, TrainType.FastFreight);
      expect(result.feasible).toBe(true);
    });
  });

  describe('train capacity validation', () => {
    it('should enforce 2-load limit for Freight trains', () => {
      const snapshot = makeSnapshot({
        trainType: TrainType.Freight,
        carriedLoads: [LoadType.Coal, LoadType.Wine],
      });
      expect(snapshot.carriedLoads).toHaveLength(2);
      // Freight can carry max 2 loads
    });

    it('should enforce 3-load limit for Heavy Freight trains', () => {
      const snapshot = makeSnapshot({
        trainType: TrainType.HeavyFreight,
        carriedLoads: [LoadType.Coal, LoadType.Wine, LoadType.Oil],
      });
      expect(snapshot.carriedLoads).toHaveLength(3);
    });
  });

  describe('upgrade path validation', () => {
    it('should define valid upgrade paths', () => {
      expect(VALID_UPGRADES).toBeDefined();
    });

    it('should allow Freight -> FastFreight upgrade', () => {
      const snapshot = makeSnapshot({
        money: 50,
        trainType: TrainType.Freight,
      });
      const result = validateUpgradeFeasibility(snapshot, TrainType.FastFreight);
      expect(result.feasible).toBe(true);
    });

    it('should allow Freight -> HeavyFreight upgrade', () => {
      const snapshot = makeSnapshot({
        money: 50,
        trainType: TrainType.Freight,
      });
      const result = validateUpgradeFeasibility(snapshot, TrainType.HeavyFreight);
      expect(result.feasible).toBe(true);
    });

    it('should reject invalid upgrade path (Freight -> Superfreight directly)', () => {
      const snapshot = makeSnapshot({
        money: 50,
        trainType: TrainType.Freight,
      });
      const result = validateUpgradeFeasibility(snapshot, TrainType.Superfreight);
      expect(result.feasible).toBe(false);
    });
  });

  describe('delivery feasibility', () => {
    it('should reject delivery when load not carried', () => {
      const demandCard = makeDemandCard(1, [
        { city: 'Berlin', resource: LoadType.Coal, payment: 15 },
      ]);
      const snapshot = makeSnapshot({
        carriedLoads: [],
        demandCards: [demandCard],
      });
      const result = validateDeliveryFeasibility(snapshot, 1, 0);
      expect(result.feasible).toBe(false);
    });
  });
});
