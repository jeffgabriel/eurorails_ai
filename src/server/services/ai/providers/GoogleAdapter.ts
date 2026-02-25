import { ProviderResponse } from '../../../../shared/types/GameTypes';
import { ProviderAdapter } from './ProviderAdapter';
import { ProviderTimeoutError, ProviderAPIError, ProviderAuthError } from './errors';

export class GoogleAdapter implements ProviderAdapter {
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
  }): Promise<ProviderResponse> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${request.model}:generateContent`;

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'x-goog-api-key': this.apiKey,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          system_instruction: {
            parts: [{ text: request.systemPrompt }],
          },
          contents: [
            {
              parts: [{ text: request.userPrompt }],
            },
          ],
          generationConfig: {
            maxOutputTokens: request.maxTokens,
            temperature: request.temperature,
          },
        }),
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

      const candidate = data.candidates?.[0];
      if (!candidate?.content?.parts?.[0]?.text) {
        const reason = candidate?.finishReason ?? 'UNKNOWN';
        throw new ProviderAPIError(
          200,
          `No content in response (finishReason: ${reason})`
        );
      }

      return {
        text: candidate.content.parts[0].text,
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
        throw new ProviderTimeoutError(this.timeoutMs);
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
}
