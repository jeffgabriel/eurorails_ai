/**
 * PathCostEstimator.ts
 *
 * Wraps `estimateRouteSegment` from RouteDetourEstimator.ts with:
 *  - City-name → grid-coord resolution (via loadGridPoints name search)
 *  - Per-replan module-scoped caching keyed by (fromCity, toCity, segmentsHash, speed)
 *
 * JIRA-230 Project 1 (R1): graph-aware path-cost primitive for upstream callers.
 *
 * NOTE: The exported function is named `estimateGraphPathCost` to avoid collision
 * with `estimatePathCost` in MapTopology.ts (ADR-2).
 */

import { estimateRouteSegment } from './RouteDetourEstimator';
import { loadGridPoints } from './MapTopology';
import { WorldSnapshot } from '../../../shared/types/GameTypes';

// ── Public types ───────────────────────────────────────────────────────

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

function makeCacheKey(fromCity: string, toCity: string, segmentsHash: string, trainSpeed: number): string {
  return `${fromCity}|${toCity}|${segmentsHash}|${trainSpeed}`;
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
 * Estimate the graph-aware cost of traveling from `fromCity` to `toCity`.
 *
 * Resolution:
 * - Looks up all grid coordinates for each city name via `loadGridPoints()`.
 * - For major cities with multiple outposts, selects the (from, to) pair that
 *   minimises `estimateRouteSegment(...).pathLength`.
 * - If either city resolves to no coordinates, returns `{ reachable: false, ... }`.
 *
 * Caching:
 * - Results are cached per (fromCity, toCity, existingSegmentsHash, trainSpeed).
 * - Cache is module-scoped and cleared via `clearPathCostCache()`.
 *
 * @param fromCity - Source city name (as it appears in the grid data)
 * @param toCity   - Destination city name
 * @param snapshot - WorldSnapshot providing bot track and opponent tracks
 * @param trainSpeed - Train speed in mileposts/turn (used to compute estimatedTurns)
 */
export function estimateGraphPathCost(
  fromCity: string,
  toCity: string,
  snapshot: WorldSnapshot,
  trainSpeed: number,
): PathCost {
  const segmentsHash = hashSegments(snapshot.bot.existingSegments);
  const cacheKey = makeCacheKey(fromCity, toCity, segmentsHash, trainSpeed);

  const cached = cache.get(cacheKey);
  if (cached !== undefined) {
    return cached;
  }

  const result = computePathCost(fromCity, toCity, snapshot, trainSpeed);
  cache.set(cacheKey, result);
  return result;
}

/**
 * Internal: compute path cost without caching.
 */
function computePathCost(
  fromCity: string,
  toCity: string,
  snapshot: WorldSnapshot,
  trainSpeed: number,
): PathCost {
  const fromCoords = resolveCityCoords(fromCity);
  const toCoords = resolveCityCoords(toCity);

  // Either city is unresolvable → unreachable
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

  for (const from of fromCoords) {
    for (const to of toCoords) {
      // Skip trivial same-point case early
      if (from.row === to.row && from.col === to.col) {
        const trivial: PathCost = { buildCost: 0, pathLength: 1, estimatedTurns: 1, reachable: true };
        if (bestResult === null || trivial.pathLength < bestResult.pathLength) {
          bestResult = trivial;
        }
        continue;
      }

      const estimate = estimateRouteSegment(from, to, snapshotInput);

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
