/**
 * LoggingProviderAdapter call tracking tests — TEST-005
 *
 * Tests llmCallIds tracking (resetCallIds, getCallIds, getCallSummaries)
 * and llmSummary aggregation from call summaries.
 */

import { LoggingProviderAdapter, LLMCallSummary } from '../../services/ai/LoggingProviderAdapter';

jest.mock('../../services/ai/LLMTranscriptLogger', () => ({
  appendLLMCall: jest.fn(),
}));

describe('LoggingProviderAdapter call tracking', () => {
  let adapter: LoggingProviderAdapter;
  let mockInner: any;

  beforeEach(() => {
    mockInner = {
      chat: jest.fn().mockResolvedValue({
        text: '{"action": "test"}',
        usage: { input: 100, output: 50 },
      }),
    };
    adapter = new LoggingProviderAdapter(mockInner);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('resetCallIds', () => {
    it('clears tracked call IDs and summaries', async () => {
      adapter.setContext({ gameId: 'g1', playerId: 'p1', turn: 1, caller: 'test', method: 'test' });
      await adapter.chat({ model: 'm', maxTokens: 100, temperature: 0, systemPrompt: 's', userPrompt: 'u' });
      expect(adapter.getCallIds()).toHaveLength(1);

      adapter.resetCallIds();
      expect(adapter.getCallIds()).toEqual([]);
      expect(adapter.getCallSummaries()).toEqual([]);
    });
  });

  describe('getCallIds', () => {
    it('returns empty array before any calls', () => {
      expect(adapter.getCallIds()).toEqual([]);
    });

    it('collects unique call IDs from chat() invocations', async () => {
      adapter.setContext({ gameId: 'g1', playerId: 'p1', turn: 1, caller: 'test', method: 'test' });
      await adapter.chat({ model: 'm', maxTokens: 100, temperature: 0, systemPrompt: 's', userPrompt: 'u1' });
      await adapter.chat({ model: 'm', maxTokens: 100, temperature: 0, systemPrompt: 's', userPrompt: 'u2' });

      const ids = adapter.getCallIds();
      expect(ids).toHaveLength(2);
      expect(ids[0]).not.toBe(ids[1]);
    });

    it('returns a defensive copy', async () => {
      adapter.setContext({ gameId: 'g1', playerId: 'p1', turn: 1, caller: 'test', method: 'test' });
      await adapter.chat({ model: 'm', maxTokens: 100, temperature: 0, systemPrompt: 's', userPrompt: 'u' });

      const ids1 = adapter.getCallIds();
      const ids2 = adapter.getCallIds();
      expect(ids1).not.toBe(ids2);
      expect(ids1).toEqual(ids2);
    });
  });

  describe('getCallSummaries', () => {
    it('returns empty array before any calls', () => {
      expect(adapter.getCallSummaries()).toEqual([]);
    });

    it('collects summaries with caller, latency, and token usage', async () => {
      adapter.setContext({ gameId: 'g1', playerId: 'p1', turn: 1, caller: 'trip-planner', method: 'planTrip' });
      await adapter.chat({ model: 'm', maxTokens: 100, temperature: 0, systemPrompt: 's', userPrompt: 'u' });

      const summaries = adapter.getCallSummaries();
      expect(summaries).toHaveLength(1);
      expect(summaries[0].caller).toBe('trip-planner');
      expect(summaries[0].latencyMs).toBeGreaterThanOrEqual(0);
      expect(summaries[0].tokenUsage).toEqual({ input: 100, output: 50 });
    });

    it('records caller as unknown when no context set', async () => {
      await adapter.chat({ model: 'm', maxTokens: 100, temperature: 0, systemPrompt: 's', userPrompt: 'u' });

      const summaries = adapter.getCallSummaries();
      expect(summaries[0].caller).toBe('unknown');
    });

    it('tracks multiple calls with different callers', async () => {
      adapter.setContext({ gameId: 'g1', playerId: 'p1', turn: 1, caller: 'trip-planner', method: 'planTrip' });
      await adapter.chat({ model: 'm', maxTokens: 100, temperature: 0, systemPrompt: 's', userPrompt: 'u1' });

      adapter.setContext({ gameId: 'g1', playerId: 'p1', turn: 1, caller: 'build-advisor', method: 'adviseBuild' });
      await adapter.chat({ model: 'm', maxTokens: 100, temperature: 0, systemPrompt: 's', userPrompt: 'u2' });

      const summaries = adapter.getCallSummaries();
      expect(summaries).toHaveLength(2);
      expect(summaries[0].caller).toBe('trip-planner');
      expect(summaries[1].caller).toBe('build-advisor');
    });

    it('still records summary when chat() throws', async () => {
      mockInner.chat.mockRejectedValueOnce(new Error('LLM timeout'));
      adapter.setContext({ gameId: 'g1', playerId: 'p1', turn: 1, caller: 'test', method: 'test' });

      await expect(
        adapter.chat({ model: 'm', maxTokens: 100, temperature: 0, systemPrompt: 's', userPrompt: 'u' }),
      ).rejects.toThrow('LLM timeout');

      const summaries = adapter.getCallSummaries();
      expect(summaries).toHaveLength(1);
      expect(summaries[0].caller).toBe('test');
    });
  });

  describe('llmSummary aggregation logic', () => {
    it('builds correct summary from multiple call summaries', () => {
      const summaries: LLMCallSummary[] = [
        { callId: 'id-1', caller: 'trip-planner', latencyMs: 800, tokenUsage: { input: 2000, output: 300 } },
        { callId: 'id-2', caller: 'build-advisor', latencyMs: 650, tokenUsage: { input: 1200, output: 180 } },
      ];

      const llmSummary = {
        callCount: summaries.length,
        totalLatencyMs: summaries.reduce((sum, s) => sum + s.latencyMs, 0),
        totalTokens: {
          input: summaries.reduce((sum, s) => sum + (s.tokenUsage?.input ?? 0), 0),
          output: summaries.reduce((sum, s) => sum + (s.tokenUsage?.output ?? 0), 0),
        },
        callers: [...new Set(summaries.map(s => s.caller))],
      };

      expect(llmSummary).toEqual({
        callCount: 2,
        totalLatencyMs: 1450,
        totalTokens: { input: 3200, output: 480 },
        callers: ['trip-planner', 'build-advisor'],
      });
    });

    it('deduplicates callers', () => {
      const summaries: LLMCallSummary[] = [
        { callId: 'id-1', caller: 'strategy-brain', latencyMs: 500, tokenUsage: { input: 1000, output: 200 } },
        { callId: 'id-2', caller: 'strategy-brain', latencyMs: 600, tokenUsage: { input: 1100, output: 250 } },
      ];

      const callers = [...new Set(summaries.map(s => s.caller))];
      expect(callers).toEqual(['strategy-brain']);
    });

    it('handles missing token usage', () => {
      const summaries: LLMCallSummary[] = [
        { callId: 'id-1', caller: 'test', latencyMs: 100 },
      ];

      const totalTokens = {
        input: summaries.reduce((sum, s) => sum + (s.tokenUsage?.input ?? 0), 0),
        output: summaries.reduce((sum, s) => sum + (s.tokenUsage?.output ?? 0), 0),
      };

      expect(totalTokens).toEqual({ input: 0, output: 0 });
    });
  });
});
