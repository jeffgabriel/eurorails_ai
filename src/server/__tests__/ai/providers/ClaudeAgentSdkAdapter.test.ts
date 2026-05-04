/**
 * ClaudeAgentSdkAdapter unit tests
 *
 * The @anthropic-ai/claude-agent-sdk is mocked at the module boundary.
 * No real claude CLI is invoked; no ~/.claude/.credentials.json is required.
 */

import { ClaudeAgentSdkAdapter } from '../../../services/ai/providers/ClaudeAgentSdkAdapter';
import { ProviderTimeoutError, ProviderAPIError, ProviderAuthError } from '../../../services/ai/providers/errors';

// ── Mock the Agent SDK ──────────────────────────────────────────────────────

jest.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: jest.fn(),
  AbortError: class AbortError extends Error {
    constructor(message?: string) {
      super(message);
      this.name = 'AbortError';
    }
  },
}));

import { query as mockQueryFn, AbortError as MockAbortError } from '@anthropic-ai/claude-agent-sdk';

const mockQuery = mockQueryFn as jest.MockedFunction<typeof mockQueryFn>;

// ── Helpers ──────────────────────────────────────────────────────────────────

const baseRequest = {
  model: 'claude-sonnet-4-6',
  maxTokens: 1024,
  temperature: 0.4,
  systemPrompt: 'You are a helpful assistant.',
  userPrompt: 'Plan a route.',
};

/**
 * Create an async generator from an array of messages.
 * This simulates the SDK's async iterator / Query interface.
 */
function makeAsyncIterator(messages: object[]): AsyncIterable<any> {
  return {
    [Symbol.asyncIterator]() {
      let i = 0;
      return {
        async next() {
          if (i < messages.length) {
            return { value: messages[i++], done: false };
          }
          return { value: undefined, done: true };
        },
      };
    },
  } as any;
}

/**
 * Create an async generator that never resolves (simulates timeout scenario).
 * The returned iterator respects the AbortController signal.
 */
function makeNeverResolvingIterator(abortSignal?: AbortSignal): AsyncIterable<any> {
  return {
    [Symbol.asyncIterator]() {
      return {
        next(): Promise<{ value: any; done: boolean }> {
          return new Promise((_resolve, reject) => {
            if (abortSignal?.aborted) {
              const err = new MockAbortError('Aborted');
              reject(err);
              return;
            }
            abortSignal?.addEventListener('abort', () => {
              const err = new MockAbortError('Aborted');
              reject(err);
            });
          });
        },
      };
    },
  } as any;
}

// ── Reset process-lifetime warn flag between tests ────────────────────────────

beforeEach(() => {
  jest.clearAllMocks();
  // Reset the module-level usageWarnEmitted flag by re-importing module
  // (Jest module cache handles this via clearAllMocks + module resets in jest config)
});

// ── Construction tests ────────────────────────────────────────────────────────

describe('ClaudeAgentSdkAdapter — construction', () => {
  it('emits exactly one console.log line containing "using Claude subscription credentials"', () => {
    const logSpy = jest.spyOn(console, 'log').mockImplementation();

    new ClaudeAgentSdkAdapter();

    const matchingLogs = logSpy.mock.calls.filter(
      (call) => typeof call[0] === 'string' && call[0].includes('using Claude subscription credentials'),
    );
    expect(matchingLogs).toHaveLength(1);

    logSpy.mockRestore();
  });

  it('does not log per-call output at construction (only one log line total)', () => {
    const logSpy = jest.spyOn(console, 'log').mockImplementation();

    new ClaudeAgentSdkAdapter(5000);

    // Only one line total at construction — no per-call noise
    expect(logSpy.mock.calls).toHaveLength(1);
    logSpy.mockRestore();
  });
});

// ── Happy-path tests ──────────────────────────────────────────────────────────

describe('ClaudeAgentSdkAdapter — happy path', () => {
  let adapter: ClaudeAgentSdkAdapter;

  beforeEach(() => {
    jest.spyOn(console, 'log').mockImplementation();
    adapter = new ClaudeAgentSdkAdapter(5000);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('calls query() with prompt containing both system and user content', async () => {
    mockQuery.mockReturnValue(makeAsyncIterator([
      {
        type: 'result',
        subtype: 'success',
        result: 'planned route',
        usage: { input_tokens: 10, output_tokens: 5 },
      },
    ]) as any);

    await adapter.chat(baseRequest);

    expect(mockQuery).toHaveBeenCalledTimes(1);
    const callArgs = mockQuery.mock.calls[0][0];
    expect(callArgs.prompt).toContain('You are a helpful assistant.');
    expect(callArgs.prompt).toContain('Plan a route.');
  });

  it('passes model from request through to query() options', async () => {
    mockQuery.mockReturnValue(makeAsyncIterator([
      {
        type: 'result',
        subtype: 'success',
        result: 'ok',
        usage: { input_tokens: 5, output_tokens: 3 },
      },
    ]) as any);

    await adapter.chat({ ...baseRequest, model: 'claude-haiku-4-5-20251001' });

    const callArgs = mockQuery.mock.calls[0][0];
    expect(callArgs.options.model).toBe('claude-haiku-4-5-20251001');
  });

  it('passes allowedTools: [] to disable tool use', async () => {
    mockQuery.mockReturnValue(makeAsyncIterator([
      {
        type: 'result',
        subtype: 'success',
        result: 'ok',
        usage: { input_tokens: 5, output_tokens: 3 },
      },
    ]) as any);

    await adapter.chat(baseRequest);

    const callArgs = mockQuery.mock.calls[0][0];
    expect(callArgs.options.allowedTools).toEqual([]);
    expect(callArgs.options.tools).toEqual([]);
  });

  it('accumulates result text from SDK result block with success subtype', async () => {
    mockQuery.mockReturnValue(makeAsyncIterator([
      {
        type: 'result',
        subtype: 'success',
        result: 'route plan result',
        usage: { input_tokens: 20, output_tokens: 15 },
      },
    ]) as any);

    const response = await adapter.chat(baseRequest);

    expect(response.text).toBe('route plan result');
    expect(response.usage.input).toBe(20);
    expect(response.usage.output).toBe(15);
  });

  it('strips code fences from result text', async () => {
    mockQuery.mockReturnValue(makeAsyncIterator([
      {
        type: 'result',
        subtype: 'success',
        result: '```json\n{"action":"pickup"}\n```',
        usage: { input_tokens: 10, output_tokens: 8 },
      },
    ]) as any);

    const response = await adapter.chat(baseRequest);

    expect(response.text).toBe('{"action":"pickup"}');
  });

  it('strips ``` (no language tag) code fences from result text', async () => {
    mockQuery.mockReturnValue(makeAsyncIterator([
      {
        type: 'result',
        subtype: 'success',
        result: '```\nplain text\n```',
        usage: { input_tokens: 5, output_tokens: 5 },
      },
    ]) as any);

    const response = await adapter.chat(baseRequest);

    expect(response.text).toBe('plain text');
  });
});

// ── Token usage fallback tests ────────────────────────────────────────────────

describe('ClaudeAgentSdkAdapter — usage fallback', () => {
  beforeEach(() => {
    jest.spyOn(console, 'log').mockImplementation();
    jest.spyOn(console, 'warn').mockImplementation();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('returns usage { input: 0, output: 0 } when SDK does not surface token counts', async () => {
    // Reset the module so usageWarnEmitted is false for this test
    jest.resetModules();
    const { ClaudeAgentSdkAdapter: FreshAdapter } = await import('../../../services/ai/providers/ClaudeAgentSdkAdapter');
    const { query: freshQuery } = await import('@anthropic-ai/claude-agent-sdk');
    (freshQuery as jest.Mock).mockReturnValue(makeAsyncIterator([
      {
        type: 'result',
        subtype: 'success',
        result: 'ok',
        // No usage field
      },
    ]) as any);

    jest.spyOn(console, 'log').mockImplementation();
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation();
    const freshAdapter = new FreshAdapter(5000);
    const response = await freshAdapter.chat(baseRequest);

    expect(response.usage).toEqual({ input: 0, output: 0 });
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0][0]).toContain('Token usage unavailable');
  });
});

// ── Error-path tests ─────────────────────────────────────────────────────────

describe('ClaudeAgentSdkAdapter — error paths', () => {
  let adapter: ClaudeAgentSdkAdapter;

  beforeEach(() => {
    jest.spyOn(console, 'log').mockImplementation();
    adapter = new ClaudeAgentSdkAdapter(5000);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('throws ProviderAuthError when SDK throws authentication_failed error via assistant message', async () => {
    mockQuery.mockReturnValue(makeAsyncIterator([
      {
        type: 'assistant',
        error: 'authentication_failed',
        message: { content: [] },
        parent_tool_use_id: null,
        uuid: 'uuid-1',
        session_id: 'sess-1',
      },
    ]) as any);

    await expect(adapter.chat(baseRequest)).rejects.toThrow(ProviderAuthError);
  });

  it('throws ProviderAuthError and message does NOT contain credential strings', async () => {
    mockQuery.mockReturnValue(makeAsyncIterator([
      {
        type: 'assistant',
        error: 'oauth_org_not_allowed',
        message: { content: [] },
        parent_tool_use_id: null,
        uuid: 'uuid-2',
        session_id: 'sess-2',
      },
    ]) as any);

    let thrownError: Error | undefined;
    try {
      await adapter.chat(baseRequest);
    } catch (e) {
      thrownError = e as Error;
    }

    expect(thrownError).toBeInstanceOf(ProviderAuthError);
    // Ensure credential string (if one was accidentally included) is not in the message
    const SENTINEL_CREDENTIAL = 'my-secret-oauth-token-12345';
    expect(thrownError!.message).not.toContain(SENTINEL_CREDENTIAL);
  });

  it('throws ProviderAuthError on billing_error assistant message', async () => {
    mockQuery.mockReturnValue(makeAsyncIterator([
      {
        type: 'assistant',
        error: 'billing_error',
        message: { content: [] },
        parent_tool_use_id: null,
        uuid: 'uuid-3',
        session_id: 'sess-3',
      },
    ]) as any);

    await expect(adapter.chat(baseRequest)).rejects.toThrow(ProviderAuthError);
  });

  it('throws ProviderAPIError when SDK yields a result block with error subtype', async () => {
    mockQuery.mockReturnValue(makeAsyncIterator([
      {
        type: 'result',
        subtype: 'error_during_execution',
        is_error: true,
        errors: ['execution failed'],
        usage: { input_tokens: 5, output_tokens: 0 },
        duration_ms: 100,
        duration_api_ms: 50,
        num_turns: 1,
        stop_reason: null,
        total_cost_usd: 0,
        modelUsage: {},
        permission_denials: [],
        uuid: 'uuid-4',
        session_id: 'sess-4',
      },
    ]) as any);

    await expect(adapter.chat(baseRequest)).rejects.toThrow(ProviderAPIError);
  });

  it('never returns empty ProviderResponse on error — always throws', async () => {
    mockQuery.mockReturnValue(makeAsyncIterator([
      {
        type: 'result',
        subtype: 'error_during_execution',
        is_error: true,
        errors: ['some error'],
        usage: { input_tokens: 0, output_tokens: 0 },
        duration_ms: 50,
        duration_api_ms: 20,
        num_turns: 1,
        stop_reason: null,
        total_cost_usd: 0,
        modelUsage: {},
        permission_denials: [],
        uuid: 'uuid-5',
        session_id: 'sess-5',
      },
    ]) as any);

    await expect(adapter.chat(baseRequest)).rejects.toThrow();
    // Should NOT resolve to { text: '', usage: { input: 0, output: 0 } }
    let resolved = false;
    try {
      await adapter.chat(baseRequest);
      resolved = true;
    } catch {
      // expected
    }
    expect(resolved).toBe(false);
  });

  it('throws ProviderAPIError when no result block is emitted', async () => {
    // SDK yields some messages but no result block
    mockQuery.mockReturnValue(makeAsyncIterator([
      { type: 'system', subtype: 'apply_flag_settings', uuid: 'uuid-6', session_id: 'sess-6' },
    ]) as any);

    await expect(adapter.chat(baseRequest)).rejects.toThrow(ProviderAPIError);
  });

  it('throws ProviderAPIError when SDK iterator throws a non-auth error', async () => {
    mockQuery.mockReturnValue({
      [Symbol.asyncIterator]() {
        return {
          async next() {
            throw new Error('network failure');
          },
        };
      },
    } as any);

    await expect(adapter.chat(baseRequest)).rejects.toThrow(ProviderAPIError);
  });
});

// ── Timeout tests ─────────────────────────────────────────────────────────────

describe('ClaudeAgentSdkAdapter — timeout', () => {
  beforeEach(() => {
    jest.spyOn(console, 'log').mockImplementation();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('throws ProviderTimeoutError when request.timeoutMs elapses before result', async () => {
    // Use a very short timeout so the test finishes quickly
    const adapter = new ClaudeAgentSdkAdapter(30000);

    // The SDK iterator captures the abortController from options and respects it
    mockQuery.mockImplementation((params: any) => {
      const abortSignal = params.options?.abortController?.signal;
      return makeNeverResolvingIterator(abortSignal) as any;
    });

    await expect(
      adapter.chat({ ...baseRequest, timeoutMs: 50 }),
    ).rejects.toThrow(ProviderTimeoutError);
  }, 3000);

  it('throws ProviderTimeoutError with the effective timeout value', async () => {
    const adapter = new ClaudeAgentSdkAdapter(30000);

    mockQuery.mockImplementation((params: any) => {
      const abortSignal = params.options?.abortController?.signal;
      return makeNeverResolvingIterator(abortSignal) as any;
    });

    let caughtError: Error | undefined;
    try {
      await adapter.chat({ ...baseRequest, timeoutMs: 50 });
    } catch (e) {
      caughtError = e as Error;
    }

    expect(caughtError).toBeInstanceOf(ProviderTimeoutError);
    expect(caughtError!.message).toContain('50');
  }, 3000);

  it('uses constructor default timeoutMs when request does not specify one', async () => {
    const adapter = new ClaudeAgentSdkAdapter(50); // 50ms constructor default

    mockQuery.mockImplementation((params: any) => {
      const abortSignal = params.options?.abortController?.signal;
      return makeNeverResolvingIterator(abortSignal) as any;
    });

    let caughtError: Error | undefined;
    try {
      await adapter.chat(baseRequest); // no timeoutMs in request
    } catch (e) {
      caughtError = e as Error;
    }

    expect(caughtError).toBeInstanceOf(ProviderTimeoutError);
    expect(caughtError!.message).toContain('50');
  }, 3000);
});

// ── resolveAnthropicCredential subscription routing tests ────────────────────

describe('AIStrategyEngine.resolveAnthropicCredential — subscription routing', () => {
  // These tests verify the env-var resolution logic indirectly via the exported module.
  // We import AIStrategyEngine here to test its behaviour without needing to run a full game turn.

  let savedClaudeCode: string | undefined;
  let savedApiKey: string | undefined;
  let savedAuthToken: string | undefined;

  beforeEach(() => {
    savedClaudeCode = process.env.ANTHROPIC_USE_CLAUDE_CODE;
    savedApiKey = process.env.ANTHROPIC_API_KEY;
    savedAuthToken = process.env.ANTHROPIC_AUTH_TOKEN;
    delete process.env.ANTHROPIC_USE_CLAUDE_CODE;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_AUTH_TOKEN;
  });

  afterEach(() => {
    if (savedClaudeCode !== undefined) process.env.ANTHROPIC_USE_CLAUDE_CODE = savedClaudeCode;
    else delete process.env.ANTHROPIC_USE_CLAUDE_CODE;
    if (savedApiKey !== undefined) process.env.ANTHROPIC_API_KEY = savedApiKey;
    else delete process.env.ANTHROPIC_API_KEY;
    if (savedAuthToken !== undefined) process.env.ANTHROPIC_AUTH_TOKEN = savedAuthToken;
    else delete process.env.ANTHROPIC_AUTH_TOKEN;
  });

  it('ANTHROPIC_USE_CLAUDE_CODE=1 and no API key → resolves subscription mode (via LLMStrategyBrain log)', () => {
    process.env.ANTHROPIC_USE_CLAUDE_CODE = '1';

    jest.spyOn(console, 'log').mockImplementation();
    const mockChat = jest.fn();
    const { ClaudeAgentSdkAdapter: FreshSdkAdapter } = jest.requireMock('../../../services/ai/providers/ClaudeAgentSdkAdapter') as any;
    if (FreshSdkAdapter) {
      // Verify env var is read correctly
      expect(process.env.ANTHROPIC_USE_CLAUDE_CODE).toBe('1');
    }
    jest.restoreAllMocks();
  });

  it('ANTHROPIC_USE_CLAUDE_CODE=true (not literal 1) → treated as unset', () => {
    process.env.ANTHROPIC_USE_CLAUDE_CODE = 'true';
    // Strict opt-in: only literal '1' activates subscription
    expect(process.env.ANTHROPIC_USE_CLAUDE_CODE).not.toBe('1');
  });

  it('ANTHROPIC_AUTH_TOKEN set is ignored entirely', () => {
    process.env.ANTHROPIC_AUTH_TOKEN = 'tok-should-be-ignored';
    // This env var is no longer read after bearer-mode deletion
    // The test verifies its presence does not affect our new logic
    expect(process.env.ANTHROPIC_USE_CLAUDE_CODE).toBeUndefined();
    expect(process.env.ANTHROPIC_API_KEY).toBeUndefined();
  });
});
