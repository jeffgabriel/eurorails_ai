import { ProviderResponse } from '../../../../shared/types/GameTypes';
import { ProviderAdapter, ThinkingConfig } from './ProviderAdapter';
import { ProviderTimeoutError, ProviderAPIError, ProviderAuthError } from './errors';

/**
 * Extra token budget reserved for Gemini 3 reasoning tokens when thinking is active.
 * Thinking tokens are drawn from maxOutputTokens, so without this reserve the model
 * may exhaust the budget on internal reasoning before emitting the final response.
 */
const GEMINI3_THINKING_RESERVE: Record<string, number> = {
  low: 2048,
  medium: 4096,
  high: 8192,
};

export class GoogleAdapter implements ProviderAdapter {
  private readonly apiKey: string;
  private readonly timeoutMs: number;

  constructor(apiKey: string, timeoutMs: number = 15000) {
    this.apiKey = apiKey;
    this.timeoutMs = timeoutMs;
  }

  /**
   * Recursively strip `additionalProperties` from a JSON schema object.
   * Gemini's response_schema API doesn't support this field and returns 400.
   * Returns a deep clone — the original schema is not mutated.
   */
  static stripAdditionalProperties(schema: unknown): unknown {
    if (Array.isArray(schema)) {
      return schema.map(item => GoogleAdapter.stripAdditionalProperties(item));
    }
    if (schema !== null && typeof schema === 'object') {
      const result: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(schema as Record<string, unknown>)) {
        if (key === 'additionalProperties') continue;
        result[key] = GoogleAdapter.stripAdditionalProperties(value);
      }
      return result;
    }
    return schema;
  }

  private isGemini3Model(model: string): boolean {
    return model.startsWith('gemini-3');
  }

  private isGemini25Model(model: string): boolean {
    return model.startsWith('gemini-2.5');
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

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${request.model}:generateContent`;

    try {
      // For Gemini 3 + thinking, inflate maxOutputTokens by the reasoning-token reserve
      // so that internal thought tokens don't consume the caller's intended output budget.
      let maxOutputTokens = request.maxTokens;
      if (this.isGemini3Model(request.model) && request.thinking) {
        const effort = request.effort ?? 'medium';
        const reserve = GEMINI3_THINKING_RESERVE[effort] ?? GEMINI3_THINKING_RESERVE.medium;
        maxOutputTokens += reserve;
      }

      const generationConfig: Record<string, unknown> = {
        maxOutputTokens,
        temperature: request.temperature,
      };

      // Add structured output — skip only when thinkingConfig is active on Gemini 3 (incompatible)
      if (request.outputSchema && !(this.isGemini3Model(request.model) && request.thinking)) {
        generationConfig.responseMimeType = 'application/json';
        generationConfig.responseSchema = GoogleAdapter.stripAdditionalProperties(request.outputSchema);
      }

      const body: Record<string, unknown> = {
        system_instruction: {
          parts: [{ text: request.systemPrompt }],
        },
        contents: [
          {
            parts: [{ text: request.userPrompt }],
          },
        ],
        generationConfig,
      };

      // Add thinkingConfig inside generationConfig for models that support it
      if (request.thinking) {
        if (this.isGemini3Model(request.model)) {
          generationConfig.thinkingConfig = {
            thinkingLevel: request.effort ?? 'medium',
          };
        } else if (this.isGemini25Model(request.model)) {
          generationConfig.thinkingConfig = {
            thinkingBudget: -1,
          };
        }
      }

      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'x-goog-api-key': this.apiKey,
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
        const errorBody = await response.text();

        // On schema rejection (400) for non-Gemini-3 models, retry without structured output
        if (
          response.status === 400 &&
          request.outputSchema &&
          !this.isGemini3Model(request.model)
        ) {
          const isSchemaRejection = errorBody.includes('schema') ||
            errorBody.includes('responseSchema') ||
            errorBody.includes('invalid_argument') ||
            errorBody.includes('INVALID_ARGUMENT');
          if (isSchemaRejection) {
            console.warn(
              `[GoogleAdapter] Schema rejected (400), retrying without structured output: ${errorBody.substring(0, 200)}`,
            );
            return this.chat({ ...request, outputSchema: undefined });
          }
        }

        throw new ProviderAPIError(response.status, errorBody);
      }

      const data = await response.json();

      const candidate = data.candidates?.[0];
      if (!candidate?.content?.parts?.length) {
        const reason = candidate?.finishReason ?? 'UNKNOWN';
        throw new ProviderAPIError(
          200,
          `No content in response (finishReason: ${reason})`
        );
      }

      // For Gemini 3 models, filter out thought parts and concatenate remaining text
      let responseText: string;
      if (this.isGemini3Model(request.model)) {
        const textParts = candidate.content.parts
          .filter((part: { thought?: boolean }) => !part.thought)
          .map((part: { text?: string }) => part.text ?? '')
          .filter((text: string) => text.length > 0);

        if (textParts.length === 0) {
          throw new ProviderAPIError(
            200,
            'Gemini 3 response contained only thought parts, no actionable text'
          );
        }
        responseText = textParts.join('');
      } else {
        if (!candidate.content.parts[0]?.text) {
          const reason = candidate?.finishReason ?? 'UNKNOWN';
          throw new ProviderAPIError(
            200,
            `No content in response (finishReason: ${reason})`
          );
        }
        responseText = candidate.content.parts[0].text;
      }

      return {
        text: responseText,
        usage: {
          input: data.usageMetadata?.promptTokenCount ?? 0,
          output: data.usageMetadata?.candidatesTokenCount ?? 0,
        },
      };
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
}
