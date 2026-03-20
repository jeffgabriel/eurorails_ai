/**
 * TripPlanner.test.ts — Tests for TripPlanner.planTrip()
 *
 * Tests candidate parsing, scoring, route conversion, validation filtering,
 * LLM failure fallback, and total failure paths.
 */

import { TripPlanner, TripPlanResult } from '../../services/ai/TripPlanner';
import { RouteValidator } from '../../services/ai/RouteValidator';
import {
  BotSkillLevel,
  BotMemoryState,
  GameContext,
  WorldSnapshot,
  LLMProvider,
  LLMStrategyConfig,
  DemandContext,
  ProviderResponse,
  StrategicRoute,
  LlmAttempt,
} from '../../../shared/types/GameTypes';

// ── Mock modules ────────────────────────────────────────────────────────

jest.mock('../../services/ai/RouteValidator');
jest.mock('../../services/ai/schemas', () => ({
  TRIP_PLAN_SCHEMA: { type: 'object' },
}));
jest.mock('../../services/ai/prompts/systemPrompts', () => ({
  getTripPlanningPrompt: jest.fn(() => 'system-prompt'),
}));

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
    estimatedTrackCostToSupply: 0,
    estimatedTrackCostToDelivery: 0,
    isLoadAvailable: true,
    isLoadOnTrain: false,
    ferryRequired: false,
    loadChipTotal: 4,
    loadChipCarried: 0,
    estimatedTurns: 3,
    demandScore: 0,
    efficiencyPerTurn: 0,
    networkCitiesUnlocked: 0,
    victoryMajorCitiesEnRoute: 0,
    isAffordable: true,
    projectedFundsAfterDelivery: 50,
    ...overrides,
  };
}

function makeContext(overrides: Partial<GameContext> = {}): GameContext {
  return {
    position: { city: 'Essen', row: 10, col: 5 },
    money: 50,
    trainType: 'Freight',
    speed: 9,
    capacity: 2,
    loads: [],
    connectedMajorCities: ['Berlin'],
    unconnectedMajorCities: [],
    totalMajorCities: 15,
    trackSummary: 'Essen-Berlin corridor',
    turnBuildCost: 0,
    turnNumber: 5,
    demands: [makeDemand()],
    canDeliver: [],
    canPickup: [],
    ...overrides,
  } as GameContext;
}

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
  } as WorldSnapshot;
}

function makeMemory(overrides: Partial<BotMemoryState> = {}): BotMemoryState {
  return {
    lastAbandonedRouteKey: null,
    previousRouteStops: null,
    consecutiveLlmFailures: 0,
    ...overrides,
  } as BotMemoryState;
}

function makeConfig(): LLMStrategyConfig {
  return {
    skillLevel: BotSkillLevel.Medium,
    provider: LLMProvider.Anthropic,
    model: 'claude-sonnet-4-6',
    apiKey: 'test-key',
    timeoutMs: 15000,
    maxRetries: 1,
  };
}

/** Build an LLM response JSON string with the given candidates */
function buildLlmResponse(candidates: Array<{
  stops: Array<{ action: string; load: string; city: string; demandCardId?: number; payment?: number }>;
  reasoning: string;
}>, chosenIndex = 0, upgradeOnRoute?: string): string {
  return JSON.stringify({
    candidates,
    chosenIndex,
    reasoning: 'Chose the best trip',
    ...(upgradeOnRoute && { upgradeOnRoute }),
  });
}

// ── Mock brain factory ──────────────────────────────────────────────────

function makeMockBrain(overrides: {
  chatFn?: jest.Mock;
  planRouteFn?: jest.Mock;
} = {}) {
  const chatFn = overrides.chatFn ?? jest.fn<Promise<ProviderResponse>, [any]>();
  const planRouteFn = overrides.planRouteFn ?? jest.fn();

  const brain = {
    providerAdapter: { chat: chatFn },
    modelName: 'claude-sonnet-4-6',
    strategyConfig: makeConfig(),
    planRoute: planRouteFn,
  };

  return { brain: brain as any, chatFn, planRouteFn };
}

// ── Tests ───────────────────────────────────────────────────────────────

describe('TripPlanner', () => {
  const mockedRouteValidator = RouteValidator as jest.Mocked<typeof RouteValidator>;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});

    // Default: RouteValidator.validate returns valid for all candidates
    (RouteValidator.validate as jest.Mock).mockReturnValue({
      valid: true,
      errors: [],
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  // ── 1. Candidate parsing ──────────────────────────────────────────────

  describe('candidate parsing', () => {
    it('should parse 1 candidate from LLM response', async () => {
      const response = buildLlmResponse([
        {
          stops: [
            { action: 'pickup', load: 'Coal', city: 'Essen' },
            { action: 'deliver', load: 'Coal', city: 'Berlin', demandCardId: 1, payment: 15 },
          ],
          reasoning: 'Direct delivery',
        },
      ]);

      const { brain, chatFn } = makeMockBrain();
      chatFn.mockResolvedValue({ text: response, usage: { input: 100, output: 50 } });

      const planner = new TripPlanner(brain);
      const result = await planner.planTrip(makeSnapshot(), makeContext(), [], makeMemory());

      expect(result).not.toBeNull();
      expect(result!.candidates).toHaveLength(1);
      expect(result!.candidates[0].stops).toHaveLength(2);
      expect(result!.candidates[0].stops[0].action).toBe('pickup');
      expect(result!.candidates[0].stops[1].action).toBe('deliver');
    });

    it('should parse 2 candidates from LLM response', async () => {
      const response = buildLlmResponse([
        {
          stops: [
            { action: 'pickup', load: 'Coal', city: 'Essen' },
            { action: 'deliver', load: 'Coal', city: 'Berlin', demandCardId: 1, payment: 15 },
          ],
          reasoning: 'Coal route',
        },
        {
          stops: [
            { action: 'pickup', load: 'Wine', city: 'Bordeaux' },
            { action: 'deliver', load: 'Wine', city: 'Paris', demandCardId: 2, payment: 12 },
          ],
          reasoning: 'Wine route',
        },
      ]);

      const context = makeContext({
        demands: [
          makeDemand(),
          makeDemand({ cardIndex: 2, loadType: 'Wine', supplyCity: 'Bordeaux', deliveryCity: 'Paris', payout: 12 }),
        ],
      });

      const { brain, chatFn } = makeMockBrain();
      chatFn.mockResolvedValue({ text: response, usage: { input: 200, output: 100 } });

      const planner = new TripPlanner(brain);
      const result = await planner.planTrip(makeSnapshot(), context, [], makeMemory());

      expect(result).not.toBeNull();
      expect(result!.candidates).toHaveLength(2);
    });

    it('should parse 3 candidates from LLM response', async () => {
      const response = buildLlmResponse([
        {
          stops: [
            { action: 'pickup', load: 'Coal', city: 'Essen' },
            { action: 'deliver', load: 'Coal', city: 'Berlin', demandCardId: 1, payment: 15 },
          ],
          reasoning: 'Coal route',
        },
        {
          stops: [
            { action: 'pickup', load: 'Wine', city: 'Bordeaux' },
            { action: 'deliver', load: 'Wine', city: 'Paris', demandCardId: 2, payment: 12 },
          ],
          reasoning: 'Wine route',
        },
        {
          stops: [
            { action: 'pickup', load: 'Steel', city: 'Hamburg' },
            { action: 'deliver', load: 'Steel', city: 'München', demandCardId: 3, payment: 20 },
          ],
          reasoning: 'Steel route',
        },
      ]);

      const context = makeContext({
        demands: [
          makeDemand(),
          makeDemand({ cardIndex: 2, loadType: 'Wine', supplyCity: 'Bordeaux', deliveryCity: 'Paris', payout: 12, estimatedTurns: 2 }),
          makeDemand({ cardIndex: 3, loadType: 'Steel', supplyCity: 'Hamburg', deliveryCity: 'München', payout: 20, estimatedTurns: 4 }),
        ],
      });

      const { brain, chatFn } = makeMockBrain();
      chatFn.mockResolvedValue({ text: response, usage: { input: 300, output: 150 } });

      const planner = new TripPlanner(brain);
      const result = await planner.planTrip(makeSnapshot(), context, [], makeMemory());

      expect(result).not.toBeNull();
      expect(result!.candidates).toHaveLength(3);
    });

    it('should record LLM latency and token usage', async () => {
      const response = buildLlmResponse([
        {
          stops: [
            { action: 'pickup', load: 'Coal', city: 'Essen' },
            { action: 'deliver', load: 'Coal', city: 'Berlin', demandCardId: 1, payment: 15 },
          ],
          reasoning: 'Direct delivery',
        },
      ]);

      const { brain, chatFn } = makeMockBrain();
      chatFn.mockResolvedValue({ text: response, usage: { input: 100, output: 50 } });

      const planner = new TripPlanner(brain);
      const result = await planner.planTrip(makeSnapshot(), makeContext(), [], makeMemory());

      expect(result).not.toBeNull();
      expect(result!.llmTokens).toEqual({ input: 100, output: 50 });
      expect(result!.llmLatencyMs).toBeGreaterThanOrEqual(0);
      expect(result!.llmLog).toHaveLength(1);
      expect(result!.llmLog[0].status).toBe('success');
    });
  });

  // ── 2. Scoring ────────────────────────────────────────────────────────

  describe('scoring', () => {
    it('should choose candidate with higher netValue/turn over higher absolute payout', async () => {
      // Candidate A: 15M payout, 3 turns → score 5 M/turn
      // Candidate B: 20M payout, 5 turns → score 4 M/turn
      // A should win despite lower absolute payout
      const response = buildLlmResponse([
        {
          stops: [
            { action: 'pickup', load: 'Coal', city: 'Essen' },
            { action: 'deliver', load: 'Coal', city: 'Berlin', demandCardId: 1, payment: 15 },
          ],
          reasoning: 'Quick coal delivery',
        },
        {
          stops: [
            { action: 'pickup', load: 'Steel', city: 'Hamburg' },
            { action: 'deliver', load: 'Steel', city: 'München', demandCardId: 3, payment: 20 },
          ],
          reasoning: 'Longer steel haul',
        },
      ]);

      const context = makeContext({
        demands: [
          makeDemand({ cardIndex: 1, loadType: 'Coal', supplyCity: 'Essen', deliveryCity: 'Berlin', payout: 15, estimatedTurns: 3, estimatedTrackCostToSupply: 0, estimatedTrackCostToDelivery: 0 }),
          makeDemand({ cardIndex: 3, loadType: 'Steel', supplyCity: 'Hamburg', deliveryCity: 'München', payout: 20, estimatedTurns: 5, estimatedTrackCostToSupply: 0, estimatedTrackCostToDelivery: 0 }),
        ],
      });

      const { brain, chatFn } = makeMockBrain();
      chatFn.mockResolvedValue({ text: response, usage: { input: 200, output: 100 } });

      const planner = new TripPlanner(brain);
      const result = await planner.planTrip(makeSnapshot(), context, [], makeMemory());

      expect(result).not.toBeNull();
      expect(result!.candidates).toHaveLength(2);
      // Coal (score=5) should be chosen over Steel (score=4)
      expect(result!.chosen).toBe(0);
      expect(result!.candidates[0].score).toBeGreaterThan(result!.candidates[1].score);
      expect(result!.route.stops[0].loadType).toBe('Coal');
    });

    it('should subtract build costs from netValue when scoring', async () => {
      // Coal: payout 15, build cost 5, turns 3 → netValue 10, score ≈ 3.3
      // Wine: payout 12, build cost 0, turns 3 → netValue 12, score = 4
      // Wine should win due to lower build cost
      const response = buildLlmResponse([
        {
          stops: [
            { action: 'pickup', load: 'Coal', city: 'Essen' },
            { action: 'deliver', load: 'Coal', city: 'Berlin', demandCardId: 1, payment: 15 },
          ],
          reasoning: 'Coal with build cost',
        },
        {
          stops: [
            { action: 'pickup', load: 'Wine', city: 'Bordeaux' },
            { action: 'deliver', load: 'Wine', city: 'Paris', demandCardId: 2, payment: 12 },
          ],
          reasoning: 'Wine no build cost',
        },
      ]);

      const context = makeContext({
        demands: [
          makeDemand({ cardIndex: 1, loadType: 'Coal', supplyCity: 'Essen', deliveryCity: 'Berlin', payout: 15, estimatedTurns: 3, estimatedTrackCostToDelivery: 5 }),
          makeDemand({ cardIndex: 2, loadType: 'Wine', supplyCity: 'Bordeaux', deliveryCity: 'Paris', payout: 12, estimatedTurns: 3, estimatedTrackCostToDelivery: 0 }),
        ],
      });

      const { brain, chatFn } = makeMockBrain();
      chatFn.mockResolvedValue({ text: response, usage: { input: 200, output: 100 } });

      const planner = new TripPlanner(brain);
      const result = await planner.planTrip(makeSnapshot(), context, [], makeMemory());

      expect(result).not.toBeNull();
      // Candidates are sorted by score desc: Wine (score=4) first, Coal (score≈3.3) second
      // chosen = 0 because best is first after sorting
      expect(result!.chosen).toBe(0);
      expect(result!.candidates[0].netValue).toBe(12); // Wine sorted first (higher score)
      expect(result!.candidates[1].netValue).toBe(10); // Coal sorted second
    });

    it('should prevent division by zero on estimatedTurns=0', async () => {
      const response = buildLlmResponse([
        {
          stops: [
            { action: 'pickup', load: 'Coal', city: 'Essen' },
            { action: 'deliver', load: 'Coal', city: 'Berlin', demandCardId: 1, payment: 15 },
          ],
          reasoning: 'Instant delivery',
        },
      ]);

      // estimatedTurns: 0 should be clamped to 1
      const context = makeContext({
        demands: [makeDemand({ estimatedTurns: 0 })],
      });

      const { brain, chatFn } = makeMockBrain();
      chatFn.mockResolvedValue({ text: response, usage: { input: 100, output: 50 } });

      const planner = new TripPlanner(brain);
      const result = await planner.planTrip(makeSnapshot(), context, [], makeMemory());

      expect(result).not.toBeNull();
      expect(result!.candidates[0].estimatedTurns).toBe(1);
      expect(isFinite(result!.candidates[0].score)).toBe(true);
    });
  });

  // ── 3. Route conversion ───────────────────────────────────────────────

  describe('route conversion', () => {
    it('should convert chosen candidate into a valid StrategicRoute', async () => {
      const response = buildLlmResponse([
        {
          stops: [
            { action: 'pickup', load: 'Coal', city: 'Essen' },
            { action: 'deliver', load: 'Coal', city: 'Berlin', demandCardId: 1, payment: 15 },
          ],
          reasoning: 'Direct coal delivery',
        },
      ]);

      const { brain, chatFn } = makeMockBrain();
      chatFn.mockResolvedValue({ text: response, usage: { input: 100, output: 50 } });

      const planner = new TripPlanner(brain);
      const result = await planner.planTrip(makeSnapshot(), makeContext(), [], makeMemory());

      expect(result).not.toBeNull();
      const route = result!.route;
      expect(route.stops).toHaveLength(2);
      expect(route.currentStopIndex).toBe(0);
      expect(route.phase).toBe('build');
      expect(route.createdAtTurn).toBe(5);
      expect(route.reasoning).toBe('Direct coal delivery');
    });

    it('should normalize action strings to lowercase', async () => {
      const response = buildLlmResponse([
        {
          stops: [
            { action: 'PICKUP', load: 'Coal', city: 'Essen' },
            { action: 'DELIVER', load: 'Coal', city: 'Berlin', demandCardId: 1, payment: 15 },
          ],
          reasoning: 'Uppercase actions',
        },
      ]);

      const { brain, chatFn } = makeMockBrain();
      chatFn.mockResolvedValue({ text: response, usage: { input: 100, output: 50 } });

      const planner = new TripPlanner(brain);
      const result = await planner.planTrip(makeSnapshot(), makeContext(), [], makeMemory());

      expect(result).not.toBeNull();
      expect(result!.route.stops[0].action).toBe('pickup');
      expect(result!.route.stops[1].action).toBe('deliver');
    });

    it('should use pruned route stops when RouteValidator returns prunedRoute', async () => {
      const prunedStops = [
        { action: 'pickup' as const, loadType: 'Coal', city: 'Essen' },
        { action: 'deliver' as const, loadType: 'Coal', city: 'Berlin', demandCardId: 1, payment: 15 },
      ];

      (RouteValidator.validate as jest.Mock).mockReturnValue({
        valid: true,
        prunedRoute: {
          stops: prunedStops,
          currentStopIndex: 0,
          phase: 'build',
          createdAtTurn: 5,
          reasoning: 'pruned',
        },
        errors: [],
      });

      const response = buildLlmResponse([
        {
          stops: [
            { action: 'pickup', load: 'Coal', city: 'Essen' },
            { action: 'deliver', load: 'Coal', city: 'Berlin', demandCardId: 1, payment: 15 },
            { action: 'pickup', load: 'Wine', city: 'Bordeaux' },
            { action: 'deliver', load: 'Wine', city: 'Paris', demandCardId: 2, payment: 12 },
          ],
          reasoning: 'Multi-stop trip',
        },
      ]);

      const { brain, chatFn } = makeMockBrain();
      chatFn.mockResolvedValue({ text: response, usage: { input: 200, output: 100 } });

      const planner = new TripPlanner(brain);
      const result = await planner.planTrip(makeSnapshot(), makeContext(), [], makeMemory());

      expect(result).not.toBeNull();
      // The candidate's stops should use the pruned stops
      expect(result!.candidates[0].stops).toHaveLength(2);
      expect(result!.candidates[0].stops[0].loadType).toBe('Coal');
    });
  });

  // ── 4. Validation filtering ───────────────────────────────────────────

  describe('validation filtering', () => {
    it('should filter out infeasible candidates rejected by RouteValidator', async () => {
      // First candidate fails validation, second passes
      (RouteValidator.validate as jest.Mock)
        .mockReturnValueOnce({ valid: false, errors: ['Supply unreachable'] })
        .mockReturnValueOnce({ valid: true, errors: [] });

      const response = buildLlmResponse([
        {
          stops: [
            { action: 'pickup', load: 'Coal', city: 'Essen' },
            { action: 'deliver', load: 'Coal', city: 'Berlin', demandCardId: 1, payment: 15 },
          ],
          reasoning: 'Infeasible route',
        },
        {
          stops: [
            { action: 'pickup', load: 'Wine', city: 'Bordeaux' },
            { action: 'deliver', load: 'Wine', city: 'Paris', demandCardId: 2, payment: 12 },
          ],
          reasoning: 'Feasible route',
        },
      ]);

      const context = makeContext({
        demands: [
          makeDemand(),
          makeDemand({ cardIndex: 2, loadType: 'Wine', supplyCity: 'Bordeaux', deliveryCity: 'Paris', payout: 12, estimatedTurns: 2 }),
        ],
      });

      const { brain, chatFn } = makeMockBrain();
      chatFn.mockResolvedValue({ text: response, usage: { input: 200, output: 100 } });

      const planner = new TripPlanner(brain);
      const result = await planner.planTrip(makeSnapshot(), context, [], makeMemory());

      expect(result).not.toBeNull();
      expect(result!.candidates).toHaveLength(1);
      expect(result!.candidates[0].reasoning).toBe('Feasible route');
    });

    it('should retry when all candidates fail validation', async () => {
      // All candidates fail on first attempt, succeed on second
      (RouteValidator.validate as jest.Mock)
        .mockReturnValueOnce({ valid: false, errors: ['Budget exceeded'] })
        .mockReturnValue({ valid: true, errors: [] });

      const failResponse = buildLlmResponse([
        {
          stops: [
            { action: 'pickup', load: 'Coal', city: 'Essen' },
            { action: 'deliver', load: 'Coal', city: 'Berlin', demandCardId: 1, payment: 15 },
          ],
          reasoning: 'Failed route',
        },
      ]);

      const successResponse = buildLlmResponse([
        {
          stops: [
            { action: 'pickup', load: 'Coal', city: 'Essen' },
            { action: 'deliver', load: 'Coal', city: 'Berlin', demandCardId: 1, payment: 15 },
          ],
          reasoning: 'Fixed route',
        },
      ]);

      const { brain, chatFn } = makeMockBrain();
      chatFn
        .mockResolvedValueOnce({ text: failResponse, usage: { input: 100, output: 50 } })
        .mockResolvedValueOnce({ text: successResponse, usage: { input: 100, output: 50 } });

      const planner = new TripPlanner(brain);
      const result = await planner.planTrip(makeSnapshot(), makeContext(), [], makeMemory());

      expect(result).not.toBeNull();
      expect(chatFn).toHaveBeenCalledTimes(2);
      expect(result!.candidates[0].reasoning).toBe('Fixed route');
    });
  });

  // ── 5. LLM failure fallback ───────────────────────────────────────────

  describe('LLM failure fallback', () => {
    it('should fall back to planRoute() when all LLM attempts fail', async () => {
      const fallbackRoute: StrategicRoute = {
        stops: [
          { action: 'pickup', loadType: 'Coal', city: 'Essen' },
          { action: 'deliver', loadType: 'Coal', city: 'Berlin', demandCardId: 1, payment: 15 },
        ],
        currentStopIndex: 0,
        phase: 'build',
        createdAtTurn: 5,
        reasoning: 'Fallback route',
      };

      const { brain, chatFn, planRouteFn } = makeMockBrain();
      chatFn.mockRejectedValue(new Error('API timeout'));
      planRouteFn.mockResolvedValue({
        route: fallbackRoute,
        model: 'claude-sonnet-4-6',
        latencyMs: 500,
        tokenUsage: { input: 80, output: 40 },
        llmLog: [{ attemptNumber: 1, status: 'success' as const, responseText: '...', latencyMs: 500 }],
      });

      const planner = new TripPlanner(brain);
      const result = await planner.planTrip(makeSnapshot(), makeContext(), [], makeMemory());

      expect(result).not.toBeNull();
      expect(result!.candidates).toHaveLength(0);
      expect(result!.chosen).toBe(-1);
      expect(result!.route.reasoning).toBe('Fallback route');
      // 3 LLM attempts (initial + 2 retries) then fallback
      expect(chatFn).toHaveBeenCalledTimes(3);
      expect(planRouteFn).toHaveBeenCalledTimes(1);
    });

    it('should fall back when LLM returns unparseable JSON', async () => {
      const fallbackRoute: StrategicRoute = {
        stops: [
          { action: 'pickup', loadType: 'Coal', city: 'Essen' },
          { action: 'deliver', loadType: 'Coal', city: 'Berlin', demandCardId: 1, payment: 15 },
        ],
        currentStopIndex: 0,
        phase: 'build',
        createdAtTurn: 5,
        reasoning: 'Fallback from parse error',
      };

      const { brain, chatFn, planRouteFn } = makeMockBrain();
      chatFn.mockResolvedValue({ text: 'NOT VALID JSON {{{', usage: { input: 50, output: 20 } });
      planRouteFn.mockResolvedValue({
        route: fallbackRoute,
        model: 'claude-sonnet-4-6',
        latencyMs: 300,
        tokenUsage: { input: 60, output: 30 },
        llmLog: [{ attemptNumber: 1, status: 'success' as const, responseText: '...', latencyMs: 300 }],
      });

      const planner = new TripPlanner(brain);
      const result = await planner.planTrip(makeSnapshot(), makeContext(), [], makeMemory());

      expect(result).not.toBeNull();
      expect(result!.chosen).toBe(-1);
      expect(result!.route.reasoning).toBe('Fallback from parse error');
      // llmLog should contain parse_error entries from failed attempts
      const parseErrors = result!.llmLog.filter(l => l.status === 'parse_error');
      expect(parseErrors.length).toBeGreaterThan(0);
    });

    it('should fall back when LLM returns empty candidates array', async () => {
      const emptyResponse = JSON.stringify({
        candidates: [],
        chosenIndex: 0,
        reasoning: 'No viable trips',
      });

      const fallbackRoute: StrategicRoute = {
        stops: [
          { action: 'pickup', loadType: 'Coal', city: 'Essen' },
          { action: 'deliver', loadType: 'Coal', city: 'Berlin', demandCardId: 1, payment: 15 },
        ],
        currentStopIndex: 0,
        phase: 'build',
        createdAtTurn: 5,
        reasoning: 'Fallback from empty candidates',
      };

      const { brain, chatFn, planRouteFn } = makeMockBrain();
      chatFn.mockResolvedValue({ text: emptyResponse, usage: { input: 50, output: 20 } });
      planRouteFn.mockResolvedValue({
        route: fallbackRoute,
        model: 'claude-sonnet-4-6',
        latencyMs: 200,
        llmLog: [{ attemptNumber: 1, status: 'success' as const, responseText: '...', latencyMs: 200 }],
      });

      const planner = new TripPlanner(brain);
      const result = await planner.planTrip(makeSnapshot(), makeContext(), [], makeMemory());

      expect(result).not.toBeNull();
      expect(result!.chosen).toBe(-1);
      expect(planRouteFn).toHaveBeenCalled();
    });
  });

  // ── 6. Total failure ──────────────────────────────────────────────────

  describe('total failure', () => {
    it('should return null when LLM and planRoute() both fail', async () => {
      const { brain, chatFn, planRouteFn } = makeMockBrain();
      chatFn.mockRejectedValue(new Error('API down'));
      planRouteFn.mockRejectedValue(new Error('Fallback also failed'));

      const planner = new TripPlanner(brain);
      const result = await planner.planTrip(makeSnapshot(), makeContext(), [], makeMemory());

      expect(result).toBeNull();
      expect(chatFn).toHaveBeenCalledTimes(3);
      expect(planRouteFn).toHaveBeenCalledTimes(1);
    });

    it('should return null when planRoute() returns null route', async () => {
      const { brain, chatFn, planRouteFn } = makeMockBrain();
      chatFn.mockRejectedValue(new Error('API error'));
      planRouteFn.mockResolvedValue({ route: null, llmLog: [] });

      const planner = new TripPlanner(brain);
      const result = await planner.planTrip(makeSnapshot(), makeContext(), [], makeMemory());

      expect(result).toBeNull();
    });

    it('should return null when all candidates are invalid and fallback fails', async () => {
      (RouteValidator.validate as jest.Mock).mockReturnValue({
        valid: false,
        errors: ['All stops infeasible'],
      });

      const response = buildLlmResponse([
        {
          stops: [
            { action: 'pickup', load: 'Coal', city: 'Essen' },
            { action: 'deliver', load: 'Coal', city: 'Berlin', demandCardId: 1, payment: 15 },
          ],
          reasoning: 'Infeasible',
        },
      ]);

      const { brain, chatFn, planRouteFn } = makeMockBrain();
      chatFn.mockResolvedValue({ text: response, usage: { input: 100, output: 50 } });
      planRouteFn.mockResolvedValue({ route: null, llmLog: [] });

      const planner = new TripPlanner(brain);
      const result = await planner.planTrip(makeSnapshot(), makeContext(), [], makeMemory());

      expect(result).toBeNull();
    });
  });

  // ── Additional edge cases ─────────────────────────────────────────────

  describe('edge cases', () => {
    it('should include error context in retry prompt after parse failure', async () => {
      const validResponse = buildLlmResponse([
        {
          stops: [
            { action: 'pickup', load: 'Coal', city: 'Essen' },
            { action: 'deliver', load: 'Coal', city: 'Berlin', demandCardId: 1, payment: 15 },
          ],
          reasoning: 'Fixed',
        },
      ]);

      const { brain, chatFn } = makeMockBrain();
      chatFn
        .mockResolvedValueOnce({ text: 'INVALID JSON', usage: { input: 50, output: 20 } })
        .mockResolvedValueOnce({ text: validResponse, usage: { input: 100, output: 50 } });

      const planner = new TripPlanner(brain);
      await planner.planTrip(makeSnapshot(), makeContext(), [], makeMemory());

      // Second call should include error context in the prompt
      const secondCall = chatFn.mock.calls[1][0];
      expect(secondCall.userPrompt).toContain('PREVIOUS ATTEMPT FAILED');
    });

    it('should handle response that is valid JSON embedded in extra whitespace', async () => {
      const response = `  \n  ${buildLlmResponse([
        {
          stops: [
            { action: 'pickup', load: 'Coal', city: 'Essen' },
            { action: 'deliver', load: 'Coal', city: 'Berlin', demandCardId: 1, payment: 15 },
          ],
          reasoning: 'Whitespace padded',
        },
      ])}  \n  `;

      const { brain, chatFn } = makeMockBrain();
      chatFn.mockResolvedValue({ text: response, usage: { input: 100, output: 50 } });

      const planner = new TripPlanner(brain);
      const result = await planner.planTrip(makeSnapshot(), makeContext(), [], makeMemory());

      expect(result).not.toBeNull();
      expect(result!.candidates).toHaveLength(1);
    });

    it('should propagate upgradeOnRoute from LLM response to StrategicRoute', async () => {
      const response = buildLlmResponse([
        {
          stops: [
            { action: 'pickup', load: 'Coal', city: 'Essen' },
            { action: 'deliver', load: 'Coal', city: 'Berlin', demandCardId: 1, payment: 15 },
          ],
          reasoning: 'Upgrade and deliver',
        },
      ], 0, 'FastFreight');

      const { brain, chatFn } = makeMockBrain();
      chatFn.mockResolvedValue({ text: response, usage: { input: 100, output: 50 } });

      const planner = new TripPlanner(brain);
      const result = await planner.planTrip(makeSnapshot(), makeContext(), [], makeMemory());

      expect(result).not.toBeNull();
      expect(result!.route.upgradeOnRoute).toBe('FastFreight');
    });

    it('should leave upgradeOnRoute undefined when LLM omits it', async () => {
      const response = buildLlmResponse([
        {
          stops: [
            { action: 'pickup', load: 'Coal', city: 'Essen' },
            { action: 'deliver', load: 'Coal', city: 'Berlin', demandCardId: 1, payment: 15 },
          ],
          reasoning: 'No upgrade',
        },
      ]);

      const { brain, chatFn } = makeMockBrain();
      chatFn.mockResolvedValue({ text: response, usage: { input: 100, output: 50 } });

      const planner = new TripPlanner(brain);
      const result = await planner.planTrip(makeSnapshot(), makeContext(), [], makeMemory());

      expect(result).not.toBeNull();
      expect(result!.route.upgradeOnRoute).toBeUndefined();
    });

    it('should pass memory fields to planRoute() fallback', async () => {
      const { brain, chatFn, planRouteFn } = makeMockBrain();
      chatFn.mockRejectedValue(new Error('LLM down'));
      planRouteFn.mockResolvedValue({ route: null, llmLog: [] });

      const memory = makeMemory({
        lastAbandonedRouteKey: 'Coal:Essen→Berlin',
        previousRouteStops: [
          { action: 'pickup', loadType: 'Coal', city: 'Essen' },
        ],
      });

      const planner = new TripPlanner(brain);
      await planner.planTrip(makeSnapshot(), makeContext(), [], memory);

      expect(planRouteFn).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        expect.anything(),
        'Coal:Essen→Berlin',
        expect.arrayContaining([expect.objectContaining({ loadType: 'Coal' })]),
      );
    });
  });
});
