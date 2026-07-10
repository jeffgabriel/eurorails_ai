/**
 * Verifies that the game-end call sites are wired to cleanupGameState:
 *   - VictoryService.resolveVictory() cleans up when a game is truly over.
 *   - PlayerService.updateGameStatus() cleans up on 'completed'/'abandoned'.
 *
 * db and gameCleanupService are mocked so these run without a real database
 * and assert only the orchestration wiring (the cleanup itself is covered by
 * gameCleanupService.test.ts).
 */
jest.mock('../db/index', () => ({
  db: { query: jest.fn() },
}));
jest.mock('../services/gameCleanupService', () => ({
  cleanupGameState: jest.fn().mockResolvedValue(undefined),
}));

import { db } from '../db/index';
import { cleanupGameState } from '../services/gameCleanupService';
import { VictoryService } from '../services/victoryService';
import { PlayerService } from '../services/playerService';
import { GameStatus } from '../../shared/types/GameTypes';

const mockQuery = db.query as jest.Mock;
const cleanupMock = cleanupGameState as jest.Mock;

describe('game-end cleanup wiring', () => {
  const gameId = 'game-wiring';

  beforeEach(() => {
    jest.clearAllMocks();
    mockQuery.mockResolvedValue({ rows: [] });
  });

  describe('VictoryService.resolveVictory', () => {
    it('cleans up per-game state when there is a clear winner', async () => {
      mockQuery
        .mockResolvedValueOnce({
          rows: [{ id: 'winner-1', name: 'Winner', money: 300, debt_owed: 0, net_worth: 300 }],
        }) // players
        .mockResolvedValueOnce({ rows: [{ victory_threshold: 250 }] }) // games threshold
        .mockResolvedValueOnce({ rows: [] }); // UPDATE games ... completed

      const result = await VictoryService.resolveVictory(gameId);

      expect(result.gameOver).toBe(true);
      expect(cleanupMock).toHaveBeenCalledTimes(1);
      expect(cleanupMock).toHaveBeenCalledWith(gameId);
    });

    it('does not clean up when no player meets the threshold (game not over)', async () => {
      mockQuery
        .mockResolvedValueOnce({
          rows: [{ id: 'p1', name: 'P1', money: 100, debt_owed: 0, net_worth: 100 }],
        }) // players
        .mockResolvedValueOnce({ rows: [{ victory_threshold: 250 }] }); // games threshold

      const result = await VictoryService.resolveVictory(gameId);

      expect(result.gameOver).toBe(false);
      expect(cleanupMock).not.toHaveBeenCalled();
    });
  });

  describe('PlayerService.updateGameStatus', () => {
    it('cleans up when the game transitions to completed', async () => {
      await PlayerService.updateGameStatus(gameId, 'completed' as GameStatus);

      expect(cleanupMock).toHaveBeenCalledTimes(1);
      expect(cleanupMock).toHaveBeenCalledWith(gameId);
    });

    it('cleans up when the game transitions to abandoned', async () => {
      await PlayerService.updateGameStatus(gameId, 'abandoned' as GameStatus);

      expect(cleanupMock).toHaveBeenCalledTimes(1);
      expect(cleanupMock).toHaveBeenCalledWith(gameId);
    });

    it('does not clean up for a non-terminal status', async () => {
      await PlayerService.updateGameStatus(gameId, 'active' as GameStatus);

      expect(cleanupMock).not.toHaveBeenCalled();
    });
  });
});
