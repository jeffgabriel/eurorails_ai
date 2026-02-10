/**
 * MovementValidator — shared, environment-agnostic service for validating
 * train movement paths.  Used by the AI pipeline server-side and potentially
 * by future human-player server-side validation.
 */

import type { GridPoint } from '../types/GameTypes';
import { TerrainType, TRAIN_PROPERTIES } from '../types/GameTypes';
import type { WorldSnapshot } from '../../server/ai/types';
import { buildUnionTrackGraph } from './trackUsageFees';
import { getMajorCityGroups, getFerryEdges, type MajorCityGroup, type FerryEdge } from './majorCityGroups';

// --- Result type ---

export interface MovementValidationResult {
  valid: boolean;
  reason?: string;
  /** Total movement points consumed by this path. */
  movementCost?: number;
}

// --- Helpers ---

function nodeKey(n: { row: number; col: number }): string {
  return `${n.row},${n.col}`;
}

/**
 * Hex-grid adjacency check.
 * Even rows: neighbors on adjacent rows shift left (col, col-1).
 * Odd rows: neighbors on adjacent rows shift right (col, col+1).
 */
export function isHexAdjacent(
  a: { row: number; col: number },
  b: { row: number; col: number },
): boolean {
  const rowDiff = b.row - a.row;
  const colDiff = b.col - a.col;

  // Same row: only adjacent if exactly 1 column apart
  if (rowDiff === 0) {
    return Math.abs(colDiff) === 1;
  }

  // Must be exactly 1 row apart
  if (Math.abs(rowDiff) !== 1) {
    return false;
  }

  if (rowDiff === 1) {
    // Moving down
    const isFromOddRow = a.row % 2 === 1;
    if (isFromOddRow) {
      return colDiff === 0 || colDiff === 1;
    } else {
      return colDiff === 0 || colDiff === -1;
    }
  } else {
    // Moving up (rowDiff === -1)
    const isToOddRow = b.row % 2 === 1;
    if (isToOddRow) {
      return colDiff === 0 || colDiff === -1;
    } else {
      return colDiff === 0 || colDiff === 1;
    }
  }
}

function isTerrainCityOrFerry(terrain: TerrainType): boolean {
  return (
    terrain === TerrainType.MajorCity ||
    terrain === TerrainType.MediumCity ||
    terrain === TerrainType.SmallCity ||
    terrain === TerrainType.FerryPort
  );
}

/**
 * Returns the city name that a point belongs to, or null if not in a city.
 * Handles major city centers and outposts.
 */
function getCityForPoint(
  row: number,
  col: number,
  majorCityGroups: MajorCityGroup[],
  mapPointLookup: Map<string, GridPoint>,
): string | null {
  // Check if the point itself has city data
  const point = mapPointLookup.get(nodeKey({ row, col }));
  if (point?.city?.name) return point.city.name;

  // Check major city groups for outpost membership
  for (const group of majorCityGroups) {
    const key = nodeKey({ row, col });
    if (nodeKey(group.center) === key) return group.cityName;
    for (const outpost of group.outposts) {
      if (nodeKey(outpost) === key) return group.cityName;
    }
  }

  return null;
}

/**
 * Build a ferry connection lookup: nodeKey -> { otherSideKey, ferryEdge }.
 */
function buildFerryLookup(
  ferryEdges: FerryEdge[],
): Map<string, { otherSideKey: string; ferry: FerryEdge }> {
  const lookup = new Map<string, { otherSideKey: string; ferry: FerryEdge }>();
  for (const ferry of ferryEdges) {
    const aKey = nodeKey(ferry.pointA);
    const bKey = nodeKey(ferry.pointB);
    lookup.set(aKey, { otherSideKey: bKey, ferry });
    lookup.set(bKey, { otherSideKey: aKey, ferry });
  }
  return lookup;
}

// --- Main validator ---

export class MovementValidator {
  /**
   * Validate a move path against the game state in a WorldSnapshot.
   *
   * @param snapshot - Immutable game state snapshot
   * @param path - Array of GridPoints forming the proposed path (first point = current position)
   * @returns Validation result with reason on failure
   */
  static validateMovePath(
    snapshot: WorldSnapshot,
    path: GridPoint[],
  ): MovementValidationResult {
    if (path.length < 2) {
      return { valid: false, reason: 'Path must contain at least 2 points (start + destination)' };
    }

    const majorCityGroups = getMajorCityGroups();
    const ferryEdges = getFerryEdges();
    const ferryLookup = buildFerryLookup(ferryEdges);

    // Build map-point lookup for terrain/city queries
    const mapPointLookup = new Map<string, GridPoint>();
    for (const mp of snapshot.mapPoints) {
      mapPointLookup.set(nodeKey({ row: mp.row, col: mp.col }), mp);
    }

    // Build union track graph for connectivity checks
    const { adjacency } = buildUnionTrackGraph({
      allTracks: snapshot.allPlayerTracks,
      majorCityGroups,
      ferryEdges,
    });

    // Train speed
    const maxMovement = TRAIN_PROPERTIES[snapshot.trainType]?.speed ?? 9;
    let movementBudget = snapshot.remainingMovement;

    // --- Initial placement validation ---
    if (!snapshot.position) {
      const firstPoint = path[0];
      if (firstPoint.terrain !== TerrainType.MajorCity) {
        return { valid: false, reason: 'Initial placement must be at a Major City' };
      }
      // For initial placement, the "path" starts at the placed city
      // The full movement budget is available
      movementBudget = maxMovement;
    } else {
      // Verify path starts at current position
      const startPoint = path[0];
      if (startPoint.row !== snapshot.position.row || startPoint.col !== snapshot.position.col) {
        return { valid: false, reason: 'Path must start at the train\'s current position' };
      }
    }

    let totalCost = 0;
    let lastEdgeFromKey: string | null = null;
    let lastEdgeToKey: string | null = null;

    for (let i = 0; i < path.length - 1; i++) {
      const from = path[i];
      const to = path[i + 1];
      const fromKey = nodeKey(from);
      const toKey = nodeKey(to);

      // 1. Adjacency or ferry connection check
      const isFerryEdge = ferryLookup.has(fromKey) &&
        ferryLookup.get(fromKey)!.otherSideKey === toKey;
      const isAdjacent = isHexAdjacent(from, to);

      if (!isAdjacent && !isFerryEdge) {
        return { valid: false, reason: `Points are not adjacent at step ${i}: (${from.row},${from.col}) to (${to.row},${to.col})` };
      }

      // 2. Track connectivity: path must exist in the union graph
      const fromNeighbors = adjacency.get(fromKey);
      if (!fromNeighbors || !fromNeighbors.has(toKey)) {
        // Exception: major city internal movement is always allowed
        const fromCity = getCityForPoint(from.row, from.col, majorCityGroups, mapPointLookup);
        const toCity = getCityForPoint(to.row, to.col, majorCityGroups, mapPointLookup);
        if (!(fromCity && toCity && fromCity === toCity)) {
          return { valid: false, reason: `No track connects (${from.row},${from.col}) to (${to.row},${to.col})` };
        }
      }

      // 3. Reversal detection
      if (lastEdgeFromKey !== null && lastEdgeToKey !== null) {
        // Check exact edge reversal: A->B then B->A
        const isExactReversal = (fromKey === lastEdgeToKey && toKey === lastEdgeFromKey);
        if (isExactReversal) {
          if (!isTerrainCityOrFerry(from.terrain)) {
            return { valid: false, reason: 'Reversal only allowed at cities or ferry ports' };
          }
        }
      }

      // 4. Movement cost
      const fromCity = getCityForPoint(from.row, from.col, majorCityGroups, mapPointLookup);
      const toCity = getCityForPoint(to.row, to.col, majorCityGroups, mapPointLookup);
      const isSameCity = fromCity !== null && toCity !== null && fromCity === toCity;

      // City-internal movement is free; everything else costs 1 milepost
      const stepCost = isSameCity ? 0 : 1;
      totalCost += stepCost;

      // 5. Ferry handling: arriving at ferry ends movement
      if (isFerryEdge) {
        // Ferry crossing: cost is 0 movement points but ends the turn
        // We don't add cost but the path should end here
      }

      // Track last edge for reversal detection
      lastEdgeFromKey = fromKey;
      lastEdgeToKey = toKey;
    }

    // Movement budget check
    if (totalCost > movementBudget) {
      return {
        valid: false,
        reason: `Path costs ${totalCost} movement points but only ${movementBudget} remaining`,
      };
    }

    return { valid: true, movementCost: totalCost };
  }
}
