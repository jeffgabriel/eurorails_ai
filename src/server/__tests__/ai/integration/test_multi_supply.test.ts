/**
 * TEST-001: Multi-Supply-City Evaluation — Behavior 2
 *
 * Validates that when multiple supply cities exist for a demand,
 * the one producing the highest demand score is selected — not the
 * one closest to existing track.
 *
 * PRD scenario: Cars demand scored with Stuttgart (score 45.8) beats
 * Manchester (score 25.6) despite being farther away.
 */

import { makeDemandContext, scoreDemand } from './integrationTestSetup';

describe('Behavior 2: Multi-Supply-City Evaluation', () => {
  describe('supply city selection by demand score', () => {
    it('should prefer a farther supply city with better corridor value', () => {
      // Manchester: closer, modest corridor.
      // ROI = (25-4)/4 = 5.25, corridorMult = min(4*0.05,0.5) = 0.2, score = 5.25*1.2 = 6.3
      const manchesterScore = scoreDemand(
        25, // payout
        4,  // totalTrackCost (cheap — close to network)
        4,  // networkCities (modest corridor: 4 cities)
        0,  // victoryMajorCities (no-op in current formula)
        4,  // estimatedTurns
      );

      // Stuttgart: same turns but higher corridor — corridor amplification wins.
      // ROI = (25-5)/4 = 5.0, corridorMult = min(8*0.05,0.5) = 0.4, score = 5.0*1.4 = 7.0
      const stuttgartScore = scoreDemand(
        25, // same payout
        5,  // totalTrackCost (slightly more, still positive ROI)
        8,  // networkCities (great corridor: 8 cities including Paris)
        0,  // victoryMajorCities (no-op)
        4,  // estimatedTurns
      );

      // Stuttgart's higher corridor value overcomes its slightly higher build cost
      expect(stuttgartScore).toBeGreaterThan(manchesterScore);
    });

    it('should select the supply city that maximizes demand score from multiple options', () => {
      // Simulate computeBestDemandContext: evaluate each supply city.
      // With the corridor formula (positive ROI amplified by corridorMultiplier),
      // a city with higher corridor value AND positive ROI wins over closer cheaper options.
      // Manchester: ROI=(25-4)/4=5.25, corridorMult=0.2, score=5.25*1.2=6.3
      // Stuttgart: ROI=(25-5)/4=5.0, corridorMult=0.4, score=5.0*1.4=7.0  <- wins (same turns, more corridor)
      // Milano: ROI=(25-8)/5=3.4, corridorMult=0.3, score=3.4*1.3=4.42
      const supplyCities = [
        { city: 'Manchester', cost: 4, corridor: 4, victory: 1, turns: 4 },
        { city: 'Stuttgart', cost: 5, corridor: 8, victory: 2, turns: 4 },
        { city: 'Milano', cost: 8, corridor: 6, victory: 1, turns: 5 },
      ];
      const payout = 25;

      const scores = supplyCities.map(sc => ({
        city: sc.city,
        score: scoreDemand(payout, sc.cost, sc.corridor, sc.victory, sc.turns),
      }));

      // Pick the best supply city (highest score)
      const best = scores.reduce((a, b) => a.score > b.score ? a : b);

      expect(best.city).toBe('Stuttgart');
      expect(best.score).toBeGreaterThan(scores.find(s => s.city === 'Manchester')!.score);
    });

    it('should prefer closer supply city when corridor values are identical', () => {
      // When corridor/victory are the same, cheaper build (closer) wins
      const closeCity = scoreDemand(20, 3, 3, 1, 3);
      const farCity = scoreDemand(20, 12, 3, 1, 6);

      expect(closeCity).toBeGreaterThan(farCity);
    });

    it('should evaluate supply city even when costly if corridor value is high', () => {
      // Moderately expensive but saturates corridor (10 cities = 0.5 max multiplier)
      // ROI = (30-15)/6 = 2.5, score = 2.5 * 1.5 = 3.75
      const expensiveButStrategic = scoreDemand(30, 15, 10, 0, 6);
      // Cheap but almost no corridor value
      // ROI = (30-3)/8 = 3.375, score = 3.375 * 1.05 = 3.54
      const cheapLowCorridor = scoreDemand(30, 3, 1, 0, 8);

      // High corridor value overcomes higher build cost when ROI is competitive
      expect(expensiveButStrategic).toBeGreaterThan(cheapLowCorridor);
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
        demandScore: scoreDemand(25, 15, 8, 2, 6),
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
        demandScore: scoreDemand(15, 5, 3, 0, 4),
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
        demandScore: scoreDemand(10, 3, 2, 0, 2),
      });

      expect(demand.isLoadOnTrain).toBe(true);
      expect(demand.demandScore).toBeGreaterThan(0);
    });
  });

  describe('negative-ROI corridor dampening', () => {
    it('corridor should dampen (not amplify) negative ROI scores', () => {
      // Negative baseROI: build cost > payout
      // No corridor: ROI = (10-20)/5 = -2.0, score = -2.0 / (1+0) = -2.0
      const noCorridorScore = scoreDemand(10, 20, 0, 0, 5);
      // With corridor: ROI = (10-20)/5 = -2.0, corridorMult=0.3, score = -2.0 / 1.3 ≈ -1.54
      const withCorridorScore = scoreDemand(10, 20, 6, 0, 5);

      // Corridor should improve (make less negative) the score, not worsen it
      expect(withCorridorScore).toBeGreaterThan(noCorridorScore);
      // Both are still negative
      expect(noCorridorScore).toBeLessThan(0);
      expect(withCorridorScore).toBeLessThan(0);
    });

    it('Frankfurt (high corridor) beats Dublin (low corridor) despite both negative ROI', () => {
      // Beer→Antwerpen: both supply cities produce negative ROI, but Frankfurt has better corridor
      // Frankfurt: ROI=(12-30)/8=-2.25, corridorMult=min(8*0.05,0.5)=0.4, score=-2.25/1.4≈-1.607
      const frankfurtScore = scoreDemand(12, 30, 8, 0, 8);
      // Dublin: ROI=(12-30)/8=-2.25, corridorMult=min(3*0.05,0.5)=0.15, score=-2.25/1.15≈-1.957
      const dublinScore = scoreDemand(12, 30, 3, 0, 8);

      // Frankfurt wins (less negative) — bot should pick Frankfurt, not Dublin
      expect(frankfurtScore).toBeGreaterThan(dublinScore);
    });

    it('negative ROI with zero corridor returns unchanged baseROI', () => {
      // corridor=0 means multiplier=0, division by (1+0)=1, so score = baseROI
      const score = scoreDemand(5, 20, 0, 0, 3);
      const baseROI = (5 - 20) / 3;
      expect(score).toBeCloseTo(baseROI, 5);
    });

    it('build cost ceiling exponentially penalizes routes over 50M', () => {
      // Route at exactly 50M vs one at 94M: same payout and turns
      // At 94M: penalty = Math.exp(-(94-50)/30) = Math.exp(-1.467) ≈ 0.23
      const routeAt50M = scoreDemand(100, 50, 0, 0, 10);
      const routeAt94M = scoreDemand(100, 94, 0, 0, 10);

      // The 94M route should score significantly worse
      expect(routeAt50M).toBeGreaterThan(routeAt94M);
    });

    it('build cost ceiling only applies above 50M threshold', () => {
      // Routes at 30M and 49M should have no cost ceiling penalty (costPenalty=1)
      // Score should differ only due to different build costs in baseROI
      const routeAt30M = scoreDemand(60, 30, 0, 0, 5);
      const routeAt49M = scoreDemand(60, 49, 0, 0, 5);
      const expectedAt30M = (60 - 30) / 5; // 6.0 — no penalty
      const expectedAt49M = (60 - 49) / 5; // 2.2 — no penalty

      expect(routeAt30M).toBeCloseTo(expectedAt30M, 5);
      expect(routeAt49M).toBeCloseTo(expectedAt49M, 5);
    });
  });
});
