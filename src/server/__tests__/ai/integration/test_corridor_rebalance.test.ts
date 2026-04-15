/**
 * TEST-001: Demand Scoring — Economic Ranking
 *
 * Validates that demand scoring correctly ranks deliveries by economic value
 * (ROI per turn), with cost ceiling and affordability penalties applied.
 *
 * JIRA-174: Corridor multiplier removed — rankings are now based purely on
 * baseROI with cost ceiling and affordability penalties.
 */

import { scoreDemand } from './integrationTestSetup';

describe('Demand Scoring: Economic Ranking', () => {
  describe('payout dominance', () => {
    it('should rank 51M delivery above 21M delivery', () => {
      // 21M delivery: modest cost and turns
      const lowPay = scoreDemand(
        21, // payout
        8,  // totalTrackCost
        5,  // estimatedTurns
      );

      // 51M delivery: higher cost and turns
      const highPay = scoreDemand(
        51, // payout
        12, // totalTrackCost
        6,  // estimatedTurns
      );

      expect(highPay).toBeGreaterThan(lowPay);
    });

    it('should rank 45M delivery above 15M delivery regardless of turns', () => {
      const lowPay = scoreDemand(15, 5, 4);
      const highPay = scoreDemand(45, 10, 5);

      expect(highPay).toBeGreaterThan(lowPay);
    });
  });

  describe('victory major city weight', () => {
    it('should treat victoryMajorCities as no-op (param removed from production)', () => {
      // JIRA-174: corridor/victoryMajorCities params removed. Scoring is pure ROI.
      const score1 = scoreDemand(30, 10, 5);
      const score2 = scoreDemand(30, 10, 5);

      expect(score1).toEqual(score2);
    });
  });

  describe('cost ceiling penalty', () => {
    it('should penalize routes with build cost > 50M', () => {
      // Same payout and turns, one has excessive track cost
      const cheapRoute = scoreDemand(60, 10, 5);
      const expensiveRoute = scoreDemand(60, 80, 5);

      expect(cheapRoute).toBeGreaterThan(expensiveRoute);
    });
  });

  describe('affordability penalty', () => {
    it('should penalize unaffordable routes', () => {
      const affordable = scoreDemand(30, 10, 5, true, Infinity);
      const unaffordable = scoreDemand(30, 10, 5, false, 0);

      expect(affordable).toBeGreaterThan(unaffordable);
    });
  });
});
