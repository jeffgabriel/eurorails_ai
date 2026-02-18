import { LLMStrategyBrain } from '../../services/ai/LLMStrategyBrain';
import {
  FeasibleOption,
  AIActionType,
  WorldSnapshot,
  BotSkillLevel,
  BotArchetype,
  LLMProvider,
  BotMemoryState,
} from '../../../shared/types/GameTypes';

// Mock all provider adapters
jest.mock('../../services/ai/providers/AnthropicAdapter');
jest.mock('../../services/ai/providers/GoogleAdapter');

// Mock MapTopology (needed by GameStateSerializer)
jest.mock('../../services/ai/MapTopology', () => ({
  loadGridPoints: jest.fn(() => new Map()),
  getHexNeighbors: jest.fn(() => []),
  getTerrainCost: jest.fn(() => 1),
  gridToPixel: jest.fn(() => ({ x: 0, y: 0 })),
  _resetCache: jest.fn(),
}));

// Import after mocking
import { AnthropicAdapter } from '../../services/ai/providers/AnthropicAdapter';

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

function makeMoveOption(overrides?: Partial<FeasibleOption>): FeasibleOption {
  return {
    action: AIActionType.MoveTrain,
    feasible: true,
    reason: 'Move',
    ...overrides,
  };
}

function makeBuildOption(overrides?: Partial<FeasibleOption>): FeasibleOption {
  return {
    action: AIActionType.BuildTrack,
    feasible: true,
    reason: 'Build',
    estimatedCost: 5,
    chainScore: 10,
    ...overrides,
  };
}

function makeMemory(): BotMemoryState {
  return {
    currentBuildTarget: null,
    turnsOnTarget: 0,
    lastAction: null,
    consecutivePassTurns: 0,
    consecutiveDiscards: 0,
    deliveryCount: 0,
    totalEarnings: 0,
    turnNumber: 0,
    activePlan: null,
    turnsOnPlan: 0,
    planHistory: [],
  };
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

  function createBrain(): LLMStrategyBrain {
    return new LLMStrategyBrain({
      archetype: BotArchetype.Balanced,
      skillLevel: BotSkillLevel.Medium,
      provider: LLMProvider.Anthropic,
      apiKey: 'test-key',
      timeoutMs: 5000,
      maxRetries: 1,
    });
  }

  describe('successful LLM selection', () => {
    it('should return LLM-selected indices on successful API call', async () => {
      mockChat.mockResolvedValue({
        text: JSON.stringify({
          moveOption: 1,
          buildOption: 0,
          reasoning: 'Head to Berlin for coal delivery',
          planHorizon: '2 turns',
        }),
        usage: { input: 100, output: 50 },
      });

      const brain = createBrain();
      const result = await brain.selectOptions(
        makeSnapshot(),
        [makeMoveOption(), makeMoveOption({ payment: 12 })],
        [makeBuildOption()],
        makeMemory(),
      );

      expect(result.moveOptionIndex).toBe(1);
      expect(result.buildOptionIndex).toBe(0);
      expect(result.reasoning).toContain('Berlin');
      expect(result.model).toBeDefined();
      expect(result.latencyMs).toBeGreaterThanOrEqual(0);
      expect(result.tokenUsage).toEqual({ input: 100, output: 50 });
    });
  });

  describe('retry and fallback', () => {
    it('should fall back to heuristic when API fails twice', async () => {
      mockChat.mockRejectedValue(new Error('API down'));

      const brain = createBrain();
      const result = await brain.selectOptions(
        makeSnapshot(),
        [makeMoveOption({ payment: 5 }), makeMoveOption({ payment: 12 })],
        [makeBuildOption({ chainScore: 10 }), makeBuildOption({ chainScore: 20 })],
        makeMemory(),
      );

      // Heuristic: highest payment move, highest chainScore build
      expect(result.moveOptionIndex).toBe(1); // payment 12 > payment 5
      expect(result.buildOptionIndex).toBe(1); // chainScore 20 > 10
      expect(result.reasoning).toContain('heuristic fallback');
    });

    it('should fall back immediately on auth error (no retry)', async () => {
      const { ProviderAuthError } = jest.requireActual('../../services/ai/providers/errors');
      mockChat.mockRejectedValue(new ProviderAuthError('Invalid key'));

      const brain = createBrain();
      const result = await brain.selectOptions(
        makeSnapshot(),
        [makeMoveOption({ payment: 5 })],
        [makeBuildOption()],
        makeMemory(),
      );

      expect(result.reasoning).toContain('heuristic fallback');
      // Should only call API once (no retry)
      expect(mockChat).toHaveBeenCalledTimes(1);
    });

    it('should select first move when none have payment (heuristic)', async () => {
      mockChat.mockRejectedValue(new Error('fail'));

      const brain = createBrain();
      const result = await brain.selectOptions(
        makeSnapshot(),
        [makeMoveOption(), makeMoveOption()],
        [makeBuildOption()],
        makeMemory(),
      );

      expect(result.moveOptionIndex).toBe(0);
    });
  });

  describe('guardrail integration', () => {
    it('should apply guardrail override to LLM selection', async () => {
      // LLM skips movement (moveOption=-1) but a delivery move exists
      mockChat.mockResolvedValue({
        text: JSON.stringify({ moveOption: -1, buildOption: 0 }),
        usage: { input: 50, output: 20 },
      });

      const deliveryMove = makeMoveOption({ payment: 15, feasible: true });
      const brain = createBrain();
      const result = await brain.selectOptions(
        makeSnapshot(),
        [deliveryMove],
        [makeBuildOption()],
        makeMemory(),
      );

      // GuardrailEnforcer should override moveOption from -1 to 0
      expect(result.moveOptionIndex).toBe(0);
      expect(result.wasGuardrailOverride).toBe(true);
    });
  });

  describe('empty options', () => {
    it('should handle no feasible moves gracefully', async () => {
      mockChat.mockRejectedValue(new Error('fail'));

      const brain = createBrain();
      const result = await brain.selectOptions(
        makeSnapshot(),
        [], // no moves
        [makeBuildOption()],
        makeMemory(),
      );

      expect(result.moveOptionIndex).toBe(-1);
    });
  });
});
