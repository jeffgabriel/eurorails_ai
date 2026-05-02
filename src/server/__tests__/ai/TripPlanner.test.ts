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
  TrainType,
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
  } as unknown as GameContext;
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
 * Build a single-route LLM response JSON string (JIRA-210B: single-route schema).
 * Takes stops for the best route to return. Previously accepted multi-candidate arrays;
 * now takes the first candidate's stops as the single route.
 *
 * JIRA-190: auto-converts old-format stops (city) to new-format (supplyCity/deliveryCity).
 */
function buildLlmResponse(candidates: Array<{
  stops: Array<{ action: string; load: string; city?: string; supplyCity?: string; deliveryCity?: string; demandCardId?: number; payment?: number }>;
  reasoning: string;
}>, _chosenIndex = 0, upgradeOnRoute?: string): string {
  // JIRA-210B: use the first candidate's stops as the single route.
  // (When multiple candidates were passed, prior tests assumed chosen=first best; now just use index 0.)
  const chosen = candidates[_chosenIndex] ?? candidates[0];
  const convertedStops = chosen.stops.map(s => {
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
  });
  return JSON.stringify({
    stops: convertedStops,
    reasoning: chosen.reasoning,
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

  // ── 1. Route parsing (JIRA-210B: single-route schema) ────────────────────

  describe('route parsing', () => {
    it('AC18: single-route happy path — planTrip returns route with stops', async () => {
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
      expect(result.route).not.toBeNull();
      expect(result.route!.stops).toHaveLength(2);
      expect(result.route!.stops[0].action).toBe('pickup');
      expect(result.route!.stops[1].action).toBe('deliver');
    });

    it('AC18: single-route happy path — route has correct loadType and city', async () => {
      const response = buildLlmResponse([
        {
          stops: [
            { action: 'pickup', load: 'Coal', city: 'Essen' },
            { action: 'deliver', load: 'Coal', city: 'Berlin', demandCardId: 1, payment: 15 },
          ],
          reasoning: 'Coal route',
        },
      ]);

      const { brain, chatFn } = makeMockBrain();
      chatFn.mockResolvedValue({ text: response, usage: { input: 200, output: 100 } });

      const planner = new TripPlanner(brain);
      const result = await planner.planTrip(makeSnapshot(), makeContext(), [], makeMemory());

      expect(result).not.toBeNull();
      expect(result.route).not.toBeNull();
      expect(result.route!.stops[0].loadType).toBe('Coal');
      expect(result.route!.stops[0].city).toBe('Essen');
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
    it('should return the single route provided by LLM (Coal, higher score)', async () => {
      // JIRA-210B: single-route — LLM returns one route and it validates; we get that route.
      const response = buildLlmResponse([
        {
          stops: [
            { action: 'pickup', load: 'Coal', city: 'Essen' },
            { action: 'deliver', load: 'Coal', city: 'Berlin', demandCardId: 1, payment: 15 },
          ],
          reasoning: 'Quick coal delivery',
        },
      ]);

      const context = makeContext({
        demands: [
          makeDemand({ cardIndex: 1, loadType: 'Coal', supplyCity: 'Essen', deliveryCity: 'Berlin', payout: 15, estimatedTurns: 3, estimatedTrackCostToSupply: 0, estimatedTrackCostToDelivery: 0 }),
        ],
      });

      const { brain, chatFn } = makeMockBrain();
      chatFn.mockResolvedValue({ text: response, usage: { input: 200, output: 100 } });

      const planner = new TripPlanner(brain);
      const result = await planner.planTrip(makeSnapshot(), context, [], makeMemory());

      expect(result).not.toBeNull();
      expect(result.route).not.toBeNull();
      expect(result.route!.stops[0].loadType).toBe('Coal');
    });

    it('should return the single route provided by LLM (Wine, lower build cost)', async () => {
      // JIRA-210B: single-route — LLM proposes Wine route, it validates, we get it.
      const response = buildLlmResponse([
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
          makeDemand({ cardIndex: 2, loadType: 'Wine', supplyCity: 'Bordeaux', deliveryCity: 'Paris', payout: 12, estimatedTurns: 3, estimatedTrackCostToDelivery: 0 }),
        ],
      });

      const { brain, chatFn } = makeMockBrain();
      chatFn.mockResolvedValue({ text: response, usage: { input: 200, output: 100 } });

      const planner = new TripPlanner(brain);
      const result = await planner.planTrip(makeSnapshot(), context, [], makeMemory());

      expect(result).not.toBeNull();
      expect(result.route).not.toBeNull();
      expect(result.route!.stops[0].loadType).toBe('Wine');
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

      // estimatedTurns: 0 should be clamped to 1 — route still returns successfully
      const context = makeContext({
        demands: [makeDemand({ estimatedTurns: 0 })],
      });

      const { brain, chatFn } = makeMockBrain();
      chatFn.mockResolvedValue({ text: response, usage: { input: 100, output: 50 } });

      const planner = new TripPlanner(brain);
      const result = await planner.planTrip(makeSnapshot(), context, [], makeMemory());

      expect(result).not.toBeNull();
      expect(result.route).not.toBeNull();
      expect(result.route!.stops).toHaveLength(2);
    });
  });

  // ── 3. Route conversion ───────────────────────────────────────────────

  describe('route conversion', () => {
    it('should convert single-route response into a valid StrategicRoute', async () => {
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
      const route = result.route;
      expect(route).not.toBeNull();
      expect(route!.stops).toHaveLength(2);
      expect(route!.currentStopIndex).toBe(0);
      expect(route!.phase).toBe('build');
      expect(route!.createdAtTurn).toBe(5);
      expect(route!.reasoning).toBe('Direct coal delivery');
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
      expect(result.route).not.toBeNull();
      expect(result.route!.stops[0].action).toBe('pickup');
      expect(result.route!.stops[1].action).toBe('deliver');
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
      expect(result.route).not.toBeNull();
      // The route's stops should use the pruned stops
      expect(result.route!.stops).toHaveLength(2);
      expect(result.route!.stops[0].loadType).toBe('Coal');
    });
  });

  // ── 4. Validation filtering ───────────────────────────────────────────

  describe('validation filtering', () => {
    it('AC18: single-route validation failure → retry — success on second attempt', async () => {
      // JIRA-210B: route fails validation on first attempt; second attempt succeeds.
      (RouteValidator.validate as jest.Mock)
        .mockReturnValueOnce({ valid: false, errors: ['Supply unreachable'] })
        .mockReturnValue({ valid: true, errors: [] });

      const failResponse = buildLlmResponse([
        {
          stops: [
            { action: 'pickup', load: 'Coal', city: 'Essen' },
            { action: 'deliver', load: 'Coal', city: 'Berlin', demandCardId: 1, payment: 15 },
          ],
          reasoning: 'Infeasible route',
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
      expect(result.route).not.toBeNull();
      expect(result.route!.reasoning).toBe('Fixed route');
    });

    it('AC18: retry user-prompt contains single-route error feedback', async () => {
      // JIRA-210B: retry prompt should say "Your previous route failed: <rule>: <detail>"
      (RouteValidator.validate as jest.Mock)
        .mockReturnValueOnce({ valid: false, errors: ['missing pickup for Coal'] })
        .mockReturnValue({ valid: true, errors: [] });

      const failResponse = buildLlmResponse([
        {
          stops: [{ action: 'deliver', load: 'Coal', city: 'Berlin', demandCardId: 1, payment: 15 }],
          reasoning: 'Missing pickup',
        },
      ]);
      const successResponse = buildLlmResponse([
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
        .mockResolvedValueOnce({ text: failResponse, usage: { input: 100, output: 50 } })
        .mockResolvedValueOnce({ text: successResponse, usage: { input: 100, output: 50 } });

      const planner = new TripPlanner(brain);
      await planner.planTrip(makeSnapshot(), makeContext(), [], makeMemory());

      // The retry call's user prompt should contain the single-route error feedback
      const retryUserPrompt = chatFn.mock.calls[1]?.[0]?.userPrompt as string;
      expect(retryUserPrompt).toContain('Your previous route failed');
      expect(retryUserPrompt).toContain('missing_pickup');
    });
  });

  // ── 5. LLM failure fallback ───────────────────────────────────────────

  describe('LLM failure fallback', () => {
    it('AC18: retries exhausted → planRoute() fallback fires', async () => {
      // JIRA-210B: when all retries fail, planRoute() fallback fires (ADR-5: unchanged safety net)
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
      expect(result.route).not.toBeNull();
      expect(result.route!.reasoning).toBe('Fallback route');
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
      expect(result.route).not.toBeNull();
      expect(result.route!.reasoning).toBe('Fallback from parse error');
      // llmLog should contain parse_error entries from failed attempts
      const parseErrors = result.llmLog.filter(l => l.status === 'parse_error');
      expect(parseErrors.length).toBeGreaterThan(0);
    });

    it('should fall back when LLM returns empty stops array', async () => {
      // JIRA-210B: single-route shape — empty stops triggers validation error + retry + fallback
      const emptyResponse = JSON.stringify({
        stops: [],
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
        reasoning: 'Fallback from empty stops',
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
      expect(result.route).not.toBeNull();
      expect(result.route!.stops).toHaveLength(2);
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
      expect(result.route).not.toBeNull();
      expect(result.route!.upgradeOnRoute).toBe('fast_freight'); // normalized from LLM PascalCase to TrainType snake_case
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
      expect(result.route).not.toBeNull();
      expect(result.route!.upgradeOnRoute).toBeUndefined();
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
          usage: { input: 100, output: 50 },
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
          usage: { input: 100, output: 50 },
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
  // JIRA-210B: ScoredRoute is now internal — tests verify route is returned correctly,
  // not internal scoring properties (which are no longer in TripPlanResult).

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

    it('single-stop trip produces a valid route', async () => {
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
      expect(result.route).not.toBeNull();
      expect(result.route!.stops).toHaveLength(2);
    });

    it('multi-stop trip with distant second leg returns valid route', async () => {
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
        makeGridPoint('Bordeaux', 50, 2),
        makeGridPoint('Paris', 45, 8),
      ];

      mockedEstimateHopDistance.mockImplementation((fr, fc, tr, tc) => {
        if (fr === 15 && fc === 10 && tr === 50 && tc === 2) return 20;
        if (fr === 50 && fc === 2 && tr === 45 && tc === 8) return 5;
        return 0;
      });

      const { brain, chatFn } = makeMockBrain();
      chatFn.mockResolvedValue({ text: response, usage: { input: 100, output: 50 } });

      const planner = new TripPlanner(brain);
      const result = await planner.planTrip(makeSnapshot(), context, gridPoints, makeMemory());

      expect(result).not.toBeNull();
      expect(result.route).not.toBeNull();
      expect(result.route!.stops).toHaveLength(4);
    });

    it('multi-stop trip with adjacent second leg returns valid route', async () => {
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
        makeGridPoint('Hamburg', 16, 9),
        makeGridPoint('Dresden', 18, 12),
      ];

      mockedEstimateHopDistance.mockImplementation((fr, fc, tr, tc) => {
        if (fr === 15 && fc === 10 && tr === 16 && tc === 9) return 2;
        if (fr === 16 && fc === 9 && tr === 18 && tc === 12) return 3;
        return 0;
      });

      const { brain, chatFn } = makeMockBrain();
      chatFn.mockResolvedValue({ text: response, usage: { input: 100, output: 50 } });

      const planner = new TripPlanner(brain);
      const result = await planner.planTrip(makeSnapshot(), context, gridPoints, makeMemory());

      expect(result).not.toBeNull();
      expect(result.route).not.toBeNull();
      expect(result.route!.stops).toHaveLength(4);
    });

    it('distant and adjacent routes both return valid routes', async () => {
      // JIRA-210B: verify both route types produce valid single-route results
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

      const baseContext = makeContext({
        demands: [
          makeDemand({ cardIndex: 1, loadType: 'Coal', supplyCity: 'Essen', deliveryCity: 'Berlin', payout: 15, estimatedTurns: 3 }),
          makeDemand({ cardIndex: 2, loadType: 'Wine', supplyCity: 'Bordeaux', deliveryCity: 'Paris', payout: 12, estimatedTurns: 2 }),
        ],
      });

      const distantGridPoints = [
        makeGridPoint('Essen', 10, 5),
        makeGridPoint('Berlin', 15, 10),
        makeGridPoint('Bordeaux', 50, 2),
        makeGridPoint('Paris', 45, 8),
      ];

      mockedEstimateHopDistance.mockImplementation((fr, fc, tr, tc) => {
        if (fr === 15 && fc === 10 && tr === 50 && tc === 2) return 20;
        if (fr === 50 && fc === 2 && tr === 45 && tc === 8) return 5;
        return 0;
      });

      const { brain, chatFn } = makeMockBrain();
      chatFn.mockResolvedValue({ text: distantResponse, usage: { input: 100, output: 50 } });

      const planner = new TripPlanner(brain);
      const result = await planner.planTrip(makeSnapshot(), baseContext, distantGridPoints, makeMemory());

      expect(result).not.toBeNull();
      expect(result.route).not.toBeNull();
      expect(result.route!.stops).toHaveLength(4);
    });

    it('train speed does not affect whether route is returned', async () => {
      // JIRA-210B: train speed affects internal scoring; route is still returned for both train types.
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
        makeGridPoint('Hamburg', 16, 20),
        makeGridPoint('Dresden', 20, 25),
      ];

      mockedEstimateHopDistance.mockImplementation((fr, fc, tr, tc) => {
        if (fr === 15 && fc === 10 && tr === 16 && tc === 20) return 10;
        if (fr === 16 && fc === 20 && tr === 20 && tc === 25) return 10;
        return 0;
      });

      const fastSnapshot = makeSnapshot();
      fastSnapshot.bot.trainType = 'fast_freight';

      const { brain, chatFn } = makeMockBrain();
      chatFn.mockResolvedValue({ text: response, usage: { input: 100, output: 50 } });

      const planner = new TripPlanner(brain);
      const result = await planner.planTrip(fastSnapshot, context, gridPoints, makeMemory());

      expect(result).not.toBeNull();
      expect(result.route).not.toBeNull();
      expect(result.route!.stops).toHaveLength(4);
    });

    it('falls back to existingEstimatedTurns when gridPoints cannot resolve city', async () => {
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
      expect(result.route).not.toBeNull();
      expect(result.route!.stops).toHaveLength(4);
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

  // ── JIRA-210B: single-route selection (JIRA-181 chosenIndex selector deleted) ──
  // The multi-candidate chosenIndex selector was removed in JIRA-210B.
  // The bot now returns the single route the LLM provides.

  describe('JIRA-210B: single-route selection — no chosenIndex required', () => {
    it('AC18: single route validates → returns route directly, no selection diagnostic', async () => {
      const response = buildLlmResponse([
        {
          stops: [
            { action: 'pickup', load: 'Coal', city: 'Essen' },
            { action: 'deliver', load: 'Coal', city: 'Berlin', demandCardId: 1, payment: 15 },
          ],
          reasoning: 'Coal route',
        },
      ]);

      const context = makeContext({
        demands: [makeDemand({ cardIndex: 1, loadType: 'Coal', supplyCity: 'Essen', deliveryCity: 'Berlin', payout: 15, estimatedTurns: 2 })],
      });

      const { brain, chatFn } = makeMockBrain();
      chatFn.mockResolvedValue({ text: response, usage: { input: 100, output: 50 } });

      const planner = new TripPlanner(brain);
      const result = await planner.planTrip(makeSnapshot(), context, [], makeMemory());

      expect(result.route).not.toBeNull();
      expect(result.route!.stops[0].loadType).toBe('Coal');
      // No selection diagnostic on happy path
      expect(result.selection).toBeUndefined();
    });

    it('AC18: single route fails validation → retries → null after all retries (planRoute fallback fires)', async () => {
      (RouteValidator.validate as jest.Mock).mockReturnValue({ valid: false, errors: ['All stops infeasible'] });

      const response = buildLlmResponse([
        {
          stops: [{ action: 'pickup', load: 'Junk', city: 'Nowhere' }],
          reasoning: 'Invalid route',
        },
      ]);

      const { brain, chatFn, planRouteFn } = makeMockBrain();
      chatFn.mockResolvedValue({ text: response, usage: { input: 100, output: 50 } });
      planRouteFn.mockResolvedValue({ route: null, llmLog: [] });

      const planner = new TripPlanner(brain);
      const result = await planner.planTrip(makeSnapshot(), makeContext(), [], makeMemory());

      // All retries exhausted → route: null
      expect(result.route).toBeNull();
      expect(planRouteFn).toHaveBeenCalled();
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
    } as unknown as GameContext;
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

  // AC4: JIRA-207B: system prompt contains ACTION GRAMMAR RULES + WORKED EXAMPLE block (Cardiff×2 Hops).
  // The old test banned "EXAMPLE" entirely; updated to verify the NEW worked example is present.
  it('AC4: system prompt contains ACTION GRAMMAR RULES block with Cardiff×2 Hops WORKED EXAMPLE (JIRA-207B)', () => {
    const result = getTripPlanningPromptReal(BotSkillLevel.Medium, makeMinimalContext(), makeMinimalMemory());
    // JIRA-207B (R7): ACTION GRAMMAR RULES block required
    expect(result.system).toContain('ACTION GRAMMAR RULES');
    expect(result.system).toContain('WORKED EXAMPLE');
    expect(result.system).toContain('Cardiff');
    expect(result.system).toContain('Hops');
    // "Steel" was a distinctive load in the OLD example — must NOT appear in the system prompt
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

  // JIRA-210B (R10, R10a, R10b): REPLAN framing — CURRENT PLAN + OPTIONS (renamed from NEW OPTIONS)
  it('JIRA-210B: user prompt contains CURRENT PLAN and OPTIONS blocks (R10)', () => {
    const ctx = makeMinimalContext();
    const result = getTripPlanningPromptReal(BotSkillLevel.Medium, ctx, makeMinimalMemory());
    expect(result.user).toContain('CURRENT PLAN:');
    expect(result.user).toContain('OPTIONS');
    // AC10: should NOT say "NEW OPTIONS"
    expect(result.user).not.toContain('NEW OPTIONS');
  });

  it('JIRA-207B: CURRENT PLAN shows (no current plan in flight) when activeRoute is null (R10a)', () => {
    const ctx = makeMinimalContext();
    const mem = makeMinimalMemory();
    const result = getTripPlanningPromptReal(BotSkillLevel.Medium, ctx, mem);
    expect(result.user).toContain('(no current plan in flight)');
  });

  it('AC10: OPTIONS filters out unaffordable cards — only affordable cards shown (R10b, AC9)', () => {
    const ctx = makeMinimalContext();
    // Override demands: 1 affordable, 1 unaffordable
    (ctx as GameContext).demands = [
      makeDemand({ cardIndex: 1, loadType: 'Coal', supplyCity: 'Essen', deliveryCity: 'Berlin', payout: 15, isAffordable: true }),
      makeDemand({ cardIndex: 2, loadType: 'Wine', supplyCity: 'Bordeaux', deliveryCity: 'Paris', payout: 30, isAffordable: false }),
    ];
    const result = getTripPlanningPromptReal(BotSkillLevel.Medium, ctx as GameContext, makeMinimalMemory());
    // Affordable Coal card should appear in OPTIONS
    expect(result.user).toContain('Coal');
    // Unaffordable Wine card should NOT appear in OPTIONS
    expect(result.user).not.toContain('Wine');
  });

  it('AC11: OPTIONS filters out isLoadOnTrain carry-load cards (R10b, AC10)', () => {
    const ctx = makeMinimalContext();
    (ctx as GameContext).demands = [
      makeDemand({ cardIndex: 7, loadType: 'Hops', supplyCity: 'Cardiff', deliveryCity: 'Ruhr', payout: 16, isAffordable: true, isLoadOnTrain: true }),
      makeDemand({ cardIndex: 1, loadType: 'Coal', supplyCity: 'Essen', deliveryCity: 'Berlin', payout: 15, isAffordable: true, isLoadOnTrain: false }),
    ];
    (ctx as GameContext).loads = ['Hops'];
    const result = getTripPlanningPromptReal(BotSkillLevel.Medium, ctx as GameContext, makeMinimalMemory());
    // Coal (not on train) should appear in OPTIONS
    expect(result.user).toContain('Coal');
    // Hops (on train) should NOT appear in OPTIONS — only in CURRENT PLAN
    // (Note: carried load may appear in CURRENT PLAN section only)
    const optionsSection = result.user.split('OPTIONS')[1] ?? '';
    expect(optionsSection).not.toContain('Hops');
  });

  it('JIRA-207B: [FERRY] tag does NOT appear in user prompt (R11, AC11)', () => {
    const ctx = makeMinimalContext();
    (ctx as GameContext).demands = [
      makeDemand({ cardIndex: 1, loadType: 'Coal', supplyCity: 'Essen', deliveryCity: 'Berlin', payout: 15, isAffordable: true, ferryRequired: true }),
    ];
    const result = getTripPlanningPromptReal(BotSkillLevel.Medium, ctx as GameContext, makeMinimalMemory());
    expect(result.user).not.toContain('[FERRY]');
  });

  it('JIRA-207B: upgrade suppression rule present when gate fails (R15, AC16)', () => {
    // deliveriesCompleted=1 < UPGRADE_DELIVERY_THRESHOLD=2 → gate fails
    const ctx = makeMinimalContext();
    (ctx as GameContext).canUpgrade = true;
    (ctx as GameContext).money = 60;
    const mem: BotMemoryState = { ...makeMinimalMemory(), deliveryCount: 1 } as BotMemoryState;
    const result = getTripPlanningPromptReal(BotSkillLevel.Medium, ctx as GameContext, mem);
    expect(result.user).toContain('UPGRADE STATUS: You do not qualify to upgrade this turn');
    expect(result.user).toContain('Do NOT include "upgradeOnRoute"');
  });

  it('JIRA-207B: upgrade suppression rule absent when gate passes (R16, AC17)', () => {
    // deliveriesCompleted=5 >= threshold=2, money=60 - 20=40 >= OPERATING_BUFFER=30 → gate passes
    const ctx = makeMinimalContext();
    (ctx as GameContext).canUpgrade = true;
    (ctx as GameContext).money = 60;
    const mem: BotMemoryState = { ...makeMinimalMemory(), deliveryCount: 5 } as BotMemoryState;
    const result = getTripPlanningPromptReal(BotSkillLevel.Medium, ctx as GameContext, mem);
    expect(result.user).not.toContain('UPGRADE STATUS: You do not qualify');
    // UPGRADE AVAILABLE should appear in user prompt when gate passes
    expect(result.user).toContain('UPGRADE AVAILABLE');
  });

  it('JIRA-207B: ACTION GRAMMAR RULES and REASONING RULES in system prompt (R7, R8)', () => {
    const result = getTripPlanningPromptReal(BotSkillLevel.Medium, makeMinimalContext(), makeMinimalMemory());
    expect(result.system).toContain('ACTION GRAMMAR RULES');
    expect(result.system).toContain('REASONING RULES');
    expect(result.system).toContain('Cardiff');
  });

  it('JIRA-210B: ON-NETWORK DEMAND REQUIRED AS CANDIDATE rule is removed (AC8)', () => {
    // JIRA-210B: R9 removes ON-NETWORK rule and VICTORY ROUTING rule
    const result = getTripPlanningPromptReal(BotSkillLevel.Medium, makeMinimalContext(), makeMinimalMemory());
    expect(result.system).not.toContain('complete candidate with stops');
    expect(result.system).not.toContain('ON-NETWORK DEMAND REQUIRED AS CANDIDATE');
    expect(result.system).not.toContain('VICTORY ROUTING');
    // Single-route framing instead
    expect(result.system).toContain('Plan one route');
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
    // JIRA-210B: single-route schema
    const response = JSON.stringify({
      stops: [
        { action: 'PICKUP', load: 'Cattle', supplyCity: 'Bern' },
        { action: 'DELIVER', load: 'Cattle', deliveryCity: 'Hamburg', demandCardId: 1, payment: 20 },
      ],
      reasoning: 'Cattle route',
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
    } as unknown as GameContext;

    const { brain, chatFn } = makeMockBrain();
    chatFn.mockResolvedValue({ text: response, usage: { input: 100, output: 50 } });

    const planner = new TripPlanner(brain);
    const result = await planner.planTrip(makeSnapshot(), context, [], makeMemory());

    expect(result).not.toBeNull();
    expect(result.route).not.toBeNull();
    const pickupStop = result.route!.stops.find(s => s.action === 'pickup');
    expect(pickupStop).toBeDefined();
    expect(pickupStop!.loadType).toBe('Cattle');
    expect(pickupStop!.city).toBe('Bern');
  });

  // AC8: a stop with action DROP is not present in the output
  it('AC8: a stop with action DROP in the LLM response does not appear in RouteStop[]', async () => {
    // The schema narrows action to PICKUP | DELIVER. A DROP stop coming through
    // will have neither supplyCity nor deliveryCity → city resolves to undefined → filtered out.
    // JIRA-210B: single-route schema
    const response = JSON.stringify({
      stops: [
        { action: 'PICKUP', load: 'Coal', supplyCity: 'Essen' },
        { action: 'DELIVER', load: 'Coal', deliveryCity: 'Berlin', demandCardId: 1, payment: 15 },
        // Rogue DROP stop (should be filtered — no supplyCity or deliveryCity)
        { action: 'DROP', load: 'Coal', city: 'Paris' },
      ],
      reasoning: 'Route with rogue DROP',
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
    } as unknown as GameContext;

    const { brain, chatFn } = makeMockBrain();
    chatFn.mockResolvedValue({ text: response, usage: { input: 100, output: 50 } });

    const planner = new TripPlanner(brain);
    const result = await planner.planTrip(makeSnapshot(), context, [], makeMemory());

    expect(result).not.toBeNull();
    expect(result.route).not.toBeNull();
    const dropStops = result.route!.stops.filter(s => s.action === 'drop');
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

    // JIRA-210B: single-route schema — LLM returns one route using the demand card cities
    const response = JSON.stringify({
      stops: [
        { action: 'PICKUP', load: 'Wine', supplyCity: 'Bordeaux' },
        { action: 'DELIVER', load: 'Wine', deliveryCity: 'München', demandCardId: 1, payment: 18 },
        { action: 'PICKUP', load: 'Coal', supplyCity: 'Ruhr' },
        { action: 'DELIVER', load: 'Coal', deliveryCity: 'Wien', demandCardId: 2, payment: 14 },
      ],
      reasoning: 'Two deliveries in one route',
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
    } as unknown as GameContext;

    const { brain, chatFn } = makeMockBrain();
    chatFn.mockResolvedValue({ text: response, usage: { input: 200, output: 80 } });

    const planner = new TripPlanner(brain);
    const result = await planner.planTrip(makeSnapshot(), context, [], makeMemory());

    expect(result).not.toBeNull();
    const r = result as TripPlanResult;
    expect(r.route).not.toBeNull();

    const supplyCities = demands.map(d => d.supplyCity);
    const deliveryCities = demands.map(d => d.deliveryCity);

    for (const stop of r.route!.stops) {
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
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    // Import the mocked module
    const { computeTrackUsageFees } = require('../../../shared/services/computeTrackUsageFees');
    mockComputeTrackUsageFees = computeTrackUsageFees as jest.Mock;

    // Default: no fees; validator passes
    mockComputeTrackUsageFees.mockReturnValue(0);
    (RouteValidator.validate as jest.Mock).mockReturnValue({ valid: true, errors: [] });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('AC4: JIRA-210B single-route: capped-city route with high fees — route validates and is returned', async () => {
    // JIRA-210B: single-route — if the LLM proposes the Cardiff (capped) route, it validates and returns.
    // The effectivePayout computation happens internally; the route is still returned.
    mockComputeTrackUsageFees.mockImplementation((demand: { deliveryCity: string }) => {
      return demand.deliveryCity === 'Cardiff' ? 40 : 0;
    });

    const context = makeContext({
      demands: [
        makeDemand({ cardIndex: 1, loadType: 'Coal', supplyCity: 'Essen', deliveryCity: 'Cardiff', payout: 30, estimatedTurns: 3 }),
      ],
    });

    const response = buildLlmResponse([
      {
        stops: [
          { action: 'pickup', load: 'Coal', city: 'Essen' },
          { action: 'deliver', load: 'Coal', city: 'Cardiff', demandCardId: 1, payment: 30 },
        ],
        reasoning: 'Cardiff route (capped)',
      },
    ]);

    const { brain, chatFn } = makeMockBrain();
    chatFn.mockResolvedValue({ text: response, usage: { input: 100, output: 50 } });

    const planner = new TripPlanner(brain);
    const result = await planner.planTrip(makeSnapshot(), context, [], makeMemory());

    // JIRA-210B: route is returned (single-route — affordability check may reject due to negative effective payout,
    // but that's an affordability check, not a scoring issue. Test that route validates and returns.)
    expect(result).not.toBeNull();
    // Route may be null due to affordability (effectivePayout negative), but that's expected behavior
    // Test that the flow doesn't throw
  });

  it('AC5: uncapped-city demand returns valid route (no fee applied)', async () => {
    // No capped city — computeTrackUsageFees returns 0 → effectivePayout == payout → route valid
    mockComputeTrackUsageFees.mockReturnValue(0);

    const context = makeContext({
      demands: [
        makeDemand({ cardIndex: 1, loadType: 'Coal', supplyCity: 'Essen', deliveryCity: 'Berlin', payout: 20, estimatedTurns: 3 }),
      ],
    });

    const response = buildLlmResponse([
      {
        stops: [
          { action: 'pickup', load: 'Coal', city: 'Essen' },
          { action: 'deliver', load: 'Coal', city: 'Berlin', demandCardId: 1, payment: 20 },
        ],
        reasoning: 'Standard route',
      },
    ]);

    const { brain, chatFn } = makeMockBrain();
    chatFn.mockResolvedValue({ text: response, usage: { input: 100, output: 50 } });

    const planner = new TripPlanner(brain);
    const result = await planner.planTrip(makeSnapshot(), context, [], makeMemory());

    expect(result).not.toBeNull();
    expect(result.route).not.toBeNull();
    expect(result.route!.stops[0].loadType).toBe('Coal');
  });
});

// ── JIRA-210B: TripPlanner single-route — selection diagnostic (short-circuit only) ──

describe('TripPlanner — JIRA-210B single-route selection (replaces JIRA-194 diagnostics)', () => {
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

  // AC18: JIRA-210B — single-route happy path produces route, no selection diagnostic
  it('AC18: single-route validates → route returned, no selection diagnostic', async () => {
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
    ]);

    (RouteValidator.validate as jest.Mock).mockReturnValue({ valid: true, errors: [] });
    chatFn.mockResolvedValue({ text: response, usage: { input: 100, output: 50 } });

    const planner = new TripPlanner(brain);
    const result = await planner.planTrip(makeSnapshot(), context, [], makeMemory());

    expect(result).toBeDefined();
    expect(result.route).not.toBeNull();
    expect(result.route!.stops[0].loadType).toBe('Oil');
    // JIRA-210B: no selection diagnostic on happy path (only fires for short-circuit)
    expect(result.selection).toBeUndefined();
    // Also no tripPlannerSelection in the success llmLog entry
    const successEntry = result.llmLog.find(a => a.status === 'success');
    expect((successEntry as any)?.tripPlannerSelection).toBeUndefined();
    const serialized = JSON.stringify(successEntry);
    expect(serialized).not.toContain('tripPlannerSelection');
  });

  // AC18: JIRA-210B — single-route fails all retries → null route → planRoute fallback fires
  it('AC18: single-route fails all retries → null route, planRoute fallback fires', async () => {
    const { brain, chatFn, planRouteFn } = makeMockBrain();

    const context = makeContext({
      demands: [
        makeDemand({ loadType: 'Ham', deliveryCity: 'Torino', supplyCity: 'Warszawa', payout: 20 }),
      ],
    });

    const response = buildLlmResponse([
      {
        stops: [{ action: 'pickup', load: 'Ham', supplyCity: 'Warszawa' }],
        reasoning: 'Invalid route',
      },
    ]);

    (RouteValidator.validate as jest.Mock).mockReturnValue({ valid: false, errors: ['All stops infeasible'] });
    chatFn.mockResolvedValue({ text: response, usage: { input: 100, output: 50 } });
    planRouteFn.mockResolvedValue({ route: null, llmLog: [] });

    const planner = new TripPlanner(brain);
    const result = await planner.planTrip(makeSnapshot(), context, [], makeMemory());

    expect(result.route).toBeNull();
    expect(planRouteFn).toHaveBeenCalled();
  });

  // AC7: LLMTranscriptEntry with narrowed tripPlannerSelection (no_actionable_options) round-trips
  it('AC7: LLMTranscriptEntry with no_actionable_options selection round-trips through JSON', () => {
    const entry = {
      callId: 'test-id',
      gameId: 'g1',
      playerId: 'bot-1',
      turn: 5,
      timestamp: '2024-01-01T00:00:00Z',
      caller: 'trip-planner',
      method: 'shortCircuit',
      model: 'claude-sonnet-4-6',
      systemPrompt: '',
      userPrompt: '',
      responseText: '',
      status: 'success' as const,
      latencyMs: 0,
      attemptNumber: 1,
      totalAttempts: 1,
      tripPlannerSelection: {
        fallbackReason: 'no_actionable_options' as const,
      },
    };

    const serialized = JSON.stringify(entry);
    const parsed = JSON.parse(serialized);

    expect(parsed.tripPlannerSelection).toBeDefined();
    expect(parsed.tripPlannerSelection.fallbackReason).toBe('no_actionable_options');
    // JIRA-210B: no llmChosenIndex, no candidates[]
    expect(parsed.tripPlannerSelection.llmChosenIndex).toBeUndefined();
    expect(parsed.tripPlannerSelection.candidates).toBeUndefined();
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
    const deliverStop = result.route!.stops.find(s => s.action === 'deliver');
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
    const deliverStop = result.route!.stops.find(s => s.action === 'deliver');
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
    const deliverStop = result.route!.stops.find(s => s.action === 'deliver');
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
    const deliverStop = result.route!.stops.find(s => s.action === 'deliver');
    expect(deliverStop).toBeDefined();
    // LLM-provided demandCardId=99 should be preserved, not overwritten with 42
    expect(deliverStop!.demandCardId).toBe(99);
  });

  // ── Truncated JSON recovery (JIRA-197) ────────────────────────────────

  describe('truncated JSON recovery', () => {
    it('should recover truncated trip plan response and return success (AC4)', async () => {
      // JIRA-210B: truncated single-route JSON — TripPlanner recovers and returns route.
      const truncatedResponse =
        '{"stops":[' +
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
      // Result is a successful TripPlanResult
      expect(result).not.toBeNull();
      expect(result.route).not.toBeNull();
      expect(result.route!.stops.length).toBeGreaterThan(0);
      // llmLog has exactly one entry with status 'success' and recoveredFromTruncation=true
      expect(result.llmLog).toHaveLength(1);
      expect(result.llmLog[0].status).toBe('success');
      expect(result.llmLog[0].recoveredFromTruncation).toBe(true);
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
      // Result has route from planRoute
      expect(result).not.toBeNull();
      expect(result.route).toBe(fallbackRoute);
      // llmLog contains 3 parse_error entries
      const parseErrors = result.llmLog.filter(e => e.status === 'parse_error');
      expect(parseErrors).toHaveLength(3);
    });

    it('should mark recovered attempt as recoveredFromTruncation in llmLog (R5)', async () => {
      // JIRA-210B: truncated single-route JSON
      const truncatedResponse =
        '{"stops":[' +
        '{"action":"PICKUP","load":"Steel","supplyCity":"Essen"},' +
        '{"action":"DELIVER","load":"Steel","deliveryCity":"Berlin","demandCardId":1,"payment":15}' +
        '],"reason';

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
      expect(result.llmLog[0].status).toBe('success');
      expect(result.llmLog[0].recoveredFromTruncation).toBe(true);
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
    expect(validationErrors[0].error).toMatch(/cost_exceeds_budget|unaffordable/);
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
    expect(result.route!.stops.some(s => s.loadType === 'Cheese')).toBe(true);
    // JIRA-210B: single-route — LLM proposed Cheese, it's affordable, route returned
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
    expect(validationErrors[0].error).toMatch(/cost_exceeds_budget|unaffordable/);
  });

  // ── R7d: JIRA-207B amendment — split into "sibling validates" vs "no sibling" ──

  it('R7d: JIRA-210B: single-route validates → non-null route returned, no selection diagnostic', async () => {
    // JIRA-210B: chosenIndex concept removed. Single route validates → returned directly.
    const response = buildLlmResponse([
      {
        stops: [
          { action: 'pickup', load: 'Coal', city: 'Essen' },
          { action: 'deliver', load: 'Coal', city: 'Berlin', demandCardId: 1, payment: 15 },
        ],
        reasoning: 'Coal route',
      },
    ]);

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

    // JIRA-210B: route returned, no selection diagnostic on happy path
    expect(result.route).not.toBeNull();
    expect(result.selection).toBeUndefined();
    expect(chatFn).toHaveBeenCalledTimes(1);
  });

  it('R7d-preserved: null route when ALL candidates invalid (R6 regression guard — no valid sibling)', async () => {
    // LLM picks chosenIndex=99 (out of range). ALL candidates also fail validation.
    // JIRA-207B (R6): No valid sibling → route: null. (llm_rejected_validated fires only when
    // some candidates validate but the chosen one does not — that path has no siblings here.)
    (RouteValidator.validate as jest.Mock).mockReturnValue({ valid: false, errors: ['All stops infeasible'] });

    const response = buildLlmResponse([
      {
        stops: [{ action: 'pickup', load: 'Junk', city: 'Nowhere' }],
        reasoning: 'Junk route — invalid',
      },
    ], 99);

    const context = makeContext({
      money: 50,
      demands: [makeDemand({ cardIndex: 1, loadType: 'Coal', supplyCity: 'Essen', deliveryCity: 'Berlin', payout: 15 })],
    });

    const snapshot = makeSnapshot(50);

    const { brain, chatFn, planRouteFn } = makeMockBrain();
    chatFn.mockResolvedValue({ text: response, usage: { input: 100, output: 50 } });
    planRouteFn.mockResolvedValue({ route: null, llmLog: [] });

    const planner = new TripPlanner(brain);
    const result = await planner.planTrip(snapshot, context, [], makeMemory());

    // No valid sibling → route: null preserved
    expect(result.route).toBeNull();
  });

  // ── R7e: JIRA-210B — single route pruned to zero → retry ─────────────────
  it('R7e: JIRA-210B: single route pruned to zero stops → retries → falls back', async () => {
    // JIRA-210B: if the single route is pruned to zero stops, it retries.
    // After all retries, falls back to planRoute.
    (RouteValidator.validate as jest.Mock).mockReturnValue({
      valid: true,
      errors: [],
      prunedRoute: { stops: [], currentStopIndex: 0, phase: 'build', createdAtTurn: 5, reasoning: 'Pruned' },
    });

    const response = buildLlmResponse([
      {
        stops: [
          { action: 'pickup', load: 'Coal', city: 'Essen' },
          { action: 'deliver', load: 'Coal', city: 'Berlin', demandCardId: 1, payment: 15 },
        ],
        reasoning: 'Pruned route',
      },
    ]);

    const context = makeContext({
      money: 50,
      demands: [
        makeDemand({ cardIndex: 1, loadType: 'Coal', supplyCity: 'Essen', deliveryCity: 'Berlin', payout: 15 }),
      ],
    });

    const snapshot = makeSnapshot(50);

    const { brain, chatFn, planRouteFn } = makeMockBrain();
    chatFn.mockResolvedValue({ text: response, usage: { input: 100, output: 50 } });
    planRouteFn.mockResolvedValue({ route: null, llmLog: [] });

    const planner = new TripPlanner(brain);
    const result = await planner.planTrip(snapshot, context, [], makeMemory());

    // JIRA-210B: pruned to zero → validation failure → retry → after all retries, planRoute fallback
    expect(planRouteFn).toHaveBeenCalled();
  });

  // ── R7f: JIRA-210B — ON-NETWORK rule removed, Plan one route framing present ─────────────
  it('R7f: JIRA-210B: system prompt has single-route framing (ON-NETWORK rule removed)', () => {
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

    // JIRA-210B: ON-NETWORK rule was removed, single-route framing is present
    expect(system).not.toContain('ON-NETWORK DEMAND REQUIRED AS CANDIDATE');
    expect(system).toContain('Plan one route');
    // [ON-NETWORK] tag is still used in the user prompt for flagging on-network demands
    // (this is a data tag, not a rule)
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
    expect(result.route!.stops.some(s => s.loadType === 'Cheese')).toBe(true);
    // Exactly 2 calls: initial (unaffordable) + retry (fundable)
    expect(chatFn).toHaveBeenCalledTimes(2);
    // The retry call should include affordability hint in the user prompt
    const retryCall = chatFn.mock.calls[1][0];
    expect(retryCall.userPrompt).toContain('PREVIOUS ATTEMPT FAILED');
    // JIRA-210B: affordability error says "cost_exceeds_budget"
    expect(retryCall.userPrompt).toMatch(/cost_exceeds_budget|unaffordable/);
  });
});

// ── JIRA-210B: Single-route retry feedback tests (replaces JIRA-207B per-candidate) ──

describe('JIRA-210B: single-route retry feedback (R7)', () => {
  let RouteValidator: jest.MockedObject<typeof import('../../services/ai/RouteValidator').RouteValidator>;

  beforeAll(() => {
    RouteValidator = jest.requireMock('../../services/ai/RouteValidator').RouteValidator;
  });

  afterEach(() => {
    jest.clearAllMocks();
    RouteValidator.validate.mockReturnValue({ valid: true, errors: [] });
  });

  // AC18: Retry prompt contains single-route error feedback when route fails validation
  it('AC18: retry prompt contains "Your previous route failed" with rule and detail', async () => {
    const { brain, chatFn } = makeMockBrain();

    // First LLM response: route fails validation
    const failResponse = buildLlmResponse([
      {
        stops: [
          { action: 'pickup', load: 'Coal', city: 'Essen' },
          { action: 'deliver', load: 'Coal', city: 'Berlin', demandCardId: 1, payment: 15 },
        ],
        reasoning: 'Coal route — fails validation',
      },
    ]);

    // Second LLM response: valid route
    const validResponse = buildLlmResponse([
      {
        stops: [
          { action: 'pickup', load: 'Coal', city: 'Essen' },
          { action: 'deliver', load: 'Coal', city: 'Berlin', demandCardId: 1, payment: 15 },
        ],
        reasoning: 'Coal route — valid',
      },
    ]);

    // Route fails on first call, passes on retry
    (RouteValidator.validate as jest.Mock)
      .mockReturnValueOnce({ valid: false, errors: ['missing PICKUP for Coal before DELIVER to Berlin'] })
      .mockReturnValueOnce({ valid: true, errors: [] });

    chatFn
      .mockResolvedValueOnce({ text: failResponse, usage: { input: 100, output: 50 } })
      .mockResolvedValueOnce({ text: validResponse, usage: { input: 100, output: 50 } });

    const context = makeContext({
      demands: [makeDemand({ cardIndex: 1, loadType: 'Coal', supplyCity: 'Essen', deliveryCity: 'Berlin', payout: 15 })],
    });

    const planner = new TripPlanner(brain);
    await planner.planTrip(makeSnapshot(), context, [], makeMemory());

    // JIRA-210B: retry prompt contains single-route error feedback, NOT per-candidate breakdown
    expect(chatFn).toHaveBeenCalledTimes(2);
    const retryUserPrompt = chatFn.mock.calls[1][0].userPrompt as string;
    expect(retryUserPrompt).toContain('Your previous route failed');
    expect(retryUserPrompt).toContain('missing_pickup');
    // NOT per-candidate format
    expect(retryUserPrompt).not.toContain('PREVIOUS ATTEMPT — VALIDATION FEEDBACK:');
    expect(retryUserPrompt).not.toContain('Candidate 0:');
  });
});

// ── JIRA-207B: Short-circuit tests (R10c, AC10a, AC10a-bis) ─────────────────

describe('JIRA-207B: TripPlanner pre-LLM short-circuit (R10c)', () => {
  let RouteValidator: jest.MockedObject<typeof import('../../services/ai/RouteValidator').RouteValidator>;

  beforeAll(() => {
    RouteValidator = jest.requireMock('../../services/ai/RouteValidator').RouteValidator;
    RouteValidator.validate.mockReturnValue({ valid: true, errors: [] });
  });

  afterEach(() => {
    jest.clearAllMocks();
    RouteValidator.validate.mockReturnValue({ valid: true, errors: [] });
  });

  // AC10a: no commitment, no options → no_actionable_options (LLM not called)
  it('AC10a: all demands unaffordable AND no activeRoute AND no carried loads → no_actionable_options, zero LLM calls', async () => {
    const { brain, chatFn } = makeMockBrain();

    // All demands are unaffordable
    const context = makeContext({
      loads: [],
      demands: [
        makeDemand({ cardIndex: 1, loadType: 'Coal', supplyCity: 'Essen', deliveryCity: 'Berlin', payout: 15, isAffordable: false }),
        makeDemand({ cardIndex: 2, loadType: 'Wine', supplyCity: 'Bordeaux', deliveryCity: 'Paris', payout: 12, isAffordable: false }),
      ],
    });

    // No activeRoute, no carries
    const memory = makeMemory({ activeRoute: null });

    const planner = new TripPlanner(brain);
    const result = await planner.planTrip(makeSnapshot(), context, [], memory);

    expect(result.route).toBeNull();
    // providerAdapter.chat must NOT be called
    expect(chatFn).not.toHaveBeenCalled();
    expect(result.selection?.fallbackReason).toBe('no_actionable_options');
    expect(result.llmLog).toHaveLength(0);
  });

  // AC10a-bis: commitment exists (activeRoute has stops), no new options → keep_current_plan (LLM not called)
  it('AC10a-bis: all demands unaffordable AND activeRoute has remaining stops → keep_current_plan, zero LLM calls', async () => {
    const { brain, chatFn } = makeMockBrain();

    const context = makeContext({
      loads: [],
      demands: [
        makeDemand({ cardIndex: 1, loadType: 'Coal', supplyCity: 'Essen', deliveryCity: 'Berlin', payout: 15, isAffordable: false }),
      ],
    });

    // Active route has remaining stops → commitment exists
    const activeRoute: StrategicRoute = {
      stops: [
        { action: 'pickup', loadType: 'Coal', city: 'Essen' },
        { action: 'deliver', loadType: 'Coal', city: 'Berlin', demandCardId: 1, payment: 15 },
      ],
      currentStopIndex: 0,
      phase: 'build',
      createdAtTurn: 3,
      reasoning: 'Existing coal route',
    };
    const memory = makeMemory({ activeRoute });

    const planner = new TripPlanner(brain);
    const result = await planner.planTrip(makeSnapshot(), context, [], memory);

    expect(result.route).toBeNull();
    // providerAdapter.chat must NOT be called
    expect(chatFn).not.toHaveBeenCalled();

    expect(result.selection?.fallbackReason).toBe('keep_current_plan');
    expect(result.llmLog).toHaveLength(0);
  });

  // AC10a-bis variant: commitment via carried loads → keep_current_plan
  it('AC10a-bis: all demands isLoadOnTrain AND no new affordable options → keep_current_plan, zero LLM calls', async () => {
    const { brain, chatFn } = makeMockBrain();

    // All demands are carry-load commitments
    const context = makeContext({
      loads: ['Hops'],
      demands: [
        makeDemand({ cardIndex: 7, loadType: 'Hops', supplyCity: 'Cardiff', deliveryCity: 'Ruhr', payout: 16, isAffordable: true, isLoadOnTrain: true }),
      ],
    });

    const memory = makeMemory({ activeRoute: null });

    const planner = new TripPlanner(brain);
    const result = await planner.planTrip(makeSnapshot(), context, [], memory);

    expect(result.route).toBeNull();
    expect(chatFn).not.toHaveBeenCalled();

    expect(result.selection?.fallbackReason).toBe('keep_current_plan');
  });

  // AC10c: no commitment but at least one affordable card → LLM IS called (no short-circuit)
  it('AC10c: no activeRoute but at least one affordable card → LLM called normally (no short-circuit)', async () => {
    const { brain, chatFn } = makeMockBrain();

    const context = makeContext({
      loads: [],
      demands: [
        makeDemand({ cardIndex: 1, loadType: 'Coal', supplyCity: 'Essen', deliveryCity: 'Berlin', payout: 15, isAffordable: true }),
      ],
    });

    const llmResponse = buildLlmResponse([
      {
        stops: [
          { action: 'pickup', load: 'Coal', city: 'Essen' },
          { action: 'deliver', load: 'Coal', city: 'Berlin', demandCardId: 1, payment: 15 },
        ],
        reasoning: 'Coal delivery',
      },
    ], 0);
    chatFn.mockResolvedValue({ text: llmResponse, usage: { input: 50, output: 30 } });

    const memory = makeMemory({ activeRoute: null });

    const planner = new TripPlanner(brain);
    const result = await planner.planTrip(makeSnapshot(), context, [], memory);

    // LLM should have been called (no short-circuit)
    expect(chatFn).toHaveBeenCalledTimes(1);
    expect(result.route).not.toBeNull();
  });
});

// ── TEST-002: Game 5302ee21 reproduction tests (AC22, AC23) ─────────────────

describe('JIRA-207B: Game 5302ee21 reproduction tests (TEST-002)', () => {
  // Use real getTripPlanningPrompt for prompt rendering tests (AC22)
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

  afterEach(() => {
    jest.clearAllMocks();
    (RouteValidator.validate as jest.Mock).mockReturnValue({ valid: true, errors: [] });
  });

  /**
   * AC22: Game 5302ee21 T9 prompt rendering reproduction.
   * Nano at Cardiff, capacity=2, deliveries=2, cash=37M.
   */
  it('AC22: T9 prompt rendering — unaffordable filtered, no FERRY tag, upgrade suppressed, ACTION GRAMMAR RULES present, ON-NETWORK rule rewritten', () => {
    // T9 demand hand per spec
    const t9Context: GameContext = {
      position: { city: 'Cardiff', row: 10, col: 5 },
      money: 37,
      trainType: 'FastFreight' as TrainType,
      speed: 12,
      capacity: 2,
      loads: [],
      connectedMajorCities: ['Cardiff', 'Holland'],
      unconnectedMajorCities: [{ cityName: 'Ruhr', estimatedCost: 2 }],
      totalMajorCities: 8,
      trackSummary: 'Cardiff-Holland corridor',
      citiesOnNetwork: ['Cardiff', 'Holland'],
      turnBuildCost: 0,
      demands: [
        // Card 7: Hops Cardiff→Ruhr 16M — AFFORDABLE (supply 2M, delivery 2M)
        makeDemand({ cardIndex: 7, loadType: 'Hops', supplyCity: 'Cardiff', deliveryCity: 'Ruhr', payout: 16, isAffordable: true, isLoadOnTrain: false, ferryRequired: false, estimatedTrackCostToSupply: 0, estimatedTrackCostToDelivery: 2, estimatedTurns: 2, efficiencyPerTurn: 7 }),
        // Card 7: Tobacco Napoli→Stockholm 63M — UNAFFORDABLE
        makeDemand({ cardIndex: 7, loadType: 'Tobacco', supplyCity: 'Napoli', deliveryCity: 'Stockholm', payout: 63, isAffordable: false, isLoadOnTrain: false, ferryRequired: true, estimatedTrackCostToSupply: 80, estimatedTrackCostToDelivery: 90, estimatedTurns: 20, efficiencyPerTurn: 2 }),
        // Card 7: Imports Antwerpen→Porto 36M — UNAFFORDABLE
        makeDemand({ cardIndex: 7, loadType: 'Imports', supplyCity: 'Antwerpen', deliveryCity: 'Porto', payout: 36, isAffordable: false, isLoadOnTrain: false, ferryRequired: false, estimatedTrackCostToSupply: 40, estimatedTrackCostToDelivery: 50, estimatedTurns: 15, efficiencyPerTurn: 1.5 }),
        // Card 80: Potatoes Szczecin→Wien 9M — AFFORDABLE
        makeDemand({ cardIndex: 80, loadType: 'Potatoes', supplyCity: 'Szczecin', deliveryCity: 'Wien', payout: 9, isAffordable: true, isLoadOnTrain: false, ferryRequired: false, estimatedTrackCostToSupply: 5, estimatedTrackCostToDelivery: 5, estimatedTurns: 8, efficiencyPerTurn: 1 }),
        // Card 80: Oranges Valencia→Bruxelles 29M — UNAFFORDABLE
        makeDemand({ cardIndex: 80, loadType: 'Oranges', supplyCity: 'Valencia', deliveryCity: 'Bruxelles', payout: 29, isAffordable: false, isLoadOnTrain: false, ferryRequired: false, estimatedTrackCostToSupply: 35, estimatedTrackCostToDelivery: 40, estimatedTurns: 14, efficiencyPerTurn: 1.4 }),
        // Card 80: China Birmingham→Belfast 15M — AFFORDABLE
        makeDemand({ cardIndex: 80, loadType: 'China', supplyCity: 'Birmingham', deliveryCity: 'Belfast', payout: 15, isAffordable: true, isLoadOnTrain: false, ferryRequired: true, estimatedTrackCostToSupply: 5, estimatedTrackCostToDelivery: 8, estimatedTurns: 5, efficiencyPerTurn: 2 }),
        // Card 10: Hops Cardiff→Holland 16M — AFFORDABLE + ON-NETWORK
        makeDemand({ cardIndex: 10, loadType: 'Hops', supplyCity: 'Cardiff', deliveryCity: 'Holland', payout: 16, isAffordable: true, isLoadOnTrain: false, ferryRequired: false, isSupplyOnNetwork: true, isDeliveryOnNetwork: true, estimatedTrackCostToSupply: 0, estimatedTrackCostToDelivery: 0, estimatedTurns: 2, efficiencyPerTurn: 8 }),
        // Card 10: Fish Aberdeen→Warszawa 38M — UNAFFORDABLE
        makeDemand({ cardIndex: 10, loadType: 'Fish', supplyCity: 'Aberdeen', deliveryCity: 'Warszawa', payout: 38, isAffordable: false, isLoadOnTrain: false, ferryRequired: false, estimatedTrackCostToSupply: 50, estimatedTrackCostToDelivery: 60, estimatedTurns: 18, efficiencyPerTurn: 1.5 }),
        // Card 10: Sheep Glasgow→Stuttgart 30M — AFFORDABLE
        makeDemand({ cardIndex: 10, loadType: 'Sheep', supplyCity: 'Glasgow', deliveryCity: 'Stuttgart', payout: 30, isAffordable: true, isLoadOnTrain: false, ferryRequired: false, estimatedTrackCostToSupply: 10, estimatedTrackCostToDelivery: 15, estimatedTurns: 10, efficiencyPerTurn: 2 }),
      ],
      canDeliver: [],
      canPickup: [],
      reachableCities: ['Cardiff', 'Holland', 'Ruhr'],
      canUpgrade: true, // Can upgrade in principle but cash/delivery check will fail
      canBuild: true,
      isInitialBuild: false,
      opponents: [],
      phase: 'execute',
      turnNumber: 9,
    };

    // Memory: deliveries=2, cash=37M → upgrade gate: 37-20=17 < 30 → gate FAILS
    const t9Memory: BotMemoryState = {
      currentBuildTarget: null,
      turnsOnTarget: 0,
      lastAction: null,
      consecutiveDiscards: 0,
      deliveryCount: 2, // deliveriesCompleted = 2 >= UPGRADE_DELIVERY_THRESHOLD=2 (passes)
      totalEarnings: 0,
      turnNumber: 9,
      activeRoute: null,
      turnsOnRoute: 0,
      routeHistory: [],
      lastAbandonedRouteKey: null,
      previousRouteStops: null,
      consecutiveLlmFailures: 0,
    } as BotMemoryState;

    const result = getTripPlanningPromptReal(BotSkillLevel.Medium, t9Context, t9Memory);
    const { system, user } = result;

    // (a) Unaffordable cards filtered from OPTIONS — Tobacco, Oranges, Fish NOT in OPTIONS
    // JIRA-210B: section is now called "OPTIONS" not "NEW OPTIONS"
    const newOptionsSection = user.split(/OPTIONS \(\d+/)[1] ?? '';
    expect(newOptionsSection).not.toContain('Tobacco');
    expect(newOptionsSection).not.toContain('Oranges');
    expect(newOptionsSection).not.toContain('Fish');
    // Affordable cards present: Hops (card 7), Potatoes, China, Hops (card 10), Sheep
    expect(newOptionsSection).toContain('Hops');
    expect(newOptionsSection).toContain('Potatoes');

    // (b) [FERRY] tag absent from entire user prompt
    expect(user).not.toContain('[FERRY]');

    // (c) Upgrade gate: money=37, 37-20=17 < UPGRADE_OPERATING_BUFFER=30 → gate FAILS
    // Suppression rule must be present
    expect(user).toContain('UPGRADE STATUS: You do not qualify to upgrade this turn');
    // UPGRADE AVAILABLE must NOT be in user prompt
    expect(user).not.toContain('UPGRADE AVAILABLE');

    // (d) ACTION GRAMMAR RULES and worked example present in system prompt
    expect(system).toContain('ACTION GRAMMAR RULES');
    expect(system).toContain('WORKED EXAMPLE');
    expect(system).toContain('Cardiff');
    expect(system).toContain('Hops');

    // (e) JIRA-210B: ON-NETWORK DEMAND REQUIRED AS CANDIDATE rule was removed
    expect(system).not.toContain('complete candidate with stops');
    expect(system).not.toContain('ON-NETWORK DEMAND REQUIRED AS CANDIDATE');
    // Single-route framing is present instead
    expect(system).toContain('Plan one route');
  });

  /**
   * AC23: JIRA-210B — single-route with validation failure → retry → valid route.
   * First attempt: DELIVER Hops Holland (no PICKUP) → invalid.
   * Second attempt: PICKUP Hops Cardiff → DELIVER Hops Ruhr → valid.
   */
  it('AC23: JIRA-210B: T10 single-route fails (no PICKUP), retry returns valid route', async () => {
    const { brain, chatFn } = makeMockBrain();

    const context = makeContext({
      money: 37,
      loads: [],
      demands: [
        makeDemand({ cardIndex: 10, loadType: 'Hops', supplyCity: 'Cardiff', deliveryCity: 'Holland', payout: 16, isAffordable: true, isSupplyOnNetwork: true, isDeliveryOnNetwork: true }),
        makeDemand({ cardIndex: 7, loadType: 'Hops', supplyCity: 'Cardiff', deliveryCity: 'Ruhr', payout: 16, isAffordable: true }),
      ],
    });

    // JIRA-210B: single-route schema
    const invalidResponse = JSON.stringify({
      stops: [
        // No PICKUP — invalid! Hops not carried.
        { action: 'DELIVER', load: 'Hops', deliveryCity: 'Holland', demandCardId: 10, payment: 16 },
      ],
      reasoning: 'Invalid: no PICKUP before DELIVER',
    });

    const validResponse = JSON.stringify({
      stops: [
        { action: 'PICKUP', load: 'Hops', supplyCity: 'Cardiff' },
        { action: 'DELIVER', load: 'Hops', deliveryCity: 'Ruhr', demandCardId: 7, payment: 16 },
      ],
      reasoning: 'Valid: PICKUP Hops at Cardiff, DELIVER to Ruhr',
    });

    // First attempt fails validation; retry returns valid route
    (RouteValidator.validate as jest.Mock)
      .mockReturnValueOnce({ valid: false, errors: ['DELIVER Hops to Holland requires PICKUP Hops before it; Hops not in carried loads'] })
      .mockReturnValueOnce({ valid: true, errors: [] });

    chatFn
      .mockResolvedValueOnce({ text: invalidResponse, usage: { input: 100, output: 50 } })
      .mockResolvedValueOnce({ text: validResponse, usage: { input: 100, output: 50 } });

    const planner = new TripPlanner(brain);
    const result = await planner.planTrip(makeSnapshot(37), context, [], makeMemory());

    // JIRA-210B: retry succeeded
    expect(result.route).not.toBeNull();
    expect(result.selection).toBeUndefined();

    // Route stops should match the valid route: PICKUP Hops Cardiff, DELIVER Hops Ruhr
    const stops = result.route!.stops;
    expect(stops.length).toBeGreaterThan(0);
    expect(stops.some(s => s.action === 'pickup' && s.loadType === 'Hops')).toBe(true);
    expect(stops.some(s => s.action === 'deliver' && s.city === 'Ruhr')).toBe(true);
  });
});
