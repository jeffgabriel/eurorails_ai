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
import {
  WorldSnapshot,
  GameContext,
  BotMemoryState,
  DemandContext,
  StrategicRoute,
  RouteStop,
  LlmAttempt,
} from '../../../shared/types/GameTypes';

// ── Tunables ───────────────────────────────────────────────────────────

/**
 * Opportunity cost per turn (ECU-equivalent score points).
 *
 * Empirically tuned to 8 from a parameter sweep over 299 historical Sonnet
 * trip-planner decisions (scripts/ai/sweep-spatial-prune.py). At OCPT=8 the
 * deterministic algorithm makes ZERO strict-loss decisions vs the Sonnet
 * baseline; at OCPT=5 it makes 1 strict loss out of 299. OCPT=8 is the knee
 * of the win-rate curve.
 *
 * IMPORTANT — calibration note:
 * OCPT=8 is higher than the bot's per-turn income upper bound (~5M, per
 * CLAUDE.md "income velocity" principle). The discrepancy is NOT a strategic
 * choice — it is a compensation for a simulator quirk:
 *
 *   RouteDetourEstimator.simulateTrip uses strict per-leg sequencing:
 *   "build all of this leg's new track, THEN move next turn." This inflates
 *   turn count vs real play (where bots interleave build and move within a
 *   leg). To rank candidates correctly under inflated turn counts, OCPT
 *   must be inflated proportionally.
 *
 * IF THE SIMULATOR'S SEQUENCING IS EVER FIXED (e.g., a future ticket lets
 * RouteDetourEstimator interleave build+move within a leg), OCPT MUST be
 * re-tuned. The expected new value is ~5, matching the income upper bound.
 * Re-run scripts/ai/sweep-spatial-prune.py against fresh log dumps to
 * confirm before changing.
 *
 * Do not change OCPT without re-running the sweep.
 */
export const OCPT = 8;

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
 * Returns the set of loadTypes the bot is currently carrying.
 *
 * Combines two signals:
 *  1. demand.isLoadOnTrain === true (canonical carry marker).
 *  2. activeRoute stops where a `deliver <load>` appears with no preceding
 *     `pickup <load>` in the same plan — implies the bot already has that load.
 *
 * When signals disagree, logs a console.warn and treats as carry (union).
 */
export function detectCarriedLoads(
  activeRoute: StrategicRoute | null,
  demands: DemandContext[],
): Set<string> {
  // Signal 1: canonical isLoadOnTrain flag
  const canonicalCarry = new Set<string>();
  for (const d of demands) {
    if (d.isLoadOnTrain) canonicalCarry.add(d.loadType);
  }

  // Signal 2: implicit carry from activeRoute stops
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

  // Union: false positive on carry is recoverable; false negative leads to unnecessary pickup
  const carried = new Set<string>([...canonicalCarry, ...implicitCarry]);

  // Warn when signals disagree
  for (const loadType of implicitCarry) {
    if (!canonicalCarry.has(loadType)) {
      console.warn(
        `[DeterministicTripPlanner] detectCarriedLoads signal mismatch: ` +
        `loadType=${loadType} canonical=false implicit=true — treating as carry`,
      );
    }
  }
  for (const loadType of canonicalCarry) {
    if (!implicitCarry.has(loadType) && activeRoute?.stops?.some(s => s.action === 'deliver' && s.loadType === loadType)) {
      console.warn(
        `[DeterministicTripPlanner] detectCarriedLoads signal mismatch: ` +
        `loadType=${loadType} canonical=true implicit=false — treating as carry`,
      );
    }
  }

  return carried;
}

// ── Row normalization ──────────────────────────────────────────────────

function normalizeRows(
  demands: DemandContext[],
  carried: Set<string>,
): NormalizedDemandRow[] {
  return demands.map((d) => ({
    loadType: d.loadType,
    supplyCity: d.supplyCity,
    deliveryCity: d.deliveryCity,
    payout: d.payout,
    cardIndex: d.cardIndex,
    isCarry: d.isLoadOnTrain || carried.has(d.loadType),
  }));
}

// ── Candidate enumeration (R4) ─────────────────────────────────────────

function genSingles(rows: NormalizedDemandRow[]): Candidate[] {
  return rows.map((r) => {
    const stops: RouteStop[] = r.isCarry
      ? [
          {
            action: 'deliver',
            loadType: r.loadType,
            city: r.deliveryCity,
            demandCardId: r.cardIndex,
            payment: r.payout,
          },
        ]
      : [
          { action: 'pickup', loadType: r.loadType, city: r.supplyCity! },
          {
            action: 'deliver',
            loadType: r.loadType,
            city: r.deliveryCity,
            demandCardId: r.cardIndex,
            payment: r.payout,
          },
        ];
    return {
      id: `${r.isCarry ? 'carry' : 'single'}:${r.cardIndex}:${r.loadType}`,
      rows: [r],
      stops,
      payout: r.payout,
    };
  });
}

function genPairs(rows: NormalizedDemandRow[], cap: number): Candidate[] {
  if (cap < 2) return [];
  const pairs: Candidate[] = [];
  for (let i = 0; i < rows.length; i++) {
    for (let j = i + 1; j < rows.length; j++) {
      const a = rows[i], b = rows[j];
      if (a.cardIndex === b.cardIndex) continue;
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
        variants.push({ suffix: 'AB', stops: [pickA, pickB, delA, delB] });
        variants.push({ suffix: 'BA', stops: [pickA, pickB, delB, delA] });
      }
      for (const v of variants) {
        pairs.push({
          id: `pair:${a.cardIndex}-${a.loadType}+${b.cardIndex}-${b.loadType}:${v.suffix}`,
          rows: [a, b],
          stops: v.stops,
          payout: a.payout + b.payout,
        });
      }
    }
  }
  return pairs;
}

function genTriples(rows: NormalizedDemandRow[], cap: number): Candidate[] {
  const triples: Candidate[] = [];
  for (let i = 0; i < rows.length; i++) {
    for (let j = i + 1; j < rows.length; j++) {
      for (let k = j + 1; k < rows.length; k++) {
        const a = rows[i], b = rows[j], c = rows[k];
        if (
          a.cardIndex === b.cardIndex ||
          b.cardIndex === c.cardIndex ||
          a.cardIndex === c.cardIndex
        ) {
          continue;
        }
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

        for (const v of variants) {
          triples.push({
            id: `triple:${a.cardIndex}-${a.loadType}+${b.cardIndex}-${b.loadType}+${c.cardIndex}-${c.loadType}:${v.suffix}`,
            rows: [a, b, c],
            stops: v.stops,
            payout: a.payout + b.payout + c.payout,
          });
        }
      }
    }
  }
  return triples;
}

/**
 * Enumerate all single, pair, and triple demand-fulfillment candidates.
 */
export function enumerateCandidates(
  rows: NormalizedDemandRow[],
  cap: number,
): Candidate[] {
  return [...genSingles(rows), ...genPairs(rows, cap), ...genTriples(rows, cap)];
}

// ── Spatial prune (R5) ─────────────────────────────────────────────────

/**
 * O(1) per candidate: compute optimistic turn + build estimates.
 * Returns keep=false if either threshold is exceeded.
 */
export function cheapPrune(
  candidate: Candidate,
  startPos: GridCoord,
  speed: number,
  opts: ResolvedOptions,
): { keep: boolean; estTurns: number; estBuild: number } {
  const cityToCoords = buildCityToCoords();
  let totalHops = 0;
  let cur = startPos;
  for (const s of candidate.stops) {
    const dest = nearestCityCoord(s.city, cur, cityToCoords);
    if (!dest) return { keep: false, estTurns: 999, estBuild: 999 };
    totalHops += hexDistance(cur.row, cur.col, dest.row, dest.col);
    cur = dest;
  }
  const estTurns = Math.max(1, Math.ceil(totalHops / speed));
  const estBuild = totalHops * opts.hopAvgCostM;
  const keep = estTurns <= opts.pruneMaxTurns && estBuild <= opts.pruneMaxBuildM;
  return { keep, estTurns, estBuild };
}

// ── Simulation scoring (R6, R7) ────────────────────────────────────────

/**
 * Score a candidate by running it through the real trip simulator.
 * Wraps in try/catch: on throw, marks infeasible and logs warn.
 */
export function scoreCandidate(
  candidate: Candidate,
  startPos: GridCoord,
  snapshot: WorldSnapshot,
  opts: ResolvedOptions,
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

  let result: { turnsToComplete: number; totalBuildCost: number; feasible: boolean };
  try {
    result = simulateTrip(startPos, candidate.stops, snapshotInput);
  } catch (e) {
    console.warn(
      `[DeterministicTripPlanner] scoreCandidate: simulator threw for candidate id=${candidate.id}`,
      e,
    );
    return { ...candidate, buildCost: 999, turns: 999, net: -999, score: -9999, feasible: false };
  }

  if (!result.feasible) {
    return { ...candidate, buildCost: result.totalBuildCost, turns: result.turnsToComplete, net: -999, score: -9999, feasible: false };
  }

  const buildCost = result.totalBuildCost;
  const turns = result.turnsToComplete;
  const net = candidate.payout - buildCost;
  const score = net - opts.ocpt * turns;
  return { ...candidate, buildCost, turns, net, score, feasible: true };
}

// ── Top-1 selection (R7) ───────────────────────────────────────────────

export function pickTop1(scored: ScoredCandidate[]): ScoredCandidate | null {
  if (scored.length === 0) return null;
  const sorted = [...scored].sort((a, b) => b.score - a.score);
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
): string {
  const pattern = inferPatternLabel(top1);
  const stopsStr = top1.stops
    .map((s, idx) => `${idx + 1}) ${s.action} ${s.loadType} at ${s.city}`)
    .join('; ');

  const patternExplanation = explainPattern(pattern, top1);
  let reasoning = `[deterministic-top-1] ${top1.id} chosen.\n`;
  reasoning += `  Picked: ${pattern} — payout ${top1.payout}M, build ${top1.buildCost}M, ${top1.turns} turns, NET ${top1.net.toFixed(0)}M, score ${top1.score.toFixed(1)}\n`;
  reasoning += `  Stops: ${stopsStr}\n`;
  reasoning += `  Rationale: ${patternExplanation}\n`;

  // Runner-ups (positions 2 and 3)
  const runnerUps = allSorted.filter((c) => c.id !== top1.id).slice(0, 2);
  for (let i = 0; i < runnerUps.length; i++) {
    const ru = runnerUps[i];
    const delta = (top1.score - ru.score).toFixed(1);
    reasoning += `  Runner-up #${i + 2}: ${ru.id}, score ${ru.score.toFixed(1)}, NET ${ru.net.toFixed(0)}M, ${ru.turns} turns. Lost by ${delta}.\n`;
  }

  reasoning += `  Survivors after spatial prune: ${stats.survivors} of ${stats.total} raw.\n`;
  reasoning += `  Discarded by prune: ${stats.prunedByTurns} (turns > ${opts.pruneMaxTurns}) | ${stats.prunedByBuild} (build > ${opts.pruneMaxBuildM}M).`;

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
): string | undefined {
  const current = (currentTrainType || '').toLowerCase();
  let target: string | undefined;
  if (current === 'freight') {
    target = 'fast_freight';
  } else if (current === 'fast_freight' || current === 'heavy_freight') {
    target = 'superfreight';
  } else {
    // Already at top tier (superfreight) or unknown — no upgrade.
    return undefined;
  }

  if (cash >= UPGRADE_COST_M + tripBuildCost) {
    return target;
  }
  return undefined;
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

  const opts: ResolvedOptions = {
    ocpt: options?.ocpt ?? OCPT,
    pruneMaxTurns: options?.pruneMaxTurns ?? PRUNE_MAX_TURNS,
    pruneMaxBuildM: options?.pruneMaxBuildM ?? PRUNE_MAX_BUILD_M,
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

  const trainTypeRaw = (snapshot.bot.trainType ?? 'freight').toLowerCase();
  const cap = TRAIN_CAP[trainTypeRaw] ?? 2;
  const speed = context.speed ?? TRAIN_SPEED[trainTypeRaw] ?? 9;

  const startPos: GridCoord = snapshot.bot.position ?? { row: 0, col: 0 };

  // Carry detection
  const carried = detectCarriedLoads(memory.activeRoute, context.demands);
  const rows = normalizeRows(context.demands, carried);

  // Enumerate all candidates
  const allCandidates = enumerateCandidates(rows, cap);

  // Spatial prune
  let prunedByTurns = 0;
  let prunedByBuild = 0;
  const survivors: Candidate[] = [];

  for (const cand of allCandidates) {
    const { keep, estTurns, estBuild } = cheapPrune(cand, startPos, speed, opts);
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
      `  Survivors after spatial prune: 0 of ${allCandidates.length} raw.`;
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
    const scored = scoreCandidate(cand, startPos, snapshot, opts);
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

  // Sort and pick top-1
  const sorted = [...feasible].sort((a, b) => b.score - a.score);
  const top1 = pickTop1(sorted)!;

  // JIRA-220 follow-up: deterministic upgrade decision. Upgrade as soon as the
  // bot can afford it given the chosen trip's build cost. Emits undefined when
  // the bot is already on Superfreight or when cash would fall short.
  const upgradeOnRoute = selectUpgradeTarget(
    snapshot.bot.trainType,
    snapshot.bot.money,
    top1.buildCost,
  );

  const latencyMs = Date.now() - startMs;
  const reasoning = synthesizeReasoning(top1, sorted, stats, opts) +
    (upgradeOnRoute ? `\n  Upgrade emitted: ${upgradeOnRoute} (cost ${UPGRADE_COST_M}M, cash ${snapshot.bot.money}M, build ${top1.buildCost}M).` : '');
  const route = buildStrategicRoute(top1, snapshot.turnNumber, reasoning, upgradeOnRoute);

  return {
    route,
    reasoning,
    outcome: 'success',
    synthesizedAttempt: synthesizeLlmAttempt(top1, latencyMs),
  };
}
