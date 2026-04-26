/**
 * ContextSerializer.test.ts — Unit tests for the ContextSerializer module.
 * JIRA-195: Slice 1 — ContextBuilder decomposition.
 *
 * Verifies that each serializer in ContextSerializer produces character-identical
 * output to the corresponding ContextBuilder serializer method (same signatures,
 * same byte-output for fixed inputs).
 */

import { ContextSerializer } from '../../services/ai/prompts/ContextSerializer';
import { ContextBuilder } from '../../services/ai/ContextBuilder';
import {
  GameContext,
  WorldSnapshot,
  BotSkillLevel,
  TerrainType,
  TrainType,
  GameStatus,
  DemandContext,
  EnRoutePickup,
  StrategicRoute,
  RouteStop,
} from '../../../shared/types/GameTypes';

// ── Mocks ─────────────────────────────────────────────────────────────────────

jest.mock('../../../shared/services/majorCityGroups', () => ({
  getMajorCityGroups: jest.fn(() => [
    { cityName: 'Wien', center: { row: 37, col: 55 }, outposts: [] },
    { cityName: 'Berlin', center: { row: 24, col: 52 }, outposts: [] },
    { cityName: 'Paris', center: { row: 29, col: 32 }, outposts: [] },
  ]),
  getFerryEdges: jest.fn(() => []),
}));

jest.mock('../../services/ai/MapTopology', () => ({
  estimatePathCost: jest.fn(() => 10),
  estimateHopDistance: jest.fn(() => 5),
  hexDistance: jest.fn(() => 5),
  computeLandmass: jest.fn(() => new Set()),
  computeFerryRouteInfo: jest.fn(() => ({ requiresFerry: false, departurePorts: [], arrivalPorts: [], ferryCost: 0 })),
  makeKey: jest.fn((r: number, c: number) => `${r},${c}`),
  loadGridPoints: jest.fn(() => new Map()),
  getFerryPairPort: jest.fn(() => null),
}));

jest.mock('../../services/ai/connectedMajorCities', () => ({
  getConnectedMajorCities: jest.fn(() => []),
}));

// ── Helper factories ────────────────────────────────────────────────────────

function makeSnapshot(overrides: {
  trainType?: string;
  money?: number;
  turnNumber?: number;
  gameStatus?: GameStatus;
  loads?: string[];
}): WorldSnapshot {
  return {
    gameId: 'test-game',
    gameStatus: overrides.gameStatus ?? 'active',
    turnNumber: overrides.turnNumber ?? 10,
    bot: {
      playerId: 'bot-1', userId: 'user-1',
      money: overrides.money ?? 80,
      position: { row: 24, col: 52 },
      existingSegments: [],
      demandCards: [1, 2, 3],
      resolvedDemands: [
        { cardId: 1, demands: [{ city: 'Wien', loadType: 'Steel', payment: 22 }] },
      ],
      trainType: overrides.trainType ?? TrainType.Freight,
      loads: overrides.loads ?? [],
      botConfig: { skillLevel: BotSkillLevel.Medium },
      connectedMajorCityCount: 1,
    },
    allPlayerTracks: [],
    loadAvailability: { Ruhr: ['Steel'] },
  };
}

function makeGameContext(snapshot: WorldSnapshot): GameContext {
  return {
    position: { row: 24, col: 52, city: 'Berlin' },
    money: snapshot.bot.money,
    trainType: snapshot.bot.trainType,
    speed: 9,
    capacity: 2,
    loads: snapshot.bot.loads,
    connectedMajorCities: ['Berlin'],
    unconnectedMajorCities: [{ cityName: 'Wien', estimatedCost: 15 }],
    totalMajorCities: 8,
    trackSummary: '3 mileposts',
    turnBuildCost: 0,
    demands: [
      {
        cardIndex: 1, loadType: 'Steel', supplyCity: 'Ruhr', deliveryCity: 'Wien',
        payout: 22, estimatedTurns: 3, estimatedTrackCostToSupply: 10,
        estimatedTrackCostToDelivery: 8,
        isSupplyReachable: false, isDeliveryReachable: false,
        isSupplyOnNetwork: false, isDeliveryOnNetwork: false,
        isLoadAvailable: true, isLoadOnTrain: false,
        ferryRequired: false, loadChipTotal: 3, loadChipCarried: 0,
        demandScore: 7, efficiencyPerTurn: 2.5,
        networkCitiesUnlocked: 0, victoryMajorCitiesEnRoute: 0,
        isAffordable: true, projectedFundsAfterDelivery: 80,
      } as DemandContext,
    ],
    canDeliver: [],
    canPickup: [],
    reachableCities: ['Berlin'],
    citiesOnNetwork: ['Berlin'],
    canUpgrade: true,
    canBuild: true,
    isInitialBuild: false,
    opponents: [],
    phase: 'Mid Game',
    turnNumber: snapshot.turnNumber,
  };
}

function makeRoute(stops: Array<{ action: 'pickup' | 'deliver' | 'drop'; loadType: string; city: string; payment?: number }>): StrategicRoute {
  return {
    stops: stops as RouteStop[],
    currentStopIndex: 0,
    phase: 'travel',
    createdAtTurn: 5,
    reasoning: 'Test route',
  };
}

// ── Tests: Output equivalence ─────────────────────────────────────────────────

describe('ContextSerializer — output equivalence with ContextBuilder', () => {
  describe('serializePrompt', () => {
    it('produces identical output to ContextBuilder.serializePrompt', () => {
      const snapshot = makeSnapshot({});
      const ctx = makeGameContext(snapshot);
      const cbOutput = ContextBuilder.serializePrompt(ctx, BotSkillLevel.Medium);
      const csOutput = ContextSerializer.serializePrompt(ctx, BotSkillLevel.Medium);
      expect(csOutput).toBe(cbOutput);
    });

    it('output includes turn number and phase', () => {
      const snapshot = makeSnapshot({ turnNumber: 15 });
      const ctx = makeGameContext(snapshot);
      const output = ContextSerializer.serializePrompt(ctx, BotSkillLevel.Medium);
      expect(output).toContain('TURN 15');
      expect(output).toContain('Mid Game');
    });

    it('output includes YOUR STATUS section', () => {
      const snapshot = makeSnapshot({});
      const ctx = makeGameContext(snapshot);
      const output = ContextSerializer.serializePrompt(ctx, BotSkillLevel.Medium);
      expect(output).toContain('YOUR STATUS');
    });
  });

  describe('serializeRoutePlanningPrompt', () => {
    it('produces identical output to ContextBuilder.serializeRoutePlanningPrompt', () => {
      const snapshot = makeSnapshot({});
      const ctx = makeGameContext(snapshot);
      const cbOutput = ContextBuilder.serializeRoutePlanningPrompt(ctx, BotSkillLevel.Medium, [], []);
      const csOutput = ContextSerializer.serializeRoutePlanningPrompt(ctx, BotSkillLevel.Medium, [], []);
      expect(csOutput).toBe(cbOutput);
    });

    it('output includes turn number and demands section', () => {
      const snapshot = makeSnapshot({});
      const ctx = makeGameContext(snapshot);
      const output = ContextSerializer.serializeRoutePlanningPrompt(ctx, BotSkillLevel.Medium, [], []);
      expect(output).toContain('TURN');
      expect(output).toContain('YOUR STATUS');
    });

    it('passes lastAbandonedRouteKey to output correctly', () => {
      const snapshot = makeSnapshot({});
      const ctx = makeGameContext(snapshot);
      const outputWithKey = ContextSerializer.serializeRoutePlanningPrompt(
        ctx, BotSkillLevel.Medium, [], [], 'Wien→Steel→Berlin',
      );
      const outputWithoutKey = ContextSerializer.serializeRoutePlanningPrompt(ctx, BotSkillLevel.Medium, [], []);
      // Output with key should differ from without key
      expect(outputWithKey).not.toBe(outputWithoutKey);
    });
  });

  describe('serializeSecondaryDeliveryPrompt', () => {
    it('produces identical output to ContextBuilder.serializeSecondaryDeliveryPrompt', () => {
      const snapshot = makeSnapshot({});
      const stops: RouteStop[] = [
        { action: 'pickup', loadType: 'Steel', city: 'Ruhr' },
        { action: 'deliver', loadType: 'Steel', city: 'Wien', demandCardId: 1, payment: 22 },
      ];
      const demands: DemandContext[] = makeGameContext(snapshot).demands;
      const enRoutePickups: EnRoutePickup[] = [];
      const cbOutput = ContextBuilder.serializeSecondaryDeliveryPrompt(snapshot, stops, demands, enRoutePickups);
      const csOutput = ContextSerializer.serializeSecondaryDeliveryPrompt(snapshot, stops, demands, enRoutePickups);
      expect(csOutput).toBe(cbOutput);
    });

    it('output includes turn number', () => {
      const snapshot = makeSnapshot({ turnNumber: 12 });
      const output = ContextSerializer.serializeSecondaryDeliveryPrompt(snapshot, [], [], []);
      expect(output).toContain('TURN 12');
    });
  });

  describe('serializeCargoConflictPrompt', () => {
    it('produces identical output to ContextBuilder.serializeCargoConflictPrompt', () => {
      const snapshot = makeSnapshot({ loads: ['Steel', 'Coal'] });
      const route = makeRoute([
        { action: 'pickup', loadType: 'Steel', city: 'Ruhr' },
        { action: 'deliver', loadType: 'Steel', city: 'Wien', payment: 22 },
      ]);
      const demands: DemandContext[] = makeGameContext(snapshot).demands;
      const cbOutput = ContextBuilder.serializeCargoConflictPrompt(snapshot, route, ['Coal'], demands);
      const csOutput = ContextSerializer.serializeCargoConflictPrompt(snapshot, route, ['Coal'], demands);
      expect(csOutput).toBe(cbOutput);
    });

    it('output mentions conflicting loads', () => {
      const snapshot = makeSnapshot({ loads: ['Steel', 'Coal'] });
      const route = makeRoute([{ action: 'deliver', loadType: 'Steel', city: 'Wien', payment: 22 }]);
      const output = ContextSerializer.serializeCargoConflictPrompt(snapshot, route, ['Coal'], []);
      expect(output).toContain('CARGO CONFLICT');
    });
  });

  describe('serializeUpgradeBeforeDropPrompt', () => {
    it('produces identical output to ContextBuilder.serializeUpgradeBeforeDropPrompt', () => {
      const snapshot = makeSnapshot({});
      const route = makeRoute([
        { action: 'pickup', loadType: 'Steel', city: 'Ruhr' },
        { action: 'deliver', loadType: 'Steel', city: 'Wien', payment: 22 },
      ]);
      const upgradeOptions = [{ targetTrain: 'fast_freight', cost: 20 }];
      const demands: DemandContext[] = makeGameContext(snapshot).demands;
      const cbOutput = ContextBuilder.serializeUpgradeBeforeDropPrompt(snapshot, route, upgradeOptions, 22, demands);
      const csOutput = ContextSerializer.serializeUpgradeBeforeDropPrompt(snapshot, route, upgradeOptions, 22, demands);
      expect(csOutput).toBe(cbOutput);
    });

    it('output includes planned route and upgrade options', () => {
      const snapshot = makeSnapshot({});
      const route = makeRoute([{ action: 'pickup', loadType: 'Steel', city: 'Ruhr' }]);
      const upgradeOptions = [{ targetTrain: 'fast_freight', cost: 20 }];
      const output = ContextSerializer.serializeUpgradeBeforeDropPrompt(snapshot, route, upgradeOptions, 0, []);
      expect(output).toContain('PLANNED ROUTE');
      expect(output).toContain('AVAILABLE UPGRADES');
    });
  });
});
