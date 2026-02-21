/**
 * PlanExecutor tests — phase transitions, stop advancement, edge cases.
 */

import { PlanExecutor } from '../../services/ai/PlanExecutor';
import {
  AIActionType,
  WorldSnapshot,
  GameContext,
  StrategicRoute,
  TrainType,
  TerrainType,
  TrackSegment,
} from '../../../shared/types/GameTypes';

// Mock ActionResolver
jest.mock('../../services/ai/ActionResolver', () => ({
  ActionResolver: {
    resolve: jest.fn(),
    heuristicFallback: jest.fn(),
  },
}));

// Mock MapTopology
jest.mock('../../services/ai/MapTopology', () => ({
  loadGridPoints: jest.fn(() => new Map()),
  getHexNeighbors: jest.fn(() => []),
  getTerrainCost: jest.fn(() => 1),
  gridToPixel: jest.fn(() => ({ x: 0, y: 0 })),
  _resetCache: jest.fn(),
}));

jest.mock('../../../shared/services/majorCityGroups', () => ({
  getMajorCityGroups: jest.fn(() => []),
  getMajorCityLookup: jest.fn(() => new Map()),
  getFerryEdges: jest.fn(() => []),
}));

jest.mock('../../../shared/services/trackUsageFees', () => ({
  buildUnionTrackGraph: jest.fn(() => ({
    adjacency: new Map(),
    edgeOwners: new Map(),
  })),
  computeTrackUsageForMove: jest.fn(() => ({
    feeTotal: 0,
    ownersUsed: [],
    ownersPaid: [],
  })),
}));

jest.mock('../../services/ai/computeBuildSegments', () => ({
  computeBuildSegments: jest.fn(() => []),
}));

jest.mock('../../../shared/services/TrackNetworkService', () => ({
  buildTrackNetwork: jest.fn(() => ({
    adjacency: new Map(),
    nodeSet: new Set(),
  })),
}));

import { ActionResolver } from '../../services/ai/ActionResolver';

const mockResolve = ActionResolver.resolve as jest.Mock;

function makeSegment(fromRow: number, fromCol: number, toRow: number, toCol: number): TrackSegment {
  return {
    from: { x: 0, y: 0, row: fromRow, col: fromCol, terrain: TerrainType.Clear },
    to: { x: 0, y: 0, row: toRow, col: toCol, terrain: TerrainType.Clear },
    cost: 1,
  };
}

function makeSnapshot(): WorldSnapshot {
  return {
    gameId: 'g1',
    gameStatus: 'active',
    turnNumber: 5,
    bot: {
      playerId: 'bot-1',
      userId: 'user-bot-1',
      money: 50,
      position: { row: 10, col: 10 },
      existingSegments: [makeSegment(10, 10, 10, 11)],
      demandCards: [1],
      resolvedDemands: [],
      trainType: TrainType.Freight,
      loads: [],
      botConfig: null,
      connectedMajorCityCount: 0,
    },
    allPlayerTracks: [],
    loadAvailability: {},
  };
}

function makeContext(overrides: Partial<GameContext> = {}): GameContext {
  return {
    position: { row: 10, col: 10 },
    money: 50,
    trainType: TrainType.Freight,
    speed: 9,
    capacity: 2,
    loads: [],
    connectedMajorCities: [],
    totalMajorCities: 8,
    trackSummary: '1 segment',
    turnBuildCost: 0,
    demands: [],
    canDeliver: [],
    canPickup: [],
    reachableCities: [],
    citiesOnNetwork: [],
    canUpgrade: false,
    canBuild: true,
    isInitialBuild: false,
    opponents: [],
    phase: 'running',
    turnNumber: 5,
    ...overrides,
  };
}

function makeRoute(overrides: Partial<StrategicRoute> = {}): StrategicRoute {
  return {
    stops: [
      { action: 'pickup', loadType: 'Coal', city: 'Berlin' },
      { action: 'deliver', loadType: 'Coal', city: 'Paris', demandCardId: 1, payment: 25 },
    ],
    currentStopIndex: 0,
    phase: 'build',
    createdAtTurn: 3,
    reasoning: 'Test route',
    ...overrides,
  };
}

describe('PlanExecutor', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('build phase', () => {
    it('should build toward target city when not on network', async () => {
      const route = makeRoute({ phase: 'build', currentStopIndex: 0 });
      const context = makeContext({ citiesOnNetwork: [], canBuild: true });

      mockResolve.mockResolvedValue({
        success: true,
        plan: { type: AIActionType.BuildTrack, segments: [makeSegment(10, 10, 10, 11)] },
      });

      const result = await PlanExecutor.execute(route, makeSnapshot(), context);

      expect(result.plan.type).toBe(AIActionType.BuildTrack);
      expect(result.routeComplete).toBe(false);
      expect(result.routeAbandoned).toBe(false);
      expect(mockResolve).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'BUILD', details: { toward: 'Berlin' } }),
        expect.anything(),
        expect.anything(),
      );
    });

    it('should transition to travel phase when target city is on network', async () => {
      const route = makeRoute({ phase: 'build', currentStopIndex: 0 });
      const context = makeContext({ citiesOnNetwork: ['Berlin'], position: { row: 5, col: 5 } });

      // resolveMove will be called after transition to travel
      mockResolve.mockResolvedValue({
        success: true,
        plan: { type: AIActionType.MoveTrain, path: [{ row: 5, col: 5 }, { row: 10, col: 10 }], fees: new Set(), totalFee: 0 },
      });

      const result = await PlanExecutor.execute(route, makeSnapshot(), context);

      // Should have transitioned through travel → produced a MOVE plan
      expect(result.plan.type).toBe(AIActionType.MoveTrain);
      expect(result.routeComplete).toBe(false);
    });

    it('should pass when cannot build this turn', async () => {
      const route = makeRoute({ phase: 'build', currentStopIndex: 0 });
      const context = makeContext({ citiesOnNetwork: [], canBuild: false });

      const result = await PlanExecutor.execute(route, makeSnapshot(), context);

      expect(result.plan.type).toBe(AIActionType.PassTurn);
      expect(result.routeComplete).toBe(false);
      expect(result.routeAbandoned).toBe(false);
    });

    it('should pass when build fails and stay in build phase', async () => {
      const route = makeRoute({ phase: 'build', currentStopIndex: 0 });
      const context = makeContext({ citiesOnNetwork: [], canBuild: true });

      mockResolve.mockResolvedValue({
        success: false,
        error: 'No path found',
      });

      const result = await PlanExecutor.execute(route, makeSnapshot(), context);

      expect(result.plan.type).toBe(AIActionType.PassTurn);
      expect(result.routeComplete).toBe(false);
      expect(result.routeAbandoned).toBe(false);
      expect(result.updatedRoute.phase).toBe('build');
    });
  });

  describe('travel phase', () => {
    it('should move toward target city when not at it', async () => {
      const route = makeRoute({ phase: 'travel', currentStopIndex: 0 });
      const context = makeContext({ position: { row: 5, col: 5 } });

      mockResolve.mockResolvedValue({
        success: true,
        plan: { type: AIActionType.MoveTrain, path: [{ row: 5, col: 5 }, { row: 8, col: 8 }], fees: new Set(), totalFee: 0 },
      });

      const result = await PlanExecutor.execute(route, makeSnapshot(), context);

      expect(result.plan.type).toBe(AIActionType.MoveTrain);
      expect(result.routeComplete).toBe(false);
    });

    it('should transition to act phase when at target city', async () => {
      const route = makeRoute({ phase: 'travel', currentStopIndex: 0 });
      // Bot is at Berlin
      const context = makeContext({ position: { city: 'Berlin', row: 10, col: 10 } });

      // resolvePickup called after transition to act phase
      mockResolve.mockResolvedValue({
        success: true,
        plan: { type: AIActionType.PickupLoad, load: 'Coal', city: 'Berlin' },
      });

      const result = await PlanExecutor.execute(route, makeSnapshot(), context);

      expect(result.plan.type).toBe(AIActionType.PickupLoad);
      expect(result.routeComplete).toBe(false);
    });

    it('should revert to build phase when move fails', async () => {
      const route = makeRoute({ phase: 'travel', currentStopIndex: 0 });
      const context = makeContext({ position: { row: 5, col: 5 } });

      mockResolve.mockResolvedValue({
        success: false,
        error: 'No valid path',
      });

      const result = await PlanExecutor.execute(route, makeSnapshot(), context);

      expect(result.plan.type).toBe(AIActionType.PassTurn);
      expect(result.updatedRoute.phase).toBe('build');
    });
  });

  describe('act phase', () => {
    it('should execute pickup and advance to next stop', async () => {
      const route = makeRoute({ phase: 'act', currentStopIndex: 0 });
      const context = makeContext({ position: { city: 'Berlin', row: 10, col: 10 } });

      mockResolve.mockResolvedValue({
        success: true,
        plan: { type: AIActionType.PickupLoad, load: 'Coal', city: 'Berlin' },
      });

      const result = await PlanExecutor.execute(route, makeSnapshot(), context);

      expect(result.plan.type).toBe(AIActionType.PickupLoad);
      expect(result.routeComplete).toBe(false);
      expect(result.updatedRoute.currentStopIndex).toBe(1);
      expect(result.updatedRoute.phase).toBe('build');
    });

    it('should execute deliver on last stop and mark route complete', async () => {
      const route = makeRoute({
        phase: 'act',
        currentStopIndex: 1, // last stop
      });
      const context = makeContext({ position: { city: 'Paris', row: 20, col: 20 } });

      mockResolve.mockResolvedValue({
        success: true,
        plan: { type: AIActionType.DeliverLoad, load: 'Coal', city: 'Paris', cardId: 1, payout: 25 },
      });

      const result = await PlanExecutor.execute(route, makeSnapshot(), context);

      expect(result.plan.type).toBe(AIActionType.DeliverLoad);
      expect(result.routeComplete).toBe(true);
      expect(result.routeAbandoned).toBe(false);
    });

    it('should abandon route when pickup fails (load unavailable)', async () => {
      const route = makeRoute({ phase: 'act', currentStopIndex: 0 });
      const context = makeContext({ position: { city: 'Berlin', row: 10, col: 10 } });

      mockResolve.mockResolvedValue({
        success: false,
        error: 'No Coal chips available',
      });

      const result = await PlanExecutor.execute(route, makeSnapshot(), context);

      expect(result.plan.type).toBe(AIActionType.PassTurn);
      expect(result.routeAbandoned).toBe(true);
    });
  });

  describe('edge cases', () => {
    it('should mark route complete when all stops are already processed', async () => {
      const route = makeRoute({
        currentStopIndex: 2, // past the end of stops array (0, 1)
      });

      const result = await PlanExecutor.execute(route, makeSnapshot(), makeContext());

      expect(result.routeComplete).toBe(true);
      expect(result.plan.type).toBe(AIActionType.PassTurn);
    });

    it('should handle single-stop route', async () => {
      const route = makeRoute({
        stops: [{ action: 'pickup', loadType: 'Wine', city: 'Bordeaux' }],
        phase: 'act',
        currentStopIndex: 0,
      });
      const context = makeContext({ position: { city: 'Bordeaux', row: 15, col: 15 } });

      mockResolve.mockResolvedValue({
        success: true,
        plan: { type: AIActionType.PickupLoad, load: 'Wine', city: 'Bordeaux' },
      });

      const result = await PlanExecutor.execute(route, makeSnapshot(), context);

      expect(result.plan.type).toBe(AIActionType.PickupLoad);
      expect(result.routeComplete).toBe(true);
    });

    it('should transition build → travel → act in one turn when city is on network and bot is at city', async () => {
      const route = makeRoute({
        phase: 'build',
        currentStopIndex: 0,
      });
      // City is on network AND bot is at the city
      const context = makeContext({
        citiesOnNetwork: ['Berlin'],
        position: { city: 'Berlin', row: 10, col: 10 },
      });

      // This should chain: build(city on network) → travel(at city) → act(pickup)
      mockResolve.mockResolvedValue({
        success: true,
        plan: { type: AIActionType.PickupLoad, load: 'Coal', city: 'Berlin' },
      });

      const result = await PlanExecutor.execute(route, makeSnapshot(), context);

      expect(result.plan.type).toBe(AIActionType.PickupLoad);
      expect(result.routeComplete).toBe(false);
      expect(result.updatedRoute.currentStopIndex).toBe(1);
    });
  });
});
