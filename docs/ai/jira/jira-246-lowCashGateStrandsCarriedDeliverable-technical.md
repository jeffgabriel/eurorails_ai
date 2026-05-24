# JIRA-246 — Remove cash-floor gate + add carry-deliver abandon path when build infeasible (technical)

Companion to `jira-246-lowCashGateStrandsCarriedDeliverable-behavioral.md`.

## Defect locus

Two coupled sites:

1. **`src/server/services/ai/routeHelpers.ts:202-217`** — the JIRA-165 Fix 2 capital-allocation gate, which returns `null` from `resolveBuildTarget` when `context.money < 5` and a carry-deliverable exists. This is a $5M cash reserve floor.

2. **`src/server/services/ai/MovementPhasePlanner.ts:432-524`** — A3 has no fall-through path that abandons the active route when `computeBuildSegments` cannot produce a complete affordable build to the route's current stop AND a carry-deliverable exists. When the build is infeasible, A3 either emits PassTurn (via `no_build_target` or `build_dijkstra_failed`) or runs a partial multi-turn build that doesn't reach the target.

The cash-floor at site 1 is redundant — the affordability cap at `MovementPhasePlanner.ts:458` (`Math.min(TURN_BUILD_BUDGET - context.turnBuildCost, snapshot.bot.money)`) already prevents the bot from spending money it doesn't have. Removing the gate is safe; the natural cap handles the "broke + multi-turn build" case correctly (zero segments fit when zero cash).

## Fix shape

### Fix A — Remove the cash-floor from `resolveBuildTarget`

`routeHelpers.ts:202-214` — delete the gate entirely:

```ts
// Route-based target — find first off-network stop city
const routeTarget = findRouteBasedTarget(route, context);

// JIRA-165 Fix 2: Capital allocation gate — REMOVED (JIRA-246).
// The $5M threshold was a cash reserve floor; bot policy is spend-to-zero.
// Downstream affordability is already enforced by computeBuildSegments's
// budget cap (MovementPhasePlanner.ts:458). The redirect this gate intended
// is now handled in A3 (see Fix B).

return routeTarget;
```

This removes the cash threshold. `resolveBuildTarget` returns the route's first off-network stop city unconditionally (subject to its other existing checks — victory branch, route validity).

### Fix B — Add a carry-deliver abandon path in A3 when build is infeasible

`MovementPhasePlanner.ts:432-524` (A3's build-target-preview section).

Two sub-cases to handle, distinguished by the current `terminationReason` chain:

**Sub-case B1: `computeBuildSegments` returns `[]`** (already-handled empty case, JIRA-244 Fix B at lines 468-481). When the JIRA-244 reachability check fails (`isCoordOnNetwork` returns false → `build_dijkstra_failed`), check for carry-deliverable. If present → abandon route.

**Sub-case B2: `computeBuildSegments` returns a partial path that doesn't reach the target.** Today (lines 482-517) A3 either moves to the build origin or runs the build. Neither finishes the connection in this turn. When the path is partial AND a carry-deliverable exists, abandon route instead.

Concrete patch at the two existing decision points:

```ts
// Helper, defined locally or imported from routeHelpers (preferred — co-locate
// with the now-removed gate's logic). Pure function over context.
function hasCarriedDeliverableOnNetwork(context: GameContext): boolean {
  return context.demands.some(d => d.isLoadOnTrain && d.isDeliveryOnNetwork);
}

// Existing JIRA-244 Fix B block (lines 468-481), extend the else branch:
if (a3OriginResult.length === 0) {
  // JIRA-244 Fix B: distinguish "target already reachable" from "no path found".
  const a3Network = snapshot.bot.existingSegments.length > 0
    ? buildTrackNetwork(snapshot.bot.existingSegments)
    : null;
  const a3FerryEdges = getFerryEdges();
  if (a3Network && isCoordOnNetwork(a3TargetCoord, a3Network, a3FerryEdges)) {
    trace.a3.terminationReason = 'a3_target_already_reachable';
    continue;
  }
  // JIRA-246: build path not found AND we have a carry-deliverable on-network.
  // Abandon the route so the replanner produces a carry-deliver plan.
  if (hasCarriedDeliverableOnNetwork(context)) {
    trace.a3.terminationReason = 'a3_abandon_for_carry_deliver';
    routeAbandonedByImpossibility = true;
    break;
  }
  trace.a3.terminationReason = 'build_dijkstra_failed';
}

// Existing partial-path branch (lines 482-517), extend with a completion check:
} else {
  // JIRA-246: detect whether the returned segment chain actually reaches the
  // build target this turn. If not AND a carry-deliverable exists, abandon.
  const lastSeg = a3OriginResult[a3OriginResult.length - 1];
  const reachesTarget = lastSeg.to.row === a3TargetCoord.row && lastSeg.to.col === a3TargetCoord.col;
  if (!reachesTarget && hasCarriedDeliverableOnNetwork(context)) {
    trace.a3.terminationReason = 'a3_abandon_for_carry_deliver_partial';
    routeAbandonedByImpossibility = true;
    break;
  }

  const previewBuildOrigin = a3OriginResult[0].from;
  // ... existing currentPos/move/build logic (lines 484-517 unchanged)
}
```

The existing `routeAbandonedByImpossibility` flag (set by JIRA-233's impossibility check earlier in the function, consumed at line 539-541) already triggers the route-abandon return path. Re-using it requires no new plumbing.

### Why two trace reasons (`a3_abandon_for_carry_deliver` vs `a3_abandon_for_carry_deliver_partial`)

For post-game forensics: distinguishing "no path found" vs "partial path found" tells us whether the abandon is due to genuine unreachability or affordability. The behavior is identical (both abandon), but the log reason differs.

## Tests

`src/server/__tests__/ai/routeHelpers.test.ts`:
- AC1 — assert `resolveBuildTarget` no longer contains the `context.money < 5` comparison. Existing tests covering the gate's positive cases (gate fires when broke + deliverable) need to be deleted or inverted (now the gate doesn't fire — the function returns the build target).

`src/server/__tests__/ai/MovementPhasePlanner.test.ts`:
- AC2 — integration test for the s1 T16 case: fixture with broke bot, carried deliverable on-network, off-network current stop. Assert: result includes `routeWasAbandoned: true` and `outputPlan` is empty (no PassTurn).
- AC4 — high-cash case: same fixture with `money: 50`. Assert: A3 builds toward target (no abandon).
- AC5 — no carry-deliverable: same fixture without `isLoadOnTrain` matching `isDeliveryOnNetwork`. Assert: existing A3 behavior (partial build or PassTurn — no new abandon).
- AC6 — sufficient cash + carry-deliverable + affordable build: A3 builds normally. Abandon must not fire.
- Partial-path coverage: fixture where `computeBuildSegments` returns 1-2 segments not reaching target. With carry-deliverable → abandon. Without → continue with partial.

## Risk

- **Removing the cash-floor changes resolveBuildTarget's return shape**: a previously `null`-returning path now returns the build target. Existing tests that asserted `null` need to be deleted (the case no longer null-returns). Other call sites of `resolveBuildTarget` (`BuildPhasePlanner.ts`, possibly `BuildAdvisor.ts`) already handle non-null returns — they were the path the gate was preventing — so no upstream changes required.
- **Carry-deliver abandon path**: the abandon fires only when (a) a carry-deliverable on-network exists AND (b) the build is infeasible (no path OR partial path). The "infeasible" condition is the same set that previously caused PassTurn or partial multi-turn builds. No regression on cases that already worked.
- **Route-abandon side effects**: `lastAbandonedRouteKey` memory is updated. The replanner avoids re-selecting the same key for one turn. Since the new route should be a single-stop carry-deliver (a different key), no risk of immediate re-selection.

## Not in scope

- JIRA-247 `origin_is_current_position` (separate fix, separate file).
- Changing the route planner to put carried deliveries first when they're on-network (a planner-level fix; this defect lives in the executor and recovers gracefully when the planner produces the wrong order).
- Changing the affordability cap at `MovementPhasePlanner.ts:458` (already correct).
- Anything in `BuildPhasePlanner.ts` or `BuildAdvisor.ts` — these call `resolveBuildTarget` but their handling of non-null returns is already correct.
