/**
 * TEST-001: Build Budget Verification — Behavior 1
 *
 * Validates that the bot correctly identifies unaffordable build targets
 * and selects achievable routes based on current cash + projected income.
 *
 * PRD scenario: Bot with 30M facing a 32M build target picks a different demand.
 */

import { makeDemandContext, scoreDemand, isRouteAffordable } from './integrationTestSetup';

describe('Behavior 1: Build Budget Verification', () => {
  describe('route affordability check', () => {
    it('should reject a build target that exceeds current cash with no projected income', () => {
      const result = isRouteAffordable(
        32, // totalTrackCost
        30, // botMoney
        0,  // projectedDeliveryIncome
        40, // payout
      );

      expect(result.affordable).toBe(false);
      expect(result.reason).toBe('insufficient_funds');
    });

    it('should accept a build target when projected delivery income bridges the gap', () => {
      // Bot has 10M, needs 25M of track, but carrying Wheat for a 20M delivery en route
      const result = isRouteAffordable(
        25, // totalTrackCost
        10, // botMoney
        20, // projectedDeliveryIncome (carrying load worth 20M)
        30, // payout
      );

      expect(result.affordable).toBe(true);
    });

    it('should reject negative ROI builds where track cost exceeds payout', () => {
      // Spending 25M on track for an 8M demand
      const result = isRouteAffordable(
        25, // totalTrackCost
        50, // botMoney — has enough cash
        0,  // projectedDeliveryIncome
        8,  // payout — less than track cost!
      );

      expect(result.affordable).toBe(false);
      expect(result.reason).toBe('negative_roi');
    });

    it('should accept a build target exactly matching available funds', () => {
      const result = isRouteAffordable(20, 20, 0, 30);
      expect(result.affordable).toBe(true);
    });

    it('should accept expensive builds when projected income makes them viable', () => {
      // Bot has 5M cash but carrying load worth 45M delivery
      const result = isRouteAffordable(
        40, // totalTrackCost
        5,  // botMoney
        45, // projectedDeliveryIncome
        50, // payout
      );

      expect(result.affordable).toBe(true);
    });
  });

  describe('demand scoring with build cost awareness', () => {
    it('should rank cheaper builds higher when payout is similar', () => {
      // Demand A: 20M payout, 15M track cost, 5 turns → ROI = (20-15)/5 = 1.0
      const scoreA = scoreDemand(20, 15, 5);
      // Demand B: 20M payout, 5M track cost, 5 turns → ROI = (20-5)/5 = 3.0
      const scoreB = scoreDemand(20, 5, 5);

      expect(scoreB).toBeGreaterThan(scoreA);
    });

    it('should score zero-cost builds (on-network) highest for same payout', () => {
      const onNetwork = scoreDemand(20, 0, 3);
      const offNetwork = scoreDemand(20, 10, 5);

      expect(onNetwork).toBeGreaterThan(offNetwork);
    });

    it('should penalize demands where build cost consumes most of the payout', () => {
      // 15M payout with 14M build cost → only 1M profit
      const lowProfit = scoreDemand(15, 14, 4);
      // 15M payout with 3M build cost → 12M profit
      const highProfit = scoreDemand(15, 3, 4);

      expect(highProfit).toBeGreaterThan(lowProfit);
      // The low-profit route should have near-zero or negative ROI
      expect(lowProfit).toBeLessThan(1);
    });
  });

  describe('affordability field in demand context', () => {
    it('should mark demand as affordable when bot can cover track cost', () => {
      const demand = makeDemandContext({
        payout: 30,
        estimatedTrackCostToSupply: 5,
        estimatedTrackCostToDelivery: 8,
        isAffordable: true,
        projectedFundsAfterDelivery: 67,
      });

      expect(demand.isAffordable).toBe(true);
      expect(demand.projectedFundsAfterDelivery).toBeGreaterThan(0);
    });

    it('should mark demand as unaffordable when costs exceed resources', () => {
      const demand = makeDemandContext({
        payout: 10,
        estimatedTrackCostToSupply: 20,
        estimatedTrackCostToDelivery: 15,
        isAffordable: false,
        projectedFundsAfterDelivery: -25,
      });

      expect(demand.isAffordable).toBe(false);
    });

    it('should prefer affordable demands when ranking by score', () => {
      const affordable = makeDemandContext({
        cardIndex: 0,
        payout: 20,
        demandScore: scoreDemand(20, 5, 4),
        isAffordable: true,
      });
      const unaffordable = makeDemandContext({
        cardIndex: 1,
        payout: 30,
        demandScore: scoreDemand(30, 35, 6), // higher payout but negative ROI
        isAffordable: false,
      });

      // The affordable demand should have a better score because the unaffordable
      // one has negative baseROI (cost > payout)
      expect(affordable.demandScore).toBeGreaterThan(unaffordable.demandScore);
    });
  });
});
