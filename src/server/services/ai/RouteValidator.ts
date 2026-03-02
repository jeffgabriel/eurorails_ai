/**
 * RouteValidator — Pre-commitment feasibility gate for LLM-planned routes.
 *
 * Validates each stop in a StrategicRoute against the current game state:
 *   - Supply/delivery city reachability
 *   - Load chip availability
 *   - Demand card existence
 *   - Cumulative budget (accounting for delivery payouts)
 *   - City name validity
 *
 * Runs inside LLMStrategyBrain.planRoute() after parsing, before committing.
 * Infeasible stops are pruned; if all stops are infeasible the route is rejected
 * and the error is fed back to the LLM for retry.
 */

import {
  StrategicRoute,
  RouteStop,
  GameContext,
  WorldSnapshot,
  DemandContext,
  TerrainType,
} from '../../../shared/types/GameTypes';
import { loadGridPoints } from './MapTopology';

export interface RouteValidationResult {
  valid: boolean;
  /** Pruned route with infeasible stops removed (only if some stops are valid) */
  prunedRoute?: StrategicRoute;
  /** Human-readable error messages per infeasible stop */
  errors: string[];
}

interface StopValidation {
  stop: RouteStop;
  feasible: boolean;
  error?: string;
}

export class RouteValidator {
  /**
   * Validate a planned route against current game state.
   *
   * Returns { valid: true } if all stops pass feasibility checks.
   * Returns { valid: true, prunedRoute } if some stops were pruned but a viable route remains.
   * Returns { valid: false, errors } if all stops are infeasible.
   */
  static validate(
    route: StrategicRoute,
    context: GameContext,
    snapshot: WorldSnapshot,
  ): RouteValidationResult {
    const tag = '[RouteValidator]';

    // ── Per-stop validation ──
    const validations: StopValidation[] = route.stops.map(stop =>
      stop.action === 'pickup'
        ? RouteValidator.checkPickupFeasibility(stop, context, snapshot)
        : RouteValidator.checkDeliverFeasibility(stop, context, snapshot),
    );

    // ── Cumulative budget check ──
    // Runs on the full stop sequence; marks later stops infeasible if
    // running cash (accounting for delivery payouts) can't cover track costs.
    RouteValidator.checkCumulativeBudget(validations, context, snapshot);

    // ── Prune infeasible stops ──
    // When a pickup is pruned, also prune the corresponding deliver
    // (they form a pair — delivering without picking up is impossible).
    const prunedLoadTypes = new Set<string>();
    for (const v of validations) {
      if (!v.feasible && v.stop.action === 'pickup') {
        prunedLoadTypes.add(v.stop.loadType);
      }
    }
    // Mark delivers whose pickup was pruned
    for (const v of validations) {
      if (v.feasible && v.stop.action === 'deliver' && prunedLoadTypes.has(v.stop.loadType)) {
        v.feasible = false;
        v.error = `Pickup for ${v.stop.loadType} was infeasible — cannot deliver without picking up.`;
      }
    }
    // When a deliver is pruned, also prune the corresponding pickup
    // (picking up without a viable delivery is wasteful)
    const prunedDeliverLoads = new Set<string>();
    for (const v of validations) {
      if (!v.feasible && v.stop.action === 'deliver') {
        prunedDeliverLoads.add(v.stop.loadType);
      }
    }
    for (const v of validations) {
      if (v.feasible && v.stop.action === 'pickup' && prunedDeliverLoads.has(v.stop.loadType)) {
        v.feasible = false;
        v.error = `Deliver for ${v.stop.loadType} was infeasible — pickup without viable delivery is wasteful.`;
      }
    }

    const feasibleStops = validations.filter(v => v.feasible).map(v => v.stop);
    const errors = validations.filter(v => !v.feasible).map(v => v.error!);

    // Log validation results
    for (const v of validations) {
      const status = v.feasible ? 'OK' : `INFEASIBLE: ${v.error}`;
      console.log(`${tag} ${v.stop.action}(${v.stop.loadType}@${v.stop.city}): ${status}`);
    }

    if (feasibleStops.length === route.stops.length) {
      // All stops feasible
      // Check for marginal budget — warn but accept
      const totalEstCost = RouteValidator.estimateTotalRouteCost(validations, context);
      if (totalEstCost > 0 && snapshot.bot.money - totalEstCost < 5) {
        console.warn(`${tag} Route feasible but marginal: estimated cost ${totalEstCost}M, cash ${snapshot.bot.money}M`);
      }
      return { valid: true, errors: [] };
    }

    if (feasibleStops.length === 0) {
      // All stops infeasible
      console.warn(`${tag} All ${route.stops.length} stops infeasible — rejecting route`);
      return { valid: false, errors };
    }

    // Some stops pruned — build a pruned route
    console.log(`${tag} Pruned ${route.stops.length - feasibleStops.length}/${route.stops.length} stops`);
    const prunedRoute: StrategicRoute = {
      ...route,
      stops: feasibleStops,
    };
    return { valid: true, prunedRoute, errors };
  }

  /**
   * Check feasibility of a pickup stop.
   */
  private static checkPickupFeasibility(
    stop: RouteStop,
    context: GameContext,
    _snapshot: WorldSnapshot,
  ): StopValidation {
    // Find matching demand(s) for this load type
    const matchingDemands = context.demands.filter(
      d => d.loadType === stop.loadType,
    );

    if (matchingDemands.length === 0) {
      return {
        stop,
        feasible: false,
        error: `No demand card for load type "${stop.loadType}".`,
      };
    }

    // Check load availability — are all chips already carried?
    const allUnavailable = matchingDemands.every(d => !d.isLoadAvailable);
    if (allUnavailable) {
      return {
        stop,
        feasible: false,
        error: `All ${stop.loadType} chips are currently carried by players — cannot pick up.`,
      };
    }

    // Check if the supply city matches any demand's supply city
    const supplyMatch = matchingDemands.find(
      d => d.supplyCity.toLowerCase() === stop.city.toLowerCase(),
    );
    if (!supplyMatch) {
      // The stop's city doesn't match any known supply city for this load
      // This could be a city name the LLM hallucinated
      return {
        stop,
        feasible: false,
        error: `"${stop.city}" is not a known supply city for ${stop.loadType}. Known sources: ${matchingDemands.map(d => d.supplyCity).join(', ')}.`,
      };
    }

    // Note: affordability is checked by checkCumulativeBudget (which accounts for
    // delivery payouts from earlier stops). Per-stop checks only validate non-budget concerns.

    return { stop, feasible: true };
  }

  /**
   * Check feasibility of a deliver stop.
   */
  private static checkDeliverFeasibility(
    stop: RouteStop,
    context: GameContext,
    _snapshot: WorldSnapshot,
  ): StopValidation {
    // Check that the bot holds a demand card for this load+city combination
    const demandMatch = context.demands.find(
      d => d.loadType === stop.loadType &&
        d.deliveryCity.toLowerCase() === stop.city.toLowerCase(),
    );

    if (!demandMatch) {
      return {
        stop,
        feasible: false,
        error: `No demand card for delivering ${stop.loadType} to ${stop.city}.`,
      };
    }

    // Note: affordability is checked by checkCumulativeBudget (which accounts for
    // delivery payouts from earlier stops). Per-stop checks only validate non-budget concerns.

    return { stop, feasible: true };
  }

  /**
   * Check cumulative budget across all stops in order.
   * Marks stops infeasible when the running cash can't cover their track costs.
   * Accounts for delivery payouts from earlier stops.
   */
  private static checkCumulativeBudget(
    validations: StopValidation[],
    context: GameContext,
    snapshot: WorldSnapshot,
  ): void {
    let runningCash = snapshot.bot.money;

    for (const v of validations) {
      if (!v.feasible) continue; // already marked infeasible by per-stop checks

      const stop = v.stop;
      const demand = RouteValidator.findMatchingDemand(stop, context);
      if (!demand) continue; // will be caught by per-stop checks

      if (stop.action === 'pickup') {
        const trackCost = demand.isSupplyOnNetwork ? 0 : demand.estimatedTrackCostToSupply;
        if (trackCost > runningCash) {
          v.feasible = false;
          v.error = `Cumulative budget exceeded: need ~${trackCost}M track to reach ${stop.city}, only ~${runningCash}M remaining after prior stops.`;
        }
        runningCash -= trackCost;
      } else {
        // deliver
        const trackCost = demand.isDeliveryOnNetwork ? 0 : demand.estimatedTrackCostToDelivery;
        if (trackCost > runningCash) {
          v.feasible = false;
          v.error = `Cumulative budget exceeded: need ~${trackCost}M track to reach ${stop.city}, only ~${runningCash}M remaining after prior stops.`;
        }
        runningCash -= trackCost;
        runningCash += stop.payment ?? 0;
      }
    }
  }

  // ── Helpers ──────────────────────────────────────────────────────────────

  /**
   * Find the DemandContext matching a route stop.
   */
  private static findMatchingDemand(
    stop: RouteStop,
    context: GameContext,
  ): DemandContext | undefined {
    if (stop.action === 'pickup') {
      return context.demands.find(
        d => d.loadType === stop.loadType &&
          d.supplyCity.toLowerCase() === stop.city.toLowerCase(),
      );
    }
    return context.demands.find(
      d => d.loadType === stop.loadType &&
        d.deliveryCity.toLowerCase() === stop.city.toLowerCase(),
    );
  }

  /**
   * Estimate total new track cost for the route (for marginal budget warning).
   */
  private static estimateTotalRouteCost(
    validations: StopValidation[],
    context: GameContext,
  ): number {
    let total = 0;
    for (const v of validations) {
      if (!v.feasible) continue;
      const demand = RouteValidator.findMatchingDemand(v.stop, context);
      if (!demand) continue;
      if (v.stop.action === 'pickup' && !demand.isSupplyOnNetwork) {
        total += demand.estimatedTrackCostToSupply;
      } else if (v.stop.action === 'deliver' && !demand.isDeliveryOnNetwork) {
        total += demand.estimatedTrackCostToDelivery;
      }
    }
    return total;
  }
}
