/**
 * routeHelpers — Unified helper functions for route state management.
 *
 * These functions are the single source of truth for route-related decisions:
 * - isStopComplete: determines if a route stop has been fulfilled
 *
 * They replace duplicated logic that previously existed across PlanExecutor,
 * TurnComposer, and AIStrategyEngine.
 */

import { RouteStop, GameContext } from '../../../shared/types/GameTypes';

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
