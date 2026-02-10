import {
  validateDeliveryFeasibility,
  validatePickupFeasibility,
  validateBuildTrackFeasibility,
  validateUpgradeFeasibility,
  computeReachableCities,
  computeBuildSegments,
  countConnectedMajorCities,
  VALID_UPGRADES,
  TERRAIN_COSTS,
  MAX_BUILD_PER_TURN,
} from '../../ai/validationService';
import { WorldSnapshot } from '../../ai/types';
import {
  TrainType,
  TerrainType,
  TrackSegment,
  GridPoint,
  PlayerTrackState,
} from '../../../shared/types/GameTypes';
import { LoadType } from '../../../shared/types/LoadTypes';
import { DemandCard } from '../../../shared/types/DemandCard';

// Mock majorCityGroups since it reads from filesystem
jest.mock('../../../shared/services/majorCityGroups', () => ({
  getMajorCityGroups: () => [
    {
      cityName: 'TestCity',
      center: { row: 5, col: 5 },
      outposts: [
        { row: 5, col: 4 },
        { row: 5, col: 6 },
      ],
    },
    {
      cityName: 'OtherCity',
      center: { row: 10, col: 10 },
      outposts: [{ row: 10, col: 9 }],
    },
  ],
  getFerryEdges: () => [],
}));

// --- Test Helpers ---

function makeGridPoint(row: number, col: number, terrain: TerrainType, cityName?: string): GridPoint {
  return {
    id: `${row}-${col}`,
    x: col * 50,
    y: row * 50,
    row,
    col,
    terrain,
    city: cityName
      ? { type: terrain, name: cityName, availableLoads: [] }
      : undefined,
  };
}

function makeSegment(
  fromRow: number, fromCol: number, fromTerrain: TerrainType,
  toRow: number, toCol: number, toTerrain: TerrainType,
  cost: number,
): TrackSegment {
  return {
    from: { x: fromCol * 50, y: fromRow * 50, row: fromRow, col: fromCol, terrain: fromTerrain },
    to: { x: toCol * 50, y: toRow * 50, row: toRow, col: toCol, terrain: toTerrain },
    cost,
  };
}

function makeSnapshot(overrides: Partial<WorldSnapshot> = {}): WorldSnapshot {
  return {
    gameId: 'test-game',
    botPlayerId: 'bot-1',
    botUserId: 'bot-user-1',
    gamePhase: 'active',
    turnBuildCostSoFar: 0,
    position: { x: 50, y: 50, row: 1, col: 1 },
    money: 50,
    debtOwed: 0,
    trainType: TrainType.Freight,
    remainingMovement: 9,
    carriedLoads: [],
    demandCards: [],
    trackSegments: [],
    connectedMajorCities: 0,
    opponents: [],
    allPlayerTracks: [],
    loadAvailability: new Map(),
    droppedLoads: new Map(),
    mapPoints: [],
    activeEvents: [],
    ...overrides,
  };
}

// --- Tests ---

describe('validateDeliveryFeasibility', () => {
  const demandCard: DemandCard = {
    id: 42,
    demands: [
      { city: 'Berlin', resource: LoadType.Coal, payment: 15 },
      { city: 'Paris', resource: LoadType.Wine, payment: 20 },
      { city: 'Madrid', resource: LoadType.Oil, payment: 25 },
    ],
  };

  it('should return infeasible if demand card not in hand', () => {
    const snapshot = makeSnapshot({ demandCards: [] });
    const result = validateDeliveryFeasibility(snapshot, 42, 0);
    expect(result.feasible).toBe(false);
    expect(result.reason).toContain('not in hand');
  });

  it('should return infeasible if demand index out of range', () => {
    const snapshot = makeSnapshot({ demandCards: [demandCard] });
    const result = validateDeliveryFeasibility(snapshot, 42, 5);
    expect(result.feasible).toBe(false);
    expect(result.reason).toContain('Invalid demand index');
  });

  it('should return infeasible if bot does not carry the load', () => {
    const snapshot = makeSnapshot({
      demandCards: [demandCard],
      carriedLoads: [LoadType.Wine],
    });
    const result = validateDeliveryFeasibility(snapshot, 42, 0); // Needs Coal
    expect(result.feasible).toBe(false);
    expect(result.reason).toContain('Not carrying');
  });

  it('should return infeasible if bot has no position', () => {
    const snapshot = makeSnapshot({
      demandCards: [demandCard],
      carriedLoads: [LoadType.Coal],
      position: null,
    });
    const result = validateDeliveryFeasibility(snapshot, 42, 0);
    expect(result.feasible).toBe(false);
    expect(result.reason).toContain('no position');
  });

  it('should return infeasible if destination city is unreachable', () => {
    // Bot at (1,1), no track to Berlin
    const snapshot = makeSnapshot({
      demandCards: [demandCard],
      carriedLoads: [LoadType.Coal],
      mapPoints: [
        makeGridPoint(1, 1, TerrainType.Clear),
        makeGridPoint(1, 2, TerrainType.Clear),
      ],
    });
    const result = validateDeliveryFeasibility(snapshot, 42, 0);
    expect(result.feasible).toBe(false);
    expect(result.reason).toContain('Cannot reach');
  });

  it('should return feasible when all conditions met', () => {
    // Bot at (1,1) with track to (1,2) which is Berlin
    const segments = [makeSegment(1, 1, TerrainType.Clear, 1, 2, TerrainType.MajorCity, 5)];
    const botTrack: PlayerTrackState = {
      playerId: 'bot-1',
      gameId: 'test-game',
      segments,
      totalCost: 5,
      turnBuildCost: 0,
      lastBuildTimestamp: new Date(),
    };
    const snapshot = makeSnapshot({
      demandCards: [demandCard],
      carriedLoads: [LoadType.Coal],
      trackSegments: segments,
      allPlayerTracks: [botTrack],
      mapPoints: [
        makeGridPoint(1, 1, TerrainType.Clear),
        makeGridPoint(1, 2, TerrainType.MajorCity, 'Berlin'),
      ],
    });
    const result = validateDeliveryFeasibility(snapshot, 42, 0);
    expect(result.feasible).toBe(true);
  });
});

describe('validatePickupFeasibility', () => {
  it('should return infeasible if bot has no position', () => {
    const snapshot = makeSnapshot({ position: null });
    const result = validatePickupFeasibility(snapshot, LoadType.Coal, 'Berlin');
    expect(result.feasible).toBe(false);
    expect(result.reason).toContain('no position');
  });

  it('should return infeasible if train at capacity', () => {
    const snapshot = makeSnapshot({
      trainType: TrainType.Freight,
      carriedLoads: [LoadType.Coal, LoadType.Wine], // 2 = Freight max
    });
    const result = validatePickupFeasibility(snapshot, LoadType.Oil, 'Berlin');
    expect(result.feasible).toBe(false);
    expect(result.reason).toContain('capacity');
  });

  it('should return infeasible if load not available at city', () => {
    const snapshot = makeSnapshot({
      loadAvailability: new Map([['Berlin', ['Wine']]]),
      mapPoints: [makeGridPoint(1, 1, TerrainType.Clear)],
    });
    const result = validatePickupFeasibility(snapshot, LoadType.Coal, 'Berlin');
    expect(result.feasible).toBe(false);
    expect(result.reason).toContain('not available');
  });

  it('should accept dropped loads at city', () => {
    const segments = [makeSegment(1, 1, TerrainType.Clear, 1, 2, TerrainType.MajorCity, 5)];
    const botTrack: PlayerTrackState = {
      playerId: 'bot-1',
      gameId: 'test-game',
      segments,
      totalCost: 5,
      turnBuildCost: 0,
      lastBuildTimestamp: new Date(),
    };
    const snapshot = makeSnapshot({
      loadAvailability: new Map(),
      droppedLoads: new Map([['Berlin', [LoadType.Coal]]]),
      trackSegments: segments,
      allPlayerTracks: [botTrack],
      mapPoints: [
        makeGridPoint(1, 1, TerrainType.Clear),
        makeGridPoint(1, 2, TerrainType.MajorCity, 'Berlin'),
      ],
    });
    const result = validatePickupFeasibility(snapshot, LoadType.Coal, 'Berlin');
    expect(result.feasible).toBe(true);
  });

  it('should return feasible when load available and city reachable', () => {
    const segments = [makeSegment(1, 1, TerrainType.Clear, 1, 2, TerrainType.MajorCity, 5)];
    const botTrack: PlayerTrackState = {
      playerId: 'bot-1',
      gameId: 'test-game',
      segments,
      totalCost: 5,
      turnBuildCost: 0,
      lastBuildTimestamp: new Date(),
    };
    const snapshot = makeSnapshot({
      loadAvailability: new Map([['Berlin', ['Coal']]]),
      trackSegments: segments,
      allPlayerTracks: [botTrack],
      mapPoints: [
        makeGridPoint(1, 1, TerrainType.Clear),
        makeGridPoint(1, 2, TerrainType.MajorCity, 'Berlin'),
      ],
    });
    const result = validatePickupFeasibility(snapshot, LoadType.Coal, 'Berlin');
    expect(result.feasible).toBe(true);
  });
});

describe('validateBuildTrackFeasibility', () => {
  it('should return infeasible for empty segments', () => {
    const snapshot = makeSnapshot();
    const result = validateBuildTrackFeasibility(snapshot, []);
    expect(result.feasible).toBe(false);
    expect(result.reason).toContain('No segments');
  });

  it('should return infeasible for invalid segment cost', () => {
    const snapshot = makeSnapshot();
    const seg = makeSegment(1, 1, TerrainType.Clear, 1, 2, TerrainType.Clear, 0);
    const result = validateBuildTrackFeasibility(snapshot, [seg]);
    expect(result.feasible).toBe(false);
    expect(result.reason).toContain('Invalid segment cost');
  });

  it('should return infeasible if exceeds turn budget', () => {
    const snapshot = makeSnapshot({ turnBuildCostSoFar: 15 });
    const seg = makeSegment(1, 1, TerrainType.Clear, 1, 2, TerrainType.Alpine, 10);
    const result = validateBuildTrackFeasibility(snapshot, [seg]);
    expect(result.feasible).toBe(false);
    expect(result.reason).toContain('turn budget');
  });

  it('should return infeasible if insufficient funds', () => {
    const snapshot = makeSnapshot({ money: 3 });
    const seg = makeSegment(1, 1, TerrainType.Clear, 1, 2, TerrainType.Alpine, 5);
    const result = validateBuildTrackFeasibility(snapshot, [seg]);
    expect(result.feasible).toBe(false);
    expect(result.reason).toContain('Insufficient funds');
  });

  it('should return feasible when within budget and funds', () => {
    const snapshot = makeSnapshot({ money: 20, turnBuildCostSoFar: 0 });
    const segments = [
      makeSegment(1, 1, TerrainType.Clear, 1, 2, TerrainType.Clear, 1),
      makeSegment(1, 2, TerrainType.Clear, 1, 3, TerrainType.Mountain, 2),
    ];
    const result = validateBuildTrackFeasibility(snapshot, segments);
    expect(result.feasible).toBe(true);
  });
});

describe('validateUpgradeFeasibility', () => {
  it('should return infeasible if already that train type', () => {
    const snapshot = makeSnapshot({ trainType: TrainType.Freight });
    const result = validateUpgradeFeasibility(snapshot, TrainType.Freight);
    expect(result.feasible).toBe(false);
    expect(result.reason).toContain('Already have');
  });

  it('should return infeasible for invalid upgrade path', () => {
    const snapshot = makeSnapshot({ trainType: TrainType.Freight });
    const result = validateUpgradeFeasibility(snapshot, TrainType.Superfreight);
    expect(result.feasible).toBe(false);
    expect(result.reason).toContain('No valid upgrade path');
  });

  it('should return infeasible if insufficient funds for upgrade', () => {
    const snapshot = makeSnapshot({ trainType: TrainType.Freight, money: 10 });
    const result = validateUpgradeFeasibility(snapshot, TrainType.FastFreight);
    expect(result.feasible).toBe(false);
    expect(result.reason).toContain('Insufficient funds');
  });

  it('should return infeasible if exceeds turn budget', () => {
    const snapshot = makeSnapshot({
      trainType: TrainType.Freight,
      money: 50,
      turnBuildCostSoFar: 5,
    });
    const result = validateUpgradeFeasibility(snapshot, TrainType.FastFreight);
    expect(result.feasible).toBe(false);
    expect(result.reason).toContain('turn budget');
  });

  it('should return feasible for valid Freight → FastFreight upgrade', () => {
    const snapshot = makeSnapshot({
      trainType: TrainType.Freight,
      money: 50,
      turnBuildCostSoFar: 0,
    });
    const result = validateUpgradeFeasibility(snapshot, TrainType.FastFreight);
    expect(result.feasible).toBe(true);
  });

  it('should return feasible for valid crossgrade FastFreight → HeavyFreight', () => {
    const snapshot = makeSnapshot({
      trainType: TrainType.FastFreight,
      money: 50,
      turnBuildCostSoFar: 0,
    });
    const result = validateUpgradeFeasibility(snapshot, TrainType.HeavyFreight);
    expect(result.feasible).toBe(true);
  });

  it('should return infeasible for Superfreight (no upgrades)', () => {
    const snapshot = makeSnapshot({
      trainType: TrainType.Superfreight,
      money: 50,
    });
    const result = validateUpgradeFeasibility(snapshot, TrainType.FastFreight);
    expect(result.feasible).toBe(false);
  });
});

describe('computeReachableCities', () => {
  it('should return empty if no position', () => {
    const snapshot = makeSnapshot({ position: null });
    const result = computeReachableCities(snapshot, 9);
    expect(result).toEqual([]);
  });

  it('should find cities within movement range on track', () => {
    // Build a simple track: (1,1) -> (1,2) where (1,2) is a city
    const segments = [makeSegment(1, 1, TerrainType.Clear, 1, 2, TerrainType.MajorCity, 5)];
    const botTrack: PlayerTrackState = {
      playerId: 'bot-1',
      gameId: 'test-game',
      segments,
      totalCost: 5,
      turnBuildCost: 0,
      lastBuildTimestamp: new Date(),
    };
    const snapshot = makeSnapshot({
      allPlayerTracks: [botTrack],
      mapPoints: [
        makeGridPoint(1, 1, TerrainType.Clear),
        makeGridPoint(1, 2, TerrainType.MajorCity, 'Berlin'),
      ],
    });
    const result = computeReachableCities(snapshot, 9);
    expect(result).toHaveLength(1);
    expect(result[0].cityName).toBe('Berlin');
    expect(result[0].distance).toBe(1);
  });

  it('should not find cities beyond movement range', () => {
    // Build a long track: (1,1) -> (1,2) -> (1,3) city at (1,3)
    const segments = [
      makeSegment(1, 1, TerrainType.Clear, 1, 2, TerrainType.Clear, 1),
      makeSegment(1, 2, TerrainType.Clear, 1, 3, TerrainType.MajorCity, 5),
    ];
    const botTrack: PlayerTrackState = {
      playerId: 'bot-1',
      gameId: 'test-game',
      segments,
      totalCost: 6,
      turnBuildCost: 0,
      lastBuildTimestamp: new Date(),
    };
    const snapshot = makeSnapshot({
      allPlayerTracks: [botTrack],
      mapPoints: [
        makeGridPoint(1, 1, TerrainType.Clear),
        makeGridPoint(1, 2, TerrainType.Clear),
        makeGridPoint(1, 3, TerrainType.MajorCity, 'Berlin'),
      ],
    });

    // Movement of 1 should not reach city at distance 2
    const result = computeReachableCities(snapshot, 1);
    expect(result).toHaveLength(0);
  });
});

describe('computeBuildSegments', () => {
  it('should return empty if target already in network', () => {
    const segments = [makeSegment(1, 1, TerrainType.Clear, 1, 2, TerrainType.Clear, 1)];
    const snapshot = makeSnapshot({
      trackSegments: segments,
      mapPoints: [
        makeGridPoint(1, 1, TerrainType.Clear),
        makeGridPoint(1, 2, TerrainType.Clear),
      ],
    });
    const result = computeBuildSegments(snapshot, 1, 2, 20);
    expect(result).toEqual([]);
  });

  it('should find a path to adjacent target within budget', () => {
    // Network at (1,1), target at (1,2)
    const segments = [makeSegment(0, 0, TerrainType.Clear, 1, 1, TerrainType.Clear, 1)];
    const snapshot = makeSnapshot({
      trackSegments: segments,
      mapPoints: [
        makeGridPoint(0, 0, TerrainType.Clear),
        makeGridPoint(1, 0, TerrainType.Clear),
        makeGridPoint(1, 1, TerrainType.Clear),
        makeGridPoint(1, 2, TerrainType.Clear),
      ],
    });
    const result = computeBuildSegments(snapshot, 1, 2, 20);
    expect(result.length).toBeGreaterThan(0);
    // The last segment should end at the target
    const lastSeg = result[result.length - 1];
    expect(lastSeg.to.row).toBe(1);
    expect(lastSeg.to.col).toBe(2);
  });

  it('should return empty if budget too small for path', () => {
    const segments = [makeSegment(0, 0, TerrainType.Clear, 1, 1, TerrainType.Clear, 1)];
    const snapshot = makeSnapshot({
      trackSegments: segments,
      mapPoints: [
        makeGridPoint(0, 0, TerrainType.Clear),
        makeGridPoint(1, 1, TerrainType.Clear),
        makeGridPoint(1, 2, TerrainType.Alpine), // Costs 5M
      ],
    });
    // Budget of 2 shouldn't reach an Alpine milepost costing 5
    const result = computeBuildSegments(snapshot, 1, 2, 2);
    expect(result).toEqual([]);
  });
});

describe('countConnectedMajorCities', () => {
  it('should return 0 for empty network', () => {
    const snapshot = makeSnapshot({ trackSegments: [] });
    const result = countConnectedMajorCities(snapshot);
    expect(result).toBe(0);
  });

  it('should count city when center is in network', () => {
    // TestCity center is at (5,5)
    const segments = [makeSegment(5, 4, TerrainType.Clear, 5, 5, TerrainType.MajorCity, 5)];
    const snapshot = makeSnapshot({ trackSegments: segments });
    const result = countConnectedMajorCities(snapshot);
    expect(result).toBe(1);
  });

  it('should count city when outpost is in network', () => {
    // TestCity outpost at (5,4)
    const segments = [makeSegment(5, 3, TerrainType.Clear, 5, 4, TerrainType.MajorCity, 5)];
    const snapshot = makeSnapshot({ trackSegments: segments });
    const result = countConnectedMajorCities(snapshot);
    expect(result).toBe(1);
  });

  it('should count multiple connected cities', () => {
    // TestCity center at (5,5), OtherCity center at (10,10)
    const segments = [
      makeSegment(5, 4, TerrainType.Clear, 5, 5, TerrainType.MajorCity, 5),
      makeSegment(10, 9, TerrainType.Clear, 10, 10, TerrainType.MajorCity, 5),
    ];
    const snapshot = makeSnapshot({ trackSegments: segments });
    const result = countConnectedMajorCities(snapshot);
    expect(result).toBe(2);
  });

  it('should not double-count a city when both center and outpost are in network', () => {
    // TestCity: center (5,5), outpost (5,4) — both connected
    const segments = [
      makeSegment(5, 3, TerrainType.Clear, 5, 4, TerrainType.MajorCity, 5),
      makeSegment(5, 4, TerrainType.MajorCity, 5, 5, TerrainType.MajorCity, 5),
    ];
    const snapshot = makeSnapshot({ trackSegments: segments });
    const result = countConnectedMajorCities(snapshot);
    expect(result).toBe(1);
  });
});

describe('VALID_UPGRADES', () => {
  it('should define upgrade paths from Freight', () => {
    const paths = VALID_UPGRADES[TrainType.Freight];
    expect(paths).toHaveLength(2);
    expect(paths.some((p) => p.targetTrainType === TrainType.FastFreight)).toBe(true);
    expect(paths.some((p) => p.targetTrainType === TrainType.HeavyFreight)).toBe(true);
    expect(paths.every((p) => p.kind === 'upgrade' && p.cost === 20)).toBe(true);
  });

  it('should define upgrade and crossgrade from FastFreight', () => {
    const paths = VALID_UPGRADES[TrainType.FastFreight];
    expect(paths).toHaveLength(2);
    const upgrade = paths.find((p) => p.kind === 'upgrade');
    const crossgrade = paths.find((p) => p.kind === 'crossgrade');
    expect(upgrade?.targetTrainType).toBe(TrainType.Superfreight);
    expect(upgrade?.cost).toBe(20);
    expect(crossgrade?.targetTrainType).toBe(TrainType.HeavyFreight);
    expect(crossgrade?.cost).toBe(5);
  });

  it('should have no upgrades from Superfreight', () => {
    expect(VALID_UPGRADES[TrainType.Superfreight]).toHaveLength(0);
  });
});

describe('TERRAIN_COSTS', () => {
  it('should define costs for all terrain types', () => {
    expect(TERRAIN_COSTS[TerrainType.Clear]).toBe(1);
    expect(TERRAIN_COSTS[TerrainType.Mountain]).toBe(2);
    expect(TERRAIN_COSTS[TerrainType.Alpine]).toBe(5);
    expect(TERRAIN_COSTS[TerrainType.SmallCity]).toBe(3);
    expect(TERRAIN_COSTS[TerrainType.MediumCity]).toBe(3);
    expect(TERRAIN_COSTS[TerrainType.MajorCity]).toBe(5);
  });
});
