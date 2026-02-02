/**
 * Unit Tests for AI Service
 * Tests the main AI turn orchestration service
 */

import { AIService, getAIService } from '../../services/ai/aiService';
import { getAIPlanner } from '../../services/ai/aiPlanner';
import { getAICommentary } from '../../services/ai/aiCommentary';
import { getAIConfig } from '../../services/ai/aiConfig';
import { emitToGame, emitStatePatch } from '../../services/socketService';
import { db } from '../../db';
import { Player, TrainType, PlayerColor, TerrainType, Point } from '../../../shared/types/GameTypes';
import { AITurnPlan, AIGameState } from '../../services/ai/types';
import { AIAction } from '../../../shared/types/AITypes';

// Mock dependencies
jest.mock('../../services/ai/aiPlanner');
jest.mock('../../services/ai/aiCommentary');
jest.mock('../../services/socketService');
jest.mock('../../db');

describe('AIService', () => {
  let service: AIService;
  const mockGameId = 'test-game-123';
  const mockPlayerId = 'ai-player-456';

  // Helper to create a mock player
  const createMockPlayer = (overrides: Partial<Player> = {}): Player => ({
    id: mockPlayerId,
    name: 'AI Player',
    color: PlayerColor.RED,
    money: 50,
    trainType: TrainType.Freight,
    trainState: {
      position: { x: 100, y: 100, row: 5, col: 5 },
      remainingMovement: 9,
      movementHistory: [],
      loads: [],
    },
    hand: [],
    userId: undefined,
    isAI: true,
    aiDifficulty: 'easy',
    aiPersonality: 'optimizer',
    turnNumber: 3,
    ...overrides,
  });

  // Helper to create a mock AITurnPlan
  const createMockPlan = (overrides: Partial<AITurnPlan> = {}): AITurnPlan => ({
    actions: [],
    reasoning: 'Test reasoning',
    expectedCashChange: 0,
    alternativesConsidered: 3,
    ...overrides,
  });

  beforeEach(() => {
    jest.clearAllMocks();
    service = new AIService();

    // Setup default mock implementations
    (getAIPlanner as jest.Mock).mockReturnValue({
      planTurn: jest.fn().mockReturnValue(createMockPlan()),
    });

    (getAICommentary as jest.Mock).mockReturnValue({
      generateTurnSummary: jest.fn().mockReturnValue('Test turn summary'),
    });

    (emitToGame as jest.Mock).mockImplementation(() => {});
    (emitStatePatch as jest.Mock).mockImplementation(() => Promise.resolve());
  });

  describe('getAIService', () => {
    it('should return a singleton instance', () => {
      const instance1 = getAIService();
      const instance2 = getAIService();
      expect(instance1).toBe(instance2);
    });
  });

  describe('executeAITurn', () => {
    beforeEach(() => {
      // Mock database queries for game state retrieval
      (db.query as jest.Mock).mockImplementation((query: string) => {
        if (query.includes('FROM players')) {
          return Promise.resolve({
            rows: [{
              id: mockPlayerId,
              name: 'AI Player',
              color: PlayerColor.RED,
              money: 50,
              train_type: TrainType.Freight,
              train_state: { position: { x: 100, y: 100, row: 5, col: 5 }, remainingMovement: 9, movementHistory: [], loads: [] },
              hand: [],
              user_id: null,
              is_ai: true,
              ai_difficulty: 'easy',
              ai_personality: 'optimizer',
              turn_number: 3,
            }],
          });
        }
        if (query.includes('FROM games')) {
          return Promise.resolve({
            rows: [{ current_player_index: 0, turn_number: 5 }],
          });
        }
        if (query.includes('FROM player_tracks')) {
          return Promise.resolve({ rows: [] });
        }
        return Promise.resolve({ rows: [] });
      });
    });

    it('should emit ai:thinking event at the start', async () => {
      await service.executeAITurn(mockGameId, mockPlayerId);

      expect(emitToGame).toHaveBeenCalledWith(
        mockGameId,
        'ai:thinking',
        { playerId: mockPlayerId }
      );
    });

    it('should return successful result with actions', async () => {
      const mockActions: AIAction[] = [
        { type: 'build', description: 'Building track', details: { cost: 5 } },
      ];
      (getAIPlanner as jest.Mock).mockReturnValue({
        planTurn: jest.fn().mockReturnValue(createMockPlan({ actions: mockActions })),
      });

      const result = await service.executeAITurn(mockGameId, mockPlayerId);

      expect(result.success).toBe(true);
      expect(result.actions).toBeDefined();
    });

    it('should emit ai:turn-complete event at the end', async () => {
      await service.executeAITurn(mockGameId, mockPlayerId);

      expect(emitToGame).toHaveBeenCalledWith(
        mockGameId,
        'ai:turn-complete',
        expect.objectContaining({
          playerId: mockPlayerId,
          turnSummary: expect.any(Object),
          currentStrategy: expect.any(Object),
          debug: expect.any(Object),
        })
      );
    });

    it('should return failed result when player is not an AI', async () => {
      (db.query as jest.Mock).mockImplementation((query: string) => {
        if (query.includes('FROM players')) {
          return Promise.resolve({
            rows: [{
              id: mockPlayerId,
              name: 'Human Player',
              color: PlayerColor.RED,
              money: 50,
              train_type: TrainType.Freight,
              train_state: null,
              hand: [],
              user_id: 'user-123',
              is_ai: false,
              ai_difficulty: null,
              ai_personality: null,
              turn_number: 3,
            }],
          });
        }
        if (query.includes('FROM games')) {
          return Promise.resolve({
            rows: [{ current_player_index: 0, turn_number: 5 }],
          });
        }
        if (query.includes('FROM player_tracks')) {
          return Promise.resolve({ rows: [] });
        }
        return Promise.resolve({ rows: [] });
      });

      const result = await service.executeAITurn(mockGameId, mockPlayerId);

      expect(result.success).toBe(false);
      expect(result.turnSummary.commentary).toContain('error');
    });

    it('should return failed result when player not found', async () => {
      (db.query as jest.Mock).mockImplementation((query: string) => {
        if (query.includes('FROM players')) {
          return Promise.resolve({
            rows: [{
              id: 'different-player',
              name: 'Other Player',
              color: PlayerColor.BLUE,
              money: 50,
              train_type: TrainType.Freight,
              train_state: null,
              hand: [],
              user_id: null,
              is_ai: true,
              ai_difficulty: 'easy',
              ai_personality: 'optimizer',
              turn_number: 3,
            }],
          });
        }
        if (query.includes('FROM games')) {
          return Promise.resolve({
            rows: [{ current_player_index: 0, turn_number: 5 }],
          });
        }
        if (query.includes('FROM player_tracks')) {
          return Promise.resolve({ rows: [] });
        }
        return Promise.resolve({ rows: [] });
      });

      const result = await service.executeAITurn(mockGameId, mockPlayerId);

      expect(result.success).toBe(false);
    });

    it('should return failed result when game not found', async () => {
      (db.query as jest.Mock).mockImplementation((query: string) => {
        if (query.includes('FROM players')) {
          return Promise.resolve({
            rows: [{
              id: mockPlayerId,
              name: 'AI Player',
              color: PlayerColor.RED,
              money: 50,
              train_type: TrainType.Freight,
              train_state: null,
              hand: [],
              user_id: null,
              is_ai: true,
              ai_difficulty: 'easy',
              ai_personality: 'optimizer',
              turn_number: 3,
            }],
          });
        }
        if (query.includes('FROM games')) {
          return Promise.resolve({ rows: [] });
        }
        if (query.includes('FROM player_tracks')) {
          return Promise.resolve({ rows: [] });
        }
        return Promise.resolve({ rows: [] });
      });

      const result = await service.executeAITurn(mockGameId, mockPlayerId);

      expect(result.success).toBe(false);
    });

    it('should call AIPlanner.planTurn with correct parameters', async () => {
      const mockPlanTurn = jest.fn().mockReturnValue(createMockPlan());
      (getAIPlanner as jest.Mock).mockReturnValue({
        planTurn: mockPlanTurn,
      });

      await service.executeAITurn(mockGameId, mockPlayerId);

      expect(mockPlanTurn).toHaveBeenCalledWith(
        expect.objectContaining({
          currentPlayerId: mockPlayerId,
        }),
        expect.objectContaining({
          id: mockPlayerId,
          isAI: true,
        }),
        expect.objectContaining({
          difficulty: expect.any(Object),
          personality: expect.any(Object),
        })
      );
    });

    describe('difficulty configurations', () => {
      it.each(['easy', 'medium', 'hard'] as const)(
        'should handle %s difficulty',
        async (difficulty) => {
          (db.query as jest.Mock).mockImplementation((query: string) => {
            if (query.includes('FROM players')) {
              return Promise.resolve({
                rows: [{
                  id: mockPlayerId,
                  name: 'AI Player',
                  color: PlayerColor.RED,
                  money: 50,
                  train_type: TrainType.Freight,
                  train_state: null,
                  hand: [],
                  user_id: null,
                  is_ai: true,
                  ai_difficulty: difficulty,
                  ai_personality: 'optimizer',
                  turn_number: 3,
                }],
              });
            }
            if (query.includes('FROM games')) {
              return Promise.resolve({
                rows: [{ current_player_index: 0, turn_number: 5 }],
              });
            }
            if (query.includes('FROM player_tracks')) {
              return Promise.resolve({ rows: [] });
            }
            return Promise.resolve({ rows: [] });
          });

          const result = await service.executeAITurn(mockGameId, mockPlayerId);

          expect(result.success).toBe(true);
        }
      );
    });

    describe('personality configurations', () => {
      it.each([
        'optimizer',
        'network_builder',
        'opportunist',
        'blocker',
        'steady_hand',
        'chaos_agent',
      ] as const)(
        'should handle %s personality',
        async (personality) => {
          (db.query as jest.Mock).mockImplementation((query: string) => {
            if (query.includes('FROM players')) {
              return Promise.resolve({
                rows: [{
                  id: mockPlayerId,
                  name: 'AI Player',
                  color: PlayerColor.RED,
                  money: 50,
                  train_type: TrainType.Freight,
                  train_state: null,
                  hand: [],
                  user_id: null,
                  is_ai: true,
                  ai_difficulty: 'easy',
                  ai_personality: personality,
                  turn_number: 3,
                }],
              });
            }
            if (query.includes('FROM games')) {
              return Promise.resolve({
                rows: [{ current_player_index: 0, turn_number: 5 }],
              });
            }
            if (query.includes('FROM player_tracks')) {
              return Promise.resolve({ rows: [] });
            }
            return Promise.resolve({ rows: [] });
          });

          const result = await service.executeAITurn(mockGameId, mockPlayerId);

          expect(result.success).toBe(true);
        }
      );
    });
  });

  describe('generateTurnSummary', () => {
    it('should return TurnSummary with all required fields', () => {
      const mockCommentary = {
        generateTurnSummary: jest.fn().mockReturnValue('Generated commentary'),
      };
      (getAICommentary as jest.Mock).mockReturnValue(mockCommentary);

      const actions: AIAction[] = [
        { type: 'build', description: 'Building track', details: { cost: 10 } },
      ];
      const plan = createMockPlan({ actions, expectedCashChange: -10 });

      const result = service.generateTurnSummary(actions, 'optimizer', plan);

      expect(result).toHaveProperty('actions');
      expect(result).toHaveProperty('cashChange');
      expect(result).toHaveProperty('commentary');
      expect(result.actions).toEqual(actions);
      expect(result.cashChange).toBe(-10);
    });

    it('should call AICommentary.generateTurnSummary', () => {
      const mockGenerateSummary = jest.fn().mockReturnValue('Test commentary');
      (getAICommentary as jest.Mock).mockReturnValue({
        generateTurnSummary: mockGenerateSummary,
      });

      const actions: AIAction[] = [{ type: 'move', description: 'Moving train', details: {} }];
      const plan = createMockPlan({ actions });

      service.generateTurnSummary(actions, 'optimizer', plan);

      expect(mockGenerateSummary).toHaveBeenCalledWith(actions, 'optimizer');
    });

    it('should handle empty actions array', () => {
      const mockCommentary = {
        generateTurnSummary: jest.fn().mockReturnValue('Idle turn'),
      };
      (getAICommentary as jest.Mock).mockReturnValue(mockCommentary);

      const plan = createMockPlan({ actions: [], expectedCashChange: 0 });

      const result = service.generateTurnSummary([], 'optimizer', plan);

      expect(result.actions).toEqual([]);
      expect(result.cashChange).toBe(0);
    });

    it.each([
      'optimizer',
      'network_builder',
      'opportunist',
      'blocker',
      'steady_hand',
      'chaos_agent',
    ] as const)('should generate summary for %s personality', (personality) => {
      const mockCommentary = {
        generateTurnSummary: jest.fn().mockReturnValue(`${personality} summary`),
      };
      (getAICommentary as jest.Mock).mockReturnValue(mockCommentary);

      const actions: AIAction[] = [{ type: 'build', description: 'Building track', details: {} }];
      const plan = createMockPlan({ actions });

      const result = service.generateTurnSummary(actions, personality, plan);

      expect(result.commentary).toBe(`${personality} summary`);
    });
  });

  describe('action execution', () => {
    beforeEach(() => {
      (db.query as jest.Mock).mockImplementation((query: string) => {
        if (query.includes('FROM players')) {
          return Promise.resolve({
            rows: [{
              id: mockPlayerId,
              name: 'AI Player',
              color: PlayerColor.RED,
              money: 50,
              train_type: TrainType.Freight,
              train_state: { position: null, remainingMovement: 9, movementHistory: [], loads: [] },
              hand: [],
              user_id: null,
              is_ai: true,
              ai_difficulty: 'easy',
              ai_personality: 'optimizer',
              turn_number: 3,
            }],
          });
        }
        if (query.includes('FROM games')) {
          return Promise.resolve({
            rows: [{ current_player_index: 0, turn_number: 5 }],
          });
        }
        if (query.includes('FROM player_tracks')) {
          return Promise.resolve({ rows: [] });
        }
        if (query.includes('UPDATE players')) {
          return Promise.resolve({ rowCount: 1 });
        }
        if (query.includes('SELECT money')) {
          return Promise.resolve({ rows: [{ money: 100 }] });
        }
        if (query.includes('SELECT money, train_type')) {
          return Promise.resolve({ rows: [{ money: 30, train_type: TrainType.FastFreight }] });
        }
        return Promise.resolve({ rows: [] });
      });
    });

    it('should execute build action and deduct cost', async () => {
      const buildAction: AIAction = { type: 'build', description: 'Building track', details: { cost: 10 } };
      (getAIPlanner as jest.Mock).mockReturnValue({
        planTurn: jest.fn().mockReturnValue(createMockPlan({ actions: [buildAction] })),
      });

      await service.executeAITurn(mockGameId, mockPlayerId);

      expect(db.query).toHaveBeenCalledWith(
        expect.stringContaining('UPDATE players SET money = money - $1'),
        [10, mockPlayerId]
      );
    });

    it('should execute deliver action and add payout', async () => {
      const deliverAction: AIAction = {
        type: 'deliver',
        description: 'Delivering cargo',
        details: { payout: 25, loadType: 'Cars', destinationCity: 'Berlin' },
      };
      (getAIPlanner as jest.Mock).mockReturnValue({
        planTurn: jest.fn().mockReturnValue(createMockPlan({ actions: [deliverAction] })),
      });

      await service.executeAITurn(mockGameId, mockPlayerId);

      expect(db.query).toHaveBeenCalledWith(
        expect.stringContaining('UPDATE players SET money = money + $1'),
        [25, mockPlayerId]
      );
    });

    it('should execute upgrade action', async () => {
      const upgradeAction: AIAction = {
        type: 'upgrade',
        description: 'Upgrading train',
        details: { toTrain: TrainType.FastFreight },
      };
      (getAIPlanner as jest.Mock).mockReturnValue({
        planTurn: jest.fn().mockReturnValue(createMockPlan({ actions: [upgradeAction] })),
      });

      await service.executeAITurn(mockGameId, mockPlayerId);

      expect(db.query).toHaveBeenCalledWith(
        expect.stringContaining('UPDATE players SET train_type = $1, money = money - $2'),
        [TrainType.FastFreight, 20, mockPlayerId]
      );
    });

    it('should continue executing actions even if one fails', async () => {
      const actions: AIAction[] = [
        { type: 'build', description: 'Building track', details: { cost: 5 } },
        { type: 'move', description: 'Moving train', details: {} },
        { type: 'deliver', description: 'Delivering cargo', details: { payout: 10 } },
      ];

      let buildCallCount = 0;
      (db.query as jest.Mock).mockImplementation((query: string) => {
        if (query.includes('UPDATE players SET money = money - $1') && buildCallCount === 0) {
          buildCallCount++;
          throw new Error('Build failed');
        }
        if (query.includes('FROM players')) {
          return Promise.resolve({
            rows: [{
              id: mockPlayerId,
              name: 'AI Player',
              color: PlayerColor.RED,
              money: 50,
              train_type: TrainType.Freight,
              train_state: null,
              hand: [],
              user_id: null,
              is_ai: true,
              ai_difficulty: 'easy',
              ai_personality: 'optimizer',
              turn_number: 3,
            }],
          });
        }
        if (query.includes('FROM games')) {
          return Promise.resolve({
            rows: [{ current_player_index: 0, turn_number: 5 }],
          });
        }
        if (query.includes('FROM player_tracks')) {
          return Promise.resolve({ rows: [] });
        }
        if (query.includes('UPDATE players SET money = money + $1')) {
          return Promise.resolve({ rowCount: 1 });
        }
        if (query.includes('SELECT money')) {
          return Promise.resolve({ rows: [{ money: 60 }] });
        }
        return Promise.resolve({ rows: [] });
      });

      (getAIPlanner as jest.Mock).mockReturnValue({
        planTurn: jest.fn().mockReturnValue(createMockPlan({ actions })),
      });

      const result = await service.executeAITurn(mockGameId, mockPlayerId);

      // Should still be successful overall
      expect(result.success).toBe(true);
    });
  });

  describe('strategy phase determination', () => {
    it('should return "Initial Building" for early turns', async () => {
      (db.query as jest.Mock).mockImplementation((query: string) => {
        if (query.includes('FROM players')) {
          return Promise.resolve({
            rows: [{
              id: mockPlayerId,
              name: 'AI Player',
              color: PlayerColor.RED,
              money: 50,
              train_type: TrainType.Freight,
              train_state: null,
              hand: [],
              user_id: null,
              is_ai: true,
              ai_difficulty: 'easy',
              ai_personality: 'optimizer',
              turn_number: 1,
            }],
          });
        }
        if (query.includes('FROM games')) {
          return Promise.resolve({
            rows: [{ current_player_index: 0, turn_number: 1 }],
          });
        }
        if (query.includes('FROM player_tracks')) {
          return Promise.resolve({ rows: [] });
        }
        return Promise.resolve({ rows: [] });
      });

      const result = await service.executeAITurn(mockGameId, mockPlayerId);

      expect(result.strategy.phase).toBe('Initial Building');
    });

    it('should return "Recovery" for low money', async () => {
      (db.query as jest.Mock).mockImplementation((query: string) => {
        if (query.includes('FROM players')) {
          return Promise.resolve({
            rows: [{
              id: mockPlayerId,
              name: 'AI Player',
              color: PlayerColor.RED,
              money: 30,
              train_type: TrainType.Freight,
              train_state: null,
              hand: [],
              user_id: null,
              is_ai: true,
              ai_difficulty: 'easy',
              ai_personality: 'optimizer',
              turn_number: 5,
            }],
          });
        }
        if (query.includes('FROM games')) {
          return Promise.resolve({
            rows: [{ current_player_index: 0, turn_number: 5 }],
          });
        }
        if (query.includes('FROM player_tracks')) {
          return Promise.resolve({ rows: [] });
        }
        return Promise.resolve({ rows: [] });
      });

      const result = await service.executeAITurn(mockGameId, mockPlayerId);

      expect(result.strategy.phase).toBe('Recovery');
    });

    it('should return "Victory Push" for high money', async () => {
      (db.query as jest.Mock).mockImplementation((query: string) => {
        if (query.includes('FROM players')) {
          return Promise.resolve({
            rows: [{
              id: mockPlayerId,
              name: 'AI Player',
              color: PlayerColor.RED,
              money: 220,
              train_type: TrainType.Freight,
              train_state: null,
              hand: [],
              user_id: null,
              is_ai: true,
              ai_difficulty: 'easy',
              ai_personality: 'optimizer',
              turn_number: 10,
            }],
          });
        }
        if (query.includes('FROM games')) {
          return Promise.resolve({
            rows: [{ current_player_index: 0, turn_number: 10 }],
          });
        }
        if (query.includes('FROM player_tracks')) {
          return Promise.resolve({ rows: [] });
        }
        return Promise.resolve({ rows: [] });
      });

      const result = await service.executeAITurn(mockGameId, mockPlayerId);

      expect(result.strategy.phase).toBe('Victory Push');
    });

    it('should return "Development" for mid-game state', async () => {
      (db.query as jest.Mock).mockImplementation((query: string) => {
        if (query.includes('FROM players')) {
          return Promise.resolve({
            rows: [{
              id: mockPlayerId,
              name: 'AI Player',
              color: PlayerColor.RED,
              money: 100,
              train_type: TrainType.Freight,
              train_state: null,
              hand: [],
              user_id: null,
              is_ai: true,
              ai_difficulty: 'easy',
              ai_personality: 'optimizer',
              turn_number: 6,
            }],
          });
        }
        if (query.includes('FROM games')) {
          return Promise.resolve({
            rows: [{ current_player_index: 0, turn_number: 6 }],
          });
        }
        if (query.includes('FROM player_tracks')) {
          return Promise.resolve({ rows: [] });
        }
        return Promise.resolve({ rows: [] });
      });

      const result = await service.executeAITurn(mockGameId, mockPlayerId);

      expect(result.strategy.phase).toBe('Development');
    });
  });

  describe('debug info generation', () => {
    beforeEach(() => {
      (db.query as jest.Mock).mockImplementation((query: string) => {
        if (query.includes('FROM players')) {
          return Promise.resolve({
            rows: [{
              id: mockPlayerId,
              name: 'AI Player',
              color: PlayerColor.RED,
              money: 50,
              train_type: TrainType.Freight,
              train_state: null,
              hand: [],
              user_id: null,
              is_ai: true,
              ai_difficulty: 'easy',
              ai_personality: 'optimizer',
              turn_number: 3,
            }],
          });
        }
        if (query.includes('FROM games')) {
          return Promise.resolve({
            rows: [{ current_player_index: 0, turn_number: 5 }],
          });
        }
        if (query.includes('FROM player_tracks')) {
          return Promise.resolve({ rows: [] });
        }
        return Promise.resolve({ rows: [] });
      });
    });

    it('should include routesEvaluated from plan', async () => {
      (getAIPlanner as jest.Mock).mockReturnValue({
        planTurn: jest.fn().mockReturnValue(createMockPlan({ alternativesConsidered: 5 })),
      });

      const result = await service.executeAITurn(mockGameId, mockPlayerId);

      expect(result.debugInfo.routesEvaluated).toBe(5);
    });

    it('should include decisionTimeMs', async () => {
      const result = await service.executeAITurn(mockGameId, mockPlayerId);

      expect(result.debugInfo.decisionTimeMs).toBeGreaterThanOrEqual(0);
    });

    it('should extract variable names from action details', async () => {
      const actions: AIAction[] = [
        { type: 'build', description: 'Building track', details: { cost: 10, destination: 'Berlin' } },
        { type: 'move', description: 'Moving train', details: { path: [], distance: 5 } },
      ];
      (getAIPlanner as jest.Mock).mockReturnValue({
        planTurn: jest.fn().mockReturnValue(createMockPlan({ actions })),
      });

      const result = await service.executeAITurn(mockGameId, mockPlayerId);

      expect(result.debugInfo.variablesConsidered).toContain('cost');
      expect(result.debugInfo.variablesConsidered).toContain('destination');
    });
  });
});
