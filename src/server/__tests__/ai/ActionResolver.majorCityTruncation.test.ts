/**
 * Major-city path truncation tests — ActionResolver.resolveMove
 *
 * Purpose: Lock in R5–R8 / AC5–AC8 behaviours introduced by the BFS-overshoot
 * fix for major-city deliveries.
 *
 * When a bot delivers to a major city, the destination has multiple mileposts
 * (center + outposts). The BFS path may enter the city's red zone early (e.g. at
 * index 2 of a 5-step path) but previously the full path was replayed, wasting
 * movement budget. The fix truncates at the first reached major-city milepost.
 *
 * Test coverage:
 *   AC5 — truncation at first reached major-city milepost (city-name move)
 *   AC6 — no truncation for small/medium city targets
 *   AC7 — no truncation for coordinate-targeted moves
 *   AC8 — ferry-port truncation wins when both apply on same path
 */

import { ActionResolver } from '../../services/ai/ActionResolver';
import {
  WorldSnapshot,
  TrainType,
  TerrainType,
  TrackSegment,
  TurnPlanMoveTrain,
  AIActionType,
} from '../../../shared/types/GameTypes';
import type { TrackUsageComputation, PathEdge } from '../../../shared/services/trackUsageFees';

// ─── Mock modules ─────────────────────────────────────────────────────────────

jest.mock('../../services/ai/computeBuildSegments', () => ({
  computeBuildSegments: jest.fn(() => []),
}));
jest.mock('../../../shared/services/trackUsageFees');
jest.mock('../../services/MapTopology');
jest.mock('../../../shared/services/majorCityGroups', () => {
  const actual = jest.requireActual('../../../shared/services/majorCityGroups');
  return {
    ...actual,
    getMajorCityGroups: jest.fn(),
    getMajorCityLookup: jest.fn(),
    getFerryEdges: jest.fn().mockReturnValue([]),
  };
});

import { computeTrackUsageForMove } from '../../../shared/services/trackUsageFees';
import { loadGridPoints } from '../../services/MapTopology';
import { getMajorCityGroups, getMajorCityLookup, getFerryEdges } from '../../../shared/services/majorCityGroups';

const mockComputeTrackUsageForMove = computeTrackUsageForMove as jest.MockedFunction<typeof computeTrackUsageForMove>;
const mockLoadGridPoints = loadGridPoints as jest.MockedFunction<typeof loadGridPoints>;
const mockGetMajorCityGroups = getMajorCityGroups as jest.MockedFunction<typeof getMajorCityGroups>;
const mockGetMajorCityLookup = getMajorCityLookup as jest.MockedFunction<typeof getMajorCityLookup>;
const mockGetFerryEdges = getFerryEdges as jest.MockedFunction<typeof getFerryEdges>;

// ─── Geometry constants ───────────────────────────────────────────────────────

const BOT_PLAYER_ID = 'test-bot-player';
const BOT_START = { row: 10, col: 5 };

// Berlin major-city mileposts: center + two outposts
const BERLIN_CENTER  = { row: 10, col: 8 };
const BERLIN_OUTPOST1 = { row: 10, col: 9 };
const BERLIN_OUTPOST2 = { row: 10, col: 10 };

// Intermediate milepost en route to Berlin (not in any major city)
const CLEAR_NODE1 = { row: 10, col: 6 };
const CLEAR_NODE2 = { row: 10, col: 7 };

// Strasbourg — a small city with single milepost (not a major city)
const STRASBOURG = { row: 10, col: 8 };  // same grid position, but no major-city group

// Stockholm major-city mileposts (for ferry + major-city combo test)
const STOCKHOLM_PORT   = { row: 8,  col: 6 };  // ferry port en route to Stockholm
const STOCKHOLM_CENTER = { row: 8,  col: 9 };
const STOCKHOLM_OUTPOST = { row: 8,  col: 10 };

// ─── Factory helpers ──────────────────────────────────────────────────────────

function makeSegment(
  fromRow: number, fromCol: number,
  toRow: number, toCol: number,
): TrackSegment {
  return {
    from: { x: fromCol * 50, y: fromRow * 45, row: fromRow, col: fromCol, terrain: TerrainType.Clear },
    to: { x: toCol * 50, y: toRow * 45, row: toRow, col: toCol, terrain: TerrainType.Clear },
    cost: 1,
  };
}

function makePathEdge(
  fromRow: number, fromCol: number,
  toRow: number, toCol: number,
  owners: string[] = [],
): PathEdge {
  return {
    from: { row: fromRow, col: fromCol },
    to:   { row: toRow,   col: toCol },
    ownerPlayerIds: owners,
  };
}

function makeValidUsage(path: PathEdge[]): TrackUsageComputation {
  return {
    isValid: true,
    path,
    ownersUsed: new Set(),
  };
}

function makeWorldSnapshot(
  position: { row: number; col: number } = BOT_START,
  overrides: Partial<WorldSnapshot> = {},
): WorldSnapshot {
  const segments = [makeSegment(BOT_START.row, BOT_START.col, BOT_START.row, BOT_START.col + 1)];
  return {
    gameId: 'test-major-city-truncation',
    gameStatus: 'active',
    turnNumber: 1,
    bot: {
      playerId: BOT_PLAYER_ID,
      userId: 'test-user',
      money: 300,
      position,
      existingSegments: segments,
      demandCards: [],
      resolvedDemands: [],
      trainType: TrainType.Freight,
      loads: [],
      botConfig: { skillLevel: 'medium' },
      ferryHalfSpeed: false,
      connectedMajorCityCount: 0,
      ...(overrides.bot ?? {}),
    },
    allPlayerTracks: [{ playerId: BOT_PLAYER_ID, segments }],
    loadAvailability: {},
    ferryEdges: [],
    ...overrides,
  };
}

/**
 * Set up loadGridPoints with specified mileposts.
 * Berlin center + outposts are added as MajorCity / MajorCityOutpost terrain.
 */
type GridEntry = {
  row: number;
  col: number;
  name: string;
  terrain?: TerrainType;
};

function setupGridPoints(entries: GridEntry[]): void {
  const grid = new Map<string, any>();
  for (const e of entries) {
    grid.set(`${e.row},${e.col}`, {
      row: e.row,
      col: e.col,
      terrain: e.terrain ?? TerrainType.Clear,
      name: e.name,
    });
  }
  mockLoadGridPoints.mockReturnValue(grid);
}

/**
 * Set up getMajorCityGroups + getMajorCityLookup for the given city groups.
 */
function setupMajorCityGroups(
  groups: Array<{ cityName: string; center: { row: number; col: number }; outposts?: Array<{ row: number; col: number }> }>,
): void {
  const fullGroups = groups.map(g => ({
    cityName: g.cityName,
    center: g.center,
    outposts: g.outposts ?? [],
  }));
  mockGetMajorCityGroups.mockReturnValue(fullGroups);

  const lookup = new Map<string, string>();
  for (const g of fullGroups) {
    lookup.set(`${g.center.row},${g.center.col}`, g.cityName);
    for (const o of (g.outposts ?? [])) {
      lookup.set(`${o.row},${o.col}`, g.cityName);
    }
  }
  mockGetMajorCityLookup.mockReturnValue(lookup);
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('ActionResolver.resolveMove — major-city path truncation', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetFerryEdges.mockReturnValue([]);
    setupGridPoints([]);
    setupMajorCityGroups([]);
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // AC5 — truncation at first reached major-city milepost
  // ═══════════════════════════════════════════════════════════════════════════

  it('truncates path at first reached milepost of destination major city (AC5)', async () => {
    /**
     * Scenario: bot at (10,5), target city "Berlin".
     * Berlin has mileposts at (10,8) center, (10,9) outpost1, (10,10) outpost2.
     * Mock BFS to target BERLIN_OUTPOST2 (10,10) — the deepest milepost.
     * Path: (10,5)→(10,6)→(10,7)→(10,8)→(10,9)→(10,10) — 5 edges.
     * The first Berlin milepost reached is index 3: (10,8).
     * Expected: path truncated to [(10,5),(10,6),(10,7),(10,8)], length 4.
     */
    setupGridPoints([
      { row: BERLIN_CENTER.row,   col: BERLIN_CENTER.col,   name: 'Berlin', terrain: TerrainType.MajorCity },
      { row: BERLIN_OUTPOST1.row, col: BERLIN_OUTPOST1.col, name: 'Berlin', terrain: TerrainType.MajorCity },
      { row: BERLIN_OUTPOST2.row, col: BERLIN_OUTPOST2.col, name: 'Berlin', terrain: TerrainType.MajorCity },
    ]);
    setupMajorCityGroups([{
      cityName: 'Berlin',
      center: BERLIN_CENTER,
      outposts: [BERLIN_OUTPOST1, BERLIN_OUTPOST2],
    }]);

    // BFS targets include all three mileposts; pick BERLIN_OUTPOST2 path (longest — deepest target)
    // The loop iterates all targets and picks the shortest resulting truncated path.
    // We make only one target return a path (BERLIN_OUTPOST2) so the truncation fires.
    mockComputeTrackUsageForMove.mockImplementation(({ to }) => {
      if (to.row === BERLIN_OUTPOST2.row && to.col === BERLIN_OUTPOST2.col) {
        return makeValidUsage([
          makePathEdge(10, 5, 10, 6),
          makePathEdge(10, 6, 10, 7),
          makePathEdge(10, 7, 10, 8),   // step 3: first Berlin milepost
          makePathEdge(10, 8, 10, 9),
          makePathEdge(10, 9, 10, 10),  // step 5: original target
        ]);
      }
      return { isValid: false, path: [], ownersUsed: new Set(), errorMessage: 'no path' };
    });

    const snapshot = makeWorldSnapshot();
    const result = await ActionResolver.resolveMove({ to: 'Berlin' }, snapshot, 9);

    expect(result.success).toBe(true);
    const plan = result.plan as TurnPlanMoveTrain;
    expect(plan.type).toBe(AIActionType.MoveTrain);

    // Path should end at the first Berlin milepost reached: (10,8)
    expect(plan.path).toHaveLength(4); // start + 3 hops
    expect(plan.path[plan.path.length - 1]).toEqual({ row: 10, col: 8 });
  });

  it('truncates at first reached outpost when center is reached first (AC5 variant)', async () => {
    /**
     * Scenario: target is BERLIN_OUTPOST1 (10,9) via BFS.
     * Path: (10,5)→(10,6)→(10,7)→(10,8)→(10,9).
     * (10,8) is BERLIN_CENTER — first Berlin group member reached at index 3.
     * Expected: truncated at (10,8), path length 4.
     */
    setupGridPoints([
      { row: BERLIN_CENTER.row,   col: BERLIN_CENTER.col,   name: 'Berlin', terrain: TerrainType.MajorCity },
      { row: BERLIN_OUTPOST1.row, col: BERLIN_OUTPOST1.col, name: 'Berlin', terrain: TerrainType.MajorCity },
    ]);
    setupMajorCityGroups([{
      cityName: 'Berlin',
      center: BERLIN_CENTER,
      outposts: [BERLIN_OUTPOST1],
    }]);

    mockComputeTrackUsageForMove.mockImplementation(({ to }) => {
      if (to.row === BERLIN_OUTPOST1.row && to.col === BERLIN_OUTPOST1.col) {
        return makeValidUsage([
          makePathEdge(10, 5, 10, 6),
          makePathEdge(10, 6, 10, 7),
          makePathEdge(10, 7, 10, 8),  // step 3: BERLIN_CENTER (first group member reached)
          makePathEdge(10, 8, 10, 9),  // step 4: BERLIN_OUTPOST1 (original target)
        ]);
      }
      if (to.row === BERLIN_CENTER.row && to.col === BERLIN_CENTER.col) {
        return makeValidUsage([
          makePathEdge(10, 5, 10, 6),
          makePathEdge(10, 6, 10, 7),
          makePathEdge(10, 7, 10, 8),  // step 3: BERLIN_CENTER
        ]);
      }
      return { isValid: false, path: [], ownersUsed: new Set(), errorMessage: 'no path' };
    });

    const snapshot = makeWorldSnapshot();
    const result = await ActionResolver.resolveMove({ to: 'Berlin' }, snapshot, 9);

    expect(result.success).toBe(true);
    const plan = result.plan as TurnPlanMoveTrain;

    // Both targets are evaluated; center path is 3 edges and outpost path truncates to 3 edges.
    // Both produce the same length; the first found wins.
    expect(plan.path.length).toBeLessThanOrEqual(4);
    // Final step should be a Berlin milepost
    const finalStep = plan.path[plan.path.length - 1];
    const berlinKeys = new Set(['10,8', '10,9']);
    expect(berlinKeys.has(`${finalStep.row},${finalStep.col}`)).toBe(true);
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // AC6 — no truncation for small/medium city targets
  // ═══════════════════════════════════════════════════════════════════════════

  it('does not truncate path when destination is a small/medium city (AC6)', async () => {
    /**
     * Scenario: target is "Strasbourg" — a small city, single milepost at (10,8).
     * majorCityLookup returns undefined for (10,8) (not a major city group member).
     * Path: (10,5)→(10,6)→(10,7)→(10,8) — 3 edges.
     * Expected: path unchanged (length 4).
     */
    setupGridPoints([
      { row: STRASBOURG.row, col: STRASBOURG.col, name: 'Strasbourg', terrain: TerrainType.SmallCity },
    ]);
    // No major city groups — lookup will return undefined for all mileposts
    setupMajorCityGroups([]);

    mockComputeTrackUsageForMove.mockReturnValue(makeValidUsage([
      makePathEdge(10, 5, 10, 6),
      makePathEdge(10, 6, 10, 7),
      makePathEdge(10, 7, 10, 8),
    ]));

    const snapshot = makeWorldSnapshot();
    const result = await ActionResolver.resolveMove({ to: 'Strasbourg' }, snapshot, 9);

    expect(result.success).toBe(true);
    const plan = result.plan as TurnPlanMoveTrain;

    // Full path retained: start + 3 hops = 4 nodes
    expect(plan.path).toHaveLength(4);
    expect(plan.path[plan.path.length - 1]).toEqual({ row: 10, col: 8 });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // AC7 — no truncation for coordinate-targeted moves
  // ═══════════════════════════════════════════════════════════════════════════

  it('does not truncate path when target is coordinate-based (AC7)', async () => {
    /**
     * Scenario: coordinate move to (10,9) (BERLIN_OUTPOST1).
     * Path passes through Berlin center (10,8) at index 3.
     * Even though (10,8) belongs to Berlin major-city group, no truncation fires
     * because isCityNameTarget is false (toRow/toCol are provided).
     * Path: (10,5)→(10,6)→(10,7)→(10,8)→(10,9) — 4 edges.
     * Expected: full path retained, length 5.
     */
    // Grid needs to include BERLIN_OUTPOST1 so the bot's coordinate is valid
    setupGridPoints([
      { row: BERLIN_CENTER.row,   col: BERLIN_CENTER.col,   name: 'Berlin', terrain: TerrainType.MajorCity },
      { row: BERLIN_OUTPOST1.row, col: BERLIN_OUTPOST1.col, name: 'Berlin', terrain: TerrainType.MajorCity },
    ]);
    setupMajorCityGroups([{
      cityName: 'Berlin',
      center: BERLIN_CENTER,
      outposts: [BERLIN_OUTPOST1],
    }]);

    mockComputeTrackUsageForMove.mockReturnValue(makeValidUsage([
      makePathEdge(10, 5, 10, 6),
      makePathEdge(10, 6, 10, 7),
      makePathEdge(10, 7, 10, 8),  // passes through Berlin center — but no truncation for coord move
      makePathEdge(10, 8, 10, 9),  // arrives at target coordinate
    ]));

    const snapshot = makeWorldSnapshot();
    // Coordinate-targeted move: toRow/toCol provided instead of city name
    const result = await ActionResolver.resolveMove(
      { toRow: BERLIN_OUTPOST1.row, toCol: BERLIN_OUTPOST1.col },
      snapshot,
      9,
    );

    expect(result.success).toBe(true);
    const plan = result.plan as TurnPlanMoveTrain;

    // Full path retained — coordinate moves bypass major-city truncation
    expect(plan.path).toHaveLength(5); // start + 4 hops
    expect(plan.path[plan.path.length - 1]).toEqual({ row: 10, col: 9 });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // AC8 — ferry-port truncation wins over major-city truncation
  // ═══════════════════════════════════════════════════════════════════════════

  it('ferry-port truncation wins when ferry port is encountered before major-city milepost (AC8)', async () => {
    /**
     * Scenario: bot at (10,5), target "Stockholm" (major city at (8,9)+(8,10)).
     * Path: (10,5)→(9,5)→(8,6)→(8,9)→(8,10)
     * - (8,6) at index 2 is a FerryPort
     * - (8,9) at index 3 is Stockholm major-city milepost
     * Ferry port truncation (index 2) runs after major-city truncation (index 3).
     * After major-city truncation fires at index 3, ferry truncation then fires at
     * index 2, overriding it. The final path should be length 3 (stop at ferry port).
     *
     * Per spec R6: the earlier truncation wins. Ferry truncation at index 2 < major-city
     * truncation at index 3, so ferry port wins.
     */
    setupGridPoints([
      { row: STOCKHOLM_PORT.row,    col: STOCKHOLM_PORT.col,    name: 'StockholmFerry', terrain: TerrainType.FerryPort },
      { row: STOCKHOLM_CENTER.row,  col: STOCKHOLM_CENTER.col,  name: 'Stockholm', terrain: TerrainType.MajorCity },
      { row: STOCKHOLM_OUTPOST.row, col: STOCKHOLM_OUTPOST.col, name: 'Stockholm', terrain: TerrainType.MajorCity },
    ]);
    setupMajorCityGroups([{
      cityName: 'Stockholm',
      center: STOCKHOLM_CENTER,
      outposts: [STOCKHOLM_OUTPOST],
    }]);

    mockComputeTrackUsageForMove.mockImplementation(({ to }) => {
      if (to.row === STOCKHOLM_CENTER.row && to.col === STOCKHOLM_CENTER.col) {
        return makeValidUsage([
          makePathEdge(10, 5,  9, 5),
          makePathEdge( 9, 5,  8, 6),  // step 2: ferry port
          makePathEdge( 8, 6,  8, 9),  // step 3: Stockholm center (major-city)
          makePathEdge( 8, 9,  8, 10), // step 4: Stockholm outpost
        ]);
      }
      if (to.row === STOCKHOLM_OUTPOST.row && to.col === STOCKHOLM_OUTPOST.col) {
        return makeValidUsage([
          makePathEdge(10, 5,  9, 5),
          makePathEdge( 9, 5,  8, 6),  // step 2: ferry port
          makePathEdge( 8, 6,  8, 9),  // step 3: Stockholm center
          makePathEdge( 8, 9,  8, 10), // step 4: Stockholm outpost (target)
        ]);
      }
      return { isValid: false, path: [], ownersUsed: new Set(), errorMessage: 'no path' };
    });

    const snapshot = makeWorldSnapshot();
    const result = await ActionResolver.resolveMove({ to: 'Stockholm' }, snapshot, 9);

    expect(result.success).toBe(true);
    const plan = result.plan as TurnPlanMoveTrain;

    // Path should be truncated at ferry port (index 2), not at Stockholm (index 3)
    // Path: start(10,5) → (9,5) → (8,6 ferry port) → STOP
    expect(plan.path).toHaveLength(3); // start + 2 hops
    expect(plan.path[plan.path.length - 1]).toEqual({ row: 8, col: 6 }); // stops at ferry port
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Logging — warn fires only when truncation occurs
  // ═══════════════════════════════════════════════════════════════════════════

  it('emits [Movement Budget] console.warn when major-city truncation fires', async () => {
    setupGridPoints([
      { row: BERLIN_CENTER.row,   col: BERLIN_CENTER.col,   name: 'Berlin', terrain: TerrainType.MajorCity },
      { row: BERLIN_OUTPOST2.row, col: BERLIN_OUTPOST2.col, name: 'Berlin', terrain: TerrainType.MajorCity },
    ]);
    setupMajorCityGroups([{
      cityName: 'Berlin',
      center: BERLIN_CENTER,
      outposts: [BERLIN_OUTPOST2],
    }]);

    mockComputeTrackUsageForMove.mockImplementation(({ to }) => {
      if (to.row === BERLIN_OUTPOST2.row && to.col === BERLIN_OUTPOST2.col) {
        return makeValidUsage([
          makePathEdge(10, 5, 10, 6),
          makePathEdge(10, 6, 10, 7),
          makePathEdge(10, 7, 10, 8),  // BERLIN_CENTER — first group member
          makePathEdge(10, 8, 10, 10), // BERLIN_OUTPOST2 — original target
        ]);
      }
      if (to.row === BERLIN_CENTER.row && to.col === BERLIN_CENTER.col) {
        return makeValidUsage([
          makePathEdge(10, 5, 10, 6),
          makePathEdge(10, 6, 10, 7),
          makePathEdge(10, 7, 10, 8),
        ]);
      }
      return { isValid: false, path: [], ownersUsed: new Set(), errorMessage: 'no path' };
    });

    const warnMessages: string[] = [];
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation((...args) => {
      warnMessages.push(String(args[0]));
    });

    const snapshot = makeWorldSnapshot();
    await ActionResolver.resolveMove({ to: 'Berlin' }, snapshot, 9);

    warnSpy.mockRestore();

    // At least one [Movement Budget] major-city truncation warning should fire
    const truncationWarning = warnMessages.find(msg =>
      msg.includes('[Movement Budget]') && msg.includes('major-city entry') && msg.includes('Berlin'),
    );
    expect(truncationWarning).toBeDefined();
  });

  it('does not emit major-city truncation warn when destination is a small city', async () => {
    setupGridPoints([
      { row: STRASBOURG.row, col: STRASBOURG.col, name: 'Strasbourg', terrain: TerrainType.SmallCity },
    ]);
    setupMajorCityGroups([]);

    mockComputeTrackUsageForMove.mockReturnValue(makeValidUsage([
      makePathEdge(10, 5, 10, 6),
      makePathEdge(10, 6, 10, 7),
      makePathEdge(10, 7, 10, 8),
    ]));

    const warnMessages: string[] = [];
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation((...args) => {
      warnMessages.push(String(args[0]));
    });

    const snapshot = makeWorldSnapshot();
    await ActionResolver.resolveMove({ to: 'Strasbourg' }, snapshot, 9);

    warnSpy.mockRestore();

    const majorCityTruncationWarning = warnMessages.find(msg =>
      msg.includes('major-city entry'),
    );
    expect(majorCityTruncationWarning).toBeUndefined();
  });
});
