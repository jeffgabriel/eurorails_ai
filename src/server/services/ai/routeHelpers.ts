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
  WorldSnapshot,
  VICTORY_INITIAL_THRESHOLD,
} from '../../../shared/types/GameTypes';
import { loadGridPoints } from './MapTopology';

/** Number of connected major cities required to win */
const VICTORY_CITY_COUNT = 7;

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
}

/**
 * Unified build-target resolver — the single source of truth for determining
 * what city the bot should extend its track toward this turn.
 *
 * Resolution order:
 * 1. Victory build override: if bot has ≥250M and fewer than 7 connected major
 *    cities, target the cheapest unconnected major city (bypasses JIT gate).
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
  // Victory build override — bot is close to winning but needs more major cities
  const isVictoryEligible =
    context.money >= VICTORY_INITIAL_THRESHOLD &&
    context.connectedMajorCities.length < VICTORY_CITY_COUNT;

  if (isVictoryEligible) {
    const victoryTarget = findCheapestUnconnectedMajorCity(context);
    if (victoryTarget) {
      return { targetCity: victoryTarget, stopIndex: -1, isVictoryBuild: true };
    }
  }

  // Route-based target — find first off-network stop city
  return findRouteBasedTarget(route, context);
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
 * A delivery is complete when the load is no longer on the train AND the
 * corresponding demand card is gone. Both conditions must be true to confirm
 * the delivery was fulfilled (as opposed to the load being dropped or lost).
 */
function isDeliveryComplete(stop: RouteStop, context: GameContext): boolean {
  const loadOnTrain = context.loads.includes(stop.loadType);
  const demandCardIds = context.demands.map(d => d.cardIndex);
  const demandPresent =
    stop.demandCardId != null && demandCardIds.includes(stop.demandCardId);

  return !loadOnTrain && !demandPresent;
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
