import { AnthropicAdapter } from '../../../services/ai/providers/AnthropicAdapter';
import { ProviderTimeoutError, ProviderAPIError, ProviderAuthError } from '../../../services/ai/providers/errors';

const mockRequest = {
  model: 'claude-sonnet-4-5-20250929',
  maxTokens: 300,
  temperature: 0.4,
  systemPrompt: 'You are a bot.',
  userPrompt: 'Pick an option.',
};

// Mock global fetch
const originalFetch = global.fetch;

beforeEach(() => {
  global.fetch = jest.fn();
});

afterEach(() => {
  global.fetch = originalFetch;
});

function mockFetchSuccess(text: string, inputTokens: number = 50, outputTokens: number = 30) {
  (global.fetch as jest.Mock).mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({
      content: [{ text }],
      usage: { input_tokens: inputTokens, output_tokens: outputTokens },
    }),
  });
}

function mockFetchError(status: number, body: string = 'error') {
  (global.fetch as jest.Mock).mockResolvedValue({
    ok: false,
    status,
    text: async () => body,
  });
}

describe('AnthropicAdapter', () => {
  const adapter = new AnthropicAdapter('test-api-key', 5000);

  it('should send correct request to Anthropic API', async () => {
    mockFetchSuccess('{"moveOption": 0}');

    await adapter.chat(mockRequest);

    expect(global.fetch).toHaveBeenCalledWith(
      'https://api.anthropic.com/v1/messages',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          'x-api-key': 'test-api-key',
          'anthropic-version': '2023-06-01',
        }),
      }),
    );

    const callBody = JSON.parse((global.fetch as jest.Mock).mock.calls[0][1].body);
    expect(callBody.model).toBe('claude-sonnet-4-5-20250929');
    expect(callBody.max_tokens).toBe(300);
    expect(callBody.temperature).toBe(0.4);
  });

  it('should send system prompt with ephemeral cache_control for prompt caching', async () => {
    mockFetchSuccess('{"action":"PASS"}');

    await adapter.chat(mockRequest);

    const callBody = JSON.parse((global.fetch as jest.Mock).mock.calls[0][1].body);
    expect(callBody.system).toEqual([{
      type: 'text',
      text: 'You are a bot.',
      cache_control: { type: 'ephemeral' },
    }]);
  });

  it('should normalize successful response to ProviderResponse', async () => {
    mockFetchSuccess('response text', 100, 50);

    const result = await adapter.chat(mockRequest);

    expect(result.text).toBe('response text');
    expect(result.usage.input).toBe(100);
    expect(result.usage.output).toBe(50);
  });

  it('should throw ProviderAuthError on 401', async () => {
    mockFetchError(401, 'Unauthorized');

    await expect(adapter.chat(mockRequest)).rejects.toThrow(ProviderAuthError);
  });

  it('should throw ProviderAuthError on 403', async () => {
    mockFetchError(403, 'Forbidden');

    await expect(adapter.chat(mockRequest)).rejects.toThrow(ProviderAuthError);
  });

  it('should throw ProviderAPIError on 500', async () => {
    mockFetchError(500, 'Internal Server Error');

    await expect(adapter.chat(mockRequest)).rejects.toThrow(ProviderAPIError);
    try {
      await adapter.chat(mockRequest);
    } catch (e) {
      expect((e as ProviderAPIError).statusCode).toBe(500);
    }
  });

  it('should throw ProviderAPIError on 429 (rate limit)', async () => {
    mockFetchError(429, 'Rate limited');

    await expect(adapter.chat(mockRequest)).rejects.toThrow(ProviderAPIError);
  });

  it('should throw ProviderTimeoutError on abort', async () => {
    const slowAdapter = new AnthropicAdapter('test-key', 50); // 50ms timeout
    (global.fetch as jest.Mock).mockImplementation(
      (_url: string, opts: { signal: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          const onAbort = () => {
            const err = new DOMException('The operation was aborted.', 'AbortError');
            reject(err);
          };
          if (opts.signal.aborted) return onAbort();
          opts.signal.addEventListener('abort', onAbort);
        }),
    );

    await expect(slowAdapter.chat(mockRequest)).rejects.toThrow(ProviderTimeoutError);
  });
});
