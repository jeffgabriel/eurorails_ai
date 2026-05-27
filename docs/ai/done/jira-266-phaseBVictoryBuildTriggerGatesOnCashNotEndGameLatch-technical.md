# JIRA-266 — Change `resolveBuildTarget`'s victory-build trigger from `money >= VICTORY_BUILD_TRIGGER_M` to `gameState === End`; remove the now-redundant cash threshold constant (technical)

Companion to `jira-266-phaseBVictoryBuildTriggerGatesOnCashNotEndGameLatch-behavioral.md`.

One structural change. No tuning knob, no new logic path, no per-turn pacing rule. The existing victory-build branch already does the right thing; only its trigger condition is wrong.

## The fix

**Defect locus.** `src/server/services/ai/routeHelpers.ts:211-213` (the `isVictoryEligible` test inside `resolveBuildTarget`).

Current code:

```ts
const isVictoryEligible =
  context.money >= VICTORY_BUILD_TRIGGER_M &&
  context.connectedMajorCities.length < VICTORY_CITY_COUNT;
```

The constant `VICTORY_BUILD_TRIGGER_M = 230` (defined at line 37) is a tuning attempt at the same defect this ticket addresses. The persistent end-game latch fires at cash > $200M (JIRA-241), so there's a structural $30M dead zone where the bot is in end-game but the victory-build branch doesn't engage.

Fix:

```ts
const isVictoryEligible =
  context.gameState === GameState.End &&
  context.connectedMajorCities.length < VICTORY_CITY_COUNT;
```

`context.gameState` is already populated by `ContextBuilder` for every turn (JIRA-241 / JIRA-265 Layer 2). It is true precisely when the bot has crossed the $200M cash latch (or when memory says End from a prior turn) — exactly the state in which victory-builds should be the default.

After the change, `VICTORY_BUILD_TRIGGER_M` becomes dead code. Remove the constant declaration at line 37 and the comment block above it (lines 27–36), preserving the historical rationale in this ticket's behavioral doc and in the git log message.

## Why no new logic is needed

The existing branch already:

- **Picks the cheapest unconnected major** via `findCheapestUnconnectedMajorCity(context)` (line 232). This matches the `cheapestConnectors[0]` field surfaced in JIRA-265's endGame trace.
- **Respects the per-turn build budget** ($20M cap) via the existing build-cost machinery. Phase B will lay as many segments toward the target as the budget and cash floor allow — empirically up to ~10 segments per turn at $1–3M each (T87 of 46e424ad: 8 segments to Paris in one turn for $12M).
- **Defers to deliveries-in-hand** via the `hasNearbyHighValueDelivery` guard (lines 222–230). If the bot is carrying a load whose delivery city is reachable this turn, building waits.
- **Considers bundling secondary connectors** within the same turn's remaining budget (lines 234–286 of the existing code) via `findNextRoutePickupOffNetwork`.

All of these behaviors are correct for end-game and stay unchanged. The only thing the fix changes is **when** the branch fires.

## Why no scoring change is needed in DeterministicTripPlanner

The trip planner's end-state scoring path (`applyEndStateScoring`) gates on `context.gameState === GameState.End` already. So the fix here is consistent with how end-state behavior is gated elsewhere in the codebase — same condition, same source of truth.

## What this fix is NOT doing

- **Not adding a per-turn segment cap or pacing rule.** Build pace is determined by existing budget + cash-floor logic.
- **Not adding a penalty/bonus to candidate scoring.** Trip-planner scoring is unaffected.
- **Not changing connector ordering.** `findCheapestUnconnectedMajorCity` already returns the cheapest; no proximity-to-bot or proximity-to-route heuristics are introduced.
- **Not touching the route-based branch** when no victory-build is needed. `majorsGap === 0` cases keep the route-derived target unchanged.

## Acceptance criteria

- **AC1 (unit, isVictoryEligible gates on End)** Fixture: `context.gameState = End`, `cash = $210M`, `connectedMajorCities.length = 4`, `unconnectedMajorCities = [Ruhr($6M), Berlin($9M), Paris($10M), London($25M)]`. Assert `resolveBuildTarget` returns `{ targetCity: 'Ruhr', isVictoryBuild: true }`.
- **AC2 (unit, sub-trigger cash post-fix)** Same fixture but `cash = $205M` (below the old $230M trigger). Assert the same result — branch fires because `gameState === End`, regardless of cash. This is the case that fails today.
- **AC3 (unit, no engagement outside End)** Fixture: `context.gameState = Mid`, `cash = $240M`, 4 majors connected. Assert `isVictoryEligible === false`; branch falls through to route-based logic. (Before fix: branch fires on cash. After fix: cash alone doesn't engage.)
- **AC4 (unit, no engagement when majors already 7)** Fixture: `context.gameState = End`, `cash = $210M`, 7 majors. Assert `isVictoryEligible === false` (city condition already met).
- **AC5 (unit, hasNearbyHighValueDelivery guard preserved)** Same fixture as AC1 but bot carries a load with on-network delivery. Assert `resolveBuildTarget` returns the delivery stop (with `isVictoryBuild: false`), not the victory target.
- **AC6 (replay 46e424ad s3)** Reconstruct s3's T74 state from the NDJSON (cash $207M, 4 majors, unconnectedMajorCities populated with Ruhr/Berlin/Paris from the recorded endGame trace). Call `resolveBuildTarget` and assert the returned target is one of `Ruhr` / `Berlin` / `Paris`. **Before fix:** returns null or a route-derived target. **After fix:** returns Ruhr.
- **AC7 (no regression on `0c08d484`)** Reconstruct bot2's T86 state (7 majors already, cash ~$228M). Assert `isVictoryEligible === false` — the route-based branch should still run. (The bot has nothing further to build for victory; the existing post-7-majors behavior is preserved.)

## Diagnostic value (post-fix, via JIRA-265 trace)

After the fix, the per-turn `endGame.victoryRouteProjection` should continue to reflect what `findFinalVictoryRoute` thinks, while a NEW signal becomes available indirectly: the per-turn `composition.build.target` will be a connector city rather than `null` whenever `gameState === End && majorsGap > 0 && no route-derived target this turn`. Existing `jq` queries on the NDJSON suffice — no schema changes.

A reader can grep:

```bash
jq -c 'select(.gameState=="end") | {turn, cash, majors: (.connectedMajorCities|length), buildTarget: .composition.build.target}' \
  logs/game-<id>.ndjson
```

Pre-fix: long runs of `buildTarget: null` while `majors < 7`. Post-fix: `buildTarget` should be an unconnected major's name on most of those turns.

## Files touched

- `src/server/services/ai/routeHelpers.ts` — one-line change to `isVictoryEligible`; remove `VICTORY_BUILD_TRIGGER_M` constant declaration and its comment block. Update any internal references (no public API).
- `src/server/__tests__/ai/routeHelpers.test.ts` (or co-located test file for `resolveBuildTarget`) — AC1–AC5 unit tests.
- Replay-style test file (e.g. `__tests__/ai/jira266Replay.test.ts`) — AC6 and AC7 using captured per-turn states from the three games.

## Not in scope

- Changes to `findCheapestUnconnectedMajorCity` or its sort order.
- Changes to `findNextRoutePickupOffNetwork` (the bundling secondary connector).
- Changes to `hasNearbyHighValueDelivery` (the delivery-first guard).
- Any scoring change inside the trip planner.
- A configurable `VICTORY_BUILD_TRIGGER_M` — deliberately removed, not parameterized. The end-game latch is the source of truth.
- Backfill of past games.

## Cross-references

- JIRA-241 — defined the `gameState === End` latch (cash > $200M, sticky). This ticket consumes that signal where it was missing.
- JIRA-243 — restored victory-build firing in End state (reverting JIRA-241's earlier suppression). The intent was correct; the cash gate is what's still wrong.
- JIRA-245 — `findFinalVictoryRoute`. Its skip-reason `no_route_covers_gap` is a parallel signal to `isVictoryEligible === false` here, but `findFinalVictoryRoute` is about route selection while this ticket is about Phase B build target selection. They engage independently.
- JIRA-265 — surfaced the per-turn `endGame` trace that made this defect grep-able. Without that visibility this would have required stdout capture across multiple games.
- The historical comment at `routeHelpers.ts:30–36` documenting the original $250M → $230M tuning (game `38e92b14`) is the same defect family; this ticket replaces the tuning with the structural fix.
