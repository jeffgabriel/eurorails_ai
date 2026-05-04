/**
 * ClaudeAgentSdkAdapter — routes Anthropic LLM calls through the local
 * Claude Max subscription via @anthropic-ai/claude-agent-sdk, instead of
 * api.anthropic.com with an API key.
 *
 * This adapter has NO credential constructor argument; the SDK reads
 * ~/.claude/.credentials.json itself. Do NOT pass a credential to this class.
 *
 * Activation: set ANTHROPIC_USE_CLAUDE_CODE=1 in your shell. Never set this
 * in CI or production — those environments use AnthropicAdapter with an API key.
 */

import { query, AbortError } from '@anthropic-ai/claude-agent-sdk';
import { ProviderResponse } from '../../../../shared/types/GameTypes';
import { ProviderAdapter, ThinkingConfig } from './ProviderAdapter';
import { ProviderTimeoutError, ProviderAPIError, ProviderAuthError } from './errors';
import { stripCodeFences } from './jsonExtraction';

/** Auth-class error codes emitted by the Agent SDK assistant message */
const AUTH_ERROR_CODES = new Set([
  'authentication_failed',
  'oauth_org_not_allowed',
  'billing_error',
]);

/** Emitted at most once per process when usage data is unavailable */
let usageWarnEmitted = false;

export class ClaudeAgentSdkAdapter implements ProviderAdapter {
  private readonly timeoutMs: number;

  /**
   * @param timeoutMs - Per-request timeout in ms. Default 30000 (30s).
   */
  constructor(timeoutMs: number = 30000) {
    this.timeoutMs = timeoutMs;
    console.log('[ClaudeAgentSdkAdapter] using Claude subscription credentials');
  }

  async chat(request: {
    model: string;
    maxTokens: number;
    temperature: number;
    systemPrompt: string;
    userPrompt: string;
    outputSchema?: object;
    thinking?: ThinkingConfig;
    effort?: string;
    timeoutMs?: number;
  }): Promise<ProviderResponse> {
    const effectiveTimeout = request.timeoutMs ?? this.timeoutMs;
    const abortController = new AbortController();
    const timer = setTimeout(() => abortController.abort(), effectiveTimeout);

    try {
      // Combine system and user prompts into a single string.
      // The Agent SDK takes a single prompt string; system content is prepended
      // with a clear separator so the model can distinguish intent.
      const combinedPrompt =
        `${request.systemPrompt}\n\n---\n\n${request.userPrompt}`;

      // Accumulate result from the async iterator
      let resultText: string | undefined;
      let resultUsage: { input: number; output: number } | undefined;

      const stream = query({
        prompt: combinedPrompt,
        options: {
          model: request.model,
          // Disable all tool use — this adapter is a pure completion oracle.
          tools: [],
          allowedTools: [],
          abortController,
        },
      });

      for await (const message of stream) {
        if (message.type === 'result') {
          if (message.subtype === 'success') {
            resultText = message.result;
            // Populate usage from the SDK's result block when available
            if (message.usage && message.usage.input_tokens != null && message.usage.output_tokens != null) {
              resultUsage = {
                input: message.usage.input_tokens,
                output: message.usage.output_tokens,
              };
            }
          } else {
            // subtype is an error variant
            const errMessages = (message as { errors?: string[] }).errors ?? [];
            throw new ProviderAPIError(
              500,
              `Claude Agent SDK execution error: ${errMessages.join(', ')}`,
            );
          }
        } else if (message.type === 'assistant' && (message as { error?: string }).error) {
          const errCode = (message as { error?: string }).error as string;
          if (AUTH_ERROR_CODES.has(errCode)) {
            throw new ProviderAuthError(
              `Claude subscription authentication failed (${errCode}). ` +
              'Ensure you are logged in via the claude CLI.',
            );
          }
          // Non-auth assistant errors are surfaced as API errors
          throw new ProviderAPIError(500, `Claude assistant error: ${errCode}`);
        }
      }

      if (resultText === undefined) {
        throw new ProviderAPIError(500, 'Claude Agent SDK returned no result block');
      }

      // Strip markdown code fences (the SDK does not support json_schema output config)
      const text = stripCodeFences(resultText);

      // Warn once per process if token usage is unavailable
      if (!resultUsage) {
        if (!usageWarnEmitted) {
          usageWarnEmitted = true;
          console.warn(
            '[ClaudeAgentSdkAdapter] Token usage unavailable in subscription mode — ' +
            'reporting {input:0, output:0}. Cost-tracking dashboards will show zero for ' +
            'subscription-mode calls.',
          );
        }
        resultUsage = { input: 0, output: 0 };
      }

      return { text, usage: resultUsage };
    } catch (error) {
      // Re-throw typed Provider errors unchanged
      if (
        error instanceof ProviderAuthError ||
        error instanceof ProviderAPIError ||
        error instanceof ProviderTimeoutError
      ) {
        throw error;
      }

      // AbortError from the SDK or from our AbortController signal
      if (error instanceof AbortError || (error instanceof Error && error.name === 'AbortError')) {
        throw new ProviderTimeoutError(effectiveTimeout);
      }

      // Any other SDK error → ProviderAPIError with sanitised message (never include credentials)
      const safeMessage = error instanceof Error ? error.message : String(error);
      throw new ProviderAPIError(500, `Claude Agent SDK unexpected error: ${safeMessage}`);
    } finally {
      clearTimeout(timer);
    }
  }
}
