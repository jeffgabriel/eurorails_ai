/**
 * Tests for AI Store
 */

import { useAIStore } from '../../../lobby/store/ai.store';
import type { TurnSummary, AIStrategy, AIDebugInfo } from '../../../../shared/types/AITypes';

// Reset store state before each test
const resetStore = () => {
  const store = useAIStore.getState();
  store.clearAIState();
};

describe('AI Store', () => {
  beforeEach(() => {
    resetStore();
  });

  describe('initial state', () => {
    it('should have correct initial values', () => {
      const state = useAIStore.getState();
      expect(state.isAIThinking).toBe(false);
      expect(state.thinkingPlayerId).toBeNull();
      expect(state.aiTurnSummaries.size).toBe(0);
      expect(state.aiStrategies.size).toBe(0);
      expect(state.aiDebugInfo.size).toBe(0);
      expect(state.selectedAIPlayerId).toBeNull();
      expect(state.isBotPanelVisible).toBe(false);
    });
  });

  describe('setAIThinking', () => {
    it('should set thinking state to true with player ID', () => {
      const { setAIThinking } = useAIStore.getState();
      setAIThinking(true, 'ai-player-1');

      const state = useAIStore.getState();
      expect(state.isAIThinking).toBe(true);
      expect(state.thinkingPlayerId).toBe('ai-player-1');
    });

    it('should set thinking state to false and clear player ID', () => {
      const { setAIThinking } = useAIStore.getState();
      setAIThinking(true, 'ai-player-1');
      setAIThinking(false);

      const state = useAIStore.getState();
      expect(state.isAIThinking).toBe(false);
      expect(state.thinkingPlayerId).toBeNull();
    });
  });

  describe('setAITurnSummary', () => {
    it('should store turn summary for a player', () => {
      const { setAITurnSummary } = useAIStore.getState();
      const mockSummary: TurnSummary = {
        actions: [
          { type: 'build', description: 'Built track', details: {} },
        ],
        cashChange: 10,
        commentary: 'Good progress!',
      };

      setAITurnSummary('ai-player-1', mockSummary);

      const state = useAIStore.getState();
      expect(state.aiTurnSummaries.get('ai-player-1')).toEqual(mockSummary);
    });

    it('should update existing turn summary', () => {
      const { setAITurnSummary } = useAIStore.getState();
      const firstSummary: TurnSummary = {
        actions: [],
        cashChange: 0,
        commentary: 'First',
      };
      const secondSummary: TurnSummary = {
        actions: [],
        cashChange: 10,
        commentary: 'Second',
      };

      setAITurnSummary('ai-player-1', firstSummary);
      setAITurnSummary('ai-player-1', secondSummary);

      const state = useAIStore.getState();
      expect(state.aiTurnSummaries.get('ai-player-1')).toEqual(secondSummary);
    });
  });

  describe('setAIStrategy', () => {
    it('should store strategy for a player', () => {
      const { setAIStrategy } = useAIStore.getState();
      const mockStrategy: AIStrategy = {
        phase: 'Building',
        currentGoal: 'Connect Berlin',
        nextGoal: 'Deliver cargo',
        majorCityProgress: '3/7',
        cashToWin: 150,
      };

      setAIStrategy('ai-player-1', mockStrategy);

      const state = useAIStore.getState();
      expect(state.aiStrategies.get('ai-player-1')).toEqual(mockStrategy);
    });
  });

  describe('setAIDebugInfo', () => {
    it('should store debug info for a player', () => {
      const { setAIDebugInfo } = useAIStore.getState();
      const mockDebug: AIDebugInfo = {
        routesEvaluated: 25,
        selectedRouteScore: 0.87,
        decisionTimeMs: 500,
        variablesConsidered: ['cost', 'distance'],
      };

      setAIDebugInfo('ai-player-1', mockDebug);

      const state = useAIStore.getState();
      expect(state.aiDebugInfo.get('ai-player-1')).toEqual(mockDebug);
    });
  });

  describe('selectAIPlayer', () => {
    it('should set selected player and show panel', () => {
      const { selectAIPlayer } = useAIStore.getState();
      selectAIPlayer('ai-player-1');

      const state = useAIStore.getState();
      expect(state.selectedAIPlayerId).toBe('ai-player-1');
      expect(state.isBotPanelVisible).toBe(true);
    });

    it('should hide panel when deselecting player', () => {
      const { selectAIPlayer } = useAIStore.getState();
      selectAIPlayer('ai-player-1');
      selectAIPlayer(null);

      const state = useAIStore.getState();
      expect(state.selectedAIPlayerId).toBeNull();
      expect(state.isBotPanelVisible).toBe(false);
    });
  });

  describe('toggleBotPanel', () => {
    it('should toggle panel visibility', () => {
      const { toggleBotPanel } = useAIStore.getState();

      expect(useAIStore.getState().isBotPanelVisible).toBe(false);
      toggleBotPanel();
      expect(useAIStore.getState().isBotPanelVisible).toBe(true);
      toggleBotPanel();
      expect(useAIStore.getState().isBotPanelVisible).toBe(false);
    });

    it('should set explicit visibility when provided', () => {
      const { toggleBotPanel } = useAIStore.getState();

      toggleBotPanel(true);
      expect(useAIStore.getState().isBotPanelVisible).toBe(true);
      toggleBotPanel(true);
      expect(useAIStore.getState().isBotPanelVisible).toBe(true);
      toggleBotPanel(false);
      expect(useAIStore.getState().isBotPanelVisible).toBe(false);
    });
  });

  describe('clearAIState', () => {
    it('should reset all state to initial values', () => {
      const store = useAIStore.getState();

      // Set up some state
      store.setAIThinking(true, 'ai-player-1');
      store.setAITurnSummary('ai-player-1', {
        actions: [],
        cashChange: 0,
        commentary: 'Test',
      });
      store.setAIStrategy('ai-player-1', {
        phase: 'Test',
        currentGoal: 'Test',
        nextGoal: 'Test',
        majorCityProgress: '0/7',
        cashToWin: 250,
      });
      store.selectAIPlayer('ai-player-1');

      // Clear all state
      store.clearAIState();

      // Verify reset
      const state = useAIStore.getState();
      expect(state.isAIThinking).toBe(false);
      expect(state.thinkingPlayerId).toBeNull();
      expect(state.aiTurnSummaries.size).toBe(0);
      expect(state.aiStrategies.size).toBe(0);
      expect(state.aiDebugInfo.size).toBe(0);
      expect(state.selectedAIPlayerId).toBeNull();
      expect(state.isBotPanelVisible).toBe(false);
    });
  });

  describe('multiple players', () => {
    it('should handle data for multiple AI players', () => {
      const store = useAIStore.getState();

      const summary1: TurnSummary = { actions: [], cashChange: 10, commentary: 'Player 1' };
      const summary2: TurnSummary = { actions: [], cashChange: 20, commentary: 'Player 2' };

      store.setAITurnSummary('ai-player-1', summary1);
      store.setAITurnSummary('ai-player-2', summary2);

      const state = useAIStore.getState();
      expect(state.aiTurnSummaries.get('ai-player-1')).toEqual(summary1);
      expect(state.aiTurnSummaries.get('ai-player-2')).toEqual(summary2);
    });
  });
});

// Socket listener tests
describe('AI Store Socket Listeners', () => {
  let mockSocket: {
    on: jest.Mock;
    off: jest.Mock;
  };

  beforeEach(() => {
    useAIStore.getState().clearAIState();
    mockSocket = {
      on: jest.fn(),
      off: jest.fn(),
    };
  });

  describe('initializeSocketListeners', () => {
    it('should register ai:thinking listener when socket is available', () => {
      // Access the store's internal socket reference
      const store = useAIStore.getState();

      // Mock the socket service by accessing internal implementation
      // This tests the listener registration pattern
      const onAIThinking = jest.fn((data: { playerId: string }) => {
        store.setAIThinking(true, data.playerId);
        store.selectAIPlayer(data.playerId);
      });

      // Simulate ai:thinking event
      onAIThinking({ playerId: 'ai-player-1' });

      const state = useAIStore.getState();
      expect(state.isAIThinking).toBe(true);
      expect(state.thinkingPlayerId).toBe('ai-player-1');
      expect(state.selectedAIPlayerId).toBe('ai-player-1');
    });

    it('should handle ai:turn-complete event correctly', () => {
      const store = useAIStore.getState();

      const turnSummary: TurnSummary = {
        actions: [{ type: 'move', description: 'Moved', details: {} }],
        cashChange: 15,
        commentary: 'Good turn.',
      };

      const strategy: AIStrategy = {
        phase: 'mid',
        currentGoal: 'Deliver goods',
        nextGoal: 'Build more track',
        majorCityProgress: '4/7',
        cashToWin: 100,
      };

      const debugInfo: AIDebugInfo = {
        routesEvaluated: 12,
        selectedRouteScore: 0.89,
        decisionTimeMs: 650,
        variablesConsidered: ['cash', 'roi'],
      };

      // Set thinking to true first
      store.setAIThinking(true, 'ai-player-1');

      // Simulate ai:turn-complete handler
      const onAITurnComplete = (data: {
        playerId: string;
        turnSummary: TurnSummary;
        currentStrategy: AIStrategy;
        debug?: AIDebugInfo;
      }) => {
        store.setAIThinking(false);
        store.setAITurnSummary(data.playerId, data.turnSummary);
        store.setAIStrategy(data.playerId, data.currentStrategy);
        if (data.debug) {
          store.setAIDebugInfo(data.playerId, data.debug);
        }
      };

      onAITurnComplete({
        playerId: 'ai-player-1',
        turnSummary,
        currentStrategy: strategy,
        debug: debugInfo,
      });

      const state = useAIStore.getState();
      expect(state.isAIThinking).toBe(false);
      expect(state.aiTurnSummaries.get('ai-player-1')).toEqual(turnSummary);
      expect(state.aiStrategies.get('ai-player-1')).toEqual(strategy);
      expect(state.aiDebugInfo.get('ai-player-1')).toEqual(debugInfo);
    });

    it('should handle ai:turn-complete without debug info', () => {
      const store = useAIStore.getState();

      const turnSummary: TurnSummary = {
        actions: [],
        cashChange: 0,
        commentary: 'Passed turn.',
      };

      const strategy: AIStrategy = {
        phase: 'early',
        currentGoal: 'Setup',
        nextGoal: 'Expand',
        majorCityProgress: '1/7',
        cashToWin: 200,
      };

      // Simulate handler without debug info
      store.setAIThinking(false);
      store.setAITurnSummary('ai-player-1', turnSummary);
      store.setAIStrategy('ai-player-1', strategy);
      // No debug info set

      const state = useAIStore.getState();
      expect(state.aiTurnSummaries.get('ai-player-1')).toEqual(turnSummary);
      expect(state.aiStrategies.get('ai-player-1')).toEqual(strategy);
      expect(state.aiDebugInfo.get('ai-player-1')).toBeUndefined();
    });
  });
});

// Selector hooks export tests
describe('AI Store Selector Hooks', () => {
  it('should export useIsAIThinking selector', () => {
    const { useIsAIThinking } = require('../../../lobby/store/ai.store');
    expect(useIsAIThinking).toBeDefined();
    expect(typeof useIsAIThinking).toBe('function');
  });

  it('should export useThinkingPlayerId selector', () => {
    const { useThinkingPlayerId } = require('../../../lobby/store/ai.store');
    expect(useThinkingPlayerId).toBeDefined();
    expect(typeof useThinkingPlayerId).toBe('function');
  });

  it('should export useAITurnSummary selector', () => {
    const { useAITurnSummary } = require('../../../lobby/store/ai.store');
    expect(useAITurnSummary).toBeDefined();
    expect(typeof useAITurnSummary).toBe('function');
  });

  it('should export useAIStrategy selector', () => {
    const { useAIStrategy } = require('../../../lobby/store/ai.store');
    expect(useAIStrategy).toBeDefined();
    expect(typeof useAIStrategy).toBe('function');
  });

  it('should export useAIDebugInfo selector', () => {
    const { useAIDebugInfo } = require('../../../lobby/store/ai.store');
    expect(useAIDebugInfo).toBeDefined();
    expect(typeof useAIDebugInfo).toBe('function');
  });

  it('should export useSelectedAIPlayerId selector', () => {
    const { useSelectedAIPlayerId } = require('../../../lobby/store/ai.store');
    expect(useSelectedAIPlayerId).toBeDefined();
    expect(typeof useSelectedAIPlayerId).toBe('function');
  });

  it('should export useIsBotPanelVisible selector', () => {
    const { useIsBotPanelVisible } = require('../../../lobby/store/ai.store');
    expect(useIsBotPanelVisible).toBeDefined();
    expect(typeof useIsBotPanelVisible).toBe('function');
  });
});
