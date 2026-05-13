# JIRA-232 — Affordability gate underestimates cash drain (technical)

Companion to `jira-232-affordabilityGateUnderestimatesCashDrain-behavioral.md`. Read that first for evidence and acceptance.

## Current implementation

### Affordability gate (`scoreCandidate`)

`src/server/services/ai/DeterministicTripPlanner.ts:586-643` — `scoreCandidate` calls `simulateTrip`, then:

```ts
const floor = affordabilityOptions?.affordabilityFloorM ?? AFFORDABILITY_FLOOR_M;  // = 0
const startingCash = snapshot.bot.money;
const projectedMin = startingCash + result.minCashRelative;
if (projectedMin < floor) {
  return { ...candidate, ..., feasible: false };
}
```

`result.minCashRelative` comes from `simulateTrip`'s internal `cashRelative` tracking. The gate accepts the candidate only when the simulated worst cash dip stays at or above zero.

### Cash-flow tracking in `simulateTrip`

`src/server/services/ai/RouteDetourEstimator.ts:515-627`:

- Line 546: `let cashRelative = 0;` — initialized to zero (deltas, not absolute)
- Line 583: `cashRelative -= builtThisTurn;` — each build turn subtracts spend
- Line 584: `minCashRelative = Math.min(minCashRelative, cashRelative);` — tracks worst dip
- Line 619: `cashRelative += stop.payment;` — delivery payouts add back
- Line 620: also updates `minCashRelative` post-delivery
- Line 626: returns `{ turnsToComplete, totalBuildCost, feasible, minCashRelative, finalCashRelative }`

**No upgrade-cost subtraction anywhere in this function.** The simulator has no input signaling that an upgrade will be paid alongside this route.

### Upgrade emission (`selectUpgradeTarget`)

`src/server/services/ai/DeterministicTripPlanner.ts:807-831`:

```ts
function selectUpgradeTarget(currentTrainType, cash, tripBuildCost, capSaturatedTurns):
  { target?, gateReason? }
{
  // ... train-type-based target selection ...
  if (cash >= UPGRADE_COST_M + tripBuildCost) return { target };
  return {};
}
```

This is called in `planTripDeterministic` AFTER `scoreCandidate` runs for all candidates and the top-1 is picked. The upgrade is emitted on the chosen route. **The upgrade's existence is unknown to `scoreCandidate` and to the simulator while they're computing feasibility.**

### Build-cost prediction (`pathToNewSegments`)

`simulateTrip` builds the candidate's path via:

```ts
const path = findShortestBuildablePath(currentPos, cityCoord, existingEdges, existingNodes, opponentEdges, grid, majorCityLookup, ferryAdjacency);
const newSegs = pathToNewSegments(path, existingEdges, grid, majorCityLookup, ferryPortCosts);
const legBuildCost = newSegs.reduce((sum, seg) => sum + seg.cost, 0);
```

`pathToNewSegments` (search `RouteDetourEstimator.ts` for `function pathToNewSegments`) takes the Dijkstra-result path and constructs `TrackSegment[]` for new (unbuilt) edges with per-segment cost. The runtime executor at BuildTrack-action time does its own path-finding and cost computation; the two paths/costs must match for `simulateTrip`'s prediction to hold.

## Fix plan

### Defect A — upgrade cost in cash flow

Two implementation options. Pick one:

**Option A1 (simpler): subtract upgrade cost in `scoreCandidate`, after the gate's `projectedMin` computation but before the comparison.**

The challenge: `scoreCandidate` doesn't currently know whether `selectUpgradeTarget` would emit an upgrade for this candidate. It would need to call `selectUpgradeTarget` itself to check. `selectUpgradeTarget` is cheap (constant time, no I/O), so this is acceptable.

```ts
// In scoreCandidate, after simulateTrip returns:
const projectedMin = startingCash + result.minCashRelative;

// JIRA-232: subtract upgrade cost when an upgrade would be emitted alongside this candidate
const wouldEmitUpgrade = selectUpgradeTarget(
  snapshot.bot.trainType,
  snapshot.bot.money,
  result.totalBuildCost,
  memory?.capSaturatedTurns ?? 0,
).target != null;
const upgradeCost = wouldEmitUpgrade ? UPGRADE_COST_M : 0;
const projectedMinWithUpgrade = projectedMin - upgradeCost;

if (projectedMinWithUpgrade < floor) {
  return { ...candidate, ..., feasible: false };
}
```

Pro: minimal change to `simulateTrip`. Con: duplicates the upgrade emission logic (called once here, again later in `planTripDeterministic`). Mitigation: memoize the result if perf matters, or accept the duplicate call (it's O(1)).

**Option A2 (cleaner): pass `pendingUpgradeCost` into `simulateTrip` and have it subtract on turn 0.**

```ts
export function simulateTrip(
  startPos: GridCoord,
  stopsInOrder: RouteStop[],
  snapshot: SnapshotInput,
  options?: { pendingUpgradeCost?: number },
): TripSimulation {
  // ... existing setup ...
  
  // JIRA-232: subtract upgrade cost from cash on turn 0 (before any build/move)
  if (options?.pendingUpgradeCost && options.pendingUpgradeCost > 0) {
    cashRelative -= options.pendingUpgradeCost;
    minCashRelative = Math.min(minCashRelative, cashRelative);
  }
  
  // ... rest of simulation ...
}
```

Caller (`scoreCandidate`) computes `pendingUpgradeCost` via `selectUpgradeTarget` and passes it in. This keeps the cash-flow logic centralized in `simulateTrip` and makes the upgrade-cost contribution visible in `minCashRelative` itself rather than as a separate adjustment.

Recommend **Option A2** for cleanliness. The `simulateTrip` signature changes but the new parameter is optional, so existing callers (mostly tests) keep working.

Either option must update `selectUpgradeTarget`'s caller in `planTripDeterministic` (around line 985+) to use the same call signature for consistency — when the actual emission happens, the same upgrade decision is made.

### Defect B — simulator-vs-runtime build cost divergence

This is investigative work; the fix shape depends on the diagnosis. Steps:

**Step 1: Instrument.** Add logging in `planTripDeterministic` that records `top1.buildCost` (simulator's prediction) and the route's `cardIndex` pair. Add separate logging in `TurnExecutor.handleBuildTrack` (or wherever the runtime BuildTrack action is processed) that records each turn's build spend, attributed to the active route. Run a few games; aggregate per-route predicted-vs-actual.

If predicted ≈ actual within ±1M across many routes, Defect B doesn't exist and the broke-state was driven by Defect A alone — close this part of the ticket. If the discrepancy is real (5-10M overruns confirmed), proceed.

**Step 2: Diagnose.** With instrumentation data, narrow the cause:
- Are the simulator's path mileposts the same as the runtime's? Compare `path` from `findShortestBuildablePath` against the runtime's per-turn build target sequence.
- Are individual segment costs identical? `pathToNewSegments` uses `getTerrainCost` and ferry cost from `getFerryAdjacency`; the runtime uses the same primitives — but does it apply them identically? Check water-crossing handling specifically (rivers add 2M to the destination milepost; the simulator's `pathToNewSegments` and the runtime's BuildTrack handler must apply this identically).
- Are major-city entry costs applied identically (5M for major, 3M for medium/small)?

**Step 3: Fix.** Once the divergence is identified, decide:
- Make the runtime use the simulator's predicted path (executor consumes the route's stops and follows the simulator-computed path verbatim), OR
- Make the simulator predict the runtime's actual path-choice algorithm (simulator emulates the runtime executor's per-turn decisions, not Dijkstra over the whole route at once).

Option 1 is simpler; Option 2 is more accurate if the runtime is doing something the simulator can't model.

### Acceptance: regression tests

In `src/server/__tests__/ai/DeterministicTripPlanner.test.ts`:

```ts
describe('JIRA-232 — affordability gate includes upgrade cost', () => {
  it('rejects route + upgrade combo when projectedMin minus upgrade falls below floor', () => {
    // Fixture: bot on Freight, cash 30M. Route candidate: build 14M predicted (NET -4M).
    // selectUpgradeTarget would emit fast_freight (cost 20M).
    // Patched gate: projectedMin = 30 + (-14) - 20 = -4M < 0 → reject.
    // Without patch: projectedMin = 30 + (-14) = 16M ≥ 0 → approve (defect).
    // ... mock simulateTrip, snapshot, etc.
    // Assert candidate.feasible === false.
  });

  it('approves route + upgrade combo when projectedMin minus upgrade remains above floor', () => {
    // Fixture: bot on Freight, cash 60M. Route candidate: build 14M predicted.
    // Patched gate: projectedMin = 60 + (-14) - 20 = 26M ≥ 0 → approve.
    // Assert candidate.feasible === true.
  });

  it('does not subtract upgrade cost for candidates whose upgrade emission would be suppressed', () => {
    // Fixture: bot already on Superfreight (no upgrade target available).
    // Patched gate: projectedMin = startingCash + minCashRelative (no -20M).
    // Assert candidate.feasible === true at boundary cash levels.
  });
});

describe('JIRA-232 — game 20e24f2d t9 regression', () => {
  it('Wine + upgrade route at t9 is rejected OR its projection accurately reflects post-upgrade cash', () => {
    // Reconstruct s1's snapshot at t9: cash 45M post-Coal-delivery, train freight, 
    // demand cards from log, existing segments from t1-t8 BuildTrack events.
    // Run planTripDeterministic. Assert:
    //   EITHER (a) Wine route is rejected and a different (smaller) candidate wins,
    //   OR (b) Wine route is chosen and its projectedMin matches observed cash dip 
    //          (cash drained to ~$0 over t10-t15) within ±5M.
  });
});
```

## Test strategy

Unit tests above cover Defect A end-to-end. For Defect B, **the first deliverable is the instrumentation patch + a test that asserts predicted = actual (with tolerance)**. That test will fail until the underlying divergence is found and fixed. The implementer's actual fix is whatever the diagnosis turns up; the test contract is just "the simulator's prediction must match the runtime's cumulative build, ±2M, across at least 3 representative test routes."

Regression test for game `20e24f2d` t9 may need to skip the actual route's `simulateTrip` execution and instead assert against a fixture that mirrors what the patched gate would compute. Reconstructing the full t9 snapshot is non-trivial (existing segments from 8 turns of game state, etc.).

## Implementation order

1. **Option A2: extend `simulateTrip` with `pendingUpgradeCost` parameter.** Self-contained; no behavior change for existing callers.
2. **Wire `scoreCandidate` to pass `pendingUpgradeCost` to `simulateTrip`.** Behavior change: the affordability gate now sees upgrade costs. Some currently-approved routes will start failing the gate. Run JIRA-227, JIRA-228, JIRA-229, JIRA-230 test suites; expect some test fixtures to need cash-level adjustments.
3. **Instrument predicted-vs-actual build cost.** Add logging; no behavior change.
4. **Investigate Defect B mechanism using instrumentation data from steps 3.** This is research, not implementation. Document findings in a comment in the ticket.
5. **Fix Defect B based on diagnosis.** Specific changes depend on what step 4 finds.
6. **Add JIRA-232 regression tests** (game 20e24f2d t9, game d04bca96 t26).

Step 1-2 can ship even before Defect B is fully diagnosed. They close the upgrade-cost half of the bug. Step 3-5 are the longer tail; step 5 may itself be a follow-up JIRA depending on what's found.

## Risk and rollback

- **Behavior change risk (steps 1-2)**: routes previously approved that included upgrades will now be rejected if their post-upgrade `projectedMin` is below the floor. This is the intended behavior, but downstream effects need verification: does the bot still pick *some* route in these situations, or does it cascade into "no feasible candidates" and PassTurn? If the latter, JIRA-233 (the safety-net recovery work I drafted separately) becomes urgent. The right outcome is: rejected routes cause the planner to pick a less-ambitious route from its candidate set; if no candidate fits, the bot is genuinely broke and PassTurn / DiscardHand is correct.
- **Test fixture churn**: tests that approve a route + upgrade with a known `projectedMin` calculation may need cash-level adjustments to keep their assertions valid. Document each change in commit messages.
- **Rollback**: revert step 2 alone to restore old gate behavior. Step 1's signature extension is harmless on its own.

## Definition of done

- Steps 1-2 implemented behind their own commits.
- Defect A regression tests pass.
- Instrumentation (step 3) emitted for at least 3 games' worth of data.
- Defect B mechanism documented in this ticket's comments (even if the fix is deferred to a follow-up).
- Game `20e24f2d` t9 and game `d04bca96` t26 regression tests pass under the new gate.
- No regression in JIRA-227, JIRA-228, JIRA-229, JIRA-230 test suites (with test-fixture cash adjustments documented).
