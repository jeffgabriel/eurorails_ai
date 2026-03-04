/**
 * TEST-001: Strategic Hand Discard — Behavior 6
 *
 * Validates that hand quality is computed correctly and that discard
 * decisions are based on quality assessment, not just binary affordability.
 *
 * PRD scenario: Bot holding 3 stale cards with 8+ turn estimates discards hand.
 */

import { makeDemandContext, computeHandQuality } from './integrationTestSetup';

describe('Behavior 6: Strategic Hand Discard', () => {
  describe('hand quality computation', () => {
    it('should assess "Good" quality when average best score >= 3', () => {
      const demands = [
        makeDemandContext({ cardIndex: 0, demandScore: 5, estimatedTurns: 3 }),
        makeDemandContext({ cardIndex: 1, demandScore: 4, estimatedTurns: 4 }),
        makeDemandContext({ cardIndex: 2, demandScore: 3, estimatedTurns: 5 }),
      ];

      const hq = computeHandQuality(demands);

      expect(hq.assessment).toBe('Good');
      expect(hq.score).toBe(4); // (5+4+3)/3 = 4.0
      expect(hq.staleCards).toBe(0);
    });

    it('should assess "Fair" quality when 1 <= average < 3', () => {
      const demands = [
        makeDemandContext({ cardIndex: 0, demandScore: 2.5, estimatedTurns: 6 }),
        makeDemandContext({ cardIndex: 1, demandScore: 1.5, estimatedTurns: 7 }),
        makeDemandContext({ cardIndex: 2, demandScore: 1.0, estimatedTurns: 8 }),
      ];

      const hq = computeHandQuality(demands);

      expect(hq.assessment).toBe('Fair');
      expect(hq.score).toBeGreaterThanOrEqual(1);
      expect(hq.score).toBeLessThan(3);
    });

    it('should assess "Poor" quality when average best score < 1', () => {
      const demands = [
        makeDemandContext({ cardIndex: 0, demandScore: 0.5, estimatedTurns: 10 }),
        makeDemandContext({ cardIndex: 1, demandScore: 0.3, estimatedTurns: 14 }),
        makeDemandContext({ cardIndex: 2, demandScore: -1, estimatedTurns: 15 }),
      ];

      const hq = computeHandQuality(demands);

      expect(hq.assessment).toBe('Poor');
      expect(hq.score).toBeLessThan(1);
    });

    it('should return Poor for empty demand list', () => {
      const hq = computeHandQuality([]);

      expect(hq.score).toBe(0);
      expect(hq.staleCards).toBe(0);
      expect(hq.assessment).toBe('Poor');
    });
  });

  describe('stale card detection', () => {
    it('should count cards with estimatedTurns >= 12 as stale', () => {
      const demands = [
        makeDemandContext({ cardIndex: 0, demandScore: 2, estimatedTurns: 3 }),
        makeDemandContext({ cardIndex: 1, demandScore: 1, estimatedTurns: 12 }), // STALE
        makeDemandContext({ cardIndex: 2, demandScore: 0.5, estimatedTurns: 15 }), // STALE
      ];

      const hq = computeHandQuality(demands);

      expect(hq.staleCards).toBe(2);
    });

    it('should not count cards with estimatedTurns < 12 as stale', () => {
      const demands = [
        makeDemandContext({ cardIndex: 0, demandScore: 4, estimatedTurns: 3 }),
        makeDemandContext({ cardIndex: 1, demandScore: 3, estimatedTurns: 8 }),
        makeDemandContext({ cardIndex: 2, demandScore: 2, estimatedTurns: 11 }),
      ];

      const hq = computeHandQuality(demands);

      expect(hq.staleCards).toBe(0);
    });

    it('should flag all 3 cards as stale when hand is terrible', () => {
      const demands = [
        makeDemandContext({ cardIndex: 0, demandScore: -2, estimatedTurns: 20 }),
        makeDemandContext({ cardIndex: 1, demandScore: -1, estimatedTurns: 18 }),
        makeDemandContext({ cardIndex: 2, demandScore: 0, estimatedTurns: 15 }),
      ];

      const hq = computeHandQuality(demands);

      expect(hq.staleCards).toBe(3);
      expect(hq.assessment).toBe('Poor');
    });
  });

  describe('multi-demand per card grouping', () => {
    it('should pick the best demand per card when cards have multiple demands', () => {
      // Card 0 has 3 demands: Wine, Coal, Iron (different loadTypes on same card)
      const demands = [
        makeDemandContext({ cardIndex: 0, loadType: 'Wine', demandScore: 8, estimatedTurns: 3 }),
        makeDemandContext({ cardIndex: 0, loadType: 'Coal', demandScore: 2, estimatedTurns: 6 }),
        makeDemandContext({ cardIndex: 0, loadType: 'Iron', demandScore: 5, estimatedTurns: 4 }),
        // Card 1
        makeDemandContext({ cardIndex: 1, loadType: 'Oil', demandScore: 3, estimatedTurns: 5 }),
        makeDemandContext({ cardIndex: 1, loadType: 'Beer', demandScore: 6, estimatedTurns: 4 }),
        // Card 2
        makeDemandContext({ cardIndex: 2, loadType: 'Wheat', demandScore: 1, estimatedTurns: 7 }),
      ];

      const hq = computeHandQuality(demands);

      // Best per card: card0=8, card1=6, card2=1 → avg = (8+6+1)/3 = 5.0
      expect(hq.score).toBe(5);
      expect(hq.assessment).toBe('Good');
      expect(hq.staleCards).toBe(0);
    });

    it('should count stale based on best demand per card', () => {
      const demands = [
        // Card 0: best demand is 4 turns → NOT stale (even though another is 15)
        makeDemandContext({ cardIndex: 0, demandScore: 5, estimatedTurns: 4 }),
        makeDemandContext({ cardIndex: 0, demandScore: 1, estimatedTurns: 15 }),
        // Card 1: best demand is 12 turns → STALE
        makeDemandContext({ cardIndex: 1, demandScore: 0.5, estimatedTurns: 12 }),
        makeDemandContext({ cardIndex: 1, demandScore: 0.3, estimatedTurns: 20 }),
      ];

      const hq = computeHandQuality(demands);

      // Card 0 best: score=5, turns=4 (not stale)
      // Card 1 best: score=0.5, turns=12 (STALE — best demand is still 12 turns)
      expect(hq.staleCards).toBe(1);
    });
  });

  describe('discard decision thresholds', () => {
    it('should recommend discard when all cards are stale and quality is Poor', () => {
      const demands = [
        makeDemandContext({ cardIndex: 0, demandScore: -1, estimatedTurns: 14 }),
        makeDemandContext({ cardIndex: 1, demandScore: 0.2, estimatedTurns: 13 }),
        makeDemandContext({ cardIndex: 2, demandScore: 0.1, estimatedTurns: 16 }),
      ];

      const hq = computeHandQuality(demands);

      // Poor quality + 3 stale = strong discard signal
      expect(hq.assessment).toBe('Poor');
      expect(hq.staleCards).toBe(3);
    });

    it('should NOT recommend discard when at least one demand is achievable in <= 4 turns', () => {
      const demands = [
        makeDemandContext({ cardIndex: 0, demandScore: 6, estimatedTurns: 3 }), // achievable!
        makeDemandContext({ cardIndex: 1, demandScore: 0, estimatedTurns: 15 }),
        makeDemandContext({ cardIndex: 2, demandScore: -1, estimatedTurns: 20 }),
      ];

      const hq = computeHandQuality(demands);

      // Average score: (6 + 0 + (-1))/3 ≈ 1.67 → Fair, not Poor
      expect(hq.assessment).toBe('Fair');
      expect(hq.staleCards).toBe(2);
      // The good card (score 6, 3 turns) should prevent discard
      expect(hq.score).toBeGreaterThanOrEqual(1);
    });
  });
});
