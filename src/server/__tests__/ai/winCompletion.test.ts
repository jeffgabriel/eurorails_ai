/**
 * winCompletion.test.ts
 *
 * Unit tests for the winCompletion helper module (JIRA-255 BE-001).
 *
 * Covers:
 *  - CASH_WIN_THRESHOLD_M constant
 *  - fullWinCost: various cmcCount and unconnectedMajors combinations
 *  - isWinCompleting: boundary conditions, true/false cases
 */

import {
  CASH_WIN_THRESHOLD_M,
  fullWinCost,
  isWinCompleting,
} from '../../services/ai/winCompletion';

// ── CASH_WIN_THRESHOLD_M ───────────────────────────────────────────────

describe('CASH_WIN_THRESHOLD_M', () => {
  it('equals 250', () => {
    expect(CASH_WIN_THRESHOLD_M).toBe(250);
  });
});

// ── fullWinCost ────────────────────────────────────────────────────────

describe('fullWinCost', () => {
  it('returns 250 when cmcCount is 7 (all connected)', () => {
    const result = fullWinCost([], 7);
    expect(result).toBe(250);
  });

  it('returns 250 when unconnectedMajors is empty and cmcCount < 7', () => {
    // No known connection costs available — returns only the cash threshold
    const result = fullWinCost([], 3);
    expect(result).toBe(250);
  });

  it('sums the cheapest (7 - cmcCount) costs for cmcCount = 3', () => {
    // remaining = 4; cheapest 4 from [5, 7, 9, 11, 13, 15] are 5+7+9+11 = 32
    const unconnected = [
      { cityName: 'A', estimatedCost: 5 },
      { cityName: 'B', estimatedCost: 7 },
      { cityName: 'C', estimatedCost: 9 },
      { cityName: 'D', estimatedCost: 11 },
      { cityName: 'E', estimatedCost: 13 },
      { cityName: 'F', estimatedCost: 15 },
    ];
    const result = fullWinCost(unconnected, 3);
    expect(result).toBe(250 + 5 + 7 + 9 + 11); // 282
  });

  it('picks cheapest entries even when array is not sorted', () => {
    const unconnected = [
      { cityName: 'A', estimatedCost: 15 },
      { cityName: 'B', estimatedCost: 5 },
      { cityName: 'C', estimatedCost: 9 },
    ];
    // cmcCount = 5 → remaining = 2 → cheapest 2: 5+9 = 14
    const result = fullWinCost(unconnected, 5);
    expect(result).toBe(250 + 5 + 9); // 264
  });

  it('handles cmcCount = 6 (one city left to connect)', () => {
    const unconnected = [
      { cityName: 'X', estimatedCost: 20 },
      { cityName: 'Y', estimatedCost: 8 },
    ];
    // remaining = 1 → take only the cheapest: 8
    const result = fullWinCost(unconnected, 6);
    expect(result).toBe(250 + 8); // 258
  });

  it('returns 250 when remaining cities exceeds unconnected array length (capped)', () => {
    // cmcCount = 0, remaining = 7, but only 2 cities available
    const unconnected = [
      { cityName: 'A', estimatedCost: 10 },
      { cityName: 'B', estimatedCost: 20 },
    ];
    const result = fullWinCost(unconnected, 0);
    // Can only slice 2 entries → 250 + 10 + 20 = 280
    expect(result).toBe(250 + 10 + 20); // 280
  });

  it('does not mutate the original unconnectedMajors array', () => {
    const unconnected = [
      { cityName: 'A', estimatedCost: 15 },
      { cityName: 'B', estimatedCost: 5 },
    ];
    const original = [...unconnected];
    fullWinCost(unconnected, 5);
    expect(unconnected).toEqual(original);
  });
});

// ── isWinCompleting ────────────────────────────────────────────────────

describe('isWinCompleting', () => {
  // Shared fixture: 3 cities connected, unconnected sum of cheapest 4 = 30M
  // (5+7+9+9 — see below), fullWinCost = 280
  const majors = [
    { cityName: 'A', estimatedCost: 5 },
    { cityName: 'B', estimatedCost: 7 },
    { cityName: 'C', estimatedCost: 9 },
    { cityName: 'D', estimatedCost: 9 },
    { cityName: 'E', estimatedCost: 12 },
  ];
  const cmcCount = 3; // remaining = 4; cheapest 4: 5+7+9+9 = 30 → fullWinCost = 280

  it('returns true when currentCash + candidateNet >= fullWinCost', () => {
    // 227 + 67 = 294 >= 280
    expect(isWinCompleting(227, 67, majors, cmcCount)).toBe(true);
  });

  it('returns false when currentCash + candidateNet < fullWinCost', () => {
    // 227 + 32 = 259 < 280
    expect(isWinCompleting(227, 32, majors, cmcCount)).toBe(false);
  });

  it('returns true when sum exactly equals fullWinCost (boundary)', () => {
    // 227 + 53 = 280 == 280 → true
    expect(isWinCompleting(227, 53, majors, cmcCount)).toBe(true);
  });

  it('returns false when candidateNet subtracts track cost bringing total below threshold', () => {
    // fullWinCost with cmcCount=3, sum $30 = 280; cash=260, net=10
    // 260 + 10 = 270 < 280 → false
    expect(isWinCompleting(260, 10, majors, cmcCount)).toBe(false);
  });

  it('returns true when all 7 cities connected (fullWinCost = 250)', () => {
    // No track cost needed; just need cash >= 250
    expect(isWinCompleting(240, 15, [], 7)).toBe(true);  // 255 >= 250
    expect(isWinCompleting(240, 9, [], 7)).toBe(false);  // 249 < 250
  });

  it('handles zero candidateNet correctly', () => {
    // Just re-checking cash position without a new delivery
    expect(isWinCompleting(280, 0, [], 7)).toBe(true);   // 280 >= 250
    expect(isWinCompleting(249, 0, [], 7)).toBe(false);  // 249 < 250
  });
});
