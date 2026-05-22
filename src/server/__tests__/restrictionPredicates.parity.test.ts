/**
 * Behavioral parity contract for restrictionPredicates (JIRA-256 Phase 4).
 *
 * Locked assertion: after the PlayerService refactor, there must be zero
 * inline `restriction.type ===` discrimination in playerService.ts.
 * All restriction-type logic lives in restrictionPredicates.ts.
 *
 * This test also verifies that predicate outputs are consistent across
 * representative (activeEffects, action) triples — same input, same output
 * regardless of call site.
 */

import { describe, it, expect } from '@jest/globals';
import { readFileSync } from 'fs';
import { join } from 'path';

describe('PlayerService parity: no inline restriction-type discrimination', () => {
  it('has no inline restriction.type === in playerService.ts', () => {
    const src = readFileSync(
      join(__dirname, '../services/playerService.ts'),
      'utf-8',
    );
    const matches = src.match(/restriction\.type ===/g) ?? [];
    expect(matches).toHaveLength(0);
  });
});

// ── Parity fixture table ──────────────────────────────────────────────────────

import {
  isPickupDeliveryBlocked,
  isMovementBlockedAtDest,
  isMovementOnOwnRailBlocked,
  isBuildBlockedAtMilepost,
} from '../services/restrictionPredicates';
import type { PickupDeliveryRestriction, MovementRestriction, BuildRestriction } from '../../shared/types/EventCard';

/**
 * Table-driven fixture: same (restrictions, action-key) → same verdict.
 * These values are what PlayerService now computes at each enforcement site
 * and what the bot planners will compute during candidate filtering.
 */

describe('Pickup/Delivery parity: predicate consistency', () => {
  const zone = ['10,5', '20,8', '30,12'];
  const restriction: PickupDeliveryRestriction = {
    type: 'no_pickup_delivery_in_zone',
    zone,
  };

  const cases: Array<[string | null, boolean]> = [
    ['10,5', true],
    ['20,8', true],
    ['30,12', true],
    ['99,99', false],
    [null, false],
  ];

  test.each(cases)('city key %s → blocked=%s', (cityKey, expected) => {
    const result = isPickupDeliveryBlocked([restriction], cityKey);
    expect(result.blocked).toBe(expected);
  });
});

describe('Movement blocked_terrain parity', () => {
  const zone = ['5,5', '6,6', '7,7'];
  const restriction: MovementRestriction = {
    type: 'blocked_terrain',
    zone,
  };

  const cases: Array<[string, boolean]> = [
    ['5,5', true],
    ['6,6', true],
    ['7,7', true],
    ['8,8', false],
    ['0,0', false],
  ];

  test.each(cases)('destKey %s → blocked=%s', (destKey, expected) => {
    const result = isMovementBlockedAtDest([restriction], destKey);
    expect(result.blocked).toBe(expected);
  });
});

describe('Rail Strike movement parity', () => {
  const restriction: MovementRestriction = {
    type: 'no_movement_on_player_rail',
    targetPlayerId: 'p1',
  };

  const cases: Array<[string, string, boolean]> = [
    ['p1', 'p1', true],   // own track, targeted player
    ['p2', 'p1', false],  // opponent track
    ['p1', 'p2', false],  // own track, but restriction targets different player
  ];

  test.each(cases)(
    'segmentOwner=%s playerId=%s → blocked=%s',
    (segOwner, playerId, expected) => {
      expect(isMovementOnOwnRailBlocked([restriction], segOwner, playerId)).toBe(expected);
    },
  );
});

describe('Build restriction parity', () => {
  const blockedTerrain: BuildRestriction = {
    type: 'blocked_terrain',
    zone: ['8,3', '8,4'],
  };
  const noBuildForP1: BuildRestriction = {
    type: 'no_build_for_player',
    targetPlayerId: 'p1',
  };

  const cases: Array<[BuildRestriction[], string, string, boolean, string | undefined]> = [
    [[blockedTerrain], '8,3', 'p1', true, 'blocked_terrain'],
    [[blockedTerrain], '9,9', 'p1', false, undefined],
    [[noBuildForP1], '9,9', 'p1', true, 'no_build_for_player'],
    [[noBuildForP1], '9,9', 'p2', false, undefined],
  ];

  test.each(cases)(
    'restriction=%j destKey=%s playerId=%s → blocked=%s reason=%s',
    (restrictions, destKey, playerId, expectedBlocked, expectedReason) => {
      const result = isBuildBlockedAtMilepost(restrictions, destKey, playerId);
      expect(result.blocked).toBe(expectedBlocked);
      if (result.blocked && expectedReason) {
        expect(result.reason).toBe(expectedReason);
      }
    },
  );
});
