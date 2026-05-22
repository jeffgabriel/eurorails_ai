/**
 * restrictionPredicates.ts — Pure predicate functions for event-card restriction checks.
 *
 * Single source of truth for all restriction-type discrimination. Consumed by:
 *   1. PlayerService (human enforcement path — replaces 5 inline blocks)
 *   2. Bot planners (MovementPhasePlanner, BuildPhasePlanner, routeHelpers)
 *   3. GuardrailEnforcer (backstop validation)
 *
 * All functions are pure — no I/O, no DB access. Each returns a discriminated
 * union { blocked: true; ... } | { blocked: false } to avoid boolean-blindness
 * and carry the violating restriction for error-message construction.
 *
 * JIRA-256 Phase 4.
 */

import type {
  ActiveEffect,
  MovementRestriction,
  BuildRestriction,
  PickupDeliveryRestriction,
} from '../../shared/types/EventCard';
import { EventCardType } from '../../shared/types/EventCard';
import type { TrackSegment } from '../../shared/types/GameTypes';
import { getRiverEdgeKeys, segmentCrossesRiver } from './trackService';
import { loadGridPoints } from './MapTopology';
import { TerrainType } from '../../shared/types/GameTypes';

// ── Pickup / Delivery ────────────────────────────────────────────────────────

/**
 * Returns { blocked: true; restriction } if the given city key is inside a
 * no_pickup_delivery_in_zone restriction (Coastal Strike).
 *
 * @param restrictions - Array of PickupDeliveryRestrictions from active effects
 * @param cityKey - Canonical "row,col" key for the city (may be null for unknown cities)
 */
export function isPickupDeliveryBlocked(
  restrictions: PickupDeliveryRestriction[],
  cityKey: string | null,
): { blocked: true; restriction: PickupDeliveryRestriction } | { blocked: false } {
  if (!cityKey) return { blocked: false };
  for (const restriction of restrictions) {
    if (restriction.type === 'no_pickup_delivery_in_zone') {
      const zoneSet = new Set(restriction.zone);
      if (zoneSet.has(cityKey)) {
        return { blocked: true, restriction };
      }
    }
  }
  return { blocked: false };
}

// ── Movement ─────────────────────────────────────────────────────────────────

/**
 * Returns { blocked: true; restriction } if the destination milepost key is
 * in a blocked_terrain zone (Snow — movement to mountain/alpine in snow zone).
 *
 * @param restrictions - Array of MovementRestrictions from active effects
 * @param destKey - Canonical "row,col" key of the destination milepost
 */
export function isMovementBlockedAtDest(
  restrictions: MovementRestriction[],
  destKey: string,
): { blocked: true; restriction: MovementRestriction } | { blocked: false } {
  for (const restriction of restrictions) {
    if (restriction.type === 'blocked_terrain' && restriction.zone) {
      const zoneSet = new Set(restriction.zone);
      if (zoneSet.has(destKey)) {
        return { blocked: true, restriction };
      }
    }
  }
  return { blocked: false };
}

/**
 * Returns true if the given segment owner is the targeted player in a
 * no_movement_on_player_rail restriction (Rail Strike).
 *
 * Per server semantics: this check runs AFTER track usage is computed so the
 * caller knows which segments are owned by the player.
 *
 * @param restrictions - Array of MovementRestrictions from active effects
 * @param segmentOwnerId - The player who owns the track segment being traversed
 * @param playerId - The moving player's ID
 */
export function isMovementOnOwnRailBlocked(
  restrictions: MovementRestriction[],
  segmentOwnerId: string,
  playerId: string,
): boolean {
  if (segmentOwnerId !== playerId) return false;
  return restrictions.some(
    r => r.type === 'no_movement_on_player_rail' && r.targetPlayerId === playerId,
  );
}

/**
 * Returns true if the destination milepost is inside a half_rate zone.
 * The caller is responsible for applying the speed cap (bot-side only;
 * the server does not enforce half-rate on movement distance).
 *
 * @param restrictions - Array of MovementRestrictions from active effects
 * @param destKey - Canonical "row,col" key of the destination milepost
 */
export function isMovementHalfRate(
  restrictions: MovementRestriction[],
  destKey: string,
): boolean {
  return restrictions.some(r => {
    if (r.type !== 'half_rate') return false;
    if (!r.zone) return false;
    return new Set(r.zone).has(destKey);
  });
}

// ── Build ─────────────────────────────────────────────────────────────────────

/**
 * Returns { blocked: true; reason; restriction } if a build to the destination
 * is blocked by either:
 *   - 'blocked_terrain': milepost is in a Snow-blocked-terrain zone
 *   - 'no_build_for_player': Rail Strike targeting this player
 *
 * @param restrictions - Array of BuildRestrictions from active effects
 * @param segDestKey - Canonical "row,col" key of the destination milepost
 * @param playerId - The building player's ID
 */
export function isBuildBlockedAtMilepost(
  restrictions: BuildRestriction[],
  segDestKey: string,
  playerId: string,
): { blocked: true; reason: 'blocked_terrain' | 'no_build_for_player'; restriction: BuildRestriction } | { blocked: false } {
  for (const restriction of restrictions) {
    if (restriction.type === 'blocked_terrain' && restriction.zone) {
      const zoneSet = new Set(restriction.zone);
      if (zoneSet.has(segDestKey)) {
        return { blocked: true, reason: 'blocked_terrain', restriction };
      }
    }
    if (restriction.type === 'no_build_for_player' && restriction.targetPlayerId === playerId) {
      return { blocked: true, reason: 'no_build_for_player', restriction };
    }
  }
  return { blocked: false };
}

/**
 * Returns { blocked: true; river } if the segment crosses a flooded river
 * that still has an active Flood effect preventing rebuilds.
 *
 * @param activeEffects - All active effects for the game
 * @param segment - The track segment being built
 */
export function isFloodRebuildBlocked(
  activeEffects: ActiveEffect[],
  segment: TrackSegment,
): { blocked: true; river: string } | { blocked: false } {
  for (const effect of activeEffects) {
    if (effect.cardType === EventCardType.Flood && effect.floodedRiver) {
      const riverEdgeKeys = getRiverEdgeKeys(effect.floodedRiver);
      if (riverEdgeKeys && segmentCrossesRiver(segment, riverEdgeKeys)) {
        return { blocked: true, river: effect.floodedRiver };
      }
    }
  }
  return { blocked: false };
}

// ── Derailment: lost-turn check ───────────────────────────────────────────────

/**
 * Returns true if the player has a pending lost turn from a Derailment event.
 * When true, the bot must emit PassTurn only and the server must consume
 * the lost turn via ActiveEffectManager.consumeLostTurn.
 *
 * @param activeEffects - All active effects for the game
 * @param playerId - The player to check
 */
export function isBotInPendingLostTurns(
  activeEffects: ActiveEffect[],
  playerId: string,
): boolean {
  return activeEffects.some(effect =>
    effect.pendingLostTurns.some(p => p.playerId === playerId),
  );
}

// ── City-milepost key helper ─────────────────────────────────────────────────

/**
 * Return the canonical milepost key ("row,col") for a city name by looking
 * up the MapTopology grid. Returns null if the city is not found.
 *
 * Extracted from PlayerService.getCityMilepointKey (was private static).
 * Exposed here so both PlayerService and bot planners use the same lookup.
 *
 * @param cityName - Display name of the city (e.g. "Paris", "Hamburg")
 */
export function getCityMilepointKey(cityName: string): string | null {
  const grid = loadGridPoints();
  // Prefer MajorCity center; fall back to any milepost with matching name
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
