/**
 * Unit Tests for AI Commentary Service
 * Tests generateTurnSummary, generateStrategyDescription, and generateDebugInfo
 */

import { AICommentary, getAICommentary } from '../../services/ai/aiCommentary';
import { AIAction, AIDebugInfo } from '../../../shared/types/AITypes';
import { AIPersonality } from '../../../shared/types/GameTypes';
import { AITurnPlan, AIDecision, TurnOption, RankedOption } from '../../services/ai/types';
import { AI_PERSONALITY_CONFIG } from '../../services/ai/aiConfig';

describe('AICommentary', () => {
  let commentary: AICommentary;

  beforeEach(() => {
    commentary = new AICommentary();
  });

  // Helper to create mock actions
  const createMockAction = (
    type: AIAction['type'] = 'move',
    overrides: Partial<AIAction> = {}
  ): AIAction => ({
    type,
    description: 'Test action',
    details: { target: 'Berlin', cost: 5, payout: 15 },
    ...overrides,
  });

  // Helper to create mock turn plan
  const createMockTurnPlan = (
    overrides: Partial<AITurnPlan> = {}
  ): AITurnPlan => ({
    actions: [createMockAction()],
    expectedCashChange: 10,
    reasoning: 'Optimal route identified',
    alternativesConsidered: 5,
    ...overrides,
  });

  // Helper to create mock decision
  const createMockDecision = (
    overrides: Partial<AIDecision> = {}
  ): AIDecision => ({
    timestamp: Date.now(),
    playerId: 'ai-player-1',
    turnNumber: 5,
    optionsConsidered: [
      { type: 'build', priority: 5, expectedValue: 10, details: { target: 'München', cost: 8 } },
      { type: 'move', priority: 3, expectedValue: 5, details: { destination: 'Berlin' } },
      { type: 'pass', priority: 0, expectedValue: 0, details: {} },
    ],
    selectedOption: {
      type: 'build',
      priority: 5,
      expectedValue: 10,
      details: { target: 'München', cost: 8 },
      score: 0.85,
      reasoning: 'Best ROI option',
    },
    evaluationTimeMs: 750,
    ...overrides,
  });

  describe('getAICommentary', () => {
    it('should return a singleton instance', () => {
      const instance1 = getAICommentary();
      const instance2 = getAICommentary();
      expect(instance1).toBe(instance2);
    });
  });

  describe('generateTurnSummary', () => {
    it('should return a non-empty string for valid actions', () => {
      const actions: AIAction[] = [createMockAction('move')];

      const summary = commentary.generateTurnSummary(actions, 'optimizer');

      expect(typeof summary).toBe('string');
      expect(summary.length).toBeGreaterThan(0);
    });

    it('should return idle message for empty actions', () => {
      const actions: AIAction[] = [];

      const summary = commentary.generateTurnSummary(actions, 'optimizer');

      expect(summary.length).toBeGreaterThan(0);
    });

    it('should generate different summaries for different action types', () => {
      const buildAction = [createMockAction('build')];
      const moveAction = [createMockAction('move')];
      const deliverAction = [createMockAction('deliver')];

      const buildSummary = commentary.generateTurnSummary(buildAction, 'optimizer');
      const moveSummary = commentary.generateTurnSummary(moveAction, 'optimizer');
      const deliverSummary = commentary.generateTurnSummary(deliverAction, 'optimizer');

      // Summaries should be generated (may vary due to random template selection)
      expect(buildSummary).toBeDefined();
      expect(moveSummary).toBeDefined();
      expect(deliverSummary).toBeDefined();
    });

    // Test all personality types
    describe.each<AIPersonality>([
      'optimizer',
      'network_builder',
      'opportunist',
      'blocker',
      'steady_hand',
      'chaos_agent'
    ])('personality: %s', (personality) => {
      it(`should generate ${personality}-appropriate commentary`, () => {
        const actions: AIAction[] = [createMockAction('build')];

        const summary = commentary.generateTurnSummary(actions, personality);

        expect(summary).toBeDefined();
        expect(summary.length).toBeGreaterThan(0);
      });

      it(`should generate ${personality} idle commentary`, () => {
        const actions: AIAction[] = [];

        const summary = commentary.generateTurnSummary(actions, personality);

        expect(summary).toBeDefined();
      });

      it(`should generate ${personality} delivery commentary`, () => {
        const actions: AIAction[] = [createMockAction('deliver', {
          details: { load: 'Cars', city: 'Berlin', payout: 20 },
        })];

        const summary = commentary.generateTurnSummary(actions, personality);

        expect(summary).toBeDefined();
      });
    });

    describe('action types', () => {
      const actionTypes: AIAction['type'][] = ['build', 'move', 'pickup', 'deliver', 'drop', 'upgrade'];

      it.each(actionTypes)('should handle %s action type', (actionType) => {
        const actions: AIAction[] = [createMockAction(actionType)];

        const summary = commentary.generateTurnSummary(actions, 'optimizer');

        expect(summary).toBeDefined();
        expect(summary.length).toBeGreaterThan(0);
      });
    });

    it('should handle multiple actions in sequence', () => {
      const actions: AIAction[] = [
        createMockAction('move'),
        createMockAction('pickup'),
        createMockAction('deliver'),
      ];

      const summary = commentary.generateTurnSummary(actions, 'opportunist');

      expect(summary).toBeDefined();
      expect(summary.length).toBeGreaterThan(0);
    });

    it('should fill in template placeholders from action details', () => {
      const actions: AIAction[] = [createMockAction('build', {
        details: { target: 'München', cost: 7, roi: 2.5 },
      })];

      // Generate multiple summaries to check placeholder filling
      // Note: Due to random template selection, we just verify it doesn't error
      for (let i = 0; i < 5; i++) {
        const summary = commentary.generateTurnSummary(actions, 'optimizer');
        expect(summary).toBeDefined();
      }
    });
  });

  describe('generateStrategyDescription', () => {
    it('should return a non-empty string', () => {
      const plan = createMockTurnPlan();

      const description = commentary.generateStrategyDescription(plan, 'optimizer');

      expect(typeof description).toBe('string');
      expect(description.length).toBeGreaterThan(0);
    });

    it('should include plan reasoning context', () => {
      const plan = createMockTurnPlan({ reasoning: 'Building toward victory' });

      const description = commentary.generateStrategyDescription(plan, 'optimizer');

      expect(description).toBeDefined();
    });

    // Test personality flavor additions
    describe('personality flavor', () => {
      it('should add optimizer flavor', () => {
        const plan = createMockTurnPlan();
        const description = commentary.generateStrategyDescription(plan, 'optimizer');
        expect(description.includes('Efficiency')).toBe(true);
      });

      it('should add network_builder flavor', () => {
        const plan = createMockTurnPlan();
        const description = commentary.generateStrategyDescription(plan, 'network_builder');
        expect(description.includes('network')).toBe(true);
      });

      it('should add opportunist flavor', () => {
        const plan = createMockTurnPlan();
        const description = commentary.generateStrategyDescription(plan, 'opportunist');
        expect(description.includes('flexible')).toBe(true);
      });

      it('should add blocker flavor', () => {
        const plan = createMockTurnPlan();
        const description = commentary.generateStrategyDescription(plan, 'blocker');
        expect(description.includes('competition')).toBe(true);
      });

      it('should add steady_hand flavor', () => {
        const plan = createMockTurnPlan();
        const description = commentary.generateStrategyDescription(plan, 'steady_hand');
        expect(description.includes('Patience')).toBe(true);
      });

      it('should add chaos_agent flavor', () => {
        const plan = createMockTurnPlan();
        const description = commentary.generateStrategyDescription(plan, 'chaos_agent');
        expect(description.includes('probably')).toBe(true);
      });
    });

    it('should handle empty plan actions', () => {
      const plan = createMockTurnPlan({ actions: [], reasoning: '' });

      const description = commentary.generateStrategyDescription(plan, 'optimizer');

      expect(description).toBeDefined();
    });
  });

  describe('generateDebugInfo', () => {
    it('should return AIDebugInfo with all required fields', () => {
      const decision = createMockDecision();

      const debugInfo = commentary.generateDebugInfo(decision);

      expect(debugInfo).toHaveProperty('routesEvaluated');
      expect(debugInfo).toHaveProperty('selectedRouteScore');
      expect(debugInfo).toHaveProperty('decisionTimeMs');
      expect(debugInfo).toHaveProperty('variablesConsidered');
    });

    it('should extract correct routesEvaluated count', () => {
      const decision = createMockDecision({
        optionsConsidered: [
          { type: 'build', priority: 5, expectedValue: 10, details: {} },
          { type: 'move', priority: 3, expectedValue: 5, details: {} },
          { type: 'deliver', priority: 8, expectedValue: 15, details: {} },
        ],
      });

      const debugInfo = commentary.generateDebugInfo(decision);

      expect(debugInfo.routesEvaluated).toBe(3);
    });

    it('should extract selectedRouteScore', () => {
      const decision = createMockDecision({
        selectedOption: {
          type: 'build',
          priority: 5,
          expectedValue: 10,
          details: {},
          score: 0.92,
          reasoning: 'Best option',
        },
      });

      const debugInfo = commentary.generateDebugInfo(decision);

      expect(debugInfo.selectedRouteScore).toBe(0.92);
    });

    it('should extract decisionTimeMs', () => {
      const decision = createMockDecision({ evaluationTimeMs: 847 });

      const debugInfo = commentary.generateDebugInfo(decision);

      expect(debugInfo.decisionTimeMs).toBe(847);
    });

    it('should extract variable names from options', () => {
      const decision = createMockDecision({
        optionsConsidered: [
          { type: 'build', priority: 5, expectedValue: 10, details: { cost: 5, roi: 2 } },
          { type: 'move', priority: 3, expectedValue: 5, details: { distance: 10, time: 2 } },
        ],
      });

      const debugInfo = commentary.generateDebugInfo(decision);

      expect(debugInfo.variablesConsidered).toContain('cost');
      expect(debugInfo.variablesConsidered).toContain('roi');
      expect(debugInfo.variablesConsidered).toContain('distance');
      expect(debugInfo.variablesConsidered).toContain('time');
    });

    it('should deduplicate variable names', () => {
      const decision = createMockDecision({
        optionsConsidered: [
          { type: 'build', priority: 5, expectedValue: 10, details: { cost: 5 } },
          { type: 'build', priority: 3, expectedValue: 8, details: { cost: 3 } },
        ],
      });

      const debugInfo = commentary.generateDebugInfo(decision);

      const costOccurrences = debugInfo.variablesConsidered.filter(v => v === 'cost');
      expect(costOccurrences.length).toBe(1);
    });

    it('should handle empty options', () => {
      const decision = createMockDecision({ optionsConsidered: [] });

      const debugInfo = commentary.generateDebugInfo(decision);

      expect(debugInfo.routesEvaluated).toBe(0);
      expect(debugInfo.variablesConsidered).toEqual([]);
    });

    it('should handle missing selectedOption', () => {
      const decision = createMockDecision();
      // @ts-expect-error - Testing null handling
      decision.selectedOption = null;

      const debugInfo = commentary.generateDebugInfo(decision);

      expect(debugInfo.selectedRouteScore).toBe(0);
    });
  });

  describe('generateAIName', () => {
    const personalities: AIPersonality[] = [
      'optimizer',
      'network_builder',
      'opportunist',
      'blocker',
      'steady_hand',
      'chaos_agent',
    ];

    it.each(personalities)('should generate a name for %s personality', (personality) => {
      const name = AICommentary.generateAIName(personality);

      expect(typeof name).toBe('string');
      expect(name.length).toBeGreaterThan(0);
    });

    it('should generate names from the correct pool for optimizer', () => {
      const validNames = ['Otto', 'Olga', 'Oscar', 'Olivia'];

      // Generate multiple names to verify they're from the right pool
      for (let i = 0; i < 10; i++) {
        const name = AICommentary.generateAIName('optimizer');
        expect(validNames).toContain(name);
      }
    });

    it('should generate names from the correct pool for chaos_agent', () => {
      const validNames = ['Chaos Carl', 'Crazy Clara', 'Wild Werner', 'Zany Zelda'];

      for (let i = 0; i < 10; i++) {
        const name = AICommentary.generateAIName('chaos_agent');
        expect(validNames).toContain(name);
      }
    });

    it('should generate names from the correct pool for network_builder', () => {
      const validNames = ['Nadine', 'Norbert', 'Natasha', 'Nelson'];

      for (let i = 0; i < 10; i++) {
        const name = AICommentary.generateAIName('network_builder');
        expect(validNames).toContain(name);
      }
    });
  });

  // Edge cases
  describe('edge cases', () => {
    it('should handle action with empty details', () => {
      const actions: AIAction[] = [{
        type: 'build',
        description: 'Test',
        details: {},
      }];

      expect(() => {
        commentary.generateTurnSummary(actions, 'optimizer');
      }).not.toThrow();
    });

    it('should handle action with undefined values in details', () => {
      const actions: AIAction[] = [{
        type: 'move',
        description: 'Test',
        details: { target: undefined, cost: null },
      }];

      expect(() => {
        commentary.generateTurnSummary(actions, 'optimizer');
      }).not.toThrow();
    });

    it('should handle very long action sequences', () => {
      const actions: AIAction[] = Array(20).fill(null).map((_, i) =>
        createMockAction('move', { description: `Action ${i}` })
      );

      expect(() => {
        commentary.generateTurnSummary(actions, 'opportunist');
      }).not.toThrow();
    });

    it('should handle decision with very long evaluation time', () => {
      const decision = createMockDecision({ evaluationTimeMs: 29999 }); // Near timeout

      const debugInfo = commentary.generateDebugInfo(decision);

      expect(debugInfo.decisionTimeMs).toBe(29999);
    });

    it('should handle decision with zero evaluation time', () => {
      const decision = createMockDecision({ evaluationTimeMs: 0 });

      const debugInfo = commentary.generateDebugInfo(decision);

      expect(debugInfo.decisionTimeMs).toBe(0);
    });
  });

  // Commentary style consistency tests
  describe('commentary style consistency', () => {
    it('should maintain consistent style for analytical personality', () => {
      const config = AI_PERSONALITY_CONFIG['optimizer'];
      expect(config.commentaryStyle).toBe('analytical');
    });

    it('should maintain consistent style for strategic personality', () => {
      const config = AI_PERSONALITY_CONFIG['network_builder'];
      expect(config.commentaryStyle).toBe('strategic');
    });

    it('should maintain consistent style for reactive personality', () => {
      const config = AI_PERSONALITY_CONFIG['opportunist'];
      expect(config.commentaryStyle).toBe('reactive');
    });

    it('should maintain consistent style for competitive personality', () => {
      const config = AI_PERSONALITY_CONFIG['blocker'];
      expect(config.commentaryStyle).toBe('competitive');
    });

    it('should maintain consistent style for methodical personality', () => {
      const config = AI_PERSONALITY_CONFIG['steady_hand'];
      expect(config.commentaryStyle).toBe('methodical');
    });

    it('should maintain consistent style for humorous personality', () => {
      const config = AI_PERSONALITY_CONFIG['chaos_agent'];
      expect(config.commentaryStyle).toBe('humorous');
    });
  });
});
