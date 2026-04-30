/**
 * TripPlanner.test.ts — Tests for TripPlanner.planTrip()
 *
 * Tests candidate parsing, scoring, route conversion, validation filtering,
 * LLM failure fallback, and total failure paths.
 */

import { TripPlanner, TripPlanResult } from '../../services/ai/TripPlanner';
import { RouteValidator } from '../../services/ai/RouteValidator';
import { estimateHopDistance } from '../../services/ai/MapTopology';
import {
  BotSkillLevel,
  BotMemoryState,
  GameContext,
  GridPoint,
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
jest.mock('../../services/ai/RouteOptimizer', () => ({
  RouteOptimizer: {
    // Pass stops through unchanged by default — tests that care about reorder can override
    orderStopsByProximity: jest.fn((stops: unknown[]) => stops),
  },
}));
jest.mock('../../services/ai/schemas', () => ({
  TRIP_PLAN_SCHEMA: { type: 'object' },
}));
jest.mock('../../services/ai/prompts/systemPrompts', () => ({
  // JIRA-190: getTripPlanningPrompt returns { system, user } not a string
  getTripPlanningPrompt: jest.fn(() => ({
    system: 'mock-system-prompt',
    user: 'mock-user-prompt: Plan the best multi-stop trip for this turn. Consider all 3 demand cards simultaneously.',
  })),
}));
jest.mock('../../services/ai/MapTopology', () => ({
  estimateHopDistance: jest.fn(() => 0),
  loadGridPoints: jest.fn(() => new Map()),
}));

// JIRA-187: mock computeTrackUsageFees — returns 0 by default (no fees)
jest.mock('../../../shared/services/computeTrackUsageFees', () => ({
  computeTrackUsageFees: jest.fn(() => 0),
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

/**
 * Build an LLM response JSON string with the given candidates.
 * JIRA-190: auto-converts old-format stops (city) to new-format (supplyCity/deliveryCity).
 */
function buildLlmResponse(candidates: Array<{
  stops: Array<{ action: string; load: string; city?: string; supplyCity?: string; deliveryCity?: string; demandCardId?: number; payment?: number }>;
  reasoning: string;
}>, chosenIndex = 0, upgradeOnRoute?: string): string {
  const convertedCandidates = candidates.map(c => ({
    ...c,
    stops: c.stops.map(s => {
      const action = s.action.toUpperCase();
      // Already using new format
      if (s.supplyCity || s.deliveryCity) return s;
      // Convert old city field to new format
      if (action === 'PICKUP' || action === 'pickup') {
        const { city, ...rest } = s;
        return { ...rest, supplyCity: city };
      } else {
        const { city, ...rest } = s;
        return { ...rest, deliveryCity: city };
      }
    }),
  }));
  return JSON.stringify({
    candidates: convertedCandidates,
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
  const setContextFn = jest.fn();

  const brain = {
    providerAdapter: { chat: chatFn, setContext: setContextFn },
    modelName: 'claude-sonnet-4-6',
    strategyConfig: makeConfig(),
    planRoute: planRouteFn,
  };

  return { brain: brain as any, chatFn, planRouteFn, setContextFn };
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
      // Wine should win due to lower build cost — LLM chooses Wine (index 1)
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
      ], 1 /* chosenIndex = Wine (index 1), the higher-scoring candidate */);

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
      expect(result!.candidates[0].netValue).toBe(12); // Wine sorted first (higher score)
      expect(result!.candidates[1].netValue).toBe(10); // Coal sorted second
      // LLM chose Wine (index 1 = sorted position 0), so Wine wins
      expect(result!.route.stops[0].loadType).toBe('Wine');
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
      // First candidate fails validation, second passes.
      // JIRA-206 (R2): LLM picks chosenIndex=0 (infeasible), which is not in the validated set.
      // chosen_not_in_validated now returns no-route instead of falling back to bestIdx.
      // Use chosenIndex=1 (the feasible candidate) so the route commits normally.
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
      ], 1 /* LLM picks the feasible candidate */);

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
    it('should return failure result with llmLog when LLM and planRoute() both fail', async () => {
      const { brain, chatFn, planRouteFn } = makeMockBrain();
      chatFn.mockRejectedValue(new Error('API down'));
      planRouteFn.mockRejectedValue(new Error('Fallback also failed'));

      const planner = new TripPlanner(brain);
      const result = await planner.planTrip(makeSnapshot(), makeContext(), [], makeMemory());

      expect(result.route).toBeNull();
      expect(result.llmLog).toHaveLength(3);
      expect(result.llmLog[0].status).toBe('api_error');
      expect(result.llmLog[0].error).toContain('API down');
      expect(chatFn).toHaveBeenCalledTimes(3);
      expect(planRouteFn).toHaveBeenCalledTimes(1);
    });

    it('should return failure result with llmLog when planRoute() returns null route', async () => {
      const { brain, chatFn, planRouteFn } = makeMockBrain();
      chatFn.mockRejectedValue(new Error('API error'));
      planRouteFn.mockResolvedValue({ route: null, llmLog: [] });

      const planner = new TripPlanner(brain);
      const result = await planner.planTrip(makeSnapshot(), makeContext(), [], makeMemory());

      expect(result.route).toBeNull();
      expect(result.llmLog).toHaveLength(3);
    });

    it('should return failure result with llmLog when all candidates are invalid and fallback fails', async () => {
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

      expect(result.route).toBeNull();
      expect(result.llmLog.length).toBeGreaterThan(0);
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
      expect(result!.route.upgradeOnRoute).toBe('fast_freight'); // normalized from LLM PascalCase to TrainType snake_case
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

  describe('userPromptOverride', () => {
    it('forwards custom user prompt to brain.chat() when provided', async () => {
      const llmResponse = buildLlmResponse([
        { stops: [
          { action: 'PICKUP', load: 'Coal', city: 'Essen' },
          { action: 'DELIVER', load: 'Coal', city: 'Berlin', demandCardId: 1, payment: 15 },
        ], reasoning: 'Quick delivery' },
      ]);

      const { brain, chatFn } = makeMockBrain({
        chatFn: jest.fn<Promise<ProviderResponse>, [any]>().mockResolvedValue({
          text: llmResponse,
          usage: { inputTokens: 100, outputTokens: 50 },
        }),
      });

      const customPrompt = 'You are at Nantes and can pick up: Cattle (best: 27M → Dublin), Machinery (best: 18M → Manchester). Plan the best multi-stop trip.';
      const planner = new TripPlanner(brain);
      await planner.planTrip(makeSnapshot(), makeContext(), [], makeMemory(), customPrompt);

      // Verify the custom prompt was forwarded via the userPrompt field
      expect(chatFn).toHaveBeenCalledTimes(1);
      const chatArgs = chatFn.mock.calls[0][0];
      expect(chatArgs.userPrompt).toContain('You are at Nantes');
      expect(chatArgs.userPrompt).toContain('Cattle');
    });

    it('uses default prompt when no override is provided', async () => {
      const llmResponse = buildLlmResponse([
        { stops: [
          { action: 'PICKUP', load: 'Coal', city: 'Essen' },
          { action: 'DELIVER', load: 'Coal', city: 'Berlin', demandCardId: 1, payment: 15 },
        ], reasoning: 'Quick delivery' },
      ]);

      const { brain, chatFn } = makeMockBrain({
        chatFn: jest.fn<Promise<ProviderResponse>, [any]>().mockResolvedValue({
          text: llmResponse,
          usage: { inputTokens: 100, outputTokens: 50 },
        }),
      });

      const planner = new TripPlanner(brain);
      await planner.planTrip(makeSnapshot(), makeContext(), [], makeMemory());

      expect(chatFn).toHaveBeenCalledTimes(1);
      const chatArgs = chatFn.mock.calls[0][0];
      expect(chatArgs.userPrompt).toContain('Plan the best multi-stop trip');
    });
  });

  // ── Chain-aware multi-stop turn estimation (JIRA-160) ──────────────────

  describe('chain-aware multi-stop turn estimation (JIRA-160)', () => {
    const mockedEstimateHopDistance = estimateHopDistance as jest.MockedFunction<typeof estimateHopDistance>;

    /** Build a minimal GridPoint with city info at given row/col */
    function makeGridPoint(name: string, row: number, col: number): GridPoint {
      return {
        id: `${row},${col}`,
        row,
        col,
        x: col * 10,
        y: row * 10,
        terrain: 0 as any,
        city: { name, type: 'major' as any },
      } as unknown as GridPoint;
    }

    it('single-stop trip produces identical score to original behavior', async () => {
      // Single deliver stop: should use matchingDemand.estimatedTurns directly (no chaining)
      const response = buildLlmResponse([
        {
          stops: [
            { action: 'pickup', load: 'Coal', city: 'Essen' },
            { action: 'deliver', load: 'Coal', city: 'Berlin', demandCardId: 1, payment: 15 },
          ],
          reasoning: 'Direct coal delivery',
        },
      ]);

      const context = makeContext({
        demands: [makeDemand({ cardIndex: 1, loadType: 'Coal', supplyCity: 'Essen', deliveryCity: 'Berlin', payout: 15, estimatedTurns: 3 })],
      });

      const gridPoints = [
        makeGridPoint('Essen', 10, 5),
        makeGridPoint('Berlin', 15, 10),
      ];

      const { brain, chatFn } = makeMockBrain();
      chatFn.mockResolvedValue({ text: response, usage: { input: 100, output: 50 } });

      const planner = new TripPlanner(brain);
      const result = await planner.planTrip(makeSnapshot(), context, gridPoints, makeMemory());

      expect(result).not.toBeNull();
      expect(result!.candidates).toHaveLength(1);
      // Single-stop: estimatedTurns = demand.estimatedTurns (3), clamped to max(3,1) = 3
      expect(result!.candidates[0].estimatedTurns).toBe(3);
      // score = (15 - 0) / 3 = 5
      expect(result!.candidates[0].score).toBeCloseTo(5);
    });

    it('multi-stop trip with distant second leg scores lower than Math.max would', async () => {
      // Coal: estimatedTurns=3, Wine: estimatedTurns=2
      // Math.max would produce 3 total turns
      // Chain-aware: 3 (coal) + chain leg turns for wine = more than 3
      const response = buildLlmResponse([
        {
          stops: [
            { action: 'pickup', load: 'Coal', city: 'Essen' },
            { action: 'deliver', load: 'Coal', city: 'Berlin', demandCardId: 1, payment: 15 },
            { action: 'pickup', load: 'Wine', city: 'Bordeaux' },
            { action: 'deliver', load: 'Wine', city: 'Paris', demandCardId: 2, payment: 12 },
          ],
          reasoning: 'Double delivery',
        },
      ]);

      const context = makeContext({
        demands: [
          makeDemand({ cardIndex: 1, loadType: 'Coal', supplyCity: 'Essen', deliveryCity: 'Berlin', payout: 15, estimatedTurns: 3 }),
          makeDemand({ cardIndex: 2, loadType: 'Wine', supplyCity: 'Bordeaux', deliveryCity: 'Paris', payout: 12, estimatedTurns: 2 }),
        ],
      });

      const gridPoints = [
        makeGridPoint('Essen', 10, 5),
        makeGridPoint('Berlin', 15, 10),
        makeGridPoint('Bordeaux', 50, 2),   // far from Berlin
        makeGridPoint('Paris', 45, 8),
      ];

      // estimateHopDistance returns 20 hops for Berlin→Bordeaux (distant), 5 for Bordeaux→Paris
      mockedEstimateHopDistance.mockImplementation((fr, fc, tr, tc) => {
        // Berlin(15,10) → Bordeaux(50,2)
        if (fr === 15 && fc === 10 && tr === 50 && tc === 2) return 20;
        // Bordeaux(50,2) → Paris(45,8)
        if (fr === 50 && fc === 2 && tr === 45 && tc === 8) return 5;
        return 0;
      });

      const { brain, chatFn } = makeMockBrain();
      chatFn.mockResolvedValue({ text: response, usage: { input: 100, output: 50 } });

      const planner = new TripPlanner(brain);
      const result = await planner.planTrip(makeSnapshot(), context, gridPoints, makeMemory());

      expect(result).not.toBeNull();
      expect(result!.candidates).toHaveLength(1);

      const candidate = result!.candidates[0];
      // Chain-aware total: 3 (coal first leg) + ceil((20+5)/9) = 3 + 3 = 6 turns
      expect(candidate.estimatedTurns).toBe(6);
      // Math.max would give 3, so chain-aware turns (6) > Math.max turns (3)
      expect(candidate.estimatedTurns).toBeGreaterThan(3);
      // JIRA-166: Geographic distance penalty applied:
      // totalHopDistance = Essen→Berlin(0) + Berlin→Bordeaux(20) + Bordeaux→Paris(5) = 25
      // distancePenaltyDivisor = 1 + 25/20 = 2.25
      // baseScore = (15+12) / 6 = 4.5, adjustedScore = 4.5 / 2.25 = 2.0
      expect(candidate.score).toBeCloseTo(2.0);
    });

    it('multi-stop trip with adjacent second leg scores appropriately (fewer turns)', async () => {
      // When the second pickup is adjacent to the first delivery,
      // the chain leg should be short → fewer total turns → better score
      const response = buildLlmResponse([
        {
          stops: [
            { action: 'pickup', load: 'Coal', city: 'Essen' },
            { action: 'deliver', load: 'Coal', city: 'Berlin', demandCardId: 1, payment: 15 },
            { action: 'pickup', load: 'Steel', city: 'Hamburg' },
            { action: 'deliver', load: 'Steel', city: 'Dresden', demandCardId: 2, payment: 12 },
          ],
          reasoning: 'Adjacent double delivery',
        },
      ]);

      const context = makeContext({
        demands: [
          makeDemand({ cardIndex: 1, loadType: 'Coal', supplyCity: 'Essen', deliveryCity: 'Berlin', payout: 15, estimatedTurns: 3 }),
          makeDemand({ cardIndex: 2, loadType: 'Steel', supplyCity: 'Hamburg', deliveryCity: 'Dresden', payout: 12, estimatedTurns: 2 }),
        ],
      });

      const gridPoints = [
        makeGridPoint('Essen', 10, 5),
        makeGridPoint('Berlin', 15, 10),
        makeGridPoint('Hamburg', 16, 9),   // adjacent to Berlin
        makeGridPoint('Dresden', 18, 12),
      ];

      // estimateHopDistance returns 2 hops for Berlin→Hamburg (adjacent), 3 for Hamburg→Dresden
      mockedEstimateHopDistance.mockImplementation((fr, fc, tr, tc) => {
        // Berlin(15,10) → Hamburg(16,9)
        if (fr === 15 && fc === 10 && tr === 16 && tc === 9) return 2;
        // Hamburg(16,9) → Dresden(18,12)
        if (fr === 16 && fc === 9 && tr === 18 && tc === 12) return 3;
        return 0;
      });

      const { brain, chatFn } = makeMockBrain();
      chatFn.mockResolvedValue({ text: response, usage: { input: 100, output: 50 } });

      const planner = new TripPlanner(brain);
      const result = await planner.planTrip(makeSnapshot(), context, gridPoints, makeMemory());

      expect(result).not.toBeNull();
      expect(result!.candidates).toHaveLength(1);

      const candidate = result!.candidates[0];
      // Chain-aware total: 3 (coal first leg) + ceil((2+3)/9) = 3 + 1 = 4 turns
      expect(candidate.estimatedTurns).toBe(4);
      // JIRA-166: Geographic distance penalty applied:
      // totalHopDistance = Essen→Berlin(0) + Berlin→Hamburg(2) + Hamburg→Dresden(3) = 5
      // distancePenaltyDivisor = 1 + 5/20 = 1.25
      // baseScore = (15+12) / 4 = 6.75, adjustedScore = 6.75 / 1.25 = 5.4
      expect(candidate.score).toBeCloseTo(5.4);
    });

    it('distant pair scores lower than adjacent pair', async () => {
      // Build two single-candidate LLM responses and compare scores directly
      const distantResponse = buildLlmResponse([
        {
          stops: [
            { action: 'pickup', load: 'Coal', city: 'Essen' },
            { action: 'deliver', load: 'Coal', city: 'Berlin', demandCardId: 1, payment: 15 },
            { action: 'pickup', load: 'Wine', city: 'Bordeaux' },
            { action: 'deliver', load: 'Wine', city: 'Paris', demandCardId: 2, payment: 12 },
          ],
          reasoning: 'Distant second leg',
        },
      ]);

      const adjacentResponse = buildLlmResponse([
        {
          stops: [
            { action: 'pickup', load: 'Coal', city: 'Essen' },
            { action: 'deliver', load: 'Coal', city: 'Berlin', demandCardId: 1, payment: 15 },
            { action: 'pickup', load: 'Wine', city: 'Hamburg' },
            { action: 'deliver', load: 'Wine', city: 'Dresden', demandCardId: 3, payment: 12 },
          ],
          reasoning: 'Adjacent second leg',
        },
      ]);

      const baseContext = makeContext({
        demands: [
          makeDemand({ cardIndex: 1, loadType: 'Coal', supplyCity: 'Essen', deliveryCity: 'Berlin', payout: 15, estimatedTurns: 3 }),
          makeDemand({ cardIndex: 2, loadType: 'Wine', supplyCity: 'Bordeaux', deliveryCity: 'Paris', payout: 12, estimatedTurns: 2 }),
          makeDemand({ cardIndex: 3, loadType: 'Wine', supplyCity: 'Hamburg', deliveryCity: 'Dresden', payout: 12, estimatedTurns: 2 }),
        ],
      });

      const distantGridPoints = [
        makeGridPoint('Essen', 10, 5),
        makeGridPoint('Berlin', 15, 10),
        makeGridPoint('Bordeaux', 50, 2),  // far from Berlin
        makeGridPoint('Paris', 45, 8),
      ];

      const adjacentGridPoints = [
        makeGridPoint('Essen', 10, 5),
        makeGridPoint('Berlin', 15, 10),
        makeGridPoint('Hamburg', 16, 9),  // adjacent to Berlin
        makeGridPoint('Dresden', 18, 12),
      ];

      // Test distant pair
      mockedEstimateHopDistance.mockImplementation((fr, fc, tr, tc) => {
        if (fr === 15 && fc === 10 && tr === 50 && tc === 2) return 20; // Berlin→Bordeaux
        if (fr === 50 && fc === 2 && tr === 45 && tc === 8) return 5;  // Bordeaux→Paris
        return 0;
      });

      const { brain: brain1, chatFn: chatFn1 } = makeMockBrain();
      chatFn1.mockResolvedValue({ text: distantResponse, usage: { input: 100, output: 50 } });

      const planner1 = new TripPlanner(brain1);
      const distantResult = await planner1.planTrip(makeSnapshot(), baseContext, distantGridPoints, makeMemory());
      const distantScore = distantResult!.candidates[0].score;

      // Test adjacent pair
      mockedEstimateHopDistance.mockImplementation((fr, fc, tr, tc) => {
        if (fr === 15 && fc === 10 && tr === 16 && tc === 9) return 2; // Berlin→Hamburg
        if (fr === 16 && fc === 9 && tr === 18 && tc === 12) return 3; // Hamburg→Dresden
        return 0;
      });

      const { brain: brain2, chatFn: chatFn2 } = makeMockBrain();
      chatFn2.mockResolvedValue({ text: adjacentResponse, usage: { input: 100, output: 50 } });

      const planner2 = new TripPlanner(brain2);
      const adjacentResult = await planner2.planTrip(makeSnapshot(), baseContext, adjacentGridPoints, makeMemory());
      const adjacentScore = adjacentResult!.candidates[0].score;

      // Adjacent pair should score higher (fewer turns for same payout)
      expect(adjacentScore).toBeGreaterThan(distantScore);
    });

    it('train speed affects turn calculation — faster train means fewer turns', async () => {
      const response = buildLlmResponse([
        {
          stops: [
            { action: 'pickup', load: 'Coal', city: 'Essen' },
            { action: 'deliver', load: 'Coal', city: 'Berlin', demandCardId: 1, payment: 15 },
            { action: 'pickup', load: 'Wine', city: 'Hamburg' },
            { action: 'deliver', load: 'Wine', city: 'Dresden', demandCardId: 2, payment: 12 },
          ],
          reasoning: 'Double delivery',
        },
      ]);

      const context = makeContext({
        demands: [
          makeDemand({ cardIndex: 1, loadType: 'Coal', supplyCity: 'Essen', deliveryCity: 'Berlin', payout: 15, estimatedTurns: 3 }),
          makeDemand({ cardIndex: 2, loadType: 'Wine', supplyCity: 'Hamburg', deliveryCity: 'Dresden', payout: 12, estimatedTurns: 2 }),
        ],
      });

      const gridPoints = [
        makeGridPoint('Essen', 10, 5),
        makeGridPoint('Berlin', 15, 10),
        makeGridPoint('Hamburg', 16, 20),  // 10 hops from Berlin
        makeGridPoint('Dresden', 20, 25),  // 10 hops from Hamburg
      ];

      // 10 hops for each leg of the chain
      mockedEstimateHopDistance.mockImplementation((fr, fc, tr, tc) => {
        if (fr === 15 && fc === 10 && tr === 16 && tc === 20) return 10; // Berlin→Hamburg
        if (fr === 16 && fc === 20 && tr === 20 && tc === 25) return 10; // Hamburg→Dresden
        return 0;
      });

      // Freight train (speed=9): chain leg = ceil(20/9) = 3 turns
      const freightSnapshot = makeSnapshot();
      freightSnapshot.bot.trainType = 'freight'; // TrainType.Freight enum value

      const { brain: freightBrain, chatFn: freightChatFn } = makeMockBrain();
      freightChatFn.mockResolvedValue({ text: response, usage: { input: 100, output: 50 } });

      const freightPlanner = new TripPlanner(freightBrain);
      const freightResult = await freightPlanner.planTrip(freightSnapshot, context, gridPoints, makeMemory());
      const freightTurns = freightResult!.candidates[0].estimatedTurns;

      // FastFreight train (speed=12): chain leg = ceil(20/12) = 2 turns
      const fastSnapshot = makeSnapshot();
      fastSnapshot.bot.trainType = 'fast_freight'; // TrainType.FastFreight enum value

      const { brain: fastBrain, chatFn: fastChatFn } = makeMockBrain();
      fastChatFn.mockResolvedValue({ text: response, usage: { input: 100, output: 50 } });

      const fastPlanner = new TripPlanner(fastBrain);
      const fastResult = await fastPlanner.planTrip(fastSnapshot, context, gridPoints, makeMemory());
      const fastTurns = fastResult!.candidates[0].estimatedTurns;

      // Faster train should take fewer turns for the chain leg
      expect(fastTurns).toBeLessThan(freightTurns);
    });

    it('falls back to existingEstimatedTurns when gridPoints cannot resolve city', async () => {
      // Supply city for second demand not in gridPoints → fallback
      const response = buildLlmResponse([
        {
          stops: [
            { action: 'pickup', load: 'Coal', city: 'Essen' },
            { action: 'deliver', load: 'Coal', city: 'Berlin', demandCardId: 1, payment: 15 },
            { action: 'pickup', load: 'Wine', city: 'UnknownCity' },
            { action: 'deliver', load: 'Wine', city: 'Paris', demandCardId: 2, payment: 12 },
          ],
          reasoning: 'Fallback test',
        },
      ]);

      const context = makeContext({
        demands: [
          makeDemand({ cardIndex: 1, loadType: 'Coal', supplyCity: 'Essen', deliveryCity: 'Berlin', payout: 15, estimatedTurns: 3 }),
          makeDemand({ cardIndex: 2, loadType: 'Wine', supplyCity: 'UnknownCity', deliveryCity: 'Paris', payout: 12, estimatedTurns: 4 }),
        ],
      });

      // gridPoints does NOT include UnknownCity → fallback to existingEstimatedTurns
      const gridPoints = [
        makeGridPoint('Essen', 10, 5),
        makeGridPoint('Berlin', 15, 10),
        makeGridPoint('Paris', 45, 8),
        // UnknownCity intentionally missing
      ];

      const { brain, chatFn } = makeMockBrain();
      chatFn.mockResolvedValue({ text: response, usage: { input: 100, output: 50 } });

      const planner = new TripPlanner(brain);
      const result = await planner.planTrip(makeSnapshot(), context, gridPoints, makeMemory());

      expect(result).not.toBeNull();
      expect(result!.candidates).toHaveLength(1);
      // Falls back: 3 (coal) + 4 (wine fallback) = 7 turns
      expect(result!.candidates[0].estimatedTurns).toBe(7);
    });
  });

  // ── JIRA-143: setContext() called before chat() ──────────────────────

  describe('setContext — caller context before chat() (JIRA-143)', () => {
    it('should call setContext with trip-planner/planTrip before chat', async () => {
      const response = buildLlmResponse([
        {
          stops: [
            { action: 'pickup', load: 'Coal', city: 'Essen' },
            { action: 'deliver', load: 'Coal', city: 'Berlin', demandCardId: 1, payment: 15 },
          ],
          reasoning: 'Direct delivery',
        },
      ]);

      const { brain, chatFn, setContextFn } = makeMockBrain();
      chatFn.mockResolvedValue({ text: response, usage: { input: 100, output: 50 } });

      const planner = new TripPlanner(brain);
      await planner.planTrip(makeSnapshot(), makeContext(), [], makeMemory());

      expect(setContextFn).toHaveBeenCalledWith({
        gameId: 'g1',
        playerId: 'bot-1',
        turn: 5,
        caller: 'trip-planner',
        method: 'planTrip',
      });
      // setContext must be called before chat
      const setContextOrder = setContextFn.mock.invocationCallOrder[0];
      const chatOrder = chatFn.mock.invocationCallOrder[0];
      expect(setContextOrder).toBeLessThan(chatOrder);
    });

    it('should call setContext on each retry attempt', async () => {
      const { brain, chatFn, setContextFn } = makeMockBrain();
      // First call fails, second succeeds
      chatFn
        .mockRejectedValueOnce(new Error('API timeout'))
        .mockResolvedValueOnce({
          text: buildLlmResponse([
            {
              stops: [
                { action: 'pickup', load: 'Coal', city: 'Essen' },
                { action: 'deliver', load: 'Coal', city: 'Berlin', demandCardId: 1, payment: 15 },
              ],
              reasoning: 'Retry success',
            },
          ]),
          usage: { input: 100, output: 50 },
        });

      const planner = new TripPlanner(brain);
      await planner.planTrip(makeSnapshot(), makeContext(), [], makeMemory());

      // setContext should be called before each chat attempt
      expect(setContextFn).toHaveBeenCalledTimes(2);
      for (const call of setContextFn.mock.calls) {
        expect(call[0]).toEqual({
          gameId: 'g1',
          playerId: 'bot-1',
          turn: 5,
          caller: 'trip-planner',
          method: 'planTrip',
        });
      }
    });
  });

  // ── JIRA-181: chosenIndex selector ───────────────────────────────────────────

  describe('JIRA-181: chosenIndex selector', () => {
    it('chosenIndex: 0 with Candidate 0 validating and Candidate 2 scoring higher internally → Candidate 0 wins', async () => {
      // Candidate 0: low-payout route (lower internal score) — but LLM chose it
      // Candidate 2: high-payout route (higher internal score)
      // The LLM's chosenIndex=0 should be honored.
      (RouteValidator.validate as jest.Mock).mockImplementation((route: StrategicRoute) => {
        // Both candidates validate, returning their stops as-is
        return { valid: true, errors: [] };
      });

      const response = buildLlmResponse(
        [
          {
            stops: [
              { action: 'pickup', load: 'Coal', city: 'Essen' },
              { action: 'deliver', load: 'Coal', city: 'Berlin', demandCardId: 1, payment: 8 },
            ],
            reasoning: 'Candidate 0 — low payout',
          },
          {
            stops: [
              { action: 'pickup', load: 'Wine', city: 'Bordeaux' },
              { action: 'deliver', load: 'Wine', city: 'Paris', demandCardId: 2, payment: 30 },
            ],
            reasoning: 'Candidate 1 — medium',
          },
          {
            stops: [
              { action: 'pickup', load: 'Steel', city: 'Ruhr' },
              { action: 'deliver', load: 'Steel', city: 'Wien', demandCardId: 3, payment: 60 },
            ],
            reasoning: 'Candidate 2 — high payout (would win on score alone)',
          },
        ],
        0, // chosenIndex = 0
      );

      const context = makeContext({
        demands: [
          makeDemand({ cardIndex: 1, loadType: 'Coal', supplyCity: 'Essen', deliveryCity: 'Berlin', payout: 8, estimatedTurns: 2 }),
          makeDemand({ cardIndex: 2, loadType: 'Wine', supplyCity: 'Bordeaux', deliveryCity: 'Paris', payout: 30, estimatedTurns: 4 }),
          makeDemand({ cardIndex: 3, loadType: 'Steel', supplyCity: 'Ruhr', deliveryCity: 'Wien', payout: 60, estimatedTurns: 5 }),
        ],
      });

      const { brain, chatFn } = makeMockBrain();
      chatFn.mockResolvedValue({ text: response, usage: { input: 300, output: 150 } });

      const planner = new TripPlanner(brain);
      const result = await planner.planTrip(makeSnapshot(), context, [], makeMemory()) as TripPlanResult;

      // The route should reflect LLM's choice (Candidate 0), not the highest-scoring one (Candidate 2)
      expect(result.route.reasoning).toBe('Candidate 0 — low payout');
    });

    it('chosenIndex: 2 with Candidate 2 rejected by RouteValidator → JIRA-206 chosen_not_in_validated returns no-route', async () => {
      // Candidate 0 and 1 validate fine. Candidate 2 is rejected entirely.
      // JIRA-206 (R2): LLM picks chosenIndex=2 (rejected), which is not in the validated set.
      // chosen_not_in_validated now returns no-route instead of falling back to bestIdx.
      (RouteValidator.validate as jest.Mock).mockImplementation((route: StrategicRoute) => {
        // Candidate 2 is identified by its reasoning text
        if (route.reasoning === 'Candidate 2 — invalid') {
          return { valid: false, errors: ['All stops infeasible'] };
        }
        return { valid: true, errors: [] };
      });

      const response = buildLlmResponse(
        [
          {
            stops: [
              { action: 'pickup', load: 'Coal', city: 'Essen' },
              { action: 'deliver', load: 'Coal', city: 'Berlin', demandCardId: 1, payment: 15 },
            ],
            reasoning: 'Candidate 0 — valid',
          },
          {
            stops: [
              { action: 'pickup', load: 'Wine', city: 'Bordeaux' },
              { action: 'deliver', load: 'Wine', city: 'Paris', demandCardId: 2, payment: 12 },
            ],
            reasoning: 'Candidate 1 — valid',
          },
          {
            stops: [
              { action: 'pickup', load: 'Junk', city: 'Nowhere' },
            ],
            reasoning: 'Candidate 2 — invalid',
          },
        ],
        2, // chosenIndex = 2 (but Candidate 2 is fully rejected by RouteValidator)
      );

      const context = makeContext({
        demands: [
          makeDemand({ cardIndex: 1, loadType: 'Coal', supplyCity: 'Essen', deliveryCity: 'Berlin', payout: 15, estimatedTurns: 2 }),
          makeDemand({ cardIndex: 2, loadType: 'Wine', supplyCity: 'Bordeaux', deliveryCity: 'Paris', payout: 12, estimatedTurns: 3 }),
        ],
      });

      const { brain, chatFn } = makeMockBrain();
      chatFn.mockResolvedValue({ text: response, usage: { input: 300, output: 150 } });

      const planner = new TripPlanner(brain);
      const result = await planner.planTrip(makeSnapshot(), context, [], makeMemory());

      // JIRA-206: chosen_not_in_validated now returns no-route (route: null)
      expect(result.route).toBeNull();
    });

    it('chosenIndex out of range → JIRA-206 returns no-route (llm_rejected_validated)', async () => {
      // JIRA-206 (R2): chosen_not_in_validated now returns no-route instead of falling back to bestIdx.
      (RouteValidator.validate as jest.Mock).mockReturnValue({ valid: true, errors: [] });

      const response = buildLlmResponse(
        [
          {
            stops: [
              { action: 'pickup', load: 'Coal', city: 'Essen' },
              { action: 'deliver', load: 'Coal', city: 'Berlin', demandCardId: 1, payment: 15 },
            ],
            reasoning: 'Candidate 0',
          },
        ],
        99, // chosenIndex out of range — not in validated set
      );

      const context = makeContext({
        demands: [makeDemand()],
      });

      const { brain, chatFn } = makeMockBrain();
      chatFn.mockResolvedValue({ text: response, usage: { input: 100, output: 50 } });

      const planner = new TripPlanner(brain);
      const result = await planner.planTrip(makeSnapshot(), context, [], makeMemory());

      // JIRA-206: chosen_not_in_validated → route: null with llm_rejected_validated
      expect(result.route).toBeNull();
    });
  });
});

// ── JIRA-190: Prompt shape and field rename tests ────────────────────────────

describe('JIRA-190: getTripPlanningPrompt — prompt shape and content (AC1–AC6)', () => {
  // Use real implementation (bypass the mock at the top of this file)
  let getTripPlanningPromptReal: (
    skillLevel: BotSkillLevel,
    context: GameContext,
    memory: BotMemoryState,
  ) => { system: string; user: string };

  beforeAll(() => {
    const mod = jest.requireActual('../../services/ai/prompts/systemPrompts') as {
      getTripPlanningPrompt: (s: BotSkillLevel, c: GameContext, m: BotMemoryState) => { system: string; user: string };
    };
    getTripPlanningPromptReal = mod.getTripPlanningPrompt;
  });

  function makeMinimalContext(): GameContext {
    return {
      position: { city: 'Berlin', row: 10, col: 10 },
      money: 50,
      trainType: 'Freight',
      speed: 9,
      capacity: 2,
      loads: [],
      connectedMajorCities: ['Berlin'],
      unconnectedMajorCities: [],
      totalMajorCities: 8,
      trackSummary: 'Berlin hub',
      citiesOnNetwork: ['Berlin', 'Essen'],
      turnBuildCost: 0,
      turnNumber: 5,
      demands: [
        {
          cardIndex: 1, loadType: 'Coal', supplyCity: 'Essen', deliveryCity: 'Wien', payout: 15,
          isSupplyReachable: true, isDeliveryReachable: true, isSupplyOnNetwork: true, isDeliveryOnNetwork: true,
          estimatedTrackCostToSupply: 5, estimatedTrackCostToDelivery: 8,
          isLoadAvailable: true, isLoadOnTrain: false, ferryRequired: false,
          loadChipTotal: 4, loadChipCarried: 0, estimatedTurns: 3,
          demandScore: 0, efficiencyPerTurn: 5, networkCitiesUnlocked: 0,
          victoryMajorCitiesEnRoute: 0, isAffordable: true, projectedFundsAfterDelivery: 42,
        } as DemandContext,
      ],
      canDeliver: [],
      canPickup: [],
    } as GameContext;
  }

  function makeMinimalMemory(): BotMemoryState {
    return { lastAbandonedRouteKey: null, previousRouteStops: null, consecutiveLlmFailures: 0 } as BotMemoryState;
  }

  // AC2: return type is object with system and user keys
  it('AC2: returns an object with system and user keys (not a string)', () => {
    const result = getTripPlanningPromptReal(BotSkillLevel.Medium, makeMinimalContext(), makeMinimalMemory());
    expect(typeof result).toBe('object');
    expect(result).toHaveProperty('system');
    expect(result).toHaveProperty('user');
    expect(typeof result.system).toBe('string');
    expect(typeof result.user).toBe('string');
  });

  // AC1: system prompt is byte-identical across two different contexts at same skill level
  it('AC1: system prompt is byte-identical for two distinct contexts at same skill level', () => {
    const ctxA = makeMinimalContext();
    const ctxB = { ...makeMinimalContext(), money: 999, turnNumber: 50, loads: ['Coal'] };
    const memA = makeMinimalMemory();
    const memB = { ...makeMinimalMemory(), consecutiveLlmFailures: 5 };

    const resultA = getTripPlanningPromptReal(BotSkillLevel.Medium, ctxA as GameContext, memA);
    const resultB = getTripPlanningPromptReal(BotSkillLevel.Medium, ctxB as GameContext, memB);

    expect(resultA.system).toBe(resultB.system);
  });

  // AC3: system prompt contains no DROP/drop/Drop references
  it('AC3: system prompt contains no DROP, drop, or Drop', () => {
    const result = getTripPlanningPromptReal(BotSkillLevel.Medium, makeMinimalContext(), makeMinimalMemory());
    expect(result.system).not.toMatch(/DROP|drop|Drop/);
  });

  // AC4: system prompt contains no worked example block (no "EXAMPLE" or "Steel" token from old example)
  it('AC4: system prompt contains no EXAMPLE block or Steel worked-example marker', () => {
    const result = getTripPlanningPromptReal(BotSkillLevel.Medium, makeMinimalContext(), makeMinimalMemory());
    expect(result.system).not.toContain('EXAMPLE');
    // "Steel" was a distinctive load in the old example — regression marker
    // (It may appear in user context but not in the static system prompt)
    expect(result.system).not.toContain('Steel');
  });

  // AC5: system prompt does not contain multi-turn heuristics from COMMON_SYSTEM_SUFFIX
  it('AC5: system prompt contains no multi-turn heuristics ("DURING THE FIRST 10 TURNS", "AFTER 4 DELIVERIES UPGRADE TRAIN ASAP")', () => {
    const result = getTripPlanningPromptReal(BotSkillLevel.Medium, makeMinimalContext(), makeMinimalMemory());
    expect(result.system).not.toContain('DURING THE FIRST 10 TURNS');
    expect(result.system).not.toContain('AFTER 4 DELIVERIES UPGRADE TRAIN ASAP');
  });

  // AC6: system prompt includes PICKUP/supplyCity constraint rule
  it('AC6: system prompt contains a PICKUP and supplyCity constraint rule', () => {
    const result = getTripPlanningPromptReal(BotSkillLevel.Medium, makeMinimalContext(), makeMinimalMemory());
    expect(result.system).toMatch(/PICKUP/);
    expect(result.system).toMatch(/supplyCity/);
  });

  // AC1 (extended): dynamic content is in user, not repeated in system
  it('user prompt contains dynamic context (position, cash, demand cards)', () => {
    const ctx = makeMinimalContext();
    const result = getTripPlanningPromptReal(BotSkillLevel.Medium, ctx, makeMinimalMemory());
    // Dynamic content should appear in user, not be in system
    expect(result.user).toContain('Berlin');
    expect(result.user).toContain('50M ECU');
    expect(result.user).toContain('Coal');
  });
});

// ── JIRA-190: scoreCandidates field rename (AC7, AC8) ─────────────────────────

describe('JIRA-190: TripPlanner scoreCandidates — supplyCity/deliveryCity field rename (AC7, AC8)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    (RouteValidator.validate as jest.Mock).mockReturnValue({ valid: true, errors: [] });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  // AC7: PICKUP stop with supplyCity produces RouteStop with correct city and action
  it('AC7: PICKUP stop with supplyCity produces RouteStop[].action===pickup, loadType===Cattle, city===Bern', async () => {
    const response = JSON.stringify({
      candidates: [{
        stops: [
          { action: 'PICKUP', load: 'Cattle', supplyCity: 'Bern' },
          { action: 'DELIVER', load: 'Cattle', deliveryCity: 'Hamburg', demandCardId: 1, payment: 20 },
        ],
        reasoning: 'Cattle route',
      }],
      chosenIndex: 0,
      reasoning: 'Best candidate',
    });

    const context = {
      position: { city: 'Bern', row: 10, col: 10 },
      money: 80,
      trainType: 'Freight',
      speed: 9,
      capacity: 2,
      loads: [],
      connectedMajorCities: [],
      unconnectedMajorCities: [],
      totalMajorCities: 8,
      trackSummary: '',
      citiesOnNetwork: ['Bern'],
      turnBuildCost: 0,
      turnNumber: 5,
      demands: [{
        cardIndex: 1, loadType: 'Cattle', supplyCity: 'Bern', deliveryCity: 'Hamburg', payout: 20,
        isSupplyReachable: true, isDeliveryReachable: true, isSupplyOnNetwork: true, isDeliveryOnNetwork: true,
        estimatedTrackCostToSupply: 0, estimatedTrackCostToDelivery: 5,
        isLoadAvailable: true, isLoadOnTrain: false, ferryRequired: false,
        loadChipTotal: 4, loadChipCarried: 0, estimatedTurns: 3,
        demandScore: 0, efficiencyPerTurn: 6.7, networkCitiesUnlocked: 0,
        victoryMajorCitiesEnRoute: 0, isAffordable: true, projectedFundsAfterDelivery: 80,
      } as DemandContext],
      canDeliver: [],
      canPickup: [],
    } as GameContext;

    const { brain, chatFn } = makeMockBrain();
    chatFn.mockResolvedValue({ text: response, usage: { input: 100, output: 50 } });

    const planner = new TripPlanner(brain);
    const result = await planner.planTrip(makeSnapshot(), context, [], makeMemory());

    expect(result).not.toBeNull();
    const r = result as TripPlanResult;
    const pickupStop = r.route.stops.find(s => s.action === 'pickup');
    expect(pickupStop).toBeDefined();
    expect(pickupStop!.loadType).toBe('Cattle');
    expect(pickupStop!.city).toBe('Bern');
  });

  // AC8: a stop with action DROP is not present in the output
  it('AC8: a stop with action DROP in the LLM response does not appear in RouteStop[]', async () => {
    // The schema narrows action to PICKUP | DELIVER. A DROP stop coming through
    // will have neither supplyCity nor deliveryCity → city resolves to undefined → filtered out.
    const response = JSON.stringify({
      candidates: [{
        stops: [
          { action: 'PICKUP', load: 'Coal', supplyCity: 'Essen' },
          { action: 'DELIVER', load: 'Coal', deliveryCity: 'Berlin', demandCardId: 1, payment: 15 },
          // Rogue DROP stop (should be filtered — no supplyCity or deliveryCity)
          { action: 'DROP', load: 'Coal', city: 'Paris' },
        ],
        reasoning: 'Route with rogue DROP',
      }],
      chosenIndex: 0,
      reasoning: 'Only valid candidate',
    });

    const context = {
      position: { city: 'Essen', row: 10, col: 5 },
      money: 50,
      trainType: 'Freight',
      speed: 9,
      capacity: 2,
      loads: [],
      connectedMajorCities: [],
      unconnectedMajorCities: [],
      totalMajorCities: 8,
      trackSummary: '',
      citiesOnNetwork: ['Essen'],
      turnBuildCost: 0,
      turnNumber: 5,
      demands: [{
        cardIndex: 1, loadType: 'Coal', supplyCity: 'Essen', deliveryCity: 'Berlin', payout: 15,
        isSupplyReachable: true, isDeliveryReachable: true, isSupplyOnNetwork: true, isDeliveryOnNetwork: true,
        estimatedTrackCostToSupply: 0, estimatedTrackCostToDelivery: 0,
        isLoadAvailable: true, isLoadOnTrain: false, ferryRequired: false,
        loadChipTotal: 4, loadChipCarried: 0, estimatedTurns: 3,
        demandScore: 0, efficiencyPerTurn: 5, networkCitiesUnlocked: 0,
        victoryMajorCitiesEnRoute: 0, isAffordable: true, projectedFundsAfterDelivery: 65,
      } as DemandContext],
      canDeliver: [],
      canPickup: [],
    } as GameContext;

    const { brain, chatFn } = makeMockBrain();
    chatFn.mockResolvedValue({ text: response, usage: { input: 100, output: 50 } });

    const planner = new TripPlanner(brain);
    const result = await planner.planTrip(makeSnapshot(), context, [], makeMemory());

    expect(result).not.toBeNull();
    const r = result as TripPlanResult;
    const dropStops = r.route.stops.filter(s => s.action === 'drop');
    expect(dropStops).toHaveLength(0);
  });
});

// ── JIRA-190: retry path system-prompt stability (AC9) ────────────────────────

describe('JIRA-190: retry path — system prompt byte-stable across retries (AC9)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    (RouteValidator.validate as jest.Mock).mockReturnValue({ valid: true, errors: [] });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('AC9: system prompt is byte-identical across the failed and retry attempt; user prompt on retry contains PREVIOUS ATTEMPT FAILED', async () => {
    const validResponse = buildLlmResponse([{
      stops: [
        { action: 'pickup', load: 'Coal', city: 'Essen' },
        { action: 'deliver', load: 'Coal', city: 'Berlin', demandCardId: 1, payment: 15 },
      ],
      reasoning: 'Success on retry',
    }]);

    const { brain, chatFn } = makeMockBrain();
    chatFn
      .mockResolvedValueOnce({ text: 'INVALID JSON', usage: { input: 50, output: 5 } })
      .mockResolvedValueOnce({ text: validResponse, usage: { input: 100, output: 50 } });

    const planner = new TripPlanner(brain);
    await planner.planTrip(makeSnapshot(), makeContext(), [], makeMemory());

    expect(chatFn).toHaveBeenCalledTimes(2);

    const firstCall = chatFn.mock.calls[0][0];
    const secondCall = chatFn.mock.calls[1][0];

    // System prompt is byte-identical
    expect(firstCall.systemPrompt).toBe(secondCall.systemPrompt);

    // User prompt on second call contains error marker
    expect(secondCall.userPrompt).toContain('PREVIOUS ATTEMPT FAILED');
    // First call user prompt does NOT contain error marker
    expect(firstCall.userPrompt).not.toContain('PREVIOUS ATTEMPT FAILED');
  });
});

// ── JIRA-190: Integration test end-to-end (AC10) ─────────────────────────────

describe('JIRA-190: Integration — planTrip produces valid route with demand-card cities (AC10)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    (RouteValidator.validate as jest.Mock).mockReturnValue({ valid: true, errors: [] });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('AC10: every pickup stop city matches a demand supplyCity; every deliver stop city matches a demand deliveryCity', async () => {
    const demands: DemandContext[] = [
      {
        cardIndex: 1, loadType: 'Wine', supplyCity: 'Bordeaux', deliveryCity: 'München', payout: 18,
        isSupplyReachable: true, isDeliveryReachable: true, isSupplyOnNetwork: false, isDeliveryOnNetwork: false,
        estimatedTrackCostToSupply: 10, estimatedTrackCostToDelivery: 8,
        isLoadAvailable: true, isLoadOnTrain: false, ferryRequired: false,
        loadChipTotal: 3, loadChipCarried: 0, estimatedTurns: 4,
        demandScore: 0, efficiencyPerTurn: 4.5, networkCitiesUnlocked: 0,
        victoryMajorCitiesEnRoute: 0, isAffordable: true, projectedFundsAfterDelivery: 58,
      },
      {
        cardIndex: 2, loadType: 'Coal', supplyCity: 'Ruhr', deliveryCity: 'Wien', payout: 14,
        isSupplyReachable: true, isDeliveryReachable: true, isSupplyOnNetwork: true, isDeliveryOnNetwork: false,
        estimatedTrackCostToSupply: 0, estimatedTrackCostToDelivery: 12,
        isLoadAvailable: true, isLoadOnTrain: false, ferryRequired: false,
        loadChipTotal: 4, loadChipCarried: 0, estimatedTurns: 3,
        demandScore: 0, efficiencyPerTurn: 4.7, networkCitiesUnlocked: 0,
        victoryMajorCitiesEnRoute: 0, isAffordable: true, projectedFundsAfterDelivery: 54,
      },
      {
        cardIndex: 3, loadType: 'Steel', supplyCity: 'Hamburg', deliveryCity: 'Paris', payout: 22,
        isSupplyReachable: true, isDeliveryReachable: false, isSupplyOnNetwork: false, isDeliveryOnNetwork: false,
        estimatedTrackCostToSupply: 15, estimatedTrackCostToDelivery: 20,
        isLoadAvailable: true, isLoadOnTrain: false, ferryRequired: false,
        loadChipTotal: 2, loadChipCarried: 0, estimatedTurns: 7,
        demandScore: 0, efficiencyPerTurn: 3.1, networkCitiesUnlocked: 0,
        victoryMajorCitiesEnRoute: 0, isAffordable: true, projectedFundsAfterDelivery: 62,
      },
    ];

    // LLM returns a valid candidate using the demand card cities
    const response = JSON.stringify({
      candidates: [{
        stops: [
          { action: 'PICKUP', load: 'Wine', supplyCity: 'Bordeaux' },
          { action: 'DELIVER', load: 'Wine', deliveryCity: 'München', demandCardId: 1, payment: 18 },
          { action: 'PICKUP', load: 'Coal', supplyCity: 'Ruhr' },
          { action: 'DELIVER', load: 'Coal', deliveryCity: 'Wien', demandCardId: 2, payment: 14 },
        ],
        reasoning: 'Two deliveries in one route',
      }],
      chosenIndex: 0,
      reasoning: 'Best route',
    });

    const context: GameContext = {
      position: { city: 'Bordeaux', row: 20, col: 5 },
      money: 80,
      trainType: 'Freight',
      speed: 9,
      capacity: 2,
      loads: [],
      connectedMajorCities: ['Ruhr'],
      unconnectedMajorCities: [],
      totalMajorCities: 8,
      trackSummary: 'Ruhr hub',
      citiesOnNetwork: ['Ruhr', 'Bordeaux'],
      turnBuildCost: 0,
      turnNumber: 10,
      demands,
      canDeliver: [],
      canPickup: [],
    } as GameContext;

    const { brain, chatFn } = makeMockBrain();
    chatFn.mockResolvedValue({ text: response, usage: { input: 200, output: 80 } });

    const planner = new TripPlanner(brain);
    const result = await planner.planTrip(makeSnapshot(), context, [], makeMemory());

    expect(result).not.toBeNull();
    const r = result as TripPlanResult;
    expect(r.route).not.toBeNull();

    const supplyCities = demands.map(d => d.supplyCity);
    const deliveryCities = demands.map(d => d.deliveryCity);

    for (const stop of r.route.stops) {
      if (stop.action === 'pickup') {
        expect(supplyCities).toContain(stop.city);
      } else if (stop.action === 'deliver') {
        expect(deliveryCities).toContain(stop.city);
      }
    }
  });
});

// ── JIRA-187: effectivePayout in scoreCandidates ───────────────────────────

describe('TripPlanner — JIRA-187 effectivePayout scoring (AC4, AC5)', () => {
  let mockComputeTrackUsageFees: jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    // Import the mocked module
    const { computeTrackUsageFees } = require('../../../shared/services/computeTrackUsageFees');
    mockComputeTrackUsageFees = computeTrackUsageFees as jest.Mock;

    // Default: no fees
    mockComputeTrackUsageFees.mockReturnValue(0);
  });

  it('AC4: demand B (uncapped, payout=30, fees=0) scores higher than demand A (capped, payout=30, fees=40)', async () => {
    // Candidate A delivers to capped city — fees = 40 → effectivePayout = -10 → negative score
    // Candidate B delivers to open city — fees = 0 → effectivePayout = 30 → positive score
    // LLM chosenIndex=1 (Berlin) — honoring it validates the scorer result
    mockComputeTrackUsageFees.mockImplementation((demand: { deliveryCity: string }) => {
      return demand.deliveryCity === 'Cardiff' ? 40 : 0;
    });

    const context = makeContext({
      demands: [
        makeDemand({ cardIndex: 1, loadType: 'Coal', supplyCity: 'Essen', deliveryCity: 'Cardiff', payout: 30, estimatedTurns: 3 }),
        makeDemand({ cardIndex: 2, loadType: 'Coal', supplyCity: 'Essen', deliveryCity: 'Berlin', payout: 30, estimatedTurns: 3 }),
      ],
    });

    const response = JSON.stringify({
      chosenIndex: 1, // LLM explicitly picks Berlin (index 1 in candidates array)
      candidates: [
        {
          stops: [
            { action: 'PICKUP', load: 'Coal', supplyCity: 'Essen' },
            { action: 'DELIVER', load: 'Coal', deliveryCity: 'Cardiff', demandCardId: 1, payment: 30 },
          ],
          reasoning: 'Candidate A (Cardiff, capped)',
        },
        {
          stops: [
            { action: 'PICKUP', load: 'Coal', supplyCity: 'Essen' },
            { action: 'DELIVER', load: 'Coal', deliveryCity: 'Berlin', demandCardId: 2, payment: 30 },
          ],
          reasoning: 'Candidate B (Berlin, open)',
        },
      ],
    });

    const { brain, chatFn } = makeMockBrain();
    chatFn.mockResolvedValue({ text: response, usage: { input: 100, output: 50 } });

    const planner = new TripPlanner(brain);
    const result = await planner.planTrip(makeSnapshot(), context, [], makeMemory());

    if (!result || !('candidates' in result)) throw new Error('Expected TripPlanResult');
    const r = result as TripPlanResult;

    // Both candidates should have been scored
    expect(r.candidates.length).toBe(2);

    // Cardiff candidate should have usageFeeEstimate=40 and lower (negative) score
    const cardiffCandidate = r.candidates.find(c => c.stops.some(s => s.city === 'Cardiff'));
    const berlinCandidate = r.candidates.find(c => c.stops.some(s => s.city === 'Berlin'));
    expect(cardiffCandidate).toBeDefined();
    expect(berlinCandidate).toBeDefined();
    expect(cardiffCandidate!.usageFeeEstimate).toBe(40);
    // effectivePayout for Cardiff = 30 - 40 = -10 → netValue = -10 - 0 = -10 → negative score
    expect(cardiffCandidate!.score).toBeLessThan(0);
    // Berlin is open — score should be positive
    expect(berlinCandidate!.score).toBeGreaterThan(0);
    // Berlin outscores Cardiff
    expect(berlinCandidate!.score).toBeGreaterThan(cardiffCandidate!.score);
  });

  it('AC5: uncapped-city demand scores the same as pre-fix (no fee applied)', async () => {
    // No capped city — computeTrackUsageFees returns 0 for all → effectivePayout == payout
    mockComputeTrackUsageFees.mockReturnValue(0);

    const context = makeContext({
      demands: [
        makeDemand({ cardIndex: 1, loadType: 'Coal', supplyCity: 'Essen', deliveryCity: 'Berlin', payout: 20, estimatedTurns: 3 }),
      ],
    });

    const response = JSON.stringify({
      chosenIndex: 0,
      candidates: [
        {
          stops: [
            { action: 'PICKUP', load: 'Coal', supplyCity: 'Essen' },
            { action: 'DELIVER', load: 'Coal', deliveryCity: 'Berlin', demandCardId: 1, payment: 20 },
          ],
          reasoning: 'Standard route',
        },
      ],
    });

    const { brain, chatFn } = makeMockBrain();
    chatFn.mockResolvedValue({ text: response, usage: { input: 100, output: 50 } });

    const planner = new TripPlanner(brain);
    const result = await planner.planTrip(makeSnapshot(), context, [], makeMemory());

    if (!result || !('candidates' in result)) throw new Error('Expected TripPlanResult');
    const r = result as TripPlanResult;

    // usageFeeEstimate should be 0 (no fees for uncapped city)
    expect(r.candidates[0].usageFeeEstimate).toBe(0);
    // Score should be positive (netValue=20/turns=3 > 0)
    expect(r.candidates[0].score).toBeGreaterThan(0);
  });
});

// ── JIRA-194: TripPlanner selection override diagnostics ─────────────────

describe('TripPlanner — JIRA-194 selection override diagnostics', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});

    // Default: all candidates valid
    (RouteValidator.validate as jest.Mock).mockReturnValue({
      valid: true,
      errors: [],
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  // AC5: LLM returns 3 candidates; chosenIndex=0 fails validation; candidates 1,2 pass.
  // JIRA-206 (R2): chosen_not_in_validated now returns { route: null } with llm_rejected_validated.
  // The selection diagnostic is embedded in the llmLog success entry.
  it('AC5: selection diagnostic populated when chosenIndex fails RouteValidator → JIRA-206 returns no-route', async () => {
    const { brain, chatFn } = makeMockBrain();

    const context = makeContext({
      demands: [
        makeDemand({ loadType: 'Ham', deliveryCity: 'Torino', supplyCity: 'Warszawa', payout: 20 }),
        makeDemand({ loadType: 'Oil', deliveryCity: 'Zurich', supplyCity: 'Beograd', payout: 18 }),
        makeDemand({ loadType: 'Coal', deliveryCity: 'Berlin', supplyCity: 'Essen', payout: 15 }),
      ],
    });

    const response = buildLlmResponse([
      {
        stops: [
          { action: 'pickup', load: 'Ham', supplyCity: 'Warszawa' },
          { action: 'deliver', load: 'Ham', deliveryCity: 'Torino', demandCardId: 1, payment: 20 },
        ],
        reasoning: 'Ham delivery',
      },
      {
        stops: [
          { action: 'pickup', load: 'Oil', supplyCity: 'Beograd' },
          { action: 'deliver', load: 'Oil', deliveryCity: 'Zurich', demandCardId: 2, payment: 18 },
        ],
        reasoning: 'Oil delivery',
      },
      {
        stops: [
          { action: 'pickup', load: 'Coal', supplyCity: 'Essen' },
          { action: 'deliver', load: 'Coal', deliveryCity: 'Berlin', demandCardId: 3, payment: 15 },
        ],
        reasoning: 'Coal delivery',
      },
    ], 0); // chosenIndex=0 (Ham)

    // Candidate 0 (Ham, llmIndex=0) fails validation; 1 and 2 pass
    (RouteValidator.validate as jest.Mock)
      .mockReturnValueOnce({ valid: false, errors: ['No demand card for Ham→Torino'] }) // candidate 0
      .mockReturnValueOnce({ valid: true, errors: [] }) // candidate 1
      .mockReturnValueOnce({ valid: true, errors: [] }); // candidate 2

    chatFn.mockResolvedValue({ text: response, usage: { input: 100, output: 50 } });

    const planner = new TripPlanner(brain);
    const result = await planner.planTrip(makeSnapshot(), context, [], makeMemory());

    // JIRA-206 (R2): chosen_not_in_validated returns no-route
    expect(result).toBeDefined();
    expect(result.route).toBeNull();
    // selection field carries the reason (returned inline)
    const r = result as unknown as { route: null; llmLog: LlmAttempt[]; selection?: { llmChosenIndex: number; fallbackReason: string } };
    expect(r.selection).toBeDefined();
    expect(r.selection!.fallbackReason).toBe('llm_rejected_validated');
    // The LLM transcript diagnostic must include candidate 0's validator errors
    const diag = (r.llmLog.find(a => a.status === 'success') as any)?.tripPlannerSelection;
    expect(diag).toBeDefined();
    expect(diag.candidates[0].validatorErrors.length).toBeGreaterThan(0);
    expect(diag.candidates[0].validatorErrors[0]).toContain('Ham');
  });

  // AC6: All 3 candidates validate; chosenIndex=0 is honored → no selection field.
  it('AC6: selection is undefined when chosenIndex is honored', async () => {
    const { brain, chatFn } = makeMockBrain();

    const context = makeContext({
      demands: [
        makeDemand({ loadType: 'Oil', deliveryCity: 'Zurich', supplyCity: 'Beograd', payout: 18 }),
      ],
    });

    const response = buildLlmResponse([
      {
        stops: [
          { action: 'pickup', load: 'Oil', supplyCity: 'Beograd' },
          { action: 'deliver', load: 'Oil', deliveryCity: 'Zurich', demandCardId: 2, payment: 18 },
        ],
        reasoning: 'Oil delivery',
      },
    ], 0); // chosenIndex=0 (honored since only one candidate, all valid)

    // Candidate 0 validates cleanly
    (RouteValidator.validate as jest.Mock).mockReturnValue({ valid: true, errors: [] });

    chatFn.mockResolvedValue({ text: response, usage: { input: 100, output: 50 } });

    const planner = new TripPlanner(brain);
    const result = await planner.planTrip(makeSnapshot(), context, [], makeMemory());

    expect(result).toBeDefined();
    expect('candidates' in result).toBe(true);
    const r = result as TripPlanResult;

    // Honored — no selection field (R5)
    expect(r.selection).toBeUndefined();
    // Also no tripPlannerSelection in the success llmLog entry
    const successEntry = r.llmLog.find(a => a.status === 'success');
    expect((successEntry as any)?.tripPlannerSelection).toBeUndefined();
    // Verify via JSON.stringify — no 'tripPlannerSelection' key in serialized entry
    const serialized = JSON.stringify(successEntry);
    expect(serialized).not.toContain('tripPlannerSelection');
  });

  // AC8: Serialization round-trip — LLMTranscriptEntry with tripPlannerSelection populated
  it('AC8: LLMTranscriptEntry with tripPlannerSelection round-trips through JSON.stringify/JSON.parse', () => {
    const entry = {
      callId: 'test-id',
      gameId: 'g1',
      playerId: 'bot-1',
      turn: 5,
      timestamp: '2024-01-01T00:00:00Z',
      caller: 'trip-planner',
      method: 'selectionOverride',
      model: 'claude-sonnet-4-6',
      systemPrompt: '',
      userPrompt: '',
      responseText: '',
      status: 'success' as const,
      latencyMs: 0,
      attemptNumber: 1,
      totalAttempts: 1,
      tripPlannerSelection: {
        llmChosenIndex: 0,
        actualSelectedLlmIndex: 1,
        fallbackReason: 'chosen_not_in_validated' as const,
        candidates: [
          {
            llmIndex: 0,
            rawStops: [{ action: 'PICKUP', load: 'Ham', city: 'Warszawa' }, { action: 'DELIVER', load: 'Ham', city: 'Torino' }],
            validatorErrors: ['No demand card for Ham→Torino'],
            prunedToZero: false,
          },
          {
            llmIndex: 1,
            rawStops: [{ action: 'PICKUP', load: 'Oil', city: 'Beograd' }, { action: 'DELIVER', load: 'Oil', city: 'Zurich' }],
            validatorErrors: [],
            prunedToZero: false,
          },
        ],
      },
    };

    const serialized = JSON.stringify(entry);
    const parsed = JSON.parse(serialized);

    expect(parsed.tripPlannerSelection).toBeDefined();
    expect(parsed.tripPlannerSelection.llmChosenIndex).toBe(0);
    expect(parsed.tripPlannerSelection.actualSelectedLlmIndex).toBe(1);
    expect(parsed.tripPlannerSelection.fallbackReason).toBe('chosen_not_in_validated');
    expect(parsed.tripPlannerSelection.candidates).toHaveLength(2);
    expect(parsed.tripPlannerSelection.candidates[0].validatorErrors[0]).toContain('Ham');
  });
});

// ── JIRA-193: TripPlanner demandCardId fill-in (AC4, R6) ─────────────────

describe('TripPlanner — JIRA-193 demandCardId fill-in (AC4)', () => {
  /**
   * When the LLM omits demandCardId on a DELIVER stop, TripPlanner should attempt
   * to fill it in from context.demands by matching loadType + deliveryCity.
   * - Exactly one match → fill in cardIndex
   * - Zero or multiple matches → leave undefined (ambiguous — never guess)
   */
  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    (RouteValidator.validate as jest.Mock).mockReturnValue({ valid: true, errors: [] });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('AC4-a: fills in demandCardId when LLM omits it and exactly one held card matches', async () => {
    // LLM response: deliver Coal to Berlin WITHOUT demandCardId
    const response = buildLlmResponse([
      {
        stops: [
          { action: 'PICKUP', load: 'Coal', supplyCity: 'Essen' },
          { action: 'DELIVER', load: 'Coal', deliveryCity: 'Berlin' }, // no demandCardId
        ],
        reasoning: 'Coal to Berlin',
      },
    ]);

    const context = makeContext({
      demands: [
        makeDemand({ cardIndex: 42, loadType: 'Coal', supplyCity: 'Essen', deliveryCity: 'Berlin', payout: 20 }),
      ],
    });

    const { brain, chatFn } = makeMockBrain();
    chatFn.mockResolvedValue({ text: response, usage: { input: 100, output: 50 } });

    const planner = new TripPlanner(brain);
    const result = await planner.planTrip(makeSnapshot(), context, [], makeMemory());

    expect(result).not.toBeNull();
    const deliverStop = result!.candidates[0].stops.find(s => s.action === 'deliver');
    expect(deliverStop).toBeDefined();
    expect(deliverStop!.demandCardId).toBe(42);
  });

  it('AC4-b: leaves demandCardId undefined when zero held cards match (no match)', async () => {
    const response = buildLlmResponse([
      {
        stops: [
          { action: 'PICKUP', load: 'Coal', supplyCity: 'Essen' },
          { action: 'DELIVER', load: 'Coal', deliveryCity: 'Paris' }, // no demandCardId
        ],
        reasoning: 'Coal to Paris',
      },
    ]);

    // No demand for Coal→Paris in context
    const context = makeContext({
      demands: [
        makeDemand({ cardIndex: 10, loadType: 'Wine', supplyCity: 'Lyon', deliveryCity: 'Paris', payout: 15 }),
      ],
    });

    const { brain, chatFn } = makeMockBrain();
    chatFn.mockResolvedValue({ text: response, usage: { input: 100, output: 50 } });

    const planner = new TripPlanner(brain);
    const result = await planner.planTrip(makeSnapshot(), context, [], makeMemory());

    expect(result).not.toBeNull();
    const deliverStop = result!.candidates[0].stops.find(s => s.action === 'deliver');
    expect(deliverStop).toBeDefined();
    expect(deliverStop!.demandCardId).toBeUndefined();
  });

  it('AC4-c: leaves demandCardId undefined when multiple held cards match (ambiguous)', async () => {
    const response = buildLlmResponse([
      {
        stops: [
          { action: 'PICKUP', load: 'Coal', supplyCity: 'Essen' },
          { action: 'DELIVER', load: 'Coal', deliveryCity: 'Berlin' }, // no demandCardId
        ],
        reasoning: 'Coal to Berlin',
      },
    ]);

    // Two Coal→Berlin demand cards — ambiguous, must not guess
    const context = makeContext({
      demands: [
        makeDemand({ cardIndex: 5, loadType: 'Coal', supplyCity: 'Essen', deliveryCity: 'Berlin', payout: 20 }),
        makeDemand({ cardIndex: 6, loadType: 'Coal', supplyCity: 'Hamburg', deliveryCity: 'Berlin', payout: 18 }),
      ],
    });

    const { brain, chatFn } = makeMockBrain();
    chatFn.mockResolvedValue({ text: response, usage: { input: 100, output: 50 } });

    const planner = new TripPlanner(brain);
    const result = await planner.planTrip(makeSnapshot(), context, [], makeMemory());

    expect(result).not.toBeNull();
    const deliverStop = result!.candidates[0].stops.find(s => s.action === 'deliver');
    expect(deliverStop).toBeDefined();
    expect(deliverStop!.demandCardId).toBeUndefined();
  });

  it('AC4-d: preserves existing demandCardId when LLM provides it', async () => {
    // LLM already emits demandCardId=99 — fill-in should not overwrite it
    const response = buildLlmResponse([
      {
        stops: [
          { action: 'PICKUP', load: 'Coal', supplyCity: 'Essen' },
          { action: 'DELIVER', load: 'Coal', deliveryCity: 'Berlin', demandCardId: 99, payment: 20 },
        ],
        reasoning: 'Coal to Berlin',
      },
    ]);

    const context = makeContext({
      demands: [
        makeDemand({ cardIndex: 42, loadType: 'Coal', supplyCity: 'Essen', deliveryCity: 'Berlin', payout: 20 }),
      ],
    });

    const { brain, chatFn } = makeMockBrain();
    chatFn.mockResolvedValue({ text: response, usage: { input: 100, output: 50 } });

    const planner = new TripPlanner(brain);
    const result = await planner.planTrip(makeSnapshot(), context, [], makeMemory());

    expect(result).not.toBeNull();
    const deliverStop = result!.candidates[0].stops.find(s => s.action === 'deliver');
    expect(deliverStop).toBeDefined();
    // LLM-provided demandCardId=99 should be preserved, not overwritten with 42
    expect(deliverStop!.demandCardId).toBe(99);
  });

  // ── Truncated JSON recovery (JIRA-197) ────────────────────────────────

  describe('truncated JSON recovery', () => {
    it('should recover truncated trip plan response and return success (AC4)', async () => {
      // Flash turn 6 attempt #1 fixture: 3 complete stops, 4th truncated mid-string.
      // TripPlanner should recover the 3 complete stops and return success without retrying.
      const truncatedResponse =
        '{"candidates":[{"stops":[' +
        '{"action":"PICKUP","load":"Steel","supplyCity":"Luxembourg"},' +
        '{"action":"PICKUP","load":"Wine","supplyCity":"Frankfurt"},' +
        '{"action":"DELIVER","load":"Wine","deliveryCity":"Paris","demandCardId":14,"payment":11},' +
        '{"action":"DELIVER","load":"S';

      const context = makeContext({
        demands: [
          makeDemand({ cardIndex: 14, loadType: 'Wine', supplyCity: 'Frankfurt', deliveryCity: 'Paris', payout: 11 }),
          makeDemand({ cardIndex: 1, loadType: 'Steel', supplyCity: 'Luxembourg', deliveryCity: 'Berlin', payout: 19 }),
        ],
      });

      const { brain, chatFn, planRouteFn } = makeMockBrain();
      chatFn.mockResolvedValue({ text: truncatedResponse, usage: { input: 800, output: 400 } });

      const planner = new TripPlanner(brain);
      const result = await planner.planTrip(makeSnapshot(), context, [], makeMemory());

      // Recovery succeeds — adapter called exactly once (no retry)
      expect(chatFn).toHaveBeenCalledTimes(1);
      // planRoute fallback NOT called
      expect(planRouteFn).not.toHaveBeenCalled();
      // Result is a successful TripPlanResult (has candidates, not just route:null)
      expect(result).not.toBeNull();
      expect('candidates' in result!).toBe(true);
      const tripResult = result as TripPlanResult;
      expect(tripResult.candidates.length).toBeGreaterThan(0);
      // The recovered candidate has stops from the 3 complete stops (Steel pickup + Wine pickup + Wine deliver)
      const chosen = tripResult.candidates[tripResult.chosen];
      expect(chosen.stops.length).toBeGreaterThan(0);
      // llmLog has exactly one entry with status 'success' and recoveredFromTruncation=true
      expect(tripResult.llmLog).toHaveLength(1);
      expect(tripResult.llmLog[0].status).toBe('success');
      expect(tripResult.llmLog[0].recoveredFromTruncation).toBe(true);
    });

    it('should fall back to planRoute after 3 failed attempts when response is unrecoverable (AC5)', async () => {
      // Adapter returns completely unparseable garbage — recoverTruncatedJson returns null.
      // TripPlanner should exhaust 3 attempts, then call planRoute().
      const garbageResponse = 'this is not json';

      const fallbackRoute: StrategicRoute = {
        stops: [{ action: 'pickup', loadType: 'Coal', city: 'Essen' }],
        currentStopIndex: 0,
        phase: 'build',
        createdAtTurn: 5,
        reasoning: 'fallback route',
      };

      const { brain, chatFn, planRouteFn } = makeMockBrain();
      chatFn.mockResolvedValue({ text: garbageResponse, usage: { input: 100, output: 5 } });
      planRouteFn.mockResolvedValue({
        route: fallbackRoute,
        model: 'claude-sonnet-4-6',
        latencyMs: 100,
        tokenUsage: { input: 50, output: 20 },
        llmLog: [],
        systemPrompt: 'mock-system',
        userPrompt: 'mock-user',
      });

      const planner = new TripPlanner(brain);
      const result = await planner.planTrip(makeSnapshot(), makeContext(), [], makeMemory());

      // All 3 attempts exhaust (MAX_RETRIES=2, so 3 total)
      expect(chatFn).toHaveBeenCalledTimes(3);
      // planRoute fallback IS called
      expect(planRouteFn).toHaveBeenCalledTimes(1);
      // Result has route from planRoute (no candidates from TripPlanner)
      expect(result).not.toBeNull();
      expect('route' in result!).toBe(true);
      const tripResult = result as TripPlanResult;
      expect(tripResult.route).toBe(fallbackRoute);
      expect(tripResult.candidates).toHaveLength(0);
      // llmLog contains 3 parse_error entries (no behavior regression)
      const tripPlannerAttempts = tripResult.llmLog.filter(e => e.status === 'parse_error');
      expect(tripPlannerAttempts).toHaveLength(3);
    });

    it('should mark recovered attempt as recoveredFromTruncation in llmLog (R5)', async () => {
      // Verify the observability field: recovered attempts get recoveredFromTruncation=true,
      // normal success attempts do not have this field.
      const truncatedResponse =
        '{"candidates":[{"stops":[' +
        '{"action":"PICKUP","load":"Steel","supplyCity":"Essen"},' +
        '{"action":"DELIVER","load":"Steel","deliveryCity":"Berlin","demandCardId":1,"payment":15}' +
        '],"reasoning":"Direct delivery"},{"';

      const context = makeContext({
        demands: [
          makeDemand({ cardIndex: 1, loadType: 'Steel', supplyCity: 'Essen', deliveryCity: 'Berlin', payout: 15 }),
        ],
      });

      const { brain, chatFn } = makeMockBrain();
      chatFn.mockResolvedValue({ text: truncatedResponse, usage: { input: 300, output: 150 } });

      const planner = new TripPlanner(brain);
      const result = await planner.planTrip(makeSnapshot(), context, [], makeMemory());

      expect(result).not.toBeNull();
      const tripResult = result as TripPlanResult;
      expect(tripResult.llmLog[0].status).toBe('success');
      expect(tripResult.llmLog[0].recoveredFromTruncation).toBe(true);
    });
  });
});

// ── JIRA-206: Affordability filter, LLM-rejection no-route, on-network prompt rule ──────

describe('TripPlanner — JIRA-206 affordability filter and LLM-rejection no-route', () => {
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

  // ── AC1 reference scenario: Nano T15 ─────────────────────────────────
  // Game d7c3fd78 T15: $12M cash, freight train, no active route.
  // LLM proposes Oil (24M build) and Steel (29M build) with upgradeOnRoute: 'FastFreight'.
  // After upgrade cost (20M), available cash = $12M - $20M = -$8M → both unaffordable.
  // After retrying with hint (MAX_RETRIES=2 allows retry), all retries exhaust → no-route.
  it('AC1: Nano T15 reference — Oil 24M + Steel 29M unaffordable after 20M upgrade → no-route after retries', async () => {
    const oilResponse = buildLlmResponse([
      {
        stops: [
          { action: 'pickup', load: 'Oil', city: 'Newcastle' },
          { action: 'deliver', load: 'Oil', city: 'Zurich', demandCardId: 89, payment: 25 },
        ],
        reasoning: 'Oil Newcastle → Zurich',
      },
      {
        stops: [
          { action: 'pickup', load: 'Steel', city: 'Birmingham' },
          { action: 'deliver', load: 'Steel', city: 'Berlin', demandCardId: 81, payment: 8 },
        ],
        reasoning: 'Steel Birmingham → Berlin',
      },
    ], 0, 'FastFreight'); // chosenIndex=0 (Oil), upgradeOnRoute='FastFreight'

    const context = makeContext({
      money: 12,
      demands: [
        makeDemand({ cardIndex: 89, loadType: 'Oil', supplyCity: 'Newcastle', deliveryCity: 'Zurich', payout: 25, estimatedTrackCostToSupply: 7, estimatedTrackCostToDelivery: 17 }),
        makeDemand({ cardIndex: 81, loadType: 'Steel', supplyCity: 'Birmingham', deliveryCity: 'Berlin', payout: 8, estimatedTrackCostToSupply: 3, estimatedTrackCostToDelivery: 26 }),
        makeDemand({ cardIndex: 88, loadType: 'Cheese', supplyCity: 'Holland', deliveryCity: 'Cardiff', payout: 15, estimatedTrackCostToSupply: 0, estimatedTrackCostToDelivery: 0 }),
      ],
    });

    const snapshot = makeSnapshot(12); // $12M cash

    const { brain, chatFn, planRouteFn } = makeMockBrain();
    // All retries return the same unaffordable candidates
    chatFn.mockResolvedValue({ text: oilResponse, usage: { input: 1462, output: 567 } });
    // planRoute fallback returns null (no viable route)
    planRouteFn.mockResolvedValue({ route: null, llmLog: [] });

    const planner = new TripPlanner(brain);
    const result = await planner.planTrip(snapshot, context, [], makeMemory());

    // AC1: The committed Oil route does NOT happen — route must be null
    expect(result.route).toBeNull();
  });

  // ── R7a: All candidates fail affordability → no-route + no_affordable_candidate ──
  it('R7a: all candidates unaffordable → no-route after retries with no_affordable_candidate', async () => {
    // Both candidates have build costs exceeding bot cash
    const response = buildLlmResponse([
      {
        stops: [
          { action: 'pickup', load: 'Coal', city: 'Essen' },
          { action: 'deliver', load: 'Coal', city: 'Berlin', demandCardId: 1, payment: 15 },
        ],
        reasoning: 'Expensive Coal route',
      },
      {
        stops: [
          { action: 'pickup', load: 'Wine', city: 'Bordeaux' },
          { action: 'deliver', load: 'Wine', city: 'Paris', demandCardId: 2, payment: 12 },
        ],
        reasoning: 'Expensive Wine route',
      },
    ], 0);

    const context = makeContext({
      money: 5,
      demands: [
        makeDemand({ cardIndex: 1, loadType: 'Coal', supplyCity: 'Essen', deliveryCity: 'Berlin', payout: 15, estimatedTrackCostToSupply: 8, estimatedTrackCostToDelivery: 10 }),
        makeDemand({ cardIndex: 2, loadType: 'Wine', supplyCity: 'Bordeaux', deliveryCity: 'Paris', payout: 12, estimatedTrackCostToSupply: 10, estimatedTrackCostToDelivery: 8 }),
      ],
    });

    const snapshot = makeSnapshot(5); // only $5M

    const { brain, chatFn, planRouteFn } = makeMockBrain();
    chatFn.mockResolvedValue({ text: response, usage: { input: 100, output: 50 } });
    planRouteFn.mockResolvedValue({ route: null, llmLog: [] });

    const planner = new TripPlanner(brain);
    const result = await planner.planTrip(snapshot, context, [], makeMemory());

    // All candidates exceed $5M cash → no-route
    expect(result.route).toBeNull();
    // Should have retried (affordability hint triggers retry)
    expect(chatFn).toHaveBeenCalledTimes(3); // initial + 2 retries (MAX_RETRIES=2)
    // All llmLog entries for affordability failures are validation_error
    const validationErrors = result.llmLog.filter(e => e.status === 'validation_error');
    expect(validationErrors.length).toBeGreaterThan(0);
    expect(validationErrors[0].error).toContain('unaffordable');
  });

  // ── R7b: On-network candidate survives filter, off-network unaffordable ──
  it('R7b: on-network candidate (buildCost=0) survives affordability filter and is selected', async () => {
    // Cheese: Holland → Cardiff is on-network (0M build). Oil: Newcastle → Zurich costs 24M build.
    // Bot has $12M cash. Oil is unaffordable; Cheese survives.
    const response = buildLlmResponse([
      {
        stops: [
          { action: 'pickup', load: 'Oil', city: 'Newcastle' },
          { action: 'deliver', load: 'Oil', city: 'Zurich', demandCardId: 89, payment: 25 },
        ],
        reasoning: 'Oil — expensive build',
      },
      {
        stops: [
          { action: 'pickup', load: 'Cheese', city: 'Holland' },
          { action: 'deliver', load: 'Cheese', city: 'Cardiff', demandCardId: 88, payment: 15 },
        ],
        reasoning: 'Cheese — on-network, free',
      },
    ], 1); // LLM picks Cheese (index 1)

    const context = makeContext({
      money: 12,
      demands: [
        makeDemand({ cardIndex: 89, loadType: 'Oil', supplyCity: 'Newcastle', deliveryCity: 'Zurich', payout: 25, estimatedTrackCostToSupply: 7, estimatedTrackCostToDelivery: 17 }),
        makeDemand({ cardIndex: 88, loadType: 'Cheese', supplyCity: 'Holland', deliveryCity: 'Cardiff', payout: 15, estimatedTrackCostToSupply: 0, estimatedTrackCostToDelivery: 0 }),
      ],
    });

    const snapshot = makeSnapshot(12); // $12M cash

    const { brain, chatFn } = makeMockBrain();
    chatFn.mockResolvedValue({ text: response, usage: { input: 100, output: 50 } });

    const planner = new TripPlanner(brain);
    const result = await planner.planTrip(snapshot, context, [], makeMemory());

    // Cheese route is affordable and selected
    expect(result.route).not.toBeNull();
    expect(result!.route.stops.some(s => s.loadType === 'Cheese')).toBe(true);
    // Oil was dropped by the affordability filter, so only 1 candidate in the affordable set
    expect(chatFn).toHaveBeenCalledTimes(1); // no retry needed
  });

  // ── R7c: upgradeOnRoute cost subtracted before affordability check ──
  it('R7c: upgradeOnRoute cost (20M) is subtracted from cash before affordability check', async () => {
    // Bot has $32M cash. upgradeOnRoute='FastFreight' costs 20M. Available = $12M.
    // Candidate buildCost = 24M > $12M → unaffordable.
    // Without upgrade subtraction it would appear affordable ($24M < $32M). With subtraction it's not.
    const response = buildLlmResponse([
      {
        stops: [
          { action: 'pickup', load: 'Oil', city: 'Newcastle' },
          { action: 'deliver', load: 'Oil', city: 'Zurich', demandCardId: 89, payment: 25 },
        ],
        reasoning: 'Oil with upgrade',
      },
    ], 0, 'FastFreight'); // upgradeOnRoute = FastFreight (costs 20M)

    const context = makeContext({
      money: 32,
      demands: [
        makeDemand({ cardIndex: 89, loadType: 'Oil', supplyCity: 'Newcastle', deliveryCity: 'Zurich', payout: 25, estimatedTrackCostToSupply: 7, estimatedTrackCostToDelivery: 17 }),
      ],
    });

    const snapshot = makeSnapshot(32); // $32M cash

    const { brain, chatFn, planRouteFn } = makeMockBrain();
    chatFn.mockResolvedValue({ text: response, usage: { input: 100, output: 50 } });
    planRouteFn.mockResolvedValue({ route: null, llmLog: [] });

    const planner = new TripPlanner(brain);
    const result = await planner.planTrip(snapshot, context, [], makeMemory());

    // $32M cash - $20M upgrade = $12M available. Build cost=24M > $12M → unaffordable → no-route
    expect(result.route).toBeNull();
    // The retry prompt should mention affordability
    const validationErrors = result.llmLog.filter(e => e.status === 'validation_error');
    expect(validationErrors.length).toBeGreaterThan(0);
    expect(validationErrors[0].error).toContain('unaffordable');
  });

  // ── R7d: chosen_not_in_validated → no-route + llm_rejected_validated ──
  it('R7d: chosen_not_in_validated → no-route with llm_rejected_validated (bestIdx NOT used)', async () => {
    // LLM picks chosenIndex=99 (out of range). Candidate 0 validates fine.
    // JIRA-206: return no-route instead of bestIdx fallback.
    const response = buildLlmResponse([
      {
        stops: [
          { action: 'pickup', load: 'Coal', city: 'Essen' },
          { action: 'deliver', load: 'Coal', city: 'Berlin', demandCardId: 1, payment: 15 },
        ],
        reasoning: 'Coal route',
      },
    ], 99); // chosenIndex=99 — not in validated set

    const context = makeContext({
      money: 50,
      demands: [
        makeDemand({ cardIndex: 1, loadType: 'Coal', supplyCity: 'Essen', deliveryCity: 'Berlin', payout: 15 }),
      ],
    });

    const snapshot = makeSnapshot(50);

    const { brain, chatFn } = makeMockBrain();
    chatFn.mockResolvedValue({ text: response, usage: { input: 100, output: 50 } });

    const planner = new TripPlanner(brain);
    const result = await planner.planTrip(snapshot, context, [], makeMemory());

    // JIRA-206 (R2): chosen_not_in_validated → route: null
    expect(result.route).toBeNull();

    // selection carries the reason
    const r = result as unknown as { route: null; llmLog: LlmAttempt[]; selection?: { llmChosenIndex: number; fallbackReason: string } };
    expect(r.selection).toBeDefined();
    expect(r.selection!.fallbackReason).toBe('llm_rejected_validated');

    // No retry was triggered (we return immediately, not retry)
    expect(chatFn).toHaveBeenCalledTimes(1);
  });

  // ── R7e: chosen_zero_stops still falls back to bestIdx ─────────────────
  it('R7e: chosen_zero_stops (pruned by validator) still falls back to bestIdx', async () => {
    // Candidate 0 validates but returns prunedRoute with zero stops.
    // Candidate 1 validates fine with stops. LLM picks chosenIndex=0 (zero-stop candidate).
    // chosen_zero_stops → bestIdx fallback (not no-route).
    (RouteValidator.validate as jest.Mock).mockImplementation((route: StrategicRoute) => {
      if (route.reasoning === 'Pruned to zero') {
        // Returns prunedRoute with empty stops
        return { valid: true, errors: [], prunedRoute: { stops: [], currentStopIndex: 0, phase: 'build', createdAtTurn: 5, reasoning: 'Pruned to zero' } };
      }
      return { valid: true, errors: [] };
    });

    const response = buildLlmResponse([
      {
        stops: [
          { action: 'pickup', load: 'Coal', city: 'Essen' },
          { action: 'deliver', load: 'Coal', city: 'Berlin', demandCardId: 1, payment: 15 },
        ],
        reasoning: 'Pruned to zero',
      },
      {
        stops: [
          { action: 'pickup', load: 'Wine', city: 'Bordeaux' },
          { action: 'deliver', load: 'Wine', city: 'Paris', demandCardId: 2, payment: 12 },
        ],
        reasoning: 'Valid Wine route',
      },
    ], 0); // LLM picks candidate 0 (gets pruned to zero)

    const context = makeContext({
      money: 50,
      demands: [
        makeDemand({ cardIndex: 1, loadType: 'Coal', supplyCity: 'Essen', deliveryCity: 'Berlin', payout: 15 }),
        makeDemand({ cardIndex: 2, loadType: 'Wine', supplyCity: 'Bordeaux', deliveryCity: 'Paris', payout: 12 }),
      ],
    });

    const snapshot = makeSnapshot(50);

    const { brain, chatFn } = makeMockBrain();
    chatFn.mockResolvedValue({ text: response, usage: { input: 100, output: 50 } });

    const planner = new TripPlanner(brain);
    const result = await planner.planTrip(snapshot, context, [], makeMemory());

    // chosen_zero_stops: bestIdx fallback → route is committed (Wine, the one with stops)
    expect(result.route).not.toBeNull();
    expect(result!.route.stops.some(s => s.loadType === 'Wine')).toBe(true);
    // selection carries chosen_zero_stops reason
    expect(result!.selection).toBeDefined();
    expect(result!.selection!.fallbackReason).toBe('chosen_zero_stops');
  });

  // ── R7f: System prompt includes new on-network-demand rule ─────────────
  it('R7f: system prompt contains on-network demand rule (rule 8)', () => {
    // Use the real systemPrompts module (bypassing the mock at the top of this file)
    const mod = jest.requireActual('../../services/ai/prompts/systemPrompts') as {
      getTripPlanningPrompt: (s: BotSkillLevel, c: GameContext, m: BotMemoryState) => { system: string; user: string };
    };

    const context = makeContext({
      citiesOnNetwork: ['Essen', 'Berlin'],
      demands: [makeDemand()],
    });
    const memory = makeMemory();

    const { system } = mod.getTripPlanningPrompt(BotSkillLevel.Medium, context, memory);

    // The new rule 8 must be present in the system prompt
    expect(system).toContain('ON-NETWORK DEMAND REQUIRED AS CANDIDATE');
    expect(system).toContain('[ON-NETWORK]');
    expect(system).toContain('highest net-value');
  });

  // ── R7g: Affordability retry succeeds on second attempt ────────────────
  it('R7g: affordability filter empty → retry once; LLM returns fundable candidate → route committed', async () => {
    // First attempt: Oil 24M build, bot has $5M cash → unaffordable → retry with hint
    const expensiveResponse = buildLlmResponse([
      {
        stops: [
          { action: 'pickup', load: 'Oil', city: 'Newcastle' },
          { action: 'deliver', load: 'Oil', city: 'Zurich', demandCardId: 89, payment: 25 },
        ],
        reasoning: 'Oil — too expensive',
      },
    ], 0);

    // Second attempt (retry): Cheese 0M build → affordable
    const cheapResponse = buildLlmResponse([
      {
        stops: [
          { action: 'pickup', load: 'Cheese', city: 'Holland' },
          { action: 'deliver', load: 'Cheese', city: 'Cardiff', demandCardId: 88, payment: 15 },
        ],
        reasoning: 'Cheese — on-network, free',
      },
    ], 0);

    const context = makeContext({
      money: 5,
      demands: [
        makeDemand({ cardIndex: 89, loadType: 'Oil', supplyCity: 'Newcastle', deliveryCity: 'Zurich', payout: 25, estimatedTrackCostToSupply: 7, estimatedTrackCostToDelivery: 17 }),
        makeDemand({ cardIndex: 88, loadType: 'Cheese', supplyCity: 'Holland', deliveryCity: 'Cardiff', payout: 15, estimatedTrackCostToSupply: 0, estimatedTrackCostToDelivery: 0 }),
      ],
    });

    const snapshot = makeSnapshot(5); // $5M cash

    const { brain, chatFn } = makeMockBrain();
    chatFn
      .mockResolvedValueOnce({ text: expensiveResponse, usage: { input: 100, output: 50 } }) // attempt 1: unaffordable
      .mockResolvedValueOnce({ text: cheapResponse, usage: { input: 120, output: 60 } }); // attempt 2: fundable

    const planner = new TripPlanner(brain);
    const result = await planner.planTrip(snapshot, context, [], makeMemory());

    // Retry succeeded — route is committed to Cheese
    expect(result.route).not.toBeNull();
    expect(result!.route.stops.some(s => s.loadType === 'Cheese')).toBe(true);
    // Exactly 2 calls: initial (unaffordable) + retry (fundable)
    expect(chatFn).toHaveBeenCalledTimes(2);
    // The retry call should include affordability hint in the user prompt
    const retryCall = chatFn.mock.calls[1][0];
    expect(retryCall.userPrompt).toContain('PREVIOUS ATTEMPT FAILED');
    expect(retryCall.userPrompt).toContain('unaffordable');
  });
});
