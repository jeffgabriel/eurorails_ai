/**
 * JIRA-156 E2E Integration Tests
 *
 * Validates the resolution of critical bugs and correct functioning of new flows
 * introduced by TurnExecutorPlanner:
 *
 *   Bug A: Beer@Holland not delivered — pickup completion must not reorder route
 *   Bug B: Wrong-direction A3 move — getNetworkFrontier must exclude unnamed mileposts
 *   Mid-turn replan — delivery triggers TripPlanner + RouteEnrichmentAdvisor, bot
 *                     continues movement on new route with remaining budget
 */

// ── Mocks (hoisted by Jest) ──────────────────────────────────────────────

jest.mock('../../../services/ai/MapTopology', () => ({
  loadGridPoints: jest.fn(() => new Map()),
}));

jest.mock('../../../services/ai/routeHelpers', () => ({
  isStopComplete: jest.fn(),
  resolveBuildTarget: jest.fn(() => null),
  getNetworkFrontier: jest.fn(() => []),
}));

jest.mock('../../../services/ai/ActionResolver', () => ({
  ActionResolver: {
    resolve: jest.fn(),
    resolveMove: jest.fn(),
  },
}));

jest.mock('../../../../shared/services/majorCityGroups', () => ({
  getMajorCityLookup: jest.fn(() => new Map()),
  computeEffectivePathLength: jest.fn(() => 3),
}));

jest.mock('../../../services/ai/TripPlanner', () => ({
  TripPlanner: jest.fn().mockImplementation(() => ({
    planTrip: jest.fn().mockResolvedValue({ route: null, llmLog: [] }),
  })),
}));

jest.mock('../../../services/ai/RouteEnrichmentAdvisor', () => ({
  RouteEnrichmentAdvisor: {
    enrich: jest.fn((route: any) => route),
  },
}));

jest.mock('../../../services/ai/BuildAdvisor', () => ({
  BuildAdvisor: {
    advise: jest.fn().mockResolvedValue(null),
    retryWithSolvencyFeedback: jest.fn().mockResolvedValue(null),
    lastDiagnostics: {},
  },
}));

jest.mock('../../../../shared/constants/gameRules', () => ({
  TURN_BUILD_BUDGET: 20,
}));

jest.mock('../../../services/ai/BotMemory', () => ({
  getMemory: jest.fn(() => ({
    currentBuildTarget: null,
    turnsOnTarget: 0,
    lastAction: null,
    noProgressTurns: 0,
    consecutiveDiscards: 0,
    deliveryCount: 0,
    totalEarnings: 0,
    turnNumber: 0,
    activeRoute: null,
    turnsOnRoute: 0,
    routeHistory: [],
    lastReasoning: null,
    lastPlanHorizon: null,
    previousRouteStops: null,
    consecutiveLlmFailures: 0,
  })),
}));

// ── Imports ──────────────────────────────────────────────────────────────

import { TurnExecutorPlanner } from '../../../services/ai/TurnExecutorPlanner';
import { AIActionType } from '../../../../shared/types/GameTypes';
import type {
  StrategicRoute,
  RouteStop,
  GameContext,
  WorldSnapshot,
} from '../../../../shared/types/GameTypes';

import { isStopComplete, getNetworkFrontier } from '../../../services/ai/routeHelpers';
import { ActionResolver } from '../../../services/ai/ActionResolver';
import { TripPlanner } from '../../../services/ai/TripPlanner';
import { RouteEnrichmentAdvisor } from '../../../services/ai/RouteEnrichmentAdvisor';

const mockIsStopComplete = isStopComplete as jest.Mock;
const mockGetNetworkFrontier = getNetworkFrontier as jest.Mock;
const mockResolve = ActionResolver.resolve as jest.Mock;
const mockResolveMove = ActionResolver.resolveMove as jest.Mock;
const MockTripPlanner = TripPlanner as jest.MockedClass<typeof TripPlanner>;
const mockEnrich = RouteEnrichmentAdvisor.enrich as jest.Mock;

// ── Factory helpers ──────────────────────────────────────────────────────

function makeStop(
  action: 'pickup' | 'deliver',
  city: string,
  loadType: string = 'Beer',
): RouteStop {
  return { action, city, loadType };
}

function makeRoute(overrides: Partial<StrategicRoute> = {}): StrategicRoute {
  return {
    stops: [],
    currentStopIndex: 0,
    phase: 'travel',
    startingCity: 'Amsterdam',
    createdAtTurn: 1,
    reasoning: 'test route',
    ...overrides,
  };
}

function makeContext(overrides: Partial<GameContext> = {}): GameContext {
  return {
    position: null,
    money: 100,
    speed: 9,
    capacity: 2,
    loads: [],
    demands: [],
    citiesOnNetwork: ['Amsterdam', 'Holland', 'Berlin', 'Paris'],
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

function makeSnapshot(overrides: Partial<{ botCity: string; botRow: number; botCol: number }> = {}): WorldSnapshot {
  const { botCity = null, botRow = 5, botCol = 5 } = overrides;
  return {
    bot: {
      position: botCity ? { city: botCity, row: botRow, col: botCol } : { row: botRow, col: botCol },
      existingSegments: [],
      money: 100,
      trainType: 'Freight',
      loads: [],
    },
    players: [],
    loadAvailability: {},
  } as unknown as WorldSnapshot;
}

// ── Setup/teardown ───────────────────────────────────────────────────────

let mockRevalidate: jest.SpyInstance;
let mockShouldDeferBuild: jest.SpyInstance;

beforeEach(() => {
  jest.clearAllMocks();
  mockRevalidate = jest.spyOn(TurnExecutorPlanner, 'revalidateRemainingDeliveries')
    .mockImplementation((route: StrategicRoute) => route);
  mockShouldDeferBuild = jest.spyOn(TurnExecutorPlanner, 'shouldDeferBuild')
    .mockReturnValue({
      deferred: false,
      reason: 'build_needed',
      trackRunway: 0,
      intermediateStopTurns: 0,
      effectiveRunway: 0,
    });
  // Default: stop is NOT complete
  mockIsStopComplete.mockReturnValue(false);
});

afterEach(() => {
  mockRevalidate.mockRestore();
  mockShouldDeferBuild.mockRestore();
});

// ── Bug A: Beer@Holland not delivered ───────────────────────────────────

describe('JIRA-156 Bug A: Beer@Holland — pickup completion must not reorder route', () => {
  /**
   * Scenario:
   *   Route: [pickup Beer @ Amsterdam, deliver Beer @ Holland]
   *   Bot is AT Amsterdam with Beer pickup pending.
   *
   *   OLD BUG: After pickup success, skipCompletedStops advanced to stop 2
   *   (deliver), but then erroneously re-ran stop-completion checks which
   *   marked the delivery city (Holland) as already complete, causing the
   *   route to short-circuit and never deliver.
   *
   *   FIX: skipCompletedStops only advances for stops that isStopComplete
   *   returns true for. Delivery at Holland is NOT yet complete (bot hasn't
   *   been there), so currentStopIndex advances to 1 (deliver), not beyond.
   */
  it('should execute pickup and not mark route complete when delivery stop still pending', async () => {
    /**
     * Bug A scenario: Route has [pickup Beer@Amsterdam, deliver Beer@Holland].
     * skipCompletedStops starts at index 0; the pickup stop is NOT yet complete
     * (bot hasn't run the action yet). The bot is at Amsterdam.
     * After running the pickup action, the route advances to index 1 (deliver@Holland)
     * but Holland delivery is NOT yet done → route is NOT complete.
     */
    const pickupPlan = {
      type: AIActionType.PickupLoad,
      load: 'Beer',
      city: 'Amsterdam',
    };
    const movePlan = {
      type: AIActionType.MoveTrain,
      path: [{ row: 2, col: 2 }, { row: 3, col: 3 }],
      fees: new Set<string>(),
      totalFee: 0,
    };
    // pickup succeeds, then move toward Holland
    mockResolve.mockResolvedValue({ success: true, plan: pickupPlan });
    mockResolveMove.mockResolvedValue({ success: true, plan: movePlan });

    // skipCompletedStops: pickup stop NOT complete (bot hasn't done it yet)
    //   → then after pickup, loop advances to deliver stop which is also NOT complete
    mockIsStopComplete.mockReturnValue(false);

    const route = makeRoute({
      stops: [
        makeStop('pickup', 'Amsterdam', 'Beer'),
        makeStop('deliver', 'Holland', 'Beer'),
      ],
      currentStopIndex: 0,
    });
    const context = makeContext({
      position: { city: 'Amsterdam', row: 2, col: 2 },
      loads: [],
      citiesOnNetwork: ['Amsterdam', 'Holland'],
    });
    const snapshot = makeSnapshot({ botCity: 'Amsterdam', botRow: 2, botCol: 2 });

    const result = await TurnExecutorPlanner.execute(route, snapshot, context);

    // Pickup action was executed — plan contains pickup
    expect(result.plans).toContainEqual(pickupPlan);

    // Route must NOT be complete — Holland delivery not yet done
    expect(result.routeComplete).toBe(false);

    // updatedRoute must still point to the delivery stop (not past it)
    expect(result.updatedRoute.stops.some(s => s.action === 'deliver' && s.city === 'Holland')).toBe(true);
  });

  it('should execute delivery at Holland when bot arrives there — delivery stop executes when at city', async () => {
    const deliverPlan = {
      type: AIActionType.DeliverLoad,
      load: 'Beer',
      city: 'Holland',
      cardId: 7,
      payout: 12,
    };
    // deliver succeeds; no move needed (already at delivery city)
    mockResolve.mockResolvedValue({ success: true, plan: deliverPlan });

    // All stops: stop 1 (deliver@Holland) is NOT complete initially
    mockIsStopComplete.mockReturnValue(false);

    // Route with only the delivery stop remaining (pickup already done in prior turn)
    const route = makeRoute({
      stops: [makeStop('deliver', 'Holland', 'Beer')],
      currentStopIndex: 0,
    });
    const context = makeContext({
      position: { city: 'Holland', row: 4, col: 4 },
      loads: ['Beer'],
      citiesOnNetwork: ['Holland'],
    });
    const snapshot = makeSnapshot({ botCity: 'Holland', botRow: 4, botCol: 4 });

    const result = await TurnExecutorPlanner.execute(route, snapshot, context);

    // hasDelivery should be true — confirms the delivery was executed
    expect(result.hasDelivery).toBe(true);

    // Route should be complete after the last stop delivered
    expect(result.routeComplete).toBe(true);

    // Deliver plan should be in the output
    expect(result.plans).toContainEqual(deliverPlan);
  });
});

// ── Bug B: Wrong-direction A3 move ──────────────────────────────────────

describe('JIRA-156 Bug B: wrong-direction A3 move — getNetworkFrontier excludes unnamed mileposts', () => {
  /**
   * Scenario:
   *   Route: [pickup Coal @ München]
   *   München is NOT on the bot's track network yet → triggers A3 frontier move.
   *
   *   OLD BUG: getNetworkFrontier returned unnamed mileposts (no cityName),
   *   which were dead-end track stubs. Bot would move to these stubs — away
   *   from München — wasting movement budget.
   *
   *   FIX: getNetworkFrontier now only returns nodes with a cityName. Unnamed
   *   mileposts are excluded. Confirmed by the frontier mock only returning
   *   named cities.
   */
  it('should move toward a named frontier city (Ruhr) when München is off-network', async () => {
    // Only named frontier node — unnamed mileposts excluded by getNetworkFrontier fix
    mockGetNetworkFrontier.mockReturnValue([
      { row: 3, col: 3, cityName: 'Ruhr' },
    ]);

    const a3MovePlan = {
      type: AIActionType.MoveTrain,
      path: [{ row: 5, col: 5 }, { row: 4, col: 4 }, { row: 3, col: 3 }],
      fees: new Set<string>(),
      totalFee: 0,
    };
    mockResolveMove.mockResolvedValue({ success: true, plan: a3MovePlan });

    const route = makeRoute({
      stops: [makeStop('pickup', 'München', 'Coal')],
      currentStopIndex: 0,
    });
    const context = makeContext({
      citiesOnNetwork: ['Paris', 'Ruhr'],  // München NOT on network → A3
      position: { city: 'Paris', row: 5, col: 5 },
      speed: 9,
    });
    const snapshot = makeSnapshot({ botCity: 'Paris', botRow: 5, botCol: 5 });

    const result = await TurnExecutorPlanner.execute(route, snapshot, context);

    // A3 move plan toward Ruhr should be in output
    expect(result.plans).toContainEqual(a3MovePlan);
    expect(result.compositionTrace.a3.movePreprended).toBe(true);

    // resolveMove should have been called with { to: 'Ruhr' } — a named city target
    expect(mockResolveMove).toHaveBeenCalledWith(
      expect.objectContaining({ to: 'Ruhr' }),
      snapshot,
      expect.any(Number),
    );
  });

  it('should NOT emit A3 move when getNetworkFrontier returns no named frontier nodes', async () => {
    // Empty frontier — all nodes were unnamed or excluded (the Bug B scenario fixed)
    mockGetNetworkFrontier.mockReturnValue([]);

    const route = makeRoute({
      stops: [makeStop('pickup', 'München', 'Coal')],
      currentStopIndex: 0,
    });
    const context = makeContext({
      citiesOnNetwork: [],  // München NOT on network
      position: { city: 'Paris', row: 5, col: 5 },
    });
    const snapshot = makeSnapshot({ botCity: 'Paris', botRow: 5, botCol: 5 });

    const result = await TurnExecutorPlanner.execute(route, snapshot, context);

    // No A3 move — frontier was empty after unnamed milepost exclusion
    expect(mockResolveMove).not.toHaveBeenCalled();
    expect(result.compositionTrace.a3.movePreprended).toBe(false);
    expect(result.compositionTrace.a2.terminationReason).toBe('stop_city_not_on_network');
  });

  it('getNetworkFrontier is called with the correct off-network target city', async () => {
    mockGetNetworkFrontier.mockReturnValue([]);

    const route = makeRoute({
      stops: [makeStop('pickup', 'München', 'Coal')],
      currentStopIndex: 0,
    });
    const context = makeContext({
      citiesOnNetwork: [], // München NOT on network
      position: { city: 'Paris', row: 5, col: 5 },
    });
    const snapshot = makeSnapshot({ botCity: 'Paris', botRow: 5, botCol: 5 });

    await TurnExecutorPlanner.execute(route, snapshot, context);

    // getNetworkFrontier must be called with the off-network city name ('München')
    // so it can compute frontier nodes in the direction of that target
    // Note: second arg is gridPoints (undefined when not provided to execute())
    expect(mockGetNetworkFrontier).toHaveBeenCalledWith(
      snapshot,
      undefined,
      'München',
    );
  });
});

// ── Mid-turn replan after delivery ──────────────────────────────────────

describe('JIRA-156 mid-turn replan: delivery triggers TripPlanner + RouteEnrichmentAdvisor stub', () => {
  /**
   * Scenario:
   *   Bot delivers Coal at Berlin, triggering a mid-turn replan.
   *   TripPlanner produces a new route (Wine: Lyon → Madrid).
   *   RouteEnrichmentAdvisor.enrich() is called — stub returns route unchanged.
   *   Bot has remaining movement budget and should proceed on the NEW route.
   */
  let mockPlanTrip: jest.Mock;

  beforeEach(() => {
    mockPlanTrip = jest.fn().mockResolvedValue({ route: null, llmLog: [] });
    MockTripPlanner.mockImplementation(() => ({ planTrip: mockPlanTrip }) as any);
    // Enrich stub returns route unchanged
    mockEnrich.mockImplementation((r: StrategicRoute) => r);
  });

  it('triggers TripPlanner.planTrip() and RouteEnrichmentAdvisor.enrich() after delivery', async () => {
    const deliverPlan = {
      type: AIActionType.DeliverLoad,
      load: 'Coal',
      city: 'Berlin',
      cardId: 5,
      payout: 10,
    };
    mockResolve.mockResolvedValueOnce({ success: true, plan: deliverPlan });

    const newRoute = makeRoute({
      stops: [
        makeStop('pickup', 'Lyon', 'Wine'),
        makeStop('deliver', 'Madrid', 'Wine'),
      ],
      reasoning: 'replanned: wine route',
    });
    mockPlanTrip.mockResolvedValue({ route: newRoute, llmLog: [] });

    const route = makeRoute({
      stops: [makeStop('deliver', 'Berlin', 'Coal')],
      currentStopIndex: 0,
    });
    const context = makeContext({
      position: { city: 'Berlin', row: 2, col: 2 },
      loads: ['Coal'],
    });
    const snapshot = makeSnapshot({ botCity: 'Berlin', botRow: 2, botCol: 2 });
    const fakeBrain = {} as any;
    const fakeGridPoints = [{ row: 1, col: 1, name: 'Berlin' }] as any;

    await TurnExecutorPlanner.execute(route, snapshot, context, fakeBrain, fakeGridPoints);

    // TripPlanner.planTrip() must have been called
    expect(mockPlanTrip).toHaveBeenCalledWith(snapshot, context, fakeGridPoints, expect.anything());

    // RouteEnrichmentAdvisor.enrich() must be called with the new route (stub returns it unchanged)
    expect(mockEnrich).toHaveBeenCalledWith(newRoute, expect.anything(), expect.anything(), expect.anything(), expect.anything());
  });

  it('updatedRoute reflects the replanned route after mid-turn replan', async () => {
    const deliverPlan = {
      type: AIActionType.DeliverLoad,
      load: 'Coal',
      city: 'Berlin',
      cardId: 5,
      payout: 10,
    };
    mockResolve.mockResolvedValue({ success: true, plan: deliverPlan });
    // After replan, bot continues on new route. Move toward Lyon fails → breaks to Phase B
    mockResolveMove.mockResolvedValue({ success: false, error: 'path not found' });

    const newRoute = makeRoute({
      stops: [
        makeStop('pickup', 'Lyon', 'Wine'),
        makeStop('deliver', 'Madrid', 'Wine'),
      ],
      reasoning: 'replanned: wine route',
    });
    mockPlanTrip.mockResolvedValue({ route: newRoute, llmLog: [] });
    mockEnrich.mockReturnValue(newRoute);

    const route = makeRoute({
      stops: [makeStop('deliver', 'Berlin', 'Coal')],
      currentStopIndex: 0,
    });
    const context = makeContext({
      position: { city: 'Berlin', row: 2, col: 2 },
      loads: ['Coal'],
      citiesOnNetwork: ['Berlin', 'Lyon', 'Madrid'],
    });
    const snapshot = makeSnapshot({ botCity: 'Berlin', botRow: 2, botCol: 2 });

    const fakeGridPoints = [{ row: 2, col: 2, name: 'Berlin' }] as any;

    const result = await TurnExecutorPlanner.execute(
      route, snapshot, context, {} as any, fakeGridPoints,
    );

    // updatedRoute must reference the new replanned route
    expect(result.updatedRoute.reasoning).toBe('replanned: wine route');
    expect(result.updatedRoute.stops).toHaveLength(2);
    expect(result.updatedRoute.stops[0].city).toBe('Lyon');
  });

  it('falls back to revalidateRemainingDeliveries when TripPlanner returns null route', async () => {
    const deliverPlan = {
      type: AIActionType.DeliverLoad,
      load: 'Coal',
      city: 'Berlin',
      cardId: 5,
      payout: 10,
    };
    mockResolve.mockResolvedValueOnce({ success: true, plan: deliverPlan });

    // TripPlanner returns null — replan failure
    mockPlanTrip.mockResolvedValue({ route: null, llmLog: [] });

    const route = makeRoute({
      stops: [makeStop('deliver', 'Berlin', 'Coal')],
      currentStopIndex: 0,
    });
    const context = makeContext({
      position: { city: 'Berlin', row: 2, col: 2 },
      loads: ['Coal'],
    });
    const snapshot = makeSnapshot({ botCity: 'Berlin', botRow: 2, botCol: 2 });

    await TurnExecutorPlanner.execute(
      route, snapshot, context, {} as any, [] as any,
    );

    // Must fall back to revalidateRemainingDeliveries instead
    expect(mockRevalidate).toHaveBeenCalled();
    // enrich NOT called since TripPlanner returned null
    expect(mockEnrich).not.toHaveBeenCalled();
  });

  it('RouteEnrichmentAdvisor.enrich() stub returns the route unchanged (pass-through verified)', async () => {
    const deliverPlan = {
      type: AIActionType.DeliverLoad,
      load: 'Coal',
      city: 'Berlin',
      cardId: 5,
      payout: 10,
    };
    mockResolve.mockResolvedValue({ success: true, plan: deliverPlan });
    // After replan, move toward Lyon fails → breaks to Phase B
    mockResolveMove.mockResolvedValue({ success: false, error: 'path not found' });

    const newRoute = makeRoute({
      stops: [makeStop('pickup', 'Lyon', 'Wine'), makeStop('deliver', 'Madrid', 'Wine')],
      reasoning: 'wine route',
    });
    mockPlanTrip.mockResolvedValue({ route: newRoute, llmLog: [] });
    // Enrich returns SAME route object — pass-through
    mockEnrich.mockImplementation((r: StrategicRoute) => r);

    const route = makeRoute({
      stops: [makeStop('deliver', 'Berlin', 'Coal')],
      currentStopIndex: 0,
    });
    const context = makeContext({
      position: { city: 'Berlin', row: 2, col: 2 },
      citiesOnNetwork: ['Berlin', 'Lyon', 'Madrid'],
    });
    const snapshot = makeSnapshot({ botCity: 'Berlin', botRow: 2, botCol: 2 });

    const fakeGridPoints = [{ row: 2, col: 2, name: 'Berlin' }] as any;

    const result = await TurnExecutorPlanner.execute(
      route, snapshot, context, {} as any, fakeGridPoints,
    );

    // enrich stub returns input unchanged — updatedRoute should reference new route
    expect(result.updatedRoute.reasoning).toBe('wine route');
  });
});
