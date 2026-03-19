import { SolvencyCheck } from '../../services/ai/SolvencyCheck';
import { TrackSegment, WorldSnapshot, GameContext, TerrainType } from '../../../shared/types/GameTypes';

/** Helper to create a minimal WorldSnapshot for solvency testing */
function makeSnapshot(overrides: {
  money?: number;
  loads?: string[];
  resolvedDemands?: WorldSnapshot['bot']['resolvedDemands'];
}): WorldSnapshot {
  return {
    gameId: 'test-game',
    gameStatus: 'active',
    turnNumber: 10,
    bot: {
      playerId: 'bot-1',
      userId: 'user-1',
      money: overrides.money ?? 20,
      position: { row: 10, col: 10 },
      existingSegments: [],
      demandCards: [],
      resolvedDemands: overrides.resolvedDemands ?? [],
      trainType: 'freight',
      loads: overrides.loads ?? [],
      botConfig: { skillLevel: 'medium' },
      connectedMajorCityCount: 2,
    },
    allPlayerTracks: [],
    loadAvailability: {},
  };
}

/** Helper to create a minimal GameContext for solvency testing */
function makeContext(overrides: {
  citiesOnNetwork?: string[];
}): GameContext {
  return {
    position: { row: 10, col: 10 },
    money: 20,
    trainType: 'freight',
    speed: 9,
    capacity: 2,
    loads: [],
    connectedMajorCities: [],
    unconnectedMajorCities: [],
    totalMajorCities: 15,
    trackSummary: '',
    turnBuildCost: 0,
    demands: [],
    canDeliver: [],
    canPickup: [],
    reachableCities: [],
    citiesOnNetwork: overrides.citiesOnNetwork ?? [],
    canUpgrade: false,
    canBuild: true,
    isInitialBuild: false,
    opponents: [],
    phase: 'active',
    turnNumber: 10,
  };
}

/** Helper to create a track segment with given cost */
function makeSeg(cost: number): TrackSegment {
  return {
    from: { x: 0, y: 0, row: 10, col: 10, terrain: TerrainType.Clear },
    to: { x: 1, y: 1, row: 10, col: 11, terrain: TerrainType.Clear },
    cost,
  };
}

describe('SolvencyCheck', () => {
  describe('actualCost calculation', () => {
    it('should sum segment costs', () => {
      const segments = [makeSeg(3), makeSeg(5), makeSeg(2)];
      const snapshot = makeSnapshot({ money: 20 });
      const context = makeContext({});

      const result = SolvencyCheck.check(segments, snapshot, context);
      expect(result.actualCost).toBe(10);
    });

    it('should return 0 for empty segments', () => {
      const result = SolvencyCheck.check([], makeSnapshot({ money: 20 }), makeContext({}));
      expect(result.actualCost).toBe(0);
      expect(result.canAfford).toBe(true);
    });
  });

  describe('incomeBefore calculation', () => {
    it('should count payouts for on-network delivery cities only', () => {
      const snapshot = makeSnapshot({
        money: 5,
        loads: ['Steel'],
        resolvedDemands: [
          {
            cardId: 1,
            demands: [
              { city: 'Paris', loadType: 'Steel', payment: 15 },
              { city: 'Berlin', loadType: 'Coal', payment: 10 },
            ],
          },
        ],
      });
      const context = makeContext({ citiesOnNetwork: ['Paris'] });

      const result = SolvencyCheck.check([makeSeg(18)], snapshot, context);
      expect(result.incomeBefore).toBe(15);
      expect(result.availableForBuild).toBe(20); // 5 + 15
      expect(result.canAfford).toBe(true);
    });

    it('should NOT count payouts for off-network delivery cities', () => {
      const snapshot = makeSnapshot({
        money: 5,
        loads: ['Steel'],
        resolvedDemands: [
          {
            cardId: 1,
            demands: [
              { city: 'Berlin', loadType: 'Steel', payment: 15 },
            ],
          },
        ],
      });
      const context = makeContext({ citiesOnNetwork: ['Paris'] }); // Berlin NOT on network

      const result = SolvencyCheck.check([makeSeg(10)], snapshot, context);
      expect(result.incomeBefore).toBe(0);
      expect(result.availableForBuild).toBe(5);
      expect(result.canAfford).toBe(false);
    });

    it('should handle no carried loads', () => {
      const snapshot = makeSnapshot({ money: 10, loads: [] });
      const context = makeContext({ citiesOnNetwork: ['Paris'] });

      const result = SolvencyCheck.check([makeSeg(8)], snapshot, context);
      expect(result.incomeBefore).toBe(0);
      expect(result.availableForBuild).toBe(10);
      expect(result.canAfford).toBe(true);
    });
  });

  describe('canAfford logic', () => {
    it('should allow spending to zero cash', () => {
      const snapshot = makeSnapshot({ money: 10 });
      const context = makeContext({});

      const result = SolvencyCheck.check([makeSeg(10)], snapshot, context);
      expect(result.canAfford).toBe(true);
      expect(result.availableForBuild).toBe(10);
    });

    it('should reject when cost exceeds available', () => {
      const snapshot = makeSnapshot({ money: 10 });
      const context = makeContext({});

      const result = SolvencyCheck.check([makeSeg(11)], snapshot, context);
      expect(result.canAfford).toBe(false);
    });

    it('should include incomeBefore in affordability check', () => {
      const snapshot = makeSnapshot({
        money: 5,
        loads: ['Oil'],
        resolvedDemands: [
          {
            cardId: 2,
            demands: [{ city: 'Roma', loadType: 'Oil', payment: 12 }],
          },
        ],
      });
      const context = makeContext({ citiesOnNetwork: ['Roma'] });

      const result = SolvencyCheck.check([makeSeg(16)], snapshot, context);
      expect(result.incomeBefore).toBe(12);
      expect(result.availableForBuild).toBe(17); // 5 + 12
      expect(result.canAfford).toBe(true);
    });
  });
});
