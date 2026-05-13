/**
 * DeterministicTripPlanner.ts
 *
 * Implements a deterministic spatial-prune top-1 trip-planning algorithm.
 * This is a production port of scripts/ai/spatial-prune-analysis.ts, adapted
 * to consume WorldSnapshot / GameContext / BotMemoryState instead of NDJSON
 * log dumps.
 *
 * Algorithm overview:
 *  1. Extract demand rows (NormalizedDemandRow) from GameContext.demands.
 *  2. Detect which loads are currently carried via dual-signal carry detection.
 *  3. Enumerate all single, pair, and triple demand-fulfillment candidates.
 *  4. Cheap-prune candidates whose optimistic turn/build estimates exceed thresholds.
 *  5. Simulate surviving candidates via RouteDetourEstimator.simulateTrip.
 *  6. Score feasible candidates: score = (payout − buildCost) − OCPT × turns.
 *  7. Return the top-1 scored candidate as a StrategicRoute.
 */

import { simulateTrip } from './RouteDetourEstimator';
import { hexDistance, loadGridPoints } from './MapTopology';
import type { GridPointData } from './MapTopology';
import { estimateGraphPathCost } from './PathCostEstimator';
import { LoadService } from '../loadService';
import {
  WorldSnapshot,
  GameContext,
  BotMemoryState,
  DemandContext,
  StrategicRoute,
  RouteStop,
  LlmAttempt,
  TrackSegment,
} from '../../../shared/types/GameTypes';

// ── Tunables ───────────────────────────────────────────────────────────

/**
 * Opportunity cost per turn (ECU-equivalent score points), keyed by game phase.
 *
 * Each turn the bot spends is penalized in score by this many ECU. The value
 * shifts across the strategic arc of a game:
 *
 * - **Early (OCPT=2)** — track is sparse, every delivery has high marginal
 *   value because each connection unlocks more of the network. The bot should
 *   accept long, expensive trips that pay off compounding. Low OCPT favors
 *   multi-stop pair/triple candidates that consolidate cards and build
 *   useful track in fewer total turns than equivalent singles would.
 * - **Mid (OCPT=4)** — slightly below income velocity to favor pair/triple
 *   candidates that consolidate multiple cards across the bot's growing
 *   network. JIRA-227 + JIRA-228 unlocked more multi-stop candidates;
 *   lowering OCPT here lets them compete on score. Was 5.
 * - **Late (OCPT=5)** — the bot is racing to ECU 250M cash and 7 connected
 *   major cities. OCPT matches measured income velocity (~5 M/turn observed
 *   post-Superfreight across recent games) so that long-haul pair/triple
 *   trips with higher net-per-turn can compete with short singles instead of
 *   being structurally crushed by an over-tuned opportunity cost.
 *
 * History:
 * - Originally a single constant 8 (empirically tuned). +3 above income
 *   velocity was compensating for a simulator quirk where every stop added
 *   a spurious +1 destination turn — fixed in RouteDetourEstimator.
 * - Then 5 (income-velocity match), then 3.5 (pair-friendly tilt across
 *   all phases), then phase-aware {early:2, mid:5, late:7}, then
 *   {early:2, mid:4, late:7} after JIRA-227/228 unlocked pair/triple
 *   candidates that were previously pruned. Late-phase value dropped from
 *   7 → 5 after log analysis showed Superfreight bots never selecting
 *   triple-load routes — late OCPT=7 was ~40% above their measured income
 *   velocity, making long trips uncompetitive regardless of net payoff.
 *
 * Do not change values without re-running scripts/ai/sweep-spatial-prune.py
 * to confirm no regression in strict-loss count. If pair-pick rate trends
 * too high (bot bites off trips it cannot afford in a phase), nudge that
 * phase's value upward; if singles still dominate when pairs would be
 * better in a phase, nudge it downward.
 */
export const OCPT_BY_PHASE = {
  early: 2,
  mid: 4,
  late: 5,
} as const;

/**
 * Default OCPT — exposed for backward compatibility and direct
 * `scoreCandidate` calls that don't have phase context. Equivalent to
 * mid-phase. Production callers go through `planTripDeterministic`, which
 * computes the phase from snapshot/memory state and uses
 * `OCPT_BY_PHASE[phase]`.
 */
export const OCPT = OCPT_BY_PHASE.mid;

/**
 * Affordability floor for the cash-dip gate in scoreCandidate.
 *
 * Default: 0 — the bot may spend to zero but not below. This enforces
 * CLAUDE.md "maintain operating capital" at trip selection rather than
 * relying on guardrails after a doomed commitment.
 *
 * Per user direction: never suggest reserve floors above zero. Phase-aware
 * floors and mercy-borrow modeling are explicitly deferred (see TD-1 in the
 * technical spec). Callers may override via scoreCandidate's optional
 * affordabilityFloorM option for specific future use cases.
 */
export const AFFORDABILITY_FLOOR_M = 0;

/**
 * Classify the game's strategic phase from observable bot state.
 *
 * Boundaries:
 * - LATE when the bot has connected ≥5 major cities OR turn ≥ 80.
 *   The win condition needs 7 cities + ECU 250M; at 5/7 connected the
 *   endgame is in sight regardless of turn count, and turn 80 is deep
 *   enough that most games are close to finishing. Turn boundary was 60
 *   before; raised to 80 to extend mid-phase OCPT=4 by 20 turns and let
 *   pair/triple candidates compete longer.
 * - EARLY when turn < 25 OR deliveries < 3 OR citiesConnected < 2.
 *   The bot is still in network-building mode; few completed deliveries
 *   means cards in hand are largely unrealized investments.
 * - MID otherwise — past the build-out phase, not yet sprinting to win.
 */
export function classifyGamePhase(
  turn: number,
  deliveries: number,
  citiesConnected: number,
): 'early' | 'mid' | 'late' {
  if (citiesConnected >= 5 || turn >= 80) return 'late';
  if (turn < 25 || deliveries < 3 || citiesConnected < 2) return 'early';
  return 'mid';
}

export const PRUNE_MAX_TURNS = 12;
export const PRUNE_MAX_BUILD_M = 130;
export const HOP_AVG_COST_M = 1.3;

// ── Train lookups ──────────────────────────────────────────────────────

const TRAIN_CAP: Record<string, number> = {
  freight: 2,
  fast_freight: 2,
  heavy_freight: 3,
  superfreight: 3,
};

const TRAIN_SPEED: Record<string, number> = {
  freight: 9,
  fast_freight: 12,
  heavy_freight: 9,
  superfreight: 12,
};

// ── Public API types ───────────────────────────────────────────────────

export interface DeterministicTripPlannerOptions {
  ocpt?: number;
  pruneMaxTurns?: number;
  pruneMaxBuildM?: number;
  hopAvgCostM?: number;
}

export interface DeterministicTripPlanResult {
  route: StrategicRoute | null;
  reasoning: string;
  outcome: 'success' | 'no_feasible_candidates';
  synthesizedAttempt: LlmAttempt;
}

// ── Internal types ─────────────────────────────────────────────────────

interface NormalizedDemandRow {
  loadType: string;
  supplyCity: string | null;
  deliveryCity: string;
  payout: number;
  cardIndex: number;
  isCarry: boolean;
}

interface Candidate {
  id: string;
  rows: NormalizedDemandRow[];
  stops: RouteStop[];
  payout: number;
}

interface ScoredCandidate extends Candidate {
  buildCost: number;
  turns: number;
  net: number;
  score: number;
  feasible: boolean;
  // JIRA-229: aggregate two-trip look-ahead scoring fields.
  // `aggregateScore` is the primary rank key — income velocity computed over
  // this trip plus the best feasible follow-up trip (with empty-leg accounted for).
  // Populated after the simulation/scoring pass via computeAggregateScore.
  // When no feasible follow-up exists, falls back to per-trip net/turns.
  aggregateScore: number;
  aggregateFollowup: ScoredCandidate | null;
  aggregateEmptyLegTurns: number;
  /**
   * New track segments built by this candidate's simulated trip, in build order.
   * Populated from TripSimulation.builtSegments inside scoreCandidate.
   * Empty array for infeasible candidates or candidates requiring no new track.
   *
   * R2 — Used by computeAggregateScore to construct post-c1 network snapshots
   * for chained c2 re-simulation (JIRA-237).
   */
  builtSegments: ReadonlyArray<TrackSegment>;
}

interface GridCoord {
  row: number;
  col: number;
}

interface ResolvedOptions {
  ocpt: number;
  pruneMaxTurns: number;
  pruneMaxBuildM: number;
  hopAvgCostM: number;
}

interface PruneStats {
  total: number;
  survivors: number;
  prunedByTurns: number;
  prunedByBuild: number;
}

// ── City coordinate lookup ─────────────────────────────────────────────

function buildCityToCoords(): Map<string, GridCoord[]> {
  const grid: Map<string, GridPointData> = loadGridPoints();
  const cityToCoords: Map<string, GridCoord[]> = new Map();
  for (const [, pt] of grid) {
    if (pt.name) {
      if (!cityToCoords.has(pt.name)) cityToCoords.set(pt.name, []);
      cityToCoords.get(pt.name)!.push({ row: pt.row, col: pt.col });
    }
  }
  return cityToCoords;
}

function nearestCityCoord(
  name: string,
  from: GridCoord,
  cityToCoords: Map<string, GridCoord[]>,
): GridCoord | null {
  const coords = cityToCoords.get(name);
  if (!coords || coords.length === 0) return null;
  let best = coords[0];
  let bestDist = hexDistance(from.row, from.col, best.row, best.col);
  for (const c of coords) {
    const d = hexDistance(from.row, from.col, c.row, c.col);
    if (d < bestDist) {
      best = c;
      bestDist = d;
    }
  }
  return best;
}

// ── Carry detection (R3) ───────────────────────────────────────────────

/**
 * Returns a Map<loadType, count> representing how many instances of each load
 * the bot is actually carrying.
 *
 * Combines two signals:
 *  1. cargoLoads (from snapshot.bot.loads) — canonical, per-instance source of
 *     truth for multiplicity. If the bot carries ['Copper', 'Coal'], the map
 *     contains { Copper: 1, Coal: 1 }.
 *  2. activeRoute stops where a `deliver <load>` appears with no preceding
 *     `pickup <load>` in the same plan — implicit carry, used when isLoadOnTrain
 *     flags are stale or missing.
 *
 * Multiplicity guarantee (R1): the count per loadType is the maximum of
 * cargoLoads count and implicit-carry signal (1 when implicit, 0 otherwise).
 * This prevents two demand cards sharing the same loadType from both getting
 * isCarry=true when the bot only carries one instance.
 *
 * When signals disagree, logs a console.warn and takes the union (conservative).
 */
export function detectCarriedLoads(
  activeRoute: StrategicRoute | null,
  demands: DemandContext[],
  cargoLoads: string[] = [],
): Map<string, number> {
  // Build per-loadType count from canonical cargo array (snapshot.bot.loads).
  // Array allows duplicates — e.g. ['Copper', 'Coal', 'Copper'] → {Copper:2, Coal:1}.
  const cargoCount = new Map<string, number>();
  for (const loadType of cargoLoads) {
    cargoCount.set(loadType, (cargoCount.get(loadType) ?? 0) + 1);
  }

  // Signal 1: canonical isLoadOnTrain flag (legacy — may not reflect multiplicity).
  // Ensures any loadType flagged by isLoadOnTrain shows at least count=1.
  for (const d of demands) {
    if (d.isLoadOnTrain && !cargoCount.has(d.loadType)) {
      cargoCount.set(d.loadType, 1);
    }
  }

  // Signal 2: implicit carry from activeRoute stops (deliver with no preceding pickup).
  // Only fires when cargoLoads is empty or lacks the loadType (stale snapshot defense).
  const implicitCarry = new Set<string>();
  if (activeRoute?.stops) {
    const pickedUp = new Set<string>();
    for (const stop of activeRoute.stops) {
      if (stop.action === 'pickup') {
        pickedUp.add(stop.loadType);
      } else if (stop.action === 'deliver' && !pickedUp.has(stop.loadType)) {
        implicitCarry.add(stop.loadType);
      }
    }
  }

  // Merge implicit signal — but only if cargoCount is 0 for that loadType.
  // Preserves multiplicity from cargoLoads while still catching stale states.
  for (const loadType of implicitCarry) {
    if (!cargoCount.has(loadType)) {
      cargoCount.set(loadType, 1);
    }
  }

  // Warn when signals disagree (for debugging signal-source divergence)
  const canonicalTypes = new Set(demands.filter(d => d.isLoadOnTrain).map(d => d.loadType));
  for (const loadType of implicitCarry) {
    if (!canonicalTypes.has(loadType) && !cargoLoads.includes(loadType)) {
      console.warn(
        `[DeterministicTripPlanner] detectCarriedLoads signal mismatch: ` +
        `loadType=${loadType} canonical=false implicit=true — treating as carry`,
      );
    }
  }
  for (const loadType of canonicalTypes) {
    if (!implicitCarry.has(loadType) && activeRoute?.stops?.some(s => s.action === 'deliver' && s.loadType === loadType)) {
      console.warn(
        `[DeterministicTripPlanner] detectCarriedLoads signal mismatch: ` +
        `loadType=${loadType} canonical=true implicit=false — treating as carry`,
      );
    }
  }

  return cargoCount;
}

// ── Row normalization ──────────────────────────────────────────────────

/**
 * Normalize demand rows into NormalizedDemandRow[] with multiplicity-aware isCarry flags.
 *
 * Multiplicity rule (R1, ADR-4): when multiple demand rows share a loadType,
 * mark isCarry=true only on the top-N rows (N = cargo count for that loadType).
 * Tie-breaking rule: highest payout wins. This maximizes expected utility of
 * the carried instance. Rows with equal payout keep stable insertion order.
 *
 * Example: bot.loads=['Copper'], demands=[{Copper,50M},{Copper,20M},{Coal,15M}]
 *   → {Copper,50M}: isCarry=true  (highest-payout Copper wins the slot)
 *   → {Copper,20M}: isCarry=false (slot exhausted by the 50M demand)
 *   → {Coal,15M}:   isCarry=false (Coal not in cargo)
 */
export function normalizeRows(
  demands: DemandContext[],
  carried: Map<string, number>,
): NormalizedDemandRow[] {
  // For each loadType with carry count > 0, determine which N demand rows
  // (sorted descending by payout) get isCarry=true. Winners are tracked by
  // the row's index in `demands` — NOT by cardIndex, because each demand
  // card carries three rows (one per (load,city,payout) tuple) that share
  // the same cardIndex; keying on cardIndex would flag all three siblings
  // as carried whenever one of them wins a slot.
  const carryWinners = new Set<number>();

  // Group demands by loadType to pick the top-N per type. Track original
  // array index alongside the row so winners can be recorded uniquely.
  const byLoadType = new Map<string, { row: DemandContext; index: number }[]>();
  for (let i = 0; i < demands.length; i++) {
    const d = demands[i];
    if (!byLoadType.has(d.loadType)) byLoadType.set(d.loadType, []);
    byLoadType.get(d.loadType)!.push({ row: d, index: i });
  }

  for (const [loadType, rows] of byLoadType) {
    const count = carried.get(loadType) ?? 0;
    if (count <= 0) continue;

    // Sort descending by payout; stable sort preserves insertion order for ties.
    const sorted = [...rows].sort((a, b) => b.row.payout - a.row.payout);
    for (let i = 0; i < Math.min(count, sorted.length); i++) {
      carryWinners.add(sorted[i].index);
    }
  }

  return demands.map((d, i) => ({
    loadType: d.loadType,
    supplyCity: d.supplyCity,
    deliveryCity: d.deliveryCity,
    payout: d.payout,
    cardIndex: d.cardIndex,
    isCarry: carryWinners.has(i),
  }));
}

// ── Supply variant expansion (JIRA-230 BE-001) ─────────────────────────

/**
 * For a single normalized demand row, return one row per valid supply city.
 * - Carry rows (load already on train): return single row with supplyCity=null.
 * - Empty supply list (guard): return single row with supplyCity=null.
 * - Otherwise: one row per source city, filtering unreachable variants.
 */
function getSupplyVariants(
  row: NormalizedDemandRow,
  snapshot: WorldSnapshot,
  speed: number,
): NormalizedDemandRow[] {
  if (row.isCarry) {
    return [{ ...row, supplyCity: null }];
  }
  const sourceCities = LoadService.getInstance().getSourceCitiesForLoad(row.loadType);
  if (!sourceCities || sourceCities.length === 0) {
    // No supply data from LoadService — fall back to the row's pre-computed
    // supplyCity (preserves single-supply behavior for legacy/test contexts).
    return [row];
  }
  const botPos = snapshot.bot.position ?? { row: 0, col: 0 };
  const variants: NormalizedDemandRow[] = [];
  for (const city of sourceCities) {
    const cost = estimateGraphPathCost(botPos, city, snapshot, speed);
    if (!cost.reachable) continue;
    variants.push({ ...row, supplyCity: city });
  }
  // If all were filtered as unreachable, fall back to original row
  if (variants.length === 0) {
    return [row];
  }
  return variants;
}

// ── Candidate enumeration (R4) ─────────────────────────────────────────

function genSingles(rows: NormalizedDemandRow[], snapshot: WorldSnapshot, speed: number): Candidate[] {
  const candidates: Candidate[] = [];
  for (const r of rows) {
    const variants = getSupplyVariants(r, snapshot, speed);
    for (const variant of variants) {
      const stops: RouteStop[] = variant.isCarry
        ? [
            {
              action: 'deliver',
              loadType: variant.loadType,
              city: variant.deliveryCity,
              demandCardId: variant.cardIndex,
              payment: variant.payout,
            },
          ]
        : [
            { action: 'pickup', loadType: variant.loadType, city: variant.supplyCity! },
            {
              action: 'deliver',
              loadType: variant.loadType,
              city: variant.deliveryCity,
              demandCardId: variant.cardIndex,
              payment: variant.payout,
            },
          ];
      const supSuffix = variant.isCarry ? '' : `-sup:${variant.supplyCity}`;
      candidates.push({
        id: `${variant.isCarry ? 'carry' : 'single'}:${variant.cardIndex}:${variant.loadType}${supSuffix}`,
        rows: [variant],
        stops,
        payout: variant.payout,
      });
    }
  }
  return candidates;
}

function genPairs(rows: NormalizedDemandRow[], cap: number, snapshot: WorldSnapshot, speed: number): Candidate[] {
  if (cap < 2) return [];
  const pairs: Candidate[] = [];
  const variantsByRow = rows.map((r) => getSupplyVariants(r, snapshot, speed));
  for (let i = 0; i < rows.length; i++) {
    for (let j = i + 1; j < rows.length; j++) {
      if (rows[i].cardIndex === rows[j].cardIndex) continue;
      for (const a of variantsByRow[i]) {
        for (const b of variantsByRow[j]) {
          const aCarry = a.isCarry, bCarry = b.isCarry;
          const delA: RouteStop = {
            action: 'deliver',
            loadType: a.loadType,
            city: a.deliveryCity,
            demandCardId: a.cardIndex,
            payment: a.payout,
          };
          const delB: RouteStop = {
            action: 'deliver',
            loadType: b.loadType,
            city: b.deliveryCity,
            demandCardId: b.cardIndex,
            payment: b.payout,
          };
          const pickA: RouteStop = { action: 'pickup', loadType: a.loadType, city: a.supplyCity! };
          const pickB: RouteStop = { action: 'pickup', loadType: b.loadType, city: b.supplyCity! };

          const variants: { suffix: string; stops: RouteStop[] }[] = [];
          if (aCarry && bCarry) {
            variants.push({ suffix: 'cAcB', stops: [delA, delB] });
            variants.push({ suffix: 'cBcA', stops: [delB, delA] });
          } else if (aCarry) {
            variants.push({ suffix: 'cA-pB', stops: [pickB, delA, delB] });
            variants.push({ suffix: 'pB-cA', stops: [pickB, delB, delA] });
            variants.push({ suffix: 'delAfirst', stops: [delA, pickB, delB] });
          } else if (bCarry) {
            variants.push({ suffix: 'cB-pA', stops: [pickA, delB, delA] });
            variants.push({ suffix: 'pA-cB', stops: [pickA, delA, delB] });
            variants.push({ suffix: 'delBfirst', stops: [delB, pickA, delA] });
          } else {
            // Both fresh: enumerate four geometrically-distinct orderings.
            // :AB / :BA pickup both, then deliver — minimal capacity usage.
            // :A-then-B / :B-then-A interleave — drop one before grabbing the
            // other. Wins when the second supply lies past the first delivery
            // (e.g., Wroclaw→Madrid then Valencia→Manchester routes through
            // Madrid before Valencia, so deliver Copper before picking up
            // Oranges). JIRA-228.
            variants.push({ suffix: 'AB',       stops: [pickA, pickB, delA, delB] });
            variants.push({ suffix: 'BA',       stops: [pickA, pickB, delB, delA] });
            variants.push({ suffix: 'A-then-B', stops: [pickA, delA, pickB, delB] });
            variants.push({ suffix: 'B-then-A', stops: [pickB, delB, pickA, delA] });
          }
          const supSuffix = `-sup:${a.supplyCity ?? 'null'}-${b.supplyCity ?? 'null'}`;
          for (const v of variants) {
            pairs.push({
              id: `pair:${a.cardIndex}-${a.loadType}+${b.cardIndex}-${b.loadType}:${v.suffix}${supSuffix}`,
              rows: [a, b],
              stops: v.stops,
              payout: a.payout + b.payout,
            });
          }
        }
      }
    }
  }
  return pairs;
}

function genTriples(rows: NormalizedDemandRow[], cap: number, snapshot: WorldSnapshot, speed: number): Candidate[] {
  const triples: Candidate[] = [];
  const variantsByRow = rows.map((r) => getSupplyVariants(r, snapshot, speed));
  for (let i = 0; i < rows.length; i++) {
    for (let j = i + 1; j < rows.length; j++) {
      for (let k = j + 1; k < rows.length; k++) {
        if (
          rows[i].cardIndex === rows[j].cardIndex ||
          rows[j].cardIndex === rows[k].cardIndex ||
          rows[i].cardIndex === rows[k].cardIndex
        ) {
          continue;
        }
        for (const a of variantsByRow[i]) {
          for (const b of variantsByRow[j]) {
            for (const c of variantsByRow[k]) {
        const carryCount = [a.isCarry, b.isCarry, c.isCarry].filter(Boolean).length;

        const stop = (kind: 'pickup' | 'deliver', r: NormalizedDemandRow): RouteStop =>
          kind === 'pickup'
            ? { action: 'pickup', loadType: r.loadType, city: r.supplyCity! }
            : {
                action: 'deliver',
                loadType: r.loadType,
                city: r.deliveryCity,
                demandCardId: r.cardIndex,
                payment: r.payout,
              };

        const variants: { suffix: string; stops: RouteStop[] }[] = [];
        if (carryCount === 3) {
          if (cap < 3) continue;
          variants.push({
            suffix: '3c',
            stops: [stop('deliver', a), stop('deliver', b), stop('deliver', c)],
          });
        } else if (carryCount === 2) {
          const fresh = !a.isCarry ? a : !b.isCarry ? b : c;
          const carries = [a, b, c].filter((x) => x.isCarry);
          const ca = carries[0], cb = carries[1];
          variants.push({
            suffix: '2c1f-ab',
            stops: [stop('deliver', ca), stop('pickup', fresh), stop('deliver', cb), stop('deliver', fresh)],
          });
          variants.push({
            suffix: '2c1f-ba',
            stops: [stop('deliver', cb), stop('pickup', fresh), stop('deliver', ca), stop('deliver', fresh)],
          });
          variants.push({
            suffix: '2c1f-cf',
            stops: [stop('deliver', ca), stop('deliver', cb), stop('pickup', fresh), stop('deliver', fresh)],
          });
          variants.push({
            suffix: '2c1f-cf2',
            stops: [stop('deliver', cb), stop('deliver', ca), stop('pickup', fresh), stop('deliver', fresh)],
          });
        } else if (carryCount === 1) {
          const carry = a.isCarry ? a : b.isCarry ? b : c;
          const fresh = [a, b, c].filter((x) => !x.isCarry);
          const fa = fresh[0], fb = fresh[1];
          variants.push({
            suffix: '1c2f-cAB',
            stops: [
              stop('deliver', carry),
              stop('pickup', fa),
              stop('pickup', fb),
              stop('deliver', fa),
              stop('deliver', fb),
            ],
          });
          variants.push({
            suffix: '1c2f-cBA',
            stops: [
              stop('deliver', carry),
              stop('pickup', fa),
              stop('pickup', fb),
              stop('deliver', fb),
              stop('deliver', fa),
            ],
          });
          if (cap >= 3) {
            variants.push({
              suffix: '1c2f-AcB',
              stops: [
                stop('pickup', fa),
                stop('pickup', fb),
                stop('deliver', carry),
                stop('deliver', fa),
                stop('deliver', fb),
              ],
            });
          }
          variants.push({
            suffix: '1c2f-int',
            stops: [
              stop('pickup', fa),
              stop('deliver', carry),
              stop('deliver', fa),
              stop('pickup', fb),
              stop('deliver', fb),
            ],
          });
        } else {
          // 0 carries + 3 fresh: cap≥3 only
          if (cap < 3) continue;
          variants.push({
            suffix: '3f-ABC',
            stops: [
              stop('pickup', a),
              stop('pickup', b),
              stop('pickup', c),
              stop('deliver', a),
              stop('deliver', b),
              stop('deliver', c),
            ],
          });
        }

        const supSuffix = `-sup:${a.supplyCity ?? 'null'}-${b.supplyCity ?? 'null'}-${c.supplyCity ?? 'null'}`;
        for (const v of variants) {
          triples.push({
            id: `triple:${a.cardIndex}-${a.loadType}+${b.cardIndex}-${b.loadType}+${c.cardIndex}-${c.loadType}:${v.suffix}${supSuffix}`,
            rows: [a, b, c],
            stops: v.stops,
            payout: a.payout + b.payout + c.payout,
          });
        }
            } // end for c variants
          } // end for b variants
        } // end for a variants
      }
    }
  }
  return triples;
}

// Minimal stub snapshot used when callers don't supply one (e.g., legacy tests).
// getSupplyVariants never reads the snapshot when LoadService returns [] (its
// early-return path), so this is safe for pre-JIRA-230 call sites.
const EMPTY_SNAPSHOT: WorldSnapshot = {
  gameId: '',
  gameStatus: 'active' as const,
  turnNumber: 0,
  bot: {
    playerId: '',
    userId: '',
    money: 0,
    position: { row: 0, col: 0 },
    existingSegments: [],
    demandCards: [],
    resolvedDemands: [],
    trainType: 'freight',
    loads: [],
    botConfig: null,
    connectedMajorCityCount: 0,
  },
  allPlayerTracks: [],
  loadAvailability: {},
};

/**
 * Enumerate all single, pair, and triple demand-fulfillment candidates.
 * JIRA-230 BE-002: supply-aware — one candidate per (route shape × supply choice).
 * `snapshot` and `speed` are optional for backward compatibility with pre-230
 * call sites (e.g., existing unit tests). When absent, getSupplyVariants falls
 * back to single-supply per-row behavior.
 */
export function enumerateCandidates(
  rows: NormalizedDemandRow[],
  cap: number,
  snapshot?: WorldSnapshot,
  speed?: number,
): Candidate[] {
  const snap = snapshot ?? EMPTY_SNAPSHOT;
  const spd = speed ?? 9;
  return [
    ...genSingles(rows, snap, spd),
    ...genPairs(rows, cap, snap, spd),
    ...genTriples(rows, cap, snap, spd),
  ];
}

// ── Spatial prune (R5) ─────────────────────────────────────────────────

/**
 * Graph-aware spatial prune: compute turn + build estimates using PathCostEstimator.
 * Returns keep=false if either threshold is exceeded or any leg is unreachable.
 * JIRA-230 BE-003: replaced hex-distance sum with iterated estimateGraphPathCost calls.
 */
export function cheapPrune(
  candidate: Candidate,
  startPos: GridCoord,
  speed: number,
  opts: ResolvedOptions,
  snapshot: WorldSnapshot,
): { keep: boolean; estTurns: number; estBuild: number } {
  let totalBuild = 0;
  let totalTurns = 0;
  let prevCity: string | { row: number; col: number } = startPos;
  for (const s of candidate.stops) {
    const leg = estimateGraphPathCost(prevCity, s.city, snapshot, speed);
    if (!leg.reachable) return { keep: false, estTurns: 999, estBuild: 999 };
    totalBuild += leg.buildCost;
    totalTurns += leg.estimatedTurns;
    prevCity = s.city;
  }
  const estTurns = Math.max(1, totalTurns);
  const estBuild = totalBuild;
  const keep = estTurns <= opts.pruneMaxTurns && estBuild <= opts.pruneMaxBuildM;
  return { keep, estTurns, estBuild };
}

// ── Simulation scoring (R6, R7) ────────────────────────────────────────

/**
 * Score a candidate by running it through the real trip simulator.
 * Wraps in try/catch: on throw, marks infeasible and logs warn.
 *
 * After the existing feasibility check, applies an affordability gate:
 * if snapshot.bot.money + simulation.minCashRelative < affordabilityFloor,
 * the candidate is rejected as infeasible with an "unaffordable" reasoning.
 * This prevents bots from committing to trips whose cumulative cash position
 * would dip below zero before the next delivery payout arrives.
 */
export function scoreCandidate(
  candidate: Candidate,
  startPos: GridCoord,
  snapshot: WorldSnapshot,
  opts: ResolvedOptions,
  affordabilityOptions?: { affordabilityFloorM?: number },
  memory?: BotMemoryState,
): ScoredCandidate {
  const snapshotInput = {
    bot: {
      playerId: snapshot.bot.playerId,
      existingSegments: snapshot.bot.existingSegments,
      trainType: snapshot.bot.trainType,
      ferryHalfSpeed: snapshot.bot.ferryHalfSpeed ?? false,
    },
    allPlayerTracks: snapshot.allPlayerTracks,
  };

  let result: ReturnType<typeof simulateTrip>;
  try {
    result = simulateTrip(startPos, candidate.stops, snapshotInput);
  } catch (e) {
    console.warn(
      `[DeterministicTripPlanner] scoreCandidate: simulator threw for candidate id=${candidate.id}`,
      e,
    );
    return { ...candidate, buildCost: 999, turns: 999, net: -999, score: -9999, feasible: false, aggregateScore: -9999, aggregateFollowup: null, aggregateEmptyLegTurns: 0, builtSegments: [] };
  }

  if (!result.feasible) {
    return { ...candidate, buildCost: result.totalBuildCost, turns: result.turnsToComplete, net: -999, score: -9999, feasible: false, aggregateScore: -9999, aggregateFollowup: null, aggregateEmptyLegTurns: 0, builtSegments: [] };
  }

  // JIRA-232 Defect A: proactively check whether the planner will emit an
  // upgrade alongside this route. If it will, re-simulate with the upgrade cost
  // subtracted so the affordability gate sees the true cash floor.
  // JIRA-237 R7: pass the post-upgrade trainType so simulateTrip uses the correct
  // speed and capacity for the upgraded train.
  const capSaturatedTurns = memory?.capSaturatedTurns ?? 0;
  const upgradeCheck = selectUpgradeTarget(
    snapshot.bot.trainType,
    snapshot.bot.money,
    result.totalBuildCost,
    capSaturatedTurns,
  );
  if (upgradeCheck.target) {
    // An upgrade will be emitted — re-simulate with the upgrade cost and
    // post-upgrade train type so speed/capacity reflect the upgraded train.
    try {
      result = simulateTrip(startPos, candidate.stops, snapshotInput, {
        pendingUpgradeCost: UPGRADE_COST_M,
        pendingUpgradeTrainType: upgradeCheck.target,
      });
    } catch (e) {
      console.warn(
        `[DeterministicTripPlanner] scoreCandidate: upgrade-aware re-simulation threw for candidate id=${candidate.id}`,
        e,
      );
      return { ...candidate, buildCost: 999, turns: 999, net: -999, score: -9999, feasible: false, aggregateScore: -9999, aggregateFollowup: null, aggregateEmptyLegTurns: 0, builtSegments: [] };
    }
  }

  // Affordability gate (JIRA-223): reject candidates where the simulated cash
  // position would dip below the floor before the next delivery payout arrives.
  const floor = affordabilityOptions?.affordabilityFloorM ?? AFFORDABILITY_FLOOR_M;
  const startingCash = snapshot.bot.money;
  const projectedMin = startingCash + result.minCashRelative;
  if (projectedMin < floor) {
    const stopSummary = candidate.stops.map((s) => `${s.action}:${s.city}`).join(',');
    console.log(
      `[DTP] affordability gate rejected: stops=${stopSummary} startingCash=${startingCash}M minRelative=${result.minCashRelative}M projectedMin=${projectedMin}M floor=${floor}M`,
    );
    return {
      ...candidate,
      buildCost: result.totalBuildCost,
      turns: result.turnsToComplete,
      net: -999,
      score: -9999,
      feasible: false,
      aggregateScore: -9999,
      aggregateFollowup: null,
      aggregateEmptyLegTurns: 0,
      builtSegments: [],
    };
  }

  const buildCost = result.totalBuildCost;
  const turns = result.turnsToComplete;
  const net = candidate.payout - buildCost;
  const score = net - opts.ocpt * turns;
  // aggregateScore/aggregateFollowup are populated later by computeAggregateScore
  // once all feasible candidates are known. Initialize to per-trip velocity so
  // callers that don't run the aggregate pass still get a sane rank key.
  // R2: surface builtSegments from the simulation result onto the ScoredCandidate
  // so computeAggregateScore can construct the post-c1 network snapshot (JIRA-237).
  return {
    ...candidate,
    buildCost,
    turns,
    net,
    score,
    feasible: true,
    aggregateScore: net / Math.max(turns, 1),
    aggregateFollowup: null,
    aggregateEmptyLegTurns: 0,
    builtSegments: result.builtSegments ?? [],
  };
}

// ── Aggregate two-trip look-ahead (JIRA-229) ───────────────────────────

/**
 * Compute the aggregate income velocity of a candidate when chained with its
 * best feasible follow-up trip. Mutates `c1` to populate the aggregate fields.
 *
 * Rationale: per-trip scoring (`score = net - OCPT * turns`) treats every
 * candidate as if it were the bot's last trip, which favors singles that
 * leave the bot with empty-leg "tails" to other still-held cards. The
 * aggregate considers what the bot will most plausibly do next and ranks
 * by the combined income velocity.
 *
 * The follow-up must use a disjoint set of demand cards from `c1` so the
 * same cardIndex is not consumed twice in the look-ahead.
 *
 * JIRA-237 Defect 1 fix: c2 is re-simulated against a post-c1 snapshot
 * (bot.position = c1.endCity, network = bot.network ∪ c1.builtSegments,
 * money = bot.money + c1.net). The structural re-simulation captures all
 * forms of network sharing between c1 and c2 — supply-city reach, shared
 * corridors, and Dijkstra paths that change against the richer network.
 *
 * O(N²) where N is the feasible-candidate count, typically 30-100.
 */
export function computeAggregateScore(
  c1: ScoredCandidate,
  allFeasible: ScoredCandidate[],
  cityToCoords: Map<string, GridCoord[]>,
  snapshot: WorldSnapshot,
): { aggregate: number; followup: ScoredCandidate | null; emptyLegTurns: number } {
  const c1Cards = new Set(c1.rows.map((r) => r.cardIndex));
  const c1EndCity = c1.stops[c1.stops.length - 1]?.city;
  const referencePos: GridCoord = { row: 0, col: 0 };
  const c1EndCoords = c1EndCity ? nearestCityCoord(c1EndCity, referencePos, cityToCoords) : null;

  // No reachable end city → cannot construct post-c1 position; fall through to standalone.
  if (!c1EndCoords) {
    return { aggregate: c1.net / Math.max(c1.turns, 1), followup: null, emptyLegTurns: 0 };
  }

  // Build post-c1 snapshot once per c1: bot positioned at c1.endCity, network
  // expanded with c1's built segments, cash post-delivery. trainType upgrade
  // propagation is a future enhancement — for now, retain snapshot.bot.trainType.
  const postC1Snapshot = {
    bot: {
      ...snapshot.bot,
      existingSegments: [
        ...snapshot.bot.existingSegments,
        ...(c1.builtSegments ?? []),
      ],
      money: snapshot.bot.money + c1.net,
    },
    allPlayerTracks: snapshot.allPlayerTracks,
  };

  let bestAggregate: number | null = null;
  let bestFollowup: ScoredCandidate | null = null;

  for (const c2 of allFeasible) {
    if (c2 === c1) continue;
    // Disjoint-cards check: c2 must not consume any card c1 is consuming.
    let overlap = false;
    for (const r of c2.rows) {
      if (c1Cards.has(r.cardIndex)) {
        overlap = true;
        break;
      }
    }
    if (overlap) continue;

    // Re-simulate c2 from c1.endCity against post-c1 network. Captures shared
    // track savings (any segment of c2's path on c1.builtSegments is free)
    // and absorbs the c1.end → c2.start movement as initial leg movement.
    const c2Chained = simulateTrip(c1EndCoords, c2.stops, postC1Snapshot);
    if (!c2Chained.feasible) continue;

    const c2ChainedNet = c2.payout - c2Chained.totalBuildCost;
    const aggregateTurns = Math.max(c1.turns + c2Chained.turnsToComplete, 1);
    const aggregateNet = c1.net + c2ChainedNet;
    const aggregate = aggregateNet / aggregateTurns;

    if (bestAggregate === null || aggregate > bestAggregate) {
      bestAggregate = aggregate;
      bestFollowup = c2;
    }
  }

  // Endgame fallback: no feasible disjoint follow-up. Use c1 standalone velocity.
  if (bestAggregate === null) {
    return { aggregate: c1.net / Math.max(c1.turns, 1), followup: null, emptyLegTurns: 0 };
  }

  // emptyLegTurns is always 0 under the chained model — c1.end → c2.start
  // movement is absorbed into c2Chained.turnsToComplete. Field retained for
  // back-compat on the return shape and ScoredCandidate.aggregateEmptyLegTurns.
  return { aggregate: bestAggregate, followup: bestFollowup, emptyLegTurns: 0 };
}

// ── Top-1 selection (R7) ───────────────────────────────────────────────

export function pickTop1(scored: ScoredCandidate[]): ScoredCandidate | null {
  if (scored.length === 0) return null;
  // JIRA-229: rank by aggregateScore (two-trip income velocity), tiebreak
  // by net descending, then by id for determinism.
  const sorted = [...scored].sort((a, b) => {
    if (b.aggregateScore !== a.aggregateScore) return b.aggregateScore - a.aggregateScore;
    if (b.net !== a.net) return b.net - a.net;
    return a.id.localeCompare(b.id);
  });
  return sorted[0];
}

// ── Pattern label inference ────────────────────────────────────────────

function inferPatternLabel(candidate: Candidate): string {
  const rows = candidate.rows;
  const stops = candidate.stops;

  if (rows.length === 1) {
    return rows[0].isCarry ? 'single-carry' : 'single-fresh';
  }

  if (rows.length === 2) {
    const [a, b] = rows;
    if (a.isCarry && b.isCarry) return 'pair-two-carry';
    if (a.isCarry || b.isCarry) return 'pair-carry+fresh';
    // Both fresh — inspect stop pattern for heuristic labeling
    const deliverCities = stops.filter((s) => s.action === 'deliver').map((s) => s.city);
    const pickupCities = stops.filter((s) => s.action === 'pickup').map((s) => s.city);
    if (a.supplyCity === b.supplyCity || pickupCities[0] === pickupCities[1]) {
      return 'pair-shared-supply';
    }
    if (a.deliveryCity === b.deliveryCity || deliverCities[0] === deliverCities[1]) {
      return 'pair-shared-delivery';
    }
    return 'pair-fresh+fresh';
  }

  if (rows.length === 3) {
    const carryCount = rows.filter((r) => r.isCarry).length;
    if (carryCount === 3) return 'triple-3carry';
    if (carryCount === 2) return 'triple-2carry+fresh';
    if (carryCount === 1) return 'triple-1carry+pair';
    return 'triple-3fresh';
  }

  return 'unknown';
}

// ── Reasoning string (R9, B5.3) ───────────────────────────────────────

function synthesizeReasoning(
  top1: ScoredCandidate,
  allSorted: ScoredCandidate[],
  stats: PruneStats,
  opts: ResolvedOptions,
  phase?: 'early' | 'mid' | 'late',
  supplyDiffLines?: string[],
  enumerationMs?: number,
): string {
  const pattern = inferPatternLabel(top1);
  const stopsStr = top1.stops
    .map((s, idx) => `${idx + 1}) ${s.action} ${s.loadType} at ${s.city}`)
    .join('; ');

  const patternExplanation = explainPattern(pattern, top1);
  let reasoning = `[deterministic-top-1] ${top1.id} chosen.\n`;
  if (phase) {
    reasoning += `  Phase: ${phase} (OCPT=${opts.ocpt})\n`;
  }
  reasoning += `  Picked: ${pattern} — payout ${top1.payout}M, build ${top1.buildCost}M, ${top1.turns} turns, NET ${top1.net.toFixed(0)}M, score ${top1.score.toFixed(1)}\n`;
  // JIRA-229: aggregate two-trip look-ahead line. Surfaces the chained
  // follow-up so the rank reasoning is auditable from the log.
  // JIRA-237: when post-c1 re-simulation is active, emptyLegTurns is absorbed
  // into the chained sim (reported as 0); log shows "chained-sim" to distinguish
  // from the legacy emptyLeg approximation.
  const aggStr = top1.aggregateScore.toFixed(2);
  if (top1.aggregateFollowup) {
    const emptyLegNote = top1.aggregateEmptyLegTurns === 0
      ? 'chained-sim'
      : `empty-leg ${top1.aggregateEmptyLegTurns} turns`;
    reasoning += `  Aggregate: ${aggStr} M/turn (chained with ${top1.aggregateFollowup.id}, ${emptyLegNote})\n`;
  } else {
    reasoning += `  Aggregate: ${aggStr} M/turn (standalone — no feasible follow-up)\n`;
  }
  reasoning += `  Stops: ${stopsStr}\n`;
  reasoning += `  Rationale: ${patternExplanation}\n`;

  // JIRA-230 BE-003: chosen-supply surface lines
  if (supplyDiffLines && supplyDiffLines.length > 0) {
    for (const line of supplyDiffLines) {
      reasoning += `  ${line}\n`;
    }
  }

  // Runner-ups (positions 2 and 3)
  const runnerUps = allSorted.filter((c) => c.id !== top1.id).slice(0, 2);
  for (let i = 0; i < runnerUps.length; i++) {
    const ru = runnerUps[i];
    // JIRA-229: report aggregate as the rank-loss metric, since aggregateScore
    // is now the ranking key. score is still shown for backward compatibility.
    const delta = (top1.aggregateScore - ru.aggregateScore).toFixed(2);
    reasoning += `  Runner-up #${i + 2}: ${ru.id}, aggregate ${ru.aggregateScore.toFixed(2)} M/turn, NET ${ru.net.toFixed(0)}M, ${ru.turns} turns. Lost by ${delta}.\n`;
  }

  reasoning += `  Survivors after spatial prune: ${stats.survivors} of ${stats.total} raw.\n`;
  reasoning += `  Discarded by prune: ${stats.prunedByTurns} (turns > ${opts.pruneMaxTurns}) | ${stats.prunedByBuild} (build > ${opts.pruneMaxBuildM}M).`;

  // JIRA-230 BE-004: per-replan enumeration telemetry
  if (enumerationMs !== undefined) {
    reasoning += `\n  Candidates: raw=${stats.total} survivors=${stats.survivors} enumerationMs=${enumerationMs}`;
  }

  return reasoning;
}

function explainPattern(pattern: string, candidate: Candidate): string {
  switch (pattern) {
    case 'single-carry':
      return `Bot already carries ${candidate.rows[0].loadType}; deliver directly to ${candidate.rows[0].deliveryCity}.`;
    case 'single-fresh':
      return `Single demand: pick up ${candidate.rows[0].loadType} then deliver to ${candidate.rows[0].deliveryCity}.`;
    case 'pair-two-carry':
      return `Both loads already on board; deliver both without new pickups.`;
    case 'pair-carry+fresh':
      return `One load on board, one needs pickup. Interleave to maximize efficiency.`;
    case 'pair-shared-supply':
      return `Two demands share a supply city; pick up both in one pass.`;
    case 'pair-shared-delivery':
      return `Two demands share a delivery city; deliver both in one pass.`;
    case 'pair-fresh+fresh':
      return `Two fresh demands; pick up and deliver both for combined payout.`;
    case 'triple-3carry':
      return `All three loads on board; deliver all without new pickups.`;
    case 'triple-2carry+fresh':
      return `Two loads on board, one needs pickup; deliver carries to free slots.`;
    case 'triple-1carry+pair':
      return `One load on board; deliver it, then pick up and deliver a fresh pair.`;
    case 'triple-3fresh':
      return `Three fresh demands; pick up all (cap≥3) then deliver all.`;
    default:
      return `Multi-demand route combining ${candidate.rows.length} demands.`;
  }
}

// ── LlmAttempt synthesis (R15) ─────────────────────────────────────────

function synthesizeLlmAttempt(
  top1: ScoredCandidate | null,
  latencyMs: number,
): LlmAttempt {
  return {
    attemptNumber: 0,
    status: top1 !== null ? 'success' : 'validation_error',
    responseText: top1
      ? `deterministic top-1: ${top1.id} score=${top1.score.toFixed(1)}`
      : 'no feasible candidates',
    latencyMs,
  };
}

// ── Upgrade decision (JIRA-220 follow-up) ──────────────────────────────

/**
 * Cost of any single train upgrade (rules-defined, EuroRails canonical):
 *   Freight → Fast Freight: ECU 20M
 *   Freight → Heavy Freight: ECU 20M
 *   Fast Freight → Superfreight: ECU 20M
 *   Heavy Freight → Superfreight: ECU 20M
 */
const UPGRADE_COST_M = 20;

/**
 * Cap-saturation gate for the Fast Freight → Superfreight upgrade.
 *
 * Superfreight over Fast Freight buys a third cargo slot (and zero extra
 * speed). Log analysis showed Superfreight bots almost never carrying a
 * third load, meaning the 20M upgrade was paying for a slot the planner
 * never selected routes to fill. This threshold gates the upgrade until
 * the bot has actually peaked at full capacity (loads == cap) on at least
 * N turns — concrete evidence its plans want more room.
 *
 * Heavy Freight → Superfreight is NOT gated (that upgrade buys +3 speed
 * for a bot already at cap=3).
 */
export const SUPERFREIGHT_SATURATION_THRESHOLD = 2;

/**
 * Select the upgrade target for a Medium-skill bot, or undefined if no upgrade
 * should be emitted this turn.
 *
 * Policy (per user direction): "Upgrade as soon as possible without going broke.
 * Upgrades are always a good idea — no need to model effectiveness. The only
 * modeling is: can the bot afford this given upcoming expenses (track build)
 * vs cash on hand?"
 *
 * Tier progression — pick a deterministic default rather than evaluate Fast vs
 * Heavy. Per CLAUDE.md the bot's strategic principle is "income velocity matters
 * more than payout size", so Fast Freight (speed +3) is the default upgrade
 * from base Freight. Heavy Freight (cap +1) is only chosen via explicit
 * non-deterministic paths today and is out of scope for this default.
 *
 * Affordability check — emit upgrade only when `cash ≥ upgradeCost +
 * top1.buildCost`. This mirrors the LLM-path affordability gate (TripPlanner.ts
 * line 407) using the simulator's truthful build cost. Usage fees on opponent
 * track are not modeled here; a downstream safety net (NewRoutePlanner.
 * tryConsumeUpgrade) re-checks affordability against current cash before
 * applying the upgrade and silently skips if insufficient — so emitting an
 * upgrade that becomes unaffordable mid-trip is not catastrophic, just a
 * missed opportunity for one turn.
 */
function selectUpgradeTarget(
  currentTrainType: string,
  cash: number,
  tripBuildCost: number,
  capSaturatedTurns: number,
): { target?: string; gateReason?: string } {
  const current = (currentTrainType || '').toLowerCase();
  let target: string | undefined;
  if (current === 'freight') {
    target = 'fast_freight';
  } else if (current === 'fast_freight' || current === 'heavy_freight') {
    target = 'superfreight';
  } else {
    // Already at top tier (superfreight) or unknown — no upgrade.
    return {};
  }

  // Cap-saturation gate applies only to Fast Freight → Superfreight (the
  // upgrade that buys a cargo slot). Heavy Freight → Superfreight buys speed
  // and is not gated.
  if (current === 'fast_freight' && target === 'superfreight'
      && capSaturatedTurns < SUPERFREIGHT_SATURATION_THRESHOLD) {
    return {
      gateReason: `superfreight gated (cap-saturated ${capSaturatedTurns}/${SUPERFREIGHT_SATURATION_THRESHOLD} turns)`,
    };
  }

  if (cash >= UPGRADE_COST_M + tripBuildCost) {
    return { target };
  }
  return {};
}

// ── StrategicRoute builder ─────────────────────────────────────────────

function buildStrategicRoute(
  top1: ScoredCandidate,
  turn: number,
  reasoning: string,
  upgradeOnRoute?: string,
): StrategicRoute {
  return {
    stops: top1.stops,
    currentStopIndex: 0,
    phase: 'build',
    createdAtTurn: turn,
    reasoning,
    ...(upgradeOnRoute ? { upgradeOnRoute } : {}),
  };
}

// ── Main entry point ───────────────────────────────────────────────────

/**
 * Plan a trip deterministically using the spatial-prune top-1 algorithm.
 */
export function planTripDeterministic(
  snapshot: WorldSnapshot,
  context: GameContext,
  memory: BotMemoryState,
  options?: DeterministicTripPlannerOptions,
): DeterministicTripPlanResult {
  const startMs = Date.now();

  // Phase-aware OCPT: classify game phase from observable state and pick the
  // matching OCPT_BY_PHASE value. Caller may override via options.ocpt for
  // tests or experiments.
  const phase = classifyGamePhase(
    snapshot.turnNumber ?? 0,
    memory.deliveryCount ?? 0,
    snapshot.bot.connectedMajorCityCount ?? 0,
  );

  // Cash-aware prune cap (JIRA-227 Fix B.1): when bot's cash exceeds the
  // static cap, raise the prune threshold to match — the bot can afford trips
  // it couldn't before. Static cap remains a floor for low-cash scenarios.
  // No reserve buffer applied (per "spend to zero" discipline). Caller may
  // still override via options.pruneMaxBuildM for tests.
  const baseBuildCap = options?.pruneMaxBuildM ?? PRUNE_MAX_BUILD_M;
  const dynamicBuildCap = options?.pruneMaxBuildM != null
    ? options.pruneMaxBuildM
    : Math.max(baseBuildCap, snapshot.bot.money);

  const opts: ResolvedOptions = {
    ocpt: options?.ocpt ?? OCPT_BY_PHASE[phase],
    pruneMaxTurns: options?.pruneMaxTurns ?? PRUNE_MAX_TURNS,
    pruneMaxBuildM: dynamicBuildCap,
    hopAvgCostM: options?.hopAvgCostM ?? HOP_AVG_COST_M,
  };

  // Empty hand check (R8)
  if (!context.demands || context.demands.length === 0) {
    const latencyMs = Date.now() - startMs;
    return {
      route: null,
      reasoning: '[deterministic-top-1] No demand cards in hand.',
      outcome: 'no_feasible_candidates',
      synthesizedAttempt: synthesizeLlmAttempt(null, latencyMs),
    };
  }

  // JIRA-231: Filter out structurally infeasible demands (supply/delivery city saturated)
  const feasibleDemands = context.demands.filter(d => d.isFeasible !== false);
  if (feasibleDemands.length === 0) {
    const latencyMs = Date.now() - startMs;
    return {
      route: null,
      reasoning: '[deterministic-top-1] All demand cards point to structurally unreachable cities — discard recommended.',
      outcome: 'no_feasible_candidates',
      synthesizedAttempt: synthesizeLlmAttempt(null, latencyMs),
    };
  }

  const trainTypeRaw = (snapshot.bot.trainType ?? 'freight').toLowerCase();
  const cap = TRAIN_CAP[trainTypeRaw] ?? 2;
  const speed = context.speed ?? TRAIN_SPEED[trainTypeRaw] ?? 9;

  const startPos: GridCoord = snapshot.bot.position ?? { row: 0, col: 0 };

  // Carry detection (use feasibleDemands to avoid detecting carries for infeasible demands).
  // Pass snapshot.bot.loads as canonical cargo for multiplicity-aware counting (R1, JIRA-233).
  const carried = detectCarriedLoads(memory.activeRoute, feasibleDemands, snapshot.bot.loads ?? []);
  const rows = normalizeRows(feasibleDemands, carried);

  // Enumerate all candidates (JIRA-230 BE-002: supply-aware, threaded snapshot/speed)
  const enumStartMs = Date.now();
  const allCandidates = enumerateCandidates(rows, cap, snapshot, speed);

  // Spatial prune
  let prunedByTurns = 0;
  let prunedByBuild = 0;
  const survivors: Candidate[] = [];

  for (const cand of allCandidates) {
    const { keep, estTurns, estBuild } = cheapPrune(cand, startPos, speed, opts, snapshot);
    if (keep) {
      survivors.push(cand);
    } else {
      if (Math.ceil(estTurns) > opts.pruneMaxTurns) prunedByTurns++;
      else if (estBuild > opts.pruneMaxBuildM) prunedByBuild++;
      else {
        // Both exceeded or city not found
        prunedByTurns++;
        prunedByBuild++;
      }
    }
  }

  const enumerationMs = Date.now() - enumStartMs;
  const rawCount = allCandidates.length;

  // JIRA-230 BE-004: perf budget alarm
  console.log(
    `[deterministic-top-1] Candidates: raw=${rawCount} survivors=${survivors.length} enumerationMs=${enumerationMs}`,
  );
  if (rawCount > 5000 || enumerationMs > 200) {
    console.warn(
      `[perf-budget] planTripDeterministic overrun: raw=${rawCount} survivors=${survivors.length} enumerationMs=${enumerationMs}`,
    );
  }

  const stats: PruneStats = {
    total: allCandidates.length,
    survivors: survivors.length,
    prunedByTurns,
    prunedByBuild,
  };

  // All pruned check (R8)
  if (survivors.length === 0) {
    const latencyMs = Date.now() - startMs;
    const reasoning =
      `[deterministic-top-1] All ${allCandidates.length} candidates pruned.\n` +
      `  Discarded by prune: ${prunedByTurns} (turns > ${opts.pruneMaxTurns}) | ${prunedByBuild} (build > ${opts.pruneMaxBuildM}M).\n` +
      `  Survivors after spatial prune: 0 of ${allCandidates.length} raw.\n` +
      `  Candidates: raw=${rawCount} survivors=0 enumerationMs=${enumerationMs}`;
    return {
      route: null,
      reasoning,
      outcome: 'no_feasible_candidates',
      synthesizedAttempt: synthesizeLlmAttempt(null, latencyMs),
    };
  }

  // Simulate survivors (R6)
  const feasible: ScoredCandidate[] = [];
  for (const cand of survivors) {
    const scored = scoreCandidate(cand, startPos, snapshot, opts, undefined, memory);
    if (scored.feasible) feasible.push(scored);
  }

  // No feasible candidates (R8)
  if (feasible.length === 0) {
    const latencyMs = Date.now() - startMs;
    const reasoning =
      `[deterministic-top-1] No feasible candidates after simulation.\n` +
      `  Survivors after spatial prune: ${survivors.length} of ${allCandidates.length} raw.\n` +
      `  All ${survivors.length} survivors were infeasible.`;
    return {
      route: null,
      reasoning,
      outcome: 'no_feasible_candidates',
      synthesizedAttempt: synthesizeLlmAttempt(null, latencyMs),
    };
  }

  // JIRA-229: aggregate two-trip look-ahead. Mutates each feasible candidate
  // to populate aggregateScore/aggregateFollowup before sorting.
  // JIRA-237 Defect 1: pass snapshot so computeAggregateScore can construct
  // the post-c1 snapshot and re-simulate c2 against c1's built network.
  const cityToCoords = buildCityToCoords();
  for (const c1 of feasible) {
    const result = computeAggregateScore(c1, feasible, cityToCoords, snapshot);
    c1.aggregateScore = result.aggregate;
    c1.aggregateFollowup = result.followup;
    c1.aggregateEmptyLegTurns = result.emptyLegTurns;
  }

  // Sort by aggregate score (rank key per JIRA-229) and pick top-1
  const sorted = [...feasible].sort((a, b) => {
    if (b.aggregateScore !== a.aggregateScore) return b.aggregateScore - a.aggregateScore;
    if (b.net !== a.net) return b.net - a.net;
    return a.id.localeCompare(b.id);
  });
  const top1 = pickTop1(sorted)!;

  // JIRA-232 Defect B: emit predicted build cost for post-game diff against actual.
  console.log(
    `[JIRA-232][predict] id=${top1.id} predictedBuildCost=${top1.buildCost}M stops=${top1.stops.map((s) => `${s.action}:${s.city}`).join(',')}`,
  );


  // JIRA-220 follow-up: deterministic upgrade decision. Upgrade as soon as the
  // bot can afford it given the chosen trip's build cost. Fast → Superfreight
  // is additionally gated by cap-saturation history (see SUPERFREIGHT_SATURATION_THRESHOLD).
  const upgradeDecision = selectUpgradeTarget(
    snapshot.bot.trainType,
    snapshot.bot.money,
    top1.buildCost,
    memory.capSaturatedTurns ?? 0,
  );
  const upgradeOnRoute = upgradeDecision.target;

  // JIRA-230 BE-003: compute chosen-supply surface lines.
  // For each pickup stop whose load has multiple supply cities, if the chosen
  // supply differs from the original DemandContext.supplyCity, emit a line.
  const supplyDiffLines: string[] = [];
  for (const stop of top1.stops) {
    if (stop.action !== 'pickup') continue;
    const allSources = LoadService.getInstance().getSourceCitiesForLoad(stop.loadType);
    if (!allSources || allSources.length <= 1) continue;
    // Find the original demand context for this load type
    const origDemand = context.demands.find((d) => d.loadType === stop.loadType);
    if (!origDemand) continue;
    const legacySupply = origDemand.supplyCity;
    if (legacySupply && legacySupply !== stop.city) {
      supplyDiffLines.push(
        `Supply chosen: ${stop.loadType} via ${stop.city} (DemandContext default: ${legacySupply}) — closer along existing track.`,
      );
    }
  }

  const latencyMs = Date.now() - startMs;
  const upgradeNote = upgradeOnRoute
    ? `\n  Upgrade emitted: ${upgradeOnRoute} (cost ${UPGRADE_COST_M}M, cash ${snapshot.bot.money}M, build ${top1.buildCost}M).`
    : upgradeDecision.gateReason
      ? `\n  Upgrade skipped: ${upgradeDecision.gateReason}.`
      : '';
  const reasoning = synthesizeReasoning(top1, sorted, stats, opts, phase, supplyDiffLines, enumerationMs) + upgradeNote;
  const route = buildStrategicRoute(top1, snapshot.turnNumber, reasoning, upgradeOnRoute);

  return {
    route,
    reasoning,
    outcome: 'success',
    synthesizedAttempt: synthesizeLlmAttempt(top1, latencyMs),
  };
}
