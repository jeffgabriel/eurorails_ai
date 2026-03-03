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

import { TurnComposer } from '../../services/ai/TurnComposer';
import { ActionResolver } from '../../services/ai/ActionResolver';
import { PlanExecutor } from '../../services/ai/PlanExecutor';
import { loadGridPoints } from '../../services/ai/MapTopology';
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
      const result = await TurnComposer.compose(plan, makeSnapshot(), makeContext());

      expect(result).toBe(plan);
      expect(result.type).toBe(AIActionType.DiscardHand);
      // No cloneSnapshot or resolve calls should be made
      expect(mockCloneSnapshot).not.toHaveBeenCalled();
      expect(mockResolve).not.toHaveBeenCalled();
    });

    it('PassTurn returns unchanged', async () => {
      const plan: TurnPlan = { type: AIActionType.PassTurn };
      const result = await TurnComposer.compose(plan, makeSnapshot(), makeContext());

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

      const result = await TurnComposer.compose(plan, snapshot, context);

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

      const result = await TurnComposer.compose(movePlan, snapshot, context);

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

      const result = await TurnComposer.compose(movePlan, snapshot, context);

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

      const result = await TurnComposer.compose(movePlan, snapshot, context);

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

      const result = await TurnComposer.compose(movePlan, snapshot, context, route);

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

      const result = await TurnComposer.compose(primaryPlan, snapshot, context, route);

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

      const result = await TurnComposer.compose(pickupPlan, snapshot, context, route);

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
    it('Primary DELIVER + BUILD', async () => {
      const snapshot = makeSnapshot();
      const context = makeContext({ turnBuildCost: 0, money: 50 });
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
      // Then tryAppendBuild should find a build target.
      // The route has a stop at Bordeaux which is not on network -> build toward it
      mockResolve
        // A2: MOVE toward next stop — fails
        .mockResolvedValueOnce({ success: false, error: 'No path' })
        // Phase B: BUILD succeeds
        .mockResolvedValueOnce({
          success: true,
          plan: { type: AIActionType.BuildTrack, segments: [makeSegment(20, 20, 20, 21)], targetCity: 'Bordeaux' },
        });

      const result = await TurnComposer.compose(deliverPlan, snapshot, context, route);

      expect(result.type).toBe('MultiAction');
      if (result.type === 'MultiAction') {
        // DELIVER + BUILD (MOVE failed so not included)
        expect(result.steps).toHaveLength(2);
        expect(result.steps[0].type).toBe(AIActionType.DeliverLoad);
        expect(result.steps[1].type).toBe(AIActionType.BuildTrack);
      }
    });

    it('Post-delivery budget allows BUILD after earning payout', async () => {
      // Pre-delivery money=5M, can't afford to build. After delivery earns 25M, money=30M.
      const snapshot = makeSnapshot({
        bot: {
          ...makeSnapshot().bot,
          money: 5,
        },
      });
      const context = makeContext({ money: 5, turnBuildCost: 0 });
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
        .mockResolvedValueOnce({ success: false, error: 'No path' })
        // Phase B: BUILD succeeds (budget now 30M > 0)
        .mockResolvedValueOnce({
          success: true,
          plan: { type: AIActionType.BuildTrack, segments: [makeSegment(20, 20, 20, 21)], targetCity: 'Bordeaux' },
        });

      const result = await TurnComposer.compose(deliverPlan, snapshot, context, route);

      expect(result.type).toBe('MultiAction');
      if (result.type === 'MultiAction') {
        expect(result.steps).toHaveLength(2);
        expect(result.steps[0].type).toBe(AIActionType.DeliverLoad);
        expect(result.steps[1].type).toBe(AIActionType.BuildTrack);
      }

      // Verify the BUILD resolve was called (meaning tryAppendBuild saw enough budget)
      const buildCall = mockResolve.mock.calls.find(
        (args: any[]) => args[0]?.action === 'BUILD',
      );
      expect(buildCall).toBeDefined();
    });

    it('Primary BUILD -> no additional phases', async () => {
      const snapshot = makeSnapshot();
      const context = makeContext({ canBuild: true, turnBuildCost: 0 });

      const buildPlan: TurnPlan = {
        type: AIActionType.BuildTrack,
        segments: [makeSegment(10, 10, 10, 11)],
        targetCity: 'Berlin',
      };

      const result = await TurnComposer.compose(buildPlan, snapshot, context);

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

      const result = await TurnComposer.compose(deliverPlan, snapshot, context);

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

      const result = await TurnComposer.compose(movePlan, snapshot, context);

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
            demandScore: 0, networkCitiesUnlocked: 0, victoryMajorCitiesEnRoute: 0,
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

      const result = await TurnComposer.compose(buildPlan, snapshot, context);

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

      const result = await TurnComposer.compose(buildPlan, snapshot, context);

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

      const result = await TurnComposer.compose(movePlan, snapshot, context);

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

      const result = await TurnComposer.compose(movePlan, snapshot, context, route);

      // Should NOT append a build step — bot is mid-route
      expect(result.type).toBe(AIActionType.MoveTrain);
      expect(mockResolve).not.toHaveBeenCalled();
      expect(mockFindDemandBuildTarget).not.toHaveBeenCalled();
    });

    it('falls back to demand city when no unconnected major cities', async () => {
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

      mockFindDemandBuildTarget.mockReturnValue('Bordeaux');

      // Phase B: BUILD toward Bordeaux succeeds
      mockResolve.mockResolvedValueOnce({
        success: true,
        plan: { type: AIActionType.BuildTrack, segments: [makeSegment(20, 20, 20, 21)], targetCity: 'Bordeaux' },
      });

      const result = await TurnComposer.compose(movePlan, snapshot, context);

      expect(result.type).toBe('MultiAction');
      // findDemandBuildTarget should have been called as fallback
      expect(mockFindDemandBuildTarget).toHaveBeenCalled();
      const buildCall = mockResolve.mock.calls.find(
        (args: any[]) => args[0]?.action === 'BUILD',
      );
      expect(buildCall![0].details.toward).toBe('Bordeaux');
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

      const result = await TurnComposer.compose(pickupPlan, snapshot, context, route);

      // Verify findMoveTarget skipped Berlin (deliver without load) and targeted Baku
      const moveCall = mockResolve.mock.calls.find(
        (args: any[]) => args[0]?.action === 'MOVE',
      );
      expect(moveCall).toBeDefined();
      expect(moveCall![0].details.to).toBe('Baku');
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

      const result = await TurnComposer.compose(movePlan, snapshot, context);

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

      const result = await TurnComposer.compose(movePlan, snapshot, context);

      // No BUILD should be appended — victory threshold not met, no demand fallback
      expect(result.type).toBe(AIActionType.MoveTrain);
      expect(mockResolve).not.toHaveBeenCalled();
    });
  });

  describe('tryAppendBuild no speculative builds', () => {
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

      const result = await TurnComposer.compose(movePlan, snapshot, context, route);

      // No BUILD appended — all stops on network, no unconnected cities, no demand target
      expect(result.type).toBe(AIActionType.MoveTrain);
      expect(mockResolve).not.toHaveBeenCalled();
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
            demandScore: 0, networkCitiesUnlocked: 0, victoryMajorCitiesEnRoute: 0,
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

      const result = await TurnComposer.compose(buildPlan, snapshot, context);

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

      const result = await TurnComposer.compose(buildPlan, snapshot, context, route);

      // initialBuild returns primary unchanged — no enrichment
      expect(result).toBe(buildPlan);
      expect(result.type).toBe(AIActionType.BuildTrack);
      expect(mockCloneSnapshot).not.toHaveBeenCalled();
      expect(mockResolve).not.toHaveBeenCalled();
    });
  });

  describe('build fallback when route stops all connected', () => {
    it('falls back to findDemandBuildTarget when all route stops on network', async () => {
      // All route stops on network — should fall through to demand build target
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

      mockFindDemandBuildTarget.mockReturnValue('Lyon');

      const movePlan: TurnPlan = {
        type: AIActionType.MoveTrain,
        path: [{ row: 10, col: 10 }, { row: 12, col: 12 }],
        fees: new Set<string>(),
        totalFee: 0,
      };

      // Phase B: BUILD toward Lyon (demand fallback) succeeds
      mockResolve.mockResolvedValueOnce({
        success: true,
        plan: { type: AIActionType.BuildTrack, segments: [makeSegment(20, 20, 20, 21)], targetCity: 'Lyon' },
      });

      const result = await TurnComposer.compose(movePlan, snapshot, context, route);

      expect(result.type).toBe('MultiAction');
      expect(mockFindDemandBuildTarget).toHaveBeenCalled();
      const buildCall = mockResolve.mock.calls.find(
        (args: any[]) => args[0]?.action === 'BUILD',
      );
      expect(buildCall).toBeDefined();
      expect(buildCall![0].details.toward).toBe('Lyon');
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
            demandScore: 0, networkCitiesUnlocked: 0, victoryMajorCitiesEnRoute: 0,
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

      const result = await TurnComposer.compose(pickupPlan, snapshot, context, route);

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
            demandScore: 0, networkCitiesUnlocked: 0, victoryMajorCitiesEnRoute: 0,
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

      const result = await TurnComposer.compose(pickupPlan, snapshot, context, route);

      // Only PICKUP returned — no MOVE could be resolved
      expect(result.type).toBe(AIActionType.PickupLoad);
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
            demandScore: 0, networkCitiesUnlocked: 0, victoryMajorCitiesEnRoute: 0,
          },
          {
            cardIndex: 1, loadType: 'Wine', supplyCity: 'Lyon', deliveryCity: 'Bordeaux',
            payout: 20, isSupplyReachable: false, isDeliveryReachable: false,
            isSupplyOnNetwork: true, isDeliveryOnNetwork: false,
            estimatedTrackCostToSupply: 0, estimatedTrackCostToDelivery: 10,
            isLoadAvailable: true, isLoadOnTrain: false, ferryRequired: false,
            loadChipTotal: 4, loadChipCarried: 0, estimatedTurns: 0,
            demandScore: 0, networkCitiesUnlocked: 0, victoryMajorCitiesEnRoute: 0,
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

      const result = await TurnComposer.compose(buildPlan, snapshot, context, route);

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

      const result = await TurnComposer.compose(movePlan, snapshot, context);

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

      const result = await TurnComposer.compose(movePlan, snapshot, context);

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

      const result = await TurnComposer.compose(buildPlan, snapshot, context);

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

      const result = await TurnComposer.compose(buildPlan, snapshot, context);

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

      const result = await TurnComposer.compose(buildPlan, snapshot, context);

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

      const result = await TurnComposer.compose(plan, snapshot, context);

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

      const result = await TurnComposer.compose(plan, snapshot, context);

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

      const result = await TurnComposer.compose(plan, snapshot, context);

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

      const result = await TurnComposer.compose(plan, snapshot, context);

      // The second MOVE (2mp excess) should be removed entirely since 2 - 2 = 0 < 1
      if (result.type === 'MultiAction') {
        const moves = result.steps.filter(s => s.type === AIActionType.MoveTrain);
        expect(moves).toHaveLength(1);
        expect((moves[0] as any).path).toHaveLength(10); // first MOVE unchanged
      }
    });
  });
});
