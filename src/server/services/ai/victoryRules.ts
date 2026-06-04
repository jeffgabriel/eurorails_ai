/**
 * victoryRules.ts — Pure functions for bot end-state detection and cost helpers.
 *
 * JIRA-241: Introduces a persistent game phase (GameState) that latches once the
 * bot's cash exceeds END_GAME_ENTRY_CASH (200M) and never reverts. Downstream
 * scoring (Task 2) and replan gate (Task 3) read gameState from GameContext.
 *
 * JIRA-245: Adds findFinalVictoryRoute — end-game speed-to-win route search that
 * runs before the normal trip planner when the bot is in End state.
 *
 * JIRA-274: findFinalVictoryOutcome now delegates stop enumeration to
 * DeterministicTripPlanner. The in-file single/pair/triple candidate loops are
 * removed; the planner handles enumeration (including batched-pickup ordering for
 * same-supply demands). The override retains its unique responsibility: filter to
 * cash-gap-feasible demands and re-score by turns-to-victory.
 */

import {
  BotMemoryState,
  GameContext,
  GameState,
  END_GAME_ENTRY_CASH,
  VICTORY_CITY_COUNT,
  VICTORY_INITIAL_THRESHOLD,
  DemandContext,
  RouteStop,
  SnapshotIdentity,
  StrategicRoute,
  TrainType,
  TRAIN_PROPERTIES,
  WorldSnapshot,
} from '../../../shared/types/GameTypes';
import { loadGridPoints, hexDistance, GridPointData } from '../MapTopology';
import { planTripDeterministic } from './DeterministicTripPlanner';

/**
 * A "victory clinch" — a currently-carried load + matching demand card whose
 * delivery would satisfy both victory conditions (cash ≥ 250M, ≥ 7 majors
 * connected) without further building.
 */
export interface VictoryClinch {
  loadType: string;
  deliveryCity: string;
  payout: number;
  cardIndex: number;
}

/**
 * Compute the bot's persistent game phase.
 *
 * Precedence (highest first):
 *   1. End latch (JIRA-241) — once memory says End, stay End.
 *   2. Cash trigger (JIRA-241) — money > END_GAME_ENTRY_CASH (200M) → End.
 *   3. Turn brackets (JIRA-242):
 *        turnNumber > 25 → Mid
 *        turnNumber ≥ 4  → Early
 *        otherwise       → Initial
 *
 * Initial → Early → Mid transitions don't need latching because turn numbers
 * only increase. End takes precedence and is latched.
 *
 * Fail-safe: missing memory.gameState is treated as no prior latch.
 *
 * @param context - Minimal context with current cash and turn number.
 * @param memory  - Persistent bot memory (may have gameState from a prior turn).
 * @returns The resolved GameState.
 */
export function computeGameState(
  context: { money: number; turnNumber: number },
  memory: BotMemoryState,
): GameState {
  // Latch: once End, never revert — even if cash dips below threshold.
  if (memory.gameState === GameState.End) {
    return GameState.End;
  }

  // Cash trigger: precedence over any turn-based phase (JIRA-241).
  if (context.money > END_GAME_ENTRY_CASH) {
    return GameState.End;
  }

  // Turn brackets (JIRA-242):
  if (context.turnNumber > 25) {
    return GameState.Mid;
  }
  if (context.turnNumber >= 4) {
    return GameState.Early;
  }
  return GameState.Initial;
}

/**
 * Sum the estimated track costs for the cheapest N unconnected major cities.
 *
 * Used by findFinalVictoryRoute to compute the minimum connector cost when the
 * bot has fewer than VICTORY_CITY_COUNT majors connected.
 *
 * Edge cases:
 * - n <= 0 → {cost: 0, cityNames: []}
 * - n > unconnectedMajorCities.length → sums all available (valid lower-bound)
 * - All majors already connected → {cost: 0, cityNames: []}
 *
 * @param context - Current game context (unconnectedMajorCities sorted by cost ascending).
 * @param n - Number of cheapest connectors to sum.
 * @returns {cost, cityNames} — total ECU M cost and the names of those cities.
 */
export function cheapestNUnconnectedMajorConnectorCost(
  context: GameContext,
  n: number,
): { cost: number; cityNames: string[] } {
  if (n <= 0) {
    return { cost: 0, cityNames: [] };
  }
  const slice = context.unconnectedMajorCities.slice(0, n);
  const cost = slice.reduce((sum, entry) => sum + (entry.estimatedCost ?? 0), 0);
  const cityNames = slice.map((entry) => entry.cityName);
  return { cost, cityNames };
}

/**
 * Return the estimated track cost to reach the cheapest unconnected major city.
 *
 * Used by end-state scoring (Task 2) to penalise routes that don't help
 * connect still-missing major cities.
 *
 * Returns 0 when:
 * - All major cities are already connected (connectedMajorCities.length >= VICTORY_CITY_COUNT).
 * - unconnectedMajorCities is empty.
 * - The first entry has no estimatedCost.
 *
 * @param context - Current game context (unconnectedMajorCities sorted by cost ascending).
 * @returns Estimated cost in ECU M, or 0 when not applicable.
 */
export function cheapestUnconnectedMajorConnectorCost(context: GameContext): number {
  if (context.connectedMajorCities.length >= VICTORY_CITY_COUNT) {
    return 0;
  }
  return cheapestNUnconnectedMajorConnectorCost(context, 1).cost;
}

/**
 * Detect whether a currently-carried load + matching demand card delivery
 * would clinch victory immediately — i.e. both victory conditions are met
 * after the delivery without any further track building.
 *
 * Conditions (all required):
 *   1. ≥ 7 major cities already connected (city condition satisfied pre-delivery).
 *   2. There exists a demand `d` such that:
 *        a. `d.isLoadOnTrain === true` (load is in cargo right now).
 *        b. `d.isDeliveryOnNetwork === true` (no build required to reach delivery).
 *        c. `money + d.payout >= 250` (cash condition satisfied post-delivery).
 *
 * When multiple carried loads qualify, the highest-payout one wins. This is
 * the simplest correct tiebreak — payout is monotone for victory and the cash
 * margin is always strictly nonneg.
 *
 * Returns null when no clinch is available. Callers should fall through to
 * normal trip planning in that case.
 *
 * Background: forensic analysis of game c990fa47 (JIRA-243) showed s2 was
 * carrying a Labor load with a matching `Labor → Bordeaux 34M` card at T74
 * after just connecting its 7th major (Madrid), yet the deterministic pair-
 * scoring continued executing a Wroclaw → Antwerpen detour for Copper. The
 * matching demand card was silently discarded post-delivery and the game ran
 * ~15 turns longer than necessary. This hard gate short-circuits that case.
 *
 * @param context - Current game context with demands + connected majors + cash.
 * @returns The clinch candidate, or null when none exists.
 */
export function detectVictoryClinch(context: GameContext): VictoryClinch | null {
  if (context.connectedMajorCities.length < VICTORY_CITY_COUNT) return null;
  if (!context.demands || context.demands.length === 0) return null;

  let best: VictoryClinch | null = null;
  for (const d of context.demands) {
    if (!d.isLoadOnTrain) continue;
    if (!d.isDeliveryOnNetwork) continue;
    if (context.money + d.payout < VICTORY_INITIAL_THRESHOLD) continue;
    if (!best || d.payout > best.payout) {
      best = {
        loadType: d.loadType,
        deliveryCity: d.deliveryCity,
        payout: d.payout,
        cardIndex: d.cardIndex,
      };
    }
  }
  return best;
}

// ─── JIRA-245: Final Victory Route Search ──────────────────────────────────

/**
 * A victory route — the fastest sequence of pickups + deliveries that
 * simultaneously satisfies cash ≥ 250M and majors ≥ 7.
 */
export interface FinalVictoryRoute {
  /** Ordered pickup → deliver sequence (1–3 deliveries typical). */
  stops: RouteStop[];
  /** Minimum turns from now to the last delivery (estimated). */
  estimatedTurns: number;
  /** ECU M: supply + delivery build costs + major connector builds combined. */
  buildCost: number;
  /** ECU M total payout across all deliveries in the route. */
  totalPayout: number;
  /** money + totalPayout − buildCost ≥ 250 (post-condition guaranteed). */
  cashAtVictory: number;
  /** connectedMajorCities.length + new connectors closed by this route ≥ 7. */
  majorsAtVictory: number;
  /** Names of unconnected majors that this route's build budget also connects. */
  majorConnectors: string[];
  /** Structured [final-victory] log line emitted on fire. */
  reasoning: string;
  /**
   * Identity of the snapshot this victory sprint was planned against (JIRA-279).
   * Set by findFinalVictoryOutcome from snapshot.identity at planning time.
   * Used by gateVictoryOutcomeFreshness to assertFresh before applying the override.
   */
  derivedFromIdentity?: SnapshotIdentity;
}

/**
 * JIRA-265: Discriminated-union outcome of a victory-route search.
 * `findFinalVictoryRoute` returns a `FinalVictoryRoute | null` for callers that
 * only care about the route. `findFinalVictoryOutcome` exposes the same
 * computation but with the skip reason preserved so per-turn NDJSON logging can
 * answer "why did this turn not produce a victory route override?" without
 * re-running the search with stdout capture.
 */
export type FinalVictoryOutcomeSkipReason =
  | 'not_in_end_state'
  | 'no_demands'
  | 'victory_met'
  | 'no_feasible_demands'
  | 'no_route_covers_gap'
  // JIRA-273: emitted by AIStrategyEngine when the override's route fails
  // validateRouteCarryPreconditions against snapshot.bot.loads. The override
  // had a fire candidate but its carry assumptions didn't match actual cargo.
  | 'carry_precondition_fail'
  // JIRA-274: emitted when all feasible demand subsets were presented to the
  // deterministic planner but it returned no viable route (all candidates
  // pruned by spatial/build/turn gates or planner returned route=null).
  | 'planner_returned_empty';

export type FinalVictoryOutcome =
  | { outcome: 'fire'; route: FinalVictoryRoute; cashGap: number; majorsGap: number; connectorCost: number }
  | { outcome: 'skip'; reason: FinalVictoryOutcomeSkipReason; cashGap?: number; majorsGap?: number; connectorCost?: number };

/**
 * JIRA-265: Per-turn end-game trace for the NDJSON log. Surfaces everything a
 * post-game reader needs to answer "what does the bot need to win, and what's
 * its plan to get there?" without re-running the search with stdout capture.
 *
 * Populated by AIStrategyEngine on every turn where `gameState === 'end'`.
 */
export interface EndGameTrace {
  /** Always true when this trace is emitted (the GameLogger field is absent otherwise). */
  inEndGame: true;
  /** Snapshot of memory.endGameLocked AFTER this turn's latch decision. */
  endGameLocked: boolean;
  /** max(0, 250 − cash). Zero when cash already meets the victory threshold. */
  cashGapM: number;
  /** max(0, 7 − connectedMajorCities.length). Zero when city condition already met. */
  majorsGap: number;
  /** The cheapest `majorsGap` unconnected majors, sorted ascending by estimated track-cost. */
  cheapestConnectors: Array<{ cityName: string; costM: number }>;
  /** cashGapM + Σ cheapestConnectors.costM. Lower bound on the spend required to win. */
  fullWinCostM: number;
  /** Per-turn outcome of findFinalVictoryRoute, including the skip reason when no route fires. */
  victoryRouteProjection:
    | {
        outcome: 'fire';
        /** "pickup:Beer@Munchen, deliver:Beer@Hamburg" style stop summary. */
        stops: string[];
        turns: number;
        buildM: number;
        payoutM: number;
        cashAtVictory: number;
        majorsAtVictory: number;
        /** True when AIStrategyEngine replaced activeRoute with this projection; false when JIRA-261 routesMatch suppressed the override. */
        appliedOverride: boolean;
      }
    | { outcome: 'skip'; reason: FinalVictoryOutcomeSkipReason };
  /** Projection of the bot's CURRENT activeRoute outcome, if any. Absent when no activeRoute. */
  activePlanProjection?: {
    /** True when the route's deliveries + connector closures would meet both victory conditions. */
    willClinch: boolean;
    /** money + Σ deliveries.payment in the remaining route. */
    projectedCash: number;
    /** connectedMajorCities.length + count of route deliveries to unconnected majors. */
    projectedMajors: number;
    /** Best-effort estimate of remaining stops; uses route length as a proxy until a turn estimator is wired. */
    remainingStops: number;
  };
}

/** ECU M the bot may spend on building per turn. */
const BUILD_CAP_PER_TURN = 20;

/**
 * Estimate the number of turns to travel a given distance at train speed.
 * Minimum 1 turn when distance > 0.
 */
function travelTurns(mileposts: number, speed: number): number {
  if (mileposts <= 0) return 0;
  return Math.ceil(mileposts / speed);
}

/**
 * Estimate turns to build a given track cost at BUILD_CAP_PER_TURN per turn.
 * Returns 0 when cost is 0.
 */
function buildTurns(cost: number): number {
  if (cost <= 0) return 0;
  return Math.ceil(cost / BUILD_CAP_PER_TURN);
}

/**
 * JIRA-267 Fix B: multiplicity-aware effective-carry set.
 *
 * `DemandContext.isLoadOnTrain` is keyed by loadType: `bot.loads.includes(loadType)`.
 * So one Fish chip on board flags ALL Fish demand cards as carried, even though
 * only one card can actually be fulfilled by that chip. This local helper builds
 * a Set<cardIndex> matching JIRA-233's "highest-payout-wins-the-slot" semantics
 * from `DeterministicTripPlanner.normalizeRows`, but without the cross-module
 * dependency.
 *
 * For each loadType with chip count N in cargo, mark the top-N demand rows by
 * payout (DESC) as effectively carried; the rest are NOT carried for the purpose
 * of victory-route candidate enumeration.
 */
export function buildEffectiveCarrySet(
  demands: DemandContext[],
  cargoLoads: string[],
): Set<number> {
  const cargoCount = new Map<string, number>();
  for (const load of cargoLoads) {
    cargoCount.set(load, (cargoCount.get(load) ?? 0) + 1);
  }
  const effective = new Set<number>();
  for (const [loadType, count] of cargoCount.entries()) {
    const matching = demands
      .filter((d) => d.loadType === loadType)
      .sort((a, b) => b.payout - a.payout);
    for (let i = 0; i < Math.min(count, matching.length); i++) {
      effective.add(matching[i].cardIndex);
    }
  }
  return effective;
}

/**
 * JIRA-267 Fix A helper: find a delivery city's coords in the grid for the
 * carry-deliver distance estimate. Linear scan — gridPoints typically holds
 * ~2000 entries; called once per Fish demand per turn so it's not a hotspot.
 */
function findCityCoord(
  cityName: string,
  gridPoints: Map<string, GridPointData>,
): { row: number; col: number } | null {
  for (const [, point] of gridPoints) {
    if (point.name === cityName) return { row: point.row, col: point.col };
  }
  return null;
}

/**
 * Estimate total turns for a single-demand route (pickup + deliver).
 *
 * When `isCarry` is true, the pickup leg is skipped and the delivery leg's
 * travel cost uses the actual distance from the bot's current position to the
 * delivery city (JIRA-267 Fix A — the previous implementation returned a
 * constant 1-turn estimate, which caused the ranker to fall to a payout-based
 * tiebreak across all carry-deliver candidates).
 *
 * `isCarry` is the multiplicity-aware effective carry from `buildEffectiveCarrySet`
 * (JIRA-267 Fix B), not the raw `d.isLoadOnTrain` per-loadType flag.
 */
function estimateSingleDemandTurns(
  d: DemandContext,
  speed: number,
  isCarry: boolean,
  botPosition: { row: number; col: number } | null,
  gridPoints: Map<string, GridPointData>,
): number {
  // Non-carry: pickup+deliver. d.estimatedTurns is the path-aware turn count
  // from ContextBuilder; add any extra build turns for off-network stops.
  if (!isCarry) {
    let turns = d.estimatedTurns ?? 3; // fallback when field missing
    turns += buildTurns(d.isSupplyOnNetwork ? 0 : d.estimatedTrackCostToSupply);
    turns += buildTurns(d.isDeliveryOnNetwork ? 0 : d.estimatedTrackCostToDelivery);
    return Math.max(1, turns);
  }

  // Carry-deliver (JIRA-267 Fix A): travel from current bot position to the
  // delivery city, plus build turns for any off-network delivery spur.
  const deliveryCoord = findCityCoord(d.deliveryCity, gridPoints);
  const travel = botPosition && deliveryCoord
    ? travelTurns(hexDistance(botPosition.row, botPosition.col, deliveryCoord.row, deliveryCoord.col), speed)
    : 1; // conservative fallback when position or city coord unavailable
  const build = buildTurns(d.isDeliveryOnNetwork ? 0 : d.estimatedTrackCostToDelivery);
  return Math.max(1, travel + build);
}

/**
 * Search for the minimum-turn route that simultaneously satisfies
 * cash ≥ 250M AND majors ≥ 7 when executed.
 *
 * Only fires when `context.gameState === GameState.End`. Returns null in all
 * other states, when no feasible victory route exists, or when no demand
 * covers both the cash gap and connector cost.
 *
 * Algorithm:
 *   cashGap    = max(0, 250 - context.money)
 *   majorsGap  = max(0, 7 - connectedMajorCities.length)
 *   connectorCost = cheapestNUnconnectedMajorConnectorCost(context, majorsGap).cost
 *
 *   For each feasible single-demand (or pair, up to train capacity):
 *     - Compute payout, buildCost, connector cost.
 *     - Feasibility: payout − buildCost − connectorCost ≥ cashGap
 *     - Rank by estimatedTurns ASC; tiebreak cashAtVictory DESC.
 *
 * @param snapshot - Frozen game state snapshot (for trainType / capacity).
 * @param context  - Current game context with demands, money, majors, etc.
 * @param memory   - Persistent bot memory (for gameState latch).
 * @returns The fastest feasible victory route, or null.
 */
/**
 * JIRA-265: Outcome-returning variant of findFinalVictoryRoute. Preserves the
 * skip reason on the null path so callers (e.g. the per-turn NDJSON endGame
 * trace in AIStrategyEngine) can record WHY no override fired without
 * re-running the search.
 *
 * Skip reasons:
 *   not_in_end_state       — context.gameState !== End
 *   no_demands             — context.demands empty
 *   victory_met            — both gaps zero (game should already have ended)
 *   no_feasible_demands    — every demand has unreachable supply/delivery
 *   no_route_covers_gap    — at least one feasible demand exists but no
 *                            single/pair/triple combination has
 *                            payout − buildCost − connectorCost ≥ cashGap
 *
 * `findFinalVictoryRoute` is a thin wrapper that maps fire→route, skip→null
 * for backward compatibility with existing call sites and tests.
 */
export function findFinalVictoryOutcome(
  snapshot: WorldSnapshot,
  context: GameContext,
  memory: BotMemoryState,
): FinalVictoryOutcome {
  // Gate: only in End state.
  if (context.gameState !== GameState.End) {
    return { outcome: 'skip', reason: 'not_in_end_state' };
  }

  if (!context.demands || context.demands.length === 0) {
    console.log('[final-victory] skip: no demands in hand');
    return { outcome: 'skip', reason: 'no_demands' };
  }

  const cashGap = Math.max(0, VICTORY_INITIAL_THRESHOLD - context.money);
  const majorsGap = Math.max(0, VICTORY_CITY_COUNT - context.connectedMajorCities.length);
  const { cost: connectorCost, cityNames: connectorCityNames } =
    cheapestNUnconnectedMajorConnectorCost(context, majorsGap);

  // If the bot somehow has already met both conditions, that's a sign the game
  // should have ended — log a warning and fall through.
  if (cashGap === 0 && majorsGap === 0) {
    console.log('[final-victory] skip: victory conditions already met — game should have ended');
    return { outcome: 'skip', reason: 'victory_met', cashGap, majorsGap, connectorCost };
  }

  // Determine train properties.
  // JIRA-267: pre-compute the multiplicity-aware effective-carry set for
  // feasibility filtering. `isCarry(d)` is used only for the supply-feasibility
  // check below; stop enumeration and ordering are delegated to the planner.
  const effectiveCarrySet = buildEffectiveCarrySet(context.demands, snapshot.bot.loads);
  const isCarry = (d: DemandContext): boolean => effectiveCarrySet.has(d.cardIndex);

  // Filter feasible demands: supply on network (or effectively carried),
  // delivery on/buildable network. Off-network supply/delivery is acceptable
  // when `estimatedTrackCostTo*` is non-negative (the cost has been computed).
  const feasibleDemands = context.demands.filter((d) => {
    const supplyFeasible = isCarry(d) || d.isSupplyOnNetwork || d.estimatedTrackCostToSupply >= 0;
    const deliveryFeasible = d.isDeliveryOnNetwork || d.estimatedTrackCostToDelivery >= 0;
    return supplyFeasible && deliveryFeasible;
  });

  if (feasibleDemands.length === 0) {
    console.log('[final-victory] skip: no feasible demands (supply/delivery unreachable)');
    return { outcome: 'skip', reason: 'no_feasible_demands', cashGap, majorsGap, connectorCost };
  }

  // ── JIRA-274: Delegate stop enumeration to DeterministicTripPlanner ──────
  //
  // The planner handles single/pair/triple enumeration internally, including
  // same-supply corridor candidates (batched pickups — the Bauxite-Marseille
  // ordering that the old in-file loops couldn't produce). We pass only the
  // feasible demands so the planner's prune/score logic operates on the
  // relevant subset.
  //
  // Re-scoring for turns-to-victory (rather than the planner's native M/turn
  // velocity) happens here, after the planner returns its top-1 route.
  const filteredContext: typeof context = { ...context, demands: feasibleDemands };
  const plannerResult = planTripDeterministic(snapshot, filteredContext, memory);

  if (plannerResult.outcome !== 'success' || plannerResult.route === null) {
    console.log(
      `[final-victory] skip: planner_returned_empty (feasibleDemands=${feasibleDemands.length}, cashGap=${cashGap}M)`,
    );
    return { outcome: 'skip', reason: 'planner_returned_empty', cashGap, majorsGap, connectorCost };
  }

  const plannerRoute = plannerResult.route;

  // Compute the total payout and build cost from the planner's returned route
  // to determine if it covers the cash gap (including connector cost).
  const routeTotalPayout = plannerRoute.stops
    .filter((s) => s.action === 'deliver' && s.payment != null)
    .reduce((sum, s) => sum + (s.payment ?? 0), 0);

  // Build cost: sum of estimatedTrackCostToSupply/Delivery for each stop,
  // using the feasible demand metadata for the matched card.
  let routeBuildCost = connectorCost;
  for (const stop of plannerRoute.stops) {
    const demand = feasibleDemands.find((d) =>
      stop.action === 'pickup'
        ? d.loadType === stop.loadType && d.supplyCity === stop.city
        : d.loadType === stop.loadType && d.deliveryCity === stop.city,
    );
    if (demand) {
      if (stop.action === 'pickup') {
        routeBuildCost += demand.isSupplyOnNetwork ? 0 : demand.estimatedTrackCostToSupply;
      } else if (stop.action === 'deliver') {
        routeBuildCost += demand.isDeliveryOnNetwork ? 0 : demand.estimatedTrackCostToDelivery;
      }
    }
  }

  const routeNetPayout = routeTotalPayout - routeBuildCost;
  if (routeNetPayout < cashGap) {
    // Planner returned a route but it cannot close the cash gap even with
    // connector cost included — treat as no_route_covers_gap.
    console.log(
      `[final-victory] skip: no_route_covers_gap (routeNetPayout=${routeNetPayout}M cashGap=${cashGap}M)`,
    );
    return { outcome: 'skip', reason: 'no_route_covers_gap', cashGap, majorsGap, connectorCost };
  }

  // ── Re-score by turns-to-victory ──────────────────────────────────────
  //
  // The planner ranks by M/turn velocity; the override ranks by minimum
  // turns-to-victory. Extract estimatedTurns from the planner's synthesized
  // attempt latency (already computed by the planner's scoreCandidate step),
  // falling back to a turns estimate derived from the route's deliver stops.
  //
  // The planner's synthesizedAttempt doesn't carry turns directly, so we
  // derive turns-to-victory from the route stops using the same per-demand
  // estimatedTurns field used by the old code.
  const trainTypeEnum = snapshot.bot.trainType as TrainType;
  const trainProps = TRAIN_PROPERTIES[trainTypeEnum] ?? { speed: 9, capacity: 2 };
  const trainSpeed = trainProps.speed;
  const gridPointsMap = loadGridPoints();
  const botPosition = snapshot.bot.position;

  let estimatedTurns = 0;
  for (const stop of plannerRoute.stops) {
    if (stop.action === 'deliver') {
      const demand = feasibleDemands.find(
        (d) => d.loadType === stop.loadType && d.deliveryCity === stop.city,
      );
      if (demand) {
        const dCarry = isCarry(demand);
        estimatedTurns += estimateSingleDemandTurns(demand, trainSpeed, dCarry, botPosition, gridPointsMap);
      }
    }
  }
  // Minimum 1 turn
  estimatedTurns = Math.max(1, estimatedTurns);

  const cashAtVictory = context.money + routeTotalPayout - routeBuildCost;
  const majorsAtVictory = context.connectedMajorCities.length + connectorCityNames.length;

  const deliverStops = plannerRoute.stops.filter((s) => s.action === 'deliver');
  const stopDesc = deliverStops.map((s) => `${s.loadType}→${s.city}`).join(', ');
  const reasoning =
    `[final-victory] ${stopDesc}, turns=${estimatedTurns}, ` +
    `build=${routeBuildCost}M, payout=${routeTotalPayout}M, ` +
    `cash@victory=${cashAtVictory}M, majors@victory=${majorsAtVictory}`;

  console.log(reasoning);

  const route: FinalVictoryRoute = {
    stops: plannerRoute.stops,
    estimatedTurns,
    buildCost: routeBuildCost,
    totalPayout: routeTotalPayout,
    cashAtVictory,
    majorsAtVictory,
    majorConnectors: connectorCityNames,
    reasoning,
  };
  return { outcome: 'fire', route, cashGap, majorsGap, connectorCost };
}

/**
 * JIRA-273: Verify that every `deliver` stop in `route.stops` is satisfiable
 * given the bot's actual cargo. A deliver is satisfiable when (a) a preceding
 * `pickup` for the same loadType exists in the route, or (b) the loadType has
 * a remaining slot in `cargoLoads`. Multiplicity-aware: two delivers of the
 * same loadType require two carries (across cargo + pickups), not just one.
 *
 * Used at the override-application site in AIStrategyEngine to reject victory
 * routes whose carry preconditions don't match snapshot.bot.loads — preventing
 * the c73cccf8-style stuck-route-abandon loop where the override repeatedly
 * commits the bot to a deliver-only route for loads it never carries.
 */
export function validateRouteCarryPreconditions(
  route: StrategicRoute,
  cargoLoads: string[],
): { ok: true } | { ok: false; reason: string } {
  // Initial available "slots" per loadType from cargo, then grow via pickups.
  const available = new Map<string, number>();
  for (const load of cargoLoads) {
    available.set(load, (available.get(load) ?? 0) + 1);
  }
  for (let i = 0; i < route.stops.length; i++) {
    const stop = route.stops[i];
    if (stop.action === 'pickup') {
      available.set(stop.loadType, (available.get(stop.loadType) ?? 0) + 1);
    } else if (stop.action === 'deliver') {
      const count = available.get(stop.loadType) ?? 0;
      if (count <= 0) {
        return {
          ok: false,
          reason:
            `deliver ${stop.loadType}@${stop.city} at stop ${i} requires carry, ` +
            `but no prior pickup and no remaining cargo slot ` +
            `(cargoLoads=[${cargoLoads.join(',')}])`,
        };
      }
      available.set(stop.loadType, count - 1);
    }
    // 'drop' actions release the load but do not affect deliver feasibility
    // for this validator's purpose; future delivers of the same loadType
    // would still need another pickup/cargo slot.
  }
  return { ok: true };
}

/**
 * Legacy wrapper for `findFinalVictoryOutcome` — returns the route on fire,
 * null on any skip. Preserved for backward compatibility with existing call
 * sites and tests that don't need the skip reason.
 */
export function findFinalVictoryRoute(
  snapshot: WorldSnapshot,
  context: GameContext,
  memory: BotMemoryState,
): FinalVictoryRoute | null {
  const result = findFinalVictoryOutcome(snapshot, context, memory);
  return result.outcome === 'fire' ? result.route : null;
}

/**
 * JIRA-265: Compose the per-turn EndGameTrace from the outcome of
 * findFinalVictoryOutcome + the current context, memory, and (optionally) the
 * activeRoute that will execute this turn. AIStrategyEngine calls this once
 * per turn when context.gameState === End and threads the result into the
 * NDJSON turn-log entry's `endGame` field.
 *
 * `appliedOverride` is supplied by the caller because the override decision is
 * made in AIStrategyEngine (after the JIRA-261 routesMatch check), not here.
 */
export function buildEndGameTrace(
  context: GameContext,
  memory: BotMemoryState,
  outcome: FinalVictoryOutcome,
  appliedOverride: boolean,
  activeRoute: StrategicRoute | null,
): EndGameTrace {
  const cashGapM = Math.max(0, VICTORY_INITIAL_THRESHOLD - context.money);
  const majorsGap = Math.max(0, VICTORY_CITY_COUNT - context.connectedMajorCities.length);
  const cheapestConnectors = (context.unconnectedMajorCities ?? [])
    .slice(0, majorsGap)
    .map((e) => ({ cityName: e.cityName, costM: e.estimatedCost }));
  const fullWinCostM = cashGapM + cheapestConnectors.reduce((s, c) => s + c.costM, 0);

  let victoryRouteProjection: EndGameTrace['victoryRouteProjection'];
  if (outcome.outcome === 'fire') {
    const stops = outcome.route.stops.map((s) => `${s.action}:${s.loadType}@${s.city}`);
    victoryRouteProjection = {
      outcome: 'fire',
      stops,
      turns: outcome.route.estimatedTurns,
      buildM: outcome.route.buildCost,
      payoutM: outcome.route.totalPayout,
      cashAtVictory: outcome.route.cashAtVictory,
      majorsAtVictory: outcome.route.majorsAtVictory,
      appliedOverride,
    };
  } else {
    victoryRouteProjection = { outcome: 'skip', reason: outcome.reason };
  }

  let activePlanProjection: EndGameTrace['activePlanProjection'];
  if (activeRoute && activeRoute.stops.length > activeRoute.currentStopIndex) {
    const remaining = activeRoute.stops.slice(activeRoute.currentStopIndex);
    const remainingStops = remaining.length;
    const connectorCitySet = new Set(cheapestConnectors.map((c) => c.cityName));
    let projectedPayout = 0;
    let connectorAdds = 0;
    for (const s of remaining) {
      if (s.action === 'deliver') {
        projectedPayout += s.payment ?? 0;
        if (connectorCitySet.has(s.city)) connectorAdds += 1;
      }
    }
    const projectedCash = context.money + projectedPayout;
    const projectedMajors = context.connectedMajorCities.length + connectorAdds;
    const willClinch = projectedCash >= VICTORY_INITIAL_THRESHOLD && projectedMajors >= VICTORY_CITY_COUNT;
    activePlanProjection = { willClinch, projectedCash, projectedMajors, remainingStops };
  }

  return {
    inEndGame: true,
    endGameLocked: !!memory.endGameLocked,
    cashGapM,
    majorsGap,
    cheapestConnectors,
    fullWinCostM,
    victoryRouteProjection,
    activePlanProjection,
  };
}
