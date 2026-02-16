/**
 * computeBuildSegments — Multi-source Dijkstra for AI track building.
 *
 * Finds the cheapest contiguous set of track segments a bot can build
 * within a given budget, starting from existing track endpoints or
 * a major city when no track exists.
 */

import { TrackSegment, TerrainType, WaterCrossingType } from '../../../shared/types/GameTypes';
import {
  getHexNeighbors,
  getTerrainCost,
  gridToPixel,
  loadGridPoints,
  GridCoord,
  GridPointData,
} from './MapTopology';
import { getMajorCityLookup, getFerryEdges } from '../../../shared/services/majorCityGroups';
import waterCrossingsData from '../../../../configuration/waterCrossings.json';

// Precompute water crossing costs for O(1) edge lookup.
// River = +2M, Lake/Ocean inlet = +3M (additive to terrain cost).
const _waterCrossingCosts = new Map<string, number>();
for (const edge of (waterCrossingsData as { riverEdges?: string[]; nonRiverWaterEdges?: string[] }).riverEdges ?? []) {
  _waterCrossingCosts.set(edge, WaterCrossingType.River); // 2
}
for (const edge of (waterCrossingsData as { riverEdges?: string[]; nonRiverWaterEdges?: string[] }).nonRiverWaterEdges ?? []) {
  _waterCrossingCosts.set(edge, WaterCrossingType.Lake); // 3
}

/** Extra cost for building across a river, lake, or ocean inlet. */
function getWaterCrossingCost(fromRow: number, fromCol: number, toRow: number, toCol: number): number {
  const a = `${fromRow},${fromCol}`;
  const b = `${toRow},${toCol}`;
  const key = a <= b ? `${a}|${b}` : `${b}|${a}`;
  return _waterCrossingCosts.get(key) ?? 0;
}

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
  ferryPortCosts: Map<string, number>,
): TrackSegment | null {
  const fromData = grid.get(makeKey(fromCoord.row, fromCoord.col));
  const toData = grid.get(makeKey(toCoord.row, toCoord.col));
  if (!fromData || !toData) return null;

  const fromPixel = gridToPixel(fromCoord.row, fromCoord.col);
  const toPixel = gridToPixel(toCoord.row, toCoord.col);

  // Ferry ports use their connection cost (4–16M) instead of terrain cost
  const baseCost = ferryPortCosts.get(makeKey(toCoord.row, toCoord.col)) ?? getTerrainCost(toData.terrain);

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
    cost: baseCost + getWaterCrossingCost(fromCoord.row, fromCoord.col, toCoord.row, toCoord.col),
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
 * @param maxSegments - Maximum number of segments to return (default: budget,
 *                      i.e. only limited by cost). The per-turn build cost
 *                      in EuroRails is ECU 20M, and cheapest terrain is 1 ECU,
 *                      so the practical max is ~20.
 * @returns An array of TrackSegment with full grid + pixel coordinates.
 */
export function computeBuildSegments(
  startPositions: GridCoord[],
  existingSegments: TrackSegment[],
  budget: number,
  maxSegments: number = budget,
  /** Edges owned by other players — these cannot be built on (Right of Way rule). */
  occupiedEdges?: Set<string>,
  /** Target positions to build toward (demand card cities). When provided,
   *  path selection prefers routes that get closest to a target over raw segment count. */
  targetPositions?: GridCoord[],
): TrackSegment[] {
  const tag = '[computeBuild]';
  if (budget <= 0) {
    console.log(`${tag} budget=${budget}, returning empty`);
    return [];
  }

  const grid = loadGridPoints();
  const majorCityLookup = getMajorCityLookup();

  // Build ferry port cost lookup: grid coord → connection cost (4–16M).
  // Per game rules, building TO a ferry port costs the ferry connection cost,
  // not the base terrain cost (which getTerrainCost incorrectly returns as 1).
  const ferryPortCosts = new Map<string, number>();
  const ferryEdges = getFerryEdges();
  for (const ferry of ferryEdges) {
    ferryPortCosts.set(makeKey(ferry.pointA.row, ferry.pointA.col), ferry.cost);
    ferryPortCosts.set(makeKey(ferry.pointB.row, ferry.pointB.col), ferry.cost);
  }

  // Ferry adjacency: when Dijkstra reaches a ferry port, it can cross to the
  // partner port for free (the cost to build TO the port was already paid;
  // the crossing itself is a public edge per game rules).
  const ferryAdjacency = new Map<string, GridCoord[]>();
  const ferryEdgeKeys = new Set<string>();
  for (const ferry of ferryEdges) {
    const aKey = makeKey(ferry.pointA.row, ferry.pointA.col);
    const bKey = makeKey(ferry.pointB.row, ferry.pointB.col);
    if (!ferryAdjacency.has(aKey)) ferryAdjacency.set(aKey, []);
    if (!ferryAdjacency.has(bKey)) ferryAdjacency.set(bKey, []);
    ferryAdjacency.get(aKey)!.push({ row: ferry.pointB.row, col: ferry.pointB.col });
    ferryAdjacency.get(bKey)!.push({ row: ferry.pointA.row, col: ferry.pointA.col });
    ferryEdgeKeys.add(`${aKey}-${bKey}`);
    ferryEdgeKeys.add(`${bKey}-${aKey}`);
  }

  console.log(`${tag} grid loaded: ${grid.size} points, budget=${budget}, maxSegments=${maxSegments}, ferries=${ferryEdges.length}`);

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

      // No track may be built within a major city red area (GH-213)
      const currentCityName = majorCityLookup.get(currentKey);
      const nbCityName = majorCityLookup.get(nbKey);
      if (currentCityName && nbCityName && currentCityName === nbCityName) continue;

      // Ferry ports use their connection cost (4–16M) instead of terrain cost
      const terrainCost = ferryPortCosts.get(nbKey) ?? getTerrainCost(nbData.terrain);
      if (terrainCost === Infinity) continue; // water

      // Don't traverse edges owned by other players (Right of Way rule)
      const edgeKey = `${currentKey}-${nbKey}`;
      if (occupiedEdges?.has(edgeKey)) continue;

      // Don't traverse already-built edges (own network)
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

      const waterExtra = getWaterCrossingCost(current.row, current.col, nb.row, nb.col);
      const newCost = current.cost + terrainCost + waterExtra;
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

    // Ferry crossing: if current node is a ferry port, expand to partner port(s).
    // Crossing is free — cost to build TO the port was already paid above.
    const ferryPartners = ferryAdjacency.get(currentKey);
    if (ferryPartners) {
      for (const partner of ferryPartners) {
        const partnerKey = makeKey(partner.row, partner.col);
        const newCost = current.cost; // free crossing
        if (newCost > budget) continue;
        const existingCost = minCost.get(partnerKey);
        if (existingCost === undefined || newCost < existingCost) {
          minCost.set(partnerKey, newCost);
          heap.push({
            row: partner.row,
            col: partner.col,
            cost: newCost,
            path: [...current.path, { row: partner.row, col: partner.col }],
          });
        }
      }
    }
  }

  // Select the best path based on whether we have target positions (demand cities).
  // With targets: prefer the path whose endpoint is closest to any target city.
  // Without targets: prefer the longest path (most new segments) within budget.
  let bestPath: DijkstraNode | null = null;

  console.log(`${tag} Dijkstra done: ${bestPaths.size} reachable destinations`);

  const hasTargets = targetPositions && targetPositions.length > 0;

  if (hasTargets) {
    // Filter out targets already on the bot's track — building toward an
    // already-reachable city wastes budget and creates star-shaped building.
    const unreachedTargets = targetPositions!.filter(
      t => !onNetwork.has(makeKey(t.row, t.col))
    );
    const effectiveTargets = unreachedTargets.length > 0
      ? unreachedTargets
      : targetPositions!;  // fallback if ALL targets are connected

    // Target-aware selection: pick the path that gets closest to a demand city
    let bestTargetDist = Infinity;
    let bestTargetName = '';

    for (const node of bestPaths.values()) {
      const newSteps = countNewSegments(node.path, onNetwork, builtEdges, ferryEdgeKeys);
      if (newSteps === 0) continue;

      const endpoint = node.path[node.path.length - 1];
      let minDist = Infinity;
      for (const target of effectiveTargets) {
        const dist = (endpoint.row - target.row) ** 2 + (endpoint.col - target.col) ** 2;
        if (dist < minDist) minDist = dist;
      }

      // Prefer closer to target; among equal distances, prefer more segments
      if (
        minDist < bestTargetDist ||
        (minDist === bestTargetDist && newSteps > (bestPath ? countNewSegments(bestPath.path, onNetwork, builtEdges, ferryEdgeKeys) : 0))
      ) {
        bestPath = node;
        bestTargetDist = minDist;
      }
    }

    // Identify which target the path aims at
    if (bestPath) {
      const ep = bestPath.path[bestPath.path.length - 1];
      const gridPt = grid.get(makeKey(ep.row, ep.col));
      bestTargetName = gridPt?.name ?? `(${ep.row},${ep.col})`;
      console.log(`${tag} target-aware: aiming for ${bestTargetName}, dist²=${bestTargetDist}, targets=${effectiveTargets.length} (${targetPositions!.length - effectiveTargets.length} already on network)`);
    }
  } else {
    // Original untargeted selection: most new segments, then cheapest
    for (const node of bestPaths.values()) {
      const newSteps = countNewSegments(node.path, onNetwork, builtEdges, ferryEdgeKeys);
      if (newSteps === 0) continue;

      const bestNewSteps = bestPath
        ? countNewSegments(bestPath.path, onNetwork, builtEdges, ferryEdgeKeys)
        : 0;

      if (
        newSteps > bestNewSteps ||
        (newSteps === bestNewSteps && node.cost < (bestPath?.cost ?? Infinity))
      ) {
        bestPath = node;
      }
    }
  }

  if (!bestPath) {
    console.log(`${tag} no valid path found, returning empty`);
    return [];
  }

  console.log(`${tag} best path: ${bestPath.path.length} nodes, cost=${bestPath.cost}, newSegments=${countNewSegments(bestPath.path, onNetwork, builtEdges, ferryEdgeKeys)}`);

  // Extract up to maxSegments new segments from the path
  const segments = extractSegments(bestPath.path, onNetwork, builtEdges, grid, budget, maxSegments, ferryPortCosts, ferryEdgeKeys);
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
  ferryEdgeKeys: Set<string>,
): number {
  let count = 0;
  for (let i = 0; i < path.length - 1; i++) {
    const fromKey = makeKey(path[i].row, path[i].col);
    const toKey = makeKey(path[i + 1].row, path[i + 1].col);
    if (ferryEdgeKeys.has(`${fromKey}-${toKey}`)) continue; // public ferry crossing, not buildable
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
  ferryPortCosts: Map<string, number>,
  ferryEdgeKeys: Set<string>,
): TrackSegment[] {
  const segments: TrackSegment[] = [];
  let spent = 0;

  for (let i = 0; i < path.length - 1; i++) {
    const fromKey = makeKey(path[i].row, path[i].col);
    const toKey = makeKey(path[i + 1].row, path[i + 1].col);

    // Skip already-built edges — but if we've already emitted segments,
    // skipping creates a contiguity gap (seg[n].to ≠ seg[n+1].from),
    // so break to keep the contiguous run we have.
    if (builtEdges.has(`${fromKey}-${toKey}`)) {
      if (segments.length > 0) break;
      continue;
    }

    // Skip ferry crossings — same contiguity rule applies
    if (ferryEdgeKeys.has(`${fromKey}-${toKey}`)) {
      if (segments.length > 0) break;
      continue;
    }

    const seg = buildSegment(path[i], path[i + 1], grid, ferryPortCosts);
    if (!seg) break;

    if (spent + seg.cost > budget) break;
    spent += seg.cost;
    segments.push(seg);

    if (segments.length >= maxSegments) break;
  }

  return segments;
}
