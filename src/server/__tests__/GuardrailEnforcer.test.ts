import { GuardrailEnforcer } from '../services/ai/GuardrailEnforcer';
import {
  WorldSnapshot,
  GameContext,
  TurnPlan,
  AIActionType,
  DemandContext,
} from '../../shared/types/GameTypes';

// Minimal factory helpers for test data

function makeSnapshot(overrides: { money?: number; loads?: string[] } = {}): WorldSnapshot {
  return {
    gameId: 'game-1',
    gameStatus: 'in_progress' as any,
    turnNumber: 10,
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
});
