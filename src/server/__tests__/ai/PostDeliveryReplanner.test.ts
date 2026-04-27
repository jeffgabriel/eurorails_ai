/**
 * PostDeliveryReplanner unit tests (JIRA-195 Slice 3a).
 *
 * Covers all four sub-paths:
 *   1. Success — TripPlanner returns a route → enriched + skipCompletedStops
 *   2. Null route — TripPlanner returns null → revalidate existing route
 *   3. Throw — TripPlanner throws → revalidate existing route
 *   4. No brain — brain null or gridPoints empty → revalidate existing route
 *
 * In every sub-path, moveTargetInvalidated must be true (JIRA-194 contract).
 */

import { PostDeliveryReplanner } from '../../services/ai/PostDeliveryReplanner';
import { TurnExecutorPlanner } from '../../services/ai/TurnExecutorPlanner';
import type {
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

const MockTripPlannerClass = TripPlanner as jest.MockedClass<typeof TripPlanner>;
const mockAdviseEnrichment = AdvisorCoordinator.adviseEnrichment as jest.Mock;

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
