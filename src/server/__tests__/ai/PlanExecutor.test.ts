/**
 * PlanExecutor tests — phase transitions, stop advancement, multi-action combining, edge cases.
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
import { getMajorCityLookup } from '../../../shared/services/majorCityGroups';

const mockResolve = ActionResolver.resolve as jest.Mock;
const mockGetMajorCityLookup = getMajorCityLookup as jest.Mock;

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
    // Default: empty major city lookup (no arrival detection)
    mockGetMajorCityLookup.mockReturnValue(new Map());
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
      const buildCall = mockResolve.mock.calls.find(
        (args: any[]) => args[0]?.action === 'BUILD' && args[0]?.details?.toward === 'Berlin',
      );
      expect(buildCall).toBeDefined();
    });

    it('should transition to travel phase when target city is on network', async () => {
      const route = makeRoute({ phase: 'build', currentStopIndex: 0 });
      const context = makeContext({ citiesOnNetwork: ['Berlin'], position: { row: 5, col: 5 }, canBuild: false });

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
      const context = makeContext({ position: { row: 5, col: 5 }, canBuild: false });

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
      const context = makeContext({ position: { city: 'Berlin', row: 10, col: 10 }, canBuild: false });

      // resolvePickup called after transition to act phase
      // Second call: chainMoveAfterAct tries MOVE toward next stop — fails
      mockResolve
        .mockResolvedValueOnce({
          success: true,
          plan: { type: AIActionType.PickupLoad, load: 'Coal', city: 'Berlin' },
        })
        .mockResolvedValueOnce({ success: false, error: 'No path' });

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
      const context = makeContext({ position: { city: 'Berlin', row: 10, col: 10 }, canBuild: false });

      // chainMoveAfterAct will try MOVE toward Paris (next stop) — fail it
      mockResolve
        .mockResolvedValueOnce({
          success: true,
          plan: { type: AIActionType.PickupLoad, load: 'Coal', city: 'Berlin' },
        })
        .mockResolvedValueOnce({ success: false, error: 'No path' });

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
        canBuild: false,
      });

      // This should chain: build(city on network) → travel(at city) → act(pickup)
      // chainMoveAfterAct will try MOVE toward Paris (next stop) — fail it
      mockResolve
        .mockResolvedValueOnce({
          success: true,
          plan: { type: AIActionType.PickupLoad, load: 'Coal', city: 'Berlin' },
        })
        .mockResolvedValueOnce({ success: false, error: 'No path' });

      const result = await PlanExecutor.execute(route, makeSnapshot(), context);

      expect(result.plan.type).toBe(AIActionType.PickupLoad);
      expect(result.routeComplete).toBe(false);
      expect(result.updatedRoute.currentStopIndex).toBe(1);
    });
  });

  describe('multi-action: chain arrival action', () => {
    it('should chain MoveTrain + PickupLoad when move arrives at target city', async () => {
      const route = makeRoute({ phase: 'travel', currentStopIndex: 0 });
      const context = makeContext({
        position: { row: 5, col: 5 },
        canBuild: false, // disable build appending for this test
      });

      // Configure city lookup so Berlin is at row 10, col 10
      mockGetMajorCityLookup.mockReturnValue(new Map([['10,10', 'Berlin']]));

      // First call: resolve MOVE → path ends at Berlin (10,10)
      // Second call: resolve PICKUP → success
      mockResolve
        .mockResolvedValueOnce({
          success: true,
          plan: { type: AIActionType.MoveTrain, path: [{ row: 5, col: 5 }, { row: 8, col: 8 }, { row: 10, col: 10 }], fees: new Set(), totalFee: 0 },
        })
        .mockResolvedValueOnce({
          success: true,
          plan: { type: AIActionType.PickupLoad, load: 'Coal', city: 'Berlin' },
        });

      const result = await PlanExecutor.execute(route, makeSnapshot(), context);

      expect(result.plan.type).toBe('MultiAction');
      if (result.plan.type === 'MultiAction') {
        expect(result.plan.steps).toHaveLength(2);
        expect(result.plan.steps[0].type).toBe(AIActionType.MoveTrain);
        expect(result.plan.steps[1].type).toBe(AIActionType.PickupLoad);
      }
      // Route should advance past stop 0 (pickup done)
      expect(result.updatedRoute.currentStopIndex).toBe(1);
    });

    it('should chain MoveTrain + DeliverLoad when move arrives at delivery city', async () => {
      const route = makeRoute({
        phase: 'travel',
        currentStopIndex: 1, // at the deliver stop (Paris)
      });
      const context = makeContext({
        position: { row: 5, col: 5 },
        canBuild: false,
      });

      // Paris is at row 20, col 20
      mockGetMajorCityLookup.mockReturnValue(new Map([['20,20', 'Paris']]));

      mockResolve
        .mockResolvedValueOnce({
          success: true,
          plan: { type: AIActionType.MoveTrain, path: [{ row: 5, col: 5 }, { row: 20, col: 20 }], fees: new Set(), totalFee: 0 },
        })
        .mockResolvedValueOnce({
          success: true,
          plan: { type: AIActionType.DeliverLoad, load: 'Coal', city: 'Paris', cardId: 1, payout: 25 },
        });

      const result = await PlanExecutor.execute(route, makeSnapshot(), context);

      expect(result.plan.type).toBe('MultiAction');
      if (result.plan.type === 'MultiAction') {
        expect(result.plan.steps).toHaveLength(2);
        expect(result.plan.steps[0].type).toBe(AIActionType.MoveTrain);
        expect(result.plan.steps[1].type).toBe(AIActionType.DeliverLoad);
      }
      expect(result.routeComplete).toBe(true);
    });

    it('should NOT chain when move does not arrive at target city', async () => {
      const route = makeRoute({ phase: 'travel', currentStopIndex: 0 });
      const context = makeContext({
        position: { row: 5, col: 5 },
        canBuild: false,
      });

      // Berlin is at 10,10 but move only reaches 8,8
      mockGetMajorCityLookup.mockReturnValue(new Map([['10,10', 'Berlin']]));

      mockResolve.mockResolvedValueOnce({
        success: true,
        plan: { type: AIActionType.MoveTrain, path: [{ row: 5, col: 5 }, { row: 8, col: 8 }], fees: new Set(), totalFee: 0 },
      });

      const result = await PlanExecutor.execute(route, makeSnapshot(), context);

      // Should remain just a MoveTrain, not a MultiAction
      expect(result.plan.type).toBe(AIActionType.MoveTrain);
      // resolve should only have been called once (for the MOVE)
      expect(mockResolve).toHaveBeenCalledTimes(1);
    });

    it('should still return move if chained act phase fails', async () => {
      const route = makeRoute({ phase: 'travel', currentStopIndex: 0 });
      const context = makeContext({
        position: { row: 5, col: 5 },
        canBuild: false,
      });

      mockGetMajorCityLookup.mockReturnValue(new Map([['10,10', 'Berlin']]));

      mockResolve
        .mockResolvedValueOnce({
          success: true,
          plan: { type: AIActionType.MoveTrain, path: [{ row: 5, col: 5 }, { row: 10, col: 10 }], fees: new Set(), totalFee: 0 },
        })
        .mockResolvedValueOnce({
          success: false,
          error: 'No Coal chips available',
        });

      const result = await PlanExecutor.execute(route, makeSnapshot(), context);

      // Should fall back to just the move
      expect(result.plan.type).toBe(AIActionType.MoveTrain);
      expect(result.routeAbandoned).toBe(false);
    });
  });

  describe('multi-action: append build step', () => {
    it('should append BuildTrack after PickupLoad when future stop not on network', async () => {
      const route = makeRoute({ phase: 'act', currentStopIndex: 0 });
      const context = makeContext({
        position: { city: 'Berlin', row: 10, col: 10 },
        canBuild: true,
        citiesOnNetwork: ['Berlin'], // Berlin is on network, but Paris (next stop) is not
      });

      // First call: resolve PICKUP → success
      // Second call: chainMoveAfterAct tries MOVE toward Paris → fails (not on network)
      // Third call: resolve BUILD toward Paris → success
      mockResolve
        .mockResolvedValueOnce({
          success: true,
          plan: { type: AIActionType.PickupLoad, load: 'Coal', city: 'Berlin' },
        })
        .mockResolvedValueOnce({ success: false, error: 'No path to Paris' })
        .mockResolvedValueOnce({
          success: true,
          plan: { type: AIActionType.BuildTrack, segments: [makeSegment(10, 11, 10, 12)], targetCity: 'Paris' },
        });

      const result = await PlanExecutor.execute(route, makeSnapshot(), context);

      expect(result.plan.type).toBe('MultiAction');
      if (result.plan.type === 'MultiAction') {
        expect(result.plan.steps).toHaveLength(2);
        expect(result.plan.steps[0].type).toBe(AIActionType.PickupLoad);
        expect(result.plan.steps[1].type).toBe(AIActionType.BuildTrack);
      }
    });

    it('should NOT append build when primary action is BuildTrack', async () => {
      const route = makeRoute({ phase: 'build', currentStopIndex: 0 });
      const context = makeContext({ citiesOnNetwork: [], canBuild: true });

      mockResolve.mockResolvedValue({
        success: true,
        plan: { type: AIActionType.BuildTrack, segments: [makeSegment(10, 10, 10, 11)] },
      });

      const result = await PlanExecutor.execute(route, makeSnapshot(), context);

      // Should still be just BuildTrack, not wrapped in MultiAction
      expect(result.plan.type).toBe(AIActionType.BuildTrack);
      // Only one resolve call (the build itself)
      expect(mockResolve).toHaveBeenCalledTimes(1);
    });

    it('should NOT append build when all future stop cities are on network', async () => {
      const route = makeRoute({ phase: 'act', currentStopIndex: 0 });
      const context = makeContext({
        position: { city: 'Berlin', row: 10, col: 10 },
        canBuild: true,
        citiesOnNetwork: ['Berlin', 'Paris'], // Both stops' cities are on network
      });

      // chainMoveAfterAct will try MOVE toward Paris — fail it to isolate build test
      mockResolve
        .mockResolvedValueOnce({
          success: true,
          plan: { type: AIActionType.PickupLoad, load: 'Coal', city: 'Berlin' },
        })
        .mockResolvedValueOnce({ success: false, error: 'No path' });

      const result = await PlanExecutor.execute(route, makeSnapshot(), context);

      // Just the pickup, no build appended (move also failed)
      expect(result.plan.type).toBe(AIActionType.PickupLoad);
      expect(mockResolve).toHaveBeenCalledTimes(2); // PICKUP + MOVE attempt
    });

    it('should NOT append build when canBuild is false', async () => {
      const route = makeRoute({ phase: 'act', currentStopIndex: 0 });
      const context = makeContext({
        position: { city: 'Berlin', row: 10, col: 10 },
        canBuild: false,
        citiesOnNetwork: ['Berlin'],
      });

      // chainMoveAfterAct will try MOVE toward Paris — fail it
      mockResolve
        .mockResolvedValueOnce({
          success: true,
          plan: { type: AIActionType.PickupLoad, load: 'Coal', city: 'Berlin' },
        })
        .mockResolvedValueOnce({ success: false, error: 'No path' });

      const result = await PlanExecutor.execute(route, makeSnapshot(), context);

      expect(result.plan.type).toBe(AIActionType.PickupLoad);
      expect(mockResolve).toHaveBeenCalledTimes(2); // PICKUP + MOVE attempt
    });

    it('should append build from demand cards when route is complete (final delivery)', async () => {
      const route = makeRoute({
        phase: 'act',
        currentStopIndex: 1, // last stop
      });
      const context = makeContext({
        position: { city: 'Paris', row: 20, col: 20 },
        canBuild: true,
        citiesOnNetwork: ['Berlin'],
        demands: [
          {
            cardIndex: 0, loadType: 'Wine', supplyCity: 'Bordeaux', deliveryCity: 'München',
            payout: 20, isSupplyReachable: false, isDeliveryReachable: false,
            isSupplyOnNetwork: false, isDeliveryOnNetwork: false,
            estimatedTrackCostToSupply: 10, estimatedTrackCostToDelivery: 15,
            isLoadAvailable: true, isLoadOnTrain: false, ferryRequired: false,
          },
        ],
      });

      // First call: DELIVER succeeds
      // Second call: BUILD toward München (demand card city) succeeds
      mockResolve
        .mockResolvedValueOnce({
          success: true,
          plan: { type: AIActionType.DeliverLoad, load: 'Coal', city: 'Paris', cardId: 1, payout: 25 },
        })
        .mockResolvedValueOnce({
          success: true,
          plan: { type: AIActionType.BuildTrack, segments: [makeSegment(20, 20, 20, 21)], targetCity: 'München' },
        });

      const result = await PlanExecutor.execute(route, makeSnapshot(), context);

      // Route complete BUT build appended from demand cards
      expect(result.routeComplete).toBe(true);
      expect(result.plan.type).toBe('MultiAction');
      if (result.plan.type === 'MultiAction') {
        expect(result.plan.steps).toHaveLength(2);
        expect(result.plan.steps[0].type).toBe(AIActionType.DeliverLoad);
        expect(result.plan.steps[1].type).toBe(AIActionType.BuildTrack);
      }
    });

    it('should NOT append build when route is complete and all demand cities are on network', async () => {
      const route = makeRoute({
        phase: 'act',
        currentStopIndex: 1, // last stop
      });
      const context = makeContext({
        position: { city: 'Paris', row: 20, col: 20 },
        canBuild: true,
        citiesOnNetwork: ['Berlin', 'München', 'Bordeaux'],
        demands: [
          {
            cardIndex: 0, loadType: 'Wine', supplyCity: 'Bordeaux', deliveryCity: 'München',
            payout: 20, isSupplyReachable: false, isDeliveryReachable: false,
            isSupplyOnNetwork: true, isDeliveryOnNetwork: true,
            estimatedTrackCostToSupply: 0, estimatedTrackCostToDelivery: 0,
            isLoadAvailable: true, isLoadOnTrain: false, ferryRequired: false,
          },
        ],
      });

      mockResolve.mockResolvedValueOnce({
        success: true,
        plan: { type: AIActionType.DeliverLoad, load: 'Coal', city: 'Paris', cardId: 1, payout: 25 },
      });

      const result = await PlanExecutor.execute(route, makeSnapshot(), context);

      // Route complete, all demand cities on network — no build appended
      expect(result.routeComplete).toBe(true);
      expect(result.plan.type).toBe(AIActionType.DeliverLoad);
      expect(mockResolve).toHaveBeenCalledTimes(1);
    });

    it('should gracefully skip build append when build resolution fails', async () => {
      const route = makeRoute({ phase: 'act', currentStopIndex: 0 });
      const context = makeContext({
        position: { city: 'Berlin', row: 10, col: 10 },
        canBuild: true,
        citiesOnNetwork: ['Berlin'],
      });

      // chainMoveAfterAct tries MOVE → fails, then appendBuildStep tries BUILD → also fails
      mockResolve
        .mockResolvedValueOnce({
          success: true,
          plan: { type: AIActionType.PickupLoad, load: 'Coal', city: 'Berlin' },
        })
        .mockResolvedValueOnce({ success: false, error: 'No path to Paris' })
        .mockResolvedValueOnce({
          success: false,
          error: 'No build path found',
        });

      const result = await PlanExecutor.execute(route, makeSnapshot(), context);

      // Should still return the pickup, just without the build or move
      expect(result.plan.type).toBe(AIActionType.PickupLoad);
    });

    it('should append build to MoveTrain when not arriving at city', async () => {
      const route = makeRoute({ phase: 'travel', currentStopIndex: 0 });
      const context = makeContext({
        position: { row: 5, col: 5 },
        canBuild: true,
        citiesOnNetwork: [], // Berlin not on network — build toward it
      });

      // Move doesn't arrive at Berlin
      mockGetMajorCityLookup.mockReturnValue(new Map([['10,10', 'Berlin']]));

      mockResolve
        .mockResolvedValueOnce({
          success: true,
          plan: { type: AIActionType.MoveTrain, path: [{ row: 5, col: 5 }, { row: 8, col: 8 }], fees: new Set(), totalFee: 0 },
        })
        .mockResolvedValueOnce({
          success: true,
          plan: { type: AIActionType.BuildTrack, segments: [makeSegment(10, 11, 10, 12)], targetCity: 'Berlin' },
        });

      const result = await PlanExecutor.execute(route, makeSnapshot(), context);

      expect(result.plan.type).toBe('MultiAction');
      if (result.plan.type === 'MultiAction') {
        expect(result.plan.steps).toHaveLength(2);
        expect(result.plan.steps[0].type).toBe(AIActionType.MoveTrain);
        expect(result.plan.steps[1].type).toBe(AIActionType.BuildTrack);
      }
    });

    it('should fall back to demand card build target when all route stops are on network', async () => {
      const route = makeRoute({ phase: 'act', currentStopIndex: 0 });
      const context = makeContext({
        position: { city: 'Berlin', row: 10, col: 10 },
        canBuild: true,
        citiesOnNetwork: ['Berlin', 'Paris'], // Both route stops on network
        demands: [
          {
            cardIndex: 0, loadType: 'Wine', supplyCity: 'Bordeaux', deliveryCity: 'München',
            payout: 30, isSupplyReachable: false, isDeliveryReachable: false,
            isSupplyOnNetwork: false, isDeliveryOnNetwork: false,
            estimatedTrackCostToSupply: 10, estimatedTrackCostToDelivery: 15,
            isLoadAvailable: true, isLoadOnTrain: false, ferryRequired: false,
          },
        ],
      });

      // Call 1: PICKUP succeeds
      // Call 2: chainMoveAfterAct tries MOVE toward Paris → fails
      // Call 3: BUILD toward München (from demand card fallback) → succeeds
      mockResolve
        .mockResolvedValueOnce({
          success: true,
          plan: { type: AIActionType.PickupLoad, load: 'Coal', city: 'Berlin' },
        })
        .mockResolvedValueOnce({ success: false, error: 'No path' })
        .mockResolvedValueOnce({
          success: true,
          plan: { type: AIActionType.BuildTrack, segments: [makeSegment(10, 11, 10, 12)], targetCity: 'München' },
        });

      const result = await PlanExecutor.execute(route, makeSnapshot(), context);

      expect(result.plan.type).toBe('MultiAction');
      if (result.plan.type === 'MultiAction') {
        expect(result.plan.steps).toHaveLength(2);
        expect(result.plan.steps[0].type).toBe(AIActionType.PickupLoad);
        expect(result.plan.steps[1].type).toBe(AIActionType.BuildTrack);
      }
      // Verify the build was toward München (demand card city)
      const buildCall = mockResolve.mock.calls.find(
        (args: any[]) => args[0]?.action === 'BUILD' && args[0]?.details?.toward === 'München',
      );
      expect(buildCall).toBeDefined();
    });
  });

  describe('multi-action: chain move after act', () => {
    it('should chain move toward next stop after pickup', async () => {
      const route = makeRoute({ phase: 'act', currentStopIndex: 0 });
      const context = makeContext({
        position: { city: 'Berlin', row: 10, col: 10 },
        canBuild: false, // disable build appending
        citiesOnNetwork: ['Berlin', 'Paris'], // both on network so no build needed
      });

      // First call: resolve PICKUP → success
      // Second call: resolve MOVE toward Paris → success
      mockResolve
        .mockResolvedValueOnce({
          success: true,
          plan: { type: AIActionType.PickupLoad, load: 'Coal', city: 'Berlin' },
        })
        .mockResolvedValueOnce({
          success: true,
          plan: { type: AIActionType.MoveTrain, path: [{ row: 10, col: 10 }, { row: 15, col: 15 }], fees: new Set(), totalFee: 0 },
        });

      const result = await PlanExecutor.execute(route, makeSnapshot(), context);

      expect(result.plan.type).toBe('MultiAction');
      if (result.plan.type === 'MultiAction') {
        expect(result.plan.steps).toHaveLength(2);
        expect(result.plan.steps[0].type).toBe(AIActionType.PickupLoad);
        expect(result.plan.steps[1].type).toBe(AIActionType.MoveTrain);
      }
      // Route should advance past stop 0
      expect(result.updatedRoute.currentStopIndex).toBe(1);
    });

    it('should NOT chain move when route is complete (last stop)', async () => {
      const route = makeRoute({
        phase: 'act',
        currentStopIndex: 1, // last stop — deliver
      });
      const context = makeContext({
        position: { city: 'Paris', row: 20, col: 20 },
        canBuild: false,
      });

      mockResolve.mockResolvedValueOnce({
        success: true,
        plan: { type: AIActionType.DeliverLoad, load: 'Coal', city: 'Paris', cardId: 1, payout: 25 },
      });

      const result = await PlanExecutor.execute(route, makeSnapshot(), context);

      // Route complete — no move chained
      expect(result.routeComplete).toBe(true);
      expect(result.plan.type).toBe(AIActionType.DeliverLoad);
      expect(mockResolve).toHaveBeenCalledTimes(1);
    });

    it('should NOT chain move during initialBuild phase', async () => {
      const route = makeRoute({
        phase: 'act',
        currentStopIndex: 0,
      });
      const context = makeContext({
        position: { city: 'Berlin', row: 10, col: 10 },
        canBuild: false,
        isInitialBuild: true,
        citiesOnNetwork: ['Berlin', 'Paris'],
      });

      mockResolve.mockResolvedValueOnce({
        success: true,
        plan: { type: AIActionType.PickupLoad, load: 'Coal', city: 'Berlin' },
      });

      const result = await PlanExecutor.execute(route, makeSnapshot(), context);

      // No move chained during initialBuild
      expect(result.plan.type).toBe(AIActionType.PickupLoad);
      expect(mockResolve).toHaveBeenCalledTimes(1);
    });

    it('should still return pickup when move resolve fails', async () => {
      const route = makeRoute({ phase: 'act', currentStopIndex: 0 });
      const context = makeContext({
        position: { city: 'Berlin', row: 10, col: 10 },
        canBuild: false,
        citiesOnNetwork: ['Berlin'],
      });

      // Pickup succeeds, move fails
      mockResolve
        .mockResolvedValueOnce({
          success: true,
          plan: { type: AIActionType.PickupLoad, load: 'Coal', city: 'Berlin' },
        })
        .mockResolvedValueOnce({
          success: false,
          error: 'No valid path to Paris',
        });

      const result = await PlanExecutor.execute(route, makeSnapshot(), context);

      // Pickup still returned, move failure doesn't break it
      expect(result.plan.type).toBe(AIActionType.PickupLoad);
      expect(result.routeAbandoned).toBe(false);
    });
  });

  describe('multi-action: combined move + act + build', () => {
    it('should produce MoveTrain + PickupLoad + BuildTrack in one turn', async () => {
      const route = makeRoute({
        phase: 'travel',
        currentStopIndex: 0,
        stops: [
          { action: 'pickup', loadType: 'Coal', city: 'Berlin' },
          { action: 'deliver', loadType: 'Coal', city: 'Paris', demandCardId: 1, payment: 25 },
        ],
      });
      const context = makeContext({
        position: { row: 5, col: 5 },
        canBuild: true,
        citiesOnNetwork: ['Berlin'], // Berlin on network, Paris not
      });

      // Move arrives at Berlin
      mockGetMajorCityLookup.mockReturnValue(new Map([['10,10', 'Berlin']]));

      // Call 1: MOVE → arrives at Berlin
      // Call 2: PICKUP (chained arrival)
      // Call 3: BUILD toward Paris (appended)
      mockResolve
        .mockResolvedValueOnce({
          success: true,
          plan: { type: AIActionType.MoveTrain, path: [{ row: 5, col: 5 }, { row: 10, col: 10 }], fees: new Set(), totalFee: 0 },
        })
        .mockResolvedValueOnce({
          success: true,
          plan: { type: AIActionType.PickupLoad, load: 'Coal', city: 'Berlin' },
        })
        .mockResolvedValueOnce({
          success: true,
          plan: { type: AIActionType.BuildTrack, segments: [makeSegment(10, 11, 10, 12)], targetCity: 'Paris' },
        });

      const result = await PlanExecutor.execute(route, makeSnapshot(), context);

      expect(result.plan.type).toBe('MultiAction');
      if (result.plan.type === 'MultiAction') {
        expect(result.plan.steps).toHaveLength(3);
        expect(result.plan.steps[0].type).toBe(AIActionType.MoveTrain);
        expect(result.plan.steps[1].type).toBe(AIActionType.PickupLoad);
        expect(result.plan.steps[2].type).toBe(AIActionType.BuildTrack);
      }
      // Stop should have advanced (pickup completed)
      expect(result.updatedRoute.currentStopIndex).toBe(1);
    });
  });
});
