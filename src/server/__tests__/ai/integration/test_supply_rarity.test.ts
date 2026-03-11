/**
 * TEST-001: Supply Rarity Awareness — Behavior 4
 *
 * Validates that each demand is tagged with supply rarity information
 * and that the demand ranking correctly reflects supply city counts.
 *
 * PRD scenario: Flowers demand near Holland gets rarity boost over
 * Beer demand near Frankfurt (Flowers: UNIQUE, Beer: COMMON).
 */

import {
  makeDemandContext,
  computeSupplyRarity,
  buildDemandRanking,
} from './integrationTestSetup';

describe('Behavior 4: Supply Rarity Awareness', () => {
  describe('rarity classification', () => {
    it('should classify UNIQUE loads with a single supply city', () => {
      const demands = [
        makeDemandContext({ loadType: 'Flowers', supplyCity: 'Holland' }),
      ];

      const rarity = computeSupplyRarity(demands);

      expect(rarity.get('Flowers')).toBe('UNIQUE');
    });

    it('should classify LIMITED loads with exactly 2 supply cities', () => {
      const demands = [
        makeDemandContext({ loadType: 'Hops', supplyCity: 'Cardiff' }),
        makeDemandContext({ loadType: 'Hops', supplyCity: 'Praha' }),
      ];

      const rarity = computeSupplyRarity(demands);

      expect(rarity.get('Hops')).toBe('LIMITED');
    });

    it('should classify COMMON loads with 3+ supply cities', () => {
      const demands = [
        makeDemandContext({ loadType: 'Beer', supplyCity: 'München' }),
        makeDemandContext({ loadType: 'Beer', supplyCity: 'Dublin' }),
        makeDemandContext({ loadType: 'Beer', supplyCity: 'Praha' }),
        makeDemandContext({ loadType: 'Beer', supplyCity: 'Amsterdam' }),
      ];

      const rarity = computeSupplyRarity(demands);

      expect(rarity.get('Beer')).toBe('COMMON');
    });

    it('should handle mixed rarity across multiple load types', () => {
      const demands = [
        makeDemandContext({ loadType: 'Flowers', supplyCity: 'Holland' }),
        makeDemandContext({ loadType: 'Hops', supplyCity: 'Cardiff' }),
        makeDemandContext({ loadType: 'Hops', supplyCity: 'Praha' }),
        makeDemandContext({ loadType: 'Beer', supplyCity: 'München' }),
        makeDemandContext({ loadType: 'Beer', supplyCity: 'Dublin' }),
        makeDemandContext({ loadType: 'Beer', supplyCity: 'Praha' }),
      ];

      const rarity = computeSupplyRarity(demands);

      expect(rarity.get('Flowers')).toBe('UNIQUE');
      expect(rarity.get('Hops')).toBe('LIMITED');
      expect(rarity.get('Beer')).toBe('COMMON');
    });

    it('should not double-count the same supply city for a load type', () => {
      const demands = [
        makeDemandContext({ loadType: 'Coal', supplyCity: 'Essen', cardIndex: 0 }),
        makeDemandContext({ loadType: 'Coal', supplyCity: 'Essen', cardIndex: 1 }),
      ];

      const rarity = computeSupplyRarity(demands);

      // Same city listed twice — still just 1 unique supply city
      expect(rarity.get('Coal')).toBe('UNIQUE');
    });
  });

  describe('rarity in demand ranking', () => {
    it('should include supplyRarity tag in demand ranking entries', () => {
      const demands = [
        makeDemandContext({
          loadType: 'Flowers',
          supplyCity: 'Holland',
          deliveryCity: 'Berlin',
          payout: 15,
          demandScore: 8,
        }),
        makeDemandContext({
          loadType: 'Beer',
          supplyCity: 'München',
          deliveryCity: 'Paris',
          payout: 12,
          demandScore: 5,
        }),
      ];

      const ranking = buildDemandRanking(demands);

      expect(ranking[0].supplyRarity).toBe('UNIQUE'); // Flowers from single city
      expect(ranking[1].supplyRarity).toBe('UNIQUE'); // Beer also unique in this demand set
    });

    it('should correctly tag rarity when same load type has multiple supply cities', () => {
      const demands = [
        makeDemandContext({
          loadType: 'Beer',
          supplyCity: 'München',
          deliveryCity: 'Berlin',
          payout: 12,
          demandScore: 6,
          cardIndex: 0,
        }),
        makeDemandContext({
          loadType: 'Beer',
          supplyCity: 'Dublin',
          deliveryCity: 'Paris',
          payout: 15,
          demandScore: 8,
          cardIndex: 1,
        }),
        makeDemandContext({
          loadType: 'Beer',
          supplyCity: 'Praha',
          deliveryCity: 'Wien',
          payout: 10,
          demandScore: 4,
          cardIndex: 2,
        }),
      ];

      const ranking = buildDemandRanking(demands);

      // All Beer entries should be COMMON (3 distinct supply cities)
      for (const entry of ranking) {
        expect(entry.supplyRarity).toBe('COMMON');
      }
    });

    it('should mark demands from rare sources for LLM opportunity awareness', () => {
      const demands = [
        makeDemandContext({
          loadType: 'Flowers',
          supplyCity: 'Holland',
          deliveryCity: 'Wien',
          payout: 20,
          demandScore: 12,
          isSupplyOnNetwork: true,
        }),
      ];

      const ranking = buildDemandRanking(demands);

      expect(ranking[0].supplyRarity).toBe('UNIQUE');
      expect(ranking[0].score).toBe(12);
      // The LLM context would show this as a rare opportunity
    });
  });

  describe('rarity edge cases', () => {
    it('should handle empty demand list', () => {
      const rarity = computeSupplyRarity([]);
      expect(rarity.size).toBe(0);
    });

    it('should handle a demand with empty supply city', () => {
      const demands = [
        makeDemandContext({ loadType: 'Coal', supplyCity: '' }),
      ];

      const rarity = computeSupplyRarity(demands);
      expect(rarity.get('Coal')).toBe('UNIQUE');
    });
  });
});
