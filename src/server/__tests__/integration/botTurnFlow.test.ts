import { describe, it, expect, beforeEach, jest } from '@jest/globals';

/**
 * Integration test: Bot Turn + Initial Build Flow
 *
 * Tests the interaction between InitialBuildService, BotTurnTrigger,
 * and the game state machine. Uses mocked DB and socket to verify
 * the full flow from game start through initialBuild to active.
 */

// Mock db before importing services
jest.mock('../../db/index', () => ({
  db: {
    query: jest.fn(),
  },
}));

// Mock socketService
jest.mock('../../services/socketService', () => ({
  emitTurnChange: jest.fn(),
  emitStatePatch: jest.fn().mockResolvedValue(undefined),
  emitToGame: jest.fn(),
}));

// Mock playerService
jest.mock('../../services/playerService', () => ({
  PlayerService: {
    updateCurrentPlayerIndex: jest.fn().mockResolvedValue(undefined),
  },
}));

import { db } from '../../db/index';
import { emitTurnChange, emitStatePatch, emitToGame } from '../../services/socketService';
import { InitialBuildService } from '../../services/InitialBuildService';
import {
  onTurnChange,
  advanceTurnAfterBot,
  pendingBotTurns,
  queuedBotTurns,
} from '../../services/ai/BotTurnTrigger';

const mockQuery = db.query as jest.MockedFunction<typeof db.query>;
const mockEmitTurnChange = emitTurnChange as jest.MockedFunction<typeof emitTurnChange>;
const mockEmitStatePatch = emitStatePatch as jest.MockedFunction<typeof emitStatePatch>;
const mockEmitToGame = emitToGame as jest.MockedFunction<typeof emitToGame>;

function mockResult(rows: any[]) {
  return { rows, command: '', rowCount: rows.length, oid: 0, fields: [] };
}

describe('Bot Turn + Initial Build Flow (Integration)', () => {
  const gameId = 'game-flow-1';
  const humanId = 'human-alice';
  const bot1Id = 'bot-heinrich';
  const bot2Id = 'bot-marie';

  // Standard player ordering (by created_at ASC)
  const allPlayers = [
    { id: humanId },
    { id: bot1Id },
    { id: bot2Id },
  ];

  beforeEach(() => {
    jest.resetAllMocks();
    (mockEmitStatePatch as jest.Mock).mockResolvedValue(undefined);
    process.env.ENABLE_AI_BOTS = 'true';
    pendingBotTurns.clear();
    queuedBotTurns.clear();
  });

  describe('setupInitialBuild', () => {
    it('should initialize game in initialBuild status with round 1 clockwise order', async () => {
      // Players query (standard ordering)
      mockQuery.mockResolvedValueOnce(mockResult(allPlayers));
      // UPDATE games
      mockQuery.mockResolvedValueOnce(mockResult([]));

      await InitialBuildService.setupInitialBuild(gameId, [humanId, bot1Id, bot2Id]);

      // Verify game set to initialBuild
      const updateCall = mockQuery.mock.calls[1];
      expect(updateCall[0]).toContain("status = 'initialBuild'");
      expect(updateCall[0]).toContain('initial_build_round = 1');
      expect(updateCall[1][0]).toBe(JSON.stringify([humanId, bot1Id, bot2Id]));

      // Verify turn:change emitted for first player (human at index 0)
      expect(mockEmitTurnChange).toHaveBeenCalledWith(gameId, 0, humanId);
    });
  });

  describe('initialBuild Round 1 progression', () => {
    it('should advance from human to bot1 within round 1', async () => {
      // Game state: round 1, order [human, bot1, bot2], current = human (index 0)
      mockQuery.mockResolvedValueOnce(mockResult([{
        status: 'initialBuild',
        initial_build_round: 1,
        initial_build_order: [humanId, bot1Id, bot2Id],
        current_player_index: 0,
      }]));
      mockQuery.mockResolvedValueOnce(mockResult(allPlayers));
      mockQuery.mockResolvedValueOnce(mockResult([]));

      await InitialBuildService.advanceTurn(gameId);

      // Should advance to bot1 (index 1)
      expect(mockEmitTurnChange).toHaveBeenCalledWith(gameId, 1, bot1Id);
    });

    it('should advance from bot1 to bot2 within round 1', async () => {
      mockQuery.mockResolvedValueOnce(mockResult([{
        status: 'initialBuild',
        initial_build_round: 1,
        initial_build_order: [humanId, bot1Id, bot2Id],
        current_player_index: 1,
      }]));
      mockQuery.mockResolvedValueOnce(mockResult(allPlayers));
      mockQuery.mockResolvedValueOnce(mockResult([]));

      await InitialBuildService.advanceTurn(gameId);

      // Should advance to bot2 (index 2)
      expect(mockEmitTurnChange).toHaveBeenCalledWith(gameId, 2, bot2Id);
    });
  });

  describe('Round 1 to Round 2 transition', () => {
    it('should transition to round 2 with reversed order after last player in round 1', async () => {
      // bot2 is last in round 1 order [human, bot1, bot2]
      mockQuery.mockResolvedValueOnce(mockResult([{
        status: 'initialBuild',
        initial_build_round: 1,
        initial_build_order: [humanId, bot1Id, bot2Id],
        current_player_index: 2,
      }]));
      mockQuery.mockResolvedValueOnce(mockResult(allPlayers));
      mockQuery.mockResolvedValueOnce(mockResult([]));

      await InitialBuildService.advanceTurn(gameId);

      // Reversed order: [bot2, bot1, human]
      const updateCall = mockQuery.mock.calls[2];
      expect(updateCall[0]).toContain('initial_build_round = 2');
      expect(updateCall[1][0]).toBe(JSON.stringify([bot2Id, bot1Id, humanId]));

      // First player in round 2 is bot2 (index 2)
      expect(mockEmitTurnChange).toHaveBeenCalledWith(gameId, 2, bot2Id);
    });
  });

  describe('initialBuild Round 2 progression', () => {
    it('should advance from bot2 to bot1 within round 2', async () => {
      // Round 2 order: [bot2, bot1, human]
      mockQuery.mockResolvedValueOnce(mockResult([{
        status: 'initialBuild',
        initial_build_round: 2,
        initial_build_order: [bot2Id, bot1Id, humanId],
        current_player_index: 2, // bot2 is at standard index 2
      }]));
      mockQuery.mockResolvedValueOnce(mockResult(allPlayers));
      mockQuery.mockResolvedValueOnce(mockResult([]));

      await InitialBuildService.advanceTurn(gameId);

      // Next is bot1 (index 1)
      expect(mockEmitTurnChange).toHaveBeenCalledWith(gameId, 1, bot1Id);
    });

    it('should advance from bot1 to human within round 2', async () => {
      mockQuery.mockResolvedValueOnce(mockResult([{
        status: 'initialBuild',
        initial_build_round: 2,
        initial_build_order: [bot2Id, bot1Id, humanId],
        current_player_index: 1, // bot1
      }]));
      mockQuery.mockResolvedValueOnce(mockResult(allPlayers));
      mockQuery.mockResolvedValueOnce(mockResult([]));

      await InitialBuildService.advanceTurn(gameId);

      // Next is human (index 0)
      expect(mockEmitTurnChange).toHaveBeenCalledWith(gameId, 0, humanId);
    });
  });

  describe('Round 2 to Active transition', () => {
    it('should transition to active status after last player in round 2', async () => {
      // human is last in round 2 order [bot2, bot1, human]
      mockQuery.mockResolvedValueOnce(mockResult([{
        status: 'initialBuild',
        initial_build_round: 2,
        initial_build_order: [bot2Id, bot1Id, humanId],
        current_player_index: 0, // human is at standard index 0
      }]));
      mockQuery.mockResolvedValueOnce(mockResult(allPlayers));
      mockQuery.mockResolvedValueOnce(mockResult([]));

      await InitialBuildService.advanceTurn(gameId);

      // Should transition to active
      const updateCall = mockQuery.mock.calls[2];
      expect(updateCall[0]).toContain("status = 'active'");
      expect(updateCall[0]).toContain('initial_build_round = 0');
      expect(updateCall[0]).toContain('initial_build_order = NULL');

      // State patch emitted for status change
      expect(mockEmitStatePatch).toHaveBeenCalledWith(
        gameId,
        expect.objectContaining({ status: 'active' }),
      );
    });
  });

  describe('BotTurnTrigger interaction', () => {
    it('should detect bot and emit turn events when bot turn triggers', async () => {
      jest.useFakeTimers();

      // is_bot check
      mockQuery.mockResolvedValueOnce(mockResult([{ is_bot: true }]));
      // game status check
      mockQuery.mockResolvedValueOnce(mockResult([{ status: 'initialBuild' }]));
      // turn number query
      mockQuery.mockResolvedValueOnce(mockResult([{ current_turn_number: 1 }]));
      // UPDATE players (increment turn)
      mockQuery.mockResolvedValueOnce(mockResult([]));
      // UPDATE player_tracks (reset build cost)
      mockQuery.mockResolvedValueOnce(mockResult([]));
      // advanceTurnAfterBot: game status query
      mockQuery.mockResolvedValueOnce(mockResult([{
        status: 'initialBuild',
        current_player_index: 1,
      }]));

      const promise = onTurnChange(gameId, 1, bot1Id);
      await jest.advanceTimersByTimeAsync(1500);
      await promise;

      // Should emit bot:turn-start and bot:turn-complete
      expect(mockEmitToGame).toHaveBeenCalledWith(gameId, 'bot:turn-start', expect.objectContaining({
        botPlayerId: bot1Id,
        turnNumber: 1,
      }));
      expect(mockEmitToGame).toHaveBeenCalledWith(gameId, 'bot:turn-complete', expect.objectContaining({
        botPlayerId: bot1Id,
        action: 'PassTurn',
      }));

      jest.useRealTimers();
    });

    it('should increment turn number and reset build cost during bot turn', async () => {
      jest.useFakeTimers();

      mockQuery.mockResolvedValueOnce(mockResult([{ is_bot: true }]));
      mockQuery.mockResolvedValueOnce(mockResult([{ status: 'active' }]));
      mockQuery.mockResolvedValueOnce(mockResult([{ current_turn_number: 3 }]));
      mockQuery.mockResolvedValueOnce(mockResult([])); // UPDATE players
      mockQuery.mockResolvedValueOnce(mockResult([])); // UPDATE player_tracks
      mockQuery.mockResolvedValueOnce(mockResult([{ status: 'active', current_player_index: 1 }]));
      mockQuery.mockResolvedValueOnce(mockResult([{ count: 3 }]));

      const promise = onTurnChange(gameId, 1, bot1Id);
      await jest.advanceTimersByTimeAsync(1500);
      await promise;

      // Verify turn number increment
      const incrementCall = mockQuery.mock.calls[3];
      expect(incrementCall[0]).toContain('current_turn_number');
      expect(incrementCall[1]).toEqual([bot1Id]);

      // Verify build cost reset
      const resetCall = mockQuery.mock.calls[4];
      expect(resetCall[0]).toContain('turn_build_cost = 0');
      expect(resetCall[1]).toEqual([gameId, bot1Id]);

      jest.useRealTimers();
    });

    it('should skip non-bot players', async () => {
      jest.useFakeTimers();

      // is_bot check returns false for human
      mockQuery.mockResolvedValueOnce(mockResult([{ is_bot: false }]));

      await onTurnChange(gameId, 0, humanId);

      // No socket events should be emitted
      expect(mockEmitToGame).not.toHaveBeenCalled();

      jest.useRealTimers();
    });

    it('should not trigger when ENABLE_AI_BOTS is false', async () => {
      process.env.ENABLE_AI_BOTS = 'false';

      await onTurnChange(gameId, 1, bot1Id);

      expect(mockQuery).not.toHaveBeenCalled();
      expect(mockEmitToGame).not.toHaveBeenCalled();
    });
  });

  describe('advanceTurnAfterBot routing', () => {
    it('should route to PlayerService for active games', async () => {
      mockQuery.mockResolvedValueOnce(mockResult([{
        status: 'active',
        current_player_index: 1,
      }]));
      mockQuery.mockResolvedValueOnce(mockResult([{ count: 3 }]));

      const { PlayerService } = await import('../../services/playerService');
      (PlayerService.updateCurrentPlayerIndex as jest.Mock).mockResolvedValue(undefined);

      await advanceTurnAfterBot(gameId);

      expect(PlayerService.updateCurrentPlayerIndex).toHaveBeenCalledWith(gameId, 2);
    });

    it('should log placeholder for initialBuild games (routing not yet wired)', async () => {
      const consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

      mockQuery.mockResolvedValueOnce(mockResult([{
        status: 'initialBuild',
        current_player_index: 1,
      }]));

      await advanceTurnAfterBot(gameId);

      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('initialBuild'));
      consoleSpy.mockRestore();
    });

    it('should not advance for completed games', async () => {
      mockQuery.mockResolvedValueOnce(mockResult([{
        status: 'completed',
        current_player_index: 0,
      }]));

      const { PlayerService } = await import('../../services/playerService');
      await advanceTurnAfterBot(gameId);

      expect(PlayerService.updateCurrentPlayerIndex).not.toHaveBeenCalled();
    });
  });

  describe('full initialBuild cycle (1 human + 2 bots)', () => {
    it('should track correct player sequence through both rounds', async () => {
      // Verify the expected turn sequence for round 1 and round 2
      // Round 1: human(0) → bot1(1) → bot2(2)
      // Round 2: bot2(2) → bot1(1) → human(0)

      const emittedTurns: Array<{ index: number; playerId: string }> = [];

      // Track all emitTurnChange calls
      mockEmitTurnChange.mockImplementation((_gameId, index, playerId) => {
        emittedTurns.push({ index, playerId: playerId || '' });
      });

      // Round 1: human → bot1
      mockQuery.mockResolvedValueOnce(mockResult([{
        status: 'initialBuild', initial_build_round: 1,
        initial_build_order: [humanId, bot1Id, bot2Id], current_player_index: 0,
      }]));
      mockQuery.mockResolvedValueOnce(mockResult(allPlayers));
      mockQuery.mockResolvedValueOnce(mockResult([]));
      await InitialBuildService.advanceTurn(gameId);

      // Round 1: bot1 → bot2
      mockQuery.mockResolvedValueOnce(mockResult([{
        status: 'initialBuild', initial_build_round: 1,
        initial_build_order: [humanId, bot1Id, bot2Id], current_player_index: 1,
      }]));
      mockQuery.mockResolvedValueOnce(mockResult(allPlayers));
      mockQuery.mockResolvedValueOnce(mockResult([]));
      await InitialBuildService.advanceTurn(gameId);

      // Round 1 → Round 2 transition
      mockQuery.mockResolvedValueOnce(mockResult([{
        status: 'initialBuild', initial_build_round: 1,
        initial_build_order: [humanId, bot1Id, bot2Id], current_player_index: 2,
      }]));
      mockQuery.mockResolvedValueOnce(mockResult(allPlayers));
      mockQuery.mockResolvedValueOnce(mockResult([]));
      await InitialBuildService.advanceTurn(gameId);

      // Round 2: bot2 → bot1
      mockQuery.mockResolvedValueOnce(mockResult([{
        status: 'initialBuild', initial_build_round: 2,
        initial_build_order: [bot2Id, bot1Id, humanId], current_player_index: 2,
      }]));
      mockQuery.mockResolvedValueOnce(mockResult(allPlayers));
      mockQuery.mockResolvedValueOnce(mockResult([]));
      await InitialBuildService.advanceTurn(gameId);

      // Round 2: bot1 → human
      mockQuery.mockResolvedValueOnce(mockResult([{
        status: 'initialBuild', initial_build_round: 2,
        initial_build_order: [bot2Id, bot1Id, humanId], current_player_index: 1,
      }]));
      mockQuery.mockResolvedValueOnce(mockResult(allPlayers));
      mockQuery.mockResolvedValueOnce(mockResult([]));
      await InitialBuildService.advanceTurn(gameId);

      // Round 2 → Active transition
      mockQuery.mockResolvedValueOnce(mockResult([{
        status: 'initialBuild', initial_build_round: 2,
        initial_build_order: [bot2Id, bot1Id, humanId], current_player_index: 0,
      }]));
      mockQuery.mockResolvedValueOnce(mockResult(allPlayers));
      mockQuery.mockResolvedValueOnce(mockResult([]));
      await InitialBuildService.advanceTurn(gameId);

      // Verify the exact turn sequence
      expect(emittedTurns).toEqual([
        { index: 1, playerId: bot1Id },   // R1: human → bot1
        { index: 2, playerId: bot2Id },   // R1: bot1 → bot2
        { index: 2, playerId: bot2Id },   // R2 start: bot2 first (reversed)
        { index: 1, playerId: bot1Id },   // R2: bot2 → bot1
        { index: 0, playerId: humanId },  // R2: bot1 → human
        { index: 0, playerId: humanId },  // Active: human is first player
      ]);

      // Verify state:patch was emitted only once (active transition)
      expect(mockEmitStatePatch).toHaveBeenCalledTimes(1);
      expect(mockEmitStatePatch).toHaveBeenCalledWith(
        gameId,
        expect.objectContaining({ status: 'active' }),
      );
    });
  });
});
