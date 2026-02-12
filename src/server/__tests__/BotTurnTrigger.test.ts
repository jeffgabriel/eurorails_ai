import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';

// Mock db before importing BotTurnTrigger
jest.mock('../db/index', () => ({
  db: {
    query: jest.fn(),
  },
}));

// Mock socketService
jest.mock('../services/socketService', () => ({
  emitToGame: jest.fn(),
  emitTurnChange: jest.fn(),
}));

// Mock playerService
jest.mock('../services/playerService', () => ({
  PlayerService: {
    updateCurrentPlayerIndex: jest.fn().mockResolvedValue(undefined),
  },
}));

import { db } from '../db/index';
import { emitToGame } from '../services/socketService';

const mockQuery = db.query as jest.MockedFunction<typeof db.query>;
const mockEmitToGame = emitToGame as jest.MockedFunction<typeof emitToGame>;

describe('BotTurnTrigger', () => {
  const originalEnv = process.env.ENABLE_AI_BOTS;

  beforeEach(() => {
    jest.useFakeTimers();
    jest.resetAllMocks();
    process.env.ENABLE_AI_BOTS = 'true';
  });

  afterEach(async () => {
    jest.useRealTimers();
    if (originalEnv === undefined) {
      delete process.env.ENABLE_AI_BOTS;
    } else {
      process.env.ENABLE_AI_BOTS = originalEnv;
    }
    // Clean up module state
    const { pendingBotTurns, queuedBotTurns } = await import('../services/ai/BotTurnTrigger');
    pendingBotTurns.clear();
    queuedBotTurns.clear();
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
      await onTurnChange('game-1', 0, 'player-1');
      expect(mockQuery).not.toHaveBeenCalled();
    });

    it('should return when player is not a bot', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ is_bot: false }], command: '', rowCount: 1, oid: 0, fields: [] });
      const { onTurnChange } = await import('../services/ai/BotTurnTrigger');
      await onTurnChange('game-1', 0, 'player-1');
      expect(mockQuery).toHaveBeenCalledTimes(1);
      expect(mockEmitToGame).not.toHaveBeenCalled();
    });

    it('should return when game status is completed', async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [{ is_bot: true }], command: '', rowCount: 1, oid: 0, fields: [] })
        .mockResolvedValueOnce({ rows: [{ status: 'completed' }], command: '', rowCount: 1, oid: 0, fields: [] });
      const { onTurnChange } = await import('../services/ai/BotTurnTrigger');
      await onTurnChange('game-1', 0, 'bot-1');
      expect(mockQuery).toHaveBeenCalledTimes(2);
      expect(mockEmitToGame).not.toHaveBeenCalled();
    });

    it('should return when game status is abandoned', async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [{ is_bot: true }], command: '', rowCount: 1, oid: 0, fields: [] })
        .mockResolvedValueOnce({ rows: [{ status: 'abandoned' }], command: '', rowCount: 1, oid: 0, fields: [] });
      const { onTurnChange } = await import('../services/ai/BotTurnTrigger');
      await onTurnChange('game-1', 0, 'bot-1');
      expect(mockEmitToGame).not.toHaveBeenCalled();
    });

    it('should execute bot turn with delay for bot player in active game', async () => {
      // is_bot query
      mockQuery.mockResolvedValueOnce({ rows: [{ is_bot: true }], command: '', rowCount: 1, oid: 0, fields: [] });
      // game status query
      mockQuery.mockResolvedValueOnce({ rows: [{ status: 'active' }], command: '', rowCount: 1, oid: 0, fields: [] });
      // turn number query
      mockQuery.mockResolvedValueOnce({ rows: [{ current_turn_number: 3 }], command: '', rowCount: 1, oid: 0, fields: [] });
      // UPDATE players (increment turn)
      mockQuery.mockResolvedValueOnce({ rows: [], command: 'UPDATE', rowCount: 1, oid: 0, fields: [] });
      // UPDATE player_tracks (reset build cost)
      mockQuery.mockResolvedValueOnce({ rows: [], command: 'UPDATE', rowCount: 1, oid: 0, fields: [] });
      // advanceTurnAfterBot: game status query
      mockQuery.mockResolvedValueOnce({ rows: [{ status: 'active', current_player_index: 0 }], command: '', rowCount: 1, oid: 0, fields: [] });
      // advanceTurnAfterBot: player count query
      mockQuery.mockResolvedValueOnce({ rows: [{ count: 3 }], command: '', rowCount: 1, oid: 0, fields: [] });

      const { onTurnChange } = await import('../services/ai/BotTurnTrigger');
      const promise = onTurnChange('game-1', 0, 'bot-1');

      // Advance past the delay
      await jest.advanceTimersByTimeAsync(1500);
      await promise;

      // Should have emitted bot:turn-start and bot:turn-complete
      expect(mockEmitToGame).toHaveBeenCalledWith('game-1', 'bot:turn-start', expect.objectContaining({
        botPlayerId: 'bot-1',
        turnNumber: 3,
      }));
      expect(mockEmitToGame).toHaveBeenCalledWith('game-1', 'bot:turn-complete', expect.objectContaining({
        botPlayerId: 'bot-1',
        action: 'PassTurn',
      }));
    });

    it('should prevent double execution with pendingBotTurns guard', async () => {
      const { onTurnChange, pendingBotTurns } = await import('../services/ai/BotTurnTrigger');

      // is_bot query for first call
      mockQuery.mockResolvedValueOnce({ rows: [{ is_bot: true }], command: '', rowCount: 1, oid: 0, fields: [] });
      // game status for first call
      mockQuery.mockResolvedValueOnce({ rows: [{ status: 'active' }], command: '', rowCount: 1, oid: 0, fields: [] });
      // turn number
      mockQuery.mockResolvedValueOnce({ rows: [{ current_turn_number: 1 }], command: '', rowCount: 1, oid: 0, fields: [] });
      // UPDATE x2
      mockQuery.mockResolvedValueOnce({ rows: [], command: 'UPDATE', rowCount: 1, oid: 0, fields: [] });
      mockQuery.mockResolvedValueOnce({ rows: [], command: 'UPDATE', rowCount: 1, oid: 0, fields: [] });
      // advanceTurnAfterBot queries
      mockQuery.mockResolvedValueOnce({ rows: [{ status: 'active', current_player_index: 0 }], command: '', rowCount: 1, oid: 0, fields: [] });
      mockQuery.mockResolvedValueOnce({ rows: [{ count: 2 }], command: '', rowCount: 1, oid: 0, fields: [] });

      // Second call should be blocked - set up its mocks
      mockQuery.mockResolvedValueOnce({ rows: [{ is_bot: true }], command: '', rowCount: 1, oid: 0, fields: [] });
      mockQuery.mockResolvedValueOnce({ rows: [{ status: 'active' }], command: '', rowCount: 1, oid: 0, fields: [] });

      const promise1 = onTurnChange('game-1', 0, 'bot-1');
      // Second call while first is pending
      const promise2 = onTurnChange('game-1', 0, 'bot-1');

      await jest.advanceTimersByTimeAsync(1500);
      await promise1;
      await promise2;

      // bot:turn-start should only be emitted once
      const startCalls = mockEmitToGame.mock.calls.filter(
        c => c[1] === 'bot:turn-start'
      );
      expect(startCalls).toHaveLength(1);
    });

    it('should clean up pendingBotTurns after execution', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ is_bot: true }], command: '', rowCount: 1, oid: 0, fields: [] });
      mockQuery.mockResolvedValueOnce({ rows: [{ status: 'active' }], command: '', rowCount: 1, oid: 0, fields: [] });
      mockQuery.mockResolvedValueOnce({ rows: [{ current_turn_number: 1 }], command: '', rowCount: 1, oid: 0, fields: [] });
      mockQuery.mockResolvedValueOnce({ rows: [], command: 'UPDATE', rowCount: 1, oid: 0, fields: [] });
      mockQuery.mockResolvedValueOnce({ rows: [], command: 'UPDATE', rowCount: 1, oid: 0, fields: [] });
      mockQuery.mockResolvedValueOnce({ rows: [{ status: 'active', current_player_index: 0 }], command: '', rowCount: 1, oid: 0, fields: [] });
      mockQuery.mockResolvedValueOnce({ rows: [{ count: 2 }], command: '', rowCount: 1, oid: 0, fields: [] });

      const { onTurnChange, pendingBotTurns } = await import('../services/ai/BotTurnTrigger');
      const promise = onTurnChange('game-1', 0, 'bot-1');

      // Flush microtasks so onTurnChange reaches pendingBotTurns.add() after its 2 await db.query() calls
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      expect(pendingBotTurns.has('game-1')).toBe(true);
      await jest.advanceTimersByTimeAsync(1500);
      await promise;
      expect(pendingBotTurns.has('game-1')).toBe(false);
    });

    it('should clean up pendingBotTurns even on error', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ is_bot: true }], command: '', rowCount: 1, oid: 0, fields: [] });
      mockQuery.mockResolvedValueOnce({ rows: [{ status: 'active' }], command: '', rowCount: 1, oid: 0, fields: [] });
      // Simulate error during turn number query
      mockQuery.mockRejectedValueOnce(new Error('DB connection lost'));

      const { onTurnChange, pendingBotTurns } = await import('../services/ai/BotTurnTrigger');
      const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

      const promise = onTurnChange('game-1', 0, 'bot-1');
      await jest.advanceTimersByTimeAsync(1500);
      await promise;

      expect(pendingBotTurns.has('game-1')).toBe(false);
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('Error executing bot turn'),
        expect.any(Error),
      );
      consoleSpy.mockRestore();
    });
  });

  describe('onHumanReconnect', () => {
    it('should return immediately when ENABLE_AI_BOTS is false', async () => {
      process.env.ENABLE_AI_BOTS = 'false';
      const { onHumanReconnect } = await import('../services/ai/BotTurnTrigger');
      await onHumanReconnect('game-1');
      expect(mockQuery).not.toHaveBeenCalled();
    });

    it('should do nothing when no queued turn exists', async () => {
      const { onHumanReconnect } = await import('../services/ai/BotTurnTrigger');
      await onHumanReconnect('game-1');
      expect(mockQuery).not.toHaveBeenCalled();
    });

    it('should dequeue and execute when queued turn exists', async () => {
      const { onHumanReconnect, queuedBotTurns } = await import('../services/ai/BotTurnTrigger');

      queuedBotTurns.set('game-1', {
        gameId: 'game-1',
        currentPlayerIndex: 0,
        currentPlayerId: 'bot-1',
      });

      // Set up mocks for the onTurnChange that will be called
      mockQuery.mockResolvedValueOnce({ rows: [{ is_bot: true }], command: '', rowCount: 1, oid: 0, fields: [] });
      mockQuery.mockResolvedValueOnce({ rows: [{ status: 'active' }], command: '', rowCount: 1, oid: 0, fields: [] });
      mockQuery.mockResolvedValueOnce({ rows: [{ current_turn_number: 1 }], command: '', rowCount: 1, oid: 0, fields: [] });
      mockQuery.mockResolvedValueOnce({ rows: [], command: 'UPDATE', rowCount: 1, oid: 0, fields: [] });
      mockQuery.mockResolvedValueOnce({ rows: [], command: 'UPDATE', rowCount: 1, oid: 0, fields: [] });
      mockQuery.mockResolvedValueOnce({ rows: [{ status: 'active', current_player_index: 0 }], command: '', rowCount: 1, oid: 0, fields: [] });
      mockQuery.mockResolvedValueOnce({ rows: [{ count: 2 }], command: '', rowCount: 1, oid: 0, fields: [] });

      const promise = onHumanReconnect('game-1');
      await jest.advanceTimersByTimeAsync(1500);
      await promise;

      expect(queuedBotTurns.has('game-1')).toBe(false);
      expect(mockEmitToGame).toHaveBeenCalledWith('game-1', 'bot:turn-start', expect.any(Object));
    });
  });

  describe('advanceTurnAfterBot', () => {
    beforeEach(() => {
      jest.useRealTimers();
    });

    afterEach(() => {
      jest.useFakeTimers();
    });

    it('should call PlayerService.updateCurrentPlayerIndex for active games', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ status: 'active', current_player_index: 1 }], command: '', rowCount: 1, oid: 0, fields: [] });
      mockQuery.mockResolvedValueOnce({ rows: [{ count: 3 }], command: '', rowCount: 1, oid: 0, fields: [] });

      const { advanceTurnAfterBot } = await import('../services/ai/BotTurnTrigger');
      const { PlayerService } = await import('../services/playerService');
      (PlayerService.updateCurrentPlayerIndex as jest.Mock).mockResolvedValue(undefined);

      await advanceTurnAfterBot('game-1');

      expect(PlayerService.updateCurrentPlayerIndex).toHaveBeenCalledWith('game-1', 2);
    });

    it('should wrap around player index for active games', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ status: 'active', current_player_index: 2 }], command: '', rowCount: 1, oid: 0, fields: [] });
      mockQuery.mockResolvedValueOnce({ rows: [{ count: 3 }], command: '', rowCount: 1, oid: 0, fields: [] });

      const { advanceTurnAfterBot } = await import('../services/ai/BotTurnTrigger');
      const { PlayerService } = await import('../services/playerService');
      (PlayerService.updateCurrentPlayerIndex as jest.Mock).mockResolvedValue(undefined);

      await advanceTurnAfterBot('game-1');

      expect(PlayerService.updateCurrentPlayerIndex).toHaveBeenCalledWith('game-1', 0);
    });

    it('should do nothing for completed games', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ status: 'completed', current_player_index: 0 }], command: '', rowCount: 1, oid: 0, fields: [] });

      const { advanceTurnAfterBot } = await import('../services/ai/BotTurnTrigger');
      const { PlayerService } = await import('../services/playerService');

      await advanceTurnAfterBot('game-1');

      expect(PlayerService.updateCurrentPlayerIndex).not.toHaveBeenCalled();
    });

    it('should do nothing for abandoned games', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ status: 'abandoned', current_player_index: 0 }], command: '', rowCount: 1, oid: 0, fields: [] });

      const { advanceTurnAfterBot } = await import('../services/ai/BotTurnTrigger');
      const { PlayerService } = await import('../services/playerService');

      await advanceTurnAfterBot('game-1');

      expect(PlayerService.updateCurrentPlayerIndex).not.toHaveBeenCalled();
    });

    it('should log for initialBuild games (placeholder)', async () => {
      const consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
      mockQuery.mockResolvedValueOnce({ rows: [{ status: 'initialBuild', current_player_index: 0 }], command: '', rowCount: 1, oid: 0, fields: [] });

      const { advanceTurnAfterBot } = await import('../services/ai/BotTurnTrigger');

      await advanceTurnAfterBot('game-1');

      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('initialBuild'));
      consoleSpy.mockRestore();
    });
  });
});
