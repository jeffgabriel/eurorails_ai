/**
 * RouteEnrichmentAdvisor — LLM-powered route enrichment (JIRA-214 Project 2).
 *
 * Repurposed from corridor-map advisor (JIRA-156) to a per-city drive-by pickup
 * advisor. Fires from MovementPhasePlanner's Phase A stop-execution loop after
 * each pickup/deliver/drop, when the bot is at a city that offers additional
 * loads matching demand cards not yet in the route.
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
import { ROUTE_ENRICHMENT_SCHEMA, RouteEnrichmentSchema } from './schemas';
import { RouteValidator } from './RouteValidator';
import { CandidateDetourInfo } from './RouteDetourEstimator';

const MAX_RETRIES = 1;
const ENRICHMENT_TIMEOUT_MS = 30000;
const ENRICHMENT_MAX_TOKENS = 1024;

/** Maximum candidates to include in the prompt (prevents token blow-out). */
const MAX_PROMPT_CANDIDATES = 5;

/**
 * RouteEnrichmentAdvisor — LLM-powered per-city drive-by pickup advisor.
 *
 * Called from MovementPhasePlanner's Phase A stop-execution loop when the bot
 * is at a city that offers additional loads. Returns the original route unchanged
 * if the LLM call fails or returns invalid data.
 */
export class RouteEnrichmentAdvisor {
  /**
   * Enrich a route with additional stops at the bot's current city.
   *
   * The advisor sees precomputed detour costs for each candidate (from
   * RouteDetourEstimator) so it can make truthful decisions without guessing.
   * Falls back to the original route on any error.
   *
   * @param route - The currently active route.
   * @param snapshot - Current world snapshot (tracks, position, demand cards).
   * @param context - Game context with demand info.
   * @param brain - LLM strategy brain providing the provider adapter.
   * @param gridPoints - Full hex grid for city name validation.
   * @param currentCity - City the bot is currently at (after executing a stop action).
   * @param candidates - Precomputed detour costs for candidate pickups (from RouteDetourEstimator).
   * @returns Enriched route (or original if enrichment fails/returns keep).
   */
  static async enrich(
    route: StrategicRoute,
    snapshot: WorldSnapshot,
    context: GameContext,
    brain: LLMStrategyBrain,
    gridPoints: GridPoint[],
    currentCity?: string,
    candidates?: CandidateDetourInfo[],
  ): Promise<StrategicRoute> {
    try {
      return await RouteEnrichmentAdvisor.attemptEnrich(
        route, snapshot, context, brain, gridPoints,
        currentCity ?? '',
        candidates ?? [],
      );
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
    currentCity: string,
    candidates: CandidateDetourInfo[],
  ): Promise<StrategicRoute> {
    // Sort candidates by marginalBuildM ascending (best first), cap at MAX_PROMPT_CANDIDATES
    const sortedCandidates = [...candidates]
      .sort((a, b) => a.marginalBuildM - b.marginalBuildM)
      .slice(0, MAX_PROMPT_CANDIDATES);

    // Log entry summary
    console.log(
      `[RouteEnrichmentAdvisor] candidates at ${currentCity}: ` +
      `${sortedCandidates.map(c => `${c.loadType}→${c.deliveryCity}(build=${c.marginalBuildM}M,turns=${c.marginalTurns})`).join(', ')}`,
    );

    if (sortedCandidates.length === 0) {
      console.log(`[RouteEnrichmentAdvisor] no viable candidates at ${currentCity}`);
      return route;
    }

    // Build prompt
    const { system, user } = RouteEnrichmentAdvisor.buildPrompt(
      route, snapshot, context, currentCity, sortedCandidates,
    );

    // Call LLM with bounded retry
    brain.providerAdapter.setContext({
      gameId: snapshot.gameId,
      playerId: snapshot.bot.playerId,
      playerName: snapshot.bot.botConfig?.name,
      turn: snapshot.turnNumber,
      caller: 'route-enrichment-advisor',
      method: 'enrich',
    });
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

    // Apply the LLM decision — pass captured candidates (snapshot stability: R7/AC18)
    const enrichedRoute = RouteEnrichmentAdvisor.applyDecision(
      route, parsed, gridPoints, context, sortedCandidates,
    );

    // Validate the enriched route (skip if unchanged — 'keep' decision)
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
        // Log each pruned stop
        const enrichedSet = new Set(enrichedRoute.stops.map(s => `${s.action}:${s.loadType}:${s.city}`));
        const prunedSet = new Set(validation.prunedRoute.stops.map(s => `${s.action}:${s.loadType}:${s.city}`));
        for (const key of enrichedSet) {
          if (!prunedSet.has(key)) {
            const [action, loadType, city] = key.split(':');
            const reason = validation.errors?.[0] ?? 'validator pruned';
            console.warn(
              `[RouteEnrichmentAdvisor] validator pruned insertion ${loadType}@${city} (action=${action}): ${reason}`,
            );
          }
        }
        return { ...enrichedRoute, stops: validation.prunedRoute.stops };
      }
    }

    return enrichedRoute;
  }

  /**
   * Apply the LLM's enrichment decision to the route.
   * Validates city names and stop structure before modifying the route.
   * For inserted DELIVER stops, attaches payment, demandCardId, and insertionDetourCostOverride.
   * Splices a free PICKUP at currentCity ahead of the delivery slot.
   * Falls back to original route for any invalid data.
   *
   * @param route - Current route
   * @param decision - LLM decision
   * @param gridPoints - Grid points for city validation
   * @param context - Game context for demand card lookup
   * @param candidates - Captured candidate info at advisor entry (snapshot stability)
   */
  private static applyDecision(
    route: StrategicRoute,
    decision: RouteEnrichmentSchema,
    gridPoints: GridPoint[],
    context?: GameContext,
    candidates?: CandidateDetourInfo[],
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
        // Build the DELIVER stop with enriched fields
        const newStop: RouteStop = {
          action: ins.action,
          loadType: ins.loadType,
          city: ins.city,
        };

        // For DELIVER stops: attach payment, demandCardId, and insertionDetourCostOverride
        if (ins.action === 'deliver' && context && candidates) {
          // Look up demand card by (loadType, deliveryCity)
          const demand = context.demands.find(
            d => d.loadType === ins.loadType && d.deliveryCity === ins.city,
          );
          if (demand) {
            newStop.payment = demand.payout;
            newStop.demandCardId = demand.cardIndex;
          }

          // Look up marginalBuildM from captured candidates
          const candidateInfo = candidates.find(
            c => c.loadType === ins.loadType && c.deliveryCity === ins.city,
          );
          if (candidateInfo) {
            newStop.insertionDetourCostOverride = candidateInfo.marginalBuildM;

            // Log divergence warning if LLM echoed an expectedDetourCost that differs > 30%
            if (ins.expectedDetourCost !== undefined && candidateInfo.marginalBuildM !== 0) {
              const computed = candidateInfo.marginalBuildM;
              const llmEchoed = ins.expectedDetourCost;
              const deltaPct = Math.abs((llmEchoed - computed) / computed) * 100;
              if (deltaPct > 30) {
                console.warn(
                  `[RouteEnrichmentAdvisor] detour echo divergence: ${ins.loadType}@${ins.city} ` +
                  `LLM=${llmEchoed}M computed=${computed}M (Δ=${deltaPct.toFixed(0)}%)`,
                );
              }
            } else if (ins.expectedDetourCost !== undefined && candidateInfo.marginalBuildM === 0 && ins.expectedDetourCost !== 0) {
              // computed=0 special case: any non-zero echo is divergent
              console.warn(
                `[RouteEnrichmentAdvisor] detour echo divergence: ${ins.loadType}@${ins.city} ` +
                `LLM=${ins.expectedDetourCost}M computed=0M (Δ=100%)`,
              );
            }
          }
        }

        const insertAt = Math.max(0, Math.min(ins.afterStopIndex + 1, newStops.length));
        newStops.splice(insertAt, 0, newStop);

        console.log(
          `[RouteEnrichmentAdvisor] applied insertion: ${ins.action}(${ins.loadType}@${ins.city}) ` +
          `at index ${insertAt}` +
          (newStop.payment !== undefined ? ` payment=${newStop.payment}M` : '') +
          (newStop.insertionDetourCostOverride !== undefined ? ` override=${newStop.insertionDetourCostOverride}M` : ''),
        );
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
    snapshot: WorldSnapshot,
    context: GameContext,
    currentCity: string,
    candidates: CandidateDetourInfo[],
  ): { system: string; user: string } {
    const slotsUsed = snapshot.bot.loads.length;
    const capacity = context.capacity;
    const slotsFree = Math.max(0, capacity - slotsUsed);
    const carrying = snapshot.bot.loads.length > 0 ? snapshot.bot.loads.join(', ') : 'nothing';

    const remainingStops = route.stops
      .slice(route.currentStopIndex)
      .map((s, i) => `  ${i}: ${s.action.toUpperCase()} ${s.loadType} at ${s.city}${s.payment ? ` (ECU ${s.payment}M)` : ''}`)
      .join('\n');

    const candidateList = candidates
      .map(c =>
        `  - ${c.loadType} → ${c.deliveryCity} | payout=${c.payout}M | ` +
        `marginalBuild=${c.marginalBuildM}M | marginalTurns=${c.marginalTurns} | ` +
        `bestSlotIndex=${c.bestSlotIndex}`,
      )
      .join('\n');

    const system = `You are a route enrichment advisor for a train freight game. \
The bot is at a city that offers additional loads. Your job is to decide whether \
picking up one or more of these loads is worth the detour cost.

You are given PRECOMPUTED detour costs (marginalBuild, marginalTurns) per candidate. \
Use these numbers as the source of truth — do NOT estimate detour costs yourself.

Heuristic: choose 'insert' only when, for at least one candidate, \
marginalBuild + (marginalTurns × ~5M/turn) < ~0.6 × payout.

Respond with JSON only using the ROUTE_ENRICHMENT_SCHEMA:
- "decision": "keep" | "insert"
- "insertions": (for insert) array of DELIVER stops to splice in, each with afterStopIndex, action="deliver", loadType, city, reasoning. Optionally include expectedDetourCost (the marginalBuild value you used).
- "reasoning": brief explanation of your decision

Only insert a stop if it clearly improves income velocity. If no candidate passes the heuristic, respond with decision: "keep".`;

    const user = `Bot is currently at: ${currentCity}
Train state: carrying [${carrying}], ${slotsFree} slot(s) free (capacity=${capacity})
Money: ECU ${snapshot.bot.money}M

Remaining route stops:
${remainingStops || '  (none — route is empty)'}

Additional loads available here:
${candidateList}

Should this route be modified to capture a drive-by pickup? Respond with JSON only.`;

    return { system, user };
  }
}
