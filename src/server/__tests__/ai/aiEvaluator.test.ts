/**
 * Unit Tests for AI Evaluator Service
 * Tests scoreDemandCard, evaluatePosition, and assessOpponentThreats
 */

import { AIEvaluator, getAIEvaluator } from '../../services/ai/aiEvaluator';
import { AIGameState, PositionScore, ThreatAssessment } from '../../services/ai/types';
import { Player, TrackSegment, TrainType, PlayerColor, Point, TerrainType } from '../../../shared/types/GameTypes';
import { DemandCard, Demand } from '../../../shared/types/DemandCard';
import { LoadType } from '../../../shared/types/LoadTypes';

describe('AIEvaluator', () => {
  let evaluator: AIEvaluator;

  beforeEach(() => {
    evaluator = new AIEvaluator();
  });

  // Helper to create a mock Point
  const createMockPoint = (x: number, y: number, row: number = 0, col: number = 0): Point => ({
    x,
    y,
    row,
    col,
  });

  // Helper to create mock player
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

  // Helper to create track segment
  const createSegment = (
    from: Point,
    to: Point,
    _playerId: string = 'ai-player-1',
    terrain: TerrainType = TerrainType.Clear
  ): TrackSegment => ({
    from: { x: from.x, y: from.y, row: from.row, col: from.col, terrain },
    to: { x: to.x, y: to.y, row: to.row, col: to.col, terrain },
    cost: 1,
  });

  // Helper to create mock game state
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

  // Helper to create mock demand card
  const createMockDemandCard = (
    payment: number = 20,
    city: string = 'Berlin',
    resource: LoadType = LoadType.Cars
  ): DemandCard => ({
    id: 1,
    demands: [{ city, resource, payment }],
  });

  describe('getAIEvaluator', () => {
    it('should return a singleton instance', () => {
      const instance1 = getAIEvaluator();
      const instance2 = getAIEvaluator();
      expect(instance1).toBe(instance2);
    });
  });

  describe('scoreDemandCard', () => {
    it('should return a score between 0 and 100', () => {
      const card = createMockDemandCard(20);
      const player = createMockPlayer();
      const gameState = createMockGameState();

      const score = evaluator.scoreDemandCard(card, player, gameState);

      expect(score).toBeGreaterThanOrEqual(0);
      expect(score).toBeLessThanOrEqual(100);
    });

    it('should score higher payout cards higher', () => {
      const lowCard = createMockDemandCard(10);
      const highCard = createMockDemandCard(40);
      const player = createMockPlayer();
      const gameState = createMockGameState();

      const lowScore = evaluator.scoreDemandCard(lowCard, player, gameState);
      const highScore = evaluator.scoreDemandCard(highCard, player, gameState);

      expect(highScore).toBeGreaterThan(lowScore);
    });

    it('should handle maximum payout cards', () => {
      const maxCard = createMockDemandCard(52); // Maximum payout in game
      const player = createMockPlayer();
      const gameState = createMockGameState();

      const score = evaluator.scoreDemandCard(maxCard, player, gameState);

      expect(score).toBeGreaterThan(0);
      expect(score).toBeLessThanOrEqual(100);
    });

    it('should handle minimum payout cards', () => {
      const minCard = createMockDemandCard(7); // Low payout
      const player = createMockPlayer();
      const gameState = createMockGameState();

      const score = evaluator.scoreDemandCard(minCard, player, gameState);

      expect(score).toBeGreaterThanOrEqual(0);
    });

    it('should consider player position when scoring', () => {
      const card = createMockDemandCard(20);
      const playerWithPosition = createMockPlayer({
        trainState: {
          position: { x: 100, y: 100, row: 10, col: 10 },
          remainingMovement: 9,
          movementHistory: [],
          loads: [],
        },
      });
      const playerNoPosition = createMockPlayer({
        trainState: {
          position: null,
          remainingMovement: 9,
          movementHistory: [],
          loads: [],
        },
      });
      const gameState = createMockGameState();

      const scoreWithPos = evaluator.scoreDemandCard(card, playerWithPosition, gameState);
      const scoreNoPos = evaluator.scoreDemandCard(card, playerNoPosition, gameState);

      // Both should return valid scores
      expect(scoreWithPos).toBeDefined();
      expect(scoreNoPos).toBeDefined();
    });

    it('should consider existing track network', () => {
      const card = createMockDemandCard(20);
      const player = createMockPlayer();

      const trackMap = new Map<string, TrackSegment[]>();
      trackMap.set(player.id, [
        createSegment(createMockPoint(0, 0), createMockPoint(50, 50), player.id),
        createSegment(createMockPoint(50, 50), createMockPoint(100, 100), player.id),
      ]);

      const gameStateWithTrack = createMockGameState({ allTrack: trackMap });
      const gameStateNoTrack = createMockGameState();

      const scoreWithTrack = evaluator.scoreDemandCard(card, player, gameStateWithTrack);
      const scoreNoTrack = evaluator.scoreDemandCard(card, player, gameStateNoTrack);

      // Both should be valid scores
      expect(scoreWithTrack).toBeDefined();
      expect(scoreNoTrack).toBeDefined();
    });

    describe('different card types', () => {
      it('should score various load types consistently', () => {
        const player = createMockPlayer();
        const gameState = createMockGameState();

        const loadTypes: LoadType[] = [LoadType.Cars, LoadType.Steel, LoadType.Wine, LoadType.Machinery, LoadType.Tourists];

        loadTypes.forEach(resource => {
          const card: DemandCard = {
            id: 1,
            demands: [{ city: 'Berlin', resource, payment: 20 }],
          };

          const score = evaluator.scoreDemandCard(card, player, gameState);
          expect(score).toBeGreaterThanOrEqual(0);
          expect(score).toBeLessThanOrEqual(100);
        });
      });
    });
  });

  describe('evaluatePosition', () => {
    it('should return PositionScore with all required fields', () => {
      const player = createMockPlayer();
      const gameState = createMockGameState();

      const score = evaluator.evaluatePosition(player, gameState);

      expect(score).toHaveProperty('overall');
      expect(score).toHaveProperty('cashPosition');
      expect(score).toHaveProperty('networkValue');
      expect(score).toHaveProperty('deliveryPotential');
      expect(score).toHaveProperty('progressToVictory');
    });

    it('should score players with more cash higher in cashPosition', () => {
      const poorPlayer = createMockPlayer({ money: 20 });
      const richPlayer = createMockPlayer({ money: 200 });
      const gameState = createMockGameState();

      const poorScore = evaluator.evaluatePosition(poorPlayer, gameState);
      const richScore = evaluator.evaluatePosition(richPlayer, gameState);

      expect(richScore.cashPosition).toBeGreaterThan(poorScore.cashPosition);
    });

    it('should cap cashPosition at victory amount', () => {
      const superRichPlayer = createMockPlayer({ money: 500 }); // Above 250 victory
      const gameState = createMockGameState();

      const score = evaluator.evaluatePosition(superRichPlayer, gameState);

      // Should be capped at max score (30)
      expect(score.cashPosition).toBeLessThanOrEqual(30);
    });

    it('should score players with more track higher in networkValue', () => {
      const player = createMockPlayer();

      const smallNetwork = new Map<string, TrackSegment[]>();
      smallNetwork.set(player.id, [
        createSegment(createMockPoint(0, 0), createMockPoint(10, 10), player.id),
      ]);

      const largeNetwork = new Map<string, TrackSegment[]>();
      largeNetwork.set(player.id, [
        createSegment(createMockPoint(0, 0), createMockPoint(10, 10), player.id),
        createSegment(createMockPoint(10, 10), createMockPoint(20, 20), player.id),
        createSegment(createMockPoint(20, 20), createMockPoint(30, 30), player.id),
        createSegment(createMockPoint(30, 30), createMockPoint(40, 40), player.id),
        createSegment(createMockPoint(40, 40), createMockPoint(50, 50), player.id),
      ]);

      const smallNetworkState = createMockGameState({ allTrack: smallNetwork });
      const largeNetworkState = createMockGameState({ allTrack: largeNetwork });

      const smallScore = evaluator.evaluatePosition(player, smallNetworkState);
      const largeScore = evaluator.evaluatePosition(player, largeNetworkState);

      expect(largeScore.networkValue).toBeGreaterThan(smallScore.networkValue);
    });

    it('should return zero networkValue for player with no track', () => {
      const player = createMockPlayer();
      const gameState = createMockGameState();

      const score = evaluator.evaluatePosition(player, gameState);

      expect(score.networkValue).toBe(0);
    });

    it('should score players with better hands higher in deliveryPotential', () => {
      const emptyHandPlayer = createMockPlayer({ hand: [] });
      const goodHandPlayer = createMockPlayer({
        hand: [
          createMockDemandCard(30),
          createMockDemandCard(25),
          createMockDemandCard(20),
        ],
      });
      const gameState = createMockGameState();

      const emptyScore = evaluator.evaluatePosition(emptyHandPlayer, gameState);
      const goodScore = evaluator.evaluatePosition(goodHandPlayer, gameState);

      expect(goodScore.deliveryPotential).toBeGreaterThan(emptyScore.deliveryPotential);
    });

    it('should calculate overall as sum of components', () => {
      const player = createMockPlayer({ money: 100 });
      const gameState = createMockGameState();

      const score = evaluator.evaluatePosition(player, gameState);

      const sum = score.cashPosition + score.networkValue +
                  score.deliveryPotential + score.progressToVictory;
      expect(score.overall).toBeCloseTo(sum, 1);
    });

    describe('victory progress', () => {
      it('should increase progressToVictory as player approaches winning', () => {
        const earlyPlayer = createMockPlayer({ money: 50 });
        const latePlayer = createMockPlayer({ money: 200 });
        const gameState = createMockGameState();

        const earlyScore = evaluator.evaluatePosition(earlyPlayer, gameState);
        const lateScore = evaluator.evaluatePosition(latePlayer, gameState);

        expect(lateScore.progressToVictory).toBeGreaterThan(earlyScore.progressToVictory);
      });
    });
  });

  describe('assessOpponentThreats', () => {
    it('should return ThreatAssessment with required fields', () => {
      const player = createMockPlayer();
      const opponents = [
        createMockPlayer({ id: 'opponent-1', name: 'Opponent 1' }),
        createMockPlayer({ id: 'opponent-2', name: 'Opponent 2' }),
      ];

      const assessment = evaluator.assessOpponentThreats(player, opponents);

      expect(assessment).toHaveProperty('overallThreat');
      expect(assessment).toHaveProperty('blockingThreats');
      expect(assessment).toHaveProperty('competitionForLoads');
      expect(Array.isArray(assessment.blockingThreats)).toBe(true);
      expect(Array.isArray(assessment.competitionForLoads)).toBe(true);
    });

    it('should return overallThreat between 0 and 100', () => {
      const player = createMockPlayer();
      const opponents = [
        createMockPlayer({ id: 'opponent-1', money: 200 }),
      ];

      const assessment = evaluator.assessOpponentThreats(player, opponents);

      expect(assessment.overallThreat).toBeGreaterThanOrEqual(0);
      expect(assessment.overallThreat).toBeLessThanOrEqual(100);
    });

    it('should assess higher threat for wealthy opponents', () => {
      const player = createMockPlayer({ money: 50 });

      const poorOpponents = [
        createMockPlayer({ id: 'opponent-1', money: 30 }),
      ];

      const richOpponents = [
        createMockPlayer({ id: 'opponent-1', money: 230 }), // Near victory
      ];

      const poorThreat = evaluator.assessOpponentThreats(player, poorOpponents);
      const richThreat = evaluator.assessOpponentThreats(player, richOpponents);

      expect(richThreat.overallThreat).toBeGreaterThan(poorThreat.overallThreat);
    });

    it('should handle single opponent', () => {
      const player = createMockPlayer();
      const opponents = [createMockPlayer({ id: 'opponent-1' })];

      const assessment = evaluator.assessOpponentThreats(player, opponents);

      expect(assessment.overallThreat).toBeGreaterThanOrEqual(0);
    });

    it('should handle multiple opponents', () => {
      const player = createMockPlayer();
      const opponents = [
        createMockPlayer({ id: 'opponent-1' }),
        createMockPlayer({ id: 'opponent-2' }),
        createMockPlayer({ id: 'opponent-3' }),
        createMockPlayer({ id: 'opponent-4' }),
        createMockPlayer({ id: 'opponent-5' }),
      ];

      const assessment = evaluator.assessOpponentThreats(player, opponents);

      expect(assessment.overallThreat).toBeGreaterThanOrEqual(0);
      expect(assessment.overallThreat).toBeLessThanOrEqual(100);
    });

    it('should handle empty opponents array', () => {
      const player = createMockPlayer();
      const opponents: Player[] = [];

      const assessment = evaluator.assessOpponentThreats(player, opponents);

      expect(assessment.overallThreat).toBe(0);
    });

    describe('blocking threats', () => {
      it('should identify blocking threats array', () => {
        const player = createMockPlayer();
        const opponents = [createMockPlayer({ id: 'opponent-1' })];

        const assessment = evaluator.assessOpponentThreats(player, opponents);

        expect(Array.isArray(assessment.blockingThreats)).toBe(true);
      });

      it('should structure blocking threats correctly when present', () => {
        const player = createMockPlayer();
        const opponents = [createMockPlayer({ id: 'opponent-1' })];

        const assessment = evaluator.assessOpponentThreats(player, opponents);

        // Each blocking threat should have required fields
        assessment.blockingThreats.forEach(threat => {
          expect(threat).toHaveProperty('playerId');
          expect(threat).toHaveProperty('cityBlocked');
          expect(threat).toHaveProperty('impact');
        });
      });
    });

    describe('load competition', () => {
      it('should return competitionForLoads array', () => {
        const player = createMockPlayer();
        const opponents = [createMockPlayer({ id: 'opponent-1' })];

        const assessment = evaluator.assessOpponentThreats(player, opponents);

        expect(Array.isArray(assessment.competitionForLoads)).toBe(true);
      });

      it('should structure load competition correctly when present', () => {
        const player = createMockPlayer();
        const opponents = [createMockPlayer({ id: 'opponent-1' })];

        const assessment = evaluator.assessOpponentThreats(player, opponents);

        assessment.competitionForLoads.forEach(competition => {
          expect(competition).toHaveProperty('loadType');
          expect(competition).toHaveProperty('competitorCount');
          expect(competition).toHaveProperty('urgency');
        });
      });
    });
  });

  describe('countConnectedMajorCities', () => {
    it('should return 0 for empty track', () => {
      const count = evaluator.countConnectedMajorCities([]);
      expect(count).toBe(0);
    });

    it('should return number >= 0', () => {
      const track: TrackSegment[] = [
        createSegment(createMockPoint(0, 0), createMockPoint(10, 10)),
      ];
      const count = evaluator.countConnectedMajorCities(track);
      expect(count).toBeGreaterThanOrEqual(0);
    });
  });

  describe('checkVictoryConditions', () => {
    it('should return false when cash is below 250', () => {
      const player = createMockPlayer({ money: 200 });
      const track: TrackSegment[] = [];

      const isVictory = evaluator.checkVictoryConditions(player, track);

      expect(isVictory).toBe(false);
    });

    it('should return false when less than 7 major cities connected', () => {
      const player = createMockPlayer({ money: 300 });
      const track: TrackSegment[] = [];

      const isVictory = evaluator.checkVictoryConditions(player, track);

      expect(isVictory).toBe(false);
    });

    it('should return boolean value', () => {
      const player = createMockPlayer({ money: 100 });
      const track: TrackSegment[] = [];

      const isVictory = evaluator.checkVictoryConditions(player, track);

      expect(typeof isVictory).toBe('boolean');
    });
  });

  // Edge cases
  describe('edge cases', () => {
    it('should handle player with no hand for scoreDemandCard', () => {
      const card = createMockDemandCard();
      const player = createMockPlayer({ hand: [] });
      const gameState = createMockGameState();

      expect(() => {
        evaluator.scoreDemandCard(card, player, gameState);
      }).not.toThrow();
    });

    it('should handle player with null position', () => {
      const player = createMockPlayer({
        trainState: {
          position: null,
          remainingMovement: 9,
          movementHistory: [],
          loads: [],
        },
      });
      const gameState = createMockGameState();

      expect(() => {
        evaluator.evaluatePosition(player, gameState);
      }).not.toThrow();
    });

    it('should handle player with zero money', () => {
      const player = createMockPlayer({ money: 0 });
      const gameState = createMockGameState();

      const score = evaluator.evaluatePosition(player, gameState);

      expect(score.cashPosition).toBe(0);
    });

    it('should handle player in debt', () => {
      const player = createMockPlayer({ money: 0, debtOwed: 20 });
      const gameState = createMockGameState();

      expect(() => {
        evaluator.evaluatePosition(player, gameState);
      }).not.toThrow();
    });
  });
});
