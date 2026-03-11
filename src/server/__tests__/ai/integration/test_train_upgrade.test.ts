/**
 * TEST-001: Train Upgrade in TurnComposer Phase B — Behavior 5
 *
 * Validates that Phase B evaluates upgrade as an alternative to build
 * and prefers upgrade when conditions are met.
 *
 * PRD scenario: Bot on Freight with 80M and no urgent build target
 * upgrades to Fast Freight.
 */

import { shouldPreferUpgrade } from './integrationTestSetup';

describe('Behavior 5: Train Upgrade in TurnComposer Phase B', () => {
  describe('upgrade preference logic', () => {
    it('should prefer upgrade when no build target found', () => {
      const result = shouldPreferUpgrade(
        true,  // canUpgrade
        80,    // money
        0,     // turnBuildCost
        'Freight',
        false, // buildPlanFound = NO
      );

      expect(result.preferUpgrade).toBe(true);
      expect(result.reason).toBe('no_build_target');
    });

    it('should prefer upgrade when build budget is too low for useful track', () => {
      const result = shouldPreferUpgrade(
        true,  // canUpgrade
        22,    // money — enough for upgrade but not much build
        18,    // turnBuildCost — already spent 18M this turn
        'Freight',
        true,  // buildPlanFound (irrelevant — budget too low)
      );

      // buildBudget = min(20 - 18, 22) = 2 → < 5 → prefer upgrade
      expect(result.preferUpgrade).toBe(true);
      expect(result.reason).toBe('low_build_budget');
    });

    it('should prefer build over upgrade when viable build target exists', () => {
      const result = shouldPreferUpgrade(
        true,  // canUpgrade
        50,    // money
        0,     // turnBuildCost
        'Freight',
        true,  // buildPlanFound = YES
      );

      expect(result.preferUpgrade).toBe(false);
      expect(result.reason).toBe('build_preferred');
    });

    it('should not upgrade when already Superfreight', () => {
      const result = shouldPreferUpgrade(
        true,  // canUpgrade
        100,   // money — plenty of cash
        0,     // turnBuildCost
        'Superfreight',
        false, // no build target
      );

      expect(result.preferUpgrade).toBe(false);
      expect(result.reason).toBe('already_max');
    });

    it('should not upgrade when cannot afford (money < 20M)', () => {
      const result = shouldPreferUpgrade(
        true,  // canUpgrade
        15,    // money — can't afford 20M upgrade
        0,     // turnBuildCost
        'Freight',
        false, // no build target
      );

      expect(result.preferUpgrade).toBe(false);
      expect(result.reason).toBe('cannot_afford');
    });

    it('should not upgrade when canUpgrade flag is false', () => {
      const result = shouldPreferUpgrade(
        false, // canUpgrade = NO (e.g., initial build phase)
        80,    // money
        0,     // turnBuildCost
        'Freight',
        false, // no build target
      );

      expect(result.preferUpgrade).toBe(false);
      expect(result.reason).toBe('cannot_upgrade');
    });
  });

  describe('upgrade timing', () => {
    it('should allow upgrade for Fast Freight', () => {
      const result = shouldPreferUpgrade(
        true,
        80,
        0,
        'Fast Freight',
        false,
      );

      expect(result.preferUpgrade).toBe(true);
    });

    it('should allow upgrade for Heavy Freight', () => {
      const result = shouldPreferUpgrade(
        true,
        80,
        0,
        'Heavy Freight',
        false,
      );

      expect(result.preferUpgrade).toBe(true);
    });

    it('should handle exact 20M budget for upgrade', () => {
      const result = shouldPreferUpgrade(
        true,
        20,   // exactly enough for upgrade
        0,
        'Freight',
        false,
      );

      expect(result.preferUpgrade).toBe(true);
    });
  });

  describe('upgrade vs build trade-off at budget boundaries', () => {
    it('should prefer upgrade when build budget is exactly 4M (below threshold)', () => {
      const result = shouldPreferUpgrade(
        true,
        20,
        16, // turnBuildCost = 16 → budget = min(4, 20) = 4 → < 5
        'Freight',
        true,
      );

      expect(result.preferUpgrade).toBe(true);
      expect(result.reason).toBe('low_build_budget');
    });

    it('should prefer build when build budget is exactly 5M (at threshold)', () => {
      const result = shouldPreferUpgrade(
        true,
        20,
        15, // turnBuildCost = 15 → budget = min(5, 20) = 5 → NOT < 5
        'Freight',
        true,
      );

      expect(result.preferUpgrade).toBe(false);
      expect(result.reason).toBe('build_preferred');
    });
  });
});
