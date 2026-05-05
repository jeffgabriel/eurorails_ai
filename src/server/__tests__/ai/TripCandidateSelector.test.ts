/**
 * TripCandidateSelector.test.ts — Unit tests for the JIRA-217 LLM selector.
 *
 * Tests: single-candidate skip, multi-candidate LLM call, invalid id fallback,
 * LLM error fallback, and prompt format assertions.
 */

import {
  TripCandidateSelector,
  buildSelectorUserPrompt,
} from '../../services/ai/TripCandidateSelector';
import { TripCandidate } from '../../services/ai/MultiDemandTripOptimizer';
import {
  BotMemoryState,
  GameContext,
  WorldSnapshot,
  TrainType,
} from '../../../shared/types/GameTypes';

// ── Mock schemas ────────────────────────────────────────────────────────────

jest.mock('../../services/ai/schemas', () => ({
  SELECTOR_SCHEMA: { type: 'object' },
}));

// ── Fixtures ─────────────────────────────────────────────────────────────────

function makeCandidate(overrides: Partial<TripCandidate> = {}): TripCandidate {
  return {
    candidateId: 0,
    route: {
      stops: [
        { action: 'pickup', loadType: 'Coal', city: 'Essen' },
        { action: 'deliver', loadType: 'Coal', city: 'Berlin', demandCardId: 1, payment: 20 },
      ],
      currentStopIndex: 0,
      phase: 'build',
      createdAtTurn: 1,
      reasoning: 'test',
    },
    score: 10,
    payoutTotal: 20,
    buildCost: 5,
    turns: 3,
    demandsCovered: [
      { cardIndex: 1, loadType: 'Coal', supplyCity: 'Essen', deliveryCity: 'Berlin', payout: 20 },
    ],
    patterns: [],
    ...overrides,
  };
}

function makeContext(overrides: Partial<GameContext> = {}): GameContext {
  return {
    position: { city: 'Essen', row: 10, col: 5 },
    money: 80,
    trainType: 'FastFreight',
    speed: 12,
    capacity: 2,
    loads: [],
    connectedMajorCities: [],
    unconnectedMajorCities: [],
    totalMajorCities: 15,
    trackSummary: '',
    turnBuildCost: 0,
    turnNumber: 5,
    demands: [],
    canDeliver: [],
    canPickup: [],
    reachableCities: [],
    citiesOnNetwork: [],
    canUpgrade: false,
    canBuild: true,
    isInitialBuild: false,
    opponents: [],
    phase: 'movement',
    ...overrides,
  } as unknown as GameContext;
}

function makeSnapshot(overrides: Partial<WorldSnapshot['bot']> = {}): WorldSnapshot {
  return {
    gameId: 'g1',
    gameStatus: 'active',
    turnNumber: 5,
    bot: {
      playerId: 'bot-1',
      userId: 'user-bot-1',
      money: 77,
      position: { row: 10, col: 5 },
      existingSegments: [],
      demandCards: [],
      resolvedDemands: [],
      trainType: TrainType.FastFreight,
      loads: [],
      botConfig: null,
      connectedMajorCityCount: 0,
      ...overrides,
    },
    allPlayerTracks: [],
    loadAvailability: {},
  } as unknown as WorldSnapshot;
}

function makeMemory(): BotMemoryState {
  return {
    lastAbandonedRouteKey: null,
    previousRouteStops: null,
    consecutiveLlmFailures: 0,
    activeRoute: null,
    turnsOnRoute: 0,
    routeHistory: [],
    currentBuildTarget: null,
    turnsOnTarget: 0,
    lastAction: null,
    consecutiveDiscards: 0,
    deliveryCount: 0,
    totalEarnings: 0,
    turnNumber: 5,
  } as BotMemoryState;
}

function makeMockBrain(chatFn = jest.fn()) {
  const setContextFn = jest.fn();
  return {
    brain: {
      providerAdapter: { chat: chatFn, setContext: setContextFn },
      modelName: 'claude-sonnet-4-6',
      strategyConfig: { skillLevel: 'medium' },
    } as any,
    chatFn,
    setContextFn,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('TripCandidateSelector', () => {
  beforeEach(() => {
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  // ── AC6: Single-candidate skip ───────────────────────────────────────────────

  it('AC6: 1 candidate → returned directly without LLM call, fallbackReason: single_candidate', async () => {
    const { brain, chatFn } = makeMockBrain();
    const selector = new TripCandidateSelector(brain);
    const candidate = makeCandidate({ candidateId: 0 });

    const result = await selector.select([candidate], makeSnapshot(), makeContext(), makeMemory());

    expect(result.chosenCandidate).toBe(candidate);
    expect(result.fallbackReason).toBe('single_candidate');
    expect(result.llmLatencyMs).toBe(0);
    expect(result.llmTokens).toEqual({ input: 0, output: 0 });
    expect(chatFn).not.toHaveBeenCalled();
  });

  // ── Multi-candidate LLM call ────────────────────────────────────────────────

  it('2 candidates + valid chosenCandidateId → returns matching candidate', async () => {
    const candidates = [
      makeCandidate({ candidateId: 0, score: 15, payoutTotal: 30 }),
      makeCandidate({ candidateId: 1, score: 10, payoutTotal: 25 }),
    ];

    const { brain, chatFn } = makeMockBrain(
      jest.fn().mockResolvedValue({
        text: JSON.stringify({ chosenCandidateId: 2, rationale: 'Better velocity' }),
        usage: { input: 100, output: 30 },
      }),
    );

    const selector = new TripCandidateSelector(brain);
    const result = await selector.select(candidates, makeSnapshot(), makeContext(), makeMemory());

    expect(chatFn).toHaveBeenCalledTimes(1);
    expect(result.chosenCandidate).toBe(candidates[1]); // chosenCandidateId=2 → index=1
    expect(result.rationale).toBe('Better velocity');
    expect(result.fallbackReason).toBeUndefined();
  });

  it('3 candidates + LLM picks first → returns candidates[0]', async () => {
    const candidates = [
      makeCandidate({ candidateId: 0, score: 20 }),
      makeCandidate({ candidateId: 1, score: 15 }),
      makeCandidate({ candidateId: 2, score: 10 }),
    ];

    const { brain, chatFn } = makeMockBrain(
      jest.fn().mockResolvedValue({
        text: JSON.stringify({ chosenCandidateId: 1, rationale: 'Top EV' }),
        usage: { input: 120, output: 25 },
      }),
    );

    const selector = new TripCandidateSelector(brain);
    const result = await selector.select(candidates, makeSnapshot(), makeContext(), makeMemory());

    expect(chatFn).toHaveBeenCalledTimes(1);
    expect(result.chosenCandidate).toBe(candidates[0]); // chosenCandidateId=1 → index=0
    expect(result.fallbackReason).toBeUndefined();
  });

  // ── AC7: Invalid id fallback ────────────────────────────────────────────────

  it('AC7: LLM returns out-of-range chosenCandidateId → candidates[0] with fallbackReason: invalid_id', async () => {
    const candidates = [
      makeCandidate({ candidateId: 0 }),
      makeCandidate({ candidateId: 1 }),
    ];

    const { brain, chatFn } = makeMockBrain(
      jest.fn().mockResolvedValue({
        text: JSON.stringify({ chosenCandidateId: 99, rationale: 'Bad id' }),
        usage: { input: 100, output: 20 },
      }),
    );

    const selector = new TripCandidateSelector(brain);
    const result = await selector.select(candidates, makeSnapshot(), makeContext(), makeMemory());

    expect(result.chosenCandidate).toBe(candidates[0]);
    expect(result.fallbackReason).toBe('invalid_id');
  });

  it('AC7: LLM returns id=0 (1-based, so index=-1, invalid) → fallbackReason: invalid_id', async () => {
    const candidates = [makeCandidate({ candidateId: 0 }), makeCandidate({ candidateId: 1 })];

    const { brain } = makeMockBrain(
      jest.fn().mockResolvedValue({
        text: JSON.stringify({ chosenCandidateId: 0, rationale: 'Zero invalid' }),
        usage: { input: 100, output: 20 },
      }),
    );

    const selector = new TripCandidateSelector(brain);
    const result = await selector.select(candidates, makeSnapshot(), makeContext(), makeMemory());

    expect(result.chosenCandidate).toBe(candidates[0]);
    expect(result.fallbackReason).toBe('invalid_id');
  });

  // ── AC8: LLM error fallback ─────────────────────────────────────────────────

  it('AC8: LLM throws error → candidates[0] with fallbackReason: llm_failure', async () => {
    const candidates = [makeCandidate({ candidateId: 0 }), makeCandidate({ candidateId: 1 })];

    const { brain } = makeMockBrain(
      jest.fn().mockRejectedValue(new Error('LLM timeout')),
    );

    const selector = new TripCandidateSelector(brain);
    const result = await selector.select(candidates, makeSnapshot(), makeContext(), makeMemory());

    expect(result.chosenCandidate).toBe(candidates[0]);
    expect(result.fallbackReason).toBe('llm_failure');
    expect(result.llmLog).toHaveLength(1);
    expect(result.llmLog[0].status).toBe('api_error');
  });

  it('AC8: LLM returns unparseable JSON → candidates[0] with fallbackReason: llm_failure', async () => {
    const candidates = [makeCandidate({ candidateId: 0 }), makeCandidate({ candidateId: 1 })];

    const { brain } = makeMockBrain(
      jest.fn().mockResolvedValue({
        text: 'not-json-at-all',
        usage: { input: 50, output: 10 },
      }),
    );

    const selector = new TripCandidateSelector(brain);
    const result = await selector.select(candidates, makeSnapshot(), makeContext(), makeMemory());

    expect(result.chosenCandidate).toBe(candidates[0]);
    expect(result.fallbackReason).toBe('llm_failure');
  });

  // ── Prompt format assertions (AC12) ────────────────────────────────────────

  it('AC12: prompt contains loadType @ supplyCity → deliveryCity (payout) format', () => {
    const candidates = [
      makeCandidate({
        candidateId: 0,
        payoutTotal: 35,
        buildCost: 15,
        turns: 5,
        demandsCovered: [
          { cardIndex: 1, loadType: 'Hops', supplyCity: 'Cardiff', deliveryCity: 'Lodz', payout: 35 },
        ],
      }),
    ];

    const prompt = buildSelectorUserPrompt(candidates, makeSnapshot(), makeContext());
    expect(prompt).toContain('Hops @ Cardiff → Lodz (35M)');
  });

  it('AC12: prompt does NOT contain "Patterns:" or "pattern" in load/candidate rows', () => {
    const candidates = [
      makeCandidate({
        candidateId: 0,
        patterns: [{ kind: 'supply-cluster', city: 'Cardiff', loadTypes: ['Hops', 'Coal'] }],
        demandsCovered: [
          { cardIndex: 1, loadType: 'Hops', supplyCity: 'Cardiff', deliveryCity: 'London', payout: 30 },
          { cardIndex: 2, loadType: 'Coal', supplyCity: 'Cardiff', deliveryCity: 'Birmingham', payout: 25 },
        ],
      }),
    ];

    const prompt = buildSelectorUserPrompt(candidates, makeSnapshot(), makeContext());
    // Patterns should NOT appear in prompt (diagnostic-only)
    expect(prompt.toLowerCase()).not.toContain('pattern');
    expect(prompt).not.toContain('Patterns:');
    expect(prompt).not.toContain('supply-cluster');
  });

  it('AC12: prompt contains each candidate row with payout, build, turns, net', () => {
    const candidates = [
      makeCandidate({
        candidateId: 0,
        payoutTotal: 62,
        buildCost: 24,
        turns: 7,
        demandsCovered: [
          { cardIndex: 1, loadType: 'Hops', supplyCity: 'Cardiff', deliveryCity: 'Lodz', payout: 35 },
          { cardIndex: 2, loadType: 'Coal', supplyCity: 'Cardiff', deliveryCity: 'Goteborg', payout: 27 },
        ],
      }),
      makeCandidate({
        candidateId: 1,
        payoutTotal: 46,
        buildCost: 14,
        turns: 5,
        demandsCovered: [
          { cardIndex: 3, loadType: 'Cheese', supplyCity: 'Holland', deliveryCity: 'Birmingham', payout: 12 },
        ],
      }),
    ];

    const prompt = buildSelectorUserPrompt(candidates, makeSnapshot(), makeContext());
    // First candidate row
    expect(prompt).toContain('62M payout');
    expect(prompt).toContain('24M build');
    expect(prompt).toContain('7 turns');
    // Net = 62 - 24 = 38
    expect(prompt).toContain('38M');
    // Second candidate row
    expect(prompt).toContain('46M payout');
    // Loads format
    expect(prompt).toContain('Hops @ Cardiff → Lodz (35M)');
    expect(prompt).toContain('Coal @ Cardiff → Goteborg (27M)');
    expect(prompt).toContain('Cheese @ Holland → Birmingham (12M)');
  });

  it('prompt includes bot state (cash, trainType, position)', () => {
    const candidates = [makeCandidate({ candidateId: 0 })];
    const snapshot = makeSnapshot({ money: 77 });
    const context = makeContext({ trainType: 'FastFreight', capacity: 2, loads: [] });

    const prompt = buildSelectorUserPrompt(candidates, snapshot, context);
    expect(prompt).toContain('77M');
    expect(prompt).toContain('FastFreight');
    expect(prompt).toContain('cap 2');
    expect(prompt).toContain('empty');
  });

  it('prompt ends with "Return JSON: { chosenCandidateId, rationale }."', () => {
    const candidates = [makeCandidate({ candidateId: 0 })];
    const prompt = buildSelectorUserPrompt(candidates, makeSnapshot(), makeContext());
    expect(prompt).toContain('Return JSON: { chosenCandidateId, rationale }.');
  });
});
