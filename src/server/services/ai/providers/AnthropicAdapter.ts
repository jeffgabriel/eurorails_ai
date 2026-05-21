import { ProviderResponse } from '../../../../shared/types/GameTypes';
import { ProviderAdapter, ThinkingConfig } from './ProviderAdapter';
import { ProviderTimeoutError, ProviderAPIError, ProviderAuthError } from './errors';
import { stripCodeFences } from './jsonExtraction';

export class AnthropicAdapter implements ProviderAdapter {
  private readonly credential: string;
  private readonly timeoutMs: number;

  constructor(credential: string, timeoutMs: number = 15000) {
    this.credential = credential;
    this.timeoutMs = timeoutMs;
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
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), effectiveTimeout);

    try {
      const isHaiku = request.model.startsWith('claude-haiku-');

      // When adaptive thinking is enabled, Anthropic requires temperature=1
      // (Haiku does not support thinking, so skip the override for Haiku)
      const effectiveTemperature = !isHaiku && request.thinking ? 1 : request.temperature;

      // Build the base request body
      const body: Record<string, unknown> = {
        model: request.model,
        max_tokens: request.maxTokens,
        temperature: effectiveTemperature,
        system: [{
          type: 'text',
          text: request.systemPrompt,
          cache_control: { type: 'ephemeral' },
        }],
        messages: [{ role: 'user', content: request.userPrompt }],
      };

      // Haiku models do not support output_config or thinking — omit both
      if (!isHaiku) {
        // Build output_config from schema and/or effort
        const outputConfig: Record<string, unknown> = {};
        if (request.outputSchema) {
          outputConfig.format = {
            type: 'json_schema',
            schema: request.outputSchema,
          };
        }
        if (request.effort) {
          outputConfig.effort = request.effort;
        }
        if (Object.keys(outputConfig).length > 0) {
          body.output_config = outputConfig;
        }

        // Conditionally add thinking config
        if (request.thinking) {
          body.thinking = request.thinking;
        }
      }

      const result = await this.executeRequest(body, controller.signal, isHaiku);

      // On schema rejection (400), retry without the json_schema format
      if (result.error && result.error.status === 400 && request.outputSchema) {
        const errorText = result.error.body;
        if (errorText.includes('schema') || errorText.includes('output_config') || errorText.includes('json_schema')) {
          console.warn(
            `[AnthropicAdapter] Schema rejected (400), retrying without json_schema format: ${errorText.substring(0, 200)}`,
          );
          // Remove only the schema format; preserve effort if present
          const oc = body.output_config as Record<string, unknown> | undefined;
          if (oc) {
            delete oc.format;
            if (Object.keys(oc).length === 0) {
              delete body.output_config;
            }
          }
          const retryResult = await this.executeRequest(body, controller.signal, isHaiku);
          if (retryResult.error) {
            this.throwApiError(retryResult.error.status, retryResult.error.body);
          }
          return retryResult.response!;
        }
      }

      if (result.error) {
        this.throwApiError(result.error.status, result.error.body);
      }

      return result.response!;
    } catch (error) {
      if (error instanceof ProviderAuthError || error instanceof ProviderAPIError) {
        throw error;
      }
      if (error instanceof DOMException && error.name === 'AbortError') {
        throw new ProviderTimeoutError(effectiveTimeout);
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Strip markdown code fences from a string.
   * Delegates to the shared jsonExtraction helper.
   */
  static stripCodeFences(text: string): string {
    return stripCodeFences(text);
  }

  private async executeRequest(
    body: Record<string, unknown>,
    signal: AbortSignal,
    isHaiku: boolean = false,
  ): Promise<{ response?: ProviderResponse; error?: { status: number; body: string } }> {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': this.credential,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
      signal,
    });

    if (response.status === 401 || response.status === 403) {
      const text = await response.text();
      throw new ProviderAuthError(text);
    }

    if (!response.ok) {
      const text = await response.text();
      return { error: { status: response.status, body: text } };
    }

    const data = await response.json();

    // Extract text from multi-block response, skipping thinking blocks
    const textBlock = Array.isArray(data.content)
      ? data.content.find((block: { type: string }) => block.type === 'text')
      : undefined;
    let text = textBlock?.text ?? '';

    // Haiku models wrap JSON in markdown code fences — strip them at the adapter
    // boundary so all downstream callers receive raw JSON on the first attempt.
    if (isHaiku) {
      text = AnthropicAdapter.stripCodeFences(text);
    }

    return {
      response: {
        text,
        usage: {
          input: data.usage.input_tokens,
          output: data.usage.output_tokens,
        },
      },
    };
  }

  private throwApiError(status: number, body: string): never {
    throw new ProviderAPIError(status, body);
  }
}
