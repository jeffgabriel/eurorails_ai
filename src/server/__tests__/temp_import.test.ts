import { getMemory, updateMemory, clearMemory } from '../services/ai/BotMemory';
import { initTurnLog, logPhase, flushTurnLog, getCurrentLog, setOutputEnabled } from '../services/ai/DecisionLogger';
import { BotMemoryState } from '../../shared/types/GameTypes';

// Mock db so BotMemory doesn't try to connect to a real DB
jest.mock('../db/index', () => ({
  db: {
    query: jest.fn().mockResolvedValue({ rows: [] }),
  },
}));

describe('BotMemory and DecisionLogger module imports', () => {
  it('should export BotMemory functions', () => {
    expect(typeof getMemory).toBe('function');
    expect(typeof updateMemory).toBe('function');
    expect(typeof clearMemory).toBe('function');
  });

  it('should export DecisionLogger functions', () => {
    expect(typeof initTurnLog).toBe('function');
    expect(typeof logPhase).toBe('function');
    expect(typeof flushTurnLog).toBe('function');
    expect(typeof getCurrentLog).toBe('function');
    expect(typeof setOutputEnabled).toBe('function');
  });

  it('getMemory returns default state for unknown game/player', async () => {
    const state: BotMemoryState = await getMemory('unknown-game', 'unknown-player');
    expect(state).toEqual({
      currentBuildTarget: null,
      turnsOnTarget: 0,
      turnsOnRoute: 0,
      activeRoute: null,
      routeHistory: [],
      lastAction: null,
      noProgressTurns: 0,
      consecutiveDiscards: 0,
      deliveryCount: 0,
      totalEarnings: 0,
      turnNumber: 0,
      lastReasoning: null,
      lastPlanHorizon: null,
      previousRouteStops: null,
      consecutiveLlmFailures: 0,
    });
  });

  it('updateMemory merges partial state', async () => {
    await updateMemory('test-game', 'test-bot', { noProgressTurns: 3 });
    const state = await getMemory('test-game', 'test-bot');
    expect(state.noProgressTurns).toBe(3);
    expect(state.currentBuildTarget).toBeNull();

    // Clean up
    await clearMemory('test-game', 'test-bot');
  });

  it('initTurnLog creates a log and flushTurnLog clears it', () => {
    setOutputEnabled(false); // suppress console output during test
    initTurnLog('game-1', 'player-1', 1);
    expect(getCurrentLog()).not.toBeNull();
    flushTurnLog();
    expect(getCurrentLog()).toBeNull();
    setOutputEnabled(true);
  });
});
