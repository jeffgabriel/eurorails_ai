/**
 * findBuildPath — Pure shared path-finding utility for AI track building.
 *
 * Encapsulates the Dijkstra algorithm used by both simulateTrip (planner-side
 * cost prediction) and computeBuildSegments (in-game build execution).
 *
 * This module satisfies AC1 of the consolidation spec:
 * - No imports of logging utilities
 * - No `console.*` calls
 * - No `Date.now()` calls
 * - Pure function: no side effects beyond returned value
 *
 * AC1 requirements:
 *   exports `findBuildPath(from, to, existingEdges, existingTrackIndex,
 *     opponentEdges, options): { path: GridCoord[]; segments: TrackSegment[]; totalCost: number }`
 */

import {
  TrackSegment,
  TerrainType,
} from '../../../../shared/types/GameTypes';
import {
  getHexNeighbors,
  getTerrainCost,
  getWaterCrossingCost,
  gridToPixel,
  loadGridPoints,
  GridCoord,
  GridPointData,
  makeKey,
} from '../MapTopology';
import { getMajorCityLookup, getFerryEdges, isIntraCityEdge } from '../../../../shared/services/majorCityGroups';
import { isNearExistingTrack } from '../computeBuildSegments';

/** Cost multiplier applied to edges near existing track (parallel-build penalty). */
const PARALLEL_COST_MULTIPLIER = 2;

/** Options for path-finding behavior. */
export interface FindBuildPathOptions {
  /**
   * When true, applies the parallel-build proximity penalty to edges adjacent
   * to the bot's existing track. Defaults to true (in-game rule).
   * Set to false only for tests or scenarios where parallel building is allowed.
   */
  applyParallelPenalty?: boolean;
  /**
   * Maximum cost cap for paths. When provided, the Dijkstra will not explore
   * paths exceeding this budget. Defaults to null (no cap).
   */
  budget?: number | null;
}

/** Result returned by findBuildPath. */
export interface FindBuildPathResult {
  /** Full path of grid coordinates from `from` to `to`. Empty if unreachable. */
  path: GridCoord[];
  /**
   * New track segments that need to be built (not in bot's existing network).
   * Costs include terrain + water crossing; NO parallel penalty (penalty affects
   * path selection, not segment pricing).
   */
  segments: TrackSegment[];
  /** Sum of segments[*].cost. 0 when path is empty or fully on existing track. */
  totalCost: number;
}

/** Internal heap node. */
interface HeapNode {
  row: number;
  col: number;
  cost: number;
  path: GridCoord[];
}

/** Simple min-heap keyed on cost. */
class MinHeap {
  private data: HeapNode[] = [];

  get size(): number {
    return this.data.length;
  }

  push(node: HeapNode): void {
    this.data.push(node);
    this.bubbleUp(this.data.length - 1);
  }

  pop(): HeapNode | undefined {
    if (this.data.length === 0) return undefined;
    const top = this.data[0];
    const last = this.data.pop()!;
    if (this.data.length > 0) {
      this.data[0] = last;
      this.sinkDown(0);
    }
    return top;
  }

  private bubbleUp(i: number): void {
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.data[i].cost >= this.data[parent].cost) break;
      [this.data[i], this.data[parent]] = [this.data[parent], this.data[i]];
      i = parent;
    }
  }

  private sinkDown(i: number): void {
    const n = this.data.length;
    while (true) {
      let smallest = i;
      const left = 2 * i + 1;
      const right = 2 * i + 2;
      if (left < n && this.data[left].cost < this.data[smallest].cost) smallest = left;
      if (right < n && this.data[right].cost < this.data[smallest].cost) smallest = right;
      if (smallest === i) break;
      [this.data[i], this.data[smallest]] = [this.data[smallest], this.data[i]];
      i = smallest;
    }
  }
}

/**
 * Convert a path of GridCoord[] into TrackSegments for only the NEW edges.
 *
 * Segment cost = terrain cost + water crossing cost (NO parallel penalty —
 * the penalty affects Dijkstra path selection, not the cost assigned to
 * built segments).
 */
function pathToSegments(
  path: GridCoord[],
  existingEdges: Set<string>,
  grid: Map<string, GridPointData>,
  majorCityLookup: Map<string, string>,
  ferryPortCosts: Map<string, number>,
): TrackSegment[] {
  const segments: TrackSegment[] = [];
  for (let i = 0; i < path.length - 1; i++) {
    const fromCoord = path[i];
    const toCoord = path[i + 1];
    const fromKey = makeKey(fromCoord.row, fromCoord.col);
    const toKey = makeKey(toCoord.row, toCoord.col);

    // Skip existing edges (already built)
    if (existingEdges.has(`${fromKey}-${toKey}`) || existingEdges.has(`${toKey}-${fromKey}`)) continue;

    // Skip intra-city edges (no track built in red area)
    if (isIntraCityEdge(fromKey, toKey, majorCityLookup)) continue;

    const fromData = grid.get(fromKey);
    const toData = grid.get(toKey);
    if (!fromData || !toData) continue;

    const fromPixel = gridToPixel(fromCoord.row, fromCoord.col);
    const toPixel = gridToPixel(toCoord.row, toCoord.col);

    const baseCost = ferryPortCosts.get(toKey) ?? getTerrainCost(toData.terrain);
    const waterExtra = getWaterCrossingCost(fromCoord.row, fromCoord.col, toCoord.row, toCoord.col);

    segments.push({
      from: {
        x: fromPixel.x,
        y: fromPixel.y,
        row: fromCoord.row,
        col: fromCoord.col,
        terrain: fromData.terrain,
      },
      to: {
        x: toPixel.x,
        y: toPixel.y,
        row: toCoord.row,
        col: toCoord.col,
        terrain: toData.terrain,
      },
      cost: baseCost + waterExtra,
    });
  }
  return segments;
}

/**
 * Find the cheapest buildable path from `from` to `to` using Dijkstra.
 *
 * Edge-weight rules:
 * - Bot's existing edges: cost 0 (traverse own network for free)
 * - Opponent edges: impassable
 * - Intra-city edges (major city red area): cost 0
 * - Ferry crossing: cost 0 once port is reached (port's terrain cost is
 *   the ferry connection cost, already charged when building to port)
 * - Fresh terrain: terrain cost + water surcharge
 * - Optional: parallel-build proximity penalty (PARALLEL_COST_MULTIPLIER × terrain)
 *   applied when applyParallelPenalty=true and hex is near existing track
 *
 * @param from - Starting grid coordinate
 * @param to - Target grid coordinate
 * @param existingEdges - Bot's existing track edges (traversal cost 0)
 * @param existingTrackIndex - Set of node keys for the bot's existing track
 *   (used for parallel-build penalty proximity check). Should EXCLUDE the
 *   bot's current position to avoid penalizing first-hop edges.
 * @param opponentEdges - Opponent track edges (impassable)
 * @param options - Call-site configuration flags
 * @returns Path + new segments + total cost. Returns empty path if unreachable.
 */
export function findBuildPath(
  from: GridCoord,
  to: GridCoord,
  existingEdges: Set<string>,
  existingTrackIndex: Set<string>,
  opponentEdges: Set<string>,
  options: FindBuildPathOptions = {},
): FindBuildPathResult {
  const { applyParallelPenalty = true, budget = null } = options;

  const grid = loadGridPoints();
  const majorCityLookup = getMajorCityLookup();

  // Build ferry port adjacency and cost lookup
  const ferryPortCosts = new Map<string, number>();
  const ferryAdjacency = new Map<string, Array<{ row: number; col: number; cost: number }>>();
  for (const ferry of getFerryEdges()) {
    const aKey = makeKey(ferry.pointA.row, ferry.pointA.col);
    const bKey = makeKey(ferry.pointB.row, ferry.pointB.col);
    ferryPortCosts.set(aKey, ferry.cost);
    ferryPortCosts.set(bKey, ferry.cost);
    if (!ferryAdjacency.has(aKey)) ferryAdjacency.set(aKey, []);
    if (!ferryAdjacency.has(bKey)) ferryAdjacency.set(bKey, []);
    ferryAdjacency.get(aKey)!.push({ row: ferry.pointB.row, col: ferry.pointB.col, cost: ferry.cost });
    ferryAdjacency.get(bKey)!.push({ row: ferry.pointA.row, col: ferry.pointA.col, cost: ferry.cost });
  }

  const fromKey = makeKey(from.row, from.col);
  const toKey = makeKey(to.row, to.col);

  // Trivial case: same point
  if (fromKey === toKey) {
    return { path: [from], segments: [], totalCost: 0 };
  }

  // existingNodes: includes existingTrackIndex + the start position (so Dijkstra
  // can pivot from the bot's current location freely)
  const existingNodes = new Set(existingTrackIndex);
  existingNodes.add(fromKey);

  const heap = new MinHeap();
  const minCost = new Map<string, number>();
  heap.push({ row: from.row, col: from.col, cost: 0, path: [{ row: from.row, col: from.col }] });
  minCost.set(fromKey, 0);

  while (heap.size > 0) {
    const current = heap.pop()!;
    const currentKey = makeKey(current.row, current.col);

    const recorded = minCost.get(currentKey);
    if (recorded !== undefined && current.cost > recorded) continue;

    if (currentKey === toKey) {
      const path = current.path;
      const segments = pathToSegments(path, existingEdges, grid, majorCityLookup, ferryPortCosts);
      const totalCost = segments.reduce((sum, seg) => sum + seg.cost, 0);
      return { path, segments, totalCost };
    }

    // Expand hex neighbors
    const neighbors = getHexNeighbors(current.row, current.col);
    for (const nb of neighbors) {
      const nbKey = makeKey(nb.row, nb.col);
      const nbData = grid.get(nbKey);
      if (!nbData) continue;

      const edgeFwd = `${currentKey}-${nbKey}`;
      const edgeBwd = `${nbKey}-${currentKey}`;

      // Impassable: opponent's track
      if (opponentEdges.has(edgeFwd)) continue;

      // Intra-city (major city red area): free traversal
      if (isIntraCityEdge(currentKey, nbKey, majorCityLookup)) {
        const newCost = current.cost;
        const existingCost = minCost.get(nbKey);
        if (existingCost === undefined || newCost < existingCost) {
          minCost.set(nbKey, newCost);
          heap.push({ row: nb.row, col: nb.col, cost: newCost, path: [...current.path, { row: nb.row, col: nb.col }] });
        }
        continue;
      }

      // Bot's existing edge: free traversal
      if (existingEdges.has(edgeFwd) || existingEdges.has(edgeBwd)) {
        if (existingNodes.has(nbKey)) {
          const newCost = current.cost;
          const existingCost = minCost.get(nbKey);
          if (existingCost === undefined || newCost < existingCost) {
            minCost.set(nbKey, newCost);
            heap.push({ row: nb.row, col: nb.col, cost: newCost, path: [...current.path, { row: nb.row, col: nb.col }] });
          }
        }
        continue;
      }

      // Fresh terrain: terrain cost + water surcharge
      const terrainCost = ferryPortCosts.get(nbKey) ?? getTerrainCost(nbData.terrain);
      if (terrainCost === Infinity) continue; // water — impassable

      // Optional parallel-build proximity penalty (JIRA-236):
      // Apply PARALLEL_COST_MULTIPLIER when building near existing track, but
      // only if applyParallelPenalty=true and the target hex is NOT already on
      // the bot's track (existingTrackIndex does NOT include the start position).
      const isParallel = applyParallelPenalty
        && existingTrackIndex.size > 0
        && !existingTrackIndex.has(nbKey)
        && isNearExistingTrack(nb.row, nb.col, existingTrackIndex);
      const effectiveTerrainCost = isParallel ? terrainCost * PARALLEL_COST_MULTIPLIER : terrainCost;

      const waterExtra = getWaterCrossingCost(current.row, current.col, nb.row, nb.col);
      const newCost = current.cost + effectiveTerrainCost + waterExtra;

      // Budget cap: skip if this edge would exceed budget
      if (budget !== null && newCost > budget) continue;

      const existingCost = minCost.get(nbKey);
      if (existingCost === undefined || newCost < existingCost) {
        minCost.set(nbKey, newCost);
        heap.push({ row: nb.row, col: nb.col, cost: newCost, path: [...current.path, { row: nb.row, col: nb.col }] });
      }
    }

    // Ferry crossing: if at a ferry port, cross to partner for free
    const ferryPartners = ferryAdjacency.get(currentKey);
    if (ferryPartners) {
      for (const partner of ferryPartners) {
        const partnerKey = makeKey(partner.row, partner.col);
        // Only cross if partner port is not blocked by opponent
        const edgeFwd = `${currentKey}-${partnerKey}`;
        if (opponentEdges.has(edgeFwd)) continue;

        const newCost = current.cost; // free crossing
        const existingCost = minCost.get(partnerKey);
        if (existingCost === undefined || newCost < existingCost) {
          minCost.set(partnerKey, newCost);
          heap.push({ row: partner.row, col: partner.col, cost: newCost, path: [...current.path, { row: partner.row, col: partner.col }] });
        }
      }
    }
  }

  return { path: [], segments: [], totalCost: 0 }; // unreachable
}
