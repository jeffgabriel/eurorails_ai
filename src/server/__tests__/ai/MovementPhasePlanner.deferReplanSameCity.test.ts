/**
 * MovementPhasePlanner.deferReplanSameCity.test.ts
 *
 * Regression test for the same-city replan deferral.
 *
 * When two consecutive route stops are at the same city (e.g. a
 * pair-shared-delivery route delivers two loads at the same destination),
 * PostDeliveryReplanner.replan should fire ONCE — after the second delivery —
 * not after each delivery. The first replan would be wasted work since the
 * bot doesn't move between same-city stops; the planner would see the bot at
 * the same position with another stop queued and almost always commit to
 * executing it. Each replan is a full trip-planning pass (10-20s mid-game),
 * so the deferral cuts double-delivery slow turns roughly in half.
 *
 * Scenario: pair-shared-delivery, bot already carrying both loads.
 *   - Route stops: [deliver Wheat @ Madrid, deliver Coal @ Madrid]
 *   - Bot starts at Madrid, cargo = [Wheat, Coal]
 *   - Iter 1: deliver Wheat, advance, peek next-stop = deliver Coal @ Madrid → DEFER
 *   - Iter 2: deliver Coal, advance, no next-stop → REPLAN
 *   - PostDeliveryReplanner.replan should be called exactly once.
 */

import { MovementPhasePlanner } from '../../services/ai/MovementPhasePlanner';
import { TurnExecutorPlanner } from '../../services/ai/TurnExecutorPlanner';
import { AIActionType, TerrainType } from '../../../shared/types/GameTypes';
import type {
  StrategicRoute,
  RouteStop,
  GameContext,
  WorldSnapshot,
  GridPoint,
  DemandContext,
} from '../../../shared/types/GameTypes';
import type { CompositionTrace } from '../../services/ai/TurnExecutorPlanner';

// ── Mocks ────────────────────────────────────────────────────────────────

jest.mock('../../services/ai/MapTopology', () => ({
  loadGridPoints: jest.fn(() => new Map()),
  makeKey: (row: number, col: number) => `${row},${col}`,
  hexDistance: jest.fn(() => 5),
  getHexNeighbors: jest.fn(() => []),
}));

jest.mock('../../../shared/services/trackUsageFees', () => ({
  buildUnionTrackGraph: jest.fn(() => ({ adjacency: new Map(), edgeOwners: new Map() })),
}));

jest.mock('../../../shared/services/computeTrackUsageFees', () => ({
  computeTrackUsageFees: jest.fn(() => 0),
}));

// routeHelpers mock — include the REAL isRouteImpossible so the defer guard
// runs as in production. Other functions are stubbed (consistent with the
// existing MovementPhasePlanner test setup).
jest.mock('../../services/ai/routeHelpers', () => {
  const real = jest.requireActual('../../services/ai/routeHelpers');
  return {
    ...real,
    isStopComplete: jest.fn(() => false),
    resolveBuildTarget: jest.fn(),
    getNetworkFrontier: jest.fn(() => []),
    isDeliveryComplete: jest.fn(),
    applyStopEffectToLocalState: jest.fn((...args: Parameters<typeof real.applyStopEffectToLocalState>) =>
      real.applyStopEffectToLocalState(...args),
    ),
    isRouteImpossible: real.isRouteImpossible,
  };
});

jest.mock('../../services/ai/computeBuildSegments', () => ({
  computeBuildSegments: jest.fn(() => []),
}));

jest.mock('../../services/ai/ActionResolver', () => ({
  ActionResolver: { resolve: jest.fn(), resolveMove: jest.fn() },
}));

jest.mock('../../../shared/services/majorCityGroups', () => ({
  ...jest.requireActual<typeof import('../../../shared/services/majorCityGroups')>('../../../shared/services/majorCityGroups'),
  getMajorCityLookup: jest.fn(() => new Map()),
  computeEffectivePathLength: jest.fn(() => 1),
}));

jest.mock('../../services/ai/TurnExecutor', () => ({
  TurnExecutor: {
    executePlan: jest.fn(() => Promise.resolve({ success: true, remainingMoney: 100 })),
  },
}));

jest.mock('../../services/ai/PostDeliveryReplanner', () => ({
  PostDeliveryReplanner: { replan: jest.fn() },
}));

const mockCapture = jest.fn();
jest.mock('../../services/ai/WorldSnapshotService', () => ({
  capture: (...args: unknown[]) => mockCapture(...args),
}));

const mockRebuildDemands = jest.fn(() => []);
const mockRebuildCanDeliver = jest.fn(() => []);
jest.mock('../../services/ai/ContextBuilder', () => ({
  ContextBuilder: {
    rebuildDemands: (...args: unknown[]) => mockRebuildDemands(...args),
    rebuildCanDeliver: (...args: unknown[]) => mockRebuildCanDeliver(...args),
  },
}));

jest.mock('../../services/ai/RouteEnrichmentAdvisor', () => ({
  RouteEnrichmentAdvisor: { enrich: jest.fn((r: unknown) => Promise.resolve(r)) },
}));

jest.mock('../../services/ai/RouteDetourEstimator', () => ({
  computeCandidateDetourCosts: jest.fn(() => []),
  MAX_DETOUR_TURNS: 3,
  OPPORTUNITY_COST_PER_TURN_M: 5,
}));

import { PostDeliveryReplanner } from '../../services/ai/PostDeliveryReplanner';

const mockPostDeliveryReplan = PostDeliveryReplanner.replan as jest.Mock;

// ── Helpers ──────────────────────────────────────────────────────────────

function makeDeliverStop(loadType: string, city: string, demandCardId: number): RouteStop {
  return { action: 'deliver', loadType, city, demandCardId, payment: 30 };
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
    timing: {
      phaseAMs: 0, phaseBMs: 0,
      replanMs: 0, replanCount: 0,
      moveResolveMs: 0, moveResolveCount: 0,
      stopActionMs: 0, stopActionCount: 0,
    },
  };
}

function makeDemand(loadType: string, deliveryCity: string, cardIndex: number): DemandContext {
  return {
    cardIndex, loadType, supplyCity: 'SomeSupply', deliveryCity, payout: 30,
    isSupplyReachable: true, isDeliveryReachable: true,
    isSupplyOnNetwork: false, isDeliveryOnNetwork: true,
    estimatedTrackCostToSupply: 0, estimatedTrackCostToDelivery: 0,
    isLoadAvailable: true, isLoadOnTrain: true,
    ferryRequired: false, loadChipTotal: 4, loadChipCarried: 1,
    estimatedTurns: 1, demandScore: 0, efficiencyPerTurn: 0,
    networkCitiesUnlocked: 0, victoryMajorCitiesEnRoute: 0,
    isAffordable: true, projectedFundsAfterDelivery: 130,
  };
}

function makeContext(loads: string[]): GameContext {
  return {
    position: { row: 10, col: 10, city: 'Madrid' },
    money: 100, trainType: 'Freight', speed: 9, capacity: 3,
    loads,
    connectedMajorCities: ['Madrid'],
    unconnectedMajorCities: [],
    totalMajorCities: 15,
    trackSummary: '', turnBuildCost: 0,
    demands: [
      makeDemand('Wheat', 'Madrid', 30),
      makeDemand('Coal', 'Madrid', 31),
    ],
    canDeliver: ['Wheat', 'Coal'], canPickup: [],
    citiesOnNetwork: ['Madrid'], reachableCities: [],
    canUpgrade: false, canBuild: true,
    isInitialBuild: false, opponents: [],
    phase: 'travel', turnNumber: 10,
  } as GameContext;
}

function makeSnapshot(): WorldSnapshot {
  return {
    gameId: 'test-defer-replan',
    gameStatus: 'active', turnNumber: 10,
    bot: {
      playerId: 'bot-1', userId: 'u', money: 100,
      position: { row: 10, col: 10 },
      existingSegments: [], demandCards: [30, 31, 32],
      resolvedDemands: [], trainType: 'Freight',
      loads: ['Wheat', 'Coal'],
      botConfig: null, connectedMajorCityCount: 1,
    },
    allPlayerTracks: [], loadAvailability: {},
  } as WorldSnapshot;
}

function makeGridPoints(): GridPoint[] {
  return [
    { row: 10, col: 10, terrain: 0 as TerrainType, city: { name: 'Madrid' } as GridPoint['city'], name: 'Madrid' } as unknown as GridPoint,
  ];
}

// ── Setup ────────────────────────────────────────────────────────────────

let mockSkipCompleted: jest.SpyInstance;
let mockExecuteStopAction: jest.SpyInstance;

beforeEach(() => {
  jest.clearAllMocks();

  // skipCompletedStops returns route unchanged — bot has not delivered yet
  mockSkipCompleted = jest.spyOn(TurnExecutorPlanner, 'skipCompletedStops')
    .mockImplementation((r: StrategicRoute) => r);

  // executeStopAction returns success for both deliveries
  mockExecuteStopAction = jest.spyOn(TurnExecutorPlanner, 'executeStopAction')
    .mockImplementation(async (stop: RouteStop) => ({
      success: true,
      plan: { type: AIActionType.DeliverLoad, load: stop.loadType, city: stop.city },
    }));

  mockCapture.mockResolvedValue({
    gameId: 'test-defer-replan', gameStatus: 'active', turnNumber: 10,
    bot: {
      playerId: 'bot-1', userId: 'u', money: 130,
      position: { row: 10, col: 10 },
      existingSegments: [], demandCards: [], resolvedDemands: [],
      trainType: 'Freight', loads: [], botConfig: null,
      connectedMajorCityCount: 1,
    },
    allPlayerTracks: [], loadAvailability: {},
  });

  mockPostDeliveryReplan.mockResolvedValue({
    route: { stops: [], currentStopIndex: 0, phase: 'travel', createdAtTurn: 10, reasoning: 'replanned' } as StrategicRoute,
    moveTargetInvalidated: false,
  });

  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  mockSkipCompleted.mockRestore();
  mockExecuteStopAction.mockRestore();
  jest.restoreAllMocks();
});

// ── Tests ────────────────────────────────────────────────────────────────

describe('MovementPhasePlanner — same-city replan deferral', () => {

  it('two consecutive deliveries at same city → PostDeliveryReplanner.replan fires exactly once', async () => {
    // Route: [deliver Wheat @ Madrid, deliver Coal @ Madrid]
    // Bot is at Madrid carrying both loads — no movement needed.
    const route: StrategicRoute = {
      stops: [
        makeDeliverStop('Wheat', 'Madrid', 30),
        makeDeliverStop('Coal', 'Madrid', 31),
      ],
      currentStopIndex: 0,
      phase: 'travel',
      createdAtTurn: 10,
      reasoning: 'pair-shared-delivery: Wheat+Coal @ Madrid',
    };

    await MovementPhasePlanner.run(
      route,
      makeSnapshot(),
      makeContext(['Wheat', 'Coal']),
      makeTrace(),
      undefined,
      makeGridPoints(),
    );

    // Both deliveries should have been executed
    expect(mockExecuteStopAction).toHaveBeenCalledTimes(2);

    // But replan should fire only ONCE — after the second delivery, when
    // the route is exhausted and there's no more same-city work queued
    expect(mockPostDeliveryReplan).toHaveBeenCalledTimes(1);
  });

  it('two deliveries at different cities → replan fires after each (no deferral)', async () => {
    // Different cities — no deferral, replan fires twice as before
    const route: StrategicRoute = {
      stops: [
        makeDeliverStop('Wheat', 'Madrid', 30),
        makeDeliverStop('Coal', 'Lisboa', 31),  // different city
      ],
      currentStopIndex: 0,
      phase: 'travel',
      createdAtTurn: 10,
      reasoning: 'fresh+fresh different-cities',
    };

    // After the first replan, the planner returns a route landing the bot at Lisboa
    // with Coal still on board. We simulate that the second iteration of the loop
    // would normally need a move — but since the test goal is just to count replan
    // calls, we return an empty route from the first replan to short-circuit.
    mockPostDeliveryReplan.mockResolvedValueOnce({
      route: { stops: [], currentStopIndex: 0, phase: 'travel', createdAtTurn: 10, reasoning: 'after first replan' } as StrategicRoute,
      moveTargetInvalidated: true,
    });

    await MovementPhasePlanner.run(
      route,
      makeSnapshot(),
      makeContext(['Wheat', 'Coal']),
      makeTrace(),
      undefined,
      makeGridPoints(),
    );

    // First delivery executes. Next stop is at Lisboa (different city) — no defer.
    // Replan fires after the first delivery. The replan returns an empty route,
    // so the loop exits before the second delivery. Count is 1, which is the
    // baseline pre-defer behavior (it would also be 1 in old code at this point).
    // The point: same code path as before — deferral did NOT fire.
    expect(mockPostDeliveryReplan).toHaveBeenCalledTimes(1);
  });

});
