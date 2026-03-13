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
  hexDistance,
  computeLandmass,
  computeFerryRouteInfo,
  GridCoord,
  GridPointData,
} from './MapTopology';
import { getMajorCityLookup, getMajorCityGroups, getFerryEdges, isIntraCityEdge } from '../../../shared/services/majorCityGroups';
import { getWaterCrossingExtraCost } from '../../../shared/config/waterCrossings';

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
    cost: baseCost + getWaterCrossingExtraCost(fromCoord, toCoord),
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
  /** Already-built segments to treat as existing for edge dedup and free traversal,
   *  but NOT used as Dijkstra sources. Used by continuation builds to avoid
   *  duplicating the bot's existing track while starting from a specific point. */
  knownSegments?: TrackSegment[],
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
  const rawSources = trackEndpoints.length > 0 ? trackEndpoints : startPositions;

  // Major City red area: if any source is a Major City outpost, add ALL
  // outposts of that city as sources. Game rule: all mileposts within a
  // major city are connected via the red area, so building FROM any outpost
  // is valid when the bot has track at any other outpost of that city.
  const majorCityGroups = getMajorCityGroups();
  const cityGroupMap = new Map(majorCityGroups.map(g => [g.cityName, g]));
  const sources = [...rawSources];
  const sourceKeys = new Set(rawSources.map(s => makeKey(s.row, s.col)));
  for (const src of rawSources) {
    const cityName = majorCityLookup.get(makeKey(src.row, src.col));
    if (!cityName) continue;
    const group = cityGroupMap.get(cityName);
    if (!group) continue;
    for (const point of [group.center, ...group.outposts]) {
      const key = makeKey(point.row, point.col);
      if (!sourceKeys.has(key)) {
        sourceKeys.add(key);
        sources.push({ row: point.row, col: point.col });
      }
    }
  }

  console.log(`${tag} sources: ${sources.length} (endpoints=${trackEndpoints.length}, startPositions=${startPositions.length}, cityExpanded=${sources.length - rawSources.length})`);

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
  // Merge knownSegments into builtEdges (for continuation builds)
  for (const seg of (knownSegments ?? [])) {
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
  // Merge knownSegments positions into onNetwork (for free traversal)
  for (const seg of (knownSegments ?? [])) {
    onNetwork.add(makeKey(seg.from.row, seg.from.col));
    onNetwork.add(makeKey(seg.to.row, seg.to.col));
  }

  // Build target key set for dead-end pruning (O(1) lookup).
  // Dead-end mileposts (≤1 non-water hex neighbor) are skipped during expansion
  // unless they are a target city — this avoids wasting budget on ocean peninsulas.
  const targetKeys = new Set<string>();
  if (targetPositions) {
    for (const tp of targetPositions) {
      targetKeys.add(makeKey(tp.row, tp.col));
    }
  }

  // Targeted builds: remove budget cap from Dijkstra to find cheapest full route
  // to target, then truncate to budget in extractSegments. Early-terminate when
  // the first target milepost is settled (Dijkstra guarantees cheapest path).
  const hasTargets = targetKeys.size > 0;
  let earlyTermPath: DijkstraNode | null = null;

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

    // Early termination for targeted builds: when a target milepost is settled,
    // Dijkstra guarantees this is the cheapest path. No need to explore further.
    if (hasTargets && current.cost > 0 && targetKeys.has(currentKey)) {
      earlyTermPath = current;
      break;
    }

    // Expand neighbors
    const neighbors = getHexNeighbors(current.row, current.col);
    for (const nb of neighbors) {
      const nbKey = makeKey(nb.row, nb.col);
      const nbData = grid.get(nbKey);
      if (!nbData) continue;

      // Dead-end pruning: skip mileposts with ≤1 non-water neighbor unless
      // they are a target city. Prevents Dijkstra from wasting budget exploring
      // ocean peninsulas and coastal dead-ends.
      if (!targetKeys.has(nbKey) && !onNetwork.has(nbKey)) {
        const nbNeighborCount = getHexNeighbors(nb.row, nb.col).length;
        if (nbNeighborCount <= 1) continue;
      }

      // Intra-city edge: free traversal through major city red area (no track built).
      // The red area connects all mileposts within a major city at zero cost.
      if (isIntraCityEdge(currentKey, nbKey, majorCityLookup)) {
        const newCost = current.cost; // zero cost
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
        continue;
      }

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

      const waterExtra = getWaterCrossingExtraCost(current, nb);
      const newCost = current.cost + terrainCost + waterExtra;
      if (!hasTargets && newCost > budget) continue; // over budget (only for untargeted builds)

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
        if (!hasTargets && newCost > budget) continue;
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

  if (earlyTermPath) {
    console.log(`${tag} early termination: target reached at cost=${earlyTermPath.cost}, path=${earlyTermPath.path.length} nodes`);
  }
  console.log(`${tag} Dijkstra done: ${bestPaths.size} reachable destinations`);

  if (hasTargets) {
    // Filter out targets already on the bot's track — building toward an
    // already-reachable city wastes budget and creates star-shaped building.
    const unreachedTargets = targetPositions!.filter(
      t => !onNetwork.has(makeKey(t.row, t.col))
    );
    let effectiveTargets = unreachedTargets.length > 0
      ? unreachedTargets
      : targetPositions!;  // fallback if ALL targets are connected

    // ── Ferry waypoint: redirect cross-water targets to departure ferry ports ──
    // Hex distance is misleading for targets on different landmasses — a coastal
    // point may appear "close" but requires a ferry crossing.  Detect such targets
    // and replace them with the departure-side ferry port so path selection builds
    // toward the ferry, not just the nearest coast.
    const sourceLandmass = computeLandmass(sources, grid);

    const crossWaterTargets = effectiveTargets.filter(
      t => !sourceLandmass.has(makeKey(t.row, t.col))
    );

    if (crossWaterTargets.length > 0) {
      const ferryInfo = computeFerryRouteInfo(sourceLandmass, onNetwork, ferryEdges);

      if (!ferryInfo.canCrossFerry) {
        if (ferryInfo.departurePorts.length > 0) {
          const localTargets = effectiveTargets.filter(
            t => sourceLandmass.has(makeKey(t.row, t.col))
          );
          effectiveTargets = [...localTargets, ...ferryInfo.departurePorts];
          console.log(`${tag} ferry waypoint: ${crossWaterTargets.length} cross-water target(s) → ${ferryInfo.departurePorts.length} departure port(s)`);
        }
      }
    }

    if (earlyTermPath) {
      // Full-path Dijkstra found cheapest route to target — use directly.
      // No hex-distance scoring needed: the path IS the optimal route.
      bestPath = earlyTermPath;
      const ep = bestPath.path[bestPath.path.length - 1];
      const gridPt = grid.get(makeKey(ep.row, ep.col));
      console.log(`${tag} target-aware: direct path to ${gridPt?.name ?? `(${ep.row},${ep.col})`}, cost=${bestPath.cost}, path=${bestPath.path.length} nodes, targets=${effectiveTargets.length} (${targetPositions!.length - effectiveTargets.length} already on network)`);
    } else {
      // Fallback: target unreachable via Dijkstra (e.g., blocked by occupied edges).
      // Use hex-distance scoring against whatever destinations were explored.
      console.warn(`${tag} target unreachable via Dijkstra, falling back to hex-distance scoring`);
      let bestTargetDist = Infinity;

      for (const node of bestPaths.values()) {
        const newSteps = countNewSegments(node.path, onNetwork, builtEdges, ferryEdgeKeys, majorCityLookup);
        if (newSteps === 0) continue;

        const endpoint = node.path[node.path.length - 1];
        let minDist = Infinity;
        for (const target of effectiveTargets) {
          const dist = hexDistance(endpoint.row, endpoint.col, target.row, target.col);
          if (dist < minDist) minDist = dist;
        }

        if (
          minDist < bestTargetDist ||
          (minDist === bestTargetDist && node.cost < (bestPath?.cost ?? Infinity))
        ) {
          bestPath = node;
          bestTargetDist = minDist;
        }
      }

      if (bestPath) {
        const ep = bestPath.path[bestPath.path.length - 1];
        const gridPt = grid.get(makeKey(ep.row, ep.col));
        console.log(`${tag} target-aware fallback: aiming for ${gridPt?.name ?? `(${ep.row},${ep.col})`}, dist=${bestTargetDist}`);
      }
    }
  } else {
    // Original untargeted selection: most new segments, then cheapest
    for (const node of bestPaths.values()) {
      const newSteps = countNewSegments(node.path, onNetwork, builtEdges, ferryEdgeKeys, majorCityLookup);
      if (newSteps === 0) continue;

      const bestNewSteps = bestPath
        ? countNewSegments(bestPath.path, onNetwork, builtEdges, ferryEdgeKeys, majorCityLookup)
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

  console.log(`${tag} best path: ${bestPath.path.length} nodes, cost=${bestPath.cost}, newSegments=${countNewSegments(bestPath.path, onNetwork, builtEdges, ferryEdgeKeys, majorCityLookup)}`);

  // Valid cold-start positions: major cities + any explicitly provided startPositions.
  // JIRA-80: When startPositions include non-major city coords (e.g., Small City),
  // they must be valid cold-start origins.
  const validColdStartKeys = new Set<string>();
  for (const g of majorCityGroups) {
    validColdStartKeys.add(makeKey(g.center.row, g.center.col));
    for (const op of g.outposts) validColdStartKeys.add(makeKey(op.row, op.col));
  }
  for (const sp of startPositions) {
    validColdStartKeys.add(makeKey(sp.row, sp.col));
  }

  // Extract up to maxSegments new segments from the path.
  // For targeted builds with a direct path, pick the first valid run (start of optimal route).
  const pickFirstRun = hasTargets && earlyTermPath !== null;
  const segments = extractSegments(bestPath.path, onNetwork, builtEdges, grid, budget, maxSegments, ferryPortCosts, ferryEdgeKeys, validColdStartKeys, majorCityLookup, pickFirstRun);
  console.log(`${tag} extracted ${segments.length} segments, totalCost=${segments.reduce((s, seg) => s + seg.cost, 0)}`);
  return segments;
}

/**
 * Count segments in a path that are genuinely new (not already built).
 * Skips intra-city edges (public red area, no track built) and ferry crossings.
 */
function countNewSegments(
  path: GridCoord[],
  onNetwork: Set<string>,
  builtEdges: Set<string>,
  ferryEdgeKeys: Set<string>,
  majorCityLookup?: Map<string, string>,
): number {
  let count = 0;
  for (let i = 0; i < path.length - 1; i++) {
    const fromKey = makeKey(path[i].row, path[i].col);
    const toKey = makeKey(path[i + 1].row, path[i + 1].col);
    if (ferryEdgeKeys.has(`${fromKey}-${toKey}`)) continue; // public ferry crossing, not buildable
    if (majorCityLookup && isIntraCityEdge(fromKey, toKey, majorCityLookup)) continue; // intra-city, not buildable
    if (!builtEdges.has(`${fromKey}-${toKey}`)) {
      count++;
    }
  }
  return Math.min(count, path.length - 1);
}

/**
 * Convert a grid-coord path into TrackSegment[], limited by maxSegments and budget.
 * Skips edges that already exist on the network, are ferry crossings, or are
 * intra-city hops (public red area, no track built).
 *
 * Collects multiple contiguous runs of new segments (separated by built edges,
 * ferry crossings, or intra-city hops).
 *
 * When `pickFirstRun` is true (targeted builds), returns the first valid run
 * — the start of the optimal path to the target.
 * When false (untargeted builds), returns the longest valid run.
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
  validColdStartKeys: Set<string>,
  majorCityLookup: Map<string, string>,
  pickFirstRun: boolean = false,
): TrackSegment[] {
  // Collect all contiguous runs of new (buildable) segments.
  // Each run has a startKey: the grid coord we started building from.
  // Only runs whose startKey is in onNetwork are valid (connected to our track or a major city).
  // Runs after a ferry crossing start from the far-side ferry port — not in onNetwork — and would be orphaned.
  const runs: { segments: TrackSegment[]; cost: number; startKey: string }[] = [];
  let currentRun: TrackSegment[] = [];
  let currentCost = 0;
  let runStartKey: string | null = null;

  for (let i = 0; i < path.length - 1; i++) {
    const fromKey = makeKey(path[i].row, path[i].col);
    const toKey = makeKey(path[i + 1].row, path[i + 1].col);

    // Skip already-built edges, ferry crossings, or intra-city hops — don't break the run
    if (builtEdges.has(`${fromKey}-${toKey}`) || ferryEdgeKeys.has(`${fromKey}-${toKey}`) || isIntraCityEdge(fromKey, toKey, majorCityLookup)) {
      if (currentRun.length > 0 && runStartKey !== null) {
        runs.push({ segments: currentRun, cost: currentCost, startKey: runStartKey });
        currentRun = [];
        currentCost = 0;
        runStartKey = null;
      }
      continue;
    }

    const seg = buildSegment(path[i], path[i + 1], grid, ferryPortCosts);
    if (!seg) {
      // Can't build this segment — finalize current run
      if (currentRun.length > 0 && runStartKey !== null) {
        runs.push({ segments: currentRun, cost: currentCost, startKey: runStartKey });
        currentRun = [];
        currentCost = 0;
        runStartKey = null;
      }
      break;
    }

    if (currentCost + seg.cost > budget) {
      // Over budget — finalize current run without this segment
      if (currentRun.length > 0 && runStartKey !== null) {
        runs.push({ segments: currentRun, cost: currentCost, startKey: runStartKey });
        currentRun = [];
        currentCost = 0;
        runStartKey = null;
      }
      break;
    }

    if (currentRun.length === 0) runStartKey = fromKey;
    currentCost += seg.cost;
    currentRun.push(seg);

    if (currentRun.length >= maxSegments && runStartKey !== null) {
      runs.push({ segments: currentRun, cost: currentCost, startKey: runStartKey });
      currentRun = [];
      currentCost = 0;
      runStartKey = null;
      break;
    }
  }

  // Don't forget the last run
  if (currentRun.length > 0 && runStartKey !== null) {
    runs.push({ segments: currentRun, cost: currentCost, startKey: runStartKey });
  }

  if (runs.length === 0) return [];

  // Build set of nodes reachable from path[0] by traversing built edges or intra-city edges.
  const connectedViaBuilt = new Set<string>();
  connectedViaBuilt.add(makeKey(path[0].row, path[0].col));
  for (let i = 0; i < path.length - 1; i++) {
    const fromKey = makeKey(path[i].row, path[i].col);
    const toKey = makeKey(path[i + 1].row, path[i + 1].col);
    const edgeKey = `${fromKey}-${toKey}`;
    if (connectedViaBuilt.has(fromKey) && (builtEdges.has(edgeKey) || isIntraCityEdge(fromKey, toKey, majorCityLookup))) {
      connectedViaBuilt.add(toKey);
    }
  }
  // Per game rules, we can build from the far side of a ferry only if we have track to the near side.
  // When builtEdges is empty (no track), we cannot legally build from a ferry port.
  const connectedFromPath = new Set(connectedViaBuilt);
  if (builtEdges.size > 0) {
    for (let i = 0; i < path.length - 1; i++) {
      const fromKey = makeKey(path[i].row, path[i].col);
      const toKey = makeKey(path[i + 1].row, path[i + 1].col);
      const edgeKey = `${fromKey}-${toKey}`;
      if (ferryEdgeKeys.has(edgeKey) && connectedViaBuilt.has(fromKey)) {
        connectedFromPath.add(toKey);
      }
    }
  }

  // When no track: only allow runs from major cities (game rule). When we have track: allow
  // runs from path-connected nodes (including far-side ferry port when we have track to near side).
  const validRuns = builtEdges.size === 0
    ? runs.filter(r => validColdStartKeys.has(r.startKey))
    : runs.filter(r => connectedFromPath.has(r.startKey));
  if (validRuns.length === 0) return [];

  if (pickFirstRun) {
    // Targeted builds: first valid run is the start of the optimal path to target.
    return validRuns[0].segments;
  }

  // Untargeted builds: longest valid run (most new segments within budget).
  let bestRun = validRuns[0];
  for (let i = 1; i < validRuns.length; i++) {
    if (validRuns[i].segments.length > bestRun.segments.length) {
      bestRun = validRuns[i];
    }
  }

  return bestRun.segments;
}
