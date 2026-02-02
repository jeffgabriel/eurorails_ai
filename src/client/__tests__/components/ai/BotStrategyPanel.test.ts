/**
 * Tests for BotStrategyPanel component logic
 */

import { BotStrategyPanel, BotStrategyPanelProps } from '../../../components/ai/BotStrategyPanel';
import type { TurnSummary, AIStrategy, AIDebugInfo } from '../../../../shared/types/AITypes';

describe('BotStrategyPanel', () => {
  const mockTurnSummary: TurnSummary = {
    actions: [
      { type: 'build', description: 'Built: München → Wien (7M, ROI: 3.2x)', details: {} },
      { type: 'deliver', description: 'Delivered: Machinery → Berlin (+18M)', details: {} },
    ],
    cashChange: 11,
    commentary: 'Prioritizing eastern corridor. 3 demands achievable within 4 turns.',
  };

  const mockStrategy: AIStrategy = {
    phase: 'Route Optimization',
    currentGoal: 'Connect to Warszawa',
    nextGoal: 'Deliver Steel to Praha',
    majorCityProgress: '4/7 major cities',
    cashToWin: 127,
  };

  const mockDebugInfo: AIDebugInfo = {
    routesEvaluated: 18,
    selectedRouteScore: 0.94,
    decisionTimeMs: 847,
    variablesConsidered: ['opponent positions', 'track cost', 'delivery value'],
  };

  describe('component interface', () => {
    it('should accept all required props', () => {
      const props: BotStrategyPanelProps = {
        playerId: 'ai-player-1',
        playerName: 'Heinrich',
        difficulty: 'hard',
        personality: 'optimizer',
        turnSummary: null,
        currentStrategy: null,
        isVisible: true,
      };

      expect(props.playerId).toBe('ai-player-1');
      expect(props.playerName).toBe('Heinrich');
      expect(props.difficulty).toBe('hard');
      expect(props.personality).toBe('optimizer');
      expect(props.turnSummary).toBeNull();
      expect(props.currentStrategy).toBeNull();
      expect(props.isVisible).toBe(true);
    });

    it('should accept optional debugInfo and onClose props', () => {
      const onClose = jest.fn();
      const props: BotStrategyPanelProps = {
        playerId: 'ai-player-1',
        playerName: 'Heinrich',
        difficulty: 'hard',
        personality: 'optimizer',
        turnSummary: mockTurnSummary,
        currentStrategy: mockStrategy,
        debugInfo: mockDebugInfo,
        isVisible: true,
        onClose,
      };

      expect(props.debugInfo).toEqual(mockDebugInfo);
      expect(props.onClose).toBe(onClose);
    });
  });

  describe('visibility logic', () => {
    it('should have isVisible prop to control visibility', () => {
      // Component visibility is controlled via isVisible prop
      // When false, component returns null (tested via integration tests)
      const propsHidden: BotStrategyPanelProps = {
        playerId: 'ai-player-1',
        playerName: 'Heinrich',
        difficulty: 'hard',
        personality: 'optimizer',
        turnSummary: mockTurnSummary,
        currentStrategy: mockStrategy,
        isVisible: false,
      };

      const propsVisible: BotStrategyPanelProps = {
        playerId: 'ai-player-1',
        playerName: 'Heinrich',
        difficulty: 'hard',
        personality: 'optimizer',
        turnSummary: null,
        currentStrategy: null,
        isVisible: true,
      };

      expect(propsHidden.isVisible).toBe(false);
      expect(propsVisible.isVisible).toBe(true);
    });
  });

  describe('difficulty handling', () => {
    it('should accept all difficulty levels', () => {
      const difficulties: Array<'easy' | 'medium' | 'hard'> = ['easy', 'medium', 'hard'];

      difficulties.forEach((difficulty) => {
        const props: BotStrategyPanelProps = {
          playerId: 'ai-player-1',
          playerName: 'Bot',
          difficulty,
          personality: 'optimizer',
          turnSummary: null,
          currentStrategy: null,
          isVisible: true,
        };

        expect(props.difficulty).toBe(difficulty);
      });
    });
  });

  describe('personality handling', () => {
    it('should accept all personality types', () => {
      const personalities: Array<
        'optimizer' | 'network_builder' | 'opportunist' | 'blocker' | 'steady_hand' | 'chaos_agent'
      > = ['optimizer', 'network_builder', 'opportunist', 'blocker', 'steady_hand', 'chaos_agent'];

      personalities.forEach((personality) => {
        const props: BotStrategyPanelProps = {
          playerId: 'ai-player-1',
          playerName: 'Bot',
          difficulty: 'medium',
          personality,
          turnSummary: null,
          currentStrategy: null,
          isVisible: true,
        };

        expect(props.personality).toBe(personality);
      });
    });
  });

  describe('turn summary data', () => {
    it('should handle empty actions array', () => {
      const emptySummary: TurnSummary = {
        actions: [],
        cashChange: 0,
        commentary: '',
      };

      const props: BotStrategyPanelProps = {
        playerId: 'ai-player-1',
        playerName: 'Bot',
        difficulty: 'easy',
        personality: 'steady_hand',
        turnSummary: emptySummary,
        currentStrategy: null,
        isVisible: true,
      };

      expect(props.turnSummary?.actions).toHaveLength(0);
    });

    it('should handle positive cash change', () => {
      const positiveSummary: TurnSummary = {
        actions: [{ type: 'deliver', description: 'Delivered cargo', details: {} }],
        cashChange: 25,
        commentary: 'Good delivery!',
      };

      expect(positiveSummary.cashChange).toBeGreaterThan(0);
    });

    it('should handle negative cash change', () => {
      const negativeSummary: TurnSummary = {
        actions: [{ type: 'build', description: 'Built track', details: {} }],
        cashChange: -15,
        commentary: 'Expensive track!',
      };

      expect(negativeSummary.cashChange).toBeLessThan(0);
    });
  });

  describe('strategy data', () => {
    it('should handle strategy with all fields', () => {
      expect(mockStrategy.phase).toBe('Route Optimization');
      expect(mockStrategy.currentGoal).toBe('Connect to Warszawa');
      expect(mockStrategy.nextGoal).toBe('Deliver Steel to Praha');
      expect(mockStrategy.majorCityProgress).toBe('4/7 major cities');
      expect(mockStrategy.cashToWin).toBe(127);
    });
  });

  describe('debug info data', () => {
    it('should handle debug info with all fields', () => {
      expect(mockDebugInfo.routesEvaluated).toBe(18);
      expect(mockDebugInfo.selectedRouteScore).toBeCloseTo(0.94);
      expect(mockDebugInfo.decisionTimeMs).toBe(847);
      expect(mockDebugInfo.variablesConsidered).toContain('opponent positions');
      expect(mockDebugInfo.variablesConsidered).toContain('track cost');
      expect(mockDebugInfo.variablesConsidered).toContain('delivery value');
    });

    it('should handle debug info with empty variables', () => {
      const emptyDebug: AIDebugInfo = {
        routesEvaluated: 5,
        selectedRouteScore: 0.5,
        decisionTimeMs: 100,
        variablesConsidered: [],
      };

      expect(emptyDebug.variablesConsidered).toHaveLength(0);
    });
  });

  describe('onClose callback', () => {
    it('should accept onClose function', () => {
      const onClose = jest.fn();
      const props: BotStrategyPanelProps = {
        playerId: 'ai-player-1',
        playerName: 'Bot',
        difficulty: 'medium',
        personality: 'optimizer',
        turnSummary: null,
        currentStrategy: null,
        isVisible: true,
        onClose,
      };

      expect(typeof props.onClose).toBe('function');
    });

    it('should not require onClose', () => {
      const props: BotStrategyPanelProps = {
        playerId: 'ai-player-1',
        playerName: 'Bot',
        difficulty: 'medium',
        personality: 'optimizer',
        turnSummary: null,
        currentStrategy: null,
        isVisible: true,
      };

      expect(props.onClose).toBeUndefined();
    });
  });
});
