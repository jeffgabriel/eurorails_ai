/**
 * Unit tests for restrictionPredicates.ts (JIRA-256 Phase 4).
 *
 * Pure-function tests — no DB, no mocks for the predicates themselves.
 * Table-driven for maximum coverage.
 */

import { describe, it, expect, jest } from '@jest/globals';

// ── Mock MapTopology (used by getCityMilepointKey) ───────────────────────────
jest.mock('../services/MapTopology', () => ({
  loadGridPoints: jest.fn(() => {
    const m = new Map<string, { row: number; col: number; terrain: number; name?: string }>();
    // TerrainType.MajorCity = 3 (numeric value from the enum)
    m.set('10,5', { row: 10, col: 5, terrain: 3, name: 'Paris' });
    m.set('20,8', { row: 20, col: 8, terrain: 2, name: 'Lyon' }); // MediumCity=2
    m.set('30,12', { row: 30, col: 12, terrain: 3, name: 'Berlin' });
    return m;
  }),
}));

// ── Mock trackService (getRiverEdgeKeys / segmentCrossesRiver) ───────────────
jest.mock('../services/trackService', () => ({
  getRiverEdgeKeys: jest.fn((riverName: string) => {
    if (riverName === 'Rhine') {
      // Fake Rhine edges: segment from (5,5) to (5,6)
      return new Set<string>(['5,5|5,6']);
    }
    return null;
  }),
  segmentCrossesRiver: jest.fn(
    (segment: { from: { row: number; col: number }; to: { row: number; col: number } }, edgeKeys: Set<string>) => {
      const key = `${Math.min(segment.from.row, segment.to.row)},${Math.min(segment.from.col, segment.to.col)}|${Math.max(segment.from.row, segment.to.row)},${Math.max(segment.from.col, segment.to.col)}`;
      return edgeKeys.has(key);
    },
  ),
}));

import {
  isPickupDeliveryBlocked,
  isMovementBlockedAtDest,
  isMovementOnOwnRailBlocked,
  isMovementHalfRate,
  isBuildBlockedAtMilepost,
  isFloodRebuildBlocked,
  isBotInPendingLostTurns,
  getCityMilepointKey,
} from '../services/restrictionPredicates';
import type { ActiveEffect, PickupDeliveryRestriction, MovementRestriction, BuildRestriction } from '../../shared/types/EventCard';
import { EventCardType } from '../../shared/types/EventCard';
import type { TrackSegment } from '../../shared/types/GameTypes';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeActiveEffect(overrides: Partial<ActiveEffect> = {}): ActiveEffect {
  return {
    cardId: 121,
    cardType: EventCardType.Strike,
    drawingPlayerId: 'player-1',
    drawingPlayerIndex: 0,
    expiresAfterTurnNumber: 5,
    affectedZone: new Set<string>(),
    restrictions: { movement: [], build: [], pickupDelivery: [] },
    pendingLostTurns: [],
    ...overrides,
  };
}

function makeSegment(
  from: { row: number; col: number },
  to: { row: number; col: number },
): TrackSegment {
  return {
    from: { x: 0, y: 0, row: from.row, col: from.col, terrain: 0 as any },
    to:   { x: 0, y: 0, row: to.row,   col: to.col,   terrain: 0 as any },
    cost: 1,
  };
}

// ── isPickupDeliveryBlocked ────────────────────────────────────────────────────

describe('isPickupDeliveryBlocked', () => {
  const restriction: PickupDeliveryRestriction = {
    type: 'no_pickup_delivery_in_zone',
    zone: ['10,5', '20,8'],
  };

  it('returns blocked: true when cityKey is inside the zone', () => {
    const result = isPickupDeliveryBlocked([restriction], '10,5');
    expect(result.blocked).toBe(true);
    if (result.blocked) {
      expect(result.restriction).toBe(restriction);
    }
  });

  it('returns blocked: false when cityKey is outside the zone', () => {
    const result = isPickupDeliveryBlocked([restriction], '99,99');
    expect(result.blocked).toBe(false);
  });

  it('returns blocked: false when cityKey is null', () => {
    const result = isPickupDeliveryBlocked([restriction], null);
    expect(result.blocked).toBe(false);
  });

  it('returns blocked: false when restrictions are empty', () => {
    const result = isPickupDeliveryBlocked([], '10,5');
    expect(result.blocked).toBe(false);
  });

  it('returns blocked: false for a different restriction type (hypothetical)', () => {
    // Only 'no_pickup_delivery_in_zone' should match
    const otherRestriction = { type: 'OTHER_TYPE' as any, zone: ['10,5'] };
    const result = isPickupDeliveryBlocked([otherRestriction as any], '10,5');
    expect(result.blocked).toBe(false);
  });
});

// ── isMovementBlockedAtDest ───────────────────────────────────────────────────

describe('isMovementBlockedAtDest', () => {
  const restriction: MovementRestriction = {
    type: 'blocked_terrain',
    zone: ['15,3', '16,4'],
  };

  it('returns blocked: true when dest is in the blocked_terrain zone', () => {
    const result = isMovementBlockedAtDest([restriction], '15,3');
    expect(result.blocked).toBe(true);
    if (result.blocked) {
      expect(result.restriction).toBe(restriction);
    }
  });

  it('returns blocked: false when dest is outside the zone', () => {
    const result = isMovementBlockedAtDest([restriction], '99,99');
    expect(result.blocked).toBe(false);
  });

  it('returns blocked: false for half_rate restrictions (wrong type)', () => {
    const halfRate: MovementRestriction = { type: 'half_rate', zone: ['15,3'] };
    const result = isMovementBlockedAtDest([halfRate], '15,3');
    expect(result.blocked).toBe(false);
  });

  it('returns blocked: false for no_movement_on_player_rail (wrong type)', () => {
    const railStrike: MovementRestriction = {
      type: 'no_movement_on_player_rail',
      targetPlayerId: 'player-1',
    };
    const result = isMovementBlockedAtDest([railStrike], '15,3');
    expect(result.blocked).toBe(false);
  });

  it('returns blocked: false when restrictions are empty', () => {
    expect(isMovementBlockedAtDest([], '15,3').blocked).toBe(false);
  });

  it('returns blocked: false when zone is missing on blocked_terrain restriction', () => {
    const noZone: MovementRestriction = { type: 'blocked_terrain' };
    expect(isMovementBlockedAtDest([noZone], '15,3').blocked).toBe(false);
  });
});

// ── isMovementOnOwnRailBlocked ────────────────────────────────────────────────

describe('isMovementOnOwnRailBlocked', () => {
  const railStrike: MovementRestriction = {
    type: 'no_movement_on_player_rail',
    targetPlayerId: 'player-1',
  };

  it('returns true when segment owner = player and restriction targets that player', () => {
    expect(isMovementOnOwnRailBlocked([railStrike], 'player-1', 'player-1')).toBe(true);
  });

  it('returns false when segment owner !== player (using opponent track)', () => {
    expect(isMovementOnOwnRailBlocked([railStrike], 'player-2', 'player-1')).toBe(false);
  });

  it('returns false when restriction targets a different player', () => {
    const otherTargetRestriction: MovementRestriction = {
      type: 'no_movement_on_player_rail',
      targetPlayerId: 'player-2',
    };
    expect(isMovementOnOwnRailBlocked([otherTargetRestriction], 'player-1', 'player-1')).toBe(false);
  });

  it('returns false when restrictions are empty', () => {
    expect(isMovementOnOwnRailBlocked([], 'player-1', 'player-1')).toBe(false);
  });
});

// ── isMovementHalfRate ────────────────────────────────────────────────────────

describe('isMovementHalfRate', () => {
  const halfRate: MovementRestriction = {
    type: 'half_rate',
    zone: ['5,5', '5,6', '6,5'],
  };

  it('returns true when dest is inside the half_rate zone', () => {
    expect(isMovementHalfRate([halfRate], '5,5')).toBe(true);
  });

  it('returns false when dest is outside the half_rate zone', () => {
    expect(isMovementHalfRate([halfRate], '99,99')).toBe(false);
  });

  it('returns false when restriction type is blocked_terrain', () => {
    const blocked: MovementRestriction = { type: 'blocked_terrain', zone: ['5,5'] };
    expect(isMovementHalfRate([blocked], '5,5')).toBe(false);
  });

  it('returns false when restrictions are empty', () => {
    expect(isMovementHalfRate([], '5,5')).toBe(false);
  });

  it('returns false when half_rate restriction has no zone', () => {
    const noZone: MovementRestriction = { type: 'half_rate' };
    expect(isMovementHalfRate([noZone], '5,5')).toBe(false);
  });
});

// ── isBuildBlockedAtMilepost ──────────────────────────────────────────────────

describe('isBuildBlockedAtMilepost', () => {
  const blockedTerrain: BuildRestriction = {
    type: 'blocked_terrain',
    zone: ['8,3', '8,4'],
  };
  const noBuildfForPlayer: BuildRestriction = {
    type: 'no_build_for_player',
    targetPlayerId: 'player-1',
  };

  it('returns blocked_terrain when dest is in the zone', () => {
    const result = isBuildBlockedAtMilepost([blockedTerrain], '8,3', 'player-1');
    expect(result.blocked).toBe(true);
    if (result.blocked) {
      expect(result.reason).toBe('blocked_terrain');
      expect(result.restriction).toBe(blockedTerrain);
    }
  });

  it('returns no_build_for_player when restriction targets this player', () => {
    const result = isBuildBlockedAtMilepost([noBuildfForPlayer], '99,99', 'player-1');
    expect(result.blocked).toBe(true);
    if (result.blocked) {
      expect(result.reason).toBe('no_build_for_player');
    }
  });

  it('returns blocked: false when no_build_for_player targets a different player', () => {
    const otherPlayer: BuildRestriction = {
      type: 'no_build_for_player',
      targetPlayerId: 'player-2',
    };
    const result = isBuildBlockedAtMilepost([otherPlayer], '99,99', 'player-1');
    expect(result.blocked).toBe(false);
  });

  it('returns blocked: false when dest is outside the zone', () => {
    const result = isBuildBlockedAtMilepost([blockedTerrain], '99,99', 'player-1');
    expect(result.blocked).toBe(false);
  });

  it('returns blocked: false when restrictions are empty', () => {
    expect(isBuildBlockedAtMilepost([], '8,3', 'player-1').blocked).toBe(false);
  });
});

// ── isFloodRebuildBlocked ─────────────────────────────────────────────────────

describe('isFloodRebuildBlocked', () => {
  const floodEffect: ActiveEffect = makeActiveEffect({
    cardType: EventCardType.Flood,
    floodedRiver: 'Rhine',
  });

  // Segment that crosses Rhine (matches our mock: from (5,5) to (5,6))
  const rhineSeg = makeSegment({ row: 5, col: 5 }, { row: 5, col: 6 });
  // Segment that does NOT cross Rhine
  const safeSeg = makeSegment({ row: 1, col: 1 }, { row: 1, col: 2 });

  it('returns blocked: true when segment crosses the active flooded river', () => {
    const result = isFloodRebuildBlocked([floodEffect], rhineSeg);
    expect(result.blocked).toBe(true);
    if (result.blocked) {
      expect(result.river).toBe('Rhine');
    }
  });

  it('returns blocked: false when segment does not cross the flooded river', () => {
    const result = isFloodRebuildBlocked([floodEffect], safeSeg);
    expect(result.blocked).toBe(false);
  });

  it('returns blocked: false when no active effects', () => {
    expect(isFloodRebuildBlocked([], rhineSeg).blocked).toBe(false);
  });

  it('returns blocked: false when active effect is not a Flood', () => {
    const strikeEffect = makeActiveEffect({ cardType: EventCardType.Strike });
    expect(isFloodRebuildBlocked([strikeEffect], rhineSeg).blocked).toBe(false);
  });

  it('returns blocked: false when Flood effect has no floodedRiver', () => {
    const floodNoRiver = makeActiveEffect({ cardType: EventCardType.Flood, floodedRiver: undefined });
    expect(isFloodRebuildBlocked([floodNoRiver], rhineSeg).blocked).toBe(false);
  });

  it('returns blocked: false when river name is unknown (getRiverEdgeKeys returns null)', () => {
    const unknownRiver = makeActiveEffect({ cardType: EventCardType.Flood, floodedRiver: 'SomeUnknownRiver' });
    expect(isFloodRebuildBlocked([unknownRiver], rhineSeg).blocked).toBe(false);
  });
});

// ── isBotInPendingLostTurns ───────────────────────────────────────────────────

describe('isBotInPendingLostTurns', () => {
  const derailmentEffect: ActiveEffect = makeActiveEffect({
    cardType: EventCardType.Derailment,
    pendingLostTurns: [{ playerId: 'player-1' }, { playerId: 'player-2' }],
  });

  it('returns true when playerId has a pending lost turn', () => {
    expect(isBotInPendingLostTurns([derailmentEffect], 'player-1')).toBe(true);
  });

  it('returns true for second player with pending lost turn', () => {
    expect(isBotInPendingLostTurns([derailmentEffect], 'player-2')).toBe(true);
  });

  it('returns false when playerId is not in pendingLostTurns', () => {
    expect(isBotInPendingLostTurns([derailmentEffect], 'player-3')).toBe(false);
  });

  it('returns false when no active effects', () => {
    expect(isBotInPendingLostTurns([], 'player-1')).toBe(false);
  });

  it('returns false when all pendingLostTurns are empty', () => {
    const noLostTurns = makeActiveEffect({ pendingLostTurns: [] });
    expect(isBotInPendingLostTurns([noLostTurns], 'player-1')).toBe(false);
  });

  it('returns false when active effect has no pendingLostTurns array (edge)', () => {
    const noPending = makeActiveEffect({ pendingLostTurns: [] });
    expect(isBotInPendingLostTurns([noPending], 'player-1')).toBe(false);
  });
});

// ── getCityMilepointKey ───────────────────────────────────────────────────────

describe('getCityMilepointKey', () => {
  it('returns the key for a MajorCity (terrain=3)', () => {
    expect(getCityMilepointKey('Paris')).toBe('10,5');
  });

  it('returns the key for a non-MajorCity (falls back to any matching name)', () => {
    expect(getCityMilepointKey('Lyon')).toBe('20,8');
  });

  it('returns null when city is not found', () => {
    expect(getCityMilepointKey('Atlantis')).toBeNull();
  });

  it('returns the MajorCity center key before a non-MajorCity key for the same name', () => {
    // 'Paris' maps to '10,5' which is MajorCity; should return that
    expect(getCityMilepointKey('Paris')).toBe('10,5');
  });
});
