import { describe, it, expect, beforeEach, jest } from '@jest/globals';

// Mock db before importing InitialBuildService
jest.mock('../db/index', () => ({
  db: {
    query: jest.fn<() => Promise<any>>(),
    connect: jest.fn<() => Promise<any>>(),
  },
}));

// Mock socketService
jest.mock('../services/socketService', () => ({
  emitTurnChange: jest.fn<() => void>(),
  emitStatePatch: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
}));

import { db } from '../db/index';
import { emitTurnChange, emitStatePatch } from '../services/socketService';
import { InitialBuildService } from '../services/InitialBuildService';

const mockQuery = db.query as unknown as jest.Mock<(...args: any[]) => Promise<any>>;
const mockConnect = (db as any).connect as unknown as jest.Mock<() => Promise<any>>;
const mockEmitTurnChange = emitTurnChange as jest.MockedFunction<typeof emitTurnChange>;
const mockEmitStatePatch = emitStatePatch as jest.MockedFunction<typeof emitStatePatch>;

// Helper to create a mock QueryResult
function mockResult(rows: any[]) {
  return { rows, command: '', rowCount: rows.length, oid: 0, fields: [] };
}

// Helper to create a mock transaction client for advanceTurn tests
// advanceTurn uses db.connect() + client.query() within a transaction
function makeClientMock(queryResponses: any[]) {
  let callIndex = 0;
  const clientQuery = jest.fn<(...args: any[]) => Promise<any>>().mockImplementation(() => {
    const response = queryResponses[callIndex] ?? mockResult([]);
    callIndex++;
    return Promise.resolve(response);
  });
  return {
    query: clientQuery,
    release: jest.fn<() => void>(),
  };
}

describe('InitialBuildService', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    (mockEmitStatePatch as jest.Mock<() => Promise<void>>).mockResolvedValue(undefined);
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
        // Transaction client query sequence:
        // 0: BEGIN
        // 1: SELECT ... FOR UPDATE (game state)
        // 2: SELECT players
        // 3: UPDATE games
        // 4: COMMIT
        const client = makeClientMock([
          mockResult([]), // BEGIN
          mockResult([{    // SELECT FOR UPDATE
            status: 'initialBuild',
            initial_build_round: 1,
            initial_build_order: [playerA, playerB, playerC],
            current_player_index: 0,
          }]),
          mockResult(standardPlayers), // SELECT players
          mockResult([]),              // UPDATE
          mockResult([]),              // COMMIT
        ]);
        mockConnect.mockResolvedValueOnce(client);

        await InitialBuildService.advanceTurn(gameId);

        // Should advance to playerB (index 1)
        const updateCall = client.query.mock.calls[3];
        expect(updateCall[1]).toEqual([1, gameId]);
        expect(mockEmitTurnChange).toHaveBeenCalledWith(gameId, 1, playerB);
      });

      it('should advance from second to third player in round 1', async () => {
        const client = makeClientMock([
          mockResult([]), // BEGIN
          mockResult([{
            status: 'initialBuild',
            initial_build_round: 1,
            initial_build_order: [playerA, playerB, playerC],
            current_player_index: 1,
          }]),
          mockResult(standardPlayers),
          mockResult([]),
          mockResult([]),
        ]);
        mockConnect.mockResolvedValueOnce(client);

        await InitialBuildService.advanceTurn(gameId);

        const updateCall = client.query.mock.calls[3];
        expect(updateCall[1]).toEqual([2, gameId]);
        expect(mockEmitTurnChange).toHaveBeenCalledWith(gameId, 2, playerC);
      });
    });

    describe('Round 1 to Round 2 transition', () => {
      it('should transition to round 2 with reversed order when last player in round 1 finishes', async () => {
        const client = makeClientMock([
          mockResult([]), // BEGIN
          mockResult([{
            status: 'initialBuild',
            initial_build_round: 1,
            initial_build_order: [playerA, playerB, playerC],
            current_player_index: 2, // C is at standard index 2
          }]),
          mockResult(standardPlayers),
          mockResult([]),
          mockResult([]),
        ]);
        mockConnect.mockResolvedValueOnce(client);

        await InitialBuildService.advanceTurn(gameId);

        // Should set round 2 with reversed order [C, B, A]
        const updateCall = client.query.mock.calls[3];
        expect(updateCall[0]).toContain('initial_build_round = 2');
        expect(updateCall[1][0]).toBe(JSON.stringify([playerC, playerB, playerA]));
        // First player in reversed order is C (index 2)
        expect(updateCall[1][1]).toBe(2);
        expect(mockEmitTurnChange).toHaveBeenCalledWith(gameId, 2, playerC);
      });

      it('should reverse a 2-player order correctly', async () => {
        const twoPlayers = [{ id: playerA }, { id: playerB }];
        const client = makeClientMock([
          mockResult([]), // BEGIN
          mockResult([{
            status: 'initialBuild',
            initial_build_round: 1,
            initial_build_order: [playerA, playerB],
            current_player_index: 1,
          }]),
          mockResult(twoPlayers),
          mockResult([]),
          mockResult([]),
        ]);
        mockConnect.mockResolvedValueOnce(client);

        await InitialBuildService.advanceTurn(gameId);

        const updateCall = client.query.mock.calls[3];
        expect(updateCall[1][0]).toBe(JSON.stringify([playerB, playerA]));
        // First in reversed order is B (index 1)
        expect(updateCall[1][1]).toBe(1);
        expect(mockEmitTurnChange).toHaveBeenCalledWith(gameId, 1, playerB);
      });
    });

    describe('Round 2 progression', () => {
      it('should advance to next player within round 2', async () => {
        const client = makeClientMock([
          mockResult([]), // BEGIN
          mockResult([{
            status: 'initialBuild',
            initial_build_round: 2,
            initial_build_order: [playerC, playerB, playerA],
            current_player_index: 2, // C is at standard index 2
          }]),
          mockResult(standardPlayers),
          mockResult([]),
          mockResult([]),
        ]);
        mockConnect.mockResolvedValueOnce(client);

        await InitialBuildService.advanceTurn(gameId);

        // Next in order is B (index 1)
        const updateCall = client.query.mock.calls[3];
        expect(updateCall[1]).toEqual([1, gameId]);
        expect(mockEmitTurnChange).toHaveBeenCalledWith(gameId, 1, playerB);
      });

      it('should advance from second to third player in round 2', async () => {
        const client = makeClientMock([
          mockResult([]), // BEGIN
          mockResult([{
            status: 'initialBuild',
            initial_build_round: 2,
            initial_build_order: [playerC, playerB, playerA],
            current_player_index: 1,
          }]),
          mockResult(standardPlayers),
          mockResult([]),
          mockResult([]),
        ]);
        mockConnect.mockResolvedValueOnce(client);

        await InitialBuildService.advanceTurn(gameId);

        // Next is A (index 0)
        const updateCall = client.query.mock.calls[3];
        expect(updateCall[1]).toEqual([0, gameId]);
        expect(mockEmitTurnChange).toHaveBeenCalledWith(gameId, 0, playerA);
      });
    });

    describe('Round 2 to Active transition', () => {
      it('should transition to active status when last player in round 2 finishes', async () => {
        const client = makeClientMock([
          mockResult([]), // BEGIN
          mockResult([{
            status: 'initialBuild',
            initial_build_round: 2,
            initial_build_order: [playerC, playerB, playerA],
            current_player_index: 0, // A is at standard index 0
          }]),
          mockResult(standardPlayers),
          mockResult([]),
          mockResult([]),
        ]);
        mockConnect.mockResolvedValueOnce(client);

        await InitialBuildService.advanceTurn(gameId);

        const updateCall = client.query.mock.calls[3];
        expect(updateCall[0]).toContain("status = 'active'");
        expect(updateCall[0]).toContain('initial_build_round = 0');
        expect(updateCall[0]).toContain('initial_build_order = NULL');
      });

      it('should set current_player_index to the last player in round 2 (per game rules)', async () => {
        const client = makeClientMock([
          mockResult([]), // BEGIN
          mockResult([{
            status: 'initialBuild',
            initial_build_round: 2,
            initial_build_order: [playerC, playerB, playerA],
            current_player_index: 0,
          }]),
          mockResult(standardPlayers),
          mockResult([]),
          mockResult([]),
        ]);
        mockConnect.mockResolvedValueOnce(client);

        await InitialBuildService.advanceTurn(gameId);

        // "The last player from the second building turn becomes the first player"
        const updateCall = client.query.mock.calls[3];
        expect(updateCall[1][0]).toBe(0); // playerA's index
        expect(mockEmitTurnChange).toHaveBeenCalledWith(gameId, 0, playerA);
      });

      it('should emit state:patch with active status', async () => {
        const client = makeClientMock([
          mockResult([]), // BEGIN
          mockResult([{
            status: 'initialBuild',
            initial_build_round: 2,
            initial_build_order: [playerC, playerB, playerA],
            current_player_index: 0,
          }]),
          mockResult(standardPlayers),
          mockResult([]),
          mockResult([]),
        ]);
        mockConnect.mockResolvedValueOnce(client);

        await InitialBuildService.advanceTurn(gameId);

        expect(mockEmitStatePatch).toHaveBeenCalledWith(
          gameId,
          expect.objectContaining({ status: 'active' }),
        );
      });

      it('should not emit state:patch during round transitions', async () => {
        // Round 1 → Round 2 transition should NOT emit state:patch
        const client = makeClientMock([
          mockResult([]), // BEGIN
          mockResult([{
            status: 'initialBuild',
            initial_build_round: 1,
            initial_build_order: [playerA, playerB, playerC],
            current_player_index: 2,
          }]),
          mockResult(standardPlayers),
          mockResult([]),
          mockResult([]),
        ]);
        mockConnect.mockResolvedValueOnce(client);

        await InitialBuildService.advanceTurn(gameId);

        expect(mockEmitStatePatch).not.toHaveBeenCalled();
      });
    });

    describe('error handling', () => {
      it('should throw when game is not found', async () => {
        const client = makeClientMock([
          mockResult([]), // BEGIN
          mockResult([]), // SELECT FOR UPDATE → no rows
          mockResult([]), // ROLLBACK
        ]);
        mockConnect.mockResolvedValueOnce(client);

        await expect(
          InitialBuildService.advanceTurn(gameId),
        ).rejects.toThrow('Game game-1 not found');
      });

      it('should throw when game is not in initialBuild phase', async () => {
        const client = makeClientMock([
          mockResult([]), // BEGIN
          mockResult([{  // SELECT FOR UPDATE
            status: 'active',
            initial_build_round: 0,
            initial_build_order: null,
            current_player_index: 0,
          }]),
          mockResult([]), // ROLLBACK
        ]);
        mockConnect.mockResolvedValueOnce(client);

        await expect(
          InitialBuildService.advanceTurn(gameId),
        ).rejects.toThrow('not in initialBuild phase');
      });

      it('should rollback and rethrow on unexpected errors', async () => {
        const client = makeClientMock([
          mockResult([]),        // BEGIN
          mockResult([{          // SELECT FOR UPDATE
            status: 'initialBuild',
            initial_build_round: 1,
            initial_build_order: [playerA, playerB, playerC],
            current_player_index: 0,
          }]),
          mockResult(standardPlayers), // SELECT players
        ]);
        // Make the UPDATE throw
        client.query.mockImplementationOnce(() => {
          throw new Error('DB write error');
        });
        mockConnect.mockResolvedValueOnce(client);

        await expect(
          InitialBuildService.advanceTurn(gameId),
        ).rejects.toThrow('DB write error');

        // ROLLBACK should have been called
        const calls = client.query.mock.calls.map((c: any[]) => c[0]);
        expect(calls).toContain('ROLLBACK');
        // Client should be released
        expect(client.release).toHaveBeenCalled();
      });

      it('should always release the client even on error', async () => {
        const client = makeClientMock([
          mockResult([]), // BEGIN
          mockResult([]), // SELECT → not found → ROLLBACK
          mockResult([]), // ROLLBACK
        ]);
        mockConnect.mockResolvedValueOnce(client);

        await expect(
          InitialBuildService.advanceTurn(gameId),
        ).rejects.toThrow();

        expect(client.release).toHaveBeenCalled();
      });
    });

    describe('SELECT FOR UPDATE locking', () => {
      it('should use SELECT ... FOR UPDATE to acquire row-level lock', async () => {
        const client = makeClientMock([
          mockResult([]), // BEGIN
          mockResult([{
            status: 'initialBuild',
            initial_build_round: 1,
            initial_build_order: [playerA, playerB],
            current_player_index: 0,
          }]),
          mockResult([{ id: playerA }, { id: playerB }]),
          mockResult([]),
          mockResult([]),
        ]);
        mockConnect.mockResolvedValueOnce(client);

        await InitialBuildService.advanceTurn(gameId);

        // Second client.query call (index 1, after BEGIN) must use FOR UPDATE
        const selectCall = client.query.mock.calls[1];
        expect(selectCall[0]).toContain('FOR UPDATE');
        expect(selectCall[1]).toEqual([gameId]);
      });

      it('should wrap all DB operations in a transaction (BEGIN ... COMMIT)', async () => {
        const client = makeClientMock([
          mockResult([]), // BEGIN
          mockResult([{
            status: 'initialBuild',
            initial_build_round: 1,
            initial_build_order: [playerA, playerB],
            current_player_index: 0,
          }]),
          mockResult([{ id: playerA }, { id: playerB }]),
          mockResult([]),
          mockResult([]),
        ]);
        mockConnect.mockResolvedValueOnce(client);

        await InitialBuildService.advanceTurn(gameId);

        const calls = client.query.mock.calls.map((c: any[]) => c[0]);
        expect(calls[0]).toBe('BEGIN');
        expect(calls[calls.length - 1]).toBe('COMMIT');
      });
    });

    describe('player index mapping', () => {
      it('should correctly map non-sequential player IDs to standard indices', async () => {
        const playerX = 'player-x';
        const playerY = 'player-y';
        const playerZ = 'player-z';
        const players = [{ id: playerX }, { id: playerY }, { id: playerZ }];

        const client = makeClientMock([
          mockResult([]), // BEGIN
          mockResult([{
            status: 'initialBuild',
            initial_build_round: 1,
            initial_build_order: [playerY, playerZ, playerX],
            current_player_index: 1, // Y is at standard index 1
          }]),
          mockResult(players),
          mockResult([]),
          mockResult([]),
        ]);
        mockConnect.mockResolvedValueOnce(client);

        await InitialBuildService.advanceTurn(gameId);

        // Next player is Z (index 2 in standard order)
        expect(mockEmitTurnChange).toHaveBeenCalledWith(gameId, 2, playerZ);
      });

      it('should handle single-player game (edge case)', async () => {
        const client = makeClientMock([
          mockResult([]), // BEGIN
          mockResult([{
            status: 'initialBuild',
            initial_build_round: 1,
            initial_build_order: [playerA],
            current_player_index: 0,
          }]),
          mockResult([{ id: playerA }]),
          mockResult([]),
          mockResult([]),
        ]);
        mockConnect.mockResolvedValueOnce(client);

        await InitialBuildService.advanceTurn(gameId);

        // Should transition to round 2
        const updateCall = client.query.mock.calls[3];
        expect(updateCall[0]).toContain('initial_build_round = 2');
      });
    });

    describe('DB query verification', () => {
      it('should query game state with correct SQL using FOR UPDATE', async () => {
        const client = makeClientMock([
          mockResult([]), // BEGIN
          mockResult([{
            status: 'initialBuild',
            initial_build_round: 1,
            initial_build_order: [playerA, playerB],
            current_player_index: 0,
          }]),
          mockResult([{ id: playerA }, { id: playerB }]),
          mockResult([]),
          mockResult([]),
        ]);
        mockConnect.mockResolvedValueOnce(client);

        await InitialBuildService.advanceTurn(gameId);

        // Second call (index 1): game state with FOR UPDATE
        expect(client.query.mock.calls[1][1]).toEqual([gameId]);
        expect(client.query.mock.calls[1][0]).toContain('FOR UPDATE');
        // Third call (index 2): players
        expect(client.query.mock.calls[2][0]).toContain('ORDER BY created_at ASC');
        expect(client.query.mock.calls[2][1]).toEqual([gameId]);
      });
    });
  });
});
