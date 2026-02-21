import { GuardrailEnforcer } from '../../services/ai/GuardrailEnforcer';
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

describe('GuardrailEnforcer', () => {
  describe('checkPlan', () => {
    describe('Guardrail 1: Force DELIVER', () => {
      it('should force DELIVER when canDeliver has opportunities and LLM chose BUILD', () => {
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

        const result = GuardrailEnforcer.checkPlan(plan, ctx, makeSnapshot());

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

      it('should force DELIVER when canDeliver has opportunities and LLM chose PASS', () => {
        const delivery: DeliveryOpportunity = {
          loadType: 'Wine',
          deliveryCity: 'Paris',
          payout: 30,
          cardIndex: 1,
        };
        const ctx = makeContext({ canDeliver: [delivery] });
        const plan: TurnPlan = { type: AIActionType.PassTurn };

        const result = GuardrailEnforcer.checkPlan(plan, ctx, makeSnapshot());

        expect(result.overridden).toBe(true);
        expect(result.plan.type).toBe(AIActionType.DeliverLoad);
      });

      it('should pick the highest-payout delivery when multiple are available', () => {
        const deliveries: DeliveryOpportunity[] = [
          { loadType: 'Coal', deliveryCity: 'Berlin', payout: 15, cardIndex: 0 },
          { loadType: 'Wine', deliveryCity: 'Paris', payout: 40, cardIndex: 1 },
          { loadType: 'Iron', deliveryCity: 'Hamburg', payout: 25, cardIndex: 2 },
        ];
        const ctx = makeContext({ canDeliver: deliveries });
        const plan: TurnPlan = { type: AIActionType.MoveTrain, path: [], fees: new Set(), totalFee: 0 };

        const result = GuardrailEnforcer.checkPlan(plan, ctx, makeSnapshot());

        expect(result.overridden).toBe(true);
        if (result.plan.type === AIActionType.DeliverLoad) {
          expect(result.plan.load).toBe('Wine');
          expect(result.plan.payout).toBe(40);
        }
      });

      it('should NOT override when LLM already chose DELIVER', () => {
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

        const result = GuardrailEnforcer.checkPlan(plan, ctx, makeSnapshot());

        expect(result.overridden).toBe(false);
        expect(result.plan).toBe(plan); // Same reference
      });

      it('should NOT override MultiAction that includes a DELIVER step', () => {
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

        const result = GuardrailEnforcer.checkPlan(plan, ctx, makeSnapshot());

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

      it('should force PICKUP when canPickup has opportunities and LLM chose PASS', () => {
        const ctx = makeContext({ canPickup: [pickup] });
        const plan: TurnPlan = { type: AIActionType.PassTurn };

        const result = GuardrailEnforcer.checkPlan(plan, ctx, makeSnapshot());

        expect(result.overridden).toBe(true);
        expect(result.plan.type).toBe(AIActionType.PickupLoad);
        if (result.plan.type === AIActionType.PickupLoad) {
          expect(result.plan.load).toBe('Cars');
          expect(result.plan.city).toBe('Stuttgart');
        }
        expect(result.reason).toContain('Forced PICKUP');
      });

      it('should inject PICKUP before BUILD when LLM chose BUILD', () => {
        const ctx = makeContext({ canPickup: [pickup] });
        const plan: TurnPlan = {
          type: AIActionType.BuildTrack,
          segments: [makeSegment(10, 10, 10, 11)],
        };

        const result = GuardrailEnforcer.checkPlan(plan, ctx, makeSnapshot());

        expect(result.overridden).toBe(true);
        expect(result.plan.type).toBe('MultiAction');
        if (result.plan.type === 'MultiAction') {
          expect(result.plan.steps).toHaveLength(2);
          expect(result.plan.steps[0].type).toBe(AIActionType.PickupLoad);
          expect(result.plan.steps[1].type).toBe(AIActionType.BuildTrack);
        }
        expect(result.reason).toContain('Injected PICKUP before BUILD');
      });

      it('should NOT override when LLM chose MOVE (bot may be moving to deliver)', () => {
        const ctx = makeContext({ canPickup: [pickup] });
        const plan: TurnPlan = {
          type: AIActionType.MoveTrain,
          path: [],
          fees: new Set(),
          totalFee: 0,
        };

        const result = GuardrailEnforcer.checkPlan(plan, ctx, makeSnapshot());

        expect(result.overridden).toBe(false);
        expect(result.plan).toBe(plan);
      });

      it('should NOT override when LLM already chose PICKUP', () => {
        const ctx = makeContext({ canPickup: [pickup] });
        const plan: TurnPlan = {
          type: AIActionType.PickupLoad,
          load: 'Cars',
          city: 'Stuttgart',
        };

        const result = GuardrailEnforcer.checkPlan(plan, ctx, makeSnapshot());

        expect(result.overridden).toBe(false);
        expect(result.plan).toBe(plan);
      });

      it('should NOT override when LLM chose DELIVER', () => {
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

        const result = GuardrailEnforcer.checkPlan(plan, ctx, makeSnapshot());

        // Guardrail 1 fires (force DELIVER) but plan is already DELIVER, so no override
        expect(result.overridden).toBe(false);
      });

      it('should NOT override when LLM chose DISCARD_HAND', () => {
        const ctx = makeContext({ canPickup: [pickup] });
        const plan: TurnPlan = { type: AIActionType.DiscardHand };

        const result = GuardrailEnforcer.checkPlan(plan, ctx, makeSnapshot());

        expect(result.overridden).toBe(false);
        expect(result.plan).toBe(plan);
      });

      it('should pick the highest-payout pickup when multiple are available', () => {
        const pickups: PickupOpportunity[] = [
          { loadType: 'Cars', supplyCity: 'Stuttgart', bestPayout: 20, bestDeliveryCity: 'Berlin' },
          { loadType: 'Wine', supplyCity: 'Stuttgart', bestPayout: 35, bestDeliveryCity: 'London' },
          { loadType: 'Iron', supplyCity: 'Stuttgart', bestPayout: 15, bestDeliveryCity: 'Paris' },
        ];
        const ctx = makeContext({ canPickup: pickups });
        const plan: TurnPlan = { type: AIActionType.PassTurn };

        const result = GuardrailEnforcer.checkPlan(plan, ctx, makeSnapshot());

        expect(result.overridden).toBe(true);
        if (result.plan.type === AIActionType.PickupLoad) {
          expect(result.plan.load).toBe('Wine');
        }
      });

      it('should NOT override MultiAction that already includes PICKUP', () => {
        const ctx = makeContext({ canPickup: [pickup] });
        const plan: TurnPlan = {
          type: 'MultiAction',
          steps: [
            { type: AIActionType.PickupLoad, load: 'Cars', city: 'Stuttgart' },
            { type: AIActionType.BuildTrack, segments: [makeSegment(10, 10, 10, 11)] },
          ],
        };

        const result = GuardrailEnforcer.checkPlan(plan, ctx, makeSnapshot());

        expect(result.overridden).toBe(false);
        expect(result.plan).toBe(plan);
      });
    });

    describe('Guardrail 3: Block UPGRADE during initialBuild', () => {
      it('should block UPGRADE during initialBuild phase', () => {
        const ctx = makeContext({ isInitialBuild: true });
        const plan: TurnPlan = {
          type: AIActionType.UpgradeTrain,
          targetTrain: 'FastFreight',
          cost: 20,
        };

        const result = GuardrailEnforcer.checkPlan(plan, ctx, makeSnapshot());

        expect(result.overridden).toBe(true);
        expect(result.plan.type).toBe(AIActionType.PassTurn);
        expect(result.reason).toContain('UPGRADE');
        expect(result.reason).toContain('initialBuild');
      });

      it('should allow UPGRADE outside initialBuild phase', () => {
        const ctx = makeContext({ isInitialBuild: false });
        const plan: TurnPlan = {
          type: AIActionType.UpgradeTrain,
          targetTrain: 'FastFreight',
          cost: 20,
        };

        const result = GuardrailEnforcer.checkPlan(plan, ctx, makeSnapshot());

        expect(result.overridden).toBe(false);
        expect(result.plan).toBe(plan);
      });
    });

    describe('No guardrail fires', () => {
      it('should pass through BUILD when no deliveries available', () => {
        const ctx = makeContext({ canDeliver: [] });
        const plan: TurnPlan = {
          type: AIActionType.BuildTrack,
          segments: [makeSegment(10, 10, 10, 11)],
        };

        const result = GuardrailEnforcer.checkPlan(plan, ctx, makeSnapshot());

        expect(result.overridden).toBe(false);
        expect(result.plan).toBe(plan);
        expect(result.reason).toBeUndefined();
      });

      it('should pass through PASS when no deliveries available', () => {
        const ctx = makeContext({ canDeliver: [] });
        const plan: TurnPlan = { type: AIActionType.PassTurn };

        const result = GuardrailEnforcer.checkPlan(plan, ctx, makeSnapshot());

        expect(result.overridden).toBe(false);
      });

      it('should pass through DISCARD_HAND without interference', () => {
        const ctx = makeContext({ canDeliver: [] });
        const plan: TurnPlan = { type: AIActionType.DiscardHand };

        const result = GuardrailEnforcer.checkPlan(plan, ctx, makeSnapshot());

        expect(result.overridden).toBe(false);
        expect(result.plan).toBe(plan);
      });

      it('should pass through PICKUP when no deliveries available', () => {
        const ctx = makeContext({ canDeliver: [] });
        const plan: TurnPlan = {
          type: AIActionType.PickupLoad,
          load: 'Coal',
          city: 'Berlin',
        };

        const result = GuardrailEnforcer.checkPlan(plan, ctx, makeSnapshot());

        expect(result.overridden).toBe(false);
      });
    });

    describe('Guardrail 4: Block BUILD toward unaffordable targets', () => {
      function makeDemand(overrides?: Partial<DemandContext>): DemandContext {
        return {
          cardIndex: 0,
          loadType: 'Wine',
          supplyCity: 'Bordeaux',
          deliveryCity: 'Barcelona',
          payout: 20,
          isSupplyReachable: true,
          isDeliveryReachable: true,
          isSupplyOnNetwork: true,
          isDeliveryOnNetwork: false,
          estimatedTrackCostToSupply: 0,
          estimatedTrackCostToDelivery: 25,
          isLoadAvailable: true,
          isLoadOnTrain: false,
          ferryRequired: false,
          ...overrides,
        };
      }

      it('should block standalone BUILD when track cost exceeds payout', () => {
        const demand = makeDemand({ payout: 20, estimatedTrackCostToSupply: 5, estimatedTrackCostToDelivery: 20 });
        const ctx = makeContext({ demands: [demand], isInitialBuild: false });
        const plan: TurnPlan = {
          type: AIActionType.BuildTrack,
          segments: [makeSegment(10, 10, 10, 11)],
          targetCity: 'Barcelona',
        };

        const result = GuardrailEnforcer.checkPlan(plan, ctx, makeSnapshot());

        expect(result.overridden).toBe(true);
        expect(result.plan.type).toBe(AIActionType.PassTurn);
        expect(result.reason).toContain('Blocked BUILD toward Barcelona');
        expect(result.reason).toContain('exceeds payout');
      });

      it('should strip BUILD from MultiAction when target is unaffordable', () => {
        const demand = makeDemand({ payout: 15, estimatedTrackCostToSupply: 0, estimatedTrackCostToDelivery: 30 });
        const ctx = makeContext({ demands: [demand], isInitialBuild: false });
        const plan: TurnPlan = {
          type: 'MultiAction',
          steps: [
            { type: AIActionType.PickupLoad, load: 'Wine', city: 'Bordeaux' },
            { type: AIActionType.BuildTrack, segments: [makeSegment(10, 10, 10, 11)], targetCity: 'Barcelona' },
          ],
        };

        const result = GuardrailEnforcer.checkPlan(plan, ctx, makeSnapshot());

        expect(result.overridden).toBe(true);
        expect(result.plan.type).toBe(AIActionType.PickupLoad);
        expect(result.reason).toContain('Blocked BUILD toward Barcelona');
        expect(result.reason).toContain('Keeping other actions');
      });

      it('should NOT block BUILD when track cost is less than payout', () => {
        const demand = makeDemand({ payout: 30, estimatedTrackCostToSupply: 5, estimatedTrackCostToDelivery: 10 });
        const ctx = makeContext({ demands: [demand], isInitialBuild: false });
        const plan: TurnPlan = {
          type: AIActionType.BuildTrack,
          segments: [makeSegment(10, 10, 10, 11)],
          targetCity: 'Barcelona',
        };

        const result = GuardrailEnforcer.checkPlan(plan, ctx, makeSnapshot());

        expect(result.overridden).toBe(false);
        expect(result.plan).toBe(plan);
      });

      it('should NOT block BUILD during initialBuild phase', () => {
        const demand = makeDemand({ payout: 15, estimatedTrackCostToSupply: 10, estimatedTrackCostToDelivery: 20 });
        const ctx = makeContext({ demands: [demand], isInitialBuild: true });
        const plan: TurnPlan = {
          type: AIActionType.BuildTrack,
          segments: [makeSegment(10, 10, 10, 11)],
          targetCity: 'Barcelona',
        };

        const result = GuardrailEnforcer.checkPlan(plan, ctx, makeSnapshot());

        expect(result.overridden).toBe(false);
        expect(result.plan).toBe(plan);
      });

      it('should NOT block BUILD when targetCity is not set', () => {
        const demand = makeDemand({ payout: 10, estimatedTrackCostToSupply: 5, estimatedTrackCostToDelivery: 20 });
        const ctx = makeContext({ demands: [demand], isInitialBuild: false });
        const plan: TurnPlan = {
          type: AIActionType.BuildTrack,
          segments: [makeSegment(10, 10, 10, 11)],
          // No targetCity
        };

        const result = GuardrailEnforcer.checkPlan(plan, ctx, makeSnapshot());

        expect(result.overridden).toBe(false);
        expect(result.plan).toBe(plan);
      });

      it('should NOT block BUILD when no demand matches the target city', () => {
        const demand = makeDemand({ deliveryCity: 'Paris', supplyCity: 'Lyon', payout: 10, estimatedTrackCostToSupply: 5, estimatedTrackCostToDelivery: 20 });
        const ctx = makeContext({ demands: [demand], isInitialBuild: false });
        const plan: TurnPlan = {
          type: AIActionType.BuildTrack,
          segments: [makeSegment(10, 10, 10, 11)],
          targetCity: 'Barcelona', // Doesn't match any demand
        };

        const result = GuardrailEnforcer.checkPlan(plan, ctx, makeSnapshot());

        expect(result.overridden).toBe(false);
        expect(result.plan).toBe(plan);
      });

      it('should match targetCity against supplyCity too', () => {
        const demand = makeDemand({ supplyCity: 'Barcelona', deliveryCity: 'Berlin', payout: 15, estimatedTrackCostToSupply: 20, estimatedTrackCostToDelivery: 0 });
        const ctx = makeContext({ demands: [demand], isInitialBuild: false });
        const plan: TurnPlan = {
          type: AIActionType.BuildTrack,
          segments: [makeSegment(10, 10, 10, 11)],
          targetCity: 'Barcelona',
        };

        const result = GuardrailEnforcer.checkPlan(plan, ctx, makeSnapshot());

        expect(result.overridden).toBe(true);
        expect(result.plan.type).toBe(AIActionType.PassTurn);
        expect(result.reason).toContain('Blocked BUILD toward Barcelona');
      });

      it('should NOT block BUILD when isLoadOnTrain=true and only delivery cost matters', () => {
        // Bot HAS the cheese — supply cost is irrelevant, only delivery cost counts
        // Supply cost (25M) + delivery cost (7M) = 32M > 22M payout → would block with old logic
        // But effective cost = 7M (delivery only) < 22M payout → should NOT block
        const demand = makeDemand({
          payout: 22,
          estimatedTrackCostToSupply: 25,
          estimatedTrackCostToDelivery: 7,
          isLoadOnTrain: true,
          deliveryCity: 'Barcelona',
        });
        const ctx = makeContext({ demands: [demand], isInitialBuild: false });
        const plan: TurnPlan = {
          type: AIActionType.BuildTrack,
          segments: [makeSegment(10, 10, 10, 11)],
          targetCity: 'Barcelona',
        };

        const result = GuardrailEnforcer.checkPlan(plan, ctx, makeSnapshot());

        expect(result.overridden).toBe(false);
        expect(result.plan).toBe(plan);
      });

      it('should block BUILD when isLoadOnTrain=true but delivery cost alone exceeds payout', () => {
        const demand = makeDemand({
          payout: 10,
          estimatedTrackCostToSupply: 25,
          estimatedTrackCostToDelivery: 15,
          isLoadOnTrain: true,
          deliveryCity: 'Barcelona',
        });
        const ctx = makeContext({ demands: [demand], isInitialBuild: false });
        const plan: TurnPlan = {
          type: AIActionType.BuildTrack,
          segments: [makeSegment(10, 10, 10, 11)],
          targetCity: 'Barcelona',
        };

        const result = GuardrailEnforcer.checkPlan(plan, ctx, makeSnapshot());

        expect(result.overridden).toBe(true);
        expect(result.plan.type).toBe(AIActionType.PassTurn);
        expect(result.reason).toContain('Blocked BUILD toward Barcelona');
      });

      it('should NOT block BUILD when at least one matching demand justifies it', () => {
        // Two demands match the target city. First is unaffordable, second is affordable.
        // Should NOT block because the second demand justifies the build.
        const demandBad = makeDemand({
          payout: 10,
          estimatedTrackCostToSupply: 15,
          estimatedTrackCostToDelivery: 10,
          isLoadOnTrain: false,
          deliveryCity: 'Barcelona',
        });
        const demandGood = makeDemand({
          cardIndex: 1,
          loadType: 'Oil',
          payout: 30,
          estimatedTrackCostToSupply: 5,
          estimatedTrackCostToDelivery: 10,
          isLoadOnTrain: false,
          deliveryCity: 'Barcelona',
        });
        const ctx = makeContext({ demands: [demandBad, demandGood], isInitialBuild: false });
        const plan: TurnPlan = {
          type: AIActionType.BuildTrack,
          segments: [makeSegment(10, 10, 10, 11)],
          targetCity: 'Barcelona',
        };

        const result = GuardrailEnforcer.checkPlan(plan, ctx, makeSnapshot());

        expect(result.overridden).toBe(false);
        expect(result.plan).toBe(plan);
      });

      it('should block BUILD only when ALL matching demands are unaffordable', () => {
        const demand1 = makeDemand({
          payout: 10,
          estimatedTrackCostToSupply: 15,
          estimatedTrackCostToDelivery: 5,
          deliveryCity: 'Barcelona',
        });
        const demand2 = makeDemand({
          cardIndex: 1,
          loadType: 'Oil',
          payout: 12,
          estimatedTrackCostToSupply: 8,
          estimatedTrackCostToDelivery: 10,
          deliveryCity: 'Barcelona',
        });
        const ctx = makeContext({ demands: [demand1, demand2], isInitialBuild: false });
        const plan: TurnPlan = {
          type: AIActionType.BuildTrack,
          segments: [makeSegment(10, 10, 10, 11)],
          targetCity: 'Barcelona',
        };

        const result = GuardrailEnforcer.checkPlan(plan, ctx, makeSnapshot());

        expect(result.overridden).toBe(true);
        expect(result.plan.type).toBe(AIActionType.PassTurn);
      });
    });

    describe('Guardrail priority', () => {
      it('Force DELIVER takes priority over block UPGRADE during initialBuild', () => {
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

        const result = GuardrailEnforcer.checkPlan(plan, ctx, makeSnapshot());

        expect(result.overridden).toBe(true);
        expect(result.plan.type).toBe(AIActionType.DeliverLoad);
        expect(result.reason).toContain('Forced DELIVER');
      });
    });
  });
});
