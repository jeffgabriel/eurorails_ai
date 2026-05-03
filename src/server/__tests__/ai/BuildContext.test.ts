/**
 * BuildContext.test.ts — Unit tests for the BuildContext computation module.
 * JIRA-195: Slice 1 — ContextBuilder decomposition.
 */

import { BuildContext } from '../../services/ai/context/BuildContext';
import {
  WorldSnapshot,
  BotSkillLevel,
  GameStatus,
  TrainType,
} from '../../../shared/types/GameTypes';
import { NetworkContextResult } from '../../services/ai/context/NetworkContext';
import {
  UPGRADE_OPERATING_BUFFER,
  UPGRADE_DELIVERY_THRESHOLD,
} from '../../services/ai/context/UpgradeGatingConstants';

// Cash fixtures derived from the gating constants so changes to the constants
// don't require touching every fixture. Freight upgrade cost is 20M.
const FREIGHT_UPGRADE_COST = 20;
// Just below the buffer: post-upgrade cash = buffer - 1 → gate FAILS.
const MONEY_BUFFER_FAIL = FREIGHT_UPGRADE_COST + UPGRADE_OPERATING_BUFFER - 1;
// Comfortably above the buffer: post-upgrade cash >> buffer → gate PASSES.
const MONEY_BUFFER_PASS = FREIGHT_UPGRADE_COST + UPGRADE_OPERATING_BUFFER + 25;
const DELIVERIES_OVER_THRESHOLD = UPGRADE_DELIVERY_THRESHOLD + 3;

// ── Helper factories ────────────────────────────────────────────────────────

function makeSnapshot(overrides: {
  trainType?: string;
  money?: number;
  gameStatus?: GameStatus;
  turnBuildCost?: number;
  deliveriesCompleted?: number;
}): WorldSnapshot {
  const bot: WorldSnapshot['bot'] & { turnBuildCost?: number } = {
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
    connectedMajorCityCount: 0,
    deliveriesCompleted: overrides.deliveriesCompleted ?? 5,
  };
  if (overrides.turnBuildCost !== undefined) {
    bot.turnBuildCost = overrides.turnBuildCost;
  }
  return {
    gameId: 'test-game',
    gameStatus: overrides.gameStatus ?? 'active',
    turnNumber: 10,
    bot,
    allPlayerTracks: [],
    loadAvailability: {},
  };
}

const emptyNetwork: NetworkContextResult = {
  network: null,
  reachableCities: [],
  citiesOnNetwork: [],
  connectedMajorCities: [],
  unconnectedMajorCities: [],
  phase: 'Early Game',
  positionCityName: undefined,
};

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('BuildContext.compute', () => {
  describe('canBuild', () => {
    it('canBuild is true when money > 0 and turnBuildCost < 20', () => {
      const snapshot = makeSnapshot({ money: 50 });
      const result = BuildContext.compute(snapshot, undefined, emptyNetwork, []);
      expect(result.canBuild).toBe(true);
    });

    it('canBuild is false when turnBuildCost >= 20', () => {
      const snapshot = makeSnapshot({ money: 50, turnBuildCost: 20 });
      const result = BuildContext.compute(snapshot, undefined, emptyNetwork, []);
      expect(result.canBuild).toBe(false);
    });

    it('canBuild is false when money is 0', () => {
      const snapshot = makeSnapshot({ money: 0 });
      const result = BuildContext.compute(snapshot, undefined, emptyNetwork, []);
      expect(result.canBuild).toBe(false);
    });

    it('canBuild defaults turnBuildCost to 0 when not on snapshot', () => {
      const snapshot = makeSnapshot({ money: 5 });
      const result = BuildContext.compute(snapshot, undefined, emptyNetwork, []);
      expect(result.turnBuildCost).toBe(0);
      expect(result.canBuild).toBe(true);
    });
  });

  describe('canUpgrade', () => {
    it('canUpgrade is false during initialBuild', () => {
      const snapshot = makeSnapshot({ gameStatus: 'initialBuild', money: 100, deliveriesCompleted: 5 });
      const result = BuildContext.compute(snapshot, undefined, emptyNetwork, []);
      expect(result.canUpgrade).toBe(false);
    });

    it('Freight: canUpgrade is false when money < upgrade cost', () => {
      const snapshot = makeSnapshot({ money: FREIGHT_UPGRADE_COST - 1, trainType: TrainType.Freight, deliveriesCompleted: DELIVERIES_OVER_THRESHOLD });
      const result = BuildContext.compute(snapshot, undefined, emptyNetwork, []);
      expect(result.canUpgrade).toBe(false);
    });

    it('Freight: canUpgrade is false when deliveriesCompleted < UPGRADE_DELIVERY_THRESHOLD', () => {
      // cash OK, but delivery threshold unmet
      const snapshot = makeSnapshot({ money: MONEY_BUFFER_PASS, trainType: TrainType.Freight, deliveriesCompleted: 0 });
      const result = BuildContext.compute(snapshot, undefined, emptyNetwork, []);
      expect(result.canUpgrade).toBe(false);
    });

    it('Freight: canUpgrade is false when operating buffer not met after upgrade', () => {
      // delivery threshold met, cash >= upgrade cost, but post-upgrade cash < UPGRADE_OPERATING_BUFFER
      const snapshot = makeSnapshot({ money: MONEY_BUFFER_FAIL, trainType: TrainType.Freight, deliveriesCompleted: DELIVERIES_OVER_THRESHOLD });
      const result = BuildContext.compute(snapshot, undefined, emptyNetwork, []);
      expect(result.canUpgrade).toBe(false);
    });

    it('Freight: canUpgrade is true when all three conditions met', () => {
      const snapshot = makeSnapshot({ money: MONEY_BUFFER_PASS, trainType: TrainType.Freight, deliveriesCompleted: DELIVERIES_OVER_THRESHOLD });
      const result = BuildContext.compute(snapshot, undefined, emptyNetwork, []);
      expect(result.canUpgrade).toBe(true);
    });

    it('Superfreight: canUpgrade is false regardless of cash', () => {
      const snapshot = makeSnapshot({ money: 100, trainType: TrainType.Superfreight, deliveriesCompleted: 10 });
      const result = BuildContext.compute(snapshot, undefined, emptyNetwork, []);
      expect(result.canUpgrade).toBe(false);
    });
  });

  describe('turnBuildCost', () => {
    it('returns 0 when not on snapshot', () => {
      const snapshot = makeSnapshot({});
      const result = BuildContext.compute(snapshot, undefined, emptyNetwork, []);
      expect(result.turnBuildCost).toBe(0);
    });

    it('returns the value when set on snapshot', () => {
      const snapshot = makeSnapshot({ turnBuildCost: 15 });
      const result = BuildContext.compute(snapshot, undefined, emptyNetwork, []);
      expect(result.turnBuildCost).toBe(15);
    });
  });
});

describe('BuildContext.checkCanUpgrade', () => {
  // ── Precondition gates ──────────────────────────────────────────────────────

  it('returns false during initialBuild', () => {
    const snapshot = makeSnapshot({ gameStatus: 'initialBuild', money: 100, deliveriesCompleted: 5 });
    expect(BuildContext.checkCanUpgrade(snapshot)).toBe(false);
  });

  it('Superfreight always returns false', () => {
    const snapshot = makeSnapshot({ money: 999, trainType: TrainType.Superfreight, deliveriesCompleted: 10 });
    expect(BuildContext.checkCanUpgrade(snapshot)).toBe(false);
  });

  // ── Three-condition gate (AC20 cases) ───────────────────────────────────────

  it('(AC20a) returns false when cash OK but deliveriesCompleted < UPGRADE_DELIVERY_THRESHOLD', () => {
    const snapshot = makeSnapshot({ money: MONEY_BUFFER_PASS, trainType: TrainType.Freight, deliveriesCompleted: 0 });
    expect(BuildContext.checkCanUpgrade(snapshot)).toBe(false);
  });

  it('(AC20b) returns false when cash + delivery threshold met but operating buffer unmet', () => {
    const snapshot = makeSnapshot({ money: MONEY_BUFFER_FAIL, trainType: TrainType.Freight, deliveriesCompleted: DELIVERIES_OVER_THRESHOLD });
    expect(BuildContext.checkCanUpgrade(snapshot)).toBe(false);
  });

  it('(AC20c) returns true when all three conditions met', () => {
    const snapshot = makeSnapshot({ money: MONEY_BUFFER_PASS, trainType: TrainType.Freight, deliveriesCompleted: DELIVERIES_OVER_THRESHOLD });
    expect(BuildContext.checkCanUpgrade(snapshot)).toBe(true);
  });

  it('returns false when money < upgrade cost', () => {
    const snapshot = makeSnapshot({ money: FREIGHT_UPGRADE_COST - 1, trainType: TrainType.Freight, deliveriesCompleted: DELIVERIES_OVER_THRESHOLD });
    expect(BuildContext.checkCanUpgrade(snapshot)).toBe(false);
  });

  it('uses deliveriesCompleted=0 as default when field absent', () => {
    // snapshot bot has no deliveriesCompleted set — should default to 0 → threshold unmet
    const snapshot = makeSnapshot({ money: 60, trainType: TrainType.Freight });
    // makeSnapshot defaults deliveriesCompleted to 5, so override here
    snapshot.bot.deliveriesCompleted = undefined;
    expect(BuildContext.checkCanUpgrade(snapshot)).toBe(false);
  });
});
