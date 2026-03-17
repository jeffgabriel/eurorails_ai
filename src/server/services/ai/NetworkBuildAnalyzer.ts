/**
 * NetworkBuildAnalyzer — Pre-build network shape analysis for AI track building.
 *
 * Provides nearest-network-point search (BFS) and parallel path detection
 * to prevent redundant/parallel track construction. Integrated into
 * ActionResolver.resolveBuild() as a pre- and post-build analysis layer.
 */

import { TrackSegment } from '../../../shared/types/GameTypes';
import {
  GridCoord,
  GridPointData,
  getHexNeighbors,
  getTerrainCost,
  makeKey,
} from './MapTopology';

/** Result of parallel path detection against existing track */
export interface ParallelDetection {
  isParallel: boolean;
  parallelSegmentCount: number;
  suggestedWaypoint?: GridCoord;
  existingTrackNearby?: GridCoord[];
}

/** Result of nearest network point BFS search */
export interface NearestNetworkResult {
  point: GridCoord;
  distance: number;
  buildCost: number;
}

/**
 * Static utility class for pre-build network analysis.
 *
 * All methods are pure functions — no database access, no side effects.
 * Reuses MapTopology helpers for hex neighbor traversal and terrain costs.
 */
export class NetworkBuildAnalyzer {
  /**
   * BFS outward from a target city position to find the closest node
   * in the existing track network.
   *
   * @param targetPosition - City grid position to search from
   * @param networkNodeKeys - Set of "row,col" strings representing existing network nodes
   * @param gridPoints - Loaded grid point data map
   * @param maxDistance - Maximum BFS depth (default 8)
   * @returns Nearest network point with distance and build cost, or null
   */
  static findNearestNetworkPoint(
    targetPosition: GridCoord,
    networkNodeKeys: Set<string>,
    gridPoints: Map<string, GridPointData>,
    maxDistance: number = 8,
  ): NearestNetworkResult | null {
    const startKey = makeKey(targetPosition.row, targetPosition.col);

    // If the target is already on the network, return distance 0
    if (networkNodeKeys.has(startKey)) {
      return { point: { row: targetPosition.row, col: targetPosition.col }, distance: 0, buildCost: 0 };
    }

    // Empty network — nothing to find
    if (networkNodeKeys.size === 0) {
      return null;
    }

    // BFS state: queue entries carry (position, distance from target, accumulated build cost)
    const visited = new Set<string>();
    visited.add(startKey);

    interface BfsNode {
      row: number;
      col: number;
      distance: number;
      buildCost: number;
    }

    let currentLevel: BfsNode[] = [{ row: targetPosition.row, col: targetPosition.col, distance: 0, buildCost: 0 }];

    while (currentLevel.length > 0 ) {
      const nextLevel: BfsNode[] = [];

      for (const node of currentLevel) {
        const neighbors = getHexNeighbors(node.row, node.col);

        for (const neighbor of neighbors) {
          const neighborKey = makeKey(neighbor.row, neighbor.col);
          if (visited.has(neighborKey)) continue;
          visited.add(neighborKey);

          const gp = gridPoints.get(neighborKey);
          if (!gp) continue; // off-map

          const terrainCost = getTerrainCost(gp.terrain);
          if (!isFinite(terrainCost)) continue; // unbuildable (water)

          const newDistance = node.distance + 1;
          if (newDistance > maxDistance) continue;

          const newBuildCost = node.buildCost + terrainCost;

          // Found a network node — BFS guarantees shortest distance
          if (networkNodeKeys.has(neighborKey)) {
            return { point: { row: neighbor.row, col: neighbor.col }, distance: newDistance, buildCost: newBuildCost };
          }

          nextLevel.push({ row: neighbor.row, col: neighbor.col, distance: newDistance, buildCost: newBuildCost });
        }
      }

      currentLevel = nextLevel;
    }

    return null;
  }

  /**
   * Analyze a proposed build path for parallel segments running alongside
   * existing track (within 1-2 hexes for 3+ consecutive segments).
   *
   * @param proposedPath - Array of grid coordinates for the proposed build
   * @param existingSegments - Bot's existing track segments
   * @param gridPoints - Loaded grid point data map
   * @returns Detection result with parallel info and suggested waypoint
   */
  static detectParallelPath(
    proposedPath: GridCoord[],
    existingSegments: TrackSegment[],
    _gridPoints: Map<string, GridPointData>,
  ): ParallelDetection {
    if (proposedPath.length < 3) {
      return { isParallel: false, parallelSegmentCount: 0 };
    }

    // Build set of existing network node keys from segments
    const existingNodeKeys = new Set<string>();
    for (const seg of existingSegments) {
      existingNodeKeys.add(makeKey(seg.from.row, seg.from.col));
      existingNodeKeys.add(makeKey(seg.to.row, seg.to.col));
    }

    if (existingNodeKeys.size === 0) {
      return { isParallel: false, parallelSegmentCount: 0 };
    }

    // For each point in the proposed path, check if any hex within 1-2 hops
    // is in the existing network (excluding the point itself being on the network,
    // which would be an intersection, not parallel)
    const nearbyPoints: (GridCoord | null)[] = proposedPath.map((point) => {
      const pointKey = makeKey(point.row, point.col);
      // If the proposed point IS on the network, it's an intersection, not parallel
      if (existingNodeKeys.has(pointKey)) return null;

      // Check 1-hop neighbors
      const hop1 = getHexNeighbors(point.row, point.col);
      for (const n1 of hop1) {
        if (existingNodeKeys.has(makeKey(n1.row, n1.col))) {
          return { row: n1.row, col: n1.col };
        }
      }

      // Check 2-hop neighbors
      for (const n1 of hop1) {
        const hop2 = getHexNeighbors(n1.row, n1.col);
        for (const n2 of hop2) {
          if (existingNodeKeys.has(makeKey(n2.row, n2.col))) {
            return { row: n2.row, col: n2.col };
          }
        }
      }

      return null;
    });

    // Find the longest run of consecutive points with nearby existing track
    let bestRunStart = 0;
    let bestRunLength = 0;
    let currentRunStart = 0;
    let currentRunLength = 0;

    for (let i = 0; i < nearbyPoints.length; i++) {
      if (nearbyPoints[i] !== null) {
        if (currentRunLength === 0) currentRunStart = i;
        currentRunLength++;
        if (currentRunLength > bestRunLength) {
          bestRunLength = currentRunLength;
          bestRunStart = currentRunStart;
        }
      } else {
        currentRunLength = 0;
      }
    }

    const PARALLEL_THRESHOLD = 3;
    if (bestRunLength < PARALLEL_THRESHOLD) {
      return { isParallel: false, parallelSegmentCount: bestRunLength };
    }

    // Collect all nearby existing track points from the best run
    const existingTrackNearby: GridCoord[] = [];
    const seen = new Set<string>();
    for (let i = bestRunStart; i < bestRunStart + bestRunLength; i++) {
      const nearby = nearbyPoints[i]!;
      const key = makeKey(nearby.row, nearby.col);
      if (!seen.has(key)) {
        seen.add(key);
        existingTrackNearby.push(nearby);
      }
    }

    // Suggest the midpoint of the parallel run's nearby track as the waypoint
    const midIdx = Math.floor(existingTrackNearby.length / 2);
    const suggestedWaypoint = existingTrackNearby[midIdx];

    return {
      isParallel: true,
      parallelSegmentCount: bestRunLength,
      suggestedWaypoint,
      existingTrackNearby,
    };
  }
}
