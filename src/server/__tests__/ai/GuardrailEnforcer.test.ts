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

    describe('Progress-based stuck detection (noProgressTurns)', () => {
      it('should force DiscardHand when noProgressTurns >= 3 and plan is not DiscardHand', async () => {
        const ctx = makeContext({ canDeliver: [] });
        const plan: TurnPlan = { type: AIActionType.PassTurn };

        const result = await GuardrailEnforcer.checkPlan(plan, ctx, makeSnapshot(), 3);

        expect(result.overridden).toBe(true);
        expect(result.plan.type).toBe(AIActionType.DiscardHand);
        expect(result.reason).toContain('stuck detection');
        expect(result.reason).toContain('3');
      });

      it('should force DiscardHand when noProgressTurns is 5 (well above threshold)', async () => {
        const ctx = makeContext({ canDeliver: [] });
        const plan: TurnPlan = {
          type: AIActionType.BuildTrack,
          segments: [makeSegment(10, 10, 10, 11)],
        };

        const result = await GuardrailEnforcer.checkPlan(plan, ctx, makeSnapshot(), 5);

        expect(result.overridden).toBe(true);
        expect(result.plan.type).toBe(AIActionType.DiscardHand);
      });

      it('should NOT override when noProgressTurns < 3', async () => {
        const ctx = makeContext({ canDeliver: [] });
        const plan: TurnPlan = { type: AIActionType.PassTurn };

        const result = await GuardrailEnforcer.checkPlan(plan, ctx, makeSnapshot(), 2);

        expect(result.overridden).toBe(false);
        expect(result.plan).toBe(plan);
      });

      it('should NOT override when noProgressTurns is 0', async () => {
        const ctx = makeContext({ canDeliver: [] });
        const plan: TurnPlan = { type: AIActionType.PassTurn };

        const result = await GuardrailEnforcer.checkPlan(plan, ctx, makeSnapshot(), 0);

        expect(result.overridden).toBe(false);
      });

      it('should NOT override when plan is already DiscardHand', async () => {
        const ctx = makeContext({ canDeliver: [] });
        const plan: TurnPlan = { type: AIActionType.DiscardHand };

        const result = await GuardrailEnforcer.checkPlan(plan, ctx, makeSnapshot(), 5);

        expect(result.overridden).toBe(false);
        expect(result.plan).toBe(plan);
      });

      it('should allow PassTurn without loads (G4 removed)', async () => {
        const ctx = makeContext({ canDeliver: [], loads: [] });
        const plan: TurnPlan = { type: AIActionType.PassTurn };

        const result = await GuardrailEnforcer.checkPlan(plan, ctx, makeSnapshot(), 0);

        expect(result.overridden).toBe(false);
        expect(result.plan).toBe(plan);
      });

      it('should allow PassTurn with loads (G4 + post-guardrail safety removed)', async () => {
        const ctx = makeContext({ canDeliver: [], loads: ['Coal', 'Wine'] });
        const plan: TurnPlan = { type: AIActionType.PassTurn };

        const result = await GuardrailEnforcer.checkPlan(plan, ctx, makeSnapshot(), 0);

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

        const result = await GuardrailEnforcer.checkPlan(plan, ctx, makeSnapshot(), 0);

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

        const result = await GuardrailEnforcer.checkPlan(plan, ctx, makeSnapshot(5), 0);

        expect(result.overridden).toBe(false);
        expect(result.plan).toBe(plan);
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

      it('Stuck detection takes priority over G3 (block UPGRADE) when no loads carried', async () => {
        const ctx = makeContext({ isInitialBuild: true, canDeliver: [] });
        const plan: TurnPlan = {
          type: AIActionType.UpgradeTrain,
          targetTrain: 'FastFreight',
          cost: 20,
        };

        const result = await GuardrailEnforcer.checkPlan(plan, ctx, makeSnapshot(), 3);

        expect(result.overridden).toBe(true);
        expect(result.plan.type).toBe(AIActionType.DiscardHand);
        expect(result.reason).toContain('stuck detection');
      });

      it('JIRA-47: G1 fires BEFORE stuck detection — bot delivers even when noProgressTurns >= 3', async () => {
        const delivery: DeliveryOpportunity = {
          loadType: 'Coal',
          deliveryCity: 'Berlin',
          payout: 25,
          cardIndex: 0,
        };
        const ctx = makeContext({ canDeliver: [delivery] });
        const plan: TurnPlan = { type: AIActionType.PassTurn };

        const result = await GuardrailEnforcer.checkPlan(plan, ctx, makeSnapshot(), 5);

        expect(result.overridden).toBe(true);
        expect(result.plan.type).toBe(AIActionType.DeliverLoad);
        expect(result.reason).toContain('Forced DELIVER');
        // Must NOT be DiscardHand from stuck detection
        expect(result.plan.type).not.toBe(AIActionType.DiscardHand);
      });

      it('JIRA-120: Stuck detection fires even when bot is carrying loads', async () => {
        // JIRA-120: Removed loads gate — carrying loads is not a reason to keep a bad hand
        const ctx = makeContext({ canDeliver: [] });
        const snap = makeSnapshot();
        snap.bot.loads = ['Coal', 'Wine'];
        const plan: TurnPlan = { type: AIActionType.MoveTrain, path: [], fees: new Set(), totalFee: 0 };

        const result = await GuardrailEnforcer.checkPlan(plan, ctx, snap, 4);

        expect(result.overridden).toBe(true);
        expect(result.plan.type).toBe(AIActionType.DiscardHand);
      });

      it('Stuck detection fires for loadless bot after 3 no-progress turns', async () => {
        const ctx = makeContext({ canDeliver: [] });
        const snap = makeSnapshot();
        snap.bot.loads = [];
        const plan: TurnPlan = { type: AIActionType.BuildTrack, segments: [makeSegment(10, 10, 10, 11)] };

        const result = await GuardrailEnforcer.checkPlan(plan, ctx, snap, 3);

        expect(result.overridden).toBe(true);
        expect(result.plan.type).toBe(AIActionType.DiscardHand);
      });

      it('JIRA-68: Stuck detection skips when bot has an active route (empty-handed travel)', async () => {
        const ctx = makeContext({ canDeliver: [] });
        const snap = makeSnapshot();
        snap.bot.loads = [];
        const plan: TurnPlan = { type: AIActionType.MoveTrain, path: [], fees: new Set(), totalFee: 0 };

        // noProgressTurns=4, hasActiveRoute=true → should NOT fire stuck detection
        const result = await GuardrailEnforcer.checkPlan(plan, ctx, snap, 4, true);

        expect(result.overridden).toBe(false);
        expect(result.plan).toBe(plan);
      });

      it('JIRA-68: Stuck detection fires when no active route, no loads, noProgressTurns >= 3', async () => {
        const ctx = makeContext({ canDeliver: [] });
        const snap = makeSnapshot();
        snap.bot.loads = [];
        const plan: TurnPlan = { type: AIActionType.MoveTrain, path: [], fees: new Set(), totalFee: 0 };

        // noProgressTurns=3, hasActiveRoute=false → SHOULD fire stuck detection
        const result = await GuardrailEnforcer.checkPlan(plan, ctx, snap, 3, false);

        expect(result.overridden).toBe(true);
        expect(result.plan.type).toBe(AIActionType.DiscardHand);
        expect(result.reason).toContain('stuck detection');
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
