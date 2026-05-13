# JIRA-230 — Supply-aware route enumeration with graph-aware costs (technical)

Companion to `jira-230-supplyAwareRouteEnumerationWithGraphCosts-behavioral.md`. Read that first for evidence and acceptance.

## Current implementation

### Supply pre-resolution

`src/server/services/ai/context/DemandEngine.ts` resolves one supply per card before any route candidates exist:

- `computeAllDemandContexts` (line 737) iterates the bot's demand cards.
- `computeBestDemandContext` (line 725) iterates all valid supply cities for the demand's load type and calls `computeSingleSupplyDemandContext` for each.
- Best is chosen by `demandScore = scoreDemand(payout, totalTrackCost, estimatedTurns, isAffordable, projectedFunds)` (lines 262-272), keeping the winner's `supplyCity` on the returned `DemandContext`.
- The result is passed downstream to `DeterministicTripPlanner` as a flat list of contexts, one per demand card.

Inside `computeSingleSupplyDemandContext`:

- `estimatedTrackCostToSupply` (lines 522-527) is `0` if the supply is "on network" (any path of existing edges leads there), else a call to `estimateTrackCost`. Same shape for delivery.
- `travelTurns` (lines 585-622) is computed via `estimateHopDistance` — Chebyshev hex distance between bot/supply/delivery coordinates. No reference to the bot's track graph, no terrain weighting, no ferry detection.

### Route enumeration consumes the frozen supply

`src/server/services/ai/DeterministicTripPlanner.ts`:

- `NormalizedDemandRow` interface (line 167) carries a single `supplyCity: string | null`.
- `genSingles`, `genPairs`, `genTriples` (lines 314-534) build `RouteStop` objects from `r.supplyCity` directly — there's no enumeration over alternative supplies.
- `cheapPrune` (lines 565-572) sums `hexDistance` city-to-city through the stop sequence and multiplies by `HOP_AVG_COST_M = 1.3` for the build estimate. Same hex approximation, no graph-awareness.

### Already-existing graph-aware primitive

`src/server/services/ai/RouteDetourEstimator.ts:441-484` exports `estimateRouteSegment(from, to, snapshot)`:

```ts
export interface RouteSegmentEstimate {
  newSegments: TrackSegment[];
  buildCost: number;
  pathLength: number;
  reachable: boolean;
}
```

This calls `findShortestBuildablePath` over the bot's `existingSegments`, weights edges by terrain cost via `getTerrainCost`, respects opponent-occupied edges, and accounts for ferries via `getFerryAdjacency`. It returns the *truthful* `buildCost` (only new segments) and `pathLength` (full milepost count along the cheapest playable path including existing edges).

`simulateTrip` (line 515) already uses this for scoring. The defect is that nothing upstream of `scoreCandidate` does.

## Fix plan

Six changes, ordered so each can be tested independently before the next is wired in:

### 1. Add a graph-aware path estimator wrapper for non-simulator callers

New file `src/server/services/ai/PathCostEstimator.ts` (or extend `RouteDetourEstimator.ts` with the helpers below — pick the location that fits the existing module boundary).

The wrapper provides:

```ts
export interface PathCost {
  buildCost: number;      // new track $M only (existing track is free)
  pathLength: number;     // total mileposts along the cheapest playable path
  estimatedTurns: number; // ceil(pathLength / trainSpeed) + ferry overhead
  reachable: boolean;
}

export function estimatePathCost(
  fromCity: string,
  toCity: string,
  snapshot: SnapshotInput,
  trainSpeed: number,
): PathCost;
```

Implementation: resolve each city to its grid coord(s), call `estimateRouteSegment` for each (from-coord, to-coord) pair, return the cheapest by `buildCost + ferryPenalty(pathLength)` or similar tiebreak. Cache results within a replan by `(fromKey, toKey)`.

This is the primitive that replaces both `estimateTrackCost` and `estimateHopDistance` in the supply scorer.

### 2. Replace binary on-network check + hex travel in `DemandEngine`

In `computeSingleSupplyDemandContext`:

- Replace lines 522-527 (the on-network coin flip) with two `estimatePathCost` calls:
  - `botToSupply = estimatePathCost(botPositionCity, supplyCity, snapshot, speed)`
  - `supplyToDelivery = estimatePathCost(supplyCity, deliveryCity, snapshot, speed)`
- `estimatedTrackCostToSupply = botToSupply.buildCost`
- `estimatedTrackCostToDelivery = supplyToDelivery.buildCost`
- Replace the entire `travelTurns` block (lines 585-622) with `botToSupply.estimatedTurns + supplyToDelivery.estimatedTurns`.
- `ferryRequired` and `countFerryCrossings` (lines 531, 645) can now be derived from `pathLength` deltas vs hex distance, or by inspecting `botToSupply.newSegments + supplyToDelivery.newSegments` for ferry edges. Keep the existing helpers for the cold-start path (initialBuild has no existing track).

Cold-start branch (lines 511-520) keeps `estimateColdStartRouteCost` — that's a separate code path with no existing track to reason about.

### 3. Move supply enumeration into route enumeration

In `DeterministicTripPlanner.ts`:

- `NormalizedDemandRow` already carries `supplyCity`; that stays.
- New helper `getSupplyVariants(d: DemandContext, snapshot: WorldSnapshot): NormalizedDemandRow[]` that:
  - For loads with one supply city (Bauxite, Marble, etc.): returns one row using that city.
  - For multi-supply loads: returns one row per supply city, each with the appropriate `supplyCity` field set.
  - Skips supplies that are unreachable (`estimatePathCost(...).reachable === false`).
- Modify `genSingles`/`genPairs`/`genTriples` to iterate over supply variants:
  - For each input demand row, fetch its supply variants.
  - For each combination of supply choices across the route's demand rows, emit a candidate with the appropriate stop cities.
- Cardinality control: worst case is harder to bound than I initially stated. A pair of two-supply loads has 4 supply combinations × ~4 orderings = 16 variants. A triple of three-supply loads has 27 supply combinations × ~4-7 orderings (depending on carry pattern) ≈ 100-200 variants per (a,b,c) triplet. C(9,3) = 84 triplets in a 9-card hand. If most loads were multi-supply (loosely true for typical hands), the worst-case raw candidate count before prune could reach low tens of thousands. The spatial prune (step 4) discards the vast majority by graph-aware turn/build cost, but the input set is large. **Add instrumentation in the first iteration**: log raw candidate count + survivor count + total enumeration time per replan, and set a budget alarm at `raw > 5000` or `enumerationMs > 200`. If hit in practice, add an upstream supply-pruner that drops supply variants whose `estimatePathCost(bot, supply).pathLength` exceeds the cheapest supply's by some multiplier (e.g., 2×).

`DemandContext`'s `supplyCity` field becomes a "preferred default" hint (used by display, logging, single-card heuristics, and the cold-start path) rather than a hard commitment.

### 4. Replace `cheapPrune`'s hex-distance approximation with graph-aware cost

`cheapPrune` (lines 565-572) is the candidate-filter gate that runs before scoring. Today:

```ts
totalHops = sum of hexDistance city-to-city through the stop sequence
estTurns  = ceil(totalHops / speed)
estBuild  = totalHops × HOP_AVG_COST_M
```

Replace with:

```ts
const legs = pairwise(candidate.stops);
let totalBuild = 0;
let totalTurns = 0;
let cur = startPos;
for (const stop of candidate.stops) {
  const leg = estimatePathCost(cityOf(cur), stop.city, snapshot, speed);
  if (!leg.reachable) return { keep: false, ... };
  totalBuild += leg.buildCost;
  totalTurns += leg.estimatedTurns;
  cur = stop.cityCoord;
}
keep = totalTurns <= pruneMaxTurns && totalBuild <= pruneMaxBuildM;
```

This makes the prune respect existing track and terrain. A candidate that traverses 50 hexes of built corridor with one new mountain segment scores `buildCost ≈ 2M`, not `buildCost = 65M`. Pairs that ride the bot's network survive the prune even when their geometric span is large.

Interaction with JIRA-227: JIRA-227 added cash-aware logic to the build *cap* (`pruneMaxBuildM = min(PRUNE_MAX_BUILD_M, snapshot.bot.money - reserve)`), but did NOT change the build-cost *math* (`totalHops × HOP_AVG_COST_M`) that gets compared against the cap. JIRA-230 step 4 replaces the cost math entirely with graph-aware cost. The two changes compose cleanly: JIRA-227's cash-aware cap continues to apply, just against a truthful estimate instead of a hex-multiplied one. **No JIRA-227 code is removed by this step.** The implementer should verify this composition holds in the existing JIRA-227 tests after step 4 lands.

### 5. Fix the aggregate double-count in `computeAggregateScore`

`DeterministicTripPlanner.computeAggregateScore` (lines 692-762) currently computes:

```ts
const aggregateTurns = Math.max(c1.turns + emptyLegTurns + c2.turns, 1);
```

`c2.turns` was computed by `simulateTrip(startPos = snapshot.bot.position, c2.stops, ...)` — it includes `bot.position → c2.start` travel as part of the simulation. Adding `emptyLegTurns` (c1.end → c2.start) on top double-charges arrival at c2.start whenever `bot.position != c2.start`.

The fix requires the aggregate computation to know c2's *execution-only* cost (excluding c2's travel-from-bot-position) so it can splice in the correct empty leg from c1.end.

**Implementation approach — two viable paths, pick one:**

**Option A (recommended): pass `botStartPos` into `computeAggregateScore` and reconstruct c2's marginal cost.** Add a parameter `botStartPos: GridCoord` to the function signature. For each candidate c2, compute the bot-to-c2-start hex turns the same way `cheapPrune` already does, then subtract from `c2.turns`:

```ts
const c2StartHops = botStartPos && c2StartCoords
  ? hexDistance(botStartPos.row, botStartPos.col, c2StartCoords.row, c2StartCoords.col)
  : 0;
const c2BotToStartTurns = Math.ceil(c2StartHops / Math.max(speed, 1));
const c2ExecutionTurns = Math.max(c2.turns - c2BotToStartTurns, 1);
const aggregateTurns = Math.max(c1.turns + emptyLegTurns + c2ExecutionTurns, 1);
```

This is the minimal change; preserves `c2.turns` as the standalone metric (still used for c2's own `aggregateScore` when c2 is the candidate being ranked); subtracts only when c2 is being treated as a follow-up.

**Option B: re-simulate c2 from c1.end.** Call `simulateTrip(c1EndCoord, c2.stops, snapshot)` to get truthful chained turns. More accurate (accounts for terrain on the empty leg, not just hex distance), but adds N² simulator calls per replan. Skip unless step 4's graph-aware empty-leg estimate proves insufficient.

Update the call site (`planTripDeterministic` around the aggregate pass): pass `snapshot.bot.position` as the new `botStartPos` argument.

Update reasoning string output: the aggregate line should report the corrected `aggregateTurns`, and (optionally) annotate the c2 component with `(execution-only)` to make the math auditable in logs.

This step is independent of steps 1-4 — it can be implemented first or last. Recommend landing it **second** (after step 1's PathCostEstimator exists, so the empty-leg cost can use graph-aware turns too, but before step 3's supply enumeration which depends on having a fair aggregate ranker to feed into).

### 6. Reasoning string surfaces the chosen supply

The chosen candidate's reasoning string in `synthesizeReasoning` (line ~830) currently shows stops as `pickup Labor at Sarajevo`. Keep that — it's already correct. But when a multi-supply load is involved and the chosen supply differs from the legacy `DemandContext.supplyCity` hint, surface that in a single line:

```
Supply chosen: Labor via Beograd (DemandContext default: Sarajevo) — closer along existing track.
```

This is for debug/observability only. No behavior change.

## Test strategy

### Unit tests in `__tests__/ai/PathCostEstimator.test.ts` (new)

- Path entirely on existing track returns `buildCost: 0` and `pathLength` matching the actual graph distance (not hex distance).
- Path with one new mountain edge returns `buildCost: 2` (terrain cost) and `pathLength` reflecting the new + existing combined.
- Unreachable city (e.g., all paths blocked by opponent track) returns `reachable: false`.
- Cache hit: calling twice with same args returns the same object (cheap test, asserts memoization).

### Unit tests in `__tests__/ai/DemandEngine.test.ts` (extend existing)

- Two supply cities both "on network" but at different graph distances: chosen supply must be the closer one along the bot's network (Scenario 1 of the behavioral acceptance).
- Path with a ferry must increase `estimatedTurns` by the ferry overhead, even when hex distance is identical to a no-ferry route (Scenario 4 of the behavioral acceptance).

### Unit tests in `__tests__/ai/DeterministicTripPlanner.test.ts` (extend existing)

- `enumerateCandidates` emits pair variants for all supply combinations of a multi-supply pair hand (Scenario 2 of the behavioral acceptance).
- t46 snapshot regression: with the hand described in the behavioral file, top-1 is the pair `Bauxite + Labor-via-Beograd` (Scenario 3).
- `cheapPrune` keeps a pair whose hex-distance estBuild exceeds 130M but whose graph-aware buildCost is ~10M (e.g., mostly on existing track).
- `computeAggregateScore` does not double-count c2's bot-to-c2-start segment (Scenario 5 of the behavioral acceptance). Construct two candidates c1 (starts at bot.position) and c2 (starts at a city N hexes from bot.position), assert that `aggregateTurns = c1.turns + emptyLeg + (c2.turns - N_turns)` rather than `c1.turns + emptyLeg + c2.turns`.

### Regression of existing tests

The OCPT and aggregate-ranking tests (JIRA-228, JIRA-229) should still pass with no changes — the score formula isn't changing, only the inputs (turns, build) become more accurate.

The cold-start tests (initial-build phase, JIRA-209) should still pass — `isColdStart` branch in `computeSingleSupplyDemandContext` is preserved.

## Implementation order

1. **PathCostEstimator** with caching + tests. Self-contained, no behavior change.
2. **Fix aggregate double-count** in `computeAggregateScore` (signature change + math correction). Self-contained scoring fix; can use simple `hexDistance`-based subtraction in v1 (graph-aware empty-leg can come later). Update aggregate tests for new expectations.
3. **DemandEngine** swap to PathCostEstimator. Single-card behavior may shift (different supply choices for multi-supply loads); update snapshot tests as needed.
4. **`cheapPrune` swap** to PathCostEstimator. Candidate survival rate may change; update prune-sensitive tests.
5. **Supply enumeration** in `genSingles/genPairs/genTriples`. Candidate counts grow; add instrumentation for raw/survivor counts and enumeration time; verify no perf regression in the bot-turn integration tests (existing latency assertions in `BotTurnTrigger.test.ts` should still pass).
6. **Reasoning surface** for chosen supply.

Each step is independently testable and revertable. Step 2 lands before steps 3-5 so the supply-enumeration changes are evaluated under a fair aggregate ranker.

### Pre-implementation evidence lock

Before step 1 starts, update `scripts/ai/analyze-t46-pairs.py` to additionally print the `scoreDemand` value (computed via the same formula in `DemandEngine.ts:262-280`) for each Labor supply variant at S3's t46 hand. Re-run and paste the output into this spec's evidence section. This verifies the "Sarajevo wins by ~1 hop on Chebyshev sum" hypothesis with concrete numbers from the diagnosis instead of inferred-from-coords reasoning.

## Risk and rollback

- **Perf risk** (step 5): supply enumeration multiplies candidate counts. Per-replan path-finding is the most expensive thing in the planner. Mitigation: the per-replan cache in step 1 means each (from, to) pair is path-found at most once per turn, and the prune still discards bad geometry early. Budget alarm at `raw > 5000` or `enumerationMs > 200` per replan (see step 3 notes); if hit, add an upstream supply-pruner.
- **Behavior risk** (step 3): supply choices for single-card scenarios may shift even when no pair is involved. This is intended (closer supply is always better), but existing scenario tests asserting specific supply picks need to be reviewed.
- **Scoring risk** (step 2): the aggregate fix shifts the ranking landscape for *all* candidates, not just pairs. Standalone-velocity singles (where bot.position == c2.start) are unbiased today, so they don't move; chains where c2.start is far from bot.position become more competitive. Existing JIRA-229 tests should be re-evaluated: any test that asserts a specific "lost by X" margin needs the new math.
- **Rollback**: each step is gated by step-specific logic. Reverting step 5 alone (keep supply pre-resolution) gives back the old behavior with the graph-aware cost improvements; reverting step 4 alone restores the hex-distance prune; reverting step 2 alone restores the old aggregate math. Steps don't entangle.

## Definition of done

- All six steps implemented behind their own commits.
- All five behavioral acceptance scenarios pass as automated tests.
- The t46 regression test from game `ad976b38` passes (planner picks pair `Bauxite + Labor-via-Beograd`).
- No regression in JIRA-227, JIRA-228 tests. JIRA-229 tests may need expected-value updates from the aggregate double-count fix (step 2); if so, update the tests and document the new expected values in the commit message.
- Aggregate scoring test (Scenario 5) explicitly asserts `aggregateTurns` excludes the `bot.position → c2.start` segment from `c2.turns`.
- `scripts/ai/analyze-t46-pairs.py` updated to (a) report `scoreDemand` per supply variant for evidence lock-in, and (b) use the production `estimatePathCost` after step 1 lands (proves the script and the planner agree on costs).
- Reasoning string includes the chosen supply when it differs from the legacy default.
- Step 5 instrumentation logs raw + survivor candidate counts and enumeration time per replan; first deployment cycle reviews the numbers to confirm budget alarms are not tripped.
