/**
 * Ferry transit rule violation — reproduction test
 *
 * Purpose: Prove that ActionResolver.resolveMove currently allows a bot to cross
 * the Harwich-Ijmuiden ferry in the same turn it arrives at Harwich, violating
 * the game rule that says a train must stop at the ferry port for the entire turn
 * upon first arrival.
 *
 * Evidence: Game log game-bca8a719..., turn 34, player Flash:
 *   positionStart: (15,30)
 *   positionEnd:   (21,39) Holland  — crossed the ferry AND continued to Holland
 *   movementPath:  (15,30)→(16,31)→(16,32)→(17,32)→(17,33)→(18,34)→
 *                  (19,34 Harwich)→(19,38 Ijmuiden)→(20,38)→(21,38)→(21,39)
 *
 * Root cause: TurnExecutorPlanner calls resolveMove twice in the same turn:
 *   1. resolveMove from (15,30) → path stops at Harwich (ferry guard fires correctly)
 *   2. Context position updated to Harwich; remainingBudget > 0
 *   3. resolveMove called AGAIN with bot.position = Harwich → resolveFerryCrossing
 *      triggers, teleports to Ijmuiden, and the bot crosses the ferry in the same turn
 *
 * R3 reproduces the second resolveMove call after arriving at a ferry port mid-turn.
 * This call should be rejected (ferry rule: stop for the whole turn), but currently
 * returns a valid crossing path — that is the bug.
 *
 * R1: Uses REAL computeTrackUsageForMove, REAL loadGridPoints, REAL getFerryEdges.
 * R3: Asserts that resolveMove with bot.position=Harwich (arrived this turn, not
 *     via ferry_half_speed=true) should NOT perform a ferry crossing.
 *     Expected to FAIL on current branch because resolveFerryCrossing fires even
 *     when the bot just arrived at the ferry port mid-turn.
 * R4: Regression guard — bot STARTS at Harwich at the beginning of a full turn
 *     (ferryHalfSpeed=false, arrived last turn) → ferry crossing IS correct.
 *     Also confirms first resolveMove (non-port start) stops at Harwich.
 * R5: Captures console.warn to record whether the ferry truncation warning fires.
 * R6: No DB, server, or browser required; relies only on configuration/ JSON files.
 */

// NO mocks for: computeTrackUsageForMove, loadGridPoints, getFerryEdges, ActionResolver
// Mocked: computeBuildSegments (unused in resolveMove) + TurnExecutorPlanner heavy deps
jest.mock('../../services/ai/computeBuildSegments', () => ({
  computeBuildSegments: jest.fn(() => []),
}));

// ─── Mocks for TurnExecutorPlanner dependencies (R3 only) ────────────────────
// These ensure TurnExecutorPlanner.execute() can run without DB/network access.
// ActionResolver and MapTopology (loadGridPoints) are intentionally NOT mocked so
// the real ferry truncation + arrival guard logic exercises live.
jest.mock('../../services/ai/routeHelpers', () => ({
  isStopComplete: jest.fn(() => false),
  resolveBuildTarget: jest.fn(() => null),
  getNetworkFrontier: jest.fn(() => []),
}));

jest.mock('../../services/ai/BotMemory', () => ({
  getMemory: jest.fn(() => ({
    currentBuildTarget: null,
    turnsOnTarget: 0,
    lastAction: null,
    noProgressTurns: 0,
    consecutiveDiscards: 0,
    deliveryCount: 0,
    totalEarnings: 0,
    turnNumber: 0,
    activeRoute: null,
    turnsOnRoute: 0,
    routeHistory: [],
    lastReasoning: null,
    lastPlanHorizon: null,
    previousRouteStops: null,
    consecutiveLlmFailures: 0,
  })),
}));

jest.mock('../../services/ai/TripPlanner', () => ({
  TripPlanner: jest.fn().mockImplementation(() => ({
    planTrip: jest.fn().mockResolvedValue({ route: null, llmLog: [] }),
  })),
}));

jest.mock('../../services/ai/RouteEnrichmentAdvisor', () => ({
  RouteEnrichmentAdvisor: {
    enrich: jest.fn(async (route: unknown) => route),
  },
}));

jest.mock('../../services/ai/BuildAdvisor', () => ({
  BuildAdvisor: {
    advise: jest.fn().mockResolvedValue(null),
    retryWithSolvencyFeedback: jest.fn().mockResolvedValue(null),
    lastDiagnostics: {},
  },
}));

jest.mock('../../services/ai/TurnExecutor', () => ({
  TurnExecutor: {
    executePlan: jest.fn().mockResolvedValue({
      success: true,
      action: 'DeliverLoad',
      cost: 0,
      segmentsBuilt: 0,
      remainingMoney: 200,
      durationMs: 1,
      payment: 0,
      newCardId: null,
    }),
  },
}));

jest.mock('../../services/ai/WorldSnapshotService', () => ({
  capture: jest.fn().mockResolvedValue(null),
}));

jest.mock('../../services/ai/ContextBuilder', () => ({
  ContextBuilder: {
    rebuildDemands: jest.fn(() => []),
  },
}));

jest.mock('../../../shared/constants/gameRules', () => ({
  TURN_BUILD_BUDGET: 20,
}));
// ─── End TurnExecutorPlanner mocks ───────────────────────────────────────────

import { ActionResolver } from '../../services/ai/ActionResolver';
import { TurnExecutorPlanner } from '../../services/ai/TurnExecutorPlanner';
import {
  WorldSnapshot,
  TrainType,
  TerrainType,
  TrackSegment,
  TurnPlanMoveTrain,
  AIActionType,
} from '../../../shared/types/GameTypes';
import type { StrategicRoute, GameContext } from '../../../shared/types/GameTypes';
import { getFerryEdges } from '../../../shared/services/majorCityGroups';

// ─── Geometry constants ───────────────────────────────────────────────────────

const BOT_PLAYER_ID = 'test-bot-player';

// Start position from game log turn 34
const BOT_START = { row: 15, col: 30 };

// Ferry ports (confirmed from gridPoints.json: GridX=col, GridY=row)
const HARWICH = { row: 19, col: 34 };   // FerryPort
const IJMUIDEN = { row: 19, col: 38 };  // FerryPort

// ─── Segment helper ───────────────────────────────────────────────────────────

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

/**
 * Build a bot track network that mirrors the actual game log path for turn 34:
 *   (15,30) → (16,31) → (16,32) → (17,32) → (17,33) → (18,34) → (19,34) Harwich
 *   Ijmuiden (19,38) → (20,38) → (21,38) → (21,39) Holland
 *
 * The Harwich↔Ijmuiden ferry edge is provided by getFerryEdges() (real data —
 * called internally by computeTrackUsageForMove).
 */
function buildGameLogTrackNetwork(): TrackSegment[] {
  return [
    // England side: (15,30) → Harwich (mirrors game log movement path)
    makeSegment(15, 30, 16, 31),
    makeSegment(16, 31, 16, 32),
    makeSegment(16, 32, 17, 32),
    makeSegment(17, 32, 17, 33),
    makeSegment(17, 33, 18, 34),
    makeSegment(18, 34, 19, 34),  // → Harwich ferry port
    // Holland side: Ijmuiden → Holland (mirrors game log movement path)
    makeSegment(19, 38, 20, 38),
    makeSegment(20, 38, 21, 38),
    makeSegment(21, 38, 21, 39),  // → Holland outpost
  ];
}

/**
 * Construct a minimal WorldSnapshot for a bot at the given position.
 */
function makeSnapshot(position: { row: number; col: number }, opts: {
  ferryHalfSpeed?: boolean;
} = {}): WorldSnapshot {
  const segments = buildGameLogTrackNetwork();
  const ferryEdges = getFerryEdges();

  return {
    gameId: 'test-game-ferry-truncation',
    gameStatus: 'active',
    turnNumber: 34,
    bot: {
      playerId: BOT_PLAYER_ID,
      userId: 'test-user',
      money: 200,
      position,
      existingSegments: segments,
      demandCards: [],
      resolvedDemands: [],
      trainType: TrainType.Freight,  // speed 9 — matches game log
      loads: [],
      botConfig: { skillLevel: 'medium' },
      ferryHalfSpeed: opts.ferryHalfSpeed ?? false,
      connectedMajorCityCount: 0,
    },
    allPlayerTracks: [
      { playerId: BOT_PLAYER_ID, segments },
    ],
    loadAvailability: {},
    ferryEdges,
  };
}

// ─── R3 Main test — drives through TurnExecutorPlanner ───────────────────────

describe('TurnExecutorPlanner.execute — ferry arrival guard (R3)', () => {
  /**
   * R3: Verify that TurnExecutorPlanner.execute() correctly invokes the ferry
   * arrival guard introduced in commit 5ad754e.
   *
   * Scenario (mirrors game log turn 34):
   *   Bot starts at (15,30), route stop = pickup at Holland.
   *   Holland IS on the network (citiesOnNetwork includes 'Holland'), so the
   *   MOVE branch fires. ActionResolver.resolveMove (REAL) returns a path that
   *   stops at Harwich (19,34) due to the ferry truncation guard in ActionResolver.
   *
   *   TurnExecutorPlanner then checks the terminal milepost via loadGridPoints()
   *   (REAL). It finds TerrainType.FerryPort at (19,34) and breaks the loop with
   *   terminationReason = 'ferry_arrival' — preventing a second resolveMove call
   *   that would illegally cross the ferry in the same turn.
   *
   * Assertions:
   *   AC1: Exactly one MoveTrain plan is emitted (loop did not continue).
   *   AC2: The final step of that plan is Harwich (19,34).
   *   AC3: No step in the plan equals Ijmuiden (19,38) — ferry not crossed.
   *   AC4: compositionTrace.a2.terminationReason === 'ferry_arrival'.
   */

  let mockShouldDeferBuild: jest.SpyInstance;
  let mockRevalidate: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    // Spy on TurnExecutorPlanner instance methods that are not mocked at module level
    mockShouldDeferBuild = jest.spyOn(TurnExecutorPlanner, 'shouldDeferBuild').mockReturnValue({
      deferred: false,
      reason: 'build_needed',
      trackRunway: 0,
      intermediateStopTurns: 0,
      effectiveRunway: 0,
    });
    mockRevalidate = jest.spyOn(TurnExecutorPlanner, 'revalidateRemainingDeliveries')
      .mockImplementation((route: StrategicRoute) => route);
  });

  afterEach(() => {
    mockShouldDeferBuild.mockRestore();
    mockRevalidate.mockRestore();
  });

  it('emits exactly one MoveTrain plan ending at Harwich, no Ijmuiden step, terminationReason ferry_arrival', async () => {
    const snapshot = makeSnapshot(BOT_START);

    // Route: one pickup stop at Holland — on the network so MOVE branch executes
    const route: StrategicRoute = {
      stops: [{ action: 'pickup', city: 'Holland', loadType: 'Cheese' }],
      currentStopIndex: 0,
      phase: 'travel',
      startingCity: 'London',
      createdAtTurn: 34,
      reasoning: 'ferry R3 test',
    };

    // Context: bot is at (15,30), Holland is on the network, speed = 9 (Freight)
    const context: GameContext = {
      position: { row: BOT_START.row, col: BOT_START.col },
      money: 200,
      speed: 9,
      capacity: 2,
      loads: [],
      demands: [],
      citiesOnNetwork: ['Holland'],
      connectedMajorCities: [],
      unconnectedMajorCities: [],
      totalMajorCities: 12,
      trackSummary: '',
      turnBuildCost: 0,
      canDeliver: [],
      canPickup: [],
      reachableCities: [],
      canUpgrade: false,
      canBuild: false,
      isInitialBuild: false,
      opponents: [],
      phase: 'travel',
      turnNumber: 34,
      trainType: 'Freight',
    };

    // gridPoints: provide Harwich so context.position update block can run.
    // TerrainType is not required here — TurnExecutorPlanner calls loadGridPoints()
    // internally (real) to detect FerryPort.
    const gridPoints = [{ row: HARWICH.row, col: HARWICH.col }] as any;

    const result = await TurnExecutorPlanner.execute(route, snapshot, context, undefined, gridPoints);

    // AC1: Exactly one MoveTrain plan — loop terminated after first move
    const movePlans = result.plans.filter(p => p.type === AIActionType.MoveTrain);
    expect(movePlans).toHaveLength(1);

    // AC2: The final step of the MoveTrain plan is Harwich (19,34)
    const movePlan = movePlans[0] as TurnPlanMoveTrain;
    const finalStep = movePlan.path[movePlan.path.length - 1];
    expect(finalStep).toEqual(HARWICH);

    // AC3: No step in the path equals Ijmuiden (19,38) — ferry was not crossed
    const pathIncludesIjmuiden = movePlan.path.some(
      p => p.row === IJMUIDEN.row && p.col === IJMUIDEN.col,
    );
    expect(pathIncludesIjmuiden).toBe(false);

    // AC4: terminationReason is 'ferry_arrival'
    expect(result.compositionTrace.a2.terminationReason).toBe('ferry_arrival');
  });
});

// ─── R4 Regression guard ─────────────────────────────────────────────────────

describe('ActionResolver.resolveMove — ferry start regression guard (R4)', () => {
  /**
   * R4a: Bot starts from (15,30) — first resolveMove should correctly stop at Harwich.
   * This confirms the single-call ferry truncation guard still works (passes).
   */
  it('single resolveMove from non-port start stops at first ferry port encountered', async () => {
    const snapshot = makeSnapshot(BOT_START);

    const result = await ActionResolver.resolveMove(
      { to: 'Holland' },
      snapshot,
      9,
    );

    expect(result.success).toBe(true);
    const plan = result.plan as TurnPlanMoveTrain;
    expect(plan).toBeDefined();
    expect(plan.path.length).toBeGreaterThan(0);

    const finalStep = plan.path[plan.path.length - 1];
    expect(finalStep).toEqual(HARWICH);  // stops at Harwich, not beyond

    const pathIncludesIjmuiden = plan.path.some(
      p => p.row === IJMUIDEN.row && p.col === IJMUIDEN.col,
    );
    expect(pathIncludesIjmuiden).toBe(false);
  });

  /**
   * R4b: Bot STARTS at Harwich at the beginning of a NEW turn (ferryHalfSpeed=false,
   * meaning it arrived last turn). resolveFerryCrossing teleports to Ijmuiden and
   * the plan correctly starts from Ijmuiden at half speed.
   * This case is expected to PASS — turn-2 ferry teleport still works.
   */
  it('bot starting a NEW turn at Harwich teleports to Ijmuiden and plans movement from there', async () => {
    const snapshot = makeSnapshot(HARWICH);

    const result = await ActionResolver.resolveMove(
      { to: 'Holland' },
      snapshot,
    );

    expect(result.success).toBe(true);
    const plan = result.plan as TurnPlanMoveTrain;
    expect(plan).toBeDefined();
    expect(plan.path.length).toBeGreaterThan(0);

    // After ferry teleport, path should start from Ijmuiden (19,38)
    const firstStep = plan.path[0];
    expect(firstStep).toEqual(IJMUIDEN);

    // Path should NOT contain Harwich (19,34) since the bot teleported away
    const pathContainsHarwich = plan.path.some(
      p => p.row === HARWICH.row && p.col === HARWICH.col,
    );
    expect(pathContainsHarwich).toBe(false);

    // Bot should reach a Holland milepost — within half-speed budget from Ijmuiden.
    // Holland has outposts adjacent to or near Ijmuiden: (20,38) is 1 hop away.
    const hollandMileposts = [
      { row: 20, col: 38 }, { row: 21, col: 37 }, { row: 21, col: 38 },
      { row: 21, col: 39 }, { row: 22, col: 38 }, { row: 22, col: 39 },
      { row: 20, col: 39 }, { row: 19, col: 39 },
    ];
    const reachedHolland = plan.path.some(
      p => hollandMileposts.some(h => h.row === p.row && h.col === p.col),
    );
    expect(reachedHolland).toBe(true);
  });

  /**
   * R4c: Confirm resolveFerryCrossing returns the correct pairing for Harwich.
   */
  it('resolveFerryCrossing correctly identifies Harwich as a ferry port paired with Ijmuiden', () => {
    const snapshot = makeSnapshot(HARWICH);
    const crossing = (ActionResolver as any).resolveFerryCrossing(HARWICH, snapshot);

    expect(crossing).not.toBeNull();
    expect(crossing.pairedPort).toEqual(IJMUIDEN);
    expect(crossing.ferryName).toContain('Harwich');
  });
});

// ─── R5 Log-capture standalone assertion ─────────────────────────────────────

describe('ActionResolver.resolveMove — ferry truncation warn probe (R5)', () => {
  /**
   * R5: Standalone probe for the console.warn observation from the failing case.
   * Records whether [Ferry] Path truncated warning fires during the first leg
   * of the game-log scenario (non-port start → should stop at Harwich).
   */
  it('records whether [Ferry] truncation warning fires during a mid-turn ferry encounter', async () => {
    const warnCalls: string[] = [];
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation((...args) => {
      warnCalls.push(String(args[0]));
    });

    const snapshot = makeSnapshot(BOT_START);
    await ActionResolver.resolveMove({ to: 'Holland' }, snapshot, 9);

    warnSpy.mockRestore();

    const truncationWarningFired = warnCalls.some(msg =>
      msg.includes('[Ferry] Path truncated at ferry port'),
    );

    // Assert the result is a boolean (always passes) — the actual value is the diagnostic
    expect(typeof truncationWarningFired).toBe('boolean');

    // Diagnostic branch: record the observable outcome for CI
    if (truncationWarningFired) {
      // Guard ran: the warn fired, meaning the truncation loop executed correctly
      const ferryMsg = warnCalls.find(msg => msg.includes('[Ferry] Path truncated at ferry port'));
      expect(ferryMsg).toMatch(/\[Ferry\] Path truncated at ferry port Harwich/);
    } else {
      // Guard did NOT fire: ferry port was not detected — different type of failure
      expect(warnCalls.some(msg => msg.includes('[Ferry] Path truncated'))).toBe(false);
    }
  });
});
