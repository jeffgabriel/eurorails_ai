/**
 * winCompletion.test.ts
 *
 * Unit tests for JIRA-255 Layer B helper module:
 * - fullWinCost
 * - isWinCompleting
 *
 * Covers AC3 (partially) — win-completer detection logic.
 */

import { CASH_WIN_THRESHOLD_M, fullWinCost, isWinCompleting } from '../../services/ai/winCompletion';

describe('winCompletion helpers — JIRA-255 Layer B', () => {
  const unconnectedMajors = [
    { cityName: 'Berlin', estimatedCost: 10 },
    { cityName: 'Paris', estimatedCost: 15 },
    { cityName: 'Roma', estimatedCost: 20 },
    { cityName: 'Madrid', estimatedCost: 25 },
    { cityName: 'Wien', estimatedCost: 30 },
    { cityName: 'Warszawa', estimatedCost: 35 },
    { cityName: 'Istanbul', estimatedCost: 40 },
  ];

  describe('CASH_WIN_THRESHOLD_M', () => {
    it('equals 250 (ECU M)', () => {
      expect(CASH_WIN_THRESHOLD_M).toBe(250);
    });
  });

  describe('fullWinCost', () => {
    it('returns 250 when cmcCount >= 7 (all cities connected)', () => {
      expect(fullWinCost(unconnectedMajors, 7)).toBe(250);
    });

    it('adds cheapest N unconnected city costs when fewer than 7 connected', () => {
      // cmcCount=4 → remaining=3 → cheapest 3 unconnected (10+15+20 = 45)
      expect(fullWinCost(unconnectedMajors, 4)).toBe(250 + 10 + 15 + 20);
    });

    it('handles cmcCount=0 (zero cities connected)', () => {
      // All 7 needed → sum of cheapest 7: 10+15+20+25+30+35+40 = 175
      expect(fullWinCost(unconnectedMajors, 0)).toBe(250 + 175);
    });

    it('handles empty unconnectedMajors gracefully', () => {
      // No unconnected cities with data → cityCost = 0 for each remaining
      expect(fullWinCost([], 4)).toBe(250);
    });

    it('uses only the cheapest N majors (sorted by estimatedCost, cheapest-first)', () => {
      // cmcCount=5 → remaining=2 → cheapest 2: 10+15=25
      expect(fullWinCost(unconnectedMajors, 5)).toBe(250 + 10 + 15);
    });

    it('handles cmcCount > 7 (should be 0 remaining) without negative', () => {
      expect(fullWinCost(unconnectedMajors, 10)).toBe(250);
    });
  });

  describe('isWinCompleting', () => {
    it('returns true when currentCash + candidateNet >= fullWinCost', () => {
      // T76 scenario: cash=227M, net=67M, cmcCount=3, cheapest 4 unconnected
      const majors = [
        { cityName: 'Milano', estimatedCost: 8 },
        { cityName: 'Ruhr', estimatedCost: 10 },
        { cityName: 'Wien', estimatedCost: 12 },
        { cityName: 'Paris', estimatedCost: 15 },
        { cityName: 'Berlin', estimatedCost: 20 },
      ];
      // cmcCount=3, remaining=4, cityCost=8+10+12+15=45 → fullWinCost=295
      // currentCash+net = 227+67 = 294 — NOT completing (294 < 295)
      expect(isWinCompleting(227, 67, majors, 3)).toBe(false);

      // With slightly higher net: 227+68=295 >= 295 → completing
      expect(isWinCompleting(227, 68, majors, 3)).toBe(true);
    });

    it('returns false when currentCash + candidateNet < fullWinCost', () => {
      // cash=100M, net=50M, cmcCount=0, many cities to connect
      expect(isWinCompleting(100, 50, unconnectedMajors, 0)).toBe(false);
    });

    it('returns true when cmcCount=7 (all connected) and cash+net >= 250', () => {
      // All 7 cities connected — only cash threshold needed
      expect(isWinCompleting(200, 50, unconnectedMajors, 7)).toBe(true);  // 200+50=250 >= 250
      expect(isWinCompleting(200, 49, unconnectedMajors, 7)).toBe(false); // 200+49=249 < 250
    });

    it('returns true at the exact boundary (currentCash + net === fullWinCost)', () => {
      // fullWinCost with cmcCount=6, 1 remaining costing 10 = 260
      const majors = [{ cityName: 'Berlin', estimatedCost: 10 }];
      expect(isWinCompleting(240, 20, majors, 6)).toBe(true); // 260 >= 260
    });
  });
});
