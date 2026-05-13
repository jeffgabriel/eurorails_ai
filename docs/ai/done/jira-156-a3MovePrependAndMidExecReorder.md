# JIRA-156: A3 Move Prepend Wrong Direction & Mid-Execution Reorder on Pickup

## Observed Behavior

### Bug A: Mid-execution reorder fires on pickup completion (Turn 5→6, game a90936db)

**What happened:**
- Turn 5: Flash picks up Beer at Frankfurt (A1 opportunistic), route order is: pickup Beer → **deliver Beer@Holland** → pickup Steel@Ruhr → deliver Steel@Milano
- Turn 6: Route is now reordered to: pickup Beer → **pickup Steel@Ruhr** → deliver Beer@Holland → deliver Steel@Milano
- Flash starts turn 6 at (22,41), just 2 mileposts from Holland (21,39), carrying Beer
- Instead of delivering Beer (2 moves), it goes all the way to Ruhr (7 moves south), picks up Steel, comes back
- Beer isn't delivered until turn 7 — one full wasted turn

**Root cause:** `PlanExecutor.execute()` at line 66 calls `reorderStopsByProximity` whenever `skipCompletedStops` advances the route index. On turn 6, Beer pickup (stop 0) was already completed (A1 on turn 5), so the index advances from 0→1. The reorder fires from the bot's current position (22,41), and from there Ruhr is closer than Holland in grid distance, so it swaps the order.

**Why this is wrong:** No game event occurred. No delivery happened, no demand card was drawn/discarded. The TripPlanner already sequenced the route optimally (deliver Beer@Holland first, then pickup Steel@Ruhr). The proximity reorder overrides the LLM's route plan based on a naive distance heuristic.

**The reorder should only fire after a delivery** — that's the only event that changes demand state (card discarded, new card drawn, which could invalidate remaining stops).

### Bug B: A3 move prepend selects wrong frontier direction (Turn 13, same game)

**What happened:**
- Flash at Ruhr (26,44) carrying Tourists, route says deliver to Nantes (far southwest)
- PlanExecutor outputs BuildTrack (toward Nantes)
- A3 prepends a move — bot moves **north** to Holland (21,39) instead of south toward Nantes
- Connected cities: Holland, Milano, Ruhr — Nantes is off-network

**Root cause (two compounding issues):**

1. **Frontier approach only considers named city frontier nodes** — `TurnComposer.findMoveTargets()` line 1625: `if (dist < bestDist && nodeCityName)` skips frontier dead-end nodes at unnamed terrain mileposts. If the actual closest frontier to Nantes is at an unnamed milepost south of Frankfurt, it's invisible. Holland wins because it's the only named frontier dead-end at a closer hex-distance to Nantes.

2. **Directional filter is skipped** — `filterByDirection()` at line 474 only runs when `buildTargetCity` is set on the BuildTrack step. On turn 13, `build.target` is null (BuildAdvisor returned nothing), so the filter is bypassed entirely. Holland passes through unchecked.

## Affected Code

### Bug A
- **File:** `src/server/services/ai/PlanExecutor.ts:66-92`
- **Function:** `PlanExecutor.execute()` — mid-execution reorder block
- **Trigger:** `route.currentStopIndex > prevIndex` (fires on ANY stop completion)

### Bug B
- **File:** `src/server/services/ai/TurnComposer.ts:1602-1636`
- **Function:** `TurnComposer.findMoveTargets()` — Priority 1.5 frontier approach
- **File:** `src/server/services/ai/TurnComposer.ts:474-476`
- **Condition:** `if (buildTargetCity)` — directional filter gate

## Proposed Fix

### Bug A: Gate reorder on delivery only

Change the reorder condition at `PlanExecutor.ts:66` to only fire when the skipped stops include at least one delivery:

```typescript
// Only reorder after a delivery completes — pickups don't change demand state
const skippedStops = route.stops.slice(prevIndex, route.currentStopIndex);
const hasSkippedDelivery = skippedStops.some(s => s.action === 'deliver');

if (hasSkippedDelivery && route.currentStopIndex > prevIndex && context.position && !context.isInitialBuild) {
```

The post-delivery revalidation at line 98 should keep its existing gate (`route.currentStopIndex > prevIndex`) since demand card changes after delivery could invalidate remaining stops.

### Bug B: Two fixes

**Fix 1 — Include unnamed frontier nodes:** Remove the `nodeCityName` requirement at line 1625. Instead, use the frontier node's coordinates directly as the move target (resolve to nearest reachable city on the path):

```typescript
// Allow unnamed frontier nodes — find closest reachable city along the path
if (dist < bestDist) {
  bestDist = dist;
  bestNode = node; // Use coordinates, resolve to city via pathfinding
}
```

Or simpler: find the named city closest to the best unnamed frontier node and use that as the move target.

**Fix 2 — Derive buildTargetCity from route when BuildAdvisor returns null:** At `TurnComposer.ts:458`, if `buildStep?.targetCity` is null, fall back to the route's delivery target:

```typescript
const buildTargetCity = buildStep?.targetCity
  ?? activeRoute?.stops.find(s => s.action === 'deliver')?.city;
```

This ensures `filterByDirection` always runs when the route has a known destination, even if BuildAdvisor didn't return a specific target.

## Test Cases

### Bug A
1. Bot completes pickup via A1, has remaining deliver+pickup stops → route order should NOT change
2. Bot completes delivery mid-turn, has remaining stops → route order SHOULD reorder by proximity
3. Bot completes delivery, new demand card drawn invalidates a stop → revalidation should remove it

### Bug B
1. Off-network target to the south, track frontier dead-ends at unnamed milepost heading south and named city heading north → bot should move south (toward unnamed frontier), not north
2. BuildAdvisor returns null, route has delivery target → `filterByDirection` should still run using route target
3. Off-network target, all frontier nodes in correct direction → existing behavior preserved

## Impact

- **Bug A:** Any multi-stop route with interleaved pickups and deliveries risks being reordered on pickup completion, undoing the TripPlanner's optimal sequencing. Worst case: 1-2 wasted turns per affected route.
- **Bug B:** Any build-toward action for an off-network target risks moving the bot in the wrong direction when the correct frontier is at an unnamed milepost. Worst case: full turn wasted moving away from the build target.
