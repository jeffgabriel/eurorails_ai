import { LLMStrategyBrain } from '../../services/ai/LLMStrategyBrain';
import {
  AIActionType,
  WorldSnapshot,
  GameContext,
  BotSkillLevel,
  BotArchetype,
  LLMProvider,
  LLM_DEFAULT_MODELS,
} from '../../../shared/types/GameTypes';

// Mock all provider adapters
jest.mock('../../services/ai/providers/AnthropicAdapter');
jest.mock('../../services/ai/providers/GoogleAdapter');

// Mock ActionResolver
jest.mock('../../services/ai/ActionResolver', () => ({
  ActionResolver: {
    resolve: jest.fn(),
    heuristicFallback: jest.fn(),
  },
}));

// Mock ContextBuilder
jest.mock('../../services/ai/ContextBuilder', () => ({
  ContextBuilder: {
    build: jest.fn(),
    serializePrompt: jest.fn(() => 'serialized-prompt'),
  },
}));

// Mock ResponseParser
jest.mock('../../services/ai/ResponseParser', () => {
  class ParseError extends Error {
    constructor(msg: string) {
      super(msg);
      this.name = 'ParseError';
    }
  }
  return {
    ResponseParser: {
      parseActionIntent: jest.fn(),
    },
    ParseError,
  };
});

// Mock MapTopology
jest.mock('../../services/ai/MapTopology', () => ({
  loadGridPoints: jest.fn(() => new Map()),
  getHexNeighbors: jest.fn(() => []),
  getTerrainCost: jest.fn(() => 1),
  gridToPixel: jest.fn(() => ({ x: 0, y: 0 })),
  _resetCache: jest.fn(),
}));

// Import after mocking
import { AnthropicAdapter } from '../../services/ai/providers/AnthropicAdapter';
import { ActionResolver } from '../../services/ai/ActionResolver';
import { ResponseParser } from '../../services/ai/ResponseParser';

const mockResolve = ActionResolver.resolve as jest.Mock;
const mockHeuristicFallback = ActionResolver.heuristicFallback as jest.Mock;
const mockParseActionIntent = ResponseParser.parseActionIntent as jest.Mock;

function makeSnapshot(money: number = 50): WorldSnapshot {
  return {
    gameId: 'g1',
    gameStatus: 'active',
    turnNumber: 5,
    bot: {
      playerId: 'bot-1',
      userId: 'user-bot-1',
      money,
      position: { row: 10, col: 5 },
      existingSegments: [],
      demandCards: [],
      resolvedDemands: [],
      trainType: 'Freight',
      loads: [],
      botConfig: null,
      connectedMajorCityCount: 2,
    },
    allPlayerTracks: [],
    loadAvailability: {},
  };
}

function makeContext(): GameContext {
  return {
    position: { row: 10, col: 5 },
    money: 50,
    trainType: 'Freight',
    speed: 9,
    capacity: 2,
    loads: [],
    connectedMajorCities: ['Berlin', 'Paris'],
    totalMajorCities: 7,
    trackSummary: '10 segments',
    turnBuildCost: 0,
    demands: [],
    canDeliver: [],
    canPickup: [],
    reachableCities: ['Berlin', 'Paris'],
    citiesOnNetwork: [],
    canUpgrade: false,
    canBuild: true,
    isInitialBuild: false,
    opponents: [],
    phase: 'running',
    turnNumber: 5,
  };
}

/** Set up mocks for a successful LLM → ActionResolver → resolve chain */
function setupSuccessfulDecision(
  mockChat: jest.Mock,
  action: AIActionType = AIActionType.BuildTrack,
) {
  mockChat.mockResolvedValue({
    text: JSON.stringify({ action: 'BuildTrack', reasoning: 'Build toward Berlin' }),
    usage: { input: 100, output: 50 },
  });
  mockParseActionIntent.mockReturnValue({
    action: 'BuildTrack',
    reasoning: 'Build toward Berlin',
    planHorizon: '2 turns',
  });
  mockResolve.mockResolvedValue({
    success: true,
    plan: { type: action },
  });
}

describe('LLMStrategyBrain', () => {
  let mockChat: jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    // Set up the mock adapter
    mockChat = jest.fn();
    (AnthropicAdapter as jest.MockedClass<typeof AnthropicAdapter>).mockImplementation(
      () => ({ chat: mockChat }) as unknown as AnthropicAdapter,
    );
  });

  function createBrain(skillLevel: BotSkillLevel = BotSkillLevel.Medium): LLMStrategyBrain {
    return new LLMStrategyBrain({
      archetype: BotArchetype.Balanced,
      skillLevel,
      provider: LLMProvider.Anthropic,
      apiKey: 'test-key',
      timeoutMs: 5000,
      maxRetries: 1,
    });
  }

  describe('decideAction — successful LLM decision', () => {
    it('should return resolved plan on successful LLM call', async () => {
      setupSuccessfulDecision(mockChat);
      const brain = createBrain();
      const result = await brain.decideAction(makeSnapshot(), makeContext());

      expect(result.plan.type).toBe(AIActionType.BuildTrack);
      expect(result.reasoning).toBe('Build toward Berlin');
      expect(result.planHorizon).toBe('2 turns');
      expect(result.model).toBeDefined();
      expect(result.latencyMs).toBeGreaterThanOrEqual(0);
      expect(result.tokenUsage).toEqual({ input: 100, output: 50 });
      expect(result.retried).toBe(false);
    });
  });

  describe('decideAction — retry and fallback', () => {
    it('should fall back to heuristic when all LLM attempts fail', async () => {
      mockChat.mockRejectedValue(new Error('API down'));
      mockHeuristicFallback.mockResolvedValue({
        success: true,
        plan: { type: AIActionType.PassTurn },
      });

      const brain = createBrain();
      const result = await brain.decideAction(makeSnapshot(), makeContext());

      expect(result.plan.type).toBe(AIActionType.PassTurn);
      expect(result.reasoning).toContain('heuristic fallback');
      // 3 attempts total (initial + 2 retries)
      expect(mockChat).toHaveBeenCalledTimes(3);
    });

    it('should fall back immediately on auth error (no retry)', async () => {
      const { ProviderAuthError } = jest.requireActual('../../services/ai/providers/errors');
      mockChat.mockRejectedValue(new ProviderAuthError('Invalid key'));
      mockHeuristicFallback.mockResolvedValue({
        success: true,
        plan: { type: AIActionType.PassTurn },
      });

      const brain = createBrain();
      const result = await brain.decideAction(makeSnapshot(), makeContext());

      expect(result.reasoning).toContain('heuristic fallback');
      // Should only call API once (no retry on auth error)
      expect(mockChat).toHaveBeenCalledTimes(1);
    });

    it('should retry with error context on action resolution failure', async () => {
      mockChat.mockResolvedValue({
        text: '{"action":"BuildTrack"}',
        usage: { input: 50, output: 20 },
      });
      mockParseActionIntent.mockReturnValue({
        action: 'BuildTrack',
        reasoning: 'Build',
        planHorizon: '',
      });

      // First resolve fails, second succeeds
      mockResolve
        .mockResolvedValueOnce({ success: false, error: 'Not enough money' })
        .mockResolvedValueOnce({ success: true, plan: { type: AIActionType.PassTurn } });

      const brain = createBrain();
      const result = await brain.decideAction(makeSnapshot(), makeContext());

      expect(result.plan.type).toBe(AIActionType.PassTurn);
      expect(mockChat).toHaveBeenCalledTimes(2);
      expect(result.retried).toBe(true);
    });

    it('should default to PassTurn when heuristic fallback also fails', async () => {
      mockChat.mockRejectedValue(new Error('fail'));
      mockHeuristicFallback.mockResolvedValue({
        success: false,
        error: 'No options available',
      });

      const brain = createBrain();
      const result = await brain.decideAction(makeSnapshot(), makeContext());

      expect(result.plan.type).toBe(AIActionType.PassTurn);
      expect(result.reasoning).toContain('Heuristic also failed');
    });
  });

  // --- BE-023: Model selection by skill level ---
  describe('model selection by skill level (BE-023)', () => {
    it('should use Haiku for Easy skill level (Anthropic)', async () => {
      setupSuccessfulDecision(mockChat);
      const brain = createBrain(BotSkillLevel.Easy);
      const result = await brain.decideAction(makeSnapshot(), makeContext());

      expect(result.model).toBe(LLM_DEFAULT_MODELS[LLMProvider.Anthropic][BotSkillLevel.Easy]);
      expect(result.model).toBe('claude-haiku-4-5-20251001');
    });

    it('should use Sonnet for Medium skill level (Anthropic)', async () => {
      setupSuccessfulDecision(mockChat);
      const brain = createBrain(BotSkillLevel.Medium);
      const result = await brain.decideAction(makeSnapshot(), makeContext());

      expect(result.model).toBe(LLM_DEFAULT_MODELS[LLMProvider.Anthropic][BotSkillLevel.Medium]);
      expect(result.model).toBe('claude-sonnet-4-20250514');
    });

    it('should use Sonnet for Hard skill level (Anthropic)', async () => {
      setupSuccessfulDecision(mockChat);
      const brain = createBrain(BotSkillLevel.Hard);
      const result = await brain.decideAction(makeSnapshot(), makeContext());

      expect(result.model).toBe(LLM_DEFAULT_MODELS[LLMProvider.Anthropic][BotSkillLevel.Hard]);
      expect(result.model).toBe('claude-sonnet-4-20250514');
    });

    it('should allow explicit model override regardless of skill level', async () => {
      setupSuccessfulDecision(mockChat);

      const brain = new LLMStrategyBrain({
        archetype: BotArchetype.Balanced,
        skillLevel: BotSkillLevel.Easy,
        provider: LLMProvider.Anthropic,
        model: 'custom-model-v1',
        apiKey: 'test-key',
        timeoutMs: 5000,
        maxRetries: 1,
      });

      const result = await brain.decideAction(makeSnapshot(), makeContext());
      expect(result.model).toBe('custom-model-v1');
    });

    it('should pass correct model to adapter.chat()', async () => {
      setupSuccessfulDecision(mockChat);
      const brain = createBrain(BotSkillLevel.Easy);
      await brain.decideAction(makeSnapshot(), makeContext());

      expect(mockChat).toHaveBeenCalledWith(
        expect.objectContaining({
          model: 'claude-haiku-4-5-20251001',
        }),
      );
    });

    it('should use higher temperature for Easy skill level', async () => {
      setupSuccessfulDecision(mockChat);
      const brain = createBrain(BotSkillLevel.Easy);
      await brain.decideAction(makeSnapshot(), makeContext());

      expect(mockChat).toHaveBeenCalledWith(
        expect.objectContaining({
          temperature: 0.7,
          maxTokens: 200,
        }),
      );
    });

    it('should use lower temperature for Hard skill level', async () => {
      setupSuccessfulDecision(mockChat);
      const brain = createBrain(BotSkillLevel.Hard);
      await brain.decideAction(makeSnapshot(), makeContext());

      expect(mockChat).toHaveBeenCalledWith(
        expect.objectContaining({
          temperature: 0.2,
          maxTokens: 400,
        }),
      );
    });
  });
});
