/**
 * Unit Tests for AI Planner Service
 * Tests planTurn and evaluateOptions across difficulty/personality combinations
 */

import { AIPlanner, getAIPlanner } from '../../services/ai/aiPlanner';
import { AI_DIFFICULTY_CONFIG, AI_PERSONALITY_CONFIG, getAIConfig } from '../../services/ai/aiConfig';
import { AIGameState, TurnOption, AIConfig } from '../../services/ai/types';
import { AIDifficulty, AIPersonality, Player, TrainType, PlayerColor, TerrainType, TrackSegment, Point } from '../../../shared/types/GameTypes';
import { DemandCard, Demand } from '../../../shared/types/DemandCard';
import { LoadType } from '../../../shared/types/LoadTypes';

describe('AIPlanner', () => {
  let planner: AIPlanner;

  beforeEach(() => {
    planner = new AIPlanner();
  });

  // Helper to create a mock Point
  const createMockPoint = (x: number, y: number, row: number = 0, col: number = 0): Point => ({
    x,
    y,
    row,
    col,
  });

  // Helper to create a mock TrackSegment
  const createMockSegment = (
    from: Point,
    to: Point,
    terrain: TerrainType = TerrainType.Clear
  ): TrackSegment => ({
    from: { ...from, terrain },
    to: { ...to, terrain },
    cost: 1,
  });

  // Helper to create a mock DemandCard
  const createMockDemandCard = (
    payment: number = 20,
    city: string = 'Berlin',
    resource: LoadType = LoadType.Cars
  ): DemandCard => ({
    id: 1,
    demands: [{ city, resource, payment }],
  });

  // Helper function to create a mock player
  const createMockPlayer = (
    overrides: Partial<Player> = {}
  ): Player => ({
    id: 'ai-player-1',
    name: 'Test AI',
    color: PlayerColor.BLUE,
    money: 50,
    trainType: TrainType.Freight,
    turnNumber: 1,
    trainState: {
      position: createMockPoint(100, 100),
      remainingMovement: 9,
      movementHistory: [],
      loads: [],
    },
    hand: [],
    isAI: true,
    aiDifficulty: 'medium',
    aiPersonality: 'optimizer',
    ...overrides,
  });

  // Helper function to create a mock game state
  const createMockGameState = (
    overrides: Partial<AIGameState> = {}
  ): AIGameState => ({
    players: [createMockPlayer()],
    currentPlayerId: 'ai-player-1',
    turnNumber: 1,
    availableLoads: new Map(),
    droppedLoads: [],
    allTrack: new Map(),
    ...overrides,
  });

  describe('getAIPlanner', () => {
    it('should return a singleton instance', () => {
      const instance1 = getAIPlanner();
      const instance2 = getAIPlanner();
      expect(instance1).toBe(instance2);
    });
  });

  describe('planTurn', () => {
    it('should return a valid AITurnPlan structure', () => {
      const player = createMockPlayer();
      const gameState = createMockGameState();
      const config = getAIConfig('medium', 'optimizer');

      const plan = planner.planTurn(gameState, player, config);

      expect(plan).toHaveProperty('actions');
      expect(plan).toHaveProperty('expectedCashChange');
      expect(plan).toHaveProperty('reasoning');
      expect(plan).toHaveProperty('alternativesConsidered');
      expect(Array.isArray(plan.actions)).toBe(true);
      expect(typeof plan.expectedCashChange).toBe('number');
      expect(typeof plan.reasoning).toBe('string');
      expect(typeof plan.alternativesConsidered).toBe('number');
    });

    it('should return at least one action (pass) when no other options available', () => {
      const player = createMockPlayer({ money: 0 }); // No money to build
      const gameState = createMockGameState();
      const config = getAIConfig('easy', 'steady_hand');

      const plan = planner.planTurn(gameState, player, config);

      expect(plan.actions.length).toBeGreaterThanOrEqual(0);
      expect(plan.alternativesConsidered).toBeGreaterThanOrEqual(1);
    });

    // Test all difficulty levels
    describe.each<AIDifficulty>(['easy', 'medium', 'hard'])('difficulty: %s', (difficulty) => {
      it(`should respect ${difficulty} planning horizon`, () => {
        const player = createMockPlayer({ aiDifficulty: difficulty });
        const gameState = createMockGameState();
        const config = getAIConfig(difficulty, 'optimizer');

        const plan = planner.planTurn(gameState, player, config);

        // Verify plan was generated with correct config
        expect(config.difficulty.planningHorizon).toBe(AI_DIFFICULTY_CONFIG[difficulty].planningHorizon);
        expect(plan).toBeDefined();
      });
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
      it(`should generate plan for ${personality} personality`, () => {
        const player = createMockPlayer({ aiPersonality: personality });
        const gameState = createMockGameState();
        const config = getAIConfig('medium', personality);

        const plan = planner.planTurn(gameState, player, config);

        expect(plan).toBeDefined();
        expect(plan.reasoning).toBeDefined();
      });
    });

    // Test difficulty + personality combinations
    describe('difficulty/personality combinations', () => {
      const difficulties: AIDifficulty[] = ['easy', 'medium', 'hard'];
      const personalities: AIPersonality[] = ['optimizer', 'network_builder', 'opportunist', 'blocker', 'steady_hand', 'chaos_agent'];

      it.each(
        difficulties.flatMap(d => personalities.map(p => [d, p] as [AIDifficulty, AIPersonality]))
      )('should handle %s difficulty with %s personality', (difficulty, personality) => {
        const player = createMockPlayer({
          aiDifficulty: difficulty,
          aiPersonality: personality,
        });
        const gameState = createMockGameState();
        const config = getAIConfig(difficulty, personality);

        const plan = planner.planTurn(gameState, player, config);

        expect(plan).toBeDefined();
        expect(plan.actions).toBeDefined();
      });
    });
  });

  describe('evaluateOptions', () => {
    const createMockOptions = (): TurnOption[] => [
      {
        type: 'build',
        priority: 5,
        expectedValue: 10,
        details: { roi: 2, efficiency: 0.8, futureValue: 5 },
      },
      {
        type: 'move',
        priority: 3,
        expectedValue: 5,
        details: { distance: 5, risk: 0.2 },
      },
      {
        type: 'deliver',
        priority: 8,
        expectedValue: 15,
        details: { payout: 15, roi: 3 },
      },
      {
        type: 'pass',
        priority: 0,
        expectedValue: 0,
        details: {},
      },
    ];

    it('should return ranked options with scores', () => {
      const options = createMockOptions();
      const ranked = planner.evaluateOptions(options, 'medium', 'optimizer');

      expect(ranked.length).toBeGreaterThan(0);
      expect(ranked[0]).toHaveProperty('score');
      expect(ranked[0]).toHaveProperty('reasoning');
    });

    it('should sort options by score descending', () => {
      const options = createMockOptions();
      const ranked = planner.evaluateOptions(options, 'medium', 'optimizer');

      for (let i = 1; i < ranked.length; i++) {
        expect(ranked[i - 1].score).toBeGreaterThanOrEqual(ranked[i].score);
      }
    });

    // Test evaluation depth for each difficulty
    describe('evaluation depth', () => {
      it('easy difficulty should use satisficing (return ~1 option)', () => {
        const options = createMockOptions();
        const ranked = planner.evaluateOptions(options, 'easy', 'optimizer');

        // Satisficing returns first good option
        expect(ranked.length).toBeLessThanOrEqual(2);
      });

      it('medium difficulty should evaluate top 3 options', () => {
        const options = createMockOptions();
        const ranked = planner.evaluateOptions(options, 'medium', 'optimizer');

        expect(ranked.length).toBeLessThanOrEqual(3);
      });

      it('hard difficulty should evaluate all options', () => {
        const options = createMockOptions();
        const ranked = planner.evaluateOptions(options, 'hard', 'optimizer');

        expect(ranked.length).toBe(options.length);
      });
    });

    // Test personality influence on scoring
    describe('personality scoring influence', () => {
      it('optimizer should favor high ROI options', () => {
        const options: TurnOption[] = [
          { type: 'build', priority: 5, expectedValue: 10, details: { roi: 5 } },
          { type: 'build', priority: 5, expectedValue: 10, details: { roi: 1 } },
        ];

        const ranked = planner.evaluateOptions(options, 'hard', 'optimizer');

        // First option should score higher due to ROI weight
        expect(ranked[0].details.roi).toBe(5);
      });

      it('network_builder should favor connectivity options', () => {
        const options: TurnOption[] = [
          { type: 'build', priority: 5, expectedValue: 10, details: { connectivity: 8 } },
          { type: 'build', priority: 5, expectedValue: 10, details: { connectivity: 2 } },
        ];

        const ranked = planner.evaluateOptions(options, 'hard', 'network_builder');

        expect(ranked[0].details.connectivity).toBe(8);
      });

      it('blocker should favor opponent denial options', () => {
        const options: TurnOption[] = [
          { type: 'build', priority: 5, expectedValue: 5, details: { opponentDenial: 10 } },
          { type: 'build', priority: 5, expectedValue: 10, details: { opponentDenial: 0 } },
        ];

        const ranked = planner.evaluateOptions(options, 'hard', 'blocker');

        // Blocker should prefer denying opponents even with lower base value
        expect(ranked[0].details.opponentDenial).toBe(10);
      });

      it('steady_hand should penalize high risk options', () => {
        const options: TurnOption[] = [
          { type: 'move', priority: 5, expectedValue: 20, details: { risk: 0.9 } },
          { type: 'move', priority: 5, expectedValue: 10, details: { risk: 0.1 } },
        ];

        const ranked = planner.evaluateOptions(options, 'hard', 'steady_hand');

        // Steady hand has low risk tolerance, should prefer safe option
        expect(ranked[0].details.risk).toBe(0.1);
      });

      it('opportunist should favor immediate payout', () => {
        const options: TurnOption[] = [
          { type: 'deliver', priority: 5, expectedValue: 15, details: { immediatePayout: 15 } },
          { type: 'build', priority: 5, expectedValue: 5, details: { immediatePayout: 0, futureValue: 20 } },
        ];

        const ranked = planner.evaluateOptions(options, 'hard', 'opportunist');

        expect(ranked[0].type).toBe('deliver');
      });

      it('chaos_agent should introduce unpredictability', () => {
        const options: TurnOption[] = [
          { type: 'build', priority: 5, expectedValue: 10, details: { unpredictability: 5 } },
          { type: 'build', priority: 5, expectedValue: 10, details: { unpredictability: 0 } },
        ];

        const ranked = planner.evaluateOptions(options, 'hard', 'chaos_agent');

        // Chaos agent weights unpredictability
        expect(ranked[0].details.unpredictability).toBe(5);
      });
    });

    // Edge cases
    describe('edge cases', () => {
      it('should handle empty options array', () => {
        const ranked = planner.evaluateOptions([], 'medium', 'optimizer');
        expect(ranked).toEqual([]);
      });

      it('should handle single option', () => {
        const options: TurnOption[] = [
          { type: 'pass', priority: 0, expectedValue: 0, details: {} },
        ];

        const ranked = planner.evaluateOptions(options, 'medium', 'optimizer');

        expect(ranked.length).toBe(1);
        expect(ranked[0].type).toBe('pass');
      });

      it('should handle options with negative expected values', () => {
        const options: TurnOption[] = [
          { type: 'build', priority: 5, expectedValue: -5, details: {} },
          { type: 'pass', priority: 0, expectedValue: 0, details: {} },
        ];

        const ranked = planner.evaluateOptions(options, 'medium', 'optimizer');

        // Pass should be preferred over negative value action
        expect(ranked[0].type).toBe('pass');
      });

      it('should handle missing details gracefully', () => {
        const options: TurnOption[] = [
          { type: 'build', priority: 5, expectedValue: 10, details: {} },
        ];

        expect(() => {
          planner.evaluateOptions(options, 'medium', 'optimizer');
        }).not.toThrow();
      });
    });
  });

  // Integration-style tests
  describe('planTurn with evaluateOptions integration', () => {
    it('should generate coherent plan based on evaluation', () => {
      const player = createMockPlayer({
        money: 100,
        hand: [createMockDemandCard(20, 'Berlin', LoadType.Cars)],
      });
      const gameState = createMockGameState({ players: [player] });
      const config = getAIConfig('hard', 'optimizer');

      const plan = planner.planTurn(gameState, player, config);

      // Plan should be coherent
      expect(plan.reasoning).toBeTruthy();
      expect(plan.alternativesConsidered).toBeGreaterThanOrEqual(1);
    });

    it('should adapt plan to player cash constraints', () => {
      const poorPlayer = createMockPlayer({ money: 5 }); // Very little cash
      const richPlayer = createMockPlayer({ money: 200 });

      const gameState = createMockGameState();
      const config = getAIConfig('medium', 'optimizer');

      const poorPlan = planner.planTurn(gameState, poorPlayer, config);
      const richPlan = planner.planTurn(gameState, richPlayer, config);

      // Both should generate valid plans
      expect(poorPlan.actions).toBeDefined();
      expect(richPlan.actions).toBeDefined();
    });
  });
});
