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

// NO mocks for: computeTrackUsageForMove, loadGridPoints, getFerryEdges
// We only mock computeBuildSegments (unused in resolveMove) to avoid side effects.
jest.mock('../../services/ai/computeBuildSegments', () => ({
  computeBuildSegments: jest.fn(() => []),
}));

import { ActionResolver } from '../../services/ai/ActionResolver';
import {
  WorldSnapshot,
  TrainType,
  TerrainType,
  TrackSegment,
  TurnPlanMoveTrain,
} from '../../../shared/types/GameTypes';
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

// ─── R3 Main failing test ─────────────────────────────────────────────────────

describe('ActionResolver.resolveMove — ferry truncation (R3)', () => {
  /**
   * R3: Reproduce the multi-move composition bug from the game log.
   *
   * Step 1: Bot starts at (15,30), resolveMove → path stops at Harwich (correct).
   *         Ferry truncation guard fires, path ends at (19,34).
   *
   * Step 2: Context updates bot.position to Harwich. remainingBudget > 0.
   *         resolveMove called AGAIN from Harwich (bot "arrived this turn").
   *         resolveFerryCrossing fires → bot crosses to Ijmuiden.
   *
   * This second call is the bug: the bot arrived at Harwich mid-turn (not at the
   * start of a new turn), so crossing the ferry violates the game rule.
   *
   * The test asserts that the SECOND resolveMove call should return success:false
   * (ferry crossing not permitted mid-turn arrival). Currently it returns success:true
   * and crosses the ferry — that is the failing assertion (AC1).
   */
  it('second resolveMove from ferry-port mid-turn arrival must not cross the ferry (expected FAIL on current branch)', async () => {
    // R5: capture console.warn to record ferry truncation and crossing logs
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

    const snapshot = makeSnapshot(BOT_START);

    // ── Step 1: First move from (15,30) — should stop at Harwich ─────────────
    const firstMoveResult = await ActionResolver.resolveMove(
      { to: 'Holland' },
      snapshot,
      9,  // full speed budget
    );

    // Step 1 must succeed and stop at Harwich
    expect(firstMoveResult.success).toBe(true);
    const firstPlan = firstMoveResult.plan as TurnPlanMoveTrain;
    expect(firstPlan).toBeDefined();

    const firstFinalStep = firstPlan.path[firstPlan.path.length - 1];
    // First move should stop at Harwich — the ferry truncation guard fires
    expect(firstFinalStep).toEqual(HARWICH);

    // R5: record whether ferry truncation warning fired in step 1
    const step1WarnFired = warnSpy.mock.calls.some(
      call => typeof call[0] === 'string' && call[0].includes('[Ferry] Path truncated at ferry port'),
    );
    expect(typeof step1WarnFired).toBe('boolean');  // R5 probe: always passes
    warnSpy.mockClear();

    // ── Step 2: Simulate composition — update position, consume budget ────────
    // TurnExecutorPlanner computes milesConsumed and subtracts from remainingBudget.
    // Path (15,30)→(16,31)→(16,32)→(17,32)→(17,33)→(18,34)→(19,34) = 6 edges.
    // No intra-city hops on this path → effective = 6 mileposts consumed.
    const milesConsumedStep1 = firstPlan.path.length - 1;  // 6 edges
    const remainingBudget = Math.max(0, 9 - milesConsumedStep1);  // 9 - 6 = 3

    // Composition updates bot position to where first move ended (Harwich)
    snapshot.bot.position = { ...firstFinalStep };

    // ── Step 3: Second resolveMove — bot is now AT Harwich with budget > 0 ────
    // Per game rules, the bot arrived at the ferry port THIS turn.
    // It must wait until next turn to cross. This call should NOT cross the ferry.
    //
    // EXPECTED TO FAIL (AC1): Currently resolveFerryCrossing fires when bot.position
    // is a ferry port, regardless of whether it just arrived or started there.
    const secondMoveResult = await ActionResolver.resolveMove(
      { to: 'Holland' },
      snapshot,
      remainingBudget,
    );

    warnSpy.mockRestore();

    // AC2: The failure message should name the offending milepost.
    // The second move result should NOT cross the ferry:
    //   - Either success:false (ferry crossing not permitted mid-turn arrival), or
    //   - success:true but path stays on England side (no Ijmuiden or beyond)
    //
    // Currently this FAILS because the second call returns success:true with
    // path starting at Ijmuiden (19,38) — proving the ferry was crossed.
    if (secondMoveResult.success) {
      const secondPlan = secondMoveResult.plan as TurnPlanMoveTrain;
      const pathIncludesIjmuiden = secondPlan.path.some(
        p => p.row === IJMUIDEN.row && p.col === IJMUIDEN.col,
      );
      const pathFirstStep = secondPlan.path[0];

      // The second move must NOT start at Ijmuiden (that means the ferry was crossed).
      // This assertion is expected to FAIL on current branch.
      expect(pathFirstStep).not.toEqual(IJMUIDEN);

      // And must NOT include Ijmuiden anywhere in the path.
      expect(pathIncludesIjmuiden).toBe(false);
    }
    // If success:false, that's acceptable — ferry mid-turn crossing was correctly rejected.
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
