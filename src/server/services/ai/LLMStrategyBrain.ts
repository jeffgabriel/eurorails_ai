/**
 * LLMStrategyBrain — Replaces Scorer.score() for Phase 1+2 decisions.
 *
 * Single LLM API call selects both movement and build options. Pipeline:
 *   GameStateSerializer.serialize() → ProviderAdapter.chat() →
 *   ResponseParser.parse() → GuardrailEnforcer.check()
 *
 * Retry chain: full prompt → minimal prompt → heuristic fallback.
 * Created per-turn in AIStrategyEngine (not singleton).
 */

import {
  WorldSnapshot,
  FeasibleOption,
  BotSkillLevel,
  BotArchetype,
  LLMProvider,
  LLM_DEFAULT_MODELS,
  LLMStrategyConfig,
  LLMSelectionResult,
  BotMemoryState,
} from '../../../shared/types/GameTypes';
import { GameStateSerializer } from './GameStateSerializer';
import { ResponseParser, ParseError } from './ResponseParser';
import { GuardrailEnforcer } from './GuardrailEnforcer';
import { getSystemPrompt } from './prompts/systemPrompts';
import { AnthropicAdapter } from './providers/AnthropicAdapter';
import { GoogleAdapter } from './providers/GoogleAdapter';
import { ProviderAdapter } from './providers/ProviderAdapter';
import {
  ProviderTimeoutError,
  ProviderAPIError,
  ProviderAuthError,
} from './providers/errors';

/** Max tokens for LLM response — JSON with reasoning is ~100-150 tokens */
const MAX_TOKENS_BY_SKILL: Record<BotSkillLevel, number> = {
  [BotSkillLevel.Easy]: 200,
  [BotSkillLevel.Medium]: 300,
  [BotSkillLevel.Hard]: 400,
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

    // Build system prompt from archetype + skill level
    this.systemPrompt = getSystemPrompt(config.archetype, config.skillLevel);

    // Create provider adapter
    this.adapter = LLMStrategyBrain.createAdapter(config.provider, config.apiKey, config.timeoutMs);
  }

  /**
   * Select movement and build options via LLM.
   *
   * Pipeline: serialize → API call → parse → guardrail check.
   * Falls back to minimal prompt retry, then heuristic fallback.
   */
  async selectOptions(
    snapshot: WorldSnapshot,
    moveOptions: FeasibleOption[],
    buildOptions: FeasibleOption[],
    memory: BotMemoryState,
  ): Promise<LLMSelectionResult> {
    const feasibleMoves = moveOptions.filter((o) => o.feasible);
    const feasibleBuilds = buildOptions.filter((o) => o.feasible);

    // Full prompt attempt
    const startMs = Date.now();
    try {
      const userPrompt = GameStateSerializer.serialize(
        snapshot, feasibleMoves, feasibleBuilds, memory, this.config.skillLevel,
      );

      const response = await this.adapter.chat({
        model: this.model,
        maxTokens: MAX_TOKENS_BY_SKILL[this.config.skillLevel],
        temperature: TEMPERATURE_BY_SKILL[this.config.skillLevel],
        systemPrompt: this.systemPrompt,
        userPrompt,
      });

      const parsed = ResponseParser.parse(
        response.text, feasibleMoves.length, feasibleBuilds.length,
      );

      const selectedMove = parsed.moveOptionIndex >= 0 ? feasibleMoves[parsed.moveOptionIndex] : undefined;
      const selectedBuild = feasibleBuilds[parsed.buildOptionIndex];

      const guardrail = GuardrailEnforcer.check(
        selectedMove, selectedBuild, feasibleMoves, feasibleBuilds, snapshot,
      );

      const finalMoveIndex = guardrail.moveOverridden ? (guardrail.correctedMoveIndex ?? -1) : parsed.moveOptionIndex;
      const finalBuildIndex = guardrail.buildOverridden ? (guardrail.correctedBuildIndex ?? parsed.buildOptionIndex) : parsed.buildOptionIndex;

      return {
        moveOptionIndex: finalMoveIndex,
        buildOptionIndex: finalBuildIndex,
        reasoning: parsed.reasoning,
        planHorizon: parsed.planHorizon,
        model: this.model,
        latencyMs: Date.now() - startMs,
        tokenUsage: response.usage,
        wasGuardrailOverride: guardrail.moveOverridden || guardrail.buildOverridden,
        guardrailReason: guardrail.reason,
      };
    } catch (firstError) {
      console.warn(
        `[LLMStrategyBrain] Full prompt failed (${Date.now() - startMs}ms):`,
        firstError instanceof Error ? firstError.message : firstError,
      );

      // Auth errors — don't retry, fall through to heuristic immediately
      if (firstError instanceof ProviderAuthError) {
        console.error('[LLMStrategyBrain] Auth error — using heuristic fallback');
        return this.heuristicFallback(feasibleMoves, feasibleBuilds, startMs, 'Auth error');
      }

      // Retry with minimal prompt
      if (this.config.maxRetries > 0) {
        try {
          return await this.retryWithMinimalPrompt(
            snapshot, feasibleMoves, feasibleBuilds, startMs,
          );
        } catch (retryError) {
          console.warn(
            '[LLMStrategyBrain] Retry failed:',
            retryError instanceof Error ? retryError.message : retryError,
          );
        }
      }

      // Heuristic fallback
      return this.heuristicFallback(
        feasibleMoves, feasibleBuilds, startMs,
        firstError instanceof Error ? firstError.message : 'Unknown error',
      );
    }
  }

  /**
   * Retry with a minimal prompt (fewer options, no opponents, no memory).
   */
  private async retryWithMinimalPrompt(
    snapshot: WorldSnapshot,
    feasibleMoves: FeasibleOption[],
    feasibleBuilds: FeasibleOption[],
    startMs: number,
  ): Promise<LLMSelectionResult> {
    const minimalPrompt = GameStateSerializer.serializeMinimal(
      snapshot, feasibleMoves, feasibleBuilds,
    );

    const response = await this.adapter.chat({
      model: this.model,
      maxTokens: 200,
      temperature: 0.3,
      systemPrompt: this.systemPrompt,
      userPrompt: minimalPrompt,
    });

    // For minimal prompt, cap option counts at 4 (what serializeMinimal shows)
    const moveCount = Math.min(feasibleMoves.length, 4);
    const buildCount = Math.min(feasibleBuilds.length, 4);

    const parsed = ResponseParser.parse(response.text, moveCount, buildCount);

    const selectedMove = parsed.moveOptionIndex >= 0 ? feasibleMoves[parsed.moveOptionIndex] : undefined;
    const selectedBuild = feasibleBuilds[parsed.buildOptionIndex];

    const guardrail = GuardrailEnforcer.check(
      selectedMove, selectedBuild, feasibleMoves, feasibleBuilds, snapshot,
    );

    const finalMoveIndex = guardrail.moveOverridden ? (guardrail.correctedMoveIndex ?? -1) : parsed.moveOptionIndex;
    const finalBuildIndex = guardrail.buildOverridden ? (guardrail.correctedBuildIndex ?? parsed.buildOptionIndex) : parsed.buildOptionIndex;

    return {
      moveOptionIndex: finalMoveIndex,
      buildOptionIndex: finalBuildIndex,
      reasoning: `[retry] ${parsed.reasoning}`,
      planHorizon: parsed.planHorizon,
      model: this.model,
      latencyMs: Date.now() - startMs,
      tokenUsage: response.usage,
      wasGuardrailOverride: guardrail.moveOverridden || guardrail.buildOverridden,
      guardrailReason: guardrail.reason,
    };
  }

  /**
   * Heuristic fallback: pick the highest-payment feasible move
   * and highest-chainScore feasible build. Always produces valid indices.
   */
  private heuristicFallback(
    feasibleMoves: FeasibleOption[],
    feasibleBuilds: FeasibleOption[],
    startMs: number,
    reason: string,
  ): LLMSelectionResult {
    // Best move: prefer delivery moves (highest payment), else first feasible
    let bestMoveIndex = -1;
    let bestMovePayment = -1;
    for (let i = 0; i < feasibleMoves.length; i++) {
      const payment = feasibleMoves[i].payment ?? 0;
      if (payment > bestMovePayment) {
        bestMovePayment = payment;
        bestMoveIndex = i;
      }
    }
    // If no move has payment, pick first feasible move
    if (bestMoveIndex === -1 && feasibleMoves.length > 0) {
      bestMoveIndex = 0;
    }

    // Best build: prefer highest chainScore, else first non-PassTurn
    let bestBuildIndex = 0;
    let bestChainScore = -Infinity;
    for (let i = 0; i < feasibleBuilds.length; i++) {
      const cs = feasibleBuilds[i].chainScore ?? 0;
      if (cs > bestChainScore) {
        bestChainScore = cs;
        bestBuildIndex = i;
      }
    }

    console.log(
      `[LLMStrategyBrain] Heuristic fallback: move=${bestMoveIndex}, build=${bestBuildIndex}, reason=${reason}`,
    );

    return {
      moveOptionIndex: bestMoveIndex,
      buildOptionIndex: bestBuildIndex,
      reasoning: `[heuristic fallback] ${reason}`,
      planHorizon: '',
      model: this.model,
      latencyMs: Date.now() - startMs,
      tokenUsage: { input: 0, output: 0 },
      wasGuardrailOverride: false,
      guardrailReason: undefined,
    };
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
