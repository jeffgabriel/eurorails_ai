import { ProviderResponse } from '../../../../shared/types/GameTypes';
import { ProviderAdapter, ThinkingConfig } from './ProviderAdapter';
import { ProviderTimeoutError, ProviderAPIError, ProviderAuthError } from './errors';

export class OpenAIAdapter implements ProviderAdapter {
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
    effort?: string;
    timeoutMs?: number;
  }): Promise<ProviderResponse> {
    const effectiveTimeout = request.timeoutMs ?? this.timeoutMs;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), effectiveTimeout);

    try {
      const body = this.buildRequestBody(request);

      const result = await this.executeRequest(body, controller.signal);

      // On schema rejection (400), retry without response_format
      if (result.error && result.error.status === 400 && request.outputSchema) {
        const errorText = result.error.body;
        if (errorText.includes('response_format') || errorText.includes('json_schema') || errorText.includes('schema')) {
          console.warn(
            `[OpenAIAdapter] Schema rejected (400), retrying without response_format: ${errorText.substring(0, 200)}`,
          );
          delete body.response_format;
          const retryResult = await this.executeRequest(body, controller.signal);
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

  private buildRequestBody(request: {
    model: string;
    maxTokens: number;
    temperature: number;
    systemPrompt: string;
    userPrompt: string;
    outputSchema?: object;
    thinking?: ThinkingConfig;
    effort?: string;
  }): Record<string, unknown> {
    const body: Record<string, unknown> = {
      model: request.model,
      max_completion_tokens: request.maxTokens,
      temperature: request.temperature,
      messages: [
        { role: 'system', content: request.systemPrompt },
        { role: 'user', content: request.userPrompt },
      ],
    };

    if (request.outputSchema) {
      body.response_format = {
        type: 'json_schema',
        json_schema: {
          name: 'game_action',
          schema: request.outputSchema,
          strict: true,
        },
      };
    }

    // Map effort to OpenAI's reasoning parameter; ignore thinking (no OpenAI equivalent)
    if (request.effort) {
      body.reasoning = { effort: request.effort };
    }

    return body;
  }

  private async executeRequest(
    body: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<{ response?: ProviderResponse; error?: { status: number; body: string } }> {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
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

    // Check for refusal
    const message = data.choices?.[0]?.message;
    if (message?.refusal) {
      return { error: { status: 400, body: `Model refused: ${message.refusal}` } };
    }

    const text = message?.content ?? '';

    return {
      response: {
        text,
        usage: {
          input: data.usage.prompt_tokens,
          output: data.usage.completion_tokens,
        },
      },
    };
  }

  private throwApiError(status: number, body: string): never {
    throw new ProviderAPIError(status, body);
  }
}
