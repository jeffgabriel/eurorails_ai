import { ProviderResponse } from '../../../../shared/types/GameTypes';
import { ProviderAdapter, ThinkingConfig } from './ProviderAdapter';
import { ProviderTimeoutError, ProviderAPIError, ProviderAuthError } from './errors';

export class AnthropicAdapter implements ProviderAdapter {
  private readonly apiKey: string;
  private readonly timeoutMs: number;

  constructor(apiKey: string, timeoutMs: number = 15000) {
    this.apiKey = apiKey;
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
  }): Promise<ProviderResponse> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      // Build the base request body
      const body: Record<string, unknown> = {
        model: request.model,
        max_tokens: request.maxTokens,
        temperature: request.temperature,
        system: [{
          type: 'text',
          text: request.systemPrompt,
          cache_control: { type: 'ephemeral' },
        }],
        messages: [{ role: 'user', content: request.userPrompt }],
      };

      // Conditionally add structured output config
      if (request.outputSchema) {
        body.output_config = {
          format: {
            type: 'json_schema',
            schema: request.outputSchema,
          },
        };
      }

      // Conditionally add thinking config
      if (request.thinking) {
        body.thinking = request.thinking;
      }

      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'x-api-key': this.apiKey,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (response.status === 401 || response.status === 403) {
        const body = await response.text();
        throw new ProviderAuthError(body);
      }

      if (!response.ok) {
        const body = await response.text();
        throw new ProviderAPIError(response.status, body);
      }

      const data = await response.json();

      // Extract text from multi-block response, skipping thinking blocks
      const textBlock = Array.isArray(data.content)
        ? data.content.find((block: { type: string }) => block.type === 'text')
        : undefined;
      const text = textBlock?.text ?? '';

      return {
        text,
        usage: {
          input: data.usage.input_tokens,
          output: data.usage.output_tokens,
        },
      };
    } catch (error) {
      if (error instanceof ProviderAuthError || error instanceof ProviderAPIError) {
        throw error;
      }
      if (error instanceof DOMException && error.name === 'AbortError') {
        throw new ProviderTimeoutError(this.timeoutMs);
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
}
