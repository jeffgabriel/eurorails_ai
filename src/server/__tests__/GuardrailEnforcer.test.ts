import { GuardrailEnforcer } from '../services/ai/GuardrailEnforcer';
import {
  WorldSnapshot,
  GameContext,
  TurnPlan,
  AIActionType,
  DemandContext,
  GameState,
} from '../../shared/types/GameTypes';
import { EventCardType } from '../../shared/types/EventCard';
import { TerrainType } from '../../shared/types/GameTypes';

// Mock MapTopology (getCityMilepointKey uses it)
jest.mock('../services/MapTopology', () => ({
  loadGridPoints: jest.fn(() => new Map([
    ['20,47', { name: 'Hamburg', terrain: 2 }], // 2 = MajorCity
  ])),
}));

// Minimal factory helpers for test data

function makeSnapshot(overrides: { money?: number; loads?: string[] } = {}): WorldSnapshot {
  return {
    gameId: 'game-1',
    gameStatus: 'in_progress' as any,
    turnNumber: 10,
    activeEffects: [],
    bot: {
      playerId: 'bot-1',
      userId: 'user-1',
      money: overrides.money ?? 50,
      position: null,
      existingSegments: [],
      demandCards: [],
      resolvedDemands: [],
      trainType: 'Freight',
      loads: overrides.loads ?? [],
      botConfig: null,
      connectedMajorCityCount: 2,
    },
    allPlayerTracks: [],
    loadAvailability: {},
  } as any;
}

function makeActiveEffect(overrides: { pendingLostTurns?: { playerId: string }[]; movement?: any[]; build?: any[]; pickupDelivery?: any[]; floodedRiver?: string } = {}) {
  return {
    cardId: 125,
    cardType: EventCardType.Derailment,
    drawingPlayerId: 'player-2',
    drawingPlayerIndex: 1,
    expiresAfterTurnNumber: 5,
    affectedZone: new Set<string>(),
    restrictions: {
      movement: overrides.movement ?? [],
      build: overrides.build ?? [],
      pickupDelivery: overrides.pickupDelivery ?? [],
    },
    pendingLostTurns: overrides.pendingLostTurns ?? [],
    floodedRiver: overrides.floodedRiver,
  };
}

function makeMoveTrainPlan(destRow: number, destCol: number): TurnPlan {
  return {
    type: AIActionType.MoveTrain,
    path: [{ row: 10, col: 10 }, { row: destRow, col: destCol }],
  } as any;
}

function makeBuildTrackPlan(toRow: number, toCol: number): TurnPlan {
  return {
    type: AIActionType.BuildTrack,
    segments: [{
      from: { row: 10, col: 10, x: 0, y: 0, terrain: TerrainType.Clear },
      to: { row: toRow, col: toCol, x: 0, y: 0, terrain: TerrainType.Alpine },
      cost: 5,
    }],
  } as any;
}

function makePickupPlan(city: string): TurnPlan {
  return { type: AIActionType.PickupLoad, load: 'Coal', city } as any;
}

function makeDeliverPlan(city: string): TurnPlan {
  return { type: AIActionType.DeliverLoad, load: 'Coal', city, cardId: 1, payout: 20 } as any;
}

function makeDemand(overrides: Partial<DemandContext> = {}): DemandContext {
  return {
    cardIndex: 0,
    loadType: 'Coal',
    supplyCity: 'Berlin',
    deliveryCity: 'Paris',
    payout: 20,
    isSupplyReachable: true,
    isDeliveryReachable: true,
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
    demandScore: 4,
    efficiencyPerTurn: 4,
    networkCitiesUnlocked: 0,
    victoryMajorCitiesEnRoute: 0,
    isAffordable: false,
    projectedFundsAfterDelivery: 20,
    ...overrides,
  };
}

function makeContext(overrides: Partial<GameContext> = {}): GameContext {
  return {
    position: null,
    money: 50,
    trainType: 'Freight',
    speed: 9,
    capacity: 2,
    loads: [],
    connectedMajorCities: [],
    unconnectedMajorCities: [],
    totalMajorCities: 10,
    trackSummary: '',
    turnBuildCost: 0,
    demands: [],
    canDeliver: [],
    canPickup: [],
    reachableCities: [],
    citiesOnNetwork: [],
    canUpgrade: false,
    canBuild: false,
    isInitialBuild: false,
    opponents: [],
    phase: 'main',
    turnNumber: 10,
    gameState: GameState.Mid,
    ...overrides,
  };
}

const passTurnPlan: TurnPlan = { type: AIActionType.PassTurn };
const discardPlan: TurnPlan = { type: AIActionType.DiscardHand };
const buildPlan: TurnPlan = { type: AIActionType.BuildTrack, segments: [] } as any;

describe('GuardrailEnforcer.checkPlan — broke-and-stuck guardrail (JIRA-177, JIRA-183)', () => {
  describe('fires (forces DiscardHand) when all conditions met', () => {
    it('broke bot with active route and no achievable demand fires immediately', async () => {
      const snapshot = makeSnapshot({ money: 0 });
      const demands = [makeDemand({ isSupplyOnNetwork: false, isDeliveryOnNetwork: false })];
      const context = makeContext({ demands });

      const result = await GuardrailEnforcer.checkPlan(
        passTurnPlan,
        context,
        snapshot,
        /* hasActiveRoute */ true,
      );

      expect(result.overridden).toBe(true);
      expect(result.plan.type).toBe(AIActionType.DiscardHand);
      expect(result.reason).toMatch(/Broke-and-stuck/);
    });

    it('treats money=4 as broke (threshold is < 5)', async () => {
      const snapshot = makeSnapshot({ money: 4 });
      const demands = [makeDemand({ isSupplyOnNetwork: false, isDeliveryOnNetwork: false })];
      const context = makeContext({ demands });

      const result = await GuardrailEnforcer.checkPlan(
        buildPlan,
        context,
        snapshot,
        true,
      );

      expect(result.overridden).toBe(true);
      expect(result.plan.type).toBe(AIActionType.DiscardHand);
    });

    it('fires on every turn — no consecutiveDiscards cap (JIRA-183)', async () => {
      // Previously capped at 3 consecutive discards; cap is now removed
      const snapshot = makeSnapshot({ money: 0 });
      const demands = [makeDemand({ isSupplyOnNetwork: false, isDeliveryOnNetwork: false })];
      const context = makeContext({ demands });

      for (let i = 0; i < 5; i++) {
        const result = await GuardrailEnforcer.checkPlan(passTurnPlan, context, snapshot, true);
        expect(result.overridden).toBe(true);
        expect(result.plan.type).toBe(AIActionType.DiscardHand);
      }
    });
  });

  describe('does NOT fire', () => {
    it('bot has money ($50M) — not broke', async () => {
      const snapshot = makeSnapshot({ money: 50 });
      const demands = [makeDemand({ isSupplyOnNetwork: false, isDeliveryOnNetwork: false })];
      const context = makeContext({ demands });

      const result = await GuardrailEnforcer.checkPlan(
        passTurnPlan,
        context,
        snapshot,
        true,
      );

      expect(result.overridden).toBe(false);
    });

    it('no active route — falls through to stuck detector', async () => {
      const snapshot = makeSnapshot({ money: 0 });
      const demands = [makeDemand({ isSupplyOnNetwork: false, isDeliveryOnNetwork: false })];
      const context = makeContext({ demands });

      // hasActiveRoute=false → stuck detector fires instead (not broke-and-stuck)
      const result = await GuardrailEnforcer.checkPlan(
        passTurnPlan,
        context,
        snapshot,
        /* hasActiveRoute */ false,
      );

      // The stuck detector fires (not broke-and-stuck), still overrides to DiscardHand
      expect(result.overridden).toBe(true);
      expect(result.plan.type).toBe(AIActionType.DiscardHand);
      expect(result.reason).not.toMatch(/Broke-and-stuck/);
    });

    it('has achievable demand (supplyOnNetwork + deliveryOnNetwork)', async () => {
      const snapshot = makeSnapshot({ money: 0 });
      const demands = [makeDemand({ isSupplyOnNetwork: true, isDeliveryOnNetwork: true })];
      const context = makeContext({ demands });

      const result = await GuardrailEnforcer.checkPlan(
        passTurnPlan,
        context,
        snapshot,
        true,
      );

      expect(result.overridden).toBe(false);
    });

    it('has achievable demand (loadOnTrain + deliveryOnNetwork)', async () => {
      const snapshot = makeSnapshot({ money: 0, loads: ['Coal'] });
      const demands = [makeDemand({ isLoadOnTrain: true, isDeliveryOnNetwork: true })];
      const context = makeContext({ demands });

      const result = await GuardrailEnforcer.checkPlan(
        passTurnPlan,
        context,
        snapshot,
        true,
      );

      expect(result.overridden).toBe(false);
    });

    it('already discarding — plan is DiscardHand', async () => {
      const snapshot = makeSnapshot({ money: 0 });
      const demands = [makeDemand({ isSupplyOnNetwork: false, isDeliveryOnNetwork: false })];
      const context = makeContext({ demands });

      const result = await GuardrailEnforcer.checkPlan(
        discardPlan,
        context,
        snapshot,
        true,
      );

      expect(result.overridden).toBe(false);
    });
  });

  describe('priority ordering', () => {
    it('G1 (force deliver) fires before broke-and-stuck guardrail', async () => {
      const snapshot = makeSnapshot({ money: 0 });
      const demands = [makeDemand({ isSupplyOnNetwork: false, isDeliveryOnNetwork: false })];
      const canDeliver = [{ loadType: 'Coal', deliveryCity: 'Paris', payout: 20, cardIndex: 0 }];
      const context = makeContext({ demands, canDeliver });

      const result = await GuardrailEnforcer.checkPlan(
        passTurnPlan,
        context,
        snapshot,
        true,
      );

      expect(result.plan.type).toBe(AIActionType.DeliverLoad);
    });
  });

  // ── Event Card Restriction Gates ─────────────────────────────────────────────

  // Context that suppresses all stuck guardrails (has active route + achievable demand)
  function makeContextWithRoute(): GameContext {
    return makeContext({
      demands: [
        makeDemand({
          isAffordable: true,
          isSupplyOnNetwork: true,
          isDeliveryOnNetwork: true,
        }),
      ],
    } as any);
  }

  describe('Event card: LOST_TURN_PENDING gate', () => {
    it('forces PassTurn and sets violationCode when bot has a pending lost turn', async () => {
      const snapshot = makeSnapshot();
      snapshot.activeEffects = [
        makeActiveEffect({ pendingLostTurns: [{ playerId: 'bot-1' }] }),
      ];
      const context = makeContextWithRoute();
      const plan = makeMoveTrainPlan(10, 11);

      const result = await GuardrailEnforcer.checkPlan(plan, context, snapshot);

      expect(result.plan.type).toBe(AIActionType.PassTurn);
      expect(result.overridden).toBe(true);
      expect(result.violationCode).toBe('LOST_TURN_PENDING');
    });

    it('does NOT fire LOST_TURN_PENDING for a different player', async () => {
      const snapshot = makeSnapshot();
      snapshot.activeEffects = [
        makeActiveEffect({ pendingLostTurns: [{ playerId: 'player-3' }] }),
      ];
      const context = makeContextWithRoute();
      const plan: TurnPlan = { type: AIActionType.PassTurn };

      const result = await GuardrailEnforcer.checkPlan(plan, context, snapshot);

      expect(result.violationCode).toBeUndefined();
      expect(result.plan.type).toBe(AIActionType.PassTurn);
    });

    it('does NOT fire LOST_TURN_PENDING when plan is already PassTurn', async () => {
      const snapshot = makeSnapshot();
      snapshot.activeEffects = [
        makeActiveEffect({ pendingLostTurns: [{ playerId: 'bot-1' }] }),
      ];
      const context = makeContextWithRoute();
      const plan: TurnPlan = { type: AIActionType.PassTurn };

      const result = await GuardrailEnforcer.checkPlan(plan, context, snapshot);

      // PassTurn is the same result — gate passes through
      expect(result.overridden).toBe(false);
      expect(result.violationCode).toBeUndefined();
    });
  });

  describe('Event card: MOVEMENT_RESTRICTION_VIOLATION gate', () => {
    it('forces PassTurn with violationCode when MoveTrain destination is in blocked_terrain zone', async () => {
      const snapshot = makeSnapshot();
      snapshot.activeEffects = [
        makeActiveEffect({
          movement: [{ type: 'blocked_terrain', zone: ['10,11'] }],
        }),
      ];
      const context = makeContextWithRoute();
      const plan = makeMoveTrainPlan(10, 11); // destination in zone

      const result = await GuardrailEnforcer.checkPlan(plan, context, snapshot);

      expect(result.plan.type).toBe(AIActionType.PassTurn);
      expect(result.overridden).toBe(true);
      expect(result.violationCode).toBe('MOVEMENT_RESTRICTION_VIOLATION');
    });

    it('does NOT fire MOVEMENT_RESTRICTION when destination is outside zone', async () => {
      const snapshot = makeSnapshot();
      snapshot.activeEffects = [
        makeActiveEffect({
          movement: [{ type: 'blocked_terrain', zone: ['99,99'] }],
        }),
      ];
      const context = makeContextWithRoute();
      const plan = makeMoveTrainPlan(10, 11);

      const result = await GuardrailEnforcer.checkPlan(plan, context, snapshot);

      expect(result.violationCode).toBeUndefined();
    });
  });

  describe('Event card: BUILD_RESTRICTION_VIOLATION gate', () => {
    it('forces PassTurn with violationCode when BuildTrack destination is in blocked_terrain zone', async () => {
      const snapshot = makeSnapshot();
      snapshot.activeEffects = [
        makeActiveEffect({
          build: [{ type: 'blocked_terrain', zone: ['10,11'] }],
        }),
      ];
      const context = makeContextWithRoute();
      const plan = makeBuildTrackPlan(10, 11);

      const result = await GuardrailEnforcer.checkPlan(plan, context, snapshot);

      expect(result.plan.type).toBe(AIActionType.PassTurn);
      expect(result.overridden).toBe(true);
      expect(result.violationCode).toBe('BUILD_RESTRICTION_VIOLATION');
    });

    it('forces PassTurn when BuildTrack is blocked for the drawing player (Rail Strike)', async () => {
      const snapshot = makeSnapshot();
      snapshot.activeEffects = [
        makeActiveEffect({
          build: [{ type: 'no_build_for_player', targetPlayerId: 'bot-1' }],
        }),
      ];
      const context = makeContextWithRoute();
      const plan = makeBuildTrackPlan(10, 11);

      const result = await GuardrailEnforcer.checkPlan(plan, context, snapshot);

      expect(result.plan.type).toBe(AIActionType.PassTurn);
      expect(result.overridden).toBe(true);
      expect(result.violationCode).toBe('BUILD_RESTRICTION_VIOLATION');
    });
  });

  describe('Event card: PICKUP_DELIVERY_RESTRICTION_VIOLATION gate', () => {
    it('forces PassTurn with violationCode when PickupLoad city is in Strike coastal zone', async () => {
      const snapshot = makeSnapshot();
      snapshot.activeEffects = [
        makeActiveEffect({
          pickupDelivery: [{ type: 'no_pickup_delivery_in_zone', zone: ['20,47'] }], // Hamburg key
        }),
      ];
      const context = makeContextWithRoute();
      const plan = makePickupPlan('Hamburg');

      const result = await GuardrailEnforcer.checkPlan(plan, context, snapshot);

      expect(result.plan.type).toBe(AIActionType.PassTurn);
      expect(result.overridden).toBe(true);
      expect(result.violationCode).toBe('PICKUP_DELIVERY_RESTRICTION_VIOLATION');
    });

    it('forces PassTurn with violationCode when DeliverLoad city is in Strike coastal zone', async () => {
      const snapshot = makeSnapshot();
      snapshot.activeEffects = [
        makeActiveEffect({
          pickupDelivery: [{ type: 'no_pickup_delivery_in_zone', zone: ['20,47'] }],
        }),
      ];
      const context = makeContextWithRoute();
      const plan = makeDeliverPlan('Hamburg');

      const result = await GuardrailEnforcer.checkPlan(plan, context, snapshot);

      expect(result.plan.type).toBe(AIActionType.PassTurn);
      expect(result.overridden).toBe(true);
      expect(result.violationCode).toBe('PICKUP_DELIVERY_RESTRICTION_VIOLATION');
    });
  });

  // JIRA-257: G1 (force deliver) must consult pickup/delivery restriction predicate
  // before constructing the override, otherwise it forces a delivery the rule layer
  // will reject and the bot loops every turn until the Strike expires.
  describe('Event card: G1 force-deliver suppression (JIRA-257)', () => {
    it('suppresses forced DELIVER when best canDeliver target is in active Strike zone — original PassTurn passes through', async () => {
      const snapshot = makeSnapshot();
      snapshot.activeEffects = [
        makeActiveEffect({
          pickupDelivery: [{ type: 'no_pickup_delivery_in_zone', zone: ['20,47'] }], // Hamburg key
        }),
      ];
      const canDeliver = [{ loadType: 'Coal', deliveryCity: 'Hamburg', payout: 31, cardIndex: 43 }];
      const context = makeContext({
        canDeliver,
        demands: [makeDemand({ isAffordable: true, isSupplyOnNetwork: true, isDeliveryOnNetwork: true })],
      } as any);

      const result = await GuardrailEnforcer.checkPlan(passTurnPlan, context, snapshot, true);

      expect(result.plan.type).toBe(AIActionType.PassTurn);
      expect(result.overridden).toBe(false);
    });

    it('still forces DELIVER when no Strike is active (regression guard)', async () => {
      const snapshot = makeSnapshot();
      snapshot.activeEffects = [];
      const canDeliver = [{ loadType: 'Coal', deliveryCity: 'Hamburg', payout: 31, cardIndex: 43 }];
      const context = makeContext({
        canDeliver,
        demands: [makeDemand({ isAffordable: true, isSupplyOnNetwork: true, isDeliveryOnNetwork: true })],
      } as any);

      const result = await GuardrailEnforcer.checkPlan(passTurnPlan, context, snapshot, true);

      expect(result.plan.type).toBe(AIActionType.DeliverLoad);
      expect(result.overridden).toBe(true);
    });

    it('suppresses forced DELIVER when bestDelivery picks blocked candidate, even if non-blocked alternative exists (documented first-pass limitation)', async () => {
      // Best by payout = Hamburg-blocked at 31M. Paris alternative at 12M not blocked.
      // The simple fix suppresses the override entirely because bestDelivery picks Hamburg.
      // Iterating canDeliver for a non-blocked alternative is intentionally out of scope —
      // documented in the JIRA-257 technical ticket as a follow-up if observed in production.
      const snapshot = makeSnapshot();
      snapshot.activeEffects = [
        makeActiveEffect({
          pickupDelivery: [{ type: 'no_pickup_delivery_in_zone', zone: ['20,47'] }], // Hamburg
        }),
      ];
      const canDeliver = [
        { loadType: 'Coal', deliveryCity: 'Hamburg', payout: 31, cardIndex: 43 },
        { loadType: 'Iron', deliveryCity: 'Paris', payout: 12, cardIndex: 44 },
      ];
      const context = makeContext({
        canDeliver,
        demands: [makeDemand({ isAffordable: true, isSupplyOnNetwork: true, isDeliveryOnNetwork: true })],
      } as any);

      const result = await GuardrailEnforcer.checkPlan(passTurnPlan, context, snapshot, true);

      expect(result.plan.type).toBe(AIActionType.PassTurn);
      expect(result.overridden).toBe(false);
    });
  });
});
