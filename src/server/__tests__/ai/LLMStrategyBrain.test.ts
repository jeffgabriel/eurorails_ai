import { LLMStrategyBrain } from '../../services/ai/LLMStrategyBrain';
import {
  AIActionType,
  WorldSnapshot,
  GameContext,
  BotSkillLevel,
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
    serializeRoutePlanningPrompt: jest.fn(() => 'route-planning-prompt'),
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
      parseStrategicRoute: jest.fn(),
    },
    ParseError,
  };
});

// Mock RouteValidator
jest.mock('../../services/ai/RouteValidator', () => ({
  RouteValidator: {
    validate: jest.fn(),
  },
}));

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
import { GoogleAdapter } from '../../services/ai/providers/GoogleAdapter';
import { ActionResolver } from '../../services/ai/ActionResolver';
import { ResponseParser } from '../../services/ai/ResponseParser';
import { RouteValidator } from '../../services/ai/RouteValidator';
import { ContextBuilder } from '../../services/ai/ContextBuilder';

const mockResolve = ActionResolver.resolve as jest.Mock;
const mockHeuristicFallback = ActionResolver.heuristicFallback as jest.Mock;
const mockParseActionIntent = ResponseParser.parseActionIntent as jest.Mock;
const mockParseStrategicRoute = (ResponseParser as unknown as { parseStrategicRoute: jest.Mock }).parseStrategicRoute as jest.Mock;
const mockRouteValidate = RouteValidator.validate as jest.Mock;

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
    unconnectedMajorCities: [],
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

    it('should use Opus for Hard skill level (Anthropic)', async () => {
      setupSuccessfulDecision(mockChat);
      const brain = createBrain(BotSkillLevel.Hard);
      const result = await brain.decideAction(makeSnapshot(), makeContext());

      expect(result.model).toBe(LLM_DEFAULT_MODELS[LLMProvider.Anthropic][BotSkillLevel.Hard]);
      expect(result.model).toBe('claude-opus-4-20250514');
    });

    it('should allow explicit model override regardless of skill level', async () => {
      setupSuccessfulDecision(mockChat);

      const brain = new LLMStrategyBrain({
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

  // --- JIRA-6: planRoute with RouteValidator ---
  describe('planRoute — RouteValidator integration', () => {
    const validRoute = {
      stops: [
        { action: 'pickup', loadType: 'Coal', city: 'Krakow' },
        { action: 'deliver', loadType: 'Coal', city: 'Roma', payment: 29 },
      ],
      currentStopIndex: 0,
      phase: 'build' as const,
      startingCity: 'Berlin',
      createdAtTurn: 5,
      reasoning: 'test route',
    };

    it('should retry when RouteValidator rejects the route', async () => {
      mockChat.mockResolvedValue({
        text: '{"route":"..."}',
        usage: { input: 100, output: 50 },
      });
      mockParseStrategicRoute.mockReturnValue(validRoute);

      // First call: rejected. Second call: accepted.
      mockRouteValidate
        .mockReturnValueOnce({
          valid: false,
          errors: ['No demand card for load type "Coal".'],
        })
        .mockReturnValueOnce({
          valid: true,
          errors: [],
        });

      const brain = createBrain();
      const result = await brain.planRoute(makeSnapshot(), makeContext(), []);

      expect(result).not.toBeNull();
      expect(mockChat).toHaveBeenCalledTimes(2);
      expect(mockRouteValidate).toHaveBeenCalledTimes(2);
      // Second call should include error feedback in the prompt
      const secondCallArgs = mockChat.mock.calls[1][0];
      expect(secondCallArgs.userPrompt).toContain('FAILED VALIDATION');
      expect(secondCallArgs.userPrompt).toContain('No demand card');
    });

    it('should use pruned route when RouteValidator prunes some stops', async () => {
      mockChat.mockResolvedValue({
        text: '{"route":"..."}',
        usage: { input: 80, output: 40 },
      });

      const fullRoute = {
        ...validRoute,
        stops: [
          { action: 'pickup', loadType: 'Flowers', city: 'Holland' },
          { action: 'deliver', loadType: 'Flowers', city: 'Wien', payment: 18 },
          { action: 'pickup', loadType: 'Oranges', city: 'Valencia' },
          { action: 'deliver', loadType: 'Oranges', city: 'Aberdeen', payment: 34 },
        ],
      };
      mockParseStrategicRoute.mockReturnValue(fullRoute);

      const prunedRoute = {
        ...fullRoute,
        stops: [
          { action: 'pickup', loadType: 'Flowers', city: 'Holland' },
          { action: 'deliver', loadType: 'Flowers', city: 'Wien', payment: 18 },
        ],
      };
      mockRouteValidate.mockReturnValue({
        valid: true,
        prunedRoute,
        errors: ['No demand card for Oranges.'],
      });

      const brain = createBrain();
      const result = await brain.planRoute(makeSnapshot(), makeContext(), []);

      expect(result).not.toBeNull();
      expect(result!.route.stops).toHaveLength(2);
      expect(result!.route.stops[0].loadType).toBe('Flowers');
      expect(result!.route.stops[1].loadType).toBe('Flowers');
      // Should only call LLM once (route was valid after pruning)
      expect(mockChat).toHaveBeenCalledTimes(1);
    });

    it('should return null when all attempts are rejected by RouteValidator', async () => {
      mockChat.mockResolvedValue({
        text: '{"route":"..."}',
        usage: { input: 60, output: 30 },
      });
      mockParseStrategicRoute.mockReturnValue(validRoute);
      mockRouteValidate.mockReturnValue({
        valid: false,
        errors: ['All stops infeasible.'],
      });

      const brain = createBrain();
      const result = await brain.planRoute(makeSnapshot(), makeContext(), []);

      expect(result).toBeNull();
      // 3 attempts total (initial + 2 retries)
      expect(mockChat).toHaveBeenCalledTimes(3);
    });

    it('should accept route when RouteValidator passes with no pruning', async () => {
      mockChat.mockResolvedValue({
        text: '{"route":"..."}',
        usage: { input: 90, output: 45 },
      });
      mockParseStrategicRoute.mockReturnValue(validRoute);
      mockRouteValidate.mockReturnValue({
        valid: true,
        errors: [],
      });

      const brain = createBrain();
      const result = await brain.planRoute(makeSnapshot(), makeContext(), []);

      expect(result).not.toBeNull();
      expect(result!.route).toBe(validRoute); // Should use original, not pruned
      expect(mockChat).toHaveBeenCalledTimes(1);
    });
  });

  // --- JIRA-5: planRoute prompt enrichment ---
  describe('planRoute — serializeRoutePlanningPrompt integration (JIRA-5)', () => {
    const mockSerializeRoutePlanningPrompt = ContextBuilder.serializeRoutePlanningPrompt as jest.Mock;

    const validRoute = {
      stops: [
        { action: 'pickup', loadType: 'Coal', city: 'Krakow' },
        { action: 'deliver', loadType: 'Coal', city: 'Roma', payment: 29 },
      ],
      currentStopIndex: 0,
      phase: 'build' as const,
      startingCity: 'Berlin',
      createdAtTurn: 5,
      reasoning: 'test route',
    };

    it('should call serializeRoutePlanningPrompt (not serializePrompt) during planRoute', async () => {
      mockChat.mockResolvedValue({
        text: '{"route":"..."}',
        usage: { input: 100, output: 50 },
      });
      mockParseStrategicRoute.mockReturnValue(validRoute);
      mockRouteValidate.mockReturnValue({ valid: true, errors: [] });

      const brain = createBrain();
      await brain.planRoute(makeSnapshot(), makeContext(), []);

      expect(mockSerializeRoutePlanningPrompt).toHaveBeenCalled();
      // serializePrompt should NOT have been called for planRoute
      const mockSerializePrompt = ContextBuilder.serializePrompt as jest.Mock;
      expect(mockSerializePrompt).not.toHaveBeenCalled();
    });

    it('should pass gridPoints to serializeRoutePlanningPrompt', async () => {
      mockChat.mockResolvedValue({
        text: '{"route":"..."}',
        usage: { input: 100, output: 50 },
      });
      mockParseStrategicRoute.mockReturnValue(validRoute);
      mockRouteValidate.mockReturnValue({ valid: true, errors: [] });

      const gridPoints = [{ row: 1, col: 2, id: 'test' }];
      const brain = createBrain();
      await brain.planRoute(makeSnapshot(), makeContext(), gridPoints as any);

      expect(mockSerializeRoutePlanningPrompt).toHaveBeenCalledWith(
        expect.anything(),  // context
        expect.anything(),  // skillLevel
        gridPoints,         // gridPoints passed through
      );
    });

    it('should pass context and skillLevel to serializeRoutePlanningPrompt', async () => {
      mockChat.mockResolvedValue({
        text: '{"route":"..."}',
        usage: { input: 100, output: 50 },
      });
      mockParseStrategicRoute.mockReturnValue(validRoute);
      mockRouteValidate.mockReturnValue({ valid: true, errors: [] });

      const brain = createBrain(BotSkillLevel.Hard);
      const ctx = makeContext();
      await brain.planRoute(makeSnapshot(), ctx, []);

      expect(mockSerializeRoutePlanningPrompt).toHaveBeenCalledWith(
        ctx,
        BotSkillLevel.Hard,
        expect.anything(),
      );
    });

    it('should use route-planning-prompt text from serializeRoutePlanningPrompt in LLM call', async () => {
      mockSerializeRoutePlanningPrompt.mockReturnValue('custom-route-planning-prompt-content');
      mockChat.mockResolvedValue({
        text: '{"route":"..."}',
        usage: { input: 100, output: 50 },
      });
      mockParseStrategicRoute.mockReturnValue(validRoute);
      mockRouteValidate.mockReturnValue({ valid: true, errors: [] });

      const brain = createBrain();
      await brain.planRoute(makeSnapshot(), makeContext(), []);

      expect(mockChat).toHaveBeenCalledWith(
        expect.objectContaining({
          userPrompt: expect.stringContaining('custom-route-planning-prompt-content'),
        }),
      );
    });
  });

  describe('provider selection and model defaults', () => {
    it('should create GoogleAdapter when provider is Google', () => {
      const mockGoogleChat = jest.fn();
      (GoogleAdapter as jest.MockedClass<typeof GoogleAdapter>).mockImplementation(
        () => ({ chat: mockGoogleChat }) as unknown as GoogleAdapter,
      );

      new LLMStrategyBrain({
        skillLevel: BotSkillLevel.Medium,
        provider: LLMProvider.Google,
        apiKey: 'google-key',
        timeoutMs: 5000,
        maxRetries: 1,
      });

      expect(GoogleAdapter).toHaveBeenCalledWith('google-key', 5000);
    });

    it('should create AnthropicAdapter when provider is Anthropic', () => {
      new LLMStrategyBrain({
        skillLevel: BotSkillLevel.Medium,
        provider: LLMProvider.Anthropic,
        apiKey: 'anthropic-key',
        timeoutMs: 5000,
        maxRetries: 1,
      });

      expect(AnthropicAdapter).toHaveBeenCalledWith('anthropic-key', 5000);
    });

    it('should use correct default model per provider and skill level', () => {
      // Anthropic Easy
      expect(LLM_DEFAULT_MODELS[LLMProvider.Anthropic][BotSkillLevel.Easy]).toBe('claude-haiku-4-5-20251001');
      // Anthropic Medium
      expect(LLM_DEFAULT_MODELS[LLMProvider.Anthropic][BotSkillLevel.Medium]).toBe('claude-sonnet-4-20250514');
      // Anthropic Hard
      expect(LLM_DEFAULT_MODELS[LLMProvider.Anthropic][BotSkillLevel.Hard]).toBe('claude-opus-4-20250514');

      // Google Easy
      expect(LLM_DEFAULT_MODELS[LLMProvider.Google][BotSkillLevel.Easy]).toBe('gemini-2.0-flash');
      // Google Medium
      expect(LLM_DEFAULT_MODELS[LLMProvider.Google][BotSkillLevel.Medium]).toBe('gemini-2.5-flash');
      // Google Hard
      expect(LLM_DEFAULT_MODELS[LLMProvider.Google][BotSkillLevel.Hard]).toBe('gemini-2.5-pro');
    });

    it('should have different models for Medium and Hard for each provider', () => {
      expect(LLM_DEFAULT_MODELS[LLMProvider.Anthropic][BotSkillLevel.Medium])
        .not.toBe(LLM_DEFAULT_MODELS[LLMProvider.Anthropic][BotSkillLevel.Hard]);
      expect(LLM_DEFAULT_MODELS[LLMProvider.Google][BotSkillLevel.Medium])
        .not.toBe(LLM_DEFAULT_MODELS[LLMProvider.Google][BotSkillLevel.Hard]);
    });

    it('should use model override when provided', async () => {
      setupSuccessfulDecision(mockChat);

      const brain = new LLMStrategyBrain({
        skillLevel: BotSkillLevel.Easy,
        provider: LLMProvider.Anthropic,
        model: 'custom-model-override',
        apiKey: 'test-key',
        timeoutMs: 5000,
        maxRetries: 1,
      });

      const result = await brain.decideAction(makeSnapshot(), makeContext());

      expect(mockChat).toHaveBeenCalledWith(
        expect.objectContaining({
          model: 'custom-model-override',
        }),
      );
      expect(result.model).toBe('custom-model-override');
    });
  });
});
