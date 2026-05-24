# JIRA-243 — Re-enable victory-build fallback in End and fix `candidateTouchesUnconnectedMajor` to distinguish "delivers at" from "builds to" (technical)

Companion to `jira-243-endStateStuckAtCitiesLessThan7-behavioral.md`.

## Defect locus

Three coupled sites, all introduced or modified by JIRA-241:

1. **`routeHelpers.ts:144-147`** — End-state suppression of the victory-build branch in `resolveBuildTarget`:
   ```ts
   const isVictoryEligible =
     context.gameState !== GameState.End &&     // ← the kill switch
     context.money >= VICTORY_BUILD_TRIGGER_M &&
     context.connectedMajorCities.length < VICTORY_CITY_COUNT;
   ```
   When `gameState === End`, the victory branch never fires. Combined with #2 below, the bot loses its only mechanism for laying track to an unconnected major when `findRouteBasedTarget` returns null.

2. **`DeterministicTripPlanner.ts:1024-1048`** — `applyEndStateScoring`:
   ```ts
   const cashGap = Math.max(0, VICTORY_INITIAL_THRESHOLD - context.money);
   const effectivePayoff = Math.min(c1.payout, cashGap);   // = 0 when cash ≥ 250
   const cityCost = (needsCity && !touchesMajor)
     ? cheapestUnconnectedMajorConnectorCost(context)
     : 0;
   const effectiveNet = effectivePayoff - (c1.buildCost + cityCost);
   c1.aggregateScore = effectiveNet / Math.max(effectiveTurns, 1);
   ```
   When `cashGap === 0`, all candidates collapse to `effectiveNet = -(buildCost + cityCost)`. The least-negative wins. Zero-build same-network routes have `effectiveNet = -cityCost`. City-touching routes (per the current `touchesMajor` check) have `effectiveNet = -buildCost`. If `buildCost > cityCost`, the zero-build route wins — and crucially, that route lays no track.

3. **`DeterministicTripPlanner.ts:983-1011`** — `candidateTouchesUnconnectedMajor`:
   ```ts
   if (!candidate.builtSegments || candidate.builtSegments.length === 0) return false;
   for (const seg of candidate.builtSegments) {
     for (const endpoint of [seg.from, seg.to]) {
       for (const mc of majorCoords) {
         if (endpoint.row === mc.row && endpoint.col === mc.col) return true;
       }
     }
   }
   return false;
   ```
   This is correctly implemented for its stated semantic ("a builtSegment endpoint matches a major's coord"). The trap is that the simulator's `findBuildPath` can produce a candidate that **delivers at a major** without **building to that major's outpost** — because the cheapest path may use red-area passage from an adjacent on-network city. The route's `builtSegments` then contains no Manchester-outpost endpoint, so `touchesMajor === false`, so `cityCost` penalty applies, even though the route's delivery is "at" Manchester. The scoring loop never gives credit for actually-connecting-a-major because no candidate gets credited that way unless it happens to also build to a different unconnected major.

4. **`GameLogger.ts:42`** — `gameState?: GameState;` is declared but never populated. AC7 of JIRA-241 was not delivered.

## Fix shape

Three coordinated fixes plus the instrumentation fix.

### Fix A — Re-enable victory-build as a safety net in End

Modify the victory-eligibility check at `routeHelpers.ts:144-147` so the branch fires in End when `findRouteBasedTarget` would otherwise produce nothing. Two options:

**A.1 (preferred)** — split the gate. Allow the branch in End specifically when `cities < 7`:

```ts
const citiesGoalUnmet = context.connectedMajorCities.length < VICTORY_CITY_COUNT;
const isVictoryEligible =
  citiesGoalUnmet &&
  context.money >= VICTORY_BUILD_TRIGGER_M &&
  (context.gameState !== GameState.End || routeBasedTargetIsNull(route, context));
```

This keeps the original JIRA-241 intent (suppress victory-build in End to avoid conflicting with route-based scoring) but adds the safety-net case: when route-based also returns nothing, run the victory branch.

**A.2 (simpler)** — drop the End suppression entirely and trust JIRA-241's scoring rule to prefer route-based targets when they exist:

```ts
const isVictoryEligible =
  context.money >= VICTORY_BUILD_TRIGGER_M &&
  context.connectedMajorCities.length < VICTORY_CITY_COUNT;
```

A.2 is less surgical but easier to reason about. A.1 preserves the conflict-avoidance intent.

Either way, JIRA-240's pickup-connector bundling continues to work — in End with $300M cash, affordability isn't an issue.

### Fix B — Fix `candidateTouchesUnconnectedMajor` semantics

Change the check at `DeterministicTripPlanner.ts:983-1011` to count a candidate as "touches major" if the **route's stops** include an unconnected major **AND** the simulated build path actually lays at least one segment whose endpoint is at that major's outpost (current behavior is the second alone, missing the first).

More directly: introduce a separate check `candidateConnectsUnconnectedMajor` with stricter semantics — the route's `builtSegments` must include a segment whose endpoint matches an unconnected major's outpost coordinates **AND** that major's outpost would not have been reachable without those segments (i.e., the segments are required to extend the network to the major).

For the scoring rule in `applyEndStateScoring`: rename `touchesMajor` → `connectsMajor` and use the stricter check. Candidates that "deliver at" but don't "build to" a major correctly get the `cityCost` penalty.

### Fix C — Strengthen End-state scoring when cashGap === 0

When `cashGap === 0 AND needsCity`, the cash side is moot. Switch to a city-progress objective:

```ts
if (cashGap === 0 && needsCity) {
  // Cash is past threshold. The only remaining axis is city progress.
  // Candidates that connect a major win; those that don't are deeply penalized.
  c1.aggregateScore = connectsMajor
    ? 1000 - c1.buildCost  // positive, with cheapest-build city-route preferred
    : -1000 - c1.buildCost; // deeply negative; pick the cheapest non-city only if no city option exists
  return;
}
```

The +1000 / −1000 sentinel makes the city-or-not decision unambiguous regardless of buildCost magnitude. Build-cost tiebreaks within each bucket pick the cheapest among equivalents.

### Fix D — Wire `gameState` into the game log

`GameLogger.recordTurn` (or whatever populates the per-turn row) should read `memory.gameState` and include it in the row. AC7 of JIRA-241 stated this and it was missed.

## Test coverage

`routeHelpers.test.ts`:

- **AC1** — Fix A.1 safety net: fixture with `gameState=End`, `cities=6`, route whose stops are all on `citiesOnNetwork`. `findRouteBasedTarget` returns null. Expect `resolveBuildTarget` returns `{targetCity: <cheapest unconnected major>, isVictoryBuild: true}`.
- **AC2** — Fix A.1 doesn't fire when route-based has a target: fixture with `gameState=End`, `cities=6`, route has an off-network stop city (e.g., Madrid). Expect `resolveBuildTarget` returns `{targetCity: Madrid, isVictoryBuild: false}` (route-based, not victory-build).

`DeterministicTripPlanner.test.ts`:

- **AC3** — Fix B: `candidateConnectsUnconnectedMajor` fixture. Candidate with stops `deliver Bauxite @ Manchester` and `builtSegments` containing only Budapest-connector coords (no Manchester-outpost coord). Expect `connectsMajor === false`. Same fixture with `builtSegments` containing Manchester-outpost coord. Expect `connectsMajor === true`.
- **AC4** — Fix C: when `cashGap === 0`, candidate that connects Manchester (buildCost 14M) beats candidate with zero-build same-network route (buildCost 0M, doesn't connect). Asserts `applyEndStateScoring` makes connectsMajor candidate's aggregateScore > non-connect's.
- **AC5** — Fix C edge case: when `cashGap === 0` AND no candidate connects any unconnected major (rare), assert the planner still picks something (the highest among the negative scores) — does not crash, does not infinite-loop.

`BuildPhasePlanner.test.ts` or end-to-end:

- **AC6** — full regression on s2 t76 snapshot from `8738866e`. Replay 10 turns. Expect at least one city added (cities count ≥ 7) and victory declared before turn 86.

`GameLogger.test.ts`:

- **AC7** — Fix D: a unit test on `recordTurn`. Pass a snapshot + memory with `gameState: GameState.End`. Assert the written row contains `gameState: 'end'`.

## Relationship to JIRA-241

JIRA-241 introduced the End-state latch + scoring rule + the route-based-only build-target gating. Each piece in isolation is reasonable. The combination breaks once `cashGap` collapses, because:
- The scoring rule cannot differentiate candidates that "deliver at" vs "build to" a major.
- The victory-build override that would have provided a fallback is disabled.
- The instrumentation that would have surfaced the bug is missing.

Fix A/B/C together restore JIRA-241's intent (drive city progress in End) without the trap. Fix D delivers the missing AC7.

## Out of scope

- Re-thinking the 200M End-latch threshold or 250M cashGap cap.
- Discard policy in End (forcing hand replacement when hand quality is poor).
- LLM-driven endgame decisions.
- Generalizing fixes beyond the `8738866e` observation. If similar lock-up patterns occur in different gameStates or different scoring regimes, file separately.
- Performance optimization of the new `candidateConnectsUnconnectedMajor` check (it loops over majors × segments, but the lists are short).
