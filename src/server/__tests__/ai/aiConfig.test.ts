/**
 * Unit Tests for AI Types and Configuration
 * Tests type definitions, config constants, and configuration helpers
 */

import {
  AI_DIFFICULTY_CONFIG,
  AI_PERSONALITY_CONFIG,
  getAIConfig,
  AI_NAMES,
  AI_TURN_TIMEOUT_MS,
  AI_BUILD_BUDGET_PER_TURN,
} from '../../services/ai/aiConfig';
import {
  DifficultyParams,
  PersonalityParams,
  AIConfig,
} from '../../services/ai/types';
import {
  AIDifficulty,
  AIPersonality,
  Player,
  TrainType,
  PlayerColor,
} from '../../../shared/types/GameTypes';

describe('AI Types and Configuration', () => {
  describe('AIDifficulty type', () => {
    it('should have exactly three difficulty levels', () => {
      const difficulties: AIDifficulty[] = ['easy', 'medium', 'hard'];
      const configKeys = Object.keys(AI_DIFFICULTY_CONFIG);

      expect(configKeys).toHaveLength(3);
      expect(configKeys).toEqual(expect.arrayContaining(difficulties));
    });

    it('should accept valid difficulty values', () => {
      const validDifficulties: AIDifficulty[] = ['easy', 'medium', 'hard'];

      validDifficulties.forEach((difficulty) => {
        expect(AI_DIFFICULTY_CONFIG[difficulty]).toBeDefined();
      });
    });
  });

  describe('AIPersonality type', () => {
    it('should have exactly six personality types', () => {
      const personalities: AIPersonality[] = [
        'optimizer',
        'network_builder',
        'opportunist',
        'blocker',
        'steady_hand',
        'chaos_agent',
      ];
      const configKeys = Object.keys(AI_PERSONALITY_CONFIG);

      expect(configKeys).toHaveLength(6);
      expect(configKeys).toEqual(expect.arrayContaining(personalities));
    });

    it('should accept valid personality values', () => {
      const validPersonalities: AIPersonality[] = [
        'optimizer',
        'network_builder',
        'opportunist',
        'blocker',
        'steady_hand',
        'chaos_agent',
      ];

      validPersonalities.forEach((personality) => {
        expect(AI_PERSONALITY_CONFIG[personality]).toBeDefined();
      });
    });
  });

  describe('Player interface with AI fields', () => {
    it('should accept a player with AI fields', () => {
      const aiPlayer: Player = {
        id: 'ai-1',
        name: 'Otto',
        color: PlayerColor.BLUE,
        money: 50,
        trainType: TrainType.Freight,
        turnNumber: 1,
        trainState: {
          position: null,
          remainingMovement: 9,
          movementHistory: [],
          loads: [],
        },
        hand: [],
        isAI: true,
        aiDifficulty: 'medium',
        aiPersonality: 'optimizer',
      };

      expect(aiPlayer.isAI).toBe(true);
      expect(aiPlayer.aiDifficulty).toBe('medium');
      expect(aiPlayer.aiPersonality).toBe('optimizer');
    });

    it('should accept a human player without AI fields', () => {
      const humanPlayer: Player = {
        id: 'human-1',
        userId: 'user-123',
        name: 'Human Player',
        color: PlayerColor.RED,
        money: 50,
        trainType: TrainType.Freight,
        turnNumber: 1,
        trainState: {
          position: null,
          remainingMovement: 9,
          movementHistory: [],
          loads: [],
        },
        hand: [],
      };

      expect(humanPlayer.isAI).toBeUndefined();
      expect(humanPlayer.aiDifficulty).toBeUndefined();
      expect(humanPlayer.aiPersonality).toBeUndefined();
    });

    it('should accept a player with isAI false', () => {
      const player: Player = {
        id: 'player-1',
        name: 'Player',
        color: PlayerColor.GREEN,
        money: 50,
        trainType: TrainType.Freight,
        turnNumber: 1,
        trainState: {
          position: null,
          remainingMovement: 9,
          movementHistory: [],
          loads: [],
        },
        hand: [],
        isAI: false,
      };

      expect(player.isAI).toBe(false);
    });
  });

  describe('DifficultyParams interface', () => {
    it('should have all required fields for each difficulty level', () => {
      const requiredFields: (keyof DifficultyParams)[] = [
        'planningHorizon',
        'variablesConsidered',
        'evaluationDepth',
        'thinkingDelayMs',
      ];

      Object.values(AI_DIFFICULTY_CONFIG).forEach((params) => {
        requiredFields.forEach((field) => {
          expect(params[field]).toBeDefined();
        });
      });
    });

    it('should have valid evaluationDepth values', () => {
      const validDepths = ['satisfice', 'good', 'optimal'];

      Object.values(AI_DIFFICULTY_CONFIG).forEach((params) => {
        expect(validDepths).toContain(params.evaluationDepth);
      });
    });

    it('should have positive numeric values for numeric fields', () => {
      Object.values(AI_DIFFICULTY_CONFIG).forEach((params) => {
        expect(params.planningHorizon).toBeGreaterThan(0);
        expect(params.variablesConsidered).toBeGreaterThan(0);
        expect(params.thinkingDelayMs).toBeGreaterThan(0);
      });
    });
  });

  describe('PersonalityParams interface', () => {
    it('should have all required fields for each personality', () => {
      const requiredFields: (keyof PersonalityParams)[] = [
        'priorityWeights',
        'riskTolerance',
        'commentaryStyle',
      ];

      Object.values(AI_PERSONALITY_CONFIG).forEach((params) => {
        requiredFields.forEach((field) => {
          expect(params[field]).toBeDefined();
        });
      });
    });

    it('should have valid commentaryStyle values', () => {
      const validStyles = ['analytical', 'strategic', 'reactive', 'competitive', 'methodical', 'humorous'];

      Object.values(AI_PERSONALITY_CONFIG).forEach((params) => {
        expect(validStyles).toContain(params.commentaryStyle);
      });
    });

    it('should have riskTolerance between 0 and 1', () => {
      Object.values(AI_PERSONALITY_CONFIG).forEach((params) => {
        expect(params.riskTolerance).toBeGreaterThanOrEqual(0);
        expect(params.riskTolerance).toBeLessThanOrEqual(1);
      });
    });

    it('should have non-empty priorityWeights objects', () => {
      Object.values(AI_PERSONALITY_CONFIG).forEach((params) => {
        expect(Object.keys(params.priorityWeights).length).toBeGreaterThan(0);
      });
    });

    it('should have positive priorityWeight values', () => {
      Object.values(AI_PERSONALITY_CONFIG).forEach((params) => {
        Object.values(params.priorityWeights).forEach((weight) => {
          expect(weight).toBeGreaterThan(0);
        });
      });
    });
  });

  describe('AI_DIFFICULTY_CONFIG', () => {
    it('should have easy difficulty with correct values', () => {
      const easy = AI_DIFFICULTY_CONFIG.easy;

      expect(easy.planningHorizon).toBe(1);
      expect(easy.variablesConsidered).toBe(4);
      expect(easy.evaluationDepth).toBe('satisfice');
      expect(easy.thinkingDelayMs).toBe(1500);
    });

    it('should have medium difficulty with correct values', () => {
      const medium = AI_DIFFICULTY_CONFIG.medium;

      expect(medium.planningHorizon).toBe(3);
      expect(medium.variablesConsidered).toBe(8);
      expect(medium.evaluationDepth).toBe('good');
      expect(medium.thinkingDelayMs).toBe(1000);
    });

    it('should have hard difficulty with correct values', () => {
      const hard = AI_DIFFICULTY_CONFIG.hard;

      expect(hard.planningHorizon).toBe(5);
      expect(hard.variablesConsidered).toBe(12);
      expect(hard.evaluationDepth).toBe('optimal');
      expect(hard.thinkingDelayMs).toBe(800);
    });

    it('should have increasing planning horizon by difficulty', () => {
      expect(AI_DIFFICULTY_CONFIG.easy.planningHorizon)
        .toBeLessThan(AI_DIFFICULTY_CONFIG.medium.planningHorizon);
      expect(AI_DIFFICULTY_CONFIG.medium.planningHorizon)
        .toBeLessThan(AI_DIFFICULTY_CONFIG.hard.planningHorizon);
    });

    it('should have increasing variables considered by difficulty', () => {
      expect(AI_DIFFICULTY_CONFIG.easy.variablesConsidered)
        .toBeLessThan(AI_DIFFICULTY_CONFIG.medium.variablesConsidered);
      expect(AI_DIFFICULTY_CONFIG.medium.variablesConsidered)
        .toBeLessThan(AI_DIFFICULTY_CONFIG.hard.variablesConsidered);
    });

    it('should have decreasing thinking delay by difficulty', () => {
      expect(AI_DIFFICULTY_CONFIG.easy.thinkingDelayMs)
        .toBeGreaterThan(AI_DIFFICULTY_CONFIG.medium.thinkingDelayMs);
      expect(AI_DIFFICULTY_CONFIG.medium.thinkingDelayMs)
        .toBeGreaterThan(AI_DIFFICULTY_CONFIG.hard.thinkingDelayMs);
    });
  });

  describe('AI_PERSONALITY_CONFIG', () => {
    it('should have optimizer personality with correct values', () => {
      const optimizer = AI_PERSONALITY_CONFIG.optimizer;

      expect(optimizer.priorityWeights.roi).toBe(1.5);
      expect(optimizer.priorityWeights.efficiency).toBe(1.3);
      expect(optimizer.priorityWeights.speed).toBe(1.0);
      expect(optimizer.riskTolerance).toBe(0.2);
      expect(optimizer.commentaryStyle).toBe('analytical');
    });

    it('should have network_builder personality with correct values', () => {
      const networkBuilder = AI_PERSONALITY_CONFIG.network_builder;

      expect(networkBuilder.priorityWeights.connectivity).toBe(1.5);
      expect(networkBuilder.priorityWeights.futureValue).toBe(1.3);
      expect(networkBuilder.priorityWeights.majorCities).toBe(1.2);
      expect(networkBuilder.riskTolerance).toBe(0.5);
      expect(networkBuilder.commentaryStyle).toBe('strategic');
    });

    it('should have opportunist personality with correct values', () => {
      const opportunist = AI_PERSONALITY_CONFIG.opportunist;

      expect(opportunist.priorityWeights.immediatePayout).toBe(1.5);
      expect(opportunist.priorityWeights.flexibility).toBe(1.2);
      expect(opportunist.riskTolerance).toBe(0.8);
      expect(opportunist.commentaryStyle).toBe('reactive');
    });

    it('should have blocker personality with correct values', () => {
      const blocker = AI_PERSONALITY_CONFIG.blocker;

      expect(blocker.priorityWeights.opponentDenial).toBe(1.4);
      expect(blocker.priorityWeights.chokepoints).toBe(1.3);
      expect(blocker.priorityWeights.scarcity).toBe(1.2);
      expect(blocker.riskTolerance).toBe(0.5);
      expect(blocker.commentaryStyle).toBe('competitive');
    });

    it('should have steady_hand personality with correct values', () => {
      const steadyHand = AI_PERSONALITY_CONFIG.steady_hand;

      expect(steadyHand.priorityWeights.consistency).toBe(1.5);
      expect(steadyHand.priorityWeights.lowRisk).toBe(1.4);
      expect(steadyHand.priorityWeights.terrain).toBe(0.7);
      expect(steadyHand.riskTolerance).toBe(0.1);
      expect(steadyHand.commentaryStyle).toBe('methodical');
    });

    it('should have chaos_agent personality with correct values', () => {
      const chaosAgent = AI_PERSONALITY_CONFIG.chaos_agent;

      expect(chaosAgent.priorityWeights.unpredictability).toBe(1.3);
      expect(chaosAgent.priorityWeights.entertainment).toBe(1.2);
      expect(chaosAgent.riskTolerance).toBe(0.9);
      expect(chaosAgent.commentaryStyle).toBe('humorous');
    });

    it('should have distinct risk tolerances for different personalities', () => {
      // steady_hand should have lowest risk tolerance
      expect(AI_PERSONALITY_CONFIG.steady_hand.riskTolerance)
        .toBeLessThan(AI_PERSONALITY_CONFIG.optimizer.riskTolerance);

      // chaos_agent should have highest risk tolerance
      expect(AI_PERSONALITY_CONFIG.chaos_agent.riskTolerance)
        .toBeGreaterThan(AI_PERSONALITY_CONFIG.blocker.riskTolerance);

      // opportunist should have high risk tolerance
      expect(AI_PERSONALITY_CONFIG.opportunist.riskTolerance)
        .toBeGreaterThan(AI_PERSONALITY_CONFIG.network_builder.riskTolerance);
    });
  });

  describe('getAIConfig', () => {
    it('should return combined config for all difficulty/personality combinations', () => {
      const difficulties: AIDifficulty[] = ['easy', 'medium', 'hard'];
      const personalities: AIPersonality[] = [
        'optimizer',
        'network_builder',
        'opportunist',
        'blocker',
        'steady_hand',
        'chaos_agent',
      ];

      difficulties.forEach((difficulty) => {
        personalities.forEach((personality) => {
          const config = getAIConfig(difficulty, personality);

          expect(config).toHaveProperty('difficulty');
          expect(config).toHaveProperty('personality');
          expect(config.difficulty).toEqual(AI_DIFFICULTY_CONFIG[difficulty]);
          expect(config.personality).toEqual(AI_PERSONALITY_CONFIG[personality]);
        });
      });
    });

    it('should return correct config for easy optimizer', () => {
      const config = getAIConfig('easy', 'optimizer');

      expect(config.difficulty.planningHorizon).toBe(1);
      expect(config.personality.commentaryStyle).toBe('analytical');
    });

    it('should return correct config for hard chaos_agent', () => {
      const config = getAIConfig('hard', 'chaos_agent');

      expect(config.difficulty.planningHorizon).toBe(5);
      expect(config.personality.commentaryStyle).toBe('humorous');
    });

    it('should return a new object each time (not a reference)', () => {
      const config1 = getAIConfig('medium', 'blocker');
      const config2 = getAIConfig('medium', 'blocker');

      expect(config1).not.toBe(config2);
      expect(config1).toEqual(config2);
    });
  });

  describe('AI_NAMES', () => {
    it('should have names for all personality types', () => {
      const personalities: AIPersonality[] = [
        'optimizer',
        'network_builder',
        'opportunist',
        'blocker',
        'steady_hand',
        'chaos_agent',
      ];

      personalities.forEach((personality) => {
        expect(AI_NAMES[personality]).toBeDefined();
        expect(Array.isArray(AI_NAMES[personality])).toBe(true);
        expect(AI_NAMES[personality].length).toBeGreaterThan(0);
      });
    });

    it('should have at least 4 names per personality', () => {
      Object.values(AI_NAMES).forEach((names) => {
        expect(names.length).toBeGreaterThanOrEqual(4);
      });
    });

    it('should have unique names within each personality', () => {
      Object.values(AI_NAMES).forEach((names) => {
        const uniqueNames = new Set(names);
        expect(uniqueNames.size).toBe(names.length);
      });
    });
  });

  describe('AI Constants', () => {
    it('should have AI_TURN_TIMEOUT_MS set to 30 seconds', () => {
      expect(AI_TURN_TIMEOUT_MS).toBe(30000);
    });

    it('should have AI_BUILD_BUDGET_PER_TURN set to 20 million ECU', () => {
      expect(AI_BUILD_BUDGET_PER_TURN).toBe(20);
    });
  });
});
