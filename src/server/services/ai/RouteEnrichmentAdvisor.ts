/**
 * RouteEnrichmentAdvisor — Stub for JIRA-156 Project 1.
 *
 * In Project 1, this is a no-op pass-through that returns the route unchanged.
 * The actual LLM-powered implementation (corridor map analysis, stop
 * insertion/reordering) is added in Project 2: Route Enrichment Advisor.
 *
 * Call sites in TurnExecutorPlanner's movement loop already invoke
 * `RouteEnrichmentAdvisor.enrich()` so that Project 2 can provide the real
 * implementation without modifying TurnExecutorPlanner.
 */

import { StrategicRoute } from '../../../shared/types/GameTypes';

/**
 * RouteEnrichmentAdvisor — Project 1 stub.
 *
 * Accepts the same signature as the future LLM-powered implementation and
 * returns the route unchanged.
 */
export class RouteEnrichmentAdvisor {
  /**
   * Enrich a route with additional stops or reordering suggestions.
   *
   * **STUB**: Returns the route unchanged in Project 1.
   * Real implementation comes in Project 2.
   *
   * @param route - The newly replanned route from TripPlanner.
   * @returns The same route, unchanged.
   */
  static enrich(route: StrategicRoute): StrategicRoute {
    // Project 1: pass-through. Project 2 will examine the corridor map
    // and insert/reorder stops for optimal geographic efficiency.
    return route;
  }
}
