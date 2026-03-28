/**
 * JIRA-161: Train Upgrade Logic Fix
 *
 * Tests for:
 * 1. computeUpgradeAdvice() — suppresses advice below MIN_DELIVERIES_BEFORE_UPGRADE
 * 2. tryConsumeUpgrade() — returns { action, reason } and exposes rejection reason
 * 3. Gate 2 removal — upgrades flow through when deliveryCount >= MIN_DELIVERIES_BEFORE_UPGRADE
 */

import { ContextBuilder } from '../../services/ai/ContextBuilder';
import { AIStrategyEngine, MIN_DELIVERIES_BEFORE_UPGRADE } from '../../services/ai/AIStrategyEngine';
import {
  WorldSnapshot,
  GameStatus,
  TrainType,
  TerrainType,
  StrategicRoute,
  AIActionType,
} from '../../../shared/types/GameTypes';

// ── Mocks ────────────────────────────────────────────────────────────────────

jest.mock('../../services/ai/MapTopology', () => ({
  estimatePathCost: jest.fn(() => 0),
  estimateHopDistance: jest.fn(() => 0),
  hexDistance: jest.fn(() => 0),
  computeLandmass: jest.fn(() => new Set<string>()),
  computeFerryRouteInfo: jest.fn(() => ({
    requiresFerry: false,
    canCrossFerry: false,
    departurePorts: [],
    arrivalPorts: [],
    cheapestFerryCost: 0,
  })),
  makeKey: jest.fn((r: number, c: number) => `${r},${c}`),
  loadGridPoints: jest.fn(() => new Map()),
}));

jest.mock('../../../shared/services/majorCityGroups', () => ({
  getMajorCityGroups: jest.fn(() => [
    { cityName: 'Wien', center: { row: 37, col: 55 }, outposts: [] },
    { cityName: 'Berlin', center: { row: 24, col: 52 }, outposts: [] },
    { cityName: 'Paris', center: { row: 29, col: 32 }, outposts: [] },
  ]),
  getFerryEdges: jest.fn(() => []),
}));

// ── Helper factories ─────────────────────────────────────────────────────────

function makeSnapshot(overrides: {
  trainType?: string;
  money?: number;
  gameStatus?: GameStatus;
  turnNumber?: number;
} = {}): WorldSnapshot {
  return {
    gameId: 'game-test',
    gameStatus: overrides.gameStatus ?? 'inProgress' as GameStatus,
    turnNumber: overrides.turnNumber ?? 10,
    bot: {
      playerId: 'bot-1',
      userId: 'user-1',
      money: overrides.money ?? 50,
      position: { row: 10, col: 10 },
      existingSegments: [],
      demandCards: [1, 2, 3],
      resolvedDemands: [],
      trainType: overrides.trainType ?? TrainType.Freight,
      loads: [],
      botConfig: { skillLevel: 'medium' },
      connectedMajorCityCount: 0,
    },
    allPlayerTracks: [],
    loadAvailability: {},
  };
}

function makeRoute(upgradeOnRoute?: string): StrategicRoute {
  return {
    stops: [],
    currentStopIndex: 0,
    phase: 'deliver',
    upgradeOnRoute,
  };
}

// ── computeUpgradeAdvice tests ───────────────────────────────────────────────

describe('JIRA-161: computeUpgradeAdvice delivery count gating', () => {
  it('returns undefined when deliveryCount is below MIN_DELIVERIES_BEFORE_UPGRADE', () => {
    const snapshot = makeSnapshot({ trainType: TrainType.Freight, money: 50, turnNumber: 15 });
    const result = ContextBuilder.computeUpgradeAdvice(snapshot, [], true, MIN_DELIVERIES_BEFORE_UPGRADE - 1);
    expect(result).toBeUndefined();
  });

  it('returns undefined when deliveryCount is 0 (default)', () => {
    const snapshot = makeSnapshot({ trainType: TrainType.Freight, money: 50, turnNumber: 15 });
    const result = ContextBuilder.computeUpgradeAdvice(snapshot, [], true, 0);
    expect(result).toBeUndefined();
  });

  it('returns advice when deliveryCount equals MIN_DELIVERIES_BEFORE_UPGRADE', () => {
    const snapshot = makeSnapshot({ trainType: TrainType.Freight, money: 50, turnNumber: 15 });
    const result = ContextBuilder.computeUpgradeAdvice(snapshot, [], true, MIN_DELIVERIES_BEFORE_UPGRADE);
    // Should produce URGENT message at turn 15 with money >= 20
    expect(result).toBeDefined();
    expect(result).toContain('URGENT');
  });

  it('returns advice when deliveryCount is above MIN_DELIVERIES_BEFORE_UPGRADE', () => {
    const snapshot = makeSnapshot({ trainType: TrainType.Freight, money: 50, turnNumber: 15 });
    const result = ContextBuilder.computeUpgradeAdvice(snapshot, [], true, MIN_DELIVERIES_BEFORE_UPGRADE + 3);
    expect(result).toBeDefined();
    expect(result).toContain('URGENT');
  });

  it('returns undefined for initialBuild regardless of deliveryCount', () => {
    const snapshot = makeSnapshot({ trainType: TrainType.Freight, money: 50, gameStatus: 'initialBuild' as GameStatus });
    const result = ContextBuilder.computeUpgradeAdvice(snapshot, [], true, MIN_DELIVERIES_BEFORE_UPGRADE + 5);
    expect(result).toBeUndefined();
  });

  it('returns undefined for Superfreight regardless of deliveryCount', () => {
    const snapshot = makeSnapshot({ trainType: TrainType.Superfreight, money: 50 });
    const result = ContextBuilder.computeUpgradeAdvice(snapshot, [], true, MIN_DELIVERIES_BEFORE_UPGRADE + 5);
    expect(result).toBeUndefined();
  });

  it('generates WARNING for Freight at turn 10 with sufficient deliveries', () => {
    const snapshot = makeSnapshot({ trainType: TrainType.Freight, money: 50, turnNumber: 10 });
    const result = ContextBuilder.computeUpgradeAdvice(snapshot, [], true, MIN_DELIVERIES_BEFORE_UPGRADE);
    expect(result).toBeDefined();
    expect(result).toContain('WARNING');
  });

  it('generates crossgrade advice for FastFreight with 5M < money < 20M and sufficient deliveries', () => {
    const snapshot = makeSnapshot({ trainType: TrainType.FastFreight, money: 10 });
    const result = ContextBuilder.computeUpgradeAdvice(snapshot, [], true, MIN_DELIVERIES_BEFORE_UPGRADE);
    expect(result).toBeDefined();
    expect(result).toContain('Crossgrade');
  });
});

// ── tryConsumeUpgrade return type tests ─────────────────────────────────────

describe('JIRA-161: tryConsumeUpgrade exposes rejection reason', () => {
  // Access private static method for direct testing
  const tryConsumeUpgrade = (AIStrategyEngine as any).tryConsumeUpgrade.bind(AIStrategyEngine);

  it('returns { action: null, reason } when deliveryCount is below threshold', () => {
    const snapshot = makeSnapshot({ trainType: TrainType.Freight, money: 50 });
    const route = makeRoute('fast_freight');
    const result = tryConsumeUpgrade(route, snapshot, '[test]', MIN_DELIVERIES_BEFORE_UPGRADE - 1);

    expect(result.action).toBeNull();
    expect(result.reason).toBeDefined();
    expect(result.reason).toContain(`need ${MIN_DELIVERIES_BEFORE_UPGRADE}`);
    // Route should be cleared (one-time consumption)
    expect(route.upgradeOnRoute).toBeUndefined();
  });

  it('returns { action: null, reason } for invalid upgrade path', () => {
    const snapshot = makeSnapshot({ trainType: TrainType.Superfreight, money: 50 });
    const route = makeRoute('fast_freight');
    const result = tryConsumeUpgrade(route, snapshot, '[test]', MIN_DELIVERIES_BEFORE_UPGRADE);

    expect(result.action).toBeNull();
    expect(result.reason).toBeDefined();
    expect(result.reason).toContain('invalid upgrade path');
  });

  it('returns { action: null, reason } when bot cannot afford upgrade', () => {
    const snapshot = makeSnapshot({ trainType: TrainType.Freight, money: 5 });
    const route = makeRoute('fast_freight');
    const result = tryConsumeUpgrade(route, snapshot, '[test]', MIN_DELIVERIES_BEFORE_UPGRADE);

    expect(result.action).toBeNull();
    expect(result.reason).toBeDefined();
    expect(result.reason).toContain('insufficient funds');
  });

  it('returns { action: TurnPlanUpgradeTrain } when all gates pass', () => {
    const snapshot = makeSnapshot({ trainType: TrainType.Freight, money: 50 });
    const route = makeRoute('fast_freight');
    const result = tryConsumeUpgrade(route, snapshot, '[test]', MIN_DELIVERIES_BEFORE_UPGRADE);

    expect(result.action).not.toBeNull();
    expect(result.action?.type).toBe(AIActionType.UpgradeTrain);
    expect(result.action?.targetTrain).toBe('fast_freight');
    expect(result.reason).toBeUndefined();
  });

  it('clears upgradeOnRoute from route on consumption', () => {
    const snapshot = makeSnapshot({ trainType: TrainType.Freight, money: 50 });
    const route = makeRoute('fast_freight');
    tryConsumeUpgrade(route, snapshot, '[test]', MIN_DELIVERIES_BEFORE_UPGRADE);
    expect(route.upgradeOnRoute).toBeUndefined();
  });
});

// ── Gate 2 removal regression test ──────────────────────────────────────────

describe('JIRA-161: MIN_DELIVERIES_BEFORE_UPGRADE constant', () => {
  it('is exported and equals 4', () => {
    expect(MIN_DELIVERIES_BEFORE_UPGRADE).toBe(4);
  });
});

describe('JIRA-161: computeUpgradeAdvice is publicly accessible', () => {
  it('is callable as a static method without casting', () => {
    const snapshot = makeSnapshot({ trainType: TrainType.Freight, money: 50, turnNumber: 15 });
    // This line would fail TypeScript compilation if the method were private
    const result = ContextBuilder.computeUpgradeAdvice(snapshot, [], true, MIN_DELIVERIES_BEFORE_UPGRADE);
    expect(typeof result === 'string' || result === undefined).toBe(true);
  });
});
