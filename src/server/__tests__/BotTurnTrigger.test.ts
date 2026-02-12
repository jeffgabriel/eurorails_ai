import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';

describe('BotTurnTrigger', () => {
  const originalEnv = process.env.ENABLE_AI_BOTS;

  afterEach(() => {
    // Restore original env
    if (originalEnv === undefined) {
      delete process.env.ENABLE_AI_BOTS;
    } else {
      process.env.ENABLE_AI_BOTS = originalEnv;
    }
    // Clear module cache so isAIBotsEnabled re-evaluates
    jest.resetModules();
  });

  describe('isAIBotsEnabled', () => {
    it('should return true when ENABLE_AI_BOTS is unset', async () => {
      delete process.env.ENABLE_AI_BOTS;
      const { isAIBotsEnabled } = await import('../services/ai/BotTurnTrigger');
      expect(isAIBotsEnabled()).toBe(true);
    });

    it('should return true when ENABLE_AI_BOTS is "true"', async () => {
      process.env.ENABLE_AI_BOTS = 'true';
      const { isAIBotsEnabled } = await import('../services/ai/BotTurnTrigger');
      expect(isAIBotsEnabled()).toBe(true);
    });

    it('should return false when ENABLE_AI_BOTS is "false"', async () => {
      process.env.ENABLE_AI_BOTS = 'false';
      const { isAIBotsEnabled } = await import('../services/ai/BotTurnTrigger');
      expect(isAIBotsEnabled()).toBe(false);
    });

    it('should return false when ENABLE_AI_BOTS is "FALSE" (case-insensitive)', async () => {
      process.env.ENABLE_AI_BOTS = 'FALSE';
      const { isAIBotsEnabled } = await import('../services/ai/BotTurnTrigger');
      expect(isAIBotsEnabled()).toBe(false);
    });

    it('should return true when ENABLE_AI_BOTS is empty string', async () => {
      process.env.ENABLE_AI_BOTS = '';
      const { isAIBotsEnabled } = await import('../services/ai/BotTurnTrigger');
      expect(isAIBotsEnabled()).toBe(true);
    });
  });

  describe('onTurnChange', () => {
    it('should return immediately when ENABLE_AI_BOTS is false', async () => {
      process.env.ENABLE_AI_BOTS = 'false';
      const { onTurnChange } = await import('../services/ai/BotTurnTrigger');

      // Should not throw — just returns immediately
      await expect(onTurnChange('game-1', 0, 'player-1')).resolves.toBeUndefined();
    });

    it('should proceed when ENABLE_AI_BOTS is true', async () => {
      process.env.ENABLE_AI_BOTS = 'true';
      const { onTurnChange } = await import('../services/ai/BotTurnTrigger');

      // Should not throw — proceeds into the (currently stub) logic
      await expect(onTurnChange('game-1', 0, 'player-1')).resolves.toBeUndefined();
    });
  });

  describe('onHumanReconnect', () => {
    it('should return immediately when ENABLE_AI_BOTS is false', async () => {
      process.env.ENABLE_AI_BOTS = 'false';
      const { onHumanReconnect } = await import('../services/ai/BotTurnTrigger');

      await expect(onHumanReconnect('game-1')).resolves.toBeUndefined();
    });
  });
});
