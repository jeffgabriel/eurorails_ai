/**
 * BuildRouteResolver — LLM + Dijkstra collaborative track builder (JIRA-179).
 *
 * Produces three candidate build paths per turn:
 *   1. llmGuided   — Dijkstra chained through all LLM waypoints (today's behavior).
 *   2. dijkstraDirect — Dijkstra with no waypoint constraints (shortest path).
 *   3. merged       — Dijkstra chained through only named-city/ferry-port waypoints.
 *
 * A deterministic selection rule picks the winner:
 *   - If zero candidates reach the target: closest-to-target-fallback.
 *   - Else if all reachers within RATIO_BAND cost: ratio-band-anchor-winner (most named-city
 *     anchors), tiebreak by cost (ratio-band-cost-tiebreak).
 *   - Else: cheapest reacher (cheapest).
 */

import { TrackSegment } from '../../../shared/types/GameTypes';
import { computeBuildSegments } from './computeBuildSegments';
import { loadGridPoints, GridCoord, hexDistance, makeKey } from './MapTopology';
import { getFerryEdges, type FerryEdge } from '../../../shared/services/majorCityGroups';

// ── Feature flag ─────────────────────────────────────────────────────────────

/** When true, resolveBuild routes through BuildRouteResolver instead of the single-path logic. */
export function isBuildResolverEnabled(): boolean {
  const value = process.env.ENABLE_BUILD_RESOLVER;
  if (value === undefined || value === '') return false;
  return value.toLowerCase() === 'true';
}

// Log flag status once at module load (mirrors ENABLE_AI_BOTS precedent in BotTurnTrigger).
console.log(`[BuildRouteResolver] ENABLE_BUILD_RESOLVER=${isBuildResolverEnabled() ? 'true' : 'false'}`);

// ── Constants ─────────────────────────────────────────────────────────────────

/** Cost ratio threshold for the "similar cost" band — tune without schema change. */
export const RATIO_BAND = 1.15;

// ── Types ─────────────────────────────────────────────────────────────────────

export type CandidateId = 'llmGuided' | 'dijkstraDirect' | 'merged';

export type RuleBranch =
  | 'only-reacher'
  | 'ratio-band-anchor-winner'
  | 'ratio-band-cost-tiebreak'
  | 'cheapest'
  | 'closest-to-target-fallback';

export interface Candidate {
  id: CandidateId;
  segments: TrackSegment[];
  totalCost: number;
  reachesTarget: boolean;
  /** Hex distance from last built segment endpoint to target; 0 when reachesTarget. */
  endpointDistanceToTarget: number;
  /** Names of named cities or ferry ports hit by this candidate's waypoints. */
  namedCityAnchorsHit: string[];
}

export interface AnchorClassification {
  coord: [number, number];
  namedCity: string | null;
  kept: boolean;
}

export interface ResolverInput {
  /** LLM-supplied waypoints as [row, col] pairs. May be empty. */
  waypoints: [number, number][];
  startPositions: GridCoord[];
  targetPositions: GridCoord[];
  budget: number;
  connectedSegments: TrackSegment[];
  occupiedEdges: Set<string>;
  networkNodeKeys: Set<string> | undefined;
  /** JIRA-203: Grid keys ("row,col") for saturated small/medium cities to exclude from paths. */
  saturatedCityKeys?: Set<string>;
}

export interface ResolverOutcome {
  selected: Candidate;
  candidates: { llmGuided: Candidate; dijkstraDirect: Candidate; merged: Candidate };
  ruleBranch: RuleBranch;
  reasonText: string;
  /** selected.totalCost − cheapest-reacher.totalCost (0 when selected is cheapest). */
  costDelta: number;
  anchorClassification: AnchorClassification[];
  /** JIRA-203: Saturated small/medium cities excluded from path computation (non-empty = saturation caused routing constraint). */
  rejectedSaturatedCities: Array<{ row: number; col: number }>;
}

// ── Internal helpers ──────────────────────────────────────────────────────────

/**
 * Compute total cost and endpoint distance for a set of segments.
 * When segments is empty, cost is 0 and distance is Infinity (unreachable).
 */
function measureSegments(
  segments: TrackSegment[],
  targetPositions: GridCoord[],
): { totalCost: number; reachesTarget: boolean; endpointDistanceToTarget: number } {
  if (segments.length === 0) {
    return { totalCost: 0, reachesTarget: false, endpointDistanceToTarget: Infinity };
  }
  const totalCost = segments.reduce((sum, seg) => sum + seg.cost, 0);
  const lastSeg = segments[segments.length - 1];
  const endRow = lastSeg.to.row;
  const endCol = lastSeg.to.col;

  const minDist = Math.min(
    ...targetPositions.map(tp => hexDistance(endRow, endCol, tp.row, tp.col)),
  );
  const reachesTarget = minDist === 0;
  return { totalCost, reachesTarget, endpointDistanceToTarget: reachesTarget ? 0 : minDist };
}

/**
 * Run waypoint-chained Dijkstra through a sequence of waypoints, then to target.
 * Returns concatenated segments across all legs.
 */
function chainedDijkstra(
  waypointSequence: [number, number][],
  startPositions: GridCoord[],
  targetPositions: GridCoord[],
  budget: number,
  connectedSegments: TrackSegment[],
  occupiedEdges: Set<string>,
  networkNodeKeys: Set<string> | undefined,
  saturatedCityKeys?: Set<string>,
): TrackSegment[] {
  if (waypointSequence.length === 0) {
    // No waypoints — single direct call
    return computeBuildSegments(
      startPositions,
      connectedSegments,
      budget,
      budget,
      occupiedEdges,
      targetPositions,
      undefined,
      networkNodeKeys,
      saturatedCityKeys,
    );
  }

  const allSegments: TrackSegment[] = [];
  let remainingBudget = budget;
  let currentStartPositions = startPositions;
  let currentConnectedSegments = connectedSegments;

  const waypointTargets: GridCoord[][] = waypointSequence.map(([row, col]) => [{ row, col }]);
  waypointTargets.push(targetPositions);

  for (const legTargets of waypointTargets) {
    if (remainingBudget <= 0) break;

    const legSegments = computeBuildSegments(
      currentStartPositions,
      currentConnectedSegments,
      remainingBudget,
      remainingBudget,
      occupiedEdges,
      legTargets,
      undefined,
      networkNodeKeys,
      saturatedCityKeys,
    );

    if (legSegments.length === 0) break;

    allSegments.push(...legSegments);
    const legCost = legSegments.reduce((sum, seg) => sum + seg.cost, 0);
    remainingBudget -= legCost;

    const lastSeg = legSegments[legSegments.length - 1];
    currentStartPositions = [{ row: lastSeg.to.row, col: lastSeg.to.col }];
    currentConnectedSegments = [...currentConnectedSegments, ...legSegments];
  }

  return allSegments;
}

// ── Public class ──────────────────────────────────────────────────────────────

export class BuildRouteResolver {
  /**
   * Classify each LLM waypoint as a named-city/ferry-port anchor (kept=true)
   * or an unnamed milepost (kept=false).
   *
   * A waypoint is kept when:
   *   - The grid point at its coordinate has a non-empty `name`, OR
   *   - The coordinate appears in the ferry-port set.
   */
  static classifyWaypoints(
    waypoints: [number, number][],
    gridPoints: Map<string, { name?: string }>,
    ferryEdges: FerryEdge[],
  ): AnchorClassification[] {
    // Build ferry port key set for O(1) lookup
    const ferryPortKeys = new Set<string>();
    const ferryPortNames = new Map<string, string>();
    for (const edge of ferryEdges) {
      const keyA = makeKey(edge.pointA.row, edge.pointA.col);
      const keyB = makeKey(edge.pointB.row, edge.pointB.col);
      ferryPortKeys.add(keyA);
      ferryPortKeys.add(keyB);
      // Use the edge name as the city label for ferry ports
      ferryPortNames.set(keyA, edge.name);
      ferryPortNames.set(keyB, edge.name);
    }

    return waypoints.map(([row, col]) => {
      const key = makeKey(row, col);
      const gp = gridPoints.get(key);
      const gridName = gp?.name && gp.name.trim() !== '' ? gp.name : null;
      const ferryName = ferryPortKeys.has(key) ? (ferryPortNames.get(key) ?? 'ferry') : null;
      const namedCity = gridName ?? ferryName;
      return {
        coord: [row, col] as [number, number],
        namedCity,
        kept: namedCity !== null,
      };
    });
  }

  /**
   * Compute the LLM-guided candidate: Dijkstra chained through ALL LLM waypoints.
   * When waypoints is empty, falls back to a single Dijkstra call (same as dijkstraDirect).
   */
  static computeLlmGuided(input: ResolverInput): Candidate {
    const segments = chainedDijkstra(
      input.waypoints,
      input.startPositions,
      input.targetPositions,
      input.budget,
      input.connectedSegments,
      input.occupiedEdges,
      input.networkNodeKeys,
      input.saturatedCityKeys,
    );
    const { totalCost, reachesTarget, endpointDistanceToTarget } = measureSegments(
      segments, input.targetPositions,
    );
    return {
      id: 'llmGuided',
      segments,
      totalCost,
      reachesTarget,
      endpointDistanceToTarget,
      namedCityAnchorsHit: [], // LLM-guided doesn't filter to named anchors
    };
  }

  /**
   * Compute the Dijkstra-direct candidate: single Dijkstra call with no waypoint constraints.
   */
  static computeDijkstraDirect(input: ResolverInput): Candidate {
    const segments = computeBuildSegments(
      input.startPositions,
      input.connectedSegments,
      input.budget,
      input.budget,
      input.occupiedEdges,
      input.targetPositions,
      undefined,
      input.networkNodeKeys,
      input.saturatedCityKeys,
    );
    const { totalCost, reachesTarget, endpointDistanceToTarget } = measureSegments(
      segments, input.targetPositions,
    );
    return {
      id: 'dijkstraDirect',
      segments,
      totalCost,
      reachesTarget,
      endpointDistanceToTarget,
      namedCityAnchorsHit: [],
    };
  }

  /**
   * Compute the merged candidate: Dijkstra chained through ONLY the high-signal
   * (named-city / ferry-port) waypoints from the LLM's list.
   *
   * When no high-signal anchors exist, this is equivalent to dijkstraDirect.
   */
  static computeMerged(input: ResolverInput, classification: AnchorClassification[]): Candidate {
    const keptWaypoints = classification
      .filter(c => c.kept)
      .map(c => c.coord);

    const segments = chainedDijkstra(
      keptWaypoints,
      input.startPositions,
      input.targetPositions,
      input.budget,
      input.connectedSegments,
      input.occupiedEdges,
      input.networkNodeKeys,
      input.saturatedCityKeys,
    );
    const { totalCost, reachesTarget, endpointDistanceToTarget } = measureSegments(
      segments, input.targetPositions,
    );
    const anchorsHit = classification.filter(c => c.kept).map(c => c.namedCity!);
    return {
      id: 'merged',
      segments,
      totalCost,
      reachesTarget,
      endpointDistanceToTarget,
      namedCityAnchorsHit: anchorsHit,
    };
  }

  /**
   * Apply the deterministic selection rule to the three candidates.
   *
   * Rule branches (in order):
   *   1. closest-to-target-fallback — no candidate reaches target.
   *   2. only-reacher              — exactly one candidate reaches target.
   *   3. ratio-band-anchor-winner  — all reachers within RATIO_BAND cost;
   *                                  winner has most named-city anchors.
   *   4. ratio-band-cost-tiebreak  — all reachers within ratio, same anchors.
   *   5. cheapest                  — reachers exist but outside ratio band.
   */
  static selectCandidate(
    candidates: [Candidate, Candidate, Candidate],
    options: { ratioBand?: number } = {},
  ): { selected: Candidate; ruleBranch: RuleBranch; reasonText: string } {
    const band = options.ratioBand ?? RATIO_BAND;
    const reachers = candidates.filter(c => c.reachesTarget);

    // Branch 1: no candidate reaches target
    if (reachers.length === 0) {
      const best = candidates.reduce((a, b) =>
        a.endpointDistanceToTarget <= b.endpointDistanceToTarget ? a : b,
      );
      return {
        selected: best,
        ruleBranch: 'closest-to-target-fallback',
        reasonText: `No candidate reached target. Selected ${best.id} with shortest endpoint distance (${best.endpointDistanceToTarget}).`,
      };
    }

    // Branch 2: exactly one reacher
    if (reachers.length === 1) {
      const best = reachers[0];
      return {
        selected: best,
        ruleBranch: 'only-reacher',
        reasonText: `Only ${best.id} reached target (cost=${best.totalCost}).`,
      };
    }

    // All reachers — find cheapest
    const cheapestCost = Math.min(...reachers.map(r => r.totalCost));
    const threshold = cheapestCost * band;
    const inBand = reachers.filter(r => r.totalCost <= threshold);

    if (inBand.length === 0) {
      // Shouldn't happen — cheapest reacher is always within its own ratio — but guard anyway
      const best = reachers.reduce((a, b) => a.totalCost <= b.totalCost ? a : b);
      return {
        selected: best,
        ruleBranch: 'cheapest',
        reasonText: `Costs outside ratio band. Selected cheapest reacher ${best.id} (cost=${best.totalCost}).`,
      };
    }

    // Branch 5: some reachers outside ratio band — pick cheapest reacher overall
    if (inBand.length < reachers.length) {
      const best = reachers.reduce((a, b) => a.totalCost <= b.totalCost ? a : b);
      return {
        selected: best,
        ruleBranch: 'cheapest',
        reasonText: `Costs spread outside ${band}× ratio band. Selected cheapest reacher ${best.id} (cost=${best.totalCost}).`,
      };
    }

    // All reachers within ratio band — compare anchor counts
    const maxAnchors = Math.max(...inBand.map(c => c.namedCityAnchorsHit.length));
    const anchorWinners = inBand.filter(c => c.namedCityAnchorsHit.length === maxAnchors);

    if (anchorWinners.length === 1) {
      const best = anchorWinners[0];
      return {
        selected: best,
        ruleBranch: 'ratio-band-anchor-winner',
        reasonText: `All reachers within ${band}× ratio. ${best.id} hits most anchors (${maxAnchors}), cost=${best.totalCost}.`,
      };
    }

    // Tiebreak by cost
    const best = anchorWinners.reduce((a, b) => a.totalCost <= b.totalCost ? a : b);
    return {
      selected: best,
      ruleBranch: 'ratio-band-cost-tiebreak',
      reasonText: `All reachers within ${band}× ratio, tied on anchors (${maxAnchors}). Selected cheapest: ${best.id} (cost=${best.totalCost}).`,
    };
  }

  /**
   * Main entry point: produce all three candidates and apply the selection rule.
   *
   * All computation is synchronous and in-process — no LLM re-calls.
   */
  static resolve(input: ResolverInput): ResolverOutcome {
    const gridPoints = loadGridPoints();
    const ferryEdges = getFerryEdges();

    const anchorClassification = BuildRouteResolver.classifyWaypoints(
      input.waypoints,
      gridPoints,
      ferryEdges,
    );

    const llmGuided = BuildRouteResolver.computeLlmGuided(input);
    const dijkstraDirect = BuildRouteResolver.computeDijkstraDirect(input);
    const merged = BuildRouteResolver.computeMerged(input, anchorClassification);

    const { selected, ruleBranch, reasonText } = BuildRouteResolver.selectCandidate(
      [llmGuided, dijkstraDirect, merged],
    );

    const reachers = [llmGuided, dijkstraDirect, merged].filter(c => c.reachesTarget);
    const cheapestReacherCost = reachers.length > 0
      ? Math.min(...reachers.map(r => r.totalCost))
      : 0;
    const costDelta = selected.reachesTarget
      ? selected.totalCost - cheapestReacherCost
      : 0;

    // JIRA-203: Decode saturated city coordinates from the input key set for telemetry.
    const rejectedSaturatedCities: Array<{ row: number; col: number }> = [];
    if (input.saturatedCityKeys) {
      for (const key of input.saturatedCityKeys) {
        const parts = key.split(',');
        if (parts.length === 2) {
          const row = parseInt(parts[0], 10);
          const col = parseInt(parts[1], 10);
          if (!isNaN(row) && !isNaN(col)) {
            rejectedSaturatedCities.push({ row, col });
          }
        }
      }
    }

    return {
      selected,
      candidates: { llmGuided, dijkstraDirect, merged },
      ruleBranch,
      reasonText,
      costDelta,
      anchorClassification,
      rejectedSaturatedCities,
    };
  }
}
