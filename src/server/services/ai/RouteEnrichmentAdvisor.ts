/**
 * RouteEnrichmentAdvisor — LLM-powered route enrichment (JIRA-156 Project 2).
 *
 * Examines an ASCII corridor map that covers all route stop cities and asks
 * the LLM to suggest stop insertions or reordering for en-route opportunities
 * that TripPlanner's city-level planning cannot see.
 *
 * Pattern reference: BuildAdvisor.advise() (same adapter, schema, fallback strategy).
 * Error strategy: graceful degradation — on any failure, return route unchanged.
 */

import {
  StrategicRoute,
  RouteStop,
  WorldSnapshot,
  GameContext,
  GridPoint,
  DemandContext,
} from '../../../shared/types/GameTypes';
import { LLMStrategyBrain } from './LLMStrategyBrain';
import { MapRenderer } from './MapRenderer';
import { ROUTE_ENRICHMENT_SCHEMA, RouteEnrichmentSchema } from './schemas';
import { RouteValidator } from './RouteValidator';

const MAX_RETRIES = 1;
const ENRICHMENT_TIMEOUT_MS = 30000;
const ENRICHMENT_MAX_TOKENS = 1024;

/**
 * RouteEnrichmentAdvisor — LLM-powered corridor map advisor.
 *
 * Called once per route creation or replan (not every turn). Returns the
 * original route unchanged if the LLM call fails or returns invalid data.
 */
export class RouteEnrichmentAdvisor {
  /**
   * Enrich a route with additional stops or reordering suggestions.
   *
   * Calls the LLM with a corridor map covering all route stop cities,
   * annotated with demand delivery (D) and pickup (P) cities, and asks
   * for insertions or reordering. Falls back to the original route on
   * any error.
   *
   * @param route - The newly planned or replanned route from TripPlanner.
   * @param snapshot - Current world snapshot (tracks, position, demand cards).
   * @param context - Game context with demand info used for D/P annotation.
   * @param brain - LLM strategy brain providing the provider adapter.
   * @param gridPoints - Full hex grid for corridor map rendering.
   * @returns Enriched route (or original if enrichment fails/returns keep).
   */
  static async enrich(
    route: StrategicRoute,
    snapshot: WorldSnapshot,
    context: GameContext,
    brain: LLMStrategyBrain,
    gridPoints: GridPoint[],
  ): Promise<StrategicRoute> {
    try {
      return await RouteEnrichmentAdvisor.attemptEnrich(route, snapshot, context, brain, gridPoints);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[RouteEnrichmentAdvisor] enrich failed (${msg}), returning original route`);
      return route;
    }
  }

  /** Internal: attempt enrichment with bounded retry on parse failure. */
  private static async attemptEnrich(
    route: StrategicRoute,
    snapshot: WorldSnapshot,
    context: GameContext,
    brain: LLMStrategyBrain,
    gridPoints: GridPoint[],
  ): Promise<StrategicRoute> {
    // 1. Render corridor map
    const corridorMap = MapRenderer.renderRouteCorridor(route, snapshot, gridPoints, context.demands);

    // 2. Build prompt
    const { system, user } = RouteEnrichmentAdvisor.buildPrompt(route, corridorMap.rendered, context.demands);

    // 3. Call LLM with bounded retry
    brain.providerAdapter.setContext({ gameId: snapshot.gameId, playerId: snapshot.bot.playerId, turn: snapshot.turnNumber, caller: 'route-enrichment-advisor', method: 'enrich' });
    let parsed: RouteEnrichmentSchema | null = null;
    let lastError = '';

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        const response = await brain.providerAdapter.chat({
          model: brain.modelName,
          maxTokens: ENRICHMENT_MAX_TOKENS,
          temperature: 0,
          systemPrompt: system,
          userPrompt: user,
          outputSchema: ROUTE_ENRICHMENT_SCHEMA,
          timeoutMs: ENRICHMENT_TIMEOUT_MS,
        });

        try {
          parsed = JSON.parse(response.text) as RouteEnrichmentSchema;
          break; // success
        } catch (parseErr) {
          lastError = `JSON parse failed: ${(parseErr as Error).message}`;
          console.warn(`[RouteEnrichmentAdvisor] attempt ${attempt + 1}: ${lastError}`);
        }
      } catch (callErr) {
        // LLM call failed — do not retry network errors
        throw callErr;
      }
    }

    if (!parsed) {
      console.warn(`[RouteEnrichmentAdvisor] all retries exhausted (${lastError}), returning original route`);
      return route;
    }

    // 4. Apply the LLM decision
    let enrichedRoute = RouteEnrichmentAdvisor.applyDecision(route, parsed, gridPoints);

    // 5. Validate the enriched route (skip if unchanged — 'keep' decision)
    if (enrichedRoute !== route) {
      const validation = RouteValidator.validate(
        { ...enrichedRoute, currentStopIndex: 0 },
        context,
        snapshot,
      );
      if (!validation.valid && !validation.prunedRoute) {
        console.warn('[RouteEnrichmentAdvisor] Enriched route rejected by validation, returning original route');
        return route;
      }
      if (validation.prunedRoute) {
        enrichedRoute = { ...enrichedRoute, stops: validation.prunedRoute.stops };
      }
    }

    return enrichedRoute;
  }

  /**
   * Apply the LLM's enrichment decision to the route.
   * Validates city names and stop structure before modifying the route.
   * Falls back to original route for any invalid data.
   */
  private static applyDecision(
    route: StrategicRoute,
    decision: RouteEnrichmentSchema,
    gridPoints: GridPoint[],
  ): StrategicRoute {
    const cityNames = new Set(
      gridPoints
        .filter(gp => gp.city?.name)
        .map(gp => gp.city!.name.toLowerCase()),
    );

    if (decision.decision === 'keep') {
      console.log(`[RouteEnrichmentAdvisor] LLM decided keep. Reasoning: ${decision.reasoning}`);
      return route;
    }

    if (decision.decision === 'insert' && decision.insertions && decision.insertions.length > 0) {
      // Validate all insertion cities exist in grid
      const validInsertions = decision.insertions.filter(ins => {
        if (!cityNames.has(ins.city.toLowerCase())) {
          console.warn(`[RouteEnrichmentAdvisor] insert: city "${ins.city}" not found in grid, skipping`);
          return false;
        }
        if (ins.action !== 'pickup' && ins.action !== 'deliver') {
          console.warn(`[RouteEnrichmentAdvisor] insert: invalid action "${ins.action}", skipping`);
          return false;
        }
        return true;
      });

      if (validInsertions.length === 0) {
        console.warn('[RouteEnrichmentAdvisor] insert: no valid insertions, returning original route');
        return route;
      }

      // Splice insertions into stop list (process in reverse order to preserve indices)
      const newStops = [...route.stops];
      const sorted = [...validInsertions].sort((a, b) => b.afterStopIndex - a.afterStopIndex);

      for (const ins of sorted) {
        const newStop: RouteStop = {
          action: ins.action,
          loadType: ins.loadType,
          city: ins.city,
        };
        const insertAt = Math.max(0, Math.min(ins.afterStopIndex + 1, newStops.length));
        newStops.splice(insertAt, 0, newStop);
      }

      console.log(
        `[RouteEnrichmentAdvisor] insert: added ${validInsertions.length} stop(s). New route: ${newStops.map(s => `${s.action}(${s.loadType}@${s.city})`).join(' → ')}`,
      );

      return { ...route, stops: newStops };
    }

    if (decision.decision === 'reorder' && decision.reorderedStops && decision.reorderedStops.length > 0) {
      // Validate all reordered stops
      const reordered = decision.reorderedStops;
      const allValid = reordered.every(s => {
        if (!cityNames.has(s.city.toLowerCase())) {
          console.warn(`[RouteEnrichmentAdvisor] reorder: city "${s.city}" not found in grid`);
          return false;
        }
        if (s.action !== 'pickup' && s.action !== 'deliver') {
          console.warn(`[RouteEnrichmentAdvisor] reorder: invalid action "${s.action}"`);
          return false;
        }
        return true;
      });

      if (!allValid) {
        console.warn('[RouteEnrichmentAdvisor] reorder: invalid stops in reordering, returning original route');
        return route;
      }

      const newStops: RouteStop[] = reordered.map(s => ({
        action: s.action,
        loadType: s.loadType,
        city: s.city,
        demandCardId: s.demandCardId,
        payment: s.payment,
      }));

      console.log(
        `[RouteEnrichmentAdvisor] reorder: new order: ${newStops.map(s => `${s.action}(${s.loadType}@${s.city})`).join(' → ')}`,
      );

      return { ...route, stops: newStops };
    }

    // Unknown decision or empty data — return unchanged
    console.warn(`[RouteEnrichmentAdvisor] unexpected decision "${decision.decision}" or empty data, returning original route`);
    return route;
  }

  /** Build the system and user prompts for the enrichment LLM call. */
  private static buildPrompt(
    route: StrategicRoute,
    corridorMap: string,
    demands: DemandContext[],
  ): { system: string; user: string } {
    const stopList = route.stops
      .map((s, i) => `  ${i}: ${s.action.toUpperCase()} ${s.loadType} at ${s.city}${s.payment ? ` (ECU ${s.payment}M)` : ''}`)
      .join('\n');

    const demandList = demands
      .slice(0, 6)
      .map(d => `  ${d.loadType}: pick up at ${d.supplyCity}, deliver to ${d.deliveryCity} (ECU ${d.payout}M)`)
      .join('\n');

    const system = `You are a route enrichment advisor for a train freight game. \
Given a planned route and a corridor map, identify en-route opportunities the planner missed: \
cities that are on or near the route where the bot could pick up or deliver a load with minimal detour.

Respond with JSON only using the ROUTE_ENRICHMENT_SCHEMA:
- "decision": "keep" | "insert" | "reorder"
- "insertions": (for insert) array of stops to splice in, each with afterStopIndex, action, loadType, city, reasoning
- "reorderedStops": (for reorder) the complete new stop list in preferred order
- "reasoning": brief explanation of your decision

Only suggest changes if they clearly improve efficiency. If the current route is already optimal, respond with decision: "keep".`;

    const user = `Current route stops:
${stopList}

Demand cards (delivery opportunities):
${demandList || '  (none)'}

Corridor map (T=route stop, D=delivery city, P=pickup city, B=bot track, O=opponent track):
${corridorMap}

Should this route be modified to capture nearby opportunities? Respond with JSON only.`;

    return { system, user };
  }
}
