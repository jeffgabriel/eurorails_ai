import { getMemory, updateMemory, clearMemory } from '../services/ai/BotMemory';
import { AIActionType, BotMemoryState } from '../../shared/types/GameTypes';

// Mock the database module
jest.mock('../db/index', () => ({
  db: {
    query: jest.fn(),
  },
}));

import { db } from '../db/index';

const mockDbQuery = db.query as jest.Mock;

describe('BotMemory', () => {
  const gameId = 'game-001';
  const playerId = 'player-001';

  beforeEach(() => {
    jest.clearAllMocks();
    // Default: DB returns no rows (NULL bot_memory or player not found)
    mockDbQuery.mockResolvedValue({ rows: [] });
  });

  afterEach(async () => {
    await clearMemory(gameId, playerId);
  });

  describe('getMemory', () => {
    it('returns default state when Map is empty and DB returns null', async () => {
      mockDbQuery.mockResolvedValue({ rows: [{ bot_memory: null }] });
      const state = await getMemory('unknown-game', 'unknown-player');
      expect(state).toEqual<BotMemoryState>({
        currentBuildTarget: null,
        turnsOnTarget: 0,
        lastAction: null,
        consecutiveDiscards: 0,
        deliveryCount: 0,
        totalEarnings: 0,
        turnNumber: 0,
        activeRoute: null,
        turnsOnRoute: 0,
        routeHistory: [],
        lastReasoning: null,
        lastPlanHorizon: null,
        previousRouteStops: null,
        consecutiveLlmFailures: 0,
      });
    });

    it('returns DB state when Map is empty and DB has data', async () => {
      const dbState: BotMemoryState = {
        currentBuildTarget: 'Berlin',
        turnsOnTarget: 3,
        lastAction: AIActionType.BuildTrack,
        consecutiveDiscards: 0,
        deliveryCount: 2,
        totalEarnings: 50,
        turnNumber: 5,
        activeRoute: null,
        turnsOnRoute: 0,
        routeHistory: [],
        lastReasoning: 'Test reasoning',
        lastPlanHorizon: null,
        previousRouteStops: null,
        consecutiveLlmFailures: 0,
      };
      mockDbQuery.mockResolvedValue({ rows: [{ bot_memory: dbState }] });

      const state = await getMemory(gameId, playerId);
      expect(state.currentBuildTarget).toBe('Berlin');
      expect(state.deliveryCount).toBe(2);
      expect(state.turnNumber).toBe(5);
    });

    it('returns Map state when Map has data (no additional DB call)', async () => {
      // Pre-populate Map via updateMemory
      mockDbQuery.mockResolvedValue({ rows: [] });
      await updateMemory(gameId, playerId, { deliveryCount: 7 });

      // Reset call count after updateMemory's DB write
      mockDbQuery.mockClear();
      mockDbQuery.mockResolvedValue({ rows: [] });

      const state = await getMemory(gameId, playerId);
      expect(state.deliveryCount).toBe(7);
      // DB should NOT have been queried (Map hit)
      expect(mockDbQuery).not.toHaveBeenCalledWith(
        expect.stringContaining('SELECT'),
        expect.anything(),
      );
    });

    it('returns default state when db.query throws', async () => {
      mockDbQuery.mockRejectedValue(new Error('DB connection failed'));
      const state = await getMemory(gameId, 'error-player');
      expect(state).toEqual<BotMemoryState>({
        currentBuildTarget: null,
        turnsOnTarget: 0,
        lastAction: null,
        consecutiveDiscards: 0,
        deliveryCount: 0,
        totalEarnings: 0,
        turnNumber: 0,
        activeRoute: null,
        turnsOnRoute: 0,
        routeHistory: [],
        lastReasoning: null,
        lastPlanHorizon: null,
        previousRouteStops: null,
        consecutiveLlmFailures: 0,
      });
    });

    it('returns previously stored state', async () => {
      mockDbQuery.mockResolvedValue({ rows: [] });
      await updateMemory(gameId, playerId, { deliveryCount: 3 });
      const state = await getMemory(gameId, playerId);
      expect(state.deliveryCount).toBe(3);
    });

    it('isolates memory by game+player key', async () => {
      mockDbQuery.mockResolvedValue({ rows: [] });
      await updateMemory(gameId, playerId, { deliveryCount: 5 });
      await updateMemory('game-002', playerId, { deliveryCount: 10 });

      expect((await getMemory(gameId, playerId)).deliveryCount).toBe(5);
      expect((await getMemory('game-002', playerId)).deliveryCount).toBe(10);

      await clearMemory('game-002', playerId);
    });
  });

  describe('updateMemory', () => {
    it('merges partial state with defaults', async () => {
      mockDbQuery.mockResolvedValue({ rows: [] });
      await updateMemory(gameId, playerId, { consecutiveDiscards: 2 });
      const state = await getMemory(gameId, playerId);
      expect(state.consecutiveDiscards).toBe(2);
      expect(state.currentBuildTarget).toBeNull();
      expect(state.deliveryCount).toBe(0);
    });

    it('overwrites specific fields without affecting others', async () => {
      mockDbQuery.mockResolvedValue({ rows: [] });
      await updateMemory(gameId, playerId, { deliveryCount: 1, totalEarnings: 43 });
      await updateMemory(gameId, playerId, { consecutiveDiscards: 1 });

      const state = await getMemory(gameId, playerId);
      expect(state.deliveryCount).toBe(1);
      expect(state.totalEarnings).toBe(43);
      expect(state.consecutiveDiscards).toBe(1);
    });

    it('calls db.query with UPDATE statement', async () => {
      mockDbQuery.mockResolvedValue({ rows: [] });
      await updateMemory(gameId, playerId, { deliveryCount: 5 });

      expect(mockDbQuery).toHaveBeenCalledWith(
        expect.stringContaining('UPDATE players SET bot_memory'),
        expect.arrayContaining([playerId]),
      );
    });

    it('succeeds even when db.query throws', async () => {
      mockDbQuery.mockRejectedValue(new Error('DB write failed'));

      // Should not throw
      await expect(updateMemory(gameId, playerId, { deliveryCount: 3 })).resolves.toBeUndefined();

      // Map should still be updated
      mockDbQuery.mockResolvedValue({ rows: [] });
      const state = await getMemory(gameId, playerId);
      expect(state.deliveryCount).toBe(3);
    });

    it('tracks build target and turns on target', async () => {
      mockDbQuery.mockResolvedValue({ rows: [] });
      await updateMemory(gameId, playerId, {
        currentBuildTarget: 'Paris',
        turnsOnTarget: 1,
        lastAction: AIActionType.BuildTrack,
      });

      const state = await getMemory(gameId, playerId);
      expect(state.currentBuildTarget).toBe('Paris');
      expect(state.turnsOnTarget).toBe(1);
      expect(state.lastAction).toBe(AIActionType.BuildTrack);
    });
  });

  describe('clearMemory', () => {
    it('removes stored state for game/player', async () => {
      mockDbQuery.mockResolvedValue({ rows: [] });
      await updateMemory(gameId, playerId, { deliveryCount: 5, totalEarnings: 100 });
      await clearMemory(gameId, playerId);

      // After clear, DB query for SELECT returns null (simulating cleared DB)
      mockDbQuery.mockResolvedValue({ rows: [{ bot_memory: null }] });
      const state = await getMemory(gameId, playerId);
      expect(state.deliveryCount).toBe(0);
      expect(state.totalEarnings).toBe(0);
    });

    it('calls db.query to set bot_memory to NULL', async () => {
      mockDbQuery.mockResolvedValue({ rows: [] });
      await clearMemory(gameId, playerId);

      expect(mockDbQuery).toHaveBeenCalledWith(
        expect.stringContaining('bot_memory = NULL'),
        expect.arrayContaining([playerId]),
      );
    });

    it('does not affect other game/player entries', async () => {
      mockDbQuery.mockResolvedValue({ rows: [] });
      await updateMemory(gameId, playerId, { deliveryCount: 5 });
      await updateMemory(gameId, 'player-002', { deliveryCount: 10 });

      await clearMemory(gameId, playerId);

      mockDbQuery.mockResolvedValue({ rows: [{ bot_memory: null }] });
      expect((await getMemory(gameId, playerId)).deliveryCount).toBe(0);
      expect((await getMemory(gameId, 'player-002')).deliveryCount).toBe(10);

      await clearMemory(gameId, 'player-002');
    });

    it('is idempotent — clearing non-existent entry does not throw', async () => {
      mockDbQuery.mockResolvedValue({ rows: [] });
      await expect(clearMemory('no-game', 'no-player')).resolves.not.toThrow();
    });

    it('does not throw when db.query throws during clear', async () => {
      mockDbQuery.mockRejectedValue(new Error('DB clear failed'));
      await expect(clearMemory(gameId, playerId)).resolves.toBeUndefined();
    });
  });
});
