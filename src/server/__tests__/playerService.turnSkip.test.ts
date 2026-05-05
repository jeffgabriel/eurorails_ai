/**
 * Unit tests for PlayerService.updateCurrentPlayerIndex turn lifecycle:
 * - Effect expiry via cleanupExpiredEffects
 * - Derailment turn-skip via consumeLostTurn
 * - Recursive advancement with infinite loop guard
 * - Backward compatibility (no client → no checks)
 */

import { PlayerService } from '../services/playerService';
import { activeEffectManager } from '../services/ActiveEffectManager';

// Mock socketService
jest.mock('../services/socketService', () => ({
  emitTurnChange: jest.fn(),
  getSocketIO: jest.fn().mockReturnValue(null),
}));

// Mock the database module
jest.mock('../db/index', () => {
  const mockClient = {
    query: jest.fn(),
    release: jest.fn(),
  };
  return {
    db: {
      connect: jest.fn().mockResolvedValue(mockClient),
      query: jest.fn(),
    },
    __mockClient: mockClient,
  };
});

// Mock ActiveEffectManager
jest.mock('../services/ActiveEffectManager', () => ({
  activeEffectManager: {
    cleanupExpiredEffects: jest.fn(),
    consumeLostTurn: jest.fn(),
    addActiveEffect: jest.fn(),
    getMovementRestrictions: jest.fn().mockResolvedValue([]),
    getBuildRestrictions: jest.fn().mockResolvedValue([]),
    getPickupDeliveryRestrictions: jest.fn().mockResolvedValue([]),
  },
}));

const { db, __mockClient: mockClient } = jest.requireMock('../db/index') as {
  db: { connect: jest.Mock; query: jest.Mock };
  __mockClient: { query: jest.Mock; release: jest.Mock };
};

const mockCleanupExpiredEffects = activeEffectManager.cleanupExpiredEffects as jest.Mock;
const mockConsumeLostTurn = activeEffectManager.consumeLostTurn as jest.Mock;

describe('PlayerService.updateCurrentPlayerIndex', () => {
  const gameId = 'game-abc';

  beforeEach(() => {
    jest.clearAllMocks();
    // Default: no expired effects, no lost turns
    mockCleanupExpiredEffects.mockResolvedValue({ expiredCardIds: [] });
    mockConsumeLostTurn.mockResolvedValue(false);
  });

  // ── Helper: mock a client that returns a player at offset N ─────────────────
  function setupClientWithPlayers(playerList: Array<{ id: string; current_turn_number: number }>) {
    mockClient.query.mockImplementation((sql: string, params?: unknown[]) => {
      if (typeof sql === 'string' && sql.includes('SELECT id, current_turn_number')) {
        const offset = params ? Number(params[1]) : 0;
        const row = playerList[offset];
        return Promise.resolve({ rows: row ? [row] : [] });
      }
      if (typeof sql === 'string' && sql.includes('COUNT(*)')) {
        return Promise.resolve({ rows: [{ cnt: playerList.length }] });
      }
      return Promise.resolve({ rows: [] });
    });
  }

  // ── Backward-compatibility tests ────────────────────────────────────────────

  describe('backward compatibility (no client)', () => {
    it('should NOT call cleanupExpiredEffects when no client is provided', async () => {
      // db.query is used in the no-client path
      (db.query as jest.Mock).mockResolvedValue({ rows: [] });
      const { getSocketIO } = await import('../services/socketService');
      (getSocketIO as jest.Mock).mockReturnValue(null);

      await PlayerService.updateCurrentPlayerIndex(gameId, 1);

      expect(mockCleanupExpiredEffects).not.toHaveBeenCalled();
    });

    it('should NOT call consumeLostTurn when no client is provided', async () => {
      (db.query as jest.Mock).mockResolvedValue({ rows: [] });

      await PlayerService.updateCurrentPlayerIndex(gameId, 1);

      expect(mockConsumeLostTurn).not.toHaveBeenCalled();
    });
  });

  // ── Effect expiry tests ──────────────────────────────────────────────────────

  describe('cleanupExpiredEffects (with client)', () => {
    it('should call cleanupExpiredEffects with prevPlayerIndex and turnNumber', async () => {
      const players = [
        { id: 'p0', current_turn_number: 3 },
        { id: 'p1', current_turn_number: 3 },
      ];
      setupClientWithPlayers(players);

      // prevPlayerIndex = 0, nextPlayerIndex = 1
      await PlayerService.updateCurrentPlayerIndex(gameId, 1, mockClient as any, 0);

      expect(mockCleanupExpiredEffects).toHaveBeenCalledWith(
        gameId,
        0,   // prevPlayerIndex
        3,   // turnNumber from prev player
        mockClient,
      );
    });

    it('should log expired card IDs when effects expire', async () => {
      const infoSpy = jest.spyOn(console, 'info').mockImplementation(() => {});
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

      const players = [{ id: 'p0', current_turn_number: 2 }, { id: 'p1', current_turn_number: 2 }];
      setupClientWithPlayers(players);
      mockCleanupExpiredEffects.mockResolvedValue({ expiredCardIds: [121, 130] });

      await PlayerService.updateCurrentPlayerIndex(gameId, 1, mockClient as any, 0);

      const allLogs = [...infoSpy.mock.calls, ...warnSpy.mock.calls].flat();
      const logText = allLogs.join(' ');
      expect(logText).toMatch(/121|130/);

      infoSpy.mockRestore();
      warnSpy.mockRestore();
    });

    it('should NOT log when no effects expire', async () => {
      const infoSpy = jest.spyOn(console, 'info').mockImplementation(() => {});

      const players = [{ id: 'p0', current_turn_number: 1 }, { id: 'p1', current_turn_number: 1 }];
      setupClientWithPlayers(players);
      mockCleanupExpiredEffects.mockResolvedValue({ expiredCardIds: [] });

      await PlayerService.updateCurrentPlayerIndex(gameId, 1, mockClient as any, 0);

      // Should not log "expired" noise for empty result
      const expiredLog = infoSpy.mock.calls.find(c => String(c[0]).toLowerCase().includes('expired'));
      expect(expiredLog).toBeUndefined();

      infoSpy.mockRestore();
    });
  });

  // ── Turn-skip (consumeLostTurn) tests ───────────────────────────────────────

  describe('consumeLostTurn (with client)', () => {
    it('should call consumeLostTurn for the next player', async () => {
      const players = [
        { id: 'p0', current_turn_number: 1 },
        { id: 'p1', current_turn_number: 1 },
      ];
      setupClientWithPlayers(players);

      await PlayerService.updateCurrentPlayerIndex(gameId, 1, mockClient as any, 0);

      expect(mockConsumeLostTurn).toHaveBeenCalledWith(gameId, 'p1', mockClient);
    });

    it('should skip a player whose turn is lost and advance to next', async () => {
      const players = [
        { id: 'p0', current_turn_number: 1 },
        { id: 'p1', current_turn_number: 1 },
        { id: 'p2', current_turn_number: 1 },
      ];
      setupClientWithPlayers(players);

      // p1 has lost turn, p2 does not
      mockConsumeLostTurn
        .mockResolvedValueOnce(true)   // p1 loses turn
        .mockResolvedValueOnce(false); // p2 is fine

      const { emitTurnChange } = await import('../services/socketService');

      await PlayerService.updateCurrentPlayerIndex(gameId, 1, mockClient as any, 0);

      // Should emit for p2 (index 2), not p1
      expect(emitTurnChange).toHaveBeenCalledWith(gameId, 2, 'p2');
    });

    it('should log a turn-skip when consumeLostTurn returns true', async () => {
      const infoSpy = jest.spyOn(console, 'info').mockImplementation(() => {});
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

      const players = [
        { id: 'p0', current_turn_number: 1 },
        { id: 'p1', current_turn_number: 1 },
        { id: 'p2', current_turn_number: 1 },
      ];
      setupClientWithPlayers(players);

      mockConsumeLostTurn
        .mockResolvedValueOnce(true)
        .mockResolvedValueOnce(false);

      await PlayerService.updateCurrentPlayerIndex(gameId, 1, mockClient as any, 0);

      const allLogs = [...infoSpy.mock.calls, ...warnSpy.mock.calls].flat();
      const logText = allLogs.join(' ');
      expect(logText).toMatch(/skip|lost|derail/i);

      infoSpy.mockRestore();
      warnSpy.mockRestore();
    });

    it('should skip multiple consecutive players with lost turns', async () => {
      const players = [
        { id: 'p0', current_turn_number: 1 },
        { id: 'p1', current_turn_number: 1 },
        { id: 'p2', current_turn_number: 1 },
        { id: 'p3', current_turn_number: 1 },
      ];
      setupClientWithPlayers(players);

      // p1 and p2 lose turn, p3 does not
      mockConsumeLostTurn
        .mockResolvedValueOnce(true)
        .mockResolvedValueOnce(true)
        .mockResolvedValueOnce(false);

      const { emitTurnChange } = await import('../services/socketService');

      await PlayerService.updateCurrentPlayerIndex(gameId, 1, mockClient as any, 0);

      expect(emitTurnChange).toHaveBeenCalledWith(gameId, 3, 'p3');
    });

    it('should guard against infinite loop if all players have lost turns', async () => {
      const players = [
        { id: 'p0', current_turn_number: 1 },
        { id: 'p1', current_turn_number: 1 },
        { id: 'p2', current_turn_number: 1 },
      ];
      setupClientWithPlayers(players);

      // ALL players have lost turns — should stop after player_count iterations
      mockConsumeLostTurn.mockResolvedValue(true);

      const { emitTurnChange } = await import('../services/socketService');

      // Should not throw and should still emit for some player
      await expect(
        PlayerService.updateCurrentPlayerIndex(gameId, 1, mockClient as any, 0),
      ).resolves.not.toThrow();

      expect(emitTurnChange).toHaveBeenCalledTimes(1);
    });
  });

  // ── Integration: expiry + skip in same advancement ──────────────────────────

  describe('combined expiry + skip', () => {
    it('should both cleanup effects and skip the derailed player', async () => {
      const players = [
        { id: 'p0', current_turn_number: 5 },
        { id: 'p1', current_turn_number: 5 },
        { id: 'p2', current_turn_number: 5 },
      ];
      setupClientWithPlayers(players);

      mockCleanupExpiredEffects.mockResolvedValue({ expiredCardIds: [125] });
      mockConsumeLostTurn
        .mockResolvedValueOnce(true)   // p1 skipped
        .mockResolvedValueOnce(false); // p2 ok

      const { emitTurnChange } = await import('../services/socketService');

      await PlayerService.updateCurrentPlayerIndex(gameId, 1, mockClient as any, 0);

      expect(mockCleanupExpiredEffects).toHaveBeenCalled();
      expect(emitTurnChange).toHaveBeenCalledWith(gameId, 2, 'p2');
    });
  });
});
