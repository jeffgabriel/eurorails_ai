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
  RouteStop,
  LlmAttempt,
} from '../../../shared/types/GameTypes';
import { ResponseParser, ParseError } from './ResponseParser';
import { ActionResolver } from './ActionResolver';
import { ContextBuilder } from './ContextBuilder';
import { getSystemPrompt, getRoutePlanningPrompt, getCargoConflictPrompt, getUpgradeBeforeDropPrompt } from './prompts/systemPrompts';
import { AnthropicAdapter } from './providers/AnthropicAdapter';
import { GoogleAdapter } from './providers/GoogleAdapter';
import { ProviderAdapter } from './providers/ProviderAdapter';
import { ProviderAuthError } from './providers/errors';
import { RouteValidator } from './RouteValidator';
import { ACTION_SCHEMA, ROUTE_SCHEMA, CARGO_CONFLICT_SCHEMA, UPGRADE_BEFORE_DROP_SCHEMA } from './schemas';

/** JIRA-92: Result of cargo conflict evaluation */
export interface CargoConflictResult {
  action: 'drop' | 'keep';
  dropLoad?: string;
  reasoning: string;
}

/** JIRA-105b: Result of upgrade-before-drop evaluation */
export interface UpgradeBeforeDropResult {
  action: 'upgrade' | 'skip';
  targetTrain?: string;
  reasoning: string;
}

/** JIRA-89: Result of secondary delivery evaluation */
export interface SecondaryDeliveryResult {
  action: 'none' | 'add_secondary';
  reasoning: string;
  pickupCity?: string;
  loadType?: string;
  deliveryCity?: string;
}


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
  [BotSkillLevel.Medium]: 'low',
  [BotSkillLevel.Hard]: 'medium',
};

/** Thinking effort for route planning decisions by skill level */
const ROUTE_EFFORT: Record<BotSkillLevel, string> = {
  [BotSkillLevel.Easy]: 'low',
  [BotSkillLevel.Medium]: 'medium',
  [BotSkillLevel.Hard]: 'medium',
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

  /** Expose adapter for TripPlanner (JIRA-126) */
  get providerAdapter(): ProviderAdapter { return this.adapter; }

  /** Expose resolved model name for TripPlanner (JIRA-126) */
  get modelName(): string { return this.model; }

  /** Expose config for TripPlanner (JIRA-126) */
  get strategyConfig(): LLMStrategyConfig { return this.config; }

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
    const llmLog: LlmAttempt[] = [];
    const initialUserPrompt = ContextBuilder.serializePrompt(context, this.config.skillLevel);

    while (attempt <= LLMStrategyBrain.MAX_LLM_RETRIES) {
      let userPrompt = initialUserPrompt;

      // On retry, append error context so the LLM can correct itself
      if (lastError) {
        userPrompt += `\n\nYOUR PREVIOUS CHOICE FAILED VALIDATION:\n${lastError}\nPlease choose a different action.`;
      }

      const startTime = Date.now();

      try {
        const useThinking = this.config.skillLevel !== BotSkillLevel.Easy;
        const response = await this.adapter.chat({
          model: this.model,
          maxTokens: ACTION_MAX_TOKENS[this.config.skillLevel],
          temperature: TEMPERATURE_BY_SKILL[this.config.skillLevel],
          systemPrompt: this.systemPrompt,
          userPrompt,
          outputSchema: ACTION_SCHEMA,
          ...(useThinking && {
            thinking: { type: 'adaptive' },
            effort: ACTION_EFFORT[this.config.skillLevel],
          }),
        });
        const attemptLatency = Date.now() - startTime;
        totalLatencyMs += attemptLatency;
        totalInputTokens += response.usage?.input ?? 0;
        totalOutputTokens += response.usage?.output ?? 0;

        const intent: LLMActionIntent = ResponseParser.parseActionIntent(response.text);
        const resolved = await ActionResolver.resolve(intent, snapshot, context);

        if (resolved.success && resolved.plan) {
          llmLog.push({
            attemptNumber: attempt + 1,
            status: 'success',
            responseText: response.text.slice(0, 500),
            latencyMs: attemptLatency,
          });
          finalPlan = resolved.plan;
          finalReasoning = intent.reasoning || '';
          finalPlanHorizon = intent.planHorizon || '';
          break;
        } else {
          lastError = resolved.error || 'Action resolution failed without specific error.';
          llmLog.push({
            attemptNumber: attempt + 1,
            status: 'validation_error',
            responseText: response.text.slice(0, 500),
            error: lastError,
            latencyMs: attemptLatency,
          });
          console.warn(
            `[LLMStrategyBrain] Action resolution failed (attempt ${attempt + 1}): ${lastError}`,
          );
        }
      } catch (e: unknown) {
        const attemptLatency = Date.now() - startTime;
        totalLatencyMs += attemptLatency;
        if (e instanceof ProviderAuthError) {
          llmLog.push({
            attemptNumber: attempt + 1,
            status: 'api_error',
            responseText: '',
            error: `Auth error: ${e.message}`,
            latencyMs: attemptLatency,
          });
          console.error('[LLMStrategyBrain] Auth error — using heuristic fallback');
          break; // Don't retry auth errors
        }
        const isParse = e instanceof ParseError;
        lastError = isParse
          ? `Parsing error: ${e.message}`
          : `LLM call error: ${e instanceof Error ? e.message : String(e)}`;
        llmLog.push({
          attemptNumber: attempt + 1,
          status: isParse ? 'parse_error' : 'api_error',
          responseText: '',
          error: lastError,
          latencyMs: attemptLatency,
        });
        console.warn(
          `[LLMStrategyBrain] LLM/Parsing failed (attempt ${attempt + 1}): ${lastError}`,
        );
      }
      attempt++;
    }

    // If all retries fail, use heuristic fallback
    if (!finalPlan) {
      console.warn('[LLMStrategyBrain] All LLM attempts failed. Falling back to heuristic.');
      const fallback = await ActionResolver.heuristicFallback(context, snapshot, { llmFailed: true });
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
      llmLog,
      systemPrompt: this.systemPrompt,
      userPrompt: initialUserPrompt,
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
    previousRouteStops?: RouteStop[] | null, // BE-010
    budgetHint?: string, // JIRA-103: optional cost constraint guidance for retry
  ): Promise<{ route: StrategicRoute; model: string; latencyMs: number; tokenUsage?: { input: number; output: number }; llmLog: LlmAttempt[]; systemPrompt?: string; userPrompt?: string } | { route: null; llmLog: LlmAttempt[] }> {
    const routePrompt = getRoutePlanningPrompt(this.config.skillLevel);
    let attempt = 0;
    let lastError: string | undefined;
    let totalLatencyMs = 0;
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    const llmLog: LlmAttempt[] = [];
    const initialRouteUserPrompt = ContextBuilder.serializeRoutePlanningPrompt(context, this.config.skillLevel, gridPoints, snapshot.bot.existingSegments, lastAbandonedRouteKey, previousRouteStops);

    while (attempt <= LLMStrategyBrain.MAX_LLM_RETRIES) {
      let userPrompt = initialRouteUserPrompt;

      // JIRA-103: Prepend budget hint when provided (outer retry with cost guidance)
      if (budgetHint) {
        userPrompt = `${budgetHint}\n\n${userPrompt}`;
      }

      if (lastError) {
        userPrompt += `\n\nYOUR PREVIOUS ROUTE PLAN FAILED VALIDATION:\n${lastError}\nPlease provide a corrected route.`;
      }

      const startTime = Date.now();

      try {
        const useThinking = this.config.skillLevel !== BotSkillLevel.Easy;
        const response = await this.adapter.chat({
          model: this.model,
          maxTokens: ROUTE_MAX_TOKENS[this.config.skillLevel],
          temperature: TEMPERATURE_BY_SKILL[this.config.skillLevel],
          systemPrompt: routePrompt,
          userPrompt,
          timeoutMs: 60000,
          outputSchema: ROUTE_SCHEMA,
          ...(useThinking && {
            thinking: { type: 'adaptive' },
            effort: ROUTE_EFFORT[this.config.skillLevel],
          }),
        });
        const attemptLatency = Date.now() - startTime;
        totalLatencyMs += attemptLatency;
        totalInputTokens += response.usage?.input ?? 0;
        totalOutputTokens += response.usage?.output ?? 0;

        const route = ResponseParser.parseStrategicRoute(response.text, snapshot.turnNumber);

        // Basic validation: at least one stop
        if (route.stops.length === 0) {
          lastError = 'Route must contain at least one stop.';
          llmLog.push({
            attemptNumber: attempt + 1,
            status: 'validation_error',
            responseText: response.text.slice(0, 500),
            error: lastError,
            latencyMs: attemptLatency,
          });
          console.warn(`[LLMStrategyBrain] Empty route (attempt ${attempt + 1})`);
          attempt++;
          continue;
        }

        // Feasibility validation: check each stop against game state
        const validation = RouteValidator.validate(route, context, snapshot);

        if (!validation.valid) {
          lastError = `Route infeasible: ${validation.errors.join('; ')}`;
          llmLog.push({
            attemptNumber: attempt + 1,
            status: 'validation_error',
            responseText: response.text.slice(0, 500),
            error: lastError,
            latencyMs: attemptLatency,
          });
          console.warn(`[LLMStrategyBrain] Route rejected (attempt ${attempt + 1}): ${lastError}`);
          attempt++;
          continue;
        }

        // Use pruned route if some stops were removed, otherwise original
        const validatedRoute = validation.prunedRoute ?? route;

        // Post-LLM abandoned route check (BE-006): reject if the proposed
        // route's first stop matches the most recently abandoned route key.
        if (lastAbandonedRouteKey && validatedRoute.stops.length > 0) {
          const firstStop = validatedRoute.stops[0];
          const proposedKey = `${firstStop.loadType}:${firstStop.city}`;
          if (proposedKey === lastAbandonedRouteKey) {
            lastError = `Route rejected: first stop "${proposedKey}" matches recently abandoned route. Choose a different route.`;
            llmLog.push({
              attemptNumber: attempt + 1,
              status: 'validation_error',
              responseText: response.text.slice(0, 500),
              error: lastError,
              latencyMs: attemptLatency,
            });
            console.warn(`[LLMStrategyBrain] Abandoned route re-proposed (attempt ${attempt + 1}): ${proposedKey}`);
            attempt++;
            continue;
          }
        }

        llmLog.push({
          attemptNumber: attempt + 1,
          status: 'success',
          responseText: response.text.slice(0, 500),
          latencyMs: attemptLatency,
        });

        return {
          route: validatedRoute,
          model: this.model,
          latencyMs: totalLatencyMs,
          tokenUsage: { input: totalInputTokens, output: totalOutputTokens },
          llmLog,
          systemPrompt: routePrompt,
          userPrompt: initialRouteUserPrompt,
        };
      } catch (e: unknown) {
        const attemptLatency = Date.now() - startTime;
        totalLatencyMs += attemptLatency;
        if (e instanceof ProviderAuthError) {
          llmLog.push({
            attemptNumber: attempt + 1,
            status: 'api_error',
            responseText: '',
            error: `Auth error: ${e.message}`,
            latencyMs: attemptLatency,
          });
          console.error('[LLMStrategyBrain] Auth error during route planning — giving up');
          return { route: null, llmLog };
        }
        const isParse = e instanceof ParseError;
        lastError = isParse
          ? `Parsing error: ${e.message}`
          : `LLM call error: ${e instanceof Error ? e.message : String(e)}`;
        llmLog.push({
          attemptNumber: attempt + 1,
          status: isParse ? 'parse_error' : 'api_error',
          responseText: '',
          error: lastError,
          latencyMs: attemptLatency,
        });
        console.warn(`[LLMStrategyBrain] Route planning failed (attempt ${attempt + 1}): ${lastError}`);
      }
      attempt++;
    }

    console.warn('[LLMStrategyBrain] All route planning attempts failed.');
    return { route: null, llmLog };
  }

  // JIRA-126: reEvaluateRoute() removed — replaced by TripPlanner.planTrip()
  // JIRA-126: findSecondaryDelivery() removed — subsumed by TripPlanner

  /**
   * JIRA-92: Evaluate whether to drop a carried load to free cargo slots for a better route.
   *
   * Lightweight LLM call: no thinking, temperature=0, 1024 max tokens, 8s timeout.
   * Returns null on failure (graceful degradation — bot keeps all cargo).
   */
  async evaluateCargoConflict(
    userPrompt: string,
    snapshot: WorldSnapshot,
    context: GameContext,
  ): Promise<CargoConflictResult | null> {
    const systemPrompt = getCargoConflictPrompt();
    const MAX_RETRIES = 1;
    let lastError: string | undefined;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      const promptWithError = lastError
        ? `${userPrompt}\n\nYOUR PREVIOUS RESPONSE FAILED VALIDATION:\n${lastError}\nPlease provide a corrected response.`
        : userPrompt;

      try {
        const response = await this.adapter.chat({
          model: this.model,
          maxTokens: 1024,
          temperature: 0,
          systemPrompt,
          userPrompt: promptWithError,
          outputSchema: CARGO_CONFLICT_SCHEMA,
          timeoutMs: 8000,
        });

        const parsed = JSON.parse(response.text);
        const action = parsed.action;

        if (!['drop', 'keep'].includes(action)) {
          lastError = `Invalid action: ${action}. Must be "drop" or "keep".`;
          continue;
        }

        if (action === 'drop') {
          // Validate dropLoad is present
          if (!parsed.dropLoad) {
            console.warn('[LLMStrategyBrain] evaluateCargoConflict: drop without dropLoad, treating as keep');
            return { action: 'keep', reasoning: 'LLM said drop but did not specify which load' };
          }

          // Validate dropLoad matches a carried load
          if (!snapshot.bot.loads.includes(parsed.dropLoad)) {
            console.warn(`[LLMStrategyBrain] evaluateCargoConflict: dropLoad "${parsed.dropLoad}" not carried, treating as keep`);
            return { action: 'keep', reasoning: `LLM said drop "${parsed.dropLoad}" but bot is not carrying it` };
          }
        }

        return {
          action,
          dropLoad: parsed.dropLoad,
          reasoning: parsed.reasoning ?? '',
        };
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        console.warn(`[LLMStrategyBrain] evaluateCargoConflict attempt ${attempt + 1} failed: ${errMsg}`);
        lastError = errMsg;
      }
    }

    console.warn('[LLMStrategyBrain] evaluateCargoConflict: all attempts failed, returning null');
    return null;
  }

  /**
   * JIRA-105b: Evaluate whether to upgrade train instead of dropping a load at cargo conflict.
   *
   * Lightweight LLM call: no thinking, temperature=0, 1024 max tokens, 8s timeout.
   * Returns null on failure (graceful degradation — falls through to cargo conflict drop).
   */
  async evaluateUpgradeBeforeDrop(
    userPrompt: string,
    snapshot: WorldSnapshot,
    context: GameContext,
  ): Promise<UpgradeBeforeDropResult | null> {
    const systemPrompt = getUpgradeBeforeDropPrompt();
    const MAX_RETRIES = 1;
    let lastError: string | undefined;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      const promptWithError = lastError
        ? `${userPrompt}\n\nYOUR PREVIOUS RESPONSE FAILED VALIDATION:\n${lastError}\nPlease provide a corrected response.`
        : userPrompt;

      try {
        const response = await this.adapter.chat({
          model: this.model,
          maxTokens: 1024,
          temperature: 0,
          systemPrompt,
          userPrompt: promptWithError,
          outputSchema: UPGRADE_BEFORE_DROP_SCHEMA,
          timeoutMs: 8000,
        });

        const parsed = JSON.parse(response.text);
        const action = parsed.action;

        if (!['upgrade', 'skip'].includes(action)) {
          lastError = `Invalid action: ${action}. Must be "upgrade" or "skip".`;
          continue;
        }

        if (action === 'upgrade' && !parsed.targetTrain) {
          lastError = 'Action is "upgrade" but targetTrain is missing. You must specify targetTrain when action is "upgrade".';
          console.warn(`[LLMStrategyBrain] evaluateUpgradeBeforeDrop attempt ${attempt + 1}: upgrade without targetTrain, retrying`);
          continue;
        }

        return {
          action,
          targetTrain: parsed.targetTrain,
          reasoning: parsed.reasoning ?? '',
        };
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        console.warn(`[LLMStrategyBrain] evaluateUpgradeBeforeDrop attempt ${attempt + 1} failed: ${errMsg}`);
        lastError = errMsg;
      }
    }

    console.warn('[LLMStrategyBrain] evaluateUpgradeBeforeDrop: all attempts failed, returning null');
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
