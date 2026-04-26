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

// ── Helper factories ────────────────────────────────────────────────────────

function makeSnapshot(overrides: {
  trainType?: string;
  money?: number;
  gameStatus?: GameStatus;
  turnBuildCost?: number;
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
  };
  if (overrides.turnBuildCost !== undefined) {
    bot.turnBuildCost = overrides.turnBuildCost;
  }
  return {
    gameId: 'test-game',
    gameStatus: overrides.gameStatus ?? 'playing',
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
      const snapshot = makeSnapshot({ gameStatus: 'initialBuild', money: 100 });
      const result = BuildContext.compute(snapshot, undefined, emptyNetwork, []);
      expect(result.canUpgrade).toBe(false);
    });

    it('canUpgrade is false when money < 5', () => {
      const snapshot = makeSnapshot({ money: 4, trainType: TrainType.Freight });
      const result = BuildContext.compute(snapshot, undefined, emptyNetwork, []);
      expect(result.canUpgrade).toBe(false);
    });

    it('Freight: canUpgrade is true when money >= 20', () => {
      const snapshot = makeSnapshot({ money: 20, trainType: TrainType.Freight });
      const result = BuildContext.compute(snapshot, undefined, emptyNetwork, []);
      expect(result.canUpgrade).toBe(true);
    });

    it('Freight: canUpgrade is false when money < 20', () => {
      const snapshot = makeSnapshot({ money: 19, trainType: TrainType.Freight });
      const result = BuildContext.compute(snapshot, undefined, emptyNetwork, []);
      expect(result.canUpgrade).toBe(false);
    });

    it('FastFreight: canUpgrade is true when money >= 5', () => {
      const snapshot = makeSnapshot({ money: 5, trainType: TrainType.FastFreight });
      const result = BuildContext.compute(snapshot, undefined, emptyNetwork, []);
      expect(result.canUpgrade).toBe(true);
    });

    it('HeavyFreight: canUpgrade is true when money >= 5', () => {
      const snapshot = makeSnapshot({ money: 5, trainType: TrainType.HeavyFreight });
      const result = BuildContext.compute(snapshot, undefined, emptyNetwork, []);
      expect(result.canUpgrade).toBe(true);
    });

    it('Superfreight: canUpgrade is false', () => {
      const snapshot = makeSnapshot({ money: 100, trainType: TrainType.Superfreight });
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
  it('returns false during initialBuild', () => {
    const snapshot = makeSnapshot({ gameStatus: 'initialBuild', money: 100 });
    expect(BuildContext.checkCanUpgrade(snapshot)).toBe(false);
  });

  it('returns false when money < 5', () => {
    const snapshot = makeSnapshot({ money: 4 });
    expect(BuildContext.checkCanUpgrade(snapshot)).toBe(false);
  });

  it('Freight returns true with 20M', () => {
    const snapshot = makeSnapshot({ money: 20, trainType: TrainType.Freight });
    expect(BuildContext.checkCanUpgrade(snapshot)).toBe(true);
  });

  it('Freight returns false with 19M', () => {
    const snapshot = makeSnapshot({ money: 19, trainType: TrainType.Freight });
    expect(BuildContext.checkCanUpgrade(snapshot)).toBe(false);
  });

  it('Superfreight always returns false', () => {
    const snapshot = makeSnapshot({ money: 999, trainType: TrainType.Superfreight });
    expect(BuildContext.checkCanUpgrade(snapshot)).toBe(false);
  });
});
