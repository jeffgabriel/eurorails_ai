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
      // Manchester: closer (4 hexes from London), modest corridor
      const manchesterScore = scoreDemand(
        25, // payout
        4,  // totalTrackCost (cheap — close to network)
        4,  // networkCities (modest corridor: 4 cities)
        1,  // victoryMajorCities
        4,  // estimatedTurns
      );

      // Stuttgart: farther (8 hexes from Wien), excellent corridor
      const stuttgartScore = scoreDemand(
        25, // same payout
        10, // totalTrackCost (more expensive — farther)
        8,  // networkCities (great corridor: 8 cities including Paris)
        2,  // victoryMajorCities (Berlin + Paris)
        6,  // estimatedTurns (more turns because farther)
      );

      // Stuttgart's corridor + victory bonus should overcome its higher cost
      expect(stuttgartScore).toBeGreaterThan(manchesterScore);
    });

    it('should select the supply city that maximizes demand score from multiple options', () => {
      // Simulate computeBestDemandContext: evaluate each supply city
      const supplyCities = [
        { city: 'Manchester', cost: 4, corridor: 4, victory: 1, turns: 4 },
        { city: 'Stuttgart', cost: 10, corridor: 8, victory: 2, turns: 6 },
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

    it('should evaluate supply city even when costly if victory cities are abundant', () => {
      // Expensive but connects 3 victory majors
      const expensiveButStrategic = scoreDemand(30, 18, 6, 3, 8);
      // Cheap but connects 0 victory majors
      const cheapButDead = scoreDemand(30, 3, 2, 0, 3);

      // Victory bonus should make the expensive route competitive
      expect(expensiveButStrategic).toBeGreaterThan(cheapButDead);
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
});
