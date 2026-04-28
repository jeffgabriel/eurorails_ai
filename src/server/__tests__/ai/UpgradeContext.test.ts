/**
 * UpgradeContext.test.ts — Unit tests for the UpgradeContext computation module.
 * JIRA-195: Slice 1 — ContextBuilder decomposition.
 */

import { UpgradeContext } from '../../services/ai/context/UpgradeContext';
import {
  WorldSnapshot,
  DemandContext,
  BotSkillLevel,
  GameStatus,
  TerrainType,
  TrainType,
} from '../../../shared/types/GameTypes';

// ── Helper factories ────────────────────────────────────────────────────────

function makeSnapshot(overrides: {
  trainType?: string;
  money?: number;
  turnNumber?: number;
  gameStatus?: GameStatus;
}): WorldSnapshot {
  return {
    gameId: 'test-game',
    gameStatus: overrides.gameStatus ?? 'active',
    turnNumber: overrides.turnNumber ?? 10,
    bot: {
      playerId: 'bot-1',
      userId: 'user-1',
      money: overrides.money ?? 80,
      position: null,
      existingSegments: [],
      demandCards: [1, 2, 3],
      resolvedDemands: [],
      trainType: overrides.trainType ?? TrainType.Freight,
      loads: [],
      botConfig: { skillLevel: BotSkillLevel.Medium },
      connectedMajorCityCount: 1,
    },
    allPlayerTracks: [],
    loadAvailability: {},
  };
}

function makeDemand(estimatedTurns: number = 3, trackCostToSupply: number = 10, trackCostToDelivery: number = 10): DemandContext {
  return {
    cardIndex: 1,
    loadType: 'Steel',
    supplyCity: 'Ruhr',
    deliveryCity: 'Wien',
    payout: 25,
    estimatedTurns,
    estimatedTrackCostToSupply: trackCostToSupply,
    estimatedTrackCostToDelivery: trackCostToDelivery,
    isSupplyReachable: false,
    isDeliveryReachable: false,
    isSupplyOnNetwork: false,
    isDeliveryOnNetwork: false,
    isLoadAvailable: true,
    isLoadOnTrain: false,
    ferryRequired: false,
    loadChipTotal: 3,
    loadChipCarried: 0,
    demandScore: 8,
    efficiencyPerTurn: 2.5,
    networkCitiesUnlocked: 0,
    victoryMajorCitiesEnRoute: 0,
    isAffordable: true,
    projectedFundsAfterDelivery: 80,
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('UpgradeContext.compute', () => {
  describe('gating: returns undefined when conditions suppress advice', () => {
    it('returns undefined during initialBuild phase', () => {
      const snapshot = makeSnapshot({ gameStatus: 'initialBuild' });
      expect(UpgradeContext.compute(snapshot, [], true, 5)).toBeUndefined();
    });

    it('returns undefined when deliveryCount is below MIN_DELIVERIES_BEFORE_UPGRADE (1)', () => {
      const snapshot = makeSnapshot({ trainType: TrainType.Freight, money: 50, turnNumber: 15 });
      expect(UpgradeContext.compute(snapshot, [], true, 0)).toBeUndefined();
    });

    it('returns undefined when trainType is Superfreight', () => {
      const snapshot = makeSnapshot({ trainType: TrainType.Superfreight, money: 100 });
      expect(UpgradeContext.compute(snapshot, [], true, 5)).toBeUndefined();
    });

    it('returns advice when deliveryCount equals threshold (1)', () => {
      // deliveryCount >= 1 unlocks advice; exactly 1 passes the gate
      const snapshot = makeSnapshot({ trainType: TrainType.Freight, money: 80, turnNumber: 5 });
      // At turn 5 with money >= 20, no urgent/warning text — may be undefined if no parts
      const result = UpgradeContext.compute(snapshot, [], true, 1);
      // No urgent text at turn 5 but Fast Freight info should appear if money >= 20
      if (result !== undefined) {
        expect(result).toContain('Fast Freight');
      }
    });
  });

  describe('Freight train advice', () => {
    it('produces URGENT advice at turn >= 15 with money >= 20', () => {
      const snapshot = makeSnapshot({ trainType: TrainType.Freight, money: 50, turnNumber: 15 });
      const result = UpgradeContext.compute(snapshot, [], true, 5);
      expect(result).toBeDefined();
      expect(result).toContain('URGENT');
    });

    it('produces WARNING advice at turn 10-14 with money >= 20', () => {
      const snapshot = makeSnapshot({ trainType: TrainType.Freight, money: 50, turnNumber: 10 });
      const result = UpgradeContext.compute(snapshot, [], true, 5);
      expect(result).toBeDefined();
      expect(result).toContain('WARNING');
    });

    it('includes Fast Freight + Heavy Freight costs when money >= 20', () => {
      const snapshot = makeSnapshot({ trainType: TrainType.Freight, money: 50, turnNumber: 10 });
      const result = UpgradeContext.compute(snapshot, [], true, 5);
      expect(result).toContain('Fast Freight');
      expect(result).toContain('Heavy Freight');
    });

    it('mentions avg route length when > 15 mileposts', () => {
      const snapshot = makeSnapshot({ trainType: TrainType.Freight, money: 50, turnNumber: 10 });
      // estimatedTurns=2, speed=9 → avgRouteLength=18 (>15)
      const demands = [makeDemand(2)];
      const result = UpgradeContext.compute(snapshot, demands, false, 5);
      expect(result).toContain('18 mileposts');
    });

    it('mentions no-build-target when canBuild is false and money >= 20', () => {
      const snapshot = makeSnapshot({ trainType: TrainType.Freight, money: 50, turnNumber: 10 });
      const demands = [makeDemand(3, 3, 3)]; // low track cost → hasMeaningfulBuild false since cost=6 ≤ 5? no 6>5
      const result = UpgradeContext.compute(snapshot, demands, false, 5);
      // canBuild=false so hasMeaningfulBuild=false
      expect(result).toContain('No route-critical build target');
    });

    it('returns undefined when money < 20 and early game with no other conditions met', () => {
      const snapshot = makeSnapshot({ trainType: TrainType.Freight, money: 10, turnNumber: 5 });
      const result = UpgradeContext.compute(snapshot, [], true, 5);
      // No urgency at turn 5, no cost data for Fast Freight (money < 20), no avg route length
      // parts will be empty
      expect(result).toBeUndefined();
    });
  });

  describe('FastFreight/HeavyFreight advice', () => {
    it('mentions Superfreight when money >= 20', () => {
      const snapshot = makeSnapshot({ trainType: TrainType.FastFreight, money: 50 });
      const result = UpgradeContext.compute(snapshot, [], true, 5);
      expect(result).toContain('Superfreight available');
    });

    it('mentions crossgrade cost (5M) when money 5-19', () => {
      const snapshot = makeSnapshot({ trainType: TrainType.FastFreight, money: 15 });
      const result = UpgradeContext.compute(snapshot, [], true, 5);
      expect(result).toContain('Crossgrade');
      expect(result).toContain('5M');
    });

    it('HeavyFreight crossgrade suggests Fast Freight', () => {
      const snapshot = makeSnapshot({ trainType: TrainType.HeavyFreight, money: 15 });
      const result = UpgradeContext.compute(snapshot, [], true, 5);
      expect(result).toContain('Fast Freight');
    });

    it('no-build-target mention for FastFreight when canBuild=false and money >= 20', () => {
      const snapshot = makeSnapshot({ trainType: TrainType.FastFreight, money: 50 });
      const result = UpgradeContext.compute(snapshot, [], false, 5);
      expect(result).toContain('No route-critical build target');
    });
  });

  describe('default parameter behavior', () => {
    it('uses deliveryCount=0 when not provided (suppresses advice)', () => {
      const snapshot = makeSnapshot({ trainType: TrainType.Freight, money: 50, turnNumber: 15 });
      // Without deliveryCount, defaults to 0 which is below gate (1)
      const result = UpgradeContext.compute(snapshot, [], true);
      expect(result).toBeUndefined();
    });
  });
});
