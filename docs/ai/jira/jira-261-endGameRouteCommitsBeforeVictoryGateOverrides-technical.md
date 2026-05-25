# JIRA-261 — Make end-state route selection prefer connector-heavy/short victory paths over high-aggregate continental round-trips (technical)

Companion to `jira-261-endGameRouteCommitsBeforeVictoryGateOverrides-behavioral.md`.

## Defect locus

`src/server/services/ai/AIStrategyEngine.ts:287-306` — the idempotency check in the `findFinalVictoryRoute` override block.

Diagnostic reproduction (one-shot test reconstructed s3's T67/T74/T75 state from the captured NDJSON and called `findFinalVictoryRoute` directly) confirms the function fires and returns a victory route that DOES include London at every relevant turn. The override is suppressed by the idempotency check at line 294-298, which compares only the **first stop**:

```ts
const currentStop = activeRoute?.stops[activeRoute.currentStopIndex];
const firstStop = finalVictoryRoute.stops[0];
const alreadyTargeted =
  currentStop?.action === firstStop.action &&
  currentStop.loadType === firstStop.loadType &&
  currentStop.city === firstStop.city;
if (!alreadyTargeted) {
  activeRoute = { ... };
}
```

At T68 the bot's existing activeRoute (set by PostDeliveryReplanner at T67 via DeterministicTripPlanner) is `[pickup Ham@Warszawa, deliver Ham@Glasgow, pickup Oil@Beograd, deliver Oil@Hamburg]`. The victory route returned by `findFinalVictoryRoute` is `[pickup Ham@Warszawa, deliver Ham@Glasgow, pickup Oranges@Sevilla, deliver Oranges@London, pickup Oil@Beograd, deliver Oil@Hamburg]`. First stops match (Ham@Warszawa pickup) → `alreadyTargeted = true` → override suppressed → bot follows the shorter, victory-orthogonal route.

## Fix shape

Tighten the idempotency check to compare more than just the first stop. Three implementation options (pick whichever survives AC2-AC5 cleanly):

### Option 1 — Compare the full remaining-stops sequence

```ts
function routesMatch(existing: StrategicRoute | undefined, proposed: StrategicRoute): boolean {
  if (!existing) return false;
  const remaining = existing.stops.slice(existing.currentStopIndex);
  if (remaining.length !== proposed.stops.length) return false;
  for (let i = 0; i < remaining.length; i++) {
    const a = remaining[i];
    const b = proposed.stops[i];
    if (a.action !== b.action || a.loadType !== b.loadType || a.city !== b.city) return false;
  }
  return true;
}
// Use: if (!routesMatch(activeRoute, finalVictoryRoute)) { activeRoute = ... }
```

Most correct semantically. Suppresses ONLY when the existing route's remaining plan equals the proposed plan exactly.

### Option 2 — Compare first N stops (e.g., N=2 or 3)

Less strict than Option 1. Allows a longer victory route to override a shorter existing route, as long as their first 1-2 stops match. Avoid if the bug ever fires on a 3+ stop divergence.

### Option 3 — Compare hash / route-id

If routes carry a stable `routeId` (per JIRA-X), compare those instead of structural equality. Cheaper but requires the ID semantics to be stable across plan re-emissions.

Recommendation: **Option 1**. Direct, no extra invariants required, surgical.

## Diagnostic test reproduction (already run, do not re-add)

A one-shot diagnostic test was created at `src/server/__tests__/ai/victoryRules.jira261-investigation.test.ts` during investigation. It was DELETED after capturing the diagnostic output (which is recorded in the behavioral ticket's root-cause section). The fix's own test should land in `src/server/__tests__/ai/AIStrategyEngine.test.ts` (the file with the idempotency check) as a behavioral assertion on the override behavior, not in `victoryRules.test.ts` (which is correctly passing now and doesn't need changes).

## Acceptance from behavioral

- **AC1** Unit test on the `findFinalVictoryRoute` override block in `AIStrategyEngine`: fixture with existing activeRoute `[pickup Ham@Warszawa, deliver Ham@Glasgow, pickup Oil@Beograd, deliver Oil@Hamburg]` (currentStopIndex=0) and mock `findFinalVictoryRoute` to return `[pickup Ham@Warszawa, deliver Ham@Glasgow, pickup Oranges@Sevilla, deliver Oranges@London, pickup Oil@Beograd, deliver Oil@Hamburg]`. Assert: after the override block, `memoryPatch.activeRoute` is set to the proposed (6-stop) route.
- **AC2** Negative test (identical-plan suppression): existing activeRoute equals the proposed route exactly. Assert: no override fires.
- **AC3** Edge — currentStopIndex > 0: existing route is `[pickup A, deliver A, pickup B, deliver B]` with currentStopIndex=2 (stops 0-1 completed). Proposed route is `[pickup B, deliver B, pickup C, deliver C]`. Document policy: the remaining slice `[pickup B, deliver B]` is a prefix of the proposed route; suppress (current trajectory is committed) OR replace (let victory route win). Pick one and test it.
- **AC4** Integration: replay-style test using s3 T67-T80 fixtures (or a hand-built equivalent). Assert: at T68 the activeRoute is the 6-stop victory route (with Sevilla→London leg), NOT the 4-stop deterministic route.
- **AC5** Over-trigger guard: existing route is `[pickup A, deliver A]` and proposed is `[pickup A, deliver B]` (same load type but different delivery city). Assert: override fires (deliver-city divergence is material).

## Validation hooks to inspect during fix

- The `[final-victory] skip: ...` console.log lines (lines 332, 344, 364, 461 of `victoryRules.ts`) are the primary diagnostic. They're not currently captured in the NDJSON turn log — adding their reason strings to `composition.endGame` or a similar trace field would make future investigation faster. Optional but recommended in the fix scope.
- The `composition.build.target` field in the turn log shows the Phase-B build target. At T67–T74 it's `null` (because no build happened during the travel-to-Britain window). After the fix it should be a connector-toward-London (or similar) for at least some of those turns.
- The `victoryCheck` field at T75 onwards: with the fix, s3 should reach `connectedCityCount=7` before T83 (when s2 wins). The faster the bot pivots, the earlier this happens.

## Not in scope

- LLM-side end-game route planning (Hard skill). Out of scope.
- Refactoring `findFinalVictoryRoute` into multiple specialized functions. Add the partial-progress mode as a flag inside the existing function if Locus A is chosen.
- Backfilling per-skip diagnostic into the NDJSON log for historical games. Going-forward only if the fix adds it.

## Relationship to existing JIRAs

- **JIRA-245** (`findFinalVictoryRoute`): the function in question. The fix may extend its contract.
- **JIRA-241** (`applyEndStateScoring`): the alternative substrate. May be where the fix lands if JIRA-245's gate genuinely can't be relaxed.
- **JIRA-242** (multi-delivery expansion bonus): orthogonal — biases mid-game toward multi-delivery, but end-state scoring substitutes that wholesale (per the line 1538 comment).
- **JIRA-243** (`detectVictoryClinch`): orthogonal — only handles single-delivery wins.
