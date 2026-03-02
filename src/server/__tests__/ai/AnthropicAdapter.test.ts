import { AnthropicAdapter } from '../../services/ai/providers/AnthropicAdapter';
import { ProviderAuthError, ProviderAPIError, ProviderTimeoutError } from '../../services/ai/providers/errors';

// Mock global fetch
const mockFetch = jest.fn();
global.fetch = mockFetch;

function makeRequest() {
  return {
    model: 'claude-haiku-4-5-20251001',
    maxTokens: 200,
    temperature: 0.7,
    systemPrompt: 'You are a helpful assistant.',
    userPrompt: 'What is the weather?',
  };
}

function makeSuccessResponse(text = 'Hello', inputTokens = 100, outputTokens = 50) {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      content: [{ type: 'text', text }],
      usage: { input_tokens: inputTokens, output_tokens: outputTokens },
    }),
    text: async () => '',
  };
}

describe('AnthropicAdapter', () => {
  let adapter: AnthropicAdapter;

  beforeEach(() => {
    jest.clearAllMocks();
    adapter = new AnthropicAdapter('test-api-key', 5000);
  });

  // --- BE-024: Prompt caching ---
  describe('prompt caching (BE-024)', () => {
    it('should send system prompt as content block array with cache_control', async () => {
      mockFetch.mockResolvedValue(makeSuccessResponse());

      await adapter.chat(makeRequest());

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const [, options] = mockFetch.mock.calls[0];
      const body = JSON.parse(options.body);

      // System must be an array, not a string
      expect(Array.isArray(body.system)).toBe(true);
      expect(body.system).toHaveLength(1);
      expect(body.system[0]).toEqual({
        type: 'text',
        text: 'You are a helpful assistant.',
        cache_control: { type: 'ephemeral' },
      });
    });

    it('should include cache_control with type ephemeral', async () => {
      mockFetch.mockResolvedValue(makeSuccessResponse());

      await adapter.chat(makeRequest());

      const [, options] = mockFetch.mock.calls[0];
      const body = JSON.parse(options.body);

      expect(body.system[0].cache_control).toEqual({ type: 'ephemeral' });
    });

    it('should preserve system prompt text exactly', async () => {
      mockFetch.mockResolvedValue(makeSuccessResponse());

      const longPrompt = 'A very detailed system prompt\nwith multiple lines\nand special chars: "quotes" & <tags>';
      await adapter.chat({ ...makeRequest(), systemPrompt: longPrompt });

      const [, options] = mockFetch.mock.calls[0];
      const body = JSON.parse(options.body);

      expect(body.system[0].text).toBe(longPrompt);
    });
  });

  // --- Core adapter functionality ---
  describe('API request format', () => {
    it('should call Anthropic API with correct URL', async () => {
      mockFetch.mockResolvedValue(makeSuccessResponse());

      await adapter.chat(makeRequest());

      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.anthropic.com/v1/messages',
        expect.any(Object),
      );
    });

    it('should include correct headers', async () => {
      mockFetch.mockResolvedValue(makeSuccessResponse());

      await adapter.chat(makeRequest());

      const [, options] = mockFetch.mock.calls[0];
      expect(options.headers).toEqual({
        'x-api-key': 'test-api-key',
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      });
    });

    it('should pass model, max_tokens, and temperature in body', async () => {
      mockFetch.mockResolvedValue(makeSuccessResponse());

      await adapter.chat(makeRequest());

      const [, options] = mockFetch.mock.calls[0];
      const body = JSON.parse(options.body);

      expect(body.model).toBe('claude-haiku-4-5-20251001');
      expect(body.max_tokens).toBe(200);
      expect(body.temperature).toBe(0.7);
    });

    it('should pass user prompt in messages array', async () => {
      mockFetch.mockResolvedValue(makeSuccessResponse());

      await adapter.chat(makeRequest());

      const [, options] = mockFetch.mock.calls[0];
      const body = JSON.parse(options.body);

      expect(body.messages).toEqual([
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

  describe('multi-block response extraction', () => {
    it('should extract only text block from response with thinking and text blocks', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          content: [
            { type: 'thinking', thinking: 'Let me analyze this step by step...' },
            { type: 'text', text: '{"action":"BUILD","reasoning":"Build toward Berlin"}' },
          ],
          usage: { input_tokens: 500, output_tokens: 200 },
        }),
        text: async () => '',
      });

      const result = await adapter.chat(makeRequest());

      expect(result.text).toBe('{"action":"BUILD","reasoning":"Build toward Berlin"}');
      expect(result.text).not.toContain('Let me analyze');
    });

    it('should return empty string when response has only thinking blocks', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          content: [
            { type: 'thinking', thinking: 'Reasoning here...' },
          ],
          usage: { input_tokens: 100, output_tokens: 50 },
        }),
        text: async () => '',
      });

      const result = await adapter.chat(makeRequest());

      expect(result.text).toBe('');
    });

    it('should handle response with multiple text blocks (takes first)', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          content: [
            { type: 'thinking', thinking: 'Step 1...' },
            { type: 'text', text: 'First text block' },
            { type: 'text', text: 'Second text block' },
          ],
          usage: { input_tokens: 100, output_tokens: 50 },
        }),
        text: async () => '',
      });

      const result = await adapter.chat(makeRequest());

      expect(result.text).toBe('First text block');
    });
  });

  describe('structured output and thinking params', () => {
    it('should include output_config when outputSchema is provided', async () => {
      mockFetch.mockResolvedValue(makeSuccessResponse());
      const schema = { type: 'object', properties: { action: { type: 'string' } } };

      await adapter.chat({ ...makeRequest(), outputSchema: schema });

      const [, options] = mockFetch.mock.calls[0];
      const body = JSON.parse(options.body);
      expect(body.output_config).toEqual({
        format: { type: 'json_schema', schema },
      });
    });

    it('should not include output_config or thinking when no optional params provided', async () => {
      mockFetch.mockResolvedValue(makeSuccessResponse());

      await adapter.chat(makeRequest());

      const [, options] = mockFetch.mock.calls[0];
      const body = JSON.parse(options.body);
      expect(body.output_config).toBeUndefined();
      expect(body.thinking).toBeUndefined();
    });

    it('should include both output_config and thinking when all params provided', async () => {
      mockFetch.mockResolvedValue(makeSuccessResponse());
      const schema = { type: 'object', properties: { action: { type: 'string' } } };

      await adapter.chat({
        ...makeRequest(),
        outputSchema: schema,
        thinking: { type: 'adaptive', effort: 'high' },
      });

      const [, options] = mockFetch.mock.calls[0];
      const body = JSON.parse(options.body);
      expect(body.output_config).toEqual({
        format: { type: 'json_schema', schema },
      });
      expect(body.thinking).toEqual({ type: 'adaptive', effort: 'high' });
    });

    it('should include output_config but not thinking when only outputSchema provided', async () => {
      mockFetch.mockResolvedValue(makeSuccessResponse());
      const schema = { type: 'object', properties: { action: { type: 'string' } } };

      await adapter.chat({ ...makeRequest(), outputSchema: schema });

      const [, options] = mockFetch.mock.calls[0];
      const body = JSON.parse(options.body);
      expect(body.output_config).toEqual({
        format: { type: 'json_schema', schema },
      });
      expect(body.thinking).toBeUndefined();
    });

    it('should include thinking config when provided', async () => {
      mockFetch.mockResolvedValue(makeSuccessResponse());

      await adapter.chat({
        ...makeRequest(),
        thinking: { type: 'adaptive', effort: 'high' },
      });

      const [, options] = mockFetch.mock.calls[0];
      const body = JSON.parse(options.body);
      expect(body.thinking).toEqual({ type: 'adaptive', effort: 'high' });
    });

    it('should use per-request timeoutMs when provided', async () => {
      const slowAdapter = new AnthropicAdapter('test-key', 50);
      mockFetch.mockImplementation(
        (_url: string, opts: { signal: AbortSignal }) =>
          new Promise((_resolve, reject) => {
            const onAbort = () => reject(new DOMException('aborted', 'AbortError'));
            if (opts.signal.aborted) return onAbort();
            opts.signal.addEventListener('abort', onAbort);
          }),
      );

      // With 50ms default but 100ms override, the timeout error should report 100ms
      await expect(
        slowAdapter.chat({ ...makeRequest(), timeoutMs: 100 }),
      ).rejects.toThrow(ProviderTimeoutError);
    });

    it('should retry without output_config on schema rejection (400)', async () => {
      const schema = { type: 'object', properties: { action: { type: 'string' } } };

      // First call: 400 with schema error
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 400,
        text: async () => 'invalid schema: output_config not supported',
      });
      // Retry call: success
      mockFetch.mockResolvedValueOnce(makeSuccessResponse('retry response'));

      const result = await adapter.chat({ ...makeRequest(), outputSchema: schema });

      expect(result.text).toBe('retry response');
      expect(mockFetch).toHaveBeenCalledTimes(2);

      // Second call should not have output_config
      const retryBody = JSON.parse(mockFetch.mock.calls[1][1].body);
      expect(retryBody.output_config).toBeUndefined();
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

    it('should throw ProviderAPIError on non-OK response', async () => {
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
  });
});
