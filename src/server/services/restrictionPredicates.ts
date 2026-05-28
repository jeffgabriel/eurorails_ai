/**
 * restrictionPredicates.ts — Pure predicate functions for event card restriction checks.
 *
 * All functions are stateless and side-effect-free.  They operate on already-
 * resolved restriction arrays (from ActiveEffectManager) so callers don't need
 * to know how restrictions are stored.
 *
 * Discriminated unions are returned wherever the caller needs the matching
 * restriction object (e.g. to surface an error message), rather than a plain
 * boolean.
 */

import {
  ActiveEffect,
  BuildRestriction,
  MovementRestriction,
  PickupDeliveryRestriction,
} from '../../shared/types/EventCard';
import { TrackSegment } from '../../shared/types/TrackTypes';
import { getRiverEdgeKeys, segmentCrossesRiver } from './trackService';
import { loadGridPoints } from './MapTopology';
import { TerrainType } from '../../shared/types/GameTypes';

// ── Pickup / Delivery ────────────────────────────────────────────────────────

/**
 * Return the first PickupDeliveryRestriction that blocks the given city milepost
 * key, or { blocked: false } if none applies.
 */
export function isPickupDeliveryBlocked(
  restrictions: PickupDeliveryRestriction[],
  cityKey: string,
): { blocked: true; restriction: PickupDeliveryRestriction } | { blocked: false } {
  for (const restriction of restrictions) {
    if (restriction.zone.includes(cityKey)) {
      return { blocked: true, restriction };
    }
  }
  return { blocked: false };
}

// ── Movement ─────────────────────────────────────────────────────────────────

/**
 * Return the first MovementRestriction of type 'blocked_terrain' that blocks
 * movement to `destKey`, or { blocked: false } if none applies.
 */
export function isMovementBlockedAtDest(
  restrictions: MovementRestriction[],
  destKey: string,
): { blocked: true; restriction: MovementRestriction } | { blocked: false } {
  for (const restriction of restrictions) {
    if (restriction.type === 'blocked_terrain' && restriction.zone?.includes(destKey)) {
      return { blocked: true, restriction };
    }
  }
  return { blocked: false };
}

/**
 * Return true when a Rail-Strike is active that prevents `playerId` from
 * moving on their own rail.  The segment's owner must match the drawing player
 * targeted by the restriction.
 */
export function isMovementOnOwnRailBlocked(
  restrictions: MovementRestriction[],
  segmentOwnerId: string,
  playerId: string,
): boolean {
  if (segmentOwnerId !== playerId) {
    return false;
  }
  return restrictions.some(
    r => r.type === 'no_movement_on_player_rail' && r.targetPlayerId === playerId,
  );
}

/**
 * Return true when a Snow event is active and `destKey` falls within the
 * half-rate zone.
 */
export function isMovementHalfRate(
  restrictions: MovementRestriction[],
  destKey: string,
): boolean {
  return restrictions.some(
    r => r.type === 'half_rate' && r.zone?.includes(destKey),
  );
}

// ── Build ────────────────────────────────────────────────────────────────────

/**
 * Return the first BuildRestriction that blocks building at `segDestKey` for
 * `playerId`, or { blocked: false } if none applies.
 *
 * The returned discriminated union includes a `reason` field so callers can
 * produce a specific error message without inspecting restriction internals.
 */
export function isBuildBlockedAtMilepost(
  restrictions: BuildRestriction[],
  segDestKey: string,
  playerId: string,
):
  | { blocked: true; reason: 'blocked_terrain' | 'no_build_for_player'; restriction: BuildRestriction }
  | { blocked: false } {
  for (const restriction of restrictions) {
    if (restriction.type === 'blocked_terrain' && restriction.zone?.includes(segDestKey)) {
      return { blocked: true, reason: 'blocked_terrain', restriction };
    }
    if (restriction.type === 'no_build_for_player' && restriction.targetPlayerId === playerId) {
      return { blocked: true, reason: 'no_build_for_player', restriction };
    }
  }
  return { blocked: false };
}

// ── Flood ────────────────────────────────────────────────────────────────────

/**
 * Return { blocked: true, river } when an active Flood effect prevents
 * rebuilding `segment` (i.e. the segment crosses the flooded river).
 * Returns { blocked: false } otherwise.
 */
export function isFloodRebuildBlocked(
  activeEffects: ActiveEffect[],
  segment: TrackSegment,
): { blocked: true; river: string } | { blocked: false } {
  for (const effect of activeEffects) {
    const river = effect.floodedRiver;
    if (!river) {
      continue;
    }

    const riverEdgeKeys = getRiverEdgeKeys(river);
    if (!riverEdgeKeys) {
      continue;
    }

    if (segmentCrossesRiver(segment, riverEdgeKeys)) {
      return { blocked: true, river };
    }
  }
  return { blocked: false };
}

// ── Derailment / Lost Turn ───────────────────────────────────────────────────

/**
 * Return true when `playerId` has a pending lost turn recorded in any active
 * Derailment effect.
 */
export function isBotInPendingLostTurns(
  activeEffects: ActiveEffect[],
  playerId: string,
): boolean {
  return activeEffects.some(effect =>
    effect.pendingLostTurns.some(entry => entry.playerId === playerId),
  );
}

// ── City key helper ───────────────────────────────────────────────────────────

/**
 * Return the canonical milepost key ("row,col") for a named city by looking it
 * up in the grid.  Prefers a MajorCity centre point; falls back to any point
 * whose name matches.  Returns null if the city is not found.
 *
 * Extracted from PlayerService so that restriction predicates and the bot
 * planner can share this lookup without depending on the full service.
 */
export function getCityMilepointKey(cityName: string): string | null {
  const grid = loadGridPoints();

  for (const [key, point] of grid) {
    if (point.name === cityName && point.terrain === TerrainType.MajorCity) {
      return key;
    }
  }

  for (const [key, point] of grid) {
    if (point.name === cityName) {
      return key;
    }
  }

  return null;
}
