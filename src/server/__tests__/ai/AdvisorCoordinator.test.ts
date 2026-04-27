/**
 * Unit tests for AdvisorCoordinator (JIRA-195 Slice 2 TEST-001).
 *
 * Covers:
 *   adviseEnrichment:
 *     - delegates to RouteEnrichmentAdvisor.enrich and returns its result
 *     - passes all parameters through unchanged
 *
 *   adviseBuild:
 *     - precondition skip (advisor returns null — falls through to heuristic path)
 *     - build success (first advise call succeeds)
 *     - solvency-retry success (first build resolution fails, retry succeeds)
 *     - solvency-retry failure (both build resolutions fail → null plan)
 *     - advisor-throw fallback (advise throws → null plan, no crash)
 */

import { AdvisorCoordinator } from '../../services/ai/AdvisorCoordinator';
import { BuildAdvisor } from '../../services/ai/BuildAdvisor';
import { RouteEnrichmentAdvisor } from '../../services/ai/RouteEnrichmentAdvisor';
import { ActionResolver } from '../../services/ai/ActionResolver';
import { LLMStrategyBrain } from '../../services/ai/LLMStrategyBrain';
import {
  WorldSnapshot,
  GameContext,
  StrategicRoute,
  GridPoint,
  TerrainType,
  BuildAdvisorResult,
  AIActionType,
} from '../../../shared/types/GameTypes';

// ── Mocks ────────────────────────────────────────────────────────────────────

jest.mock('../../services/ai/BuildAdvisor');
jest.mock('../../services/ai/RouteEnrichmentAdvisor');
jest.mock('../../services/ai/ActionResolver');

const MockBuildAdvisor = BuildAdvisor as jest.Mocked<typeof BuildAdvisor>;
const MockRouteEnrichmentAdvisor = RouteEnrichmentAdvisor as jest.Mocked<typeof RouteEnrichmentAdvisor>;
const MockActionResolver = ActionResolver as jest.Mocked<typeof ActionResolver>;

// ── Fixture factories ─────────────────────────────────────────────────────────

function gp(row: number, col: number, terrain: TerrainType, cityName?: string): GridPoint {
  return {
    id: `${row},${col}`,
    x: col * 50,
    y: row * 50,
    row,
    col,
    terrain,
    city: cityName ? { type: terrain, name: cityName, availableLoads: [] } : undefined,
  };
}

const testGrid: GridPoint[] = [
  gp(0, 0, TerrainType.MajorCity, 'Berlin'),
  gp(0, 1, TerrainType.Clear),
  gp(1, 0, TerrainType.Clear),
  gp(1, 1, TerrainType.MajorCity, 'Paris'),
];

function makeSnapshot(): WorldSnapshot {
  return {
    gameId: 'test-game',
    gameStatus: 'active',
    turnNumber: 5,
    bot: {
      playerId: 'bot-1',
      userId: 'user-1',
      money: 30,
      position: { row: 0, col: 0 },
      existingSegments: [],
      demandCards: [],
      resolvedDemands: [],
      trainType: 'freight',
      loads: [],
      botConfig: { skillLevel: 'medium' },
      connectedMajorCityCount: 1,
    },
    allPlayerTracks: [{ playerId: 'bot-1', segments: [] }],
    loadAvailability: {},
  };
}

function makeContext(): GameContext {
  return {
    position: { row: 0, col: 0 },
    money: 30,
    trainType: 'freight',
    speed: 9,
    capacity: 2,
    loads: [],
    connectedMajorCities: ['Berlin'],
    unconnectedMajorCities: [{ cityName: 'Paris', estimatedCost: 10 }],
    totalMajorCities: 8,
    trackSummary: '',
    turnBuildCost: 0,
    demands: [],
    canDeliver: [],
    canPickup: [],
    reachableCities: [],
    citiesOnNetwork: ['Berlin'],
    canUpgrade: false,
    canBuild: true,
    isInitialBuild: false,
    opponents: [],
    phase: 'active',
    turnNumber: 5,
  };
}

function makeRoute(): StrategicRoute {
  return {
    stops: [
      { action: 'pickup', loadType: 'Steel', city: 'Berlin' },
      { action: 'deliver', loadType: 'Steel', city: 'Paris', payment: 15 },
    ],
    currentStopIndex: 0,
    phase: 'travel',
    createdAtTurn: 3,
    reasoning: 'Deliver steel to Paris',
    startingCity: 'Berlin',
  };
}

function makeBrain(): LLMStrategyBrain {
  return {
    providerAdapter: { chat: jest.fn(), setContext: jest.fn() },
    modelName: 'test-model',
  } as unknown as LLMStrategyBrain;
}

const TAG = '[AdvisorCoordinator test]';

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('AdvisorCoordinator', () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  // ── adviseEnrichment ────────────────────────────────────────────────────────

  describe('adviseEnrichment', () => {
    it('delegates to RouteEnrichmentAdvisor.enrich and returns its result', async () => {
      const originalRoute = makeRoute();
      const enrichedRoute: StrategicRoute = {
        ...originalRoute,
        stops: [
          ...originalRoute.stops,
          { action: 'pickup', loadType: 'Coal', city: 'SomeCity' },
        ],
      };

      MockRouteEnrichmentAdvisor.enrich.mockResolvedValue(enrichedRoute);

      const result = await AdvisorCoordinator.adviseEnrichment(
        originalRoute,
        makeSnapshot(),
        makeContext(),
        makeBrain(),
        testGrid,
      );

      expect(MockRouteEnrichmentAdvisor.enrich).toHaveBeenCalledTimes(1);
      expect(result).toBe(enrichedRoute);
    });

    it('returns original route when RouteEnrichmentAdvisor returns it unchanged', async () => {
      const route = makeRoute();
      MockRouteEnrichmentAdvisor.enrich.mockResolvedValue(route);

      const result = await AdvisorCoordinator.adviseEnrichment(
        route,
        makeSnapshot(),
        makeContext(),
        makeBrain(),
        testGrid,
      );

      expect(result).toBe(route);
    });

    it('passes all parameters to RouteEnrichmentAdvisor.enrich', async () => {
      const route = makeRoute();
      const snapshot = makeSnapshot();
      const context = makeContext();
      const brain = makeBrain();
      MockRouteEnrichmentAdvisor.enrich.mockResolvedValue(route);

      await AdvisorCoordinator.adviseEnrichment(route, snapshot, context, brain, testGrid);

      expect(MockRouteEnrichmentAdvisor.enrich).toHaveBeenCalledWith(
        route, snapshot, context, brain, testGrid,
      );
    });
  });

  // ── adviseBuild ─────────────────────────────────────────────────────────────

  describe('adviseBuild', () => {
    it('returns null plan when BuildAdvisor.advise returns null (precondition-skip path)', async () => {
      MockBuildAdvisor.advise.mockResolvedValue(null);

      const result = await AdvisorCoordinator.adviseBuild(
        'Paris',
        20,
        makeRoute(),
        makeSnapshot(),
        makeContext(),
        makeBrain(),
        testGrid,
        TAG,
      );

      expect(result.plan).toBeNull();
      expect(MockBuildAdvisor.retryWithSolvencyFeedback).not.toHaveBeenCalled();
    });

    it('returns null plan when BuildAdvisor.advise returns keep action', async () => {
      const keepResult: BuildAdvisorResult = { action: 'keep', reasoning: 'no build needed' };
      MockBuildAdvisor.advise.mockResolvedValue(keepResult);

      const result = await AdvisorCoordinator.adviseBuild(
        'Paris', 20, makeRoute(), makeSnapshot(), makeContext(), makeBrain(), testGrid, TAG,
      );

      expect(result.plan).toBeNull();
      expect(MockBuildAdvisor.retryWithSolvencyFeedback).not.toHaveBeenCalled();
    });

    it('returns plan when build action resolves successfully (build success path)', async () => {
      const advisorResult: BuildAdvisorResult = {
        action: 'build',
        target: 'Paris',
        waypoints: [[0, 1], [1, 1]],
        reasoning: 'Build toward Paris',
      };
      MockBuildAdvisor.advise.mockResolvedValue(advisorResult);

      const buildPlan = { type: AIActionType.BuildTrack, segments: [{ from: { row: 0, col: 0, x: 0, y: 0, terrain: TerrainType.MajorCity }, to: { row: 0, col: 1, x: 50, y: 0, terrain: TerrainType.Clear }, cost: 1 }] };
      MockActionResolver.resolve.mockResolvedValue({ success: true, plan: buildPlan });

      const result = await AdvisorCoordinator.adviseBuild(
        'Paris', 20, makeRoute(), makeSnapshot(), makeContext(), makeBrain(), testGrid, TAG,
      );

      expect(result.plan).toBe(buildPlan);
      expect(MockBuildAdvisor.retryWithSolvencyFeedback).not.toHaveBeenCalled();
    });

    it('passes buildResolverLog through when present (build success path)', async () => {
      const advisorResult: BuildAdvisorResult = { action: 'build', target: 'Paris', reasoning: 'build' };
      MockBuildAdvisor.advise.mockResolvedValue(advisorResult);

      const buildPlan = { type: AIActionType.BuildTrack, segments: [] };
      const resolverLog = { enabled: true as const, targetCity: 'Paris', budget: 20, candidates: [], outcome: 'success' as const };
      MockActionResolver.resolve.mockResolvedValue({ success: true, plan: buildPlan, buildResolverLog: resolverLog });

      const result = await AdvisorCoordinator.adviseBuild(
        'Paris', 20, makeRoute(), makeSnapshot(), makeContext(), makeBrain(), testGrid, TAG,
      );

      expect(result.buildResolverLog).toBeDefined();
    });

    it('calls retryWithSolvencyFeedback when first build resolution fails', async () => {
      const advisorResult: BuildAdvisorResult = {
        action: 'build',
        target: 'Paris',
        reasoning: 'build',
      };
      MockBuildAdvisor.advise.mockResolvedValue(advisorResult);
      // First resolution fails
      MockActionResolver.resolve.mockResolvedValueOnce({ success: false, error: 'path not found' });
      // Retry also returns null advisor result
      MockBuildAdvisor.retryWithSolvencyFeedback.mockResolvedValue(null);

      await AdvisorCoordinator.adviseBuild(
        'Paris', 20, makeRoute(), makeSnapshot(), makeContext(), makeBrain(), testGrid, TAG,
      );

      expect(MockBuildAdvisor.retryWithSolvencyFeedback).toHaveBeenCalledTimes(1);
    });

    it('returns plan from solvency retry when it succeeds (solvency-retry success)', async () => {
      const firstAdvisorResult: BuildAdvisorResult = { action: 'build', target: 'Paris', reasoning: 'build' };
      const retryAdvisorResult: BuildAdvisorResult = { action: 'build', target: 'Paris', waypoints: [[0, 1]], reasoning: 'retry' };

      MockBuildAdvisor.advise.mockResolvedValue(firstAdvisorResult);
      MockBuildAdvisor.retryWithSolvencyFeedback.mockResolvedValue(retryAdvisorResult);

      const retryPlan = { type: AIActionType.BuildTrack, segments: [] };
      // First call fails, second (retry) succeeds
      MockActionResolver.resolve
        .mockResolvedValueOnce({ success: false, error: 'too expensive' })
        .mockResolvedValueOnce({ success: true, plan: retryPlan });

      const result = await AdvisorCoordinator.adviseBuild(
        'Paris', 20, makeRoute(), makeSnapshot(), makeContext(), makeBrain(), testGrid, TAG,
      );

      expect(result.plan).toBe(retryPlan);
    });

    it('returns null plan when solvency retry also fails (solvency-retry failure)', async () => {
      const firstAdvisorResult: BuildAdvisorResult = { action: 'build', target: 'Paris', reasoning: 'build' };
      const retryAdvisorResult: BuildAdvisorResult = { action: 'build', target: 'Paris', reasoning: 'retry' };

      MockBuildAdvisor.advise.mockResolvedValue(firstAdvisorResult);
      MockBuildAdvisor.retryWithSolvencyFeedback.mockResolvedValue(retryAdvisorResult);

      // Both ActionResolver calls fail
      MockActionResolver.resolve
        .mockResolvedValueOnce({ success: false, error: 'too expensive' })
        .mockResolvedValueOnce({ success: false, error: 'still too expensive' });

      const result = await AdvisorCoordinator.adviseBuild(
        'Paris', 20, makeRoute(), makeSnapshot(), makeContext(), makeBrain(), testGrid, TAG,
      );

      expect(result.plan).toBeNull();
    });

    it('returns null plan when BuildAdvisor.advise throws (advisor-throw fallback)', async () => {
      MockBuildAdvisor.advise.mockRejectedValue(new Error('LLM timeout'));

      const result = await AdvisorCoordinator.adviseBuild(
        'Paris', 20, makeRoute(), makeSnapshot(), makeContext(), makeBrain(), testGrid, TAG,
      );

      expect(result.plan).toBeNull();
      // Should not propagate — log-and-fallback semantic
      expect(MockBuildAdvisor.retryWithSolvencyFeedback).not.toHaveBeenCalled();
    });

    it('passes correct remainingBudget overshoot to retryWithSolvencyFeedback', async () => {
      const firstAdvisorResult: BuildAdvisorResult = { action: 'build', target: 'Paris', reasoning: 'build' };
      MockBuildAdvisor.advise.mockResolvedValue(firstAdvisorResult);
      MockActionResolver.resolve.mockResolvedValueOnce({ success: false, error: 'too expensive' });
      MockBuildAdvisor.retryWithSolvencyFeedback.mockResolvedValue(null);

      const remainingBudget = 15;
      await AdvisorCoordinator.adviseBuild(
        'Paris', remainingBudget, makeRoute(), makeSnapshot(), makeContext(), makeBrain(), testGrid, TAG,
      );

      // actualCost = remainingBudget + 1 (overshoot indicator per TurnExecutorPlanner)
      expect(MockBuildAdvisor.retryWithSolvencyFeedback).toHaveBeenCalledWith(
        firstAdvisorResult,
        remainingBudget + 1,
        remainingBudget,
        expect.anything(),
        expect.anything(),
        expect.anything(),
        expect.anything(),
        expect.anything(),
      );
    });
  });
});
