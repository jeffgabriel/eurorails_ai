/**
 * ActiveRouteContinuer unit tests (JIRA-195b Sub-slice B, BE-003).
 *
 * Covers the four required scenarios:
 *   1. Success — route continues to next stop, decision populated correctly
 *   2. Route-abandoned — routeWasAbandoned set, execCompositionTrace preserved
 *   3. Route-completed — routeWasCompleted set, activeRoute unchanged
 *   4. JIRA-185 replan LLM data propagation — replanLlmLog/systemPrompt/userPrompt flow into decision
 */

import { ActiveRouteContinuer } from '../../services/ai/ActiveRouteContinuer';
import { TurnExecutorPlanner } from '../../services/ai/TurnExecutorPlanner';
import { GameState, AIActionType } from '../../../shared/types/GameTypes';
import type {
  StrategicRoute,
  RouteStop,
  GameContext,
  WorldSnapshot,
  GridPoint,
  LlmAttempt,
  TurnPlan,
  LLMDecisionResult,
  BotMemoryState,
} from '../../../shared/types/GameTypes';
import type { LLMStrategyBrain } from '../../services/ai/LLMStrategyBrain';
import type { CompositionTrace, TurnExecutorResult } from '../../services/ai/TurnExecutorPlanner';

// ── Mock TurnExecutorPlanner.execute ─────────────────────────────────────────

jest.mock('../../services/ai/TurnExecutorPlanner', () => ({
  TurnExecutorPlanner: {
    execute: jest.fn(),
    // preserve other static members as no-ops so imports don't fail
    isCappedCityBlocked: jest.fn().mockReturnValue(false),
    resolveCappedCityDelivery: jest.fn(),
    assertBuildDirection: jest.fn(),
    executeBuildPhase: jest.fn(),
    shouldDeferBuild: jest.fn().mockReturnValue(false),
    skipCompletedStops: jest.fn((route: StrategicRoute) => route),
    revalidateRoute: jest.fn((route: StrategicRoute) => route),
  },
}));

const mockExecute = TurnExecutorPlanner.execute as jest.Mock;

// ── Factory helpers ───────────────────────────────────────────────────────────

function makeStop(
  action: 'pickup' | 'deliver',
  city = 'TestCity',
  loadType = 'Coal',
): RouteStop {
  return { action, city, loadType };
}

function makeRoute(overrides: Partial<StrategicRoute> = {}): StrategicRoute {
  return {
    stops: [makeStop('pickup', 'Lyon'), makeStop('deliver', 'Berlin')],
    currentStopIndex: 0,
    phase: 'travel',
    startingCity: 'Lyon',
    createdAtTurn: 1,
    reasoning: 'test route',
    ...overrides,
  };
}

function makeContext(overrides: Partial<GameContext> = {}): GameContext {
  return {
    position: { row: 5, col: 5, city: 'Lyon' },
    money: 100,
    speed: 9,
    capacity: 2,
    loads: [],
    demands: [],
    citiesOnNetwork: [],
    connectedMajorCities: [],
    unconnectedMajorCities: [],
    totalMajorCities: 12,
    trackSummary: '',
    turnBuildCost: 0,
    canDeliver: [],
    canPickup: [],
    reachableCities: [],
    canUpgrade: false,
    canBuild: true,
    isInitialBuild: false,
    opponents: [],
    phase: 'travel',
    turnNumber: 1,
    trainType: 'Freight',
    gameState: GameState.Mid,
    ...overrides,
  };
}

function makeSnapshot(): WorldSnapshot {
  return {
    bot: {
      playerId: 'bot-1',
      position: { row: 5, col: 5 },
      existingSegments: [],
      money: 100,
      trainType: 'Freight',
      loads: [],
      connectedMajorCityCount: 0,
    },
    players: [],
    loadAvailability: {},
  } as unknown as WorldSnapshot;
}

function makeTrace(): CompositionTrace {
  return {
    inputPlan: [],
    outputPlan: [],
    moveBudget: { total: 9, used: 0, wasted: 0 },
    a1: { citiesScanned: 0, opportunitiesFound: 0 },
    a2: { iterations: 0, terminationReason: '' },
    a3: { movePreprended: false },
    build: { target: null, cost: 0, skipped: false, upgradeConsidered: false },
    pickups: [],
    deliveries: [],
  };
}

function makeExecResult(overrides: Partial<TurnExecutorResult> = {}): TurnExecutorResult {
  const route = makeRoute({ currentStopIndex: 1 });
  return {
    plans: [{ type: AIActionType.PassTurn }],
    updatedRoute: route,
    compositionTrace: makeTrace(),
    routeComplete: false,
    routeAbandoned: false,
    hasDelivery: false,
    ...overrides,
  };
}

const gridPoints: GridPoint[] = [];
const brain: LLMStrategyBrain | null = null;
const tag = '[bot:test turn:1]';

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
    consecutiveLlmFailures: 0,
    ...overrides,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

beforeEach(() => {
  jest.clearAllMocks();
});

describe('ActiveRouteContinuer.run', () => {
  describe('success case — route continues', () => {
    it('returns decision with route-executor model and advances activeRoute to updatedRoute', async () => {
      const activeRoute = makeRoute({ currentStopIndex: 0 });
      const updatedRoute = makeRoute({ currentStopIndex: 1 });
      const execResult = makeExecResult({ updatedRoute, routeComplete: false, routeAbandoned: false });
      mockExecute.mockResolvedValue(execResult);

      const result = await ActiveRouteContinuer.run(
        activeRoute,
        makeSnapshot(),
        makeContext(),
        brain,
        gridPoints,
        tag,
        makeMemory(),
      );

      expect(result.routeWasCompleted).toBe(false);
      expect(result.routeWasAbandoned).toBe(false);
      expect(result.hasDelivery).toBe(false);
      // activeRoute should be the updatedRoute from TurnExecutorPlanner
      expect(result.activeRoute).toBe(updatedRoute);
      expect(result.decision.model).toBe('route-executor');
      expect(result.decision.plan).toEqual({ type: AIActionType.PassTurn });
      expect(result.execCompositionTrace).toBe(execResult.compositionTrace);
    });

    it('collapses multiple plans into a MultiAction step', async () => {
      const plan1 = { type: AIActionType.PassTurn } as TurnPlan;
      const plan2 = { type: AIActionType.DiscardHand } as TurnPlan;
      const execResult = makeExecResult({ plans: [plan1, plan2] });
      mockExecute.mockResolvedValue(execResult);

      const result = await ActiveRouteContinuer.run(
        makeRoute(),
        makeSnapshot(),
        makeContext(),
        brain,
        gridPoints,
        tag,
        makeMemory(),
      );

      expect(result.decision.plan).toEqual({ type: 'MultiAction', steps: [plan1, plan2] });
    });

    it('produces PassTurn plan when TurnExecutorPlanner returns empty plans', async () => {
      const execResult = makeExecResult({ plans: [] });
      mockExecute.mockResolvedValue(execResult);

      const result = await ActiveRouteContinuer.run(
        makeRoute(),
        makeSnapshot(),
        makeContext(),
        brain,
        gridPoints,
        tag,
        makeMemory(),
      );

      expect(result.decision.plan).toEqual({ type: AIActionType.PassTurn });
    });
  });

  describe('route-abandoned case', () => {
    it('sets routeWasAbandoned=true and preserves original activeRoute', async () => {
      const activeRoute = makeRoute({ currentStopIndex: 0 });
      const trace = { ...makeTrace(), a2: { iterations: 3, terminationReason: 'stuck' } };
      const execResult = makeExecResult({
        routeAbandoned: true,
        compositionTrace: trace,
      });
      mockExecute.mockResolvedValue(execResult);

      const result = await ActiveRouteContinuer.run(
        activeRoute,
        makeSnapshot(),
        makeContext(),
        brain,
        gridPoints,
        tag,
        makeMemory(),
      );

      expect(result.routeWasAbandoned).toBe(true);
      expect(result.routeWasCompleted).toBe(false);
      // When abandoned the route is NOT updated to updatedRoute — the original is kept
      expect(result.activeRoute).toBe(activeRoute);
      expect(result.execCompositionTrace).toBe(execResult.compositionTrace);
    });
  });

  describe('route-completed case', () => {
    it('sets routeWasCompleted=true and does not update activeRoute', async () => {
      const activeRoute = makeRoute({ currentStopIndex: 1 });
      const execResult = makeExecResult({ routeComplete: true });
      mockExecute.mockResolvedValue(execResult);

      const result = await ActiveRouteContinuer.run(
        activeRoute,
        makeSnapshot(),
        makeContext(),
        brain,
        gridPoints,
        tag,
        makeMemory(),
      );

      expect(result.routeWasCompleted).toBe(true);
      expect(result.routeWasAbandoned).toBe(false);
      // When complete the route is NOT updated — the original is kept
      expect(result.activeRoute).toBe(activeRoute);
    });

    it('propagates hasDelivery=true when TurnExecutorPlanner signals a delivery', async () => {
      const execResult = makeExecResult({ routeComplete: true, hasDelivery: true });
      mockExecute.mockResolvedValue(execResult);

      const result = await ActiveRouteContinuer.run(
        makeRoute(),
        makeSnapshot(),
        makeContext(),
        brain,
        gridPoints,
        tag,
        makeMemory(),
      );

      expect(result.hasDelivery).toBe(true);
    });
  });

  describe('JIRA-185 replan LLM data propagation', () => {
    it('spreads replanLlmLog, replanSystemPrompt, replanUserPrompt into decision when present', async () => {
      const replanLlmLog: LlmAttempt[] = [{ role: 'assistant', content: 'replan response' } as unknown as LlmAttempt];
      const replanSystemPrompt = 'system: replan context';
      const replanUserPrompt = 'user: post-delivery replan';

      const execResult = makeExecResult({
        replanLlmLog,
        replanSystemPrompt,
        replanUserPrompt,
      });
      mockExecute.mockResolvedValue(execResult);

      const result = await ActiveRouteContinuer.run(
        makeRoute(),
        makeSnapshot(),
        makeContext(),
        brain,
        gridPoints,
        tag,
        makeMemory(),
      );

      // The decision must carry JIRA-185 replan data for the debug overlay
      expect((result.decision as LLMDecisionResult).llmLog).toBe(replanLlmLog);
      expect((result.decision as LLMDecisionResult).systemPrompt).toBe(replanSystemPrompt);
      expect((result.decision as LLMDecisionResult).userPrompt).toBe(replanUserPrompt);
    });

    it('JIRA-220 follow-up: surfaces updatedRoute.reasoning in decision.reasoning when a replan happened', async () => {
      // PostDeliveryReplanner installed a new route via TripPlanner.planTrip; the new
      // route carries the planner's verbose reasoning (deterministic top-1 trace for
      // Medium, or LLM reasoning for Easy/Hard). Without this propagation, the per-turn
      // NDJSON record only retains "[route-executor] stop X/Y, phase=Z" and the
      // planner's diagnostic is lost.
      const replanLlmLog: LlmAttempt[] = [{ role: 'assistant', content: 'replan response' } as unknown as LlmAttempt];
      const verboseReasoning = '[deterministic-top-1] pair:c10-Hops+c82-Iron:AB chosen.\n  Picked: pair-shared-delivery — payout 27M, build 33M, 6 turns, NET -6M, score -54.0\n  Stops: 1) pickup Hops at Cardiff; 2) pickup Iron at Birmingham; 3) deliver Hops at Holland; 4) deliver Iron at Holland\n  Survivors after spatial prune: 18 of 47 raw.';
      const newRoute = makeRoute({
        currentStopIndex: 0,
        reasoning: verboseReasoning,
      });

      const execResult = makeExecResult({
        replanLlmLog,
        updatedRoute: newRoute,
      });
      mockExecute.mockResolvedValue(execResult);

      const result = await ActiveRouteContinuer.run(
        makeRoute(),
        makeSnapshot(),
        makeContext(),
        brain,
        gridPoints,
        tag,
        makeMemory(),
      );

      expect(result.decision.reasoning).toContain('[route-executor]');
      expect(result.decision.reasoning).toContain('replan triggered');
      expect(result.decision.reasoning).toContain('[deterministic-top-1]');
      expect(result.decision.reasoning).toContain('pair-shared-delivery');
      expect(result.decision.reasoning).toContain('Survivors after spatial prune');
    });

    it('JIRA-220 follow-up: does NOT append updatedRoute.reasoning when no replan happened', async () => {
      // No replanLlmLog → no replan → keep the brief route-executor tag.
      const execResult = makeExecResult({
        updatedRoute: makeRoute({ reasoning: 'unrelated route reasoning that should not surface' }),
      });
      delete (execResult as Partial<TurnExecutorResult>).replanLlmLog;
      mockExecute.mockResolvedValue(execResult);

      const result = await ActiveRouteContinuer.run(
        makeRoute(),
        makeSnapshot(),
        makeContext(),
        brain,
        gridPoints,
        tag,
        makeMemory(),
      );

      expect(result.decision.reasoning).toContain('[route-executor]');
      expect(result.decision.reasoning).not.toContain('replan triggered');
      expect(result.decision.reasoning).not.toContain('unrelated route reasoning');
    });

    it('does not add llmLog/systemPrompt fields when replan fields are absent', async () => {
      const execResult = makeExecResult();
      delete (execResult as Partial<TurnExecutorResult>).replanLlmLog;
      delete (execResult as Partial<TurnExecutorResult>).replanSystemPrompt;
      delete (execResult as Partial<TurnExecutorResult>).replanUserPrompt;
      mockExecute.mockResolvedValue(execResult);

      const result = await ActiveRouteContinuer.run(
        makeRoute(),
        makeSnapshot(),
        makeContext(),
        brain,
        gridPoints,
        tag,
        makeMemory(),
      );

      expect((result.decision as LLMDecisionResult).llmLog).toBeUndefined();
      expect((result.decision as LLMDecisionResult).systemPrompt).toBeUndefined();
      expect(typeof (result.decision as LLMDecisionResult).userPrompt).toBe('string');
    });
  });

  describe('stuck-route abandonment', () => {
    it.each([
      ['stop_city_not_on_network'],
      ['budget_exhausted'],
      ['max_iterations'],
    ])('abandons stuck route after threshold turns of PassTurn-only output (a2=%s)', async (terminationReason) => {
      // Reproduces game c5f36a97 / 0c6f0fb6 — bot stuck on a route whose pickup
      // city it cannot reach. TurnExecutorPlanner returns no plans (PassTurn),
      // and after ≥ 2 prior turns on this route the next no-progress turn must
      // abandon so TripPlanner can replan instead of PassTurning forever.
      const activeRoute = makeRoute({ currentStopIndex: 0 });
      const trace = { ...makeTrace(), a2: { iterations: 1, terminationReason } };
      const execResult = makeExecResult({
        plans: [],
        compositionTrace: trace,
        routeComplete: false,
        routeAbandoned: false,
      });
      mockExecute.mockResolvedValue(execResult);

      const result = await ActiveRouteContinuer.run(
        activeRoute,
        makeSnapshot(),
        makeContext(),
        brain,
        gridPoints,
        tag,
        makeMemory({ turnsOnRoute: 2 }),
      );

      expect(result.routeWasAbandoned).toBe(true);
      expect(result.routeWasCompleted).toBe(false);
      expect(result.activeRoute).toBe(activeRoute);
      expect(result.decision.model).toBe('stuck-route-abandon');
      expect(result.decision.reasoning).toContain('stuck-route-abandon');
    });

    it('does NOT abandon a fresh route on its first PassTurn turn (turnsOnRoute=0)', async () => {
      // Building toward a far pickup may legitimately produce PassTurn on the
      // first turn — abandonment should only fire after the threshold.
      const activeRoute = makeRoute({ currentStopIndex: 0 });
      const execResult = makeExecResult({ plans: [], routeComplete: false, routeAbandoned: false });
      mockExecute.mockResolvedValue(execResult);

      const result = await ActiveRouteContinuer.run(
        activeRoute,
        makeSnapshot(),
        makeContext(),
        brain,
        gridPoints,
        tag,
        makeMemory({ turnsOnRoute: 0 }),
      );

      expect(result.routeWasAbandoned).toBe(false);
      expect(result.decision.model).toBe('route-executor');
    });

    it('does NOT abandon when the route advanced this turn (pickup or deliver happened)', async () => {
      // Even at turnsOnRoute=5, if execResult contains real plans (e.g., MoveTrain + PickupLoad),
      // the bot is making progress and the route must be preserved.
      const activeRoute = makeRoute({ currentStopIndex: 0 });
      const updatedRoute = makeRoute({ currentStopIndex: 1 });
      const execResult = makeExecResult({
        plans: [{ type: AIActionType.PickupLoad, load: 'Coal', city: 'Lyon', cardId: 1 } as TurnPlan],
        updatedRoute,
        routeComplete: false,
        routeAbandoned: false,
      });
      mockExecute.mockResolvedValue(execResult);

      const result = await ActiveRouteContinuer.run(
        activeRoute,
        makeSnapshot(),
        makeContext(),
        brain,
        gridPoints,
        tag,
        makeMemory({ turnsOnRoute: 5 }),
      );

      expect(result.routeWasAbandoned).toBe(false);
      expect(result.activeRoute).toBe(updatedRoute);
      expect(result.decision.model).toBe('route-executor');
    });
  });
});
