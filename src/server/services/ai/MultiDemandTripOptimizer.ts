/**
 * MultiDemandTripOptimizer — Deterministic two-demand trip pattern detector.
 *
 * JIRA-217: Detects 4 pattern kinds in the bot's hand, generates candidate
 * trip combinations (up to K=2 new pickups), simulates each via
 * RouteDetourEstimator.simulateTrip, scores them, and returns the top 3.
 *
 * Always includes the highest-payout feasible single-demand as a baseline
 * so the selector LLM has a comparison point. v1 is K=2 only.
 */

import {
  DemandContext,
  GameContext,
  GridPoint,
  RouteStop,
  StrategicRoute,
  WorldSnapshot,
} from '../../../shared/types/GameTypes';
import { simulateTrip, OPPORTUNITY_COST_PER_TURN_M } from './RouteDetourEstimator';

// ── Types ──────────────────────────────────────────────────────────────

export type TripPattern =
  | { kind: 'load-double';             loadType: string; count: 2 | 3 }
  | { kind: 'load-double-same-supply'; loadType: string; supplyCity: string; count: 2 | 3 }
  | { kind: 'supply-cluster';          city: string; loadTypes: string[] }
  | { kind: 'delivery-cluster';        cluster: string; cities: string[] };

export interface TripCandidate {
  candidateId: number;
  route: StrategicRoute;
  score: number;
  payoutTotal: number;
  buildCost: number;
  turns: number;
  demandsCovered: Array<{
    cardIndex: number;
    loadType: string;
    supplyCity: string;
    deliveryCity: string;
    payout: number;
  }>;
  patterns: TripPattern[];
}

export interface OptimizerResult {
  candidates: TripCandidate[];
  enumerationStats: {
    patternsDetected: number;
    candidatesGenerated: number;
    candidatesFeasible: number;
    orderingsEvaluated: number;
    durationMs: number;
  };
}

// ── Constants ──────────────────────────────────────────────────────────

const TOP_N_CANDIDATES = 3;
const MAX_COMBINATIONS_HARD_CAP = 200;
const MAX_ORDERINGS_PER_COMBO = 200;

/**
 * Delivery cluster lookup — maps city name to cluster name.
 * Used by the delivery-cluster pattern detector.
 */
const DELIVERY_CLUSTERS: Record<string, string> = {
  // UK
  London: 'UK', Glasgow: 'UK', Birmingham: 'UK', Cardiff: 'UK',
  Belfast: 'UK', Edinburgh: 'UK', Dublin: 'UK', Liverpool: 'UK', Manchester: 'UK',
  // East EU
  Lodz: 'east-EU', Warszawa: 'east-EU', Krakow: 'east-EU', Wroclaw: 'east-EU',
  Bratislava: 'east-EU', Budapest: 'east-EU',
  // Iberia
  Madrid: 'iberia', Barcelona: 'iberia', Lisboa: 'iberia',
  Sevilla: 'iberia', Valencia: 'iberia', Porto: 'iberia',
  // Nordic
  Oslo: 'nordic', Stockholm: 'nordic', Goteborg: 'nordic',
  Kobenhavn: 'nordic', Helsinki: 'nordic', Bergen: 'nordic', Arhus: 'nordic',
  // North Italy
  Milano: 'north-italy', Torino: 'north-italy', Firenze: 'north-italy',
  Genoa: 'north-italy', Venezia: 'north-italy', Bologna: 'north-italy',
};

// ── Pattern Detection ──────────────────────────────────────────────────

/**
 * Detects load-double-same-supply: same (loadType, supplyCity) in 2+ demands.
 * Returns groups of matching demands.
 */
function detectLoadDoubleSameSupply(
  demands: DemandContext[],
): Array<{ pattern: TripPattern; demands: DemandContext[] }> {
  const groups = new Map<string, DemandContext[]>();
  for (const d of demands) {
    if (!d.supplyCity) continue;
    const key = `${d.loadType}|${d.supplyCity}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(d);
  }

  const results: Array<{ pattern: TripPattern; demands: DemandContext[] }> = [];
  for (const [, group] of groups) {
    if (group.length >= 2) {
      const sorted = [...group].sort((a, b) => b.payout - a.payout);
      const top2 = sorted.slice(0, 2);
      results.push({
        pattern: {
          kind: 'load-double-same-supply',
          loadType: top2[0].loadType,
          supplyCity: top2[0].supplyCity!,
          count: 2,
        },
        demands: top2,
      });
    }
  }
  return results;
}

/**
 * Detects load-double: same loadType in 2+ demands, different supply cities.
 */
function detectLoadDouble(
  demands: DemandContext[],
): Array<{ pattern: TripPattern; demands: DemandContext[] }> {
  const byLoadType = new Map<string, DemandContext[]>();
  for (const d of demands) {
    if (!byLoadType.has(d.loadType)) byLoadType.set(d.loadType, []);
    byLoadType.get(d.loadType)!.push(d);
  }

  const results: Array<{ pattern: TripPattern; demands: DemandContext[] }> = [];
  for (const [loadType, group] of byLoadType) {
    // Only include demands with different supply cities for this pattern
    const differentSupply = group.filter(d => d.supplyCity != null);
    const uniqueSupplies = new Set(differentSupply.map(d => d.supplyCity));
    if (uniqueSupplies.size < 2) continue;
    if (group.length < 2) continue;

    // Take top 2 by payout
    const sorted = [...group].sort((a, b) => b.payout - a.payout);
    const top2 = sorted.slice(0, 2);

    // Ensure these two have different supply cities (since we checked there are ≥2 unique)
    if (top2[0].supplyCity === top2[1].supplyCity) {
      // Find a different one
      const alternative = sorted.find(d => d.supplyCity !== top2[0].supplyCity);
      if (!alternative) continue;
      top2[1] = alternative;
    }

    results.push({
      pattern: { kind: 'load-double', loadType, count: 2 },
      demands: top2,
    });
  }
  return results;
}

/**
 * Detects supply-cluster: single supplyCity with 2+ different load types.
 */
function detectSupplyCluster(
  demands: DemandContext[],
): Array<{ pattern: TripPattern; demands: DemandContext[] }> {
  const bySupplyCity = new Map<string, DemandContext[]>();
  for (const d of demands) {
    if (!d.supplyCity) continue;
    if (!bySupplyCity.has(d.supplyCity)) bySupplyCity.set(d.supplyCity, []);
    bySupplyCity.get(d.supplyCity)!.push(d);
  }

  const results: Array<{ pattern: TripPattern; demands: DemandContext[] }> = [];
  for (const [supplyCity, group] of bySupplyCity) {
    const uniqueLoadTypes = new Set(group.map(d => d.loadType));
    if (uniqueLoadTypes.size < 2) continue;

    // Pick the top 2 by payout, but ensure different load types
    const sorted = [...group].sort((a, b) => b.payout - a.payout);
    const top2: DemandContext[] = [];
    const usedLoadTypes = new Set<string>();
    for (const d of sorted) {
      if (!usedLoadTypes.has(d.loadType)) {
        top2.push(d);
        usedLoadTypes.add(d.loadType);
        if (top2.length === 2) break;
      }
    }
    if (top2.length < 2) continue;

    results.push({
      pattern: {
        kind: 'supply-cluster',
        city: supplyCity,
        loadTypes: top2.map(d => d.loadType),
      },
      demands: top2,
    });
  }
  return results;
}

/**
 * Detects delivery-cluster: 2+ delivery cities mapping to the same DELIVERY_CLUSTERS entry.
 */
function detectDeliveryCluster(
  demands: DemandContext[],
): Array<{ pattern: TripPattern; demands: DemandContext[] }> {
  const byCluster = new Map<string, DemandContext[]>();
  for (const d of demands) {
    const cluster = DELIVERY_CLUSTERS[d.deliveryCity];
    if (!cluster) continue;
    if (!byCluster.has(cluster)) byCluster.set(cluster, []);
    byCluster.get(cluster)!.push(d);
  }

  const results: Array<{ pattern: TripPattern; demands: DemandContext[] }> = [];
  for (const [cluster, group] of byCluster) {
    if (group.length < 2) continue;

    // Take top 2 by payout
    const sorted = [...group].sort((a, b) => b.payout - a.payout);
    const top2 = sorted.slice(0, 2);

    results.push({
      pattern: {
        kind: 'delivery-cluster',
        cluster,
        cities: top2.map(d => d.deliveryCity),
      },
      demands: top2,
    });
  }
  return results;
}

// ── Stop Ordering (DFS) ───────────────────────────────────────────────

/**
 * Generate all valid orderings for a set of new demands to pick up and deliver.
 * A valid ordering follows game rules: you must pick up a load before delivering it.
 * Returns sequences as arrays of RouteStop.
 *
 * For K=1: 1 ordering (pickup, deliver).
 * For K=2: 6 orderings (all valid permutations respecting pickup-before-deliver).
 */
function generateOrderings(
  newDemands: DemandContext[],
  capacity: number,
  prefixStops: RouteStop[],
): RouteStop[][] {
  const results: RouteStop[][] = [];

  // Build all pickup stops and deliver stops
  const pickupStops: RouteStop[] = newDemands
    .filter(d => d.supplyCity != null)
    .map(d => ({
      action: 'pickup' as const,
      loadType: d.loadType,
      city: d.supplyCity!,
    }));

  const deliverStops: RouteStop[] = newDemands.map(d => ({
    action: 'deliver' as const,
    loadType: d.loadType,
    city: d.deliveryCity,
    demandCardId: d.cardIndex,
    payment: d.payout,
  }));

  // DFS over orderings
  function dfs(
    remaining: { pickup?: RouteStop; deliver: RouteStop; pickedUp: boolean }[],
    currentLoad: number,
    sequence: RouteStop[],
  ): void {
    if (sequence.length > MAX_ORDERINGS_PER_COMBO) return;

    const allDone = remaining.every(r => r.pickedUp && !sequence.find(s => s === r.deliver) && false) ||
      remaining.length === 0;

    if (remaining.every(r => r.pickedUp) && remaining.length > 0) {
      // All picked up — must deliver all remaining
      const undelivered = remaining.filter(r => !sequence.includes(r.deliver));
      if (undelivered.length === 0) {
        results.push([...prefixStops, ...sequence]);
        return;
      }
      // Generate all permutations of remaining deliveries
      permute(undelivered.map(r => r.deliver), perm => {
        results.push([...prefixStops, ...sequence, ...perm]);
      });
      return;
    }

    // Can either pick up next unpicked demand (if capacity allows) or deliver a picked-up one
    for (let i = 0; i < remaining.length; i++) {
      const item = remaining[i];
      if (!item.pickedUp && item.pickup && currentLoad < capacity) {
        // Pick up this demand
        const newRemaining = remaining.map((r, j) => j === i ? { ...r, pickedUp: true } : r);
        dfs(newRemaining, currentLoad + 1, [...sequence, item.pickup]);
      }
      if (item.pickedUp) {
        // Deliver this demand
        const newRemaining = remaining.filter((_, j) => j !== i);
        dfs(newRemaining, currentLoad - 1, [...sequence, item.deliver]);
      }
    }

    void allDone; // suppress unused warning
  }

  const items = newDemands.map((d, i) => ({
    pickup: pickupStops[i],
    deliver: deliverStops[i],
    pickedUp: false,
  }));

  dfs(items, 0, []);

  // Deduplicate orderings (can arise from same-supply patterns)
  const seen = new Set<string>();
  const unique: RouteStop[][] = [];
  for (const ordering of results) {
    const key = ordering.map(s => `${s.action}:${s.loadType}:${s.city}`).join('|');
    if (!seen.has(key)) {
      seen.add(key);
      unique.push(ordering);
    }
  }

  return unique;
}

/** Generate all permutations of an array and call callback for each. */
function permute<T>(arr: T[], cb: (perm: T[]) => void): void {
  if (arr.length <= 1) {
    cb([...arr]);
    return;
  }
  for (let i = 0; i < arr.length; i++) {
    const rest = arr.filter((_, j) => j !== i);
    permute(rest, perm => cb([arr[i], ...perm]));
  }
}

// ── Scoring ────────────────────────────────────────────────────────────

/**
 * Score = sum(payouts) − totalBuildCost − turnsToComplete × OPPORTUNITY_COST_PER_TURN_M
 */
function scoreCandidate(payoutTotal: number, buildCost: number, turns: number): number {
  return payoutTotal - buildCost - turns * OPPORTUNITY_COST_PER_TURN_M;
}

// ── Carried-load helpers ───────────────────────────────────────────────

/**
 * Build the prefix stops for carried loads: deliver stops for loads that have
 * a matching demand card. Loads with no matching card are ignored (drop-at-convenience).
 */
function buildCarriedLoadStops(
  carriedLoads: string[],
  demands: DemandContext[],
): RouteStop[] {
  const stops: RouteStop[] = [];
  for (const loadType of carriedLoads) {
    const matchingDemand = demands.find(d => d.loadType === loadType && d.isLoadOnTrain);
    if (matchingDemand) {
      stops.push({
        action: 'deliver',
        loadType: matchingDemand.loadType,
        city: matchingDemand.deliveryCity,
        demandCardId: matchingDemand.cardIndex,
        payment: matchingDemand.payout,
      });
    }
  }
  return stops;
}

// ── GridPoint city lookup ──────────────────────────────────────────────

/**
 * Find the grid coordinate for a city by name from the gridPoints list.
 * Returns null when the city is not found.
 */
function findCityCoord(
  cityName: string,
  gridPoints: GridPoint[],
): { row: number; col: number } | null {
  for (const gp of gridPoints) {
    if (gp.city?.name === cityName || gp.name === cityName) {
      return { row: gp.row, col: gp.col };
    }
  }
  return null;
}

// ── Main export ────────────────────────────────────────────────────────

/**
 * Generate trip candidates from the bot's current demand hand.
 * Returns up to topN (default 3) candidates sorted by score descending.
 */
export function generateCandidates(
  snapshot: WorldSnapshot,
  context: GameContext,
  _gridPoints: GridPoint[],
  options?: { topN?: number },
): OptimizerResult {
  const startMs = Date.now();
  const topN = options?.topN ?? TOP_N_CANDIDATES;

  const demands = context.demands;
  const carriedLoads = snapshot.bot.loads ?? [];
  const trainCapacity = context.capacity;

  // Stats
  let patternsDetected = 0;
  let candidatesGenerated = 0;
  let candidatesFeasible = 0;
  let orderingsEvaluated = 0;

  if (demands.length === 0) {
    return {
      candidates: [],
      enumerationStats: {
        patternsDetected: 0,
        candidatesGenerated: 0,
        candidatesFeasible: 0,
        orderingsEvaluated: 0,
        durationMs: Date.now() - startMs,
      },
    };
  }

  // The bot's current position
  const botPos = snapshot.bot.position;
  if (!botPos) {
    return {
      candidates: [],
      enumerationStats: {
        patternsDetected: 0,
        candidatesGenerated: 0,
        candidatesFeasible: 0,
        orderingsEvaluated: 0,
        durationMs: Date.now() - startMs,
      },
    };
  }

  // Carried-load deliver prefix stops (common prefix for all candidates)
  const carriedLoadStops = buildCarriedLoadStops(carriedLoads, demands);

  // Demands NOT already on the train (available for new pickups)
  const availableDemands = demands.filter(d => !d.isLoadOnTrain);

  // Detect all 4 pattern kinds
  const patternGroups: Array<{ pattern: TripPattern; demands: DemandContext[] }> = [
    ...detectLoadDoubleSameSupply(availableDemands),
    ...detectLoadDouble(availableDemands),
    ...detectSupplyCluster(availableDemands),
    ...detectDeliveryCluster(availableDemands),
  ];

  patternsDetected = patternGroups.length;

  // Track which demand combinations have already been seeded (avoid duplicate candidates)
  const seenCombinations = new Set<string>();

  function combinationKey(ds: DemandContext[]): string {
    return ds
      .map(d => d.cardIndex)
      .sort((a, b) => a - b)
      .join(',');
  }

  // Build candidate seeds: one per pattern + the single-demand baseline
  type CandidateSeed = {
    newDemands: DemandContext[];
    patterns: TripPattern[];
  };

  const seeds: CandidateSeed[] = [];

  // Add multi-demand pattern seeds (K=2)
  for (const { pattern, demands: patDemands } of patternGroups) {
    if (seeds.length >= MAX_COMBINATIONS_HARD_CAP) break;

    // Enforce capacity: clip to top-K by payout
    let newDemands = patDemands;
    const newPickupSlotsNeeded = newDemands.length;
    const alreadyCarried = carriedLoads.length;
    if (newPickupSlotsNeeded + alreadyCarried > trainCapacity) {
      // Clip to fit within remaining capacity
      const maxNew = Math.max(0, trainCapacity - alreadyCarried);
      newDemands = newDemands
        .sort((a, b) => b.payout - a.payout)
        .slice(0, maxNew);
    }
    if (newDemands.length < 2) continue; // pattern collapsed to <2 demands — skip

    // Enforce one-per-card rule
    const cardIndices = new Set<number>();
    const deduped: DemandContext[] = [];
    for (const d of newDemands) {
      if (!cardIndices.has(d.cardIndex)) {
        cardIndices.add(d.cardIndex);
        deduped.push(d);
      }
    }
    if (deduped.length < 2) continue;

    const key = combinationKey(deduped);
    if (seenCombinations.has(key)) continue;
    seenCombinations.add(key);

    seeds.push({ newDemands: deduped, patterns: [pattern] });
  }

  // Add single-demand baseline seed (K=1, highest-payout available demand)
  const baselineDemand = availableDemands
    .filter(d => d.supplyCity != null)
    .sort((a, b) => b.payout - a.payout)[0];

  if (baselineDemand) {
    seeds.push({ newDemands: [baselineDemand], patterns: [] });
  }

  // Evaluate each seed
  const evaluatedCandidates: Array<TripCandidate & { _feasible: boolean }> = [];
  let candidateIdCounter = 0;

  for (const seed of seeds) {
    if (candidatesGenerated >= MAX_COMBINATIONS_HARD_CAP) break;

    const { newDemands, patterns } = seed;
    candidatesGenerated++;

    // Generate orderings for this candidate
    const orderings = generateOrderings(newDemands, trainCapacity, carriedLoadStops);
    orderingsEvaluated += orderings.length;

    // Track payout total (same for all orderings of same demands)
    const payoutTotal = newDemands.reduce((sum, d) => sum + d.payout, 0)
      + carriedLoadStops.reduce((sum, s) => sum + (s.payment ?? 0), 0);

    // Find the best-scoring feasible ordering
    let bestScore = -Infinity;
    let bestOrdering: RouteStop[] | null = null;
    let bestBuildCost = 0;
    let bestTurns = 0;

    for (const ordering of orderings) {
      const sim = simulateTrip(
        { row: botPos.row, col: botPos.col },
        ordering,
        snapshot as Parameters<typeof simulateTrip>[2],
      );

      if (!sim.feasible) continue;

      const score = scoreCandidate(payoutTotal, sim.totalBuildCost, sim.turnsToComplete);
      if (score > bestScore) {
        bestScore = score;
        bestOrdering = ordering;
        bestBuildCost = sim.totalBuildCost;
        bestTurns = sim.turnsToComplete;
      }
    }

    if (bestOrdering === null) {
      // All orderings infeasible
      evaluatedCandidates.push({
        candidateId: candidateIdCounter++,
        route: buildRoute([], context.turnNumber),
        score: -Infinity,
        payoutTotal,
        buildCost: 0,
        turns: 0,
        demandsCovered: newDemands.map(d => ({
          cardIndex: d.cardIndex,
          loadType: d.loadType,
          supplyCity: d.supplyCity ?? '',
          deliveryCity: d.deliveryCity,
          payout: d.payout,
        })),
        patterns,
        _feasible: false,
      });
      continue;
    }

    candidatesFeasible++;
    evaluatedCandidates.push({
      candidateId: candidateIdCounter++,
      route: buildRoute(bestOrdering, context.turnNumber),
      score: bestScore,
      payoutTotal,
      buildCost: bestBuildCost,
      turns: bestTurns,
      demandsCovered: newDemands.map(d => ({
        cardIndex: d.cardIndex,
        loadType: d.loadType,
        supplyCity: d.supplyCity ?? '',
        deliveryCity: d.deliveryCity,
        payout: d.payout,
      })),
      patterns,
      _feasible: true,
    });
  }

  // Filter to feasible candidates, sort by score descending, return top N
  const feasible = evaluatedCandidates
    .filter(c => c._feasible)
    .sort((a, b) => b.score - a.score)
    .slice(0, topN);

  // Strip internal _feasible flag and re-number candidateIds in result order
  const candidates: TripCandidate[] = feasible.map((c, idx) => {
    const { _feasible, ...rest } = c;
    void _feasible;
    return { ...rest, candidateId: idx };
  });

  const durationMs = Date.now() - startMs;
  console.log(
    `[trip-optimizer] ${patternsDetected} patterns, ${candidatesFeasible} feasible candidates, top score=${candidates[0]?.score?.toFixed(1) ?? 'n/a'}M`,
  );

  return {
    candidates,
    enumerationStats: {
      patternsDetected,
      candidatesGenerated,
      candidatesFeasible,
      orderingsEvaluated,
      durationMs,
    },
  };
}

/** Build a StrategicRoute from an ordered stop list. */
function buildRoute(stops: RouteStop[], createdAtTurn: number): StrategicRoute {
  return {
    stops,
    currentStopIndex: 0,
    phase: 'build',
    createdAtTurn,
    reasoning: '[MultiDemandTripOptimizer] deterministic candidate',
  };
}

/** Export DELIVERY_CLUSTERS for testing. */
export { DELIVERY_CLUSTERS };
