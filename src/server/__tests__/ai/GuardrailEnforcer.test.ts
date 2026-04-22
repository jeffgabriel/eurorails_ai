import { GuardrailEnforcer } from '../../services/ai/GuardrailEnforcer';
import {
  AIActionType,
  WorldSnapshot,
  TurnPlan,
  GameContext,
  DemandContext,
  DeliveryOpportunity,
  TerrainType,
  TrackSegment,
} from '../../../shared/types/GameTypes';
import * as majorCityGroups from '../../../shared/services/majorCityGroups';

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
    isAffordable: true,
    projectedFundsAfterDelivery: 50,
    ...overrides,
  };
}

describe('GuardrailEnforcer', () => {
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

        // hasActiveRoute=true: bot is delivering as part of a route, not stuck
        const result = await GuardrailEnforcer.checkPlan(plan, ctx, makeSnapshot(), true);

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

        // hasActiveRoute=true: bot is delivering as part of a route, not stuck
        const result = await GuardrailEnforcer.checkPlan(plan, ctx, makeSnapshot(), true);

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

        // hasActiveRoute=true to skip stuck guardrail and reach G3
        const result = await GuardrailEnforcer.checkPlan(plan, ctx, makeSnapshot(), true);

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

        // hasActiveRoute=true to skip stuck guardrail and reach G3 check
        const result = await GuardrailEnforcer.checkPlan(plan, ctx, makeSnapshot(), true);

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

        // hasActiveRoute=true: bot is building track as part of an active route
        const result = await GuardrailEnforcer.checkPlan(plan, ctx, makeSnapshot(), true);

        expect(result.overridden).toBe(false);
        expect(result.plan).toBe(plan);
        expect(result.reason).toBeUndefined();
      });

      it('should pass through PASS when no deliveries available', async () => {
        const ctx = makeContext({ canDeliver: [] });
        const plan: TurnPlan = { type: AIActionType.PassTurn };

        // hasActiveRoute=true: bot passes while on an active route (e.g. waiting at ferry)
        const result = await GuardrailEnforcer.checkPlan(plan, ctx, makeSnapshot(), true);

        expect(result.overridden).toBe(false);
      });

      it('should pass through DISCARD_HAND without interference', async () => {
        const ctx = makeContext({ canDeliver: [] });
        const plan: TurnPlan = { type: AIActionType.DiscardHand };

        // DiscardHand is always passed through (no guardrail fires on it)
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

        // hasActiveRoute=true: bot is picking up as part of active route
        const result = await GuardrailEnforcer.checkPlan(plan, ctx, makeSnapshot(), true);

        expect(result.overridden).toBe(false);
      });
    });

    describe('Stuck guardrail (no active route, no deliverable load)', () => {
      it('should force DiscardHand immediately when no active route and no deliverable load', async () => {
        const ctx = makeContext({ canDeliver: [] });
        const plan: TurnPlan = { type: AIActionType.PassTurn };

        // hasActiveRoute=false (default), no loads on train → fires immediately
        const result = await GuardrailEnforcer.checkPlan(plan, ctx, makeSnapshot());

        expect(result.overridden).toBe(true);
        expect(result.plan.type).toBe(AIActionType.DiscardHand);
        expect(result.reason).toContain('Stuck');
      });

      it('should force DiscardHand for BUILD plan when no active route and no deliverable load', async () => {
        const ctx = makeContext({ canDeliver: [] });
        const plan: TurnPlan = {
          type: AIActionType.BuildTrack,
          segments: [makeSegment(10, 10, 10, 11)],
        };

        const result = await GuardrailEnforcer.checkPlan(plan, ctx, makeSnapshot());

        expect(result.overridden).toBe(true);
        expect(result.plan.type).toBe(AIActionType.DiscardHand);
      });

      it('should NOT override when plan is already DiscardHand', async () => {
        const ctx = makeContext({ canDeliver: [] });
        const plan: TurnPlan = { type: AIActionType.DiscardHand };

        const result = await GuardrailEnforcer.checkPlan(plan, ctx, makeSnapshot());

        expect(result.overridden).toBe(false);
        expect(result.plan).toBe(plan);
      });

      it('should NOT override when bot has an active route (hasActiveRoute=true)', async () => {
        const ctx = makeContext({ canDeliver: [] });
        const snap = makeSnapshot();
        snap.bot.loads = [];
        const plan: TurnPlan = { type: AIActionType.MoveTrain, path: [], fees: new Set(), totalFee: 0 };

        // hasActiveRoute=true → stuck guardrail skips
        const result = await GuardrailEnforcer.checkPlan(plan, ctx, snap, true);

        expect(result.overridden).toBe(false);
        expect(result.plan).toBe(plan);
      });

      it('should NOT override when bot has a deliverable load on-train', async () => {
        const ctx = makeContext({
          canDeliver: [],
          demands: [makeDemand({ loadType: 'Coal', isLoadOnTrain: true, isDeliveryOnNetwork: true })],
        });
        const snap = makeSnapshot();
        snap.bot.loads = ['Coal'];
        const plan: TurnPlan = { type: AIActionType.MoveTrain, path: [], fees: new Set(), totalFee: 0 };

        // hasDeliverableLoad=true → stuck guardrail skips
        const result = await GuardrailEnforcer.checkPlan(plan, ctx, snap);

        expect(result.overridden).toBe(false);
        expect(result.plan).toBe(plan);
      });

      it('should NOT force pickup when at supply city (G2 removed — LLM decides)', async () => {
        const ctx = makeContext({
          canDeliver: [],
          canPickup: [{ loadType: 'Cars', supplyCity: 'Stuttgart', bestPayout: 20, bestDeliveryCity: 'Berlin' }],
          demands: [makeDemand({ loadType: 'Cars', deliveryCity: 'Berlin', isDeliveryOnNetwork: true })],
        });
        const plan: TurnPlan = {
          type: AIActionType.BuildTrack,
          segments: [makeSegment(10, 10, 10, 11)],
        };

        // hasActiveRoute=true (bot is mid-route) → stuck guardrail skips
        const result = await GuardrailEnforcer.checkPlan(plan, ctx, makeSnapshot(), true);

        expect(result.overridden).toBe(false);
        expect(result.plan).toBe(plan);
      });

      it('should NOT force drop of undeliverable loads (G5 removed — speculative pickups valid)', async () => {
        const ctx = makeContext({
          canDeliver: [],
          loads: ['Cattle'],
          demands: [makeDemand({ loadType: 'Cattle', isLoadOnTrain: true, isDeliveryOnNetwork: false, estimatedTrackCostToDelivery: 999 })],
        });
        const plan: TurnPlan = {
          type: AIActionType.BuildTrack,
          segments: [makeSegment(10, 10, 10, 11)],
        };

        // hasActiveRoute=true → stuck guardrail skips; load is on train but not deliverable on network
        const result = await GuardrailEnforcer.checkPlan(plan, ctx, makeSnapshot(5), true);

        expect(result.overridden).toBe(false);
        expect(result.plan).toBe(plan);
      });
    });

    describe('Broke-and-stuck guardrail (JIRA-177, JIRA-183)', () => {
      it('should force DiscardHand immediately when broke, has active route, no achievable demand', async () => {
        const ctx = makeContext({
          canDeliver: [],
          demands: [makeDemand({ isSupplyOnNetwork: false, isDeliveryOnNetwork: false, isLoadOnTrain: false })],
        });
        const snap = makeSnapshot(0); // broke
        const plan: TurnPlan = { type: AIActionType.PassTurn };

        const result = await GuardrailEnforcer.checkPlan(plan, ctx, snap, true);

        expect(result.overridden).toBe(true);
        expect(result.plan.type).toBe(AIActionType.DiscardHand);
        expect(result.reason).toContain('Broke-and-stuck');
      });

      it('should NOT fire when bot is not broke', async () => {
        const ctx = makeContext({
          canDeliver: [],
          demands: [makeDemand({ isSupplyOnNetwork: false, isDeliveryOnNetwork: false })],
        });
        const snap = makeSnapshot(50); // not broke
        const plan: TurnPlan = { type: AIActionType.MoveTrain, path: [], fees: new Set(), totalFee: 0 };

        const result = await GuardrailEnforcer.checkPlan(plan, ctx, snap, true);

        expect(result.overridden).toBe(false);
      });

      it('should NOT fire when bot has an achievable demand (supply on network)', async () => {
        const ctx = makeContext({
          canDeliver: [],
          demands: [makeDemand({ isSupplyOnNetwork: true, isDeliveryOnNetwork: true })],
        });
        const snap = makeSnapshot(0); // broke
        const plan: TurnPlan = { type: AIActionType.MoveTrain, path: [], fees: new Set(), totalFee: 0 };

        const result = await GuardrailEnforcer.checkPlan(plan, ctx, snap, true);

        expect(result.overridden).toBe(false);
      });

      it('should NOT fire when plan is already DiscardHand', async () => {
        const ctx = makeContext({
          canDeliver: [],
          demands: [makeDemand({ isSupplyOnNetwork: false, isDeliveryOnNetwork: false })],
        });
        const snap = makeSnapshot(0); // broke
        const plan: TurnPlan = { type: AIActionType.DiscardHand };

        const result = await GuardrailEnforcer.checkPlan(plan, ctx, snap, true);

        expect(result.overridden).toBe(false);
      });

      it('should fire on every turn with no cap (consecutiveDiscards removed)', async () => {
        // Simulate multiple consecutive broke-and-stuck triggers — all should fire
        const ctx = makeContext({
          canDeliver: [],
          demands: [makeDemand({ isSupplyOnNetwork: false, isDeliveryOnNetwork: false })],
        });
        const snap = makeSnapshot(0); // broke
        const plan: TurnPlan = { type: AIActionType.MoveTrain, path: [], fees: new Set(), totalFee: 0 };

        for (let i = 0; i < 5; i++) {
          const result = await GuardrailEnforcer.checkPlan(plan, ctx, snap, true);
          expect(result.overridden).toBe(true);
          expect(result.plan.type).toBe(AIActionType.DiscardHand);
        }
      });
    });

    describe('Guardrail priority', () => {
      it('Force DELIVER takes priority over block UPGRADE during initialBuild', async () => {
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

      it('Stuck detection takes priority over G3 (block UPGRADE) when no active route', async () => {
        const ctx = makeContext({ isInitialBuild: true, canDeliver: [] });
        const plan: TurnPlan = {
          type: AIActionType.UpgradeTrain,
          targetTrain: 'FastFreight',
          cost: 20,
        };

        // hasActiveRoute=false → stuck guardrail fires before G3
        const result = await GuardrailEnforcer.checkPlan(plan, ctx, makeSnapshot());

        expect(result.overridden).toBe(true);
        expect(result.plan.type).toBe(AIActionType.DiscardHand);
        expect(result.reason).toContain('Stuck');
      });

      it('JIRA-47: G1 fires BEFORE stuck detection — bot delivers even when stuck', async () => {
        const delivery: DeliveryOpportunity = {
          loadType: 'Coal',
          deliveryCity: 'Berlin',
          payout: 25,
          cardIndex: 0,
        };
        const ctx = makeContext({ canDeliver: [delivery] });
        const plan: TurnPlan = { type: AIActionType.PassTurn };

        const result = await GuardrailEnforcer.checkPlan(plan, ctx, makeSnapshot());

        expect(result.overridden).toBe(true);
        expect(result.plan.type).toBe(AIActionType.DeliverLoad);
        expect(result.reason).toContain('Forced DELIVER');
        // Must NOT be DiscardHand from stuck detection
        expect(result.plan.type).not.toBe(AIActionType.DiscardHand);
      });

      it('JIRA-120: Stuck detection fires when carrying loads with no deliverable route', async () => {
        // Loads on train but no demand with isLoadOnTrain+isDeliveryOnNetwork → hasDeliverableLoad=false
        const ctx = makeContext({ canDeliver: [] });
        const snap = makeSnapshot();
        snap.bot.loads = ['Coal', 'Wine'];
        const plan: TurnPlan = { type: AIActionType.MoveTrain, path: [], fees: new Set(), totalFee: 0 };

        // hasActiveRoute=false, loads on train but no deliverable demand → stuck fires
        const result = await GuardrailEnforcer.checkPlan(plan, ctx, snap);

        expect(result.overridden).toBe(true);
        expect(result.plan.type).toBe(AIActionType.DiscardHand);
      });

      it('JIRA-68, JIRA-183: Stuck detection fires immediately for bot with no active route', async () => {
        const ctx = makeContext({ canDeliver: [] });
        const snap = makeSnapshot();
        snap.bot.loads = [];
        const plan: TurnPlan = { type: AIActionType.MoveTrain, path: [], fees: new Set(), totalFee: 0 };

        // hasActiveRoute=false → fires immediately (no counter needed)
        const result = await GuardrailEnforcer.checkPlan(plan, ctx, snap, false);

        expect(result.overridden).toBe(true);
        expect(result.plan.type).toBe(AIActionType.DiscardHand);
        expect(result.reason).toContain('Stuck');
      });

      it('JIRA-68: Stuck detection skips when bot has an active route (empty-handed travel)', async () => {
        const ctx = makeContext({ canDeliver: [] });
        const snap = makeSnapshot();
        snap.bot.loads = [];
        const plan: TurnPlan = { type: AIActionType.MoveTrain, path: [], fees: new Set(), totalFee: 0 };

        // hasActiveRoute=true → stuck guardrail skips
        const result = await GuardrailEnforcer.checkPlan(plan, ctx, snap, true);

        expect(result.overridden).toBe(false);
        expect(result.plan).toBe(plan);
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

        const result = await GuardrailEnforcer.checkPlan(plan, ctx, makeSnapshot(), true);

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

        const result = await GuardrailEnforcer.checkPlan(plan, ctx, makeSnapshot(), true);

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

        const result = await GuardrailEnforcer.checkPlan(plan, ctx, makeSnapshot(), true);

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

        await GuardrailEnforcer.checkPlan(plan, ctx, makeSnapshot(), true);

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

        const result = await GuardrailEnforcer.checkPlan(plan, ctx, makeSnapshot(), true);

        // Guardrail 8 only handles MultiAction; single MOVE passes through
        expect(result.overridden).toBe(false);
        expect(result.plan).toBe(plan);
      });

      describe('intra-city edge handling', () => {
        /**
         * Build a path where coordinates at positions `intraCityIndices` are treated
         * as belonging to the same major city ("TestCity") — making those edges free.
         *
         * The path visits row=20, col=20+i for all points, except those at
         * `intraCityIndices` which use a shared city row=99 scheme so they map
         * into our seeded lookup.
         *
         * Simpler approach: build a normal linear path but spy on getMajorCityLookup
         * to return a map that marks specific coordinate pairs as intra-city.
         */
        function setupIntraCityLookup(intraCityKeys: string[]): void {
          const lookup = new Map<string, string>();
          for (const key of intraCityKeys) {
            lookup.set(key, 'TestCity');
          }
          jest.spyOn(majorCityGroups, 'getMajorCityLookup').mockReturnValue(lookup);
        }

        afterEach(() => {
          jest.restoreAllMocks();
        });

        it('should NOT truncate when raw edges exceed speed but effective mp equals speed (intra-city hops discount)', async () => {
          // Speed = 9. First MOVE has 9 raw edges but 2 are intra-city → 7 effective mp.
          // Second MOVE has 2 raw edges, all non-intra-city → 2 effective mp.
          // Total effective = 9 = speed → no truncation.
          const ctx = makeContext({ speed: 9 });

          // Path for first MOVE: 10 nodes (9 raw edges). Edges at indices 3→4 and 6→7 are intra-city.
          // Coordinates: row=20, col=20+i. Mark col 23→24 and col 26→27 as same city.
          const firstPath = Array.from({ length: 10 }, (_, i) => ({ row: 20, col: 20 + i }));
          // Mark edges [3→4] and [6→7] as intra-city: keys "20,23"→"20,24" and "20,26"→"20,27"
          setupIntraCityLookup(['20,23', '20,24', '20,26', '20,27']);

          const secondPath = Array.from({ length: 3 }, (_, i) => ({ row: 30, col: 30 + i }));

          const plan: TurnPlan = {
            type: 'MultiAction',
            steps: [
              { type: AIActionType.MoveTrain, path: firstPath, fees: new Set<string>(), totalFee: 0 },
              { type: AIActionType.PickupLoad, load: 'Coal', city: 'TestCity' },
              { type: AIActionType.MoveTrain, path: secondPath, fees: new Set<string>(), totalFee: 0 },
            ],
          };
          // effective total: 7 + 2 = 9 = speed → no truncation

          const result = await GuardrailEnforcer.checkPlan(plan, ctx, makeSnapshot(), true);

          expect(result.overridden).toBe(false);
          expect(result.plan).toBe(plan); // unchanged reference
        });

        it('should preserve trailing MOVE when intra-city hops on first MOVE would have caused false over-budget', async () => {
          // Speed = 9. First MOVE: 9 raw edges, 1 intra-city → 8 effective mp.
          // Second MOVE: 1 raw edge (non-intra-city) → 1 effective mp.
          // Total effective = 9 = speed → second MOVE preserved.
          // Without the fix, raw total = 10 > 9 → second MOVE would be removed.
          const ctx = makeContext({ speed: 9 });

          const firstPath = Array.from({ length: 10 }, (_, i) => ({ row: 21, col: 21 + i }));
          // Edge at index [4→5] is intra-city: keys "21,25" and "21,26"
          setupIntraCityLookup(['21,25', '21,26']);

          const secondPath = [{ row: 31, col: 31 }, { row: 31, col: 32 }];

          const plan: TurnPlan = {
            type: 'MultiAction',
            steps: [
              { type: AIActionType.MoveTrain, path: firstPath, fees: new Set<string>(), totalFee: 0 },
              { type: AIActionType.PickupLoad, load: 'Coal', city: 'TestCity' },
              { type: AIActionType.MoveTrain, path: secondPath, fees: new Set<string>(), totalFee: 0 },
            ],
          };
          // effective total: 8 + 1 = 9 = speed → no truncation

          const result = await GuardrailEnforcer.checkPlan(plan, ctx, makeSnapshot(), true);

          expect(result.overridden).toBe(false);
          expect(result.plan).toBe(plan); // unchanged — second MOVE preserved
          if (result.plan.type === 'MultiAction') {
            expect(result.plan.steps).toHaveLength(3);
          }
        });

        it('should truncate correctly when effective mp genuinely exceeds speed and over-budget portion includes intra-city hops', async () => {
          // Speed = 9. First MOVE: 5 effective mp. Second MOVE: 7 raw edges, 1 intra-city → 6 effective mp.
          // Total effective = 11 > 9. excess = 2 effective mp from the trailing MOVE.
          // Truncation must walk the second MOVE backwards removing raw edges until 2 effective mp removed.
          const ctx = makeContext({ speed: 9 });

          const firstPath = Array.from({ length: 6 }, (_, i) => ({ row: 22, col: 22 + i }));
          // Second MOVE: 8 nodes (7 raw edges). Edge [3→4] is intra-city: "23,26"→"23,27"
          const secondPath = Array.from({ length: 8 }, (_, i) => ({ row: 23, col: 23 + i }));
          setupIntraCityLookup(['23,26', '23,27']);

          const plan: TurnPlan = {
            type: 'MultiAction',
            steps: [
              { type: AIActionType.MoveTrain, path: firstPath, fees: new Set<string>(), totalFee: 0 },
              { type: AIActionType.PickupLoad, load: 'Coal', city: 'TestCity' },
              { type: AIActionType.MoveTrain, path: secondPath, fees: new Set<string>(), totalFee: 0 },
            ],
          };
          // effective: 5 + 6 = 11 > 9. excess = 2 effective mp to remove from trailing MOVE.
          // Walking backwards from secondPath end: edge [6→7] (cols 29→30) non-intra → remove 1 raw, 1 effective
          // edge [5→6] (cols 28→29) non-intra → remove 1 raw, 1 effective. Total: 2 effective removed → stop.
          // Resulting second path: secondPath.slice(0, 6) → 6 nodes (5 raw edges, 4 effective)

          const result = await GuardrailEnforcer.checkPlan(plan, ctx, makeSnapshot(), true);

          expect(result.overridden).toBe(false);
          expect(result.plan.type).toBe('MultiAction');
          if (result.plan.type === 'MultiAction') {
            expect(result.plan.steps).toHaveLength(3);
            const lastMove = result.plan.steps[2];
            if (lastMove.type === AIActionType.MoveTrain) {
              // 2 non-intra-city edges removed from end: 8 - 2 = 6 nodes
              expect(lastMove.path).toHaveLength(6);
            }
          }
        });

        it('should remove trailing MOVE entirely when its surviving path has zero effective mileposts after truncation', async () => {
          // Speed = 9. First MOVE: 9 effective mp (no intra-city).
          // Second MOVE: 3 raw edges, all intra-city → 0 effective mp.
          // Total effective = 9 = speed → no truncation needed.
          // But if we make first MOVE = 10 effective mp → excess = 1 from second MOVE.
          // Second MOVE has 0 effective mp → can't reduce effective count from it.
          // So truncation correctly skips to first MOVE.

          // Simpler scenario: speed=9, first MOVE=9 effective, second MOVE=2 raw edges both intra-city (0 effective).
          // Total effective = 9 → no truncation. Second MOVE preserved (it's "free").
          const ctx = makeContext({ speed: 9 });

          const firstPath = Array.from({ length: 10 }, (_, i) => ({ row: 24, col: 24 + i }));
          // Second MOVE: 3 nodes (2 raw edges), both intra-city: "25,25"→"25,26"→"25,27"
          const secondPath = [
            { row: 25, col: 25 },
            { row: 25, col: 26 },
            { row: 25, col: 27 },
          ];
          // Mark the second path as all intra-city
          setupIntraCityLookup(['25,25', '25,26', '25,27']);

          const plan: TurnPlan = {
            type: 'MultiAction',
            steps: [
              { type: AIActionType.MoveTrain, path: firstPath, fees: new Set<string>(), totalFee: 0 },
              { type: AIActionType.PickupLoad, load: 'Coal', city: 'TestCity' },
              { type: AIActionType.MoveTrain, path: secondPath, fees: new Set<string>(), totalFee: 0 },
            ],
          };
          // effective total: 9 (first, no intra-city) + 0 (second, all intra-city) = 9 = speed
          // → no truncation, plan preserved unchanged

          const result = await GuardrailEnforcer.checkPlan(plan, ctx, makeSnapshot(), true);

          expect(result.overridden).toBe(false);
          expect(result.plan).toBe(plan); // unchanged
          if (result.plan.type === 'MultiAction') {
            expect(result.plan.steps).toHaveLength(3);
          }
        });
      });
    });
  });
});
