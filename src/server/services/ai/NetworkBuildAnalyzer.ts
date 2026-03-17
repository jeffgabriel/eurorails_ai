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
import { getFerryEdges, type FerryEdge } from '../../../shared/services/majorCityGroups';

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

/** A ferry port reachable from the existing network via a short spur */
export interface FerryOpportunity {
  ferryName: string;
  networkPoint: { row: number; col: number };
  ferryPort: { row: number; col: number };
  spurCost: number;
  ferryCost: number;
  destinationSide: { row: number; col: number };
}

/** A demand city reachable from the existing network via a short spur */
export interface SpurOpportunity {
  city: string;
  nearestNetworkPoint: { row: number; col: number };
  spurCost: number;
  spurSegments: number;
}

/** Result of cost-per-turn build option evaluation */
export interface BuildOptionEvaluation {
  turnsSaved: number;
  buildCost: number;
  valuePerTurn: number;
  isWorthwhile: boolean;
}

/**
 * Static utility class for pre-build network analysis.
 *
 * All methods are pure functions — no database access, no side effects.
 * Reuses MapTopology helpers for hex neighbor traversal and terrain costs.
 */
/** Minimum segment count before network analysis is worthwhile */
const MIN_SEGMENTS_FOR_ANALYSIS = 3;

const LOG_PREFIX = '[NetworkBuildAnalyzer]';

export class NetworkBuildAnalyzer {
  /** Check whether network analysis should be skipped (early game / too few segments) */
  static shouldSkipAnalysis(existingSegments: TrackSegment[]): boolean {
    if (existingSegments.length < MIN_SEGMENTS_FOR_ANALYSIS) {
      console.log(`${LOG_PREFIX} Skipping analysis — network too small (${existingSegments.length} segments < ${MIN_SEGMENTS_FOR_ANALYSIS})`);
      return true;
    }
    return false;
  }

  /** Log nearest-network-point search results */
  static logNearestPointResult(
    targetCity: string,
    result: NearestNetworkResult | null,
    maxDistance: number,
  ): void {
    if (result) {
      console.log(`${LOG_PREFIX} Nearest network point to ${targetCity}: (${result.point.row},${result.point.col}) at ${result.distance} segments, buildCost=${result.buildCost}M`);
    } else {
      console.log(`${LOG_PREFIX} No network point within ${maxDistance} segments of ${targetCity}`);
    }
  }

  /** Log parallel path detection results */
  static logParallelDetection(detection: ParallelDetection): void {
    if (detection.isParallel && detection.suggestedWaypoint) {
      console.log(`${LOG_PREFIX} Parallel path detected: ${detection.parallelSegmentCount} segments within 1-2 hexes of existing track near (${detection.suggestedWaypoint.row},${detection.suggestedWaypoint.col})`);
    }
  }

  /** Log reroute decision */
  static logRerouteDecision(waypoint: GridCoord, savedSegments: number): void {
    console.log(`${LOG_PREFIX} Rerouting build through existing track at (${waypoint.row},${waypoint.col}) — saves ${savedSegments} segments`);
  }

  /** Log reroute fallback when rerouted path exceeds budget */
  static logRerouteFallback(cost: number, budget: number): void {
    console.log(`${LOG_PREFIX} Rerouted path exceeds budget (${cost}M > ${budget}M), using original path`);
  }

  /** Log unexpected errors during analysis (graceful degradation) */
  static logAnalysisError(error: unknown): void {
    console.warn(`${LOG_PREFIX} Network analysis failed, falling back to default behavior:`, error);
  }

  /** Cached ferry edge data, loaded once from configuration files */
  private static ferryEdgeCache: FerryEdge[] | null = null;

  /**
   * Load ferry edge data with caching. Wraps getFerryEdges() from majorCityGroups.
   * Returns empty array on failure (graceful degradation).
   */
  static loadFerryData(): FerryEdge[] {
    if (NetworkBuildAnalyzer.ferryEdgeCache) return NetworkBuildAnalyzer.ferryEdgeCache;
    try {
      NetworkBuildAnalyzer.ferryEdgeCache = getFerryEdges();
      return NetworkBuildAnalyzer.ferryEdgeCache;
    } catch (error) {
      console.warn(`${LOG_PREFIX} Ferry data loading failed, returning empty opportunities:`, error);
      return [];
    }
  }

  /** Reset ferry cache (for testing) */
  static _resetFerryCache(): void {
    NetworkBuildAnalyzer.ferryEdgeCache = null;
  }

  /**
   * BFS outward from each ferry port to find connections to the existing network.
   * For each ferry, checks both port positions and returns opportunities where
   * the network is within maxDistance segments of a port.
   *
   * @param networkNodeKeys - Set of "row,col" strings representing existing network nodes
   * @param gridPoints - Loaded grid point data map
   * @param ferryData - Parsed ferry edges (defaults to cached ferry data)
   * @param maxDistance - Maximum BFS depth from ferry port (default 4)
   * @returns Array of ferry opportunities sorted by spurCost ascending
   */
  static findNearbyFerryPorts(
    networkNodeKeys: Set<string>,
    gridPoints: Map<string, GridPointData>,
    ferryData?: FerryEdge[],
    maxDistance: number = 4,
  ): FerryOpportunity[] {
    const edges = ferryData ?? NetworkBuildAnalyzer.loadFerryData();
    if (edges.length === 0) return [];

    const opportunities: FerryOpportunity[] = [];

    for (const ferry of edges) {
      // Check both sides of the ferry
      const sides: [{ row: number; col: number }, { row: number; col: number }][] = [
        [ferry.pointA, ferry.pointB],
        [ferry.pointB, ferry.pointA],
      ];

      for (const [port, destination] of sides) {
        const portKey = makeKey(port.row, port.col);

        // If the port itself is on the network, distance is 0
        if (networkNodeKeys.has(portKey)) {
          opportunities.push({
            ferryName: ferry.name,
            networkPoint: { row: port.row, col: port.col },
            ferryPort: { row: port.row, col: port.col },
            spurCost: 0,
            ferryCost: ferry.cost,
            destinationSide: { row: destination.row, col: destination.col },
          });
          console.log(`${LOG_PREFIX} Ferry near-miss: ${ferry.name} — network at (${port.row},${port.col}) is 0 segments from port, spurCost=0M`);
          continue;
        }

        // BFS outward from the ferry port toward the network
        const result = NetworkBuildAnalyzer.findNearestNetworkPoint(
          port,
          networkNodeKeys,
          gridPoints,
          maxDistance,
        );

        if (result) {
          opportunities.push({
            ferryName: ferry.name,
            networkPoint: { row: result.point.row, col: result.point.col },
            ferryPort: { row: port.row, col: port.col },
            spurCost: result.buildCost,
            ferryCost: ferry.cost,
            destinationSide: { row: destination.row, col: destination.col },
          });
          console.log(`${LOG_PREFIX} Ferry near-miss: ${ferry.name} — network at (${result.point.row},${result.point.col}) is ${result.distance} segments from port, spurCost=${result.buildCost}M`);
        }
      }
    }

    // Sort by spurCost ascending
    opportunities.sort((a, b) => a.spurCost - b.spurCost);
    return opportunities;
  }

  /**
   * BFS outward from each demand city to find connections to the existing network.
   * Only returns opportunities for cities NOT already on the network.
   *
   * @param networkNodeKeys - Set of "row,col" strings representing existing network nodes
   * @param demandCities - Array of demand city positions with city names
   * @param gridPoints - Loaded grid point data map
   * @param maxDistance - Maximum BFS depth from city (default 3)
   * @returns Array of spur opportunities sorted by spurCost ascending
   */
  static findSpurOpportunities(
    networkNodeKeys: Set<string>,
    demandCities: Array<{ city: string; position: { row: number; col: number } }>,
    gridPoints: Map<string, GridPointData>,
    maxDistance: number = 3,
  ): SpurOpportunity[] {
    if (demandCities.length === 0) return [];

    const opportunities: SpurOpportunity[] = [];

    for (const { city, position } of demandCities) {
      const cityKey = makeKey(position.row, position.col);

      // Skip cities already on the network
      if (networkNodeKeys.has(cityKey)) continue;

      // BFS from the city toward the network
      const result = NetworkBuildAnalyzer.findNearestNetworkPoint(
        position,
        networkNodeKeys,
        gridPoints,
        maxDistance,
      );

      if (result) {
        opportunities.push({
          city,
          nearestNetworkPoint: { row: result.point.row, col: result.point.col },
          spurCost: result.buildCost,
          spurSegments: result.distance,
        });
        console.log(`${LOG_PREFIX} Spur opportunity: ${city} is ${result.distance} segments from network at (${result.point.row},${result.point.col}), cost=${result.buildCost}M`);
      }
    }

    // Sort by spurCost ascending
    opportunities.sort((a, b) => a.spurCost - b.spurCost);
    return opportunities;
  }

  /**
   * Evaluate whether a build option is worthwhile using a cost-per-turn heuristic.
   * Derives game phase from turnNumber to determine value per turn saved.
   *
   * @param option - Build option with cost and distance metrics
   * @param turnNumber - Current game turn number
   * @param speed - Train speed in mileposts per turn (9 or 12)
   * @returns Evaluation result with turnsSaved, valuePerTurn, and isWorthwhile
   */
  static evaluateBuildOption(
    option: { buildCost: number; distanceSaved: number; alternativeDistance: number },
    turnNumber: number,
    speed: number,
  ): BuildOptionEvaluation {
    // Derive value per turn based on game phase
    let valuePerTurn: number;
    if (turnNumber <= 20) {
      valuePerTurn = 2.5; // Early game — low delivery value
    } else if (turnNumber <= 60) {
      valuePerTurn = 6.5; // Mid game — moderate delivery value
    } else {
      valuePerTurn = 11.5; // Late game — high delivery value
    }

    // Calculate turns saved by using the shortcut vs alternative route
    const turnsSaved = speed > 0 ? option.distanceSaved / speed : 0;

    // Determine if the build is worthwhile
    const isWorthwhile = turnsSaved > 0 && turnsSaved * valuePerTurn > option.buildCost;

    console.log(`${LOG_PREFIX} Evaluating build: turnsSaved=${turnsSaved.toFixed(1)}, buildCost=${option.buildCost}M, valuePerTurn=${valuePerTurn}M, isWorthwhile=${isWorthwhile}`);

    return {
      turnsSaved,
      buildCost: option.buildCost,
      valuePerTurn,
      isWorthwhile,
    };
  }

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
