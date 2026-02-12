import { describe, it, expect, beforeEach, jest } from '@jest/globals';

// Mock db before importing InitialBuildService
jest.mock('../db/index', () => ({
  db: {
    query: jest.fn(),
  },
}));

// Mock socketService
jest.mock('../services/socketService', () => ({
  emitTurnChange: jest.fn(),
  emitStatePatch: jest.fn().mockResolvedValue(undefined),
}));

import { db } from '../db/index';
import { emitTurnChange, emitStatePatch } from '../services/socketService';
import { InitialBuildService } from '../services/InitialBuildService';

const mockQuery = db.query as jest.MockedFunction<typeof db.query>;
const mockEmitTurnChange = emitTurnChange as jest.MockedFunction<typeof emitTurnChange>;
const mockEmitStatePatch = emitStatePatch as jest.MockedFunction<typeof emitStatePatch>;

// Helper to create a mock QueryResult
function mockResult(rows: any[]) {
  return { rows, command: '', rowCount: rows.length, oid: 0, fields: [] };
}

describe('InitialBuildService', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    (mockEmitStatePatch as jest.Mock).mockResolvedValue(undefined);
  });

  // Standard player ordering: [A, B, C] with indices [0, 1, 2]
  const gameId = 'game-1';
  const playerA = 'player-a';
  const playerB = 'player-b';
  const playerC = 'player-c';
  const standardPlayers = [
    { id: playerA },
    { id: playerB },
    { id: playerC },
  ];

  describe('setupInitialBuild', () => {
    it('should set game to initialBuild status with round 1', async () => {
      // Players query returns standard ordering
      mockQuery.mockResolvedValueOnce(mockResult(standardPlayers));
      // UPDATE query
      mockQuery.mockResolvedValueOnce(mockResult([]));

      await InitialBuildService.setupInitialBuild(gameId, [playerA, playerB, playerC]);

      // Verify UPDATE was called with correct values
      expect(mockQuery).toHaveBeenCalledTimes(2);
      const updateCall = mockQuery.mock.calls[1];
      expect(updateCall[0]).toContain("status = 'initialBuild'");
      expect(updateCall[0]).toContain('initial_build_round = 1');
      expect(updateCall[1]).toEqual([
        JSON.stringify([playerA, playerB, playerC]),
        0, // firstPlayerIndex = index of playerA in standard order
        gameId,
      ]);
    });

    it('should set current_player_index to the first player in order', async () => {
      // If we pass [B, A, C], the first player is B, who is at index 1 in standard order
      mockQuery.mockResolvedValueOnce(mockResult(standardPlayers));
      mockQuery.mockResolvedValueOnce(mockResult([]));

      await InitialBuildService.setupInitialBuild(gameId, [playerB, playerA, playerC]);

      const updateCall = mockQuery.mock.calls[1];
      expect(updateCall[1][1]).toBe(1); // playerB is index 1 in standard order
    });

    it('should emit turn:change for the first player', async () => {
      mockQuery.mockResolvedValueOnce(mockResult(standardPlayers));
      mockQuery.mockResolvedValueOnce(mockResult([]));

      await InitialBuildService.setupInitialBuild(gameId, [playerA, playerB, playerC]);

      expect(mockEmitTurnChange).toHaveBeenCalledWith(gameId, 0, playerA);
    });

    it('should throw when called with no players', async () => {
      await expect(
        InitialBuildService.setupInitialBuild(gameId, []),
      ).rejects.toThrow('Cannot setup initial build with no players');
    });
  });

  describe('advanceTurn', () => {
    describe('Round 1 progression', () => {
      it('should advance to next player within round 1', async () => {
        // Game state: round 1, order [A, B, C], current is A (index 0)
        mockQuery.mockResolvedValueOnce(mockResult([{
          status: 'initialBuild',
          initial_build_round: 1,
          initial_build_order: [playerA, playerB, playerC],
          current_player_index: 0,
        }]));
        // Players query
        mockQuery.mockResolvedValueOnce(mockResult(standardPlayers));
        // UPDATE query
        mockQuery.mockResolvedValueOnce(mockResult([]));

        await InitialBuildService.advanceTurn(gameId);

        // Should advance to playerB (index 1)
        const updateCall = mockQuery.mock.calls[2];
        expect(updateCall[1]).toEqual([1, gameId]);
        expect(mockEmitTurnChange).toHaveBeenCalledWith(gameId, 1, playerB);
      });

      it('should advance from second to third player in round 1', async () => {
        // Current is B (index 1), next should be C (index 2)
        mockQuery.mockResolvedValueOnce(mockResult([{
          status: 'initialBuild',
          initial_build_round: 1,
          initial_build_order: [playerA, playerB, playerC],
          current_player_index: 1,
        }]));
        mockQuery.mockResolvedValueOnce(mockResult(standardPlayers));
        mockQuery.mockResolvedValueOnce(mockResult([]));

        await InitialBuildService.advanceTurn(gameId);

        const updateCall = mockQuery.mock.calls[2];
        expect(updateCall[1]).toEqual([2, gameId]);
        expect(mockEmitTurnChange).toHaveBeenCalledWith(gameId, 2, playerC);
      });
    });

    describe('Round 1 to Round 2 transition', () => {
      it('should transition to round 2 with reversed order when last player in round 1 finishes', async () => {
        // Current is C (last in round 1 order [A, B, C])
        mockQuery.mockResolvedValueOnce(mockResult([{
          status: 'initialBuild',
          initial_build_round: 1,
          initial_build_order: [playerA, playerB, playerC],
          current_player_index: 2, // C is at standard index 2
        }]));
        mockQuery.mockResolvedValueOnce(mockResult(standardPlayers));
        mockQuery.mockResolvedValueOnce(mockResult([]));

        await InitialBuildService.advanceTurn(gameId);

        // Should set round 2 with reversed order [C, B, A]
        const updateCall = mockQuery.mock.calls[2];
        expect(updateCall[0]).toContain('initial_build_round = 2');
        expect(updateCall[1][0]).toBe(JSON.stringify([playerC, playerB, playerA]));
        // First player in reversed order is C (index 2)
        expect(updateCall[1][1]).toBe(2);
        expect(mockEmitTurnChange).toHaveBeenCalledWith(gameId, 2, playerC);
      });

      it('should reverse a 2-player order correctly', async () => {
        const twoPlayers = [{ id: playerA }, { id: playerB }];
        // Round 1 order [A, B], current is B (last)
        mockQuery.mockResolvedValueOnce(mockResult([{
          status: 'initialBuild',
          initial_build_round: 1,
          initial_build_order: [playerA, playerB],
          current_player_index: 1,
        }]));
        mockQuery.mockResolvedValueOnce(mockResult(twoPlayers));
        mockQuery.mockResolvedValueOnce(mockResult([]));

        await InitialBuildService.advanceTurn(gameId);

        const updateCall = mockQuery.mock.calls[2];
        expect(updateCall[1][0]).toBe(JSON.stringify([playerB, playerA]));
        // First in reversed order is B (index 1)
        expect(updateCall[1][1]).toBe(1);
        expect(mockEmitTurnChange).toHaveBeenCalledWith(gameId, 1, playerB);
      });
    });

    describe('Round 2 progression', () => {
      it('should advance to next player within round 2', async () => {
        // Round 2, order [C, B, A], current is C (index 2)
        mockQuery.mockResolvedValueOnce(mockResult([{
          status: 'initialBuild',
          initial_build_round: 2,
          initial_build_order: [playerC, playerB, playerA],
          current_player_index: 2, // C is at standard index 2
        }]));
        mockQuery.mockResolvedValueOnce(mockResult(standardPlayers));
        mockQuery.mockResolvedValueOnce(mockResult([]));

        await InitialBuildService.advanceTurn(gameId);

        // Next in order is B (index 1)
        const updateCall = mockQuery.mock.calls[2];
        expect(updateCall[1]).toEqual([1, gameId]);
        expect(mockEmitTurnChange).toHaveBeenCalledWith(gameId, 1, playerB);
      });

      it('should advance from second to third player in round 2', async () => {
        // Round 2, order [C, B, A], current is B (index 1)
        mockQuery.mockResolvedValueOnce(mockResult([{
          status: 'initialBuild',
          initial_build_round: 2,
          initial_build_order: [playerC, playerB, playerA],
          current_player_index: 1,
        }]));
        mockQuery.mockResolvedValueOnce(mockResult(standardPlayers));
        mockQuery.mockResolvedValueOnce(mockResult([]));

        await InitialBuildService.advanceTurn(gameId);

        // Next is A (index 0)
        const updateCall = mockQuery.mock.calls[2];
        expect(updateCall[1]).toEqual([0, gameId]);
        expect(mockEmitTurnChange).toHaveBeenCalledWith(gameId, 0, playerA);
      });
    });

    describe('Round 2 to Active transition', () => {
      it('should transition to active status when last player in round 2 finishes', async () => {
        // Round 2, order [C, B, A], current is A (last in round 2)
        mockQuery.mockResolvedValueOnce(mockResult([{
          status: 'initialBuild',
          initial_build_round: 2,
          initial_build_order: [playerC, playerB, playerA],
          current_player_index: 0, // A is at standard index 0
        }]));
        mockQuery.mockResolvedValueOnce(mockResult(standardPlayers));
        mockQuery.mockResolvedValueOnce(mockResult([]));

        await InitialBuildService.advanceTurn(gameId);

        const updateCall = mockQuery.mock.calls[2];
        expect(updateCall[0]).toContain("status = 'active'");
        expect(updateCall[0]).toContain('initial_build_round = 0');
        expect(updateCall[0]).toContain('initial_build_order = NULL');
      });

      it('should set current_player_index to the last player in round 2 (per game rules)', async () => {
        // Round 2, order [C, B, A], last player is A (index 0 in standard order)
        mockQuery.mockResolvedValueOnce(mockResult([{
          status: 'initialBuild',
          initial_build_round: 2,
          initial_build_order: [playerC, playerB, playerA],
          current_player_index: 0,
        }]));
        mockQuery.mockResolvedValueOnce(mockResult(standardPlayers));
        mockQuery.mockResolvedValueOnce(mockResult([]));

        await InitialBuildService.advanceTurn(gameId);

        // "The last player from the second building turn becomes the first player"
        const updateCall = mockQuery.mock.calls[2];
        expect(updateCall[1][0]).toBe(0); // playerA's index
        expect(mockEmitTurnChange).toHaveBeenCalledWith(gameId, 0, playerA);
      });

      it('should emit state:patch with active status', async () => {
        mockQuery.mockResolvedValueOnce(mockResult([{
          status: 'initialBuild',
          initial_build_round: 2,
          initial_build_order: [playerC, playerB, playerA],
          current_player_index: 0,
        }]));
        mockQuery.mockResolvedValueOnce(mockResult(standardPlayers));
        mockQuery.mockResolvedValueOnce(mockResult([]));

        await InitialBuildService.advanceTurn(gameId);

        expect(mockEmitStatePatch).toHaveBeenCalledWith(
          gameId,
          expect.objectContaining({ status: 'active' }),
        );
      });

      it('should not emit state:patch during round transitions', async () => {
        // Round 1 → Round 2 transition should NOT emit state:patch
        mockQuery.mockResolvedValueOnce(mockResult([{
          status: 'initialBuild',
          initial_build_round: 1,
          initial_build_order: [playerA, playerB, playerC],
          current_player_index: 2,
        }]));
        mockQuery.mockResolvedValueOnce(mockResult(standardPlayers));
        mockQuery.mockResolvedValueOnce(mockResult([]));

        await InitialBuildService.advanceTurn(gameId);

        expect(mockEmitStatePatch).not.toHaveBeenCalled();
      });
    });

    describe('error handling', () => {
      it('should throw when game is not found', async () => {
        mockQuery.mockResolvedValueOnce(mockResult([]));

        await expect(
          InitialBuildService.advanceTurn(gameId),
        ).rejects.toThrow('Game game-1 not found');
      });

      it('should throw when game is not in initialBuild phase', async () => {
        mockQuery.mockResolvedValueOnce(mockResult([{
          status: 'active',
          initial_build_round: 0,
          initial_build_order: null,
          current_player_index: 0,
        }]));

        await expect(
          InitialBuildService.advanceTurn(gameId),
        ).rejects.toThrow('not in initialBuild phase');
      });
    });

    describe('player index mapping', () => {
      it('should correctly map non-sequential player IDs to standard indices', async () => {
        // Standard order: [X, Y, Z] at indices [0, 1, 2]
        // Round 1 order: [Y, Z, X] — Y is first
        const playerX = 'player-x';
        const playerY = 'player-y';
        const playerZ = 'player-z';
        const players = [{ id: playerX }, { id: playerY }, { id: playerZ }];

        mockQuery.mockResolvedValueOnce(mockResult([{
          status: 'initialBuild',
          initial_build_round: 1,
          initial_build_order: [playerY, playerZ, playerX],
          current_player_index: 1, // Y is at standard index 1
        }]));
        mockQuery.mockResolvedValueOnce(mockResult(players));
        mockQuery.mockResolvedValueOnce(mockResult([]));

        await InitialBuildService.advanceTurn(gameId);

        // Next player is Z (index 2 in standard order)
        expect(mockEmitTurnChange).toHaveBeenCalledWith(gameId, 2, playerZ);
      });

      it('should handle single-player game (edge case)', async () => {
        // Single player, round 1, they just took their turn
        mockQuery.mockResolvedValueOnce(mockResult([{
          status: 'initialBuild',
          initial_build_round: 1,
          initial_build_order: [playerA],
          current_player_index: 0,
        }]));
        mockQuery.mockResolvedValueOnce(mockResult([{ id: playerA }]));
        mockQuery.mockResolvedValueOnce(mockResult([]));

        await InitialBuildService.advanceTurn(gameId);

        // Should transition to round 2
        const updateCall = mockQuery.mock.calls[2];
        expect(updateCall[0]).toContain('initial_build_round = 2');
      });
    });

    describe('DB query verification', () => {
      it('should query game state with correct SQL', async () => {
        mockQuery.mockResolvedValueOnce(mockResult([{
          status: 'initialBuild',
          initial_build_round: 1,
          initial_build_order: [playerA, playerB],
          current_player_index: 0,
        }]));
        mockQuery.mockResolvedValueOnce(mockResult([{ id: playerA }, { id: playerB }]));
        mockQuery.mockResolvedValueOnce(mockResult([]));

        await InitialBuildService.advanceTurn(gameId);

        // First query: game state
        expect(mockQuery.mock.calls[0][1]).toEqual([gameId]);
        // Second query: players
        expect(mockQuery.mock.calls[1][0]).toContain('ORDER BY created_at ASC');
        expect(mockQuery.mock.calls[1][1]).toEqual([gameId]);
      });
    });
  });
});
