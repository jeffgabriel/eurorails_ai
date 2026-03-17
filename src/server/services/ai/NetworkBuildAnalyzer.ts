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
    _proposedPath: GridCoord[],
    _existingSegments: TrackSegment[],
    _gridPoints: Map<string, GridPointData>,
  ): ParallelDetection {
    // Implementation in BE-003
    return { isParallel: false, parallelSegmentCount: 0 };
  }
}
