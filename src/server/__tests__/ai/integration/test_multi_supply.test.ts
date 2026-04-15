/**
 * TEST-001: Multi-Supply-City Evaluation — Behavior 2
 *
 * Validates that when multiple supply cities exist for a demand,
 * the one producing the highest demand score is selected — not the
 * one closest to existing track.
 *
 * PRD scenario: The supply city with better ROI (lower cost, higher payout,
 * fewer turns) wins. JIRA-174: Corridor multiplier removed — scoring is
 * pure baseROI with cost ceiling and affordability penalties.
 */

import { makeDemandContext, scoreDemand } from './integrationTestSetup';

describe('Behavior 2: Multi-Supply-City Evaluation', () => {
  describe('supply city selection by demand score', () => {
    it('should prefer a supply city with better ROI', () => {
      // Manchester: closer, lower cost → better ROI
      // ROI = (25-4)/4 = 5.25
      const manchesterScore = scoreDemand(
        25, // payout
        4,  // totalTrackCost (cheap — close to network)
        4,  // estimatedTurns
      );

      // Stuttgart: higher cost, same turns → lower ROI
      // ROI = (25-10)/4 = 3.75
      const stuttgartScore = scoreDemand(
        25, // same payout
        10, // totalTrackCost (more expensive)
        4,  // estimatedTurns
      );

      // Manchester wins due to lower build cost (higher ROI)
      expect(manchesterScore).toBeGreaterThan(stuttgartScore);
    });

    it('should select the supply city that maximizes demand score from multiple options', () => {
      // Simulate computeBestDemandContext: evaluate each supply city.
      // Winner is the city with highest ROI = (payout - cost) / turns
      // Manchester: ROI=(25-4)/4 = 5.25  <- wins (lowest cost, good turns)
      // Stuttgart: ROI=(25-5)/4 = 5.0
      // Milano: ROI=(25-8)/5 = 3.4
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

    it('should rank by ROI when costs differ significantly', () => {
      // Expensive but fast vs cheap but slow
      // Expensive: ROI = (30-15)/6 = 2.5
      const expensiveButFast = scoreDemand(30, 15, 6);
      // Cheap slow: ROI = (30-3)/8 = 3.375 — better ROI
      const cheapSlow = scoreDemand(30, 3, 8);

      // Cheap slow wins due to better ROI
      expect(cheapSlow).toBeGreaterThan(expensiveButFast);
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

  describe('negative-ROI scoring', () => {
    it('negative ROI scores are negative', () => {
      // Negative baseROI: build cost > payout
      const score = scoreDemand(10, 20, 5);
      const baseROI = (10 - 20) / 5; // -2.0
      expect(score).toBeCloseTo(baseROI, 5);
      expect(score).toBeLessThan(0);
    });

    it('lower build cost wins when both routes have negative ROI', () => {
      // Both negative, but less-negative (less costly) wins
      // route1: ROI = (12-30)/8 = -2.25
      const route1Score = scoreDemand(12, 30, 8);
      // route2: ROI = (12-20)/8 = -1.0 (less negative)
      const route2Score = scoreDemand(12, 20, 8);

      // route2 wins (less negative score)
      expect(route2Score).toBeGreaterThan(route1Score);
    });

    it('negative ROI with zero build cost returns payout/turns', () => {
      // zero build cost: ROI = payout/turns (always positive if payout > 0)
      const score = scoreDemand(5, 0, 3);
      const baseROI = 5 / 3;
      expect(score).toBeCloseTo(baseROI, 5);
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
      // Score should differ only due to different build costs in baseROI
      const routeAt30M = scoreDemand(60, 30, 5);
      const routeAt49M = scoreDemand(60, 49, 5);
      const expectedAt30M = (60 - 30) / 5; // 6.0 — no penalty
      const expectedAt49M = (60 - 49) / 5; // 2.2 — no penalty

      expect(routeAt30M).toBeCloseTo(expectedAt30M, 5);
      expect(routeAt49M).toBeCloseTo(expectedAt49M, 5);
    });
  });
});
