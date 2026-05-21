/**
 * DemandEngine.test.ts
 *
 * Unit tests for the graph-aware cost changes in DemandEngine
 * introduced by JIRA-230 Project 2 (BE-002).
 *
 * AC6: closer on-network supply wins (graph-aware turns from estimateGraphPathCost)
 * AC7: ferry path has higher estimatedTurns via estimateGraphPathCost (no double-count)
 *
 * Mocking strategy:
 * - Mock estimateGraphPathCost from PathCostEstimator to control cost per leg
 * - Mock MapTopology (loadGridPoints, hexDistance, etc.) to control city lookup
 * - Mock majorCityGroups to avoid real city-region ferry logic
 */

// ── Mocks ──────────────────────────────────────────────────────────────

// Mock PathCostEstimator — controls estimateGraphPathCost
jest.mock('../../services/ai/PathCostEstimator', () => ({
  estimateGraphPathCost: jest.fn(),
  clearPathCostCache: jest.fn(),
}));

// Mock MapTopology
jest.mock('../../services/MapTopology', () => ({
  ...jest.requireActual<typeof import('../../services/MapTopology')>('../../services/MapTopology'),
  hexDistance: jest.fn((r1: number, c1: number, r2: number, c2: number): number => {
    return Math.max(Math.abs(r2 - r1), Math.abs(c2 - c1));
  }),
  estimateHopDistance: jest.fn((r1: number, c1: number, r2: number, c2: number): number => {
    return Math.max(Math.abs(r2 - r1), Math.abs(c2 - c1));
  }),
  estimatePathCost: jest.fn().mockReturnValue(0),
  computeLandmass: jest.fn().mockReturnValue(new Set()),
  computeFerryRouteInfo: jest.fn().mockReturnValue({}),
  makeKey: jest.fn((...args: unknown[]) => args.join(',')),
  loadGridPoints: jest.fn().mockReturnValue(new Map()),
}));

// Mock majorCityGroups to avoid real city-region lookups
jest.mock('../../../shared/services/majorCityGroups', () => ({
  ...jest.requireActual<typeof import('../../../shared/services/majorCityGroups')>('../../../shared/services/majorCityGroups'),
  getMajorCityGroups: jest.fn().mockReturnValue([]),
  getFerryEdges: jest.fn().mockReturnValue([]),
  getMajorCityLookup: jest.fn().mockReturnValue(new Map()),
  computeEffectivePathLength: jest.fn().mockReturnValue(0),
}));

// Mock TrackNetworkService — return a minimal network object with empty nodes map
jest.mock('../../../shared/services/TrackNetworkService', () => ({
  buildTrackNetwork: jest.fn().mockReturnValue({ nodes: new Map(), edges: new Map() }),
}));

// ── Imports (after mocks) ──────────────────────────────────────────────

import { estimateGraphPathCost } from '../../services/ai/PathCostEstimator';
import { computeBestDemandContext, computeAllDemandContexts } from '../../services/ai/context/DemandEngine';
import { WorldSnapshot, GridPoint, TerrainType, TrackSegment } from '../../../shared/types/GameTypes';
// Note: buildTrackNetwork is mocked above but we need its return type

const mockEstimateGraphPathCost = estimateGraphPathCost as jest.MockedFunction<typeof estimateGraphPathCost>;

// ── Helpers ────────────────────────────────────────────────────────────

function makeSnapshot(overrides: Partial<WorldSnapshot['bot']> = {}): WorldSnapshot {
  return {
    gameId: 'test-game',
    gameStatus: 'active',
    turnNumber: 10,
    bot: {
      playerId: 'bot-1',
      userId: 'user-1',
      money: 200,
      position: { row: 5, col: 5 },
      existingSegments: [
        // non-empty so isColdStart is false
        {
          from: { x: 200, y: 200, row: 5, col: 5, terrain: TerrainType.Clear },
          to: { x: 240, y: 240, row: 6, col: 6, terrain: TerrainType.Clear },
          cost: 1,
        },
      ],
      demandCards: [],
      resolvedDemands: [],
      trainType: 'freight', // speed=9
      loads: [],
      botConfig: { skillLevel: 'medium' },
      connectedMajorCityCount: 2,
      ...overrides,
    },
    allPlayerTracks: [],
    loadAvailability: {},
  };
}

/** Create a minimal GridPoint with a city */
function makeCityPoint(
  row: number,
  col: number,
  name: string,
  availableLoads: string[] = [],
): GridPoint {
  return {
    id: `gp-${row}-${col}`,
    x: col * 40,
    y: row * 40,
    row,
    col,
    terrain: TerrainType.MajorCity,
    city: { type: TerrainType.MajorCity, name, availableLoads },
  };
}

// ── Setup ──────────────────────────────────────────────────────────────

beforeEach(() => {
  jest.clearAllMocks();
});

// ── AC6: closer on-network supply wins ────────────────────────────────

describe('AC6: computeBestDemandContext selects closer on-network supply', () => {
  it('picks Beograd (5 turns) over Sarajevo (12 turns) when both on network', () => {
    /**
     * Scenario: demand for 'Coal' at 'Zagreb' (payout=30M).
     * Two supply cities: 'Beograd' and 'Sarajevo' — both on network (buildCost=0).
     * - bot→Beograd:  estimatedTurns=5, buildCost=0
     * - bot→Sarajevo: estimatedTurns=12, buildCost=0
     * - Beograd→Zagreb:  estimatedTurns=2, buildCost=0
     * - Sarajevo→Zagreb: estimatedTurns=2, buildCost=0
     *
     * With graph-aware scoring:
     * - Beograd total turns = 5+2 = 7 → demandScore = 30/8 ≈ 3.75
     * - Sarajevo total turns = 12+2 = 14 → demandScore = 30/15 ≈ 2.0
     * → Beograd wins.
     */
    const snapshot = makeSnapshot();
    const demand = { city: 'Zagreb', loadType: 'Coal', payment: 30 };

    // Grid: Beograd and Sarajevo both supply 'Coal'; Zagreb demands it
    const gridPoints: GridPoint[] = [
      makeCityPoint(10, 10, 'Beograd', ['Coal']),
      makeCityPoint(15, 15, 'Sarajevo', ['Coal']),
      makeCityPoint(12, 12, 'Zagreb'),
    ];

    // Configure mock: four calls — bot→Beograd, Beograd→Zagreb, bot→Sarajevo, Sarajevo→Zagreb
    // The order depends on Set iteration. We configure all permutations.
    mockEstimateGraphPathCost.mockImplementation(
      (from: unknown, to: unknown) => {
        const toStr = String(to);
        const fromStr = typeof from === 'string' ? from : `coord`;
        if (toStr === 'Beograd' || (fromStr === 'coord' && toStr === 'Beograd')) {
          return { reachable: true, buildCost: 0, pathLength: 45, estimatedTurns: 5 };
        }
        if (toStr === 'Sarajevo' || (fromStr === 'coord' && toStr === 'Sarajevo')) {
          return { reachable: true, buildCost: 0, pathLength: 108, estimatedTurns: 12 };
        }
        if (toStr === 'Zagreb') {
          return { reachable: true, buildCost: 0, pathLength: 18, estimatedTurns: 2 };
        }
        return { reachable: true, buildCost: 0, pathLength: 10, estimatedTurns: 1 };
      },
    );

    const result = computeBestDemandContext(
      1,
      demand,
      snapshot,
      null,
      gridPoints,
      ['Beograd', 'Sarajevo', 'Zagreb'], // all reachable
      ['Beograd', 'Sarajevo', 'Zagreb'], // all on network
      [],
    );

    expect(result.supplyCity).toBe('Beograd');
  });
});

// ── AC7: ferry path has higher estimatedTurns (no double-count) ────────

describe('AC7: ferry overhead comes only from estimateGraphPathCost, not ferryCrossings * 2', () => {
  it('ferry route estimatedTurns exceeds non-ferry route by exactly 2 (from estimateGraphPathCost)', () => {
    /**
     * Scenario: two demand contexts with identical payout and buildCost=0.
     * The ferry route's estimateGraphPathCost returns +2 extra turns vs non-ferry.
     * We verify the final DemandContext.estimatedTurns difference equals exactly 2
     * — confirming no ferryCrossings*2 double-count.
     *
     * We compute both contexts separately with different mocked estimateGraphPathCost
     * responses to simulate "ferry path" vs "non-ferry path".
     *
     * Note: We use continent cities to avoid isFerryOnRoute returning true based on
     * city-region difference (Beograd/Sarajevo are both on continent).
     * ferryCrossings=0 in both cases, so the only difference is estimatedTurns.
     */
    const snapshot = makeSnapshot();
    const demand = { city: 'Madrid', loadType: 'Iron', payment: 25 };

    const gridPoints: GridPoint[] = [
      makeCityPoint(5, 5, 'Barcelona', ['Iron']),
      makeCityPoint(10, 10, 'Madrid'),
    ];

    // Non-ferry path: baseline turns
    const baselineTurns = 4;
    mockEstimateGraphPathCost.mockImplementation(
      (_from: unknown, to: unknown) => {
        if (String(to) === 'Barcelona') {
          return { reachable: true, buildCost: 0, pathLength: 27, estimatedTurns: 3 };
        }
        // Barcelona → Madrid
        return { reachable: true, buildCost: 0, pathLength: 9, estimatedTurns: 1 };
      },
    );

    const nonFerryCtx = computeBestDemandContext(
      1,
      demand,
      snapshot,
      null,
      gridPoints,
      ['Barcelona', 'Madrid'],
      ['Barcelona', 'Madrid'],
      [],
    );

    // estimatedTurns = 3 + 1 + 0 (no ferry) + 1 = 5
    const nonFerryEstimatedTurns = nonFerryCtx.estimatedTurns;

    // Ferry path: +2 turns from estimateGraphPathCost (ferry overhead baked in)
    jest.clearAllMocks();
    mockEstimateGraphPathCost.mockImplementation(
      (_from: unknown, to: unknown) => {
        if (String(to) === 'Barcelona') {
          return { reachable: true, buildCost: 0, pathLength: 27, estimatedTurns: 3 };
        }
        // Barcelona → Madrid via ferry: +2 turns baked in by PathCostEstimator
        return { reachable: true, buildCost: 0, pathLength: 27, estimatedTurns: 3 };
      },
    );

    const ferryCtx = computeBestDemandContext(
      1,
      demand,
      snapshot,
      null,
      gridPoints,
      ['Barcelona', 'Madrid'],
      ['Barcelona', 'Madrid'],
      [],
    );

    // estimatedTurns = 3 + 3 + 0 (ferryCrossings=0, no double-count) + 1 = 7
    const ferryEstimatedTurns = ferryCtx.estimatedTurns;

    const diff = ferryEstimatedTurns - nonFerryEstimatedTurns;
    expect(diff).toBe(2);
    expect(ferryEstimatedTurns).toBeGreaterThan(nonFerryEstimatedTurns);
  });

  it('no ferryCrossings * 2 double-count: context uses estimateGraphPathCost turns directly', () => {
    /**
     * Verify the ferry-add logic is 0 in non-cold-start branch.
     * Set up: continent supply and delivery → ferryCrossings=0 anyway.
     * estimateGraphPathCost returns estimatedTurns=6 total.
     * Expected estimatedTurns = 6 + 0 (ferryAdd) + 1 (buildTurns=0 + 1) = 7.
     */
    const snapshot = makeSnapshot();
    const demand = { city: 'Berlin', loadType: 'Coal', payment: 20 };

    const gridPoints: GridPoint[] = [
      makeCityPoint(5, 5, 'Hamburg', ['Coal']),
      makeCityPoint(10, 10, 'Berlin'),
    ];

    mockEstimateGraphPathCost.mockImplementation(
      (_from: unknown, to: unknown) => {
        if (String(to) === 'Hamburg') {
          return { reachable: true, buildCost: 0, pathLength: 27, estimatedTurns: 3 };
        }
        // Hamburg → Berlin
        return { reachable: true, buildCost: 0, pathLength: 27, estimatedTurns: 3 };
      },
    );

    const ctx = computeBestDemandContext(
      1,
      demand,
      snapshot,
      null,
      gridPoints,
      ['Hamburg', 'Berlin'],
      ['Hamburg', 'Berlin'],
      [],
    );

    // buildTurns=0 (totalTrackCost=0), travelTurns=3+3=6, ferryAdd=0, +1
    expect(ctx.estimatedTurns).toBe(7);
  });
});

// ── JIRA-231: Feasibility producer (AC1–AC4) ─────────────────────────────────

/** Create a small-city GridPoint (entry limit = 2 players). */
function makeSmallCityPoint(
  row: number,
  col: number,
  name: string,
  availableLoads: string[] = [],
): GridPoint {
  return {
    id: `gp-${row}-${col}`,
    x: col * 40,
    y: row * 40,
    row,
    col,
    terrain: TerrainType.SmallCity,
    city: { type: TerrainType.SmallCity, name, availableLoads },
  };
}

/** Create a TrackSegment endpoint at a given row/col with given terrain. */
function makeSegment(
  fromRow: number,
  fromCol: number,
  toRow: number,
  toCol: number,
  terrain: TerrainType = TerrainType.Clear,
): TrackSegment {
  return {
    from: { x: fromCol * 40, y: fromRow * 40, row: fromRow, col: fromCol, terrain },
    to: { x: toCol * 40, y: toRow * 40, row: toRow, col: toCol, terrain },
    cost: 1,
  };
}

describe('JIRA-231: Feasibility producer — supply city saturated', () => {
  /**
   * AC1: Supply city (48,44) is saturated (two other players already there) and bot has
   * no track at (48,44). Expected: isFeasible === false, infeasibleReason === 'supplyCitySaturated'.
   */
  it('AC1: supply city saturated and not on bot network → isFeasible false, supplyCitySaturated', () => {
    // Bot has track at (5,5)→(6,6) only — NOT at (48,44)
    const snapshot = makeSnapshot({
      existingSegments: [
        makeSegment(5, 5, 6, 6),
      ],
    });

    const demand = { city: 'Ruhr', loadType: 'Marble', payment: 20 };

    // Grid: supply city Firenze at (48,44), delivery city Ruhr at (20,20)
    const gridPoints: GridPoint[] = [
      makeSmallCityPoint(48, 44, 'Firenze', ['Marble']),
      makeSmallCityPoint(20, 20, 'Ruhr'),
    ];

    // Firenze is saturated for the bot
    const saturatedCityKeys = new Set<string>(['48,44']);

    // Network with no nodes at (48,44) — mocked to return empty nodes
    const network = { nodes: new Map<string, unknown>(), edges: new Map<string, unknown>() };

    mockEstimateGraphPathCost.mockReturnValue({ reachable: true, buildCost: 5, pathLength: 20, estimatedTurns: 3 });

    const ctx = computeBestDemandContext(
      1,
      demand,
      snapshot,
      network as unknown as ReturnType<typeof import('../../../shared/services/TrackNetworkService').buildTrackNetwork>,
      gridPoints,
      ['Firenze', 'Ruhr'],
      ['Ruhr'],
      [],
      saturatedCityKeys,
    );

    expect(ctx.isFeasible).toBe(false);
    expect(ctx.infeasibleReason).toBe('supplyCitySaturated');
  });

  /**
   * AC2: Supply city saturated, but bot already has track at (48,44) (grandfathered).
   * Expected: isFeasible !== false (the demand is feasible).
   */
  it('AC2: supply city saturated but bot already has track there → isFeasible not false (grandfathered)', () => {
    // Bot has track touching (48,44)
    const snapshot = makeSnapshot({
      existingSegments: [
        makeSegment(48, 44, 49, 45, TerrainType.SmallCity),
      ],
    });

    const demand = { city: 'Ruhr', loadType: 'Marble', payment: 20 };

    const gridPoints: GridPoint[] = [
      makeSmallCityPoint(48, 44, 'Firenze', ['Marble']),
      makeSmallCityPoint(20, 20, 'Ruhr'),
    ];

    const saturatedCityKeys = new Set<string>(['48,44']);

    // Network DOES have node at (48,44) — bot is grandfathered
    const networkNodes = new Map<string, unknown>();
    networkNodes.set('48,44', {});
    const network = { nodes: networkNodes, edges: new Map<string, unknown>() };

    mockEstimateGraphPathCost.mockReturnValue({ reachable: true, buildCost: 5, pathLength: 20, estimatedTurns: 3 });

    const ctx = computeBestDemandContext(
      1,
      demand,
      snapshot,
      network as unknown as ReturnType<typeof import('../../../shared/services/TrackNetworkService').buildTrackNetwork>,
      gridPoints,
      ['Firenze', 'Ruhr'],
      ['Firenze', 'Ruhr'],
      [],
      saturatedCityKeys,
    );

    expect(ctx.isFeasible).not.toBe(false);
  });

  /**
   * AC3: Delivery city is saturated and not on bot's network.
   * Expected: isFeasible === false, infeasibleReason === 'deliveryCitySaturated'.
   */
  it('AC3: delivery city saturated and not on bot network → isFeasible false, deliveryCitySaturated', () => {
    const snapshot = makeSnapshot({
      existingSegments: [
        makeSegment(5, 5, 6, 6),
      ],
    });

    const demand = { city: 'Firenze', loadType: 'Marble', payment: 20 };

    // Supply at Hamburg (large, not saturated), delivery at Firenze (48,44) which is saturated
    const gridPoints: GridPoint[] = [
      makeCityPoint(10, 10, 'Hamburg', ['Marble']),   // major city, not saturated
      makeSmallCityPoint(48, 44, 'Firenze'),
    ];

    // Only delivery city is saturated
    const saturatedCityKeys = new Set<string>(['48,44']);
    const network = { nodes: new Map<string, unknown>(), edges: new Map<string, unknown>() };

    mockEstimateGraphPathCost.mockReturnValue({ reachable: true, buildCost: 5, pathLength: 20, estimatedTurns: 3 });

    const ctx = computeBestDemandContext(
      1,
      demand,
      snapshot,
      network as unknown as ReturnType<typeof import('../../../shared/services/TrackNetworkService').buildTrackNetwork>,
      gridPoints,
      ['Hamburg', 'Firenze'],
      ['Hamburg'],
      [],
      saturatedCityKeys,
    );

    expect(ctx.isFeasible).toBe(false);
    expect(ctx.infeasibleReason).toBe('deliveryCitySaturated');
  });

  /**
   * AC4: saturatedCityKeys parameter omitted from computeAllDemandContexts.
   * Expected: all demands have isFeasible !== false (backwards compatibility).
   */
  it('AC4: saturatedCityKeys omitted → all demands have isFeasible not false (backwards compatible)', () => {
    const snapshot: WorldSnapshot = {
      ...makeSnapshot(),
      bot: {
        ...makeSnapshot().bot,
        existingSegments: [makeSegment(5, 5, 6, 6)],
        resolvedDemands: [
          {
            cardId: 1,
            demands: [
              { city: 'Firenze', loadType: 'Marble', payment: 15 },
            ],
          },
          {
            cardId: 2,
            demands: [
              { city: 'Hamburg', loadType: 'Coal', payment: 20 },
            ],
          },
        ],
      },
    };

    const gridPoints: GridPoint[] = [
      makeSmallCityPoint(48, 44, 'Firenze'),
      makeCityPoint(10, 10, 'Hamburg'),
      makeCityPoint(15, 15, 'Berlin', ['Marble', 'Coal']),
    ];

    mockEstimateGraphPathCost.mockReturnValue({ reachable: true, buildCost: 5, pathLength: 20, estimatedTurns: 3 });

    // Call WITHOUT saturatedCityKeys parameter
    const contexts = computeAllDemandContexts(
      snapshot,
      null,
      gridPoints,
      ['Firenze', 'Hamburg', 'Berlin'],
      ['Firenze', 'Hamburg', 'Berlin'],
      [],
      // no saturatedCityKeys
    );

    // All demands should be feasible (isFeasible not set to false)
    for (const ctx of contexts) {
      expect(ctx.isFeasible).not.toBe(false);
    }
  });
});
