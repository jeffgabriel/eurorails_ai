# JIRA-253 — Narrow `a3_abandon_for_carry_deliver_partial` to genuine pathological partials (technical)

Companion to `jira-253-routeImpossibleLivelock-behavioral.md`.

## Defect locus

`src/server/services/ai/MovementPhasePlanner.ts:530-537`:

```ts
// computeBuildSegments returned segments but the path does not reach
// the build target (partial path) AND bot carries a deliverable
// on-network load → abandon so the next turn produces a carry-deliver
// plan instead of committing budget to a partial route.
if (
  (lastSeg.to.row !== a3TargetCoord.row || lastSeg.to.col !== a3TargetCoord.col) &&
  hasCarriedDeliverableOnNetwork(context)
) {
  console.warn(`${tag} a3_abandon_for_carry_deliver_partial — partial build path, carry-deliverable on-network`);
  trace.a3.terminationReason = 'a3_abandon_for_carry_deliver_partial';
  routeAbandonedByImpossibility = true;
  break;
}
```

The predicate "last segment's `to` ≠ target coordinate" is true for **every** build path that exceeds 20M (Phase B's per-turn cap). `computeBuildSegments` returns at most 20M-worth of segments; if the target is 21M+ away, the last segment lands short of the target. The abandon then fires.

This conflates two different states:
- **Normal multi-turn progress**: `lastSeg.to !== target` because the path is incomplete *this turn*, but `computeBuildSegments` made meaningful progress and the build will complete next turn.
- **Pathologically partial**: `lastSeg.to !== target` because the path is incomplete *period* — there's a structural blocker (saturated city, ferry obstacle, water with no crossing, opponent track Right-of-Way) that the bot can't get around.

Only the second case justifies abandoning.

## Fix shape

Two layers; **layer A is the main fix**, layer B is a safety net.

### Layer A — Compute "is this build genuinely blocked?" not "is the path partial?"

Replace the partial-path check with a real reachability check. Two options:

**Option A1 (recommended).** Re-run `computeBuildSegments` with `budget = Infinity` (or a large bound like 200M). If the unbounded path also doesn't reach the target, the path is genuinely blocked → abandon is appropriate. If the unbounded path DOES reach the target, the partial we got is just budget-limited → don't abandon.

```ts
const a3UnboundedResult = computeBuildSegments({
  ...a3Params,
  budget: 999, // effectively infinite for hex-grid build paths
});
const isStructurallyReachable = a3UnboundedResult.length > 0 &&
  a3UnboundedResult[a3UnboundedResult.length - 1].to.row === a3TargetCoord.row &&
  a3UnboundedResult[a3UnboundedResult.length - 1].to.col === a3TargetCoord.col;

if (!isStructurallyReachable && hasCarriedDeliverableOnNetwork(context)) {
  trace.a3.terminationReason = 'a3_abandon_for_carry_deliver_partial';
  routeAbandonedByImpossibility = true;
  break;
}
```

Performance: one extra `computeBuildSegments` call per turn when A3 fires. The function is already O(grid) Dijkstra; one extra call per turn is acceptable. Cache the result if perf matters.

**Option A2 (alternative).** Add a `reason` field to `computeBuildSegments`'s return: `'budget_exhausted' | 'no_path' | 'reached'`. Only abandon when `'no_path'`. Cleaner contract but a bigger code change.

### Layer B — Even if abandoned, exclude the candidate on next replan

Independent of layer A: when A3 abandons a route, the next turn's planner currently re-picks the same candidate because the demand state hasn't changed. The replan needs to know which candidate was just abandoned, so it doesn't re-emit it.

Pass an `excludeRouteSignature: string[]` argument to `TripPlanner.planTrip`. When abandoning a route, compute a signature like `pair:Steel-Copper:supply-Ruhr-Wroclaw` (similar to the planner's reasoning string) and add it to the exclusion set for the next call. The signature persists in `memory.recentlyAbandonedRouteKeys` for N turns (suggest 3).

If layer A is in place, layer B is rarely needed (the route stops being abandoned in the first place). But layer B is a defense-in-depth gate against future abandon-loop bugs.

### Layer C — Gate `upgradeOnRoute` on route execution

Independent fix: wherever the executor processes `upgradeOnRoute` (search the codebase for the string), gate it on "route was not abandoned this turn." Currently the upgrade fires even when the route is being abandoned (T10 in the game evidence). The bot self-inflicted a $20M loss for an upgrade tied to a route it never executed.

```ts
if (route.upgradeOnRoute && !routeWasAbandonedThisTurn) {
  // emit UpgradeTrain action
}
```

## Acceptance from behavioral

- **AC1** Unit test on `MovementPhasePlanner.run`: fixture where `computeBuildSegments` returns a partial path (20M of segments toward a 21M target) AND `hasCarriedDeliverableOnNetwork` is true. With layer A in place, assert: A3 does NOT set `a3_abandon_for_carry_deliver_partial`. The composition trace shows the build proceeding.
- **AC2** Unit test: fixture where `computeBuildSegments` returns a partial path AND the unbounded re-run ALSO returns a partial path (pathological case — e.g., target is in an enclave the bot can't reach). Assert: A3 DOES set `a3_abandon_for_carry_deliver_partial`.
- **AC3** Unit test on Phase B composition: same fixture as AC1. Assert: `composition.build.cost > 0`, `composition.build.target` is the route's next pickup city, `segmentsBuilt > 0`.
- **AC4** Unit test on `upgradeOnRoute` gate: fixture where A3 abandoned the route this turn AND the route has `upgradeOnRoute = 'Superfreight'`. Assert: UpgradeTrain action is NOT emitted; the upgrade is suppressed with `upgradeSuppressionReason = 'route_abandoned_this_turn'` recorded.
- **AC5** Integration regression on game `6033c903` Sonnet T8 snapshot, 5 turns: assert build progress is observable (`composition.build.cost > 0` at least once) AND cash does NOT drop by $20M from a same-turn `upgradeOnRoute` while the route is being abandoned.

## Not in scope

- Generalized "scorer-vs-executor parity" auditing across all simulation paths — not the bug here.
- LLM-path equivalent abandon logic — the LLM produces prompts that already include carry-deliver instructions; focus the fix on the deterministic (Medium) path.
- Re-thinking JIRA-246's carry-deliver-first heuristic at a higher level. The heuristic is fine; the trigger predicate is too aggressive.
- The unrelated `connectedMajorCities` vs `trackCostToDelivery` inconsistency (mentioned in behavioral). Worth following up if it produces visible bugs, but is not the cause of the livelock here.

## Validation hooks to inspect during fix

- `composition.a3.terminationReason` at T8 of game `6033c903` should NOT be `a3_abandon_for_carry_deliver_partial` after the fix. Expected: `a3_move_success` or similar progress reason.
- `composition.build.cost` at T8 should be > 0 (specifically, ≤ 20M, the Phase B cap, with progress toward Wroclaw).
- `composition.build.target` should equal `Wroclaw` (the route's next pickup-requiring city).
- A new `composition.upgrade.skippedReason` field should record `route_abandoned_this_turn` if the upgrade gate from layer C fires (no fire expected after layer A, but the gate is defense-in-depth).

## Relationship to existing JIRAs

- **JIRA-246** added the carry-deliver abandon paths in A3. The intent (prefer free carry-delivery over big builds) is preserved; this ticket narrows the trigger to genuine pathological partials.
- **JIRA-247** addressed a sibling A3 livelock (`origin_is_current_position`). Same family — A3 termination reasons leading to PassTurn loops. JIRA-253 is the partial-path analog.
- **JIRA-248/250** ensure carried-load deliveries are represented in the candidate set as a floor. With layer A in place, the planner's choice of pair-shared-delivery over carry-only is preserved AND actually executed.
- **JIRA-252** (post-delivery replan ordering) is the sibling: both involve the executor mishandling a turn. 253 is about start-of-turn abandon-vs-execute; 252 is about post-delivery sequencing.
