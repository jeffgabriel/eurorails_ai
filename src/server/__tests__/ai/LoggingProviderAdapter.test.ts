import { LoggingProviderAdapter } from '../../services/ai/LoggingProviderAdapter';
import { ProviderAdapter } from '../../services/ai/providers/ProviderAdapter';
import * as LLMTranscriptLogger from '../../services/ai/LLMTranscriptLogger';

let uuidCounter = 0;
jest.mock('crypto', () => ({
  randomUUID: () => `uuid-${++uuidCounter}`,
}));

jest.mock('../../services/ai/LLMTranscriptLogger', () => ({
  appendLLMCall: jest.fn(),
}));

const mockAppendLLMCall = LLMTranscriptLogger.appendLLMCall as jest.MockedFunction<typeof LLMTranscriptLogger.appendLLMCall>;

describe('LoggingProviderAdapter', () => {
  let mockInner: jest.Mocked<ProviderAdapter>;
  let adapter: LoggingProviderAdapter;

  const defaultRequest = {
    model: 'claude-haiku-4-5-20251001',
    maxTokens: 1024,
    temperature: 0.2,
    systemPrompt: 'You are a bot.',
    userPrompt: 'What should I do?',
  };

  const defaultResponse = {
    text: '{"action":"move"}',
    usage: { input: 100, output: 50 },
  };

  beforeEach(() => {
    jest.clearAllMocks();
    mockInner = {
      chat: jest.fn().mockResolvedValue(defaultResponse),
    };
    adapter = new LoggingProviderAdapter(mockInner);
  });

  describe('chat delegation', () => {
    it('should delegate to inner adapter and return the result', async () => {
      const result = await adapter.chat(defaultRequest);

      expect(mockInner.chat).toHaveBeenCalledWith(defaultRequest);
      expect(result).toEqual(defaultResponse);
    });

    it('should not alter the response data', async () => {
      const result = await adapter.chat(defaultRequest);

      expect(result.text).toBe(defaultResponse.text);
      expect(result.usage).toEqual(defaultResponse.usage);
    });
  });

  describe('context propagation', () => {
    it('should write transcript entry with context when setContext is called', async () => {
      adapter.setContext({
        gameId: 'game-123',
        playerId: 'player-1',
        turn: 1,
        caller: 'strategy-brain',
        method: 'decideAction',
      });

      await adapter.chat(defaultRequest);

      expect(mockAppendLLMCall).toHaveBeenCalledWith(
        'game-123',
        expect.objectContaining({
          gameId: 'game-123',
          playerId: 'player-1',
          turn: 1,
          caller: 'strategy-brain',
          method: 'decideAction',
          model: 'claude-haiku-4-5-20251001',
          systemPrompt: 'You are a bot.',
          userPrompt: 'What should I do?',
          responseText: '{"action":"move"}',
          status: 'success',
        }),
      );
    });

    it('should not write transcript when context is not set', async () => {
      await adapter.chat(defaultRequest);

      expect(mockAppendLLMCall).not.toHaveBeenCalled();
    });
  });

  describe('error propagation', () => {
    it('should re-throw errors from inner adapter', async () => {
      const error = new Error('LLM timeout');
      mockInner.chat.mockRejectedValue(error);

      adapter.setContext({
        gameId: 'game-123',
        playerId: 'player-1',
        turn: 1,
        caller: 'strategy-brain',
        method: 'decideAction',
      });

      await expect(adapter.chat(defaultRequest)).rejects.toThrow('LLM timeout');
    });

    it('should log error status in transcript on failure', async () => {
      mockInner.chat.mockRejectedValue(new Error('LLM timeout'));

      adapter.setContext({
        gameId: 'game-123',
        playerId: 'player-1',
        turn: 1,
        caller: 'strategy-brain',
        method: 'decideAction',
      });

      await expect(adapter.chat(defaultRequest)).rejects.toThrow();

      expect(mockAppendLLMCall).toHaveBeenCalledWith(
        'game-123',
        expect.objectContaining({
          status: 'error',
          error: 'LLM timeout',
          responseText: '',
        }),
      );
    });
  });

  describe('call ID management', () => {
    it('should accumulate call IDs across multiple chat calls', async () => {
      adapter.setContext({
        gameId: 'game-123',
        playerId: 'player-1',
        turn: 1,
        caller: 'strategy-brain',
        method: 'decideAction',
      });

      await adapter.chat(defaultRequest);
      await adapter.chat(defaultRequest);

      const ids = adapter.getCallIds();
      expect(ids).toHaveLength(2);
      expect(ids[0]).toMatch(/^uuid-/);
      expect(ids[1]).toMatch(/^uuid-/);
      expect(ids[0]).not.toBe(ids[1]);
    });

    it('should return a copy from getCallIds', async () => {
      adapter.setContext({
        gameId: 'game-123',
        playerId: 'player-1',
        turn: 1,
        caller: 'strategy-brain',
        method: 'decideAction',
      });

      await adapter.chat(defaultRequest);
      const ids = adapter.getCallIds();
      ids.push('mutated');

      expect(adapter.getCallIds()).toHaveLength(1);
    });

    it('should clear call IDs on resetCallIds', async () => {
      adapter.setContext({
        gameId: 'game-123',
        playerId: 'player-1',
        turn: 1,
        caller: 'strategy-brain',
        method: 'decideAction',
      });

      await adapter.chat(defaultRequest);
      expect(adapter.getCallIds()).toHaveLength(1);

      adapter.resetCallIds();
      expect(adapter.getCallIds()).toEqual([]);
    });
  });
});
