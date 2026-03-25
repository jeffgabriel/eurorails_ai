import { LLMStrategyBrain } from '../../services/ai/LLMStrategyBrain';
import {
  AIActionType,
  WorldSnapshot,
  GameContext,
  BotSkillLevel,
  LLMProvider,
  LLM_DEFAULT_MODELS,
} from '../../../shared/types/GameTypes';

// Mock LLM transcript logger to prevent file I/O
jest.mock('../../services/ai/LLMTranscriptLogger', () => ({
  appendLLMCall: jest.fn(),
}));

// Mock all provider adapters
jest.mock('../../services/ai/providers/AnthropicAdapter');
jest.mock('../../services/ai/providers/GoogleAdapter');
jest.mock('../../services/ai/providers/OpenAIAdapter');

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
import { LoggingProviderAdapter } from '../../services/ai/LoggingProviderAdapter';

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
  let setContextSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    // Set up the mock adapter
    mockChat = jest.fn();
    (AnthropicAdapter as jest.MockedClass<typeof AnthropicAdapter>).mockImplementation(
      () => ({ chat: mockChat }) as unknown as AnthropicAdapter,
    );
    // Spy on LoggingProviderAdapter.setContext for JIRA-143 assertions
    setContextSpy = jest.spyOn(LoggingProviderAdapter.prototype, 'setContext');
  });

  afterEach(() => {
    setContextSpy.mockRestore();
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

    it('should use Sonnet 4.6 for Medium skill level (Anthropic)', async () => {
      setupSuccessfulDecision(mockChat);
      const brain = createBrain(BotSkillLevel.Medium);
      const result = await brain.decideAction(makeSnapshot(), makeContext());

      expect(result.model).toBe(LLM_DEFAULT_MODELS[LLMProvider.Anthropic][BotSkillLevel.Medium]);
      expect(result.model).toBe('claude-sonnet-4-6');
    });

    it('should use Opus 4.6 for Hard skill level (Anthropic)', async () => {
      setupSuccessfulDecision(mockChat);
      const brain = createBrain(BotSkillLevel.Hard);
      const result = await brain.decideAction(makeSnapshot(), makeContext());

      expect(result.model).toBe(LLM_DEFAULT_MODELS[LLMProvider.Anthropic][BotSkillLevel.Hard]);
      expect(result.model).toBe('claude-opus-4-6');
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
          maxTokens: 2048,
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
          maxTokens: 8192,
        }),
      );
    });
  });

  describe('createAdapter — OpenAI provider', () => {
    it('should create brain with OpenAI provider without error', () => {
      const brain = new LLMStrategyBrain({
        skillLevel: BotSkillLevel.Easy,
        provider: LLMProvider.OpenAI,
        apiKey: 'test-openai-key',
        timeoutMs: 5000,
        maxRetries: 1,
      });
      expect(brain).toBeDefined();
    });
  });

  // --- JIRA-17: Structured output schemas and effort levels ---
  describe('Anthropic structured output and thinking (JIRA-17)', () => {
    it.each([
      [BotSkillLevel.Medium, 'low'],
      [BotSkillLevel.Hard, 'medium'],
    ])('decideAction — skill %s (4.6 default) should pass schema, thinking, effort=%s', async (skill, expectedEffort) => {
      setupSuccessfulDecision(mockChat);
      const brain = createBrain(skill);
      await brain.decideAction(makeSnapshot(), makeContext());

      const callArgs = mockChat.mock.calls[0][0];
      expect(callArgs.outputSchema).toBeDefined();
      expect(callArgs.outputSchema.type).toBe('object');
      expect(callArgs.outputSchema.oneOf).toBeDefined(); // ACTION_SCHEMA has oneOf
      expect(callArgs.thinking).toEqual({ type: 'adaptive' });
      expect(callArgs.effort).toBe(expectedEffort);
    });

    it('decideAction — Easy (Haiku) should pass schema but not thinking (JIRA-81)', async () => {
      setupSuccessfulDecision(mockChat);
      const brain = createBrain(BotSkillLevel.Easy);
      await brain.decideAction(makeSnapshot(), makeContext());

      const callArgs = mockChat.mock.calls[0][0];
      expect(callArgs.outputSchema).toBeDefined();
      expect(callArgs.thinking).toBeUndefined();
      expect(callArgs.effort).toBeUndefined();
    });

    it.each([
      [BotSkillLevel.Medium, 'medium'],
      [BotSkillLevel.Hard, 'medium'],
    ])('planRoute — skill %s (4.6 default) should pass ROUTE_SCHEMA and effort=%s', async (skill, expectedEffort) => {
      mockChat.mockResolvedValue({
        text: '{"route":"..."}',
        usage: { input: 100, output: 50 },
      });
      mockParseStrategicRoute.mockReturnValue({
        stops: [{ action: 'pickup', loadType: 'Coal', city: 'Berlin' }],
        currentStopIndex: 0,
        phase: 'build',
        startingCity: 'Berlin',
        createdAtTurn: 5,
        reasoning: 'test',
      });
      mockRouteValidate.mockReturnValue({ valid: true, errors: [] });

      const brain = createBrain(skill);
      await brain.planRoute(makeSnapshot(), makeContext(), []);

      const callArgs = mockChat.mock.calls[0][0];
      expect(callArgs.outputSchema).toBeDefined();
      expect(callArgs.outputSchema.properties?.route).toBeDefined();
      expect(callArgs.thinking).toEqual({ type: 'adaptive' });
      expect(callArgs.effort).toBe(expectedEffort);
      expect(callArgs.timeoutMs).toBe(60000);
    });

    it('planRoute — Easy (Haiku) should pass schema but not thinking (JIRA-81)', async () => {
      mockChat.mockResolvedValue({
        text: '{"route":"..."}',
        usage: { input: 100, output: 50 },
      });
      mockParseStrategicRoute.mockReturnValue({
        stops: [{ action: 'pickup', loadType: 'Coal', city: 'Berlin' }],
        currentStopIndex: 0,
        phase: 'build',
        startingCity: 'Berlin',
        createdAtTurn: 5,
        reasoning: 'test',
      });
      mockRouteValidate.mockReturnValue({ valid: true, errors: [] });

      const brain = createBrain(BotSkillLevel.Easy);
      await brain.planRoute(makeSnapshot(), makeContext(), []);

      const callArgs = mockChat.mock.calls[0][0];
      expect(callArgs.outputSchema).toBeDefined();
      expect(callArgs.thinking).toBeUndefined();
      expect(callArgs.effort).toBeUndefined();
      expect(callArgs.timeoutMs).toBe(60000);
    });

    it('decideAction — should pass outputSchema and thinking for Google provider at Medium skill', async () => {
      const mockGoogleChat = jest.fn().mockResolvedValue({
        text: '{"action":"PASS","reasoning":"skip"}',
        usage: { input: 50, output: 20 },
      });
      (GoogleAdapter as jest.MockedClass<typeof GoogleAdapter>).mockImplementation(
        () => ({ chat: mockGoogleChat }) as unknown as GoogleAdapter,
      );
      mockParseActionIntent.mockReturnValue({
        action: 'PASS',
        reasoning: 'skip',
        planHorizon: '',
      });
      mockResolve.mockResolvedValue({
        success: true,
        plan: { type: AIActionType.PassTurn },
      });

      const brain = new LLMStrategyBrain({
        skillLevel: BotSkillLevel.Medium,
        provider: LLMProvider.Google,
        apiKey: 'google-key',
        timeoutMs: 5000,
        maxRetries: 1,
      });
      await brain.decideAction(makeSnapshot(), makeContext());

      const callArgs = mockGoogleChat.mock.calls[0][0];
      expect(callArgs.outputSchema).toBeDefined();
      expect(callArgs.thinking).toEqual({ type: 'adaptive' });
      expect(callArgs.effort).toBe('low');
    });

    it('decideAction — should pass outputSchema and thinking for Google provider at Hard skill', async () => {
      const mockGoogleChat = jest.fn().mockResolvedValue({
        text: '{"action":"BUILD","reasoning":"expand network"}',
        usage: { input: 80, output: 40 },
      });
      (GoogleAdapter as jest.MockedClass<typeof GoogleAdapter>).mockImplementation(
        () => ({ chat: mockGoogleChat }) as unknown as GoogleAdapter,
      );
      mockParseActionIntent.mockReturnValue({
        action: 'BuildTrack',
        reasoning: 'expand network',
        planHorizon: '3 turns',
      });
      mockResolve.mockResolvedValue({
        success: true,
        plan: { type: AIActionType.BuildTrack },
      });

      const brain = new LLMStrategyBrain({
        skillLevel: BotSkillLevel.Hard,
        provider: LLMProvider.Google,
        apiKey: 'google-key',
        timeoutMs: 5000,
        maxRetries: 1,
      });
      await brain.decideAction(makeSnapshot(), makeContext());

      const callArgs = mockGoogleChat.mock.calls[0][0];
      expect(callArgs.outputSchema).toBeDefined();
      expect(callArgs.thinking).toEqual({ type: 'adaptive' });
      expect(callArgs.effort).toBe('medium');
      expect(callArgs.maxTokens).toBe(8192);
      expect(callArgs.temperature).toBe(0.2);
    });

    it('decideAction — should pass outputSchema but not thinking for Google provider at Easy skill (JIRA-81)', async () => {
      const mockGoogleChat = jest.fn().mockResolvedValue({
        text: '{"action":"PASS","reasoning":"easy bot"}',
        usage: { input: 30, output: 10 },
      });
      (GoogleAdapter as jest.MockedClass<typeof GoogleAdapter>).mockImplementation(
        () => ({ chat: mockGoogleChat }) as unknown as GoogleAdapter,
      );
      mockParseActionIntent.mockReturnValue({
        action: 'PASS',
        reasoning: 'easy bot',
        planHorizon: '',
      });
      mockResolve.mockResolvedValue({
        success: true,
        plan: { type: AIActionType.PassTurn },
      });

      const brain = new LLMStrategyBrain({
        skillLevel: BotSkillLevel.Easy,
        provider: LLMProvider.Google,
        apiKey: 'google-key',
        timeoutMs: 5000,
        maxRetries: 1,
      });
      await brain.decideAction(makeSnapshot(), makeContext());

      const callArgs = mockGoogleChat.mock.calls[0][0];
      expect(callArgs.outputSchema).toBeDefined();
      expect(callArgs.thinking).toBeUndefined();
      expect(callArgs.effort).toBeUndefined();
      expect(callArgs.maxTokens).toBe(2048);
      expect(callArgs.temperature).toBe(0.7);
    });

    it('planRoute — should pass ROUTE_SCHEMA and thinking for Google provider at Medium skill', async () => {
      const mockGoogleChat = jest.fn().mockResolvedValue({
        text: '{"route":"..."}',
        usage: { input: 100, output: 50 },
      });
      (GoogleAdapter as jest.MockedClass<typeof GoogleAdapter>).mockImplementation(
        () => ({ chat: mockGoogleChat }) as unknown as GoogleAdapter,
      );
      mockParseStrategicRoute.mockReturnValue({
        stops: [{ action: 'pickup', loadType: 'Coal', city: 'Berlin' }],
        currentStopIndex: 0,
        phase: 'build',
        startingCity: 'Berlin',
        createdAtTurn: 5,
        reasoning: 'test',
      });
      mockRouteValidate.mockReturnValue({ valid: true, errors: [] });

      const brain = new LLMStrategyBrain({
        skillLevel: BotSkillLevel.Medium,
        provider: LLMProvider.Google,
        apiKey: 'google-key',
        timeoutMs: 5000,
        maxRetries: 1,
      });
      await brain.planRoute(makeSnapshot(), makeContext(), []);

      const callArgs = mockGoogleChat.mock.calls[0][0];
      expect(callArgs.outputSchema).toBeDefined();
      expect(callArgs.outputSchema.properties?.route).toBeDefined();
      expect(callArgs.thinking).toEqual({ type: 'adaptive' });
      expect(callArgs.effort).toBe('medium');
      expect(callArgs.timeoutMs).toBe(60000);
      expect(callArgs.maxTokens).toBe(12288);
    });

    it('planRoute — should pass ROUTE_SCHEMA and thinking for Google provider at Hard skill', async () => {
      const mockGoogleChat = jest.fn().mockResolvedValue({
        text: '{"route":"..."}',
        usage: { input: 120, output: 60 },
      });
      (GoogleAdapter as jest.MockedClass<typeof GoogleAdapter>).mockImplementation(
        () => ({ chat: mockGoogleChat }) as unknown as GoogleAdapter,
      );
      mockParseStrategicRoute.mockReturnValue({
        stops: [{ action: 'pickup', loadType: 'Wine', city: 'Bordeaux' }],
        currentStopIndex: 0,
        phase: 'build',
        startingCity: 'Paris',
        createdAtTurn: 5,
        reasoning: 'test',
      });
      mockRouteValidate.mockReturnValue({ valid: true, errors: [] });

      const brain = new LLMStrategyBrain({
        skillLevel: BotSkillLevel.Hard,
        provider: LLMProvider.Google,
        apiKey: 'google-key',
        timeoutMs: 5000,
        maxRetries: 1,
      });
      await brain.planRoute(makeSnapshot(), makeContext(), []);

      const callArgs = mockGoogleChat.mock.calls[0][0];
      expect(callArgs.outputSchema).toBeDefined();
      expect(callArgs.outputSchema.properties?.route).toBeDefined();
      expect(callArgs.thinking).toEqual({ type: 'adaptive' });
      expect(callArgs.effort).toBe('medium');
      expect(callArgs.timeoutMs).toBe(60000);
      expect(callArgs.maxTokens).toBe(16384);
      expect(callArgs.temperature).toBe(0.2);
    });

    it('planRoute — should pass outputSchema but not thinking for Google provider at Easy skill (JIRA-81)', async () => {
      const mockGoogleChat = jest.fn().mockResolvedValue({
        text: '{"route":"..."}',
        usage: { input: 60, output: 30 },
      });
      (GoogleAdapter as jest.MockedClass<typeof GoogleAdapter>).mockImplementation(
        () => ({ chat: mockGoogleChat }) as unknown as GoogleAdapter,
      );
      mockParseStrategicRoute.mockReturnValue({
        stops: [{ action: 'pickup', loadType: 'Coal', city: 'Berlin' }],
        currentStopIndex: 0,
        phase: 'build',
        startingCity: 'Berlin',
        createdAtTurn: 5,
        reasoning: 'test',
      });
      mockRouteValidate.mockReturnValue({ valid: true, errors: [] });

      const brain = new LLMStrategyBrain({
        skillLevel: BotSkillLevel.Easy,
        provider: LLMProvider.Google,
        apiKey: 'google-key',
        timeoutMs: 5000,
        maxRetries: 1,
      });
      await brain.planRoute(makeSnapshot(), makeContext(), []);

      const callArgs = mockGoogleChat.mock.calls[0][0];
      expect(callArgs.outputSchema).toBeDefined();
      expect(callArgs.thinking).toBeUndefined();
      expect(callArgs.effort).toBeUndefined();
      expect(callArgs.timeoutMs).toBe(60000);
      expect(callArgs.maxTokens).toBe(8192);
      expect(callArgs.temperature).toBe(0.7);
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
      const r = result!;
      expect(r.route!.stops).toHaveLength(2);
      expect(r.route!.stops[0].loadType).toBe('Flowers');
      expect(r.route!.stops[1].loadType).toBe('Flowers');
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

      expect(result).not.toBeNull();
      expect(result!.route).toBeNull();
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
      const r = result!;
      expect(r.route).toBe(validRoute); // Should use original, not pruned
      expect(mockChat).toHaveBeenCalledTimes(1);
    });
  });

  // --- BE-006: post-LLM validation for abandoned routes ---
  describe('planRoute — abandoned route rejection (BE-006)', () => {
    const abandonedRoute = {
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

    const differentRoute = {
      stops: [
        { action: 'pickup', loadType: 'Wine', city: 'Lyon' },
        { action: 'deliver', loadType: 'Wine', city: 'Berlin', payment: 20 },
      ],
      currentStopIndex: 0,
      phase: 'build' as const,
      startingCity: 'Paris',
      createdAtTurn: 5,
      reasoning: 'different route',
    };

    it('should reject route matching lastAbandonedRouteKey and retry', async () => {
      mockChat.mockResolvedValue({
        text: '{"route":"..."}',
        usage: { input: 100, output: 50 },
      });

      // First call returns abandoned route, second returns different route
      mockParseStrategicRoute
        .mockReturnValueOnce(abandonedRoute)
        .mockReturnValueOnce(differentRoute);

      mockRouteValidate.mockReturnValue({ valid: true, errors: [] });

      const brain = createBrain();
      const result = await brain.planRoute(
        makeSnapshot(), makeContext(), [], 'Coal:Krakow',
      );

      expect(result).not.toBeNull();
      const r = result!;
      expect(r.route!.stops[0].loadType).toBe('Wine');
      expect(mockChat).toHaveBeenCalledTimes(2);
      // Second prompt should include rejection feedback
      const secondCallArgs = mockChat.mock.calls[1][0];
      expect(secondCallArgs.userPrompt).toContain('matches recently abandoned route');
    });

    it('should accept route when it does NOT match lastAbandonedRouteKey', async () => {
      mockChat.mockResolvedValue({
        text: '{"route":"..."}',
        usage: { input: 100, output: 50 },
      });
      mockParseStrategicRoute.mockReturnValue(differentRoute);
      mockRouteValidate.mockReturnValue({ valid: true, errors: [] });

      const brain = createBrain();
      const result = await brain.planRoute(
        makeSnapshot(), makeContext(), [], 'Coal:Krakow',
      );

      expect(result).not.toBeNull();
      const r = result!;
      expect(r.route!.stops[0].loadType).toBe('Wine');
      expect(mockChat).toHaveBeenCalledTimes(1);
    });

    it('should accept any route when lastAbandonedRouteKey is null', async () => {
      mockChat.mockResolvedValue({
        text: '{"route":"..."}',
        usage: { input: 100, output: 50 },
      });
      mockParseStrategicRoute.mockReturnValue(abandonedRoute);
      mockRouteValidate.mockReturnValue({ valid: true, errors: [] });

      const brain = createBrain();
      const result = await brain.planRoute(
        makeSnapshot(), makeContext(), [], null,
      );

      expect(result).not.toBeNull();
      const r = result!;
      expect(r.route!.stops[0].loadType).toBe('Coal');
      expect(mockChat).toHaveBeenCalledTimes(1);
    });

    it('should return null when all retries produce the abandoned route', async () => {
      mockChat.mockResolvedValue({
        text: '{"route":"..."}',
        usage: { input: 100, output: 50 },
      });
      mockParseStrategicRoute.mockReturnValue(abandonedRoute);
      mockRouteValidate.mockReturnValue({ valid: true, errors: [] });

      const brain = createBrain();
      const result = await brain.planRoute(
        makeSnapshot(), makeContext(), [], 'Coal:Krakow',
      );

      expect(result).not.toBeNull();
      expect(result!.route).toBeNull();
      // Should exhaust all retries (initial + 2 retries = 3 calls)
      expect(mockChat).toHaveBeenCalledTimes(3);
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
        expect.anything(),  // existingSegments
        undefined,          // lastAbandonedRouteKey (BE-005)
        undefined,          // previousRouteStops (BE-010)
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
        expect.anything(),  // gridPoints
        expect.anything(),  // existingSegments
        undefined,          // lastAbandonedRouteKey (BE-005)
        undefined,          // previousRouteStops (BE-010)
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

  // --- JIRA-103: budgetHint parameter ---
  describe('planRoute — budgetHint parameter (JIRA-103)', () => {
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

    it('should prepend budgetHint to user prompt when provided', async () => {
      mockSerializeRoutePlanningPrompt.mockReturnValue('base-route-prompt');
      mockChat.mockResolvedValue({
        text: '{"route":"..."}',
        usage: { input: 100, output: 50 },
      });
      mockParseStrategicRoute.mockReturnValue(validRoute);
      mockRouteValidate.mockReturnValue({ valid: true, errors: [] });

      const brain = createBrain();
      const hint = 'Prioritize routes on existing track. Available cash: 30M.';
      await brain.planRoute(makeSnapshot(), makeContext(), [], null, null, hint);

      expect(mockChat).toHaveBeenCalledWith(
        expect.objectContaining({
          userPrompt: expect.stringContaining(hint),
        }),
      );
      // budgetHint should appear before the base prompt
      const actualPrompt = mockChat.mock.calls[0][0].userPrompt as string;
      expect(actualPrompt.indexOf(hint)).toBeLessThan(actualPrompt.indexOf('base-route-prompt'));
    });

    it('should NOT modify user prompt when budgetHint is undefined', async () => {
      mockSerializeRoutePlanningPrompt.mockReturnValue('base-route-prompt');
      mockChat.mockResolvedValue({
        text: '{"route":"..."}',
        usage: { input: 100, output: 50 },
      });
      mockParseStrategicRoute.mockReturnValue(validRoute);
      mockRouteValidate.mockReturnValue({ valid: true, errors: [] });

      const brain = createBrain();
      await brain.planRoute(makeSnapshot(), makeContext(), []);

      const actualPrompt = mockChat.mock.calls[0][0].userPrompt as string;
      expect(actualPrompt).toBe('base-route-prompt');
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
      expect(LLM_DEFAULT_MODELS[LLMProvider.Anthropic][BotSkillLevel.Medium]).toBe('claude-sonnet-4-6');
      // Anthropic Hard
      expect(LLM_DEFAULT_MODELS[LLMProvider.Anthropic][BotSkillLevel.Hard]).toBe('claude-opus-4-6');

      // Google Easy
      expect(LLM_DEFAULT_MODELS[LLMProvider.Google][BotSkillLevel.Easy]).toBe('gemini-3-flash-preview');
      // Google Medium
      expect(LLM_DEFAULT_MODELS[LLMProvider.Google][BotSkillLevel.Medium]).toBe('gemini-3-pro-preview');
      // Google Hard
      expect(LLM_DEFAULT_MODELS[LLMProvider.Google][BotSkillLevel.Hard]).toBe('gemini-3.1-pro-preview');
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

  describe('llmLog collection — decideAction()', () => {
    it('should return llmLog with success entry on first attempt', async () => {
      setupSuccessfulDecision(mockChat);
      const brain = createBrain();
      const result = await brain.decideAction(makeSnapshot(), makeContext());

      expect(result.llmLog).toHaveLength(1);
      expect(result.llmLog![0]).toMatchObject({
        attemptNumber: 1,
        status: 'success',
        latencyMs: expect.any(Number),
      });
      expect(result.llmLog![0].error).toBeUndefined();
    });

    it('should log validation_error when ActionResolver rejects', async () => {
      mockChat.mockResolvedValue({
        text: '{"action":"BuildTrack"}',
        usage: { input: 100, output: 50 },
      });
      mockParseActionIntent.mockReturnValue({
        action: 'BuildTrack',
        reasoning: 'test',
        planHorizon: 'now',
      });
      // Fail first attempt, succeed second
      mockResolve
        .mockResolvedValueOnce({ success: false, error: 'No valid segments' })
        .mockResolvedValueOnce({ success: true, plan: { type: AIActionType.PassTurn } });

      const brain = createBrain();
      const result = await brain.decideAction(makeSnapshot(), makeContext());

      expect(result.llmLog).toHaveLength(2);
      expect(result.llmLog![0].status).toBe('validation_error');
      expect(result.llmLog![0].error).toBe('No valid segments');
      expect(result.llmLog![1].status).toBe('success');
    });

    it('should log api_error when adapter.chat() throws', async () => {
      mockChat.mockRejectedValue(new Error('Network timeout'));
      mockHeuristicFallback.mockResolvedValue({
        success: true,
        plan: { type: AIActionType.PassTurn },
      });

      const brain = createBrain();
      const result = await brain.decideAction(makeSnapshot(), makeContext());

      expect(result.llmLog!.length).toBeGreaterThanOrEqual(1);
      expect(result.llmLog![0].status).toBe('api_error');
      expect(result.llmLog![0].error).toContain('Network timeout');
    });

    it('should log parse_error when ResponseParser throws ParseError', async () => {
      const { ParseError } = jest.requireMock('../../services/ai/ResponseParser');
      mockChat.mockResolvedValue({ text: 'garbage', usage: { input: 10, output: 5 } });
      mockParseActionIntent.mockImplementation(() => { throw new ParseError('Invalid JSON'); });
      mockHeuristicFallback.mockResolvedValue({
        success: true,
        plan: { type: AIActionType.PassTurn },
      });

      const brain = createBrain();
      const result = await brain.decideAction(makeSnapshot(), makeContext());

      expect(result.llmLog!.length).toBeGreaterThanOrEqual(1);
      expect(result.llmLog![0].status).toBe('parse_error');
      expect(result.llmLog![0].error).toContain('Parsing error');
    });

    it('should preserve full responseText without truncation', async () => {
      const longText = 'x'.repeat(1000);
      mockChat.mockResolvedValue({ text: longText, usage: { input: 10, output: 5 } });
      mockParseActionIntent.mockReturnValue({
        action: 'BuildTrack',
        reasoning: 'test',
        planHorizon: 'now',
      });
      mockResolve.mockResolvedValue({ success: true, plan: { type: AIActionType.BuildTrack } });

      const brain = createBrain();
      const result = await brain.decideAction(makeSnapshot(), makeContext());

      expect(result.llmLog![0].responseText.length).toBe(1000);
    });
  });

  describe('llmLog collection — planRoute()', () => {
    const validRoute = {
      stops: [{ action: 'pickup', loadType: 'Steel', city: 'Ruhr' }],
      currentStopIndex: 0,
      phase: 'build',
      createdAtTurn: 5,
      reasoning: 'Get steel',
    };

    it('should return llmLog with success entry on valid route', async () => {
      mockChat.mockResolvedValue({ text: '{"route":"ok"}', usage: { input: 100, output: 50 } });
      mockParseStrategicRoute.mockReturnValue(validRoute);
      mockRouteValidate.mockReturnValue({ valid: true, errors: [] });

      const brain = createBrain();
      const result = await brain.planRoute(makeSnapshot(), makeContext(), []);

      expect(result).not.toBeNull();
      const r = result!;
      expect(r.llmLog).toHaveLength(1);
      expect(r.llmLog[0]).toMatchObject({
        attemptNumber: 1,
        status: 'success',
        latencyMs: expect.any(Number),
      });
    });

    it('should log validation_error when RouteValidator rejects', async () => {
      mockChat.mockResolvedValue({ text: '{"route":"bad"}', usage: { input: 10, output: 5 } });
      mockParseStrategicRoute.mockReturnValue(validRoute);
      // Fail all attempts
      mockRouteValidate.mockReturnValue({ valid: false, errors: ['Stop 1 invalid'] });

      const brain = createBrain();
      const result = await brain.planRoute(makeSnapshot(), makeContext(), []);

      expect(result).not.toBeNull();
      expect(result!.route).toBeNull();
      // Should have logged multiple validation_error entries (up to MAX_RETRIES+1)
      expect(result!.llmLog.length).toBeGreaterThanOrEqual(1);
      for (const entry of result!.llmLog) {
        expect(entry.status).toBe('validation_error');
      }
    });

    it('should log api_error when adapter.chat() throws', async () => {
      mockChat.mockRejectedValue(new Error('API rate limit'));

      const brain = createBrain();
      const result = await brain.planRoute(makeSnapshot(), makeContext(), []);

      expect(result).not.toBeNull();
      expect(result!.route).toBeNull();
      expect(result!.llmLog.length).toBeGreaterThanOrEqual(1);
      for (const entry of result!.llmLog) {
        expect(entry.status).toBe('api_error');
      }
    });

    it('should log parse_error when parseStrategicRoute throws ParseError', async () => {
      const { ParseError } = jest.requireMock('../../services/ai/ResponseParser');
      mockChat.mockResolvedValue({ text: 'bad json', usage: { input: 10, output: 5 } });
      mockParseStrategicRoute.mockImplementation(() => { throw new ParseError('Invalid route JSON'); });

      const brain = createBrain();
      const result = await brain.planRoute(makeSnapshot(), makeContext(), []);

      expect(result).not.toBeNull();
      expect(result!.route).toBeNull();
      expect(result!.llmLog.length).toBeGreaterThanOrEqual(1);
      for (const entry of result!.llmLog) {
        expect(entry.status).toBe('parse_error');
      }
    });

    it('should include llmLog in successful return value with full responseText', async () => {
      const longResponse = 'r'.repeat(1000);
      mockChat.mockResolvedValue({ text: longResponse, usage: { input: 100, output: 50 } });
      mockParseStrategicRoute.mockReturnValue(validRoute);
      mockRouteValidate.mockReturnValue({ valid: true, errors: [] });

      const brain = createBrain();
      const result = await brain.planRoute(makeSnapshot(), makeContext(), []);

      expect(result).not.toBeNull();
      const r = result!;
      expect(r.llmLog[0].responseText.length).toBe(1000);
    });
  });

  // ── JIRA-92: evaluateCargoConflict ──

  describe('evaluateCargoConflict', () => {
    function createBrain(): LLMStrategyBrain {
      return new LLMStrategyBrain({
        skillLevel: BotSkillLevel.Medium,
        provider: LLMProvider.Anthropic,
        apiKey: 'test-key',
        timeoutMs: 8000,
        maxRetries: 1,
      });
    }

    function makeSnapshotWithCargo(): WorldSnapshot {
      const snap = makeSnapshot();
      snap.bot.loads = ['Hops', 'Coal'];
      snap.bot.resolvedDemands = [
        { cardId: 1, demands: [{ city: 'Stockholm', loadType: 'Hops', payment: 48 }] },
        { cardId: 2, demands: [{ city: 'Paris', loadType: 'Coal', payment: 20 }] },
      ];
      return snap;
    }

    it('should return drop with valid dropLoad', async () => {
      const snap = makeSnapshotWithCargo();
      mockChat.mockResolvedValue({
        text: JSON.stringify({
          action: 'drop',
          dropLoad: 'Hops',
          reasoning: 'Stockholm delivery too expensive',
        }),
        usage: { input: 50, output: 30 },
      });

      const brain = createBrain();
      const result = await brain.evaluateCargoConflict('test prompt', snap, makeContext());

      expect(result).not.toBeNull();
      expect(result!.action).toBe('drop');
      expect(result!.dropLoad).toBe('Hops');
      expect(result!.reasoning).toBe('Stockholm delivery too expensive');
    });

    it('should return keep when LLM says keep', async () => {
      mockChat.mockResolvedValue({
        text: JSON.stringify({
          action: 'keep',
          reasoning: 'Delivery is imminent',
        }),
        usage: { input: 50, output: 20 },
      });

      const brain = createBrain();
      const result = await brain.evaluateCargoConflict('test prompt', makeSnapshotWithCargo(), makeContext());

      expect(result).not.toBeNull();
      expect(result!.action).toBe('keep');
      expect(result!.dropLoad).toBeUndefined();
    });

    it('should treat drop without dropLoad as keep', async () => {
      mockChat.mockResolvedValue({
        text: JSON.stringify({
          action: 'drop',
          reasoning: 'Should drop but forgot to say what',
        }),
        usage: { input: 50, output: 20 },
      });

      const brain = createBrain();
      const result = await brain.evaluateCargoConflict('test prompt', makeSnapshotWithCargo(), makeContext());

      expect(result).not.toBeNull();
      expect(result!.action).toBe('keep');
    });

    it('should treat drop with non-carried dropLoad as keep', async () => {
      const snap = makeSnapshotWithCargo();
      mockChat.mockResolvedValue({
        text: JSON.stringify({
          action: 'drop',
          dropLoad: 'Wheat', // Not carried
          reasoning: 'Drop the wheat',
        }),
        usage: { input: 50, output: 20 },
      });

      const brain = createBrain();
      const result = await brain.evaluateCargoConflict('test prompt', snap, makeContext());

      expect(result).not.toBeNull();
      expect(result!.action).toBe('keep');
    });

    it('should retry on invalid action then return null', async () => {
      mockChat
        .mockResolvedValueOnce({
          text: JSON.stringify({ action: 'sell', reasoning: 'bad action' }),
          usage: { input: 50, output: 20 },
        })
        .mockResolvedValueOnce({
          text: JSON.stringify({ action: 'trade', reasoning: 'still bad' }),
          usage: { input: 50, output: 20 },
        });

      const brain = createBrain();
      const result = await brain.evaluateCargoConflict('test prompt', makeSnapshotWithCargo(), makeContext());

      expect(result).toBeNull();
      expect(mockChat).toHaveBeenCalledTimes(2); // Initial + 1 retry
    });

    it('should return null on LLM timeout', async () => {
      mockChat.mockRejectedValue(new Error('API timeout'));

      const brain = createBrain();
      const result = await brain.evaluateCargoConflict('test prompt', makeSnapshotWithCargo(), makeContext());

      expect(result).toBeNull();
    });

    it('should return null on invalid JSON', async () => {
      mockChat.mockResolvedValue({
        text: 'not valid json at all',
        usage: { input: 50, output: 20 },
      });

      const brain = createBrain();
      const result = await brain.evaluateCargoConflict('test prompt', makeSnapshotWithCargo(), makeContext());

      expect(result).toBeNull();
    });
  });
  // ── JIRA-143: setContext() called before each chat() ──

  describe('setContext — caller context before chat() (JIRA-143)', () => {
    it('should call setContext with strategy-brain/planRoute before chat in decideAction', async () => {
      setupSuccessfulDecision(mockChat);
      const brain = createBrain();
      const snapshot = makeSnapshot();
      await brain.decideAction(snapshot, makeContext());

      expect(setContextSpy).toHaveBeenCalledWith({
        gameId: 'g1',
        playerId: 'bot-1',
        turn: 5,
        caller: 'strategy-brain',
        method: 'planRoute',
      });
      // setContext must be called before chat
      const setContextOrder = setContextSpy.mock.invocationCallOrder[0];
      const chatOrder = mockChat.mock.invocationCallOrder[0];
      expect(setContextOrder).toBeLessThan(chatOrder);
    });

    it('should call setContext with strategy-brain/planRoute before chat in planRoute', async () => {
      mockChat.mockResolvedValue({
        text: '{"route":"..."}',
        usage: { input: 100, output: 50 },
      });
      mockParseStrategicRoute.mockReturnValue({
        stops: [{ action: 'pickup', loadType: 'Coal', city: 'Berlin' }],
        currentStopIndex: 0,
        phase: 'build',
        startingCity: 'Berlin',
        createdAtTurn: 5,
        reasoning: 'test',
      });
      mockRouteValidate.mockReturnValue({ valid: true, errors: [] });

      const brain = createBrain();
      await brain.planRoute(makeSnapshot(), makeContext(), []);

      expect(setContextSpy).toHaveBeenCalledWith({
        gameId: 'g1',
        playerId: 'bot-1',
        turn: 5,
        caller: 'strategy-brain',
        method: 'planRoute',
      });
    });

    it('should call setContext with strategy-brain/evaluateCargoConflict before chat', async () => {
      const snap = makeSnapshot();
      snap.bot.loads = ['Hops', 'Coal'];
      snap.bot.resolvedDemands = [
        { cardId: 1, demands: [{ city: 'Stockholm', loadType: 'Hops', payment: 48 }] },
        { cardId: 2, demands: [{ city: 'Paris', loadType: 'Coal', payment: 20 }] },
      ];
      mockChat.mockResolvedValue({
        text: JSON.stringify({ action: 'keep', reasoning: 'keep it' }),
        usage: { input: 50, output: 20 },
      });

      const brain = createBrain();
      await brain.evaluateCargoConflict('test prompt', snap, makeContext());

      expect(setContextSpy).toHaveBeenCalledWith({
        gameId: 'g1',
        playerId: 'bot-1',
        turn: 5,
        caller: 'strategy-brain',
        method: 'evaluateCargoConflict',
      });
    });

    it('should call setContext with strategy-brain/evaluateUpgradeBeforeDrop before chat', async () => {
      mockChat.mockResolvedValue({
        text: JSON.stringify({ action: 'skip', reasoning: 'not worth it' }),
        usage: { input: 50, output: 20 },
      });

      const brain = createBrain();
      await brain.evaluateUpgradeBeforeDrop('test prompt', makeSnapshot(50), makeContext());

      expect(setContextSpy).toHaveBeenCalledWith({
        gameId: 'g1',
        playerId: 'bot-1',
        turn: 5,
        caller: 'strategy-brain',
        method: 'evaluateUpgradeBeforeDrop',
      });
    });

    it('should call setContext on each retry in decideAction', async () => {
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
      await brain.decideAction(makeSnapshot(), makeContext());

      // setContext should be called before each chat attempt
      expect(setContextSpy).toHaveBeenCalledTimes(2);
    });
  });

  // ── JIRA-105b: evaluateUpgradeBeforeDrop ──

  describe('evaluateUpgradeBeforeDrop', () => {
    function createBrain(): LLMStrategyBrain {
      return new LLMStrategyBrain({
        skillLevel: BotSkillLevel.Medium,
        provider: LLMProvider.Anthropic,
        apiKey: 'test-key',
        timeoutMs: 8000,
        maxRetries: 1,
      });
    }

    it('should return upgrade with valid targetTrain', async () => {
      mockChat.mockResolvedValue({
        text: JSON.stringify({
          action: 'upgrade',
          targetTrain: 'HeavyFreight',
          reasoning: 'Net benefit is positive',
        }),
        usage: { input: 50, output: 30 },
      });

      const brain = createBrain();
      const result = await brain.evaluateUpgradeBeforeDrop('test prompt', makeSnapshot(50), makeContext());

      expect(result).not.toBeNull();
      expect(result!.action).toBe('upgrade');
      expect(result!.targetTrain).toBe('HeavyFreight');
      expect(result!.reasoning).toBe('Net benefit is positive');
    });

    it('should return skip when LLM says skip', async () => {
      mockChat.mockResolvedValue({
        text: JSON.stringify({
          action: 'skip',
          reasoning: 'Need to build track urgently',
        }),
        usage: { input: 50, output: 20 },
      });

      const brain = createBrain();
      const result = await brain.evaluateUpgradeBeforeDrop('test prompt', makeSnapshot(50), makeContext());

      expect(result).not.toBeNull();
      expect(result!.action).toBe('skip');
      expect(result!.targetTrain).toBeUndefined();
    });

    it('should treat upgrade without targetTrain as skip', async () => {
      mockChat.mockResolvedValue({
        text: JSON.stringify({
          action: 'upgrade',
          reasoning: 'Should upgrade but forgot target',
        }),
        usage: { input: 50, output: 20 },
      });

      const brain = createBrain();
      const result = await brain.evaluateUpgradeBeforeDrop('test prompt', makeSnapshot(50), makeContext());

      expect(result).not.toBeNull();
      expect(result!.action).toBe('skip');
    });

    it('should retry on invalid action then return null', async () => {
      mockChat
        .mockResolvedValueOnce({
          text: JSON.stringify({ action: 'buy', reasoning: 'bad action' }),
          usage: { input: 50, output: 20 },
        })
        .mockResolvedValueOnce({
          text: JSON.stringify({ action: 'sell', reasoning: 'still bad' }),
          usage: { input: 50, output: 20 },
        });

      const brain = createBrain();
      const result = await brain.evaluateUpgradeBeforeDrop('test prompt', makeSnapshot(50), makeContext());

      expect(result).toBeNull();
      expect(mockChat).toHaveBeenCalledTimes(2); // Initial + 1 retry
    });

    it('should return null on LLM timeout', async () => {
      mockChat.mockRejectedValue(new Error('API timeout'));

      const brain = createBrain();
      const result = await brain.evaluateUpgradeBeforeDrop('test prompt', makeSnapshot(50), makeContext());

      expect(result).toBeNull();
    });

    it('should return null on invalid JSON', async () => {
      mockChat.mockResolvedValue({
        text: 'not valid json',
        usage: { input: 50, output: 20 },
      });

      const brain = createBrain();
      const result = await brain.evaluateUpgradeBeforeDrop('test prompt', makeSnapshot(50), makeContext());

      expect(result).toBeNull();
    });
  });
});

// ── JIRA-105b: UPGRADE_BEFORE_DROP_SCHEMA validation ──

describe('UPGRADE_BEFORE_DROP_SCHEMA', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { UPGRADE_BEFORE_DROP_SCHEMA } = require('../../services/ai/schemas');

  it('should have upgrade and skip as valid action values', () => {
    expect(UPGRADE_BEFORE_DROP_SCHEMA.properties.action.enum).toEqual(['upgrade', 'skip']);
  });

  it('should require action and reasoning', () => {
    expect(UPGRADE_BEFORE_DROP_SCHEMA.required).toContain('action');
    expect(UPGRADE_BEFORE_DROP_SCHEMA.required).toContain('reasoning');
  });

  it('should have targetTrain as optional string', () => {
    expect(UPGRADE_BEFORE_DROP_SCHEMA.properties.targetTrain.type).toBe('string');
    expect(UPGRADE_BEFORE_DROP_SCHEMA.required).not.toContain('targetTrain');
  });

  it('should disallow additional properties', () => {
    expect(UPGRADE_BEFORE_DROP_SCHEMA.additionalProperties).toBe(false);
  });
});

// ── JIRA-92: CARGO_CONFLICT_SCHEMA validation ──

describe('CARGO_CONFLICT_SCHEMA', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { CARGO_CONFLICT_SCHEMA } = require('../../services/ai/schemas');

  it('should have drop and keep as valid action values', () => {
    expect(CARGO_CONFLICT_SCHEMA.properties.action.enum).toEqual(['drop', 'keep']);
  });

  it('should require action and reasoning', () => {
    expect(CARGO_CONFLICT_SCHEMA.required).toContain('action');
    expect(CARGO_CONFLICT_SCHEMA.required).toContain('reasoning');
  });

  it('should have dropLoad as optional string', () => {
    expect(CARGO_CONFLICT_SCHEMA.properties.dropLoad.type).toBe('string');
    expect(CARGO_CONFLICT_SCHEMA.required).not.toContain('dropLoad');
  });
});

// ── JIRA-89: findDeadLoads ──

describe('PlanExecutor.findDeadLoads', () => {
  // Import PlanExecutor — it doesn't need the full mock setup
  const { PlanExecutor } = require('../../services/ai/PlanExecutor');

  it('should return empty array when no loads carried', () => {
    const result = PlanExecutor.findDeadLoads([], [{ demands: [{ loadType: 'Coal' }] }]);
    expect(result).toEqual([]);
  });

  it('should return empty array when all loads have matching demands', () => {
    const loads = ['Coal', 'Iron'];
    const demands = [
      { demands: [{ loadType: 'Coal' }] },
      { demands: [{ loadType: 'Iron' }] },
    ];
    const result = PlanExecutor.findDeadLoads(loads, demands);
    expect(result).toEqual([]);
  });

  it('should detect dead loads with no matching demand', () => {
    const loads = ['Coal', 'Iron'];
    const demands = [
      { demands: [{ loadType: 'Coal' }] },
      // No demand for Iron
    ];
    const result = PlanExecutor.findDeadLoads(loads, demands);
    expect(result).toEqual(['Iron']);
  });

  it('should return all loads when no demands exist', () => {
    const loads = ['Coal', 'Iron'];
    const demands: any[] = [];
    const result = PlanExecutor.findDeadLoads(loads, demands);
    expect(result).toEqual(['Coal', 'Iron']);
  });

  it('should handle demand card with multiple demands (one matches)', () => {
    const loads = ['Coal'];
    const demands = [
      { demands: [{ loadType: 'Iron' }, { loadType: 'Coal' }, { loadType: 'Steel' }] },
    ];
    const result = PlanExecutor.findDeadLoads(loads, demands);
    expect(result).toEqual([]);
  });
});
