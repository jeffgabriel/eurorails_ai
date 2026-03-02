import { ProviderResponse } from '../../../../shared/types/GameTypes';

/**
 * Configuration for Anthropic's adaptive thinking feature.
 * When enabled, the model performs extended reasoning before responding.
 *
 * @property type - Must be "adaptive" to enable extended reasoning.
 * @property effort - Controls reasoning depth: "low", "medium", or "high".
 *   Higher effort increases token usage but may improve decision quality.
 */
export interface ThinkingConfig {
  type: string;
  effort?: string;
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
   * @param request.outputSchema - (Anthropic only) JSON schema for structured output.
   *   Sent as output_config.format.json_schema. On 400 rejection, AnthropicAdapter
   *   retries without the schema. GoogleAdapter ignores this parameter.
   * @param request.thinking - (Anthropic only) Adaptive thinking configuration.
   *   Enables extended reasoning before the text response. GoogleAdapter ignores this.
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
    timeoutMs?: number;
  }): Promise<ProviderResponse>;
}
