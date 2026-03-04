import { GuardrailEnforcer } from '../../services/ai/GuardrailEnforcer';
import { ActionResolver } from '../../services/ai/ActionResolver';
import {
  AIActionType,
  WorldSnapshot,
  TurnPlan,
  GameContext,
  DemandContext,
  DeliveryOpportunity,
  PickupOpportunity,
  TerrainType,
  TrackSegment,
} from '../../../shared/types/GameTypes';

jest.mock('../../services/ai/ActionResolver');

function makeSnapshot(money: number = 50): WorldSnapshot {
  return {
    gameId: 'g1',
    gameStatus: 'active',
    turnNumber: 1,
    bot: {
      playerId: 'bot-1',
      userId: 'user-bot-1',
      money,
      position: null,
      existingSegments: [],
      demandCards: [],
      resolvedDemands: [],
      trainType: 'Freight',
      loads: [],
      botConfig: null,
      connectedMajorCityCount: 0,
    },
    allPlayerTracks: [],
    loadAvailability: {},
  };
}

function makeContext(overrides?: Partial<GameContext>): GameContext {
  return {
    position: { city: 'Berlin', row: 10, col: 10 },
    money: 50,
    trainType: 'Freight',
    speed: 9,
    capacity: 2,
    loads: [],
    connectedMajorCities: ['Berlin'],
    unconnectedMajorCities: [],
    totalMajorCities: 8,
    trackSummary: '5 segments',
    turnBuildCost: 0,
    demands: [],
    canDeliver: [],
    canPickup: [],
    reachableCities: ['Berlin', 'Hamburg'],
    citiesOnNetwork: [],
    canUpgrade: true,
    canBuild: true,
    isInitialBuild: false,
    opponents: [],
    phase: 'normal',
    turnNumber: 5,
    ...overrides,
  };
}

function makeSegment(fromRow: number, fromCol: number, toRow: number, toCol: number): TrackSegment {
  return {
    from: { x: fromCol * 40, y: fromRow * 40, row: fromRow, col: fromCol, terrain: TerrainType.Clear },
    to: { x: toCol * 40, y: toRow * 40, row: toRow, col: toCol, terrain: TerrainType.Clear },
    cost: 1,
  };
}

function makeDemand(overrides: Partial<DemandContext> = {}): DemandContext {
  return {
    cardIndex: 0,
    loadType: 'Wine',
    supplyCity: 'Bordeaux',
    deliveryCity: 'Berlin',
    payout: 20,
    isSupplyReachable: false,
    isDeliveryReachable: false,
    isSupplyOnNetwork: false,
    isDeliveryOnNetwork: false,
    estimatedTrackCostToSupply: 10,
    estimatedTrackCostToDelivery: 10,
    isLoadAvailable: true,
    isLoadOnTrain: false,
    ferryRequired: false,
    loadChipTotal: 4,
    loadChipCarried: 0,
    estimatedTurns: 5,
    demandScore: 0,
    efficiencyPerTurn: 0,
    networkCitiesUnlocked: 0,
    victoryMajorCitiesEnRoute: 0,
    ...overrides,
  };
}

describe('GuardrailEnforcer', () => {
  const mockResolveMove = ActionResolver.resolveMove as jest.MockedFunction<typeof ActionResolver.resolveMove>;

  beforeEach(() => {
    mockResolveMove.mockReset();
    // Default: resolveMove fails (no valid path) — tests that need success override this
    mockResolveMove.mockResolvedValue({ success: false, error: 'No valid path (test default)' });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('checkPlan', () => {
    describe('Guardrail 1: Force DELIVER', () => {
      it('should force DELIVER when canDeliver has opportunities and LLM chose BUILD', async () => {
        const delivery: DeliveryOpportunity = {
          loadType: 'Coal',
          deliveryCity: 'Berlin',
          payout: 25,
          cardIndex: 0,
        };
        const ctx = makeContext({ canDeliver: [delivery] });
        const plan: TurnPlan = {
          type: AIActionType.BuildTrack,
          segments: [makeSegment(10, 10, 10, 11)],
        };

        const result = await GuardrailEnforcer.checkPlan(plan, ctx, makeSnapshot());

        expect(result.overridden).toBe(true);
        expect(result.plan.type).toBe(AIActionType.DeliverLoad);
        if (result.plan.type === AIActionType.DeliverLoad) {
          expect(result.plan.load).toBe('Coal');
          expect(result.plan.city).toBe('Berlin');
          expect(result.plan.payout).toBe(25);
          expect(result.plan.cardId).toBe(0);
        }
        expect(result.reason).toContain('Forced DELIVER');
        expect(result.reason).toContain('Coal');
      });

      it('should force DELIVER when canDeliver has opportunities and LLM chose PASS', async () => {
        const delivery: DeliveryOpportunity = {
          loadType: 'Wine',
          deliveryCity: 'Paris',
          payout: 30,
          cardIndex: 1,
        };
        const ctx = makeContext({ canDeliver: [delivery] });
        const plan: TurnPlan = { type: AIActionType.PassTurn };

        const result = await GuardrailEnforcer.checkPlan(plan, ctx, makeSnapshot());

        expect(result.overridden).toBe(true);
        expect(result.plan.type).toBe(AIActionType.DeliverLoad);
      });

      it('should pick the highest-payout delivery when multiple are available', async () => {
        const deliveries: DeliveryOpportunity[] = [
          { loadType: 'Coal', deliveryCity: 'Berlin', payout: 15, cardIndex: 0 },
          { loadType: 'Wine', deliveryCity: 'Paris', payout: 40, cardIndex: 1 },
          { loadType: 'Iron', deliveryCity: 'Hamburg', payout: 25, cardIndex: 2 },
        ];
        const ctx = makeContext({ canDeliver: deliveries });
        const plan: TurnPlan = { type: AIActionType.MoveTrain, path: [], fees: new Set(), totalFee: 0 };

        const result = await GuardrailEnforcer.checkPlan(plan, ctx, makeSnapshot());

        expect(result.overridden).toBe(true);
        if (result.plan.type === AIActionType.DeliverLoad) {
          expect(result.plan.load).toBe('Wine');
          expect(result.plan.payout).toBe(40);
        }
      });

      it('should NOT override when LLM already chose DELIVER', async () => {
        const delivery: DeliveryOpportunity = {
          loadType: 'Coal',
          deliveryCity: 'Berlin',
          payout: 25,
          cardIndex: 0,
        };
        const ctx = makeContext({ canDeliver: [delivery] });
        const plan: TurnPlan = {
          type: AIActionType.DeliverLoad,
          load: 'Coal',
          city: 'Berlin',
          cardId: 0,
          payout: 25,
        };

        const result = await GuardrailEnforcer.checkPlan(plan, ctx, makeSnapshot());

        expect(result.overridden).toBe(false);
        expect(result.plan).toBe(plan); // Same reference
      });

      it('should NOT override MultiAction that includes a DELIVER step', async () => {
        const delivery: DeliveryOpportunity = {
          loadType: 'Coal',
          deliveryCity: 'Berlin',
          payout: 25,
          cardIndex: 0,
        };
        const ctx = makeContext({ canDeliver: [delivery] });
        const plan: TurnPlan = {
          type: 'MultiAction',
          steps: [
            { type: AIActionType.MoveTrain, path: [], fees: new Set(), totalFee: 0 },
            { type: AIActionType.DeliverLoad, load: 'Coal', city: 'Berlin', cardId: 0, payout: 25 },
          ],
        };

        const result = await GuardrailEnforcer.checkPlan(plan, ctx, makeSnapshot());

        expect(result.overridden).toBe(false);
        expect(result.plan).toBe(plan);
      });
    });

    describe('Guardrail 2: Force PICKUP', () => {
      const pickup: PickupOpportunity = {
        loadType: 'Cars',
        supplyCity: 'Stuttgart',
        bestPayout: 20,
        bestDeliveryCity: 'Berlin',
      };

      it('should force PICKUP when canPickup has opportunities and LLM chose PASS', async () => {
        const ctx = makeContext({
          canPickup: [pickup],
          demands: [makeDemand({ loadType: 'Cars', deliveryCity: 'Berlin', isDeliveryOnNetwork: true })],
        });
        const plan: TurnPlan = { type: AIActionType.PassTurn };

        const result = await GuardrailEnforcer.checkPlan(plan, ctx, makeSnapshot());

        expect(result.overridden).toBe(true);
        expect(result.plan.type).toBe(AIActionType.PickupLoad);
        if (result.plan.type === AIActionType.PickupLoad) {
          expect(result.plan.load).toBe('Cars');
          expect(result.plan.city).toBe('Stuttgart');
        }
        expect(result.reason).toContain('Forced PICKUP');
      });

      it('should inject PICKUP before BUILD when LLM chose BUILD', async () => {
        const ctx = makeContext({
          canPickup: [pickup],
          demands: [makeDemand({ loadType: 'Cars', deliveryCity: 'Berlin', isDeliveryOnNetwork: true })],
        });
        const plan: TurnPlan = {
          type: AIActionType.BuildTrack,
          segments: [makeSegment(10, 10, 10, 11)],
        };

        const result = await GuardrailEnforcer.checkPlan(plan, ctx, makeSnapshot());

        expect(result.overridden).toBe(true);
        expect(result.plan.type).toBe('MultiAction');
        if (result.plan.type === 'MultiAction') {
          expect(result.plan.steps).toHaveLength(2);
          expect(result.plan.steps[0].type).toBe(AIActionType.PickupLoad);
          expect(result.plan.steps[1].type).toBe(AIActionType.BuildTrack);
        }
        expect(result.reason).toContain('Injected PICKUP(s) before BUILD');
      });

      it('should NOT override when LLM chose MOVE (bot may be moving to deliver)', async () => {
        const ctx = makeContext({ canPickup: [pickup] });
        const plan: TurnPlan = {
          type: AIActionType.MoveTrain,
          path: [],
          fees: new Set(),
          totalFee: 0,
        };

        const result = await GuardrailEnforcer.checkPlan(plan, ctx, makeSnapshot());

        expect(result.overridden).toBe(false);
        expect(result.plan).toBe(plan);
      });

      it('should NOT override when LLM already chose PICKUP', async () => {
        const ctx = makeContext({ canPickup: [pickup] });
        const plan: TurnPlan = {
          type: AIActionType.PickupLoad,
          load: 'Cars',
          city: 'Stuttgart',
        };

        const result = await GuardrailEnforcer.checkPlan(plan, ctx, makeSnapshot());

        expect(result.overridden).toBe(false);
        expect(result.plan).toBe(plan);
      });

      it('should NOT override when LLM chose DELIVER', async () => {
        const delivery: DeliveryOpportunity = {
          loadType: 'Coal',
          deliveryCity: 'Berlin',
          payout: 25,
          cardIndex: 0,
        };
        const ctx = makeContext({ canPickup: [pickup], canDeliver: [delivery] });
        // Guardrail 1 fires first for DELIVER, but if canDeliver is handled,
        // test that DELIVER plan passes Guardrail 2
        const plan: TurnPlan = {
          type: AIActionType.DeliverLoad,
          load: 'Coal',
          city: 'Berlin',
          cardId: 0,
          payout: 25,
        };

        const result = await GuardrailEnforcer.checkPlan(plan, ctx, makeSnapshot());

        // Guardrail 1 fires (force DELIVER) but plan is already DELIVER, so no override
        expect(result.overridden).toBe(false);
      });

      it('should NOT override when LLM chose DISCARD_HAND', async () => {
        const ctx = makeContext({ canPickup: [pickup] });
        const plan: TurnPlan = { type: AIActionType.DiscardHand };

        const result = await GuardrailEnforcer.checkPlan(plan, ctx, makeSnapshot());

        expect(result.overridden).toBe(false);
        expect(result.plan).toBe(plan);
      });

      it('should pick the highest-payout pickup when multiple are available', async () => {
        const pickups: PickupOpportunity[] = [
          { loadType: 'Cars', supplyCity: 'Stuttgart', bestPayout: 20, bestDeliveryCity: 'Berlin' },
          { loadType: 'Wine', supplyCity: 'Stuttgart', bestPayout: 35, bestDeliveryCity: 'London' },
          { loadType: 'Iron', supplyCity: 'Stuttgart', bestPayout: 15, bestDeliveryCity: 'Paris' },
        ];
        const ctx = makeContext({
          canPickup: pickups,
          demands: [
            makeDemand({ loadType: 'Cars', deliveryCity: 'Berlin', isDeliveryOnNetwork: true }),
            makeDemand({ loadType: 'Wine', deliveryCity: 'London', isDeliveryOnNetwork: true }),
            makeDemand({ loadType: 'Iron', deliveryCity: 'Paris', isDeliveryOnNetwork: true }),
          ],
        });
        const plan: TurnPlan = { type: AIActionType.PassTurn };

        const result = await GuardrailEnforcer.checkPlan(plan, ctx, makeSnapshot());

        expect(result.overridden).toBe(true);
        if (result.plan.type === AIActionType.PickupLoad) {
          expect(result.plan.load).toBe('Wine');
        }
      });

      it('should NOT override MultiAction that already includes PICKUP', async () => {
        const ctx = makeContext({ canPickup: [pickup] });
        const plan: TurnPlan = {
          type: 'MultiAction',
          steps: [
            { type: AIActionType.PickupLoad, load: 'Cars', city: 'Stuttgart' },
            { type: AIActionType.BuildTrack, segments: [makeSegment(10, 10, 10, 11)] },
          ],
        };

        const result = await GuardrailEnforcer.checkPlan(plan, ctx, makeSnapshot());

        expect(result.overridden).toBe(false);
        expect(result.plan).toBe(plan);
      });
    });

    describe('Guardrail 3: Block UPGRADE during initialBuild', () => {
      it('should block UPGRADE during initialBuild phase', async () => {
        const ctx = makeContext({ isInitialBuild: true });
        const plan: TurnPlan = {
          type: AIActionType.UpgradeTrain,
          targetTrain: 'FastFreight',
          cost: 20,
        };

        const result = await GuardrailEnforcer.checkPlan(plan, ctx, makeSnapshot());

        expect(result.overridden).toBe(true);
        expect(result.plan.type).toBe(AIActionType.PassTurn);
        expect(result.reason).toContain('UPGRADE');
        expect(result.reason).toContain('initialBuild');
      });

      it('should allow UPGRADE outside initialBuild phase', async () => {
        const ctx = makeContext({ isInitialBuild: false });
        const plan: TurnPlan = {
          type: AIActionType.UpgradeTrain,
          targetTrain: 'FastFreight',
          cost: 20,
        };

        const result = await GuardrailEnforcer.checkPlan(plan, ctx, makeSnapshot());

        expect(result.overridden).toBe(false);
        expect(result.plan).toBe(plan);
      });
    });

    describe('No guardrail fires', () => {
      it('should pass through BUILD when no deliveries available', async () => {
        const ctx = makeContext({ canDeliver: [] });
        const plan: TurnPlan = {
          type: AIActionType.BuildTrack,
          segments: [makeSegment(10, 10, 10, 11)],
        };

        const result = await GuardrailEnforcer.checkPlan(plan, ctx, makeSnapshot());

        expect(result.overridden).toBe(false);
        expect(result.plan).toBe(plan);
        expect(result.reason).toBeUndefined();
      });

      it('should pass through PASS when no deliveries available', async () => {
        const ctx = makeContext({ canDeliver: [] });
        const plan: TurnPlan = { type: AIActionType.PassTurn };

        const result = await GuardrailEnforcer.checkPlan(plan, ctx, makeSnapshot());

        expect(result.overridden).toBe(false);
      });

      it('should pass through DISCARD_HAND without interference', async () => {
        const ctx = makeContext({ canDeliver: [] });
        const plan: TurnPlan = { type: AIActionType.DiscardHand };

        const result = await GuardrailEnforcer.checkPlan(plan, ctx, makeSnapshot());

        expect(result.overridden).toBe(false);
        expect(result.plan).toBe(plan);
      });

      it('should pass through PICKUP when no deliveries available', async () => {
        const ctx = makeContext({ canDeliver: [] });
        const plan: TurnPlan = {
          type: AIActionType.PickupLoad,
          load: 'Coal',
          city: 'Berlin',
        };

        const result = await GuardrailEnforcer.checkPlan(plan, ctx, makeSnapshot());

        expect(result.overridden).toBe(false);
      });
    });

    describe('Guardrail 4: No passing while carrying loads', () => {

      it('should override PassTurn to MoveTrain when bot has loads and delivery is on network', async () => {
        const movePlan = {
          type: AIActionType.MoveTrain as const,
          path: [{ row: 10, col: 10 }, { row: 10, col: 11 }, { row: 10, col: 12 }],
          fees: new Set<string>(),
          totalFee: 0,
        };
        mockResolveMove.mockResolvedValue({ success: true, plan: movePlan });
        const ctx = makeContext({
          loads: ['Wine'],
          demands: [
            makeDemand({ isLoadOnTrain: true, isDeliveryOnNetwork: true, deliveryCity: 'Berlin', payout: 20 }),
          ],
        });
        const plan: TurnPlan = { type: AIActionType.PassTurn };

        const result = await GuardrailEnforcer.checkPlan(plan, ctx, makeSnapshot());

        expect(result.overridden).toBe(true);
        expect(result.plan.type).toBe(AIActionType.MoveTrain);
        if (result.plan.type === AIActionType.MoveTrain) {
          expect(result.plan.path.length).toBeGreaterThan(0); // BE-008: real path, not empty
        }
        expect(result.reason).toContain('Blocked PASS with loads');
        expect(result.reason).toContain('Berlin');
        expect(mockResolveMove).toHaveBeenCalledWith({ to: 'Berlin' }, expect.any(Object));
      });

      it('should pick highest-payout delivery when multiple demands match', async () => {
        const movePlan = {
          type: AIActionType.MoveTrain as const,
          path: [{ row: 10, col: 10 }, { row: 10, col: 11 }],
          fees: new Set<string>(),
          totalFee: 0,
        };
        mockResolveMove.mockResolvedValue({ success: true, plan: movePlan });
        const ctx = makeContext({
          loads: ['Wine', 'Coal'],
          demands: [
            makeDemand({ loadType: 'Coal', isLoadOnTrain: true, isDeliveryOnNetwork: true, deliveryCity: 'Hamburg', payout: 10 }),
            makeDemand({ loadType: 'Wine', isLoadOnTrain: true, isDeliveryOnNetwork: true, deliveryCity: 'Paris', payout: 30 }),
          ],
        });
        const plan: TurnPlan = { type: AIActionType.PassTurn };

        const result = await GuardrailEnforcer.checkPlan(plan, ctx, makeSnapshot());

        expect(result.overridden).toBe(true);
        expect(result.plan.type).toBe(AIActionType.MoveTrain);
        expect(result.reason).toContain('Paris'); // highest payout demand
        // Should try Paris first (highest payout)
        expect(mockResolveMove).toHaveBeenCalledWith({ to: 'Paris' }, expect.any(Object));
      });

      it('should fall back to supply city movement when no delivery is on network', async () => {
        const movePlan = {
          type: AIActionType.MoveTrain as const,
          path: [{ row: 10, col: 10 }, { row: 10, col: 11 }],
          fees: new Set<string>(),
          totalFee: 0,
        };
        mockResolveMove.mockResolvedValue({ success: true, plan: movePlan });
        const ctx = makeContext({
          loads: ['Coal'],
          demands: [
            makeDemand({ loadType: 'Coal', isLoadOnTrain: true, isDeliveryOnNetwork: false, estimatedTrackCostToDelivery: 10, deliveryCity: 'München', payout: 15 }),
            makeDemand({ loadType: 'Wine', isLoadOnTrain: false, isSupplyOnNetwork: true, supplyCity: 'Bordeaux', payout: 25 }),
          ],
        });
        const plan: TurnPlan = { type: AIActionType.PassTurn };

        const result = await GuardrailEnforcer.checkPlan(plan, ctx, makeSnapshot());

        expect(result.overridden).toBe(true);
        expect(result.plan.type).toBe(AIActionType.MoveTrain);
        expect(result.reason).toContain('Bordeaux');
        expect(result.reason).toContain('pick up');
        expect(mockResolveMove).toHaveBeenCalledWith({ to: 'Bordeaux' }, expect.any(Object));
      });

      it('should NOT override when resolveMove fails for all targets (BE-008)', async () => {
        // Default mock returns failure — no paths computable
        const ctx = makeContext({
          loads: ['Wine'],
          demands: [
            makeDemand({ isLoadOnTrain: true, isDeliveryOnNetwork: true, deliveryCity: 'Berlin', payout: 20 }),
          ],
        });
        const plan: TurnPlan = { type: AIActionType.PassTurn };

        const result = await GuardrailEnforcer.checkPlan(plan, ctx, makeSnapshot());

        expect(result.overridden).toBe(false); // PassTurn allowed — no feasible path
        expect(mockResolveMove).toHaveBeenCalledWith({ to: 'Berlin' }, expect.any(Object));
      });

      it('should try next target when first resolveMove fails (BE-008)', async () => {
        // First call fails, second succeeds
        const movePlan = {
          type: AIActionType.MoveTrain as const,
          path: [{ row: 10, col: 10 }, { row: 10, col: 11 }],
          fees: new Set<string>(),
          totalFee: 0,
        };
        mockResolveMove
          .mockResolvedValueOnce({ success: false, error: 'No path to Paris' })
          .mockResolvedValueOnce({ success: true, plan: movePlan });
        const ctx = makeContext({
          loads: ['Wine', 'Coal'],
          demands: [
            makeDemand({ loadType: 'Wine', isLoadOnTrain: true, isDeliveryOnNetwork: true, deliveryCity: 'Paris', payout: 30 }),
            makeDemand({ loadType: 'Coal', isLoadOnTrain: true, isDeliveryOnNetwork: true, deliveryCity: 'Hamburg', payout: 10 }),
          ],
        });
        const plan: TurnPlan = { type: AIActionType.PassTurn };

        const result = await GuardrailEnforcer.checkPlan(plan, ctx, makeSnapshot());

        expect(result.overridden).toBe(true);
        expect(result.plan.type).toBe(AIActionType.MoveTrain);
        expect(result.reason).toContain('Hamburg'); // Falls back to second target
        expect(mockResolveMove).toHaveBeenCalledTimes(2);
      });

      it('should NOT override when bot has no loads', async () => {
        const ctx = makeContext({
          loads: [],
          demands: [makeDemand({ isLoadOnTrain: false, isDeliveryOnNetwork: true })],
        });
        const plan: TurnPlan = { type: AIActionType.PassTurn };

        const result = await GuardrailEnforcer.checkPlan(plan, ctx, makeSnapshot());

        expect(result.overridden).toBe(false);
      });

      it('should NOT override when plan is not PassTurn', async () => {
        const ctx = makeContext({
          loads: ['Wine'],
          demands: [makeDemand({ isLoadOnTrain: true, isDeliveryOnNetwork: true })],
        });
        const plan: TurnPlan = {
          type: AIActionType.BuildTrack,
          segments: [makeSegment(10, 10, 10, 11)],
        };

        const result = await GuardrailEnforcer.checkPlan(plan, ctx, makeSnapshot());

        expect(result.overridden).toBe(false);
      });

      it('should NOT override when no demands have delivery or supply on network', async () => {
        const ctx = makeContext({
          loads: ['Wine'],
          demands: [
            makeDemand({ isLoadOnTrain: true, isDeliveryOnNetwork: false }),
            makeDemand({ isLoadOnTrain: false, isSupplyOnNetwork: false }),
          ],
        });
        const plan: TurnPlan = { type: AIActionType.PassTurn };

        const result = await GuardrailEnforcer.checkPlan(plan, ctx, makeSnapshot());

        expect(result.overridden).toBe(false);
      });
    });

    describe('Guardrail 5: Drop undeliverable loads', () => {
      it('should drop a load with no matching demand card', async () => {
        const ctx = makeContext({
          loads: ['Iron'],
          demands: [], // No demands at all
        });
        const plan: TurnPlan = { type: AIActionType.BuildTrack, segments: [makeSegment(1, 1, 2, 2)], totalCost: 5 };

        const result = await GuardrailEnforcer.checkPlan(plan, ctx, makeSnapshot());

        expect(result.overridden).toBe(true);
        expect(result.plan.type).toBe(AIActionType.DropLoad);
        if (result.plan.type === AIActionType.DropLoad) {
          expect(result.plan.load).toBe('Iron');
        }
        expect(result.reason).toContain('undeliverable');
      });

      it('should drop a load when delivery city is unreachable and too expensive', async () => {
        const ctx = makeContext({
          loads: ['Coal'],
          demands: [{
            cardIndex: 1,
            loadType: 'Coal',
            supplyCity: 'Berlin',
            deliveryCity: 'London',
            payout: 20,
            isDeliveryOnNetwork: false,
            isDeliveryReachable: false,
            isSupplyOnNetwork: true,
            isLoadOnTrain: true,
            estimatedTrackCostToSupply: 0,
            estimatedTrackCostToDelivery: 100,
            isLoadAvailable: false, ferryRequired: false,
            loadChipTotal: 4, loadChipCarried: 0, estimatedTurns: 0,
            demandScore: 0, networkCitiesUnlocked: 0, victoryMajorCitiesEnRoute: 0,
          }] as DemandContext[],
        });
        const plan: TurnPlan = { type: AIActionType.BuildTrack, segments: [makeSegment(1, 1, 2, 2)], totalCost: 5 };

        // Bot has 50M, delivery costs 100M → infeasible
        const result = await GuardrailEnforcer.checkPlan(plan, ctx, makeSnapshot(50));

        expect(result.overridden).toBe(true);
        expect(result.plan.type).toBe(AIActionType.DropLoad);
      });

      it('should NOT drop a load when delivery city is on network', async () => {
        const ctx = makeContext({
          loads: ['Coal'],
          demands: [{
            cardIndex: 1,
            loadType: 'Coal',
            supplyCity: 'Berlin',
            deliveryCity: 'Hamburg',
            payout: 20,
            isDeliveryOnNetwork: true,
            isDeliveryReachable: true,
            isSupplyOnNetwork: true,
            isLoadOnTrain: true,
            estimatedTrackCostToSupply: 0,
            estimatedTrackCostToDelivery: 0,
            isLoadAvailable: false, ferryRequired: false,
            loadChipTotal: 4, loadChipCarried: 0, estimatedTurns: 0,
            demandScore: 0, networkCitiesUnlocked: 0, victoryMajorCitiesEnRoute: 0,
          }] as DemandContext[],
        });
        const plan: TurnPlan = { type: AIActionType.BuildTrack, segments: [makeSegment(1, 1, 2, 2)], totalCost: 5 };

        const result = await GuardrailEnforcer.checkPlan(plan, ctx, makeSnapshot());

        expect(result.overridden).toBe(false);
      });

      it('should NOT drop a load when build cost is within budget', async () => {
        const ctx = makeContext({
          loads: ['Coal'],
          demands: [{
            cardIndex: 1,
            loadType: 'Coal',
            supplyCity: 'Berlin',
            deliveryCity: 'Hamburg',
            payout: 20,
            isDeliveryOnNetwork: false,
            isDeliveryReachable: false,
            isSupplyOnNetwork: true,
            isLoadOnTrain: true,
            estimatedTrackCostToSupply: 0,
            estimatedTrackCostToDelivery: 10,
            isLoadAvailable: false, ferryRequired: false,
            loadChipTotal: 4, loadChipCarried: 0, estimatedTurns: 0,
            demandScore: 0, networkCitiesUnlocked: 0, victoryMajorCitiesEnRoute: 0,
          }] as DemandContext[],
        });
        const plan: TurnPlan = { type: AIActionType.BuildTrack, segments: [makeSegment(1, 1, 2, 2)], totalCost: 5 };

        // Bot has 50M, delivery costs 10M → feasible
        const result = await GuardrailEnforcer.checkPlan(plan, ctx, makeSnapshot(50));

        expect(result.overridden).toBe(false);
      });

      it('should drop multiple undeliverable loads as MultiAction', async () => {
        const ctx = makeContext({
          loads: ['Iron', 'Bauxite'],
          demands: [], // No demands for either load
        });
        const plan: TurnPlan = { type: AIActionType.BuildTrack, segments: [makeSegment(1, 1, 2, 2)], totalCost: 5 };

        const result = await GuardrailEnforcer.checkPlan(plan, ctx, makeSnapshot());

        expect(result.overridden).toBe(true);
        expect(result.plan.type).toBe('MultiAction');
        if (result.plan.type === 'MultiAction') {
          expect(result.plan.steps).toHaveLength(2);
          expect(result.plan.steps[0].type).toBe(AIActionType.DropLoad);
          expect(result.plan.steps[1].type).toBe(AIActionType.DropLoad);
        }
      });
    });

    describe('Guardrail 7: Strategic hand discard after 3 stuck turns', () => {
      it('should force DiscardHand after 3 consecutive stuck turns', async () => {
        const ctx = makeContext();
        const plan: TurnPlan = { type: AIActionType.PassTurn };

        const result = await GuardrailEnforcer.checkPlan(plan, ctx, makeSnapshot(), 3);

        expect(result.overridden).toBe(true);
        expect(result.plan.type).toBe(AIActionType.DiscardHand);
        expect(result.reason).toContain('Strategic hand discard');
      });

      it('should force DiscardHand after 4 consecutive stuck turns', async () => {
        const ctx = makeContext();
        const plan: TurnPlan = { type: AIActionType.BuildTrack, segments: [makeSegment(1, 1, 2, 2)], totalCost: 5 };

        const result = await GuardrailEnforcer.checkPlan(plan, ctx, makeSnapshot(), 4);

        expect(result.overridden).toBe(true);
        expect(result.plan.type).toBe(AIActionType.DiscardHand);
      });

      it('should NOT override if plan is already DiscardHand', async () => {
        const ctx = makeContext();
        const plan: TurnPlan = { type: AIActionType.DiscardHand };

        const result = await GuardrailEnforcer.checkPlan(plan, ctx, makeSnapshot(), 3);

        expect(result.overridden).toBe(false);
      });

      it('should NOT force DiscardHand with fewer than 3 stuck turns', async () => {
        const ctx = makeContext();
        const plan: TurnPlan = { type: AIActionType.PassTurn };

        const result = await GuardrailEnforcer.checkPlan(plan, ctx, makeSnapshot(), 2);

        expect(result.overridden).toBe(false);
      });
    });

    describe('Guardrail 6: Escape hatch after 5 stuck turns', () => {
      it('should force PassTurn after 5 consecutive stuck turns', async () => {
        const ctx = makeContext();
        const plan: TurnPlan = { type: AIActionType.BuildTrack, segments: [makeSegment(1, 1, 2, 2)], totalCost: 5 };

        const result = await GuardrailEnforcer.checkPlan(plan, ctx, makeSnapshot(), 5);

        expect(result.overridden).toBe(true);
        expect(result.plan.type).toBe(AIActionType.PassTurn);
        expect(result.reason).toContain('Escape hatch');
      });

      it('should force PassTurn after 6+ consecutive stuck turns', async () => {
        const ctx = makeContext();
        const plan: TurnPlan = { type: AIActionType.DiscardHand };

        const result = await GuardrailEnforcer.checkPlan(plan, ctx, makeSnapshot(), 6);

        expect(result.overridden).toBe(true);
        expect(result.plan.type).toBe(AIActionType.PassTurn);
      });

      it('should take priority over Guardrail 7 (G6 fires at 5, G7 at 3)', async () => {
        // At 5 turns, G6 escape should fire, NOT G7 discard
        const ctx = makeContext();
        const plan: TurnPlan = { type: AIActionType.BuildTrack, segments: [makeSegment(1, 1, 2, 2)], totalCost: 5 };

        const result = await GuardrailEnforcer.checkPlan(plan, ctx, makeSnapshot(), 5);

        expect(result.plan.type).toBe(AIActionType.PassTurn); // G6, not DiscardHand
      });
    });

    describe('bestPickups multi-load scenarios', () => {
      it('should return multiple pickups sorted by payout up to capacity', async () => {
        const pickup1: PickupOpportunity = { loadType: 'Coal', supplyCity: 'Berlin', bestPayout: 15 };
        const pickup2: PickupOpportunity = { loadType: 'Steel', supplyCity: 'Berlin', bestPayout: 25 };
        const pickup3: PickupOpportunity = { loadType: 'Wine', supplyCity: 'Berlin', bestPayout: 20 };
        const ctx = makeContext({
          canPickup: [pickup1, pickup2, pickup3],
          capacity: 2,
          loads: [],
          demands: [
            makeDemand({ loadType: 'Coal', isDeliveryOnNetwork: true }),
            makeDemand({ loadType: 'Steel', isDeliveryOnNetwork: true }),
            makeDemand({ loadType: 'Wine', isDeliveryOnNetwork: true }),
          ],
        });
        const plan: TurnPlan = { type: AIActionType.PassTurn };

        const result = await GuardrailEnforcer.checkPlan(plan, ctx, makeSnapshot());

        expect(result.overridden).toBe(true);
        expect(result.plan.type).toBe('MultiAction');
        if (result.plan.type === 'MultiAction') {
          expect(result.plan.steps).toHaveLength(2); // limited by capacity=2
          // Should be sorted: Steel (25) first, then Wine (20)
          expect(result.plan.steps[0].type).toBe(AIActionType.PickupLoad);
          if (result.plan.steps[0].type === AIActionType.PickupLoad) {
            expect(result.plan.steps[0].load).toBe('Steel');
          }
          if (result.plan.steps[1].type === AIActionType.PickupLoad) {
            expect(result.plan.steps[1].load).toBe('Wine');
          }
        }
      });

      it('should respect remaining capacity when bot already carries loads', async () => {
        const pickup1: PickupOpportunity = { loadType: 'Coal', supplyCity: 'Berlin', bestPayout: 15 };
        const pickup2: PickupOpportunity = { loadType: 'Steel', supplyCity: 'Berlin', bestPayout: 25 };
        const ctx = makeContext({
          canPickup: [pickup1, pickup2],
          capacity: 2,
          loads: ['Wine'], // Already carrying 1 of 2
          demands: [
            makeDemand({ loadType: 'Coal', isDeliveryOnNetwork: true }),
            makeDemand({ loadType: 'Steel', isDeliveryOnNetwork: true }),
          ],
        });
        const plan: TurnPlan = { type: AIActionType.PassTurn };

        const result = await GuardrailEnforcer.checkPlan(plan, ctx, makeSnapshot());

        expect(result.overridden).toBe(true);
        // Only 1 pickup slot available → single PICKUP, not MultiAction
        expect(result.plan.type).toBe(AIActionType.PickupLoad);
        if (result.plan.type === AIActionType.PickupLoad) {
          expect(result.plan.load).toBe('Steel'); // Highest payout
        }
      });

      it('should NOT override when at full capacity', async () => {
        const pickup1: PickupOpportunity = { loadType: 'Coal', supplyCity: 'Berlin', bestPayout: 15 };
        const ctx = makeContext({
          canPickup: [pickup1],
          capacity: 2,
          loads: ['Wine', 'Steel'], // Full
        });
        const plan: TurnPlan = { type: AIActionType.PassTurn };

        const result = await GuardrailEnforcer.checkPlan(plan, ctx, makeSnapshot());

        // G2 won't fire (capacity full), G4 will fire because loads > 0
        // But G4 needs demands with delivery/supply on network
        expect(result.plan.type).not.toBe(AIActionType.PickupLoad);
      });
    });

    describe('Guardrail 2: Pickup feasibility filtering (G2-G5 loop prevention)', () => {
      it('should include pickup with feasible delivery (on network)', async () => {
        const pickup: PickupOpportunity = { loadType: 'Coal', supplyCity: 'Berlin', bestPayout: 20, bestDeliveryCity: 'Hamburg' };
        const ctx = makeContext({
          canPickup: [pickup],
          demands: [makeDemand({ loadType: 'Coal', deliveryCity: 'Hamburg', isDeliveryOnNetwork: true })],
        });
        const plan: TurnPlan = { type: AIActionType.PassTurn };

        const result = await GuardrailEnforcer.checkPlan(plan, ctx, makeSnapshot());

        expect(result.overridden).toBe(true);
        expect(result.plan.type).toBe(AIActionType.PickupLoad);
        if (result.plan.type === AIActionType.PickupLoad) {
          expect(result.plan.load).toBe('Coal');
        }
      });

      it('should include pickup with feasible delivery (build cost within budget)', async () => {
        const pickup: PickupOpportunity = { loadType: 'Coal', supplyCity: 'Berlin', bestPayout: 20, bestDeliveryCity: 'Hamburg' };
        const ctx = makeContext({
          canPickup: [pickup],
          demands: [makeDemand({ loadType: 'Coal', deliveryCity: 'Hamburg', isDeliveryOnNetwork: false, estimatedTrackCostToDelivery: 10 })],
        });
        const plan: TurnPlan = { type: AIActionType.PassTurn };

        // Bot has 50M, delivery build cost is 10M → feasible
        const result = await GuardrailEnforcer.checkPlan(plan, ctx, makeSnapshot(50));

        expect(result.overridden).toBe(true);
        expect(result.plan.type).toBe(AIActionType.PickupLoad);
      });

      it('should exclude pickup when delivery is infeasible (off network and too expensive)', async () => {
        const pickup: PickupOpportunity = { loadType: 'Coal', supplyCity: 'Berlin', bestPayout: 20, bestDeliveryCity: 'London' };
        const ctx = makeContext({
          canPickup: [pickup],
          demands: [makeDemand({ loadType: 'Coal', deliveryCity: 'London', isDeliveryOnNetwork: false, estimatedTrackCostToDelivery: 100 })],
        });
        const plan: TurnPlan = { type: AIActionType.PassTurn };

        // Bot has 50M, delivery costs 100M → infeasible, G2 should NOT fire
        const result = await GuardrailEnforcer.checkPlan(plan, ctx, makeSnapshot(50));

        expect(result.overridden).toBe(false);
      });

      it('should exclude pickup with no matching demands', async () => {
        const pickup: PickupOpportunity = { loadType: 'Coal', supplyCity: 'Berlin', bestPayout: 20, bestDeliveryCity: 'Hamburg' };
        const ctx = makeContext({
          canPickup: [pickup],
          demands: [makeDemand({ loadType: 'Wine', isDeliveryOnNetwork: true })], // Different load type
        });
        const plan: TurnPlan = { type: AIActionType.PassTurn };

        const result = await GuardrailEnforcer.checkPlan(plan, ctx, makeSnapshot());

        expect(result.overridden).toBe(false);
      });

      it('should filter mixed pickups: only feasible ones included', async () => {
        const feasiblePickup: PickupOpportunity = { loadType: 'Wine', supplyCity: 'Berlin', bestPayout: 30, bestDeliveryCity: 'Paris' };
        const infeasiblePickup: PickupOpportunity = { loadType: 'Coal', supplyCity: 'Berlin', bestPayout: 40, bestDeliveryCity: 'London' };
        const ctx = makeContext({
          canPickup: [feasiblePickup, infeasiblePickup],
          demands: [
            makeDemand({ loadType: 'Wine', deliveryCity: 'Paris', isDeliveryOnNetwork: true }),
            makeDemand({ loadType: 'Coal', deliveryCity: 'London', isDeliveryOnNetwork: false, estimatedTrackCostToDelivery: 200 }),
          ],
        });
        const plan: TurnPlan = { type: AIActionType.PassTurn };

        // Coal has higher bestPayout but is infeasible → only Wine should be picked up
        const result = await GuardrailEnforcer.checkPlan(plan, ctx, makeSnapshot(50));

        expect(result.overridden).toBe(true);
        expect(result.plan.type).toBe(AIActionType.PickupLoad);
        if (result.plan.type === AIActionType.PickupLoad) {
          expect(result.plan.load).toBe('Wine');
        }
      });

      it('should return empty when all pickups are infeasible (G2 does not fire)', async () => {
        const pickup1: PickupOpportunity = { loadType: 'Coal', supplyCity: 'Berlin', bestPayout: 20, bestDeliveryCity: 'London' };
        const pickup2: PickupOpportunity = { loadType: 'Iron', supplyCity: 'Berlin', bestPayout: 15, bestDeliveryCity: 'Madrid' };
        const ctx = makeContext({
          canPickup: [pickup1, pickup2],
          demands: [
            makeDemand({ loadType: 'Coal', deliveryCity: 'London', isDeliveryOnNetwork: false, estimatedTrackCostToDelivery: 100 }),
            makeDemand({ loadType: 'Iron', deliveryCity: 'Madrid', isDeliveryOnNetwork: false, estimatedTrackCostToDelivery: 80 }),
          ],
        });
        const plan: TurnPlan = { type: AIActionType.PassTurn };

        // Bot has 0M → neither delivery is affordable
        const result = await GuardrailEnforcer.checkPlan(plan, ctx, makeSnapshot(0));

        expect(result.overridden).toBe(false);
      });

      it('should not count demands where load is already on train', async () => {
        const pickup: PickupOpportunity = { loadType: 'Coal', supplyCity: 'Berlin', bestPayout: 20, bestDeliveryCity: 'Hamburg' };
        const ctx = makeContext({
          canPickup: [pickup],
          demands: [
            // This demand already has Coal on the train, so picking up more Coal
            // should look for OTHER demand entries for Coal
            makeDemand({ loadType: 'Coal', deliveryCity: 'Hamburg', isDeliveryOnNetwork: true, isLoadOnTrain: true }),
          ],
        });
        const plan: TurnPlan = { type: AIActionType.PassTurn };

        // Only demand for Coal already has isLoadOnTrain: true → no unfulfilled demand
        const result = await GuardrailEnforcer.checkPlan(plan, ctx, makeSnapshot());

        expect(result.overridden).toBe(false);
      });

      it('should break the G2→G5 cycle: infeasible pickup not forced, then not dropped', async () => {
        // Scenario: Bot is at a city with available Coal, has a demand for Coal
        // delivery to London (off-network, costs 100M), but only has 10M.
        // G2 should NOT force the pickup because G5 would immediately drop it.
        const pickup: PickupOpportunity = { loadType: 'Coal', supplyCity: 'Berlin', bestPayout: 25, bestDeliveryCity: 'London' };
        const ctx = makeContext({
          canPickup: [pickup],
          loads: [], // Bot is empty
          demands: [
            makeDemand({
              loadType: 'Coal',
              deliveryCity: 'London',
              isDeliveryOnNetwork: false,
              estimatedTrackCostToDelivery: 100,
            }),
          ],
        });
        const plan: TurnPlan = {
          type: AIActionType.BuildTrack,
          segments: [makeSegment(10, 10, 10, 11)],
        };

        // Bot has only 10M → cannot afford 100M track to London
        const result = await GuardrailEnforcer.checkPlan(plan, ctx, makeSnapshot(10));

        // G2 should NOT fire because the only pickup is infeasible
        expect(result.overridden).toBe(false);
        expect(result.plan.type).toBe(AIActionType.BuildTrack);
      });
    });

    describe('Guardrail priority', () => {
      it('Force DELIVER takes priority over block UPGRADE during initialBuild', async () => {
        // Edge case: isInitialBuild=true, canDeliver has items, LLM chose UPGRADE
        // Guardrail 1 (force DELIVER) should fire before Guardrail 3 (block UPGRADE)
        const delivery: DeliveryOpportunity = {
          loadType: 'Coal',
          deliveryCity: 'Berlin',
          payout: 25,
          cardIndex: 0,
        };
        const ctx = makeContext({ isInitialBuild: true, canDeliver: [delivery] });
        const plan: TurnPlan = {
          type: AIActionType.UpgradeTrain,
          targetTrain: 'FastFreight',
          cost: 20,
        };

        const result = await GuardrailEnforcer.checkPlan(plan, ctx, makeSnapshot());

        expect(result.overridden).toBe(true);
        expect(result.plan.type).toBe(AIActionType.DeliverLoad);
        expect(result.reason).toContain('Forced DELIVER');
      });
    });

    describe('Guardrail 8: Movement budget enforcement', () => {
      /** Helper: build a path array of the given milepost count (path.length = mp + 1) */
      function makePath(mp: number): { row: number; col: number }[] {
        return Array.from({ length: mp + 1 }, (_, i) => ({ row: 10, col: 10 + i }));
      }

      it('should truncate last MOVE when MultiAction total exceeds speed', async () => {
        const ctx = makeContext({ speed: 9 });
        const plan: TurnPlan = {
          type: 'MultiAction',
          steps: [
            { type: AIActionType.MoveTrain, path: makePath(5), fees: new Set<string>(), totalFee: 0 },
            { type: AIActionType.PickupLoad, load: 'Coal', city: 'Berlin' },
            { type: AIActionType.MoveTrain, path: makePath(7), fees: new Set<string>(), totalFee: 0 },
          ],
        };
        // Total: 5 + 7 = 12mp, speed = 9, excess = 3 → last MOVE truncated from 7 to 4

        const result = await GuardrailEnforcer.checkPlan(plan, ctx, makeSnapshot());

        expect(result.overridden).toBe(false);
        expect(result.plan.type).toBe('MultiAction');
        if (result.plan.type === 'MultiAction') {
          expect(result.plan.steps).toHaveLength(3);
          // First MOVE unchanged (5mp)
          const firstMove = result.plan.steps[0];
          if (firstMove.type === AIActionType.MoveTrain) {
            expect(firstMove.path).toHaveLength(6); // 5mp + 1
          }
          // Last MOVE truncated (7mp → 4mp)
          const lastMove = result.plan.steps[2];
          if (lastMove.type === AIActionType.MoveTrain) {
            expect(lastMove.path).toHaveLength(5); // 4mp + 1
          }
        }
      });

      it('should not modify MultiAction plan within speed limit', async () => {
        const ctx = makeContext({ speed: 9 });
        const plan: TurnPlan = {
          type: 'MultiAction',
          steps: [
            { type: AIActionType.MoveTrain, path: makePath(4), fees: new Set<string>(), totalFee: 0 },
            { type: AIActionType.PickupLoad, load: 'Coal', city: 'Berlin' },
            { type: AIActionType.MoveTrain, path: makePath(5), fees: new Set<string>(), totalFee: 0 },
          ],
        };
        // Total: 4 + 5 = 9mp = speed limit, no truncation

        const result = await GuardrailEnforcer.checkPlan(plan, ctx, makeSnapshot());

        expect(result.overridden).toBe(false);
        expect(result.plan).toBe(plan); // Same reference — no changes
      });

      it('should remove MOVE step entirely when truncation leaves path of length 1', async () => {
        const ctx = makeContext({ speed: 9 });
        const plan: TurnPlan = {
          type: 'MultiAction',
          steps: [
            { type: AIActionType.MoveTrain, path: makePath(9), fees: new Set<string>(), totalFee: 0 },
            { type: AIActionType.PickupLoad, load: 'Coal', city: 'Berlin' },
            { type: AIActionType.MoveTrain, path: makePath(3), fees: new Set<string>(), totalFee: 0 },
          ],
        };
        // Total: 9 + 3 = 12mp, excess = 3, last MOVE has 3mp → removed entirely

        const result = await GuardrailEnforcer.checkPlan(plan, ctx, makeSnapshot());

        expect(result.overridden).toBe(false);
        expect(result.plan.type).toBe('MultiAction');
        if (result.plan.type === 'MultiAction') {
          expect(result.plan.steps).toHaveLength(2); // MOVE step removed
          expect(result.plan.steps[0].type).toBe(AIActionType.MoveTrain);
          expect(result.plan.steps[1].type).toBe(AIActionType.PickupLoad);
        }
      });

      it('should log a warning when truncation occurs', async () => {
        const warnSpy = jest.spyOn(console, 'warn').mockImplementation();
        const ctx = makeContext({ speed: 9 });
        const plan: TurnPlan = {
          type: 'MultiAction',
          steps: [
            { type: AIActionType.MoveTrain, path: makePath(6), fees: new Set<string>(), totalFee: 0 },
            { type: AIActionType.MoveTrain, path: makePath(6), fees: new Set<string>(), totalFee: 0 },
          ],
        };
        // Total: 6 + 6 = 12mp > 9

        await GuardrailEnforcer.checkPlan(plan, ctx, makeSnapshot());

        expect(warnSpy).toHaveBeenCalledWith(
          expect.stringContaining('[Guardrail 8]'),
        );
        expect(warnSpy).toHaveBeenCalledWith(
          expect.stringContaining('12mp > 9mp'),
        );
        warnSpy.mockRestore();
      });

      it('should not affect single MOVE plans (only MultiAction)', async () => {
        const ctx = makeContext({ speed: 9 });
        const plan: TurnPlan = {
          type: AIActionType.MoveTrain,
          path: makePath(12), // 12mp > 9, but not MultiAction
          fees: new Set<string>(),
          totalFee: 0,
        };

        const result = await GuardrailEnforcer.checkPlan(plan, ctx, makeSnapshot());

        // Guardrail 8 only handles MultiAction; single MOVE passes through
        expect(result.overridden).toBe(false);
        expect(result.plan).toBe(plan);
      });
    });
  });
});
