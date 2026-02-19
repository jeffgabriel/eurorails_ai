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
      content: [{ text }],
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
