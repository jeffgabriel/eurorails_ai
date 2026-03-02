import { GoogleAdapter } from '../../services/ai/providers/GoogleAdapter';
import { ProviderAPIError, ProviderAuthError, ProviderTimeoutError } from '../../services/ai/providers/errors';

// Mock global fetch
const mockFetch = jest.fn();
global.fetch = mockFetch;

function makeRequest() {
  return {
    model: 'gemini-2.5-pro',
    maxTokens: 300,
    temperature: 0.4,
    systemPrompt: 'You are a game bot.',
    userPrompt: 'What should I do?',
  };
}

function makeSuccessResponse(text: string = '{"action":"BuildTrack"}') {
  return {
    ok: true,
    status: 200,
    json: jest.fn().mockResolvedValue({
      candidates: [
        {
          content: { parts: [{ text }] },
          finishReason: 'STOP',
        },
      ],
      usageMetadata: {
        promptTokenCount: 100,
        candidatesTokenCount: 50,
      },
    }),
    text: jest.fn(),
  };
}

describe('GoogleAdapter', () => {
  let adapter: GoogleAdapter;

  beforeEach(() => {
    jest.clearAllMocks();
    adapter = new GoogleAdapter('test-api-key', 5000);
  });

  describe('isGemini3Model', () => {
    it('should return true for gemini-3-flash-preview', () => {
      expect((adapter as any).isGemini3Model('gemini-3-flash-preview')).toBe(true);
    });

    it('should return true for gemini-3-pro-preview', () => {
      expect((adapter as any).isGemini3Model('gemini-3-pro-preview')).toBe(true);
    });

    it('should return true for gemini-3.1-pro-preview', () => {
      expect((adapter as any).isGemini3Model('gemini-3.1-pro-preview')).toBe(true);
    });

    it('should return false for gemini-2.5-pro', () => {
      expect((adapter as any).isGemini3Model('gemini-2.5-pro')).toBe(false);
    });

    it('should return false for gemini-2.0-flash', () => {
      expect((adapter as any).isGemini3Model('gemini-2.0-flash')).toBe(false);
    });

    it('should return false for non-Gemini models', () => {
      expect((adapter as any).isGemini3Model('claude-3-opus-20240229')).toBe(false);
    });
  });

  describe('successful response parsing', () => {
    it('should parse a valid Gemini response', async () => {
      mockFetch.mockResolvedValue(makeSuccessResponse('{"action":"BuildTrack"}'));

      const result = await adapter.chat(makeRequest());

      expect(result.text).toBe('{"action":"BuildTrack"}');
      expect(result.usage.input).toBe(100);
      expect(result.usage.output).toBe(50);
    });

    it('should call the correct Gemini API URL with model', async () => {
      mockFetch.mockResolvedValue(makeSuccessResponse());

      await adapter.chat(makeRequest());

      expect(mockFetch).toHaveBeenCalledWith(
        'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:generateContent',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            'x-goog-api-key': 'test-api-key',
            'content-type': 'application/json',
          }),
        }),
      );
    });

    it('should pass system prompt and user prompt in the request body', async () => {
      mockFetch.mockResolvedValue(makeSuccessResponse());

      await adapter.chat(makeRequest());

      const callBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(callBody.system_instruction.parts[0].text).toBe('You are a game bot.');
      expect(callBody.contents[0].parts[0].text).toBe('What should I do?');
      expect(callBody.generationConfig.maxOutputTokens).toBe(300);
      expect(callBody.generationConfig.temperature).toBe(0.4);
    });
  });

  describe('safety-blocked response', () => {
    it('should throw ProviderAPIError when response has no content (safety block)', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
        json: jest.fn().mockResolvedValue({
          candidates: [
            {
              finishReason: 'SAFETY',
            },
          ],
          usageMetadata: {
            promptTokenCount: 100,
          },
        }),
        text: jest.fn(),
      });

      await expect(adapter.chat(makeRequest())).rejects.toThrow(ProviderAPIError);
      await expect(adapter.chat(makeRequest())).rejects.toThrow('finishReason: SAFETY');
    });

    it('should throw ProviderAPIError when candidates array is empty', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
        json: jest.fn().mockResolvedValue({
          candidates: [],
          usageMetadata: { promptTokenCount: 100 },
        }),
        text: jest.fn(),
      });

      await expect(adapter.chat(makeRequest())).rejects.toThrow(ProviderAPIError);
    });
  });

  describe('missing usage metadata', () => {
    it('should default token counts to 0 when usageMetadata is missing', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
        json: jest.fn().mockResolvedValue({
          candidates: [
            {
              content: { parts: [{ text: 'response' }] },
              finishReason: 'STOP',
            },
          ],
        }),
        text: jest.fn(),
      });

      const result = await adapter.chat(makeRequest());

      expect(result.usage.input).toBe(0);
      expect(result.usage.output).toBe(0);
    });

    it('should default candidatesTokenCount to 0 when missing', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
        json: jest.fn().mockResolvedValue({
          candidates: [
            {
              content: { parts: [{ text: 'response' }] },
              finishReason: 'STOP',
            },
          ],
          usageMetadata: {
            promptTokenCount: 100,
          },
        }),
        text: jest.fn(),
      });

      const result = await adapter.chat(makeRequest());

      expect(result.usage.input).toBe(100);
      expect(result.usage.output).toBe(0);
    });
  });

  describe('thinkingConfig', () => {
    it('should include thinkingLevel for Gemini 3 models when thinking is enabled', async () => {
      mockFetch.mockResolvedValue(makeSuccessResponse());

      await adapter.chat({
        ...makeRequest(),
        model: 'gemini-3-pro-preview',
        thinking: { type: 'adaptive' },
        effort: 'high',
      });

      const callBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(callBody.thinkingConfig).toEqual({ thinkingLevel: 'high' });
    });

    it('should default thinkingLevel to medium when effort is not provided for Gemini 3', async () => {
      mockFetch.mockResolvedValue(makeSuccessResponse());

      await adapter.chat({
        ...makeRequest(),
        model: 'gemini-3-flash-preview',
        thinking: { type: 'adaptive' },
      });

      const callBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(callBody.thinkingConfig).toEqual({ thinkingLevel: 'medium' });
    });

    it('should include thinkingBudget: -1 for Gemini 2.5 models when thinking is enabled', async () => {
      mockFetch.mockResolvedValue(makeSuccessResponse());

      await adapter.chat({
        ...makeRequest(),
        model: 'gemini-2.5-pro',
        thinking: { type: 'adaptive' },
      });

      const callBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(callBody.thinkingConfig).toEqual({ thinkingBudget: -1 });
    });

    it('should not include thinkingConfig when thinking is not enabled', async () => {
      mockFetch.mockResolvedValue(makeSuccessResponse());

      await adapter.chat({
        ...makeRequest(),
        model: 'gemini-3-pro-preview',
      });

      const callBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(callBody.thinkingConfig).toBeUndefined();
    });

    it('should not include thinkingConfig for non-thinking models', async () => {
      mockFetch.mockResolvedValue(makeSuccessResponse());

      await adapter.chat({
        ...makeRequest(),
        model: 'gemini-2.0-flash',
        thinking: { type: 'adaptive' },
      });

      const callBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(callBody.thinkingConfig).toBeUndefined();
    });
  });

  describe('structured output', () => {
    const testSchema = { type: 'object', properties: { action: { type: 'string' } } };

    it('should include responseMimeType and responseSchema for Gemini 2.5 models', async () => {
      mockFetch.mockResolvedValue(makeSuccessResponse());

      await adapter.chat({
        ...makeRequest(),
        model: 'gemini-2.5-pro',
        outputSchema: testSchema,
      });

      const callBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(callBody.generationConfig.responseMimeType).toBe('application/json');
      expect(callBody.generationConfig.responseSchema).toEqual(testSchema);
    });

    it('should NOT include responseMimeType and responseSchema for Gemini 3 models', async () => {
      mockFetch.mockResolvedValue(makeSuccessResponse());

      await adapter.chat({
        ...makeRequest(),
        model: 'gemini-3-pro-preview',
        outputSchema: testSchema,
      });

      const callBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(callBody.generationConfig.responseMimeType).toBeUndefined();
      expect(callBody.generationConfig.responseSchema).toBeUndefined();
    });

    it('should not include structured output when outputSchema is not provided', async () => {
      mockFetch.mockResolvedValue(makeSuccessResponse());

      await adapter.chat(makeRequest());

      const callBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(callBody.generationConfig.responseMimeType).toBeUndefined();
      expect(callBody.generationConfig.responseSchema).toBeUndefined();
    });
  });

  describe('Gemini 3 thought part filtering', () => {
    it('should filter out thought parts and return only text parts', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
        json: jest.fn().mockResolvedValue({
          candidates: [{
            content: {
              parts: [
                { text: 'Let me think...', thought: true },
                { text: '{"action":"BuildTrack"}' },
              ],
            },
            finishReason: 'STOP',
          }],
          usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 50 },
        }),
        text: jest.fn(),
      });

      const result = await adapter.chat({
        ...makeRequest(),
        model: 'gemini-3-pro-preview',
      });

      expect(result.text).toBe('{"action":"BuildTrack"}');
    });

    it('should concatenate multiple non-thought text parts', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
        json: jest.fn().mockResolvedValue({
          candidates: [{
            content: {
              parts: [
                { text: 'thinking...', thought: true },
                { text: '{"action":' },
                { text: '"MoveTrain"}' },
              ],
            },
            finishReason: 'STOP',
          }],
          usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 50 },
        }),
        text: jest.fn(),
      });

      const result = await adapter.chat({
        ...makeRequest(),
        model: 'gemini-3-pro-preview',
      });

      expect(result.text).toBe('{"action":"MoveTrain"}');
    });

    it('should throw ProviderAPIError when response has only thought parts', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
        json: jest.fn().mockResolvedValue({
          candidates: [{
            content: {
              parts: [
                { text: 'Let me think about this...', thought: true },
                { text: 'More thinking...', thought: true },
              ],
            },
            finishReason: 'STOP',
          }],
          usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 50 },
        }),
        text: jest.fn(),
      });

      await expect(adapter.chat({
        ...makeRequest(),
        model: 'gemini-3-pro-preview',
      })).rejects.toThrow(ProviderAPIError);
      await expect(adapter.chat({
        ...makeRequest(),
        model: 'gemini-3-pro-preview',
      })).rejects.toThrow('only thought parts');
    });

    it('should use standard parsing for non-Gemini-3 models', async () => {
      mockFetch.mockResolvedValue(makeSuccessResponse('{"action":"BuildTrack"}'));

      const result = await adapter.chat({
        ...makeRequest(),
        model: 'gemini-2.5-pro',
      });

      expect(result.text).toBe('{"action":"BuildTrack"}');
    });
  });

  describe('error handling', () => {
    it('should throw ProviderAuthError on 401', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 401,
        text: jest.fn().mockResolvedValue('Unauthorized'),
      });

      await expect(adapter.chat(makeRequest())).rejects.toThrow(ProviderAuthError);
    });

    it('should throw ProviderAuthError on 403', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 403,
        text: jest.fn().mockResolvedValue('Forbidden'),
      });

      await expect(adapter.chat(makeRequest())).rejects.toThrow(ProviderAuthError);
    });

    it('should throw ProviderAPIError on non-ok response', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 500,
        text: jest.fn().mockResolvedValue('Internal Server Error'),
      });

      await expect(adapter.chat(makeRequest())).rejects.toThrow(ProviderAPIError);
    });

    it('should throw ProviderTimeoutError on abort', async () => {
      mockFetch.mockImplementation(() => {
        const error = new DOMException('The operation was aborted', 'AbortError');
        return Promise.reject(error);
      });

      await expect(adapter.chat(makeRequest())).rejects.toThrow(ProviderTimeoutError);
    });
  });
});
