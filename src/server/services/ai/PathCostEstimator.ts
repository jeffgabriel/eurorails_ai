/**
 * PathCostEstimator.ts
 *
 * Wraps `estimateRouteSegment` from RouteDetourEstimator.ts with:
 *  - City-name → grid-coord resolution (via loadGridPoints name search)
 *  - Per-replan module-scoped caching keyed by (fromCity, toCity, segmentsHash, speed)
 *
 * JIRA-230 Project 1 (R1): graph-aware path-cost primitive for upstream callers.
 * JIRA-230 Project 2 BE-001: extended to accept GridCoord inputs for from/to.
 *
 * NOTE: The exported function is named `estimateGraphPathCost` to avoid collision
 * with `estimatePathCost` in MapTopology.ts (ADR-2).
 */

import { estimateRouteSegment } from './RouteDetourEstimator';
import { loadGridPoints } from '../MapTopology';
import { WorldSnapshot, TrackSegment } from '../../../shared/types/GameTypes';

// ── Public types ───────────────────────────────────────────────────────

/** A grid coordinate (row, col) pair — used as an alternative to city names. */
export interface GridCoord {
  row: number;
  col: number;
}

/** Result of a graph-aware path cost estimate between two named cities. */
export interface PathCost {
  /** Total ECU cost to build new track segments (0 when fully on existing network). */
  buildCost: number;
  /** Total mileposts in the cheapest playable path (existing + new segments). */
  pathLength: number;
  /** Movement turns required: ceil(pathLength / trainSpeed). */
  estimatedTurns: number;
  /** false when no path exists (e.g. opponent track blocks all routes, or city unresolvable). */
  reachable: boolean;
  /**
   * The new track segments this leg would need to build. Surfaced so callers
   * can compose snapshots between sequential leg calculations (e.g. supply →
   * delivery): the supply leg's new segments become free traversal for the
   * delivery leg. Empty when the path is fully on existing track. Optional
   * for back-compat with callers that don't need composition.
   */
  newSegments?: TrackSegment[];
}

// ── Module-scoped cache ────────────────────────────────────────────────

/** Module-scoped cache: cleared on demand for test isolation. */
const cache: Map<string, PathCost> = new Map();

/**
 * Clear the path cost cache. Call from tests between test cases to ensure isolation.
 * Production code does not need to call this — the segments hash invalidates
 * correctly when the bot builds new track.
 */
export function clearPathCostCache(): void {
  cache.clear();
}

// ── Cache key helpers ──────────────────────────────────────────────────

/**
 * Build a cheap rolling hash of existing track segments.
 * Not cryptographic — just deterministic enough to detect cache invalidation.
 */
function hashSegments(segments: Array<{ from: { row: number; col: number }; to: { row: number; col: number } }>): string {
  if (segments.length === 0) return 'empty';
  // Sort for stability: segment order in the array may vary
  const parts = segments
    .map((s) => `${s.from.row},${s.from.col}-${s.to.row},${s.to.col}`)
    .sort();
  return parts.join('|');
}

/** Serialize a city name or GridCoord to a stable string for cache keying. */
function serializeInput(input: string | GridCoord): string {
  if (typeof input === 'string') return `name:${input}`;
  return `coord:${input.row},${input.col}`;
}

function makeCacheKey(from: string | GridCoord, to: string | GridCoord, segmentsHash: string, trainSpeed: number): string {
  return `${serializeInput(from)}|${serializeInput(to)}|${segmentsHash}|${trainSpeed}`;
}

// ── City resolution ────────────────────────────────────────────────────

/** Resolve a city name to all matching grid coordinates. */
function resolveCityCoords(cityName: string): Array<{ row: number; col: number }> {
  const grid = loadGridPoints();
  const coords: Array<{ row: number; col: number }> = [];
  for (const [, data] of grid.entries()) {
    if (data.name === cityName) {
      coords.push({ row: data.row, col: data.col });
    }
  }
  return coords;
}

// ── Unreachable sentinel ───────────────────────────────────────────────

const UNREACHABLE: PathCost = { buildCost: 0, pathLength: 0, estimatedTurns: 0, reachable: false };

// ── Main function ──────────────────────────────────────────────────────

/**
 * Estimate the graph-aware cost of traveling from `from` to `to`.
 *
 * Accepts either a city name (string) or a raw grid coordinate (GridCoord) for
 * each endpoint. When a GridCoord is passed, city-name resolution is skipped and
 * the coord is used directly with `estimateRouteSegment`. This allows callers to
 * pass bot mid-track positions without resolving them to a city name first.
 *
 * Resolution (string inputs):
 * - Looks up all grid coordinates for each city name via `loadGridPoints()`.
 * - For major cities with multiple outposts, selects the (from, to) pair that
 *   minimises `estimateRouteSegment(...).pathLength`.
 * - If either city resolves to no coordinates, returns `{ reachable: false, ... }`.
 *
 * Caching:
 * - Results are cached per (from, to, existingSegmentsHash, trainSpeed).
 * - Cache is module-scoped and cleared via `clearPathCostCache()`.
 *
 * @param from       - Source: city name string or GridCoord
 * @param to         - Destination: city name string or GridCoord
 * @param snapshot   - WorldSnapshot providing bot track and opponent tracks
 * @param trainSpeed - Train speed in mileposts/turn (used to compute estimatedTurns)
 */
export function estimateGraphPathCost(
  from: string | GridCoord,
  to: string | GridCoord,
  snapshot: WorldSnapshot,
  trainSpeed: number,
): PathCost {
  const segmentsHash = hashSegments(snapshot.bot.existingSegments);
  const cacheKey = makeCacheKey(from, to, segmentsHash, trainSpeed);

  const cached = cache.get(cacheKey);
  if (cached !== undefined) {
    return cached;
  }

  const result = computePathCost(from, to, snapshot, trainSpeed);
  cache.set(cacheKey, result);
  return result;
}

/**
 * Internal: compute path cost without caching.
 */
function computePathCost(
  from: string | GridCoord,
  to: string | GridCoord,
  snapshot: WorldSnapshot,
  trainSpeed: number,
): PathCost {
  // Resolve inputs to arrays of coords
  const fromCoords: Array<{ row: number; col: number }> =
    typeof from === 'string' ? resolveCityCoords(from) : [from];
  const toCoords: Array<{ row: number; col: number }> =
    typeof to === 'string' ? resolveCityCoords(to) : [to];

  // Either endpoint is unresolvable → unreachable
  if (fromCoords.length === 0 || toCoords.length === 0) {
    return { ...UNREACHABLE };
  }

  // Build snapshot shape compatible with estimateRouteSegment's SnapshotInput
  const snapshotInput = {
    bot: {
      playerId: snapshot.bot.playerId,
      existingSegments: snapshot.bot.existingSegments,
      trainType: snapshot.bot.trainType,
      ferryHalfSpeed: snapshot.bot.ferryHalfSpeed ?? false,
    },
    allPlayerTracks: snapshot.allPlayerTracks,
  };

  // For single-coordinate cities, use the only available coord.
  // For multi-coordinate major cities, pick the (from, to) pair that
  // minimises pathLength (nearest outpost heuristic).
  let bestResult: PathCost | null = null;

  for (const fromCoord of fromCoords) {
    for (const toCoord of toCoords) {
      // Skip trivial same-point case early.
      // Same-city pickups/deliveries consume zero turns per game rules — the
      // train is already at the location, so no movement is required.
      if (fromCoord.row === toCoord.row && fromCoord.col === toCoord.col) {
        const trivial: PathCost = { buildCost: 0, pathLength: 1, estimatedTurns: 0, reachable: true, newSegments: [] };
        if (bestResult === null || trivial.pathLength < bestResult.pathLength) {
          bestResult = trivial;
        }
        continue;
      }

      const estimate = estimateRouteSegment(fromCoord, toCoord, snapshotInput);

      if (!estimate.reachable) {
        // This pair is blocked; continue trying other outpost combinations
        continue;
      }

      const estimatedTurns = Math.ceil(estimate.pathLength / Math.max(trainSpeed, 1));
      const candidate: PathCost = {
        buildCost: estimate.buildCost,
        pathLength: estimate.pathLength,
        estimatedTurns,
        reachable: true,
        newSegments: estimate.newSegments,
      };

      if (bestResult === null || candidate.pathLength < bestResult.pathLength) {
        bestResult = candidate;
      }
    }
  }

  if (bestResult === null) {
    // All coord pairs were blocked
    return { ...UNREACHABLE };
  }

  return bestResult;
}
