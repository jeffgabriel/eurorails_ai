/**
 * TripPlannerMedium.test.ts — Tests for Medium-skill specific TripPlanner behavior.
 *
 * Covers AC6-AC13 from the Strategic Trip Planning spec:
 * - AC6: Easy system prompt byte-stable
 * - AC7: Hard system prompt byte-stable
 * - AC8: Medium system prompt composed as 3 blocks; user has strategic context
 * - AC9: propose accepted when valid + feasible + higher score
 * - AC10: propose rejected (validation_failed / infeasible / worse_score) with log
 * - AC11: chosenOver-empty retry when ≥2 viable alternatives
 * - AC12: no retry on empty chosenOver when only 1 viable option
 * - AC13: Easy behavior unchanged (regression guard)
 */

import { TripPlanner } from '../../services/ai/TripPlanner';
import { RouteValidator } from '../../services/ai/RouteValidator';
import { RouteOptimizer } from '../../services/ai/RouteOptimizer';
import { TRIP_PLANNING_SYSTEM_SUFFIX, TRIP_REASONING_STRUCTURE, TRIP_PROPOSE_LATITUDE, getTripPlanningPrompt } from '../../services/ai/prompts/systemPrompts';
import {
  BotSkillLevel,
  BotMemoryState,
  GameContext,
  GridPoint,
  WorldSnapshot,
  DemandContext,
  TrainType,
} from '../../../shared/types/GameTypes';

// ── Mock modules ────────────────────────────────────────────────────────

jest.mock('../../services/ai/RouteValidator');
jest.mock('../../services/ai/RouteOptimizer', () => ({
  RouteOptimizer: {
    orderStopsByProximity: jest.fn((stops: unknown[]) => stops),
  },
}));
jest.mock('../../services/ai/schemas', () => ({
  TRIP_PLAN_SCHEMA: { type: 'object' },
  TRIP_PLAN_SCHEMA_MEDIUM: { type: 'object' },
}));
jest.mock('../../services/ai/MapTopology', () => ({
  estimateHopDistance: jest.fn(() => 0),
  loadGridPoints: jest.fn(() => []),
}));
jest.mock('../../../shared/services/computeTrackUsageFees', () => ({
  computeTrackUsageFees: jest.fn(() => 0),
}));
jest.mock('../../services/ai/RouteDetourEstimator', () => ({
  simulateTrip: jest.fn(() => ({ feasible: true, turnsToComplete: 3, totalBuildCost: 5 })),
}));
jest.mock('../../services/ai/StrategicContextBuilder', () => ({
  build: jest.fn(() => ({
    phaseSnapshot: { turn: 10, deliveries: 3, citiesConnected: 2 },
    victoryTargets: [{ cityName: 'Madrid', estimatedCost: 40, handAffinityCount: 0 }],
    capital: { cash: 80, targetGap: 170, recentIncomeVelocity: 15, projectedTurnsToVictoryCash: 12 },
    handStaleness: [],
    opponents: [],
  })),
  renderStrategicContext: jest.fn(() => 'STRATEGIC CONTEXT (turn 10):\n- Deliveries completed: 3\n'),
}));

// ── Fixtures ─────────────────────────────────────────────────────────

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
    estimatedTrackCostToDelivery: 5,
    isLoadAvailable: true,
    isLoadOnTrain: false,
    ferryRequired: false,
    loadChipTotal: 4,
    loadChipCarried: 0,
    estimatedTurns: 3,
    demandScore: 3,
    efficiencyPerTurn: 3,
    networkCitiesUnlocked: 2,
    victoryMajorCitiesEnRoute: 0,
    isAffordable: true,
    projectedFundsAfterDelivery: 95,
    ...overrides,
  };
}

function makeContext(overrides: Partial<GameContext> = {}): GameContext {
  return {
    position: { city: 'Berlin', row: 10, col: 15 },
    money: 80,
    trainType: TrainType.Freight,
    speed: 9,
    capacity: 2,
    loads: [],
    connectedMajorCities: ['Berlin', 'Paris'],
    unconnectedMajorCities: [{ cityName: 'Madrid', estimatedCost: 40 }],
    totalMajorCities: 8,
    trackSummary: '5 segments',
    turnBuildCost: 0,
    demands: [makeDemand()],
    canDeliver: [],
    canPickup: [],
    reachableCities: ['Berlin', 'Essen'],
    citiesOnNetwork: ['Berlin', 'Essen'],
    canUpgrade: false,
    canBuild: true,
    isInitialBuild: false,
    opponents: [],
    phase: 'mid',
    turnNumber: 10,
    ...overrides,
  };
}

function makeMemory(overrides: Partial<BotMemoryState> = {}): BotMemoryState {
  return {
    currentBuildTarget: null,
    turnsOnTarget: 0,
    lastAction: null,
    consecutiveDiscards: 0,
    deliveryCount: 3,
    totalEarnings: 45,
    turnNumber: 10,
    activeRoute: null,
    turnsOnRoute: 0,
    routeHistory: [],
    consecutiveLlmFailures: 0,
    recentDeliveries: [{ turn: 8, payout: 15 }],
    cardAcquisitionTurn: { 1: 5 },
    ...overrides,
  };
}

function makeSnapshot(skillLevel: BotSkillLevel = BotSkillLevel.Medium): WorldSnapshot {
  return {
    gameId: 'game-1',
    gameStatus: 'active',
    turnNumber: 10,
    bot: {
      playerId: 'bot-1',
      userId: 'user-1',
      money: 80,
      position: { row: 10, col: 15 },
      existingSegments: [],
      demandCards: [1],
      resolvedDemands: [],
      trainType: TrainType.Freight,
      loads: [],
      botConfig: { skillLevel },
      connectedMajorCityCount: 2,
    },
    allPlayerTracks: [],
    loadAvailability: { Essen: ['Coal'] },
  };
}

function makeBrain(skillLevel: BotSkillLevel, chatFn: jest.Mock) {
  return {
    strategyConfig: { skillLevel },
    providerAdapter: {
      setContext: jest.fn(),
      chat: chatFn,
    },
    modelName: 'mock-model',
    planRoute: jest.fn().mockResolvedValue({ route: null, latencyMs: 0, tokenUsage: { input: 0, output: 0 }, llmLog: [] }),
  } as any;
}

function makeValidResponse(stops: object[] = [], reasoning: object | string = 'good route') {
  return JSON.stringify({ stops, reasoning });
}

// ── AC6 & AC7: Easy and Hard system prompt byte-stability ─────────────

describe('getTripPlanningPrompt — skill-level regression guard', () => {
  it('AC6: Easy skill returns TRIP_PLANNING_SYSTEM_SUFFIX byte-for-byte', () => {
    const context = makeContext();
    const memory = makeMemory();
    const { system } = getTripPlanningPrompt(BotSkillLevel.Easy, context, memory);
    expect(system).toBe(TRIP_PLANNING_SYSTEM_SUFFIX);
  });

  it('AC7: Hard skill returns TRIP_PLANNING_SYSTEM_SUFFIX byte-for-byte', () => {
    const context = makeContext();
    const memory = makeMemory();
    const { system } = getTripPlanningPrompt(BotSkillLevel.Hard, context, memory);
    expect(system).toBe(TRIP_PLANNING_SYSTEM_SUFFIX);
  });

  it('AC8: Medium + strategicContext composes MEDIUM_SYSTEM as 3 blocks joined by \\n\\n', () => {
    const { build: mockBuild, renderStrategicContext: mockRender } = require('../../services/ai/StrategicContextBuilder');
    const ctx = mockBuild();
    const context = makeContext();
    const memory = makeMemory();

    const { system, user } = getTripPlanningPrompt(BotSkillLevel.Medium, context, memory, ctx);

    const expectedSystem = [TRIP_PLANNING_SYSTEM_SUFFIX, TRIP_REASONING_STRUCTURE, TRIP_PROPOSE_LATITUDE].join('\n\n');
    expect(system).toBe(expectedSystem);

    // User prompt must contain the rendered strategic context between CURRENT PLAN and OPTIONS
    expect(user).toContain('CURRENT PLAN:');
    expect(user).toContain('STRATEGIC CONTEXT');
    expect(user).toContain('OPTIONS');
    // strategic context should appear after CURRENT PLAN and before OPTIONS
    const cpIdx = user.indexOf('CURRENT PLAN:');
    const scIdx = user.indexOf('STRATEGIC CONTEXT');
    const optIdx = user.indexOf('OPTIONS');
    expect(scIdx).toBeGreaterThan(cpIdx);
    expect(optIdx).toBeGreaterThan(scIdx);
  });

  it('AC8: Medium without strategicContext uses byte-stable system prompt', () => {
    const context = makeContext();
    const memory = makeMemory();
    const { system } = getTripPlanningPrompt(BotSkillLevel.Medium, context, memory);
    expect(system).toBe(TRIP_PLANNING_SYSTEM_SUFFIX);
  });
});

// ── AC9: Propose accepted ─────────────────────────────────────────────

describe('TripPlanner.planTrip — propose acceptance (AC9)', () => {
  beforeEach(() => {
    (RouteValidator.validate as jest.Mock).mockReturnValue({ valid: true, errors: [] });
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('AC9: accepts propose.stops when valid + feasible + higher score', async () => {
    const { simulateTrip } = require('../../services/ai/RouteDetourEstimator');

    // Status-quo route has low payout; propose has higher payout
    const statusQuoStops = [
      { action: 'PICKUP', load: 'Coal', supplyCity: 'Essen' },
      { action: 'DELIVER', load: 'Coal', deliveryCity: 'Berlin', demandCardId: 1, payment: 10 },
    ];
    const proposeStops = [
      { action: 'PICKUP', load: 'Coal', supplyCity: 'Essen' },
      { action: 'DELIVER', load: 'Coal', deliveryCity: 'Paris', demandCardId: 1, payment: 30 },
    ];

    const response = JSON.stringify({
      stops: statusQuoStops,
      reasoning: {
        chosen: 'Card 1 Coal→Berlin',
        chosenOver: ['Card 1 Coal→Paris'],
        chosenOverWhy: 'Berlin is closer',
        riskIfWrong: 'Switch to Paris route',
        followUpTrip: 'Next: Oil→Wien',
      },
      propose: { stops: proposeStops, rationale: 'Paris pays more' },
    });

    const chatFn = jest.fn().mockResolvedValue({ text: response, usage: { input: 100, output: 50 } });
    const brain = makeBrain(BotSkillLevel.Medium, chatFn);
    const planner = new TripPlanner(brain);

    // Simulator: propose has lower build cost and turns → higher score
    (simulateTrip as jest.Mock).mockReturnValue({ feasible: true, turnsToComplete: 2, totalBuildCost: 3 });

    const context = makeContext({
      demands: [makeDemand({ cardIndex: 1, deliveryCity: 'Berlin', payout: 10, estimatedTurns: 4, estimatedTrackCostToDelivery: 8 })],
    });
    const snapshot = makeSnapshot(BotSkillLevel.Medium);
    const memory = makeMemory();

    const result = await planner.planTrip(snapshot, context, [], memory);

    expect(result.route).not.toBeNull();
    // The propose route delivers to Paris
    const stopsIncludeParis = result.route!.stops.some(s => s.city === 'Paris');
    expect(stopsIncludeParis).toBe(true);
  });
});

// ── AC10: Propose rejected ────────────────────────────────────────────

describe('TripPlanner.planTrip — propose rejection (AC10)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('AC10: rejects propose when RouteValidator returns invalid, uses status-quo', async () => {
    const { simulateTrip } = require('../../services/ai/RouteDetourEstimator');

    // Status-quo valid, propose invalid
    (RouteValidator.validate as jest.Mock)
      .mockReturnValueOnce({ valid: true, errors: [] })   // status-quo
      .mockReturnValueOnce({ valid: false, errors: ['invalid route'] }); // propose

    const statusQuoStops = [
      { action: 'PICKUP', load: 'Coal', supplyCity: 'Essen' },
      { action: 'DELIVER', load: 'Coal', deliveryCity: 'Berlin', demandCardId: 1, payment: 15 },
    ];
    const proposeStops = [
      { action: 'PICKUP', load: 'Coal', supplyCity: 'Essen' },
      { action: 'DELIVER', load: 'Coal', deliveryCity: 'Nowhere', demandCardId: 1, payment: 50 },
    ];

    const response = JSON.stringify({
      stops: statusQuoStops,
      reasoning: {
        chosen: 'Card 1',
        chosenOver: ['propose'],
        chosenOverWhy: 'Closer',
        riskIfWrong: 'N/A',
        followUpTrip: 'Next',
      },
      propose: { stops: proposeStops, rationale: 'Higher payout' },
    });

    const chatFn = jest.fn().mockResolvedValue({ text: response, usage: { input: 100, output: 50 } });
    const brain = makeBrain(BotSkillLevel.Medium, chatFn);
    const planner = new TripPlanner(brain);

    const context = makeContext({
      demands: [makeDemand({ cardIndex: 1, deliveryCity: 'Berlin', payout: 15 })],
    });
    const snapshot = makeSnapshot(BotSkillLevel.Medium);
    const memory = makeMemory();

    const result = await planner.planTrip(snapshot, context, [], memory);

    // Status-quo route used (Berlin, not Nowhere)
    expect(result.route).not.toBeNull();
    const stopsIncludeBerlin = result.route!.stops.some(s => s.city === 'Berlin');
    expect(stopsIncludeBerlin).toBe(true);

    // simulateTrip should NOT have been called (validation failed first)
    expect(simulateTrip as jest.Mock).not.toHaveBeenCalled();

    // Log line emitted
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining('[TripPlanner.propose] rejected: validation_failed'),
    );
  });

  it('AC10: rejects propose when simulateTrip returns infeasible', async () => {
    const { simulateTrip } = require('../../services/ai/RouteDetourEstimator');

    (RouteValidator.validate as jest.Mock).mockReturnValue({ valid: true, errors: [] });
    (simulateTrip as jest.Mock).mockReturnValue({ feasible: false, turnsToComplete: 0, totalBuildCost: 0 });

    const statusQuoStops = [
      { action: 'PICKUP', load: 'Coal', supplyCity: 'Essen' },
      { action: 'DELIVER', load: 'Coal', deliveryCity: 'Berlin', demandCardId: 1, payment: 15 },
    ];
    const proposeStops = [
      { action: 'PICKUP', load: 'Coal', supplyCity: 'Essen' },
      { action: 'DELIVER', load: 'Coal', deliveryCity: 'London', demandCardId: 1, payment: 50 },
    ];

    const response = JSON.stringify({
      stops: statusQuoStops,
      reasoning: {
        chosen: 'Card 1',
        chosenOver: ['propose'],
        chosenOverWhy: 'London infeasible',
        riskIfWrong: 'N/A',
        followUpTrip: 'Next',
      },
      propose: { stops: proposeStops, rationale: 'London pays more' },
    });

    const chatFn = jest.fn().mockResolvedValue({ text: response, usage: { input: 100, output: 50 } });
    const brain = makeBrain(BotSkillLevel.Medium, chatFn);
    const planner = new TripPlanner(brain);

    const context = makeContext({
      demands: [makeDemand({ cardIndex: 1, deliveryCity: 'Berlin', payout: 15 })],
    });
    const snapshot = makeSnapshot(BotSkillLevel.Medium);
    const memory = makeMemory();

    const result = await planner.planTrip(snapshot, context, [], memory);

    expect(result.route).not.toBeNull();
    const usedStatusQuo = result.route!.stops.some(s => s.city === 'Berlin');
    expect(usedStatusQuo).toBe(true);

    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining('[TripPlanner.propose] rejected: infeasible'),
    );
  });

  it('AC10: rejects propose when score is worse than status-quo', async () => {
    const { simulateTrip } = require('../../services/ai/RouteDetourEstimator');

    (RouteValidator.validate as jest.Mock).mockReturnValue({ valid: true, errors: [] });
    // Propose: very high turns → low score
    (simulateTrip as jest.Mock).mockReturnValue({ feasible: true, turnsToComplete: 20, totalBuildCost: 60 });

    const statusQuoStops = [
      { action: 'PICKUP', load: 'Coal', supplyCity: 'Essen' },
      { action: 'DELIVER', load: 'Coal', deliveryCity: 'Berlin', demandCardId: 1, payment: 15 },
    ];
    const proposeStops = [
      { action: 'PICKUP', load: 'Coal', supplyCity: 'Essen' },
      { action: 'DELIVER', load: 'Coal', deliveryCity: 'Madrid', demandCardId: 1, payment: 25 },
    ];

    const response = JSON.stringify({
      stops: statusQuoStops,
      reasoning: {
        chosen: 'Card 1',
        chosenOver: ['Madrid route'],
        chosenOverWhy: 'Berlin is more efficient',
        riskIfWrong: 'N/A',
        followUpTrip: 'Next',
      },
      propose: { stops: proposeStops, rationale: 'Madrid pays more nominally' },
    });

    const chatFn = jest.fn().mockResolvedValue({ text: response, usage: { input: 100, output: 50 } });
    const brain = makeBrain(BotSkillLevel.Medium, chatFn);
    const planner = new TripPlanner(brain);

    const context = makeContext({
      demands: [makeDemand({ cardIndex: 1, deliveryCity: 'Berlin', payout: 15, estimatedTurns: 2, estimatedTrackCostToDelivery: 2 })],
    });
    const snapshot = makeSnapshot(BotSkillLevel.Medium);
    const memory = makeMemory();

    const result = await planner.planTrip(snapshot, context, [], memory);

    expect(result.route).not.toBeNull();
    const usedStatusQuo = result.route!.stops.some(s => s.city === 'Berlin');
    expect(usedStatusQuo).toBe(true);

    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining('[TripPlanner.propose] rejected: worse_score'),
    );
  });

  it('AC10: propose rejection does NOT trigger additional LLM retry (chatFn called only once)', async () => {
    const { simulateTrip } = require('../../services/ai/RouteDetourEstimator');

    (RouteValidator.validate as jest.Mock)
      .mockReturnValueOnce({ valid: true, errors: [] })   // status-quo
      .mockReturnValueOnce({ valid: false, errors: ['fail'] }); // propose

    const statusQuoStops = [
      { action: 'PICKUP', load: 'Coal', supplyCity: 'Essen' },
      { action: 'DELIVER', load: 'Coal', deliveryCity: 'Berlin', demandCardId: 1, payment: 15 },
    ];
    const proposeStops = [
      { action: 'PICKUP', load: 'Coal', supplyCity: 'Essen' },
      { action: 'DELIVER', load: 'Coal', deliveryCity: 'Nowhere', demandCardId: 1, payment: 50 },
    ];

    const response = JSON.stringify({
      stops: statusQuoStops,
      reasoning: { chosen: 'c1', chosenOver: ['p1'], chosenOverWhy: 'better', riskIfWrong: 'r', followUpTrip: 'f' },
      propose: { stops: proposeStops, rationale: 'higher' },
    });

    const chatFn = jest.fn().mockResolvedValue({ text: response, usage: { input: 100, output: 50 } });
    const brain = makeBrain(BotSkillLevel.Medium, chatFn);
    const planner = new TripPlanner(brain);

    const context = makeContext({
      demands: [makeDemand({ cardIndex: 1, deliveryCity: 'Berlin', payout: 15 })],
    });
    const snapshot = makeSnapshot(BotSkillLevel.Medium);
    const memory = makeMemory();

    await planner.planTrip(snapshot, context, [], memory);

    // Only 1 LLM call — propose rejection should NOT trigger retry
    expect(chatFn).toHaveBeenCalledTimes(1);
  });
});

// ── AC11: chosenOver-empty retry ──────────────────────────────────────

describe('TripPlanner.planTrip — chosenOver-empty retry (AC11)', () => {
  beforeEach(() => {
    (RouteValidator.validate as jest.Mock).mockReturnValue({ valid: true, errors: [] });
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('AC11: retries with feedback when chosenOver empty AND propose present', async () => {
    const statusQuoStops = [
      { action: 'PICKUP', load: 'Coal', supplyCity: 'Essen' },
      { action: 'DELIVER', load: 'Coal', deliveryCity: 'Berlin', demandCardId: 1, payment: 15 },
    ];
    const proposeStops = [
      { action: 'PICKUP', load: 'Coal', supplyCity: 'Essen' },
      { action: 'DELIVER', load: 'Coal', deliveryCity: 'Paris', demandCardId: 1, payment: 25 },
    ];

    // First call: chosenOver empty (should trigger retry)
    const firstResponse = JSON.stringify({
      stops: statusQuoStops,
      reasoning: {
        chosen: 'Card 1',
        chosenOver: [],  // EMPTY — should trigger retry
        chosenOverWhy: 'Berlin is close',
        riskIfWrong: 'N/A',
        followUpTrip: 'Next',
      },
      propose: { stops: proposeStops, rationale: 'higher payout' },
    });

    // Second call: chosenOver populated (retry succeeds)
    const secondResponse = JSON.stringify({
      stops: statusQuoStops,
      reasoning: {
        chosen: 'Card 1',
        chosenOver: ['Paris route via propose'],
        chosenOverWhy: 'Berlin is more efficient: 15M in 2 turns vs 25M in 8 turns',
        riskIfWrong: 'Switch to Paris if Berlin blocked',
        followUpTrip: 'Next: Oil→Wien',
      },
      propose: { stops: proposeStops, rationale: 'higher payout' },
    });

    const chatFn = jest.fn()
      .mockResolvedValueOnce({ text: firstResponse, usage: { input: 100, output: 50 } })
      .mockResolvedValueOnce({ text: secondResponse, usage: { input: 100, output: 60 } });

    const brain = makeBrain(BotSkillLevel.Medium, chatFn);
    const planner = new TripPlanner(brain);

    const context = makeContext({
      demands: [makeDemand({ cardIndex: 1, deliveryCity: 'Berlin', payout: 15 })],
    });
    const snapshot = makeSnapshot(BotSkillLevel.Medium);
    const memory = makeMemory();

    const result = await planner.planTrip(snapshot, context, [], memory);

    expect(result.route).not.toBeNull();
    // Should have made exactly 2 LLM calls
    expect(chatFn).toHaveBeenCalledTimes(2);

    // Second call should contain the retry feedback in userPrompt
    const secondCallArgs = chatFn.mock.calls[1][0];
    expect(secondCallArgs.userPrompt).toContain('Your reasoning.chosenOver was empty. Identify at least one alternative you considered.');
  });
});

// ── AC12: no retry when only 1 viable option ──────────────────────────

describe('TripPlanner.planTrip — no chosenOver retry when 1 option (AC12)', () => {
  beforeEach(() => {
    (RouteValidator.validate as jest.Mock).mockReturnValue({ valid: true, errors: [] });
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('AC12: does NOT retry on empty chosenOver when propose is absent (single-option)', async () => {
    const statusQuoStops = [
      { action: 'PICKUP', load: 'Coal', supplyCity: 'Essen' },
      { action: 'DELIVER', load: 'Coal', deliveryCity: 'Berlin', demandCardId: 1, payment: 15 },
    ];

    // No propose field — only 1 viable option
    const response = JSON.stringify({
      stops: statusQuoStops,
      reasoning: {
        chosen: 'Card 1',
        chosenOver: [],  // empty but no propose → no retry
        chosenOverWhy: 'Only option',
        riskIfWrong: 'N/A',
        followUpTrip: 'Next',
      },
    });

    const chatFn = jest.fn().mockResolvedValue({ text: response, usage: { input: 100, output: 50 } });
    const brain = makeBrain(BotSkillLevel.Medium, chatFn);
    const planner = new TripPlanner(brain);

    const context = makeContext({
      demands: [makeDemand({ cardIndex: 1, deliveryCity: 'Berlin', payout: 15 })],
    });
    const snapshot = makeSnapshot(BotSkillLevel.Medium);
    const memory = makeMemory();

    const result = await planner.planTrip(snapshot, context, [], memory);

    expect(result.route).not.toBeNull();
    // Only 1 LLM call — no retry triggered
    expect(chatFn).toHaveBeenCalledTimes(1);
  });
});

// ── AC13: Easy behavior unchanged (regression guard) ──────────────────

describe('TripPlanner.planTrip — Easy regression guard (AC13)', () => {
  beforeEach(() => {
    (RouteValidator.validate as jest.Mock).mockReturnValue({ valid: true, errors: [] });
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('AC13: Easy planTrip returns same TripPlanResult shape without reasoning object or propose', async () => {
    const { build: mockBuild } = require('../../services/ai/StrategicContextBuilder');

    const stops = [
      { action: 'PICKUP', load: 'Coal', supplyCity: 'Essen' },
      { action: 'DELIVER', load: 'Coal', deliveryCity: 'Berlin', demandCardId: 1, payment: 15 },
    ];

    const response = JSON.stringify({
      stops,
      reasoning: 'simple reasoning string for easy bot',
    });

    const chatFn = jest.fn().mockResolvedValue({ text: response, usage: { input: 100, output: 50 } });
    const brain = makeBrain(BotSkillLevel.Easy, chatFn);
    const planner = new TripPlanner(brain);

    const context = makeContext({
      demands: [makeDemand({ cardIndex: 1, deliveryCity: 'Berlin', payout: 15 })],
    });
    const snapshot = makeSnapshot(BotSkillLevel.Easy);
    const memory = makeMemory();

    const result = await planner.planTrip(snapshot, context, [], memory);

    expect(result.route).not.toBeNull();
    expect(result.route!.stops.length).toBeGreaterThan(0);
    expect(result.llmLog).toBeDefined();
    expect(result.llmTokens).toBeDefined();

    // StrategicContextBuilder.build() must NOT have been called for Easy
    expect(mockBuild).not.toHaveBeenCalled();
  });
});
