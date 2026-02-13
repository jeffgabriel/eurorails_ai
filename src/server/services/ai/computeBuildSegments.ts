/**
 * computeBuildSegments — Multi-source Dijkstra for AI track building.
 *
 * Finds the cheapest contiguous set of track segments a bot can build
 * within a given budget, starting from existing track endpoints or
 * a major city when no track exists.
 */

import { TrackSegment, TerrainType } from '../../../shared/types/GameTypes';
import {
  getHexNeighbors,
  getTerrainCost,
  gridToPixel,
  loadGridPoints,
  GridCoord,
  GridPointData,
} from './MapTopology';

/** Internal node for Dijkstra's priority queue */
interface DijkstraNode {
  row: number;
  col: number;
  cost: number;
  /** Chain of grid coords from start to this node (inclusive) */
  path: GridCoord[];
}

function makeKey(row: number, col: number): string {
  return `${row},${col}`;
}

/**
 * Simple min-heap keyed on `cost`.
 * Good enough for the ~2000-node hex grid; avoids external deps.
 */
class MinHeap {
  private data: DijkstraNode[] = [];

  get size(): number {
    return this.data.length;
  }

  push(node: DijkstraNode): void {
    this.data.push(node);
    this.bubbleUp(this.data.length - 1);
  }

  pop(): DijkstraNode | undefined {
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
 * Extract the frontier (endpoints) of existing track that can be extended.
 * An endpoint is any grid position that appears as `from` or `to` in the
 * segment list. We collect all unique positions.
 */
function extractTrackEndpoints(segments: TrackSegment[]): GridCoord[] {
  const seen = new Set<string>();
  const endpoints: GridCoord[] = [];

  for (const seg of segments) {
    const fromKey = makeKey(seg.from.row, seg.from.col);
    if (!seen.has(fromKey)) {
      seen.add(fromKey);
      endpoints.push({ row: seg.from.row, col: seg.from.col });
    }
    const toKey = makeKey(seg.to.row, seg.to.col);
    if (!seen.has(toKey)) {
      seen.add(toKey);
      endpoints.push({ row: seg.to.row, col: seg.to.col });
    }
  }

  return endpoints;
}

/**
 * Build a TrackSegment between two grid positions, populating pixel
 * coordinates and cost from the terrain of the destination.
 */
function buildSegment(
  fromCoord: GridCoord,
  toCoord: GridCoord,
  grid: Map<string, GridPointData>,
): TrackSegment | null {
  const fromData = grid.get(makeKey(fromCoord.row, fromCoord.col));
  const toData = grid.get(makeKey(toCoord.row, toCoord.col));
  if (!fromData || !toData) return null;

  const fromPixel = gridToPixel(fromCoord.row, fromCoord.col);
  const toPixel = gridToPixel(toCoord.row, toCoord.col);

  return {
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
    cost: getTerrainCost(toData.terrain),
  };
}

/**
 * Compute the optimal set of track segments a bot should build this turn.
 *
 * Uses multi-source Dijkstra starting from every existing track position
 * (or the provided `startPositions` when the bot has no track yet).
 * Expands outward by terrain cost, then selects the best contiguous path
 * of up to `maxSegments` new segments within the given `budget`.
 *
 * @param startPositions - Grid coords to start from when no track exists
 *                         (typically major city positions).
 * @param existingSegments - The bot's current track network.
 * @param budget - Maximum total cost in ECU millions for this turn's build.
 * @param maxSegments - Maximum number of segments to return (default 3).
 * @returns An array of TrackSegment with full grid + pixel coordinates.
 */
export function computeBuildSegments(
  startPositions: GridCoord[],
  existingSegments: TrackSegment[],
  budget: number,
  maxSegments: number = 3,
): TrackSegment[] {
  const tag = '[computeBuild]';
  if (budget <= 0) {
    console.log(`${tag} budget=${budget}, returning empty`);
    return [];
  }

  const grid = loadGridPoints();
  console.log(`${tag} grid loaded: ${grid.size} points, budget=${budget}, maxSegments=${maxSegments}`);

  // Determine starting frontier
  const trackEndpoints = extractTrackEndpoints(existingSegments);
  const sources = trackEndpoints.length > 0 ? trackEndpoints : startPositions;
  console.log(`${tag} sources: ${sources.length} (endpoints=${trackEndpoints.length}, startPositions=${startPositions.length})`);

  if (sources.length === 0) {
    console.log(`${tag} no sources, returning empty`);
    return [];
  }

  // Build a set of already-built edges so we don't duplicate
  const builtEdges = new Set<string>();
  for (const seg of existingSegments) {
    const a = makeKey(seg.from.row, seg.from.col);
    const b = makeKey(seg.to.row, seg.to.col);
    builtEdges.add(`${a}-${b}`);
    builtEdges.add(`${b}-${a}`);
  }

  // Also track which positions are already on the player's network
  const onNetwork = new Set<string>();
  for (const src of sources) {
    onNetwork.add(makeKey(src.row, src.col));
  }

  // Multi-source Dijkstra
  const heap = new MinHeap();
  const minCost = new Map<string, number>();

  for (const src of sources) {
    const key = makeKey(src.row, src.col);
    heap.push({ row: src.row, col: src.col, cost: 0, path: [{ row: src.row, col: src.col }] });
    minCost.set(key, 0);
  }

  // Store the best paths found. Key = destination, value = cheapest path to get there.
  const bestPaths: Map<string, DijkstraNode> = new Map();

  while (heap.size > 0) {
    const current = heap.pop()!;
    const currentKey = makeKey(current.row, current.col);

    // Skip if we've already found a cheaper way here
    const recorded = minCost.get(currentKey);
    if (recorded !== undefined && current.cost > recorded) continue;

    // Record this as a reachable destination if cost > 0 (not a start node)
    if (current.cost > 0) {
      bestPaths.set(currentKey, current);
    }

    // Expand neighbors
    const neighbors = getHexNeighbors(current.row, current.col);
    for (const nb of neighbors) {
      const nbKey = makeKey(nb.row, nb.col);
      const nbData = grid.get(nbKey);
      if (!nbData) continue;

      const terrainCost = getTerrainCost(nbData.terrain);
      if (terrainCost === Infinity) continue; // water

      // Don't traverse already-built edges
      const edgeKey = `${currentKey}-${nbKey}`;
      if (builtEdges.has(edgeKey)) {
        // But we can pass through existing network nodes for free
        if (onNetwork.has(nbKey)) {
          const newCost = current.cost; // zero cost to traverse own network
          const existingCost = minCost.get(nbKey);
          if (existingCost === undefined || newCost < existingCost) {
            minCost.set(nbKey, newCost);
            heap.push({
              row: nb.row,
              col: nb.col,
              cost: newCost,
              path: [...current.path, { row: nb.row, col: nb.col }],
            });
          }
        }
        continue;
      }

      const newCost = current.cost + terrainCost;
      if (newCost > budget) continue; // over budget

      const existingCost = minCost.get(nbKey);
      if (existingCost === undefined || newCost < existingCost) {
        minCost.set(nbKey, newCost);
        heap.push({
          row: nb.row,
          col: nb.col,
          cost: newCost,
          path: [...current.path, { row: nb.row, col: nb.col }],
        });
      }
    }
  }

  // Select the best path: the one that reaches furthest for the least cost.
  // We want the longest path (most new segments) that fits within budget.
  // Among equal-length paths, prefer the cheapest.
  let bestPath: DijkstraNode | null = null;

  console.log(`${tag} Dijkstra done: ${bestPaths.size} reachable destinations`);

  for (const node of bestPaths.values()) {
    // Count new segments in this path (steps that aren't on existing network)
    const newSteps = countNewSegments(node.path, onNetwork, builtEdges);
    if (newSteps === 0) continue;

    const bestNewSteps = bestPath
      ? countNewSegments(bestPath.path, onNetwork, builtEdges)
      : 0;

    if (
      newSteps > bestNewSteps ||
      (newSteps === bestNewSteps && node.cost < (bestPath?.cost ?? Infinity))
    ) {
      bestPath = node;
    }
  }

  if (!bestPath) {
    console.log(`${tag} no valid path found, returning empty`);
    return [];
  }

  console.log(`${tag} best path: ${bestPath.path.length} nodes, cost=${bestPath.cost}, newSegments=${countNewSegments(bestPath.path, onNetwork, builtEdges)}`);

  // Extract up to maxSegments new segments from the path
  const segments = extractSegments(bestPath.path, onNetwork, builtEdges, grid, budget, maxSegments);
  console.log(`${tag} extracted ${segments.length} segments, totalCost=${segments.reduce((s, seg) => s + seg.cost, 0)}`);
  return segments;
}

/**
 * Count segments in a path that are genuinely new (not already built).
 */
function countNewSegments(
  path: GridCoord[],
  onNetwork: Set<string>,
  builtEdges: Set<string>,
): number {
  let count = 0;
  for (let i = 0; i < path.length - 1; i++) {
    const fromKey = makeKey(path[i].row, path[i].col);
    const toKey = makeKey(path[i + 1].row, path[i + 1].col);
    if (!builtEdges.has(`${fromKey}-${toKey}`)) {
      count++;
    }
  }
  return Math.min(count, path.length - 1);
}

/**
 * Convert a grid-coord path into TrackSegment[], limited by maxSegments and budget.
 * Skips edges that already exist on the network.
 */
function extractSegments(
  path: GridCoord[],
  onNetwork: Set<string>,
  builtEdges: Set<string>,
  grid: Map<string, GridPointData>,
  budget: number,
  maxSegments: number,
): TrackSegment[] {
  const segments: TrackSegment[] = [];
  let spent = 0;

  for (let i = 0; i < path.length - 1; i++) {
    const fromKey = makeKey(path[i].row, path[i].col);
    const toKey = makeKey(path[i + 1].row, path[i + 1].col);

    // Skip already-built edges
    if (builtEdges.has(`${fromKey}-${toKey}`)) continue;

    const seg = buildSegment(path[i], path[i + 1], grid);
    if (!seg) break;

    if (spent + seg.cost > budget) break;
    spent += seg.cost;
    segments.push(seg);

    if (segments.length >= maxSegments) break;
  }

  return segments;
}
