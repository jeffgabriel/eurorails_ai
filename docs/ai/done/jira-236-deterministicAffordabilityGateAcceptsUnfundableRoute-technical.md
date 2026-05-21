# JIRA-236 — Simulator build cost underestimate + open upgrade-emission mystery (technical)

Companion to `jira-236-deterministicAffordabilityGateAcceptsUnfundableRoute-behavioral.md`.

**Status: primary fix shipped.** Parallel-build proximity penalty added to `findShortestBuildablePath` in `simulateTrip`. Secondary upgrade-emission mystery remains open.

This document captures the technical investigation as performed, the specific code sites identified, the fix shape implemented for the primary defect, and the targeted next steps for the secondary mystery.

## Investigation as performed

1. **Confirmed planning path.** s3 is Medium skill. `decisionSource` across the game is `initial-build-planner:1, route-executor:32`. The replan at t15 fired through `PostDeliveryReplanner.replan` → `TripPlanner.planTrip` → (Medium branch at `TripPlanner.ts:212`) → `planTripDeterministic` → `scoreCandidate`. The reasoning string `[deterministic-top-1] pair:116-Fish+71-China:B-then-A-sup:Oslo-Leipzig chosen.` confirms this is what executed.

2. **Verified affordability-gate math.** With `startingCash ≈ $47M` (after Wine deliveries mid-t15) and `top1.buildCost = $48M`, the only way `projectedMin = startingCash + result.minCashRelative >= 0` is satisfied is if the simulator's `minCashRelative >= -$47M`. The simulator passed; therefore it computed a `minCashRelative` no worse than -$47M.

3. **Computed expected vs actual cost.** Realistic build cost for the Leipzig→Oslo leg (~25 hex through Scandinavia with ferry crossings) plus Oslo→Budapest (~38 hex) totals roughly $94M of new track on top of the existing-network reach. Observed bot spend over t15–t17 was $40M just to reach Leipzig and pick up China — already comparable to the simulator's prediction for the entire trip. Net underestimate ≈ $86M.

4. **Located the most likely cost-model deviation.** `findShortestBuildablePath` at `RouteDetourEstimator.ts:264` makes ferry crossings free: line 364 `const newCost = current.cost; // free crossing`. The build-into-port cost may be charged via `ferryPortCosts` (line 281–287), but only on one end. For a multi-ferry path through Denmark/Sweden the simulator's per-edge cost during the crossing itself is zero.

5. **Investigated the upgrade emission.** Grepped for all paths that set `route.upgradeOnRoute` or assign `pendingUpgradeAction`. Found:
   - `DeterministicTripPlanner.ts:1414` — sets `upgradeOnRoute` only when `selectUpgradeTarget` returns a target. For s3 t15 with cash≈$47M, build=$48M, `47 >= 20+48 = 68` is false, so target is `{}`.
   - `TripPlanner.ts:476` — LLM path. Doesn't apply to s3 (Medium skill).
   - `NewRoutePlanner.ts:244` — consumes `route.upgradeOnRoute`. Doesn't apply since the planner didn't set it.
   - `NewRoutePlanner.ts:295–352` (JIRA-105b) — gated on `routePickupCount > effectiveFreeSlots`. For the new Fish+China route the leading consecutive pickup count is 1 (next stop after pickup is deliver), and `effectiveFreeSlots` is 2. So this gate is false.
   - No other emission paths found via grep.
   
   The upgrade nonetheless fired and is logged as `actor=system, detail=route-executor`. This is unexplained by the code paths surfaced.

## Primary defect — implementation locations

`simulateTrip` (`RouteDetourEstimator.ts:515`) consumes the path from `findShortestBuildablePath` and computes:
- `totalBuildCost` — sum of new-segment costs (from `pathToNewSegments` at line 377)
- `minCashRelative` — turn-by-turn cash trajectory honoring `TURN_BUILD_BUDGET=20` (line 521, this part is correct)

The buildCost is therefore directly determined by what the path-finder selects. If the path is too cheap, the trip's affordability is over-optimistic.

`findShortestBuildablePath` itself looks well-formed except for the **free ferry traversal at line 364**. Game rules charge for the ferry cost (with cost shifted to whichever player built first). The simulator's `ferryPortCosts` is set from `partners[0].cost` — but a single port's cost in the data may not capture the full ferry economics.

Secondary candidates for cost underestimate (verify each):
- **`getTerrainCost` mapping.** Confirm clear/mountain/alpine return 1/2/5 ECU matching game rules (`src/server/services/ai/MapTopology.ts`?). Mismatch here would compound.
- **`pathToNewSegments`** (line 377) — verify it emits one segment per hex transition exactly as `computeBuildSegments` does. If the simulator collapses segments or misses water surcharges, cost is under-reported.
- **Major-city outpost free traversal** (line 319 `isIntraCityEdge`) — confirm this only fires within the red area of a major city, not for any edge touching a major-city outpost milepost. The check uses `majorCityLookup` semantics; if outposts that are NOT in the red area pass this test, the bot's existing track at Berlin/Wien could give effectively free traversal further than expected.
- **Bot-existing-edge free traversal at line 330**. Confirm `existingEdges` corresponds to fully-built edges, not in-flight/intended edges, and that `existingNodes.has(nbKey)` properly gates the free traversal so the bot can't free-ride off existing track to a node it hasn't yet reached.

## Fix as shipped — primary defect

After reviewing `computeBuildSegments` (the in-game build logic), the actual divergence is NOT the ferry crossing (both `simulateTrip` and `computeBuildSegments` treat ferry crossings as free — line 364 in both). The real divergence is that `computeBuildSegments` applies a **`PARALLEL_COST_MULTIPLIER = 2`** penalty on hexes adjacent to existing track (to discourage parallel building) while the simulator does not. As a result, the simulator finds the objectively shortest path while the in-game build chooses a longer, parallel-avoiding path. The simulator's `totalBuildCost` is therefore optimistic.

### Implementation

`src/server/services/ai/RouteDetourEstimator.ts`:

1. Imported `isNearExistingTrack` from `./computeBuildSegments`.
2. Added a module-level `PARALLEL_COST_MULTIPLIER = 2` matching `computeBuildSegments`.
3. Added a new parameter `existingTrackIndex: Set<string>` to `findShortestBuildablePath` — separate from `existingNodes` so the bot's current-position hex (added to `existingNodes` for free traversal) does NOT incorrectly trigger the proximity penalty on first-hop edges.
4. At the fresh-terrain expansion in `findShortestBuildablePath`, multiplied terrain cost by `PARALLEL_COST_MULTIPLIER` when the neighbor is hex-adjacent to `existingTrackIndex` (but not on it).
5. Updated both call sites — `simulateTrip` (line ~590) and `estimateRouteSegment` (line ~476) — to build `existingTrackIndex` (segments only) and pass it alongside `existingNodes` (segments + current position).

```ts
// New module constant
const PARALLEL_COST_MULTIPLIER = 2;

// New parameter on findShortestBuildablePath
function findShortestBuildablePath(
  …,
  existingNodes: Set<string>,
  existingTrackIndex: Set<string>, // ← NEW
  …,
)

// New penalty branch in the fresh-terrain expansion
const isParallel = existingTrackIndex.size > 0
  && !existingTrackIndex.has(nbKey)
  && isNearExistingTrack(nb.row, nb.col, existingTrackIndex);
const effectiveTerrainCost = isParallel ? terrainCost * PARALLEL_COST_MULTIPLIER : terrainCost;
```

The penalty affects PATH SELECTION (Dijkstra weight) only; `pathToNewSegments` continues to report base terrain + water cost per segment, matching `computeBuildSegments`'s `buildSegment` helper (also base cost, no penalty in segment output). The game's actual cost is base cost; the penalty is a planner-side disincentive.

### Test coverage

`src/server/__tests__/ai/RouteDetourEstimator.test.ts`:

- New `describe('simulateTrip — JIRA-236 parallel-build proximity penalty')` block.
- **Negative-case test passes**: when existing track is geographically isolated from the path (not hex-adjacent to any path hex), the simulator's `totalBuildCost` is identical to the no-existing-track baseline. Confirms the penalty does not fire spuriously.
- Positive-case test was attempted but is hard to construct under the heavily-mocked grid test infrastructure: the hex neighbor model lets the pathfinder weave between adjacent columns to dodge penalty hexes while keeping path length minimal, so the chosen path's base-cost output ends up equal between baseline and with-existing. The penalty IS correctly applied (verified via `DEBUG_JIRA_236=1` console.log instrumentation during development), but a clean unit-test assertion on the output is impractical. Production-level verification belongs at the integration level via the s3 t15 game-log replay described in the behavioral doc.

### Test regression check

Full server test suite: 2881 passing baseline → 2882 passing after fix (1 new test added). 66 failing tests in both baseline and after-fix runs are unchanged pre-existing failures unrelated to this fix.

One mock-related fix required: `TurnExecutorPlanner.test.ts` mocks `BuildAdvisor` and was missing the new `isBuildAdvisorEnabled` export (added in JIRA-234 Defect C). Added `isBuildAdvisorEnabled: jest.fn(() => true)` to the mock so existing BuildAdvisor-LLM-path tests still cover the LLM path.

## Limitations / open questions

1. **Path-selection-only fix**. The penalty changes which path Dijkstra picks, but `pathToNewSegments` reports each segment's base cost (terrain + water, no penalty). If the in-game build ends up choosing the SAME path the simulator chose (post-fix), `totalBuildCost` will match. If the in-game build picks a different path due to its own heuristics, divergence remains possible. This is the same regime `computeBuildSegments` operates in.
2. **No s3 t15 fixture-based assertion yet.** A future test should replay s3's exact snapshot and assert `simulateTrip` predicts `totalBuildCost >= ~$90M`, which would force the affordability gate to reject. Requires plumbing real grid + real water-crossing data + extracted fixture from the game log.
3. **Other cost-model deviations may still exist.** I checked ferry crossings (identical in both), water crossings (byte-identical implementations), terrain costs (same constants). Parallel penalty was the only mismatch I found, but I did not exhaustively diff every code path.

## Secondary mystery — investigation plan

To resolve the surprise upgrade emission at t15:

1. **Instrument every UpgradeTrain emission point.** Add `console.log` at:
   - `DeterministicTripPlanner.ts:1414` after `upgradeOnRoute` assignment, logging the value.
   - `NewRoutePlanner.tryConsumeUpgrade` (lines 240–248 in NewRoutePlanner.ts, plus the function body at ~line 487) — log inputs and result.
   - `NewRoutePlanner.ts:345` (JIRA-105b emission point) — log when it fires.
   - `MovementPhasePlanner.ts:349` — log when `pendingUpgradeAction` is adopted from a replan result.
   - `TripPlanner.ts:476` — log when LLM path sets `upgradeOnRoute`.
   
2. **Re-run the game** (or a fixture replaying s3's t15 state) and grep server stdout for which path fires.

3. **Alternative: bisect the `bot_turn_audits` table.** The audit row for the t15 UpgradeTrain action carries `cost`, `remaining_money`, and `duration_ms`. Cross-reference with `replanLlmLog` / `replanSystemPrompt` to see if any LLM call near the upgrade timestamp would hint at the source.

4. **One-off code-review angle.** Check whether `PostDeliveryReplanner` runs MULTIPLE times in a single turn (once per delivery completed). If a first replan after the Wine#1 delivery (with cash maybe $5M+$20M = $25M from one Wine payout, build estimate maybe lower than 48M) emitted an upgrade, then a second replan after Wine#2 with new state may have re-planned without upgrade — but the older upgradeOnRoute could have already been consumed and the action queued.

## Files relevant to this ticket

- `src/server/services/ai/DeterministicTripPlanner.ts` — affordability gate (line 812), `selectUpgradeTarget` (line 1175), `planTripDeterministic` (line 1224+).
- `src/server/services/ai/RouteDetourEstimator.ts` — `simulateTrip` (515), `findShortestBuildablePath` (264), terrain/ferry cost logic.
- `src/server/services/ai/PostDeliveryReplanner.ts` — replan trigger + upgrade consumption (line 187–209).
- `src/server/services/ai/NewRoutePlanner.ts` — `tryConsumeUpgrade` (~487), JIRA-105b upgrade-before-drop (line 295+).
- `src/server/services/ai/MovementPhasePlanner.ts` — `pendingUpgradeAction` propagation (line 346–355).
- `src/server/services/ai/TurnExecutor.ts` — `handleUpgradeTrain` execution (line 941).

## Status

- Primary defect (build cost underestimate from missing parallel-build penalty): **fix shipped**, see "Fix as shipped" section above.
- Secondary defect (surprise upgrade emission for s3 t15 — bot upgraded fast_freight → superfreight despite the planner's reasoning showing no "Upgrade emitted" line): **open**. The "Secondary mystery — investigation plan" section above lists the next steps for resolving it.
- A3 stuck-build-progress guardrail (JIRA-234) remains the runtime safety net for cases where the planner-time fix is insufficient.
