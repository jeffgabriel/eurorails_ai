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
