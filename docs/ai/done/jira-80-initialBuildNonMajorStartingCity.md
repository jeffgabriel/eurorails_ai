# JIRA-80: Initial Build Wastes Budget When startingCity Matches First Route Stop

## Summary

During initial build turns, the bot wastes both 20M build budgets when `startingCity` equals the first route stop city (e.g., startingCity="Bern" and first stop is pickup@Bern). Two cascading bugs:

1. **Turn 1**: Builds 1 random spur segment (1M) instead of building the full supply→delivery corridor with 20M budget
2. **Turn 3**: PassTurn wastes the entire second initial build turn sitting idle

## Game Evidence

Game `9126f0b3`, haiku bot `94b6428f`:
- Route: `pickup(Cattle@Bern) → deliver(Cattle@Wien)`, `startingCity="Bern"`
- Wien is the bot's starting city (Major City). Bern is the supply city (Small City).
- Good strategy: start at Wien, build toward Bern, pick up Cattle, deliver to Wien.

| Turn | Action | Result | Budget Wasted |
|------|--------|--------|---------------|
| 2 (1st build) | BuildTrack | 1 segment, 1M, buildTargetCity=Wien | 19M |
| 3 (2nd build) | PassTurn | "All route stops reachable during initialBuild" | 20M |
| 4+ | BuildTrack | Finally builds toward Bern (20M + 3M over 2 turns) | — |

## Root Cause Analysis

### Bug 1: Builds 1 random spur from Wien (Turn 2)

Traced execution through the code:

1. **`PlanExecutor.executeInitialBuild`** (`PlanExecutor.ts:107`): `targetCity = stop.city = "Bern"` (first route stop is pickup@Bern)
2. **`PlanExecutor.ts:112-113`**: `isStartingCity = true` because `route.startingCity("Bern") === targetCity("Bern")`
3. **`PlanExecutor.ts:115`**: Enters the "already reachable" branch — treats Bern as if it doesn't need track
4. **`findInitialBuildTarget`** (`PlanExecutor.ts:430-439`): Skips Bern (startingCity), returns **"Wien"** as the build target
5. **`ActionResolver.resolveBuild`** (`ActionResolver.ts:140-154`): Cold-start looks up `"Bern"` in `getMajorCityGroups()` → **no match** (Bern is a Small City, only Major Cities are in the lookup). Falls back to **ALL major city centers** as start positions
6. **`computeBuildSegments`**: Dijkstra finds cheapest path from any major city center to Wien. Nearest major city to Wien = **Wien itself** (distance 0). Builds 1 spur segment from a Wien outpost for 1M
7. **`continuationBuild`** (`PlanExecutor.ts:483-489`): Iterates route stops — skips Bern (startingCity) and Wien (now on network after primary build). **No continuation build happens.** 19M wasted.

**The trigger**: `startingCity = first stop city` causes the code to enter the "already reachable" branch. Then the cold-start path can't build from Bern (not a major city) and accidentally builds from Wien toward Wien (a no-op).

### Bug 2: PassTurn wastes Turn 3

Direct consequence of Bug 1:

1. **`ContextBuilder.computeCitiesOnNetwork`** (`ContextBuilder.ts:294-306`): After Turn 2's segment from Wien outpost, **Wien is now in `citiesOnNetwork`**
2. **`findInitialBuildTarget`** (`PlanExecutor.ts:430-439`): Bern → skipped (startingCity). Wien → skipped (on network). Returns **null**
3. **`findDemandBuildTarget`** (`PlanExecutor.ts:414`): Cattle demand has `trackCostToSupply=25M > 20M` threshold → **filtered out**
4. **`PlanExecutor.ts:160-166`**: Falls through to **PassTurn**

## Required Fixes

### Fix A: ActionResolver cold-start city lookup (`ActionResolver.ts:140-157`)

**Current**: `getMajorCityGroups().find(startingCity)` → if no match, fall back to ALL major city centers.

**Fix**: When startingCity is not a major city, look up its coordinates from `loadGridPoints()` by city name and use those as `startPositions`.

### Fix B: findInitialBuildTarget route corridor awareness (`PlanExecutor.ts:430-439`)

**Current**: Iterates route stops, skips startingCity and on-network cities, returns first unconnected stop or null.

**Fix**: After iterating, if all stops are skipped, check the demand context. If the delivery city is on-network but the supply city needs track, return the supply city. The bot should build toward where it needs to go, not just where it hasn't been.

### Fix C: findDemandBuildTarget budget filter (`PlanExecutor.ts:414`)

**Current**: `(demand.estimatedTrackCostToSupply || 0) <= 20` — single-turn filter.

**Fix**: During initial build, use `<= 40` threshold (2 turns × 20M). During normal gameplay, keep `<= 20`. Use `context.isInitialBuild` to determine threshold.

### Fix D: computeBuildSegments cold-start validation (`computeBuildSegments.ts`)

**Current**: `extractSegments` validates that cold-start builds originate from major city positions (`validColdStartKeys`).

**Fix**: Allow builds from the provided `startPositions` regardless of city type when explicitly passed.

### Fix E: continuationBuild skips startingCity (`PlanExecutor.ts:486-488`)

**Current**: `continuationBuild` skips Bern because it's the startingCity, preventing any continuation toward Bern even with 19M remaining budget.

**Fix**: In `continuationBuild`, don't skip startingCity — it's a valid build target when it needs track built to reach it.

## Acceptance Criteria

- [ ] When `startingCity` is a Small or Medium city, cold-start build starts from that city's grid coordinates (not from the nearest major city)
- [ ] Initial build spends full 20M budget per turn building the supply→delivery corridor
- [ ] `findInitialBuildTarget` returns the supply city when the delivery city is already on-network and the supply city needs track
- [ ] `findDemandBuildTarget` considers demands costing up to 40M during initial build
- [ ] `continuationBuild` doesn't skip startingCity as a build target
- [ ] Existing unit tests continue to pass
- [ ] New unit tests cover: non-major startingCity cold-start, startingCity=first stop initial build target selection

## Affected Code

| File | Lines | Issue |
|------|-------|-------|
| `src/server/services/ai/ActionResolver.ts` | 140-157 | Cold-start startingCity fallback ignores Small/Medium cities |
| `src/server/services/ai/PlanExecutor.ts` | 430-439 | `findInitialBuildTarget` returns wrong target when startingCity=first stop |
| `src/server/services/ai/PlanExecutor.ts` | 414 | `findDemandBuildTarget` over-filters with 20M single-turn threshold |
| `src/server/services/ai/PlanExecutor.ts` | 486-488 | `continuationBuild` skips startingCity as build target |
| `src/server/services/ai/computeBuildSegments.ts` | extractSegments | Cold-start validation rejects non-major city start positions |

## Source Documents
- Game log: `logs/game-9126f0b3-ed2e-4103-a3bb-5edd5d8ca800.ndjson`
- Grid data: `configuration/gridPoints.json` (Bern = Small City, Wien = Major City)
