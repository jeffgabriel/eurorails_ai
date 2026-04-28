/**
 * PostDeliveryReplanner unit tests (JIRA-195 Slice 3a + JIRA-198 upgrade consumption).
 *
 * Covers all four sub-paths:
 *   1. Success — TripPlanner returns a route → enriched + skipCompletedStops
 *   2. Null route — TripPlanner returns null → revalidate existing route
 *   3. Throw — TripPlanner throws → revalidate existing route
 *   4. No brain — brain null or gridPoints empty → revalidate existing route
 *
 * In every sub-path, moveTargetInvalidated must be true (JIRA-194 contract).
 *
 * JIRA-198 upgrade consumption scenarios (B13.2):
 *   - Success: upgradeOnRoute eligible → pendingUpgradeAction populated
 *   - Gate-blocked: delivery count below threshold → pendingUpgradeAction null + reason
 *   - Unaffordable: insufficient funds → pendingUpgradeAction null + reason
 *   - Invalid-path: invalid upgrade from current train → pendingUpgradeAction null + reason
 *   - Sub-paths 2/3/4: both fields undefined
 *   - Multi-replan accumulation: last non-null wins; null does not clobber non-null
 */

import { PostDeliveryReplanner } from '../../services/ai/PostDeliveryReplanner';
import { TurnExecutorPlanner } from '../../services/ai/TurnExecutorPlanner';
import type {
  AIActionType,
  GameContext,
  GridPoint,
  LlmAttempt,
  RouteStop,
  StrategicRoute,
  WorldSnapshot,
} from '../../../shared/types/GameTypes';
import type { LLMStrategyBrain } from '../../services/ai/LLMStrategyBrain';

// ── Mock dependencies ──────────────────────────────────────────────────────

jest.mock('../../services/ai/BotMemory', () => ({
  getMemory: jest.fn().mockResolvedValue({
    currentBuildTarget: null,
    turnsOnTarget: 0,
    lastAction: null,
    noProgressTurns: 0,
    consecutiveDiscards: 0,
    deliveryCount: 2,
    totalEarnings: 0,
    turnNumber: 5,
    activeRoute: null,
    turnsOnRoute: 0,
    routeHistory: [],
    lastReasoning: null,
    lastPlanHorizon: null,
    previousRouteStops: null,
    consecutiveLlmFailures: 0,
  }),
}));

// JIRA-198: Mock NewRoutePlanner.tryConsumeUpgrade at the module boundary
jest.mock('../../services/ai/NewRoutePlanner', () => ({
  NewRoutePlanner: {
    tryConsumeUpgrade: jest.fn(),
  },
}));

jest.mock('../../services/ai/TripPlanner', () => ({
  TripPlanner: jest.fn().mockImplementation(() => ({
    planTrip: jest.fn().mockResolvedValue({ route: null, llmLog: [] }),
  })),
}));

jest.mock('../../services/ai/AdvisorCoordinator', () => ({
  AdvisorCoordinator: {
    adviseEnrichment: jest.fn(async (route: unknown) => route),
  },
}));

// Import mocked modules to access their mock functions
import { TripPlanner } from '../../services/ai/TripPlanner';
import { AdvisorCoordinator } from '../../services/ai/AdvisorCoordinator';
import { NewRoutePlanner } from '../../services/ai/NewRoutePlanner';

const MockTripPlannerClass = TripPlanner as jest.MockedClass<typeof TripPlanner>;
const mockAdviseEnrichment = AdvisorCoordinator.adviseEnrichment as jest.Mock;
const mockTryConsumeUpgrade = NewRoutePlanner.tryConsumeUpgrade as jest.Mock;

// TurnExecutorPlanner static methods — spy on the real implementation
let mockSkipCompletedStops: jest.SpyInstance;
let mockRevalidate: jest.SpyInstance;

// ── Factory helpers ────────────────────────────────────────────────────────

function makeStop(
  action: 'pickup' | 'deliver' | 'drop',
  city = 'TestCity',
  loadType = 'Coal',
): RouteStop {
  return { action, city, loadType };
}

function makeRoute(overrides: Partial<StrategicRoute> = {}): StrategicRoute {
  return {
    stops: [makeStop('pickup', 'Lyon'), makeStop('deliver', 'Berlin')],
    currentStopIndex: 1,
    phase: 'travel',
    startingCity: 'Lyon',
    createdAtTurn: 1,
    reasoning: 'test route',
    ...overrides,
  };
}

function makeContext(overrides: Partial<GameContext> = {}): GameContext {
  return {
    position: { row: 5, col: 5, city: 'Berlin' },
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
    turnNumber: 5,
    trainType: 'Freight',
    ...overrides,
  };
}

function makeSnapshot(): WorldSnapshot {
  return {
    gameId: 'game-1',
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

function makeGridPoints(): GridPoint[] {
  return [{ row: 5, col: 5 } as GridPoint];
}

function makeBrain(): LLMStrategyBrain {
  return {} as LLMStrategyBrain;
}

/** Get the planTrip mock from the last TripPlanner instance created. */
function getLastPlanTripMock(): jest.Mock {
  const lastInstance = MockTripPlannerClass.mock.results[MockTripPlannerClass.mock.results.length - 1]?.value;
  return lastInstance?.planTrip as jest.Mock;
}

// ── Test setup ─────────────────────────────────────────────────────────────

beforeEach(() => {
  jest.clearAllMocks();

  // Reset the TripPlanner factory so each test gets a fresh instance mock
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (MockTripPlannerClass as any).mockImplementation(() => ({
    planTrip: jest.fn().mockResolvedValue({ route: null, llmLog: [] }),
  }));

  // By default, skipCompletedStops returns the route unchanged
  mockSkipCompletedStops = jest
    .spyOn(TurnExecutorPlanner, 'skipCompletedStops')
    .mockImplementation((route: StrategicRoute) => route);

  // By default, revalidate returns the route unchanged
  mockRevalidate = jest
    .spyOn(TurnExecutorPlanner, 'revalidateRemainingDeliveries')
    .mockImplementation((route: StrategicRoute) => route);

  // By default, adviseEnrichment passes the route through
  mockAdviseEnrichment.mockImplementation(async (route: StrategicRoute) => route);

  // By default, tryConsumeUpgrade returns no action (not called unless route has upgradeOnRoute)
  mockTryConsumeUpgrade.mockReturnValue({ action: null, reason: 'Upgrade blocked: default mock' });
});

afterEach(() => {
  mockSkipCompletedStops.mockRestore();
  mockRevalidate.mockRestore();
});

// ── Sub-path 1: Success ────────────────────────────────────────────────────

describe('PostDeliveryReplanner.replan — sub-path 1: TripPlanner success', () => {
  it('returns the enriched route with moveTargetInvalidated=true', async () => {
    const newRoute = makeRoute({ currentStopIndex: 0, reasoning: 'new enriched route' });
    const enrichedRoute = { ...newRoute, reasoning: 'enriched' };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (MockTripPlannerClass as any).mockImplementation(() => ({
      planTrip: jest.fn().mockResolvedValue({
        route: newRoute,
        llmLog: [{ role: 'user', content: 'test' }] as unknown as LlmAttempt[],
        systemPrompt: 'sys',
        userPrompt: 'usr',
      }),
    }));
    mockAdviseEnrichment.mockResolvedValue(enrichedRoute);

    const result = await PostDeliveryReplanner.replan(
      makeRoute(),
      makeSnapshot(),
      makeContext(),
      makeBrain(),
      makeGridPoints(),
      1,
      '[TEST]',
    );

    expect(result.moveTargetInvalidated).toBe(true);
    expect(result.route.reasoning).toBe('enriched');
    expect(mockAdviseEnrichment).toHaveBeenCalledTimes(1);
    expect(mockSkipCompletedStops).toHaveBeenCalledWith(enrichedRoute, expect.anything());
  });

  it('propagates llmLog, systemPrompt, userPrompt from TripPlanner', async () => {
    const llmLog = [{ role: 'assistant', content: 'log' }] as unknown as LlmAttempt[];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (MockTripPlannerClass as any).mockImplementation(() => ({
      planTrip: jest.fn().mockResolvedValue({
        route: makeRoute(),
        llmLog,
        systemPrompt: 'system-prompt',
        userPrompt: 'user-prompt',
      }),
    }));

    const result = await PostDeliveryReplanner.replan(
      makeRoute(),
      makeSnapshot(),
      makeContext(),
      makeBrain(),
      makeGridPoints(),
      0,
      '[TEST]',
    );

    expect(result.replanLlmLog).toBe(llmLog);
    expect(result.replanSystemPrompt).toBe('system-prompt');
    expect(result.replanUserPrompt).toBe('user-prompt');
  });

  it('patches deliveryCount in memory before calling TripPlanner (JIRA-185)', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (MockTripPlannerClass as any).mockImplementation(() => ({
      planTrip: jest.fn().mockResolvedValue({ route: makeRoute(), llmLog: [] }),
    }));

    await PostDeliveryReplanner.replan(
      makeRoute(),
      makeSnapshot(),
      makeContext(),
      makeBrain(),
      makeGridPoints(),
      3, // deliveriesThisTurn
      '[TEST]',
    );

    // getMemory returns deliveryCount=2; we pass 3 deliveriesThisTurn → patched = 5
    const planTripMock = getLastPlanTripMock();
    expect(planTripMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ deliveryCount: 5 }),
    );
  });
});

// ── Sub-path 2: Null route ─────────────────────────────────────────────────

describe('PostDeliveryReplanner.replan — sub-path 2: TripPlanner returns null route', () => {
  it('revalidates and returns with moveTargetInvalidated=true', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (MockTripPlannerClass as any).mockImplementation(() => ({
      planTrip: jest.fn().mockResolvedValue({ route: null, llmLog: [] }),
    }));
    const revalidatedRoute = makeRoute({ reasoning: 'revalidated' });
    mockRevalidate.mockReturnValue(revalidatedRoute);

    const result = await PostDeliveryReplanner.replan(
      makeRoute(),
      makeSnapshot(),
      makeContext(),
      makeBrain(),
      makeGridPoints(),
      0,
      '[TEST]',
    );

    expect(result.moveTargetInvalidated).toBe(true);
    expect(mockRevalidate).toHaveBeenCalledTimes(1);
    expect(mockSkipCompletedStops).toHaveBeenCalledWith(revalidatedRoute, expect.anything());
  });

  it('does not call adviseEnrichment when route is null', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (MockTripPlannerClass as any).mockImplementation(() => ({
      planTrip: jest.fn().mockResolvedValue({ route: null, llmLog: [] }),
    }));

    await PostDeliveryReplanner.replan(
      makeRoute(),
      makeSnapshot(),
      makeContext(),
      makeBrain(),
      makeGridPoints(),
      0,
      '[TEST]',
    );

    expect(mockAdviseEnrichment).not.toHaveBeenCalled();
  });
});

// ── Sub-path 3: TripPlanner throws ────────────────────────────────────────

describe('PostDeliveryReplanner.replan — sub-path 3: TripPlanner throws', () => {
  it('catches error, revalidates, returns with moveTargetInvalidated=true', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (MockTripPlannerClass as any).mockImplementation(() => ({
      planTrip: jest.fn().mockRejectedValue(new Error('LLM timeout')),
    }));
    const revalidatedRoute = makeRoute({ reasoning: 'revalidated-after-throw' });
    mockRevalidate.mockReturnValue(revalidatedRoute);

    const result = await PostDeliveryReplanner.replan(
      makeRoute(),
      makeSnapshot(),
      makeContext(),
      makeBrain(),
      makeGridPoints(),
      0,
      '[TEST]',
    );

    expect(result.moveTargetInvalidated).toBe(true);
    expect(mockRevalidate).toHaveBeenCalledTimes(1);
    expect(mockSkipCompletedStops).toHaveBeenCalledWith(revalidatedRoute, expect.anything());
  });

  it('does not propagate LLM prompts when TripPlanner throws', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (MockTripPlannerClass as any).mockImplementation(() => ({
      planTrip: jest.fn().mockRejectedValue(new Error('network error')),
    }));

    const result = await PostDeliveryReplanner.replan(
      makeRoute(),
      makeSnapshot(),
      makeContext(),
      makeBrain(),
      makeGridPoints(),
      0,
      '[TEST]',
    );

    expect(result.replanLlmLog).toBeUndefined();
    expect(result.replanSystemPrompt).toBeUndefined();
    expect(result.replanUserPrompt).toBeUndefined();
  });
});

// ── Sub-path 4: No brain available ────────────────────────────────────────

describe('PostDeliveryReplanner.replan — sub-path 4: no brain or no gridPoints', () => {
  it('returns moveTargetInvalidated=true when brain is null', async () => {
    const result = await PostDeliveryReplanner.replan(
      makeRoute(),
      makeSnapshot(),
      makeContext(),
      null, // no brain
      makeGridPoints(),
      0,
      '[TEST]',
    );

    expect(result.moveTargetInvalidated).toBe(true);
    expect(MockTripPlannerClass).not.toHaveBeenCalled();
    expect(mockRevalidate).toHaveBeenCalledTimes(1);
  });

  it('returns moveTargetInvalidated=true when brain is undefined', async () => {
    const result = await PostDeliveryReplanner.replan(
      makeRoute(),
      makeSnapshot(),
      makeContext(),
      undefined,
      makeGridPoints(),
      0,
      '[TEST]',
    );

    expect(result.moveTargetInvalidated).toBe(true);
    expect(MockTripPlannerClass).not.toHaveBeenCalled();
  });

  it('returns moveTargetInvalidated=true when gridPoints is empty', async () => {
    const result = await PostDeliveryReplanner.replan(
      makeRoute(),
      makeSnapshot(),
      makeContext(),
      makeBrain(),
      [], // empty gridPoints
      0,
      '[TEST]',
    );

    expect(result.moveTargetInvalidated).toBe(true);
    expect(MockTripPlannerClass).not.toHaveBeenCalled();
    expect(mockRevalidate).toHaveBeenCalledTimes(1);
  });

  it('returns moveTargetInvalidated=true when gridPoints is undefined', async () => {
    const result = await PostDeliveryReplanner.replan(
      makeRoute(),
      makeSnapshot(),
      makeContext(),
      makeBrain(),
      undefined, // no gridPoints
      0,
      '[TEST]',
    );

    expect(result.moveTargetInvalidated).toBe(true);
    expect(MockTripPlannerClass).not.toHaveBeenCalled();
  });

  it('does not call adviseEnrichment when brain is null', async () => {
    await PostDeliveryReplanner.replan(
      makeRoute(),
      makeSnapshot(),
      makeContext(),
      null,
      makeGridPoints(),
      0,
      '[TEST]',
    );

    expect(mockAdviseEnrichment).not.toHaveBeenCalled();
  });
});

// ── Cross-path invariant: moveTargetInvalidated is always true ─────────────

describe('PostDeliveryReplanner — moveTargetInvalidated invariant', () => {
  it('is true in success path', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (MockTripPlannerClass as any).mockImplementation(() => ({
      planTrip: jest.fn().mockResolvedValue({ route: makeRoute(), llmLog: [] }),
    }));
    const { moveTargetInvalidated } = await PostDeliveryReplanner.replan(
      makeRoute(), makeSnapshot(), makeContext(), makeBrain(), makeGridPoints(), 0, '[TEST]',
    );
    expect(moveTargetInvalidated).toBe(true);
  });

  it('is true in null-route path', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (MockTripPlannerClass as any).mockImplementation(() => ({
      planTrip: jest.fn().mockResolvedValue({ route: null, llmLog: [] }),
    }));
    const { moveTargetInvalidated } = await PostDeliveryReplanner.replan(
      makeRoute(), makeSnapshot(), makeContext(), makeBrain(), makeGridPoints(), 0, '[TEST]',
    );
    expect(moveTargetInvalidated).toBe(true);
  });

  it('is true in throw path', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (MockTripPlannerClass as any).mockImplementation(() => ({
      planTrip: jest.fn().mockRejectedValue(new Error('boom')),
    }));
    const { moveTargetInvalidated } = await PostDeliveryReplanner.replan(
      makeRoute(), makeSnapshot(), makeContext(), makeBrain(), makeGridPoints(), 0, '[TEST]',
    );
    expect(moveTargetInvalidated).toBe(true);
  });

  it('is true in no-brain path', async () => {
    const { moveTargetInvalidated } = await PostDeliveryReplanner.replan(
      makeRoute(), makeSnapshot(), makeContext(), null, makeGridPoints(), 0, '[TEST]',
    );
    expect(moveTargetInvalidated).toBe(true);
  });
});

// ── JIRA-198: Upgrade consumption in sub-path 1 ───────────────────────────

describe('JIRA-198: PostDeliveryReplanner.replan — upgrade consumption (sub-path 1)', () => {
  /**
   * Helper: set up TripPlanner to return a route with upgradeOnRoute set,
   * and set up AdvisorCoordinator to pass it through unchanged.
   */
  function setupRouteWithUpgrade(upgradeOnRoute: string) {
    const routeWithUpgrade = makeRoute({ upgradeOnRoute });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (MockTripPlannerClass as any).mockImplementation(() => ({
      planTrip: jest.fn().mockResolvedValue({ route: routeWithUpgrade, llmLog: [] }),
    }));
    // adviseEnrichment passes through (set in beforeEach)
    return routeWithUpgrade;
  }

  it('AC1: returns pendingUpgradeAction populated when upgrade is eligible', async () => {
    setupRouteWithUpgrade('fast_freight');
    const upgradeAction = { type: 'UpgradeTrain' as AIActionType, targetTrain: 'fast_freight', cost: 20 };
    mockTryConsumeUpgrade.mockReturnValue({ action: upgradeAction });

    const result = await PostDeliveryReplanner.replan(
      makeRoute(),
      makeSnapshot(),
      makeContext(),
      makeBrain(),
      makeGridPoints(),
      2, // deliveriesThisTurn
      '[TEST]',
    );

    expect(result.pendingUpgradeAction).toEqual(upgradeAction);
    expect(result.upgradeSuppressionReason).toBeNull();
    // tryConsumeUpgrade was called with the correct delivery count
    // (memory.deliveryCount=2 + deliveriesThisTurn=2 = 4, which meets the gate)
    expect(mockTryConsumeUpgrade).toHaveBeenCalledWith(
      expect.objectContaining({ upgradeOnRoute: 'fast_freight' }),
      expect.anything(),
      '[TEST]',
      4, // memory.deliveryCount(2) + deliveriesThisTurn(2)
    );
  });

  it('AC2: returns null + reason when delivery count is below threshold (gate-blocked)', async () => {
    setupRouteWithUpgrade('fast_freight');
    mockTryConsumeUpgrade.mockReturnValue({
      action: null,
      reason: 'Upgrade blocked: only 3 deliveries (need 4)',
    });

    const result = await PostDeliveryReplanner.replan(
      makeRoute(),
      makeSnapshot(),
      makeContext(),
      makeBrain(),
      makeGridPoints(),
      1, // deliveriesThisTurn — memory(2)+1=3, below gate of 4
      '[TEST]',
    );

    expect(result.pendingUpgradeAction).toBeNull();
    expect(result.upgradeSuppressionReason).toBe('Upgrade blocked: only 3 deliveries (need 4)');
  });

  it('AC2: returns null + reason when bot cannot afford the upgrade (unaffordable)', async () => {
    setupRouteWithUpgrade('fast_freight');
    mockTryConsumeUpgrade.mockReturnValue({
      action: null,
      reason: 'Upgrade blocked: insufficient funds (need 20M, have 15M)',
    });

    const result = await PostDeliveryReplanner.replan(
      makeRoute(),
      makeSnapshot(),
      makeContext(),
      makeBrain(),
      makeGridPoints(),
      2,
      '[TEST]',
    );

    expect(result.pendingUpgradeAction).toBeNull();
    expect(result.upgradeSuppressionReason).toContain('insufficient funds');
  });

  it('AC2: returns null + reason for invalid upgrade path', async () => {
    setupRouteWithUpgrade('fast_freight');
    mockTryConsumeUpgrade.mockReturnValue({
      action: null,
      reason: 'Upgrade blocked: invalid upgrade path "fast_freight" from "Superfreight"',
    });

    const result = await PostDeliveryReplanner.replan(
      makeRoute(),
      makeSnapshot(),
      makeContext(),
      makeBrain(),
      makeGridPoints(),
      2,
      '[TEST]',
    );

    expect(result.pendingUpgradeAction).toBeNull();
    expect(result.upgradeSuppressionReason).toContain('invalid upgrade path');
  });

  it('sub-path 2 (null route): both upgrade fields undefined', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (MockTripPlannerClass as any).mockImplementation(() => ({
      planTrip: jest.fn().mockResolvedValue({ route: null, llmLog: [] }),
    }));

    const result = await PostDeliveryReplanner.replan(
      makeRoute(), makeSnapshot(), makeContext(), makeBrain(), makeGridPoints(), 0, '[TEST]',
    );

    expect(result.pendingUpgradeAction).toBeUndefined();
    expect(result.upgradeSuppressionReason).toBeUndefined();
    expect(mockTryConsumeUpgrade).not.toHaveBeenCalled();
  });

  it('sub-path 3 (throw): both upgrade fields undefined', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (MockTripPlannerClass as any).mockImplementation(() => ({
      planTrip: jest.fn().mockRejectedValue(new Error('LLM error')),
    }));

    const result = await PostDeliveryReplanner.replan(
      makeRoute(), makeSnapshot(), makeContext(), makeBrain(), makeGridPoints(), 0, '[TEST]',
    );

    expect(result.pendingUpgradeAction).toBeUndefined();
    expect(result.upgradeSuppressionReason).toBeUndefined();
    expect(mockTryConsumeUpgrade).not.toHaveBeenCalled();
  });

  it('sub-path 4 (no brain): both upgrade fields undefined', async () => {
    const result = await PostDeliveryReplanner.replan(
      makeRoute(), makeSnapshot(), makeContext(), null, makeGridPoints(), 0, '[TEST]',
    );

    expect(result.pendingUpgradeAction).toBeUndefined();
    expect(result.upgradeSuppressionReason).toBeUndefined();
    expect(mockTryConsumeUpgrade).not.toHaveBeenCalled();
  });

  it('sub-path 1 with no upgradeOnRoute: both upgrade fields undefined', async () => {
    // Route has no upgradeOnRoute — tryConsumeUpgrade should NOT be called
    const routeWithoutUpgrade = makeRoute(); // no upgradeOnRoute
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (MockTripPlannerClass as any).mockImplementation(() => ({
      planTrip: jest.fn().mockResolvedValue({ route: routeWithoutUpgrade, llmLog: [] }),
    }));

    const result = await PostDeliveryReplanner.replan(
      makeRoute(), makeSnapshot(), makeContext(), makeBrain(), makeGridPoints(), 0, '[TEST]',
    );

    expect(result.pendingUpgradeAction).toBeUndefined();
    expect(result.upgradeSuppressionReason).toBeUndefined();
    expect(mockTryConsumeUpgrade).not.toHaveBeenCalled();
  });
});

// ── JIRA-198: Multi-replan accumulation (last non-null wins) ─────────────

describe('JIRA-198: multi-replan accumulation — last non-null action wins', () => {
  /**
   * These tests exercise MovementPhasePlanner's accumulator logic indirectly
   * by verifying that PostDeliveryReplanner.replan returns the right values
   * for each replan call, then checking the "last non-null wins" contract.
   *
   * The accumulator lives in MovementPhasePlanner. These tests verify the
   * per-replan building blocks that feed into it.
   */

  it('second replan emits valid upgrade after first suppressed → valid upgrade wins', async () => {
    // First replan call: suppressed (delivery count below threshold)
    const routeWithUpgrade = makeRoute({ upgradeOnRoute: 'fast_freight' });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (MockTripPlannerClass as any).mockImplementation(() => ({
      planTrip: jest.fn().mockResolvedValue({ route: routeWithUpgrade, llmLog: [] }),
    }));
    mockTryConsumeUpgrade.mockReturnValue({
      action: null,
      reason: 'Upgrade blocked: only 3 deliveries (need 4)',
    });

    const result1 = await PostDeliveryReplanner.replan(
      makeRoute(), makeSnapshot(), makeContext(), makeBrain(), makeGridPoints(), 1, '[TEST]',
    );

    expect(result1.pendingUpgradeAction).toBeNull();
    expect(result1.upgradeSuppressionReason).toContain('only 3 deliveries');

    // Second replan call: upgrade now eligible
    const upgradeAction = { type: 'UpgradeTrain' as AIActionType, targetTrain: 'fast_freight', cost: 20 };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (MockTripPlannerClass as any).mockImplementation(() => ({
      planTrip: jest.fn().mockResolvedValue({ route: routeWithUpgrade, llmLog: [] }),
    }));
    mockTryConsumeUpgrade.mockReturnValue({ action: upgradeAction });

    const result2 = await PostDeliveryReplanner.replan(
      makeRoute(), makeSnapshot(), makeContext(), makeBrain(), makeGridPoints(), 2, '[TEST]',
    );

    expect(result2.pendingUpgradeAction).toEqual(upgradeAction);
    expect(result2.upgradeSuppressionReason).toBeNull();

    // Verify: accumulator (in MovementPhasePlanner) would keep the non-null from result2
    // since result2.pendingUpgradeAction !== null, it replaces the earlier null.
  });

  it('second replan emits null after first had valid upgrade → non-null is preserved', async () => {
    // First replan: valid upgrade
    const routeWithUpgrade = makeRoute({ upgradeOnRoute: 'fast_freight' });
    const upgradeAction = { type: 'UpgradeTrain' as AIActionType, targetTrain: 'fast_freight', cost: 20 };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (MockTripPlannerClass as any).mockImplementation(() => ({
      planTrip: jest.fn().mockResolvedValue({ route: routeWithUpgrade, llmLog: [] }),
    }));
    mockTryConsumeUpgrade.mockReturnValue({ action: upgradeAction });

    const result1 = await PostDeliveryReplanner.replan(
      makeRoute(), makeSnapshot(), makeContext(), makeBrain(), makeGridPoints(), 2, '[TEST]',
    );

    expect(result1.pendingUpgradeAction).toEqual(upgradeAction);

    // Second replan: null route → sub-path 2 (no upgrade fields produced)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (MockTripPlannerClass as any).mockImplementation(() => ({
      planTrip: jest.fn().mockResolvedValue({ route: null, llmLog: [] }),
    }));

    const result2 = await PostDeliveryReplanner.replan(
      makeRoute(), makeSnapshot(), makeContext(), makeBrain(), makeGridPoints(), 2, '[TEST]',
    );

    // Sub-path 2 returns undefined for both upgrade fields
    expect(result2.pendingUpgradeAction).toBeUndefined();
    expect(result2.upgradeSuppressionReason).toBeUndefined();

    // The accumulator in MovementPhasePlanner checks: if result2.pendingUpgradeAction is
    // undefined (not null), it does NOT update the accumulator — preserving result1's value.
    // This contract is enforced by the "pendingUpgradeAction !== undefined" guard in
    // MovementPhasePlanner.
  });
});
