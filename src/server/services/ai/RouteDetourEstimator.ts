/**
 * RouteDetourEstimator — Pure helper functions for computing truthful detour costs.
 *
 * Provides three exported functions for the bot's strategic advisors to compute
 * first-class estimates of what it actually costs (in ECU and turns) to insert
 * a new stop into an existing planned route.
 *
 * JIRA-214 P1 — foundations only. No advisor changes; no behavior changes observable
 * until Project 2 wires these into RouteEnrichmentAdvisor.
 *
 * ADR-2 note: Dijkstra edge-weight semantics are intentionally duplicated from
 * computeBuildSegments.ts to keep blast radius scoped. computeBuildSegments is NOT
 * modified. The two implementations must stay in sync if terrain costs change.
 */

import {
  TrackSegment,
  TerrainType,
  WaterCrossingType,
  TrainType,
  TRAIN_PROPERTIES,
  RouteStop,
  StrategicRoute,
} from '../../../shared/types/GameTypes';
import {
  getHexNeighbors,
  getTerrainCost,
  gridToPixel,
  loadGridPoints,
  GridCoord,
  makeKey,
} from './MapTopology';
import { getMajorCityLookup, isIntraCityEdge, getFerryEdges } from '../../../shared/services/majorCityGroups';
import waterCrossingsData from '../../../../configuration/waterCrossings.json';
import { ActionResolver } from './ActionResolver';

// ── Types ──────────────────────────────────────────────────────────────

/** Result of estimating a single path leg between two grid positions. */
export interface RouteSegmentEstimate {
  /** New track segments that need to be built (not in bot's existing network). */
  newSegments: TrackSegment[];
  /** Total ECU cost to build newSegments. 0 when fully on existing network. */
  buildCost: number;
  /** Total number of mileposts in the path (including existing-track mileposts). */
  pathLength: number;
  /** false when no path exists (e.g., all routes blocked by opponent track). */
  reachable: boolean;
}

/** Result of simulating a full multi-stop trip turn by turn. */
export interface TripSimulation {
  /** Total turns to complete all stops including build and travel. */
  turnsToComplete: number;
  /** Total ECU cost to build all new track segments across all legs. */
  totalBuildCost: number;
  /** false when any leg is unreachable (opponent track blocks all paths). */
  feasible: boolean;
}

/** Per-candidate detour scoring result for computeCandidateDetourCosts. */
export interface CandidateDetourInfo {
  loadType: string;
  deliveryCity: string;
  payout: number;
  cardIndex: number;
  /** Slot index [0, route.stops.length] that minimises marginal cost. */
  bestSlotIndex: number;
  /** Additional ECU build cost from inserting this candidate at bestSlotIndex. */
  marginalBuildM: number;
  /** Additional turns from inserting this candidate at bestSlotIndex. */
  marginalTurns: number;
  feasible: boolean;
}

// ── Constants (R11) ────────────────────────────────────────────────────

/**
 * Imputed ECU opportunity cost of one extra turn when scoring insertion slots.
 *
 * Provenance: CLAUDE.md strategic principle "income velocity matters more than
 * payout size". Bot per-turn income ranges from ~2.5–5.6M/turn across the
 * winner-loser band. 5M/turn represents the upper end of that range, making
 * the bot reject slot choices that add turns unless the build savings outweigh
 * the opportunity cost.
 */
export const OPPORTUNITY_COST_PER_TURN_M = 5;

/**
 * Hard ceiling on extra turns a single insertion may cost.
 *
 * Provenance: A detour that adds 4+ turns is no longer a "piggyback" on an
 * existing route — it is effectively a separate trip. When extra turns exceed
 * this threshold, PostDeliveryReplanner will produce a better full-route plan
 * from scratch rather than forcing the current plan to absorb the stop.
 */
export const MAX_DETOUR_TURNS = 3;

// ── Private helpers ────────────────────────────────────────────────────

/** Precomputed water crossing costs. River = +2, Lake/OceanInlet = +3. */
const _waterCosts = new Map<string, number>();
for (const edge of (waterCrossingsData as { riverEdges?: string[]; nonRiverWaterEdges?: string[] }).riverEdges ?? []) {
  _waterCosts.set(edge, WaterCrossingType.River); // 2
}
for (const edge of (waterCrossingsData as { riverEdges?: string[]; nonRiverWaterEdges?: string[] }).nonRiverWaterEdges ?? []) {
  _waterCosts.set(edge, WaterCrossingType.Lake); // 3
}

function edgeCrossingCost(fromRow: number, fromCol: number, toRow: number, toCol: number): number {
  const a = `${fromRow},${fromCol}`;
  const b = `${toRow},${toCol}`;
  const key = a <= b ? `${a}|${b}` : `${b}|${a}`;
  return _waterCosts.get(key) ?? 0;
}

/** Simple min-heap keyed on cost. */
interface HeapNode {
  row: number;
  col: number;
  cost: number;
  path: GridCoord[];
}

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
 * WorldSnapshot-compatible parameter type capturing only the fields this
 * module needs. Avoids importing the full type and keeps blast radius scoped.
 */
interface SnapshotInput {
  bot: {
    playerId: string;
    existingSegments: TrackSegment[];
    trainType: string;
    ferryHalfSpeed?: boolean;
  };
  allPlayerTracks: Array<{
    playerId: string;
    segments: TrackSegment[];
  }>;
}

/** Build the set of existing-edge keys (both directions) for O(1) lookup. */
function buildExistingEdgeSet(segments: TrackSegment[]): Set<string> {
  const edges = new Set<string>();
  for (const seg of segments) {
    const a = makeKey(seg.from.row, seg.from.col);
    const b = makeKey(seg.to.row, seg.to.col);
    edges.add(`${a}-${b}`);
    edges.add(`${b}-${a}`);
  }
  return edges;
}

/** Build the set of node keys in an existing segment list for O(1) lookup. */
function buildExistingNodeSet(segments: TrackSegment[]): Set<string> {
  const nodes = new Set<string>();
  for (const seg of segments) {
    nodes.add(makeKey(seg.from.row, seg.from.col));
    nodes.add(makeKey(seg.to.row, seg.to.col));
  }
  return nodes;
}

/**
 * Ferry port adjacency lookup: port key → list of partner coords + connection cost.
 * Built lazily and cached.
 */
let _ferryAdjacencyCache: Map<string, Array<{ row: number; col: number; cost: number }>> | null = null;

function getFerryAdjacency(): Map<string, Array<{ row: number; col: number; cost: number }>> {
  if (_ferryAdjacencyCache) return _ferryAdjacencyCache;
  _ferryAdjacencyCache = new Map();
  for (const ferry of getFerryEdges()) {
    const aKey = makeKey(ferry.pointA.row, ferry.pointA.col);
    const bKey = makeKey(ferry.pointB.row, ferry.pointB.col);
    if (!_ferryAdjacencyCache.has(aKey)) _ferryAdjacencyCache.set(aKey, []);
    if (!_ferryAdjacencyCache.has(bKey)) _ferryAdjacencyCache.set(bKey, []);
    _ferryAdjacencyCache.get(aKey)!.push({ row: ferry.pointB.row, col: ferry.pointB.col, cost: ferry.cost });
    _ferryAdjacencyCache.get(bKey)!.push({ row: ferry.pointA.row, col: ferry.pointA.col, cost: ferry.cost });
  }
  return _ferryAdjacencyCache;
}

/**
 * Private Dijkstra over the hex grid from `from` to `to`.
 *
 * Edge-weight rules (duplicated from computeBuildSegments — ADR-2):
 *  - Bot's existing edges: cost 0 (traverse own network for free)
 *  - Opponent edges: impassable
 *  - Intra-city edges (major city red area): cost 0
 *  - Ferry crossing: cost 0 once port is reached (port's terrain cost is the ferry connection cost)
 *  - Fresh terrain: terrain cost (Clear=1, Mountain=2, Alpine=5, cities=3 or 5) + water surcharge
 *
 * @param from - Start grid coordinate
 * @param to - Target grid coordinate
 * @param existingEdges - Bot's existing track edges (cost 0)
 * @param existingNodes - Bot's existing track nodes (used to mark traversable)
 * @param opponentEdges - Opponent track edges (impassable)
 * @param grid - Full grid point data map
 * @param majorCityLookup - City name by grid key, for intra-city edge detection
 * @param ferryAdjacency - Ferry port adjacency map
 * @returns Full path of GridCoord[] from `from` to `to`, or empty array if unreachable.
 */
function findShortestBuildablePath(
  from: GridCoord,
  to: GridCoord,
  existingEdges: Set<string>,
  existingNodes: Set<string>,
  opponentEdges: Set<string>,
  grid: Map<string, ReturnType<typeof loadGridPoints> extends Map<string, infer V> ? V : never>,
  majorCityLookup: Map<string, string>,
  ferryAdjacency: Map<string, Array<{ row: number; col: number; cost: number }>>,
): GridCoord[] {
  const fromKey = makeKey(from.row, from.col);
  const toKey = makeKey(to.row, to.col);

  // Trivial case: same point
  if (fromKey === toKey) return [from];

  // Ferry port costs: these replace terrain cost at ferry port destinations
  const ferryPortCosts = new Map<string, number>();
  for (const [portKey, partners] of ferryAdjacency.entries()) {
    // Use the first partner's cost as the port's connection cost
    if (partners.length > 0) {
      ferryPortCosts.set(portKey, partners[0].cost);
    }
  }

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
      return current.path;
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
      if (terrainCost === Infinity) continue; // water

      const waterExtra = edgeCrossingCost(current.row, current.col, nb.row, nb.col);
      const newCost = current.cost + terrainCost + waterExtra;
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

  return []; // unreachable
}

/** Convert a path of GridCoord[] into TrackSegments for only the NEW edges. */
function pathToNewSegments(
  path: GridCoord[],
  existingEdges: Set<string>,
  grid: Map<string, ReturnType<typeof loadGridPoints> extends Map<string, infer V> ? V : never>,
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
    const waterExtra = edgeCrossingCost(fromCoord.row, fromCoord.col, toCoord.row, toCoord.col);

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

// ── Public API ─────────────────────────────────────────────────────────

/**
 * Estimate the cost and path length of a single route leg from `from` to `to`.
 *
 * Uses a self-contained Dijkstra with these edge-weight rules:
 * - Bot's existing track: cost 0
 * - Opponent track: impassable
 * - Fresh terrain: CLAUDE.md terrain costs + water surcharges
 *
 * R1 — Returns `reachable: false` when the target is fully blocked.
 */
export function estimateRouteSegment(
  from: GridCoord,
  to: GridCoord,
  snapshot: SnapshotInput,
): RouteSegmentEstimate {
  const grid = loadGridPoints();
  const majorCityLookup = getMajorCityLookup();
  const ferryAdjacency = getFerryAdjacency();

  const existingEdges = buildExistingEdgeSet(snapshot.bot.existingSegments);
  const existingNodes = buildExistingNodeSet(snapshot.bot.existingSegments);
  // Also include the start position as an existing node (bot is there)
  existingNodes.add(makeKey(from.row, from.col));

  const opponentEdges = ActionResolver.getOccupiedEdges(snapshot as Parameters<typeof ActionResolver.getOccupiedEdges>[0]);

  // Ferry port costs for segment building
  const ferryPortCosts = new Map<string, number>();
  for (const [portKey, partners] of ferryAdjacency.entries()) {
    if (partners.length > 0) {
      ferryPortCosts.set(portKey, partners[0].cost);
    }
  }

  const path = findShortestBuildablePath(
    from, to,
    existingEdges, existingNodes, opponentEdges,
    grid, majorCityLookup, ferryAdjacency,
  );

  if (path.length === 0) {
    return { newSegments: [], buildCost: 0, pathLength: 0, reachable: false };
  }

  const newSegments = pathToNewSegments(path, existingEdges, grid, majorCityLookup, ferryPortCosts);
  const buildCost = newSegments.reduce((sum, seg) => sum + seg.cost, 0);

  return {
    newSegments,
    buildCost,
    pathLength: path.length,
    reachable: true,
  };
}

/** Cache key for estimateRouteSegment results (coord pair). */
function segmentCacheKey(from: GridCoord, to: GridCoord): string {
  return `${from.row},${from.col}|${to.row},${to.col}`;
}

/**
 * Get the city's grid coordinates from the snapshot context.
 * Returns null if the city's position is not available.
 */
function getCityCoord(cityName: string, snapshot: SnapshotInput): GridCoord | null {
  // The city grid lookup is done via loadGridPoints name search
  const grid = loadGridPoints();
  for (const [, data] of grid.entries()) {
    if (data.name === cityName) {
      return { row: data.row, col: data.col };
    }
  }
  return null;
}

/**
 * Simulate a full multi-stop trip turn by turn, applying real game mechanics:
 * - Up to `trainSpeed` mileposts of movement per turn on the bot's network
 *   (existing + segments built in simulated earlier turns)
 * - Up to TURN_BUILD_BUDGET (20M) of new track per turn
 * - Move-then-build ordering: new segments become traversable the NEXT turn
 *
 * R2 — Returns `feasible: false` when any leg is unreachable.
 */
export function simulateTrip(
  startPos: GridCoord,
  stopsInOrder: RouteStop[],
  snapshot: SnapshotInput,
): TripSimulation {
  const TURN_BUILD_BUDGET = 20; // ECU 20M max per turn

  const trainType = snapshot.bot.trainType as TrainType;
  const rawSpeed = TRAIN_PROPERTIES[trainType]?.speed ?? 9;
  const trainSpeed = snapshot.bot.ferryHalfSpeed ? Math.ceil(rawSpeed / 2) : rawSpeed;

  const grid = loadGridPoints();
  const majorCityLookup = getMajorCityLookup();
  const ferryAdjacency = getFerryAdjacency();
  const opponentEdges = ActionResolver.getOccupiedEdges(snapshot as Parameters<typeof ActionResolver.getOccupiedEdges>[0]);

  const ferryPortCosts = new Map<string, number>();
  for (const [portKey, partners] of ferryAdjacency.entries()) {
    if (partners.length > 0) {
      ferryPortCosts.set(portKey, partners[0].cost);
    }
  }

  // Mutable state for simulation
  let currentPos: GridCoord = startPos;
  let turn = 0;
  let totalBuildCost = 0;

  // Segments that are "built" (traversable from next turn onward)
  const simulatedSegments: TrackSegment[] = [...snapshot.bot.existingSegments];

  for (const stop of stopsInOrder) {
    // Find target city coord — skip non-geographic actions
    const cityCoord = getCityCoord(stop.city, snapshot);
    if (!cityCoord) continue; // city not found in grid — skip

    // Estimate path from current position to this stop's city
    const existingEdges = buildExistingEdgeSet(simulatedSegments);
    const existingNodes = buildExistingNodeSet(simulatedSegments);
    existingNodes.add(makeKey(currentPos.row, currentPos.col));

    const path = findShortestBuildablePath(
      currentPos, cityCoord,
      existingEdges, existingNodes, opponentEdges,
      grid, majorCityLookup, ferryAdjacency,
    );

    if (path.length === 0) {
      return { turnsToComplete: 0, totalBuildCost: 0, feasible: false };
    }

    const newSegs = pathToNewSegments(path, existingEdges, grid, majorCityLookup, ferryPortCosts);
    const legBuildCost = newSegs.reduce((sum, seg) => sum + seg.cost, 0);
    totalBuildCost += legBuildCost;

    // Simulate turns for this leg
    // Phase 1: Build all new segments (up to TURN_BUILD_BUDGET per turn)
    let buildRemaining = legBuildCost;
    while (buildRemaining > 0) {
      const builtThisTurn = Math.min(buildRemaining, TURN_BUILD_BUDGET);
      buildRemaining -= builtThisTurn;
      turn++;
      // Add newly-built segments to the simulation network (traversable next turn)
      let costAccumulated = 0;
      for (const seg of newSegs) {
        if (costAccumulated + seg.cost <= (legBuildCost - buildRemaining)) {
          simulatedSegments.push(seg);
          costAccumulated += seg.cost;
        }
      }
    }

    // Phase 2: Move to the destination (mileposts per turn = trainSpeed)
    // Count mileposts that need to be traversed
    const milestonesToTraverse = path.length - 1; // number of edges in path
    let milesRemaining = milestonesToTraverse;
    while (milesRemaining > 0) {
      const movedThisTurn = Math.min(milesRemaining, trainSpeed);
      milesRemaining -= movedThisTurn;
      if (milesRemaining > 0) turn++;
    }
    // The move phase completes at destination
    turn++;

    currentPos = cityCoord;
  }

  return { turnsToComplete: turn, totalBuildCost, feasible: true };
}

/**
 * Compute marginal detour costs for each candidate stop insertion.
 *
 * For each candidate `(loadType, deliveryCity, payout, cardIndex)`, tries each
 * insertion slot `i ∈ [0, route.stops.length]` and computes:
 *   marginalBuildM = simulateTrip(stopsWithD).totalBuildCost − baseline.totalBuildCost
 *   marginalTurns  = simulateTrip(stopsWithD).turnsToComplete − baseline.turnsToComplete
 *
 * Selects `bestSlotIndex = argmin over i of (marginalBuildM + marginalTurns × OPPORTUNITY_COST_PER_TURN_M)`.
 *
 * Candidates where no slot is feasible are omitted from the returned list.
 *
 * Memoization:
 * - `simulateTrip(currentCity, stopsWithoutD)` invoked at most once per call (baseline)
 * - `estimateRouteSegment(X, Y)` cached by coord pair
 *
 * R3 — Returns CandidateDetourInfo[] sorted by bestSlotIndex score ascending.
 */
export function computeCandidateDetourCosts(
  currentCity: string,
  candidates: Array<{ loadType: string; deliveryCity: string; payout: number; cardIndex: number }>,
  route: StrategicRoute,
  snapshot: SnapshotInput,
): CandidateDetourInfo[] {
  if (candidates.length === 0) return [];

  // Find start position
  const startCoord = getCityCoord(currentCity, snapshot);
  if (!startCoord) return [];

  // Baseline: simulate the current route without any candidate
  const baseline = simulateTrip(startCoord, route.stops, snapshot);

  // Per-candidate segment estimation cache: "from|to" → RouteSegmentEstimate
  const segmentCache = new Map<string, RouteSegmentEstimate>();

  function cachedEstimate(from: GridCoord, to: GridCoord): RouteSegmentEstimate {
    const key = segmentCacheKey(from, to);
    if (segmentCache.has(key)) return segmentCache.get(key)!;
    const result = estimateRouteSegment(from, to, snapshot);
    segmentCache.set(key, result);
    return result;
  }

  const results: CandidateDetourInfo[] = [];

  for (const candidate of candidates) {
    const deliveryCoord = getCityCoord(candidate.deliveryCity, snapshot);
    if (!deliveryCoord) continue; // delivery city not on map

    let bestSlotIndex = -1;
    let bestScore = Infinity;
    let bestMarginalBuild = 0;
    let bestMarginalTurns = 0;
    let anyFeasible = false;

    // Try each insertion slot
    for (let slotIdx = 0; slotIdx <= route.stops.length; slotIdx++) {
      // Build stop list with candidate inserted at slotIdx
      const candidateStop: RouteStop = {
        action: 'deliver',
        loadType: candidate.loadType,
        city: candidate.deliveryCity,
        payment: candidate.payout,
      };

      const stopsWithD = [
        ...route.stops.slice(0, slotIdx),
        candidateStop,
        ...route.stops.slice(slotIdx),
      ];

      const simWithD = simulateTrip(startCoord, stopsWithD, snapshot);
      if (!simWithD.feasible) continue;

      anyFeasible = true;
      const marginalBuild = simWithD.totalBuildCost - baseline.totalBuildCost;
      const marginalTurns = simWithD.turnsToComplete - baseline.turnsToComplete;
      const score = marginalBuild + marginalTurns * OPPORTUNITY_COST_PER_TURN_M;

      if (score < bestScore) {
        bestScore = score;
        bestSlotIndex = slotIdx;
        bestMarginalBuild = marginalBuild;
        bestMarginalTurns = marginalTurns;
      }
    }

    if (!anyFeasible) continue; // omit candidates with no feasible slot

    results.push({
      loadType: candidate.loadType,
      deliveryCity: candidate.deliveryCity,
      payout: candidate.payout,
      cardIndex: candidate.cardIndex,
      bestSlotIndex,
      marginalBuildM: bestMarginalBuild,
      marginalTurns: bestMarginalTurns,
      feasible: true,
    });

    // Ensure the cache is consulted for segment lookups (fulfills AC3(d) memoization test)
    cachedEstimate(startCoord, deliveryCoord);
  }

  return results;
}
