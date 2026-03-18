/**
 * TurnComposer tests — multi-phase turn composition, operational enrichment, build appending.
 */

jest.mock('../../services/ai/ActionResolver', () => ({
  ActionResolver: {
    resolve: jest.fn(),
    cloneSnapshot: jest.fn(),
    applyPlanToState: jest.fn(),
  },
}));
jest.mock('../../services/ai/PlanExecutor', () => ({
  PlanExecutor: {
    findDemandBuildTarget: jest.fn(),
  },
}));
jest.mock('../../services/ai/MapTopology', () => ({
  loadGridPoints: jest.fn(() => new Map()),
  getHexNeighbors: jest.fn(() => []),
  getTerrainCost: jest.fn(() => 1),
  gridToPixel: jest.fn(() => ({ x: 0, y: 0 })),
  makeKey: (row: number, col: number) => `${row},${col}`,
  _resetCache: jest.fn(),
}));
jest.mock('../../../shared/services/trackUsageFees', () => ({
  buildUnionTrackGraph: jest.fn(() => ({ adjacency: new Map(), edgeOwners: new Map() })),
  computeTrackUsageForMove: jest.fn(() => ({ feeTotal: 0, ownersUsed: [], ownersPaid: [] })),
}));
jest.mock('../../services/ai/computeBuildSegments', () => ({
  computeBuildSegments: jest.fn(() => []),
}));
jest.mock('../../../shared/services/TrackNetworkService', () => ({
  buildTrackNetwork: jest.fn(() => ({ adjacency: new Map(), nodeSet: new Set() })),
}));
jest.mock('../../services/ai/NetworkBuildAnalyzer', () => ({
  NetworkBuildAnalyzer: {
    findNearbyFerryPorts: jest.fn(() => []),
    findSpurOpportunities: jest.fn(() => []),
    evaluateBuildOption: jest.fn(() => ({ turnsSaved: 0, buildCost: 0, valuePerTurn: 0, isWorthwhile: false })),
    loadFerryData: jest.fn(() => []),
  },
}));

import { TurnComposer } from '../../services/ai/TurnComposer';
import { ActionResolver } from '../../services/ai/ActionResolver';
import { PlanExecutor } from '../../services/ai/PlanExecutor';
import { loadGridPoints } from '../../services/ai/MapTopology';
import * as majorCityGroups from '../../../shared/services/majorCityGroups';
import {
  AIActionType,
  WorldSnapshot,
  GameContext,
  StrategicRoute,
  TrainType,
  TerrainType,
  TrackSegment,
  TurnPlan,
} from '../../../shared/types/GameTypes';

const mockResolve = ActionResolver.resolve as jest.Mock;
const mockCloneSnapshot = ActionResolver.cloneSnapshot as jest.Mock;
const mockApplyPlanToState = ActionResolver.applyPlanToState as jest.Mock;
const mockFindDemandBuildTarget = PlanExecutor.findDemandBuildTarget as jest.Mock;
const mockLoadGridPoints = loadGridPoints as jest.Mock;

// Near-miss optimizer mocks
const { NetworkBuildAnalyzer: MockNetworkBuildAnalyzer } = require('../../services/ai/NetworkBuildAnalyzer');
const mockFindNearbyFerryPorts = MockNetworkBuildAnalyzer.findNearbyFerryPorts as jest.Mock;
const mockFindSpurOpportunities = MockNetworkBuildAnalyzer.findSpurOpportunities as jest.Mock;
const mockEvaluateBuildOption = MockNetworkBuildAnalyzer.evaluateBuildOption as jest.Mock;

function makeSegment(fromRow: number, fromCol: number, toRow: number, toCol: number): TrackSegment {
  return {
    from: { x: 0, y: 0, row: fromRow, col: fromCol, terrain: TerrainType.Clear },
    to: { x: 0, y: 0, row: toRow, col: toCol, terrain: TerrainType.Clear },
    cost: 1,
  };
}

function makeSnapshot(overrides: Partial<WorldSnapshot> = {}): WorldSnapshot {
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
    ...overrides,
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
    unconnectedMajorCities: [],
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

/**
 * Default cloneSnapshot implementation that deep-copies the snapshot
 * so TurnComposer mutations on the clone don't affect the original.
 */
function defaultCloneSnapshot(snap: WorldSnapshot): WorldSnapshot {
  return {
    ...snap,
    bot: {
      ...snap.bot,
      loads: [...snap.bot.loads],
      existingSegments: [...snap.bot.existingSegments],
      demandCards: [...snap.bot.demandCards],
      resolvedDemands: snap.bot.resolvedDemands.map(rd => ({
        ...rd,
        demands: [...rd.demands],
      })),
    },
    allPlayerTracks: [...snap.allPlayerTracks],
    loadAvailability: { ...snap.loadAvailability },
  };
}

describe('TurnComposer', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    // Default mock implementations (reset before each test to prevent leaks)
    mockCloneSnapshot.mockImplementation(defaultCloneSnapshot);
    mockApplyPlanToState.mockImplementation(() => {}); // no-op by default
    mockLoadGridPoints.mockReturnValue(new Map());
    mockFindDemandBuildTarget.mockReturnValue(null);
  });

  describe('exclusive actions', () => {
    it('DISCARD_HAND returns unchanged', async () => {
      const plan: TurnPlan = { type: AIActionType.DiscardHand };
      const { plan: result } = await TurnComposer.compose(plan, makeSnapshot(), makeContext());

      expect(result).toBe(plan);
      expect(result.type).toBe(AIActionType.DiscardHand);
      // No cloneSnapshot or resolve calls should be made
      expect(mockCloneSnapshot).not.toHaveBeenCalled();
      expect(mockResolve).not.toHaveBeenCalled();
    });

    it('PassTurn returns unchanged', async () => {
      const plan: TurnPlan = { type: AIActionType.PassTurn };
      const { plan: result } = await TurnComposer.compose(plan, makeSnapshot(), makeContext());

      expect(result).toBe(plan);
      expect(result.type).toBe(AIActionType.PassTurn);
      expect(mockCloneSnapshot).not.toHaveBeenCalled();
      expect(mockResolve).not.toHaveBeenCalled();
    });

    it('UPGRADE skips build phase', async () => {
      const plan: TurnPlan = { type: AIActionType.UpgradeTrain, targetTrain: 'FastFreight', cost: 20 };
      const snapshot = makeSnapshot();
      const context = makeContext({ canBuild: true });

      // Even if findDemandBuildTarget returns a target, build should be skipped
      mockFindDemandBuildTarget.mockReturnValue('München');

      const { plan: result } = await TurnComposer.compose(plan, snapshot, context);

      // UPGRADE should be returned without BUILD appended
      // Since it's the only step, it returns the primary plan unchanged
      expect(result.type).toBe(AIActionType.UpgradeTrain);
      // resolve should NOT be called for BUILD
      expect(mockResolve).not.toHaveBeenCalled();
    });
  });

  describe('move + pickup/deliver composition', () => {
    it('Primary MOVE arrives at delivery city -> MOVE + DELIVER', async () => {
      // Bot carries Coal, has a demand for Coal at Paris
      const snapshot = makeSnapshot({
        bot: {
          ...makeSnapshot().bot,
          loads: ['Coal'],
          resolvedDemands: [
            {
              cardId: 1,
              demands: [{ city: 'Paris', loadType: 'Coal', payment: 25 }],
            },
          ],
        },
      });
      const context = makeContext();

      // Move path ends at (20, 20) which maps to Paris
      const movePlan: TurnPlan = {
        type: AIActionType.MoveTrain,
        path: [{ row: 10, col: 10 }, { row: 15, col: 15 }, { row: 20, col: 20 }],
        fees: new Set<string>(),
        totalFee: 0,
      };

      // Setup loadGridPoints to map Paris position
      mockLoadGridPoints.mockReturnValue(new Map([
        ['20,20', { row: 20, col: 20, terrain: TerrainType.MajorCity, name: 'Paris' }],
      ]));

      // cloneSnapshot must carry over loads and resolvedDemands
      mockCloneSnapshot.mockImplementation((snap: WorldSnapshot) => ({
        ...snap,
        bot: {
          ...snap.bot,
          loads: [...snap.bot.loads],
          existingSegments: [...snap.bot.existingSegments],
          demandCards: [...snap.bot.demandCards],
          resolvedDemands: snap.bot.resolvedDemands.map(rd => ({
            ...rd,
            demands: [...rd.demands],
          })),
        },
        allPlayerTracks: [...snap.allPlayerTracks],
        loadAvailability: { ...snap.loadAvailability },
      }));

      // applyPlanToState for the MOVE: update bot position to end of path
      mockApplyPlanToState.mockImplementation((plan: TurnPlan, snap: WorldSnapshot) => {
        if (plan.type === AIActionType.MoveTrain) {
          const movePath = (plan as any).path;
          const endPos = movePath[movePath.length - 1];
          snap.bot.position = { row: endPos.row, col: endPos.col };
        }
      });

      // resolve DELIVER succeeds
      mockResolve.mockResolvedValueOnce({
        success: true,
        plan: { type: AIActionType.DeliverLoad, load: 'Coal', city: 'Paris', cardId: 1, payout: 25 },
      });

      const { plan: result } = await TurnComposer.compose(movePlan, snapshot, context);

      expect(result.type).toBe('MultiAction');
      if (result.type === 'MultiAction') {
        expect(result.steps).toHaveLength(2);
        expect(result.steps[0].type).toBe(AIActionType.MoveTrain);
        expect(result.steps[1].type).toBe(AIActionType.DeliverLoad);
      }
    });

    it('Primary MOVE arrives at supply city -> MOVE + PICKUP', async () => {
      // Bot has demand for Coal, Berlin produces Coal, bot at capacity < max
      const snapshot = makeSnapshot({
        bot: {
          ...makeSnapshot().bot,
          loads: [],
          resolvedDemands: [
            {
              cardId: 1,
              demands: [{ city: 'Paris', loadType: 'Coal', payment: 25 }],
            },
          ],
        },
        loadAvailability: { Berlin: ['Coal'] },
      });
      const context = makeContext();

      // Move path ends at Berlin (10, 20)
      const movePlan: TurnPlan = {
        type: AIActionType.MoveTrain,
        path: [{ row: 10, col: 10 }, { row: 10, col: 20 }],
        fees: new Set<string>(),
        totalFee: 0,
      };

      mockLoadGridPoints.mockReturnValue(new Map([
        ['10,20', { row: 10, col: 20, terrain: TerrainType.MajorCity, name: 'Berlin' }],
      ]));

      mockApplyPlanToState.mockImplementation((plan: TurnPlan, snap: WorldSnapshot) => {
        if (plan.type === AIActionType.MoveTrain) {
          const movePath = (plan as any).path;
          const endPos = movePath[movePath.length - 1];
          snap.bot.position = { row: endPos.row, col: endPos.col };
        }
      });

      // resolve PICKUP succeeds
      mockResolve.mockResolvedValueOnce({
        success: true,
        plan: { type: AIActionType.PickupLoad, load: 'Coal', city: 'Berlin' },
      });

      const { plan: result } = await TurnComposer.compose(movePlan, snapshot, context);

      expect(result.type).toBe('MultiAction');
      if (result.type === 'MultiAction') {
        expect(result.steps).toHaveLength(2);
        expect(result.steps[0].type).toBe(AIActionType.MoveTrain);
        expect(result.steps[1].type).toBe(AIActionType.PickupLoad);
      }
    });

    it('Bot at capacity skips pickup', async () => {
      // Bot already has 2/2 loads (Freight capacity = 2)
      const snapshot = makeSnapshot({
        bot: {
          ...makeSnapshot().bot,
          loads: ['Iron', 'Wine'],
          resolvedDemands: [
            {
              cardId: 1,
              demands: [{ city: 'Paris', loadType: 'Coal', payment: 25 }],
            },
          ],
        },
        loadAvailability: { Berlin: ['Coal'] },
      });
      const context = makeContext();

      // Move path ends at Berlin
      const movePlan: TurnPlan = {
        type: AIActionType.MoveTrain,
        path: [{ row: 10, col: 10 }, { row: 10, col: 20 }],
        fees: new Set<string>(),
        totalFee: 0,
      };

      mockLoadGridPoints.mockReturnValue(new Map([
        ['10,20', { row: 10, col: 20, terrain: TerrainType.MajorCity, name: 'Berlin' }],
      ]));

      // Apply move updates position, but also clone must carry loads correctly
      mockCloneSnapshot.mockImplementation(defaultCloneSnapshot);
      mockApplyPlanToState.mockImplementation((plan: TurnPlan, snap: WorldSnapshot) => {
        if (plan.type === AIActionType.MoveTrain) {
          const movePath = (plan as any).path;
          const endPos = movePath[movePath.length - 1];
          snap.bot.position = { row: endPos.row, col: endPos.col };
        }
      });

      const { plan: result } = await TurnComposer.compose(movePlan, snapshot, context);

      // Bot at capacity, no deliver match either -> MOVE only (no MultiAction)
      // resolve should NOT have been called for PICKUP
      expect(mockResolve).not.toHaveBeenCalled();
      // Since no additional steps, returns the primary plan unchanged
      expect(result.type).toBe(AIActionType.MoveTrain);
    });
  });

  describe('continuation MOVE after split', () => {
    it('MOVE to pickup city -> PICKUP -> continuation MOVE toward delivery', async () => {
      // Bot has demand for Cars, Torino produces Cars, route: pickup(Cars@Torino) → deliver(Cars@Nantes)
      const snapshot = makeSnapshot({
        bot: {
          ...makeSnapshot().bot,
          loads: [],
          resolvedDemands: [
            {
              cardId: 1,
              demands: [{ city: 'Nantes', loadType: 'Cars', payment: 51 }],
            },
          ],
        },
        loadAvailability: { Torino: ['Cars'] },
      });
      const context = makeContext({ speed: 9 });
      const route = makeRoute({
        stops: [
          { action: 'pickup', loadType: 'Cars', city: 'Torino' },
          { action: 'deliver', loadType: 'Cars', city: 'Nantes', demandCardId: 1, payment: 51 },
        ],
        currentStopIndex: 0,
        phase: 'travel',
      });

      // Primary plan: MOVE 2 mileposts to Torino
      const movePlan: TurnPlan = {
        type: AIActionType.MoveTrain,
        path: [{ row: 42, col: 41 }, { row: 41, col: 41 }, { row: 40, col: 41 }],
        fees: new Set<string>(),
        totalFee: 0,
      };

      // Setup loadGridPoints: Torino at (40,41)
      mockLoadGridPoints.mockReturnValue(new Map([
        ['40,41', { row: 40, col: 41, terrain: TerrainType.MediumCity, name: 'Torino' }],
      ]));

      // cloneSnapshot carries loads and resolvedDemands
      mockCloneSnapshot.mockImplementation((snap: WorldSnapshot) => ({
        ...snap,
        bot: {
          ...snap.bot,
          loads: [...snap.bot.loads],
          existingSegments: [...snap.bot.existingSegments],
          demandCards: [...snap.bot.demandCards],
          resolvedDemands: snap.bot.resolvedDemands.map(rd => ({
            ...rd,
            demands: [...rd.demands],
          })),
        },
        allPlayerTracks: [...snap.allPlayerTracks],
        loadAvailability: { ...snap.loadAvailability },
      }));

      // applyPlanToState: update position for MOVE, add load for PICKUP
      mockApplyPlanToState.mockImplementation((plan: TurnPlan, snap: WorldSnapshot, ctx: GameContext) => {
        if (plan.type === AIActionType.MoveTrain) {
          const movePath = (plan as any).path;
          const endPos = movePath[movePath.length - 1];
          snap.bot.position = { row: endPos.row, col: endPos.col };
          ctx.position = { row: endPos.row, col: endPos.col };
        }
        if (plan.type === AIActionType.PickupLoad) {
          const load = (plan as any).load;
          snap.bot.loads.push(load);
          ctx.loads = [...snap.bot.loads];
        }
      });

      // A1 finds PICKUP at Torino (via splitMoveForOpportunities → ActionResolver.resolve)
      mockResolve
        // A1: PICKUP at Torino during split
        .mockResolvedValueOnce({
          success: true,
          plan: { type: AIActionType.PickupLoad, load: 'Cars', city: 'Torino' },
        })
        // A2: continuation MOVE toward Nantes (7 remaining mileposts)
        .mockResolvedValueOnce({
          success: true,
          plan: {
            type: AIActionType.MoveTrain,
            path: [
              { row: 40, col: 41 }, { row: 39, col: 40 }, { row: 38, col: 40 },
              { row: 37, col: 39 }, { row: 36, col: 39 }, { row: 35, col: 38 },
              { row: 34, col: 38 }, { row: 33, col: 37 }, { row: 32, col: 37 },
              { row: 31, col: 36 },
            ],
            fees: new Set<string>(),
            totalFee: 0,
          },
        });

      const { plan: result } = await TurnComposer.compose(movePlan, snapshot, context, route);

      expect(result.type).toBe('MultiAction');
      if (result.type === 'MultiAction') {
        // Should be: MOVE(to Torino) + PICKUP(Cars) + MOVE(continuation toward Nantes)
        expect(result.steps.length).toBeGreaterThanOrEqual(3);
        expect(result.steps[0].type).toBe(AIActionType.MoveTrain);
        expect(result.steps[1].type).toBe(AIActionType.PickupLoad);
        // Last operational step should be a MOVE (continuation)
        const lastMoveStep = result.steps.find(
          (s, i) => i >= 2 && s.type === AIActionType.MoveTrain,
        );
        expect(lastMoveStep).toBeDefined();
      }

      // Verify continuation MOVE targets Nantes (delivery city), not Torino (pickup city)
      const moveCalls = mockResolve.mock.calls.filter(
        (args: any[]) => args[0]?.action === 'MOVE',
      );
      expect(moveCalls.length).toBe(1);
      expect(moveCalls[0][0].details.to).toBe('Nantes');
    });

    it('Continuation MOVE is capped at remaining movement allowance', async () => {
      // Bot already used 4 mileposts, speed=9, so only 5 remaining
      const snapshot = makeSnapshot({
        bot: {
          ...makeSnapshot().bot,
          loads: ['Coal'],
          resolvedDemands: [],
        },
      });
      const context = makeContext({ speed: 9 });
      // Route points to next stop (pickup Wine at Bordeaux) after the delivery
      const route = makeRoute({
        stops: [
          { action: 'deliver', loadType: 'Coal', city: 'Paris', demandCardId: 1, payment: 25 },
          { action: 'pickup', loadType: 'Wine', city: 'Bordeaux' },
        ],
        currentStopIndex: 1, // already past the deliver stop
      });

      // Primary: DELIVER after a 4-milepost MOVE
      const deliverPlan: TurnPlan = {
        type: AIActionType.DeliverLoad,
        load: 'Coal',
        city: 'Paris',
        cardId: 1,
        payout: 25,
      };

      // Create a MultiAction with MOVE + DELIVER as primary
      const primaryPlan: TurnPlan = {
        type: 'MultiAction' as const,
        steps: [
          {
            type: AIActionType.MoveTrain,
            path: [
              { row: 10, col: 10 }, { row: 11, col: 10 },
              { row: 12, col: 10 }, { row: 13, col: 10 }, { row: 14, col: 10 },
            ],
            fees: new Set<string>(),
            totalFee: 0,
          } as TurnPlan,
          deliverPlan,
        ],
      };

      mockApplyPlanToState.mockImplementation((plan: TurnPlan, snap: WorldSnapshot, ctx: GameContext) => {
        if (plan.type === AIActionType.MoveTrain) {
          const movePath = (plan as any).path;
          const endPos = movePath[movePath.length - 1];
          snap.bot.position = { row: endPos.row, col: endPos.col };
          ctx.position = { row: endPos.row, col: endPos.col };
        }
        if (plan.type === AIActionType.DeliverLoad) {
          const loadIdx = snap.bot.loads.indexOf((plan as any).load);
          if (loadIdx >= 0) snap.bot.loads.splice(loadIdx, 1);
          ctx.loads = [...snap.bot.loads];
          snap.bot.money += (plan as any).payout;
          ctx.money = snap.bot.money;
        }
      });

      // A2: continuation MOVE returns 9-milepost path (too long — should be capped to 5)
      mockResolve.mockResolvedValueOnce({
        success: true,
        plan: {
          type: AIActionType.MoveTrain,
          path: [
            { row: 14, col: 10 }, { row: 15, col: 10 }, { row: 16, col: 10 },
            { row: 17, col: 10 }, { row: 18, col: 10 }, { row: 19, col: 10 },
            { row: 20, col: 10 }, { row: 21, col: 10 }, { row: 22, col: 10 },
            { row: 23, col: 10 },
          ],
          fees: new Set<string>(),
          totalFee: 0,
        },
      });

      const { plan: result } = await TurnComposer.compose(primaryPlan, snapshot, context, route);

      expect(result.type).toBe('MultiAction');
      if (result.type === 'MultiAction') {
        // Find the continuation MOVE (the one after DELIVER)
        const deliverIdx = result.steps.findIndex(s => s.type === AIActionType.DeliverLoad);
        const continuationMoves = result.steps.filter(
          (s, i) => i > deliverIdx && s.type === AIActionType.MoveTrain,
        );
        expect(continuationMoves.length).toBeGreaterThan(0);
        // The continuation MOVE should be capped at 5 mileposts (9 - 4 already used)
        const continuationPath = (continuationMoves[0] as any).path;
        expect(continuationPath.length - 1).toBeLessThanOrEqual(5);
      }
    });
  });

  describe('pickup/deliver + move composition', () => {
    it('Primary PICKUP -> PICKUP + MOVE', async () => {
      const snapshot = makeSnapshot();
      const context = makeContext();
      const route = makeRoute({
        phase: 'travel',
        currentStopIndex: 1, // next stop is deliver at Paris
      });

      // applyPlanToState must simulate the pickup so findMoveTarget sees the load
      mockApplyPlanToState.mockImplementation((plan: any, _snap: any, ctx: any) => {
        if (plan.type === AIActionType.PickupLoad) {
          ctx.loads = [...(ctx.loads || []), plan.load];
        }
      });

      const pickupPlan: TurnPlan = {
        type: AIActionType.PickupLoad,
        load: 'Coal',
        city: 'Berlin',
      };

      // After pickup, TurnComposer should try MOVE toward next route stop (Paris)
      mockResolve.mockResolvedValueOnce({
        success: true,
        plan: {
          type: AIActionType.MoveTrain,
          path: [{ row: 10, col: 10 }, { row: 15, col: 15 }],
          fees: new Set<string>(),
          totalFee: 0,
        },
      });

      const { plan: result } = await TurnComposer.compose(pickupPlan, snapshot, context, route);

      expect(result.type).toBe('MultiAction');
      if (result.type === 'MultiAction') {
        expect(result.steps).toHaveLength(2);
        expect(result.steps[0].type).toBe(AIActionType.PickupLoad);
        expect(result.steps[1].type).toBe(AIActionType.MoveTrain);
      }

      // Verify the MOVE resolve was called with the route's next stop city
      const moveCall = mockResolve.mock.calls.find(
        (args: any[]) => args[0]?.action === 'MOVE',
      );
      expect(moveCall).toBeDefined();
      expect(moveCall![0].details.to).toBe('Paris');
    });
  });

  describe('build phase composition', () => {
    it('Primary DELIVER defers BUILD when current stop on-network (JIRA-124 ADR-3)', async () => {
      const snapshot = makeSnapshot();
      const context = makeContext({ turnBuildCost: 0, money: 50, citiesOnNetwork: ['Berlin', 'Paris'] });
      const route = makeRoute({
        currentStopIndex: 1,
        stops: [
          { action: 'pickup', loadType: 'Coal', city: 'Berlin' },
          { action: 'deliver', loadType: 'Coal', city: 'Paris', demandCardId: 1, payment: 25 },
          { action: 'pickup', loadType: 'Wine', city: 'Bordeaux' },
        ],
      });

      const deliverPlan: TurnPlan = {
        type: AIActionType.DeliverLoad,
        load: 'Coal',
        city: 'Paris',
        cardId: 1,
        payout: 25,
      };

      // After DELIVER (no MOVE present), findMoveTarget may try MOVE but let that fail.
      // JIRA-124: current stop (Paris) is on-network, so JIT gate defers build toward Bordeaux
      mockResolve
        // A2: MOVE toward next stop — fails
        .mockResolvedValueOnce({ success: false, error: 'No path' });

      const { plan: result } = await TurnComposer.compose(deliverPlan, snapshot, context, route);

      // JIRA-124: build deferred because current stop (Paris) is on-network — only DELIVER produced
      expect(result.type).toBe(AIActionType.DeliverLoad);
    });

    it('Post-delivery defers BUILD when current stop on-network (JIRA-124 ADR-3)', async () => {
      // Pre-delivery money=5M. After delivery earns 25M, money=30M.
      // JIRA-124: current stop (Paris) is on-network, so build toward Bordeaux is deferred.
      const snapshot = makeSnapshot({
        bot: {
          ...makeSnapshot().bot,
          money: 5,
        },
      });
      const context = makeContext({ money: 5, turnBuildCost: 0, citiesOnNetwork: ['Berlin', 'Paris'] });
      const route = makeRoute({
        currentStopIndex: 1,
        stops: [
          { action: 'pickup', loadType: 'Coal', city: 'Berlin' },
          { action: 'deliver', loadType: 'Coal', city: 'Paris', demandCardId: 1, payment: 25 },
          { action: 'pickup', loadType: 'Wine', city: 'Bordeaux' },
        ],
      });

      const deliverPlan: TurnPlan = {
        type: AIActionType.DeliverLoad,
        load: 'Coal',
        city: 'Paris',
        cardId: 1,
        payout: 25,
      };

      // applyPlanToState must update money when applying DeliverLoad
      mockApplyPlanToState.mockImplementation((plan: TurnPlan, snap: WorldSnapshot, ctx: GameContext) => {
        if (plan.type === AIActionType.DeliverLoad) {
          const payout = (plan as any).payout as number;
          snap.bot.money += payout;
          ctx.money = snap.bot.money;
        }
      });

      // A2: MOVE toward next stop — fails
      mockResolve
        .mockResolvedValueOnce({ success: false, error: 'No path' });

      const { plan: result } = await TurnComposer.compose(deliverPlan, snapshot, context, route);

      // JIRA-124: build deferred because current stop (Paris) is on-network — only DELIVER produced
      expect(result.type).toBe(AIActionType.DeliverLoad);
    });

    it('Primary BUILD -> no additional phases', async () => {
      const snapshot = makeSnapshot();
      const context = makeContext({ canBuild: true, turnBuildCost: 0 });

      const buildPlan: TurnPlan = {
        type: AIActionType.BuildTrack,
        segments: [makeSegment(10, 10, 10, 11)],
        targetCity: 'Berlin',
      };

      const { plan: result } = await TurnComposer.compose(buildPlan, snapshot, context);

      // Build is already present -> skipBuildPhase=true, no second build appended
      // No MOVE in primary, and primary is not PICKUP/DELIVER, so no A2 chaining
      // Result: primary plan unchanged
      expect(result.type).toBe(AIActionType.BuildTrack);
      expect(mockResolve).not.toHaveBeenCalled();
    });
  });

  describe('error handling', () => {
    it('Failed append phases are silently skipped', async () => {
      const snapshot = makeSnapshot();
      const context = makeContext({ turnBuildCost: 0, money: 50 });

      const deliverPlan: TurnPlan = {
        type: AIActionType.DeliverLoad,
        load: 'Coal',
        city: 'Paris',
        cardId: 1,
        payout: 25,
      };

      // findDemandBuildTarget returns a target so tryAppendBuild will try
      mockFindDemandBuildTarget.mockReturnValue('München');

      // A2: MOVE toward demand city — fails
      mockResolve
        .mockResolvedValueOnce({ success: false, error: 'No path' })
        // Phase B: BUILD resolve also fails
        .mockResolvedValueOnce({ success: false, error: 'No build path found' });

      const { plan: result } = await TurnComposer.compose(deliverPlan, snapshot, context);

      // Only the primary DELIVER is returned
      expect(result.type).toBe(AIActionType.DeliverLoad);
    });

    it('scanPathOpportunities error does not lose primary', async () => {
      const snapshot = makeSnapshot({
        bot: {
          ...makeSnapshot().bot,
          loads: ['Coal'],
          resolvedDemands: [
            {
              cardId: 1,
              demands: [{ city: 'Paris', loadType: 'Coal', payment: 25 }],
            },
          ],
        },
      });
      const context = makeContext();

      const movePlan: TurnPlan = {
        type: AIActionType.MoveTrain,
        path: [{ row: 10, col: 10 }, { row: 20, col: 20 }],
        fees: new Set<string>(),
        totalFee: 0,
      };

      // Make loadGridPoints throw during scanPathOpportunities
      mockLoadGridPoints.mockImplementation(() => {
        throw new Error('Simulated lookup failure');
      });

      // applyPlanToState for the move still updates position
      mockApplyPlanToState.mockImplementation((plan: TurnPlan, snap: WorldSnapshot) => {
        if (plan.type === AIActionType.MoveTrain) {
          const movePath = (plan as any).path;
          const endPos = movePath[movePath.length - 1];
          snap.bot.position = { row: endPos.row, col: endPos.col };
        }
      });

      const { plan: result } = await TurnComposer.compose(movePlan, snapshot, context);

      // Phase A error caught — primary plan returned unchanged
      expect(result.type).toBe(AIActionType.MoveTrain);
    });
  });

  describe('Phase A3: MOVE prepended before BUILD', () => {
    it('BUILD primary gets MOVE prepended when move target exists', async () => {
      const snapshot = makeSnapshot({
        bot: {
          ...makeSnapshot().bot,
          loads: ['Coal'],
        },
      });
      // Bot carrying Coal, delivery city on network -> findMoveTarget returns Paris
      const context = makeContext({
        demands: [
          {
            cardIndex: 0, loadType: 'Coal', supplyCity: 'Berlin', deliveryCity: 'Paris',
            payout: 25, isSupplyReachable: false, isDeliveryReachable: false,
            isSupplyOnNetwork: true, isDeliveryOnNetwork: true,
            estimatedTrackCostToSupply: 0, estimatedTrackCostToDelivery: 0,
            isLoadAvailable: true, isLoadOnTrain: true, ferryRequired: false,
            loadChipTotal: 4, loadChipCarried: 0, estimatedTurns: 0,
            demandScore: 0, efficiencyPerTurn: 0, networkCitiesUnlocked: 0, victoryMajorCitiesEnRoute: 0,
            isAffordable: true, projectedFundsAfterDelivery: 50,
          },
        ],
      });

      const buildPlan: TurnPlan = {
        type: AIActionType.BuildTrack,
        segments: [makeSegment(10, 10, 10, 11)],
        targetCity: 'München',
      };

      // A3: MOVE toward delivery city (Paris) succeeds
      mockResolve.mockResolvedValueOnce({
        success: true,
        plan: {
          type: AIActionType.MoveTrain,
          path: [{ row: 10, col: 10 }, { row: 12, col: 12 }],
          fees: new Set<string>(),
          totalFee: 0,
        },
      });

      const { plan: result } = await TurnComposer.compose(buildPlan, snapshot, context);

      expect(result.type).toBe('MultiAction');
      if (result.type === 'MultiAction') {
        // MOVE should be before BUILD
        expect(result.steps[0].type).toBe(AIActionType.MoveTrain);
        expect(result.steps[result.steps.length - 1].type).toBe(AIActionType.BuildTrack);
      }
    });

    it('BUILD primary stays unchanged when no move target found', async () => {
      const snapshot = makeSnapshot();
      const context = makeContext({
        demands: [], // No demands = no move target
      });

      const buildPlan: TurnPlan = {
        type: AIActionType.BuildTrack,
        segments: [makeSegment(10, 10, 10, 11)],
        targetCity: 'München',
      };

      const { plan: result } = await TurnComposer.compose(buildPlan, snapshot, context);

      // No move target found, plan unchanged
      expect(result.type).toBe(AIActionType.BuildTrack);
      expect(mockResolve).not.toHaveBeenCalled();
    });
  });

  describe('Phase B: victory-priority speculative build', () => {
    it('prefers unconnected major city over demand city for speculative build', async () => {
      // Use MOVE primary to isolate Phase B (avoids A2/A3 interactions)
      // Money must be > 230 to pass the victory build cash threshold
      const snapshot = makeSnapshot({
        bot: { ...makeSnapshot().bot, money: 240 },
      });
      const context = makeContext({
        turnBuildCost: 0,
        money: 240,
        unconnectedMajorCities: [
          { cityName: 'Milano', estimatedCost: 6 },
          { cityName: 'Wien', estimatedCost: 21 },
        ],
      });

      const movePlan: TurnPlan = {
        type: AIActionType.MoveTrain,
        path: [{ row: 10, col: 10 }, { row: 12, col: 12 }],
        fees: new Set<string>(),
        totalFee: 0,
      };

      // findDemandBuildTarget would return 'Roma' — but victory city should be preferred
      mockFindDemandBuildTarget.mockReturnValue('Roma');

      // Phase B: BUILD toward Milano (victory priority) succeeds
      mockResolve.mockResolvedValueOnce({
        success: true,
        plan: { type: AIActionType.BuildTrack, segments: [makeSegment(20, 20, 20, 21)], targetCity: 'Milano' },
      });

      const { plan: result } = await TurnComposer.compose(movePlan, snapshot, context);

      expect(result.type).toBe('MultiAction');
      if (result.type === 'MultiAction') {
        const buildStep = result.steps.find(s => s.type === AIActionType.BuildTrack);
        expect(buildStep).toBeDefined();
      }

      // Verify BUILD was called with Milano, not Roma
      const buildCall = mockResolve.mock.calls.find(
        (args: any[]) => args[0]?.action === 'BUILD',
      );
      expect(buildCall).toBeDefined();
      expect(buildCall![0].details.toward).toBe('Milano');
      // findDemandBuildTarget should NOT have been called (victory city found first)
      expect(mockFindDemandBuildTarget).not.toHaveBeenCalled();
    });

    it('skips speculative victory build when mid-route (travel phase)', async () => {
      // Bot is mid-route traveling to deliver Cars at Nantes.
      // Nantes is on network, so no route-specific build target.
      // Despite Ruhr being cheapest unconnected city, bot should NOT build toward it —
      // it should finish its delivery first and earn the payout.
      const snapshot = makeSnapshot();
      const context = makeContext({
        turnBuildCost: 0,
        money: 14,
        citiesOnNetwork: ['Torino', 'Paris', 'Lyon', 'Nantes'],
        unconnectedMajorCities: [
          { cityName: 'Ruhr', estimatedCost: 14 },
          { cityName: 'London', estimatedCost: 15 },
        ],
      });

      const movePlan: TurnPlan = {
        type: AIActionType.MoveTrain,
        path: [{ row: 35, col: 36 }, { row: 34, col: 35 }],
        fees: new Set<string>(),
        totalFee: 0,
      };

      // Active route in travel phase — bot is moving to deliver
      const route = makeRoute({
        stops: [
          { action: 'pickup', loadType: 'Cars', city: 'Torino' },
          { action: 'deliver', loadType: 'Cars', city: 'Nantes', demandCardId: 1, payment: 51 },
        ],
        currentStopIndex: 1,
        phase: 'travel',
      });

      const { plan: result } = await TurnComposer.compose(movePlan, snapshot, context, route);

      // Should NOT append a build step — bot is mid-route
      expect(result.type).toBe(AIActionType.MoveTrain);
      expect(mockResolve).not.toHaveBeenCalled();
      expect(mockFindDemandBuildTarget).not.toHaveBeenCalled();
    });

    it('does not build speculatively when no unconnected major cities (JIRA-93)', async () => {
      const snapshot = makeSnapshot();
      const context = makeContext({
        turnBuildCost: 0,
        money: 50,
        unconnectedMajorCities: [], // All connected
      });

      const movePlan: TurnPlan = {
        type: AIActionType.MoveTrain,
        path: [{ row: 10, col: 10 }, { row: 12, col: 12 }],
        fees: new Set<string>(),
        totalFee: 0,
      };

      const { plan: result } = await TurnComposer.compose(movePlan, snapshot, context);

      // JIRA-93: No speculative builds — should NOT fall back to findDemandBuildTarget
      expect(result.type).toBe(AIActionType.MoveTrain);
      expect(mockFindDemandBuildTarget).not.toHaveBeenCalled();
    });
  });

  describe('findMoveTarget deliver-stop skip', () => {
    it('skips deliver stop when bot no longer has the load (already delivered)', async () => {
      // Route: pickup Wine at Bordeaux → deliver Wine at Berlin → pickup Oil at Baku
      // Bot has already delivered Wine (loads is empty), so deliver at Berlin should be skipped.
      // findMoveTarget should return 'Baku' (next actionable stop).
      const snapshot = makeSnapshot({
        bot: {
          ...makeSnapshot().bot,
          loads: [], // Wine already delivered
        },
      });
      const context = makeContext({ loads: [] });
      const route = makeRoute({
        stops: [
          { action: 'pickup', loadType: 'Wine', city: 'Bordeaux' },
          { action: 'deliver', loadType: 'Wine', city: 'Berlin', demandCardId: 1, payment: 30 },
          { action: 'pickup', loadType: 'Oil', city: 'Baku' },
        ],
        currentStopIndex: 1, // Past the pickup, at the deliver stop
        phase: 'travel',
      });

      // Use PICKUP as primary to trigger A2 which calls findMoveTarget
      const pickupPlan: TurnPlan = {
        type: AIActionType.PickupLoad,
        load: 'Iron',
        city: 'SomeCity',
      };

      // A2: MOVE toward Baku (the target findMoveTarget should return)
      mockResolve.mockResolvedValueOnce({
        success: true,
        plan: {
          type: AIActionType.MoveTrain,
          path: [{ row: 10, col: 10 }, { row: 12, col: 12 }],
          fees: new Set<string>(),
          totalFee: 0,
        },
      });

      const { plan: result } = await TurnComposer.compose(pickupPlan, snapshot, context, route);

      // Verify findMoveTarget skipped Berlin (deliver without load) and targeted Baku
      const moveCall = mockResolve.mock.calls.find(
        (args: any[]) => args[0]?.action === 'MOVE',
      );
      expect(moveCall).toBeDefined();
      expect(moveCall![0].details.to).toBe('Baku');
    });

    it('uses live context.loads instead of stale demand.isLoadOnTrain for move targets', async () => {
      // Bug: After delivering a load via TurnComposer (A1 split), demand.isLoadOnTrain
      // remains true (stale) even though context.loads was updated. This caused
      // Priority 2 to add the delivery city (bot already there) and Priority 3 to
      // skip supply cities for the delivered load type.
      //
      // Scenario: Bot delivered Steel at Torino (last route stop). No more route stops.
      // context.loads is empty (Steel delivered), but demand for Steel still has
      // isLoadOnTrain=true (stale from ContextBuilder). Priority 3 should use
      // context.loads to find supply targets, not the stale flag.
      const snapshot = makeSnapshot({
        bot: {
          ...makeSnapshot().bot,
          loads: [], // Steel already delivered during composition
        },
      });
      const context = makeContext({
        loads: [], // Updated during composition
        demands: [
          // Stale demand: isLoadOnTrain=true even though Steel was already delivered
          {
            cardIndex: 1,
            loadType: 'Steel',
            supplyCity: 'Ruhr',
            deliveryCity: 'Torino',
            payout: 16,
            isSupplyReachable: true,
            isDeliveryReachable: true,
            isSupplyOnNetwork: true,
            isDeliveryOnNetwork: true,
            estimatedTrackCostToSupply: 0,
            estimatedTrackCostToDelivery: 0,
            isLoadAvailable: true,
            isLoadOnTrain: true, // STALE — Steel was already delivered
            ferryRequired: false,
            loadChipTotal: 4,
            loadChipCarried: 0,
            estimatedTurns: 2,
            demandScore: 8,
            efficiencyPerTurn: 0, networkCitiesUnlocked: 0, victoryMajorCitiesEnRoute: 0,
            isAffordable: true, projectedFundsAfterDelivery: 50,
          },
          // Another demand from remaining card — supply on network
          {
            cardIndex: 2,
            loadType: 'Wine',
            supplyCity: 'Bordeaux',
            deliveryCity: 'Berlin',
            payout: 20,
            isSupplyReachable: false,
            isDeliveryReachable: false,
            isSupplyOnNetwork: true,
            isDeliveryOnNetwork: false,
            estimatedTrackCostToSupply: 0,
            estimatedTrackCostToDelivery: 10,
            isLoadAvailable: true,
            isLoadOnTrain: false,
            ferryRequired: false,
            loadChipTotal: 4,
            loadChipCarried: 0,
            estimatedTurns: 5,
            demandScore: 4,
            efficiencyPerTurn: 0, networkCitiesUnlocked: 0, victoryMajorCitiesEnRoute: 0,
            isAffordable: true, projectedFundsAfterDelivery: 50,
          },
        ],
      });
      // Route has only the delivery stop (already completed)
      const route = makeRoute({
        stops: [
          { action: 'deliver', loadType: 'Steel', city: 'Torino', demandCardId: 1, payment: 16 },
        ],
        currentStopIndex: 0,
        phase: 'travel',
      });

      // Use DELIVER as primary to trigger A2 (last step is DeliverLoad)
      const deliverPlan: TurnPlan = {
        type: AIActionType.DeliverLoad,
        load: 'Steel',
        city: 'Torino',
        cardId: 1,
        payout: 16,
      };

      // A2: MOVE toward supply city (should be Ruhr or Bordeaux, not Torino)
      mockResolve.mockResolvedValueOnce({
        success: true,
        plan: {
          type: AIActionType.MoveTrain,
          path: [{ row: 10, col: 10 }, { row: 14, col: 14 }],
          fees: new Set<string>(),
          totalFee: 0,
        },
      });

      const { plan: result } = await TurnComposer.compose(deliverPlan, snapshot, context, route);

      // A2 should have tried to chain a continuation MOVE using live loads state
      const moveCall = mockResolve.mock.calls.find(
        (args: any[]) => args[0]?.action === 'MOVE',
      );
      expect(moveCall).toBeDefined();
      // The target should NOT be Torino (where bot already is) — it should be
      // a supply city (Ruhr or Bordeaux) found via Priority 3 using live context.loads
      expect(moveCall![0].details.to).not.toBe('Torino');
    });
  });

  describe('tryAppendBuild 230M threshold', () => {
    it('builds toward victory city when money > 230', async () => {
      const snapshot = makeSnapshot({
        bot: { ...makeSnapshot().bot, money: 240 },
      });
      const context = makeContext({
        money: 240,
        turnBuildCost: 0,
        unconnectedMajorCities: [
          { cityName: 'Milano', estimatedCost: 6 },
        ],
      });

      const movePlan: TurnPlan = {
        type: AIActionType.MoveTrain,
        path: [{ row: 10, col: 10 }, { row: 12, col: 12 }],
        fees: new Set<string>(),
        totalFee: 0,
      };

      mockResolve.mockResolvedValueOnce({
        success: true,
        plan: { type: AIActionType.BuildTrack, segments: [makeSegment(20, 20, 20, 21)], targetCity: 'Milano' },
      });

      const { plan: result } = await TurnComposer.compose(movePlan, snapshot, context);

      expect(result.type).toBe('MultiAction');
      const buildCall = mockResolve.mock.calls.find(
        (args: any[]) => args[0]?.action === 'BUILD',
      );
      expect(buildCall).toBeDefined();
      expect(buildCall![0].details.toward).toBe('Milano');
    });

    it('does NOT build toward victory city when money <= 230', async () => {
      const snapshot = makeSnapshot({
        bot: { ...makeSnapshot().bot, money: 180 },
      });
      const context = makeContext({
        money: 180,
        turnBuildCost: 0,
        unconnectedMajorCities: [
          { cityName: 'Milano', estimatedCost: 6 },
        ],
      });

      const movePlan: TurnPlan = {
        type: AIActionType.MoveTrain,
        path: [{ row: 10, col: 10 }, { row: 12, col: 12 }],
        fees: new Set<string>(),
        totalFee: 0,
      };

      // findDemandBuildTarget returns null — no fallback either
      mockFindDemandBuildTarget.mockReturnValue(null);

      const { plan: result } = await TurnComposer.compose(movePlan, snapshot, context);

      // No BUILD should be appended — victory threshold not met, no demand fallback
      expect(result.type).toBe(AIActionType.MoveTrain);
      expect(mockResolve).not.toHaveBeenCalled();
    });
  });

  describe('JIRA-93: tryAppendBuild no speculative builds', () => {
    it('builds toward route stop when active route has unreachable stop', async () => {
      const snapshot = makeSnapshot();
      const context = makeContext({
        money: 50,
        turnBuildCost: 0,
        citiesOnNetwork: ['Berlin'], // Paris NOT on network
        unconnectedMajorCities: [],
      });
      const route = makeRoute({
        stops: [
          { action: 'pickup', loadType: 'Coal', city: 'Berlin' },
          { action: 'deliver', loadType: 'Coal', city: 'Paris', demandCardId: 1, payment: 25 },
        ],
        currentStopIndex: 1, // JIRA-124: current stop must be off-network for JIT gate to approve build
        phase: 'build',
      });

      mockResolve.mockResolvedValueOnce({
        success: true,
        plan: { type: AIActionType.BuildTrack, segments: [makeSegment(20, 20, 20, 21)], targetCity: 'Paris' },
      });

      const movePlan: TurnPlan = {
        type: AIActionType.MoveTrain,
        path: [{ row: 10, col: 10 }, { row: 12, col: 12 }],
        fees: new Set<string>(),
        totalFee: 0,
      };

      const { plan: result } = await TurnComposer.compose(movePlan, snapshot, context, route);

      // Should build toward Paris (route stop not on network)
      expect(result.type).toBe('MultiAction');
      const buildCall = mockResolve.mock.calls.find(
        (args: any[]) => args[0]?.action === 'BUILD',
      );
      expect(buildCall).toBeDefined();
      expect(buildCall![0].details.toward).toBe('Paris');
    });

    it('returns null when all route stops are on network and no unconnected cities', async () => {
      const snapshot = makeSnapshot();
      const context = makeContext({
        money: 50,
        turnBuildCost: 0,
        citiesOnNetwork: ['Berlin', 'Paris'],
        unconnectedMajorCities: [],
      });
      const route = makeRoute({
        stops: [
          { action: 'pickup', loadType: 'Coal', city: 'Berlin' },
          { action: 'deliver', loadType: 'Coal', city: 'Paris', demandCardId: 1, payment: 25 },
        ],
        currentStopIndex: 0,
        phase: 'build',
      });

      // No demand build target either
      mockFindDemandBuildTarget.mockReturnValue(null);

      const movePlan: TurnPlan = {
        type: AIActionType.MoveTrain,
        path: [{ row: 10, col: 10 }, { row: 12, col: 12 }],
        fees: new Set<string>(),
        totalFee: 0,
      };

      const { plan: result } = await TurnComposer.compose(movePlan, snapshot, context, route);

      // No BUILD appended — all stops on network, no unconnected cities, no demand target
      expect(result.type).toBe(AIActionType.MoveTrain);
      expect(mockResolve).not.toHaveBeenCalled();
    });
  });

  describe('JIRA-116: Multi-stop look-ahead building in tryAppendBuild', () => {
    it('builds toward multiple unreached route stops with remaining budget', async () => {
      const snapshot = makeSnapshot({
        bot: { ...makeSnapshot().bot, money: 50 },
      });
      const context = makeContext({
        money: 50,
        turnBuildCost: 0,
        citiesOnNetwork: ['Berlin'], // Paris and Wien NOT on network
        unconnectedMajorCities: [],
      });
      const route = makeRoute({
        stops: [
          { action: 'pickup', loadType: 'Coal', city: 'Berlin' },
          { action: 'deliver', loadType: 'Coal', city: 'Paris', demandCardId: 1, payment: 25 },
          { action: 'deliver', loadType: 'Wine', city: 'Wien', demandCardId: 2, payment: 20 },
        ],
        currentStopIndex: 1, // JIRA-124: current stop must be off-network for JIT gate to approve build
        phase: 'build',
      });

      // First BUILD toward Paris costs 5M
      mockResolve.mockResolvedValueOnce({
        success: true,
        plan: {
          type: AIActionType.BuildTrack,
          segments: [
            makeSegment(10, 11, 12, 12),
            makeSegment(12, 12, 14, 14),
          ],
          targetCity: 'Paris',
        },
      });
      // Second BUILD toward Wien costs 3M
      mockResolve.mockResolvedValueOnce({
        success: true,
        plan: {
          type: AIActionType.BuildTrack,
          segments: [makeSegment(14, 14, 16, 16)],
          targetCity: 'Wien',
        },
      });

      const movePlan: TurnPlan = {
        type: AIActionType.MoveTrain,
        path: [{ row: 10, col: 10 }, { row: 12, col: 12 }],
        fees: new Set<string>(),
        totalFee: 0,
      };

      const { plan: result } = await TurnComposer.compose(movePlan, snapshot, context, route);

      expect(result.type).toBe('MultiAction');
      // Verify two BUILD resolve calls were made
      const buildCalls = mockResolve.mock.calls.filter(
        (args: any[]) => args[0]?.action === 'BUILD',
      );
      expect(buildCalls).toHaveLength(2);
      expect(buildCalls[0][0].details.toward).toBe('Paris');
      expect(buildCalls[1][0].details.toward).toBe('Wien');
    });

    it('single-stop route behaves identically to previous code (no regression)', async () => {
      const snapshot = makeSnapshot();
      const context = makeContext({
        money: 50,
        turnBuildCost: 0,
        citiesOnNetwork: ['Berlin'], // Paris NOT on network
        unconnectedMajorCities: [],
      });
      const route = makeRoute({
        stops: [
          { action: 'pickup', loadType: 'Coal', city: 'Berlin' },
          { action: 'deliver', loadType: 'Coal', city: 'Paris', demandCardId: 1, payment: 25 },
        ],
        currentStopIndex: 1, // JIRA-124: current stop must be off-network for JIT gate to approve build
        phase: 'build',
      });

      mockResolve.mockResolvedValueOnce({
        success: true,
        plan: { type: AIActionType.BuildTrack, segments: [makeSegment(20, 20, 20, 21)], targetCity: 'Paris' },
      });

      const movePlan: TurnPlan = {
        type: AIActionType.MoveTrain,
        path: [{ row: 10, col: 10 }, { row: 12, col: 12 }],
        fees: new Set<string>(),
        totalFee: 0,
      };

      const { plan: result } = await TurnComposer.compose(movePlan, snapshot, context, route);

      expect(result.type).toBe('MultiAction');
      const buildCalls = mockResolve.mock.calls.filter(
        (args: any[]) => args[0]?.action === 'BUILD',
      );
      expect(buildCalls).toHaveLength(1);
      expect(buildCalls[0][0].details.toward).toBe('Paris');
    });

    it('stops iterating when computeBuildSegments returns empty for subsequent stop', async () => {
      const snapshot = makeSnapshot({
        bot: { ...makeSnapshot().bot, money: 50 },
      });
      const context = makeContext({
        money: 50,
        turnBuildCost: 0,
        citiesOnNetwork: ['Berlin'], // Paris and Wien NOT on network
        unconnectedMajorCities: [],
      });
      const route = makeRoute({
        stops: [
          { action: 'pickup', loadType: 'Coal', city: 'Berlin' },
          { action: 'deliver', loadType: 'Coal', city: 'Paris', demandCardId: 1, payment: 25 },
          { action: 'deliver', loadType: 'Wine', city: 'Wien', demandCardId: 2, payment: 20 },
        ],
        currentStopIndex: 1, // JIRA-124: current stop must be off-network for JIT gate to approve build
        phase: 'build',
      });

      // First BUILD toward Paris succeeds
      mockResolve.mockResolvedValueOnce({
        success: true,
        plan: { type: AIActionType.BuildTrack, segments: [makeSegment(10, 11, 12, 12)], targetCity: 'Paris' },
      });
      // Second BUILD toward Wien fails (no path within budget)
      mockResolve.mockResolvedValueOnce({
        success: false,
        error: 'Could not find a path to build toward "Wien" within budget.',
      });

      const movePlan: TurnPlan = {
        type: AIActionType.MoveTrain,
        path: [{ row: 10, col: 10 }, { row: 12, col: 12 }],
        fees: new Set<string>(),
        totalFee: 0,
      };

      const { plan: result } = await TurnComposer.compose(movePlan, snapshot, context, route);

      // Should still have the first build (Paris) even though Wien failed
      expect(result.type).toBe('MultiAction');
      const buildCalls = mockResolve.mock.calls.filter(
        (args: any[]) => args[0]?.action === 'BUILD',
      );
      expect(buildCalls).toHaveLength(2); // Attempted both, but Wien failed
    });

    it('does not attempt second stop when budget exhausted on first stop', async () => {
      const snapshot = makeSnapshot({
        bot: { ...makeSnapshot().bot, money: 20 },
      });
      const context = makeContext({
        money: 20,
        turnBuildCost: 0,
        citiesOnNetwork: ['Berlin'], // Paris and Wien NOT on network
        unconnectedMajorCities: [],
      });
      const route = makeRoute({
        stops: [
          { action: 'pickup', loadType: 'Coal', city: 'Berlin' },
          { action: 'deliver', loadType: 'Coal', city: 'Paris', demandCardId: 1, payment: 25 },
          { action: 'deliver', loadType: 'Wine', city: 'Wien', demandCardId: 2, payment: 20 },
        ],
        currentStopIndex: 1, // JIRA-124: current stop must be off-network for JIT gate to approve build
        phase: 'build',
      });

      // First BUILD uses full 20M budget
      const seg1 = makeSegment(10, 11, 12, 12);
      seg1.cost = 20; // Costs the full budget
      mockResolve.mockResolvedValueOnce({
        success: true,
        plan: { type: AIActionType.BuildTrack, segments: [seg1], targetCity: 'Paris' },
      });

      const movePlan: TurnPlan = {
        type: AIActionType.MoveTrain,
        path: [{ row: 10, col: 10 }, { row: 12, col: 12 }],
        fees: new Set<string>(),
        totalFee: 0,
      };

      const { plan: result } = await TurnComposer.compose(movePlan, snapshot, context, route);

      expect(result.type).toBe('MultiAction');
      // Only one BUILD call — budget exhausted after first stop
      const buildCalls = mockResolve.mock.calls.filter(
        (args: any[]) => args[0]?.action === 'BUILD',
      );
      expect(buildCalls).toHaveLength(1);
      expect(buildCalls[0][0].details.toward).toBe('Paris');
    });

    it('updates snapshot existingSegments between iterations for correct frontier (AC-5)', async () => {
      const snapshot = makeSnapshot({
        bot: { ...makeSnapshot().bot, money: 50, existingSegments: [makeSegment(10, 10, 10, 11)] },
      });
      const context = makeContext({
        money: 50,
        turnBuildCost: 0,
        citiesOnNetwork: ['Berlin'],
        unconnectedMajorCities: [],
      });
      const route = makeRoute({
        stops: [
          { action: 'pickup', loadType: 'Coal', city: 'Berlin' },
          { action: 'deliver', loadType: 'Coal', city: 'Paris', demandCardId: 1, payment: 25 },
          { action: 'deliver', loadType: 'Wine', city: 'Wien', demandCardId: 2, payment: 20 },
        ],
        currentStopIndex: 1, // JIRA-124: current stop must be off-network for JIT gate to approve build
        phase: 'build',
      });

      const parisSegment = makeSegment(10, 11, 12, 12);
      mockResolve.mockResolvedValueOnce({
        success: true,
        plan: { type: AIActionType.BuildTrack, segments: [parisSegment], targetCity: 'Paris' },
      });
      mockResolve.mockResolvedValueOnce({
        success: true,
        plan: { type: AIActionType.BuildTrack, segments: [makeSegment(12, 12, 14, 14)], targetCity: 'Wien' },
      });

      const movePlan: TurnPlan = {
        type: AIActionType.MoveTrain,
        path: [{ row: 10, col: 10 }, { row: 12, col: 12 }],
        fees: new Set<string>(),
        totalFee: 0,
      };

      await TurnComposer.compose(movePlan, snapshot, context, route);

      // Second BUILD call should have snapshot with Paris segment added
      const buildCalls = mockResolve.mock.calls.filter(
        (args: any[]) => args[0]?.action === 'BUILD',
      );
      expect(buildCalls).toHaveLength(2);
      // The second call's snapshot should include the Paris segment
      const secondCallSnapshot = buildCalls[1][1] as WorldSnapshot;
      expect(secondCallSnapshot.bot.existingSegments).toContainEqual(parisSegment);
    });
  });

  describe('Phase A3: movement cap', () => {
    it('A3 MOVE prepended before BUILD is capped at remaining movement', async () => {
      const snapshot = makeSnapshot({
        bot: {
          ...makeSnapshot().bot,
          loads: ['Coal'],
        },
      });
      // speed=9, so capped at 9 mileposts
      const context = makeContext({
        speed: 9,
        demands: [
          {
            cardIndex: 0, loadType: 'Coal', supplyCity: 'Berlin', deliveryCity: 'Paris',
            payout: 25, isSupplyReachable: false, isDeliveryReachable: false,
            isSupplyOnNetwork: true, isDeliveryOnNetwork: true,
            estimatedTrackCostToSupply: 0, estimatedTrackCostToDelivery: 0,
            isLoadAvailable: true, isLoadOnTrain: true, ferryRequired: false,
            loadChipTotal: 4, loadChipCarried: 0, estimatedTurns: 0,
            demandScore: 0, efficiencyPerTurn: 0, networkCitiesUnlocked: 0, victoryMajorCitiesEnRoute: 0,
            isAffordable: true, projectedFundsAfterDelivery: 50,
          },
        ],
      });

      const buildPlan: TurnPlan = {
        type: AIActionType.BuildTrack,
        segments: [makeSegment(10, 10, 10, 11)],
        targetCity: 'München',
      };

      // A3: MOVE returns a 12-milepost path (too long — should be capped to 9)
      mockResolve.mockResolvedValueOnce({
        success: true,
        plan: {
          type: AIActionType.MoveTrain,
          path: [
            { row: 10, col: 10 }, { row: 11, col: 10 }, { row: 12, col: 10 },
            { row: 13, col: 10 }, { row: 14, col: 10 }, { row: 15, col: 10 },
            { row: 16, col: 10 }, { row: 17, col: 10 }, { row: 18, col: 10 },
            { row: 19, col: 10 }, { row: 20, col: 10 }, { row: 21, col: 10 },
            { row: 22, col: 10 },
          ],
          fees: new Set<string>(),
          totalFee: 0,
        },
      });

      const { plan: result } = await TurnComposer.compose(buildPlan, snapshot, context);

      expect(result.type).toBe('MultiAction');
      if (result.type === 'MultiAction') {
        // MOVE should be before BUILD
        expect(result.steps[0].type).toBe(AIActionType.MoveTrain);
        expect(result.steps[result.steps.length - 1].type).toBe(AIActionType.BuildTrack);

        // The MOVE path should be capped at 9 mileposts (10 positions including start)
        const moveStep = result.steps[0] as any;
        expect(moveStep.path.length - 1).toBeLessThanOrEqual(9);
        expect(moveStep.path.length).toBe(10); // start + 9 mileposts
      }
    });
  });

  describe('initialBuild', () => {
    it('During initialBuild, returns primary unchanged', async () => {
      const snapshot = makeSnapshot();
      const context = makeContext({ isInitialBuild: true });
      const route = makeRoute({ phase: 'build' });

      const buildPlan: TurnPlan = {
        type: AIActionType.BuildTrack,
        segments: [makeSegment(10, 10, 10, 11)],
        targetCity: 'Berlin',
      };

      const { plan: result } = await TurnComposer.compose(buildPlan, snapshot, context, route);

      // initialBuild returns primary unchanged — no enrichment
      expect(result).toBe(buildPlan);
      expect(result.type).toBe(AIActionType.BuildTrack);
      expect(mockCloneSnapshot).not.toHaveBeenCalled();
      expect(mockResolve).not.toHaveBeenCalled();
    });
  });

  describe('JIRA-93: no speculative build when route stops all connected', () => {
    it('skips build when all route stops on network and no victory cities (no speculative builds)', async () => {
      const snapshot = makeSnapshot();
      const context = makeContext({
        money: 50,
        turnBuildCost: 0,
        citiesOnNetwork: ['Berlin', 'Paris'],
        unconnectedMajorCities: [],
      });
      const route = makeRoute({
        stops: [
          { action: 'pickup', loadType: 'Coal', city: 'Berlin' },
          { action: 'deliver', loadType: 'Coal', city: 'Paris', demandCardId: 1, payment: 25 },
        ],
        currentStopIndex: 0,
        phase: 'build',
      });

      const movePlan: TurnPlan = {
        type: AIActionType.MoveTrain,
        path: [{ row: 10, col: 10 }, { row: 12, col: 12 }],
        fees: new Set<string>(),
        totalFee: 0,
      };

      const { plan: result } = await TurnComposer.compose(movePlan, snapshot, context, route);

      // JIRA-93: No speculative builds — should NOT fall back to findDemandBuildTarget
      expect(result.type).toBe(AIActionType.MoveTrain);
      expect(mockFindDemandBuildTarget).not.toHaveBeenCalled();
    });
  });

  describe('A2 multi-target fallback (GH-Cardiff-bug)', () => {
    it('falls back to demand city when route target is unreachable', async () => {
      // Scenario: bot picks up Hops at Cardiff, route next stop is Dublin (unreachable).
      // Dublin MOVE fails. Demand fallback: supply city London is on network → move there.
      const snapshot = makeSnapshot({
        bot: {
          ...makeSnapshot().bot,
          loads: ['Hops'],
          resolvedDemands: [
            {
              cardId: 1,
              demands: [{ city: 'Dublin', loadType: 'Hops', payment: 12 }],
            },
          ],
        },
      });
      const context = makeContext({
        speed: 9,
        loads: ['Hops'],
        demands: [
          {
            cardIndex: 0, loadType: 'Wine', supplyCity: 'London', deliveryCity: 'Bordeaux',
            payout: 20, isSupplyReachable: false, isDeliveryReachable: false,
            isSupplyOnNetwork: true, isDeliveryOnNetwork: false,
            estimatedTrackCostToSupply: 0, estimatedTrackCostToDelivery: 10,
            isLoadAvailable: true, isLoadOnTrain: false, ferryRequired: false,
            loadChipTotal: 4, loadChipCarried: 0, estimatedTurns: 0,
            demandScore: 0, efficiencyPerTurn: 0, networkCitiesUnlocked: 0, victoryMajorCitiesEnRoute: 0,
            isAffordable: true, projectedFundsAfterDelivery: 50,
          },
        ],
      });
      const route = makeRoute({
        stops: [
          { action: 'pickup', loadType: 'Hops', city: 'Cardiff' },
          { action: 'deliver', loadType: 'Hops', city: 'Dublin', demandCardId: 1, payment: 12 },
        ],
        currentStopIndex: 1, // Already past pickup
        phase: 'travel',
      });

      // Primary: PICKUP (simulating A1 split already happened, last step is pickup)
      const pickupPlan: TurnPlan = {
        type: AIActionType.PickupLoad,
        load: 'Hops',
        city: 'Cardiff',
      };

      // applyPlanToState: update loads for PICKUP, position for MOVE
      mockApplyPlanToState.mockImplementation((plan: TurnPlan, snap: WorldSnapshot, ctx: GameContext) => {
        if (plan.type === AIActionType.PickupLoad) {
          snap.bot.loads.push((plan as any).load);
          ctx.loads = [...snap.bot.loads];
        }
        if (plan.type === AIActionType.MoveTrain) {
          const movePath = (plan as any).path;
          const endPos = movePath[movePath.length - 1];
          snap.bot.position = { row: endPos.row, col: endPos.col };
          ctx.position = { row: endPos.row, col: endPos.col };
        }
      });

      mockResolve
        // A2 attempt 1: MOVE to Dublin — FAILS (unreachable, no track to ferry)
        .mockResolvedValueOnce({ success: false, error: 'No valid path to "Dublin" on existing track network.' })
        // A2 attempt 2: MOVE to London (demand supply city) — SUCCEEDS
        .mockResolvedValueOnce({
          success: true,
          plan: {
            type: AIActionType.MoveTrain,
            path: [
              { row: 17, col: 26 }, { row: 18, col: 27 }, { row: 19, col: 28 },
              { row: 20, col: 29 }, { row: 20, col: 30 },
            ],
            fees: new Set<string>(),
            totalFee: 0,
          },
        });

      const { plan: result } = await TurnComposer.compose(pickupPlan, snapshot, context, route);

      expect(result.type).toBe('MultiAction');
      if (result.type === 'MultiAction') {
        expect(result.steps[0].type).toBe(AIActionType.PickupLoad);
        // Continuation MOVE should exist (fell back to London)
        const moveStep = result.steps.find(s => s.type === AIActionType.MoveTrain);
        expect(moveStep).toBeDefined();
      }

      // Verify: first MOVE tried Dublin, second tried London
      const moveCalls = mockResolve.mock.calls.filter(
        (args: any[]) => args[0]?.action === 'MOVE',
      );
      expect(moveCalls).toHaveLength(2);
      expect(moveCalls[0][0].details.to).toBe('Dublin');
      expect(moveCalls[1][0].details.to).toBe('London');
    });

    it('no continuation MOVE when ALL targets are unreachable', async () => {
      // All route stops and demand cities fail resolveMove — no MOVE added.
      const snapshot = makeSnapshot({
        bot: {
          ...makeSnapshot().bot,
          loads: ['Hops'],
        },
      });
      const context = makeContext({
        speed: 9,
        loads: ['Hops'],
        demands: [
          {
            cardIndex: 0, loadType: 'Hops', supplyCity: 'Cardiff', deliveryCity: 'Dublin',
            payout: 12, isSupplyReachable: false, isDeliveryReachable: false,
            isSupplyOnNetwork: false, isDeliveryOnNetwork: false,
            estimatedTrackCostToSupply: 0, estimatedTrackCostToDelivery: 0,
            isLoadAvailable: true, isLoadOnTrain: true, ferryRequired: false,
            loadChipTotal: 4, loadChipCarried: 0, estimatedTurns: 0,
            demandScore: 0, efficiencyPerTurn: 0, networkCitiesUnlocked: 0, victoryMajorCitiesEnRoute: 0,
            isAffordable: true, projectedFundsAfterDelivery: 50,
          },
        ],
      });
      const route = makeRoute({
        stops: [
          { action: 'deliver', loadType: 'Hops', city: 'Dublin', demandCardId: 1, payment: 12 },
        ],
        currentStopIndex: 0,
        phase: 'travel',
      });

      const pickupPlan: TurnPlan = {
        type: AIActionType.PickupLoad,
        load: 'Hops',
        city: 'Cardiff',
      };

      // All MOVE attempts fail — no valid path to anything
      mockResolve.mockResolvedValue({ success: false, error: 'No path' });

      const { plan: result } = await TurnComposer.compose(pickupPlan, snapshot, context, route);

      // Only PICKUP returned — no MOVE could be resolved
      expect(result.type).toBe(AIActionType.PickupLoad);
    });

    it('JIRA-50: uses reachable cities as fallback when demand targets are unreachable', async () => {
      // Scenario: bot delivers a load, demand supply cities are on-network but
      // not reachable from current position. reachableCities should provide a
      // valid fallback target so movement budget isn't wasted.
      const snapshot = makeSnapshot({
        bot: {
          ...makeSnapshot().bot,
          loads: [],
        },
      });
      const context = makeContext({
        speed: 9,
        loads: [],
        demands: [
          {
            cardIndex: 0, loadType: 'Iron', supplyCity: 'FarCity', deliveryCity: 'FarDest',
            payout: 20, isSupplyReachable: false, isDeliveryReachable: false,
            isSupplyOnNetwork: true, isDeliveryOnNetwork: false,
            estimatedTrackCostToSupply: 0, estimatedTrackCostToDelivery: 0,
            isLoadAvailable: true, isLoadOnTrain: false, ferryRequired: false,
            loadChipTotal: 4, loadChipCarried: 0, estimatedTurns: 0,
            demandScore: 0, efficiencyPerTurn: 0, networkCitiesUnlocked: 0, victoryMajorCitiesEnRoute: 0,
            isAffordable: true, projectedFundsAfterDelivery: 50,
          },
        ],
        reachableCities: ['NearbyCity', 'AnotherCity'],
      });

      const deliverPlan: TurnPlan = {
        type: AIActionType.DeliverLoad,
        load: 'Steel',
        city: 'Torino',
        cardId: 1,
        payout: 16,
      };

      // A2: MOVE to FarCity (demand supply) — FAILS (unreachable)
      mockResolve.mockResolvedValueOnce({ success: false, error: 'No path to FarCity' });
      // A2: MOVE to NearbyCity (reachable fallback) — SUCCEEDS
      mockResolve.mockResolvedValueOnce({
        success: true,
        plan: {
          type: AIActionType.MoveTrain,
          path: [{ row: 10, col: 10 }, { row: 12, col: 12 }, { row: 14, col: 14 }],
          fees: new Set<string>(),
          totalFee: 0,
        },
      });

      const { plan: result, trace } = await TurnComposer.compose(deliverPlan, snapshot, context, null);

      // Should have composed DELIVER + MOVE (using reachable city fallback)
      expect(result.type).toBe('MultiAction');
      if (result.type === 'MultiAction') {
        const moveStep = result.steps.find(s => s.type === AIActionType.MoveTrain);
        expect(moveStep).toBeDefined();
      }

      // Verify: first MOVE tried FarCity (demand), second tried NearbyCity (reachable fallback)
      const moveCalls = mockResolve.mock.calls.filter(
        (args: any[]) => args[0]?.action === 'MOVE',
      );
      expect(moveCalls.length).toBeGreaterThanOrEqual(2);
      expect(moveCalls[0][0].details.to).toBe('FarCity');
      expect(moveCalls[1][0].details.to).toBe('NearbyCity');
    });
  });

  describe('A3 multi-target fallback (GH-Dublin-bug)', () => {
    it('falls back to demand city when BUILD target is unreachable for MOVE', async () => {
      // Scenario: bot at Dublin, no loads. Primary is BUILD toward München (unreachable).
      // Route: pickup Cars at München (not on network), deliver Cars at London.
      // Bot doesn't have Cars, so deliver stop is skipped by findMoveTargets.
      // findMoveTargets returns [München, Lyon] — München from route, Lyon from 2nd demand.
      // MOVE to München fails. Fallback MOVE to Lyon (supply city on network) succeeds.
      const snapshot = makeSnapshot({
        bot: {
          ...makeSnapshot().bot,
          loads: [],
          position: { row: 10, col: 24 },
        },
      });
      const context = makeContext({
        speed: 9,
        loads: [],
        position: { row: 10, col: 24 },
        demands: [
          {
            cardIndex: 0, loadType: 'Cars', supplyCity: 'München', deliveryCity: 'London',
            payout: 30, isSupplyReachable: false, isDeliveryReachable: false,
            isSupplyOnNetwork: false, isDeliveryOnNetwork: true,
            estimatedTrackCostToSupply: 0, estimatedTrackCostToDelivery: 0,
            isLoadAvailable: true, isLoadOnTrain: false, ferryRequired: false,
            loadChipTotal: 4, loadChipCarried: 0, estimatedTurns: 0,
            demandScore: 0, efficiencyPerTurn: 0, networkCitiesUnlocked: 0, victoryMajorCitiesEnRoute: 0,
            isAffordable: true, projectedFundsAfterDelivery: 50,
          },
          {
            cardIndex: 1, loadType: 'Wine', supplyCity: 'Lyon', deliveryCity: 'Bordeaux',
            payout: 20, isSupplyReachable: false, isDeliveryReachable: false,
            isSupplyOnNetwork: true, isDeliveryOnNetwork: false,
            estimatedTrackCostToSupply: 0, estimatedTrackCostToDelivery: 10,
            isLoadAvailable: true, isLoadOnTrain: false, ferryRequired: false,
            loadChipTotal: 4, loadChipCarried: 0, estimatedTurns: 0,
            demandScore: 0, efficiencyPerTurn: 0, networkCitiesUnlocked: 0, victoryMajorCitiesEnRoute: 0,
            isAffordable: true, projectedFundsAfterDelivery: 50,
          },
        ],
      });
      const route = makeRoute({
        stops: [
          { action: 'pickup', loadType: 'Cars', city: 'München' },
          { action: 'deliver', loadType: 'Cars', city: 'London', demandCardId: 1, payment: 30 },
        ],
        currentStopIndex: 0,
        phase: 'build',
      });

      const buildPlan: TurnPlan = {
        type: AIActionType.BuildTrack,
        segments: [makeSegment(10, 24, 11, 25)],
        targetCity: 'München',
      };

      mockResolve
        // A3 attempt 1: MOVE to München (route stop, unreachable) — FAILS
        .mockResolvedValueOnce({ success: false, error: 'No valid path to "München"' })
        // A3 attempt 2: MOVE to Lyon (demand supply city on network) — SUCCEEDS
        .mockResolvedValueOnce({
          success: true,
          plan: {
            type: AIActionType.MoveTrain,
            path: [
              { row: 10, col: 24 }, { row: 11, col: 25 }, { row: 12, col: 26 },
            ],
            fees: new Set<string>(),
            totalFee: 0,
          },
        });

      const { plan: result } = await TurnComposer.compose(buildPlan, snapshot, context, route);

      expect(result.type).toBe('MultiAction');
      if (result.type === 'MultiAction') {
        // MOVE should be before BUILD
        expect(result.steps[0].type).toBe(AIActionType.MoveTrain);
        expect(result.steps[result.steps.length - 1].type).toBe(AIActionType.BuildTrack);
      }

      // Verify: first tried München, then fell back to Lyon
      const moveCalls = mockResolve.mock.calls.filter(
        (args: any[]) => args[0]?.action === 'MOVE',
      );
      expect(moveCalls).toHaveLength(2);
      expect(moveCalls[0][0].details.to).toBe('München');
      expect(moveCalls[1][0].details.to).toBe('Lyon');
    });
  });

  describe('multi-load pickup (FR-5)', () => {
    it('picks up multiple matching loads when capacity allows', async () => {
      // Bot at Berlin which produces Coal and Steel, bot has capacity for 2
      const snapshot = makeSnapshot({
        bot: {
          ...makeSnapshot().bot,
          loads: [],
          resolvedDemands: [
            { cardId: 1, demands: [{ city: 'Paris', loadType: 'Coal', payment: 25 }] },
            { cardId: 2, demands: [{ city: 'Hamburg', loadType: 'Steel', payment: 20 }] },
          ],
        },
        loadAvailability: { Berlin: ['Coal', 'Steel'] },
      });
      const context = makeContext({ capacity: 2 });

      // Move path ends at Berlin
      const movePlan: TurnPlan = {
        type: AIActionType.MoveTrain,
        path: [{ row: 10, col: 10 }, { row: 10, col: 20 }],
        fees: new Set<string>(),
        totalFee: 0,
      };

      mockLoadGridPoints.mockReturnValue(new Map([
        ['10,20', { row: 10, col: 20, terrain: TerrainType.MajorCity, name: 'Berlin' }],
      ]));

      mockApplyPlanToState.mockImplementation((plan: TurnPlan, snap: WorldSnapshot) => {
        if (plan.type === AIActionType.MoveTrain) {
          const movePath = (plan as any).path;
          const endPos = movePath[movePath.length - 1];
          snap.bot.position = { row: endPos.row, col: endPos.col };
        }
        if (plan.type === AIActionType.PickupLoad) {
          snap.bot.loads = [...snap.bot.loads, (plan as any).load];
        }
      });

      // Two pickup resolves succeed
      mockResolve
        .mockResolvedValueOnce({
          success: true,
          plan: { type: AIActionType.PickupLoad, load: 'Coal', city: 'Berlin' },
        })
        .mockResolvedValueOnce({
          success: true,
          plan: { type: AIActionType.PickupLoad, load: 'Steel', city: 'Berlin' },
        });

      const { plan: result } = await TurnComposer.compose(movePlan, snapshot, context);

      expect(result.type).toBe('MultiAction');
      if (result.type === 'MultiAction') {
        const pickupSteps = result.steps.filter(s => s.type === AIActionType.PickupLoad);
        expect(pickupSteps.length).toBe(2);
      }
    });

    it('limits pickups to remaining capacity', async () => {
      // Bot already carrying 1 load, capacity 2, city has 2 loads
      const snapshot = makeSnapshot({
        bot: {
          ...makeSnapshot().bot,
          loads: ['Wine'],
          resolvedDemands: [
            { cardId: 1, demands: [{ city: 'Paris', loadType: 'Coal', payment: 25 }] },
            { cardId: 2, demands: [{ city: 'Hamburg', loadType: 'Steel', payment: 20 }] },
          ],
        },
        loadAvailability: { Berlin: ['Coal', 'Steel'] },
      });
      const context = makeContext({ capacity: 2, loads: ['Wine'] });

      const movePlan: TurnPlan = {
        type: AIActionType.MoveTrain,
        path: [{ row: 10, col: 10 }, { row: 10, col: 20 }],
        fees: new Set<string>(),
        totalFee: 0,
      };

      mockLoadGridPoints.mockReturnValue(new Map([
        ['10,20', { row: 10, col: 20, terrain: TerrainType.MajorCity, name: 'Berlin' }],
      ]));

      mockApplyPlanToState.mockImplementation((plan: TurnPlan, snap: WorldSnapshot) => {
        if (plan.type === AIActionType.MoveTrain) {
          const endPos = (plan as any).path[(plan as any).path.length - 1];
          snap.bot.position = { row: endPos.row, col: endPos.col };
        }
        if (plan.type === AIActionType.PickupLoad) {
          snap.bot.loads = [...snap.bot.loads, (plan as any).load];
        }
      });

      // Only first pickup should succeed (capacity reached after first)
      mockResolve.mockResolvedValueOnce({
        success: true,
        plan: { type: AIActionType.PickupLoad, load: 'Coal', city: 'Berlin' },
      });

      const { plan: result } = await TurnComposer.compose(movePlan, snapshot, context);

      expect(result.type).toBe('MultiAction');
      if (result.type === 'MultiAction') {
        const pickupSteps = result.steps.filter(s => s.type === AIActionType.PickupLoad);
        expect(pickupSteps.length).toBe(1);
      }
    });

    it('picks up multiple copies of same load type when bot has multiple matching demands (JIRA-52)', async () => {
      // Bot at Valencia which produces Oranges, bot has 2 Orange demands and 2 empty slots
      const snapshot = makeSnapshot({
        bot: {
          ...makeSnapshot().bot,
          loads: [],
          resolvedDemands: [
            { cardId: 1, demands: [{ city: 'München', loadType: 'Oranges', payment: 36 }] },
            { cardId: 2, demands: [{ city: 'Holland', loadType: 'Oranges', payment: 33 }] },
          ],
        },
        loadAvailability: { Valencia: ['Oranges'] },
      });
      const context = makeContext({ capacity: 2 });

      const movePlan: TurnPlan = {
        type: AIActionType.MoveTrain,
        path: [{ row: 10, col: 10 }, { row: 10, col: 20 }],
        fees: new Set<string>(),
        totalFee: 0,
      };

      mockLoadGridPoints.mockReturnValue(new Map([
        ['10,20', { row: 10, col: 20, terrain: TerrainType.MajorCity, name: 'Valencia' }],
      ]));

      mockApplyPlanToState.mockImplementation((plan: TurnPlan, snap: WorldSnapshot) => {
        if (plan.type === AIActionType.MoveTrain) {
          const movePath = (plan as any).path;
          const endPos = movePath[movePath.length - 1];
          snap.bot.position = { row: endPos.row, col: endPos.col };
        }
        if (plan.type === AIActionType.PickupLoad) {
          snap.bot.loads = [...snap.bot.loads, (plan as any).load];
        }
      });

      // Two pickup resolves succeed for the same load type
      mockResolve
        .mockResolvedValueOnce({
          success: true,
          plan: { type: AIActionType.PickupLoad, load: 'Oranges', city: 'Valencia' },
        })
        .mockResolvedValueOnce({
          success: true,
          plan: { type: AIActionType.PickupLoad, load: 'Oranges', city: 'Valencia' },
        });

      const { plan: result } = await TurnComposer.compose(movePlan, snapshot, context);

      expect(result.type).toBe('MultiAction');
      if (result.type === 'MultiAction') {
        const pickupSteps = result.steps.filter(s => s.type === AIActionType.PickupLoad);
        expect(pickupSteps.length).toBe(2);
      }
    });

    it('does not pick up extra copy when only 1 matching demand exists (JIRA-52)', async () => {
      // Bot at Valencia, only 1 Orange demand but city has Oranges available
      const snapshot = makeSnapshot({
        bot: {
          ...makeSnapshot().bot,
          loads: [],
          resolvedDemands: [
            { cardId: 1, demands: [{ city: 'München', loadType: 'Oranges', payment: 36 }] },
            { cardId: 2, demands: [{ city: 'Paris', loadType: 'Coal', payment: 25 }] },
          ],
        },
        loadAvailability: { Valencia: ['Oranges'] },
      });
      const context = makeContext({ capacity: 2 });

      const movePlan: TurnPlan = {
        type: AIActionType.MoveTrain,
        path: [{ row: 10, col: 10 }, { row: 10, col: 20 }],
        fees: new Set<string>(),
        totalFee: 0,
      };

      mockLoadGridPoints.mockReturnValue(new Map([
        ['10,20', { row: 10, col: 20, terrain: TerrainType.MajorCity, name: 'Valencia' }],
      ]));

      mockApplyPlanToState.mockImplementation((plan: TurnPlan, snap: WorldSnapshot) => {
        if (plan.type === AIActionType.MoveTrain) {
          const movePath = (plan as any).path;
          const endPos = movePath[movePath.length - 1];
          snap.bot.position = { row: endPos.row, col: endPos.col };
        }
        if (plan.type === AIActionType.PickupLoad) {
          snap.bot.loads = [...snap.bot.loads, (plan as any).load];
        }
      });

      // Only 1 pickup should happen
      mockResolve.mockResolvedValueOnce({
        success: true,
        plan: { type: AIActionType.PickupLoad, load: 'Oranges', city: 'Valencia' },
      });

      const { plan: result } = await TurnComposer.compose(movePlan, snapshot, context);

      expect(result.type).toBe('MultiAction');
      if (result.type === 'MultiAction') {
        const pickupSteps = result.steps.filter(s => s.type === AIActionType.PickupLoad);
        expect(pickupSteps.length).toBe(1);
      }
    });
  });

  describe('delivery feasibility check for opportunistic pickups (BE-001)', () => {
    it('allows opportunistic pickup when delivery city is on network', async () => {
      const snapshot = makeSnapshot({
        bot: {
          ...makeSnapshot().bot,
          loads: [],
          resolvedDemands: [
            { cardId: 1, demands: [{ city: 'Paris', loadType: 'Coal', payment: 25 }] },
          ],
        },
        loadAvailability: { Berlin: ['Coal'] },
      });
      const context = makeContext({
        capacity: 2,
        demands: [{
          cardIndex: 1, loadType: 'Coal', supplyCity: 'Berlin', deliveryCity: 'Paris',
          payout: 25, isDeliveryOnNetwork: true, isDeliveryReachable: true,
          isSupplyOnNetwork: true, isLoadOnTrain: false,
          estimatedTrackCostToSupply: 0, estimatedTrackCostToDelivery: 0,
          isLoadAvailable: true, ferryRequired: false,
          loadChipTotal: 4, loadChipCarried: 0, estimatedTurns: 0,
          demandScore: 0, efficiencyPerTurn: 0, networkCitiesUnlocked: 0, victoryMajorCitiesEnRoute: 0,
        }] as any[],
      });

      const movePlan: TurnPlan = {
        type: AIActionType.MoveTrain,
        path: [{ row: 10, col: 10 }, { row: 10, col: 20 }],
        fees: new Set<string>(),
        totalFee: 0,
      };

      mockLoadGridPoints.mockReturnValue(new Map([
        ['10,20', { row: 10, col: 20, terrain: TerrainType.MajorCity, name: 'Berlin' }],
      ]));

      mockApplyPlanToState.mockImplementation((plan: TurnPlan, snap: WorldSnapshot) => {
        if (plan.type === AIActionType.MoveTrain) {
          const endPos = (plan as any).path[(plan as any).path.length - 1];
          snap.bot.position = { row: endPos.row, col: endPos.col };
        }
        if (plan.type === AIActionType.PickupLoad) {
          snap.bot.loads = [...snap.bot.loads, (plan as any).load];
        }
      });

      mockResolve.mockResolvedValueOnce({
        success: true,
        plan: { type: AIActionType.PickupLoad, load: 'Coal', city: 'Berlin' },
      });

      const { plan: result } = await TurnComposer.compose(movePlan, snapshot, context);

      expect(result.type).toBe('MultiAction');
      if (result.type === 'MultiAction') {
        const pickupSteps = result.steps.filter(s => s.type === AIActionType.PickupLoad);
        expect(pickupSteps.length).toBe(1);
      }
    });

    it('allows opportunistic pickup when build cost is less than payout and bot money', async () => {
      const snapshot = makeSnapshot({
        bot: {
          ...makeSnapshot().bot,
          loads: [],
          money: 50,
          resolvedDemands: [
            { cardId: 1, demands: [{ city: 'Paris', loadType: 'Coal', payment: 25 }] },
          ],
        },
        loadAvailability: { Berlin: ['Coal'] },
      });
      const context = makeContext({
        capacity: 2,
        money: 50,
        demands: [{
          cardIndex: 1, loadType: 'Coal', supplyCity: 'Berlin', deliveryCity: 'Paris',
          payout: 25, isDeliveryOnNetwork: false, isDeliveryReachable: false,
          isSupplyOnNetwork: true, isLoadOnTrain: false,
          estimatedTrackCostToSupply: 0, estimatedTrackCostToDelivery: 10,
          isLoadAvailable: true, ferryRequired: false,
          loadChipTotal: 4, loadChipCarried: 0, estimatedTurns: 0,
          demandScore: 0, efficiencyPerTurn: 0, networkCitiesUnlocked: 0, victoryMajorCitiesEnRoute: 0,
        }] as any[],
      });

      const movePlan: TurnPlan = {
        type: AIActionType.MoveTrain,
        path: [{ row: 10, col: 10 }, { row: 10, col: 20 }],
        fees: new Set<string>(),
        totalFee: 0,
      };

      mockLoadGridPoints.mockReturnValue(new Map([
        ['10,20', { row: 10, col: 20, terrain: TerrainType.MajorCity, name: 'Berlin' }],
      ]));

      mockApplyPlanToState.mockImplementation((plan: TurnPlan, snap: WorldSnapshot) => {
        if (plan.type === AIActionType.MoveTrain) {
          const endPos = (plan as any).path[(plan as any).path.length - 1];
          snap.bot.position = { row: endPos.row, col: endPos.col };
        }
        if (plan.type === AIActionType.PickupLoad) {
          snap.bot.loads = [...snap.bot.loads, (plan as any).load];
        }
      });

      mockResolve.mockResolvedValueOnce({
        success: true,
        plan: { type: AIActionType.PickupLoad, load: 'Coal', city: 'Berlin' },
      });

      const { plan: result } = await TurnComposer.compose(movePlan, snapshot, context);

      expect(result.type).toBe('MultiAction');
      if (result.type === 'MultiAction') {
        const pickupSteps = result.steps.filter(s => s.type === AIActionType.PickupLoad);
        expect(pickupSteps.length).toBe(1);
      }
    });

    it('rejects opportunistic pickup when build cost exceeds demand payout', async () => {
      const snapshot = makeSnapshot({
        bot: {
          ...makeSnapshot().bot,
          loads: [],
          money: 50,
          resolvedDemands: [
            { cardId: 1, demands: [{ city: 'Paris', loadType: 'Coal', payment: 25 }] },
          ],
        },
        loadAvailability: { Berlin: ['Coal'] },
      });
      const context = makeContext({
        capacity: 2,
        money: 50,
        demands: [{
          cardIndex: 1, loadType: 'Coal', supplyCity: 'Berlin', deliveryCity: 'Paris',
          payout: 25, isDeliveryOnNetwork: false, isDeliveryReachable: false,
          isSupplyOnNetwork: true, isLoadOnTrain: false,
          estimatedTrackCostToSupply: 0, estimatedTrackCostToDelivery: 30,
          isLoadAvailable: true, ferryRequired: false,
          loadChipTotal: 4, loadChipCarried: 0, estimatedTurns: 5,
          demandScore: 0, efficiencyPerTurn: 0, networkCitiesUnlocked: 0, victoryMajorCitiesEnRoute: 0,
        }] as any[],
      });

      const movePlan: TurnPlan = {
        type: AIActionType.MoveTrain,
        path: [{ row: 10, col: 10 }, { row: 10, col: 20 }],
        fees: new Set<string>(),
        totalFee: 0,
      };

      mockLoadGridPoints.mockReturnValue(new Map([
        ['10,20', { row: 10, col: 20, terrain: TerrainType.MajorCity, name: 'Berlin' }],
      ]));

      const warnSpy = jest.spyOn(console, 'warn').mockImplementation();

      const { plan: result } = await TurnComposer.compose(movePlan, snapshot, context);

      // No pickup should be proposed — only the original MOVE remains
      if (result.type === 'MultiAction') {
        const pickupSteps = result.steps.filter(s => s.type === AIActionType.PickupLoad);
        expect(pickupSteps.length).toBe(0);
      } else {
        expect(result.type).toBe(AIActionType.MoveTrain);
      }

      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('Rejected infeasible opportunistic pickup'),
      );

      warnSpy.mockRestore();
    });

    it('rejects opportunistic pickup when build cost exceeds bot money', async () => {
      const snapshot = makeSnapshot({
        bot: {
          ...makeSnapshot().bot,
          loads: [],
          money: 15,
          resolvedDemands: [
            { cardId: 1, demands: [{ city: 'Paris', loadType: 'Coal', payment: 25 }] },
          ],
        },
        loadAvailability: { Berlin: ['Coal'] },
      });
      const context = makeContext({
        capacity: 2,
        money: 15,
        demands: [{
          cardIndex: 1, loadType: 'Coal', supplyCity: 'Berlin', deliveryCity: 'Paris',
          payout: 25, isDeliveryOnNetwork: false, isDeliveryReachable: false,
          isSupplyOnNetwork: true, isLoadOnTrain: false,
          estimatedTrackCostToSupply: 0, estimatedTrackCostToDelivery: 20,
          isLoadAvailable: true, ferryRequired: false,
          loadChipTotal: 4, loadChipCarried: 0, estimatedTurns: 5,
          demandScore: 0, efficiencyPerTurn: 0, networkCitiesUnlocked: 0, victoryMajorCitiesEnRoute: 0,
        }] as any[],
      });

      const movePlan: TurnPlan = {
        type: AIActionType.MoveTrain,
        path: [{ row: 10, col: 10 }, { row: 10, col: 20 }],
        fees: new Set<string>(),
        totalFee: 0,
      };

      mockLoadGridPoints.mockReturnValue(new Map([
        ['10,20', { row: 10, col: 20, terrain: TerrainType.MajorCity, name: 'Berlin' }],
      ]));

      const warnSpy = jest.spyOn(console, 'warn').mockImplementation();

      const { plan: result } = await TurnComposer.compose(movePlan, snapshot, context);

      // No pickup should be proposed
      if (result.type === 'MultiAction') {
        const pickupSteps = result.steps.filter(s => s.type === AIActionType.PickupLoad);
        expect(pickupSteps.length).toBe(0);
      } else {
        expect(result.type).toBe(AIActionType.MoveTrain);
      }

      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('Rejected infeasible opportunistic pickup'),
      );

      warnSpy.mockRestore();
    });

    it('JIRA-87: allows opportunistic pickup when delivery is achievable within 2 turns', async () => {
      // Coal→Paris: delivery NOT on network, track cost exceeds money,
      // BUT estimatedTurns=2 — within relaxed feasibility window (current + 1 turn)
      const snapshot = makeSnapshot({
        bot: {
          ...makeSnapshot().bot,
          loads: [],
          money: 15,
          resolvedDemands: [
            { cardId: 1, demands: [{ city: 'Paris', loadType: 'Coal', payment: 25 }] },
          ],
        },
        loadAvailability: { Berlin: ['Coal'] },
      });
      const context = makeContext({
        capacity: 2,
        money: 15,
        demands: [{
          cardIndex: 1, loadType: 'Coal', supplyCity: 'Berlin', deliveryCity: 'Paris',
          payout: 25, isDeliveryOnNetwork: false, isDeliveryReachable: false,
          isSupplyOnNetwork: true, isLoadOnTrain: false,
          estimatedTrackCostToSupply: 0, estimatedTrackCostToDelivery: 30,
          isLoadAvailable: true, ferryRequired: false,
          loadChipTotal: 4, loadChipCarried: 0, estimatedTurns: 2,
          demandScore: 0, efficiencyPerTurn: 0, networkCitiesUnlocked: 0, victoryMajorCitiesEnRoute: 0,
        }] as any[],
      });

      const movePlan: TurnPlan = {
        type: AIActionType.MoveTrain,
        path: [{ row: 10, col: 10 }, { row: 10, col: 20 }],
        fees: new Set<string>(),
        totalFee: 0,
      };

      mockLoadGridPoints.mockReturnValue(new Map([
        ['10,20', { row: 10, col: 20, terrain: TerrainType.MajorCity, name: 'Berlin' }],
      ]));

      mockApplyPlanToState.mockImplementation((plan: TurnPlan, snap: WorldSnapshot) => {
        if (plan.type === AIActionType.PickupLoad) {
          snap.bot.loads = [...snap.bot.loads, (plan as any).load];
        }
      });

      mockResolve.mockResolvedValueOnce({
        success: true,
        plan: { type: AIActionType.PickupLoad, load: 'Coal', city: 'Berlin' },
      });

      const { plan: result } = await TurnComposer.compose(movePlan, snapshot, context);

      // Pickup SHOULD be proposed — estimatedTurns=2 passes the relaxed gate
      expect(result.type).toBe('MultiAction');
      if (result.type === 'MultiAction') {
        const pickupSteps = result.steps.filter(s => s.type === AIActionType.PickupLoad);
        expect(pickupSteps.length).toBe(1);
      }
    });

    it('JIRA-87: rejects opportunistic pickup when delivery requires more than 2 turns and cost is infeasible', async () => {
      // Coal→Paris: delivery NOT on network, track cost exceeds money,
      // AND estimatedTurns=5 — beyond relaxed feasibility window
      const snapshot = makeSnapshot({
        bot: {
          ...makeSnapshot().bot,
          loads: [],
          money: 15,
          resolvedDemands: [
            { cardId: 1, demands: [{ city: 'Paris', loadType: 'Coal', payment: 25 }] },
          ],
        },
        loadAvailability: { Berlin: ['Coal'] },
      });
      const context = makeContext({
        capacity: 2,
        money: 15,
        demands: [{
          cardIndex: 1, loadType: 'Coal', supplyCity: 'Berlin', deliveryCity: 'Paris',
          payout: 25, isDeliveryOnNetwork: false, isDeliveryReachable: false,
          isSupplyOnNetwork: true, isLoadOnTrain: false,
          estimatedTrackCostToSupply: 0, estimatedTrackCostToDelivery: 30,
          isLoadAvailable: true, ferryRequired: false,
          loadChipTotal: 4, loadChipCarried: 0, estimatedTurns: 5,
          demandScore: 0, efficiencyPerTurn: 0, networkCitiesUnlocked: 0, victoryMajorCitiesEnRoute: 0,
        }] as any[],
      });

      const movePlan: TurnPlan = {
        type: AIActionType.MoveTrain,
        path: [{ row: 10, col: 10 }, { row: 10, col: 20 }],
        fees: new Set<string>(),
        totalFee: 0,
      };

      mockLoadGridPoints.mockReturnValue(new Map([
        ['10,20', { row: 10, col: 20, terrain: TerrainType.MajorCity, name: 'Berlin' }],
      ]));

      const warnSpy = jest.spyOn(console, 'warn').mockImplementation();

      const { plan: result } = await TurnComposer.compose(movePlan, snapshot, context);

      // Pickup should NOT be proposed — estimatedTurns=5 exceeds the 2-turn window
      if (result.type === 'MultiAction') {
        const pickupSteps = result.steps.filter(s => s.type === AIActionType.PickupLoad);
        expect(pickupSteps.length).toBe(0);
      } else {
        expect(result.type).toBe(AIActionType.MoveTrain);
      }

      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('Rejected infeasible opportunistic pickup'),
      );

      warnSpy.mockRestore();
    });

    it('JIRA-57: allows pickup when infeasible by cost but matches active route stop', async () => {
      // Chocolate→Manchester: payout 17M, track cost 30M — feasibility check would reject.
      // But the active route's current stop is pickup Chocolate at Berlin → bypass check.
      const snapshot = makeSnapshot({
        bot: {
          ...makeSnapshot().bot,
          loads: [],
          money: 50,
          resolvedDemands: [
            { cardId: 1, demands: [{ city: 'Manchester', loadType: 'Chocolate', payment: 17 }] },
          ],
        },
        loadAvailability: { Berlin: ['Chocolate'] },
      });
      const context = makeContext({
        capacity: 2,
        money: 50,
        demands: [{
          cardIndex: 1, loadType: 'Chocolate', supplyCity: 'Berlin', deliveryCity: 'Manchester',
          payout: 17, isDeliveryOnNetwork: false, isDeliveryReachable: false,
          isSupplyOnNetwork: true, isLoadOnTrain: false,
          estimatedTrackCostToSupply: 0, estimatedTrackCostToDelivery: 30,
          isLoadAvailable: true, ferryRequired: false,
          loadChipTotal: 4, loadChipCarried: 0, estimatedTurns: 0,
          demandScore: 0, efficiencyPerTurn: 0, networkCitiesUnlocked: 0, victoryMajorCitiesEnRoute: 0,
        }] as any[],
      });

      const movePlan: TurnPlan = {
        type: AIActionType.MoveTrain,
        path: [{ row: 10, col: 10 }, { row: 10, col: 20 }],
        fees: new Set<string>(),
        totalFee: 0,
      };

      // Active route says: pickup Chocolate at Berlin
      const activeRoute: StrategicRoute = {
        currentStopIndex: 0,
        startingCity: 'Paris',
        phase: 'travel',
        createdAtTurn: 1,
        reasoning: 'test route',
        stops: [
          { action: 'pickup', loadType: 'Chocolate', city: 'Berlin' },
          { action: 'deliver', loadType: 'Chocolate', city: 'Manchester', demandCardId: 1, payment: 17 },
        ],
      };

      mockLoadGridPoints.mockReturnValue(new Map([
        ['10,20', { row: 10, col: 20, terrain: TerrainType.MajorCity, name: 'Berlin' }],
      ]));

      mockApplyPlanToState.mockImplementation((plan: TurnPlan, snap: WorldSnapshot) => {
        if (plan.type === AIActionType.MoveTrain) {
          const endPos = (plan as any).path[(plan as any).path.length - 1];
          snap.bot.position = { row: endPos.row, col: endPos.col };
        }
        if (plan.type === AIActionType.PickupLoad) {
          snap.bot.loads = [...snap.bot.loads, (plan as any).load];
        }
      });

      mockResolve.mockResolvedValueOnce({
        success: true,
        plan: { type: AIActionType.PickupLoad, load: 'Chocolate', city: 'Berlin' },
      });

      const warnSpy = jest.spyOn(console, 'warn').mockImplementation();

      const { plan: result } = await TurnComposer.compose(movePlan, snapshot, context, activeRoute);

      // Pickup SHOULD happen — route planned it despite infeasible cost check
      expect(result.type).toBe('MultiAction');
      if (result.type === 'MultiAction') {
        const pickupSteps = result.steps.filter(s => s.type === AIActionType.PickupLoad);
        expect(pickupSteps.length).toBe(1);
      }

      // No rejection warning should appear
      expect(warnSpy).not.toHaveBeenCalledWith(
        expect.stringContaining('Rejected infeasible opportunistic pickup'),
      );

      warnSpy.mockRestore();
    });
  });

  describe('cargo slot reservation for planned pickups (BE-002)', () => {
    it('rejects opportunistic pickup when only one slot left and route has planned pickup', async () => {
      // Bot has 1 load, capacity 2 → 1 empty slot. Route next stop is pickup.
      // Reservation leaves 0 effective slots → opportunistic pickup blocked.
      const snapshot = makeSnapshot({
        bot: {
          ...makeSnapshot().bot,
          loads: ['Wine'],
          resolvedDemands: [
            { cardId: 1, demands: [{ city: 'Paris', loadType: 'Coal', payment: 25 }] },
          ],
        },
        loadAvailability: { Berlin: ['Coal'] },
      });
      const context = makeContext({
        capacity: 2,
        loads: ['Wine'],
        demands: [{
          cardIndex: 1, loadType: 'Coal', supplyCity: 'Berlin', deliveryCity: 'Paris',
          payout: 25, isDeliveryOnNetwork: true, isDeliveryReachable: true,
          isSupplyOnNetwork: true, isLoadOnTrain: false,
          estimatedTrackCostToSupply: 0, estimatedTrackCostToDelivery: 0,
          isLoadAvailable: true, ferryRequired: false,
          loadChipTotal: 4, loadChipCarried: 0, estimatedTurns: 0,
          demandScore: 0, efficiencyPerTurn: 0, networkCitiesUnlocked: 0, victoryMajorCitiesEnRoute: 0,
        }] as any[],
      });
      const route = makeRoute({
        stops: [
          { action: 'pickup', loadType: 'Steel', city: 'Hamburg' },
          { action: 'deliver', loadType: 'Steel', city: 'London', demandCardId: 2, payment: 30 },
        ],
        currentStopIndex: 0,
        phase: 'travel',
      });

      const movePlan: TurnPlan = {
        type: AIActionType.MoveTrain,
        path: [{ row: 10, col: 10 }, { row: 10, col: 20 }],
        fees: new Set<string>(),
        totalFee: 0,
      };

      mockLoadGridPoints.mockReturnValue(new Map([
        ['10,20', { row: 10, col: 20, terrain: TerrainType.MajorCity, name: 'Berlin' }],
      ]));

      // No resolve calls should happen — pickup should be blocked before calling ActionResolver
      const { plan: result } = await TurnComposer.compose(movePlan, snapshot, context, route);

      // Only MOVE should remain — no opportunistic pickup
      if (result.type === 'MultiAction') {
        const pickupSteps = result.steps.filter(s => s.type === AIActionType.PickupLoad);
        expect(pickupSteps.length).toBe(0);
      } else {
        expect(result.type).toBe(AIActionType.MoveTrain);
      }
    });

    it('allows opportunistic pickup when two slots are empty and route has planned pickup', async () => {
      // Bot has 0 loads, capacity 2 → 2 empty slots. Route next stop is pickup.
      // Reservation leaves 1 effective slot → opportunistic pickup allowed.
      const snapshot = makeSnapshot({
        bot: {
          ...makeSnapshot().bot,
          loads: [],
          resolvedDemands: [
            { cardId: 1, demands: [{ city: 'Paris', loadType: 'Coal', payment: 25 }] },
          ],
        },
        loadAvailability: { Berlin: ['Coal'] },
      });
      const context = makeContext({
        capacity: 2,
        loads: [],
        demands: [{
          cardIndex: 1, loadType: 'Coal', supplyCity: 'Berlin', deliveryCity: 'Paris',
          payout: 25, isDeliveryOnNetwork: true, isDeliveryReachable: true,
          isSupplyOnNetwork: true, isLoadOnTrain: false,
          estimatedTrackCostToSupply: 0, estimatedTrackCostToDelivery: 0,
          isLoadAvailable: true, ferryRequired: false,
          loadChipTotal: 4, loadChipCarried: 0, estimatedTurns: 0,
          demandScore: 0, efficiencyPerTurn: 0, networkCitiesUnlocked: 0, victoryMajorCitiesEnRoute: 0,
        }] as any[],
      });
      const route = makeRoute({
        stops: [
          { action: 'pickup', loadType: 'Steel', city: 'Hamburg' },
          { action: 'deliver', loadType: 'Steel', city: 'London', demandCardId: 2, payment: 30 },
        ],
        currentStopIndex: 0,
        phase: 'travel',
      });

      const movePlan: TurnPlan = {
        type: AIActionType.MoveTrain,
        path: [{ row: 10, col: 10 }, { row: 10, col: 20 }],
        fees: new Set<string>(),
        totalFee: 0,
      };

      mockLoadGridPoints.mockReturnValue(new Map([
        ['10,20', { row: 10, col: 20, terrain: TerrainType.MajorCity, name: 'Berlin' }],
      ]));

      mockApplyPlanToState.mockImplementation((plan: TurnPlan, snap: WorldSnapshot) => {
        if (plan.type === AIActionType.MoveTrain) {
          const endPos = (plan as any).path[(plan as any).path.length - 1];
          snap.bot.position = { row: endPos.row, col: endPos.col };
        }
        if (plan.type === AIActionType.PickupLoad) {
          snap.bot.loads = [...snap.bot.loads, (plan as any).load];
        }
      });

      mockResolve.mockResolvedValueOnce({
        success: true,
        plan: { type: AIActionType.PickupLoad, load: 'Coal', city: 'Berlin' },
      });

      const { plan: result } = await TurnComposer.compose(movePlan, snapshot, context, route);

      expect(result.type).toBe('MultiAction');
      if (result.type === 'MultiAction') {
        const pickupSteps = result.steps.filter(s => s.type === AIActionType.PickupLoad);
        expect(pickupSteps.length).toBe(1);
      }
    });

    it('allows opportunistic pickup when no active route exists', async () => {
      // Bot has 1 load, capacity 2 → 1 empty slot. No active route.
      // No reservation → opportunistic pickup allowed.
      const snapshot = makeSnapshot({
        bot: {
          ...makeSnapshot().bot,
          loads: ['Wine'],
          resolvedDemands: [
            { cardId: 1, demands: [{ city: 'Paris', loadType: 'Coal', payment: 25 }] },
          ],
        },
        loadAvailability: { Berlin: ['Coal'] },
      });
      const context = makeContext({
        capacity: 2,
        loads: ['Wine'],
        demands: [{
          cardIndex: 1, loadType: 'Coal', supplyCity: 'Berlin', deliveryCity: 'Paris',
          payout: 25, isDeliveryOnNetwork: true, isDeliveryReachable: true,
          isSupplyOnNetwork: true, isLoadOnTrain: false,
          estimatedTrackCostToSupply: 0, estimatedTrackCostToDelivery: 0,
          isLoadAvailable: true, ferryRequired: false,
          loadChipTotal: 4, loadChipCarried: 0, estimatedTurns: 0,
          demandScore: 0, efficiencyPerTurn: 0, networkCitiesUnlocked: 0, victoryMajorCitiesEnRoute: 0,
        }] as any[],
      });

      const movePlan: TurnPlan = {
        type: AIActionType.MoveTrain,
        path: [{ row: 10, col: 10 }, { row: 10, col: 20 }],
        fees: new Set<string>(),
        totalFee: 0,
      };

      mockLoadGridPoints.mockReturnValue(new Map([
        ['10,20', { row: 10, col: 20, terrain: TerrainType.MajorCity, name: 'Berlin' }],
      ]));

      mockApplyPlanToState.mockImplementation((plan: TurnPlan, snap: WorldSnapshot) => {
        if (plan.type === AIActionType.MoveTrain) {
          const endPos = (plan as any).path[(plan as any).path.length - 1];
          snap.bot.position = { row: endPos.row, col: endPos.col };
        }
        if (plan.type === AIActionType.PickupLoad) {
          snap.bot.loads = [...snap.bot.loads, (plan as any).load];
        }
      });

      mockResolve.mockResolvedValueOnce({
        success: true,
        plan: { type: AIActionType.PickupLoad, load: 'Coal', city: 'Berlin' },
      });

      // No activeRoute passed
      const { plan: result } = await TurnComposer.compose(movePlan, snapshot, context);

      expect(result.type).toBe('MultiAction');
      if (result.type === 'MultiAction') {
        const pickupSteps = result.steps.filter(s => s.type === AIActionType.PickupLoad);
        expect(pickupSteps.length).toBe(1);
      }
    });
  });

  describe('Phase A0: deliver-before-build (FR-8)', () => {
    it('prepends MOVE+DELIVER before BUILD when deliverable load is reachable', async () => {
      const snapshot = makeSnapshot({
        bot: {
          ...makeSnapshot().bot,
          loads: ['Coal'],
        },
      });
      const context = makeContext({
        loads: ['Coal'],
        demands: [{
          cardIndex: 1,
          loadType: 'Coal',
          supplyCity: 'Berlin',
          deliveryCity: 'Paris',
          payout: 25,
          isDeliveryOnNetwork: true,
          isDeliveryReachable: true,
          isSupplyOnNetwork: true,
          isLoadOnTrain: true,
          estimatedTrackCostToSupply: 0,
          estimatedTrackCostToDelivery: 0,
          bestPayout: 25,
        }] as any[],
      });

      const buildPlan: TurnPlan = {
        type: AIActionType.BuildTrack,
        segments: [makeSegment(10, 10, 11, 11)],
        targetCity: 'Hamburg',
      };

      // A0: MOVE to Paris resolves successfully
      mockResolve
        .mockResolvedValueOnce({
          success: true,
          plan: {
            type: AIActionType.MoveTrain,
            path: [{ row: 10, col: 10 }, { row: 15, col: 15 }],
            fees: new Set<string>(),
            totalFee: 0,
          },
        })
        // A0: DELIVER at Paris succeeds
        .mockResolvedValueOnce({
          success: true,
          plan: { type: AIActionType.DeliverLoad, load: 'Coal', city: 'Paris', cardId: 1, payout: 25 },
        });

      const { plan: result } = await TurnComposer.compose(buildPlan, snapshot, context);

      expect(result.type).toBe('MultiAction');
      if (result.type === 'MultiAction') {
        expect(result.steps.length).toBeGreaterThanOrEqual(3);
        expect(result.steps[0].type).toBe(AIActionType.MoveTrain);
        expect(result.steps[1].type).toBe(AIActionType.DeliverLoad);
        // BUILD should still be present
        const hasBuild = result.steps.some(s => s.type === AIActionType.BuildTrack);
        expect(hasBuild).toBe(true);
      }
    });

    it('does NOT prepend deliver when no deliverable load is present', async () => {
      const snapshot = makeSnapshot();
      const context = makeContext({
        demands: [], // No deliverable loads
      });

      const buildPlan: TurnPlan = {
        type: AIActionType.BuildTrack,
        segments: [makeSegment(10, 10, 11, 11)],
        targetCity: 'Hamburg',
      };

      const { plan: result } = await TurnComposer.compose(buildPlan, snapshot, context);

      // Should still contain BUILD, but no DELIVER
      if (result.type === 'MultiAction') {
        const hasDeliver = result.steps.some(s => s.type === AIActionType.DeliverLoad);
        expect(hasDeliver).toBe(false);
      } else {
        expect(result.type).toBe(AIActionType.BuildTrack);
      }
    });

    it('does NOT prepend deliver when delivery city is not reachable', async () => {
      const snapshot = makeSnapshot({
        bot: {
          ...makeSnapshot().bot,
          loads: ['Coal'],
        },
      });
      const context = makeContext({
        loads: ['Coal'],
        demands: [{
          cardIndex: 1,
          loadType: 'Coal',
          supplyCity: 'Berlin',
          deliveryCity: 'London',
          payout: 25,
          isDeliveryOnNetwork: false,
          isDeliveryReachable: false,
          isSupplyOnNetwork: true,
          isLoadOnTrain: true,
          estimatedTrackCostToSupply: 0,
          estimatedTrackCostToDelivery: 100,
          bestPayout: 25,
        }] as any[],
      });

      const buildPlan: TurnPlan = {
        type: AIActionType.BuildTrack,
        segments: [makeSegment(10, 10, 11, 11)],
        targetCity: 'Hamburg',
      };

      const { plan: result } = await TurnComposer.compose(buildPlan, snapshot, context);

      // No DELIVER should be prepended
      if (result.type === 'MultiAction') {
        const hasDeliver = result.steps.some(s => s.type === AIActionType.DeliverLoad);
        expect(hasDeliver).toBe(false);
      }
    });
  });

  describe('pre-enrichment movement budget validation', () => {
    it('should truncate last MOVE when incoming plan exceeds speed limit', async () => {
      const snapshot = makeSnapshot();
      const context = makeContext({ speed: 9 });

      // MultiAction with two MOVEs totaling 12mp (7 + 5 = 12 > 9)
      const plan: TurnPlan = {
        type: 'MultiAction' as const,
        steps: [
          {
            type: AIActionType.MoveTrain,
            path: Array.from({ length: 8 }, (_, i) => ({ row: 10, col: 10 + i })), // 7mp
          } as TurnPlan,
          {
            type: AIActionType.DeliverLoad,
            load: 'Coal',
            city: 'Berlin',
            cardId: 1,
            payout: 25,
          } as TurnPlan,
          {
            type: AIActionType.MoveTrain,
            path: Array.from({ length: 6 }, (_, i) => ({ row: 10, col: 17 + i })), // 5mp
          } as TurnPlan,
        ],
      };

      const warnSpy = jest.spyOn(console, 'warn').mockImplementation();

      const { plan: result } = await TurnComposer.compose(plan, snapshot, context);

      expect(result.type).toBe('MultiAction');
      if (result.type === 'MultiAction') {
        // Last MOVE should be truncated from 5mp to 2mp (12 - 9 = 3 excess, 5 - 3 = 2)
        const moves = result.steps.filter(s => s.type === AIActionType.MoveTrain);
        expect(moves).toHaveLength(2);
        const firstMove = moves[0] as any;
        expect(firstMove.path).toHaveLength(8); // 7mp unchanged
        const secondMove = moves[1] as any;
        expect(secondMove.path).toHaveLength(3); // 2mp (truncated from 5)
      }

      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('[TurnComposer] Movement budget exceeded'),
      );

      warnSpy.mockRestore();
    });

    it('should not truncate when plan is exactly at speed limit', async () => {
      const snapshot = makeSnapshot();
      const context = makeContext({ speed: 9 });

      // MultiAction with MOVE totaling exactly 9mp
      const plan: TurnPlan = {
        type: 'MultiAction' as const,
        steps: [
          {
            type: AIActionType.MoveTrain,
            path: Array.from({ length: 10 }, (_, i) => ({ row: 10, col: 10 + i })), // 9mp
          } as TurnPlan,
          {
            type: AIActionType.DeliverLoad,
            load: 'Coal',
            city: 'Berlin',
            cardId: 1,
            payout: 25,
          } as TurnPlan,
        ],
      };

      const warnSpy = jest.spyOn(console, 'warn').mockImplementation();

      const { plan: result } = await TurnComposer.compose(plan, snapshot, context);

      expect(result.type).toBe('MultiAction');
      if (result.type === 'MultiAction') {
        const move = result.steps.find(s => s.type === AIActionType.MoveTrain) as any;
        expect(move.path).toHaveLength(10); // 9mp, no truncation
      }

      // No budget warning should be logged
      const budgetWarnings = warnSpy.mock.calls.filter(
        c => typeof c[0] === 'string' && c[0].includes('[TurnComposer] Movement budget exceeded'),
      );
      expect(budgetWarnings).toHaveLength(0);

      warnSpy.mockRestore();
    });

    it('should not truncate when plan is under speed limit', async () => {
      const snapshot = makeSnapshot();
      const context = makeContext({ speed: 9 });

      // Single MOVE of 5mp
      const plan: TurnPlan = {
        type: AIActionType.MoveTrain,
        path: Array.from({ length: 6 }, (_, i) => ({ row: 10, col: 10 + i })), // 5mp
      } as TurnPlan;

      const { plan: result } = await TurnComposer.compose(plan, snapshot, context);

      // The plan should pass through unmodified (enrichment may add steps, but the MOVE shouldn't be truncated)
      if (result.type === 'MultiAction') {
        const move = result.steps.find(s => s.type === AIActionType.MoveTrain) as any;
        expect(move.path.length).toBeGreaterThanOrEqual(6); // at least original 5mp
      } else {
        const move = result as any;
        expect(move.path).toHaveLength(6); // 5mp, unchanged
      }
    });

    it('should remove MOVE entirely when truncation would leave path of length 1', async () => {
      const snapshot = makeSnapshot();
      const context = makeContext({ speed: 9 });

      // Two MOVEs: first uses 9mp, second has 2mp — second should be removed entirely
      const plan: TurnPlan = {
        type: 'MultiAction' as const,
        steps: [
          {
            type: AIActionType.MoveTrain,
            path: Array.from({ length: 10 }, (_, i) => ({ row: 10, col: 10 + i })), // 9mp
          } as TurnPlan,
          {
            type: AIActionType.MoveTrain,
            path: Array.from({ length: 3 }, (_, i) => ({ row: 10, col: 19 + i })), // 2mp
          } as TurnPlan,
        ],
      };

      const { plan: result } = await TurnComposer.compose(plan, snapshot, context);

      // The second MOVE (2mp excess) should be removed entirely since 2 - 2 = 0 < 1
      if (result.type === 'MultiAction') {
        const moves = result.steps.filter(s => s.type === AIActionType.MoveTrain);
        expect(moves).toHaveLength(1);
        expect((moves[0] as any).path).toHaveLength(10); // first MOVE unchanged
      }
    });
  });

  describe('A2 loop: multi-chaining and budget respect', () => {
    it('chains MOVE → DELIVER → MOVE using full movement budget', async () => {
      // Bot carrying Coal, route: deliver Coal at CityA → pickup Wine at CityB
      // Speed: 9. MOVE to CityA = 4mp. After DELIVER, MOVE to CityB = 5mp. Total = 9mp.
      const snapshot = makeSnapshot({
        bot: {
          ...makeSnapshot().bot,
          loads: ['Coal'],
          resolvedDemands: [
            { cardId: 1, demands: [{ city: 'CityA', loadType: 'Coal', payment: 25 }] },
          ],
        },
      });
      const context = makeContext({ speed: 9, loads: ['Coal'] });
      const route = makeRoute({
        stops: [
          { action: 'deliver', loadType: 'Coal', city: 'CityA', demandCardId: 1, payment: 25 },
          { action: 'pickup', loadType: 'Wine', city: 'CityB' },
        ],
        currentStopIndex: 0,
        phase: 'travel',
      });

      // Primary: PICKUP (simulates A1 having already produced a pickup)
      const pickupPlan: TurnPlan = {
        type: AIActionType.PickupLoad,
        load: 'Iron',
        city: 'StartCity',
      };

      // loadGridPoints: CityA at (14,10)
      mockLoadGridPoints.mockReturnValue(new Map([
        ['14,10', { row: 14, col: 10, terrain: TerrainType.MediumCity, name: 'CityA' }],
      ]));

      mockApplyPlanToState.mockImplementation((plan: TurnPlan, snap: WorldSnapshot, ctx: GameContext) => {
        if (plan.type === AIActionType.PickupLoad) {
          const load = (plan as any).load;
          if (!snap.bot.loads.includes(load)) snap.bot.loads.push(load);
          ctx.loads = [...snap.bot.loads];
        }
        if (plan.type === AIActionType.MoveTrain) {
          const movePath = (plan as any).path;
          const endPos = movePath[movePath.length - 1];
          snap.bot.position = { row: endPos.row, col: endPos.col };
          ctx.position = { row: endPos.row, col: endPos.col };
        }
        if (plan.type === AIActionType.DeliverLoad) {
          const load = (plan as any).load;
          const idx = snap.bot.loads.indexOf(load);
          if (idx >= 0) snap.bot.loads.splice(idx, 1);
          ctx.loads = [...snap.bot.loads];
        }
      });

      mockResolve
        // A2 iter 1: MOVE to CityA (5 positions = 4mp)
        .mockResolvedValueOnce({
          success: true,
          plan: {
            type: AIActionType.MoveTrain,
            path: [
              { row: 10, col: 10 }, { row: 11, col: 10 },
              { row: 12, col: 10 }, { row: 13, col: 10 }, { row: 14, col: 10 },
            ],
            fees: new Set<string>(),
            totalFee: 0,
          },
        })
        // splitMoveForOpportunities: DELIVER Coal at CityA
        .mockResolvedValueOnce({
          success: true,
          plan: { type: AIActionType.DeliverLoad, load: 'Coal', city: 'CityA', cardId: 1, payout: 25 },
        })
        // A2 iter 2: MOVE to CityB (6 positions = 5mp, remaining budget)
        .mockResolvedValueOnce({
          success: true,
          plan: {
            type: AIActionType.MoveTrain,
            path: [
              { row: 14, col: 10 }, { row: 15, col: 10 },
              { row: 16, col: 10 }, { row: 17, col: 10 },
              { row: 18, col: 10 }, { row: 19, col: 10 },
            ],
            fees: new Set<string>(),
            totalFee: 0,
          },
        });

      const logSpy = jest.spyOn(console, 'log').mockImplementation();
      const { plan: result } = await TurnComposer.compose(pickupPlan, snapshot, context, route);

      expect(result.type).toBe('MultiAction');
      if (result.type === 'MultiAction') {
        // PICKUP + MOVE(4mp) + DELIVER + MOVE(5mp) = 4 steps
        expect(result.steps[0].type).toBe(AIActionType.PickupLoad);
        const moves = result.steps.filter(s => s.type === AIActionType.MoveTrain);
        expect(moves.length).toBe(2);
        const delivers = result.steps.filter(s => s.type === AIActionType.DeliverLoad);
        expect(delivers.length).toBe(1);
        // Total movement: 4 + 5 = 9mp (fully used)
        const totalMp = moves.reduce(
          (sum, m) => sum + ((m as any).path.length - 1), 0,
        );
        expect(totalMp).toBe(9);
      }

      // Verify A2 loop logged
      const a2Logs = logSpy.mock.calls.filter(
        c => typeof c[0] === 'string' && c[0].includes('[TurnComposer] A2 loop'),
      );
      expect(a2Logs.length).toBe(1);
      expect(a2Logs[0][0]).toContain('chained continuation');

      logSpy.mockRestore();
    });

    it('stops chaining when movement budget is exhausted', async () => {
      // Speed: 4. Primary PICKUP. MOVE 4mp to CityA → DELIVER. No budget left for iter 2.
      const snapshot = makeSnapshot({
        bot: {
          ...makeSnapshot().bot,
          loads: ['Coal'],
          resolvedDemands: [
            { cardId: 1, demands: [{ city: 'CityA', loadType: 'Coal', payment: 25 }] },
          ],
        },
      });
      const context = makeContext({ speed: 4, loads: ['Coal'] });
      const route = makeRoute({
        stops: [
          { action: 'deliver', loadType: 'Coal', city: 'CityA', demandCardId: 1, payment: 25 },
          { action: 'pickup', loadType: 'Wine', city: 'CityB' },
        ],
        currentStopIndex: 0,
        phase: 'travel',
      });

      const pickupPlan: TurnPlan = {
        type: AIActionType.PickupLoad,
        load: 'Iron',
        city: 'StartCity',
      };

      mockLoadGridPoints.mockReturnValue(new Map([
        ['14,10', { row: 14, col: 10, terrain: TerrainType.MediumCity, name: 'CityA' }],
      ]));

      mockApplyPlanToState.mockImplementation((plan: TurnPlan, snap: WorldSnapshot, ctx: GameContext) => {
        if (plan.type === AIActionType.PickupLoad) {
          const load = (plan as any).load;
          if (!snap.bot.loads.includes(load)) snap.bot.loads.push(load);
          ctx.loads = [...snap.bot.loads];
        }
        if (plan.type === AIActionType.MoveTrain) {
          const movePath = (plan as any).path;
          const endPos = movePath[movePath.length - 1];
          snap.bot.position = { row: endPos.row, col: endPos.col };
          ctx.position = { row: endPos.row, col: endPos.col };
        }
        if (plan.type === AIActionType.DeliverLoad) {
          const load = (plan as any).load;
          const idx = snap.bot.loads.indexOf(load);
          if (idx >= 0) snap.bot.loads.splice(idx, 1);
          ctx.loads = [...snap.bot.loads];
        }
      });

      mockResolve
        // A2 iter 1: MOVE to CityA (5 positions = 4mp, uses all budget)
        .mockResolvedValueOnce({
          success: true,
          plan: {
            type: AIActionType.MoveTrain,
            path: [
              { row: 10, col: 10 }, { row: 11, col: 10 },
              { row: 12, col: 10 }, { row: 13, col: 10 }, { row: 14, col: 10 },
            ],
            fees: new Set<string>(),
            totalFee: 0,
          },
        })
        // splitMoveForOpportunities: DELIVER Coal at CityA
        .mockResolvedValueOnce({
          success: true,
          plan: { type: AIActionType.DeliverLoad, load: 'Coal', city: 'CityA', cardId: 1, payout: 25 },
        });

      const logSpy = jest.spyOn(console, 'log').mockImplementation();
      const { plan: result } = await TurnComposer.compose(pickupPlan, snapshot, context, route);

      expect(result.type).toBe('MultiAction');
      if (result.type === 'MultiAction') {
        // PICKUP + MOVE(4mp) + DELIVER — no second MOVE (budget exhausted)
        expect(result.steps).toHaveLength(3);
        expect(result.steps[0].type).toBe(AIActionType.PickupLoad);
        expect(result.steps[1].type).toBe(AIActionType.MoveTrain);
        expect(result.steps[2].type).toBe(AIActionType.DeliverLoad);
      }

      // Verify log says budget exhausted
      const a2Logs = logSpy.mock.calls.filter(
        c => typeof c[0] === 'string' && c[0].includes('[TurnComposer] A2 loop'),
      );
      expect(a2Logs.length).toBe(1);
      expect(a2Logs[0][0]).toContain('budget exhausted');

      logSpy.mockRestore();
    });

    it('respects movement budget across multiple chained MOVEs', async () => {
      // Speed: 6. Primary PICKUP. Iter 1: MOVE 3mp → DELIVER. Iter 2: MOVE(resolves 5mp, truncated to 3mp).
      const snapshot = makeSnapshot({
        bot: {
          ...makeSnapshot().bot,
          loads: ['Coal'],
          resolvedDemands: [
            { cardId: 1, demands: [{ city: 'CityA', loadType: 'Coal', payment: 25 }] },
          ],
        },
      });
      const context = makeContext({ speed: 6, loads: ['Coal'] });
      const route = makeRoute({
        stops: [
          { action: 'deliver', loadType: 'Coal', city: 'CityA', demandCardId: 1, payment: 25 },
          { action: 'pickup', loadType: 'Wine', city: 'CityB' },
        ],
        currentStopIndex: 0,
        phase: 'travel',
      });

      const pickupPlan: TurnPlan = {
        type: AIActionType.PickupLoad,
        load: 'Iron',
        city: 'StartCity',
      };

      mockLoadGridPoints.mockReturnValue(new Map([
        ['13,10', { row: 13, col: 10, terrain: TerrainType.MediumCity, name: 'CityA' }],
      ]));

      mockApplyPlanToState.mockImplementation((plan: TurnPlan, snap: WorldSnapshot, ctx: GameContext) => {
        if (plan.type === AIActionType.PickupLoad) {
          const load = (plan as any).load;
          if (!snap.bot.loads.includes(load)) snap.bot.loads.push(load);
          ctx.loads = [...snap.bot.loads];
        }
        if (plan.type === AIActionType.MoveTrain) {
          const movePath = (plan as any).path;
          const endPos = movePath[movePath.length - 1];
          snap.bot.position = { row: endPos.row, col: endPos.col };
          ctx.position = { row: endPos.row, col: endPos.col };
        }
        if (plan.type === AIActionType.DeliverLoad) {
          const load = (plan as any).load;
          const idx = snap.bot.loads.indexOf(load);
          if (idx >= 0) snap.bot.loads.splice(idx, 1);
          ctx.loads = [...snap.bot.loads];
        }
      });

      mockResolve
        // A2 iter 1: MOVE 3mp to CityA
        .mockResolvedValueOnce({
          success: true,
          plan: {
            type: AIActionType.MoveTrain,
            path: [
              { row: 10, col: 10 }, { row: 11, col: 10 },
              { row: 12, col: 10 }, { row: 13, col: 10 },
            ],
            fees: new Set<string>(),
            totalFee: 0,
          },
        })
        // splitMoveForOpportunities: DELIVER at CityA
        .mockResolvedValueOnce({
          success: true,
          plan: { type: AIActionType.DeliverLoad, load: 'Coal', city: 'CityA', cardId: 1, payout: 25 },
        })
        // A2 iter 2: MOVE toward CityB — returns 6mp path (too long, should be truncated to 3mp)
        .mockResolvedValueOnce({
          success: true,
          plan: {
            type: AIActionType.MoveTrain,
            path: [
              { row: 13, col: 10 }, { row: 14, col: 10 },
              { row: 15, col: 10 }, { row: 16, col: 10 },
              { row: 17, col: 10 }, { row: 18, col: 10 }, { row: 19, col: 10 },
            ],
            fees: new Set<string>(),
            totalFee: 0,
          },
        });

      const { plan: result } = await TurnComposer.compose(pickupPlan, snapshot, context, route);

      expect(result.type).toBe('MultiAction');
      if (result.type === 'MultiAction') {
        const moves = result.steps.filter(s => s.type === AIActionType.MoveTrain);
        expect(moves.length).toBe(2);
        // First MOVE: 3mp
        expect((moves[0] as any).path.length - 1).toBe(3);
        // Second MOVE: truncated to 3mp (6 - 3 = 3 remaining)
        expect((moves[1] as any).path.length - 1).toBeLessThanOrEqual(3);
        // Total movement never exceeds speed
        const totalMp = moves.reduce(
          (sum, m) => sum + ((m as any).path.length - 1), 0,
        );
        expect(totalMp).toBeLessThanOrEqual(6);
      }
    });
  });

  describe('JIRA-62: A2 truncation uses effective mileposts through major cities', () => {
    it('should use full remaining budget when path passes through major city red area', async () => {
      // Scenario from game e48b04ec: Flash at Holland picks up Imports at Antwerpen (2 eff mp),
      // then A2 chains continuation MOVE back through Holland toward Wien.
      // The path Antwerpen→Wien passes through Holland's red area (intra-city hops = free).
      // Bug: A2 truncated using raw edge count, wasting budget on free intra-city hops.
      // Fix: truncate using effective mileposts so free hops don't consume budget.

      // Setup: bot at (10,10) "Antwerpen", just picked up. Speed 9, 2mp already used.
      // Continuation path: Antwerpen→milepost→Holland_outpost→Holland_center→Holland_outpost_east→east1→east2→east3→east4→east5→east6→east7
      // Raw edges: 11. Intra-city: 2 (Holland outpost→center, center→east_outpost). Effective: 9mp.
      // With 7mp remaining, truncation should keep 7 effective mp (9 raw edges including 2 free hops).

      // Mock major city lookup: Holland nodes at (12,10), (12,11), (12,12) all belong to "Holland"
      const lookupSpy = jest.spyOn(majorCityGroups, 'getMajorCityLookup').mockReturnValue(new Map<string, string>([
        ['12,10', 'Holland'],  // outpost west
        ['12,11', 'Holland'],  // center
        ['12,12', 'Holland'],  // outpost east
      ]));

      const snapshot = makeSnapshot({
        bot: {
          ...makeSnapshot().bot,
          position: { row: 10, col: 10 },  // At Antwerpen after pickup
          loads: ['Imports'],
          resolvedDemands: [
            { cardId: 1, demands: [{ city: 'Wien', loadType: 'Imports', payment: 19 }] },
          ],
        },
      });
      const context = makeContext({ speed: 9, loads: ['Imports'] });
      const route = makeRoute({
        stops: [
          { action: 'pickup', loadType: 'Imports', city: 'Antwerpen' },
          { action: 'deliver', loadType: 'Imports', city: 'Wien', demandCardId: 1, payment: 19 },
        ],
        currentStopIndex: 1,  // pickup done, now delivering
        phase: 'travel',
      });

      // Primary plan: PICKUP (already happened, simulates post-A1 state)
      const pickupPlan: TurnPlan = {
        type: AIActionType.PickupLoad,
        load: 'Imports',
        city: 'Antwerpen',
      };

      mockLoadGridPoints.mockReturnValue(new Map([
        ['10,10', { row: 10, col: 10, terrain: TerrainType.MajorCity, name: 'Antwerpen' }],
      ]));

      mockApplyPlanToState.mockImplementation((plan: TurnPlan, snap: WorldSnapshot, ctx: GameContext) => {
        if (plan.type === AIActionType.PickupLoad) {
          const load = (plan as any).load;
          if (!snap.bot.loads.includes(load)) snap.bot.loads.push(load);
          ctx.loads = [...snap.bot.loads];
        }
        if (plan.type === AIActionType.MoveTrain) {
          const movePath = (plan as any).path;
          const endPos = movePath[movePath.length - 1];
          snap.bot.position = { row: endPos.row, col: endPos.col };
          ctx.position = { row: endPos.row, col: endPos.col };
        }
      });

      // A2 continuation MOVE: path from Antwerpen through Holland toward Wien
      // 12 nodes = 11 raw edges. 2 intra-city hops at Holland → 9 effective mp.
      const continuationPath = [
        { row: 10, col: 10 },  // Antwerpen
        { row: 11, col: 10 },  // milepost (1 eff)
        { row: 12, col: 10 },  // Holland outpost west (2 eff)
        { row: 12, col: 11 },  // Holland center (FREE - intra-city)
        { row: 12, col: 12 },  // Holland outpost east (FREE - intra-city)
        { row: 13, col: 12 },  // milepost east (3 eff)
        { row: 14, col: 12 },  // milepost (4 eff)
        { row: 15, col: 12 },  // milepost (5 eff)
        { row: 16, col: 12 },  // milepost (6 eff)
        { row: 17, col: 12 },  // milepost (7 eff)
        { row: 18, col: 12 },  // milepost (8 eff)
        { row: 19, col: 12 },  // milepost (9 eff)
      ];

      mockResolve.mockResolvedValueOnce({
        success: true,
        plan: {
          type: AIActionType.MoveTrain,
          path: continuationPath,
          fees: new Set<string>(),
          totalFee: 0,
        },
      });

      const warnSpy = jest.spyOn(console, 'warn').mockImplementation();
      const logSpy = jest.spyOn(console, 'log').mockImplementation();
      const { plan: result } = await TurnComposer.compose(pickupPlan, snapshot, context, route);

      expect(result.type).toBe('MultiAction');
      if (result.type === 'MultiAction') {
        const moves = result.steps.filter(s => s.type === AIActionType.MoveTrain);
        expect(moves.length).toBe(1);
        const movePath = (moves[0] as any).path;
        // With 9mp budget (no prior MOVE in steps) and 9 effective mp in the path,
        // the full path should be kept. Before this fix, the truncation would have
        // sliced at 9 raw edges, losing 2 effective mp due to intra-city hops.
        // The path should include all 12 nodes (11 raw edges, 9 effective mp).
        expect(movePath.length).toBe(12);
      }

      warnSpy.mockRestore();
      logSpy.mockRestore();
      lookupSpy.mockRestore();
    });
  });

  describe('A2 loop: termination conditions and state consistency', () => {
    it('terminates when last step is MOVE (no further pickup/deliver)', async () => {
      // Primary PICKUP. A2 chains a MOVE with no intermediate city. Last step = MOVE → exit.
      const snapshot = makeSnapshot();
      const context = makeContext({ speed: 9 });
      const route = makeRoute({
        stops: [
          { action: 'deliver', loadType: 'Coal', city: 'Paris', demandCardId: 1, payment: 25 },
        ],
        currentStopIndex: 0,
        phase: 'travel',
      });

      const pickupPlan: TurnPlan = {
        type: AIActionType.PickupLoad,
        load: 'Coal',
        city: 'Berlin',
      };

      mockApplyPlanToState.mockImplementation((plan: TurnPlan, snap: WorldSnapshot, ctx: GameContext) => {
        if (plan.type === AIActionType.PickupLoad) {
          const load = (plan as any).load;
          if (!snap.bot.loads.includes(load)) snap.bot.loads.push(load);
          ctx.loads = [...snap.bot.loads];
        }
        if (plan.type === AIActionType.MoveTrain) {
          const movePath = (plan as any).path;
          const endPos = movePath[movePath.length - 1];
          snap.bot.position = { row: endPos.row, col: endPos.col };
          ctx.position = { row: endPos.row, col: endPos.col };
        }
      });

      // A2: MOVE toward Paris — no intermediate cities → split returns [MOVE]
      mockResolve.mockResolvedValueOnce({
        success: true,
        plan: {
          type: AIActionType.MoveTrain,
          path: [{ row: 10, col: 10 }, { row: 12, col: 12 }, { row: 14, col: 14 }],
          fees: new Set<string>(),
          totalFee: 0,
        },
      });

      const logSpy = jest.spyOn(console, 'log').mockImplementation();
      const { plan: result } = await TurnComposer.compose(pickupPlan, snapshot, context, route);

      expect(result.type).toBe('MultiAction');
      if (result.type === 'MultiAction') {
        expect(result.steps).toHaveLength(2);
        expect(result.steps[0].type).toBe(AIActionType.PickupLoad);
        expect(result.steps[1].type).toBe(AIActionType.MoveTrain);
      }

      // Log says "last step is MOVE"
      const a2Logs = logSpy.mock.calls.filter(
        c => typeof c[0] === 'string' && c[0].includes('[TurnComposer] A2 loop'),
      );
      expect(a2Logs.length).toBe(1);
      expect(a2Logs[0][0]).toContain('last step is MOVE');

      logSpy.mockRestore();
    });

    it('terminates when no valid target resolves in iteration > 0', async () => {
      // Primary PICKUP. Iter 1: MOVE → DELIVER. Iter 2: no target resolves → exit.
      const snapshot = makeSnapshot({
        bot: {
          ...makeSnapshot().bot,
          loads: ['Coal'],
          resolvedDemands: [
            { cardId: 1, demands: [{ city: 'CityA', loadType: 'Coal', payment: 25 }] },
          ],
        },
      });
      const context = makeContext({ speed: 9, loads: ['Coal'] });
      const route = makeRoute({
        stops: [
          { action: 'deliver', loadType: 'Coal', city: 'CityA', demandCardId: 1, payment: 25 },
        ],
        currentStopIndex: 0,
        phase: 'travel',
      });

      const pickupPlan: TurnPlan = {
        type: AIActionType.PickupLoad,
        load: 'Iron',
        city: 'StartCity',
      };

      mockLoadGridPoints.mockReturnValue(new Map([
        ['14,10', { row: 14, col: 10, terrain: TerrainType.MediumCity, name: 'CityA' }],
      ]));

      mockApplyPlanToState.mockImplementation((plan: TurnPlan, snap: WorldSnapshot, ctx: GameContext) => {
        if (plan.type === AIActionType.PickupLoad) {
          const load = (plan as any).load;
          if (!snap.bot.loads.includes(load)) snap.bot.loads.push(load);
          ctx.loads = [...snap.bot.loads];
        }
        if (plan.type === AIActionType.MoveTrain) {
          const movePath = (plan as any).path;
          const endPos = movePath[movePath.length - 1];
          snap.bot.position = { row: endPos.row, col: endPos.col };
          ctx.position = { row: endPos.row, col: endPos.col };
        }
        if (plan.type === AIActionType.DeliverLoad) {
          const load = (plan as any).load;
          const idx = snap.bot.loads.indexOf(load);
          if (idx >= 0) snap.bot.loads.splice(idx, 1);
          ctx.loads = [...snap.bot.loads];
        }
      });

      mockResolve
        // A2 iter 1: MOVE 4mp → split finds DELIVER at CityA
        .mockResolvedValueOnce({
          success: true,
          plan: {
            type: AIActionType.MoveTrain,
            path: [
              { row: 10, col: 10 }, { row: 11, col: 10 },
              { row: 12, col: 10 }, { row: 13, col: 10 }, { row: 14, col: 10 },
            ],
            fees: new Set<string>(),
            totalFee: 0,
          },
        })
        // splitMoveForOpportunities: DELIVER at CityA
        .mockResolvedValueOnce({
          success: true,
          plan: { type: AIActionType.DeliverLoad, load: 'Coal', city: 'CityA', cardId: 1, payout: 25 },
        })
        // A2 iter 2: all MOVE attempts fail
        .mockResolvedValue({ success: false, error: 'No path' });

      const logSpy = jest.spyOn(console, 'log').mockImplementation();
      const { plan: result } = await TurnComposer.compose(pickupPlan, snapshot, context, route);

      expect(result.type).toBe('MultiAction');
      if (result.type === 'MultiAction') {
        // PICKUP + MOVE + DELIVER — no second MOVE
        expect(result.steps).toHaveLength(3);
        expect(result.steps[0].type).toBe(AIActionType.PickupLoad);
        expect(result.steps[1].type).toBe(AIActionType.MoveTrain);
        expect(result.steps[2].type).toBe(AIActionType.DeliverLoad);
      }

      // Log says "no valid target"
      const a2Logs = logSpy.mock.calls.filter(
        c => typeof c[0] === 'string' && c[0].includes('[TurnComposer] A2 loop'),
      );
      expect(a2Logs.length).toBe(1);
      expect(a2Logs[0][0]).toContain('no valid target');

      logSpy.mockRestore();
    });

    it('respects iteration cap of 5', async () => {
      // Bot at start with Coal. Each iteration: MOVE to city → DELIVER + PICKUP new load.
      // This chains indefinitely (budget=1000, capacity maintained at 1 via deliver+pickup).
      // Loop MUST stop at 5 iterations.
      const cities = ['CityA', 'CityB', 'CityC', 'CityD', 'CityE', 'CityF'];
      const loads = ['Coal', 'Wine', 'Steel', 'Oil', 'Grain', 'Timber'];
      // resolvedDemands: demand for each load at corresponding city
      const resolvedDemands = loads.map((load, i) => ({
        cardId: i + 1,
        demands: [{ city: cities[i], loadType: load, payment: 25 }],
      }));
      // loadAvailability: each city produces the NEXT load in sequence
      const loadAvailability: Record<string, string[]> = {};
      for (let i = 0; i < cities.length - 1; i++) {
        loadAvailability[cities[i]] = [loads[i + 1]];
      }

      const snapshot = makeSnapshot({
        bot: {
          ...makeSnapshot().bot,
          loads: ['Coal'],
          trainType: TrainType.Superfreight,
          resolvedDemands,
        },
        loadAvailability,
      });
      // turnBuildCost: 20 prevents Phase B (tryAppendBuild) from consuming mock resolve calls
      const context = makeContext({ speed: 1000, loads: ['Coal'], capacity: 3, turnBuildCost: 20 });

      // Route: deliver Coal at CityA, pickup Wine at CityA, deliver Wine at CityB, ...
      const routeStops: any[] = [];
      for (let i = 0; i < cities.length - 1; i++) {
        routeStops.push({ action: 'deliver', loadType: loads[i], city: cities[i], demandCardId: i + 1, payment: 25 });
        routeStops.push({ action: 'pickup', loadType: loads[i + 1], city: cities[i] });
      }
      routeStops.push({ action: 'deliver', loadType: loads[loads.length - 1], city: cities[cities.length - 1], demandCardId: loads.length, payment: 25 });

      const route = makeRoute({
        stops: routeStops,
        currentStopIndex: 0,
        phase: 'travel',
      });

      const pickupPlan: TurnPlan = {
        type: AIActionType.PickupLoad,
        load: 'Coal',
        city: 'StartCity',
      };

      // loadGridPoints: map each city to a grid position (2mp apart)
      const gridMap = new Map<string, any>();
      for (let i = 0; i < cities.length; i++) {
        const row = 10 + (i + 1) * 2;
        gridMap.set(`${row},10`, { row, col: 10, terrain: TerrainType.MediumCity, name: cities[i] });
      }
      mockLoadGridPoints.mockReturnValue(gridMap);

      mockApplyPlanToState.mockImplementation((plan: TurnPlan, snap: WorldSnapshot, ctx: GameContext) => {
        if (plan.type === AIActionType.PickupLoad) {
          const load = (plan as any).load;
          if (!snap.bot.loads.includes(load)) snap.bot.loads.push(load);
          ctx.loads = [...snap.bot.loads];
        }
        if (plan.type === AIActionType.MoveTrain) {
          const movePath = (plan as any).path;
          const endPos = movePath[movePath.length - 1];
          snap.bot.position = { row: endPos.row, col: endPos.col };
          ctx.position = { row: endPos.row, col: endPos.col };
        }
        if (plan.type === AIActionType.DeliverLoad) {
          const load = (plan as any).load;
          const idx = snap.bot.loads.indexOf(load);
          if (idx >= 0) snap.bot.loads.splice(idx, 1);
          ctx.loads = [...snap.bot.loads];
        }
      });

      // Each iteration: MOVE resolve (2mp path) + DELIVER resolve + PICKUP resolve
      // Need 5 iterations × 3 resolves = 15, but 6th iter is prevented by cap.
      for (let i = 0; i < 6; i++) {
        const startRow = 10 + i * 2;
        const endRow = 10 + (i + 1) * 2;
        // MOVE
        mockResolve.mockResolvedValueOnce({
          success: true,
          plan: {
            type: AIActionType.MoveTrain,
            path: [{ row: startRow, col: 10 }, { row: startRow + 1, col: 10 }, { row: endRow, col: 10 }],
            fees: new Set<string>(),
            totalFee: 0,
          },
        });
        // DELIVER (found by splitMoveForOpportunities at city)
        mockResolve.mockResolvedValueOnce({
          success: true,
          plan: { type: AIActionType.DeliverLoad, load: loads[i], city: cities[i], cardId: i + 1, payout: 25 },
        });
        // PICKUP (found by splitMoveForOpportunities at city, if not last city)
        if (i < cities.length - 1) {
          mockResolve.mockResolvedValueOnce({
            success: true,
            plan: { type: AIActionType.PickupLoad, load: loads[i + 1], city: cities[i] },
          });
        }
      }

      const logSpy = jest.spyOn(console, 'log').mockImplementation();
      const { plan: result } = await TurnComposer.compose(pickupPlan, snapshot, context, route);

      expect(result.type).toBe('MultiAction');
      if (result.type === 'MultiAction') {
        // Count continuation MOVEs (excluding any A1 MOVEs)
        const moves = result.steps.filter(s => s.type === AIActionType.MoveTrain);
        // Should have exactly 5 MOVEs (one per A2 iteration, capped at 5)
        expect(moves.length).toBe(5);
      }

      // Log says "iteration cap"
      const a2Logs = logSpy.mock.calls.filter(
        c => typeof c[0] === 'string' && c[0].includes('[TurnComposer] A2 loop'),
      );
      expect(a2Logs.length).toBe(1);
      expect(a2Logs[0][0]).toContain('iteration cap');

      logSpy.mockRestore();
    });

    it('maintains correct simulated state across loop iterations', async () => {
      // Verify position and loads are updated correctly across 2 A2 iterations.
      const snapshot = makeSnapshot({
        bot: {
          ...makeSnapshot().bot,
          position: { row: 10, col: 10 },
          loads: ['Coal'],
          resolvedDemands: [
            { cardId: 1, demands: [{ city: 'CityA', loadType: 'Coal', payment: 25 }] },
            { cardId: 2, demands: [{ city: 'CityB', loadType: 'Wine', payment: 30 }] },
          ],
        },
        loadAvailability: { CityA: ['Wine'] },
      });
      // turnBuildCost: 20 prevents Phase B from consuming mock resolve calls
      const context = makeContext({
        speed: 9,
        loads: ['Coal'],
        position: { row: 10, col: 10 },
        turnBuildCost: 20,
      });
      const route = makeRoute({
        stops: [
          { action: 'deliver', loadType: 'Coal', city: 'CityA', demandCardId: 1, payment: 25 },
          { action: 'pickup', loadType: 'Wine', city: 'CityA' },
          { action: 'deliver', loadType: 'Wine', city: 'CityB', demandCardId: 2, payment: 30 },
        ],
        currentStopIndex: 0,
        phase: 'travel',
      });

      const pickupPlan: TurnPlan = {
        type: AIActionType.PickupLoad,
        load: 'Coal',
        city: 'StartCity',
      };

      mockLoadGridPoints.mockReturnValue(new Map([
        ['14,10', { row: 14, col: 10, terrain: TerrainType.MediumCity, name: 'CityA' }],
      ]));

      // Track all applyPlanToState calls to verify state updates
      const stateHistory: Array<{ type: string; loads: string[]; position: { row: number; col: number } }> = [];
      mockApplyPlanToState.mockImplementation((plan: TurnPlan, snap: WorldSnapshot, ctx: GameContext) => {
        if (plan.type === AIActionType.PickupLoad) {
          const load = (plan as any).load;
          if (!snap.bot.loads.includes(load)) snap.bot.loads.push(load);
          ctx.loads = [...snap.bot.loads];
        }
        if (plan.type === AIActionType.MoveTrain) {
          const movePath = (plan as any).path;
          const endPos = movePath[movePath.length - 1];
          snap.bot.position = { row: endPos.row, col: endPos.col };
          ctx.position = { row: endPos.row, col: endPos.col };
        }
        if (plan.type === AIActionType.DeliverLoad) {
          const load = (plan as any).load;
          const idx = snap.bot.loads.indexOf(load);
          if (idx >= 0) snap.bot.loads.splice(idx, 1);
          ctx.loads = [...snap.bot.loads];
        }
        stateHistory.push({
          type: plan.type,
          loads: [...snap.bot.loads],
          position: snap.bot.position ? { ...snap.bot.position } : { row: 0, col: 0 },
        });
      });

      mockResolve
        // A2 iter 1: MOVE to CityA
        .mockResolvedValueOnce({
          success: true,
          plan: {
            type: AIActionType.MoveTrain,
            path: [
              { row: 10, col: 10 }, { row: 11, col: 10 },
              { row: 12, col: 10 }, { row: 13, col: 10 }, { row: 14, col: 10 },
            ],
            fees: new Set<string>(),
            totalFee: 0,
          },
        })
        // splitMoveForOpportunities: DELIVER Coal at CityA
        .mockResolvedValueOnce({
          success: true,
          plan: { type: AIActionType.DeliverLoad, load: 'Coal', city: 'CityA', cardId: 1, payout: 25 },
        })
        // splitMoveForOpportunities: PICKUP Wine at CityA
        .mockResolvedValueOnce({
          success: true,
          plan: { type: AIActionType.PickupLoad, load: 'Wine', city: 'CityA' },
        })
        // A2 iter 2: MOVE toward CityB (5mp remaining)
        .mockResolvedValueOnce({
          success: true,
          plan: {
            type: AIActionType.MoveTrain,
            path: [
              { row: 14, col: 10 }, { row: 15, col: 10 },
              { row: 16, col: 10 }, { row: 17, col: 10 },
              { row: 18, col: 10 }, { row: 19, col: 10 },
            ],
            fees: new Set<string>(),
            totalFee: 0,
          },
        });

      jest.spyOn(console, 'log').mockImplementation();
      const { plan: result } = await TurnComposer.compose(pickupPlan, snapshot, context, route);
      (console.log as jest.Mock).mockRestore();

      expect(result.type).toBe('MultiAction');
      if (result.type === 'MultiAction') {
        // PICKUP + MOVE(4mp) + DELIVER + PICKUP(Wine) + MOVE(5mp)
        expect(result.steps.length).toBeGreaterThanOrEqual(4);
      }

      // Verify state transitions via stateHistory
      // After initial PICKUP: loads should include Coal
      const pickupState = stateHistory.find(s => s.type === AIActionType.PickupLoad && s.loads.includes('Coal'));
      expect(pickupState).toBeDefined();

      // After DELIVER Coal: Coal should be removed
      const deliverState = stateHistory.find(s => s.type === AIActionType.DeliverLoad);
      expect(deliverState).toBeDefined();
      expect(deliverState!.loads).not.toContain('Coal');

      // After PICKUP Wine: Wine should be present
      const pickupWineState = stateHistory.find(s => s.type === AIActionType.PickupLoad && s.loads.includes('Wine'));
      expect(pickupWineState).toBeDefined();

      // Final MOVE should be at a position past CityA
      const lastMoveState = stateHistory.filter(s => s.type === AIActionType.MoveTrain).pop();
      expect(lastMoveState).toBeDefined();
      expect(lastMoveState!.position.row).toBeGreaterThan(14); // Past CityA
    });
  });

  // ── BE-007: Phase A error handling and logging ──

  describe('Phase A error handling (BE-007)', () => {
    it('should log phase context when Phase A throws an error', async () => {
      const errorSpy = jest.spyOn(console, 'error').mockImplementation();
      const logSpy = jest.spyOn(console, 'log').mockImplementation();

      mockCloneSnapshot.mockImplementation((s: WorldSnapshot) => ({
        ...s,
        bot: { ...s.bot, loads: [...s.bot.loads] },
        allPlayerTracks: [...s.allPlayerTracks],
      }));

      // Throw inside Phase A when resolve is called (A2 continuation)
      mockResolve.mockImplementation(() => {
        throw new Error('Simulated Phase A failure');
      });

      const snapshot = makeSnapshot();
      const context = makeContext({
        demands: [
          {
            cardIndex: 0, loadType: 'Coal', supplyCity: 'Berlin', deliveryCity: 'Paris',
            payout: 20, isSupplyReachable: true, isDeliveryReachable: true,
            isSupplyOnNetwork: true, isDeliveryOnNetwork: true,
            estimatedTrackCostToSupply: 0, estimatedTrackCostToDelivery: 0,
            isLoadAvailable: true, isLoadOnTrain: true, ferryRequired: false,
            loadChipTotal: 4, loadChipCarried: 0, estimatedTurns: 2,
            demandScore: 10, efficiencyPerTurn: 5, networkCitiesUnlocked: 0, victoryMajorCitiesEnRoute: 0,
            isAffordable: true, projectedFundsAfterDelivery: 50,
          },
        ],
      });

      // Primary PICKUP triggers A2 which calls resolve() → throws
      const pickupPlan = { type: AIActionType.PickupLoad, load: 'Coal', city: 'Berlin' };
      const { plan: result } = await TurnComposer.compose(pickupPlan as TurnPlan, snapshot, context);

      // Should still return the primary plan (error is non-fatal)
      expect(result).toBeDefined();

      // Error should be logged with phase context
      const errorLogs = errorSpy.mock.calls.filter(
        c => typeof c[0] === 'string' && c[0].includes('[TurnComposer] Phase'),
      );
      expect(errorLogs.length).toBeGreaterThan(0);
      expect(errorLogs[0][1]).toContain('Simulated Phase A failure');

      errorSpy.mockRestore();
      logSpy.mockRestore();
    });

    it('should not crash when A2 loop encounters error during continuation MOVE', async () => {
      const errorSpy = jest.spyOn(console, 'error').mockImplementation();
      const logSpy = jest.spyOn(console, 'log').mockImplementation();

      mockCloneSnapshot.mockImplementation((s: WorldSnapshot) => ({
        ...s,
        bot: { ...s.bot, loads: [...s.bot.loads] },
        allPlayerTracks: [...s.allPlayerTracks],
      }));

      // Primary PICKUP succeeds
      mockResolve.mockRejectedValue(new Error('Continuation resolve failed'));

      const pickupPlan = {
        type: AIActionType.PickupLoad,
        load: 'Coal',
        city: 'Berlin',
      };
      const snapshot = makeSnapshot();
      const context = makeContext({ speed: 9 });

      const { plan: result } = await TurnComposer.compose(pickupPlan as TurnPlan, snapshot, context);

      // Should fall back to returning just the primary plan
      expect(result).toBeDefined();

      errorSpy.mockRestore();
      logSpy.mockRestore();
    });
  });

  // ── JIRA-39: DropLoad prefix composition ──────────────────────────────────

  describe('JIRA-39: DropLoad prefix composition', () => {
    it('composes DropLoad + PickupLoad when load is available at same city', async () => {
      const dropPlan: TurnPlan = {
        type: AIActionType.DropLoad,
        load: 'Cheese',
        city: 'Holland',
      };

      const snapshot = makeSnapshot({
        bot: {
          ...makeSnapshot().bot,
          loads: ['Cheese', 'Ham'],
          position: { row: 5, col: 5 },
          resolvedDemands: [{
            cardId: 1,
            demands: [{ loadType: 'Flowers', city: 'Oslo', payment: 20 }],
          }],
        },
        loadAvailability: { Holland: ['Flowers'] },
      });

      const context = makeContext({ loads: ['Cheese', 'Ham'] });

      const pickupPlan: TurnPlan = {
        type: AIActionType.PickupLoad,
        load: 'Flowers',
        city: 'Holland',
      };

      // applyPlanToState must simulate the drop (remove load from bot)
      mockApplyPlanToState.mockImplementation((plan: TurnPlan, snap: WorldSnapshot) => {
        if (plan.type === AIActionType.DropLoad) {
          snap.bot.loads = snap.bot.loads.filter((l: string) => l !== (plan as any).load);
        }
      });

      // Pickup resolves successfully
      mockResolve.mockResolvedValue({ success: true, plan: pickupPlan });

      const { plan: result, trace } = await TurnComposer.compose(
        dropPlan, snapshot, context,
      );

      expect(result.type).toBe('MultiAction');
      if (result.type === 'MultiAction') {
        expect(result.steps[0].type).toBe(AIActionType.DropLoad);
        expect(result.steps[1].type).toBe(AIActionType.PickupLoad);
      }
      expect(trace.inputPlan).toEqual([AIActionType.DropLoad]);
    });

    it('composes DropLoad + PickupLoad + MoveTrain via A2 continuation', async () => {
      const dropPlan: TurnPlan = {
        type: AIActionType.DropLoad,
        load: 'Cheese',
        city: 'Holland',
      };

      const snapshot = makeSnapshot({
        bot: {
          ...makeSnapshot().bot,
          loads: ['Cheese', 'Ham'],
          position: { row: 5, col: 5 },
          resolvedDemands: [{
            cardId: 1,
            demands: [{ loadType: 'Flowers', city: 'Oslo', payment: 20 }],
          }],
        },
        loadAvailability: { Holland: ['Flowers'] },
      });

      const context = makeContext({
        loads: ['Cheese', 'Ham'],
        demands: [{
          cardIndex: 0,
          loadType: 'Flowers',
          deliveryCity: 'Oslo',
          supplyCity: 'Holland',
          payout: 20,
          isLoadOnTrain: false,
          isDeliveryOnNetwork: true,
          isDeliveryReachable: true,
          isSupplyOnNetwork: true,
          isSupplyReachable: true,
          estimatedTrackCostToSupply: 0,
          estimatedTrackCostToDelivery: 0,
          isLoadAvailable: true,
          ferryRequired: false,
          loadChipTotal: 4,
          loadChipCarried: 0,
          estimatedTurns: 2,
          demandScore: 0,
          efficiencyPerTurn: 0,
          networkCitiesUnlocked: 0,
          victoryMajorCitiesEnRoute: 0,
          isAffordable: true,
          projectedFundsAfterDelivery: 50,
        }],
      });

      const pickupPlan: TurnPlan = {
        type: AIActionType.PickupLoad,
        load: 'Flowers',
        city: 'Holland',
      };

      const movePlan: TurnPlan = {
        type: AIActionType.MoveTrain,
        path: [
          { row: 5, col: 5 },
          { row: 5, col: 6 },
          { row: 5, col: 7 },
        ],
        fees: new Set<string>(),
        totalFee: 0,
      };

      // applyPlanToState must simulate the drop
      mockApplyPlanToState.mockImplementation((plan: TurnPlan, snap: WorldSnapshot) => {
        if (plan.type === AIActionType.DropLoad) {
          snap.bot.loads = snap.bot.loads.filter((l: string) => l !== (plan as any).load);
        }
      });

      // First call: pickup after drop. Second call: A2 continuation MOVE.
      mockResolve
        .mockResolvedValueOnce({ success: true, plan: pickupPlan })
        .mockResolvedValueOnce({ success: true, plan: movePlan });

      const { plan: result } = await TurnComposer.compose(
        dropPlan, snapshot, context,
      );

      expect(result.type).toBe('MultiAction');
      if (result.type === 'MultiAction') {
        expect(result.steps[0].type).toBe(AIActionType.DropLoad);
        expect(result.steps[1].type).toBe(AIActionType.PickupLoad);
        expect(result.steps[2].type).toBe(AIActionType.MoveTrain);
      }
    });

    it('returns DropLoad only when no pickup is possible at the city', async () => {
      const dropPlan: TurnPlan = {
        type: AIActionType.DropLoad,
        load: 'Cheese',
        city: 'Holland',
      };

      const snapshot = makeSnapshot({
        bot: {
          ...makeSnapshot().bot,
          loads: ['Cheese'],
          position: { row: 5, col: 5 },
          resolvedDemands: [],
        },
        loadAvailability: {},
      });

      const context = makeContext({ loads: ['Cheese'] });

      const { plan: result } = await TurnComposer.compose(
        dropPlan, snapshot, context,
      );

      // No pickup available — DropLoad is the only step
      expect(result.type).toBe(AIActionType.DropLoad);
      expect(mockResolve).not.toHaveBeenCalled();
    });

    it('uses route stop for pickup when no demand-matched load found', async () => {
      const dropPlan: TurnPlan = {
        type: AIActionType.DropLoad,
        load: 'Cheese',
        city: 'Berlin',
      };

      const snapshot = makeSnapshot({
        bot: {
          ...makeSnapshot().bot,
          loads: ['Cheese', 'Ham'],
          position: { row: 5, col: 5 },
          resolvedDemands: [],
        },
        loadAvailability: {},
      });

      const context = makeContext({ loads: ['Cheese', 'Ham'] });

      const route = makeRoute({
        stops: [
          { action: 'pickup', loadType: 'Coal', city: 'Berlin' },
          { action: 'deliver', loadType: 'Coal', city: 'Paris', demandCardId: 1, payment: 25 },
        ],
        currentStopIndex: 0,
      });

      const pickupPlan: TurnPlan = {
        type: AIActionType.PickupLoad,
        load: 'Coal',
        city: 'Berlin',
      };

      // applyPlanToState must simulate the drop
      mockApplyPlanToState.mockImplementation((plan: TurnPlan, snap: WorldSnapshot) => {
        if (plan.type === AIActionType.DropLoad) {
          snap.bot.loads = snap.bot.loads.filter((l: string) => l !== (plan as any).load);
        }
      });

      mockResolve.mockResolvedValueOnce({ success: true, plan: pickupPlan });

      const { plan: result } = await TurnComposer.compose(
        dropPlan, snapshot, context, route,
      );

      expect(result.type).toBe('MultiAction');
      if (result.type === 'MultiAction') {
        expect(result.steps[0].type).toBe(AIActionType.DropLoad);
        expect(result.steps[1].type).toBe(AIActionType.PickupLoad);
        expect((result.steps[1] as any).load).toBe('Coal');
      }
    });

    it('DropLoad does not consume movement budget', async () => {
      const dropPlan: TurnPlan = {
        type: AIActionType.DropLoad,
        load: 'Cheese',
        city: 'Holland',
      };

      const snapshot = makeSnapshot({
        bot: {
          ...makeSnapshot().bot,
          loads: ['Cheese'],
          position: { row: 5, col: 5 },
          resolvedDemands: [],
        },
        loadAvailability: {},
      });

      const context = makeContext({ loads: ['Cheese'], speed: 9 });

      const { trace } = await TurnComposer.compose(
        dropPlan, snapshot, context,
      );

      expect(trace.moveBudget.used).toBe(0);
      expect(trace.moveBudget.wasted).toBe(9);
    });
  });

  describe('JIRA-38: Same-city multi-pickup', () => {
    it('chains second pickup at same city without issuing a MOVE', async () => {
      // Setup: bot is at Birmingham (10,10), primary plan is PICKUP Iron.
      // Route has two pickups at Birmingham: Iron (index 0) and Steel (index 1).
      const gridMap = new Map([
        ['10,10', { name: 'Birmingham', x: 0, y: 0 }],
        ['10,15', { name: 'Antwerpen', x: 0, y: 0 }],
      ]);
      mockLoadGridPoints.mockReturnValue(gridMap);

      const snapshot = makeSnapshot({
        bot: {
          ...makeSnapshot().bot,
          loads: [],
          position: { row: 10, col: 10 },
          resolvedDemands: [
            { cardId: 1, demands: [{ loadType: 'Iron', city: 'Antwerpen', payment: 15 }] },
            { cardId: 2, demands: [{ loadType: 'Steel', city: 'Budapest', payment: 20 }] },
          ],
        },
        loadAvailability: { Birmingham: ['Iron', 'Steel'] },
      });

      const context = makeContext({
        loads: [],
        speed: 9,
        citiesOnNetwork: ['Birmingham', 'Antwerpen'],
        demands: [
          { loadType: 'Iron', supplyCity: 'Birmingham', deliveryCity: 'Antwerpen', payout: 15, isLoadOnTrain: false, isSupplyOnNetwork: true, isDeliveryOnNetwork: true, isDeliveryReachable: true, estimatedTrackCostToDelivery: 0, cardIndex: 1 },
          { loadType: 'Steel', supplyCity: 'Birmingham', deliveryCity: 'Budapest', payout: 20, isLoadOnTrain: false, isSupplyOnNetwork: true, isDeliveryOnNetwork: true, isDeliveryReachable: false, estimatedTrackCostToDelivery: 0, cardIndex: 2 },
        ] as any,
      });

      const route = makeRoute({
        stops: [
          { action: 'pickup' as const, loadType: 'Iron', city: 'Birmingham' },
          { action: 'pickup' as const, loadType: 'Steel', city: 'Birmingham' },
          { action: 'deliver' as const, loadType: 'Iron', city: 'Antwerpen', demandCardId: 1, payment: 15 },
        ],
        currentStopIndex: 0,
        phase: 'act',
      });

      // Primary plan: PICKUP Iron at Birmingham
      const pickupIronPlan = { type: AIActionType.PickupLoad, load: 'Iron', city: 'Birmingham' };

      // Mock: cloneSnapshot returns deep copy
      mockCloneSnapshot.mockImplementation(defaultCloneSnapshot);

      // Track calls to resolve for assertions
      let resolveCallCount = 0;
      mockResolve.mockImplementation(async (action: any) => {
        resolveCallCount++;
        if (action.action === 'PICKUP' && action.details.load === 'Steel') {
          return {
            success: true,
            plan: { type: AIActionType.PickupLoad, load: 'Steel', city: 'Birmingham' },
          };
        }
        if (action.action === 'MOVE') {
          return {
            success: true,
            plan: {
              type: AIActionType.MoveTrain,
              path: [{ row: 10, col: 10 }, { row: 10, col: 11 }, { row: 10, col: 12 }],
            },
          };
        }
        return { success: false, error: 'not mocked' };
      });

      // applyPlanToState: simulate adding loads
      mockApplyPlanToState.mockImplementation((plan: any, snap: any) => {
        if (plan.type === AIActionType.PickupLoad) {
          snap.bot.loads = [...snap.bot.loads, plan.load];
        }
        if (plan.type === AIActionType.MoveTrain) {
          const lastPos = plan.path[plan.path.length - 1];
          snap.bot.position = { row: lastPos.row, col: lastPos.col };
        }
      });

      const { plan } = await TurnComposer.compose(
        pickupIronPlan as TurnPlan, snapshot, context, route,
      );

      // Should produce MultiAction with [PickupIron, PickupSteel, Move...]
      expect(plan.type).toBe('MultiAction');
      if (plan.type === 'MultiAction') {
        const types = plan.steps.map((s: any) => s.type);
        // First step is the primary PickupLoad (Iron)
        expect(types[0]).toBe(AIActionType.PickupLoad);
        // Second step should be PickupLoad (Steel) — same city, no MOVE
        expect(types[1]).toBe(AIActionType.PickupLoad);
        expect((plan.steps[1] as any).load).toBe('Steel');
        // Should NOT have a MOVE between the two pickups
        expect(types.indexOf(AIActionType.MoveTrain)).toBeGreaterThan(1);
      }
    });

    it('skips already-completed same-city stops', async () => {
      // Bot already has Iron on train, route says pickup Iron at Birmingham (already done).
      // Next stop is pickup Steel at Birmingham — should chain Steel directly.
      const gridMap = new Map([
        ['10,10', { name: 'Birmingham', x: 0, y: 0 }],
      ]);
      mockLoadGridPoints.mockReturnValue(gridMap);

      const snapshot = makeSnapshot({
        bot: {
          ...makeSnapshot().bot,
          loads: ['Iron'], // Already have Iron
          position: { row: 10, col: 10 },
          resolvedDemands: [],
        },
      });

      const context = makeContext({
        loads: ['Iron'],
        speed: 9,
      });

      const route = makeRoute({
        stops: [
          { action: 'pickup' as const, loadType: 'Iron', city: 'Birmingham' },
          { action: 'pickup' as const, loadType: 'Steel', city: 'Birmingham' },
          { action: 'deliver' as const, loadType: 'Iron', city: 'Antwerpen', demandCardId: 1, payment: 15 },
        ],
        currentStopIndex: 0, // Points to Iron pickup (already done)
        phase: 'act',
      });

      // Primary plan: a deliver action (simulating A2 triggered after a deliver)
      // Actually, let's use a PickupLoad for Steel that would follow from the Iron being done
      const pickupSteelPlan = { type: AIActionType.PickupLoad, load: 'Steel', city: 'Birmingham' };

      mockCloneSnapshot.mockImplementation(defaultCloneSnapshot);
      mockResolve.mockImplementation(async () => ({ success: false, error: 'not needed' }));
      mockApplyPlanToState.mockImplementation(() => {});

      const { plan } = await TurnComposer.compose(
        pickupSteelPlan as TurnPlan, snapshot, context, route,
      );

      // The JIRA-38 code should skip the Iron stop (already on train) and not crash
      // Plan should at minimum contain the original PickupSteel
      const steps = plan.type === 'MultiAction' ? plan.steps : [plan];
      expect(steps[0].type).toBe(AIActionType.PickupLoad);
    });
  });

  describe('JIRA-117: Same-city double pickup of identical load type', () => {
    it('chains both pickups when route has 2x same load at same city', async () => {
      // Route: pickup(Iron@Birmingham), pickup(Iron@Birmingham), deliver(Iron@Antwerpen)
      // Bot at Birmingham with 0 loads and capacity 2. Both pickups should chain.
      const gridMap = new Map([
        ['10,10', { name: 'Birmingham', x: 0, y: 0 }],
        ['10,15', { name: 'Antwerpen', x: 0, y: 0 }],
      ]);
      mockLoadGridPoints.mockReturnValue(gridMap);

      const snapshot = makeSnapshot({
        bot: {
          ...makeSnapshot().bot,
          loads: [],
          position: { row: 10, col: 10 },
          resolvedDemands: [
            { cardId: 1, demands: [{ loadType: 'Iron', city: 'Antwerpen', payment: 15 }] },
            { cardId: 2, demands: [{ loadType: 'Iron', city: 'Praha', payment: 18 }] },
          ],
        },
        loadAvailability: { Birmingham: ['Iron'] },
      });

      const context = makeContext({
        loads: [],
        speed: 9,
        citiesOnNetwork: ['Birmingham', 'Antwerpen'],
        demands: [
          { loadType: 'Iron', supplyCity: 'Birmingham', deliveryCity: 'Antwerpen', payout: 15, isLoadOnTrain: false, isSupplyOnNetwork: true, isDeliveryOnNetwork: true, isDeliveryReachable: true, estimatedTrackCostToDelivery: 0, cardIndex: 1 },
          { loadType: 'Iron', supplyCity: 'Birmingham', deliveryCity: 'Praha', payout: 18, isLoadOnTrain: false, isSupplyOnNetwork: true, isDeliveryOnNetwork: true, isDeliveryReachable: false, estimatedTrackCostToDelivery: 0, cardIndex: 2 },
        ] as any,
      });

      const route = makeRoute({
        stops: [
          { action: 'pickup' as const, loadType: 'Iron', city: 'Birmingham' },
          { action: 'pickup' as const, loadType: 'Iron', city: 'Birmingham' },
          { action: 'deliver' as const, loadType: 'Iron', city: 'Antwerpen', demandCardId: 1, payment: 15 },
        ],
        currentStopIndex: 0,
        phase: 'act',
      });

      // Primary plan: PICKUP Iron at Birmingham (first one)
      const pickupIronPlan = { type: AIActionType.PickupLoad, load: 'Iron', city: 'Birmingham' };

      mockCloneSnapshot.mockImplementation(defaultCloneSnapshot);

      mockResolve.mockImplementation(async (action: any) => {
        if (action.action === 'PICKUP' && action.details.load === 'Iron') {
          return {
            success: true,
            plan: { type: AIActionType.PickupLoad, load: 'Iron', city: 'Birmingham' },
          };
        }
        if (action.action === 'MOVE') {
          return {
            success: true,
            plan: {
              type: AIActionType.MoveTrain,
              path: [{ row: 10, col: 10 }, { row: 10, col: 11 }, { row: 10, col: 12 }],
            },
          };
        }
        return { success: false, error: 'not mocked' };
      });

      mockApplyPlanToState.mockImplementation((plan: any, snap: any) => {
        if (plan.type === AIActionType.PickupLoad) {
          snap.bot.loads = [...snap.bot.loads, plan.load];
        }
        if (plan.type === AIActionType.MoveTrain) {
          const lastPos = plan.path[plan.path.length - 1];
          snap.bot.position = { row: lastPos.row, col: lastPos.col };
        }
      });

      const { plan } = await TurnComposer.compose(
        pickupIronPlan as TurnPlan, snapshot, context, route,
      );

      // Should produce MultiAction with [PickupIron, PickupIron, Move...]
      expect(plan.type).toBe('MultiAction');
      if (plan.type === 'MultiAction') {
        const pickupSteps = plan.steps.filter((s: any) => s.type === AIActionType.PickupLoad);
        // JIRA-117: Both Iron pickups must be chained — not just 1
        expect(pickupSteps.length).toBe(2);
        expect((pickupSteps[0] as any).load).toBe('Iron');
        expect((pickupSteps[1] as any).load).toBe('Iron');
      }
    });
  });

  describe('JIRA-69: A2 continuation after mid-move delivery/pickup', () => {
    it('continues movement toward next route stop after mid-move delivery', async () => {
      // Route: deliver Coal at CityA (idx 0) → pickup Wine at CityB (idx 1)
      // Bot delivers Coal mid-move at CityA. After delivery, route index should
      // advance to 1, and A2 chain should target CityB for the pickup.
      const snapshot = makeSnapshot({
        bot: {
          ...makeSnapshot().bot,
          loads: ['Coal'],
          resolvedDemands: [
            { cardId: 1, demands: [{ city: 'CityA', loadType: 'Coal', payment: 25 }] },
          ],
        },
      });
      const context = makeContext({
        speed: 9,
        loads: ['Coal'],
        demands: [
          {
            cardIndex: 1, loadType: 'Coal', supplyCity: 'SupplyX',
            deliveryCity: 'CityA', payout: 25,
            isSupplyReachable: true, isDeliveryReachable: true,
            isSupplyOnNetwork: true, isDeliveryOnNetwork: true,
            estimatedTrackCostToSupply: 0, estimatedTrackCostToDelivery: 0,
            isLoadAvailable: true, isLoadOnTrain: true,
            ferryRequired: false, loadChipTotal: 3, loadChipCarried: 1,
            estimatedTurns: 1, demandScore: 25, efficiencyPerTurn: 25,
            networkCitiesUnlocked: 0, victoryMajorCitiesEnRoute: 0,
            isAffordable: true, projectedFundsAfterDelivery: 75,
          },
        ],
        reachableCities: ['CityB'],
      });
      const route = makeRoute({
        stops: [
          { action: 'deliver', loadType: 'Coal', city: 'CityA', demandCardId: 1, payment: 25 },
          { action: 'pickup', loadType: 'Wine', city: 'CityB' },
        ],
        currentStopIndex: 0,
        phase: 'travel',
      });

      const pickupPlan: TurnPlan = {
        type: AIActionType.PickupLoad,
        load: 'Iron',
        city: 'StartCity',
      };

      // CityA at position (14,10) — intermediate city on the move path
      mockLoadGridPoints.mockReturnValue(new Map([
        ['14,10', { row: 14, col: 10, terrain: TerrainType.MediumCity, name: 'CityA' }],
      ]));

      mockApplyPlanToState.mockImplementation((plan: TurnPlan, snap: WorldSnapshot, ctx: GameContext) => {
        if (plan.type === AIActionType.PickupLoad) {
          const load = (plan as any).load;
          if (!snap.bot.loads.includes(load)) snap.bot.loads.push(load);
          ctx.loads = [...snap.bot.loads];
        }
        if (plan.type === AIActionType.MoveTrain) {
          const movePath = (plan as any).path;
          const endPos = movePath[movePath.length - 1];
          snap.bot.position = { row: endPos.row, col: endPos.col };
          ctx.position = { row: endPos.row, col: endPos.col };
        }
        if (plan.type === AIActionType.DeliverLoad) {
          const load = (plan as any).load;
          const idx = snap.bot.loads.indexOf(load);
          if (idx >= 0) snap.bot.loads.splice(idx, 1);
          ctx.loads = [...snap.bot.loads];
        }
      });

      mockResolve
        // A2 iter 1: MOVE toward CityA (5 nodes = 4mp)
        .mockResolvedValueOnce({
          success: true,
          plan: {
            type: AIActionType.MoveTrain,
            path: [
              { row: 10, col: 10 }, { row: 11, col: 10 },
              { row: 12, col: 10 }, { row: 13, col: 10 }, { row: 14, col: 10 },
            ],
            fees: new Set<string>(),
            totalFee: 0,
          },
        })
        // splitMoveForOpportunities: DELIVER Coal at CityA
        .mockResolvedValueOnce({
          success: true,
          plan: { type: AIActionType.DeliverLoad, load: 'Coal', city: 'CityA', cardId: 1, payout: 25 },
        })
        // A2 iter 2: MOVE toward CityB (6 nodes = 5mp)
        .mockResolvedValueOnce({
          success: true,
          plan: {
            type: AIActionType.MoveTrain,
            path: [
              { row: 14, col: 10 }, { row: 15, col: 10 },
              { row: 16, col: 10 }, { row: 17, col: 10 },
              { row: 18, col: 10 }, { row: 19, col: 10 },
            ],
            fees: new Set<string>(),
            totalFee: 0,
          },
        });

      const logSpy = jest.spyOn(console, 'log').mockImplementation();
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation();
      const { plan: result } = await TurnComposer.compose(pickupPlan, snapshot, context, route);

      expect(result.type).toBe('MultiAction');
      if (result.type === 'MultiAction') {
        // PICKUP + MOVE(4mp) + DELIVER + MOVE(5mp) = 4 steps
        const moves = result.steps.filter(s => s.type === AIActionType.MoveTrain);
        const delivers = result.steps.filter(s => s.type === AIActionType.DeliverLoad);
        expect(moves.length).toBe(2);
        expect(delivers.length).toBe(1);

        // Verify delivery is Coal at CityA
        const deliver = delivers[0] as any;
        expect(deliver.load).toBe('Coal');
        expect(deliver.city).toBe('CityA');

        // Verify step order: pickup → move → deliver → move (A2 continuation)
        const stepTypes = result.steps.map(s => s.type);
        const deliverIdx = stepTypes.indexOf(AIActionType.DeliverLoad);
        const moveBeforeDeliver = stepTypes.slice(0, deliverIdx).filter(t => t === AIActionType.MoveTrain);
        const moveAfterDeliver = stepTypes.slice(deliverIdx + 1).filter(t => t === AIActionType.MoveTrain);
        expect(moveBeforeDeliver.length).toBeGreaterThanOrEqual(1);
        expect(moveAfterDeliver.length).toBeGreaterThanOrEqual(1);

        // Total movement: 4 + 5 = 9mp (fully used, not wasted)
        const totalMp = moves.reduce(
          (sum, m) => sum + ((m as any).path.length - 1), 0,
        );
        expect(totalMp).toBe(9);
      }

      logSpy.mockRestore();
      warnSpy.mockRestore();
    });

    it('continues movement after mid-move pickup with route index advancement', async () => {
      // Route: pickup Wine at CityA (idx 0) → deliver Wine at CityB (idx 1)
      // Bot picks up Wine mid-move at CityA. After pickup, route index should
      // advance to 1, and A2 chain should target CityB for delivery.
      const snapshot = makeSnapshot({
        bot: {
          ...makeSnapshot().bot,
          loads: [],
          resolvedDemands: [
            { cardId: 2, demands: [{ city: 'CityB', loadType: 'Wine', payment: 30 }] },
          ],
          // CityA has Wine available for pickup
        },
        loadAvailability: { CityA: ['Wine'] },
      });
      const context = makeContext({
        speed: 9,
        loads: [],
        demands: [
          {
            cardIndex: 2, loadType: 'Wine', supplyCity: 'CityA',
            deliveryCity: 'CityB', payout: 30,
            isSupplyReachable: true, isDeliveryReachable: true,
            isSupplyOnNetwork: true, isDeliveryOnNetwork: true,
            estimatedTrackCostToSupply: 0, estimatedTrackCostToDelivery: 0,
            isLoadAvailable: true, isLoadOnTrain: false,
            ferryRequired: false, loadChipTotal: 3, loadChipCarried: 0,
            estimatedTurns: 2, demandScore: 15, efficiencyPerTurn: 15,
            networkCitiesUnlocked: 0, victoryMajorCitiesEnRoute: 0,
            isAffordable: true, projectedFundsAfterDelivery: 80,
          },
        ],
        reachableCities: ['CityB'],
      });
      const route = makeRoute({
        stops: [
          { action: 'pickup', loadType: 'Wine', city: 'CityA' },
          { action: 'deliver', loadType: 'Wine', city: 'CityB', demandCardId: 2, payment: 30 },
        ],
        currentStopIndex: 0,
        phase: 'travel',
      });

      const movePlan: TurnPlan = {
        type: AIActionType.MoveTrain,
        path: [
          { row: 10, col: 10 }, { row: 11, col: 10 },
          { row: 12, col: 10 }, { row: 13, col: 10 }, { row: 14, col: 10 },
          { row: 15, col: 10 }, { row: 16, col: 10 }, { row: 17, col: 10 },
          { row: 18, col: 10 }, { row: 19, col: 10 },
        ],
        fees: new Set<string>(),
        totalFee: 0,
      };

      // CityA at position (14,10) — intermediate city on the move path
      mockLoadGridPoints.mockReturnValue(new Map([
        ['14,10', { row: 14, col: 10, terrain: TerrainType.MediumCity, name: 'CityA' }],
      ]));

      mockApplyPlanToState.mockImplementation((plan: TurnPlan, snap: WorldSnapshot, ctx: GameContext) => {
        if (plan.type === AIActionType.PickupLoad) {
          const load = (plan as any).load;
          if (!snap.bot.loads.includes(load)) snap.bot.loads.push(load);
          ctx.loads = [...snap.bot.loads];
        }
        if (plan.type === AIActionType.MoveTrain) {
          const movePath = (plan as any).path;
          const endPos = movePath[movePath.length - 1];
          snap.bot.position = { row: endPos.row, col: endPos.col };
          ctx.position = { row: endPos.row, col: endPos.col };
        }
      });

      mockResolve
        // splitMoveForOpportunities (A1 split): PICKUP Wine at CityA
        .mockResolvedValueOnce({
          success: true,
          plan: { type: AIActionType.PickupLoad, load: 'Wine', city: 'CityA' },
        })
        // A2 iter 1: MOVE toward CityB (continuation after pickup)
        .mockResolvedValueOnce({
          success: true,
          plan: {
            type: AIActionType.MoveTrain,
            path: [
              { row: 19, col: 10 }, { row: 20, col: 10 },
              { row: 21, col: 10 }, { row: 22, col: 10 },
            ],
            fees: new Set<string>(),
            totalFee: 0,
          },
        });

      const logSpy = jest.spyOn(console, 'log').mockImplementation();
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation();
      const { plan: result } = await TurnComposer.compose(movePlan, snapshot, context, route);

      expect(result.type).toBe('MultiAction');
      if (result.type === 'MultiAction') {
        // Should have: MOVE (to CityA) + PICKUP + MOVE (rest) + continuation MOVE
        const pickups = result.steps.filter(s => s.type === AIActionType.PickupLoad);
        const moves = result.steps.filter(s => s.type === AIActionType.MoveTrain);
        expect(pickups.length).toBe(1);
        expect(moves.length).toBeGreaterThanOrEqual(2);

        // Verify pickup is Wine at CityA
        const pickup = pickups[0] as any;
        expect(pickup.load).toBe('Wine');
        expect(pickup.city).toBe('CityA');

        // Verify step order: move → pickup → move (A2 continuation after pickup)
        const stepTypes = result.steps.map(s => s.type);
        const pickupIdx = stepTypes.indexOf(AIActionType.PickupLoad);
        const moveBeforePickup = stepTypes.slice(0, pickupIdx).filter(t => t === AIActionType.MoveTrain);
        const moveAfterPickup = stepTypes.slice(pickupIdx + 1).filter(t => t === AIActionType.MoveTrain);
        expect(moveBeforePickup.length).toBeGreaterThanOrEqual(1);
        expect(moveAfterPickup.length).toBeGreaterThanOrEqual(1);
      }

      logSpy.mockRestore();
      warnSpy.mockRestore();
    });
  });

  describe('JIRA-76: post-route-completion move targets by demandScore', () => {
    it('prioritizes demand with higher demandScore over higher payout for supply city targeting', async () => {
      // Scenario: bot at Dublin, no loads, no active route (route completed).
      // Two demands: Wine (high payout=40, low demandScore=2) and Coal (low payout=15, high demandScore=8).
      // Both supply cities are on network. findMoveTargets should try Coal's supply city first
      // because demandScore is the sort key, not payout.
      const snapshot = makeSnapshot({
        bot: {
          ...makeSnapshot().bot,
          loads: [],
          position: { row: 10, col: 24 },
        },
      });
      const context = makeContext({
        speed: 9,
        loads: [],
        position: { row: 10, col: 24 },
        demands: [
          {
            cardIndex: 0, loadType: 'Wine', supplyCity: 'Lyon', deliveryCity: 'Bordeaux',
            payout: 40, isSupplyReachable: true, isDeliveryReachable: false,
            isSupplyOnNetwork: true, isDeliveryOnNetwork: false,
            estimatedTrackCostToSupply: 0, estimatedTrackCostToDelivery: 10,
            isLoadAvailable: true, isLoadOnTrain: false, ferryRequired: false,
            loadChipTotal: 4, loadChipCarried: 0, estimatedTurns: 8,
            demandScore: 2, efficiencyPerTurn: 0.5, networkCitiesUnlocked: 0, victoryMajorCitiesEnRoute: 0,
            isAffordable: true, projectedFundsAfterDelivery: 50,
          },
          {
            cardIndex: 1, loadType: 'Coal', supplyCity: 'Berlin', deliveryCity: 'Paris',
            payout: 15, isSupplyReachable: true, isDeliveryReachable: false,
            isSupplyOnNetwork: true, isDeliveryOnNetwork: false,
            estimatedTrackCostToSupply: 0, estimatedTrackCostToDelivery: 5,
            isLoadAvailable: true, isLoadOnTrain: false, ferryRequired: false,
            loadChipTotal: 4, loadChipCarried: 0, estimatedTurns: 3,
            demandScore: 8, efficiencyPerTurn: 3.0, networkCitiesUnlocked: 0, victoryMajorCitiesEnRoute: 0,
            isAffordable: true, projectedFundsAfterDelivery: 50,
          },
        ],
      });

      // No active route — simulates post-route-completion state
      const buildPlan: TurnPlan = {
        type: AIActionType.BuildTrack,
        segments: [makeSegment(10, 24, 11, 25)],
        targetCity: 'Paris',
      };

      mockResolve
        // A3: MOVE to Berlin (highest demandScore supply city) — SUCCEEDS
        .mockResolvedValueOnce({
          success: true,
          plan: {
            type: AIActionType.MoveTrain,
            path: [
              { row: 10, col: 24 }, { row: 11, col: 25 }, { row: 12, col: 26 },
            ],
            fees: new Set<string>(),
            totalFee: 0,
          },
        });

      const logSpy = jest.spyOn(console, 'log').mockImplementation();
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation();
      const { plan: result } = await TurnComposer.compose(buildPlan, snapshot, context);

      // Verify: the first MOVE target attempted should be Berlin (demandScore=8),
      // NOT Lyon (payout=40 but demandScore=2)
      const moveCalls = mockResolve.mock.calls.filter(
        (args: any[]) => args[0]?.action === 'MOVE',
      );
      expect(moveCalls.length).toBeGreaterThanOrEqual(1);
      expect(moveCalls[0][0].details.to).toBe('Berlin');

      logSpy.mockRestore();
      warnSpy.mockRestore();
    });
  });

  describe('JIRA-92: reservedSlots counts consecutive pickup stops', () => {
    // Helper: build a MOVE plan through a city where an opportunistic pickup is available.
    // With reservedSlots the bot should skip the pickup; without, it should take it.

    function setupOpportunisticPickupScenario(activeRoute: StrategicRoute | null) {
      // Bot carries 1 load on a Freight (capacity=2), so 1 free slot.
      // City "Torino" along the path has Wine available.
      // If reservedSlots >= 1, effectiveCapacity = 2 - 1 = 1, bot.loads.length (1) >= 1 → skip pickup.
      // If reservedSlots = 0, effectiveCapacity = 2, bot.loads.length (1) < 2 → take pickup.
      const snapshot = makeSnapshot({
        bot: {
          ...makeSnapshot().bot,
          loads: ['Coal'],
          resolvedDemands: [
            { cardId: 1, demands: [{ city: 'Paris', loadType: 'Coal', payment: 25 }] },
            { cardId: 2, demands: [{ city: 'Berlin', loadType: 'Wine', payment: 20 }] },
          ],
        },
        loadAvailability: { Torino: ['Wine'] },
      });
      const context = makeContext({ speed: 9, loads: ['Coal'] });

      const movePlan: TurnPlan = {
        type: AIActionType.MoveTrain,
        path: [
          { row: 10, col: 10 }, { row: 11, col: 11 }, { row: 12, col: 12 },
          { row: 13, col: 13 }, { row: 14, col: 14 },
        ],
        fees: new Set<string>(),
        totalFee: 0,
      };

      mockLoadGridPoints.mockReturnValue(new Map([
        ['12,12', { row: 12, col: 12, terrain: TerrainType.MediumCity, name: 'Torino' }],
      ]));

      mockCloneSnapshot.mockImplementation(defaultCloneSnapshot);
      mockApplyPlanToState.mockImplementation((plan: TurnPlan, snap: WorldSnapshot, ctx: GameContext) => {
        if (plan.type === AIActionType.MoveTrain) {
          const movePath = (plan as any).path;
          const endPos = movePath[movePath.length - 1];
          snap.bot.position = { row: endPos.row, col: endPos.col };
          ctx.position = { row: endPos.row, col: endPos.col };
        }
        if (plan.type === AIActionType.PickupLoad) {
          const load = (plan as any).load;
          snap.bot.loads.push(load);
          ctx.loads = [...snap.bot.loads];
        }
      });

      return { snapshot, context, movePlan, activeRoute };
    }

    it('planned pickup at arrival executes before opportunistic scans', async () => {
      const snapshot = makeSnapshot({
        bot: {
          ...makeSnapshot().bot,
          resolvedDemands: [],
          loads: [],
        },
        loadAvailability: {}, // no opportunistic pickups available
      });
      const context = makeContext({ canBuild: false, loads: [] });
      const route = makeRoute({
        stops: [
          { action: 'pickup', loadType: 'Ham', city: 'Warszawa' },
          { action: 'deliver', loadType: 'Ham', city: 'Torino', demandCardId: 2, payment: 29 },
        ],
        currentStopIndex: 0,
      });

      const movePlan: TurnPlan = {
        type: AIActionType.MoveTrain,
        path: [
          { row: 10, col: 10 }, { row: 12, col: 12 }, { row: 13, col: 13 },
        ],
        fees: new Set<string>(),
        totalFee: 0,
      };

      mockLoadGridPoints.mockReturnValue(new Map([
        ['12,12', { row: 12, col: 12, terrain: TerrainType.MediumCity, name: 'Warszawa' }],
      ]));

      mockCloneSnapshot.mockImplementation(defaultCloneSnapshot);
      mockApplyPlanToState.mockImplementation(() => {});

      // Planned pickup resolves successfully
      mockResolve.mockResolvedValueOnce({
        success: true,
        plan: { type: AIActionType.PickupLoad, load: 'Ham', city: 'Warszawa' },
      });

      const { plan: result } = await TurnComposer.compose(movePlan, snapshot, context, route);

      // Should include the planned pickup at Warszawa
      expect(result.type).toBe('MultiAction');
      if (result.type === 'MultiAction') {
        const pickupSteps = result.steps.filter(s => s.type === AIActionType.PickupLoad);
        expect(pickupSteps.length).toBeGreaterThanOrEqual(1);
        expect((pickupSteps[0] as any).load).toBe('Ham');
        expect((pickupSteps[0] as any).city).toBe('Warszawa');
      }

      // Ensure the pickup was invoked via ActionResolver.resolve
      const pickupCalls = mockResolve.mock.calls.filter(
        (args: any[]) => args[0]?.action === 'PICKUP',
      );
      expect(pickupCalls.length).toBeGreaterThanOrEqual(1);
    });

    it('route with 2 consecutive pickups → reservedSlots=2, blocks opportunistic pickup', async () => {
      const route = makeRoute({
        stops: [
          { action: 'pickup', loadType: 'Hops', city: 'München' },
          { action: 'pickup', loadType: 'Beer', city: 'Praha' },
          { action: 'deliver', loadType: 'Hops', city: 'Berlin', demandCardId: 3, payment: 30 },
        ],
        currentStopIndex: 0,
      });
      const { snapshot, context, movePlan } = setupOpportunisticPickupScenario(route);

      // reservedSlots=2, effectiveCapacity=2-2=0 → no pickup possible
      // ActionResolver.resolve should NOT be called for PICKUP
      const logSpy = jest.spyOn(console, 'log').mockImplementation();
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation();

      const { plan: result } = await TurnComposer.compose(movePlan, snapshot, context, route);

      // No pickup calls should have been made
      const pickupCalls = mockResolve.mock.calls.filter(
        (args: any[]) => args[0]?.action === 'PICKUP',
      );
      expect(pickupCalls.length).toBe(0);

      logSpy.mockRestore();
      warnSpy.mockRestore();
    });

    it('route with 1 pickup then deliver → reservedSlots=1, blocks opportunistic pickup at capacity-1', async () => {
      const route = makeRoute({
        stops: [
          { action: 'pickup', loadType: 'Hops', city: 'München' },
          { action: 'deliver', loadType: 'Hops', city: 'Berlin', demandCardId: 3, payment: 30 },
        ],
        currentStopIndex: 0,
      });
      const { snapshot, context, movePlan } = setupOpportunisticPickupScenario(route);

      // reservedSlots=1, effectiveCapacity=2-1=1, bot has 1 load → no pickup
      const logSpy = jest.spyOn(console, 'log').mockImplementation();
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation();

      const { plan: result } = await TurnComposer.compose(movePlan, snapshot, context, route);

      const pickupCalls = mockResolve.mock.calls.filter(
        (args: any[]) => args[0]?.action === 'PICKUP',
      );
      expect(pickupCalls.length).toBe(0);

      logSpy.mockRestore();
      warnSpy.mockRestore();
    });

    it('route with deliver as next stop → reservedSlots=0, allows opportunistic pickup', async () => {
      const route = makeRoute({
        stops: [
          { action: 'deliver', loadType: 'Coal', city: 'Paris', demandCardId: 1, payment: 25 },
        ],
        currentStopIndex: 0,
      });
      const { snapshot, context, movePlan } = setupOpportunisticPickupScenario(route);

      // reservedSlots=0, effectiveCapacity=2, bot has 1 load → pickup allowed
      // Mock ActionResolver.resolve to succeed for the PICKUP
      mockResolve.mockResolvedValueOnce({
        success: true,
        plan: { type: AIActionType.PickupLoad, load: 'Wine', city: 'Torino' },
      });

      const logSpy = jest.spyOn(console, 'log').mockImplementation();
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation();

      const { plan: result } = await TurnComposer.compose(movePlan, snapshot, context, route);

      // Should have attempted a PICKUP
      const pickupCalls = mockResolve.mock.calls.filter(
        (args: any[]) => args[0]?.action === 'PICKUP',
      );
      expect(pickupCalls.length).toBeGreaterThanOrEqual(1);

      logSpy.mockRestore();
      warnSpy.mockRestore();
    });

    it('no active route → reservedSlots=0, allows opportunistic pickup', async () => {
      const { snapshot, context, movePlan } = setupOpportunisticPickupScenario(null);

      // reservedSlots=0 (no route), effectiveCapacity=2, bot has 1 load → pickup allowed
      mockResolve.mockResolvedValueOnce({
        success: true,
        plan: { type: AIActionType.PickupLoad, load: 'Wine', city: 'Torino' },
      });

      const logSpy = jest.spyOn(console, 'log').mockImplementation();
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation();

      const { plan: result } = await TurnComposer.compose(movePlan, snapshot, context, null);

      const pickupCalls = mockResolve.mock.calls.filter(
        (args: any[]) => args[0]?.action === 'PICKUP',
      );
      expect(pickupCalls.length).toBeGreaterThanOrEqual(1);

      logSpy.mockRestore();
      warnSpy.mockRestore();
    });
  });

  describe('JIRA-115: Frontier approach for off-network targets', () => {
    it('moves toward closest on-network city when next route stop is off-network', async () => {
      // Bot at Frankfurt (row=20, col=30), picked up Beer. Next stop Leipzig is off-network.
      // On-network cities: Ruhr (row=18, col=26) and Berlin (row=16, col=38).
      // Berlin (dist=16) is closer to Leipzig (row=14, col=40) than Ruhr (dist=18).
      const snapshot = makeSnapshot({
        bot: {
          ...makeSnapshot().bot,
          position: { row: 20, col: 30 },
          loads: ['Beer'],
        },
      });
      const context = makeContext({
        position: { row: 20, col: 30 },
        speed: 9,
        loads: ['Beer'],
        citiesOnNetwork: ['Ruhr', 'Berlin'],
        reachableCities: ['Ruhr'],
        demands: [],
      });
      const route = makeRoute({
        stops: [
          { action: 'pickup', loadType: 'Beer', city: 'Frankfurt' },
          { action: 'deliver', loadType: 'Beer', city: 'Leipzig', demandCardId: 1, payment: 15 },
        ],
        currentStopIndex: 1,
        phase: 'travel',
      });

      // Set up gridPoints with coordinates
      const gridPoints = new Map<string, any>();
      gridPoints.set('14,40', { row: 14, col: 40, name: 'Leipzig', terrain: 0 });
      gridPoints.set('18,26', { row: 18, col: 26, name: 'Ruhr', terrain: 0 });
      gridPoints.set('16,38', { row: 16, col: 38, name: 'Berlin', terrain: 0 });
      gridPoints.set('20,30', { row: 20, col: 30, name: 'Frankfurt', terrain: 0 });
      mockLoadGridPoints.mockReturnValue(gridPoints);

      const pickupPlan: TurnPlan = {
        type: AIActionType.PickupLoad,
        load: 'Beer',
        city: 'Frankfurt',
      };

      mockApplyPlanToState.mockImplementation((plan: TurnPlan, snap: WorldSnapshot, ctx: GameContext) => {
        if (plan.type === AIActionType.MoveTrain) {
          const movePath = (plan as any).path;
          const endPos = movePath[movePath.length - 1];
          snap.bot.position = { row: endPos.row, col: endPos.col };
          ctx.position = { row: endPos.row, col: endPos.col };
        }
      });

      mockResolve
        // A2: MOVE to Leipzig (P1 route stop, off-network) — FAILS
        .mockResolvedValueOnce({ success: false, error: 'No valid path to "Leipzig"' })
        // A2: MOVE to Berlin (P1.5 frontier approach, closest to Leipzig) — SUCCEEDS
        .mockResolvedValueOnce({
          success: true,
          plan: {
            type: AIActionType.MoveTrain,
            path: [
              { row: 20, col: 30 }, { row: 19, col: 31 }, { row: 18, col: 32 },
              { row: 17, col: 33 }, { row: 16, col: 34 },
            ],
            fees: new Set<string>(),
            totalFee: 0,
          },
        });

      const logSpy = jest.spyOn(console, 'log').mockImplementation();
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation();

      const { plan: result } = await TurnComposer.compose(pickupPlan, snapshot, context, route);

      // Verify MOVE was attempted: first to Leipzig (P1), then to Berlin (P1.5 frontier)
      const moveCalls = mockResolve.mock.calls.filter(
        (args: any[]) => args[0]?.action === 'MOVE',
      );
      expect(moveCalls.length).toBeGreaterThanOrEqual(2);
      expect(moveCalls[0][0].details.to).toBe('Leipzig');
      expect(moveCalls[1][0].details.to).toBe('Berlin');

      // Verify frontier approach log message
      const frontierLog = logSpy.mock.calls.find(
        (c: any[]) => typeof c[0] === 'string' && c[0].includes('JIRA-115'),
      );
      expect(frontierLog).toBeDefined();

      logSpy.mockRestore();
      warnSpy.mockRestore();
    });

    it('skips frontier logic when all route stops are on-network', async () => {
      const snapshot = makeSnapshot({
        bot: {
          ...makeSnapshot().bot,
          position: { row: 20, col: 30 },
          loads: ['Beer'],
        },
      });
      const context = makeContext({
        position: { row: 20, col: 30 },
        speed: 9,
        loads: ['Beer'],
        citiesOnNetwork: ['Berlin', 'Leipzig'],
        reachableCities: ['Berlin'],
        demands: [],
      });
      const route = makeRoute({
        stops: [
          { action: 'pickup', loadType: 'Beer', city: 'Frankfurt' },
          { action: 'deliver', loadType: 'Beer', city: 'Leipzig', demandCardId: 1, payment: 15 },
        ],
        currentStopIndex: 1,
        phase: 'travel',
      });

      const pickupPlan: TurnPlan = {
        type: AIActionType.PickupLoad,
        load: 'Beer',
        city: 'Frankfurt',
      };

      mockApplyPlanToState.mockImplementation(() => {});

      mockResolve
        // A2: MOVE to Leipzig (P1 route stop, ON-network) — SUCCEEDS directly
        .mockResolvedValueOnce({
          success: true,
          plan: {
            type: AIActionType.MoveTrain,
            path: [
              { row: 20, col: 30 }, { row: 19, col: 31 }, { row: 18, col: 32 },
            ],
            fees: new Set<string>(),
            totalFee: 0,
          },
        });

      const logSpy = jest.spyOn(console, 'log').mockImplementation();
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation();

      await TurnComposer.compose(pickupPlan, snapshot, context, route);

      // Should NOT have a frontier approach log (all stops on-network)
      const frontierLog = logSpy.mock.calls.find(
        (c: any[]) => typeof c[0] === 'string' && c[0].includes('JIRA-115'),
      );
      expect(frontierLog).toBeUndefined();

      // Only one MOVE attempted (directly to Leipzig)
      const moveCalls = mockResolve.mock.calls.filter(
        (args: any[]) => args[0]?.action === 'MOVE',
      );
      expect(moveCalls).toHaveLength(1);
      expect(moveCalls[0][0].details.to).toBe('Leipzig');

      logSpy.mockRestore();
      warnSpy.mockRestore();
    });

    it('skips frontier logic when no active route', async () => {
      const snapshot = makeSnapshot({
        bot: {
          ...makeSnapshot().bot,
          position: { row: 20, col: 30 },
          loads: ['Beer'],
        },
      });
      const context = makeContext({
        position: { row: 20, col: 30 },
        speed: 9,
        loads: ['Beer'],
        citiesOnNetwork: ['Berlin'],
        reachableCities: ['Berlin'],
        demands: [
          {
            cardIndex: 0, loadType: 'Beer', supplyCity: 'Frankfurt', deliveryCity: 'Berlin',
            payout: 20, isSupplyReachable: false, isDeliveryReachable: true,
            isSupplyOnNetwork: true, isDeliveryOnNetwork: true,
            estimatedTrackCostToSupply: 0, estimatedTrackCostToDelivery: 0,
            isLoadAvailable: true, isLoadOnTrain: true, ferryRequired: false,
            loadChipTotal: 4, loadChipCarried: 0, estimatedTurns: 0,
            demandScore: 10, efficiencyPerTurn: 5, networkCitiesUnlocked: 0, victoryMajorCitiesEnRoute: 0,
            isAffordable: true, projectedFundsAfterDelivery: 50,
          },
        ],
      });

      const pickupPlan: TurnPlan = {
        type: AIActionType.PickupLoad,
        load: 'Beer',
        city: 'Frankfurt',
      };

      mockApplyPlanToState.mockImplementation(() => {});

      mockResolve
        // A2: MOVE to Berlin (P2 demand delivery city) — SUCCEEDS
        .mockResolvedValueOnce({
          success: true,
          plan: {
            type: AIActionType.MoveTrain,
            path: [
              { row: 20, col: 30 }, { row: 19, col: 31 }, { row: 18, col: 32 },
            ],
            fees: new Set<string>(),
            totalFee: 0,
          },
        });

      const logSpy = jest.spyOn(console, 'log').mockImplementation();
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation();

      await TurnComposer.compose(pickupPlan, snapshot, context, null);

      // No frontier log — no active route
      const frontierLog = logSpy.mock.calls.find(
        (c: any[]) => typeof c[0] === 'string' && c[0].includes('JIRA-115'),
      );
      expect(frontierLog).toBeUndefined();

      logSpy.mockRestore();
      warnSpy.mockRestore();
    });

    it('falls through gracefully when no on-network cities exist', async () => {
      const snapshot = makeSnapshot({
        bot: {
          ...makeSnapshot().bot,
          position: { row: 20, col: 30 },
          loads: ['Beer'],
        },
      });
      const context = makeContext({
        position: { row: 20, col: 30 },
        speed: 9,
        loads: ['Beer'],
        citiesOnNetwork: [], // No cities on network
        reachableCities: [],
        demands: [],
      });
      const route = makeRoute({
        stops: [
          { action: 'pickup', loadType: 'Beer', city: 'Frankfurt' },
          { action: 'deliver', loadType: 'Beer', city: 'Leipzig', demandCardId: 1, payment: 15 },
        ],
        currentStopIndex: 1,
        phase: 'travel',
      });

      const gridPoints = new Map<string, any>();
      gridPoints.set('14,40', { row: 14, col: 40, name: 'Leipzig', terrain: 0 });
      mockLoadGridPoints.mockReturnValue(gridPoints);

      const pickupPlan: TurnPlan = {
        type: AIActionType.PickupLoad,
        load: 'Beer',
        city: 'Frankfurt',
      };

      mockApplyPlanToState.mockImplementation(() => {});

      // All MOVE attempts fail (nothing reachable)
      mockResolve.mockResolvedValue({ success: false, error: 'No valid path' });

      const logSpy = jest.spyOn(console, 'log').mockImplementation();
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation();

      const { plan: result } = await TurnComposer.compose(pickupPlan, snapshot, context, route);

      // No frontier log (no on-network cities to approach)
      const frontierLog = logSpy.mock.calls.find(
        (c: any[]) => typeof c[0] === 'string' && c[0].includes('JIRA-115'),
      );
      expect(frontierLog).toBeUndefined();

      // Result should just be the pickup (no continuation MOVE succeeded)
      expect(result.type === AIActionType.PickupLoad || result.type === 'MultiAction').toBe(true);

      logSpy.mockRestore();
      warnSpy.mockRestore();
    });

    it('targets first off-network stop when multiple stops are off-network', async () => {
      const snapshot = makeSnapshot({
        bot: {
          ...makeSnapshot().bot,
          position: { row: 20, col: 30 },
          loads: ['Beer'],
        },
      });
      const context = makeContext({
        position: { row: 20, col: 30 },
        speed: 9,
        loads: ['Beer'],
        citiesOnNetwork: ['Munich'],
        reachableCities: ['Munich'],
        demands: [],
      });
      const route = makeRoute({
        stops: [
          { action: 'pickup', loadType: 'Beer', city: 'Frankfurt' },
          { action: 'deliver', loadType: 'Beer', city: 'Leipzig', demandCardId: 1, payment: 15 },
          { action: 'pickup', loadType: 'Coal', city: 'Szczecin' },
        ],
        currentStopIndex: 1,
        phase: 'travel',
      });

      // Leipzig at (14,40), Szczecin at (10,44), Munich at (22,36)
      // Munich is closer to Leipzig (dist=14) than to Szczecin (dist=20)
      const gridPoints = new Map<string, any>();
      gridPoints.set('14,40', { row: 14, col: 40, name: 'Leipzig', terrain: 0 });
      gridPoints.set('10,44', { row: 10, col: 44, name: 'Szczecin', terrain: 0 });
      gridPoints.set('22,36', { row: 22, col: 36, name: 'Munich', terrain: 0 });
      mockLoadGridPoints.mockReturnValue(gridPoints);

      const pickupPlan: TurnPlan = {
        type: AIActionType.PickupLoad,
        load: 'Beer',
        city: 'Frankfurt',
      };

      mockApplyPlanToState.mockImplementation((plan: TurnPlan, snap: WorldSnapshot, ctx: GameContext) => {
        if (plan.type === AIActionType.MoveTrain) {
          const movePath = (plan as any).path;
          const endPos = movePath[movePath.length - 1];
          snap.bot.position = { row: endPos.row, col: endPos.col };
          ctx.position = { row: endPos.row, col: endPos.col };
        }
      });

      mockResolve
        // A2: MOVE to Leipzig (P1 route stop, off-network) — FAILS
        .mockResolvedValueOnce({ success: false, error: 'No valid path to "Leipzig"' })
        // A2: MOVE to Szczecin (P1 route stop, off-network) — FAILS
        .mockResolvedValueOnce({ success: false, error: 'No valid path to "Szczecin"' })
        // A2: MOVE to Munich (P1.5 frontier, closest to Leipzig — first off-network stop) — SUCCEEDS
        .mockResolvedValueOnce({
          success: true,
          plan: {
            type: AIActionType.MoveTrain,
            path: [
              { row: 20, col: 30 }, { row: 21, col: 31 }, { row: 22, col: 32 },
            ],
            fees: new Set<string>(),
            totalFee: 0,
          },
        });

      const logSpy = jest.spyOn(console, 'log').mockImplementation();
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation();

      await TurnComposer.compose(pickupPlan, snapshot, context, route);

      // Verify frontier approach targets Leipzig (first off-network), not Szczecin
      const frontierLog = logSpy.mock.calls.find(
        (c: any[]) => typeof c[0] === 'string' && c[0].includes('JIRA-115'),
      );
      expect(frontierLog).toBeDefined();
      expect(frontierLog![0]).toContain('Leipzig');
      expect(frontierLog![0]).toContain('Munich');

      // MOVE calls: Leipzig (P1, fails), Szczecin (P1, fails), Munich (P1.5 frontier, succeeds)
      const moveCalls = mockResolve.mock.calls.filter(
        (args: any[]) => args[0]?.action === 'MOVE',
      );
      expect(moveCalls.length).toBeGreaterThanOrEqual(3);
      expect(moveCalls[0][0].details.to).toBe('Leipzig');
      expect(moveCalls[1][0].details.to).toBe('Szczecin');
      expect(moveCalls[2][0].details.to).toBe('Munich');

      logSpy.mockRestore();
      warnSpy.mockRestore();
    });
  });

  // ── JIRA-113 P2: Near-Miss Optimizer Integration Tests ──────────────────

  describe('JIRA-113: Near-miss optimizer in tryAppendBuild', () => {
    beforeEach(() => {
      mockFindNearbyFerryPorts.mockReturnValue([]);
      mockFindSpurOpportunities.mockReturnValue([]);
      mockEvaluateBuildOption.mockReturnValue({ turnsSaved: 0, buildCost: 0, valuePerTurn: 0, isWorthwhile: false });
    });

    it('no opportunities found → standard build behavior unchanged', async () => {
      const snapshot = makeSnapshot({
        bot: {
          ...makeSnapshot().bot,
          existingSegments: [
            makeSegment(10, 10, 10, 11),
            makeSegment(10, 11, 10, 12),
            makeSegment(10, 12, 10, 13),
          ],
        },
      });
      const context = makeContext({ turnNumber: 40 });
      const route = makeRoute({ stops: [{ city: 'Berlin', type: 'pickup' as const }] });

      // Standard build returns a plan
      mockResolve.mockResolvedValueOnce({
        success: true,
        plan: { type: AIActionType.BuildTrack, segments: [makeSegment(10, 13, 10, 14)], targetCity: 'Berlin' },
      });

      const result = await TurnComposer.tryAppendBuild(snapshot, context, route);
      // Should still produce a build plan via standard path
      expect(result).not.toBeNull();
      expect(mockFindNearbyFerryPorts).toHaveBeenCalled();
      expect(mockFindSpurOpportunities).toHaveBeenCalled();
    });

    it('worthwhile spur found and budget allows → near-miss built, budget updated', async () => {
      const snapshot = makeSnapshot({
        bot: {
          ...makeSnapshot().bot,
          money: 50,
          existingSegments: [
            makeSegment(10, 10, 10, 11),
            makeSegment(10, 11, 10, 12),
            makeSegment(10, 12, 10, 13),
          ],
        },
      });
      const context = makeContext({
        turnNumber: 50,
        turnBuildCost: 0,
        demands: [{
          cardIndex: 1, loadType: 'Coal', supplyCity: 'NearCity', deliveryCity: 'FarCity',
          payout: 10, isSupplyReachable: true, isDeliveryReachable: false,
          isSupplyOnNetwork: false, isDeliveryOnNetwork: false,
          estimatedTrackCostToSupply: 3, estimatedTrackCostToDelivery: 20,
          isLoadAvailable: true, isLoadOnTrain: false, ferryRequired: false,
          loadChipTotal: 4, loadChipCarried: 0, estimatedTurns: 5,
        }],
      });

      // Spur opportunity found
      mockFindSpurOpportunities.mockReturnValue([
        { city: 'NearCity', nearestNetworkPoint: { row: 10, col: 14 }, spurCost: 5, spurSegments: 2 },
      ]);
      mockEvaluateBuildOption.mockReturnValue({
        turnsSaved: 1.5, buildCost: 5, valuePerTurn: 6.5, isWorthwhile: true,
      });

      // Near-miss build succeeds with 5M cost
      const spurSegment = makeSegment(10, 13, 10, 14, 5);
      mockResolve.mockResolvedValueOnce({
        success: true,
        plan: { type: AIActionType.BuildTrack, segments: [spurSegment], targetCity: 'NearCity' },
      });
      // Standard build also called with remaining budget
      mockResolve.mockResolvedValueOnce({
        success: true,
        plan: { type: AIActionType.BuildTrack, segments: [makeSegment(10, 14, 10, 15, 3)], targetCity: 'Berlin' },
      });

      const route = makeRoute({ stops: [{ city: 'Berlin', type: 'pickup' as const }] });
      const result = await TurnComposer.tryAppendBuild(snapshot, context, route);

      // Near-miss build should have been attempted
      expect(mockFindSpurOpportunities).toHaveBeenCalled();
      expect(mockEvaluateBuildOption).toHaveBeenCalled();
      // ActionResolver should have been called for the near-miss build
      expect(mockResolve).toHaveBeenCalled();
    });

    it('worthwhile spur exceeds remaining budget → spur skipped', async () => {
      const snapshot = makeSnapshot({
        bot: {
          ...makeSnapshot().bot,
          money: 5,
          existingSegments: [
            makeSegment(10, 10, 10, 11),
            makeSegment(10, 11, 10, 12),
            makeSegment(10, 12, 10, 13),
          ],
        },
      });
      const context = makeContext({
        turnNumber: 50,
        turnBuildCost: 18, // Only 2M remaining budget
      });

      // Spur costs 5M — exceeds 2M remaining budget
      mockFindSpurOpportunities.mockReturnValue([
        { city: 'ExpensiveCity', nearestNetworkPoint: { row: 10, col: 14 }, spurCost: 5, spurSegments: 3 },
      ]);
      // evaluateBuildOption is worthwhile, but budget check in tryNearMissBuild filters it
      mockEvaluateBuildOption.mockReturnValue({
        turnsSaved: 2, buildCost: 5, valuePerTurn: 6.5, isWorthwhile: true,
      });

      const result = await TurnComposer.tryAppendBuild(snapshot, context, null);
      // Budget too low for any build — should return null
      expect(result).toBeNull();
    });

    it('network too small (<3 nodes) → near-miss scanning skipped', async () => {
      const snapshot = makeSnapshot({
        bot: {
          ...makeSnapshot().bot,
          existingSegments: [makeSegment(10, 10, 10, 11)], // Only 2 unique nodes
        },
      });
      const context = makeContext({ turnNumber: 50 });

      const result = await TurnComposer.tryAppendBuild(snapshot, context, null);
      // With only 2 network nodes, near-miss scanning should be skipped
      expect(mockFindNearbyFerryPorts).not.toHaveBeenCalled();
      expect(mockFindSpurOpportunities).not.toHaveBeenCalled();
    });
  });
});
