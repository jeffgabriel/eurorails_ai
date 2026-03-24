/**
 * TripPlanner — Multi-stop trip planning service (JIRA-126).
 *
 * Replaces serial single-delivery planning with multi-stop trip planning.
 * Generates 2-3 candidate trips via LLM, scores them by netValue/estimatedTurns,
 * validates via RouteValidator, and converts the best into a StrategicRoute.
 */

import {
  BotSkillLevel,
  BotMemoryState,
  GameContext,
  GridPoint,
  LlmAttempt,
  RouteStop,
  StrategicRoute,
  WorldSnapshot,
} from '../../../shared/types/GameTypes';
import { LLMStrategyBrain } from './LLMStrategyBrain';
import { RouteValidator } from './RouteValidator';
import { TRIP_PLAN_SCHEMA } from './schemas';
import { getTripPlanningPrompt } from './prompts/systemPrompts';

// ── Types ────────────────────────────────────────────────────────────

export interface TripCandidate {
  stops: RouteStop[];
  score: number;
  netValue: number;
  estimatedTurns: number;
  buildCostEstimate: number;
  usageFeeEstimate: number;
  reasoning: string;
}

export interface TripPlanResult {
  candidates: TripCandidate[];
  chosen: number;
  route: StrategicRoute;
  llmLatencyMs: number;
  llmTokens: { input: number; output: number };
  llmLog: LlmAttempt[];
  systemPrompt?: string;
  userPrompt?: string;
}

/** Raw LLM output matching TRIP_PLAN_SCHEMA */
interface LLMTripPlanResponse {
  candidates: Array<{
    stops: Array<{
      action: string;
      load: string;
      city: string;
      demandCardId?: number;
      payment?: number;
    }>;
    reasoning: string;
  }>;
  chosenIndex: number;
  reasoning: string;
  upgradeOnRoute?: string;
}

// ── Token budgets (same scale as route planning) ─────────────────────

const TRIP_MAX_TOKENS: Record<BotSkillLevel, number> = {
  [BotSkillLevel.Easy]: 8192,
  [BotSkillLevel.Medium]: 12288,
  [BotSkillLevel.Hard]: 16384,
};

const TRIP_EFFORT: Record<BotSkillLevel, string> = {
  [BotSkillLevel.Easy]: 'low',
  [BotSkillLevel.Medium]: 'medium',
  [BotSkillLevel.Hard]: 'medium',
};

const TEMPERATURE_BY_SKILL: Record<BotSkillLevel, number> = {
  [BotSkillLevel.Easy]: 0.7,
  [BotSkillLevel.Medium]: 0.4,
  [BotSkillLevel.Hard]: 0.2,
};

const MAX_RETRIES = 2;

// ── TripPlanner ──────────────────────────────────────────────────────

export class TripPlanner {
  private readonly brain: LLMStrategyBrain;

  constructor(brain: LLMStrategyBrain) {
    this.brain = brain;
  }

  /**
   * Plan a multi-stop trip. On total failure (LLM + fallback both fail),
   * returns a failure result with route=null and the llmLog preserved for diagnostics.
   */
  async planTrip(
    snapshot: WorldSnapshot,
    context: GameContext,
    gridPoints: GridPoint[],
    memory: BotMemoryState,
    userPromptOverride?: string,
  ): Promise<TripPlanResult | { route: null; llmLog: LlmAttempt[] }> {
    const config = this.brain.strategyConfig;
    const adapter = this.brain.providerAdapter;
    const model = this.brain.modelName;
    const skillLevel = config.skillLevel;

    const systemPrompt = getTripPlanningPrompt(skillLevel, context, memory);
    const userPrompt = userPromptOverride ?? `Plan the best multi-stop trip for this turn. Consider all 3 demand cards simultaneously.`;

    const llmLog: LlmAttempt[] = [];
    let lastError: string | undefined;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      const promptWithError = lastError
        ? `${userPrompt}\n\nPREVIOUS ATTEMPT FAILED: ${lastError}\nPlease fix the issue and try again.`
        : userPrompt;

      const startMs = Date.now();
      try {
        adapter.setContext({ gameId: snapshot.gameId, playerId: snapshot.bot.playerId, turn: snapshot.turnNumber, caller: 'trip-planner', method: 'planTrip' });
        const response = await adapter.chat({
          model,
          maxTokens: TRIP_MAX_TOKENS[skillLevel],
          temperature: TEMPERATURE_BY_SKILL[skillLevel],
          systemPrompt,
          userPrompt: promptWithError,
          outputSchema: TRIP_PLAN_SCHEMA,
          ...(skillLevel !== BotSkillLevel.Easy && {
            thinking: { type: 'adaptive' },
            effort: TRIP_EFFORT[skillLevel],
          }),
        });
        const latencyMs = Date.now() - startMs;

        // Parse LLM response
        let parsed: LLMTripPlanResponse;
        try {
          parsed = typeof response.text === 'string'
            ? JSON.parse(response.text)
            : response.text as unknown as LLMTripPlanResponse;
        } catch {
          const err = `JSON parse error: ${response.text.substring(0, 200)}`;
          llmLog.push({ attemptNumber: attempt + 1, status: 'parse_error', responseText: response.text.substring(0, 500), error: err, latencyMs });
          lastError = err;
          continue;
        }

        // Validate basic structure
        if (!parsed.candidates || parsed.candidates.length === 0) {
          const err = 'LLM returned no candidates';
          llmLog.push({ attemptNumber: attempt + 1, status: 'validation_error', responseText: response.text.substring(0, 500), error: err, latencyMs });
          lastError = err;
          continue;
        }

        // Convert and validate each candidate
        const candidates = this.scoreCandidates(parsed, context, snapshot);

        if (candidates.length === 0) {
          const err = 'All candidates failed validation';
          llmLog.push({ attemptNumber: attempt + 1, status: 'validation_error', responseText: response.text.substring(0, 500), error: err, latencyMs });
          lastError = err;
          continue;
        }

        // Pick the best candidate (highest score)
        const bestIdx = candidates.reduce((best, c, i) =>
          c.score > candidates[best].score ? i : best, 0);
        const chosen = candidates[bestIdx];

        // Convert to StrategicRoute
        const route: StrategicRoute = {
          stops: chosen.stops,
          currentStopIndex: 0,
          phase: 'build',
          createdAtTurn: context.turnNumber,
          reasoning: chosen.reasoning,
          upgradeOnRoute: parsed.upgradeOnRoute,
        };

        llmLog.push({
          attemptNumber: attempt + 1,
          status: 'success',
          responseText: response.text.substring(0, 500),
          latencyMs,
        });

        return {
          candidates,
          chosen: bestIdx,
          route,
          llmLatencyMs: latencyMs,
          llmTokens: response.usage,
          llmLog,
          systemPrompt,
          userPrompt,
        };
      } catch (error) {
        const latencyMs = Date.now() - startMs;
        const err = error instanceof Error ? error.message : String(error);
        llmLog.push({ attemptNumber: attempt + 1, status: 'api_error', responseText: '', error: err, latencyMs });
        lastError = err;
      }
    }

    // All retries failed — try fallback via planRoute()
    console.warn(`[TripPlanner] All ${MAX_RETRIES + 1} attempts failed, falling back to planRoute()`);
    try {
      const fallback = await this.brain.planRoute(
        snapshot,
        context,
        gridPoints,
        memory.lastAbandonedRouteKey,
        memory.previousRouteStops,
      );
      if (fallback.route) {
        const successResult = fallback as { route: StrategicRoute; model: string; latencyMs: number; tokenUsage?: { input: number; output: number }; llmLog: LlmAttempt[]; systemPrompt?: string; userPrompt?: string };
        return {
          candidates: [],
          chosen: -1,
          route: successResult.route,
          llmLatencyMs: successResult.latencyMs,
          llmTokens: successResult.tokenUsage ?? { input: 0, output: 0 },
          llmLog: [...llmLog, ...successResult.llmLog],
          systemPrompt: successResult.systemPrompt,
          userPrompt: successResult.userPrompt,
        };
      }
    } catch (fallbackErr) {
      const errMsg = fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr);
      console.warn(`[TripPlanner] planRoute() fallback also failed: ${errMsg}`);
    }

    // Return failure with preserved llmLog for diagnostics
    return { route: null, llmLog };
  }

  /**
   * Score and validate LLM candidates. Returns only valid candidates sorted by score.
   */
  private scoreCandidates(
    parsed: LLMTripPlanResponse,
    context: GameContext,
    snapshot: WorldSnapshot,
  ): TripCandidate[] {
    const validCandidates: TripCandidate[] = [];

    for (const rawCandidate of parsed.candidates) {
      // Convert LLM stops to RouteStop format
      const stops: RouteStop[] = rawCandidate.stops.map(s => ({
        action: s.action.toLowerCase() as 'pickup' | 'deliver',
        loadType: s.load,
        city: s.city,
        demandCardId: s.demandCardId,
        payment: s.payment,
      }));

      // Build a temporary StrategicRoute for validation
      const tempRoute: StrategicRoute = {
        stops,
        currentStopIndex: 0,
        phase: 'build',
        createdAtTurn: context.turnNumber,
        reasoning: rawCandidate.reasoning,
      };

      // Validate via RouteValidator
      const validation = RouteValidator.validate(tempRoute, context, snapshot);
      if (!validation.valid && !validation.prunedRoute) {
        continue; // completely invalid
      }

      // Use pruned route if available
      const finalStops = validation.prunedRoute?.stops ?? stops;

      // Calculate scoring metrics from demand context
      let totalPayout = 0;
      let totalBuildCost = 0;
      let totalEstimatedTurns = 0;

      for (const stop of finalStops) {
        if (stop.action === 'deliver' && stop.payment) {
          totalPayout += stop.payment;
        }
        // Estimate build costs from demand context data
        const matchingDemand = context.demands.find(
          d => d.loadType === stop.loadType && (
            (stop.action === 'pickup' && d.supplyCity === stop.city) ||
            (stop.action === 'deliver' && d.deliveryCity === stop.city)
          ),
        );
        if (matchingDemand) {
          if (stop.action === 'pickup') {
            totalBuildCost += matchingDemand.estimatedTrackCostToSupply;
          } else {
            totalBuildCost += matchingDemand.estimatedTrackCostToDelivery;
          }
          totalEstimatedTurns = Math.max(totalEstimatedTurns, matchingDemand.estimatedTurns);
        }
      }

      // Prevent division by zero
      const estimatedTurns = Math.max(totalEstimatedTurns, 1);
      const netValue = totalPayout - totalBuildCost;
      const score = netValue / estimatedTurns;

      validCandidates.push({
        stops: finalStops,
        score,
        netValue,
        estimatedTurns,
        buildCostEstimate: totalBuildCost,
        usageFeeEstimate: 0, // no opponent track awareness per spec
        reasoning: rawCandidate.reasoning,
      });
    }

    return validCandidates.sort((a, b) => b.score - a.score);
  }
}
