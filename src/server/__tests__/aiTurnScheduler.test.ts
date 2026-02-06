import { AITurnScheduler } from '../services/ai/AITurnScheduler';
import { AIStrategyEngine } from '../services/ai/AIStrategyEngine';
import { db } from '../db';
import { emitToGame, emitTurnChange, emitStatePatch } from '../services/socketService';

// Mock dependencies
jest.mock('../db', () => ({
  db: {
    query: jest.fn(),
  },
}));

jest.mock('../services/ai/AIStrategyEngine', () => ({
  AIStrategyEngine: {
    executeTurn: jest.fn(),
  },
}));

jest.mock('../services/socketService', () => ({
  emitToGame: jest.fn(),
  emitTurnChange: jest.fn(),
  emitStatePatch: jest.fn().mockResolvedValue(undefined),
}));

/** Flush all pending promises in the microtask queue */
function flushPromises(): Promise<void> {
  return new Promise(resolve => setImmediate(resolve));
}

describe('AITurnScheduler', () => {
  const gameId = 'game-123';

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('triggerIfAI', () => {
    it('returns false if the player at the index is human', async () => {
      (db.query as jest.Mock).mockResolvedValueOnce({
        rows: [{ id: 'human-1', is_ai: false }],
      });

      const result = await AITurnScheduler.triggerIfAI(gameId, 0);

      expect(result).toBe(false);
      expect(AIStrategyEngine.executeTurn).not.toHaveBeenCalled();
    });

    it('returns false if no player exists at the index', async () => {
      (db.query as jest.Mock).mockResolvedValueOnce({ rows: [] });

      const result = await AITurnScheduler.triggerIfAI(gameId, 5);

      expect(result).toBe(false);
    });

    it('returns true and triggers AI turn for AI player', async () => {
      (db.query as jest.Mock).mockResolvedValueOnce({
        rows: [{ id: 'bot-1', is_ai: true }],
      });
      (AIStrategyEngine.executeTurn as jest.Mock).mockResolvedValue({});
      // advanceToNextPlayer queries
      (db.query as jest.Mock)
        .mockResolvedValueOnce({ rows: [{ count: 3 }] }) // player count
        .mockResolvedValueOnce(undefined) // UPDATE games
        .mockResolvedValueOnce({ rows: [{ id: 'human-2', is_ai: false }] }); // next player

      const result = await AITurnScheduler.triggerIfAI(gameId, 1);

      expect(result).toBe(true);

      // Wait for the async fire-and-forget to complete
      await flushPromises();

      expect(AIStrategyEngine.executeTurn).toHaveBeenCalledWith(gameId, 'bot-1');
    });

    it('queries the player at the correct offset', async () => {
      (db.query as jest.Mock).mockResolvedValueOnce({
        rows: [{ id: 'bot-at-2', is_ai: true }],
      });
      (AIStrategyEngine.executeTurn as jest.Mock).mockResolvedValue({});
      (db.query as jest.Mock)
        .mockResolvedValueOnce({ rows: [{ count: 4 }] })
        .mockResolvedValueOnce(undefined)
        .mockResolvedValueOnce({ rows: [{ id: 'human-3', is_ai: false }] });

      await AITurnScheduler.triggerIfAI(gameId, 2);
      await flushPromises();

      // First call queries the player at offset 2
      expect(db.query).toHaveBeenCalledWith(
        expect.stringContaining('OFFSET $2'),
        [gameId, 2],
      );
    });
  });

  describe('AI turn execution', () => {
    it('advances to the next player after AI turn completes', async () => {
      // triggerIfAI — player is AI
      (db.query as jest.Mock).mockResolvedValueOnce({
        rows: [{ id: 'bot-1', is_ai: true }],
      });
      (AIStrategyEngine.executeTurn as jest.Mock).mockResolvedValue({});
      // advanceToNextPlayer
      (db.query as jest.Mock)
        .mockResolvedValueOnce({ rows: [{ count: 3 }] }) // player count
        .mockResolvedValueOnce(undefined) // UPDATE games
        .mockResolvedValueOnce({ rows: [{ id: 'human-2', is_ai: false }] }); // next player is human

      await AITurnScheduler.triggerIfAI(gameId, 0);
      await flushPromises();

      // Should have updated the game to index 1
      expect(db.query).toHaveBeenCalledWith(
        expect.stringContaining('UPDATE games SET current_player_index'),
        [1, gameId],
      );
      // Should emit turn change
      expect(emitTurnChange).toHaveBeenCalledWith(gameId, 1, 'human-2');
      expect(emitStatePatch).toHaveBeenCalledWith(gameId, { currentPlayerIndex: 1 });
    });

    it('wraps around player index when reaching the end', async () => {
      // triggerIfAI — player at index 2 (last of 3) is AI
      (db.query as jest.Mock).mockResolvedValueOnce({
        rows: [{ id: 'bot-last', is_ai: true }],
      });
      (AIStrategyEngine.executeTurn as jest.Mock).mockResolvedValue({});
      // advanceToNextPlayer
      (db.query as jest.Mock)
        .mockResolvedValueOnce({ rows: [{ count: 3 }] }) // 3 players
        .mockResolvedValueOnce(undefined) // UPDATE games
        .mockResolvedValueOnce({ rows: [{ id: 'human-0', is_ai: false }] }); // next player at index 0

      await AITurnScheduler.triggerIfAI(gameId, 2);
      await flushPromises();

      // (2 + 1) % 3 = 0
      expect(db.query).toHaveBeenCalledWith(
        expect.stringContaining('UPDATE games SET current_player_index'),
        [0, gameId],
      );
    });

    it('chains AI turns for consecutive bot players', async () => {
      // First AI trigger: player at index 0 is AI
      (db.query as jest.Mock).mockResolvedValueOnce({
        rows: [{ id: 'bot-0', is_ai: true }],
      });
      (AIStrategyEngine.executeTurn as jest.Mock)
        .mockResolvedValueOnce({}) // bot-0 turn
        .mockResolvedValueOnce({}); // bot-1 turn

      // advanceToNextPlayer from bot-0 (index 0)
      (db.query as jest.Mock)
        .mockResolvedValueOnce({ rows: [{ count: 3 }] }) // player count
        .mockResolvedValueOnce(undefined) // UPDATE games
        .mockResolvedValueOnce({ rows: [{ id: 'bot-1', is_ai: true }] }); // next is also AI!

      // advanceToNextPlayer from bot-1 (index 1)
      (db.query as jest.Mock)
        .mockResolvedValueOnce({ rows: [{ count: 3 }] }) // player count
        .mockResolvedValueOnce(undefined) // UPDATE games
        .mockResolvedValueOnce({ rows: [{ id: 'human-2', is_ai: false }] }); // next is human

      await AITurnScheduler.triggerIfAI(gameId, 0);
      // Need multiple flushes for the chained async calls
      await flushPromises();
      await flushPromises();
      await flushPromises();

      // Both AI players should have had their turns executed
      expect(AIStrategyEngine.executeTurn).toHaveBeenCalledTimes(2);
      expect(AIStrategyEngine.executeTurn).toHaveBeenCalledWith(gameId, 'bot-0');
      expect(AIStrategyEngine.executeTurn).toHaveBeenCalledWith(gameId, 'bot-1');
    });

    it('emits timeout event when AI turn exceeds timeout', async () => {
      (db.query as jest.Mock).mockResolvedValueOnce({
        rows: [{ id: 'slow-bot', is_ai: true }],
      });

      // executeTurn never resolves — simulates a stuck AI turn
      (AIStrategyEngine.executeTurn as jest.Mock).mockReturnValue(new Promise(() => {}));

      // Mock the private timeout to resolve immediately so the race finishes instantly
      jest.spyOn(AITurnScheduler as any, 'timeout').mockResolvedValue(undefined);

      // advanceToNextPlayer
      (db.query as jest.Mock)
        .mockResolvedValueOnce({ rows: [{ count: 2 }] })
        .mockResolvedValueOnce(undefined)
        .mockResolvedValueOnce({ rows: [{ id: 'human-1', is_ai: false }] });

      await AITurnScheduler.triggerIfAI(gameId, 0);
      await flushPromises();

      expect(emitToGame).toHaveBeenCalledWith(gameId, 'ai:turn-complete', expect.objectContaining({
        playerId: 'slow-bot',
        result: 'timeout',
      }));
    });

    it('handles AI engine errors gracefully', async () => {
      (db.query as jest.Mock).mockResolvedValueOnce({
        rows: [{ id: 'error-bot', is_ai: true }],
      });
      (AIStrategyEngine.executeTurn as jest.Mock).mockRejectedValue(
        new Error('Unexpected explosion'),
      );
      // advanceToNextPlayer
      (db.query as jest.Mock)
        .mockResolvedValueOnce({ rows: [{ count: 2 }] })
        .mockResolvedValueOnce(undefined)
        .mockResolvedValueOnce({ rows: [{ id: 'human-1', is_ai: false }] });

      const consoleSpy = jest.spyOn(console, 'error').mockImplementation();

      await AITurnScheduler.triggerIfAI(gameId, 0);
      await flushPromises();

      // Should still advance to next player despite error
      expect(emitTurnChange).toHaveBeenCalled();
      // Should emit error turn-complete event
      expect(emitToGame).toHaveBeenCalledWith(gameId, 'ai:turn-complete', expect.objectContaining({
        playerId: 'error-bot',
        result: 'error',
      }));

      consoleSpy.mockRestore();
    });
  });
});
