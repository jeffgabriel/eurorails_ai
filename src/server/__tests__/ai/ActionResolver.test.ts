/**
 * ActionResolver unit tests — TEST-003: resolveBuild + resolveMove
 *
 * All external dependencies are mocked:
 *   - computeBuildSegments (Dijkstra pathfinding for build)
 *   - computeTrackUsageForMove (union-graph pathfinding for movement)
 *   - loadGridPoints (map topology)
 *   - getMajorCityGroups / getMajorCityLookup (major city geometry)
 */

import { ActionResolver } from '../../services/ai/ActionResolver';
import {
  WorldSnapshot,
  GameContext,
  LLMActionIntent,
  AIActionType,
  TrackSegment,
  TrainType,
  TerrainType,
  TRACK_USAGE_FEE,
  ResolvedDemand,
  DemandContext,
  DeliveryOpportunity,
  TurnPlanBuildTrack,
  TurnPlanMoveTrain,
  TurnPlanDeliverLoad,
  TurnPlanPickupLoad,
  TurnPlanDropLoad,
  TurnPlanUpgradeTrain,
  TurnPlanDiscardHand,
  TurnPlanPassTurn,
} from '../../../shared/types/GameTypes';
import type { GridPointData, GridCoord } from '../../services/ai/MapTopology';
import type { TrackUsageComputation, PathEdge } from '../../../shared/services/trackUsageFees';

// ─── Mock modules ────────────────────────────────────────────────────────────

jest.mock('../../services/ai/computeBuildSegments');
jest.mock('../../../shared/services/trackUsageFees');
jest.mock('../../services/ai/MapTopology');
jest.mock('../../../shared/services/majorCityGroups', () => {
  const actual = jest.requireActual('../../../shared/services/majorCityGroups');
  return {
    ...actual,
    getMajorCityGroups: jest.fn(),
    getMajorCityLookup: jest.fn(),
    getFerryEdges: jest.fn().mockReturnValue([]),
  };
});

import { computeBuildSegments } from '../../services/ai/computeBuildSegments';
import { computeTrackUsageForMove } from '../../../shared/services/trackUsageFees';
import { loadGridPoints, hexDistance } from '../../services/ai/MapTopology';
import { getMajorCityGroups, getMajorCityLookup } from '../../../shared/services/majorCityGroups';

const mockComputeBuildSegments = computeBuildSegments as jest.MockedFunction<typeof computeBuildSegments>;
const mockComputeTrackUsageForMove = computeTrackUsageForMove as jest.MockedFunction<typeof computeTrackUsageForMove>;
const mockLoadGridPoints = loadGridPoints as jest.MockedFunction<typeof loadGridPoints>;
const mockGetMajorCityGroups = getMajorCityGroups as jest.MockedFunction<typeof getMajorCityGroups>;
const mockGetMajorCityLookup = getMajorCityLookup as jest.MockedFunction<typeof getMajorCityLookup>;
const mockHexDistance = hexDistance as jest.MockedFunction<typeof hexDistance>;

// ─── Factory helpers ─────────────────────────────────────────────────────────

function makeSegment(
  fromRow: number, fromCol: number,
  toRow: number, toCol: number,
  cost: number = 1,
): TrackSegment {
  return {
    from: { x: fromCol * 50, y: fromRow * 45, row: fromRow, col: fromCol, terrain: TerrainType.Clear },
    to: { x: toCol * 50, y: toRow * 45, row: toRow, col: toCol, terrain: TerrainType.Clear },
    cost,
  };
}

function makeWorldSnapshot(overrides: Partial<WorldSnapshot> = {}): WorldSnapshot {
  return {
    gameId: 'game-1',
    gameStatus: 'active',
    turnNumber: 5,
    bot: {
      playerId: 'bot-1',
      userId: 'user-bot',
      money: 50,
      position: { row: 5, col: 5 },
      existingSegments: [makeSegment(5, 5, 5, 6)],
      demandCards: [1, 2, 3],
      resolvedDemands: [
        { cardId: 1, demands: [{ city: 'Holland', loadType: 'Steel', payment: 20 }, { city: 'Berlin', loadType: 'Coal', payment: 15 }, { city: 'Paris', loadType: 'Wine', payment: 25 }] },
        { cardId: 2, demands: [{ city: 'Hamburg', loadType: 'Oil', payment: 30 }, { city: 'Roma', loadType: 'Iron', payment: 18 }, { city: 'London', loadType: 'Bauxite', payment: 22 }] },
      ],
      trainType: TrainType.Freight,
      loads: [],
      botConfig: { skillLevel: 'medium' },
      ferryHalfSpeed: false,
      connectedMajorCityCount: 0,
      ...(overrides.bot ?? {}),
    } as WorldSnapshot['bot'],
    allPlayerTracks: overrides.allPlayerTracks ?? [
      { playerId: 'bot-1', segments: [makeSegment(5, 5, 5, 6)] },
    ],
    loadAvailability: overrides.loadAvailability ?? {},
    opponents: overrides.opponents,
    ferryEdges: overrides.ferryEdges,
  };
}

function makeGameContext(overrides: Partial<GameContext> = {}): GameContext {
  return {
    position: { city: 'TestCity', row: 5, col: 5 },
    money: 50,
    trainType: TrainType.Freight,
    speed: 9,
    capacity: 2,
    loads: [],
    connectedMajorCities: [],
    unconnectedMajorCities: [],
    totalMajorCities: 20,
    trackSummary: '1 segment',
    turnBuildCost: 0,
    demands: [],
    canDeliver: [],
    canPickup: [],
    reachableCities: [],
    citiesOnNetwork: [],
    canUpgrade: false,
    canBuild: true,
    isInitialBuild: false,
    opponents: [],
    phase: 'operate',
    turnNumber: 5,
    ...overrides,
  };
}

function makeBuildIntent(toward: string): LLMActionIntent {
  return {
    action: AIActionType.BuildTrack,
    details: { toward },
    reasoning: 'Build toward target',
    planHorizon: 'short',
  };
}

function makeMoveIntent(to: string): LLMActionIntent {
  return {
    action: AIActionType.MoveTrain,
    details: { to },
    reasoning: 'Move to target',
    planHorizon: 'short',
  };
}

/** Sets up loadGridPoints with a minimal map containing specified cities */
function setupGridPoints(
  cities: Array<{ row: number; col: number; name: string; terrain?: TerrainType }>,
): void {
  const grid = new Map<string, GridPointData>();
  for (const c of cities) {
    grid.set(`${c.row},${c.col}`, {
      row: c.row,
      col: c.col,
      terrain: c.terrain ?? TerrainType.MajorCity,
      name: c.name,
    });
  }
  mockLoadGridPoints.mockReturnValue(grid);
}

/** Sets up major city groups with specified cities */
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
    for (const o of g.outposts) {
      lookup.set(`${o.row},${o.col}`, g.cityName);
    }
  }
  mockGetMajorCityLookup.mockReturnValue(lookup);
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('ActionResolver', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Default empty setups
    setupGridPoints([]);
    setupMajorCityGroups([]);
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // resolveBuild (via resolve)
  // ═══════════════════════════════════════════════════════════════════════════

  describe('resolveBuild', () => {
    it('should return segments when build is valid', async () => {
      setupGridPoints([{ row: 10, col: 10, name: 'Berlin' }]);
      const builtSegments = [makeSegment(5, 6, 6, 6), makeSegment(6, 6, 7, 6)];
      mockComputeBuildSegments.mockReturnValue(builtSegments);

      const snapshot = makeWorldSnapshot();
      const context = makeGameContext();
      const intent = makeBuildIntent('Berlin');

      const result = await ActionResolver.resolve(intent, snapshot, context);

      expect(result.success).toBe(true);
      const plan = result.plan as TurnPlanBuildTrack;
      expect(plan.type).toBe(AIActionType.BuildTrack);
      expect(plan.segments).toBe(builtSegments);
    });

    it('should fail when no target city is specified', async () => {
      const intent: LLMActionIntent = {
        action: AIActionType.BuildTrack,
        details: {},
        reasoning: 'Build somewhere',
        planHorizon: 'short',
      };

      const result = await ActionResolver.resolve(intent, makeWorldSnapshot(), makeGameContext());

      expect(result.success).toBe(false);
      expect(result.error).toContain('BUILD requires');
    });

    it('should fail when target city is not found on the map', async () => {
      // Grid is empty, no city named "Atlantis"
      const result = await ActionResolver.resolve(
        makeBuildIntent('Atlantis'),
        makeWorldSnapshot(),
        makeGameContext(),
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('not found on the map');
    });

    it('should fail when bot has no money (budget=0)', async () => {
      setupGridPoints([{ row: 10, col: 10, name: 'Berlin' }]);
      const snapshot = makeWorldSnapshot({ bot: { money: 0 } as any });

      const result = await ActionResolver.resolve(
        makeBuildIntent('Berlin'),
        snapshot,
        makeGameContext(),
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('No budget');
    });

    it('should fail when computeBuildSegments returns empty', async () => {
      setupGridPoints([{ row: 10, col: 10, name: 'Berlin' }]);
      mockComputeBuildSegments.mockReturnValue([]);

      const result = await ActionResolver.resolve(
        makeBuildIntent('Berlin'),
        makeWorldSnapshot(),
        makeGameContext(),
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('Could not find a path');
    });

    it('should use track frontier as start positions when bot has track', async () => {
      setupGridPoints([{ row: 10, col: 10, name: 'Berlin' }]);
      const segments = [makeSegment(5, 5, 5, 6), makeSegment(5, 6, 6, 6)];
      const snapshot = makeWorldSnapshot({
        bot: { existingSegments: segments } as any,
      });
      mockComputeBuildSegments.mockReturnValue([makeSegment(6, 6, 7, 7)]);

      await ActionResolver.resolve(makeBuildIntent('Berlin'), snapshot, makeGameContext());

      // Verify computeBuildSegments was called with frontier positions (unique endpoints)
      const callArgs = mockComputeBuildSegments.mock.calls[0];
      const startPositions = callArgs[0] as GridCoord[];
      // Segments (5,5)-(5,6) and (5,6)-(6,6) have endpoints: (5,5), (5,6), (6,6)
      expect(startPositions).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ row: 5, col: 5 }),
          expect.objectContaining({ row: 5, col: 6 }),
          expect.objectContaining({ row: 6, col: 6 }),
        ]),
      );
    });

    it('should use major city centers for cold-start when bot has no track', async () => {
      setupGridPoints([{ row: 10, col: 10, name: 'Berlin' }]);
      setupMajorCityGroups([
        { cityName: 'Berlin', center: { row: 10, col: 10 } },
        { cityName: 'Paris', center: { row: 20, col: 5 } },
      ]);

      const snapshot = makeWorldSnapshot({
        bot: { existingSegments: [] } as any,
      });
      mockComputeBuildSegments.mockReturnValue([makeSegment(10, 10, 10, 11)]);

      await ActionResolver.resolve(makeBuildIntent('Berlin'), snapshot, makeGameContext());

      const startPositions = mockComputeBuildSegments.mock.calls[0][0] as GridCoord[];
      expect(startPositions).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ row: 10, col: 10 }),
          expect.objectContaining({ row: 20, col: 5 }),
        ]),
      );
    });

    it('should constrain cold-start to single city when valid startingCity is provided', async () => {
      setupGridPoints([{ row: 10, col: 10, name: 'Berlin' }]);
      setupMajorCityGroups([
        { cityName: 'Berlin', center: { row: 10, col: 10 }, outposts: [{ row: 10, col: 11 }] },
        { cityName: 'Paris', center: { row: 20, col: 5 } },
      ]);

      const snapshot = makeWorldSnapshot({
        bot: { existingSegments: [] } as any,
      });
      mockComputeBuildSegments.mockReturnValue([makeSegment(10, 10, 10, 11)]);

      await ActionResolver.resolve(makeBuildIntent('Berlin'), snapshot, makeGameContext(), 'Berlin');

      const startPositions = mockComputeBuildSegments.mock.calls[0][0] as GridCoord[];
      // Should include Berlin center + outpost, but NOT Paris
      expect(startPositions).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ row: 10, col: 10 }),
          expect.objectContaining({ row: 10, col: 11 }),
        ]),
      );
      expect(startPositions).not.toEqual(
        expect.arrayContaining([
          expect.objectContaining({ row: 20, col: 5 }),
        ]),
      );
    });

    it('should fall back to all major cities when startingCity is invalid', async () => {
      setupGridPoints([{ row: 10, col: 10, name: 'Berlin' }]);
      setupMajorCityGroups([
        { cityName: 'Berlin', center: { row: 10, col: 10 } },
        { cityName: 'Paris', center: { row: 20, col: 5 } },
      ]);

      const snapshot = makeWorldSnapshot({
        bot: { existingSegments: [] } as any,
      });
      mockComputeBuildSegments.mockReturnValue([makeSegment(10, 10, 10, 11)]);
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

      await ActionResolver.resolve(makeBuildIntent('Berlin'), snapshot, makeGameContext(), 'Atlantis');

      const startPositions = mockComputeBuildSegments.mock.calls[0][0] as GridCoord[];
      // Should include all major cities (fallback)
      expect(startPositions).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ row: 10, col: 10 }),
          expect.objectContaining({ row: 20, col: 5 }),
        ]),
      );
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('Invalid startingCity "Atlantis"'),
      );
      warnSpy.mockRestore();
    });

    it('should use all major cities for cold-start when no startingCity is provided', async () => {
      setupGridPoints([{ row: 10, col: 10, name: 'Berlin' }]);
      setupMajorCityGroups([
        { cityName: 'Berlin', center: { row: 10, col: 10 } },
        { cityName: 'Paris', center: { row: 20, col: 5 } },
      ]);

      const snapshot = makeWorldSnapshot({
        bot: { existingSegments: [] } as any,
      });
      mockComputeBuildSegments.mockReturnValue([makeSegment(10, 10, 10, 11)]);

      // No startingCity parameter
      await ActionResolver.resolve(makeBuildIntent('Berlin'), snapshot, makeGameContext());

      const startPositions = mockComputeBuildSegments.mock.calls[0][0] as GridCoord[];
      expect(startPositions).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ row: 10, col: 10 }),
          expect.objectContaining({ row: 20, col: 5 }),
        ]),
      );
    });

    it('should ignore startingCity when bot already has track', async () => {
      setupGridPoints([{ row: 10, col: 10, name: 'Berlin' }]);
      setupMajorCityGroups([
        { cityName: 'Berlin', center: { row: 10, col: 10 } },
        { cityName: 'Paris', center: { row: 20, col: 5 } },
      ]);

      const segments = [makeSegment(5, 5, 5, 6)];
      const snapshot = makeWorldSnapshot({
        bot: { existingSegments: segments } as any,
      });
      mockComputeBuildSegments.mockReturnValue([makeSegment(5, 6, 6, 6)]);

      // startingCity provided but bot has track — should use frontier, not city
      await ActionResolver.resolve(makeBuildIntent('Berlin'), snapshot, makeGameContext(), 'Berlin');

      const startPositions = mockComputeBuildSegments.mock.calls[0][0] as GridCoord[];
      // Should be track frontier endpoints, not major city centers
      expect(startPositions).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ row: 5, col: 5 }),
          expect.objectContaining({ row: 5, col: 6 }),
        ]),
      );
      // Should NOT include major city centers
      expect(startPositions).not.toEqual(
        expect.arrayContaining([
          expect.objectContaining({ row: 10, col: 10 }),
        ]),
      );
    });

    it('should pass budget as min(20, money) to computeBuildSegments', async () => {
      setupGridPoints([{ row: 10, col: 10, name: 'Berlin' }]);
      mockComputeBuildSegments.mockReturnValue([makeSegment(5, 6, 6, 6)]);

      // Bot with 15M should have budget=15 (less than TURN_BUILD_BUDGET=20)
      const snapshot = makeWorldSnapshot({ bot: { money: 15 } as any });

      await ActionResolver.resolve(makeBuildIntent('Berlin'), snapshot, makeGameContext());

      const budgetArg = mockComputeBuildSegments.mock.calls[0][2];
      expect(budgetArg).toBe(15);
    });

    it('should cap budget at 20M even with more money', async () => {
      setupGridPoints([{ row: 10, col: 10, name: 'Berlin' }]);
      mockComputeBuildSegments.mockReturnValue([makeSegment(5, 6, 6, 6)]);

      const snapshot = makeWorldSnapshot({ bot: { money: 100 } as any });

      await ActionResolver.resolve(makeBuildIntent('Berlin'), snapshot, makeGameContext());

      const budgetArg = mockComputeBuildSegments.mock.calls[0][2];
      expect(budgetArg).toBe(20);
    });

    it('should pass occupied edges from other players segments', async () => {
      setupGridPoints([{ row: 10, col: 10, name: 'Berlin' }]);
      mockComputeBuildSegments.mockReturnValue([makeSegment(5, 6, 6, 6)]);

      const snapshot = makeWorldSnapshot({
        allPlayerTracks: [
          { playerId: 'bot-1', segments: [makeSegment(5, 5, 5, 6)] },
          { playerId: 'opponent-1', segments: [makeSegment(3, 3, 3, 4)] },
        ],
      });

      await ActionResolver.resolve(makeBuildIntent('Berlin'), snapshot, makeGameContext());

      const occupiedEdges = mockComputeBuildSegments.mock.calls[0][4] as Set<string>;
      // Should include opponent edges, not bot edges
      expect(occupiedEdges.has('3,3-3,4')).toBe(true);
      expect(occupiedEdges.has('3,4-3,3')).toBe(true);
      // Should NOT include bot's own edges
      expect(occupiedEdges.has('5,5-5,6')).toBe(false);
    });

    it('should pass target positions to computeBuildSegments', async () => {
      setupGridPoints([
        { row: 10, col: 10, name: 'Berlin' },
        { row: 10, col: 11, name: 'Berlin' },
      ]);
      mockComputeBuildSegments.mockReturnValue([makeSegment(5, 6, 6, 6)]);

      await ActionResolver.resolve(
        makeBuildIntent('Berlin'),
        makeWorldSnapshot(),
        makeGameContext(),
      );

      const targetPositions = mockComputeBuildSegments.mock.calls[0][5] as GridCoord[];
      expect(targetPositions).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ row: 10, col: 10 }),
          expect.objectContaining({ row: 10, col: 11 }),
        ]),
      );
    });

    it('should find city via major city groups when not in grid points', async () => {
      // City not in grid points but IS in major city groups
      setupGridPoints([]);
      setupMajorCityGroups([
        {
          cityName: 'Berlin',
          center: { row: 10, col: 10 },
          outposts: [{ row: 10, col: 11 }, { row: 11, col: 10 }],
        },
      ]);
      mockComputeBuildSegments.mockReturnValue([makeSegment(5, 6, 6, 6)]);

      const result = await ActionResolver.resolve(
        makeBuildIntent('Berlin'),
        makeWorldSnapshot(),
        makeGameContext(),
      );

      expect(result.success).toBe(true);
      const targetPositions = mockComputeBuildSegments.mock.calls[0][5] as GridCoord[];
      expect(targetPositions.length).toBe(2); // outposts only (center excluded for BUILD)
    });

    it('should sort build targets by proximity to track frontier', async () => {
      // Two outposts: one close to frontier (row 6), one far (row 20)
      setupGridPoints([]);
      setupMajorCityGroups([
        {
          cityName: 'Berlin',
          center: { row: 13, col: 13 },
          outposts: [
            { row: 20, col: 20 }, // far outpost
            { row: 6, col: 6 },   // near outpost (close to bot track at 5,5→5,6)
          ],
        },
      ]);
      // Mock hexDistance to return realistic distances
      mockHexDistance.mockImplementation((r1, c1, r2, c2) => {
        // Simple Manhattan-like distance for testing
        return Math.abs(r1 - r2) + Math.abs(c1 - c2);
      });
      mockComputeBuildSegments.mockReturnValue([makeSegment(5, 6, 6, 6)]);

      await ActionResolver.resolve(
        makeBuildIntent('Berlin'),
        makeWorldSnapshot(),
        makeGameContext(),
      );

      const targetPositions = mockComputeBuildSegments.mock.calls[0][5] as GridCoord[];
      expect(targetPositions.length).toBe(2);
      // Near outpost (6,6) should come before far outpost (20,20) after sorting
      expect(targetPositions[0]).toEqual({ row: 6, col: 6 });
      expect(targetPositions[1]).toEqual({ row: 20, col: 20 });
    });

    it('should accept "BUILD" string as action alias', async () => {
      setupGridPoints([{ row: 10, col: 10, name: 'Berlin' }]);
      mockComputeBuildSegments.mockReturnValue([makeSegment(5, 6, 6, 6)]);

      const intent: LLMActionIntent = {
        action: 'BUILD',
        details: { toward: 'Berlin' },
        reasoning: 'Build',
        planHorizon: 'short',
      };

      const result = await ActionResolver.resolve(intent, makeWorldSnapshot(), makeGameContext());
      expect(result.success).toBe(true);
    });

    it('should accept details.target and details.city as alternatives to details.toward', async () => {
      setupGridPoints([{ row: 10, col: 10, name: 'Berlin' }]);
      mockComputeBuildSegments.mockReturnValue([makeSegment(5, 6, 6, 6)]);

      // Test details.target
      const intent1: LLMActionIntent = {
        action: AIActionType.BuildTrack,
        details: { target: 'Berlin' },
        reasoning: 'Build',
        planHorizon: 'short',
      };
      const result1 = await ActionResolver.resolve(intent1, makeWorldSnapshot(), makeGameContext());
      expect(result1.success).toBe(true);

      // Test details.city
      const intent2: LLMActionIntent = {
        action: AIActionType.BuildTrack,
        details: { city: 'Berlin' },
        reasoning: 'Build',
        planHorizon: 'short',
      };
      const result2 = await ActionResolver.resolve(intent2, makeWorldSnapshot(), makeGameContext());
      expect(result2.success).toBe(true);
    });

    it('should expand track frontier through major city red areas', async () => {
      setupGridPoints([{ row: 20, col: 20, name: 'München' }]);
      setupMajorCityGroups([
        {
          cityName: 'Berlin',
          center: { row: 10, col: 10 },
          outposts: [{ row: 10, col: 11 }, { row: 11, col: 10 }],
        },
      ]);
      mockComputeBuildSegments.mockReturnValue([makeSegment(10, 11, 12, 12)]);

      // Bot has track at Berlin center (10,10) — should expand to include outposts
      const snapshot = makeWorldSnapshot({
        bot: {
          existingSegments: [makeSegment(9, 9, 10, 10)],
        } as any,
      });

      await ActionResolver.resolve(makeBuildIntent('München'), snapshot, makeGameContext());

      const startPositions = mockComputeBuildSegments.mock.calls[0][0] as GridCoord[];
      // Should include (9,9), (10,10) from segment endpoints, plus (10,11) and (11,10) from red area expansion
      const posKeys = startPositions.map(p => `${p.row},${p.col}`);
      expect(posKeys).toContain('9,9');
      expect(posKeys).toContain('10,10');
      expect(posKeys).toContain('10,11');
      expect(posKeys).toContain('11,10');
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // resolveMove (via resolve)
  // ═══════════════════════════════════════════════════════════════════════════

  describe('resolveMove', () => {
    function makePathEdge(fromRow: number, fromCol: number, toRow: number, toCol: number, owners: string[] = []): PathEdge {
      return {
        from: { row: fromRow, col: fromCol },
        to: { row: toRow, col: toCol },
        ownerPlayerIds: owners,
      };
    }

    function makeValidUsage(
      path: PathEdge[],
      ownersUsed: string[] = [],
    ): TrackUsageComputation {
      return {
        isValid: true,
        path,
        ownersUsed: new Set(ownersUsed),
      };
    }

    function makeInvalidUsage(): TrackUsageComputation {
      return {
        isValid: false,
        errorMessage: 'No valid path',
        path: [],
        ownersUsed: new Set(),
      };
    }

    it('should return a valid move plan when path exists', async () => {
      setupGridPoints([{ row: 8, col: 8, name: 'Hamburg' }]);
      const path = [
        makePathEdge(5, 5, 6, 5),
        makePathEdge(6, 5, 7, 6),
        makePathEdge(7, 6, 8, 8),
      ];
      mockComputeTrackUsageForMove.mockReturnValue(makeValidUsage(path));

      const snapshot = makeWorldSnapshot();
      const result = await ActionResolver.resolve(
        makeMoveIntent('Hamburg'),
        snapshot,
        makeGameContext(),
      );

      expect(result.success).toBe(true);
      const plan = result.plan as TurnPlanMoveTrain;
      expect(plan.type).toBe(AIActionType.MoveTrain);
      expect(plan.path).toEqual([
        { row: 5, col: 5 },
        { row: 6, col: 5 },
        { row: 7, col: 6 },
        { row: 8, col: 8 },
      ]);
      expect(plan.totalFee).toBe(0);
    });

    it('should fail when no destination is specified', async () => {
      const intent: LLMActionIntent = {
        action: AIActionType.MoveTrain,
        details: {},
        reasoning: 'Move somewhere',
        planHorizon: 'short',
      };

      const result = await ActionResolver.resolve(intent, makeWorldSnapshot(), makeGameContext());

      expect(result.success).toBe(false);
      expect(result.error).toContain('MOVE requires');
    });

    it('should fail when bot has no position', async () => {
      setupGridPoints([{ row: 10, col: 10, name: 'Berlin' }]);
      const snapshot = makeWorldSnapshot({ bot: { position: null } as any });

      const result = await ActionResolver.resolve(
        makeMoveIntent('Berlin'),
        snapshot,
        makeGameContext(),
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('no position');
    });

    it('should fail when destination city is not found', async () => {
      const result = await ActionResolver.resolve(
        makeMoveIntent('Atlantis'),
        makeWorldSnapshot(),
        makeGameContext(),
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('not found on the map');
    });

    it('should fail when bot is already at the target city', async () => {
      setupGridPoints([{ row: 5, col: 5, name: 'TestCity' }]);

      const result = await ActionResolver.resolve(
        makeMoveIntent('TestCity'),
        makeWorldSnapshot(),
        makeGameContext(),
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('already at');
    });

    it('should fail when bot is at a major city outpost of the target', async () => {
      setupGridPoints([{ row: 10, col: 10, name: 'Berlin' }]);
      setupMajorCityGroups([
        {
          cityName: 'Berlin',
          center: { row: 10, col: 10 },
          outposts: [{ row: 5, col: 5 }],
        },
      ]);

      // Bot position (5,5) is an outpost of Berlin
      const result = await ActionResolver.resolve(
        makeMoveIntent('Berlin'),
        makeWorldSnapshot(),
        makeGameContext(),
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('already at');
    });

    it('should truncate path to speed limit for partial move', async () => {
      setupGridPoints([{ row: 20, col: 20, name: 'FarCity' }]);
      // Freight has speed 9, path has 10 edges — should truncate to 9
      const path: PathEdge[] = [];
      for (let i = 0; i < 10; i++) {
        path.push(makePathEdge(5 + i, 5, 6 + i, 5));
      }
      mockComputeTrackUsageForMove.mockReturnValue(makeValidUsage(path));

      const snapshot = makeWorldSnapshot(); // Freight, speed=9
      const result = await ActionResolver.resolve(
        makeMoveIntent('FarCity'),
        snapshot,
        makeGameContext(),
      );

      expect(result.success).toBe(true);
      const plan = result.plan as TurnPlanMoveTrain;
      // Path should be truncated: 9 edges + 1 start = 10 coords
      expect(plan.path.length).toBe(10);
    });

    it('should teleport to paired port and apply half speed when at ferry port (BE-006)', async () => {
      // Bot is at ferry port A (5,5). Ferry connects A(5,5) ↔ B(20,20).
      // resolveMove should teleport to B and compute path from there at half speed.
      setupGridPoints([
        { row: 5, col: 5, name: 'FerryPortA', terrain: TerrainType.FerryPort },
        { row: 20, col: 20, name: 'FerryPortB', terrain: TerrainType.FerryPort },
        { row: 25, col: 25, name: 'Target' },
      ]);

      // Path from the paired port (20,20) to target — 4 edges
      const path = Array.from({ length: 4 }, (_, i) =>
        makePathEdge(20 + i, 20, 21 + i, 20),
      );
      mockComputeTrackUsageForMove.mockReturnValue(makeValidUsage(path));

      const snapshot = makeWorldSnapshot({
        bot: { position: { row: 5, col: 5 } } as any,
        ferryEdges: [
          { name: 'TestFerry', pointA: { row: 5, col: 5 }, pointB: { row: 20, col: 20 }, cost: 4 },
        ],
      } as any);
      const result = await ActionResolver.resolve(
        makeMoveIntent('Target'),
        snapshot,
        makeGameContext(),
      );

      expect(result.success).toBe(true);
      // Verify pathfinding was called from the paired port, not the original position
      expect(mockComputeTrackUsageForMove).toHaveBeenCalledWith(
        expect.objectContaining({ from: { row: 20, col: 20 } }),
      );
    });

    it('should truncate path to halved speed during ferry crossing (BE-006)', async () => {
      // Bot is at ferry port. Freight speed=9, halved=ceil(9/2)=5.
      // Path with 6 edges should be truncated to 5.
      setupGridPoints([
        { row: 5, col: 5, name: 'FerryPortA', terrain: TerrainType.FerryPort },
        { row: 20, col: 20, name: 'FerryPortB', terrain: TerrainType.FerryPort },
        { row: 26, col: 20, name: 'Target' },
      ]);

      const path6 = Array.from({ length: 6 }, (_, i) =>
        makePathEdge(20 + i, 20, 21 + i, 20),
      );
      mockComputeTrackUsageForMove.mockReturnValue(makeValidUsage(path6));

      const snapshot = makeWorldSnapshot({
        bot: { position: { row: 5, col: 5 } } as any,
        ferryEdges: [
          { name: 'TestFerry', pointA: { row: 5, col: 5 }, pointB: { row: 20, col: 20 }, cost: 4 },
        ],
      } as any);
      const result = await ActionResolver.resolve(
        makeMoveIntent('Target'),
        snapshot,
        makeGameContext(),
      );

      expect(result.success).toBe(true);
      const plan = result.plan as TurnPlanMoveTrain;
      // Path should be truncated to half speed: 5 edges + 1 start = 6 coords
      expect(plan.path.length).toBe(6);
    });

    it('should truncate path at ferry port (FR-2)', async () => {
      // Path of 5 edges: start → 3 clear → ferry port → clear
      // Should truncate at step 4 (the ferry port)
      setupGridPoints([
        { row: 5, col: 5, name: 'Start' },
        { row: 9, col: 5, name: 'FerryA', terrain: TerrainType.FerryPort },
        { row: 10, col: 5, name: 'Target' },
      ]);
      const path = [
        makePathEdge(5, 5, 6, 5),
        makePathEdge(6, 5, 7, 5),
        makePathEdge(7, 5, 8, 5),
        makePathEdge(8, 5, 9, 5),  // step 4 → ferry port
        makePathEdge(9, 5, 10, 5),
      ];
      mockComputeTrackUsageForMove.mockReturnValue(makeValidUsage(path));

      const result = await ActionResolver.resolve(
        makeMoveIntent('Target'),
        makeWorldSnapshot(),
        makeGameContext(),
      );

      expect(result.success).toBe(true);
      const plan = result.plan as TurnPlanMoveTrain;
      // Path should stop at ferry port: start + 4 steps = 5 coords
      expect(plan.path.length).toBe(5);
      expect(plan.path[plan.path.length - 1]).toEqual({ row: 9, col: 5 });
    });

    it('should skip departure port in truncation after ferry crossing (BE-006)', async () => {
      // Bot is at ferry port A (5,5). Ferry connects A(5,5) ↔ B(20,20).
      // After teleportation, the path starts from B (20,20).
      // If the pathfinder routes through A (back across the ferry), the
      // truncation should NOT stop at A since it's the departure port.
      setupGridPoints([
        { row: 5, col: 5, name: 'FerryPortA', terrain: TerrainType.FerryPort },
        { row: 20, col: 20, name: 'FerryPortB', terrain: TerrainType.FerryPort },
        { row: 25, col: 25, name: 'Target' },
      ]);

      // Path from B that passes through the departure port A at step 1
      // B(20,20) → A(5,5) → (21,20) → (22,20)
      const path = [
        makePathEdge(20, 20, 5, 5),    // step 1: the departure port (should be skipped)
        makePathEdge(5, 5, 21, 20),     // step 2
        makePathEdge(21, 20, 22, 20),   // step 3
      ];
      mockComputeTrackUsageForMove.mockReturnValue(makeValidUsage(path));

      const snapshot = makeWorldSnapshot({
        bot: { position: { row: 5, col: 5 } } as any,
        ferryEdges: [
          { name: 'TestFerry', pointA: { row: 5, col: 5 }, pointB: { row: 20, col: 20 }, cost: 4 },
        ],
      } as any);
      const result = await ActionResolver.resolve(
        makeMoveIntent('Target'),
        snapshot,
        makeGameContext(),
      );

      expect(result.success).toBe(true);
      const plan = result.plan as TurnPlanMoveTrain;
      // Path should NOT be truncated at step 1 (departure port A) —
      // all 3 edges should be preserved (within half-speed limit of 5)
      expect(plan.path.length).toBe(4); // start + 3 edges
    });

    it('should NOT truncate path when no ferry port is present', async () => {
      setupGridPoints([{ row: 8, col: 8, name: 'Hamburg' }]);
      const path = [
        makePathEdge(5, 5, 6, 5),
        makePathEdge(6, 5, 7, 6),
        makePathEdge(7, 6, 8, 8),
      ];
      mockComputeTrackUsageForMove.mockReturnValue(makeValidUsage(path));

      const result = await ActionResolver.resolve(
        makeMoveIntent('Hamburg'),
        makeWorldSnapshot(),
        makeGameContext(),
      );

      expect(result.success).toBe(true);
      const plan = result.plan as TurnPlanMoveTrain;
      // Full path preserved: start + 3 steps = 4 coords
      expect(plan.path.length).toBe(4);
    });

    it('should fail when path is invalid (no route)', async () => {
      setupGridPoints([{ row: 10, col: 10, name: 'Berlin' }]);
      mockComputeTrackUsageForMove.mockReturnValue(makeInvalidUsage());

      const result = await ActionResolver.resolve(
        makeMoveIntent('Berlin'),
        makeWorldSnapshot(),
        makeGameContext(),
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('No valid path');
    });

    it('should calculate track usage fees for opponent track', async () => {
      setupGridPoints([{ row: 8, col: 8, name: 'Hamburg' }]);
      const path = [
        makePathEdge(5, 5, 6, 5, ['opponent-1']),
        makePathEdge(6, 5, 7, 6, ['opponent-1']),
        makePathEdge(7, 6, 8, 8),
      ];
      mockComputeTrackUsageForMove.mockReturnValue(
        makeValidUsage(path, ['opponent-1']),
      );

      const result = await ActionResolver.resolve(
        makeMoveIntent('Hamburg'),
        makeWorldSnapshot(),
        makeGameContext(),
      );

      expect(result.success).toBe(true);
      const plan = result.plan as TurnPlanMoveTrain;
      expect(plan.totalFee).toBe(TRACK_USAGE_FEE); // 4M per opponent
      expect(plan.fees.has('opponent-1')).toBe(true);
    });

    it('should fail when funds insufficient for fees + reserve', async () => {
      setupGridPoints([{ row: 8, col: 8, name: 'Hamburg' }]);
      const path = [makePathEdge(5, 5, 6, 5, ['opponent-1'])];
      mockComputeTrackUsageForMove.mockReturnValue(
        makeValidUsage(path, ['opponent-1']),
      );

      // Fee=4, reserve=5, need 9 total. Bot has 8.
      const snapshot = makeWorldSnapshot({ bot: { money: 8 } as any });
      const result = await ActionResolver.resolve(
        makeMoveIntent('Hamburg'),
        snapshot,
        makeGameContext(),
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('Insufficient funds');
    });

    it('should succeed when funds exactly cover fees + reserve', async () => {
      setupGridPoints([{ row: 8, col: 8, name: 'Hamburg' }]);
      const path = [makePathEdge(5, 5, 6, 5, ['opponent-1'])];
      mockComputeTrackUsageForMove.mockReturnValue(
        makeValidUsage(path, ['opponent-1']),
      );

      // Fee=4, reserve=5, need 9 total. Bot has 9.
      const snapshot = makeWorldSnapshot({ bot: { money: 9 } as any });
      const result = await ActionResolver.resolve(
        makeMoveIntent('Hamburg'),
        snapshot,
        makeGameContext(),
      );

      expect(result.success).toBe(true);
    });

    it('should skip fee check when no opponents used (totalFee=0)', async () => {
      setupGridPoints([{ row: 8, col: 8, name: 'Hamburg' }]);
      const path = [makePathEdge(5, 5, 6, 5)];
      mockComputeTrackUsageForMove.mockReturnValue(makeValidUsage(path));

      // Bot has very little money but no fees
      const snapshot = makeWorldSnapshot({ bot: { money: 1 } as any });
      const result = await ActionResolver.resolve(
        makeMoveIntent('Hamburg'),
        snapshot,
        makeGameContext(),
      );

      expect(result.success).toBe(true);
      const plan = result.plan as TurnPlanMoveTrain;
      expect(plan.totalFee).toBe(0);
    });

    it('should accept "MOVE" string as action alias', async () => {
      setupGridPoints([{ row: 8, col: 8, name: 'Hamburg' }]);
      mockComputeTrackUsageForMove.mockReturnValue(
        makeValidUsage([makePathEdge(5, 5, 6, 5)]),
      );

      const intent: LLMActionIntent = {
        action: 'MOVE',
        details: { to: 'Hamburg' },
        reasoning: 'Move',
        planHorizon: 'short',
      };

      const result = await ActionResolver.resolve(intent, makeWorldSnapshot(), makeGameContext());
      expect(result.success).toBe(true);
    });

    it('should accept details.toward and details.city as alternatives to details.to', async () => {
      setupGridPoints([{ row: 8, col: 8, name: 'Hamburg' }]);
      mockComputeTrackUsageForMove.mockReturnValue(
        makeValidUsage([makePathEdge(5, 5, 6, 5)]),
      );

      const intent1: LLMActionIntent = {
        action: AIActionType.MoveTrain,
        details: { toward: 'Hamburg' },
        reasoning: 'Move',
        planHorizon: 'short',
      };
      const result1 = await ActionResolver.resolve(intent1, makeWorldSnapshot(), makeGameContext());
      expect(result1.success).toBe(true);

      const intent2: LLMActionIntent = {
        action: AIActionType.MoveTrain,
        details: { city: 'Hamburg' },
        reasoning: 'Move',
        planHorizon: 'short',
      };
      const result2 = await ActionResolver.resolve(intent2, makeWorldSnapshot(), makeGameContext());
      expect(result2.success).toBe(true);
    });

    it('should pick shortest path among multiple target mileposts', async () => {
      // Berlin has two mileposts; one is closer
      setupGridPoints([
        { row: 6, col: 6, name: 'Berlin' },
        { row: 20, col: 20, name: 'Berlin' },
      ]);

      const shortPath = [makePathEdge(5, 5, 6, 6)]; // 1 edge
      const longPath = Array.from({ length: 5 }, (_, i) =>
        makePathEdge(5 + i, 5 + i, 6 + i, 6 + i),
      ); // 5 edges

      mockComputeTrackUsageForMove
        .mockReturnValueOnce(makeValidUsage(shortPath))
        .mockReturnValueOnce(makeValidUsage(longPath));

      const result = await ActionResolver.resolve(
        makeMoveIntent('Berlin'),
        makeWorldSnapshot(),
        makeGameContext(),
      );

      expect(result.success).toBe(true);
      const plan = result.plan as TurnPlanMoveTrain;
      // Should pick the 1-edge path → 2 nodes in path array
      expect(plan.path.length).toBe(2);
    });

    it('should pick the path with lower fees when lengths are equal', async () => {
      setupGridPoints([
        { row: 6, col: 6, name: 'Berlin' },
        { row: 7, col: 7, name: 'Berlin' },
      ]);

      const pathFree = [makePathEdge(5, 5, 6, 6)]; // no fees
      const pathExpensive = [makePathEdge(5, 5, 7, 7, ['opponent-1'])]; // has fees

      mockComputeTrackUsageForMove
        .mockReturnValueOnce(makeValidUsage(pathFree))
        .mockReturnValueOnce(makeValidUsage(pathExpensive, ['opponent-1']));

      const result = await ActionResolver.resolve(
        makeMoveIntent('Berlin'),
        makeWorldSnapshot(),
        makeGameContext(),
      );

      expect(result.success).toBe(true);
      const plan = result.plan as TurnPlanMoveTrain;
      expect(plan.totalFee).toBe(0); // picked the free path
    });

    it('should use FastFreight speed of 12', async () => {
      setupGridPoints([{ row: 17, col: 5, name: 'FarCity' }]);
      // 12-edge path, exactly at FastFreight speed
      const path = Array.from({ length: 12 }, (_, i) =>
        makePathEdge(5 + i, 5, 6 + i, 5),
      );
      mockComputeTrackUsageForMove.mockReturnValue(makeValidUsage(path));

      const snapshot = makeWorldSnapshot({
        bot: { trainType: TrainType.FastFreight } as any,
      });

      const result = await ActionResolver.resolve(
        makeMoveIntent('FarCity'),
        snapshot,
        makeGameContext(),
      );

      expect(result.success).toBe(true);
    });

    it('should calculate fees for multiple opponents', async () => {
      setupGridPoints([{ row: 8, col: 8, name: 'Hamburg' }]);
      const path = [
        makePathEdge(5, 5, 6, 5, ['opp-1']),
        makePathEdge(6, 5, 7, 6, ['opp-2']),
        makePathEdge(7, 6, 8, 8),
      ];
      mockComputeTrackUsageForMove.mockReturnValue(
        makeValidUsage(path, ['opp-1', 'opp-2']),
      );

      const result = await ActionResolver.resolve(
        makeMoveIntent('Hamburg'),
        makeWorldSnapshot(),
        makeGameContext(),
      );

      expect(result.success).toBe(true);
      const plan = result.plan as TurnPlanMoveTrain;
      expect(plan.totalFee).toBe(TRACK_USAGE_FEE * 2); // 4M * 2 opponents = 8M
      expect(plan.fees.has('opp-1')).toBe(true);
      expect(plan.fees.has('opp-2')).toBe(true);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // resolve dispatch
  // ═══════════════════════════════════════════════════════════════════════════

  describe('resolve dispatch', () => {
    it('should return error for unknown action type', async () => {
      const intent: LLMActionIntent = {
        action: 'TELEPORT',
        details: {},
        reasoning: 'Beam me up',
        planHorizon: 'short',
      };

      const result = await ActionResolver.resolve(intent, makeWorldSnapshot(), makeGameContext());

      expect(result.success).toBe(false);
      expect(result.error).toContain('Unknown action type');
      expect(result.error).toContain('TELEPORT');
    });

    it('should return error when intent has neither action nor actions', async () => {
      const intent: LLMActionIntent = {
        reasoning: 'Nothing',
        planHorizon: 'short',
      };

      const result = await ActionResolver.resolve(intent, makeWorldSnapshot(), makeGameContext());

      expect(result.success).toBe(false);
      expect(result.error).toContain("must specify 'action' or 'actions'");
    });

    it('should dispatch to resolveMultiAction when actions array provided', async () => {
      const intent: LLMActionIntent = {
        actions: [
          { action: 'BUILD', details: { toward: 'Berlin' } },
          { action: 'MOVE', details: { to: 'Berlin' } },
        ],
        reasoning: 'Multi',
        planHorizon: 'short',
      };

      const result = await ActionResolver.resolve(intent, makeWorldSnapshot(), makeGameContext());

      // Multi-action dispatches to resolveMultiAction which resolves each step;
      // BUILD fails because Berlin is not in the mocked grid
      expect(result.success).toBe(false);
      expect(result.error).toContain('Step 1 (BUILD) failed');
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // resolveDeliver (via resolve) — TEST-004
  // ═══════════════════════════════════════════════════════════════════════════

  describe('resolveDeliver', () => {
    function makeDeliverIntent(load: string, at: string): LLMActionIntent {
      return {
        action: AIActionType.DeliverLoad,
        details: { load, at },
        reasoning: 'Deliver load',
        planHorizon: 'short',
      };
    }

    function snapshotWithDemand(overrides: Partial<WorldSnapshot['bot']> = {}): WorldSnapshot {
      const resolvedDemands: ResolvedDemand[] = [
        {
          cardId: 42,
          demands: [
            { city: 'Berlin', loadType: 'Steel', payment: 15 },
            { city: 'Paris', loadType: 'Wine', payment: 10 },
          ],
        },
      ];
      return makeWorldSnapshot({
        bot: {
          position: { row: 10, col: 10 },
          loads: ['Steel'],
          resolvedDemands,
          ...overrides,
        } as any,
      });
    }

    beforeEach(() => {
      setupGridPoints([
        { row: 10, col: 10, name: 'Berlin' },
        { row: 20, col: 20, name: 'Paris' },
      ]);
    });

    it('should succeed when bot is at city, carrying load, and has matching demand', async () => {
      const snapshot = snapshotWithDemand();
      const result = await ActionResolver.resolve(
        makeDeliverIntent('Steel', 'Berlin'),
        snapshot,
        makeGameContext(),
      );

      expect(result.success).toBe(true);
      const plan = result.plan as TurnPlanDeliverLoad;
      expect(plan.type).toBe(AIActionType.DeliverLoad);
      expect(plan.load).toBe('Steel');
      expect(plan.city).toBe('Berlin');
      expect(plan.cardId).toBe(42);
      expect(plan.payout).toBe(15);
    });

    it('should fail when load or city missing from details', async () => {
      const intent: LLMActionIntent = {
        action: AIActionType.DeliverLoad,
        details: { load: 'Steel' }, // missing city
        reasoning: 'Deliver',
        planHorizon: 'short',
      };
      const result = await ActionResolver.resolve(intent, snapshotWithDemand(), makeGameContext());
      expect(result.success).toBe(false);
      expect(result.error).toContain('DELIVER requires');
    });

    it('should fail when bot is not at the delivery city', async () => {
      // Bot at (10,10) = Berlin, trying to deliver at Paris (20,20)
      const result = await ActionResolver.resolve(
        makeDeliverIntent('Wine', 'Paris'),
        snapshotWithDemand(),
        makeGameContext(),
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('not at');
    });

    it('should fail when bot is not carrying the load', async () => {
      const snapshot = snapshotWithDemand({ loads: ['Wine'] } as any);
      const result = await ActionResolver.resolve(
        makeDeliverIntent('Steel', 'Berlin'),
        snapshot,
        makeGameContext(),
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('not carrying');
    });

    it('should fail when no matching demand card exists', async () => {
      // Bot at Berlin with Oil, but no demand for Oil at Berlin
      const snapshot = snapshotWithDemand({ loads: ['Oil'] } as any);
      const result = await ActionResolver.resolve(
        makeDeliverIntent('Oil', 'Berlin'),
        snapshot,
        makeGameContext(),
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('No demand card');
    });

    it('should pick the highest-paying demand when multiple match', async () => {
      const resolvedDemands: ResolvedDemand[] = [
        { cardId: 10, demands: [{ city: 'Berlin', loadType: 'Steel', payment: 8 }] },
        { cardId: 20, demands: [{ city: 'Berlin', loadType: 'Steel', payment: 20 }] },
      ];
      const snapshot = makeWorldSnapshot({
        bot: {
          position: { row: 10, col: 10 },
          loads: ['Steel'],
          resolvedDemands,
        } as any,
      });

      const result = await ActionResolver.resolve(
        makeDeliverIntent('Steel', 'Berlin'),
        snapshot,
        makeGameContext(),
      );

      expect(result.success).toBe(true);
      const plan = result.plan as TurnPlanDeliverLoad;
      expect(plan.cardId).toBe(20);
      expect(plan.payout).toBe(20);
    });

    it('should accept "DELIVER" string as action alias', async () => {
      const intent: LLMActionIntent = {
        action: 'DELIVER',
        details: { load: 'Steel', at: 'Berlin' },
        reasoning: 'Deliver',
        planHorizon: 'short',
      };
      const result = await ActionResolver.resolve(intent, snapshotWithDemand(), makeGameContext());
      expect(result.success).toBe(true);
    });

    it('should accept details.city and details.to as alternatives to details.at', async () => {
      const intent1: LLMActionIntent = {
        action: AIActionType.DeliverLoad,
        details: { load: 'Steel', city: 'Berlin' },
        reasoning: 'Deliver',
        planHorizon: 'short',
      };
      expect((await ActionResolver.resolve(intent1, snapshotWithDemand(), makeGameContext())).success).toBe(true);

      const intent2: LLMActionIntent = {
        action: AIActionType.DeliverLoad,
        details: { load: 'Steel', to: 'Berlin' },
        reasoning: 'Deliver',
        planHorizon: 'short',
      };
      expect((await ActionResolver.resolve(intent2, snapshotWithDemand(), makeGameContext())).success).toBe(true);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // resolvePickup (via resolve)
  // ═══════════════════════════════════════════════════════════════════════════

  describe('resolvePickup', () => {
    function makePickupIntent(load: string, at: string): LLMActionIntent {
      return {
        action: AIActionType.PickupLoad,
        details: { load, at },
        reasoning: 'Pickup load',
        planHorizon: 'short',
      };
    }

    beforeEach(() => {
      setupGridPoints([
        { row: 5, col: 5, name: 'Ruhr', terrain: TerrainType.MediumCity },
      ]);
    });

    it('should succeed when all conditions are met', async () => {
      const snapshot = makeWorldSnapshot({
        bot: { position: { row: 5, col: 5 }, loads: [], trainType: TrainType.Freight } as any,
        loadAvailability: { Ruhr: ['Steel', 'Coal'] },
      });

      const result = await ActionResolver.resolve(
        makePickupIntent('Steel', 'Ruhr'),
        snapshot,
        makeGameContext(),
      );

      expect(result.success).toBe(true);
      const plan = result.plan as TurnPlanPickupLoad;
      expect(plan.type).toBe(AIActionType.PickupLoad);
      expect(plan.load).toBe('Steel');
      expect(plan.city).toBe('Ruhr');
    });

    it('should fail when load or city missing from details', async () => {
      const intent: LLMActionIntent = {
        action: AIActionType.PickupLoad,
        details: { at: 'Ruhr' }, // missing load
        reasoning: 'Pickup',
        planHorizon: 'short',
      };
      const result = await ActionResolver.resolve(intent, makeWorldSnapshot(), makeGameContext());
      expect(result.success).toBe(false);
      expect(result.error).toContain('PICKUP requires');
    });

    it('should fail when bot is not at the pickup city', async () => {
      // Bot at (5,5) = Ruhr, but trying to pick up from a different city
      setupGridPoints([
        { row: 5, col: 5, name: 'Ruhr' },
        { row: 20, col: 20, name: 'Essen' },
      ]);
      const snapshot = makeWorldSnapshot({
        loadAvailability: { Essen: ['Steel'] },
      });

      const result = await ActionResolver.resolve(
        makePickupIntent('Steel', 'Essen'),
        snapshot,
        makeGameContext(),
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('not at');
    });

    it('should fail when train is at capacity (Freight, 2 loads)', async () => {
      const snapshot = makeWorldSnapshot({
        bot: {
          position: { row: 5, col: 5 },
          loads: ['Coal', 'Wine'],
          trainType: TrainType.Freight,
        } as any,
        loadAvailability: { Ruhr: ['Steel'] },
      });

      const result = await ActionResolver.resolve(
        makePickupIntent('Steel', 'Ruhr'),
        snapshot,
        makeGameContext(),
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('full');
    });

    it('should allow 3rd load on HeavyFreight', async () => {
      const snapshot = makeWorldSnapshot({
        bot: {
          position: { row: 5, col: 5 },
          loads: ['Coal', 'Wine'],
          trainType: TrainType.HeavyFreight,
        } as any,
        loadAvailability: { Ruhr: ['Steel'] },
      });

      const result = await ActionResolver.resolve(
        makePickupIntent('Steel', 'Ruhr'),
        snapshot,
        makeGameContext(),
      );

      expect(result.success).toBe(true);
    });

    it('should fail when city does not produce the load', async () => {
      const snapshot = makeWorldSnapshot({
        bot: { position: { row: 5, col: 5 }, loads: [] } as any,
        loadAvailability: { Ruhr: ['Coal'] }, // Ruhr has Coal, not Steel
      });

      const result = await ActionResolver.resolve(
        makePickupIntent('Steel', 'Ruhr'),
        snapshot,
        makeGameContext(),
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('does not produce');
    });

    it('should fail when city has no loadAvailability entry', async () => {
      const snapshot = makeWorldSnapshot({
        bot: { position: { row: 5, col: 5 }, loads: [] } as any,
        loadAvailability: {}, // no entry for Ruhr
      });

      const result = await ActionResolver.resolve(
        makePickupIntent('Steel', 'Ruhr'),
        snapshot,
        makeGameContext(),
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('does not produce');
    });

    it('should accept "PICKUP" string as action alias', async () => {
      const snapshot = makeWorldSnapshot({
        bot: { position: { row: 5, col: 5 }, loads: [] } as any,
        loadAvailability: { Ruhr: ['Steel'] },
      });

      const intent: LLMActionIntent = {
        action: 'PICKUP',
        details: { load: 'Steel', at: 'Ruhr' },
        reasoning: 'Pickup',
        planHorizon: 'short',
      };
      const result = await ActionResolver.resolve(intent, snapshot, makeGameContext());
      expect(result.success).toBe(true);
    });

    it('should accept details.city and details.from as alternatives to details.at', async () => {
      const snapshot = makeWorldSnapshot({
        bot: { position: { row: 5, col: 5 }, loads: [] } as any,
        loadAvailability: { Ruhr: ['Steel'] },
      });

      const intent1: LLMActionIntent = {
        action: AIActionType.PickupLoad,
        details: { load: 'Steel', city: 'Ruhr' },
        reasoning: 'Pickup',
        planHorizon: 'short',
      };
      expect((await ActionResolver.resolve(intent1, snapshot, makeGameContext())).success).toBe(true);

      const intent2: LLMActionIntent = {
        action: AIActionType.PickupLoad,
        details: { load: 'Steel', from: 'Ruhr' },
        reasoning: 'Pickup',
        planHorizon: 'short',
      };
      expect((await ActionResolver.resolve(intent2, snapshot, makeGameContext())).success).toBe(true);
    });

    it('should reject speculative pickup when no demand card matches (FR-4)', async () => {
      const snapshot = makeWorldSnapshot({
        bot: {
          position: { row: 5, col: 5 },
          loads: [],
          resolvedDemands: [
            { cardId: 1, demands: [{ city: 'Paris', loadType: 'Wine', payment: 25 }] },
          ],
        } as any,
        loadAvailability: { Ruhr: ['Steel'] },
      });

      const result = await ActionResolver.resolve(
        makePickupIntent('Steel', 'Ruhr'),
        snapshot,
        makeGameContext(),
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('No demand card');
    });

    it('should allow pickup when demand card matches the load type (FR-4)', async () => {
      const snapshot = makeWorldSnapshot({
        bot: {
          position: { row: 5, col: 5 },
          loads: [],
          resolvedDemands: [
            { cardId: 1, demands: [{ city: 'Berlin', loadType: 'Steel', payment: 20 }] },
          ],
        } as any,
        loadAvailability: { Ruhr: ['Steel'] },
      });

      const context = makeGameContext({
        demands: [{
          cardIndex: 1,
          loadType: 'Steel',
          supplyCity: 'Ruhr',
          deliveryCity: 'Berlin',
          payout: 20,
          isSupplyReachable: true,
          isDeliveryOnNetwork: true,
          isDeliveryReachable: true,
          isSupplyOnNetwork: true,
          isLoadOnTrain: false,
          isLoadAvailable: true,
          ferryRequired: false,
          estimatedTrackCostToSupply: 0,
          estimatedTrackCostToDelivery: 0,
          loadChipTotal: 4, loadChipCarried: 0, estimatedTurns: 0,
          demandScore: 0, networkCitiesUnlocked: 0, victoryMajorCitiesEnRoute: 0,
        }] as DemandContext[],
      });

      const result = await ActionResolver.resolve(
        makePickupIntent('Steel', 'Ruhr'),
        snapshot,
        context,
      );

      expect(result.success).toBe(true);
      const plan = result.plan as TurnPlanPickupLoad;
      expect(plan.load).toBe('Steel');
    });

    it('should reject pickup when delivery is infeasible (FR-6)', async () => {
      // Bot has 10M, delivery city costs 50M to build to and is not on network
      const snapshot = makeWorldSnapshot({
        bot: {
          position: { row: 5, col: 5 },
          loads: [],
          money: 10,
          resolvedDemands: [
            { cardId: 1, demands: [{ city: 'London', loadType: 'Steel', payment: 20 }] },
          ],
        } as any,
        loadAvailability: { Ruhr: ['Steel'] },
      });

      const context = makeGameContext({
        money: 10,
        demands: [{
          cardIndex: 1,
          loadType: 'Steel',
          supplyCity: 'Ruhr',
          deliveryCity: 'London',
          payout: 20,
          isSupplyReachable: true,
          isDeliveryOnNetwork: false,
          isDeliveryReachable: false,
          isSupplyOnNetwork: true,
          isLoadOnTrain: false,
          isLoadAvailable: true,
          ferryRequired: false,
          estimatedTrackCostToSupply: 0,
          estimatedTrackCostToDelivery: 50,
          loadChipTotal: 4, loadChipCarried: 0, estimatedTurns: 0,
          demandScore: 0, networkCitiesUnlocked: 0, victoryMajorCitiesEnRoute: 0,
        }] as DemandContext[],
      });

      const result = await ActionResolver.resolve(
        makePickupIntent('Steel', 'Ruhr'),
        snapshot,
        context,
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('not reachable within budget');
    });

    it('should allow pickup when delivery city is on network even if build cost is high (FR-6)', async () => {
      const snapshot = makeWorldSnapshot({
        bot: {
          position: { row: 5, col: 5 },
          loads: [],
          money: 10,
          resolvedDemands: [
            { cardId: 1, demands: [{ city: 'Berlin', loadType: 'Steel', payment: 20 }] },
          ],
        } as any,
        loadAvailability: { Ruhr: ['Steel'] },
      });

      const context = makeGameContext({
        money: 10,
        demands: [{
          cardIndex: 1,
          loadType: 'Steel',
          supplyCity: 'Ruhr',
          deliveryCity: 'Berlin',
          payout: 20,
          isSupplyReachable: true,
          isDeliveryOnNetwork: true,
          isDeliveryReachable: true,
          isSupplyOnNetwork: true,
          isLoadOnTrain: false,
          isLoadAvailable: true,
          ferryRequired: false,
          estimatedTrackCostToSupply: 0,
          estimatedTrackCostToDelivery: 50,
          loadChipTotal: 4, loadChipCarried: 0, estimatedTurns: 0,
          demandScore: 0, networkCitiesUnlocked: 0, victoryMajorCitiesEnRoute: 0,
        }] as DemandContext[],
      });

      const result = await ActionResolver.resolve(
        makePickupIntent('Steel', 'Ruhr'),
        snapshot,
        context,
      );

      expect(result.success).toBe(true);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // resolveDropLoad (via resolve)
  // ═══════════════════════════════════════════════════════════════════════════

  describe('resolveDropLoad', () => {
    function makeDropIntent(load: string, at?: string): LLMActionIntent {
      return {
        action: AIActionType.DropLoad,
        details: at ? { load, at } : { load },
        reasoning: 'Drop load',
        planHorizon: 'short',
      };
    }

    beforeEach(() => {
      setupGridPoints([
        { row: 5, col: 5, name: 'Ruhr', terrain: TerrainType.MediumCity },
      ]);
    });

    it('should succeed when bot carries the load and is at a city', async () => {
      const snapshot = makeWorldSnapshot({
        bot: { position: { row: 5, col: 5 }, loads: ['Coal'] } as any,
      });

      const result = await ActionResolver.resolve(
        makeDropIntent('Coal', 'Ruhr'),
        snapshot,
        makeGameContext(),
      );

      expect(result.success).toBe(true);
      const plan = result.plan as TurnPlanDropLoad;
      expect(plan.type).toBe(AIActionType.DropLoad);
      expect(plan.load).toBe('Coal');
      expect(plan.city).toBe('Ruhr');
    });

    it('should resolve city from bot position when not explicitly specified', async () => {
      const snapshot = makeWorldSnapshot({
        bot: { position: { row: 5, col: 5 }, loads: ['Coal'] } as any,
      });

      const result = await ActionResolver.resolve(
        makeDropIntent('Coal'),
        snapshot,
        makeGameContext(),
      );

      expect(result.success).toBe(true);
      const plan = result.plan as TurnPlanDropLoad;
      expect(plan.city).toBe('Ruhr');
    });

    it('should fail when bot does not carry the specified load', async () => {
      const snapshot = makeWorldSnapshot({
        bot: { position: { row: 5, col: 5 }, loads: ['Wine'] } as any,
      });

      const result = await ActionResolver.resolve(
        makeDropIntent('Coal', 'Ruhr'),
        snapshot,
        makeGameContext(),
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('not carrying');
    });

    it('should fail when bot is not at the specified city', async () => {
      setupGridPoints([
        { row: 5, col: 5, name: 'Ruhr' },
        { row: 20, col: 20, name: 'Berlin' },
      ]);
      const snapshot = makeWorldSnapshot({
        bot: { position: { row: 5, col: 5 }, loads: ['Coal'] } as any,
      });

      const result = await ActionResolver.resolve(
        makeDropIntent('Coal', 'Berlin'),
        snapshot,
        makeGameContext(),
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('not at');
    });

    it('should fail when load type is missing from details', async () => {
      const intent: LLMActionIntent = {
        action: AIActionType.DropLoad,
        details: { at: 'Ruhr' },
        reasoning: 'Drop',
        planHorizon: 'short',
      };

      const result = await ActionResolver.resolve(
        intent,
        makeWorldSnapshot({ bot: { position: { row: 5, col: 5 }, loads: ['Coal'] } as any }),
        makeGameContext(),
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('DROP requires');
    });

    it('should fail when bot is not at any named city', async () => {
      // Position at a point not in the grid
      setupGridPoints([]); // no cities
      const snapshot = makeWorldSnapshot({
        bot: { position: { row: 99, col: 99 }, loads: ['Coal'] } as any,
      });

      const result = await ActionResolver.resolve(
        makeDropIntent('Coal'),
        snapshot,
        makeGameContext(),
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('not at a named city');
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // resolveUpgrade (via resolve)
  // ═══════════════════════════════════════════════════════════════════════════

  describe('resolveUpgrade', () => {
    function makeUpgradeIntent(to: string): LLMActionIntent {
      return {
        action: AIActionType.UpgradeTrain,
        details: { to },
        reasoning: 'Upgrade train',
        planHorizon: 'short',
      };
    }

    it('should succeed for Freight -> FastFreight with 20M', async () => {
      const snapshot = makeWorldSnapshot({
        bot: { trainType: TrainType.Freight, money: 25 } as any,
      });

      const result = await ActionResolver.resolve(
        makeUpgradeIntent(TrainType.FastFreight),
        snapshot,
        makeGameContext(),
      );

      expect(result.success).toBe(true);
      const plan = result.plan as TurnPlanUpgradeTrain;
      expect(plan.type).toBe(AIActionType.UpgradeTrain);
      expect(plan.targetTrain).toBe(TrainType.FastFreight);
      expect(plan.cost).toBe(20);
    });

    it('should succeed for Freight -> HeavyFreight with 20M', async () => {
      const snapshot = makeWorldSnapshot({
        bot: { trainType: TrainType.Freight, money: 20 } as any,
      });

      const result = await ActionResolver.resolve(
        makeUpgradeIntent(TrainType.HeavyFreight),
        snapshot,
        makeGameContext(),
      );

      expect(result.success).toBe(true);
      const plan = result.plan as TurnPlanUpgradeTrain;
      expect(plan.cost).toBe(20);
    });

    it('should succeed for FastFreight -> Superfreight with 20M', async () => {
      const snapshot = makeWorldSnapshot({
        bot: { trainType: TrainType.FastFreight, money: 50 } as any,
      });

      const result = await ActionResolver.resolve(
        makeUpgradeIntent(TrainType.Superfreight),
        snapshot,
        makeGameContext(),
      );

      expect(result.success).toBe(true);
      const plan = result.plan as TurnPlanUpgradeTrain;
      expect(plan.cost).toBe(20);
    });

    it('should succeed for crossgrade FastFreight -> HeavyFreight with 5M', async () => {
      const snapshot = makeWorldSnapshot({
        bot: { trainType: TrainType.FastFreight, money: 10 } as any,
      });

      const result = await ActionResolver.resolve(
        makeUpgradeIntent(TrainType.HeavyFreight),
        snapshot,
        makeGameContext(),
      );

      expect(result.success).toBe(true);
      const plan = result.plan as TurnPlanUpgradeTrain;
      expect(plan.cost).toBe(5);
    });

    it('should succeed for crossgrade HeavyFreight -> FastFreight with 5M', async () => {
      const snapshot = makeWorldSnapshot({
        bot: { trainType: TrainType.HeavyFreight, money: 5 } as any,
      });

      const result = await ActionResolver.resolve(
        makeUpgradeIntent(TrainType.FastFreight),
        snapshot,
        makeGameContext(),
      );

      expect(result.success).toBe(true);
      const plan = result.plan as TurnPlanUpgradeTrain;
      expect(plan.cost).toBe(5);
    });

    it('should fail when target is not specified', async () => {
      const intent: LLMActionIntent = {
        action: AIActionType.UpgradeTrain,
        details: {},
        reasoning: 'Upgrade',
        planHorizon: 'short',
      };

      const result = await ActionResolver.resolve(intent, makeWorldSnapshot(), makeGameContext());
      expect(result.success).toBe(false);
      expect(result.error).toContain('UPGRADE requires');
    });

    it('should fail for invalid upgrade path (Freight -> Superfreight)', async () => {
      const snapshot = makeWorldSnapshot({
        bot: { trainType: TrainType.Freight, money: 50 } as any,
      });

      const result = await ActionResolver.resolve(
        makeUpgradeIntent(TrainType.Superfreight),
        snapshot,
        makeGameContext(),
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('Cannot upgrade');
    });

    it('should fail for Superfreight (no further upgrades)', async () => {
      const snapshot = makeWorldSnapshot({
        bot: { trainType: TrainType.Superfreight, money: 50 } as any,
      });

      const result = await ActionResolver.resolve(
        makeUpgradeIntent(TrainType.FastFreight),
        snapshot,
        makeGameContext(),
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('Cannot upgrade');
    });

    it('should fail when insufficient funds', async () => {
      const snapshot = makeWorldSnapshot({
        bot: { trainType: TrainType.Freight, money: 15 } as any,
      });

      const result = await ActionResolver.resolve(
        makeUpgradeIntent(TrainType.FastFreight),
        snapshot,
        makeGameContext(),
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('Insufficient funds');
    });

    it('should accept "UPGRADE" string as action alias', async () => {
      const snapshot = makeWorldSnapshot({
        bot: { trainType: TrainType.Freight, money: 20 } as any,
      });
      const intent: LLMActionIntent = {
        action: 'UPGRADE',
        details: { to: TrainType.FastFreight },
        reasoning: 'Upgrade',
        planHorizon: 'short',
      };
      const result = await ActionResolver.resolve(intent, snapshot, makeGameContext());
      expect(result.success).toBe(true);
    });

    it('should accept details.train and details.target as alternatives to details.to', async () => {
      const snapshot = makeWorldSnapshot({
        bot: { trainType: TrainType.Freight, money: 20 } as any,
      });

      const intent1: LLMActionIntent = {
        action: AIActionType.UpgradeTrain,
        details: { train: TrainType.FastFreight },
        reasoning: 'Upgrade',
        planHorizon: 'short',
      };
      expect((await ActionResolver.resolve(intent1, snapshot, makeGameContext())).success).toBe(true);

      const intent2: LLMActionIntent = {
        action: AIActionType.UpgradeTrain,
        details: { target: TrainType.HeavyFreight },
        reasoning: 'Upgrade',
        planHorizon: 'short',
      };
      expect((await ActionResolver.resolve(intent2, snapshot, makeGameContext())).success).toBe(true);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // resolveDiscard (via resolve)
  // ═══════════════════════════════════════════════════════════════════════════

  describe('resolveDiscard', () => {
    it('should always succeed', async () => {
      const intent: LLMActionIntent = {
        action: AIActionType.DiscardHand,
        details: {},
        reasoning: 'Bad cards',
        planHorizon: 'short',
      };

      const result = await ActionResolver.resolve(intent, makeWorldSnapshot(), makeGameContext());

      expect(result.success).toBe(true);
      const plan = result.plan as TurnPlanDiscardHand;
      expect(plan.type).toBe(AIActionType.DiscardHand);
    });

    it('should accept "DISCARD_HAND" string as action alias', async () => {
      const intent: LLMActionIntent = {
        action: 'DISCARD_HAND',
        details: {},
        reasoning: 'Bad cards',
        planHorizon: 'short',
      };

      const result = await ActionResolver.resolve(intent, makeWorldSnapshot(), makeGameContext());
      expect(result.success).toBe(true);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // resolvePass (via resolve)
  // ═══════════════════════════════════════════════════════════════════════════

  describe('resolvePass', () => {
    it('should always succeed', async () => {
      const intent: LLMActionIntent = {
        action: AIActionType.PassTurn,
        details: {},
        reasoning: 'Nothing to do',
        planHorizon: 'short',
      };

      const result = await ActionResolver.resolve(intent, makeWorldSnapshot(), makeGameContext());

      expect(result.success).toBe(true);
      const plan = result.plan as TurnPlanPassTurn;
      expect(plan.type).toBe(AIActionType.PassTurn);
    });

    it('should accept "PASS" string as action alias', async () => {
      const intent: LLMActionIntent = {
        action: 'PASS',
        details: {},
        reasoning: 'Pass',
        planHorizon: 'short',
      };

      const result = await ActionResolver.resolve(intent, makeWorldSnapshot(), makeGameContext());
      expect(result.success).toBe(true);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // heuristicFallback
  // ═══════════════════════════════════════════════════════════════════════════

  describe('heuristicFallback', () => {
    it('should deliver if canDeliver has opportunities', async () => {
      setupGridPoints([{ row: 5, col: 5, name: 'Berlin' }]);
      const snapshot = makeWorldSnapshot({
        bot: {
          position: { row: 5, col: 5 },
          loads: ['Steel'],
          resolvedDemands: [
            { cardId: 42, demands: [{ city: 'Berlin', loadType: 'Steel', payment: 15 }] },
          ],
        } as any,
      });

      const context = makeGameContext({
        canDeliver: [
          { loadType: 'Steel', deliveryCity: 'Berlin', payout: 15, cardIndex: 0 },
        ],
      });

      const result = await ActionResolver.heuristicFallback(context, snapshot);

      expect(result.success).toBe(true);
      const plan = result.plan as TurnPlanDeliverLoad;
      expect(plan.type).toBe(AIActionType.DeliverLoad);
      expect(plan.load).toBe('Steel');
    });

    it('should pick highest-payout delivery from canDeliver', async () => {
      setupGridPoints([{ row: 5, col: 5, name: 'Berlin' }]);
      const snapshot = makeWorldSnapshot({
        bot: {
          position: { row: 5, col: 5 },
          loads: ['Steel', 'Wine'],
          resolvedDemands: [
            { cardId: 42, demands: [
              { city: 'Berlin', loadType: 'Steel', payment: 10 },
              { city: 'Berlin', loadType: 'Wine', payment: 20 },
            ]},
          ],
        } as any,
      });

      const context = makeGameContext({
        canDeliver: [
          { loadType: 'Steel', deliveryCity: 'Berlin', payout: 10, cardIndex: 0 },
          { loadType: 'Wine', deliveryCity: 'Berlin', payout: 20, cardIndex: 0 },
        ],
      });

      const result = await ActionResolver.heuristicFallback(context, snapshot);

      expect(result.success).toBe(true);
      const plan = result.plan as TurnPlanDeliverLoad;
      expect(plan.load).toBe('Wine'); // picked higher payout
    });

    it('should try building toward supply city when load not on train', async () => {
      setupGridPoints([
        { row: 5, col: 5, name: 'HomeCity' },
        { row: 20, col: 20, name: 'SupplyCity' },
        { row: 30, col: 30, name: 'DeliveryCity' },
      ]);
      mockComputeBuildSegments.mockReturnValue([makeSegment(5, 5, 6, 6)]);

      const snapshot = makeWorldSnapshot({
        bot: { position: { row: 5, col: 5 }, loads: [] } as any,
      });

      const context = makeGameContext({
        canDeliver: [],
        canBuild: true,
        demands: [
          {
            cardIndex: 0,
            loadType: 'Steel',
            supplyCity: 'SupplyCity',
            deliveryCity: 'DeliveryCity',
            payout: 15,
            isSupplyReachable: false,
            isDeliveryReachable: false,
            isSupplyOnNetwork: false,
            isDeliveryOnNetwork: false,
            estimatedTrackCostToSupply: 10,
            estimatedTrackCostToDelivery: 20,
            isLoadAvailable: true,
            isLoadOnTrain: false,
            ferryRequired: false,
            loadChipTotal: 4, loadChipCarried: 0, estimatedTurns: 0,
            demandScore: 0, networkCitiesUnlocked: 0, victoryMajorCitiesEnRoute: 0,
          },
        ],
      });

      const result = await ActionResolver.heuristicFallback(context, snapshot);

      expect(result.success).toBe(true);
      const plan = result.plan as TurnPlanBuildTrack;
      expect(plan.type).toBe(AIActionType.BuildTrack);
    });

    it('should try building toward delivery city when supply is reachable', async () => {
      setupGridPoints([
        { row: 20, col: 20, name: 'DeliveryCity' },
      ]);
      mockComputeBuildSegments.mockReturnValue([makeSegment(5, 5, 6, 6)]);

      const snapshot = makeWorldSnapshot();

      const context = makeGameContext({
        canDeliver: [],
        canBuild: true,
        demands: [
          {
            cardIndex: 0,
            loadType: 'Steel',
            supplyCity: 'SupplyCity',
            deliveryCity: 'DeliveryCity',
            payout: 15,
            isSupplyReachable: true,
            isDeliveryReachable: false,
            isSupplyOnNetwork: false,
            isDeliveryOnNetwork: false,
            estimatedTrackCostToSupply: 0,
            estimatedTrackCostToDelivery: 10,
            isLoadAvailable: true,
            isLoadOnTrain: true,
            ferryRequired: false,
            loadChipTotal: 4, loadChipCarried: 0, estimatedTurns: 0,
            demandScore: 0, networkCitiesUnlocked: 0, victoryMajorCitiesEnRoute: 0,
          },
        ],
      });

      const result = await ActionResolver.heuristicFallback(context, snapshot);

      expect(result.success).toBe(true);
      const plan = result.plan as TurnPlanBuildTrack;
      expect(plan.type).toBe(AIActionType.BuildTrack);
    });

    it('should fall back to PASS when no delivery or build succeeds', async () => {
      const context = makeGameContext({
        canDeliver: [],
        canBuild: false,
        demands: [],
      });

      const result = await ActionResolver.heuristicFallback(context, makeWorldSnapshot());

      expect(result.success).toBe(true);
      const plan = result.plan as TurnPlanPassTurn;
      expect(plan.type).toBe(AIActionType.PassTurn);
    });

    it('should fall back to PASS when build fails for all demands', async () => {
      setupGridPoints([{ row: 20, col: 20, name: 'FarCity' }]);
      mockComputeBuildSegments.mockReturnValue([]); // build always fails

      const context = makeGameContext({
        canDeliver: [],
        canBuild: true,
        demands: [
          {
            cardIndex: 0,
            loadType: 'Steel',
            supplyCity: 'FarCity',
            deliveryCity: 'FarCity',
            payout: 15,
            isSupplyReachable: true,
            isDeliveryReachable: false,
            isSupplyOnNetwork: false,
            isDeliveryOnNetwork: false,
            estimatedTrackCostToSupply: 0,
            estimatedTrackCostToDelivery: 10,
            isLoadAvailable: true,
            isLoadOnTrain: true,
            ferryRequired: false,
            loadChipTotal: 4, loadChipCarried: 0, estimatedTurns: 0,
            demandScore: 0, networkCitiesUnlocked: 0, victoryMajorCitiesEnRoute: 0,
          },
        ],
      });

      const result = await ActionResolver.heuristicFallback(context, makeWorldSnapshot());

      expect(result.success).toBe(true);
      const plan = result.plan as TurnPlanPassTurn;
      expect(plan.type).toBe(AIActionType.PassTurn);
    });

    it('should sort demands by cheapest track cost first for build', async () => {
      setupGridPoints([
        { row: 20, col: 20, name: 'CheapCity' },
        { row: 30, col: 30, name: 'ExpensiveCity' },
      ]);
      // Only succeed for the first call (cheapest track cost should be tried first)
      mockComputeBuildSegments
        .mockReturnValueOnce([makeSegment(5, 5, 6, 6)])
        .mockReturnValue([]);

      const context = makeGameContext({
        canDeliver: [],
        canBuild: true,
        demands: [
          {
            cardIndex: 0, loadType: 'Coal', supplyCity: 'A', deliveryCity: 'CheapCity',
            payout: 5, isSupplyReachable: true, isDeliveryReachable: false,
            isSupplyOnNetwork: false, isDeliveryOnNetwork: false,
            estimatedTrackCostToSupply: 0, estimatedTrackCostToDelivery: 10,
            isLoadAvailable: true, isLoadOnTrain: true, ferryRequired: false,
            loadChipTotal: 4, loadChipCarried: 0, estimatedTurns: 0,
            demandScore: 0, networkCitiesUnlocked: 0, victoryMajorCitiesEnRoute: 0,
          },
          {
            cardIndex: 1, loadType: 'Gold', supplyCity: 'B', deliveryCity: 'ExpensiveCity',
            payout: 25, isSupplyReachable: true, isDeliveryReachable: false,
            isSupplyOnNetwork: false, isDeliveryOnNetwork: false,
            estimatedTrackCostToSupply: 0, estimatedTrackCostToDelivery: 15,
            isLoadAvailable: true, isLoadOnTrain: true, ferryRequired: false,
            loadChipTotal: 4, loadChipCarried: 0, estimatedTurns: 0,
            demandScore: 0, networkCitiesUnlocked: 0, victoryMajorCitiesEnRoute: 0,
          },
        ],
      });

      const result = await ActionResolver.heuristicFallback(context, makeWorldSnapshot());

      expect(result.success).toBe(true);
      // The build should have targeted CheapCity first (cheapest track cost=10)
      const callTargets = mockComputeBuildSegments.mock.calls.map(
        call => (call[5] as GridCoord[])?.[0],
      );
      expect(callTargets[0]).toEqual(expect.objectContaining({ row: 20, col: 20 }));
    });

    it('should discard hand when all demands are unachievable within budget', async () => {
      const context = makeGameContext({
        canDeliver: [],
        canPickup: [],
        canBuild: true,
        isInitialBuild: false,
        demands: [
          {
            cardIndex: 0, loadType: 'Steel', supplyCity: 'FarA', deliveryCity: 'FarB',
            payout: 25, isSupplyReachable: false, isDeliveryReachable: false,
            isSupplyOnNetwork: false, isDeliveryOnNetwork: false,
            estimatedTrackCostToSupply: 30, estimatedTrackCostToDelivery: 40,
            isLoadAvailable: true, isLoadOnTrain: false, ferryRequired: false,
            loadChipTotal: 4, loadChipCarried: 0, estimatedTurns: 0,
            demandScore: 0, networkCitiesUnlocked: 0, victoryMajorCitiesEnRoute: 0,
          },
          {
            cardIndex: 1, loadType: 'Gold', supplyCity: 'FarC', deliveryCity: 'FarD',
            payout: 20, isSupplyReachable: false, isDeliveryReachable: false,
            isSupplyOnNetwork: false, isDeliveryOnNetwork: false,
            estimatedTrackCostToSupply: 50, estimatedTrackCostToDelivery: 60,
            isLoadAvailable: true, isLoadOnTrain: false, ferryRequired: false,
            loadChipTotal: 4, loadChipCarried: 0, estimatedTurns: 0,
            demandScore: 0, networkCitiesUnlocked: 0, victoryMajorCitiesEnRoute: 0,
          },
        ],
      });

      const snapshot = makeWorldSnapshot({ bot: { money: 10 } as any });
      const result = await ActionResolver.heuristicFallback(context, snapshot);

      expect(result.success).toBe(true);
      const plan = result.plan as TurnPlanDiscardHand;
      expect(plan.type).toBe(AIActionType.DiscardHand);
    });

    it('should NOT discard hand when at least one demand is achievable', async () => {
      setupGridPoints([
        { row: 5, col: 5, name: 'HomeCity' },
        { row: 8, col: 8, name: 'NearCity' },
      ]);
      mockComputeBuildSegments.mockReturnValue([makeSegment(5, 5, 6, 6)]);

      const context = makeGameContext({
        canDeliver: [],
        canPickup: [],
        canBuild: true,
        isInitialBuild: false,
        demands: [
          {
            cardIndex: 0, loadType: 'Steel', supplyCity: 'NearCity', deliveryCity: 'HomeCity',
            payout: 15, isSupplyReachable: false, isDeliveryReachable: false,
            isSupplyOnNetwork: false, isDeliveryOnNetwork: true,
            estimatedTrackCostToSupply: 5, estimatedTrackCostToDelivery: 0,
            isLoadAvailable: true, isLoadOnTrain: false, ferryRequired: false,
            loadChipTotal: 4, loadChipCarried: 0, estimatedTurns: 0,
            demandScore: 0, networkCitiesUnlocked: 0, victoryMajorCitiesEnRoute: 0,
          },
        ],
      });

      const snapshot = makeWorldSnapshot({ bot: { money: 10 } as any });
      const result = await ActionResolver.heuristicFallback(context, snapshot);

      expect(result.success).toBe(true);
      // Should BUILD, not discard (supply cost 5 <= budget 10)
      expect(result.plan!.type).toBe(AIActionType.BuildTrack);
    });

    it('should NOT discard hand during initialBuild even if demands unachievable', async () => {
      const context = makeGameContext({
        canDeliver: [],
        canPickup: [],
        canBuild: false,
        isInitialBuild: true,
        demands: [
          {
            cardIndex: 0, loadType: 'Steel', supplyCity: 'FarA', deliveryCity: 'FarB',
            payout: 25, isSupplyReachable: false, isDeliveryReachable: false,
            isSupplyOnNetwork: false, isDeliveryOnNetwork: false,
            estimatedTrackCostToSupply: 100, estimatedTrackCostToDelivery: 100,
            isLoadAvailable: true, isLoadOnTrain: false, ferryRequired: false,
            loadChipTotal: 4, loadChipCarried: 0, estimatedTurns: 0,
            demandScore: 0, networkCitiesUnlocked: 0, victoryMajorCitiesEnRoute: 0,
          },
        ],
      });

      const snapshot = makeWorldSnapshot({ bot: { money: 5 } as any });
      const result = await ActionResolver.heuristicFallback(context, snapshot);

      expect(result.success).toBe(true);
      // Should PASS, not discard (initialBuild blocks discard)
      expect(result.plan!.type).toBe(AIActionType.PassTurn);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // applyPlanToState — BE-003
  // ═══════════════════════════════════════════════════════════════════════════

  describe('applyPlanToState', () => {
    it('should add delivery payout to bot money and remove load and demand', () => {
      const resolvedDemands: ResolvedDemand[] = [
        { cardId: 42, demands: [{ city: 'Berlin', loadType: 'Wine', payment: 12 }] },
      ];
      const snapshot = makeWorldSnapshot({
        bot: {
          money: 5,
          loads: ['Wine'],
          resolvedDemands,
        } as any,
      });
      const context = makeGameContext({ money: 5, loads: ['Wine'] });

      const plan: TurnPlanDeliverLoad = {
        type: AIActionType.DeliverLoad,
        load: 'Wine',
        city: 'Berlin',
        cardId: 42,
        payout: 12,
      };

      ActionResolver.applyPlanToState(plan, snapshot, context);

      expect(snapshot.bot.money).toBe(17); // 5 + 12
      expect(context.money).toBe(17);
      expect(snapshot.bot.loads).toEqual([]);
      expect(context.loads).toEqual([]);
      expect(snapshot.bot.resolvedDemands).toEqual([]);
    });

    it('should only remove the delivered load when carrying multiple loads', () => {
      const resolvedDemands: ResolvedDemand[] = [
        { cardId: 10, demands: [{ city: 'Berlin', loadType: 'Coal', payment: 8 }] },
        { cardId: 20, demands: [{ city: 'Paris', loadType: 'Wine', payment: 15 }] },
      ];
      const snapshot = makeWorldSnapshot({
        bot: {
          money: 30,
          loads: ['Coal', 'Wine'],
          resolvedDemands,
        } as any,
      });
      const context = makeGameContext({ money: 30, loads: ['Coal', 'Wine'] });

      const plan: TurnPlanDeliverLoad = {
        type: AIActionType.DeliverLoad,
        load: 'Coal',
        city: 'Berlin',
        cardId: 10,
        payout: 8,
      };

      ActionResolver.applyPlanToState(plan, snapshot, context);

      expect(snapshot.bot.money).toBe(38); // 30 + 8
      expect(snapshot.bot.loads).toEqual(['Wine']); // Coal removed, Wine remains
      expect(snapshot.bot.resolvedDemands).toHaveLength(1);
      expect(snapshot.bot.resolvedDemands[0].cardId).toBe(20); // card 10 removed
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // resolveMultiAction — TEST-008
  // ═══════════════════════════════════════════════════════════════════════════

  describe('resolveMultiAction', () => {
    // Helper to build multi-action intents
    function makeMultiIntent(...actions: { action: string; details?: Record<string, string> }[]): LLMActionIntent {
      return {
        actions: actions.map(a => ({ action: a.action, details: a.details ?? {} })),
        reasoning: 'multi-action test',
        planHorizon: 'test',
      };
    }

    describe('valid multi-action sequences', () => {
      it('should resolve MOVE + DELIVER as a MultiAction with 2 steps', async () => {
        // Setup: bot at Berlin with Coal, demand card for Coal at Vienna
        const gridMap = new Map<string, GridPointData>();
        gridMap.set('5,5', { row: 5, col: 5, terrain: TerrainType.MajorCity, name: 'Berlin' });
        gridMap.set('5,6', { row: 5, col: 6, terrain: TerrainType.Clear });
        gridMap.set('10,10', { row: 10, col: 10, terrain: TerrainType.MajorCity, name: 'Vienna' });
        mockLoadGridPoints.mockReturnValue(gridMap);
        mockGetMajorCityGroups.mockReturnValue([]);
        mockGetMajorCityLookup.mockReturnValue(new Map([['5,5', 'Berlin'], ['10,10', 'Vienna']]));

        // MOVE needs a valid path
        mockComputeTrackUsageForMove.mockReturnValue({
          isValid: true,
          path: [
            { from: { row: 5, col: 5 }, to: { row: 5, col: 6 } },
            { from: { row: 5, col: 6 }, to: { row: 10, col: 10 } },
          ] as PathEdge[],
          ownersUsed: new Set<string>(),
          ownersPaid: [],
          feeTotal: 0,
        } as unknown as TrackUsageComputation);

        const snapshot = makeWorldSnapshot({
          bot: {
            playerId: 'bot-1',
            userId: 'user-bot',
            money: 50,
            position: { row: 5, col: 5 },
            existingSegments: [makeSegment(5, 5, 5, 6), makeSegment(5, 6, 10, 10)],
            demandCards: [1],
            resolvedDemands: [
              { cardId: 1, demands: [{ city: 'Vienna', loadType: 'Coal', payment: 30 }] },
            ] as ResolvedDemand[],
            trainType: TrainType.Freight,
            loads: ['Coal'],
            botConfig: null,
            ferryHalfSpeed: false,
            connectedMajorCityCount: 0,
          } as WorldSnapshot['bot'],
        });

        const intent = makeMultiIntent(
          { action: 'MOVE', details: { to: 'Vienna' } },
          { action: 'DELIVER', details: { load: 'Coal', at: 'Vienna' } },
        );

        const result = await ActionResolver.resolve(intent, snapshot, makeGameContext());

        // Cumulative state simulation: MOVE updates bot position to Vienna,
        // then DELIVER succeeds because bot is now at Vienna
        expect(result.success).toBe(true);
        expect(result.plan!.type).toBe('MultiAction');
        if (result.plan!.type === 'MultiAction') {
          expect(result.plan!.steps).toHaveLength(2);
          expect(result.plan!.steps[0].type).toBe(AIActionType.MoveTrain);
          expect(result.plan!.steps[1].type).toBe(AIActionType.DeliverLoad);
        }
      });

      it('should resolve a single action passed as multi-action (degenerates to single)', async () => {
        const intent = makeMultiIntent(
          { action: 'PASS' },
        );

        const result = await ActionResolver.resolve(intent, makeWorldSnapshot(), makeGameContext());

        // Single action in array → resolved as single action, not MultiAction
        expect(result.success).toBe(true);
        expect(result.plan!.type).toBe(AIActionType.PassTurn);
      });

      it('should resolve PASS + BUILD as MultiAction', async () => {
        // Setup mocks for BUILD to succeed
        const gridMap = new Map<string, GridPointData>();
        gridMap.set('5,5', { row: 5, col: 5, terrain: TerrainType.MajorCity, name: 'Berlin' });
        gridMap.set('5,6', { row: 5, col: 6, terrain: TerrainType.Clear });
        mockLoadGridPoints.mockReturnValue(gridMap);
        mockGetMajorCityGroups.mockReturnValue([]);
        mockGetMajorCityLookup.mockReturnValue(new Map([['5,5', 'Berlin']]));
        mockComputeBuildSegments.mockReturnValue([makeSegment(5, 5, 5, 6, 1)]);

        const intent = makeMultiIntent(
          { action: 'PASS' },
          { action: 'BUILD', details: { toward: 'Berlin' } },
        );

        const result = await ActionResolver.resolve(intent, makeWorldSnapshot(), makeGameContext());

        expect(result.success).toBe(true);
        expect(result.plan!.type).toBe('MultiAction');
        if (result.plan!.type === 'MultiAction') {
          expect(result.plan!.steps).toHaveLength(2);
          expect(result.plan!.steps[0].type).toBe(AIActionType.PassTurn);
          expect(result.plan!.steps[1].type).toBe(AIActionType.BuildTrack);
        }
      });

      it('should resolve PICKUP + BUILD as MultiAction when both succeed', async () => {
        const gridMap = new Map<string, GridPointData>();
        gridMap.set('5,5', { row: 5, col: 5, terrain: TerrainType.MajorCity, name: 'Berlin' });
        gridMap.set('5,6', { row: 5, col: 6, terrain: TerrainType.Clear });
        gridMap.set('10,10', { row: 10, col: 10, terrain: TerrainType.MajorCity, name: 'Vienna' });
        mockLoadGridPoints.mockReturnValue(gridMap);
        mockGetMajorCityGroups.mockReturnValue([]);
        mockGetMajorCityLookup.mockReturnValue(new Map([['5,5', 'Berlin'], ['10,10', 'Vienna']]));
        mockComputeBuildSegments.mockReturnValue([makeSegment(5, 6, 10, 10, 5)]);

        const snapshot = makeWorldSnapshot({
          bot: {
            playerId: 'bot-1',
            userId: 'user-bot',
            money: 50,
            position: { row: 5, col: 5 },
            existingSegments: [makeSegment(5, 5, 5, 6)],
            demandCards: [1],
            resolvedDemands: [{ cardId: 1, demands: [{ city: 'Hamburg', loadType: 'Coal', payment: 15 }] }],
            trainType: TrainType.Freight,
            loads: [],
            botConfig: null,
            ferryHalfSpeed: false,
            connectedMajorCityCount: 0,
          } as WorldSnapshot['bot'],
          loadAvailability: { Berlin: ['Coal'] },
        });

        const intent = makeMultiIntent(
          { action: 'PICKUP', details: { load: 'Coal', at: 'Berlin' } },
          { action: 'BUILD', details: { toward: 'Vienna' } },
        );

        const result = await ActionResolver.resolve(intent, snapshot, makeGameContext());

        expect(result.success).toBe(true);
        expect(result.plan!.type).toBe('MultiAction');
        if (result.plan!.type === 'MultiAction') {
          expect(result.plan!.steps).toHaveLength(2);
          expect(result.plan!.steps[0].type).toBe(AIActionType.PickupLoad);
          expect(result.plan!.steps[1].type).toBe(AIActionType.BuildTrack);
        }
      });
    });

    describe('cumulative state simulation', () => {
      it('should update bot position after MOVE so DELIVER at destination succeeds', async () => {
        // This is verified by the MOVE + DELIVER test above, but here we verify the state
        // simulation specifically: the bot starts at 5,5, MOVE changes position to 10,10,
        // and DELIVER at Vienna (10,10) succeeds because the simulated state was updated.
        const gridMap = new Map<string, GridPointData>();
        gridMap.set('5,5', { row: 5, col: 5, terrain: TerrainType.MajorCity, name: 'Berlin' });
        gridMap.set('10,10', { row: 10, col: 10, terrain: TerrainType.MajorCity, name: 'Vienna' });
        mockLoadGridPoints.mockReturnValue(gridMap);
        mockGetMajorCityGroups.mockReturnValue([]);
        mockGetMajorCityLookup.mockReturnValue(new Map([['5,5', 'Berlin'], ['10,10', 'Vienna']]));

        mockComputeTrackUsageForMove.mockReturnValue({
          isValid: true,
          path: [{ from: { row: 5, col: 5 }, to: { row: 10, col: 10 } }] as PathEdge[],
          ownersUsed: new Set<string>(),
          ownersPaid: [],
          feeTotal: 0,
        } as unknown as TrackUsageComputation);

        const snapshot = makeWorldSnapshot({
          bot: {
            playerId: 'bot-1',
            userId: 'user-bot',
            money: 50,
            position: { row: 5, col: 5 },
            existingSegments: [makeSegment(5, 5, 10, 10)],
            demandCards: [1],
            resolvedDemands: [
              { cardId: 1, demands: [{ city: 'Vienna', loadType: 'Wine', payment: 48 }] },
            ] as ResolvedDemand[],
            trainType: TrainType.Freight,
            loads: ['Wine'],
            botConfig: null,
            ferryHalfSpeed: false,
            connectedMajorCityCount: 0,
          } as WorldSnapshot['bot'],
        });

        const intent = makeMultiIntent(
          { action: 'MOVE', details: { to: 'Vienna' } },
          { action: 'DELIVER', details: { load: 'Wine', at: 'Vienna' } },
        );

        const result = await ActionResolver.resolve(intent, snapshot, makeGameContext());

        expect(result.success).toBe(true);
        if (result.plan!.type === 'MultiAction') {
          const deliverStep = result.plan!.steps[1] as TurnPlanDeliverLoad;
          expect(deliverStep.load).toBe('Wine');
          expect(deliverStep.payout).toBe(48);
        }

        // Original snapshot should NOT be mutated
        expect(snapshot.bot.position).toEqual({ row: 5, col: 5 });
      });

      it('should update bot loads after PICKUP so capacity check succeeds for BUILD', async () => {
        const gridMap = new Map<string, GridPointData>();
        gridMap.set('5,5', { row: 5, col: 5, terrain: TerrainType.MajorCity, name: 'Berlin' });
        gridMap.set('10,10', { row: 10, col: 10, terrain: TerrainType.MajorCity, name: 'Vienna' });
        mockLoadGridPoints.mockReturnValue(gridMap);
        mockGetMajorCityGroups.mockReturnValue([]);
        mockGetMajorCityLookup.mockReturnValue(new Map([['5,5', 'Berlin'], ['10,10', 'Vienna']]));
        mockComputeBuildSegments.mockReturnValue([makeSegment(5, 5, 5, 6, 3)]);

        const snapshot = makeWorldSnapshot({
          bot: {
            playerId: 'bot-1',
            userId: 'user-bot',
            money: 50,
            position: { row: 5, col: 5 },
            existingSegments: [makeSegment(5, 5, 5, 6)],
            demandCards: [1],
            resolvedDemands: [{ cardId: 1, demands: [{ city: 'Berlin', loadType: 'Coal', payment: 15 }] }],
            trainType: TrainType.Freight,
            loads: ['Iron'], // Already has 1 load, capacity 2
            botConfig: null,
            ferryHalfSpeed: false,
            connectedMajorCityCount: 0,
          } as WorldSnapshot['bot'],
          loadAvailability: { Berlin: ['Coal'] },
        });

        const intent = makeMultiIntent(
          { action: 'PICKUP', details: { load: 'Coal', at: 'Berlin' } },
          { action: 'BUILD', details: { toward: 'Vienna' } },
        );

        const result = await ActionResolver.resolve(intent, snapshot, makeGameContext());

        expect(result.success).toBe(true);
        if (result.plan!.type === 'MultiAction') {
          expect(result.plan!.steps[0].type).toBe(AIActionType.PickupLoad);
          expect(result.plan!.steps[1].type).toBe(AIActionType.BuildTrack);
        }

        // Original snapshot should NOT be mutated
        expect(snapshot.bot.loads).toEqual(['Iron']);
      });

      it('should deduct build cost so second BUILD respects reduced budget', async () => {
        const gridMap = new Map<string, GridPointData>();
        gridMap.set('5,5', { row: 5, col: 5, terrain: TerrainType.MajorCity, name: 'Berlin' });
        gridMap.set('10,10', { row: 10, col: 10, terrain: TerrainType.MajorCity, name: 'Vienna' });
        mockLoadGridPoints.mockReturnValue(gridMap);
        mockGetMajorCityGroups.mockReturnValue([]);
        mockGetMajorCityLookup.mockReturnValue(new Map([['5,5', 'Berlin'], ['10,10', 'Vienna']]));

        // First build costs 15M, second build also tries 15M but only 5M budget remains
        mockComputeBuildSegments
          .mockReturnValueOnce([makeSegment(5, 5, 5, 6, 15)])
          .mockReturnValueOnce([makeSegment(5, 6, 10, 10, 5)]);

        const snapshot = makeWorldSnapshot({
          bot: {
            playerId: 'bot-1',
            userId: 'user-bot',
            money: 20, // Only 20M total, first build costs 15M, leaves 5M
            position: { row: 5, col: 5 },
            existingSegments: [makeSegment(5, 5, 5, 6)],
            demandCards: [],
            resolvedDemands: [],
            trainType: TrainType.Freight,
            loads: [],
            botConfig: null,
            ferryHalfSpeed: false,
            connectedMajorCityCount: 0,
          } as WorldSnapshot['bot'],
        });

        const intent = makeMultiIntent(
          { action: 'BUILD', details: { toward: 'Berlin' } },
          { action: 'BUILD', details: { toward: 'Vienna' } },
        );

        const result = await ActionResolver.resolve(intent, snapshot, makeGameContext());

        // Both BUILDs succeed because computeBuildSegments mock returns segments
        // and the budget check uses min(TURN_BUILD_BUDGET, money)
        // After first build (15M), money is 5M, so second build has 5M budget
        expect(result.success).toBe(true);

        // Original snapshot money should NOT be mutated
        expect(snapshot.bot.money).toBe(20);
      });

      it('should not mutate the original snapshot during multi-action resolution', async () => {
        const gridMap = new Map<string, GridPointData>();
        gridMap.set('5,5', { row: 5, col: 5, terrain: TerrainType.MajorCity, name: 'Berlin' });
        mockLoadGridPoints.mockReturnValue(gridMap);
        mockGetMajorCityGroups.mockReturnValue([]);
        mockGetMajorCityLookup.mockReturnValue(new Map([['5,5', 'Berlin']]));

        const snapshot = makeWorldSnapshot({
          bot: {
            playerId: 'bot-1',
            userId: 'user-bot',
            money: 50,
            position: { row: 5, col: 5 },
            existingSegments: [makeSegment(5, 5, 5, 6)],
            demandCards: [1],
            resolvedDemands: [{ cardId: 1, demands: [{ city: 'Hamburg', loadType: 'Coal', payment: 15 }] }],
            trainType: TrainType.Freight,
            loads: [],
            botConfig: null,
            ferryHalfSpeed: false,
            connectedMajorCityCount: 0,
          } as WorldSnapshot['bot'],
          loadAvailability: { Berlin: ['Coal'] },
        });

        const originalMoney = snapshot.bot.money;
        const originalLoads = [...snapshot.bot.loads];
        const originalPosition = { ...snapshot.bot.position! };

        const intent = makeMultiIntent(
          { action: 'PICKUP', details: { load: 'Coal', at: 'Berlin' } },
          { action: 'PASS' },
        );

        await ActionResolver.resolve(intent, snapshot, makeGameContext());

        // Original snapshot must remain unchanged
        expect(snapshot.bot.money).toBe(originalMoney);
        expect(snapshot.bot.loads).toEqual(originalLoads);
        expect(snapshot.bot.position).toEqual(originalPosition);
      });
    });

    describe('forbidden combination: UPGRADE + BUILD', () => {
      it('should reject UPGRADE + BUILD combination', async () => {
        const intent = makeMultiIntent(
          { action: 'UPGRADE', details: { to: 'fast_freight' } },
          { action: 'BUILD', details: { toward: 'Berlin' } },
        );

        const result = await ActionResolver.resolve(intent, makeWorldSnapshot(), makeGameContext());

        expect(result.success).toBe(false);
        expect(result.error).toContain('Cannot upgrade and build track in the same turn');
      });

      it('should reject BUILD + UPGRADE combination (order reversed)', async () => {
        const intent = makeMultiIntent(
          { action: 'BUILD', details: { toward: 'Berlin' } },
          { action: 'UPGRADE', details: { to: 'fast_freight' } },
        );

        const result = await ActionResolver.resolve(intent, makeWorldSnapshot(), makeGameContext());

        expect(result.success).toBe(false);
        expect(result.error).toContain('Cannot upgrade and build track in the same turn');
      });

      it('should reject using AIActionType enum values for UPGRADE + BUILD', async () => {
        const intent = makeMultiIntent(
          { action: AIActionType.UpgradeTrain, details: { to: 'fast_freight' } },
          { action: AIActionType.BuildTrack, details: { toward: 'Berlin' } },
        );

        const result = await ActionResolver.resolve(intent, makeWorldSnapshot(), makeGameContext());

        expect(result.success).toBe(false);
        expect(result.error).toContain('Cannot upgrade and build track in the same turn');
      });
    });

    describe('forbidden combination: DISCARD_HAND exclusivity', () => {
      it('should reject DISCARD_HAND + MOVE', async () => {
        const intent = makeMultiIntent(
          { action: 'DISCARD_HAND' },
          { action: 'MOVE', details: { to: 'Berlin' } },
        );

        const result = await ActionResolver.resolve(intent, makeWorldSnapshot(), makeGameContext());

        expect(result.success).toBe(false);
        expect(result.error).toContain('Discard Hand ends the turn immediately');
      });

      it('should reject MOVE + DISCARD_HAND (discard not first)', async () => {
        const intent = makeMultiIntent(
          { action: 'MOVE', details: { to: 'Berlin' } },
          { action: 'DISCARD_HAND' },
        );

        const result = await ActionResolver.resolve(intent, makeWorldSnapshot(), makeGameContext());

        expect(result.success).toBe(false);
        expect(result.error).toContain('Discard Hand ends the turn immediately');
      });

      it('should reject DISCARD_HAND + BUILD', async () => {
        const intent = makeMultiIntent(
          { action: AIActionType.DiscardHand },
          { action: 'BUILD', details: { toward: 'Berlin' } },
        );

        const result = await ActionResolver.resolve(intent, makeWorldSnapshot(), makeGameContext());

        expect(result.success).toBe(false);
        expect(result.error).toContain('Discard Hand ends the turn immediately');
      });

      it('should reject DISCARD_HAND + PASS', async () => {
        const intent = makeMultiIntent(
          { action: 'DISCARD_HAND' },
          { action: 'PASS' },
        );

        const result = await ActionResolver.resolve(intent, makeWorldSnapshot(), makeGameContext());

        expect(result.success).toBe(false);
        expect(result.error).toContain('Discard Hand ends the turn immediately');
      });

      it('should reject three actions including DISCARD_HAND', async () => {
        const intent = makeMultiIntent(
          { action: 'MOVE', details: { to: 'Berlin' } },
          { action: 'DISCARD_HAND' },
          { action: 'BUILD', details: { toward: 'Vienna' } },
        );

        const result = await ActionResolver.resolve(intent, makeWorldSnapshot(), makeGameContext());

        expect(result.success).toBe(false);
        expect(result.error).toContain('Discard Hand ends the turn immediately');
      });
    });

    describe('invalid action in sequence', () => {
      it('should fail on first invalid action (step 1)', async () => {
        // MOVE with no bot position
        const snapshot = makeWorldSnapshot({
          bot: {
            playerId: 'bot-1',
            userId: 'user-bot',
            money: 50,
            position: null,
            existingSegments: [],
            demandCards: [],
            resolvedDemands: [],
            trainType: TrainType.Freight,
            loads: [],
            botConfig: null,
            ferryHalfSpeed: false,
            connectedMajorCityCount: 0,
          } as unknown as WorldSnapshot['bot'],
        });

        const intent = makeMultiIntent(
          { action: 'MOVE', details: { to: 'Berlin' } },
          { action: 'PASS' },
        );

        const result = await ActionResolver.resolve(intent, snapshot, makeGameContext());

        expect(result.success).toBe(false);
        expect(result.error).toContain('Step 1 (MOVE) failed');
        expect(result.error).toContain('no position');
      });

      it('should fail on second invalid action (step 2) after first succeeds', async () => {
        // PASS succeeds, then DELIVER fails (no load on train)
        const gridMap = new Map<string, GridPointData>();
        gridMap.set('5,5', { row: 5, col: 5, terrain: TerrainType.MajorCity, name: 'Berlin' });
        mockLoadGridPoints.mockReturnValue(gridMap);
        mockGetMajorCityGroups.mockReturnValue([]);
        mockGetMajorCityLookup.mockReturnValue(new Map([['5,5', 'Berlin']]));

        const snapshot = makeWorldSnapshot({
          bot: {
            playerId: 'bot-1',
            userId: 'user-bot',
            money: 50,
            position: { row: 5, col: 5 },
            existingSegments: [makeSegment(5, 5, 5, 6)],
            demandCards: [1],
            resolvedDemands: [],
            trainType: TrainType.Freight,
            loads: [], // No loads on train
            botConfig: null,
            ferryHalfSpeed: false,
            connectedMajorCityCount: 0,
          } as WorldSnapshot['bot'],
        });

        const intent = makeMultiIntent(
          { action: 'PASS' },
          { action: 'DELIVER', details: { load: 'Coal', at: 'Berlin' } },
        );

        const result = await ActionResolver.resolve(intent, snapshot, makeGameContext());

        expect(result.success).toBe(false);
        expect(result.error).toContain('Step 2 (DELIVER) failed');
        expect(result.error).toContain('not carrying');
      });

      it('should fail on third action in a three-step sequence', async () => {
        const gridMap = new Map<string, GridPointData>();
        gridMap.set('5,5', { row: 5, col: 5, terrain: TerrainType.MajorCity, name: 'Berlin' });
        mockLoadGridPoints.mockReturnValue(gridMap);
        mockGetMajorCityGroups.mockReturnValue([]);
        mockGetMajorCityLookup.mockReturnValue(new Map([['5,5', 'Berlin']]));

        const snapshot = makeWorldSnapshot({
          bot: {
            playerId: 'bot-1',
            userId: 'user-bot',
            money: 50,
            position: { row: 5, col: 5 },
            existingSegments: [makeSegment(5, 5, 5, 6)],
            demandCards: [1],
            resolvedDemands: [{ cardId: 1, demands: [{ city: 'Hamburg', loadType: 'Coal', payment: 15 }] }],
            trainType: TrainType.Freight,
            loads: [],
            botConfig: null,
            ferryHalfSpeed: false,
            connectedMajorCityCount: 0,
          } as WorldSnapshot['bot'],
          loadAvailability: { Berlin: ['Coal'] },
        });

        const intent = makeMultiIntent(
          { action: 'PASS' },
          { action: 'PICKUP', details: { load: 'Coal', at: 'Berlin' } },
          { action: 'DELIVER', details: { load: 'Coal', at: 'Berlin' } },
        );

        const result = await ActionResolver.resolve(intent, snapshot, makeGameContext());

        // PASS and PICKUP succeed, but DELIVER fails because resolvedDemands is empty
        expect(result.success).toBe(false);
        expect(result.error).toContain('Step 3 (DELIVER) failed');
      });

      it('should fail when unknown action type is in the sequence', async () => {
        const intent = makeMultiIntent(
          { action: 'PASS' },
          { action: 'FLY' },
        );

        const result = await ActionResolver.resolve(intent, makeWorldSnapshot(), makeGameContext());

        expect(result.success).toBe(false);
        expect(result.error).toContain('Step 2 (FLY) failed');
        expect(result.error).toContain('Unknown action type');
      });
    });

    describe('edge cases', () => {
      it('should fail on empty actions array (treated as no action)', async () => {
        const intent: LLMActionIntent = {
          actions: [],
          reasoning: 'empty',
          planHorizon: 'none',
        };

        const result = await ActionResolver.resolve(intent, makeWorldSnapshot(), makeGameContext());

        // Empty array doesn't pass the length > 0 check, falls through to missing action
        expect(result.success).toBe(false);
        expect(result.error).toContain("must specify 'action' or 'actions'");
      });

      it('should handle actions with missing details gracefully', async () => {
        const intent = makeMultiIntent(
          { action: 'BUILD' }, // no details.toward → should fail
        );

        const result = await ActionResolver.resolve(intent, makeWorldSnapshot(), makeGameContext());

        // Single action in multi-action → degenerates to single resolution
        expect(result.success).toBe(false);
        expect(result.error).toContain('BUILD requires details.toward');
      });

      it('should handle two PASS actions in a MultiAction', async () => {
        const intent = makeMultiIntent(
          { action: 'PASS' },
          { action: 'PASS' },
        );

        const result = await ActionResolver.resolve(intent, makeWorldSnapshot(), makeGameContext());

        expect(result.success).toBe(true);
        expect(result.plan!.type).toBe('MultiAction');
        if (result.plan!.type === 'MultiAction') {
          expect(result.plan!.steps).toHaveLength(2);
          expect(result.plan!.steps[0].type).toBe(AIActionType.PassTurn);
          expect(result.plan!.steps[1].type).toBe(AIActionType.PassTurn);
        }
      });

      it('should reject UPGRADE + BUILD even with crossgrade cost of 5M', async () => {
        // Even a 5M crossgrade + BUILD is forbidden per game rules
        const intent = makeMultiIntent(
          { action: 'UPGRADE', details: { to: 'heavy_freight' } },
          { action: 'BUILD', details: { toward: 'Berlin' } },
        );

        const snapshot = makeWorldSnapshot({
          bot: {
            playerId: 'bot-1',
            userId: 'user-bot',
            money: 50,
            position: { row: 5, col: 5 },
            existingSegments: [makeSegment(5, 5, 5, 6)],
            demandCards: [],
            resolvedDemands: [],
            trainType: TrainType.FastFreight,
            loads: [],
            botConfig: null,
            ferryHalfSpeed: false,
            connectedMajorCityCount: 0,
          } as WorldSnapshot['bot'],
        });

        const result = await ActionResolver.resolve(intent, snapshot, makeGameContext());

        expect(result.success).toBe(false);
        expect(result.error).toContain('Cannot upgrade and build track in the same turn');
      });
    });

    describe('cumulative movement budget', () => {
      /** Build a mock PathEdge[] of a given length (edges = milepost steps) */
      function makeMockPath(
        startRow: number, startCol: number,
        length: number,
      ): PathEdge[] {
        const edges: PathEdge[] = [];
        for (let i = 0; i < length; i++) {
          edges.push({
            from: { row: startRow, col: startCol + i },
            to: { row: startRow, col: startCol + i + 1 },
          } as PathEdge);
        }
        return edges;
      }

      /** Set up grid with CityA at (5,5), CityB and CityC at configurable columns */
      function setupMovementTestGrid(cityBCol = 8, cityCCol = 14): void {
        const gridMap = new Map<string, GridPointData>();
        gridMap.set('5,5', { row: 5, col: 5, terrain: TerrainType.MajorCity, name: 'CityA' });
        for (let c = 6; c <= 30; c++) {
          if (c === cityBCol || c === cityCCol) continue;
          gridMap.set(`5,${c}`, { row: 5, col: c, terrain: TerrainType.Clear });
        }
        gridMap.set(`5,${cityBCol}`, { row: 5, col: cityBCol, terrain: TerrainType.MajorCity, name: 'CityB' });
        gridMap.set(`5,${cityCCol}`, { row: 5, col: cityCCol, terrain: TerrainType.MajorCity, name: 'CityC' });
        mockLoadGridPoints.mockReturnValue(gridMap);
        mockGetMajorCityGroups.mockReturnValue([]);
        mockGetMajorCityLookup.mockReturnValue(new Map([
          ['5,5', 'CityA'],
          [`5,${cityBCol}`, 'CityB'],
          [`5,${cityCCol}`, 'CityC'],
        ]));
      }

      it('should truncate second MOVE when cumulative movement exceeds speed (3mp + 9mp → 3mp + 6mp)', async () => {
        setupMovementTestGrid();

        // First MOVE: 3mp from CityA to CityB
        // Second MOVE: 9mp requested from CityB to CityC, but should be truncated to 6mp
        let callCount = 0;
        mockComputeTrackUsageForMove.mockImplementation(() => {
          callCount++;
          if (callCount === 1) {
            // First MOVE: 3 edges from (5,5) to (5,8)
            return {
              isValid: true,
              path: makeMockPath(5, 5, 3),
              ownersUsed: new Set<string>(),
              ownersPaid: [],
              feeTotal: 0,
            } as unknown as TrackUsageComputation;
          }
          // Second MOVE: 9 edges from (5,8) to (5,17) — will be truncated
          return {
            isValid: true,
            path: makeMockPath(5, 8, 9),
            ownersUsed: new Set<string>(),
            ownersPaid: [],
            feeTotal: 0,
          } as unknown as TrackUsageComputation;
        });

        const snapshot = makeWorldSnapshot({
          bot: {
            playerId: 'bot-1',
            userId: 'user-bot',
            money: 50,
            position: { row: 5, col: 5 },
            existingSegments: [makeSegment(5, 5, 5, 8), makeSegment(5, 8, 5, 14)],
            demandCards: [1],
            resolvedDemands: [
              { cardId: 1, demands: [{ city: 'CityB', loadType: 'Coal', payment: 30 }] },
            ] as ResolvedDemand[],
            trainType: TrainType.Freight,
            loads: ['Coal'],
            botConfig: null,
            ferryHalfSpeed: false,
            connectedMajorCityCount: 0,
          } as WorldSnapshot['bot'],
        });

        const context = makeGameContext({ speed: 9 });

        const intent = makeMultiIntent(
          { action: 'MOVE', details: { to: 'CityB' } },
          { action: 'DELIVER', details: { load: 'Coal', at: 'CityB' } },
          { action: 'MOVE', details: { to: 'CityC' } },
        );

        const result = await ActionResolver.resolve(intent, snapshot, context);

        expect(result.success).toBe(true);
        expect(result.plan!.type).toBe('MultiAction');
        if (result.plan!.type === 'MultiAction') {
          expect(result.plan!.steps).toHaveLength(3);
          // First MOVE: 3mp (path length 4 = 3 edges + start node)
          const move1 = result.plan!.steps[0] as TurnPlanMoveTrain;
          expect(move1.path).toHaveLength(4); // 3 edges + start
          // Second MOVE: truncated to 6mp (9 - 3 = 6 remaining)
          const move2 = result.plan!.steps[2] as TurnPlanMoveTrain;
          expect(move2.path).toHaveLength(7); // 6 edges + start
        }
      });

      it('should block second MOVE when speed budget is fully consumed (9mp + any → skip)', async () => {
        // CityC at col 14 = 9 edges from CityA at col 5
        setupMovementTestGrid(8, 14);

        // First MOVE: 9mp — uses the entire budget
        mockComputeTrackUsageForMove.mockReturnValue({
          isValid: true,
          path: makeMockPath(5, 5, 9),
          ownersUsed: new Set<string>(),
          ownersPaid: [],
          feeTotal: 0,
        } as unknown as TrackUsageComputation);

        const snapshot = makeWorldSnapshot({
          bot: {
            playerId: 'bot-1',
            userId: 'user-bot',
            money: 50,
            position: { row: 5, col: 5 },
            existingSegments: [makeSegment(5, 5, 5, 14)],
            demandCards: [1],
            resolvedDemands: [
              { cardId: 1, demands: [{ city: 'CityA', loadType: 'Coal', payment: 15 }] },
            ] as ResolvedDemand[],
            trainType: TrainType.Freight,
            loads: [],
            botConfig: null,
            ferryHalfSpeed: false,
            connectedMajorCityCount: 0,
          } as WorldSnapshot['bot'],
          loadAvailability: { CityC: ['Coal'] },
        });

        const context = makeGameContext({
          speed: 9,
          demands: [{
            loadType: 'Coal',
            supplyCity: 'CityC',
            deliveryCity: 'CityA',
            payout: 15,
            isLoadOnTrain: false,
            isSupplyOnNetwork: true,
            isDeliveryOnNetwork: true,
            isSupplyReachable: true,
            isDeliveryReachable: true,
            estimatedTrackCostToSupply: 0,
            estimatedTrackCostToDelivery: 0,
          } as DemandContext],
        });

        const warnSpy = jest.spyOn(console, 'warn').mockImplementation();

        // MOVE(9mp) to CityC, PICKUP Coal at CityC, then MOVE to CityA should be skipped
        const intent = makeMultiIntent(
          { action: 'MOVE', details: { to: 'CityC' } },
          { action: 'PICKUP', details: { load: 'Coal', at: 'CityC' } },
          { action: 'MOVE', details: { to: 'CityA' } },
        );

        const result = await ActionResolver.resolve(intent, snapshot, context);

        expect(result.success).toBe(true);
        expect(result.plan!.type).toBe('MultiAction');
        if (result.plan!.type === 'MultiAction') {
          // Second MOVE should be skipped — only MOVE + PICKUP remain
          expect(result.plan!.steps).toHaveLength(2);
          expect(result.plan!.steps[0].type).toBe(AIActionType.MoveTrain);
          expect(result.plan!.steps[1].type).toBe(AIActionType.PickupLoad);
        }

        // Should have logged a warning about skipping the second MOVE
        expect(warnSpy).toHaveBeenCalledWith(
          expect.stringContaining('MOVE skipped: 0mp remaining'),
        );

        warnSpy.mockRestore();
      });

      it('should allow two MOVEs that exactly equal the speed limit (5mp + 4mp = 9mp)', async () => {
        // CityB at col 10 = 5 edges from CityA, CityC at col 14 = 4 edges from CityB
        setupMovementTestGrid(10, 14);

        let callCount = 0;
        mockComputeTrackUsageForMove.mockImplementation(() => {
          callCount++;
          if (callCount === 1) {
            return {
              isValid: true,
              path: makeMockPath(5, 5, 5),
              ownersUsed: new Set<string>(),
              ownersPaid: [],
              feeTotal: 0,
            } as unknown as TrackUsageComputation;
          }
          return {
            isValid: true,
            path: makeMockPath(5, 10, 4),
            ownersUsed: new Set<string>(),
            ownersPaid: [],
            feeTotal: 0,
          } as unknown as TrackUsageComputation;
        });

        const snapshot = makeWorldSnapshot({
          bot: {
            playerId: 'bot-1',
            userId: 'user-bot',
            money: 50,
            position: { row: 5, col: 5 },
            existingSegments: [makeSegment(5, 5, 5, 14)],
            demandCards: [1],
            resolvedDemands: [
              { cardId: 1, demands: [{ city: 'CityB', loadType: 'Coal', payment: 30 }] },
            ] as ResolvedDemand[],
            trainType: TrainType.Freight,
            loads: ['Coal'],
            botConfig: null,
            ferryHalfSpeed: false,
            connectedMajorCityCount: 0,
          } as WorldSnapshot['bot'],
        });

        const context = makeGameContext({ speed: 9 });

        const intent = makeMultiIntent(
          { action: 'MOVE', details: { to: 'CityB' } },
          { action: 'DELIVER', details: { load: 'Coal', at: 'CityB' } },
          { action: 'MOVE', details: { to: 'CityC' } },
        );

        const result = await ActionResolver.resolve(intent, snapshot, context);

        expect(result.success).toBe(true);
        expect(result.plan!.type).toBe('MultiAction');
        if (result.plan!.type === 'MultiAction') {
          expect(result.plan!.steps).toHaveLength(3);
          const move1 = result.plan!.steps[0] as TurnPlanMoveTrain;
          const move2 = result.plan!.steps[2] as TurnPlanMoveTrain;
          expect(move1.path).toHaveLength(6); // 5 edges + start
          expect(move2.path).toHaveLength(5); // 4 edges + start
          // Total: 5 + 4 = 9 = speed limit
        }
      });

      it('should not truncate a single MOVE at the speed limit (backward compatibility)', async () => {
        setupMovementTestGrid();

        // Single MOVE of exactly 9 edges
        mockComputeTrackUsageForMove.mockReturnValue({
          isValid: true,
          path: makeMockPath(5, 5, 9),
          ownersUsed: new Set<string>(),
          ownersPaid: [],
          feeTotal: 0,
        } as unknown as TrackUsageComputation);

        const snapshot = makeWorldSnapshot({
          bot: {
            playerId: 'bot-1',
            userId: 'user-bot',
            money: 50,
            position: { row: 5, col: 5 },
            existingSegments: [makeSegment(5, 5, 5, 14)],
            demandCards: [1],
            resolvedDemands: [],
            trainType: TrainType.Freight,
            loads: [],
            botConfig: null,
            ferryHalfSpeed: false,
            connectedMajorCityCount: 0,
          } as WorldSnapshot['bot'],
        });

        const context = makeGameContext({ speed: 9 });

        const intent = makeMoveIntent('CityC');

        const result = await ActionResolver.resolve(intent, snapshot, context);

        expect(result.success).toBe(true);
        const plan = result.plan as TurnPlanMoveTrain;
        expect(plan.type).toBe(AIActionType.MoveTrain);
        // Path should be 9 edges + start = 10 nodes, no truncation
        expect(plan.path).toHaveLength(10);
      });

      it('should log console.warn when a MOVE path is truncated by remainingSpeed', async () => {
        // CityB at col 10 = 5 edges from CityA
        setupMovementTestGrid(10, 20);

        let callCount = 0;
        mockComputeTrackUsageForMove.mockImplementation(() => {
          callCount++;
          if (callCount === 1) {
            return {
              isValid: true,
              path: makeMockPath(5, 5, 5),
              ownersUsed: new Set<string>(),
              ownersPaid: [],
              feeTotal: 0,
            } as unknown as TrackUsageComputation;
          }
          // Second MOVE: 9 edges, but only 4mp remaining — should trigger warn
          return {
            isValid: true,
            path: makeMockPath(5, 10, 9),
            ownersUsed: new Set<string>(),
            ownersPaid: [],
            feeTotal: 0,
          } as unknown as TrackUsageComputation;
        });

        const snapshot = makeWorldSnapshot({
          bot: {
            playerId: 'bot-1',
            userId: 'user-bot',
            money: 50,
            position: { row: 5, col: 5 },
            existingSegments: [makeSegment(5, 5, 5, 14)],
            demandCards: [1],
            resolvedDemands: [
              { cardId: 1, demands: [{ city: 'CityB', loadType: 'Coal', payment: 30 }] },
            ] as ResolvedDemand[],
            trainType: TrainType.Freight,
            loads: ['Coal'],
            botConfig: null,
            ferryHalfSpeed: false,
            connectedMajorCityCount: 0,
          } as WorldSnapshot['bot'],
        });

        const context = makeGameContext({ speed: 9 });
        const warnSpy = jest.spyOn(console, 'warn').mockImplementation();

        const intent = makeMultiIntent(
          { action: 'MOVE', details: { to: 'CityB' } },
          { action: 'DELIVER', details: { load: 'Coal', at: 'CityB' } },
          { action: 'MOVE', details: { to: 'CityC' } },
        );

        await ActionResolver.resolve(intent, snapshot, context);

        // Should warn about truncation in resolveMove
        expect(warnSpy).toHaveBeenCalledWith(
          expect.stringContaining('[Movement Budget] MOVE truncated'),
        );

        warnSpy.mockRestore();
      });
    });
  });

});
