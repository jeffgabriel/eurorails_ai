import { ProviderResponse } from '../../../../shared/types/GameTypes';

/**
 * Configuration for adaptive thinking / extended reasoning.
 * When enabled, the model performs extended reasoning before responding.
 *
 * @property type - Must be "adaptive" to enable extended reasoning.
 */
export interface ThinkingConfig {
  type: string;
}

/**
 * Abstraction over LLM provider APIs (Anthropic, Google).
 *
 * Implementations: AnthropicAdapter, GoogleAdapter.
 * Created per-game by LLMStrategyBrain via LLMStrategyBrain.createAdapter().
 */
export interface ProviderAdapter {
  /**
   * Send a chat request to the LLM provider and return the response.
   *
   * @param request.model - Model identifier (e.g., "claude-sonnet-4-20250514").
   * @param request.maxTokens - Maximum tokens in the response.
   * @param request.temperature - Sampling temperature (0 = deterministic, 1 = creative).
   * @param request.systemPrompt - System-level instructions for the model.
   * @param request.userPrompt - The user/game-state prompt.
   * @param request.outputSchema - JSON schema for structured output. Each adapter
   *   handles this per its API: Anthropic uses output_config.format.json_schema,
   *   Google uses generationConfig.responseSchema (skipped for Gemini 3 models).
   *   Both adapters retry without schema on 400 rejection.
   * @param request.thinking - Adaptive thinking configuration.
   *   Enables extended reasoning before the text response.
   * @param request.effort - Thinking effort level: "low", "medium", or "high".
   *   Anthropic sends inside output_config.effort; Google maps to thinkingLevel
   *   (Gemini 3) or thinkingBudget (Gemini 2.5).
   * @param request.timeoutMs - Per-request timeout override. Falls back to the
   *   adapter's constructor default if not provided.
   * @returns Text response and token usage counts.
   */
  chat(request: {
    model: string;
    maxTokens: number;
    temperature: number;
    systemPrompt: string;
    userPrompt: string;
    outputSchema?: object;
    thinking?: ThinkingConfig;
    effort?: string;
    timeoutMs?: number;
  }): Promise<ProviderResponse>;
}
