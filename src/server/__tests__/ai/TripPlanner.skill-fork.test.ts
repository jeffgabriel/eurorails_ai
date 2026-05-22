/**
 * TripPlanner.skill-fork.test.ts
 *
 * Integration tests for the JIRA-220 skill-fork in TripPlanner.planTrip:
 * - Medium skill → deterministic path (no LLM call)
 * - Easy/Hard skill → LLM path (byte-stable behavior preserved)
 * - Pre-LLM short-circuits run before the deterministic algorithm
 * - heuristic-fallback when deterministic returns no_feasible_candidates
 */

// ── Mocks ──────────────────────────────────────────────────────────────

// Mock DeterministicTripPlanner to control deterministic path per test
jest.mock('../../services/ai/DeterministicTripPlanner', () => ({
  planTripDeterministic: jest.fn(),
  PRUNE_MAX_TURNS: 12,
  PRUNE_MAX_BUILD_M: 130,
  HOP_AVG_COST_M: 1.3,
}));

jest.mock('../../services/ai/RouteValidator', () => ({
  RouteValidator: {
    validate: jest.fn(() => ({ valid: true, errors: [] })),
  },
}));

jest.mock('../../services/ai/RouteOptimizer', () => ({
  RouteOptimizer: {
    orderStopsByProximity: jest.fn((stops: unknown[]) => stops),
  },
}));

jest.mock('../../services/ai/schemas', () => ({
  TRIP_PLAN_SCHEMA: { type: 'object' },
  TRIP_PLAN_SCHEMA_MEDIUM: { type: 'object' },
}));

jest.mock('../../services/ai/prompts/systemPrompts', () => ({
  getTripPlanningPrompt: jest.fn(() => ({
    system: 'mock-system',
    user: 'mock-user',
  })),
}));

jest.mock('../../services/MapTopology', () => ({
  ...jest.requireActual<typeof import('../../services/MapTopology')>('../../services/MapTopology'),
  estimateHopDistance: jest.fn(() => 0),
  loadGridPoints: jest.fn(() => new Map()),
}));

jest.mock('../../../shared/services/computeTrackUsageFees', () => ({
  computeTrackUsageFees: jest.fn(() => 0),
}));

jest.mock('../../services/ai/StrategicContextBuilder', () => ({
  build: jest.fn(() => ({})),
}));

jest.mock('../../services/ai/RouteDetourEstimator', () => ({
  simulateTrip: jest.fn(() => ({ feasible: true, turnsToComplete: 2, totalBuildCost: 5 })),
}));

jest.mock('../../services/ai/RouteEnrichmentAdvisor', () => ({
  RouteEnrichmentAdvisor: {
    enrich: jest.fn(async (route: unknown) => route),
  },
}));

// ── Imports ────────────────────────────────────────────────────────────

import { TripPlanner } from '../../services/ai/TripPlanner';
import { planTripDeterministic } from '../../services/ai/DeterministicTripPlanner';
import {
  BotSkillLevel,
  BotMemoryState,
  GameContext,
  GridPoint,
  WorldSnapshot,
  DemandContext,
  ProviderResponse,
  StrategicRoute,
  LLMProvider,
  LLMStrategyConfig,
  TrainType,
  GameState,
} from '../../../shared/types/GameTypes';

const mockPlanTripDeterministic = planTripDeterministic as jest.MockedFunction<typeof planTripDeterministic>;

// ── Fixtures ────────────────────────────────────────────────────────────

function makeDemand(overrides: Partial<DemandContext> = {}): DemandContext {
  return {
    cardIndex: 1,
    loadType: 'Coal',
    supplyCity: 'Essen',
    deliveryCity: 'Berlin',
    payout: 15,
    isSupplyReachable: true,
    isDeliveryReachable: true,
    isSupplyOnNetwork: true,
    isDeliveryOnNetwork: true,
    estimatedTrackCostToSupply: 5,
    estimatedTrackCostToDelivery: 5,
    isLoadAvailable: true,
    isLoadOnTrain: false,
    ferryRequired: false,
    loadChipTotal: 4,
    loadChipCarried: 0,
    estimatedTurns: 3,
    demandScore: 10,
    efficiencyPerTurn: 3,
    networkCitiesUnlocked: 0,
    victoryMajorCitiesEnRoute: 0,
    isAffordable: true,
    projectedFundsAfterDelivery: 100,
    ...overrides,
  };
}

function makeMemory(overrides: Partial<BotMemoryState> = {}): BotMemoryState {
  return {
    currentBuildTarget: null,
    turnsOnTarget: 0,
    lastAction: null,
    consecutiveDiscards: 0,
    deliveryCount: 0,
    totalEarnings: 0,
    turnNumber: 1,
    activeRoute: null,
    turnsOnRoute: 0,
    routeHistory: [],
    lastAbandonedRouteKey: null,
    lastReasoning: null,
    lastPlanHorizon: null,
    previousRouteStops: null,
    consecutiveLlmFailures: 0,
    ...overrides,
  };
}

function makeSnapshot(overrides: Partial<WorldSnapshot['bot']> = {}): WorldSnapshot {
  return {
    gameId: 'test-game',
    gameStatus: 'active',
    turnNumber: 5,
    bot: {
      playerId: 'bot-1',
      userId: 'user-1',
      money: 100,
      position: { row: 5, col: 5 },
      existingSegments: [],
      demandCards: [],
      resolvedDemands: [],
      trainType: TrainType.Freight,
      loads: [],
      botConfig: { skillLevel: 'medium' },
      connectedMajorCityCount: 0,
     pendingFloodRebuilds: [],
      ...overrides,
    },
    allPlayerTracks: [],
    loadAvailability: {},
    activeEffects: [],
  };
}

function makeContext(demands: DemandContext[] = [makeDemand(), makeDemand({ cardIndex: 2, loadType: 'Wine' })], overrides: Partial<GameContext> = {}): GameContext {
  return {
    position: { row: 5, col: 5 },
    money: 100,
    trainType: TrainType.Freight,
    speed: 9,
    capacity: 2,
    loads: [],
    connectedMajorCities: [],
    unconnectedMajorCities: [],
    totalMajorCities: 7,
    trackSummary: '',
    turnBuildCost: 0,
    demands,
    canDeliver: [],
    canPickup: [],
    reachableCities: [],
    citiesOnNetwork: [],
    canUpgrade: false,
    canBuild: true,
    isInitialBuild: false,
    opponents: [],
    phase: 'active',
    turnNumber: 5,
    gameState: GameState.Mid,
    ...overrides,
  };
}

function makeConfig(skillLevel: BotSkillLevel): LLMStrategyConfig {
  return {
    skillLevel,
    provider: LLMProvider.Anthropic,
    model: 'claude-sonnet-4-6',
    apiKey: 'test-key',
    timeoutMs: 15000,
    maxRetries: 1,
  };
}

function makeMockBrain(skillLevel: BotSkillLevel, overrides: {
  chatFn?: jest.Mock;
  planRouteFn?: jest.Mock;
} = {}) {
  const chatFn = overrides.chatFn ?? jest.fn<Promise<ProviderResponse>, [unknown]>();
  const planRouteFn = overrides.planRouteFn ?? jest.fn().mockResolvedValue({ route: null, llmLog: [] });
  const setContextFn = jest.fn();

  const brain = {
    providerAdapter: { chat: chatFn, setContext: setContextFn },
    modelName: 'claude-sonnet-4-6',
    strategyConfig: makeConfig(skillLevel),
    planRoute: planRouteFn,
  };

  return { brain: brain as any, chatFn, planRouteFn, setContextFn };
}

function makeDetResult(overrides: Partial<ReturnType<typeof planTripDeterministic>> = {}): ReturnType<typeof planTripDeterministic> {
  const route: StrategicRoute = {
    stops: [
      { action: 'pickup', loadType: 'Coal', city: 'Essen' },
      { action: 'deliver', loadType: 'Coal', city: 'Berlin', demandCardId: 1, payment: 15 },
    ],
    currentStopIndex: 0,
    phase: 'build',
    createdAtTurn: 5,
    reasoning: '[deterministic-top-1] single:1:Coal chosen.\n  Picked: single-fresh\n  Survivors after spatial prune: 1 of 1 raw.',
  };
  return {
    route,
    reasoning: route.reasoning,
    outcome: 'success',
    synthesizedAttempt: {
      attemptNumber: 0,
      status: 'success',
      responseText: 'deterministic top-1: single:1:Coal score=5.0',
      latencyMs: 42,
    },
    ...overrides,
  };
}

function makeLlmResponse(stops: Array<{
  action: string;
  load: string;
  supplyCity?: string;
  deliveryCity?: string;
  demandCardId?: number;
  payment?: number;
}>, reasoning = 'Test reasoning'): string {
  return JSON.stringify({ stops, reasoning });
}

// ── Setup ──────────────────────────────────────────────────────────────

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});

  // Default: deterministic returns success
  mockPlanTripDeterministic.mockReturnValue(makeDetResult());
});

afterEach(() => {
  jest.restoreAllMocks();
});

// ── Tests ──────────────────────────────────────────────────────────────

describe('TripPlanner skill-fork (JIRA-220)', () => {

  // ── Medium skill: deterministic path ──────────────────────────────────

  describe('Medium skill: deterministic path', () => {
    it('does NOT call adapter.chat for Medium skill with feasible hand', async () => {
      const { brain, chatFn } = makeMockBrain(BotSkillLevel.Medium);
      mockPlanTripDeterministic.mockReturnValue(makeDetResult());

      const planner = new TripPlanner(brain);
      const result = await planner.planTrip(makeSnapshot(), makeContext(), [], makeMemory());

      expect(chatFn).toHaveBeenCalledTimes(0);
      expect(result.route).not.toBeNull();
    });

    it('returns decisionSource: trip-planner-deterministic for Medium success', async () => {
      const { brain } = makeMockBrain(BotSkillLevel.Medium);
      mockPlanTripDeterministic.mockReturnValue(makeDetResult());

      const planner = new TripPlanner(brain);
      const result = await planner.planTrip(makeSnapshot(), makeContext(), [], makeMemory());

      expect(result.decisionSource).toBe('trip-planner-deterministic');
    });

    it('llmLog.length === 1 and llmLog[0].responseText contains deterministic for Medium success', async () => {
      const { brain } = makeMockBrain(BotSkillLevel.Medium);
      mockPlanTripDeterministic.mockReturnValue(makeDetResult());

      const planner = new TripPlanner(brain);
      const result = await planner.planTrip(makeSnapshot(), makeContext(), [], makeMemory());

      expect(result.llmLog).toHaveLength(1);
      expect(result.llmLog[0].responseText).toContain('deterministic');
    });

    it('route.stops is non-empty for Medium success', async () => {
      const { brain } = makeMockBrain(BotSkillLevel.Medium);
      mockPlanTripDeterministic.mockReturnValue(makeDetResult());

      const planner = new TripPlanner(brain);
      const result = await planner.planTrip(makeSnapshot(), makeContext(), [], makeMemory());

      expect(result.route!.stops.length).toBeGreaterThan(0);
    });

    it('planTripDeterministic called once per planTrip call for Medium', async () => {
      const { brain } = makeMockBrain(BotSkillLevel.Medium);
      mockPlanTripDeterministic.mockReturnValue(makeDetResult());

      const planner = new TripPlanner(brain);
      await planner.planTrip(makeSnapshot(), makeContext(), [], makeMemory());

      expect(mockPlanTripDeterministic).toHaveBeenCalledTimes(1);
    });

    it('falls through to heuristic-fallback when deterministic returns no_feasible_candidates', async () => {
      const mockRoute: StrategicRoute = {
        stops: [{ action: 'pickup', loadType: 'Coal', city: 'Essen' }],
        currentStopIndex: 0,
        phase: 'build',
        createdAtTurn: 5,
        reasoning: 'heuristic',
      };
      const { brain, planRouteFn } = makeMockBrain(BotSkillLevel.Medium);
      planRouteFn.mockResolvedValue({ route: mockRoute, latencyMs: 10, tokenUsage: { input: 0, output: 0 }, llmLog: [] });
      mockPlanTripDeterministic.mockReturnValue(makeDetResult({
        outcome: 'no_feasible_candidates',
        route: null,
        reasoning: '[deterministic-top-1] No demand cards in hand.',
      }));

      const planner = new TripPlanner(brain);
      const result = await planner.planTrip(makeSnapshot(), makeContext(), [], makeMemory());

      expect(planRouteFn).toHaveBeenCalledTimes(1);
      expect(result.decisionSource).toBe('heuristic-fallback');
    });
  });

  // ── Pre-LLM short-circuits before deterministic ──────────────────────

  describe('Pre-LLM short-circuits run before deterministic (Medium)', () => {
    it('empty demands → no_actionable_options fires; planTripDeterministic NOT invoked', async () => {
      const { brain } = makeMockBrain(BotSkillLevel.Medium);

      const planner = new TripPlanner(brain);
      const result = await planner.planTrip(makeSnapshot(), makeContext([]), [], makeMemory());

      expect(mockPlanTripDeterministic).not.toHaveBeenCalled();
      expect(result.selection?.fallbackReason).toBe('no_actionable_options');
    });

    it('all demands unaffordable → no_actionable_options fires; planTripDeterministic NOT invoked', async () => {
      const { brain } = makeMockBrain(BotSkillLevel.Medium);
      const unaffordableDemand = makeDemand({ isAffordable: false });

      const planner = new TripPlanner(brain);
      const result = await planner.planTrip(
        makeSnapshot(),
        makeContext([unaffordableDemand, makeDemand({ cardIndex: 2, loadType: 'Wine', isAffordable: false })]),
        [],
        makeMemory(),
      );

      expect(mockPlanTripDeterministic).not.toHaveBeenCalled();
      expect(result.selection?.fallbackReason).toBe('no_actionable_options');
    });

    it('single actionable demand → single_option_shortcircuit fires; planTripDeterministic NOT invoked', async () => {
      const { brain } = makeMockBrain(BotSkillLevel.Medium);
      const singleDemand = makeDemand({ cardIndex: 1, loadType: 'Coal', isAffordable: true });

      const { RouteValidator } = await import('../../services/ai/RouteValidator');
      (RouteValidator.validate as jest.Mock).mockReturnValue({
        valid: true,
        errors: [],
        prunedRoute: {
          stops: [
            { action: 'pickup', loadType: 'Coal', city: 'Essen' },
            { action: 'deliver', loadType: 'Coal', city: 'Berlin', demandCardId: 1, payment: 15 },
          ],
          currentStopIndex: 0,
          phase: 'build',
          createdAtTurn: 5,
          reasoning: '',
        },
      });

      const planner = new TripPlanner(brain);
      const result = await planner.planTrip(makeSnapshot(), makeContext([singleDemand]), [], makeMemory());

      expect(mockPlanTripDeterministic).not.toHaveBeenCalled();
      expect(result.selection?.fallbackReason).toBe('single_option_shortcircuit');
    });
  });

  // ── Easy skill: LLM path preserved ────────────────────────────────────

  describe('Easy skill: LLM path preserved', () => {
    it('calls adapter.chat exactly once for Easy skill with valid response', async () => {
      const llmResponse = makeLlmResponse([
        { action: 'PICKUP', load: 'Coal', supplyCity: 'Essen' },
        { action: 'DELIVER', load: 'Coal', deliveryCity: 'Berlin', demandCardId: 1, payment: 15 },
      ]);
      const { brain, chatFn } = makeMockBrain(BotSkillLevel.Easy);
      chatFn.mockResolvedValue({ text: llmResponse, usage: { input: 100, output: 50 } });

      const planner = new TripPlanner(brain);
      const result = await planner.planTrip(makeSnapshot(), makeContext(), [], makeMemory());

      expect(chatFn).toHaveBeenCalledTimes(1);
      expect(mockPlanTripDeterministic).not.toHaveBeenCalled();
      expect(result.route).not.toBeNull();
    });

    it('Easy skill: decisionSource is trip-planner', async () => {
      const llmResponse = makeLlmResponse([
        { action: 'PICKUP', load: 'Coal', supplyCity: 'Essen' },
        { action: 'DELIVER', load: 'Coal', deliveryCity: 'Berlin', demandCardId: 1, payment: 15 },
      ]);
      const { brain, chatFn } = makeMockBrain(BotSkillLevel.Easy);
      chatFn.mockResolvedValue({ text: llmResponse, usage: { input: 100, output: 50 } });

      const planner = new TripPlanner(brain);
      const result = await planner.planTrip(makeSnapshot(), makeContext(), [], makeMemory());

      expect(result.decisionSource).toBe('trip-planner');
    });
  });

  // ── Hard skill: LLM path preserved ────────────────────────────────────

  describe('Hard skill: LLM path preserved', () => {
    it('calls adapter.chat with thinking: adaptive for Hard skill', async () => {
      const llmResponse = makeLlmResponse([
        { action: 'PICKUP', load: 'Coal', supplyCity: 'Essen' },
        { action: 'DELIVER', load: 'Coal', deliveryCity: 'Berlin', demandCardId: 1, payment: 15 },
      ]);
      const { brain, chatFn } = makeMockBrain(BotSkillLevel.Hard);
      chatFn.mockResolvedValue({ text: llmResponse, usage: { input: 200, output: 100 } });

      const planner = new TripPlanner(brain);
      const result = await planner.planTrip(makeSnapshot(), makeContext(), [], makeMemory());

      expect(chatFn).toHaveBeenCalledTimes(1);
      expect(mockPlanTripDeterministic).not.toHaveBeenCalled();
      expect(result.route).not.toBeNull();

      // Hard should pass thinking: adaptive
      const chatCall = chatFn.mock.calls[0][0];
      expect(chatCall.thinking).toEqual({ type: 'adaptive' });
    });

    it('Hard skill: decisionSource is trip-planner', async () => {
      const llmResponse = makeLlmResponse([
        { action: 'PICKUP', load: 'Coal', supplyCity: 'Essen' },
        { action: 'DELIVER', load: 'Coal', deliveryCity: 'Berlin', demandCardId: 1, payment: 15 },
      ]);
      const { brain, chatFn } = makeMockBrain(BotSkillLevel.Hard);
      chatFn.mockResolvedValue({ text: llmResponse, usage: { input: 200, output: 100 } });

      const planner = new TripPlanner(brain);
      const result = await planner.planTrip(makeSnapshot(), makeContext(), [], makeMemory());

      expect(result.decisionSource).toBe('trip-planner');
    });
  });

  // ── Regression: existing Easy/Hard tests pass ─────────────────────────

  describe('Regression: Easy and Hard behavior unchanged', () => {
    it('Easy: route has stops when LLM returns valid response', async () => {
      const llmResponse = makeLlmResponse([
        { action: 'PICKUP', load: 'Wine', supplyCity: 'Lyon' },
        { action: 'DELIVER', load: 'Wine', deliveryCity: 'Paris', demandCardId: 2, payment: 20 },
      ]);
      const { brain, chatFn } = makeMockBrain(BotSkillLevel.Easy);
      chatFn.mockResolvedValue({ text: llmResponse, usage: { input: 100, output: 50 } });
      const demands = [makeDemand({ cardIndex: 2, loadType: 'Wine', supplyCity: 'Lyon', deliveryCity: 'Paris', payout: 20 })];

      const planner = new TripPlanner(brain);
      const result = await planner.planTrip(makeSnapshot(), makeContext(demands), [], makeMemory());

      expect(result.route).not.toBeNull();
      expect(result.route!.stops.length).toBeGreaterThan(0);
    });

    it('Hard: route has stops when LLM returns valid response', async () => {
      const llmResponse = makeLlmResponse([
        { action: 'PICKUP', load: 'Steel', supplyCity: 'Essen' },
        { action: 'DELIVER', load: 'Steel', deliveryCity: 'Hamburg', demandCardId: 3, payment: 25 },
      ]);
      const { brain, chatFn } = makeMockBrain(BotSkillLevel.Hard);
      chatFn.mockResolvedValue({ text: llmResponse, usage: { input: 200, output: 100 } });
      const demands = [makeDemand({ cardIndex: 3, loadType: 'Steel', supplyCity: 'Essen', deliveryCity: 'Hamburg', payout: 25 })];

      const planner = new TripPlanner(brain);
      const result = await planner.planTrip(makeSnapshot(), makeContext(demands), [], makeMemory());

      expect(result.route).not.toBeNull();
      expect(result.route!.stops.length).toBeGreaterThan(0);
    });
  });
});
