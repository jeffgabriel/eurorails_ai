/**
 * RouteOptimizer — Stop-order optimization for LLM-planned routes.
 *
 * Owns the proximity-based stop reordering logic extracted from RouteValidator
 * as part of JIRA-184. RouteValidator is a pure feasibility predicate; this
 * class owns the transformation (reordering).
 *
 * Callers that want both optimized order AND feasibility validation:
 *   const optimized = RouteOptimizer.orderStopsByProximity(stops, botPos, gridPoints, carriedLoads);
 *   const validation = RouteValidator.validate({ ...route, stops: optimized }, context, snapshot);
 */

import { RouteStop } from '../../../shared/types/GameTypes';
import { estimateHopDistance, GridPointData } from './MapTopology';

export class RouteOptimizer {
  /**
   * Reorder route stops by geographic proximity using greedy nearest-neighbor.
   * Respects pickup-before-delivery constraints: a deliver(loadType) can only
   * be selected after its corresponding pickup(loadType) has been placed.
   */
  static orderStopsByProximity(
    stops: RouteStop[],
    botPosition: { row: number; col: number },
    gridPoints: Map<string, GridPointData>,
    carriedLoads?: string[],
  ): RouteStop[] {
    const tag = '[RouteOptimizer]';
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
    // JIRA-121 Bug 3: Carried loads already on train don't need a pickup first
    if (carriedLoads) {
      for (const load of carriedLoads) {
        pickupDone.add(load);
      }
    }
    const remaining = [...stops];
    const ordered: RouteStop[] = [];
    let currentPos = { row: botPosition.row, col: botPosition.col };

    while (remaining.length > 0) {
      // Find eligible stops (pickups and drops are always eligible; delivers need their pickup done)
      const eligible = remaining.filter(s =>
        s.action === 'pickup' || s.action === 'drop' || pickupDone.has(s.loadType),
      );

      if (eligible.length === 0) {
        // Safety: no eligible stops but remaining exist — append in original order
        ordered.push(...remaining);
        break;
      }

      // JIRA-121 Bug 3: Prioritize deliver stops for carried loads over pickup stops
      // JIRA-123: Gate with detour-cost threshold — only promote deliveries when
      // no eligible pickup is within NEARBY_PICKUP_THRESHOLD hops
      const NEARBY_PICKUP_THRESHOLD = 4;
      let carriedDelivers = carriedLoads
        ? eligible.filter(s => s.action === 'deliver' && carriedLoads.includes(s.loadType))
        : [];

      if (carriedDelivers.length > 0) {
        // Check if any eligible pickup is nearby — if so, grab it first
        const eligiblePickups = eligible.filter(s => s.action === 'pickup');
        const hasNearbyPickup = eligiblePickups.some(s => {
          const coords = cityCoords.get(s.city.toLowerCase());
          if (!coords) return false;
          const dist = estimateHopDistance(currentPos.row, currentPos.col, coords.row, coords.col);
          return dist >= 0 && dist <= NEARBY_PICKUP_THRESHOLD;
        });
        if (hasNearbyPickup) {
          const nearbyPickup = eligiblePickups.find(s => {
            const coords = cityCoords.get(s.city.toLowerCase());
            if (!coords) return false;
            return estimateHopDistance(currentPos.row, currentPos.col, coords.row, coords.col) <= NEARBY_PICKUP_THRESHOLD;
          });
          console.log(`${tag} Detour-cost gate: nearby pickup ${nearbyPickup?.city} prevents carried-load delivery promotion`);
          carriedDelivers = [];
        }
      }

      let nearest: RouteStop;
      let nearestDist = Infinity;

      if (carriedDelivers.length > 0) {
        // Pick the nearest carried-load delivery (immediate income, zero acquisition cost)
        nearest = carriedDelivers[0];
        for (const stop of carriedDelivers) {
          const coords = cityCoords.get(stop.city.toLowerCase());
          if (!coords) continue;
          const dist = estimateHopDistance(currentPos.row, currentPos.col, coords.row, coords.col);
          if (dist >= 0 && dist < nearestDist) {
            nearestDist = dist;
            nearest = stop;
          }
        }
        console.log(`${tag} Carried-load priority: deliver(${nearest.loadType}@${nearest.city}) promoted ahead of pickup stops`);
      } else {
        // Pick the nearest eligible stop (original behavior)
        nearest = eligible[0];
        for (const stop of eligible) {
          const coords = cityCoords.get(stop.city.toLowerCase());
          if (!coords) continue;
          const dist = estimateHopDistance(currentPos.row, currentPos.col, coords.row, coords.col);
          if (dist >= 0 && dist < nearestDist) {
            nearestDist = dist;
            nearest = stop;
          }
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
}
