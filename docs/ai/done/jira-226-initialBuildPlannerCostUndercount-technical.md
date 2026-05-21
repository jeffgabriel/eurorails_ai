# JIRA-226 — `InitialBuildPlanner` cost estimator undercounts true build cost (technical)

See `jira-226-initialBuildPlannerCostUndercount-behavioral.md` for observed behavior, root causes, and acceptance criteria.

## Files to touch

- `src/server/services/ai/InitialBuildPlanner.ts:684-708` — `costBetween` heuristic fallback and `isFerryBetween` region check.
- The implementation of `estimatePathCost` (search the codebase for its declaration; likely in `MapTopology.ts` or a path-finding utility module) — verify it includes ferry/river/ocean-inlet surcharges.
- `src/server/__tests__/ai/InitialBuildPlanner.test.ts` — new tests for the b1dd75b7 case and intra-continent ferry detection.

## Fix path

### Step 1 — Fix `isFerryBetween`

Replace region-only check with a real path-aware check:

```ts
private static isFerryBetween(
  cityA: string, cityB: string, gridPoints: GridPoint[],
): boolean {
  // Direct ferry-port check (existing — keep)
  for (const gp of gridPoints) {
    if (gp.isFerryCity) {
      const cityName = gp.city?.name;
      if (cityName === cityA || cityName === cityB) return true;
    }
  }
  // Region check (existing — keep as a fast path for cross-region)
  if (InitialBuildPlanner.getCityRegion(cityA) !== InitialBuildPlanner.getCityRegion(cityB)) {
    return true;
  }
  // NEW: ask the path-finder whether the cheapest path between the two cities
  // crosses a ferry edge. If estimatePathCost or its underlying graph exposes
  // ferry-edge information, use it. Otherwise add a thin helper that walks
  // the cheapest path and checks each edge.
  return InitialBuildPlanner.cheapestPathCrossesFerry(cityA, cityB, gridPoints);
}
```

The `cheapestPathCrossesFerry` helper either reuses an existing path-walker or wraps the existing pathfinder to return ferry-edge metadata alongside cost.

### Step 2 — Fix `costBetween` heuristic fallback

Three options, in order of preference:

**Option A — Eliminate the fallback** (preferred if `estimatePathCost` is reliable). Make it an error when `estimatePathCost` returns 0 for non-coincident points. Surfaces the pathfinder bug directly instead of silently undercounting.

**Option B — Tighten the heuristic** to a more realistic per-hex average. Sample the map's terrain distribution; recompute the average ECU/hex (likely closer to 3.0–4.0 for a path that crosses any non-clear terrain). Document the methodology.

**Option C — Fail fast** when the fallback would be used. Filter out the candidate (return `Infinity`) rather than under-estimate. Most conservative.

For initial fix, **Option B** is the smallest change with the biggest accuracy improvement. If post-fix games still show under-estimation, escalate to **Option A** with a fix to `estimatePathCost`.

### Step 3 — Audit `estimatePathCost`

Independent of A/B/C above, verify that `estimatePathCost` itself includes:
- Mountain / alpine surcharges.
- River / ocean inlet crossing surcharges.
- Ferry crossing costs (where applicable).
- Major-city build cost (5 ECU each per CLAUDE.md rules).

If any are missing, `costBetween`'s caller will keep undercounting even when the pathfinder returns a positive value.

## Test plan

### Unit tests

- `isFerryBetween('København', 'Stockholm', gridPoints)` → `true` (current code: false, since both are continent).
- `isFerryBetween('London', 'Paris', gridPoints)` → `true` (existing passes; baseline).
- `isFerryBetween('Bern', 'Zurich', gridPoints)` → `false` (no ferry between them; sanity).
- `costBetween` for a known mountain/alpine path returns a value within 20% of the actual buildable cost.
- `estimateBuildCostFromCity('Cardiff', 'Oslo', 'Bern', gridPoints)` returns `> 40` (the b1dd75b7 case, verifying AC3).

### Integration / regression

- Replay `InitialBuildPlanner.planInitialBuild` against the same seed/state that produced the b1dd75b7 selection. Assert the Oslo → Bern + Zurich pairing is filtered (`continue` on the `MAX_BUILD_BUDGET` check) instead of returned as `bestDouble`.
- Run a corpus replay against historical games where the initial-build pick was good — confirm those picks are still produced.

## Risks

- **Medium blast radius** — `costBetween` is a private helper but feeds every candidate filter and score in `InitialBuildPlanner`. Tightening its estimates may cause some borderline candidates to be filtered out that were previously accepted. The historical-corpus regression test is the safety net.
- A too-conservative fix might leave the bot with NO valid initial route. Mitigation: the existing `emergencyFallback` (line 728+) handles the all-filtered case; ensure it is exercised by the regression tests.

## Estimated complexity

Standard. Two-function fix with cross-cutting accuracy implications and a corpus replay needed for safety.

## Relationship to JIRA-223

JIRA-223 (deterministic affordability gate) is the second line of defense — it catches mid-game candidate selection errors. JIRA-226 fixes the FIRST line of defense (initial-build commitment). Both are needed; neither obsoletes the other. After both ship:
- `InitialBuildPlanner.MAX_BUILD_BUDGET` filters honestly → bot won't commit to a 70M trip with 50M cash.
- `DeterministicTripPlanner` affordability gate filters mid-game → bot won't accept a trip mid-game it can't fund.
