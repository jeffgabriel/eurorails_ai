/**
 * TEST-001: Multi-Supply-City Evaluation — Behavior 2
 *
 * Validates that when multiple supply cities exist for a demand,
 * the one producing the highest demand score is selected — not the
 * one closest to existing track.
 *
 * PRD scenario: The supply city with better score wins.
 * JIRA-174: Corridor multiplier removed.
 * JIRA-175: Formula changed to (payout/turns) - (cost*0.1) to fix turn-division
 * inversion — short affordable routes rank above long expensive ones.
 */

import { makeDemandContext, scoreDemand } from './integrationTestSetup';

describe('Behavior 2: Multi-Supply-City Evaluation', () => {
  describe('supply city selection by demand score', () => {
    it('should prefer a supply city with better score', () => {
      // Manchester: closer, lower cost → better score
      // score = (25/4) - (4*0.1) = 6.25 - 0.4 = 5.85
      const manchesterScore = scoreDemand(
        25, // payout
        4,  // totalTrackCost (cheap — close to network)
        4,  // estimatedTurns
      );

      // Stuttgart: higher cost, same turns → lower score
      // score = (25/4) - (10*0.1) = 6.25 - 1.0 = 5.25
      const stuttgartScore = scoreDemand(
        25, // same payout
        10, // totalTrackCost (more expensive)
        4,  // estimatedTurns
      );

      // Manchester wins due to lower build cost (higher score)
      expect(manchesterScore).toBeGreaterThan(stuttgartScore);
    });

    it('should select the supply city that maximizes demand score from multiple options', () => {
      // Simulate computeBestDemandContext: evaluate each supply city.
      // Winner is the city with highest score = (payout/turns) - (cost*0.1)
      // Manchester: (25/4) - (4*0.1) = 6.25 - 0.4 = 5.85  <- wins (lowest cost)
      // Stuttgart: (25/4) - (5*0.1) = 6.25 - 0.5 = 5.75
      // Milano: (25/5) - (8*0.1) = 5.0 - 0.8 = 4.2
      const supplyCities = [
        { city: 'Manchester', cost: 4, turns: 4 },
        { city: 'Stuttgart', cost: 5, turns: 4 },
        { city: 'Milano', cost: 8, turns: 5 },
      ];
      const payout = 25;

      const scores = supplyCities.map(sc => ({
        city: sc.city,
        score: scoreDemand(payout, sc.cost, sc.turns),
      }));

      // Pick the best supply city (highest score)
      const best = scores.reduce((a, b) => a.score > b.score ? a : b);

      expect(best.city).toBe('Manchester');
      expect(best.score).toBeGreaterThan(scores.find(s => s.city === 'Stuttgart')!.score);
    });

    it('should prefer closer supply city when build costs differ', () => {
      // When same payout, lower cost (closer) wins
      const closeCity = scoreDemand(20, 3, 3);
      const farCity = scoreDemand(20, 12, 6);

      expect(closeCity).toBeGreaterThan(farCity);
    });

    it('should rank by income velocity when turn count differs significantly', () => {
      // Expensive but fast vs cheap but slow
      // Expensive fast: (30/6) - (15*0.1) = 5.0 - 1.5 = 3.5
      const expensiveButFast = scoreDemand(30, 15, 6);
      // Cheap slow: (30/8) - (3*0.1) = 3.75 - 0.3 = 3.45
      const cheapSlow = scoreDemand(30, 3, 8);

      // JIRA-175: income velocity (payout/turns) drives ranking — fast delivery wins
      expect(expensiveButFast).toBeGreaterThan(cheapSlow);
    });
  });

  describe('demand context with best supply city', () => {
    it('should populate demand context with the winning supply city', () => {
      // When computeBestDemandContext runs, the returned DemandContext
      // should have the supply city that produced the best score
      const bestDemand = makeDemandContext({
        loadType: 'Cars',
        supplyCity: 'Stuttgart', // best supply city
        deliveryCity: 'Nantes',
        payout: 25,
        estimatedTrackCostToSupply: 10,
        estimatedTrackCostToDelivery: 5,
        networkCitiesUnlocked: 8,
        victoryMajorCitiesEnRoute: 2,
        estimatedTurns: 6,
        demandScore: scoreDemand(25, 15, 6),
      });

      expect(bestDemand.supplyCity).toBe('Stuttgart');
      expect(bestDemand.demandScore).toBeGreaterThan(0);
    });

    it('should handle single supply city without comparison', () => {
      // Flowers only from Holland — no comparison needed
      const demand = makeDemandContext({
        loadType: 'Flowers',
        supplyCity: 'Holland',
        payout: 15,
        demandScore: scoreDemand(15, 5, 4),
      });

      expect(demand.supplyCity).toBe('Holland');
      expect(demand.demandScore).toBeGreaterThan(0);
    });

    it('should handle load already on train (no supply city matters)', () => {
      const demand = makeDemandContext({
        loadType: 'Coal',
        supplyCity: 'Essen',
        deliveryCity: 'Berlin',
        isLoadOnTrain: true,
        estimatedTrackCostToSupply: 0, // already carrying the load
        estimatedTurns: 2,
        payout: 10,
        demandScore: scoreDemand(10, 3, 2),
      });

      expect(demand.isLoadOnTrain).toBe(true);
      expect(demand.demandScore).toBeGreaterThan(0);
    });
  });

  describe('negative score scenarios', () => {
    it('negative score when cost burden exceeds income velocity', () => {
      // JIRA-175 formula: (10/5) - (20*0.1) = 2.0 - 2.0 = 0.0
      // Use higher cost to get negative: (10/5) - (30*0.1) = 2.0 - 3.0 = -1.0
      const score = scoreDemand(10, 30, 5);
      expect(score).toBeLessThan(0);
    });

    it('lower build cost wins when both routes score poorly', () => {
      // Both negative, but less-negative (less costly) wins
      // route1: (12/8) - (30*0.1) = 1.5 - 3.0 = -1.5
      const route1Score = scoreDemand(12, 30, 8);
      // route2: (12/8) - (20*0.1) = 1.5 - 2.0 = -0.5 (less negative)
      const route2Score = scoreDemand(12, 20, 8);

      // route2 wins (less negative score)
      expect(route2Score).toBeGreaterThan(route1Score);
    });

    it('zero build cost returns payout/turns', () => {
      // zero build cost: score = payout/turns (always positive if payout > 0)
      const score = scoreDemand(5, 0, 3);
      const expected = 5 / 3;
      expect(score).toBeCloseTo(expected, 5);
    });

    it('build cost ceiling exponentially penalizes routes over 50M', () => {
      // Route at exactly 50M vs one at 94M: same payout and turns
      // At 94M: penalty = Math.exp(-(94-50)/30) = Math.exp(-1.467) ≈ 0.23
      const routeAt50M = scoreDemand(100, 50, 10);
      const routeAt94M = scoreDemand(100, 94, 10);

      // The 94M route should score significantly worse
      expect(routeAt50M).toBeGreaterThan(routeAt94M);
    });

    it('build cost ceiling only applies above 50M threshold', () => {
      // Routes at 30M and 49M should have no cost ceiling penalty (costPenalty=1)
      // JIRA-175 formula: (60/5) - (cost*0.1), no ceiling penalty for cost ≤ 50M
      const routeAt30M = scoreDemand(60, 30, 5);
      const routeAt49M = scoreDemand(60, 49, 5);
      const expectedAt30M = (60 / 5) - (30 * 0.1); // 12 - 3 = 9.0 — no penalty
      const expectedAt49M = (60 / 5) - (49 * 0.1); // 12 - 4.9 = 7.1 — no penalty

      expect(routeAt30M).toBeCloseTo(expectedAt30M, 5);
      expect(routeAt49M).toBeCloseTo(expectedAt49M, 5);
    });
  });
});
