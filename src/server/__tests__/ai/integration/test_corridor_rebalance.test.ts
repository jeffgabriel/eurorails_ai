/**
 * TEST-001: Payout-Relative Corridor Scoring — Behavior 3
 *
 * Validates that corridor value is a multiplier on economic value rather
 * than a flat addition, ensuring high-payout deliveries aren't beaten
 * by low-payout deliveries with better geography.
 *
 * PRD scenario: 51M delivery beats 21M delivery despite fewer corridor cities.
 */

import { scoreDemand } from './integrationTestSetup';

describe('Behavior 3: Payout-Relative Corridor Scoring', () => {
  describe('payout dominance over corridor bonus', () => {
    it('should rank 51M delivery above 21M delivery despite fewer corridor cities', () => {
      // 21M delivery with great corridor: 7 cities, 2 victory majors
      const lowPayHighCorridor = scoreDemand(
        21, // payout
        8,  // totalTrackCost
        7,  // networkCities (great corridor)
        2,  // victoryMajorCities
        5,  // estimatedTurns
      );

      // 51M delivery with modest corridor: 4 cities, 1 victory major
      const highPayLowCorridor = scoreDemand(
        51, // payout
        12, // totalTrackCost
        4,  // networkCities (modest corridor)
        1,  // victoryMajorCities
        6,  // estimatedTurns
      );

      expect(highPayLowCorridor).toBeGreaterThan(lowPayHighCorridor);
    });

    it('should not let 3 extra corridor cities overcome a 30M payout advantage', () => {
      // Low payout, excellent corridor
      const lowPay = scoreDemand(15, 5, 8, 2, 4);
      // High payout, modest corridor
      const highPay = scoreDemand(45, 10, 5, 1, 5);

      expect(highPay).toBeGreaterThan(lowPay);
    });

    it('should ensure corridor multiplier is capped at 0.5', () => {
      // 10+ corridor cities should still cap the multiplier at 0.5
      const maxCorridor = scoreDemand(30, 10, 15, 0, 5); // 15 cities
      const cappedCorridor = scoreDemand(30, 10, 10, 0, 5); // 10 cities

      // Both should be capped at 0.5 multiplier
      expect(maxCorridor).toBe(cappedCorridor);
    });
  });

  describe('corridor value as multiplier', () => {
    it('should amplify high-payout deliveries more than low-payout ones', () => {
      // Same corridor (5 cities, 1 victory major), different payouts
      const lowPay = scoreDemand(15, 5, 5, 1, 4);
      const highPay = scoreDemand(40, 10, 5, 1, 5);

      // The corridor bonus should be proportionally larger for high payout
      const lowPayNoCorridor = scoreDemand(15, 5, 0, 0, 4);
      const highPayNoCorridor = scoreDemand(40, 10, 0, 0, 5);

      const lowPayCorridorBonus = lowPay - lowPayNoCorridor;
      const highPayCorridorBonus = highPay - highPayNoCorridor;

      // Victory bonus is added separately, isolate corridor multiplier effect
      const lowPayNoVictory = scoreDemand(15, 5, 5, 0, 4);
      const highPayNoVictory = scoreDemand(40, 10, 5, 0, 5);
      const lowPayBase = scoreDemand(15, 5, 0, 0, 4);
      const highPayBase = scoreDemand(40, 10, 0, 0, 5);

      const lowCorridorEffect = lowPayNoVictory - lowPayBase;
      const highCorridorEffect = highPayNoVictory - highPayBase;

      // Corridor effect should be larger for higher payout (it's a multiplier on ROI)
      expect(highCorridorEffect).toBeGreaterThan(lowCorridorEffect);
    });

    it('should correctly compute corridor multiplier as min(cities * 0.05, 0.5)', () => {
      const baseScore = scoreDemand(20, 5, 0, 0, 5); // baseROI = 3.0
      const with4Cities = scoreDemand(20, 5, 4, 0, 5); // multiplier = 0.20

      // corridorMultiplier = min(4 * 0.05, 0.5) = 0.20
      // score = baseROI + 0.20 * baseROI = 3.0 + 0.6 = 3.6
      const expectedMultiplied = baseScore * 1.20;

      expect(with4Cities).toBeCloseTo(expectedMultiplied, 2);
    });
  });

  describe('victory major city weight', () => {
    it('should give victory major cities significant weight', () => {
      const noVictory = scoreDemand(30, 10, 5, 0, 5);
      const oneVictory = scoreDemand(30, 10, 5, 1, 5);
      const twoVictory = scoreDemand(30, 10, 5, 2, 5);

      expect(oneVictory).toBeGreaterThan(noVictory);
      expect(twoVictory).toBeGreaterThan(oneVictory);

      // Victory bonus = victoryMajorCities * max(payout * 0.15, 5)
      // For 30M payout: bonus per city = max(30 * 0.15, 5) = max(4.5, 5) = 5
      const victoryBonusPerCity = 5;
      expect(oneVictory - noVictory).toBeCloseTo(victoryBonusPerCity, 1);
    });

    it('should scale victory bonus with payout for high-value deliveries', () => {
      // For 50M payout: bonus = max(50 * 0.15, 5) = 7.5
      const noVictoryHigh = scoreDemand(50, 10, 3, 0, 5);
      const oneVictoryHigh = scoreDemand(50, 10, 3, 1, 5);

      // For 20M payout: bonus = max(20 * 0.15, 5) = max(3, 5) = 5
      const noVictoryLow = scoreDemand(20, 5, 3, 0, 4);
      const oneVictoryLow = scoreDemand(20, 5, 3, 1, 4);

      const highPayVictoryBonus = oneVictoryHigh - noVictoryHigh;
      const lowPayVictoryBonus = oneVictoryLow - noVictoryLow;

      // High-payout victory bonus should be larger (7.5 vs 5)
      expect(highPayVictoryBonus).toBeGreaterThan(lowPayVictoryBonus);
    });

    it('should use minimum victory bonus of 5 for low-payout demands', () => {
      // For 10M payout: bonus = max(10 * 0.15, 5) = max(1.5, 5) = 5
      const noVictory = scoreDemand(10, 3, 2, 0, 3);
      const oneVictory = scoreDemand(10, 3, 2, 1, 3);

      expect(oneVictory - noVictory).toBeCloseTo(5, 1);
    });
  });

  describe('differentiating equally-priced demands', () => {
    it('should use corridor to differentiate same-payout demands', () => {
      // Two demands with identical payout and cost, different corridors
      const poorCorridor = scoreDemand(25, 8, 2, 0, 5);
      const richCorridor = scoreDemand(25, 8, 6, 0, 5);

      expect(richCorridor).toBeGreaterThan(poorCorridor);
    });

    it('should prefer routes with victory progress when all else is equal', () => {
      const noVictory = scoreDemand(25, 8, 5, 0, 5);
      const withVictory = scoreDemand(25, 8, 5, 1, 5);

      expect(withVictory).toBeGreaterThan(noVictory);
    });
  });
});
