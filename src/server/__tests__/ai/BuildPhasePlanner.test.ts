/**
 * BuildPhasePlanner unit tests (JIRA-195 Slice 3b).
 *
 * Phase B scenarios: no build target, build target resolved, JIT gate deferral,
 * capped-city 2a/2b/2c paths, empty plans → PassTurn, route complete / abandoned pass-through.
 */

import { BuildPhasePlanner } from '../../services/ai/BuildPhasePlanner';
import { TurnExecutorPlanner } from '../../services/ai/TurnExecutorPlanner';
import { AIActionType } from '../../../shared/types/GameTypes';
import type {
  StrategicRoute,
  RouteStop,
  GameContext,
  WorldSnapshot,
  GridPoint,
} from '../../../shared/types/GameTypes';
import type { LLMStrategyBrain } from '../../services/ai/LLMStrategyBrain';
import type { CompositionTrace } from '../../services/ai/TurnExecutorPlanner';
import type { PhaseAResult } from '../../services/ai/schemas';

// ── Mock dependencies ──────────────────────────────────────────────────────

jest.mock('../../services/ai/routeHelpers', () => ({
  resolveBuildTarget: jest.fn(),
  isStopComplete: jest.fn(),
  getNetworkFrontier: jest.fn(() => []),
  applyStopEffectToLocalState: jest.fn(),
}));

jest.mock('../../../shared/services/trackUsageFees', () => ({
  buildUnionTrackGraph: jest.fn(() => ({
    adjacency: new Map(),
    edgeOwners: new Map(),
  })),
}));

jest.mock('../../../shared/services/computeTrackUsageFees', () => ({
  computeTrackUsageFees: jest.fn(() => 0),
}));

jest.mock('../../services/ai/MapTopology', () => ({
  loadGridPoints: jest.fn(() => new Map()),
  makeKey: (row: number, col: number) => `${row},${col}`,
  hexDistance: jest.fn(() => 5),
  getHexNeighbors: jest.fn(() => []),
}));

jest.mock('../../../shared/constants/gameRules', () => ({
  TURN_BUILD_BUDGET: 20,
}));

jest.mock('../../../shared/services/majorCityGroups', () => ({
  getMajorCityLookup: jest.fn(() => new Map()),
  computeEffectivePathLength: jest.fn(() => 3),
}));

jest.mock('../../services/ai/computeBuildSegments', () => ({
  computeBuildSegments: jest.fn(() => []),
}));

jest.mock('../../services/ai/ActionResolver', () => ({
  ActionResolver: {
    resolve: jest.fn(),
    resolveMove: jest.fn(),
  },
}));

jest.mock('../../services/ai/AdvisorCoordinator', () => ({
  AdvisorCoordinator: {
    adviseBuild: jest.fn().mockResolvedValue({ plan: null }),
    adviseEnrichment: jest.fn(async (route: unknown) => route),
  },
}));

jest.mock('../../services/ai/BuildAdvisor', () => ({
  BuildAdvisor: {
    advise: jest.fn().mockResolvedValue(null),
    retryWithSolvencyFeedback: jest.fn().mockResolvedValue(null),
    lastDiagnostics: {},
  },
}));

import { resolveBuildTarget } from '../../services/ai/routeHelpers';

const mockResolveBuildTarget = resolveBuildTarget as jest.Mock;
let mockIsCappedCityBlocked: jest.SpyInstance;
let mockResolveCappedCityDelivery: jest.SpyInstance;
let mockAssertBuildDirection: jest.SpyInstance;
let mockExecuteBuildPhase: jest.SpyInstance;
let mockShouldDeferBuild: jest.SpyInstance;

// ── Factory helpers ────────────────────────────────────────────────────────

function makeStop(
  action: 'pickup' | 'deliver',
  city = 'TestCity',
  loadType = 'Coal',
): RouteStop {
  return { action, city, loadType };
}

function makeRoute(overrides: Partial<StrategicRoute> = {}): StrategicRoute {
  return {
    stops: [makeStop('pickup', 'Paris'), makeStop('deliver', 'Berlin')],
    currentStopIndex: 0,
    phase: 'travel',
    startingCity: 'Paris',
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

function makePhaseAResult(overrides: Partial<PhaseAResult> = {}): PhaseAResult {
  return {
    activeRoute: makeRoute(),
    lastMoveTargetCity: null,
    deliveriesThisTurn: 0,
    accumulatedPlans: [],
    loadStateMutations: { snapshotLoads: [], contextLoads: [] },
    routeAbandoned: false,
    routeComplete: false,
    hasDelivery: false,
    ...overrides,
  };
}

function makeBrain(): LLMStrategyBrain {
  return {} as LLMStrategyBrain;
}

// ── Test setup ─────────────────────────────────────────────────────────────

beforeEach(() => {
  jest.clearAllMocks();

  mockIsCappedCityBlocked = jest.spyOn(TurnExecutorPlanner, 'isCappedCityBlocked')
    .mockReturnValue(false);

  mockResolveCappedCityDelivery = jest.spyOn(TurnExecutorPlanner, 'resolveCappedCityDelivery')
    .mockReturnValue({ handled: false, plans: [], error: 'default' });

  mockAssertBuildDirection = jest.spyOn(TurnExecutorPlanner, 'assertBuildDirectionAgreesWithMove')
    .mockImplementation(() => { /* no-op */ });

  mockExecuteBuildPhase = jest.spyOn(TurnExecutorPlanner, 'executeBuildPhase')
    .mockResolvedValue(null);

  mockShouldDeferBuild = jest.spyOn(TurnExecutorPlanner, 'shouldDeferBuild')
    .mockReturnValue({
      deferred: false,
      reason: 'build_needed',
      trackRunway: 0,
      intermediateStopTurns: 0,
      effectiveRunway: 0,
    });
});

afterEach(() => {
  mockIsCappedCityBlocked.mockRestore();
  mockResolveCappedCityDelivery.mockRestore();
  mockAssertBuildDirection.mockRestore();
  mockExecuteBuildPhase.mockRestore();
  mockShouldDeferBuild.mockRestore();
});

// ── Route complete / abandoned pass-through ────────────────────────────────

describe('BuildPhasePlanner.run — Phase A result pass-through', () => {
  it('returns phase A plans unchanged when routeComplete=true', async () => {
    const plan = { type: AIActionType.MoveTrain, path: [], milesUsed: 3, cost: 0, trackUsageFees: [] } as unknown as import('../../../shared/types/GameTypes').TurnPlan;
    const phaseA = makePhaseAResult({
      routeComplete: true,
      accumulatedPlans: [plan],
    });

    const result = await BuildPhasePlanner.run(phaseA, makeSnapshot(), makeContext(), makeTrace());

    expect(result.routeComplete).toBe(true);
    expect(result.plans).toHaveLength(1);
    expect(result.plans[0].type).toBe(AIActionType.MoveTrain);
    expect(mockResolveBuildTarget).not.toHaveBeenCalled();
  });

  it('returns phase A plans unchanged when routeAbandoned=true', async () => {
    const phaseA = makePhaseAResult({
      routeAbandoned: true,
      accumulatedPlans: [{ type: AIActionType.PassTurn }],
    });

    const result = await BuildPhasePlanner.run(phaseA, makeSnapshot(), makeContext(), makeTrace());

    expect(result.routeAbandoned).toBe(true);
    expect(result.plans[0].type).toBe(AIActionType.PassTurn);
    expect(mockResolveBuildTarget).not.toHaveBeenCalled();
  });
});

// ── No build target ────────────────────────────────────────────────────────

describe('BuildPhasePlanner.run — no build target', () => {
  it('skips build and emits PassTurn when plans is empty', async () => {
    mockResolveBuildTarget.mockReturnValue(null);

    const result = await BuildPhasePlanner.run(
      makePhaseAResult(),
      makeSnapshot(),
      makeContext(),
      makeTrace(),
    );

    expect(result.plans.some(p => p.type === AIActionType.PassTurn)).toBe(true);
    expect(mockExecuteBuildPhase).not.toHaveBeenCalled();
  });

  it('skips build but emits accumulated Phase A plans when plans exist', async () => {
    mockResolveBuildTarget.mockReturnValue(null);
    const movePlan = { type: AIActionType.MoveTrain, path: [], milesUsed: 3, cost: 0, trackUsageFees: [] } as unknown as import('../../../shared/types/GameTypes').TurnPlan;
    const phaseA = makePhaseAResult({ accumulatedPlans: [movePlan] });

    const result = await BuildPhasePlanner.run(phaseA, makeSnapshot(), makeContext(), makeTrace());

    expect(result.plans).toHaveLength(1);
    expect(result.plans[0].type).toBe(AIActionType.MoveTrain);
    // No PassTurn since we already have plans
    expect(result.plans.some(p => p.type === AIActionType.PassTurn)).toBe(false);
  });
});

// ── Build target resolved ──────────────────────────────────────────────────

describe('BuildPhasePlanner.run — build target resolved', () => {
  it('calls executeBuildPhase and appends the returned plan', async () => {
    mockResolveBuildTarget.mockReturnValue({
      targetCity: 'Munich',
      stopIndex: 1,
      isVictoryBuild: false,
    });
    const buildPlan = {
      type: AIActionType.BuildTrack,
      segments: [{ from: { row: 1, col: 1 }, to: { row: 1, col: 2 }, cost: 5 }],
    } as unknown as import('../../../shared/types/GameTypes').TurnPlan;
    mockExecuteBuildPhase.mockResolvedValue(buildPlan);

    const result = await BuildPhasePlanner.run(
      makePhaseAResult(),
      makeSnapshot(),
      makeContext(),
      makeTrace(),
    );

    expect(mockExecuteBuildPhase).toHaveBeenCalledWith(
      'Munich', false, 1, expect.anything(), expect.anything(), expect.anything(), null, undefined, expect.anything(), expect.anything(),
    );
    expect(result.plans.some(p => p.type === AIActionType.BuildTrack)).toBe(true);
  });

  it('calls assertBuildDirectionAgreesWithMove with lastMoveTargetCity from PhaseAResult', async () => {
    mockResolveBuildTarget.mockReturnValue({
      targetCity: 'Munich',
      stopIndex: 1,
      isVictoryBuild: false,
    });

    const phaseA = makePhaseAResult({ lastMoveTargetCity: 'Berlin' });

    await BuildPhasePlanner.run(phaseA, makeSnapshot(), makeContext(), makeTrace());

    expect(mockAssertBuildDirection).toHaveBeenCalledWith(
      'Munich',
      'Berlin',
      expect.anything(),
      expect.anything(),
    );
  });
});

// ── JIRA-187 capped-city: 2a handled path ─────────────────────────────────

describe('BuildPhasePlanner.run — JIRA-187 capped city', () => {
  it('2a path: returns capped city plans when handled=true', async () => {
    const deliverRoute = makeRoute({
      stops: [makeStop('deliver', 'Cardiff', 'Coal')],
      currentStopIndex: 0,
    });
    const phaseA = makePhaseAResult({ activeRoute: deliverRoute });

    mockIsCappedCityBlocked.mockReturnValue(true);
    const movePlan = { type: AIActionType.MoveTrain } as unknown as import('../../../shared/types/GameTypes').TurnPlan;
    mockResolveCappedCityDelivery.mockReturnValue({
      handled: true,
      plans: [movePlan],
      routeAbandoned: false,
    });

    const result = await BuildPhasePlanner.run(phaseA, makeSnapshot(), makeContext(), makeTrace());

    expect(result.plans[0].type).toBe(AIActionType.MoveTrain);
    expect(result.routeAbandoned).toBe(false);
    expect(mockResolveBuildTarget).not.toHaveBeenCalled();
  });

  it('2c path: routeAbandoned=true when capped city not handled', async () => {
    const deliverRoute = makeRoute({
      stops: [makeStop('deliver', 'Cardiff', 'Coal')],
      currentStopIndex: 0,
    });
    const phaseA = makePhaseAResult({ activeRoute: deliverRoute });

    mockIsCappedCityBlocked.mockReturnValue(true);
    mockResolveCappedCityDelivery.mockReturnValue({
      handled: false,
      plans: [],
      error: 'no path',
    });

    const result = await BuildPhasePlanner.run(phaseA, makeSnapshot(), makeContext(), makeTrace());

    expect(result.routeAbandoned).toBe(true);
    expect(result.plans.some(p => p.type === AIActionType.PassTurn)).toBe(true);
  });
});

// ── Replan LLM data propagated from Phase A ────────────────────────────────

describe('BuildPhasePlanner.run — replan LLM data propagation', () => {
  it('propagates replanLlmLog from PhaseAResult to PhaseBResult', async () => {
    mockResolveBuildTarget.mockReturnValue(null);
    const llmLog = [{ role: 'assistant' }] as unknown as import('../../../shared/types/GameTypes').LlmAttempt[];
    const phaseA = makePhaseAResult({
      replanLlmLog: llmLog,
      replanSystemPrompt: 'sys',
      replanUserPrompt: 'usr',
    });

    const result = await BuildPhasePlanner.run(phaseA, makeSnapshot(), makeContext(), makeTrace());

    expect(result.replanLlmLog).toBe(llmLog);
    expect(result.replanSystemPrompt).toBe('sys');
    expect(result.replanUserPrompt).toBe('usr');
  });
});

// ── hasDelivery propagated ─────────────────────────────────────────────────

describe('BuildPhasePlanner.run — hasDelivery propagation', () => {
  it('propagates hasDelivery=true from PhaseAResult', async () => {
    mockResolveBuildTarget.mockReturnValue(null);
    const phaseA = makePhaseAResult({ hasDelivery: true });

    const result = await BuildPhasePlanner.run(phaseA, makeSnapshot(), makeContext(), makeTrace());

    expect(result.hasDelivery).toBe(true);
  });
});
