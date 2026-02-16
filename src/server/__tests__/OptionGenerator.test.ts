import { OptionGenerator } from '../services/ai/OptionGenerator';
import { WorldSnapshot, AIActionType, TrackSegment, TerrainType, TrainType, TRACK_USAGE_FEE, BotMemoryState } from '../../shared/types/GameTypes';
import { computeBuildSegments } from '../services/ai/computeBuildSegments';
import { getMajorCityGroups } from '../../shared/services/majorCityGroups';
import { buildUnionTrackGraph } from '../../shared/services/trackUsageFees';
import { DemandDeckService } from '../services/demandDeckService';

// Mock computeBuildSegments so we control what segments come back
jest.mock('../services/ai/computeBuildSegments');
jest.mock('../../shared/services/trackUsageFees');
jest.mock('../services/demandDeckService');
jest.mock('../services/ai/MapTopology', () => ({
  loadGridPoints: jest.fn(() => new Map()),
  getHexNeighbors: jest.fn(() => []),
  getTerrainCost: jest.fn(() => 1),
  gridToPixel: jest.fn(() => ({ x: 0, y: 0 })),
  _resetCache: jest.fn(),
}));

const mockComputeBuild = computeBuildSegments as jest.Mock;

function makeSegment(fromRow: number, fromCol: number, toRow: number, toCol: number, cost: number): TrackSegment {
  return {
    from: { x: 0, y: 0, row: fromRow, col: fromCol, terrain: TerrainType.Clear },
    to: { x: 0, y: 0, row: toRow, col: toCol, terrain: TerrainType.Clear },
    cost,
  };
}

function makeSnapshot(overrides?: Partial<WorldSnapshot>): WorldSnapshot {
  return {
    gameId: 'game-1',
    gameStatus: 'active',
    turnNumber: 1,
    bot: {
      playerId: 'bot-1',
      userId: 'user-bot-1',
      money: 50,
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
    ...overrides,
  };
}

describe('OptionGenerator', () => {
  afterEach(() => jest.clearAllMocks());

  describe('generate', () => {
    it('should always include a PassTurn option', () => {
      mockComputeBuild.mockReturnValue([]);
      const options = OptionGenerator.generate(makeSnapshot());
      const passTurn = options.find((o) => o.action === AIActionType.PassTurn);
      expect(passTurn).toBeDefined();
      expect(passTurn!.feasible).toBe(true);
    });

    it('should include BuildTrack option when segments are available', () => {
      const seg = makeSegment(29, 32, 29, 31, 1);
      mockComputeBuild.mockReturnValue([seg]);

      const options = OptionGenerator.generate(makeSnapshot());
      const buildTrack = options.find(
        (o) => o.action === AIActionType.BuildTrack && o.feasible,
      );
      expect(buildTrack).toBeDefined();
      expect(buildTrack!.segments).toHaveLength(1);
      expect(buildTrack!.estimatedCost).toBe(1);
    });

    it('should return infeasible BuildTrack when no segments found', () => {
      mockComputeBuild.mockReturnValue([]);
      const options = OptionGenerator.generate(makeSnapshot());
      const buildTrack = options.find((o) => o.action === AIActionType.BuildTrack);
      expect(buildTrack).toBeDefined();
      expect(buildTrack!.feasible).toBe(false);
    });

    it('should return infeasible BuildTrack when bot has no money', () => {
      const snapshot = makeSnapshot({
        bot: {
          ...makeSnapshot().bot,
          money: 0,
        },
      });
      const options = OptionGenerator.generate(snapshot);
      const buildTrack = options.find((o) => o.action === AIActionType.BuildTrack);
      expect(buildTrack).toBeDefined();
      expect(buildTrack!.feasible).toBe(false);
      expect(buildTrack!.reason).toContain('No money');
    });
  });

  describe('start positions', () => {
    it('should use major city outposts when bot has no track', () => {
      mockComputeBuild.mockReturnValue([]);
      const snapshot = makeSnapshot();

      OptionGenerator.generate(snapshot);

      // computeBuildSegments should have been called with major city outpost positions
      expect(mockComputeBuild).toHaveBeenCalledTimes(1);
      const [startPositions] = mockComputeBuild.mock.calls[0];
      // Should have many positions (outposts from all major cities)
      expect(startPositions.length).toBeGreaterThan(0);
    });

    it('should use existing track endpoints when bot has track', () => {
      const existingSeg = makeSegment(29, 32, 29, 31, 1);
      mockComputeBuild.mockReturnValue([]);

      const snapshot = makeSnapshot({
        bot: {
          ...makeSnapshot().bot,
          existingSegments: [existingSeg],
        },
      });

      OptionGenerator.generate(snapshot);

      expect(mockComputeBuild).toHaveBeenCalledTimes(1);
      const [startPositions] = mockComputeBuild.mock.calls[0];
      expect(startPositions).toEqual([
        { row: 29, col: 32 },
        { row: 29, col: 31 },
      ]);
    });
  });

  describe('budget', () => {
    it('should cap budget at 20M even if bot has more money', () => {
      mockComputeBuild.mockReturnValue([]);
      OptionGenerator.generate(makeSnapshot({ bot: { ...makeSnapshot().bot, money: 100 } }));

      const [, , budget] = mockComputeBuild.mock.calls[0];
      expect(budget).toBe(20);
    });

    it('should use bot money as budget when less than 20M', () => {
      mockComputeBuild.mockReturnValue([]);
      OptionGenerator.generate(makeSnapshot({ bot: { ...makeSnapshot().bot, money: 8 } }));

      const [, , budget] = mockComputeBuild.mock.calls[0];
      expect(budget).toBe(8);
    });
  });

  describe('estimatedCost', () => {
    it('should sum segment costs for estimatedCost', () => {
      const segs = [
        makeSegment(29, 32, 29, 31, 1),
        makeSegment(29, 31, 28, 31, 2),
      ];
      mockComputeBuild.mockReturnValue(segs);

      const options = OptionGenerator.generate(makeSnapshot());
      const buildTrack = options.find(
        (o) => o.action === AIActionType.BuildTrack && o.feasible,
      );
      expect(buildTrack!.estimatedCost).toBe(3);
    });
  });
});

/* ────────────────────────────────────────────────────────────────────────
 * TEST-001: OptionGenerator.generateMoveOptions
 * ──────────────────────────────────────────────────────────────────────── */

const mockBuildUnionGraph = buildUnionTrackGraph as jest.Mock;
const mockDemandDeck = DemandDeckService.getInstance as jest.Mock;

function makeActiveSnapshot(overrides?: Partial<WorldSnapshot['bot']>, topOverrides?: Partial<WorldSnapshot>): WorldSnapshot {
  return {
    gameId: 'game-1',
    gameStatus: 'active',
    turnNumber: 5,
    bot: {
      playerId: 'bot-1',
      userId: 'user-bot-1',
      money: 50,
      position: { row: 10, col: 10 },
      existingSegments: [makeSegment(10, 10, 11, 10, 1)],
      demandCards: [42],
      resolvedDemands: [],
      trainType: TrainType.Freight,
      loads: [],
      botConfig: null,
      connectedMajorCityCount: 0,
      ...overrides,
    },
    allPlayerTracks: [
      { playerId: 'bot-1', segments: [makeSegment(10, 10, 11, 10, 1), makeSegment(11, 10, 12, 10, 1)] },
    ],
    loadAvailability: {},
    ...topOverrides,
  };
}

function setupMockGraph(adjacencyMap: Record<string, string[]>, edgeOwnerMap?: Record<string, string[]>): void {
  const adjacency = new Map<string, Set<string>>();
  for (const [key, neighbors] of Object.entries(adjacencyMap)) {
    adjacency.set(key, new Set(neighbors));
  }
  const edgeOwners = new Map<string, Set<string>>();
  if (edgeOwnerMap) {
    for (const [key, owners] of Object.entries(edgeOwnerMap)) {
      edgeOwners.set(key, new Set(owners));
    }
  }
  mockBuildUnionGraph.mockReturnValue({ adjacency, edgeOwners });
}

function setupMockDemandDeck(cards: Array<{ id: number; demands: Array<{ city: string; payment: number; resource: string }> }>): void {
  const mockInstance = {
    getCard: jest.fn((id: number) => cards.find(c => c.id === id)),
  };
  mockDemandDeck.mockReturnValue(mockInstance);
}

describe('OptionGenerator — generateMoveOptions', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockComputeBuild.mockReturnValue([]);
  });

  it('should return feasible MoveTrain option when demand city is reachable', () => {
    // Graph: 10,10 → 11,10 → 12,10 (Berlin at 12,10)
    setupMockGraph({
      '10,10': ['11,10'],
      '11,10': ['10,10', '12,10'],
      '12,10': ['11,10'],
    });
    setupMockDemandDeck([
      { id: 42, demands: [{ city: 'Berlin', payment: 10, resource: 'Coal' }] },
    ]);
    // Make loadGridPoints return Berlin at 12,10
    const { loadGridPoints } = require('../services/ai/MapTopology');
    (loadGridPoints as jest.Mock).mockReturnValue(new Map([
      ['12,10', { row: 12, col: 10, terrain: TerrainType.MediumCity, name: 'Berlin' }],
    ]));

    const snapshot = makeActiveSnapshot();
    const options = OptionGenerator.generate(snapshot);
    const moveOptions = options.filter(o => o.action === AIActionType.MoveTrain && o.feasible);

    expect(moveOptions.length).toBeGreaterThanOrEqual(1);
    expect(moveOptions[0].movementPath).toBeDefined();
    expect(moveOptions[0].targetCity).toBe('Berlin');
    expect(moveOptions[0].mileposts).toBe(2); // 10,10 → 11,10 → 12,10
  });

  it('should use frontier fallback when demand city is not reachable via track', () => {
    // Berlin at 20,10 is not connected to the track graph at all
    // Bot at 10,10 has track to 11,10 — frontier fallback should move toward Berlin
    setupMockGraph({
      '10,10': ['11,10'],
      '11,10': ['10,10'],
      // Berlin at 20,10 is disconnected — no track path exists
    });
    setupMockDemandDeck([
      { id: 42, demands: [{ city: 'Berlin', payment: 10, resource: 'Coal' }] },
    ]);
    const { loadGridPoints } = require('../services/ai/MapTopology');
    (loadGridPoints as jest.Mock).mockReturnValue(new Map([
      ['20,10', { row: 20, col: 10, terrain: TerrainType.MediumCity, name: 'Berlin' }],
    ]));

    const snapshot = makeActiveSnapshot();
    const options = OptionGenerator.generate(snapshot);
    const moveOptions = options.filter(o => o.action === AIActionType.MoveTrain && o.feasible);

    // Frontier fallback: 11,10 is closer to Berlin (20,10) than start 10,10
    expect(moveOptions).toHaveLength(1);
    expect(moveOptions[0].targetCity).toBe('Berlin');
    expect(moveOptions[0].mileposts).toBe(1); // 10,10 → 11,10
    expect(moveOptions[0].reason).toContain('frontier');
  });

  it('should return infeasible when no reachable node is closer to demand city than start', () => {
    // Berlin at 5,10 — bot is at 10,10, only reachable node is 11,10 which is farther away
    setupMockGraph({
      '10,10': ['11,10'],
      '11,10': ['10,10'],
    });
    setupMockDemandDeck([
      { id: 42, demands: [{ city: 'Berlin', payment: 10, resource: 'Coal' }] },
    ]);
    const { loadGridPoints } = require('../services/ai/MapTopology');
    (loadGridPoints as jest.Mock).mockReturnValue(new Map([
      ['5,10', { row: 5, col: 10, terrain: TerrainType.MediumCity, name: 'Berlin' }],
    ]));

    const snapshot = makeActiveSnapshot();
    const options = OptionGenerator.generate(snapshot);
    const moveOptions = options.filter(o => o.action === AIActionType.MoveTrain && o.feasible);

    // 11,10 is farther from Berlin (5,10) than 10,10, so no frontier improvement
    expect(moveOptions).toHaveLength(0);
  });

  it('should not generate move options during initialBuild phase', () => {
    setupMockGraph({ '10,10': ['11,10'] });
    setupMockDemandDeck([
      { id: 42, demands: [{ city: 'Berlin', payment: 10, resource: 'Coal' }] },
    ]);

    const snapshot = makeActiveSnapshot({}, { gameStatus: 'initialBuild' as any });
    const options = OptionGenerator.generate(snapshot);
    const moveOptions = options.filter(o => o.action === AIActionType.MoveTrain);

    expect(moveOptions).toHaveLength(0);
  });

  it('should not generate move options when bot has no position', () => {
    setupMockGraph({ '10,10': ['11,10'] });
    setupMockDemandDeck([
      { id: 42, demands: [{ city: 'Berlin', payment: 10, resource: 'Coal' }] },
    ]);

    const snapshot = makeActiveSnapshot({ position: null });
    const options = OptionGenerator.generate(snapshot);
    const moveOptions = options.filter(o => o.action === AIActionType.MoveTrain);

    expect(moveOptions).toHaveLength(0);
  });

  it('should truncate path to speed limit for demand city beyond max speed', () => {
    // Create a long chain: 10,10 → 11,10 → 12,10 → ... → 20,10
    // Freight speed = 9, so path of length 10 should be truncated to 9 mileposts
    const adjacencyMap: Record<string, string[]> = {};
    for (let r = 10; r < 20; r++) {
      const key = `${r},10`;
      const nextKey = `${r + 1},10`;
      adjacencyMap[key] = adjacencyMap[key] || [];
      adjacencyMap[nextKey] = adjacencyMap[nextKey] || [];
      adjacencyMap[key].push(nextKey);
      adjacencyMap[nextKey].push(key);
    }
    setupMockGraph(adjacencyMap);
    // Berlin at 20,10 — 10 mileposts away, beyond Freight speed of 9
    setupMockDemandDeck([
      { id: 42, demands: [{ city: 'Berlin', payment: 10, resource: 'Coal' }] },
    ]);
    const { loadGridPoints } = require('../services/ai/MapTopology');
    (loadGridPoints as jest.Mock).mockReturnValue(new Map([
      ['20,10', { row: 20, col: 10, terrain: TerrainType.MediumCity, name: 'Berlin' }],
    ]));

    const snapshot = makeActiveSnapshot({ trainType: TrainType.Freight });
    const options = OptionGenerator.generate(snapshot);
    const moveOptions = options.filter(o => o.action === AIActionType.MoveTrain && o.feasible);

    // Berlin is 10 mileposts away but reachable via track — bot moves 9 mileposts toward it
    expect(moveOptions).toHaveLength(1);
    expect(moveOptions[0].mileposts).toBe(9);
    expect(moveOptions[0].movementPath).toHaveLength(10); // start + 9 steps
    expect(moveOptions[0].targetCity).toBe('Berlin');
    // Target position is the demand city, even though we won't arrive this turn
    expect(moveOptions[0].targetPosition).toEqual({ row: 20, col: 10 });
  });

  it('should exclude current city from move targets', () => {
    // Bot is at Berlin (12,10) — should not generate a move to Berlin
    setupMockGraph({
      '12,10': ['11,10'],
      '11,10': ['12,10', '10,10'],
      '10,10': ['11,10'],
    });
    setupMockDemandDeck([
      { id: 42, demands: [{ city: 'Berlin', payment: 10, resource: 'Coal' }] },
    ]);
    const { loadGridPoints } = require('../services/ai/MapTopology');
    (loadGridPoints as jest.Mock).mockReturnValue(new Map([
      ['12,10', { row: 12, col: 10, terrain: TerrainType.MediumCity, name: 'Berlin' }],
    ]));

    const snapshot = makeActiveSnapshot({ position: { row: 12, col: 10 } });
    const options = OptionGenerator.generate(snapshot);
    const moveOptions = options.filter(o => o.action === AIActionType.MoveTrain && o.feasible);

    // Berlin is the current city — no move option should target it
    expect(moveOptions).toHaveLength(0);
  });

  it('should estimate track usage fees from opponent edges', () => {
    setupMockGraph(
      {
        '10,10': ['11,10'],
        '11,10': ['10,10', '12,10'],
        '12,10': ['11,10'],
      },
      {
        // Player-2 owns the edge 11,10 → 12,10
        '11,10|12,10': ['player-2'],
      },
    );
    setupMockDemandDeck([
      { id: 42, demands: [{ city: 'Berlin', payment: 10, resource: 'Coal' }] },
    ]);
    const { loadGridPoints } = require('../services/ai/MapTopology');
    (loadGridPoints as jest.Mock).mockReturnValue(new Map([
      ['12,10', { row: 12, col: 10, terrain: TerrainType.MediumCity, name: 'Berlin' }],
    ]));

    const snapshot = makeActiveSnapshot();
    const options = OptionGenerator.generate(snapshot);
    const moveOptions = options.filter(o => o.action === AIActionType.MoveTrain && o.feasible);

    expect(moveOptions.length).toBeGreaterThanOrEqual(1);
    expect(moveOptions[0].estimatedCost).toBe(TRACK_USAGE_FEE); // 4M for 1 opponent
  });

  it('should generate frontier options for unreached targets even when some targets are reached', () => {
    // Graph: 10,10 → 11,10 → 12,10 (Berlin at 12,10 — reachable)
    // Paris at 20,20 — NOT reachable via track
    // Bot should get BFS option for Berlin AND frontier option for Paris
    setupMockGraph({
      '10,10': ['11,10'],
      '11,10': ['10,10', '12,10'],
      '12,10': ['11,10'],
    });
    setupMockDemandDeck([
      { id: 42, demands: [
        { city: 'Berlin', payment: 10, resource: 'Coal' },
        { city: 'Paris', payment: 15, resource: 'Wine' },
      ] },
    ]);
    const { loadGridPoints } = require('../services/ai/MapTopology');
    (loadGridPoints as jest.Mock).mockReturnValue(new Map([
      ['12,10', { row: 12, col: 10, terrain: TerrainType.MediumCity, name: 'Berlin' }],
      ['20,20', { row: 20, col: 20, terrain: TerrainType.MediumCity, name: 'Paris' }],
    ]));

    const snapshot = makeActiveSnapshot();
    const options = OptionGenerator.generate(snapshot);
    const moveOptions = options.filter(o => o.action === AIActionType.MoveTrain && o.feasible);

    // Should have Berlin (BFS direct) + Paris (frontier fallback)
    expect(moveOptions.length).toBeGreaterThanOrEqual(2);
    const berlinOpt = moveOptions.find(o => o.targetCity === 'Berlin');
    const parisOpt = moveOptions.find(o => o.targetCity === 'Paris');
    expect(berlinOpt).toBeDefined();
    expect(berlinOpt!.reason).not.toContain('frontier');
    expect(parisOpt).toBeDefined();
    expect(parisOpt!.reason).toContain('frontier');
  });

  it('should truncate movement path at ferry port (bot stops at port, crosses next turn)', () => {
    // Graph: 21,33 → 22,33 (Dover) → 23,33 (Calais) → 24,33
    // Dover→Calais is a real ferry route — BFS finds FarCity across the ferry,
    // but movement path is truncated at Dover (ferry port).
    setupMockGraph({
      '21,33': ['22,33'],
      '22,33': ['21,33', '23,33'],
      '23,33': ['22,33', '24,33'],
      '24,33': ['23,33'],
    });
    setupMockDemandDeck([
      { id: 42, demands: [{ city: 'FarCity', payment: 10, resource: 'Coal' }] },
    ]);
    const { loadGridPoints } = require('../services/ai/MapTopology');
    (loadGridPoints as jest.Mock).mockReturnValue(new Map([
      ['24,33', { row: 24, col: 33, terrain: TerrainType.MediumCity, name: 'FarCity' }],
    ]));

    const snapshot = makeActiveSnapshot({ position: { row: 21, col: 33 } });
    const options = OptionGenerator.generate(snapshot);
    const moveOptions = options.filter(o => o.action === AIActionType.MoveTrain && o.feasible);

    // BFS finds FarCity across the ferry — direct hit, not frontier.
    expect(moveOptions).toHaveLength(1);
    expect(moveOptions[0].targetCity).toBe('FarCity');
    expect(moveOptions[0].reason).not.toContain('frontier');
    // Movement path should stop at Dover (22,33), not cross to Calais
    const endPoint = moveOptions[0].movementPath![moveOptions[0].movementPath!.length - 1];
    expect(endPoint).toEqual({ row: 22, col: 33 });
    expect(moveOptions[0].mileposts).toBe(1); // 21,33 → 22,33
  });

  it('should halve movement speed when ferryHalfSpeed is set', () => {
    // Create a 10-node chain: 10,10 → 11,10 → ... → 19,10
    const adjacencyMap: Record<string, string[]> = {};
    for (let r = 10; r < 19; r++) {
      const key = `${r},10`;
      const nextKey = `${r + 1},10`;
      adjacencyMap[key] = adjacencyMap[key] || [];
      adjacencyMap[nextKey] = adjacencyMap[nextKey] || [];
      adjacencyMap[key].push(nextKey);
      adjacencyMap[nextKey].push(key);
    }
    setupMockGraph(adjacencyMap);
    setupMockDemandDeck([
      { id: 42, demands: [{ city: 'Berlin', payment: 10, resource: 'Coal' }] },
    ]);
    const { loadGridPoints } = require('../services/ai/MapTopology');
    (loadGridPoints as jest.Mock).mockReturnValue(new Map([
      ['19,10', { row: 19, col: 10, terrain: TerrainType.MediumCity, name: 'Berlin' }],
    ]));

    // Freight speed = 9, half = ceil(9/2) = 5
    const snapshot = makeActiveSnapshot({ trainType: TrainType.Freight });
    snapshot.bot.ferryHalfSpeed = true;
    const options = OptionGenerator.generate(snapshot);
    const moveOptions = options.filter(o => o.action === AIActionType.MoveTrain && o.feasible);

    expect(moveOptions).toHaveLength(1);
    expect(moveOptions[0].mileposts).toBe(5); // half of 9, rounded up
    expect(moveOptions[0].movementPath).toHaveLength(6); // start + 5 steps
  });
});

/* ────────────────────────────────────────────────────────────────────────
 * TEST-001: OptionGenerator.generatePickupOptions / generateDeliveryOptions
 * ──────────────────────────────────────────────────────────────────────── */

import { LoadType } from '../../shared/types/LoadTypes';

describe('OptionGenerator — generatePickupOptions', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockComputeBuild.mockReturnValue([]);
    setupMockGraph({});
    setupMockDemandDeck([]);
  });

  it('should generate pickup option when load is available at current city and demand matches', () => {
    const { loadGridPoints } = require('../services/ai/MapTopology');
    (loadGridPoints as jest.Mock).mockReturnValue(new Map([
      ['10,10', { row: 10, col: 10, terrain: TerrainType.MediumCity, name: 'Hamburg' }],
      ['11,10', { row: 11, col: 10, terrain: TerrainType.MajorCity, name: 'Berlin' }],
    ]));

    const snapshot = makeActiveSnapshot(
      {
        position: { row: 10, col: 10 },
        loads: [],
        existingSegments: [makeSegment(10, 10, 11, 10, 1)],
        resolvedDemands: [
          { cardId: 42, demands: [{ city: 'Berlin', loadType: 'Coal', payment: 10 }] },
        ],
      },
      { loadAvailability: { Hamburg: ['Coal'] } },
    );

    const options = OptionGenerator.generate(snapshot);
    const pickups = options.filter(o => o.action === AIActionType.PickupLoad && o.feasible);

    expect(pickups.length).toBeGreaterThanOrEqual(1);
    expect(pickups[0].loadType).toBe('Coal');
    expect(pickups[0].payment).toBe(10);
    expect(pickups[0].cardId).toBe(42);
  });

  it('should not generate pickup when train is at full capacity', () => {
    const { loadGridPoints } = require('../services/ai/MapTopology');
    (loadGridPoints as jest.Mock).mockReturnValue(new Map([
      ['10,10', { row: 10, col: 10, terrain: TerrainType.MediumCity, name: 'Hamburg' }],
    ]));

    const snapshot = makeActiveSnapshot(
      {
        position: { row: 10, col: 10 },
        loads: ['Coal', 'Wine'], // Freight capacity = 2
        trainType: TrainType.Freight,
        resolvedDemands: [
          { cardId: 42, demands: [{ city: 'Berlin', loadType: 'Iron', payment: 8 }] },
        ],
      },
      { loadAvailability: { Hamburg: ['Iron'] } },
    );

    const options = OptionGenerator.generate(snapshot);
    const pickups = options.filter(o => o.action === AIActionType.PickupLoad && o.feasible);

    expect(pickups).toHaveLength(0);
  });

  it('should not generate pickup when not at a city', () => {
    const { loadGridPoints } = require('../services/ai/MapTopology');
    (loadGridPoints as jest.Mock).mockReturnValue(new Map([
      ['10,10', { row: 10, col: 10, terrain: TerrainType.Clear }], // no name = not a city
    ]));

    const snapshot = makeActiveSnapshot(
      { position: { row: 10, col: 10 }, loads: [] },
      { loadAvailability: {} },
    );

    const options = OptionGenerator.generate(snapshot);
    const pickups = options.filter(o => o.action === AIActionType.PickupLoad && o.feasible);

    expect(pickups).toHaveLength(0);
  });

  it('should NOT generate speculative pickup when no demand matches (P5 fix)', () => {
    const { loadGridPoints } = require('../services/ai/MapTopology');
    (loadGridPoints as jest.Mock).mockReturnValue(new Map([
      ['10,10', { row: 10, col: 10, terrain: TerrainType.MediumCity, name: 'Hamburg' }],
    ]));

    const snapshot = makeActiveSnapshot(
      {
        position: { row: 10, col: 10 },
        loads: [],
        resolvedDemands: [], // no demands at all
      },
      { loadAvailability: { Hamburg: ['Coal'] } },
    );

    const options = OptionGenerator.generate(snapshot);
    const pickups = options.filter(o => o.action === AIActionType.PickupLoad && o.feasible);

    // P5 fix: speculative pickups (no matching demand) are no longer generated
    expect(pickups).toHaveLength(0);
  });

  it('should not generate pickup during initialBuild phase', () => {
    const { loadGridPoints } = require('../services/ai/MapTopology');
    (loadGridPoints as jest.Mock).mockReturnValue(new Map([
      ['10,10', { row: 10, col: 10, terrain: TerrainType.MediumCity, name: 'Hamburg' }],
    ]));

    const snapshot = makeActiveSnapshot(
      { position: { row: 10, col: 10 }, loads: [] },
      { gameStatus: 'initialBuild' as any, loadAvailability: { Hamburg: ['Coal'] } },
    );

    const options = OptionGenerator.generate(snapshot);
    const pickups = options.filter(o => o.action === AIActionType.PickupLoad);

    expect(pickups).toHaveLength(0);
  });
});

describe('OptionGenerator — generateDeliveryOptions', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockComputeBuild.mockReturnValue([]);
    setupMockGraph({});
    setupMockDemandDeck([]);
  });

  it('should generate delivery option when carrying a load demanded at current city', () => {
    const { loadGridPoints } = require('../services/ai/MapTopology');
    (loadGridPoints as jest.Mock).mockReturnValue(new Map([
      ['10,10', { row: 10, col: 10, terrain: TerrainType.MediumCity, name: 'Berlin' }],
    ]));

    const snapshot = makeActiveSnapshot(
      {
        position: { row: 10, col: 10 },
        loads: ['Coal'],
        resolvedDemands: [
          { cardId: 42, demands: [{ city: 'Berlin', loadType: 'Coal', payment: 10 }] },
        ],
      },
    );

    const options = OptionGenerator.generate(snapshot);
    const deliveries = options.filter(o => o.action === AIActionType.DeliverLoad && o.feasible);

    expect(deliveries.length).toBeGreaterThanOrEqual(1);
    expect(deliveries[0].loadType).toBe('Coal');
    expect(deliveries[0].targetCity).toBe('Berlin');
    expect(deliveries[0].payment).toBe(10);
    expect(deliveries[0].cardId).toBe(42);
  });

  it('should not generate delivery when not carrying any loads', () => {
    const { loadGridPoints } = require('../services/ai/MapTopology');
    (loadGridPoints as jest.Mock).mockReturnValue(new Map([
      ['10,10', { row: 10, col: 10, terrain: TerrainType.MediumCity, name: 'Berlin' }],
    ]));

    const snapshot = makeActiveSnapshot(
      {
        position: { row: 10, col: 10 },
        loads: [], // no loads
        resolvedDemands: [
          { cardId: 42, demands: [{ city: 'Berlin', loadType: 'Coal', payment: 10 }] },
        ],
      },
    );

    const options = OptionGenerator.generate(snapshot);
    const deliveries = options.filter(o => o.action === AIActionType.DeliverLoad && o.feasible);

    expect(deliveries).toHaveLength(0);
  });

  it('should not generate delivery when demand does not match current city', () => {
    const { loadGridPoints } = require('../services/ai/MapTopology');
    (loadGridPoints as jest.Mock).mockReturnValue(new Map([
      ['10,10', { row: 10, col: 10, terrain: TerrainType.MediumCity, name: 'Hamburg' }],
    ]));

    const snapshot = makeActiveSnapshot(
      {
        position: { row: 10, col: 10 },
        loads: ['Coal'],
        resolvedDemands: [
          { cardId: 42, demands: [{ city: 'Berlin', loadType: 'Coal', payment: 10 }] }, // demand is for Berlin, not Hamburg
        ],
      },
    );

    const options = OptionGenerator.generate(snapshot);
    const deliveries = options.filter(o => o.action === AIActionType.DeliverLoad && o.feasible);

    expect(deliveries).toHaveLength(0);
  });

  it('should pick highest payment when multiple demands match same card', () => {
    const { loadGridPoints } = require('../services/ai/MapTopology');
    (loadGridPoints as jest.Mock).mockReturnValue(new Map([
      ['10,10', { row: 10, col: 10, terrain: TerrainType.MediumCity, name: 'Berlin' }],
    ]));

    const snapshot = makeActiveSnapshot(
      {
        position: { row: 10, col: 10 },
        loads: ['Coal', 'Wine'],
        resolvedDemands: [
          {
            cardId: 42,
            demands: [
              { city: 'Berlin', loadType: 'Coal', payment: 5 },
              { city: 'Berlin', loadType: 'Wine', payment: 12 },
            ],
          },
        ],
      },
    );

    const options = OptionGenerator.generate(snapshot);
    const deliveries = options.filter(o => o.action === AIActionType.DeliverLoad && o.feasible);

    // Should pick Wine (payment 12) over Coal (payment 5) for card 42
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0].loadType).toBe('Wine');
    expect(deliveries[0].payment).toBe(12);
  });
});

describe('OptionGenerator — sticky build target', () => {
  const { loadGridPoints } = require('../services/ai/MapTopology');

  function makeGridMap(): Map<string, { row: number; col: number; name: string; terrain: number }> {
    const map = new Map();
    map.set('10,10', { row: 10, col: 10, name: 'Berlin', terrain: TerrainType.MajorCity });
    map.set('20,20', { row: 20, col: 20, name: 'Paris', terrain: TerrainType.MajorCity });
    map.set('30,30', { row: 30, col: 30, name: 'Hamburg', terrain: TerrainType.MediumCity });
    return map;
  }

  function makeStickySnapshot(overrides?: Partial<WorldSnapshot>): WorldSnapshot {
    return {
      gameId: 'game-1',
      gameStatus: 'active',
      turnNumber: 5,
      bot: {
        playerId: 'bot-1',
        userId: 'user-bot-1',
        money: 50,
        position: { row: 5, col: 5 },
        existingSegments: [makeSegment(5, 5, 6, 5, 1)],
        demandCards: [42, 43],
        resolvedDemands: [
          {
            cardId: 42,
            demands: [{ city: 'Berlin', loadType: 'Coal', payment: 10 }],
          },
          {
            cardId: 43,
            demands: [{ city: 'Paris', loadType: 'Wine', payment: 12 }],
          },
        ],
        trainType: 'Freight',
        loads: [],
        botConfig: null,
        connectedMajorCityCount: 0,
      },
      allPlayerTracks: [],
      loadAvailability: {
        'Hamburg': ['Coal'],
        'Paris': ['Wine'],
      },
      ...overrides,
    };
  }

  function defaultMemory(overrides?: Partial<BotMemoryState>): BotMemoryState {
    return {
      currentBuildTarget: null,
      turnsOnTarget: 0,
      lastAction: null,
      consecutivePassTurns: 0,
      deliveryCount: 0,
      totalEarnings: 0,
      turnNumber: 0,
      ...overrides,
    };
  }

  function setupBuildMock(): void {
    let callCount = 0;
    mockComputeBuild.mockImplementation(() => {
      callCount++;
      // Return unique segments per call to avoid dedup in generateBuildTrackOptions
      return [makeSegment(5, 5, 5 + callCount, 5 + callCount, 1)];
    });
  }

  beforeEach(() => {
    loadGridPoints.mockReturnValue(makeGridMap());
    // Mock DemandDeckService for extractBuildTargets
    setupMockDemandDeck([
      { id: 42, demands: [{ city: 'Berlin', payment: 10, resource: 'Coal' }] },
      { id: 43, demands: [{ city: 'Paris', payment: 12, resource: 'Wine' }] },
    ]);
    setupBuildMock();
  });

  afterEach(() => jest.clearAllMocks());

  it('should apply loyalty bonus when currentBuildTarget matches a chain delivery city', () => {
    const snapshot = makeStickySnapshot();
    const buildOnly = new Set([AIActionType.BuildTrack, AIActionType.PassTurn]);

    // Without memory — natural chain ordering (Berlin chainScore = 0.14)
    const optionsNoMemory = OptionGenerator.generate(snapshot, buildOnly);
    const buildsNoMemory = optionsNoMemory.filter(o => o.action === AIActionType.BuildTrack && o.feasible);
    const berlinNoMemory = buildsNoMemory.find(b => b.reason?.includes('Berlin'));

    // Reset mock for fresh call count
    setupBuildMock();

    // With memory targeting Berlin — loyalty bonus applies (Berlin chainScore = 0.14 * 1.5 = 0.21)
    const memoryBerlin = defaultMemory({ currentBuildTarget: 'Berlin', turnsOnTarget: 1 });
    const optionsWithMemory = OptionGenerator.generate(snapshot, buildOnly, memoryBerlin);
    const buildsWithMemory = optionsWithMemory.filter(o => o.action === AIActionType.BuildTrack && o.feasible);
    const berlinWithMemory = buildsWithMemory.find(b => b.reason?.includes('Berlin'));

    // Both should produce build options
    expect(buildsNoMemory.length).toBeGreaterThan(0);
    expect(buildsWithMemory.length).toBeGreaterThan(0);

    // Berlin chain should exist in both
    expect(berlinNoMemory).toBeDefined();
    expect(berlinWithMemory).toBeDefined();

    // With loyalty bonus, Berlin's chainScore should be 1.5x higher
    expect(berlinWithMemory!.chainScore).toBeCloseTo(berlinNoMemory!.chainScore! * 1.5, 2);
  });

  it('should NOT apply loyalty bonus when target is stale (>= 5 turns)', () => {
    const snapshot = makeStickySnapshot();
    const buildOnly = new Set([AIActionType.BuildTrack, AIActionType.PassTurn]);

    // Fresh target — loyalty bonus applies
    const freshMemory = defaultMemory({ currentBuildTarget: 'Berlin', turnsOnTarget: 2 });
    const freshOptions = OptionGenerator.generate(snapshot, buildOnly, freshMemory);
    const freshBuilds = freshOptions.filter(o => o.action === AIActionType.BuildTrack && o.feasible);
    const freshBerlin = freshBuilds.find(b => b.reason?.includes('Berlin'));

    // Reset mock for fresh call count
    setupBuildMock();

    // Stale target — loyalty bonus should NOT apply
    const staleMemory = defaultMemory({ currentBuildTarget: 'Berlin', turnsOnTarget: 5 });
    const staleOptions = OptionGenerator.generate(snapshot, buildOnly, staleMemory);
    const staleBuilds = staleOptions.filter(o => o.action === AIActionType.BuildTrack && o.feasible);
    const staleBerlin = staleBuilds.find(b => b.reason?.includes('Berlin'));

    // Both should produce build options
    expect(freshBuilds.length).toBeGreaterThan(0);
    expect(staleBuilds.length).toBeGreaterThan(0);

    // Both should contain Berlin-targeting builds
    expect(freshBerlin).toBeDefined();
    expect(staleBerlin).toBeDefined();

    // Fresh Berlin should have loyalty bonus (1.5x chainScore), stale should not
    expect(freshBerlin!.chainScore).toBeGreaterThan(staleBerlin!.chainScore!);
    expect(freshBerlin!.chainScore).toBeCloseTo(staleBerlin!.chainScore! * 1.5, 2);
  });

  it('should work without BotMemoryState (backward compatible)', () => {
    const snapshot = makeStickySnapshot();
    const buildOnly = new Set([AIActionType.BuildTrack, AIActionType.PassTurn]);

    // No memory at all — should not crash
    const options = OptionGenerator.generate(snapshot, buildOnly);
    const builds = options.filter(o => o.action === AIActionType.BuildTrack && o.feasible);
    expect(builds.length).toBeGreaterThan(0);
  });
});

describe('OptionGenerator — chain ranking: short-haul beats long-haul', () => {
  const { loadGridPoints } = require('../services/ai/MapTopology');

  function makeChainGridMap(): Map<string, { row: number; col: number; name: string; terrain: number }> {
    const map = new Map();
    // Close pickup/delivery pair: München at (8,8), London at (12,12)
    map.set('8,8', { row: 8, col: 8, name: 'München', terrain: TerrainType.MajorCity });
    map.set('12,12', { row: 12, col: 12, name: 'London', terrain: TerrainType.MajorCity });
    // Far pickup/delivery pair: Porto at (40,5), Krakow at (10,45)
    map.set('40,5', { row: 40, col: 5, name: 'Porto', terrain: TerrainType.MajorCity });
    map.set('10,45', { row: 10, col: 45, name: 'Krakow', terrain: TerrainType.MajorCity });
    return map;
  }

  function makeChainSnapshot(overrides?: Partial<WorldSnapshot>): WorldSnapshot {
    return {
      gameId: 'game-1',
      gameStatus: 'active',
      turnNumber: 5,
      bot: {
        playerId: 'bot-1',
        userId: 'user-bot-1',
        money: 50,
        position: { row: 5, col: 5 },
        existingSegments: [makeSegment(5, 5, 6, 5, 1)],
        demandCards: [42, 43],
        resolvedDemands: [
          {
            cardId: 42,
            demands: [{ city: 'London', loadType: 'Beer', payment: 11 }],
          },
          {
            cardId: 43,
            demands: [{ city: 'Krakow', loadType: 'Fish', payment: 40 }],
          },
        ],
        trainType: 'Freight',
        loads: [],
        botConfig: null,
        connectedMajorCityCount: 0,
      },
      allPlayerTracks: [],
      loadAvailability: {
        'München': ['Beer'],
        'Porto': ['Fish'],
      },
      ...overrides,
    };
  }

  beforeEach(() => {
    loadGridPoints.mockReturnValue(makeChainGridMap());
    setupMockDemandDeck([
      { id: 42, demands: [{ city: 'London', payment: 11, resource: 'Beer' }] },
      { id: 43, demands: [{ city: 'Krakow', payment: 40, resource: 'Fish' }] },
    ]);
    let callCount = 0;
    mockComputeBuild.mockImplementation(() => {
      callCount++;
      return [makeSegment(5, 5, 5 + callCount, 5 + callCount, 1)];
    });
  });

  afterEach(() => jest.clearAllMocks());

  it('should rank short-haul chain (Beer→London) above long-haul chain (Fish→Krakow) despite lower payment', () => {
    const snapshot = makeChainSnapshot();
    const buildOnly = new Set([AIActionType.BuildTrack, AIActionType.PassTurn]);

    const options = OptionGenerator.generate(snapshot, buildOnly);
    const builds = options.filter(o => o.action === AIActionType.BuildTrack && o.feasible);

    // Should produce build options
    expect(builds.length).toBeGreaterThan(0);

    // Find the Beer→London and Fish→Krakow build options
    const beerBuild = builds.find(b => b.reason?.includes('Beer') && b.reason?.includes('London'));
    const fishBuild = builds.find(b => b.reason?.includes('Fish') && b.reason?.includes('Krakow'));

    // Beer→London should exist and be ranked in the top 3 chains
    expect(beerBuild).toBeDefined();

    // If both exist, Beer should have a higher chainScore
    if (beerBuild && fishBuild) {
      expect(beerBuild.chainScore!).toBeGreaterThan(fishBuild.chainScore!);
    }
  });

  it('should apply budget penalty to chains whose build cost exceeds bot money', () => {
    // Give bot very little money — long-haul chain should be penalized
    const snapshot = makeChainSnapshot({ bot: { ...makeChainSnapshot().bot, money: 20 } });
    const buildOnly = new Set([AIActionType.BuildTrack, AIActionType.PassTurn]);

    const options = OptionGenerator.generate(snapshot, buildOnly);
    const builds = options.filter(o => o.action === AIActionType.BuildTrack && o.feasible);

    expect(builds.length).toBeGreaterThan(0);

    // The short-haul chain should dominate when budget is tight
    const beerBuild = builds.find(b => b.reason?.includes('Beer') && b.reason?.includes('London'));
    expect(beerBuild).toBeDefined();
  });
});
