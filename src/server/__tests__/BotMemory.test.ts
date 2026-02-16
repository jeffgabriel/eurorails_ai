import { getMemory, updateMemory, clearMemory } from '../services/ai/BotMemory';
import { AIActionType, BotMemoryState } from '../../shared/types/GameTypes';

describe('BotMemory', () => {
  const gameId = 'game-001';
  const playerId = 'player-001';

  afterEach(() => {
    clearMemory(gameId, playerId);
  });

  describe('getMemory', () => {
    it('returns default state for unknown game/player', () => {
      const state = getMemory('unknown-game', 'unknown-player');
      expect(state).toEqual<BotMemoryState>({
        currentBuildTarget: null,
        turnsOnTarget: 0,
        lastAction: null,
        consecutivePassTurns: 0,
        deliveryCount: 0,
        totalEarnings: 0,
        turnNumber: 0,
      });
    });

    it('returns previously stored state', () => {
      updateMemory(gameId, playerId, { deliveryCount: 3 });
      const state = getMemory(gameId, playerId);
      expect(state.deliveryCount).toBe(3);
    });

    it('isolates memory by game+player key', () => {
      updateMemory(gameId, playerId, { deliveryCount: 5 });
      updateMemory('game-002', playerId, { deliveryCount: 10 });

      expect(getMemory(gameId, playerId).deliveryCount).toBe(5);
      expect(getMemory('game-002', playerId).deliveryCount).toBe(10);

      clearMemory('game-002', playerId);
    });
  });

  describe('updateMemory', () => {
    it('merges partial state with defaults', () => {
      updateMemory(gameId, playerId, { consecutivePassTurns: 2 });
      const state = getMemory(gameId, playerId);
      expect(state.consecutivePassTurns).toBe(2);
      expect(state.currentBuildTarget).toBeNull();
      expect(state.deliveryCount).toBe(0);
    });

    it('overwrites specific fields without affecting others', () => {
      updateMemory(gameId, playerId, { deliveryCount: 1, totalEarnings: 43 });
      updateMemory(gameId, playerId, { consecutivePassTurns: 1 });

      const state = getMemory(gameId, playerId);
      expect(state.deliveryCount).toBe(1);
      expect(state.totalEarnings).toBe(43);
      expect(state.consecutivePassTurns).toBe(1);
    });

    it('tracks build target and turns on target', () => {
      updateMemory(gameId, playerId, {
        currentBuildTarget: 'Paris',
        turnsOnTarget: 1,
        lastAction: AIActionType.BuildTrack,
      });

      const state = getMemory(gameId, playerId);
      expect(state.currentBuildTarget).toBe('Paris');
      expect(state.turnsOnTarget).toBe(1);
      expect(state.lastAction).toBe(AIActionType.BuildTrack);
    });
  });

  describe('clearMemory', () => {
    it('removes stored state for game/player', () => {
      updateMemory(gameId, playerId, { deliveryCount: 5, totalEarnings: 100 });
      clearMemory(gameId, playerId);

      const state = getMemory(gameId, playerId);
      expect(state.deliveryCount).toBe(0);
      expect(state.totalEarnings).toBe(0);
    });

    it('does not affect other game/player entries', () => {
      updateMemory(gameId, playerId, { deliveryCount: 5 });
      updateMemory(gameId, 'player-002', { deliveryCount: 10 });

      clearMemory(gameId, playerId);

      expect(getMemory(gameId, playerId).deliveryCount).toBe(0);
      expect(getMemory(gameId, 'player-002').deliveryCount).toBe(10);

      clearMemory(gameId, 'player-002');
    });

    it('is idempotent — clearing non-existent entry does not throw', () => {
      expect(() => clearMemory('no-game', 'no-player')).not.toThrow();
    });
  });
});
