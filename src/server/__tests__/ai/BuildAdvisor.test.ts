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
function makeMockBrain(responseText: string): LLMStrategyBrain {
  const mockChat = jest.fn().mockResolvedValue({
    text: responseText,
    usage: { input: 100, output: 50 },
  });

  return {
    providerAdapter: { chat: mockChat },
    modelName: 'test-model',
  } as unknown as LLMStrategyBrain;
}

/** Mock brain that throws an error */
function makeFailingBrain(): LLMStrategyBrain {
  const mockChat = jest.fn().mockRejectedValue(new Error('LLM timeout'));

  return {
    providerAdapter: { chat: mockChat },
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
  });
});
