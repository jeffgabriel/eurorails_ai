# JIRA-140: Build Advisor for All Turns (Including Initial Build)

## Problem

During initial build turns (turns 2-3), track placement uses a **heuristic pathfinder** (`computeBuildSegments`) instead of the **Build Advisor LLM**. This produces poor track routing — bots build in straight lines toward targets without considering terrain costs, corridor reuse, or strategic waypoints.

In game `0a019619`, 3 of 5 bots built terrible track in turns 2-3 because the heuristic pathfinder has no strategic awareness. The build advisor (which produces much better results from turn 4+) was explicitly excluded from initial build.

## Root Cause Analysis

Two gates prevent the build advisor from running during initial build:

### Gate 1: `compose()` early return (TurnComposer.ts:136)
```typescript
// During initialBuild, no operational enrichment is possible (no train movement)
if (context.isInitialBuild) return wrapResult(primaryPlan);
```
This returns the primary plan (which already contains a heuristic BuildTrack) before Phase B (build advisor) ever runs.

### Gate 2: `skipBuildPhase` check (TurnComposer.ts:172-173)
```typescript
const hasBuild = hasType(AIActionType.BuildTrack);
const skipBuildPhase = hasBuild || hasUpgrade;
```
Even if Gate 1 is removed, the primary plan from PlanExecutor already contains a BuildTrack action, so `hasBuild = true` → `skipBuildPhase = true` → Phase B is skipped.

### Gate 3: `useAdvisor` check (TurnComposer.ts:822-823)
```typescript
const isInitialBuild = context.isInitialBuild === true;
const useAdvisor = brain && gridPoints && !isInitialBuild && !victoryConditionsMet && remainingBudget > 0;
```
Even if Gates 1 and 2 are cleared, the advisor is explicitly excluded for `isInitialBuild`.

### Where the heuristic build originates
PlanExecutor handles initial build turns by calling `computeBuildSegments()` to determine track placement. This is a simple A* pathfinder that builds the cheapest path to the target city — no strategic reasoning about corridors, terrain avoidance, or multi-stop lookahead.

## Proposed Solution

**Replace the heuristic build segments with build advisor output during initial build.**

### Approach: Strip heuristic build, let Phase B supply it

1. **In `compose()`**: Remove the early return for `isInitialBuild`. Instead, set a flag `skipOperationalPhases` that skips Phase A (movement/pickup/delivery enrichment — not applicable during initial build since there's no train) but allows Phase B to run.

2. **For `skipBuildPhase`**: When `isInitialBuild` is true and the primary plan contains a heuristic BuildTrack, strip it from `steps` and set `skipBuildPhase = false` so Phase B runs. The build advisor then supplies the build segments instead.

3. **Remove `!isInitialBuild`** from the `useAdvisor` guard.

4. **Ensure the build advisor has what it needs during initial build:**
   - `activeRoute` — exists (trip planner runs before initial build)
   - `gridPoints` — need to verify this is available during initial build
   - `brain` (LLM adapter) — exists for LLM bots
   - `corridorMap` — rendered from grid points, should work

### Key consideration: Budget

During initial build, the bot has ~30-50M cash and can spend up to 20M on track. The build advisor already handles budget constraints via the solvency retry loop. The heuristic currently spends the full 20M budget — the advisor should do the same or better since it considers terrain costs.

### Key consideration: Starting city

During initial build turn 2, the bot has no track yet. Track must start from a major city. The trip planner's `startingCity` determines where building begins. The build advisor needs to know this starting point — it currently gets it from the corridor map which shows the bot's network frontier. During initial build with no track, the frontier would be empty.

**This needs investigation**: How does the corridor map / build advisor handle the case where the bot has zero track? The `MapRenderer` may need the starting city passed explicitly so it can render a corridor from that city to the target.

## Files to Modify

- `src/server/services/ai/TurnComposer.ts` — Remove initial build exclusions (Gates 1-3), add `skipOperationalPhases` flag, strip heuristic build from steps during initial build
- `src/server/services/ai/BuildAdvisor.ts` — May need to handle empty-network case (no frontier points)
- `src/server/services/ai/MapRenderer.ts` — May need to accept starting city for zero-track corridor rendering
- `src/server/services/ai/PlanExecutor.ts` — Possibly simplify initial build handling if TurnComposer takes over build placement

## Testing

- Verify build advisor is called during initial build turns (check game logs for `[BUILD ADVISOR]` on turns 2-3)
- Verify track placement is strategic (avoids expensive terrain, follows corridors)
- Verify budget is respected (doesn't overspend 20M)
- Verify starting city constraint is honored (first track from major city)
- Verify bots with no LLM (heuristic-only) still work during initial build
- Run a 5-bot game and compare turn 2-3 track quality vs. pre-change

## Complexity Estimate

**Standard** — 3-4 files modified, need to handle empty-network edge case in corridor map rendering, and carefully preserve the existing heuristic fallback for non-LLM bots.
