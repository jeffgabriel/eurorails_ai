/**
 * Unit tests for restrictionPredicates.ts
 *
 * All predicate functions are pure, so tests cover: happy-path matches,
 * miss cases (no restriction applies), edge cases (empty arrays, zone
 * boundaries), and discrimination of return types.
 */

import { describe, it, expect, jest, beforeEach } from '@jest/globals';

// ── Mocks ─────────────────────────────────────────────────────────────────────

// trackService exports module-level functions that read rivers.json.
// Mock them so tests stay unit-level (no file I/O).
jest.mock('../services/trackService', () => ({
  getRiverEdgeKeys: jest.fn(),
  segmentCrossesRiver: jest.fn(),
}));

// MapTopology.loadGridPoints reads a large grid file — mock it.
jest.mock('../services/MapTopology', () => ({
  loadGridPoints: jest.fn(),
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
import { getRiverEdgeKeys, segmentCrossesRiver } from '../services/trackService';
import { loadGridPoints } from '../services/MapTopology';
import {
  ActiveEffect,
  BuildRestriction,
  EventCardType,
  MovementRestriction,
  PickupDeliveryRestriction,
} from '../../shared/types/EventCard';
import { TerrainType } from '../../shared/types/GameTypes';

const mockGetRiverEdgeKeys = getRiverEdgeKeys as jest.MockedFunction<typeof getRiverEdgeKeys>;
const mockSegmentCrossesRiver = segmentCrossesRiver as jest.MockedFunction<typeof segmentCrossesRiver>;
const mockLoadGridPoints = loadGridPoints as jest.MockedFunction<typeof loadGridPoints>;

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeActiveEffect(overrides: Partial<ActiveEffect> = {}): ActiveEffect {
  return {
    cardId: 121,
    cardType: EventCardType.Strike,
    drawingPlayerId: 'player-1',
    drawingPlayerIndex: 0,
    expiresAfterTurnNumber: 5,
    affectedZone: new Set(['10,5', '10,6']),
    restrictions: { movement: [], build: [], pickupDelivery: [] },
    pendingLostTurns: [],
    ...overrides,
  };
}

function makeTrackSegment() {
  return {
    from: { x: 0, y: 0, row: 10, col: 5, terrain: TerrainType.Clear },
    to: { x: 1, y: 0, row: 10, col: 6, terrain: TerrainType.Clear },
    cost: 1,
  };
}

// ── isPickupDeliveryBlocked ───────────────────────────────────────────────────

describe('isPickupDeliveryBlocked', () => {
  it('returns blocked:true with the matching restriction when city key is in zone', () => {
    const restriction: PickupDeliveryRestriction = {
      type: 'no_pickup_delivery_in_zone',
      zone: ['10,5', '10,6'],
    };
    const result = isPickupDeliveryBlocked([restriction], '10,5');
    expect(result.blocked).toBe(true);
    if (result.blocked) {
      expect(result.restriction).toBe(restriction);
    }
  });

  it('returns blocked:false when city key is not in zone', () => {
    const restriction: PickupDeliveryRestriction = {
      type: 'no_pickup_delivery_in_zone',
      zone: ['10,5', '10,6'],
    };
    const result = isPickupDeliveryBlocked([restriction], '99,99');
    expect(result.blocked).toBe(false);
  });

  it('returns blocked:false for empty restrictions array', () => {
    expect(isPickupDeliveryBlocked([], '10,5').blocked).toBe(false);
  });

  it('returns the first matching restriction when multiple restrictions exist', () => {
    const r1: PickupDeliveryRestriction = {
      type: 'no_pickup_delivery_in_zone',
      zone: ['10,5'],
    };
    const r2: PickupDeliveryRestriction = {
      type: 'no_pickup_delivery_in_zone',
      zone: ['10,5', '10,6'],
    };
    const result = isPickupDeliveryBlocked([r1, r2], '10,5');
    expect(result.blocked).toBe(true);
    if (result.blocked) {
      expect(result.restriction).toBe(r1);
    }
  });
});

// ── isMovementBlockedAtDest ───────────────────────────────────────────────────

describe('isMovementBlockedAtDest', () => {
  it('returns blocked:true with restriction when dest is in a blocked_terrain zone', () => {
    const restriction: MovementRestriction = {
      type: 'blocked_terrain',
      zone: ['5,3', '5,4'],
    };
    const result = isMovementBlockedAtDest([restriction], '5,3');
    expect(result.blocked).toBe(true);
    if (result.blocked) {
      expect(result.restriction).toBe(restriction);
    }
  });

  it('returns blocked:false when dest is outside the zone', () => {
    const restriction: MovementRestriction = {
      type: 'blocked_terrain',
      zone: ['5,3'],
    };
    expect(isMovementBlockedAtDest([restriction], '5,4').blocked).toBe(false);
  });

  it('ignores non-blocked_terrain restrictions', () => {
    const restriction: MovementRestriction = {
      type: 'half_rate',
      zone: ['5,3'],
    };
    expect(isMovementBlockedAtDest([restriction], '5,3').blocked).toBe(false);
  });

  it('returns blocked:false for empty restrictions', () => {
    expect(isMovementBlockedAtDest([], '5,3').blocked).toBe(false);
  });
});

// ── isMovementOnOwnRailBlocked ────────────────────────────────────────────────

describe('isMovementOnOwnRailBlocked', () => {
  const restriction: MovementRestriction = {
    type: 'no_movement_on_player_rail',
    targetPlayerId: 'player-1',
  };

  it('returns true when player is moving on their own track and restriction targets them', () => {
    expect(isMovementOnOwnRailBlocked([restriction], 'player-1', 'player-1')).toBe(true);
  });

  it('returns false when the segment belongs to a different player', () => {
    // player-2 is trying to move on player-1's track — restriction does not apply
    expect(isMovementOnOwnRailBlocked([restriction], 'player-1', 'player-2')).toBe(false);
  });

  it('returns false when segmentOwnerId differs from playerId (moving on opponent rail)', () => {
    expect(isMovementOnOwnRailBlocked([restriction], 'player-2', 'player-1')).toBe(false);
  });

  it('returns false when no no_movement_on_player_rail restrictions exist', () => {
    const halfRate: MovementRestriction = { type: 'half_rate', zone: ['10,5'] };
    expect(isMovementOnOwnRailBlocked([halfRate], 'player-1', 'player-1')).toBe(false);
  });

  it('returns false for empty restrictions', () => {
    expect(isMovementOnOwnRailBlocked([], 'player-1', 'player-1')).toBe(false);
  });
});

// ── isMovementHalfRate ────────────────────────────────────────────────────────

describe('isMovementHalfRate', () => {
  it('returns true when dest is in half_rate zone', () => {
    const restriction: MovementRestriction = { type: 'half_rate', zone: ['6,7', '6,8'] };
    expect(isMovementHalfRate([restriction], '6,7')).toBe(true);
  });

  it('returns false when dest is outside the half_rate zone', () => {
    const restriction: MovementRestriction = { type: 'half_rate', zone: ['6,7'] };
    expect(isMovementHalfRate([restriction], '6,8')).toBe(false);
  });

  it('ignores blocked_terrain restrictions', () => {
    const restriction: MovementRestriction = { type: 'blocked_terrain', zone: ['6,7'] };
    expect(isMovementHalfRate([restriction], '6,7')).toBe(false);
  });

  it('returns false for empty restrictions', () => {
    expect(isMovementHalfRate([], '6,7')).toBe(false);
  });
});

// ── isBuildBlockedAtMilepost ──────────────────────────────────────────────────

describe('isBuildBlockedAtMilepost', () => {
  it('returns blocked_terrain reason when milepost is in blocked zone', () => {
    const restriction: BuildRestriction = { type: 'blocked_terrain', zone: ['3,3'] };
    const result = isBuildBlockedAtMilepost([restriction], '3,3', 'player-1');
    expect(result.blocked).toBe(true);
    if (result.blocked) {
      expect(result.reason).toBe('blocked_terrain');
      expect(result.restriction).toBe(restriction);
    }
  });

  it('returns no_build_for_player reason under Rail Strike', () => {
    const restriction: BuildRestriction = {
      type: 'no_build_for_player',
      targetPlayerId: 'player-1',
    };
    const result = isBuildBlockedAtMilepost([restriction], 'any-key', 'player-1');
    expect(result.blocked).toBe(true);
    if (result.blocked) {
      expect(result.reason).toBe('no_build_for_player');
    }
  });

  it('does not block a different player under Rail Strike', () => {
    const restriction: BuildRestriction = {
      type: 'no_build_for_player',
      targetPlayerId: 'player-1',
    };
    const result = isBuildBlockedAtMilepost([restriction], 'any-key', 'player-2');
    expect(result.blocked).toBe(false);
  });

  it('returns blocked:false when milepost is outside blocked zone', () => {
    const restriction: BuildRestriction = { type: 'blocked_terrain', zone: ['3,3'] };
    expect(isBuildBlockedAtMilepost([restriction], '9,9', 'player-1').blocked).toBe(false);
  });

  it('returns blocked:false for empty restrictions', () => {
    expect(isBuildBlockedAtMilepost([], '3,3', 'player-1').blocked).toBe(false);
  });
});

// ── isFloodRebuildBlocked ─────────────────────────────────────────────────────

describe('isFloodRebuildBlocked', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns blocked:true with river name when segment crosses the flooded river', () => {
    const fakeEdgeKeys = new Set(['10,5|10,6']);
    mockGetRiverEdgeKeys.mockReturnValue(fakeEdgeKeys);
    mockSegmentCrossesRiver.mockReturnValue(true);

    const effect = makeActiveEffect({
      cardType: EventCardType.Flood,
      floodedRiver: 'Rhine',
    });
    const segment = makeTrackSegment();

    const result = isFloodRebuildBlocked([effect], segment);
    expect(result.blocked).toBe(true);
    if (result.blocked) {
      expect(result.river).toBe('Rhine');
    }
    expect(mockGetRiverEdgeKeys).toHaveBeenCalledWith('Rhine');
    expect(mockSegmentCrossesRiver).toHaveBeenCalledWith(segment, fakeEdgeKeys);
  });

  it('returns blocked:false when segment does not cross the flooded river', () => {
    const fakeEdgeKeys = new Set(['99,99|99,100']);
    mockGetRiverEdgeKeys.mockReturnValue(fakeEdgeKeys);
    mockSegmentCrossesRiver.mockReturnValue(false);

    const effect = makeActiveEffect({
      cardType: EventCardType.Flood,
      floodedRiver: 'Rhine',
    });

    const result = isFloodRebuildBlocked([effect], makeTrackSegment());
    expect(result.blocked).toBe(false);
  });

  it('returns blocked:false when no active effect has a floodedRiver', () => {
    const effect = makeActiveEffect({ cardType: EventCardType.Snow });
    const result = isFloodRebuildBlocked([effect], makeTrackSegment());
    expect(result.blocked).toBe(false);
    expect(mockGetRiverEdgeKeys).not.toHaveBeenCalled();
  });

  it('returns blocked:false when getRiverEdgeKeys returns null (unknown river)', () => {
    mockGetRiverEdgeKeys.mockReturnValue(null);
    const effect = makeActiveEffect({
      cardType: EventCardType.Flood,
      floodedRiver: 'UnknownRiver',
    });
    const result = isFloodRebuildBlocked([effect], makeTrackSegment());
    expect(result.blocked).toBe(false);
  });

  it('returns blocked:false for empty effects array', () => {
    expect(isFloodRebuildBlocked([], makeTrackSegment()).blocked).toBe(false);
  });
});

// ── isBotInPendingLostTurns ───────────────────────────────────────────────────

describe('isBotInPendingLostTurns', () => {
  it('returns true when player has a pending lost turn in an active Derailment effect', () => {
    const effect = makeActiveEffect({
      cardType: EventCardType.Derailment,
      pendingLostTurns: [{ playerId: 'player-1' }],
    });
    expect(isBotInPendingLostTurns([effect], 'player-1')).toBe(true);
  });

  it('returns false when player is not in pendingLostTurns', () => {
    const effect = makeActiveEffect({
      cardType: EventCardType.Derailment,
      pendingLostTurns: [{ playerId: 'player-2' }],
    });
    expect(isBotInPendingLostTurns([effect], 'player-1')).toBe(false);
  });

  it('returns false when pendingLostTurns is empty', () => {
    const effect = makeActiveEffect({ pendingLostTurns: [] });
    expect(isBotInPendingLostTurns([effect], 'player-1')).toBe(false);
  });

  it('returns false for empty active effects', () => {
    expect(isBotInPendingLostTurns([], 'player-1')).toBe(false);
  });

  it('checks across multiple effects', () => {
    const e1 = makeActiveEffect({ pendingLostTurns: [{ playerId: 'player-2' }] });
    const e2 = makeActiveEffect({ pendingLostTurns: [{ playerId: 'player-1' }] });
    expect(isBotInPendingLostTurns([e1, e2], 'player-1')).toBe(true);
  });
});

// ── getCityMilepointKey ───────────────────────────────────────────────────────

describe('getCityMilepointKey', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns the MajorCity centre key when found', () => {
    const fakeGrid = new Map([
      ['5,10', { name: 'Berlin', terrain: TerrainType.MajorCity }],
      ['5,11', { name: 'Berlin', terrain: TerrainType.Clear }],
    ]);
    mockLoadGridPoints.mockReturnValue(fakeGrid as any);

    expect(getCityMilepointKey('Berlin')).toBe('5,10');
  });

  it('falls back to any matching milepost when no MajorCity entry exists', () => {
    const fakeGrid = new Map([
      ['3,7', { name: 'SmallTown', terrain: TerrainType.SmallCity }],
    ]);
    mockLoadGridPoints.mockReturnValue(fakeGrid as any);

    expect(getCityMilepointKey('SmallTown')).toBe('3,7');
  });

  it('returns null when city name is not found', () => {
    mockLoadGridPoints.mockReturnValue(new Map());
    expect(getCityMilepointKey('Atlantis')).toBeNull();
  });
});
