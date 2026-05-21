import { GoogleAdapter } from '../../../services/ai/providers/GoogleAdapter';
import { ProviderTimeoutError, ProviderAPIError, ProviderAuthError } from '../../../services/ai/providers/errors';

const mockRequest = {
  model: 'gemini-2.0-flash',
  maxTokens: 300,
  temperature: 0.4,
  systemPrompt: 'You are a bot.',
  userPrompt: 'Pick an option.',
};

const originalFetch = global.fetch;

beforeEach(() => {
  global.fetch = jest.fn();
});

afterEach(() => {
  global.fetch = originalFetch;
});

function mockFetchSuccess(text: string, promptTokens: number = 50, candidateTokens: number = 30) {
  (global.fetch as jest.Mock).mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({
      candidates: [{ content: { parts: [{ text }] } }],
      usageMetadata: {
        promptTokenCount: promptTokens,
        candidatesTokenCount: candidateTokens,
      },
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

describe('GoogleAdapter', () => {
  const adapter = new GoogleAdapter('test-google-key', 5000);

  it('should send correct request to Google API', async () => {
    mockFetchSuccess('{"moveOption": 0}');

    await adapter.chat(mockRequest);

    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining('generativelanguage.googleapis.com'),
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          'x-goog-api-key': 'test-google-key',
        }),
      }),
    );

    const callBody = JSON.parse((global.fetch as jest.Mock).mock.calls[0][1].body);
    expect(callBody.generationConfig.maxOutputTokens).toBe(300);
    expect(callBody.generationConfig.temperature).toBe(0.4);
    expect(callBody.system_instruction.parts[0].text).toBe('You are a bot.');
  });

  it('should normalize successful response to ProviderResponse', async () => {
    mockFetchSuccess('response text', 80, 40);

    const result = await adapter.chat(mockRequest);

    expect(result.text).toBe('response text');
    expect(result.usage.input).toBe(80);
    expect(result.usage.output).toBe(40);
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
  });

  it('should throw ProviderAPIError on 429', async () => {
    mockFetchError(429, 'Rate limited');

    await expect(adapter.chat(mockRequest)).rejects.toThrow(ProviderAPIError);
  });

  it('should throw ProviderTimeoutError on abort', async () => {
    const slowAdapter = new GoogleAdapter('test-key', 50);
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

  it('should include model name in URL', async () => {
    mockFetchSuccess('text');

    await adapter.chat(mockRequest);

    const url = (global.fetch as jest.Mock).mock.calls[0][0] as string;
    expect(url).toContain('gemini-2.0-flash');
  });

  describe('Gemini 3 thinking token reserve (GEMINI3_THINKING_RESERVE)', () => {
    function mockGemini3Success(text: string) {
      (global.fetch as jest.Mock).mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          candidates: [{ content: { parts: [{ text }] } }],
          usageMetadata: { promptTokenCount: 50, candidatesTokenCount: 30 },
        }),
      });
    }

    it('gemini-3-flash-preview + thinking medium → maxOutputTokens = request.maxTokens + 4096', async () => {
      mockGemini3Success('ok');

      await adapter.chat({
        model: 'gemini-3-flash-preview',
        maxTokens: 1000,
        temperature: 0.5,
        systemPrompt: 'sys',
        userPrompt: 'usr',
        thinking: { type: 'adaptive' },
        effort: 'medium',
      });

      const callBody = JSON.parse((global.fetch as jest.Mock).mock.calls[0][1].body);
      expect(callBody.generationConfig.maxOutputTokens).toBe(1000 + 4096);
    });

    it('gemini-3-flash-preview + thinking low → maxOutputTokens = request.maxTokens + 2048', async () => {
      mockGemini3Success('ok');

      await adapter.chat({
        model: 'gemini-3-flash-preview',
        maxTokens: 1000,
        temperature: 0.5,
        systemPrompt: 'sys',
        userPrompt: 'usr',
        thinking: { type: 'adaptive' },
        effort: 'low',
      });

      const callBody = JSON.parse((global.fetch as jest.Mock).mock.calls[0][1].body);
      expect(callBody.generationConfig.maxOutputTokens).toBe(1000 + 2048);
    });

    it('gemini-3-flash-preview WITHOUT thinking → maxOutputTokens = request.maxTokens (no reserve)', async () => {
      mockGemini3Success('ok');

      await adapter.chat({
        model: 'gemini-3-flash-preview',
        maxTokens: 1000,
        temperature: 0.5,
        systemPrompt: 'sys',
        userPrompt: 'usr',
      });

      const callBody = JSON.parse((global.fetch as jest.Mock).mock.calls[0][1].body);
      expect(callBody.generationConfig.maxOutputTokens).toBe(1000);
    });

    it('gemini-2.5-flash + thinking → maxOutputTokens = request.maxTokens (Gemini 2.5 branch unchanged)', async () => {
      (global.fetch as jest.Mock).mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          candidates: [{ content: { parts: [{ text: 'ok' }] } }],
          usageMetadata: { promptTokenCount: 50, candidatesTokenCount: 30 },
        }),
      });

      await adapter.chat({
        model: 'gemini-2.5-flash',
        maxTokens: 1000,
        temperature: 0.5,
        systemPrompt: 'sys',
        userPrompt: 'usr',
        thinking: { type: 'adaptive' },
        effort: 'medium',
      });

      const callBody = JSON.parse((global.fetch as jest.Mock).mock.calls[0][1].body);
      expect(callBody.generationConfig.maxOutputTokens).toBe(1000);
    });
  });
});
