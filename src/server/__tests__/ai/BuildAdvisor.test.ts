import { BuildAdvisor } from '../../services/ai/BuildAdvisor';
import { LLMStrategyBrain } from '../../services/ai/LLMStrategyBrain';
import {
  WorldSnapshot,
  GameContext,
  StrategicRoute,
  GridPoint,
  TerrainType,
  BuildAdvisorResult,
} from '../../../shared/types/GameTypes';

// Mock the LLMStrategyBrain module
jest.mock('../../services/ai/LLMStrategyBrain');

/** Helper to create a GridPoint */
function gp(row: number, col: number, terrain: TerrainType, cityName?: string): GridPoint {
  return {
    id: `${row},${col}`,
    x: col * 50,
    y: row * 50,
    row,
    col,
    terrain,
    city: cityName ? { type: terrain, name: cityName, availableLoads: [] } : undefined,
  };
}

/** Minimal grid with a target city */
const testGrid: GridPoint[] = [
  gp(0, 0, TerrainType.MajorCity, 'Berlin'),
  gp(0, 1, TerrainType.Clear),
  gp(0, 2, TerrainType.Clear),
  gp(1, 0, TerrainType.Clear),
  gp(1, 1, TerrainType.Clear),
  gp(1, 2, TerrainType.Clear),
  gp(2, 0, TerrainType.Clear),
  gp(2, 1, TerrainType.Clear),
  gp(2, 2, TerrainType.MajorCity, 'Paris'),
];

/** Minimal snapshot */
function makeSnapshot(): WorldSnapshot {
  return {
    gameId: 'test-game',
    gameStatus: 'active',
    turnNumber: 10,
    bot: {
      playerId: 'bot-1',
      userId: 'user-1',
      money: 20,
      position: { row: 0, col: 0 },
      existingSegments: [
        {
          from: { x: 0, y: 0, row: 0, col: 0, terrain: TerrainType.MajorCity },
          to: { x: 50, y: 0, row: 0, col: 1, terrain: TerrainType.Clear },
          cost: 1,
        },
      ],
      demandCards: [],
      resolvedDemands: [],
      trainType: 'freight',
      loads: [],
      botConfig: { skillLevel: 'medium' },
      connectedMajorCityCount: 1,
    },
    allPlayerTracks: [
      { playerId: 'bot-1', segments: [] },
    ],
    loadAvailability: {},
  };
}

/** Minimal context */
function makeContext(): GameContext {
  return {
    position: { row: 0, col: 0 },
    money: 20,
    trainType: 'freight',
    speed: 9,
    capacity: 2,
    loads: [],
    connectedMajorCities: ['Berlin'],
    unconnectedMajorCities: [{ cityName: 'Paris', estimatedCost: 10 }],
    totalMajorCities: 8,
    trackSummary: '',
    turnBuildCost: 0,
    demands: [],
    canDeliver: [],
    canPickup: [],
    reachableCities: [],
    citiesOnNetwork: ['Berlin'],
    canUpgrade: false,
    canBuild: true,
    isInitialBuild: false,
    opponents: [],
    phase: 'active',
    turnNumber: 10,
  };
}

/** Active route targeting Paris */
function makeRoute(): StrategicRoute {
  return {
    stops: [
      { action: 'pickup', loadType: 'Steel', city: 'Berlin' },
      { action: 'deliver', loadType: 'Steel', city: 'Paris', payment: 15 },
    ],
    currentStopIndex: 1,
    phase: 'build',
    createdAtTurn: 8,
    reasoning: 'Deliver steel to Paris',
  };
}

/** Mock brain that returns canned responses */
function makeMockBrain(responseText: string, opts: { setContextFn?: jest.Mock } = {}): LLMStrategyBrain {
  const mockChat = jest.fn().mockResolvedValue({
    text: responseText,
    usage: { input: 100, output: 50 },
  });
  const setContextFn = opts.setContextFn ?? jest.fn();

  return {
    providerAdapter: { chat: mockChat, setContext: setContextFn },
    modelName: 'test-model',
  } as unknown as LLMStrategyBrain;
}

/** Mock brain that throws an error */
function makeFailingBrain(): LLMStrategyBrain {
  const mockChat = jest.fn().mockRejectedValue(new Error('LLM timeout'));

  return {
    providerAdapter: { chat: mockChat, setContext: jest.fn() },
    modelName: 'test-model',
  } as unknown as LLMStrategyBrain;
}

describe('BuildAdvisor', () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('advise', () => {
    it('should return result with valid waypoints', async () => {
      const validResponse: BuildAdvisorResult = {
        action: 'build',
        target: 'Paris',
        waypoints: [[1, 1], [2, 2]],
        reasoning: 'Build toward Paris via center',
      };
      const brain = makeMockBrain(JSON.stringify(validResponse));

      const result = await BuildAdvisor.advise(
        makeSnapshot(),
        makeContext(),
        makeRoute(),
        testGrid,
        brain,
      );

      expect(result).not.toBeNull();
      expect(result!.action).toBe('build');
      expect(result!.target).toBe('Paris');
      expect(result!.waypoints).toEqual([[1, 1], [2, 2]]);
    });

    it('should filter out invalid waypoints', async () => {
      const responseWithInvalid: BuildAdvisorResult = {
        action: 'build',
        target: 'Paris',
        waypoints: [[1, 1], [99, 99], [2, 2]], // [99,99] doesn't exist
        reasoning: 'Build toward Paris',
      };
      const brain = makeMockBrain(JSON.stringify(responseWithInvalid));

      const result = await BuildAdvisor.advise(
        makeSnapshot(),
        makeContext(),
        makeRoute(),
        testGrid,
        brain,
      );

      expect(result).not.toBeNull();
      expect(result!.waypoints).toEqual([[1, 1], [2, 2]]); // [99,99] filtered
    });

    it('should return null when all waypoints are invalid for build action', async () => {
      const allInvalid: BuildAdvisorResult = {
        action: 'build',
        target: 'Paris',
        waypoints: [[99, 99], [88, 88]],
        reasoning: 'Bad waypoints',
      };
      const brain = makeMockBrain(JSON.stringify(allInvalid));

      const result = await BuildAdvisor.advise(
        makeSnapshot(),
        makeContext(),
        makeRoute(),
        testGrid,
        brain,
      );

      expect(result).toBeNull();
    });

    it('should return null on LLM failure', async () => {
      const brain = makeFailingBrain();

      const result = await BuildAdvisor.advise(
        makeSnapshot(),
        makeContext(),
        makeRoute(),
        testGrid,
        brain,
      );

      expect(result).toBeNull();
    });

    it('should attempt extraction on JSON parse failure and succeed', async () => {
      const validExtracted: BuildAdvisorResult = {
        action: 'build',
        target: 'Paris',
        waypoints: [[1, 1], [2, 2]],
        reasoning: 'Build toward Paris via extraction',
      };
      // First call returns prose, second returns valid JSON
      const mockChat = jest.fn()
        .mockResolvedValueOnce({ text: 'To build toward Paris, I recommend heading south-east through the corridor...', usage: { input: 100, output: 50 } })
        .mockResolvedValueOnce({ text: JSON.stringify(validExtracted), usage: { input: 50, output: 30 } });

      const brain = {
        providerAdapter: { chat: mockChat, setContext: jest.fn() },
        modelName: 'test-model',
      } as unknown as LLMStrategyBrain;

      const result = await BuildAdvisor.advise(
        makeSnapshot(),
        makeContext(),
        makeRoute(),
        testGrid,
        brain,
      );

      expect(result).not.toBeNull();
      expect(result!.action).toBe('build');
      expect(result!.target).toBe('Paris');
      expect(mockChat).toHaveBeenCalledTimes(2);
      expect(BuildAdvisor.lastDiagnostics.extractionUsed).toBe(true);
      expect(BuildAdvisor.lastDiagnostics.extractionLatencyMs).toBeGreaterThanOrEqual(0);
      expect(BuildAdvisor.lastDiagnostics.extractionError).toBeUndefined();
    });

    it('should return null when extraction also fails', async () => {
      // Both calls return prose (no valid JSON)
      const mockChat = jest.fn()
        .mockResolvedValueOnce({ text: 'Build toward Paris via the center corridor', usage: { input: 100, output: 50 } })
        .mockResolvedValueOnce({ text: 'I suggest building south-east', usage: { input: 50, output: 30 } });

      const brain = {
        providerAdapter: { chat: mockChat, setContext: jest.fn() },
        modelName: 'test-model',
      } as unknown as LLMStrategyBrain;

      const result = await BuildAdvisor.advise(
        makeSnapshot(),
        makeContext(),
        makeRoute(),
        testGrid,
        brain,
      );

      expect(result).toBeNull();
      expect(mockChat).toHaveBeenCalledTimes(2);
      expect(BuildAdvisor.lastDiagnostics.extractionUsed).toBe(true);
      expect(BuildAdvisor.lastDiagnostics.extractionError).toBeDefined();
    });

    it('should skip extraction when pass 1 returns valid JSON', async () => {
      const validResponse: BuildAdvisorResult = {
        action: 'build',
        target: 'Paris',
        waypoints: [[1, 1]],
        reasoning: 'Direct route',
      };
      const brain = makeMockBrain(JSON.stringify(validResponse));

      const result = await BuildAdvisor.advise(
        makeSnapshot(),
        makeContext(),
        makeRoute(),
        testGrid,
        brain,
      );

      expect(result).not.toBeNull();
      expect((brain.providerAdapter.chat as jest.Mock)).toHaveBeenCalledTimes(1);
      expect(BuildAdvisor.lastDiagnostics.extractionUsed).toBeUndefined();
    });

    it('should omit thinking config in extraction call to enable structured output', async () => {
      const validExtracted: BuildAdvisorResult = {
        action: 'build',
        target: 'Paris',
        waypoints: [[1, 1]],
        reasoning: 'Extracted',
      };
      const mockChat = jest.fn()
        .mockResolvedValueOnce({ text: 'prose response here', usage: { input: 100, output: 50 } })
        .mockResolvedValueOnce({ text: JSON.stringify(validExtracted), usage: { input: 50, output: 30 } });

      const brain = {
        providerAdapter: { chat: mockChat, setContext: jest.fn() },
        modelName: 'test-model',
      } as unknown as LLMStrategyBrain;

      await BuildAdvisor.advise(
        makeSnapshot(),
        makeContext(),
        makeRoute(),
        testGrid,
        brain,
      );

      const secondCall = mockChat.mock.calls[1][0];
      expect(secondCall.thinking).toBeUndefined();
      expect(secondCall.maxTokens).toBe(512);
      expect(secondCall.timeoutMs).toBe(10000);
      expect(secondCall.outputSchema).toBeDefined();
    });

    it('should pass timeoutMs: 30000 to the chat call', async () => {
      const validResponse: BuildAdvisorResult = {
        action: 'build',
        target: 'Paris',
        waypoints: [[1, 1]],
        reasoning: 'Build toward Paris',
      };
      const brain = makeMockBrain(JSON.stringify(validResponse));

      await BuildAdvisor.advise(
        makeSnapshot(),
        makeContext(),
        makeRoute(),
        testGrid,
        brain,
      );

      const chatCall = (brain.providerAdapter.chat as jest.Mock).mock.calls[0][0];
      expect(chatCall.timeoutMs).toBe(30000);
    });

    it('should pass thinking: { type: "adaptive" } to the chat call (JIRA-205)', async () => {
      const validResponse: BuildAdvisorResult = {
        action: 'build',
        target: 'Paris',
        waypoints: [[1, 1]],
        reasoning: 'Build toward Paris',
      };
      const brain = makeMockBrain(JSON.stringify(validResponse));

      await BuildAdvisor.advise(
        makeSnapshot(),
        makeContext(),
        makeRoute(),
        testGrid,
        brain,
      );

      const chatCall = (brain.providerAdapter.chat as jest.Mock).mock.calls[0][0];
      expect(chatCall.thinking).toEqual({ type: 'adaptive' });
    });

    it('should allow empty waypoints for useOpponentTrack action', async () => {
      const opponentTrackResponse: BuildAdvisorResult = {
        action: 'useOpponentTrack',
        target: 'Paris',
        waypoints: [],
        reasoning: 'Use opponent track to reach Paris',
      };
      const brain = makeMockBrain(JSON.stringify(opponentTrackResponse));

      const result = await BuildAdvisor.advise(
        makeSnapshot(),
        makeContext(),
        makeRoute(),
        testGrid,
        brain,
      );

      expect(result).not.toBeNull();
      expect(result!.action).toBe('useOpponentTrack');
      expect(result!.waypoints).toEqual([]);
    });
  });

  describe('retryWithSolvencyFeedback', () => {
    it('should call LLM with solvency feedback and return cheaper route', async () => {
      const cheaperResponse: BuildAdvisorResult = {
        action: 'build',
        target: 'Paris',
        waypoints: [[1, 1]],
        reasoning: 'Cheaper route via single waypoint',
      };
      const brain = makeMockBrain(JSON.stringify(cheaperResponse));

      const previousResult: BuildAdvisorResult = {
        action: 'build',
        target: 'Paris',
        waypoints: [[1, 1], [2, 2]],
        reasoning: 'Original route too expensive',
      };

      const result = await BuildAdvisor.retryWithSolvencyFeedback(
        previousResult,
        25, // actual cost
        15, // available cash
        makeSnapshot(),
        makeContext(),
        makeRoute(),
        testGrid,
        brain,
      );

      expect(result).not.toBeNull();
      expect(result!.waypoints).toEqual([[1, 1]]);

      // Verify solvency feedback was included in prompt
      const chatCall = (brain.providerAdapter.chat as jest.Mock).mock.calls[0][0];
      expect(chatCall.userPrompt).toContain('SOLVENCY FEEDBACK');
      expect(chatCall.userPrompt).toContain('25M');
      expect(chatCall.userPrompt).toContain('15M');
    });

    it('should pass timeoutMs: 30000 to the retry chat call', async () => {
      const cheaperResponse: BuildAdvisorResult = {
        action: 'build',
        target: 'Paris',
        waypoints: [[1, 1]],
        reasoning: 'Cheaper route',
      };
      const brain = makeMockBrain(JSON.stringify(cheaperResponse));

      await BuildAdvisor.retryWithSolvencyFeedback(
        { action: 'build', target: 'Paris', waypoints: [[1, 1]], reasoning: 'test' },
        25,
        15,
        makeSnapshot(),
        makeContext(),
        makeRoute(),
        testGrid,
        brain,
      );

      const chatCall = (brain.providerAdapter.chat as jest.Mock).mock.calls[0][0];
      expect(chatCall.timeoutMs).toBe(30000);
    });

    it('should pass thinking: { type: "adaptive" } to the retry chat call (JIRA-205)', async () => {
      const cheaperResponse: BuildAdvisorResult = {
        action: 'build',
        target: 'Paris',
        waypoints: [[1, 1]],
        reasoning: 'Cheaper route',
      };
      const brain = makeMockBrain(JSON.stringify(cheaperResponse));

      await BuildAdvisor.retryWithSolvencyFeedback(
        { action: 'build', target: 'Paris', waypoints: [[1, 1]], reasoning: 'test' },
        25,
        15,
        makeSnapshot(),
        makeContext(),
        makeRoute(),
        testGrid,
        brain,
      );

      const chatCall = (brain.providerAdapter.chat as jest.Mock).mock.calls[0][0];
      expect(chatCall.thinking).toEqual({ type: 'adaptive' });
    });

    it('should return null on retry LLM failure', async () => {
      const brain = makeFailingBrain();

      const result = await BuildAdvisor.retryWithSolvencyFeedback(
        { action: 'build', target: 'Paris', waypoints: [[1, 1]], reasoning: 'test' },
        25,
        15,
        makeSnapshot(),
        makeContext(),
        makeRoute(),
        testGrid,
        brain,
      );

      expect(result).toBeNull();
    });

    it('should attempt extraction on JSON parse failure in retry', async () => {
      const validExtracted: BuildAdvisorResult = {
        action: 'build',
        target: 'Paris',
        waypoints: [[1, 1]],
        reasoning: 'Cheaper route extracted from prose',
      };
      const mockChat = jest.fn()
        .mockResolvedValueOnce({ text: 'I recommend building a shorter route...', usage: { input: 100, output: 50 } })
        .mockResolvedValueOnce({ text: JSON.stringify(validExtracted), usage: { input: 50, output: 30 } });

      const brain = {
        providerAdapter: { chat: mockChat, setContext: jest.fn() },
        modelName: 'test-model',
      } as unknown as LLMStrategyBrain;

      const result = await BuildAdvisor.retryWithSolvencyFeedback(
        { action: 'build', target: 'Paris', waypoints: [[1, 1], [2, 2]], reasoning: 'Original' },
        25,
        15,
        makeSnapshot(),
        makeContext(),
        makeRoute(),
        testGrid,
        brain,
      );

      expect(result).not.toBeNull();
      expect(result!.waypoints).toEqual([[1, 1]]);
      expect(mockChat).toHaveBeenCalledTimes(2);
      expect(BuildAdvisor.lastDiagnostics.extractionUsed).toBe(true);
    });
  });

  describe('getNetworkFrontier', () => {
    // Access private static method via bracket notation
    const getFrontier = (BuildAdvisor as any).getNetworkFrontier.bind(BuildAdvisor);

    it('should return track endpoints when track exists', () => {
      const snapshot = makeSnapshot();
      const result = getFrontier(snapshot, testGrid);
      expect(result.length).toBeGreaterThan(0);
      expect(result).toContainEqual({ row: 0, col: 0 });
      expect(result).toContainEqual({ row: 0, col: 1 });
    });

    it('should return bot position when no track but position exists', () => {
      const snapshot = makeSnapshot();
      snapshot.bot.existingSegments = [];
      snapshot.bot.position = { row: 5, col: 5 };
      const result = getFrontier(snapshot, testGrid);
      expect(result).toEqual([{ row: 5, col: 5 }]);
    });

    it('should return nearest major city to first route stop when no track and no position', () => {
      const snapshot = makeSnapshot();
      snapshot.bot.existingSegments = [];
      snapshot.bot.position = null;

      const activeRoute: StrategicRoute = {
        stops: [
          { action: 'pickup', loadType: 'Steel', city: 'Berlin' },
          { action: 'deliver', loadType: 'Steel', city: 'Paris' },
        ],
        currentStopIndex: 0,
        phase: 'build',
        createdAtTurn: 2,
        reasoning: 'test',
      };

      const result = getFrontier(snapshot, testGrid, activeRoute);
      expect(result.length).toBe(1);
      // Berlin is at (0,0) in testGrid — nearest major city to itself
      expect(result[0]).toEqual({ row: 0, col: 0 });
    });

    it('should return empty frontier when no track, no position, and no route', () => {
      const snapshot = makeSnapshot();
      snapshot.bot.existingSegments = [];
      snapshot.bot.position = null;
      const result = getFrontier(snapshot, testGrid, null);
      expect(result).toEqual([]);
    });
  });

  describe('getTargetCoord (JIRA-145)', () => {
    // Access private static method via bracket notation
    const getTargetCoord = (BuildAdvisor as any).getTargetCoord.bind(BuildAdvisor);

    it('should skip starting city when it equals current stop', () => {
      const route: StrategicRoute = {
        stops: [
          { action: 'pickup', loadType: 'Steel', city: 'Berlin' },
          { action: 'deliver', loadType: 'Steel', city: 'Paris', payment: 15 },
        ],
        currentStopIndex: 0,
        phase: 'build',
        startingCity: 'Berlin',
        createdAtTurn: 2,
        reasoning: 'test',
      };
      const context = makeContext();
      context.citiesOnNetwork = ['Berlin'];

      const result = getTargetCoord(route, context, testGrid);
      // Should target Paris (2,2), not Berlin (0,0) — JIRA-148: now includes cityName
      expect(result).toEqual({ row: 2, col: 2, cityName: 'Paris' });
    });

    it('should skip on-network stops', () => {
      const route: StrategicRoute = {
        stops: [
          { action: 'pickup', loadType: 'Steel', city: 'Berlin' },
          { action: 'deliver', loadType: 'Steel', city: 'Paris', payment: 15 },
        ],
        currentStopIndex: 0,
        phase: 'build',
        createdAtTurn: 2,
        reasoning: 'test',
        // no startingCity — Berlin is skipped because it's on-network
      };
      const context = makeContext();
      context.citiesOnNetwork = ['Berlin'];

      const result = getTargetCoord(route, context, testGrid);
      // Berlin is on-network, so should target Paris
      expect(result).toEqual({ row: 2, col: 2, cityName: 'Paris' });
    });

    it('should fall back to current stop when all stops are reachable', () => {
      const route: StrategicRoute = {
        stops: [
          { action: 'pickup', loadType: 'Steel', city: 'Berlin' },
          { action: 'deliver', loadType: 'Steel', city: 'Paris', payment: 15 },
        ],
        currentStopIndex: 0,
        phase: 'build',
        startingCity: 'Berlin',
        createdAtTurn: 2,
        reasoning: 'test',
      };
      const context = makeContext();
      // Both cities are on-network or starting city — all skipped
      context.citiesOnNetwork = ['Berlin', 'Paris'];

      const result = getTargetCoord(route, context, testGrid);
      // Falls back to currentStopIndex (0) → Berlin at (0,0)
      expect(result).toEqual({ row: 0, col: 0, cityName: 'Berlin' });
    });

    it('should fall back to unconnected major city when no active route', () => {
      const context = makeContext();
      context.unconnectedMajorCities = [{ cityName: 'Paris', estimatedCost: 10 }];

      const result = getTargetCoord(null, context, testGrid);
      expect(result).toEqual({ row: 2, col: 2, cityName: 'Paris' });
    });
  });

  // ── JIRA-143: setContext() called before chat() ──────────────────────

  describe('setContext — caller context before chat() (JIRA-143)', () => {
    it('should call setContext with build-advisor/adviseBuild before chat in advise', async () => {
      const validResponse: BuildAdvisorResult = {
        action: 'build',
        target: 'Paris',
        waypoints: [[1, 1], [2, 2]],
        reasoning: 'Build toward Paris',
      };
      const setContextFn = jest.fn();
      const brain = makeMockBrain(JSON.stringify(validResponse), { setContextFn });

      await BuildAdvisor.advise(
        makeSnapshot(),
        makeContext(),
        makeRoute(),
        testGrid,
        brain,
      );

      expect(setContextFn).toHaveBeenCalledWith({
        gameId: 'test-game',
        playerId: 'bot-1',
        turn: 10,
        caller: 'build-advisor',
        method: 'adviseBuild',
      });
      // setContext must be called before chat
      const setContextOrder = setContextFn.mock.invocationCallOrder[0];
      const chatOrder = (brain.providerAdapter.chat as jest.Mock).mock.invocationCallOrder[0];
      expect(setContextOrder).toBeLessThan(chatOrder);
    });

    it('should call setContext with build-advisor/adviseBuildInitial in retryWithSolvencyFeedback', async () => {
      const validResponse: BuildAdvisorResult = {
        action: 'build',
        target: 'Paris',
        waypoints: [[1, 1]],
        reasoning: 'Cheaper route',
      };
      const setContextFn = jest.fn();
      const brain = makeMockBrain(JSON.stringify(validResponse), { setContextFn });

      await BuildAdvisor.retryWithSolvencyFeedback(
        { action: 'build', target: 'Paris', waypoints: [[1, 1], [2, 2]], reasoning: 'Original' },
        25,
        15,
        makeSnapshot(),
        makeContext(),
        makeRoute(),
        testGrid,
        brain,
      );

      expect(setContextFn).toHaveBeenCalledWith({
        gameId: 'test-game',
        playerId: 'bot-1',
        turn: 10,
        caller: 'build-advisor',
        method: 'adviseBuildInitial',
      });
    });

    it('should call setContext with build-advisor/adviseBuildVictory during extraction fallback', async () => {
      const validExtracted: BuildAdvisorResult = {
        action: 'build',
        target: 'Paris',
        waypoints: [[1, 1]],
        reasoning: 'Extracted',
      };
      const setContextFn = jest.fn();
      const mockChat = jest.fn()
        .mockResolvedValueOnce({ text: 'Build south-east toward Paris...', usage: { input: 100, output: 50 } })
        .mockResolvedValueOnce({ text: JSON.stringify(validExtracted), usage: { input: 50, output: 30 } });

      const brain = {
        providerAdapter: { chat: mockChat, setContext: setContextFn },
        modelName: 'test-model',
      } as unknown as LLMStrategyBrain;

      await BuildAdvisor.advise(
        makeSnapshot(),
        makeContext(),
        makeRoute(),
        testGrid,
        brain,
      );

      // First call: adviseBuild, second call (extraction): adviseBuildVictory
      expect(setContextFn).toHaveBeenCalledTimes(2);
      expect(setContextFn).toHaveBeenNthCalledWith(1, expect.objectContaining({
        caller: 'build-advisor',
        method: 'adviseBuild',
      }));
      expect(setContextFn).toHaveBeenNthCalledWith(2, expect.objectContaining({
        caller: 'build-advisor',
        method: 'adviseBuildVictory',
      }));
    });
  });
});
