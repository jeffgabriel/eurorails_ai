# JIRA-73: Initial Build Should Complete Full Delivery Route

## Problem

During initial build turns (first 2 turns, 20M budget each = 40M total), the bot builds incrementally toward **one route stop at a time**, spending only a fraction of its budget. A human player would build the **entire delivery route** across both initial build turns, ensuring the path is complete when movement begins.

### Observed Behavior (game d32bb790, Flash player f74864fb)

Route: `pickup(Iron@Birmingham) → deliver(Iron@Stuttgart)`
Starting city: London

| Turn | Target | Segments | Cost | Budget Wasted |
|------|--------|----------|------|---------------|
| 2    | Birmingham | 3 | 5M | 15M |
| 3    | Stuttgart  | 2 | 5M | 15M |
| **Total** | | **5** | **10M** | **30M wasted** |

The bot spent only 10M of 40M available. The track from London toward the Channel ferry was barely started. When movement began on turn 4, the bot picked up Iron at Birmingham but couldn't continue past London — no track to the ferry existed yet. This caused:

- Turn 4: 3 mp wasted (backtracked to London, nowhere else to go)
- Turn 5: 7 mp wasted (moved 2 effective mp to ferry port, A2 can't chain after MOVE)
- Turn 6: Full turn spent on ferry crossing

A human would have built ~40M of track: London→Birmingham (~5M) + London→Dover ferry→Channel→toward Stuttgart (~35M), completing most of the delivery path.

## Root Cause Analysis

### 1. `PlanExecutor.executeInitialBuild()` builds toward ONE target per turn
**File:** `src/server/services/ai/PlanExecutor.ts:97-196`

`executeInitialBuild()` calls `ActionResolver.resolve({ action: 'BUILD', details: { toward: targetCity } })` **once** and returns. It picks a single build target via `findInitialBuildTarget()` (line 114) — the first route stop not yet on the network. It never loops to spend remaining budget toward additional route stops.

### 2. `findInitialBuildTarget()` returns only the first unreachable stop
**File:** `src/server/services/ai/PlanExecutor.ts:419-428`

```typescript
private static findInitialBuildTarget(route, context): string | null {
  for (const stop of route.stops) {
    if (!isStartingCity && !context.citiesOnNetwork.includes(stop.city)) {
      return stop.city;  // Returns FIRST unreachable stop, ignores rest
    }
  }
  return null;
}
```

On turn 2, this returns "Birmingham" (stop 0). On turn 3, Birmingham is now on the network, so it returns "Stuttgart" (stop 1). Each turn builds toward only one city, never considering the full route.

### 3. `computeBuildSegments` picks cheapest path, not longest within budget
**File:** `src/server/services/ai/computeBuildSegments.ts:492-503`

The target-aware path selection tiebreaker logic:
1. Closest to target (hex distance) — correct
2. Cheapest cost — **problematic**: prefers spending less, not building more
3. Most new segments — only as final tiebreak

When the optimal direction has only 3-5 cheap clear-terrain mileposts before the path angles away from the target, `computeBuildSegments` returns those 3-5 segments (costing 5M) even though 15M remains unspent. It finds the path that **reaches closest to the target for the least cost**, not the path that **builds as much useful track as possible within budget**.

### 4. TurnComposer skips Phase B during initialBuild
**File:** `src/server/services/ai/TurnComposer.ts:102-103`

```typescript
if (context.isInitialBuild) return wrapResult(primaryPlan);
```

During normal turns, Phase B (`tryAppendBuild`, line 470) appends a second BUILD action to use remaining budget. During `isInitialBuild`, TurnComposer returns immediately — Phase B never runs. There's no mechanism to spend remaining budget on additional route track.

## Proposed Fix

The fix should make the bot build the **full delivery route** during initial build turns, spending up to 20M per turn purposefully — not frivolously.

### Approach: Multi-target continuation build in `executeInitialBuild`

After the primary build toward the first route stop, check if budget remains and continue building toward subsequent route stops. This mirrors what a human does: build the entire path needed for the first delivery.

**In `PlanExecutor.executeInitialBuild()` (~line 120):**

```typescript
// After primary build succeeds, continuation-build toward remaining route stops
let plan = buildResult.plan as TurnPlanBuildTrack;
let spentSoFar = plan.segments.reduce((sum, s) => sum + getTerrainCost(s), 0);
const MAX_BUILD_BUDGET = 20;

// Build toward subsequent route stops with remaining budget
for (let i = route.currentStopIndex; i < route.stops.length && spentSoFar < MAX_BUILD_BUDGET; i++) {
  const nextStop = route.stops[i];
  if (context.citiesOnNetwork.includes(nextStop.city)) continue;

  const remainingBudget = MAX_BUILD_BUDGET - spentSoFar;
  if (remainingBudget <= 0) break;

  const continuationResult = await ActionResolver.resolve(
    { action: 'BUILD', details: { toward: nextStop.city }, reasoning: '', planHorizon: '' },
    updatedSnapshot,  // snapshot with primary build applied
    updatedContext,    // context with updated network
    route.startingCity,
  );

  if (continuationResult.success && continuationResult.plan) {
    const contPlan = continuationResult.plan as TurnPlanBuildTrack;
    plan = {
      ...plan,
      segments: [...plan.segments, ...contPlan.segments],
    };
    spentSoFar += contPlan.segments.reduce((sum, s) => sum + getTerrainCost(s), 0);
  }
}
```

**Key constraints:**
- Only build toward route stops — don't speculate on future demand cards
- Stop when 20M budget is exhausted — don't overspend
- Apply each build to the snapshot before the next continuation, so `computeBuildSegments` sees the updated network frontier
- The continuation build uses `computeBuildSegments` with `knownSegments` so it extends from the newly-built track, not the original frontier

### Secondary fix: `computeBuildSegments` tiebreaker

Change the tiebreaker from "cheapest cost" to "most new segments" when costs are within budget:

```
Current:  closest → cheapest → most segments
Proposed: closest → most segments → cheapest
```

This ensures the bot builds as much useful track toward the target as budget allows, rather than finding the cheapest 3-segment path and stopping.

### NOT changing TurnComposer `isInitialBuild` early return

The Phase B skip is correct — Phase B's `tryAppendBuild` handles build-after-movement scenarios and wouldn't work correctly during initial build (no sim snapshot from movement). The continuation logic belongs in `PlanExecutor.executeInitialBuild()` where the route context is available.

## Expected Outcome

With the fix, the Flash bot's initial build turns would look like:

| Turn | Action | Cost |
|------|--------|------|
| 2    | Build London→Birmingham (3 seg, 5M) + continue toward Stuttgart/Channel (15M) | ~20M |
| 3    | Continue building toward Stuttgart/Channel | ~20M |

The bot would arrive at turn 4 with the full route built: Birmingham ← London → Dover ferry → Channel → toward Stuttgart. Movement turn 4 would be: London→Birmingham (pickup Iron)→London→ferry port (9 mp fully used). Turn 5: ferry crossing + half-speed movement. No wasted turns.

## Files to Modify

1. **`src/server/services/ai/PlanExecutor.ts`** — Add continuation build loop in `executeInitialBuild()`
2. **`src/server/services/ai/computeBuildSegments.ts`** — Swap tiebreaker priority (most segments > cheapest)
3. **`src/server/services/ai/ActionResolver.ts`** — May need to expose `applyPlanToState` or add a method to create an updated snapshot after a build for continuation builds

## Test Plan

1. Unit test: `executeInitialBuild` with a 2-stop route spends close to 20M, not just the cost of the first leg
2. Unit test: `computeBuildSegments` with 20M budget builds 15+ segments toward a distant target (not 3 cheap ones)
3. Integration test: bot with route across a ferry builds toward the ferry port during initial build turns
4. Manual test: replay game d32bb790 scenario — verify Flash bot builds full route during turns 2-3
