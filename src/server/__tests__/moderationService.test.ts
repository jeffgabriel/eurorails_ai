/**
 * ModerationService Unit Tests
 * Tests for content moderation via Llama Guard model served by Ollama.
 * Llama Guard 3 returns binary "safe" / "unsafe\nS10" responses.
 */

import { ModerationService } from '../services/moderationService';

// Helper to create a mock fetch response
function mockFetchResponse(body: any, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as Response;
}

describe('ModerationService', () => {
  let service: ModerationService;
  const originalFetch = global.fetch;

  beforeEach(() => {
    service = new ModerationService();
    global.fetch = jest.fn();
  });

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  describe('initialize', () => {
    it('should initialize successfully when Ollama has the model', async () => {
      (global.fetch as jest.Mock).mockResolvedValue(
        mockFetchResponse({ name: 'llama-guard3:1b' })
      );

      await service.initialize(1000);

      expect(service.isReady()).toBe(true);
      expect(global.fetch).toHaveBeenCalledWith(
        'http://localhost:11434/api/show',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ name: 'llama-guard3:1b' }),
        })
      );
    });

    it('should skip if already initialized', async () => {
      (global.fetch as jest.Mock).mockResolvedValue(
        mockFetchResponse({ name: 'llama-guard3:1b' })
      );

      await service.initialize(1000);
      await service.initialize(1000);

      expect(global.fetch).toHaveBeenCalledTimes(1);
    });

    it('should throw when Ollama server is unreachable', async () => {
      (global.fetch as jest.Mock).mockRejectedValue(new Error('ECONNREFUSED'));

      await expect(service.initialize(0)).rejects.toThrow(
        'MODERATION_INITIALIZATION_FAILED'
      );
      expect(service.isReady()).toBe(false);
    });

    it('should throw when model is not found', async () => {
      (global.fetch as jest.Mock).mockResolvedValue(
        mockFetchResponse({ error: 'model not found' }, 404)
      );

      await expect(service.initialize(0)).rejects.toThrow(
        'MODERATION_INITIALIZATION_FAILED'
      );
      expect(service.isReady()).toBe(false);
    });
  });

  describe('checkMessage', () => {
    beforeEach(async () => {
      (global.fetch as jest.Mock).mockResolvedValueOnce(
        mockFetchResponse({ name: 'llama-guard3:1b' })
      );
      await service.initialize(1000);
    });

    it('should reject empty messages', async () => {
      const result = await service.checkMessage('');

      expect(result.isAppropriate).toBe(false);
      expect(result.violatedCategories).toEqual([]);
    });

    it('should reject whitespace-only messages', async () => {
      const result = await service.checkMessage('   ');

      expect(result.isAppropriate).toBe(false);
    });

    it('should approve safe messages', async () => {
      (global.fetch as jest.Mock).mockResolvedValueOnce(
        mockFetchResponse({ response: 'safe' })
      );

      const result = await service.checkMessage('Hello, how are you?');

      expect(result.isAppropriate).toBe(true);
      expect(result.violatedCategories).toEqual([]);
    });

    it('should reject unsafe messages with category', async () => {
      (global.fetch as jest.Mock).mockResolvedValueOnce(
        mockFetchResponse({ response: 'unsafe\nS10' })
      );

      const result = await service.checkMessage('some hateful content');

      expect(result.isAppropriate).toBe(false);
      expect(result.violatedCategories).toEqual(['S10']);
    });

    it('should reject unsafe messages with multiple categories', async () => {
      (global.fetch as jest.Mock).mockResolvedValueOnce(
        mockFetchResponse({ response: 'unsafe\nS1,S10' })
      );

      const result = await service.checkMessage('violent and hateful content');

      expect(result.isAppropriate).toBe(false);
      expect(result.violatedCategories).toEqual(['S1', 'S10']);
    });

    it('should fail closed on API error', async () => {
      (global.fetch as jest.Mock).mockResolvedValueOnce(
        mockFetchResponse({ error: 'internal error' }, 500)
      );

      const result = await service.checkMessage('test message');

      expect(result.isAppropriate).toBe(false);
    });

    it('should fail closed on network error', async () => {
      (global.fetch as jest.Mock).mockRejectedValueOnce(
        new Error('ECONNREFUSED')
      );

      const result = await service.checkMessage('test message');

      expect(result.isAppropriate).toBe(false);
    });

    it('should fail closed on unparseable response', async () => {
      (global.fetch as jest.Mock).mockResolvedValueOnce(
        mockFetchResponse({ response: 'gibberish output' })
      );

      const result = await service.checkMessage('test message');

      expect(result.isAppropriate).toBe(false);
    });

    it('should send correct prompt format to Ollama', async () => {
      (global.fetch as jest.Mock).mockResolvedValueOnce(
        mockFetchResponse({ response: 'safe' })
      );

      await service.checkMessage('Hello world');

      const generateCall = (global.fetch as jest.Mock).mock.calls.find(
        (call: any[]) => call[0].includes('/api/generate')
      );
      expect(generateCall).toBeDefined();

      const body = JSON.parse(generateCall[1].body);
      expect(body.model).toBe('llama-guard3:1b');
      expect(body.stream).toBe(false);
      expect(body.prompt).toContain('Hello world');
      expect(body.prompt).toContain('<BEGIN UNSAFE CONTENT CATEGORIES>');
      expect(body.prompt).toContain('<END UNSAFE CONTENT CATEGORIES>');
    });
  });

  describe('checkMessage - not initialized', () => {
    it('should throw MODERATION_NOT_INITIALIZED', async () => {
      await expect(service.checkMessage('test')).rejects.toThrow(
        'MODERATION_NOT_INITIALIZED'
      );
    });
  });

  describe('getHealthStatus', () => {
    it('should return Ollama config', () => {
      const status = service.getHealthStatus();

      expect(status.initialized).toBe(false);
      expect(status.ollamaUrl).toBe('http://localhost:11434');
      expect(status.modelName).toBe('llama-guard3:1b');
    });
  });
});
