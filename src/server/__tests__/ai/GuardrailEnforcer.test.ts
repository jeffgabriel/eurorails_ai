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
        expect(result.reason).toContain('Injected PICKUP(s) before BUILD');
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

    describe('Guardrail 4: No passing while carrying loads', () => {
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
          ...overrides,
        };
      }

      it('should override PassTurn to MoveTrain when bot has loads and delivery is on network', () => {
        const ctx = makeContext({
          loads: ['Wine'],
          demands: [
            makeDemand({ isLoadOnTrain: true, isDeliveryOnNetwork: true, deliveryCity: 'Berlin', payout: 20 }),
          ],
        });
        const plan: TurnPlan = { type: AIActionType.PassTurn };

        const result = GuardrailEnforcer.checkPlan(plan, ctx, makeSnapshot());

        expect(result.overridden).toBe(true);
        expect(result.plan.type).toBe(AIActionType.MoveTrain);
        expect(result.reason).toContain('Blocked PASS with loads');
        expect(result.reason).toContain('Berlin');
      });

      it('should pick highest-payout delivery when multiple demands match', () => {
        const ctx = makeContext({
          loads: ['Wine', 'Coal'],
          demands: [
            makeDemand({ loadType: 'Coal', isLoadOnTrain: true, isDeliveryOnNetwork: true, deliveryCity: 'Hamburg', payout: 10 }),
            makeDemand({ loadType: 'Wine', isLoadOnTrain: true, isDeliveryOnNetwork: true, deliveryCity: 'Paris', payout: 30 }),
          ],
        });
        const plan: TurnPlan = { type: AIActionType.PassTurn };

        const result = GuardrailEnforcer.checkPlan(plan, ctx, makeSnapshot());

        expect(result.overridden).toBe(true);
        expect(result.plan.type).toBe(AIActionType.MoveTrain);
        expect(result.reason).toContain('Paris'); // highest payout demand
      });

      it('should fall back to supply city movement when no delivery is on network', () => {
        const ctx = makeContext({
          loads: ['Coal'],
          demands: [
            makeDemand({ loadType: 'Coal', isLoadOnTrain: true, isDeliveryOnNetwork: false, estimatedTrackCostToDelivery: 10, deliveryCity: 'München', payout: 15 }),
            makeDemand({ loadType: 'Wine', isLoadOnTrain: false, isSupplyOnNetwork: true, supplyCity: 'Bordeaux', payout: 25 }),
          ],
        });
        const plan: TurnPlan = { type: AIActionType.PassTurn };

        const result = GuardrailEnforcer.checkPlan(plan, ctx, makeSnapshot());

        expect(result.overridden).toBe(true);
        expect(result.plan.type).toBe(AIActionType.MoveTrain);
        expect(result.reason).toContain('Bordeaux');
        expect(result.reason).toContain('pick up');
      });

      it('should NOT override when bot has no loads', () => {
        const ctx = makeContext({
          loads: [],
          demands: [makeDemand({ isLoadOnTrain: false, isDeliveryOnNetwork: true })],
        });
        const plan: TurnPlan = { type: AIActionType.PassTurn };

        const result = GuardrailEnforcer.checkPlan(plan, ctx, makeSnapshot());

        expect(result.overridden).toBe(false);
      });

      it('should NOT override when plan is not PassTurn', () => {
        const ctx = makeContext({
          loads: ['Wine'],
          demands: [makeDemand({ isLoadOnTrain: true, isDeliveryOnNetwork: true })],
        });
        const plan: TurnPlan = {
          type: AIActionType.BuildTrack,
          segments: [makeSegment(10, 10, 10, 11)],
        };

        const result = GuardrailEnforcer.checkPlan(plan, ctx, makeSnapshot());

        expect(result.overridden).toBe(false);
      });

      it('should NOT override when no demands have delivery or supply on network', () => {
        const ctx = makeContext({
          loads: ['Wine'],
          demands: [
            makeDemand({ isLoadOnTrain: true, isDeliveryOnNetwork: false }),
            makeDemand({ isLoadOnTrain: false, isSupplyOnNetwork: false }),
          ],
        });
        const plan: TurnPlan = { type: AIActionType.PassTurn };

        const result = GuardrailEnforcer.checkPlan(plan, ctx, makeSnapshot());

        expect(result.overridden).toBe(false);
      });
    });

    describe('Guardrail 5: Drop undeliverable loads', () => {
      it('should drop a load with no matching demand card', () => {
        const ctx = makeContext({
          loads: ['Iron'],
          demands: [], // No demands at all
        });
        const plan: TurnPlan = { type: AIActionType.BuildTrack, segments: [makeSegment(1, 1, 2, 2)], totalCost: 5 };

        const result = GuardrailEnforcer.checkPlan(plan, ctx, makeSnapshot());

        expect(result.overridden).toBe(true);
        expect(result.plan.type).toBe(AIActionType.DropLoad);
        if (result.plan.type === AIActionType.DropLoad) {
          expect(result.plan.load).toBe('Iron');
        }
        expect(result.reason).toContain('undeliverable');
      });

      it('should drop a load when delivery city is unreachable and too expensive', () => {
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
            bestPayout: 20,
          }] as DemandContext[],
        });
        const plan: TurnPlan = { type: AIActionType.BuildTrack, segments: [makeSegment(1, 1, 2, 2)], totalCost: 5 };

        // Bot has 50M, delivery costs 100M → infeasible
        const result = GuardrailEnforcer.checkPlan(plan, ctx, makeSnapshot(50));

        expect(result.overridden).toBe(true);
        expect(result.plan.type).toBe(AIActionType.DropLoad);
      });

      it('should NOT drop a load when delivery city is on network', () => {
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
            bestPayout: 20,
          }] as DemandContext[],
        });
        const plan: TurnPlan = { type: AIActionType.BuildTrack, segments: [makeSegment(1, 1, 2, 2)], totalCost: 5 };

        const result = GuardrailEnforcer.checkPlan(plan, ctx, makeSnapshot());

        expect(result.overridden).toBe(false);
      });

      it('should NOT drop a load when build cost is within budget', () => {
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
            bestPayout: 20,
          }] as DemandContext[],
        });
        const plan: TurnPlan = { type: AIActionType.BuildTrack, segments: [makeSegment(1, 1, 2, 2)], totalCost: 5 };

        // Bot has 50M, delivery costs 10M → feasible
        const result = GuardrailEnforcer.checkPlan(plan, ctx, makeSnapshot(50));

        expect(result.overridden).toBe(false);
      });

      it('should drop multiple undeliverable loads as MultiAction', () => {
        const ctx = makeContext({
          loads: ['Iron', 'Bauxite'],
          demands: [], // No demands for either load
        });
        const plan: TurnPlan = { type: AIActionType.BuildTrack, segments: [makeSegment(1, 1, 2, 2)], totalCost: 5 };

        const result = GuardrailEnforcer.checkPlan(plan, ctx, makeSnapshot());

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
      it('should force DiscardHand after 3 consecutive stuck turns', () => {
        const ctx = makeContext();
        const plan: TurnPlan = { type: AIActionType.PassTurn };

        const result = GuardrailEnforcer.checkPlan(plan, ctx, makeSnapshot(), 3);

        expect(result.overridden).toBe(true);
        expect(result.plan.type).toBe(AIActionType.DiscardHand);
        expect(result.reason).toContain('Strategic hand discard');
      });

      it('should force DiscardHand after 4 consecutive stuck turns', () => {
        const ctx = makeContext();
        const plan: TurnPlan = { type: AIActionType.BuildTrack, segments: [makeSegment(1, 1, 2, 2)], totalCost: 5 };

        const result = GuardrailEnforcer.checkPlan(plan, ctx, makeSnapshot(), 4);

        expect(result.overridden).toBe(true);
        expect(result.plan.type).toBe(AIActionType.DiscardHand);
      });

      it('should NOT override if plan is already DiscardHand', () => {
        const ctx = makeContext();
        const plan: TurnPlan = { type: AIActionType.DiscardHand };

        const result = GuardrailEnforcer.checkPlan(plan, ctx, makeSnapshot(), 3);

        expect(result.overridden).toBe(false);
      });

      it('should NOT force DiscardHand with fewer than 3 stuck turns', () => {
        const ctx = makeContext();
        const plan: TurnPlan = { type: AIActionType.PassTurn };

        const result = GuardrailEnforcer.checkPlan(plan, ctx, makeSnapshot(), 2);

        expect(result.overridden).toBe(false);
      });
    });

    describe('Guardrail 6: Escape hatch after 5 stuck turns', () => {
      it('should force PassTurn after 5 consecutive stuck turns', () => {
        const ctx = makeContext();
        const plan: TurnPlan = { type: AIActionType.BuildTrack, segments: [makeSegment(1, 1, 2, 2)], totalCost: 5 };

        const result = GuardrailEnforcer.checkPlan(plan, ctx, makeSnapshot(), 5);

        expect(result.overridden).toBe(true);
        expect(result.plan.type).toBe(AIActionType.PassTurn);
        expect(result.reason).toContain('Escape hatch');
      });

      it('should force PassTurn after 6+ consecutive stuck turns', () => {
        const ctx = makeContext();
        const plan: TurnPlan = { type: AIActionType.DiscardHand };

        const result = GuardrailEnforcer.checkPlan(plan, ctx, makeSnapshot(), 6);

        expect(result.overridden).toBe(true);
        expect(result.plan.type).toBe(AIActionType.PassTurn);
      });

      it('should take priority over Guardrail 7 (G6 fires at 5, G7 at 3)', () => {
        // At 5 turns, G6 escape should fire, NOT G7 discard
        const ctx = makeContext();
        const plan: TurnPlan = { type: AIActionType.BuildTrack, segments: [makeSegment(1, 1, 2, 2)], totalCost: 5 };

        const result = GuardrailEnforcer.checkPlan(plan, ctx, makeSnapshot(), 5);

        expect(result.plan.type).toBe(AIActionType.PassTurn); // G6, not DiscardHand
      });
    });

    describe('bestPickups multi-load scenarios', () => {
      it('should return multiple pickups sorted by payout up to capacity', () => {
        const pickup1: PickupOpportunity = { loadType: 'Coal', supplyCity: 'Berlin', bestPayout: 15 };
        const pickup2: PickupOpportunity = { loadType: 'Steel', supplyCity: 'Berlin', bestPayout: 25 };
        const pickup3: PickupOpportunity = { loadType: 'Wine', supplyCity: 'Berlin', bestPayout: 20 };
        const ctx = makeContext({
          canPickup: [pickup1, pickup2, pickup3],
          capacity: 2,
          loads: [],
        });
        const plan: TurnPlan = { type: AIActionType.PassTurn };

        const result = GuardrailEnforcer.checkPlan(plan, ctx, makeSnapshot());

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

      it('should respect remaining capacity when bot already carries loads', () => {
        const pickup1: PickupOpportunity = { loadType: 'Coal', supplyCity: 'Berlin', bestPayout: 15 };
        const pickup2: PickupOpportunity = { loadType: 'Steel', supplyCity: 'Berlin', bestPayout: 25 };
        const ctx = makeContext({
          canPickup: [pickup1, pickup2],
          capacity: 2,
          loads: ['Wine'], // Already carrying 1 of 2
        });
        const plan: TurnPlan = { type: AIActionType.PassTurn };

        const result = GuardrailEnforcer.checkPlan(plan, ctx, makeSnapshot());

        expect(result.overridden).toBe(true);
        // Only 1 pickup slot available → single PICKUP, not MultiAction
        expect(result.plan.type).toBe(AIActionType.PickupLoad);
        if (result.plan.type === AIActionType.PickupLoad) {
          expect(result.plan.load).toBe('Steel'); // Highest payout
        }
      });

      it('should NOT override when at full capacity', () => {
        const pickup1: PickupOpportunity = { loadType: 'Coal', supplyCity: 'Berlin', bestPayout: 15 };
        const ctx = makeContext({
          canPickup: [pickup1],
          capacity: 2,
          loads: ['Wine', 'Steel'], // Full
        });
        const plan: TurnPlan = { type: AIActionType.PassTurn };

        const result = GuardrailEnforcer.checkPlan(plan, ctx, makeSnapshot());

        // G2 won't fire (capacity full), G4 will fire because loads > 0
        // But G4 needs demands with delivery/supply on network
        expect(result.plan.type).not.toBe(AIActionType.PickupLoad);
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
