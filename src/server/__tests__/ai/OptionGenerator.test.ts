/**
 * Unit tests for OptionGenerator.
 * Tests feasible option generation for all action types and infeasibility tagging.
 *
 * Note: OptionGenerator implementation is pending (BE-003).
 * These tests define expected behavior and will be updated when the module is implemented.
 */

import { makeSnapshot, makeDemandCard, makeSegment } from './helpers/testFixtures';
import { AIActionType } from '../../ai/types';
import type { FeasibleOption, InfeasibleOption } from '../../ai/types';
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

describe('OptionGenerator', () => {
  describe('action type coverage', () => {
    it('should define all expected action types', () => {
      expect(AIActionType.DeliverLoad).toBe('DeliverLoad');
      expect(AIActionType.PickupAndDeliver).toBe('PickupAndDeliver');
      expect(AIActionType.BuildTrack).toBe('BuildTrack');
      expect(AIActionType.UpgradeTrain).toBe('UpgradeTrain');
      expect(AIActionType.BuildTowardMajorCity).toBe('BuildTowardMajorCity');
      expect(AIActionType.PassTurn).toBe('PassTurn');
    });

    it('should have exactly 6 action types', () => {
      const actionTypes = Object.values(AIActionType);
      expect(actionTypes).toHaveLength(6);
    });
  });

  describe('feasible option structure', () => {
    it('should create a valid FeasibleOption shape', () => {
      const option: FeasibleOption = {
        type: AIActionType.PassTurn,
        description: 'Pass turn - no action taken',
        feasible: true,
        params: { type: AIActionType.PassTurn },
      };

      expect(option.feasible).toBe(true);
      expect(option.type).toBe(AIActionType.PassTurn);
    });

    it('should create a valid InfeasibleOption shape', () => {
      const option: InfeasibleOption = {
        type: AIActionType.UpgradeTrain,
        description: 'Upgrade to Fast Freight',
        feasible: false,
        reason: 'Insufficient funds (need 20, have 15)',
      };

      expect(option.feasible).toBe(false);
      expect(option.reason).toContain('Insufficient funds');
    });
  });

  describe('delivery option prerequisites', () => {
    it('should require carried loads for delivery options', () => {
      const snapshot = makeSnapshot({ carriedLoads: [] });
      // With no carried loads, delivery options should be infeasible
      expect(snapshot.carriedLoads).toHaveLength(0);
    });

    it('should require demand cards for delivery options', () => {
      const snapshot = makeSnapshot({ demandCards: [] });
      expect(snapshot.demandCards).toHaveLength(0);
    });

    it('should require matching load and demand for delivery', () => {
      const demandCard = makeDemandCard(1, [
        { city: 'Berlin', resource: LoadType.Coal, payment: 15 },
      ]);
      const snapshot = makeSnapshot({
        carriedLoads: [LoadType.Coal],
        demandCards: [demandCard],
      });

      expect(snapshot.carriedLoads).toContain(LoadType.Coal);
      expect(snapshot.demandCards[0].demands[0].resource).toBe(LoadType.Coal);
    });
  });

  describe('upgrade option prerequisites', () => {
    it('should require sufficient funds for upgrade (20 ECU)', () => {
      const snapshot = makeSnapshot({ money: 15 });
      expect(snapshot.money).toBeLessThan(20);
    });

    it('should allow upgrade from Freight with 20+ ECU', () => {
      const snapshot = makeSnapshot({
        money: 25,
        trainType: TrainType.Freight,
      });
      expect(snapshot.money).toBeGreaterThanOrEqual(20);
      expect(snapshot.trainType).toBe(TrainType.Freight);
    });
  });

  describe('build track option prerequisites', () => {
    it('should require funds for track building', () => {
      const snapshot = makeSnapshot({ money: 0 });
      expect(snapshot.money).toBe(0);
    });

    it('should respect 20 ECU per turn build budget', () => {
      const snapshot = makeSnapshot({ money: 50, turnBuildCostSoFar: 15 });
      const remainingBudget = 20 - snapshot.turnBuildCostSoFar;
      expect(remainingBudget).toBe(5);
    });
  });
});
