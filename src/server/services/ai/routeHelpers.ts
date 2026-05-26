/**
 * routeHelpers — Unified helper functions for route state management.
 *
 * These functions are the single source of truth for route-related decisions:
 * - isStopComplete: determines if a route stop has been fulfilled
 * - resolveBuildTarget: determines the optimal city to build toward
 * - getNetworkFrontier: returns frontier (dead-end) nodes on the bot's track
 *
 * They replace duplicated logic that previously existed across PlanExecutor,
 * TurnComposer, and AIStrategyEngine.
 */

import {
  RouteStop,
  StrategicRoute,
  GameContext,
  GameState,
  WorldSnapshot,
  VICTORY_CITY_COUNT,
  TrackSegment,
} from '../../../shared/types/GameTypes';
import { loadGridPoints, hexDistance, GridCoord } from '../MapTopology';
import { TURN_BUILD_BUDGET } from '../../../shared/constants/gameRules';
import { computeBuildSegments } from './computeBuildSegments';

/**
 * Large build budget used by isStructurallyReachable to simulate an effectively
 * infinite budget. A hex-grid EuroRails board has at most ~2000 nodes; the most
 * expensive cross-continent route is well under 200M ECU. Using 999_999_999
 * ensures computeBuildSegments never truncates for cost reasons.
 */
const STRUCTURAL_REACHABILITY_BUDGET = 999_999_999;

/**
 * Determines whether a target coordinate is structurally reachable from the
 * bot's existing track network by re-running computeBuildSegments with an
 * effectively infinite budget.
 *
 * This distinguishes two cases that look identical from the outside:
 * - **Budget-limited partial**: computeBuildSegments reached its cost cap before
 *   arriving at the target. The target IS reachable given more turns.
 * - **Structurally blocked**: There is no path to the target regardless of budget
 *   (e.g. saturated city blocks all routes, water with no ferry crossing, full
 *   Right-of-Way occupation by opponents).
 *
 * Returns `true` when the unbounded build path reaches the target.
 * Returns `false` when the unbounded path is also partial (pathological block).
 *
 * Fail-safe: returns `false` for missing/empty inputs (never throws).
 *
 * @param buildOrigin  - Starting grid coordinate (typically a bot network frontier node).
 * @param target       - The grid coordinate the bot is trying to reach.
 * @param existingSegments - The bot's current track network segments.
 * @param occupiedEdges    - Edge keys for other players' track (Right-of-Way blocked).
 * @returns true if the target is structurally reachable; false if genuinely blocked.
 */
export function isStructurallyReachable(
  buildOrigin: GridCoord,
  target: GridCoord,
  existingSegments: TrackSegment[],
  occupiedEdges: Set<string>,
): boolean {
  // Fail-safe guards
  if (!buildOrigin || !target) return false;
  if (!existingSegments) return false;

  const unboundedResult = computeBuildSegments(
    [buildOrigin],
    existingSegments,
    STRUCTURAL_REACHABILITY_BUDGET,
    undefined,
    occupiedEdges,
    [target],
  );

  if (unboundedResult.length === 0) return false;

  const lastSeg = unboundedResult[unboundedResult.length - 1];
  return lastSeg.to.row === target.row && lastSeg.to.col === target.col;
}

// ── resolveBuildTarget ─────────────────────────────────────────────────────

/**
 * Result from resolveBuildTarget — describes the target city to build toward.
 */
export interface BuildTargetResult {
  /** Name of the city to build toward */
  targetCity: string;
  /** Index of the route stop that motivated this target (or -1 for victory build) */
  stopIndex: number;
  /** True when the bot meets the victory cash threshold but lacks 7 major cities */
  isVictoryBuild: boolean;
  /**
   * JIRA-240: Optional secondary build target (pickup connector) to lay in the same turn
   * when the primary victory build leaves budget remaining.
   * Only set when isVictoryBuild is true and a bundled connector is affordable.
   */
  secondaryTarget?: string | null;
  /**
   * JIRA-240: Estimated track cost to reach the secondary target from the network frontier.
   * Only set when secondaryTarget is set.
   */
  secondaryEstimatedCost?: number;
}

/**
 * True when the bot carries a load whose delivery city is on its track network.
 *
 * Why: signals that a carry-delivery is available without spending more build
 * budget. Used by guardrails and A3 build-abandon paths to prefer a fresh
 * carry-deliver plan over continuing a build route that just failed.
 */
export function hasCarriedDeliverableOnNetwork(context: GameContext): boolean {
  return context.demands.some(d => d.isLoadOnTrain && d.isDeliveryOnNetwork);
}

/**
 * JIRA-239: Returns true iff the bot can complete a carry delivery this turn
 * on its existing network, without needing to build new track.
 *
 * All four conditions must hold:
 * 1. The current route stop is a 'deliver' action.
 * 2. The bot is currently carrying the required load (context.loads contains loadType).
 * 3. The delivery city is on the bot's network (context.citiesOnNetwork includes city).
 * 4. The hex distance from bot position to delivery city is ≤ context.speed (reachable this turn).
 *
 * Returns false for any missing/invalid input (fail-safe: prefer false to avoid
 * misdirecting the build phase).
 */
function hasNearbyHighValueDelivery(
  route: StrategicRoute,
  context: GameContext,
): boolean {
  // Fail-safe guards
  if (!route || !route.stops || route.stops.length === 0) return false;
  if (route.currentStopIndex < 0 || route.currentStopIndex >= route.stops.length) return false;
  if (!context?.loads || !context.citiesOnNetwork || !context.position) return false;

  const stop = route.stops[route.currentStopIndex];
  if (!stop) return false;

  // Condition 1: current stop must be a delivery
  if (stop.action !== 'deliver') return false;

  // Condition 2: bot must be carrying the required load
  if (!context.loads.includes(stop.loadType)) return false;

  // Condition 3: delivery city must be on the existing network
  if (!context.citiesOnNetwork.includes(stop.city)) return false;

  // Condition 4: delivery city must be reachable this turn (hex distance ≤ speed)
  // Resolve delivery city to grid coordinates
  const grid = loadGridPoints();
  let deliveryRow = -1;
  let deliveryCol = -1;
  for (const [, gp] of grid) {
    if (gp.name === stop.city) {
      deliveryRow = gp.row;
      deliveryCol = gp.col;
      break;
    }
  }
  if (deliveryRow < 0) return false; // city not found in grid — fail-safe

  const dist = hexDistance(context.position.row, context.position.col, deliveryRow, deliveryCol);
  return dist <= context.speed;
}

/**
 * Unified build-target resolver — the single source of truth for determining
 * what city the bot should extend its track toward this turn.
 *
 * Resolution order:
 * 1. Victory build override: if `gameState === End` and the bot has fewer
 *    than 7 connected major cities, target the cheapest unconnected major
 *    city (bypasses JIT gate). JIRA-266 replaced the prior `money >= 230M`
 *    gate — the end-game latch (cash > 200M, sticky) is the right signal.
 * 2. Route-based target: iterate stops from currentStopIndex; return the first
 *    stop whose city is off-network (skipping the route's startingCity).
 * 3. Null: all remaining stops are on-network — no build needed.
 *
 * @param route - The active strategic route.
 * @param context - Current game context.
 * @returns BuildTargetResult or null if no build is needed.
 */
export function resolveBuildTarget(
  route: StrategicRoute,
  context: GameContext,
): BuildTargetResult | null {
  // Victory build override — bot is in end-game but still needs more majors.
  //
  // JIRA-266: gate on the persistent end-game latch (gameState === End, set
  // by ContextBuilder when cash > 200M, sticky) instead of a cash threshold.
  // The prior $230M cash gate (originally $250M before JIRA-243) was a tuning
  // attempt at the same defect: when a bot entered end-game between $200M
  // and $230M and stayed there for many turns waiting for a delivery, no
  // connector building happened. The natural gate is the latch — same signal
  // applyEndStateScoring uses elsewhere.
  //
  // JIRA-243 (preserved): victory-build was suppressed in End by JIRA-241's
  // negative-score path; this branch firing in End restores connector
  // building when it matters most.
  const isVictoryEligible =
    context.gameState === GameState.End &&
    context.connectedMajorCities.length < VICTORY_CITY_COUNT;

  if (isVictoryEligible) {
    // JIRA-239: Delivery-first guard — if the bot is carrying a load whose
    // delivery city is on the network and reachable this turn, deliver first
    // rather than wasting a turn building toward a victory city.
    // We return the current stop's city directly (isVictoryBuild: false) so
    // BuildPhasePlanner knows to skip building and let movement/delivery execute.
    // Note: findRouteBasedTarget() skips on-network cities, so we must return
    // the stop directly here rather than delegating to findRouteBasedTarget.
    if (hasNearbyHighValueDelivery(route, context)) {
      const deliverStop = route.stops[route.currentStopIndex];
      return {
        targetCity: deliverStop.city,
        stopIndex: route.currentStopIndex,
        isVictoryBuild: false,
      };
    }

    const victoryTarget = findCheapestUnconnectedMajorCity(context);
    if (victoryTarget) {
      // JIRA-240: Bundling guard — check if the next route pickup connector fits
      // in the remaining build budget after the primary victory build.
      const victoryEstimatedCost = context.unconnectedMajorCities[0]?.estimatedCost ?? TURN_BUILD_BUDGET;
      const remainingBudget = TURN_BUILD_BUDGET - victoryEstimatedCost;

      let secondaryTarget: string | null = null;
      let secondaryEstimatedCost: number | undefined;

      if (remainingBudget > 0) {
        const nextPickup = findNextRoutePickupOffNetwork(route, context);
        if (nextPickup) {
          // Look up the pre-computed build cost to this pickup city from context.demands.
          // The ContextBuilder already computed estimatedTrackCostToSupply for each demand,
          // which represents the marginal cost to build from the current network to the
          // supply city — exactly what we need for the secondary connector estimate.
          const demandForPickup = context.demands.find(d => d.supplyCity === nextPickup);
          const connectorCost = demandForPickup?.estimatedTrackCostToSupply ?? Infinity;

          if (connectorCost <= remainingBudget) {
            secondaryTarget = nextPickup;
            secondaryEstimatedCost = connectorCost;
          }
        }
      }

      return {
        targetCity: victoryTarget,
        stopIndex: -1,
        isVictoryBuild: true,
        ...(secondaryTarget != null ? { secondaryTarget, secondaryEstimatedCost } : {}),
      };
    }
  }

  // Route-based target — find first off-network stop city
  const routeTarget = findRouteBasedTarget(route, context);

  return routeTarget;
}

/**
 * Returns the cheapest unconnected major city by estimated track cost,
 * or null if all major cities are connected.
 */
function findCheapestUnconnectedMajorCity(context: GameContext): string | null {
  if (context.unconnectedMajorCities.length === 0) return null;
  // unconnectedMajorCities is already sorted by estimatedCost ascending
  // (computed by ContextBuilder.computeUnconnectedMajorCities)
  return context.unconnectedMajorCities[0].cityName;
}

/**
 * JIRA-240: Returns the city name of the first pickup stop in the active route
 * that is NOT already on the bot's track network, or null if none exists.
 *
 * Exported for unit testing. Not intended for use outside routeHelpers.
 *
 * Used to identify a secondary build target for bundling: when the victory-build
 * primary leaves remaining budget, we can pre-connect the next route's pickup city
 * in the same turn.
 *
 * Behavior:
 * - Iterates route.stops from route.currentStopIndex.
 * - Skips delivery stops (only pickup stops are connector candidates).
 * - Skips pickup stops whose city is already on context.citiesOnNetwork.
 * - Returns the first off-network pickup-stop city name, or null.
 *
 * Safe defaults: returns null for null/empty/invalid inputs (never throws).
 */
export function findNextRoutePickupOffNetwork(
  route: StrategicRoute,
  context: GameContext,
): string | null {
  // Fail-safe guards
  if (!route || !route.stops || route.stops.length === 0) return null;
  if (!context?.citiesOnNetwork) return null;
  if (route.currentStopIndex < 0 || route.currentStopIndex >= route.stops.length) return null;

  for (let i = route.currentStopIndex; i < route.stops.length; i++) {
    const stop = route.stops[i];
    // Only consider pickup stops
    if (stop.action !== 'pickup') continue;
    // Skip if already on the network
    if (context.citiesOnNetwork.includes(stop.city)) continue;
    // First off-network pickup found
    return stop.city;
  }

  return null;
}

/**
 * Iterates route stops from currentStopIndex and returns the first stop whose
 * city is not yet on the network, skipping the route's starting city.
 *
 * Collects demand card IDs that will be consumed by this route's deliver stops
 * (JIRA-114) so we do not chase a supply city for a card we're about to discard.
 */
function findRouteBasedTarget(
  route: StrategicRoute,
  context: GameContext,
): BuildTargetResult | null {
  // JIRA-114: Collect cards that will be consumed by deliver stops in this route
  const activeDeliveryCardIds = new Set<number>();
  for (const stop of route.stops) {
    if (stop.action === 'deliver' && stop.demandCardId != null) {
      activeDeliveryCardIds.add(stop.demandCardId);
    }
  }

  for (let i = route.currentStopIndex; i < route.stops.length; i++) {
    const stop = route.stops[i];

    // Skip the starting city — the bot is already there
    const isStartingCity =
      route.startingCity != null &&
      stop.city.toLowerCase() === route.startingCity.toLowerCase();
    if (isStartingCity) continue;

    // Skip cities already on the network
    if (context.citiesOnNetwork.includes(stop.city)) continue;

    return { targetCity: stop.city, stopIndex: i, isVictoryBuild: false };
  }

  return null;
}

/**
 * Determines whether a single route stop has been completed given the current
 * game context.
 *
 * For pickup stops: completed if the train already carries enough instances of
 * the load type to cover all same-type pickup stops up to and including this
 * one (JIRA-104 count-aware logic).
 *
 * For delivery stops: completed if the load is NOT on the train AND the demand
 * card is no longer present (i.e., the delivery was already fulfilled).
 *
 * @param stop - The route stop to evaluate.
 * @param stopIndexInRoute - The index of this stop within the route's stops array
 *   (used to count same-type pickups up to this position).
 * @param allStops - The full ordered stops array from the route (used for
 *   count-aware pickup calculation).
 * @param context - Current game context containing loads on train and active demand cards.
 * @returns true if the stop is complete and can be skipped, false if it still
 *   needs to be executed.
 */
export function isStopComplete(
  stop: RouteStop,
  stopIndexInRoute: number,
  allStops: RouteStop[],
  context: GameContext,
): boolean {
  if (stop.action === 'pickup') {
    return isPickupComplete(stop, stopIndexInRoute, allStops, context);
  }

  if (stop.action === 'deliver') {
    return isDeliveryComplete(stop, context);
  }

  // Unknown action type — treat as incomplete to be safe
  return false;
}

/**
 * Count-aware pickup completion check (JIRA-104).
 *
 * A pickup is complete when the train already carries at least as many
 * instances of the load type as there are same-type pickup stops up to and
 * including this stop index. This prevents incorrectly skipping the second
 * pickup of the same load type when only one is loaded.
 */
function isPickupComplete(
  stop: RouteStop,
  stopIndexInRoute: number,
  allStops: RouteStop[],
  context: GameContext,
): boolean {
  const loadsOnTrain = context.loads.filter(l => l === stop.loadType).length;
  const sameTypePickupsUpToHere = allStops
    .slice(0, stopIndexInRoute + 1)
    .filter(s => s.action === 'pickup' && s.loadType === stop.loadType).length;

  return loadsOnTrain >= sameTypePickupsUpToHere;
}

/**
 * Delivery completion check.
 *
 * A delivery is complete when:
 * 1. We have a demand card identifier (demandCardId is non-nullish), AND
 * 2. The load is no longer on the train, AND
 * 3. The corresponding demand card is no longer in context.demands.
 *
 * When demandCardId is nullish, we have no evidence the delivery was fulfilled
 * (fail-closed: treat as NOT complete). This prevents false-positive completions
 * when the LLM omits demandCardId from its response (JIRA-193 Bug A fix, R5).
 */
export function isDeliveryComplete(stop: RouteStop, context: GameContext): boolean {
  // Fail-closed: without a card identifier we cannot confirm completion
  if (stop.demandCardId == null) return false;

  const loadOnTrain = context.loads.includes(stop.loadType);
  const demandCardIds = context.demands.map(d => d.cardIndex);
  const demandPresent = demandCardIds.includes(stop.demandCardId);

  return !loadOnTrain && !demandPresent;
}

/**
 * Detect when the active route has become impossible to complete from the current
 * cargo + remaining pickup stops (JIRA-233, R3).
 *
 * Returns `true` only when the route's NEXT UNFINISHED stop is a `deliver` action
 * and the required load is NEITHER in `context.loads` NOR reachable via a remaining
 * `pickup` stop in the route. Returns `false` for all undecidable or safe cases
 * (fail-safe: prefer false to avoid phantom abandonments).
 *
 * Multi-instance accounting (AC3): for routes with N deliver:X stops, the helper
 * checks that the available Copper-count (cargo + future pickups) is enough to
 * satisfy ALL deliver stops up to and including the current one. If the route has
 * already consumed the only Copper instance at an earlier deliver stop, the second
 * deliver:Copper is impossible.
 *
 * @param route   Active route with currentStopIndex pointing at the next stop to execute.
 * @param context Current game context — `context.loads` is the authoritative cargo list.
 * @returns true  if the next deliver stop cannot be satisfied; false otherwise.
 */
export function isRouteImpossible(route: StrategicRoute, context: GameContext): boolean {
  // Edge guard: no route or missing stops
  if (!route || !route.stops || !context?.loads) return false;

  const remainingStops = route.stops.slice(route.currentStopIndex);

  // Empty slice → route is done (not impossible)
  if (remainingStops.length === 0) return false;

  const nextStop = remainingStops[0];

  // Only deliver stops can be cargo-impossible; pickups are always achievable
  if (nextStop.action !== 'deliver') return false;

  const requiredLoad = nextStop.loadType;

  // No loadType on the stop → fail-safe false (can't determine impossibility)
  if (!requiredLoad) return false;

  // Count available Copper-equivalent instances across cargo + future pickup stops
  // (multi-instance AC3): we need enough to satisfy ALL deliver:requiredLoad stops
  // in the remaining slice INCLUDING the current one.
  const cargoCount = context.loads.filter(l => l === requiredLoad).length;
  const futurePickupCount = remainingStops.filter(
    s => s.action === 'pickup' && s.loadType === requiredLoad,
  ).length;
  const totalAvailable = cargoCount + futurePickupCount;

  // Count how many deliver:requiredLoad stops exist in the remaining slice
  const deliverDemandCount = remainingStops.filter(
    s => s.action === 'deliver' && s.loadType === requiredLoad,
  ).length;

  // If we have enough to cover all deliver stops, the route is not impossible
  if (totalAvailable >= deliverDemandCount) return false;

  // Available < demand → impossible
  return true;
}

/**
 * Apply the effect of a successfully-executed route stop to the planner's working state.
 *
 * This is the single source of truth for load-state mutation after a stop is executed.
 * Replaces two duplicated inline splice blocks in TurnExecutorPlanner.execute() and
 * fills the missing pickup-side mutation (JIRA-193 Bug A structural fix, R2).
 *
 * Contract (JIRA-196 Fix B):
 * - Only `context.loads` is mutated. `snapshot.bot.loads` is never touched here — it
 *   stays in sync with DB-committed state across the entire planner run.
 * - context.loads must be an independent copy of snapshot.bot.loads (ensured by
 *   ContextBuilder.makeContext) so planner mutations do not leak into the snapshot.
 *
 * Mutation semantics:
 * - pickup  → add loadType to context.loads
 * - deliver → remove first occurrence of loadType from context.loads
 * - drop    → same as deliver
 * - other   → no-op (does not throw)
 *
 * @param stop     The route stop that was just successfully executed.
 * @param context  Bot-turn GameContext (planner working state). Mutated in place.
 */
export function applyStopEffectToLocalState(
  stop: RouteStop,
  context: GameContext,
): void {
  const { action, loadType } = stop;

  if (action === 'pickup') {
    context.loads.push(loadType);
  } else if (action === 'deliver' || action === 'drop') {
    const ctxIdx = context.loads.indexOf(loadType);
    if (ctxIdx !== -1) context.loads.splice(ctxIdx, 1);
  }
  // unknown actions are no-ops
}

// ── getNetworkFrontier ─────────────────────────────────────────────────────

/**
 * A single frontier node on the bot's track network.
 */
export interface FrontierNode {
  row: number;
  col: number;
  /** City name at this milepost, if any (unnamed mileposts will have this undefined) */
  cityName?: string;
}

/**
 * Unified network frontier calculation — the single source of truth for
 * identifying the dead-end nodes on the bot's existing track.
 *
 * **Fixes JIRA-156 Bug B**: The previous TurnComposer implementation only
 * considered frontier nodes that had a `cityName`, silently ignoring unnamed
 * milepost endpoints. This caused the bot to miss the Holland direction when
 * the track ended at an unnamed milepost near Holland.
 *
 * A frontier node is a track endpoint with degree 1 (appears in exactly one
 * segment endpoint — i.e., a dead-end, not an internal junction).
 *
 * When `targetCity` is provided, results are sorted by distance to that city
 * (closest first).
 *
 * Fallbacks (when no track exists):
 * - Bot position (pre-track initial state)
 * - null (nothing to return)
 *
 * @param snapshot - World snapshot containing bot track segments and position.
 * @param gridPoints - Optional pre-loaded grid point map for city name lookup.
 *   If omitted, loaded on demand via `loadGridPoints()`.
 * @param targetCity - Optional city name to sort results toward (closest first).
 * @returns Ordered list of frontier nodes, with `cityName` populated where known.
 */
export function getNetworkFrontier(
  snapshot: WorldSnapshot,
  gridPoints?: Map<string, { name?: string; row: number; col: number }>,
  targetCity?: string,
): FrontierNode[] {
  const grid = gridPoints ?? loadGridPoints();
  const segments = snapshot.bot.existingSegments;

  if (segments.length === 0) {
    // Fallback: use bot's current position when no track exists
    if (snapshot.bot.position) {
      const posKey = `${snapshot.bot.position.row},${snapshot.bot.position.col}`;
      const gp = grid.get(posKey);
      return [{
        row: snapshot.bot.position.row,
        col: snapshot.bot.position.col,
        cityName: gp?.name,
      }];
    }
    return [];
  }

  // Count how many times each endpoint appears across all segments
  const nodeCount = new Map<string, { row: number; col: number; count: number }>();
  for (const seg of segments) {
    for (const endpoint of [seg.from, seg.to]) {
      const key = `${endpoint.row},${endpoint.col}`;
      const existing = nodeCount.get(key);
      if (existing) {
        existing.count++;
      } else {
        nodeCount.set(key, { row: endpoint.row, col: endpoint.col, count: 1 });
      }
    }
  }

  // Frontier = nodes with degree 1 (dead-end endpoints only)
  // NOTE: We do NOT filter by cityName here — unnamed milepost endpoints are
  // valid frontier nodes and MUST be included (fixes JIRA-156 Bug B).
  const frontierNodes: FrontierNode[] = [];
  for (const [key, node] of nodeCount) {
    if (node.count === 1) {
      const gp = grid.get(key);
      frontierNodes.push({
        row: node.row,
        col: node.col,
        cityName: gp?.name,
      });
    }
  }

  // If no degree-1 nodes (e.g., circular track), return all endpoints
  if (frontierNodes.length === 0) {
    for (const [key, node] of nodeCount) {
      const gp = grid.get(key);
      frontierNodes.push({
        row: node.row,
        col: node.col,
        cityName: gp?.name,
      });
    }
  }

  // Sort by distance to targetCity if provided
  if (targetCity) {
    let targetRow = -1;
    let targetCol = -1;
    for (const [, gp] of grid) {
      if (gp.name === targetCity) {
        targetRow = gp.row;
        targetCol = gp.col;
        break;
      }
    }
    if (targetRow >= 0) {
      frontierNodes.sort((a, b) => {
        const distA = Math.abs(a.row - targetRow) + Math.abs(a.col - targetCol);
        const distB = Math.abs(b.row - targetRow) + Math.abs(b.col - targetCol);
        return distA - distB;
      });
    }
  }

  return frontierNodes;
}
