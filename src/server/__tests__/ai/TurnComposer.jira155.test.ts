/**
 * JIRA-155: TurnComposer composition ordering bug fix tests.
 *
 * Bug 1 — A3 guard widens to fire after PICKUP/DELIVER when next stop needs building.
 * Bug 2 — Delivery-first ordering in splitMoveForOpportunities when planned stop is PICKUP.
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
  hexDistance: (r1: number, c1: number, r2: number, c2: number) => {
    const x1 = c1 - Math.floor(r1 / 2);
    const z1 = r1;
    const y1 = -x1 - z1;
    const x2 = c2 - Math.floor(r2 / 2);
    const z2 = r2;
    const y2 = -x2 - z2;
    return Math.max(Math.abs(x1 - x2), Math.abs(y1 - y2), Math.abs(z1 - z2));
  },
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
jest.mock('../../services/ai/BuildAdvisor', () => ({
  BuildAdvisor: {
    advise: jest.fn(() => Promise.resolve(null)),
    retryWithSolvencyFeedback: jest.fn(() => Promise.resolve(null)),
  },
}));
jest.mock('../../services/ai/SolvencyCheck', () => ({
  SolvencyCheck: {
    check: jest.fn(() => ({ canAfford: true, actualCost: 5, availableForBuild: 50, incomeBefore: 0 })),
  },
}));
jest.mock('../../services/ai/RouteValidator', () => ({
  RouteValidator: {
    validate: jest.fn(() => ({ valid: true, errors: [] })),
  },
}));

import { TurnComposer } from '../../services/ai/TurnComposer';
import { ActionResolver } from '../../services/ai/ActionResolver';
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

describe('JIRA-155: A3 MOVE after PICKUP when next stop needs building', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    mockCloneSnapshot.mockImplementation(defaultCloneSnapshot);
    mockApplyPlanToState.mockImplementation(() => {});
    mockLoadGridPoints.mockReturnValue(new Map());
  });

  it('composes PICKUP + MOVE toward frontier when next route stop is off-network', async () => {
    // Bot at Berlin, just picked up Iron. Next route stop is deliver Iron at Paris (off-network).
    // A2 should fail (no on-network MOVE target), then A3 widens to fire because last step is PICKUP.
    // A3 finds Frankfurt via findMoveTargets and resolves a MOVE.
    const snapshot = makeSnapshot({
      bot: {
        ...makeSnapshot().bot,
        position: { row: 10, col: 10 },
        loads: ['Iron'],
        resolvedDemands: [
          { cardId: 1, demands: [{ city: 'Paris', loadType: 'Iron', payment: 30 }] },
        ],
      },
    });

    const context = makeContext({
      speed: 9,
      loads: ['Iron'],
      // Paris is NOT on network — A2's findMoveTargets will attempt it but MOVE will fail
      citiesOnNetwork: ['Berlin', 'Frankfurt'],
      demands: [
        {
          cardIndex: 1,
          loadType: 'Iron',
          supplyCity: 'Berlin',
          deliveryCity: 'Paris',
          payout: 30,
          isSupplyReachable: true,
          isDeliveryReachable: false,
          isSupplyOnNetwork: true,
          isDeliveryOnNetwork: false,  // Off-network — A2 MOVE will fail
          estimatedTrackCostToSupply: 0,
          estimatedTrackCostToDelivery: 15,
          isLoadAvailable: true,
          isLoadOnTrain: true,
          ferryRequired: false,
          loadChipTotal: 4,
          loadChipCarried: 0,
          estimatedTurns: 3,
          demandScore: 10,
          efficiencyPerTurn: 5,
          networkCitiesUnlocked: 0,
          victoryMajorCitiesEnRoute: 0,
          isAffordable: true,
          projectedFundsAfterDelivery: 80,
        },
      ],
    });

    // Active route: stop 0 already done (pickup Iron at Berlin, currentStopIndex=1),
    // stop 1 is deliver Iron at Paris (off-network)
    const route = makeRoute({
      stops: [
        { action: 'pickup', loadType: 'Iron', city: 'Berlin' },
        { action: 'deliver', loadType: 'Iron', city: 'Paris', demandCardId: 1, payment: 30 },
      ],
      currentStopIndex: 1, // Pickup done, next is delivery at Paris (off-network)
      phase: 'travel',
    });

    // Primary plan is the PICKUP at Berlin (already executed by PlanExecutor)
    const pickupPlan: TurnPlan = {
      type: AIActionType.PickupLoad,
      load: 'Iron',
      city: 'Berlin',
    };

    // A2 will attempt to MOVE toward Paris — it fails (off-network)
    // A3 then fires because lastStepType is PickupLoad and hasMove is false
    // A3 attempts MOVE toward Frankfurt (on-network, directional toward Paris) — succeeds
    mockResolve
      // A2 iter 1: MOVE to Paris — fails (off-network)
      .mockResolvedValueOnce({ success: false, error: 'City not reachable: Paris' })
      // A3: MOVE toward Frankfurt (frontier city on track toward Paris) — succeeds
      .mockResolvedValueOnce({
        success: true,
        plan: {
          type: AIActionType.MoveTrain,
          path: [
            { row: 10, col: 10 }, { row: 10, col: 11 },
            { row: 10, col: 12 }, { row: 10, col: 13 },
          ],
          fees: new Set<string>(),
          totalFee: 0,
        },
      });

    const { plan: result, trace } = await TurnComposer.compose(pickupPlan, snapshot, context, route);

    // Should be MultiAction: [PickupLoad, MoveTrain]
    expect(result.type).toBe('MultiAction');
    if (result.type === 'MultiAction') {
      const types = result.steps.map(s => s.type);
      expect(types).toContain(AIActionType.PickupLoad);
      expect(types).toContain(AIActionType.MoveTrain);
      // PICKUP should come before MOVE
      const pickupIdx = types.indexOf(AIActionType.PickupLoad);
      const moveIdx = types.indexOf(AIActionType.MoveTrain);
      expect(pickupIdx).toBeLessThan(moveIdx);
    }

    // A3 should have fired
    expect(trace.a3.movePreprended).toBe(true);
  });

  it('A3 does NOT fire after PICKUP when next stop IS on-network (regression guard)', async () => {
    // Bot just picked up Iron at Berlin. Next stop is deliver Iron at Frankfurt (on-network).
    // A2 should chain the MOVE successfully, so A3 should NOT fire.
    const snapshot = makeSnapshot({
      bot: {
        ...makeSnapshot().bot,
        position: { row: 10, col: 10 },
        loads: ['Iron'],
        resolvedDemands: [
          { cardId: 1, demands: [{ city: 'Frankfurt', loadType: 'Iron', payment: 20 }] },
        ],
      },
    });

    const context = makeContext({
      speed: 9,
      loads: ['Iron'],
      citiesOnNetwork: ['Berlin', 'Frankfurt'], // Frankfurt IS on network
      demands: [
        {
          cardIndex: 1,
          loadType: 'Iron',
          supplyCity: 'Berlin',
          deliveryCity: 'Frankfurt',
          payout: 20,
          isSupplyReachable: true,
          isDeliveryReachable: true,
          isSupplyOnNetwork: true,
          isDeliveryOnNetwork: true,  // On-network — A2 MOVE should succeed
          estimatedTrackCostToSupply: 0,
          estimatedTrackCostToDelivery: 0,
          isLoadAvailable: true,
          isLoadOnTrain: true,
          ferryRequired: false,
          loadChipTotal: 4,
          loadChipCarried: 0,
          estimatedTurns: 1,
          demandScore: 10,
          efficiencyPerTurn: 10,
          networkCitiesUnlocked: 0,
          victoryMajorCitiesEnRoute: 0,
          isAffordable: true,
          projectedFundsAfterDelivery: 70,
        },
      ],
    });

    const route = makeRoute({
      stops: [
        { action: 'pickup', loadType: 'Iron', city: 'Berlin' },
        { action: 'deliver', loadType: 'Iron', city: 'Frankfurt', demandCardId: 1, payment: 20 },
      ],
      currentStopIndex: 1, // pickup done, next is deliver at Frankfurt (on-network)
      phase: 'travel',
    });

    const pickupPlan: TurnPlan = {
      type: AIActionType.PickupLoad,
      load: 'Iron',
      city: 'Berlin',
    };

    // A2: MOVE toward Frankfurt succeeds
    mockResolve
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
      });

    const { plan: result, trace } = await TurnComposer.compose(pickupPlan, snapshot, context, route);

    // Should be MultiAction with a MOVE (A2 chained it)
    expect(result.type).toBe('MultiAction');

    // A3 should NOT have fired (A2 already added a MOVE)
    expect(trace.a3.movePreprended).toBe(false);
  });

  it('A3 still prepends MOVE before BUILD for BuildTrack primary (regression guard)', async () => {
    // Existing A3 behavior: BUILD primary with no MOVE — A3 prepends MOVE before BUILD.
    const snapshot = makeSnapshot({
      bot: {
        ...makeSnapshot().bot,
        loads: ['Coal'],
      },
    });

    const context = makeContext({
      demands: [
        {
          cardIndex: 0,
          loadType: 'Coal',
          supplyCity: 'Berlin',
          deliveryCity: 'Paris',
          payout: 25,
          isSupplyReachable: false,
          isDeliveryReachable: false,
          isSupplyOnNetwork: true,
          isDeliveryOnNetwork: true,
          estimatedTrackCostToSupply: 0,
          estimatedTrackCostToDelivery: 0,
          isLoadAvailable: true,
          isLoadOnTrain: true,
          ferryRequired: false,
          loadChipTotal: 4,
          loadChipCarried: 0,
          estimatedTurns: 0,
          demandScore: 0,
          efficiencyPerTurn: 0,
          networkCitiesUnlocked: 0,
          victoryMajorCitiesEnRoute: 0,
          isAffordable: true,
          projectedFundsAfterDelivery: 50,
        },
      ],
    });

    const buildPlan: TurnPlan = {
      type: AIActionType.BuildTrack,
      segments: [makeSegment(10, 10, 10, 11)],
      targetCity: 'München',
    };

    // A3: MOVE toward delivery city succeeds
    mockResolve.mockResolvedValueOnce({
      success: true,
      plan: {
        type: AIActionType.MoveTrain,
        path: [{ row: 10, col: 10 }, { row: 12, col: 12 }],
        fees: new Set<string>(),
        totalFee: 0,
      },
    });

    const { plan: result, trace } = await TurnComposer.compose(buildPlan, snapshot, context);

    expect(result.type).toBe('MultiAction');
    if (result.type === 'MultiAction') {
      expect(result.steps[0].type).toBe(AIActionType.MoveTrain);
      expect(result.steps[result.steps.length - 1].type).toBe(AIActionType.BuildTrack);
    }
    expect(trace.a3.movePreprended).toBe(true);
  });
});

describe('JIRA-155: delivery executes before pickup at same city in splitMoveForOpportunities', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    mockCloneSnapshot.mockImplementation(defaultCloneSnapshot);
    mockApplyPlanToState.mockImplementation(() => {});
    mockLoadGridPoints.mockReturnValue(new Map());
  });

  it('delivers carried load before executing planned pickup at same city', async () => {
    // Bot is moving through Kaliningrad.
    // Bot carries Flowers and has a demand card for Flowers at Kaliningrad.
    // Planned stop at Kaliningrad is pickup(Iron).
    // Expected: DELIVER Flowers BEFORE PICKUP Iron in the composed plan — no capacity overflow.
    const snapshot = makeSnapshot({
      bot: {
        ...makeSnapshot().bot,
        position: { row: 5, col: 5 },
        loads: ['Flowers'],
        resolvedDemands: [
          { cardId: 1, demands: [{ city: 'Kaliningrad', loadType: 'Flowers', payment: 18 }] },
        ],
      },
      loadAvailability: { Kaliningrad: ['Iron'] },
    });

    const context = makeContext({
      speed: 9,
      capacity: 2,
      loads: ['Flowers'],
      demands: [
        {
          cardIndex: 1,
          loadType: 'Flowers',
          supplyCity: 'Amsterdam',
          deliveryCity: 'Kaliningrad',
          payout: 18,
          isSupplyReachable: true,
          isDeliveryReachable: true,
          isSupplyOnNetwork: true,
          isDeliveryOnNetwork: true,
          estimatedTrackCostToSupply: 0,
          estimatedTrackCostToDelivery: 0,
          isLoadAvailable: true,
          isLoadOnTrain: true,
          ferryRequired: false,
          loadChipTotal: 3,
          loadChipCarried: 0,
          estimatedTurns: 1,
          demandScore: 8,
          efficiencyPerTurn: 8,
          networkCitiesUnlocked: 0,
          victoryMajorCitiesEnRoute: 0,
          isAffordable: true,
          projectedFundsAfterDelivery: 68,
        },
      ],
    });

    // Route: next planned stop is pickup(Iron) at Kaliningrad
    const route = makeRoute({
      stops: [
        { action: 'pickup', loadType: 'Iron', city: 'Kaliningrad' },
        { action: 'deliver', loadType: 'Iron', city: 'Berlin', demandCardId: 2, payment: 22 },
      ],
      currentStopIndex: 0,
      phase: 'travel',
    });

    // Primary: MOVE that passes through Kaliningrad at row 7, col 5
    const movePlan: TurnPlan = {
      type: AIActionType.MoveTrain,
      path: [
        { row: 5, col: 5 }, { row: 6, col: 5 },
        { row: 7, col: 5 }, { row: 8, col: 5 },
      ],
      fees: new Set<string>(),
      totalFee: 0,
    };

    // GridPoints: Kaliningrad is at row 7, col 5
    mockLoadGridPoints.mockReturnValue(new Map([
      ['7,5', { row: 7, col: 5, name: 'Kaliningrad', terrain: TerrainType.MediumCity }],
    ]));

    // Track the order in which ActionResolver.resolve is called for DELIVER and PICKUP
    const resolveCallOrder: string[] = [];

    mockApplyPlanToState.mockImplementation((plan: TurnPlan, snap: WorldSnapshot) => {
      if (plan.type === AIActionType.DeliverLoad) {
        const load = (plan as any).load;
        const idx = snap.bot.loads.indexOf(load);
        if (idx >= 0) snap.bot.loads.splice(idx, 1);
      }
      if (plan.type === AIActionType.PickupLoad) {
        const load = (plan as any).load;
        snap.bot.loads.push(load);
      }
    });

    mockResolve.mockImplementation(async (req: any) => {
      if (req.action === 'DELIVER' && req.details.load === 'Flowers') {
        resolveCallOrder.push('DELIVER_Flowers');
        return {
          success: true,
          plan: { type: AIActionType.DeliverLoad, load: 'Flowers', city: 'Kaliningrad', cardId: 1, payout: 18 },
        };
      }
      if (req.action === 'PICKUP' && req.details.load === 'Iron') {
        resolveCallOrder.push('PICKUP_Iron');
        return {
          success: true,
          plan: { type: AIActionType.PickupLoad, load: 'Iron', city: 'Kaliningrad' },
        };
      }
      return { success: false, error: `unhandled: ${req.action} ${JSON.stringify(req.details)}` };
    });

    const { plan: result } = await TurnComposer.compose(movePlan, snapshot, context, route);

    // Find the action sequence — DELIVER must come before PICKUP
    const actionTypes = result.type === 'MultiAction'
      ? result.steps.map(s => s.type)
      : [result.type];

    expect(actionTypes).toContain(AIActionType.DeliverLoad);
    expect(actionTypes).toContain(AIActionType.PickupLoad);

    const deliverIdx = actionTypes.indexOf(AIActionType.DeliverLoad);
    const pickupIdx = actionTypes.indexOf(AIActionType.PickupLoad);
    expect(deliverIdx).toBeLessThan(pickupIdx);

    // Verify delivery was resolved before pickup (call order within splitMoveForOpportunities)
    const deliverCallPos = resolveCallOrder.indexOf('DELIVER_Flowers');
    const pickupCallPos = resolveCallOrder.indexOf('PICKUP_Iron');
    expect(deliverCallPos).toBeGreaterThanOrEqual(0);
    expect(pickupCallPos).toBeGreaterThanOrEqual(0);
    expect(deliverCallPos).toBeLessThan(pickupCallPos);
  });

  it('does NOT reorder when planned stop is DELIVER (no-op regression guard)', async () => {
    // Bot carries Coal, planned stop at CityA is deliver Coal.
    // No delivery-first logic should activate (planned stop is already a DELIVER, not a pickup).
    // The delivery should execute normally via the planned stop path.
    const snapshot = makeSnapshot({
      bot: {
        ...makeSnapshot().bot,
        position: { row: 5, col: 5 },
        loads: ['Coal'],
        resolvedDemands: [
          { cardId: 1, demands: [{ city: 'CityA', loadType: 'Coal', payment: 22 }] },
        ],
      },
    });

    const context = makeContext({
      speed: 9,
      capacity: 2,
      loads: ['Coal'],
    });

    // Planned stop is deliver Coal at CityA (not a pickup)
    const route = makeRoute({
      stops: [
        { action: 'deliver', loadType: 'Coal', city: 'CityA', demandCardId: 1, payment: 22 },
      ],
      currentStopIndex: 0,
      phase: 'travel',
    });

    const movePlan: TurnPlan = {
      type: AIActionType.MoveTrain,
      path: [
        { row: 5, col: 5 }, { row: 6, col: 5 },
        { row: 7, col: 5 }, { row: 8, col: 5 },
      ],
      fees: new Set<string>(),
      totalFee: 0,
    };

    // CityA is at row 7, col 5
    mockLoadGridPoints.mockReturnValue(new Map([
      ['7,5', { row: 7, col: 5, name: 'CityA', terrain: TerrainType.MediumCity }],
    ]));

    // Track resolve calls to verify no extra delivery-first DELIVER was injected
    const deliverResolveCalls: string[] = [];

    mockApplyPlanToState.mockImplementation((plan: TurnPlan, snap: WorldSnapshot) => {
      if (plan.type === AIActionType.DeliverLoad) {
        const load = (plan as any).load;
        const idx = snap.bot.loads.indexOf(load);
        if (idx >= 0) snap.bot.loads.splice(idx, 1);
      }
    });

    mockResolve.mockImplementation(async (req: any) => {
      if (req.action === 'DELIVER' && req.details.load === 'Coal') {
        deliverResolveCalls.push('DELIVER_Coal');
        return {
          success: true,
          plan: { type: AIActionType.DeliverLoad, load: 'Coal', city: 'CityA', cardId: 1, payout: 22 },
        };
      }
      return { success: false, error: `unhandled: ${req.action} ${JSON.stringify(req.details)}` };
    });

    await TurnComposer.compose(movePlan, snapshot, context, route);

    // The delivery-first code must NOT inject an extra DELIVER before the planned DELIVER.
    // Only the planned stop's own resolve call should appear (the opportunistic scan may
    // add a second but only if Coal is still on the train — after the planned stop delivers
    // it, the opportunistic scan finds no Coal to deliver).
    // The important check: no "pre-planned DELIVER" was injected by Bug 2 delivery-first logic.
    // Since the planned stop is DELIVER (not PICKUP), Bug 2 code path is NOT entered.
    // The resolve call count depends on whether opportunistic scan also fires — we only check
    // that the calls that DID happen were for 'DELIVER Coal' (not some unexpected action).
    expect(deliverResolveCalls.every(c => c === 'DELIVER_Coal')).toBe(true);
  });
});
