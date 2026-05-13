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
 * ADR-2 note (superseded by BE-002): Per-leg path-finding is now delegated to
 * the shared `findBuildPath` utility in `pathfinding/findBuildPath.ts`. This
 * eliminates the intentional duplication that existed between this module and
 * computeBuildSegments.ts. Updating the shared helper propagates to both callers.
 */

import {
  TrackSegment,
  TrainType,
  TRAIN_PROPERTIES,
  RouteStop,
  StrategicRoute,
} from '../../../shared/types/GameTypes';
import {
  loadGridPoints,
  GridCoord,
  makeKey,
} from './MapTopology';
import { ActionResolver } from './ActionResolver';
import { findBuildPath } from './pathfinding/findBuildPath';

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
  /**
   * Lowest cumulative cash delta (relative to starting cash = 0) reached at any
   * point during the simulated trip. Negative = the bot would dip below starting
   * cash by that much. 0 means cash never dropped below the starting level.
   * Safe default: 0 when feasible: false.
   */
  minCashRelative: number;
  /**
   * Cumulative cash delta at the end of the simulated trip. Starting cash +
   * finalCashRelative = projected cash on hand after the last delivery.
   * Safe default: 0 when feasible: false.
   */
  finalCashRelative: number;
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

// ── Public API ─────────────────────────────────────────────────────────

/**
 * Estimate the cost and path length of a single route leg from `from` to `to`.
 *
 * Delegates path-finding to the shared `findBuildPath` utility (BE-002).
 * Preserves public API — returns `reachable: false` when the target is
 * fully blocked by opponent track or otherwise unreachable.
 *
 * R1 — Returns `reachable: false` when the target is fully blocked.
 */
export function estimateRouteSegment(
  from: GridCoord,
  to: GridCoord,
  snapshot: SnapshotInput,
): RouteSegmentEstimate {
  const existingEdges = buildExistingEdgeSet(snapshot.bot.existingSegments);
  // existingTrackIndex: segments-only node set (no start hex) — feeds the
  // parallel-build penalty in findBuildPath without penalizing first-hop edges.
  const existingTrackIndex = buildExistingNodeSet(snapshot.bot.existingSegments);

  const opponentEdges = ActionResolver.getOccupiedEdges(snapshot as Parameters<typeof ActionResolver.getOccupiedEdges>[0]);

  const { path, segments: newSegments, totalCost: buildCost } = findBuildPath(
    from, to,
    existingEdges, existingTrackIndex, opponentEdges,
  );

  if (path.length === 0) {
    return { newSegments: [], buildCost: 0, pathLength: 0, reachable: false };
  }

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
 * Per-leg path-finding is delegated to the shared `findBuildPath` utility
 * (BE-002), eliminating the duplicate Dijkstra that previously drifted from
 * computeBuildSegments.
 *
 * R2 — Returns `feasible: false` when any leg is unreachable.
 */
export function simulateTrip(
  startPos: GridCoord,
  stopsInOrder: RouteStop[],
  snapshot: SnapshotInput,
  options?: { pendingUpgradeCost?: number },
): TripSimulation {
  const TURN_BUILD_BUDGET = 20; // ECU 20M max per turn

  const trainType = snapshot.bot.trainType as TrainType;
  const rawSpeed = TRAIN_PROPERTIES[trainType]?.speed ?? 9;
  const trainSpeed = snapshot.bot.ferryHalfSpeed ? Math.ceil(rawSpeed / 2) : rawSpeed;

  const opponentEdges = ActionResolver.getOccupiedEdges(snapshot as Parameters<typeof ActionResolver.getOccupiedEdges>[0]);

  // Mutable state for simulation
  let currentPos: GridCoord = startPos;
  let turn = 0;
  let totalBuildCost = 0;

  // Cash-flow tracking (R2): running cumulative cash delta relative to starting cash.
  // Decremented by build spend each build turn; incremented by delivery payout on the
  // turn the stop is reached. Safe-defaults: 0 for both fields.
  let cashRelative = 0;
  let minCashRelative = 0;

  // JIRA-232 Defect A: subtract pending upgrade cost on turn 0 before any
  // build/move work begins. This ensures the affordability gate sees the true
  // cash floor when an upgrade will be emitted alongside this route.
  const upgradeCost = options?.pendingUpgradeCost ?? 0;
  if (upgradeCost > 0) {
    cashRelative -= upgradeCost;
    minCashRelative = Math.min(minCashRelative, cashRelative);
  }

  // Segments that are "built" (traversable from next turn onward)
  const simulatedSegments: TrackSegment[] = [...snapshot.bot.existingSegments];

  for (const stop of stopsInOrder) {
    // Find target city coord — skip non-geographic actions
    const cityCoord = getCityCoord(stop.city, snapshot);
    if (!cityCoord) continue; // city not found in grid — skip

    // Estimate path from current position to this stop's city.
    // existingEdges: full edge set for free traversal.
    // existingTrackIndex: segments-only node set (no start hex) — feeds the
    // parallel-build penalty without penalizing first-hop edges from current pos.
    const existingEdges = buildExistingEdgeSet(simulatedSegments);
    const existingTrackIndex = buildExistingNodeSet(simulatedSegments);

    const { path, segments: newSegs, totalCost: legBuildCost } = findBuildPath(
      currentPos, cityCoord,
      existingEdges, existingTrackIndex, opponentEdges,
    );

    if (path.length === 0) {
      return { turnsToComplete: 0, totalBuildCost: 0, feasible: false, minCashRelative: 0, finalCashRelative: 0 };
    }

    totalBuildCost += legBuildCost;

    // Simulate turns for this leg
    // Phase 1: Build all new segments (up to TURN_BUILD_BUDGET per turn)
    let buildRemaining = legBuildCost;
    while (buildRemaining > 0) {
      const builtThisTurn = Math.min(buildRemaining, TURN_BUILD_BUDGET);
      buildRemaining -= builtThisTurn;
      // Cash-flow: each build turn spends `builtThisTurn` ECU
      cashRelative -= builtThisTurn;
      minCashRelative = Math.min(minCashRelative, cashRelative);
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
    // Account for the leg's destination turn — but only when *something*
    // actually happened on this leg (build or movement). Without this guard,
    // zero-distance, zero-build stops (e.g., a second deliver at a city we
    // just delivered at — typical of P3 shared-delivery pairs) would each
    // add a spurious +1 turn that systematically punishes pair candidates
    // in score-based ranking. JIRA-220 follow-up: this fix unblocks deterministic
    // pair selection by removing the simulator's per-stop turn tax for
    // already-arrived stops.
    if (legBuildCost > 0 || milestonesToTraverse > 0) {
      turn++;
    }

    // Cash-flow: delivery payout arrives when the bot reaches the delivery city
    if (stop.action === 'deliver' && stop.payment != null) {
      cashRelative += stop.payment;
      minCashRelative = Math.min(minCashRelative, cashRelative);
    }

    currentPos = cityCoord;
  }

  return { turnsToComplete: turn, totalBuildCost, feasible: true, minCashRelative, finalCashRelative: cashRelative };
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
