import { OpenAIAdapter } from '../../services/ai/providers/OpenAIAdapter';
import { ProviderAuthError, ProviderAPIError, ProviderTimeoutError } from '../../services/ai/providers/errors';

// Mock global fetch
const mockFetch = jest.fn();
global.fetch = mockFetch;

function makeRequest() {
  return {
    model: 'gpt-5.4-mini',
    maxTokens: 200,
    temperature: 0.7,
    systemPrompt: 'You are a helpful assistant.',
    userPrompt: 'What is the weather?',
  };
}

function makeSuccessResponse(text = 'Hello', promptTokens = 100, completionTokens = 50) {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      choices: [{ message: { content: text, refusal: null } }],
      usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens },
    }),
    text: async () => '',
  };
}

describe('OpenAIAdapter', () => {
  let adapter: OpenAIAdapter;

  beforeEach(() => {
    jest.clearAllMocks();
    adapter = new OpenAIAdapter('test-api-key', 5000);
  });

  describe('API request format', () => {
    it('should call OpenAI API with correct URL', async () => {
      mockFetch.mockResolvedValue(makeSuccessResponse());

      await adapter.chat(makeRequest());

      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.openai.com/v1/chat/completions',
        expect.any(Object),
      );
    });

    it('should include correct headers with Bearer auth', async () => {
      mockFetch.mockResolvedValue(makeSuccessResponse());

      await adapter.chat(makeRequest());

      const [, options] = mockFetch.mock.calls[0];
      expect(options.headers).toEqual({
        'Authorization': 'Bearer test-api-key',
        'Content-Type': 'application/json',
      });
    });

    it('should pass model, max_completion_tokens, and temperature in body', async () => {
      mockFetch.mockResolvedValue(makeSuccessResponse());

      await adapter.chat(makeRequest());

      const [, options] = mockFetch.mock.calls[0];
      const body = JSON.parse(options.body);

      expect(body.model).toBe('gpt-5.4-mini');
      expect(body.max_completion_tokens).toBe(200);
      expect(body.temperature).toBe(0.7);
    });

    it('should pass system and user prompts in messages array', async () => {
      mockFetch.mockResolvedValue(makeSuccessResponse());

      await adapter.chat(makeRequest());

      const [, options] = mockFetch.mock.calls[0];
      const body = JSON.parse(options.body);

      expect(body.messages).toEqual([
        { role: 'system', content: 'You are a helpful assistant.' },
        { role: 'user', content: 'What is the weather?' },
      ]);
    });
  });

  describe('response parsing', () => {
    it('should return text and usage from successful response', async () => {
      mockFetch.mockResolvedValue(makeSuccessResponse('Test response', 150, 75));

      const result = await adapter.chat(makeRequest());

      expect(result.text).toBe('Test response');
      expect(result.usage).toEqual({ input: 150, output: 75 });
    });
  });

  describe('structured output and reasoning params', () => {
    it('should include response_format when outputSchema is provided', async () => {
      mockFetch.mockResolvedValue(makeSuccessResponse());
      const schema = { type: 'object', properties: { action: { type: 'string' } } };

      await adapter.chat({ ...makeRequest(), outputSchema: schema });

      const [, options] = mockFetch.mock.calls[0];
      const body = JSON.parse(options.body);
      expect(body.response_format).toEqual({
        type: 'json_schema',
        json_schema: {
          name: 'game_action',
          schema,
          strict: true,
        },
      });
    });

    it('should not include response_format or reasoning when no optional params provided', async () => {
      mockFetch.mockResolvedValue(makeSuccessResponse());

      await adapter.chat(makeRequest());

      const [, options] = mockFetch.mock.calls[0];
      const body = JSON.parse(options.body);
      expect(body.response_format).toBeUndefined();
      expect(body.reasoning).toBeUndefined();
    });

    it('should map effort to reasoning param', async () => {
      mockFetch.mockResolvedValue(makeSuccessResponse());

      await adapter.chat({ ...makeRequest(), effort: 'high' });

      const [, options] = mockFetch.mock.calls[0];
      const body = JSON.parse(options.body);
      expect(body.reasoning).toEqual({ effort: 'high' });
    });

    it('should silently ignore thinking param (no OpenAI equivalent)', async () => {
      mockFetch.mockResolvedValue(makeSuccessResponse());

      await adapter.chat({ ...makeRequest(), thinking: { type: 'adaptive' } });

      const [, options] = mockFetch.mock.calls[0];
      const body = JSON.parse(options.body);
      expect(body.thinking).toBeUndefined();
    });

    it('should retry without response_format on schema rejection (400) and log warning', async () => {
      const schema = { type: 'object', properties: { action: { type: 'string' } } };
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation();

      // First call: 400 with schema error
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 400,
        text: async () => 'invalid json_schema: response_format not supported',
      });
      // Retry call: success
      mockFetch.mockResolvedValueOnce(makeSuccessResponse('retry response'));

      const result = await adapter.chat({ ...makeRequest(), outputSchema: schema });

      expect(result.text).toBe('retry response');
      expect(mockFetch).toHaveBeenCalledTimes(2);

      // Should log warning about schema fallback
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('[OpenAIAdapter] Schema rejected (400)'),
      );

      // Retry body should not have response_format
      const retryBody = JSON.parse(mockFetch.mock.calls[1][1].body);
      expect(retryBody.response_format).toBeUndefined();
      warnSpy.mockRestore();
    });

    it('should NOT retry on 400 without schema keyword', async () => {
      const schema = { type: 'object', properties: { action: { type: 'string' } } };
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation();

      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 400,
        text: async () => 'invalid request: max_tokens too large',
      });

      await expect(adapter.chat({ ...makeRequest(), outputSchema: schema })).rejects.toThrow(ProviderAPIError);
      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(warnSpy).not.toHaveBeenCalled();
      warnSpy.mockRestore();
    });

    it('should use per-request timeoutMs when provided', async () => {
      const slowAdapter = new OpenAIAdapter('test-key', 50);
      mockFetch.mockImplementation(
        (_url: string, opts: { signal: AbortSignal }) =>
          new Promise((_resolve, reject) => {
            const onAbort = () => reject(new DOMException('aborted', 'AbortError'));
            if (opts.signal.aborted) return onAbort();
            opts.signal.addEventListener('abort', onAbort);
          }),
      );

      await expect(
        slowAdapter.chat({ ...makeRequest(), timeoutMs: 100 }),
      ).rejects.toThrow(ProviderTimeoutError);
    });
  });

  describe('refusal handling', () => {
    it('should treat non-null refusal as a ProviderAPIError', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          choices: [{ message: { content: null, refusal: 'I cannot help with that' } }],
          usage: { prompt_tokens: 100, completion_tokens: 10 },
        }),
        text: async () => '',
      });

      await expect(adapter.chat(makeRequest())).rejects.toThrow(ProviderAPIError);
    });
  });

  describe('error handling', () => {
    it('should throw ProviderAuthError on 401', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 401,
        text: async () => 'Unauthorized',
      });

      await expect(adapter.chat(makeRequest())).rejects.toThrow(ProviderAuthError);
    });

    it('should throw ProviderAuthError on 403', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 403,
        text: async () => 'Forbidden',
      });

      await expect(adapter.chat(makeRequest())).rejects.toThrow(ProviderAuthError);
    });

    it('should throw ProviderAPIError on 500 server error', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 500,
        text: async () => 'Internal Server Error',
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

    it('should throw ProviderAPIError on 429 rate limit', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 429,
        text: async () => 'Rate limit exceeded',
      });

      await expect(adapter.chat(makeRequest())).rejects.toThrow(ProviderAPIError);
    });
  });
});
