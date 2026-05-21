# JIRA-224 — `freshSnapshot.bot.loads` override after DB capture is suspect (technical)

See `jira-224-freshSnapshotLoadsOverride-behavioral.md` for the observed behavior and acceptance criteria.

## Root cause

Pre-`116346f`, `snapshot.bot.loads` was mutated in many places and rarely reflected DB truth. The override at `MovementPhasePlanner.ts:291` was the planner's way of ensuring `freshSnapshot.bot.loads` reflected the most recent local mutations even after a DB capture (which might lag a same-turn write).

Post-`116346f`, mutation ownership is consolidated. The local `snapshot.bot.loads` is updated by the same code path that issued the DB write. A subsequent `capture()` call returns the same loads list. The override is now a no-op in the happy path and a silent corruption hazard in any divergence path.

## Investigation steps

1. Find every call site that reaches `MovementPhasePlanner.ts:290-294`. Search for the enclosing function and trace upward.
2. For each entry path, identify the state of `context.loads` and DB at line 290:
   - Does `context.loads` reflect post-delivery state? (Should — handlers update it.)
   - Does the DB write for the delivery commit before `capture()`? (Should — early-exec does, deferred-exec is committed by the time we reach the post-delivery branch.)
3. Construct a divergence test case: under what conditions would the two arrays disagree at this exact line?
   - Early-exec failure path: `context.loads` may have been pre-updated optimistically; failure fallback may not have rolled back. Worth checking.
   - Event-card-induced load drop: handler may update DB and local snapshot but not `context.loads`. Worth checking.
4. Decide: remove vs guard vs document.

## Proposed fix paths (pick one based on AC2 finding)

### Path A — Remove the override (preferred if no divergence flow found)

```ts
const freshSnapshot = await capture(snapshot.gameId, snapshot.bot.playerId);
// freshSnapshot.bot.loads is now DB-authoritative; trust it.
context.loads = [...freshSnapshot.bot.loads]; // reverse direction: align context to DB
context.demands = ContextBuilder.rebuildDemands(freshSnapshot, gridPoints);
context.canDeliver = ContextBuilder.rebuildCanDeliver(freshSnapshot, gridPoints);
snapshot.bot.resolvedDemands = freshSnapshot.bot.resolvedDemands;
```

This reverses the data flow: the DB capture is now the source, and `context.loads` is realigned to it. Eliminates the corruption hazard at the cost of one realignment.

### Path B — Guard with fail-fast (if a specific divergence flow IS still needed)

```ts
const freshSnapshot = await capture(snapshot.gameId, snapshot.bot.playerId);
if (!loadsArraysEqual(freshSnapshot.bot.loads, context.loads)) {
  // log explicit warning; pick the explicit reconciliation rule per the documented flow
  console.warn(`${tag} JIRA-224: loads divergence detected. db=${...} context=${...}`);
}
freshSnapshot.bot.loads = [...context.loads]; // documented as: <specific flow this compensates for>
```

Only viable if AC2 identifies a real flow that requires the override.

### Path C — Delete the override outright (if AC2 confirms always-equal)

Just remove the line and let the DB capture stand.

## Files to touch

- `src/server/services/ai/MovementPhasePlanner.ts:290-294` — primary site.
- `src/server/__tests__/ai/MovementPhasePlanner*.test.ts` — verify post-delivery branch tests still pass.

## Test plan

- For Path A: a unit test covering the post-delivery branch where `context.loads` and DB diverge (e.g., synthetic divergence) and asserting the realignment uses DB.
- For Path B: a test that triggers the documented divergence flow and asserts the warning fires + the override produces the right answer.
- For Path C: a test that asserts post-delivery branch produces correct `context.demands` and `context.canDeliver` after removing the override.
- Integration: replay games e437ce9b / b1dd75b7 in test mode and confirm no behavioral regression in handler-generated logs.

## Risks

- **Low** — the change is a single-line audit at a well-known boundary. The blast radius is the post-delivery branch only.
- The biggest risk is removing the override and discovering an unmodeled flow that depended on it. AC2 + AC3 mitigate via the audit + regression check.

## Estimated complexity

Probably trivial-tier under a properly-tuned scoring system. Two-line change at most. Audit work is the bulk.
