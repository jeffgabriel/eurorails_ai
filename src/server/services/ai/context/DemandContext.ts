/**
 * DemandContext — Computes demand-related context: demand rankings, delivery/pickup
 * opportunities, and en-route pickup detection.
 *
 * Single responsibility: given the world snapshot and memory, compute all
 * demand-card-derived context fields.
 *
 * JIRA-195: Extracted from ContextBuilder as part of Slice 1 decomposition.
 * The full logic for demand scoring (computeAllDemandContexts, computeCanDeliver,
 * computeCanPickup, computeEnRoutePickups) is delegated to ContextBuilder until
 * BE-004 completes the code-motion phase.
 */

import {
  WorldSnapshot,
  DemandContext as DemandContextType,
  DeliveryOpportunity,
  PickupOpportunity,
  EnRoutePickup,
  RouteStop,
  GridPoint,
  BotMemoryState,
} from '../../../../shared/types/GameTypes';
import { buildTrackNetwork } from '../../../../shared/services/TrackNetworkService';
import { ContextBuilder } from '../ContextBuilder';

/** Internal result type for DemandContext.compute() */
export interface DemandContextResult {
  /** All demand contexts from current hand */
  demands: DemandContextType[];
  /** Immediate delivery opportunities at current position */
  canDeliver: DeliveryOpportunity[];
  /** Pickup opportunities at current position */
  canPickup: PickupOpportunity[];
  /** En-route pickup opportunities near the planned route */
  enRoutePickups: EnRoutePickup[] | undefined;
}

export class DemandContext {
  /**
   * Compute all demand-related context fields.
   *
   * @param snapshot    Current game state.
   * @param memory      Bot memory (used for activeRoute en-route pickup computation).
   * @param gridPoints  Full hex grid for city lookups.
   * @param network     Pre-built track network (to avoid rebuilding — pass null if no track).
   * @param reachableCities  Cities reachable this turn (used for demand scoring).
   * @param citiesOnNetwork  All cities on the bot's network (used for demand scoring).
   * @param connectedMajorCities  Major cities connected (used for demand scoring).
   */
  static compute(
    snapshot: WorldSnapshot,
    memory: BotMemoryState | undefined,
    gridPoints: GridPoint[],
    network: ReturnType<typeof buildTrackNetwork> | null,
    reachableCities: string[],
    citiesOnNetwork: string[],
    connectedMajorCities: string[],
  ): DemandContextResult {
    // Demand contexts — delegates to ContextBuilder's private method via public rebuildDemands
    // Note: rebuildDemands recomputes reachableCities internally; once BE-004 moves the logic,
    // this will use the pre-computed values directly.
    const demands = DemandContext.computeAllDemands(
      snapshot, network, gridPoints, reachableCities, citiesOnNetwork, connectedMajorCities,
    );

    const canDeliver = DemandContext.computeCanDeliver(snapshot, gridPoints);
    const canPickup = DemandContext.computeCanPickup(snapshot, gridPoints);

    const enRoutePickups = memory?.activeRoute?.stops
      ? ContextBuilder.computeEnRoutePickups(snapshot, memory.activeRoute.stops, gridPoints)
      : undefined;

    return { demands, canDeliver, canPickup, enRoutePickups };
  }

  /**
   * Compute all demand contexts for the bot's current hand.
   * Delegates to ContextBuilder.rebuildDemands until code-motion is complete (BE-004).
   */
  private static computeAllDemands(
    snapshot: WorldSnapshot,
    _network: ReturnType<typeof buildTrackNetwork> | null,
    gridPoints: GridPoint[],
    _reachableCities: string[],
    _citiesOnNetwork: string[],
    _connectedMajorCities: string[],
  ): DemandContextType[] {
    // Delegates to ContextBuilder.rebuildDemands which internally recomputes
    // the network and reachability. Will be replaced with direct computation in BE-004.
    return ContextBuilder.rebuildDemands(snapshot, gridPoints);
  }

  /**
   * Compute immediate delivery opportunities at the bot's current position.
   */
  static computeCanDeliver(
    snapshot: WorldSnapshot,
    gridPoints: GridPoint[],
  ): DeliveryOpportunity[] {
    return ContextBuilder.rebuildCanDeliver(snapshot, gridPoints);
  }

  /**
   * Compute pickup opportunities at the bot's current position.
   * Delegates to ContextBuilder until code-motion is complete (BE-004).
   */
  static computeCanPickup(
    snapshot: WorldSnapshot,
    gridPoints: GridPoint[],
  ): PickupOpportunity[] {
    if (!snapshot.bot.position) return [];
    if (snapshot.gameStatus === 'initialBuild') return [];

    const cityPoint = gridPoints.find(
      gp => gp.row === snapshot.bot.position!.row && gp.col === snapshot.bot.position!.col,
    );
    const cityName = cityPoint?.city?.name;
    if (!cityName) return [];

    const { TrainType, TRAIN_PROPERTIES } = require('../../../../shared/types/GameTypes');
    const trainType = snapshot.bot.trainType as typeof TrainType[keyof typeof TrainType];
    const capacity = TRAIN_PROPERTIES[trainType]?.capacity ?? 2;
    if (snapshot.bot.loads.length >= capacity) return [];

    const availableLoads = snapshot.loadAvailability?.[cityName] ?? [];
    if (availableLoads.length === 0) return [];

    const opportunities: PickupOpportunity[] = [];
    for (const loadType of availableLoads) {
      if (snapshot.bot.loads.includes(loadType)) continue;
      let bestPayout = 0;
      let bestDeliveryCity = '';
      for (const resolved of snapshot.bot.resolvedDemands) {
        for (const demand of resolved.demands) {
          if (demand.loadType === loadType && demand.payment > bestPayout) {
            bestPayout = demand.payment;
            bestDeliveryCity = demand.city;
          }
        }
      }
      if (bestPayout > 0) {
        opportunities.push({ loadType, supplyCity: cityName, bestPayout, bestDeliveryCity });
      }
    }
    return opportunities;
  }

  /**
   * Compute en-route pickup opportunities near the bot's planned route stops.
   * Delegates to ContextBuilder.computeEnRoutePickups.
   */
  static computeEnRoutePickups(
    snapshot: WorldSnapshot,
    routeStops: RouteStop[],
    gridPoints: GridPoint[],
  ): EnRoutePickup[] {
    return ContextBuilder.computeEnRoutePickups(snapshot, routeStops, gridPoints);
  }
}
