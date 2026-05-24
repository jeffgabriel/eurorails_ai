/**
 * victoryRules.ts — Pure functions for bot end-state detection and cost helpers.
 *
 * JIRA-241: Introduces a persistent game phase (GameState) that latches once the
 * bot's cash exceeds END_GAME_ENTRY_CASH (200M) and never reverts. Downstream
 * scoring (Task 2) and replan gate (Task 3) read gameState from GameContext.
 *
 * JIRA-245: Adds findFinalVictoryRoute — end-game speed-to-win route search that
 * runs before the normal trip planner when the bot is in End state.
 */

import {
  BotMemoryState,
  GameContext,
  GameState,
  END_GAME_ENTRY_CASH,
  VICTORY_CITY_COUNT,
  VICTORY_INITIAL_THRESHOLD,
  RouteStop,
  TrainType,
  TRAIN_PROPERTIES,
  WorldSnapshot,
} from '../../../shared/types/GameTypes';

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
}

/**
 * Internal candidate structure during route search.
 */
interface VictoryCandidate {
  stops: RouteStop[];
  estimatedTurns: number;
  buildCost: number;
  totalPayout: number;
  cashAtVictory: number;
  majorsAtVictory: number;
  majorConnectors: string[];
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
 * Estimate total turns for a single-demand route (pickup + deliver).
 *
 * When isLoadOnTrain the pickup turn is skipped.
 * estimatedTurns from DemandContext already encodes pathfinding-derived
 * turn estimates — reuse when available.
 */
function estimateSingleDemandTurns(
  d: import('../../../shared/types/GameTypes').DemandContext,
  speed: number,
): number {
  // DemandContext.estimatedTurns already incorporates travel costs.
  // We use it as-is and add any extra build turns for off-network supply/delivery.
  let turns = d.estimatedTurns ?? 3; // fallback when field missing
  turns += buildTurns(d.isSupplyOnNetwork ? 0 : d.estimatedTrackCostToSupply);
  turns += buildTurns(d.isDeliveryOnNetwork ? 0 : d.estimatedTrackCostToDelivery);
  // For carried loads we skip the supply leg travel.
  if (d.isLoadOnTrain) {
    // estimatedTurns from ContextBuilder counts supply travel; subtract 1 trip leg.
    // Use speed-based estimate for the carry case to avoid double-counting.
    turns = travelTurns(1, speed); // at least 1 turn to deliver
    turns += buildTurns(d.isDeliveryOnNetwork ? 0 : d.estimatedTrackCostToDelivery);
  }
  return Math.max(1, turns);
}

/**
 * Build stops for a pickup-then-deliver route for a demand d.
 * When isLoadOnTrain, only the deliver stop is emitted.
 */
function buildStopsForDemand(
  d: import('../../../shared/types/GameTypes').DemandContext,
): RouteStop[] {
  const stops: RouteStop[] = [];
  if (!d.isLoadOnTrain && d.supplyCity) {
    stops.push({ action: 'pickup', loadType: d.loadType, city: d.supplyCity });
  }
  stops.push({
    action: 'deliver',
    loadType: d.loadType,
    city: d.deliveryCity,
    demandCardId: d.cardIndex,
    payment: d.payout,
  });
  return stops;
}

/**
 * Compute the route-level build cost for a demand.
 * Carried loads contribute 0 to supply build cost.
 */
function demandBuildCost(
  d: import('../../../shared/types/GameTypes').DemandContext,
): number {
  const supplyCost = d.isLoadOnTrain ? 0 : (d.isSupplyOnNetwork ? 0 : d.estimatedTrackCostToSupply);
  const deliveryCost = d.isDeliveryOnNetwork ? 0 : d.estimatedTrackCostToDelivery;
  return supplyCost + deliveryCost;
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
export function findFinalVictoryRoute(
  snapshot: WorldSnapshot,
  context: GameContext,
  memory: BotMemoryState,
): FinalVictoryRoute | null {
  // Gate: only in End state.
  if (context.gameState !== GameState.End) {
    return null;
  }

  if (!context.demands || context.demands.length === 0) {
    console.log('[final-victory] skip: no demands in hand');
    return null;
  }

  const cashGap = Math.max(0, VICTORY_INITIAL_THRESHOLD - context.money);
  const majorsGap = Math.max(0, VICTORY_CITY_COUNT - context.connectedMajorCities.length);
  const { cost: connectorCost, cityNames: connectorCityNames } =
    cheapestNUnconnectedMajorConnectorCost(context, majorsGap);

  // If the bot somehow has already met both conditions, that's a sign the game
  // should have ended — log a warning and fall through.
  if (cashGap === 0 && majorsGap === 0) {
    console.log('[final-victory] skip: victory conditions already met — game should have ended');
    return null;
  }

  // Determine train properties.
  const trainTypeEnum = snapshot.bot.trainType as TrainType;
  const trainProps = TRAIN_PROPERTIES[trainTypeEnum] ?? { speed: 9, capacity: 2 };
  const trainSpeed = trainProps.speed;
  const trainCap = trainProps.capacity;

  // Filter feasible demands: supply on network (or carried), delivery on/buildable network.
  // We accept off-network supply/delivery when cost is affordable (estimatedTrackCostToSupply ≥ 0).
  const feasibleDemands = context.demands.filter((d) => {
    // Feasible if supply is on network, load is on train, or we can estimate a build cost.
    const supplyFeasible = d.isLoadOnTrain || d.isSupplyOnNetwork || d.estimatedTrackCostToSupply >= 0;
    const deliveryFeasible = d.isDeliveryOnNetwork || d.estimatedTrackCostToDelivery >= 0;
    return supplyFeasible && deliveryFeasible;
  });

  if (feasibleDemands.length === 0) {
    console.log('[final-victory] skip: no feasible demands (supply/delivery unreachable)');
    return null;
  }

  const candidates: VictoryCandidate[] = [];

  // ── Single-delivery candidates ──────────────────────────────────────────
  for (const d of feasibleDemands) {
    const buildCost = demandBuildCost(d) + connectorCost;
    const netPayout = d.payout - buildCost;
    if (netPayout < cashGap) continue; // infeasible: can't close the cash gap

    const cashAtVictory = context.money + d.payout - buildCost;
    const majorsAtVictory = context.connectedMajorCities.length + connectorCityNames.length;
    const turns = estimateSingleDemandTurns(d, trainSpeed);

    candidates.push({
      stops: buildStopsForDemand(d),
      estimatedTurns: turns,
      buildCost,
      totalPayout: d.payout,
      cashAtVictory,
      majorsAtVictory,
      majorConnectors: connectorCityNames,
    });
  }

  // ── Two-delivery candidates (capacity ≥ 2) ─────────────────────────────
  if (trainCap >= 2) {
    for (let i = 0; i < feasibleDemands.length; i++) {
      for (let j = i + 1; j < feasibleDemands.length; j++) {
        const d1 = feasibleDemands[i];
        const d2 = feasibleDemands[j];
        const totalPayout = d1.payout + d2.payout;
        const buildCost = demandBuildCost(d1) + demandBuildCost(d2) + connectorCost;
        const netPayout = totalPayout - buildCost;
        if (netPayout < cashGap) continue;

        const cashAtVictory = context.money + totalPayout - buildCost;
        const majorsAtVictory = context.connectedMajorCities.length + connectorCityNames.length;
        const turns = estimateSingleDemandTurns(d1, trainSpeed) +
          estimateSingleDemandTurns(d2, trainSpeed);

        const stops = [...buildStopsForDemand(d1), ...buildStopsForDemand(d2)];
        candidates.push({
          stops,
          estimatedTurns: turns,
          buildCost,
          totalPayout,
          cashAtVictory,
          majorsAtVictory,
          majorConnectors: connectorCityNames,
        });
      }
    }
  }

  // ── Three-delivery candidates (capacity ≥ 3) ───────────────────────────
  if (trainCap >= 3) {
    for (let i = 0; i < feasibleDemands.length; i++) {
      for (let j = i + 1; j < feasibleDemands.length; j++) {
        for (let k = j + 1; k < feasibleDemands.length; k++) {
          const d1 = feasibleDemands[i];
          const d2 = feasibleDemands[j];
          const d3 = feasibleDemands[k];
          const totalPayout = d1.payout + d2.payout + d3.payout;
          const buildCost = demandBuildCost(d1) + demandBuildCost(d2) + demandBuildCost(d3) + connectorCost;
          const netPayout = totalPayout - buildCost;
          if (netPayout < cashGap) continue;

          const cashAtVictory = context.money + totalPayout - buildCost;
          const majorsAtVictory = context.connectedMajorCities.length + connectorCityNames.length;
          const turns = estimateSingleDemandTurns(d1, trainSpeed) +
            estimateSingleDemandTurns(d2, trainSpeed) +
            estimateSingleDemandTurns(d3, trainSpeed);

          const stops = [
            ...buildStopsForDemand(d1),
            ...buildStopsForDemand(d2),
            ...buildStopsForDemand(d3),
          ];
          candidates.push({
            stops,
            estimatedTurns: turns,
            buildCost,
            totalPayout,
            cashAtVictory,
            majorsAtVictory,
            majorConnectors: connectorCityNames,
          });
        }
      }
    }
  }

  if (candidates.length === 0) {
    console.log(
      `[final-victory] skip: no route covers cashGap=${cashGap}M + connectorCost=${connectorCost}M`,
    );
    return null;
  }

  // Rank: minimum estimatedTurns ASC; tiebreak maximum cashAtVictory DESC.
  candidates.sort((a, b) => {
    if (a.estimatedTurns !== b.estimatedTurns) return a.estimatedTurns - b.estimatedTurns;
    return b.cashAtVictory - a.cashAtVictory;
  });

  const best = candidates[0];
  const deliverStops = best.stops.filter((s) => s.action === 'deliver');
  const stopDesc = deliverStops.map((s) => `${s.loadType}→${s.city}`).join(', ');
  const reasoning =
    `[final-victory] ${stopDesc}, turns=${best.estimatedTurns}, ` +
    `build=${best.buildCost}M, payout=${best.totalPayout}M, ` +
    `cash@victory=${best.cashAtVictory}M, majors@victory=${best.majorsAtVictory}`;

  console.log(reasoning);

  return {
    stops: best.stops,
    estimatedTurns: best.estimatedTurns,
    buildCost: best.buildCost,
    totalPayout: best.totalPayout,
    cashAtVictory: best.cashAtVictory,
    majorsAtVictory: best.majorsAtVictory,
    majorConnectors: best.majorConnectors,
    reasoning,
  };
}
