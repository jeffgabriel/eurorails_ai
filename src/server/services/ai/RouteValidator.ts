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
import { loadGridPoints, estimateHopDistance, GridPointData } from '../MapTopology';

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

    // ── Reorder stops by geographic proximity ──
    // Greedy nearest-neighbor with pickup-before-delivery constraints.
    // Must run before cumulative budget check so budget is validated against
    // the actual execution order.
    if (validations.length > 1) {
      const botPos = snapshot.bot.position;
      if (botPos) {
        const gridPoints = loadGridPoints();
        const reordered = RouteValidator.reorderStopsByProximity(
          validations.filter(v => v.feasible).map(v => v.stop),
          botPos,
          gridPoints,
        );
        // Rebuild validations array in reordered sequence
        const reorderedValidations: StopValidation[] = reordered.map(stop => {
          const orig = validations.find(v => v.stop === stop);
          return orig!;
        });
        // Append infeasible stops at the end (order doesn't matter for them)
        const infeasible = validations.filter(v => !v.feasible);
        validations.length = 0;
        validations.push(...reorderedValidations, ...infeasible);
      }
      // else: bot position null (initial build) — skip reorder, keep LLM's original stop order
    }

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

    // ── Post-pruning delivery check ──
    // A route with only pickup stops (no deliveries) after pruning has no payout
    // and no destination — reject it so the bot replans with a viable route.
    const hasDeliveryStop = validations.some(v => v.feasible && v.stop.action === 'deliver');
    const hasFeasibleStop = validations.some(v => v.feasible);
    if (hasFeasibleStop && !hasDeliveryStop) {
      const allErrors = validations.filter(v => !v.feasible).map(v => v.error!);
      allErrors.push('Route has no delivery stops after pruning — not viable');
      console.warn(`${tag} Route has no delivery stops after pruning — rejecting`);
      return { valid: false, errors: allErrors };
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
      // Return reordered route if stop order changed
      const stopsChanged = feasibleStops.some((s, i) => s !== route.stops[i]);
      if (stopsChanged) {
        return { valid: true, prunedRoute: { ...route, stops: feasibleStops }, errors: [] };
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

    // JIRA-96: Defensive $0M gate — when bot has no cash, reject any stop
    // requiring track building. The per-stop trackCost check below should
    // catch this, but upstream estimatedTrackCost/isOnNetwork may be wrong.
    if (runningCash < 1) {
      for (const v of validations) {
        if (!v.feasible) continue;
        const stop = v.stop;
        const demand = RouteValidator.findMatchingDemand(stop, context);
        if (!demand) continue;
        const needsTrack = stop.action === 'pickup'
          ? !demand.isSupplyOnNetwork && demand.estimatedTrackCostToSupply > 0
          : !demand.isDeliveryOnNetwork && demand.estimatedTrackCostToDelivery > 0;
        if (needsTrack) {
          v.feasible = false;
          v.error = `Bot has ${runningCash}M — cannot afford track to ${stop.city}.`;
        }
      }
    }

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
        runningCash += stop.payment ?? demand?.payout ?? 0;
      }
    }
  }

  // ── Stop reordering ─────────────────────────────────────────────────────

  /**
   * Reorder route stops by geographic proximity using greedy nearest-neighbor.
   * Respects pickup-before-delivery constraints: a deliver(loadType) can only
   * be selected after its corresponding pickup(loadType) has been placed.
   */
  static reorderStopsByProximity(
    stops: RouteStop[],
    botPosition: { row: number; col: number },
    gridPoints: Map<string, GridPointData>,
  ): RouteStop[] {
    const tag = '[RouteValidator]';
    if (stops.length <= 1) return stops;

    // Build city coordinate lookup (first matching grid point per city name)
    const cityCoords = new Map<string, { row: number; col: number }>();
    for (const [, gp] of gridPoints) {
      if (gp.name && !cityCoords.has(gp.name.toLowerCase())) {
        cityCoords.set(gp.name.toLowerCase(), { row: gp.row, col: gp.col });
      }
    }

    // Build dependency map: deliver(loadType) requires pickup(loadType) first
    const pickupDone = new Set<string>();
    const remaining = [...stops];
    const ordered: RouteStop[] = [];
    let currentPos = { row: botPosition.row, col: botPosition.col };

    while (remaining.length > 0) {
      // Find eligible stops (pickups are always eligible; delivers need their pickup done)
      const eligible = remaining.filter(s =>
        s.action === 'pickup' || pickupDone.has(s.loadType),
      );

      if (eligible.length === 0) {
        // Safety: no eligible stops but remaining exist — append in original order
        ordered.push(...remaining);
        break;
      }

      // Pick the nearest eligible stop
      let nearest = eligible[0];
      let nearestDist = Infinity;
      for (const stop of eligible) {
        const coords = cityCoords.get(stop.city.toLowerCase());
        if (!coords) continue;
        const dist = estimateHopDistance(currentPos.row, currentPos.col, coords.row, coords.col);
        if (dist >= 0 && dist < nearestDist) {
          nearestDist = dist;
          nearest = stop;
        }
      }

      ordered.push(nearest);
      const idx = remaining.indexOf(nearest);
      remaining.splice(idx, 1);

      // Update state
      if (nearest.action === 'pickup') {
        pickupDone.add(nearest.loadType);
      }
      const coords = cityCoords.get(nearest.city.toLowerCase());
      if (coords) {
        currentPos = { row: coords.row, col: coords.col };
      }
    }

    // Log if order changed
    const originalOrder = stops.map(s => `${s.action}(${s.loadType}@${s.city})`).join(' → ');
    const newOrder = ordered.map(s => `${s.action}(${s.loadType}@${s.city})`).join(' → ');
    if (originalOrder !== newOrder) {
      console.log(`${tag} Reordered stops by proximity:\n  was: ${originalOrder}\n  now: ${newOrder}`);
    }

    return ordered;
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
