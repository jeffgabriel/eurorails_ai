/**
 * LLMStrategyBrain — LLM-driven strategic decision-making for bot turns.
 *
 * v6.3 pipeline:
 *   ContextBuilder.serializePrompt() → ProviderAdapter.chat() →
 *   ResponseParser.parseActionIntent() → ActionResolver.resolve()
 *
 * Retry chain: full prompt (with error feedback) → heuristic fallback.
 * Created per-turn in AIStrategyEngine (not singleton).
 */

import {
  WorldSnapshot,
  BotSkillLevel,
  LLMProvider,
  LLM_DEFAULT_MODELS,
  LLMStrategyConfig,
  LLMDecisionResult,
  LLMActionIntent,
  GameContext,
  TurnPlan,
  AIActionType,
  StrategicRoute,
  GridPoint,
} from '../../../shared/types/GameTypes';
import { ResponseParser, ParseError } from './ResponseParser';
import { ActionResolver } from './ActionResolver';
import { ContextBuilder } from './ContextBuilder';
import { getSystemPrompt, getRoutePlanningPrompt } from './prompts/systemPrompts';
import { AnthropicAdapter } from './providers/AnthropicAdapter';
import { GoogleAdapter } from './providers/GoogleAdapter';
import { ProviderAdapter } from './providers/ProviderAdapter';
import { ProviderAuthError } from './providers/errors';
import { RouteValidator } from './RouteValidator';
import { ACTION_SCHEMA, ROUTE_SCHEMA } from './schemas';

/** Token budgets for turn action decisions by skill level */
const ACTION_MAX_TOKENS: Record<BotSkillLevel, number> = {
  [BotSkillLevel.Easy]: 2048,
  [BotSkillLevel.Medium]: 4096,
  [BotSkillLevel.Hard]: 8192,
};

/** Token budgets for route planning decisions by skill level */
const ROUTE_MAX_TOKENS: Record<BotSkillLevel, number> = {
  [BotSkillLevel.Easy]: 8192,
  [BotSkillLevel.Medium]: 12288,
  [BotSkillLevel.Hard]: 16384,
};

/** Thinking effort for turn action decisions by skill level */
const ACTION_EFFORT: Record<BotSkillLevel, string> = {
  [BotSkillLevel.Easy]: 'low',
  [BotSkillLevel.Medium]: 'medium',
  [BotSkillLevel.Hard]: 'high',
};

/** Thinking effort for route planning decisions by skill level */
const ROUTE_EFFORT: Record<BotSkillLevel, string> = {
  [BotSkillLevel.Easy]: 'medium',
  [BotSkillLevel.Medium]: 'high',
  [BotSkillLevel.Hard]: 'high',
};

/** Temperature: lower = more deterministic */
const TEMPERATURE_BY_SKILL: Record<BotSkillLevel, number> = {
  [BotSkillLevel.Easy]: 0.7,
  [BotSkillLevel.Medium]: 0.4,
  [BotSkillLevel.Hard]: 0.2,
};

export class LLMStrategyBrain {
  private readonly config: LLMStrategyConfig;
  private readonly adapter: ProviderAdapter;
  private readonly systemPrompt: string;
  private readonly model: string;

  constructor(config: LLMStrategyConfig) {
    this.config = config;

    // Resolve model from config or default lookup
    this.model = config.model ?? LLM_DEFAULT_MODELS[config.provider][config.skillLevel];

    // Build system prompt from skill level
    this.systemPrompt = getSystemPrompt(config.skillLevel);

    // Create provider adapter
    this.adapter = LLMStrategyBrain.createAdapter(config.provider, config.apiKey, config.timeoutMs);
  }

  /** Max LLM retries for decideAction (initial attempt + retries = MAX_LLM_RETRIES+1 total) */
  private static readonly MAX_LLM_RETRIES = 2;

  /**
   * Decide a strategic action via LLM (v6.3 pipeline).
   *
   * Pipeline: serializePrompt → LLM call → parseActionIntent → ActionResolver.resolve
   * Retry loop feeds error context back to the LLM. Falls back to heuristicFallback
   * after MAX_LLM_RETRIES failures.
   */
  async decideAction(
    snapshot: WorldSnapshot,
    context: GameContext,
  ): Promise<LLMDecisionResult> {
    let attempt = 0;
    let lastError: string | undefined;
    let finalPlan: TurnPlan | undefined;
    let finalReasoning = '';
    let finalPlanHorizon = '';
    let totalLatencyMs = 0;
    let totalInputTokens = 0;
    let totalOutputTokens = 0;

    while (attempt <= LLMStrategyBrain.MAX_LLM_RETRIES) {
      let userPrompt = ContextBuilder.serializePrompt(context, this.config.skillLevel);

      // On retry, append error context so the LLM can correct itself
      if (lastError) {
        userPrompt += `\n\nYOUR PREVIOUS CHOICE FAILED VALIDATION:\n${lastError}\nPlease choose a different action.`;
      }

      const startTime = Date.now();

      try {
        const useAdvancedFeatures = this.config.skillLevel !== BotSkillLevel.Easy;
        const response = await this.adapter.chat({
          model: this.model,
          maxTokens: ACTION_MAX_TOKENS[this.config.skillLevel],
          temperature: TEMPERATURE_BY_SKILL[this.config.skillLevel],
          systemPrompt: this.systemPrompt,
          userPrompt,
          ...(useAdvancedFeatures && {
            outputSchema: ACTION_SCHEMA,
            thinking: { type: 'adaptive' },
            effort: ACTION_EFFORT[this.config.skillLevel],
          }),
        });
        totalLatencyMs += (Date.now() - startTime);
        totalInputTokens += response.usage?.input ?? 0;
        totalOutputTokens += response.usage?.output ?? 0;

        const intent: LLMActionIntent = ResponseParser.parseActionIntent(response.text);
        const resolved = await ActionResolver.resolve(intent, snapshot, context);

        if (resolved.success && resolved.plan) {
          finalPlan = resolved.plan;
          finalReasoning = intent.reasoning || '';
          finalPlanHorizon = intent.planHorizon || '';
          break;
        } else {
          lastError = resolved.error || 'Action resolution failed without specific error.';
          console.warn(
            `[LLMStrategyBrain] Action resolution failed (attempt ${attempt + 1}): ${lastError}`,
          );
        }
      } catch (e: unknown) {
        totalLatencyMs += (Date.now() - startTime);
        if (e instanceof ProviderAuthError) {
          console.error('[LLMStrategyBrain] Auth error — using heuristic fallback');
          break; // Don't retry auth errors
        }
        lastError = e instanceof ParseError
          ? `Parsing error: ${e.message}`
          : `LLM call error: ${e instanceof Error ? e.message : String(e)}`;
        console.warn(
          `[LLMStrategyBrain] LLM/Parsing failed (attempt ${attempt + 1}): ${lastError}`,
        );
      }
      attempt++;
    }

    // If all retries fail, use heuristic fallback
    if (!finalPlan) {
      console.warn('[LLMStrategyBrain] All LLM attempts failed. Falling back to heuristic.');
      const fallback = await ActionResolver.heuristicFallback(context, snapshot);
      if (fallback.success && fallback.plan) {
        finalPlan = fallback.plan;
        finalReasoning = `[heuristic fallback] ${lastError ?? 'LLM failed to provide a valid plan.'}`;
        finalPlanHorizon = 'Immediate';
      } else {
        finalPlan = { type: AIActionType.PassTurn };
        finalReasoning = '[heuristic fallback] Heuristic also failed. Defaulting to PassTurn.';
        finalPlanHorizon = 'Immediate';
      }
    }

    return {
      plan: finalPlan,
      reasoning: finalReasoning,
      planHorizon: finalPlanHorizon,
      model: this.model,
      latencyMs: totalLatencyMs,
      tokenUsage: { input: totalInputTokens, output: totalOutputTokens },
      retried: attempt > 0,
    };
  }

  /**
   * Plan a multi-stop strategic route via LLM.
   *
   * Pipeline: serializePrompt (route planning) → LLM call → parseStrategicRoute
   * Retry loop feeds error context back to the LLM. Returns null on total failure
   * (caller should use heuristic fallback for this turn).
   */
  async planRoute(
    snapshot: WorldSnapshot,
    context: GameContext,
    gridPoints: GridPoint[],
    lastAbandonedRouteKey?: string | null,
  ): Promise<{ route: StrategicRoute; model: string; latencyMs: number; tokenUsage?: { input: number; output: number } } | null> {
    const routePrompt = getRoutePlanningPrompt(this.config.skillLevel);
    let attempt = 0;
    let lastError: string | undefined;
    let totalLatencyMs = 0;
    let totalInputTokens = 0;
    let totalOutputTokens = 0;

    while (attempt <= LLMStrategyBrain.MAX_LLM_RETRIES) {
      let userPrompt = ContextBuilder.serializeRoutePlanningPrompt(context, this.config.skillLevel, gridPoints, snapshot.bot.existingSegments, lastAbandonedRouteKey);

      if (lastError) {
        userPrompt += `\n\nYOUR PREVIOUS ROUTE PLAN FAILED VALIDATION:\n${lastError}\nPlease provide a corrected route.`;
      }

      const startTime = Date.now();

      try {
        const useAdvancedFeatures = this.config.skillLevel !== BotSkillLevel.Easy;
        const response = await this.adapter.chat({
          model: this.model,
          maxTokens: ROUTE_MAX_TOKENS[this.config.skillLevel],
          temperature: TEMPERATURE_BY_SKILL[this.config.skillLevel],
          systemPrompt: routePrompt,
          userPrompt,
          timeoutMs: 60000,
          ...(useAdvancedFeatures && {
            outputSchema: ROUTE_SCHEMA,
            thinking: { type: 'adaptive' },
            effort: ROUTE_EFFORT[this.config.skillLevel],
          }),
        });
        totalLatencyMs += (Date.now() - startTime);
        totalInputTokens += response.usage?.input ?? 0;
        totalOutputTokens += response.usage?.output ?? 0;

        const route = ResponseParser.parseStrategicRoute(response.text, snapshot.turnNumber);

        // Basic validation: at least one stop
        if (route.stops.length === 0) {
          lastError = 'Route must contain at least one stop.';
          console.warn(`[LLMStrategyBrain] Empty route (attempt ${attempt + 1})`);
          attempt++;
          continue;
        }

        // Feasibility validation: check each stop against game state
        const validation = RouteValidator.validate(route, context, snapshot);

        if (!validation.valid) {
          lastError = `Route infeasible: ${validation.errors.join('; ')}`;
          console.warn(`[LLMStrategyBrain] Route rejected (attempt ${attempt + 1}): ${lastError}`);
          attempt++;
          continue;
        }

        // Use pruned route if some stops were removed, otherwise original
        const validatedRoute = validation.prunedRoute ?? route;

        return {
          route: validatedRoute,
          model: this.model,
          latencyMs: totalLatencyMs,
          tokenUsage: { input: totalInputTokens, output: totalOutputTokens },
        };
      } catch (e: unknown) {
        totalLatencyMs += (Date.now() - startTime);
        if (e instanceof ProviderAuthError) {
          console.error('[LLMStrategyBrain] Auth error during route planning — giving up');
          return null;
        }
        lastError = e instanceof ParseError
          ? `Parsing error: ${e.message}`
          : `LLM call error: ${e instanceof Error ? e.message : String(e)}`;
        console.warn(`[LLMStrategyBrain] Route planning failed (attempt ${attempt + 1}): ${lastError}`);
      }
      attempt++;
    }

    console.warn('[LLMStrategyBrain] All route planning attempts failed.');
    return null;
  }

  /**
   * Create the appropriate provider adapter.
   */
  private static createAdapter(
    provider: LLMProvider,
    apiKey: string,
    timeoutMs: number,
  ): ProviderAdapter {
    switch (provider) {
      case LLMProvider.Anthropic:
        return new AnthropicAdapter(apiKey, timeoutMs);
      case LLMProvider.Google:
        return new GoogleAdapter(apiKey, timeoutMs);
      default:
        throw new Error(`Unsupported LLM provider: ${provider}`);
    }
  }
}
