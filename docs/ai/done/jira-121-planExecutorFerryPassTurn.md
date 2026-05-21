# JIRA-121: PlanExecutor Passes Turn at Ferry Port Instead of Delivering Carried Load

## Evidence

**Game:** `fc8ecd8e` — Flash bot (Gemini Flash)

| Turn | Position | Speed | Action | Model | Cash | Loads | Route Stop | Details |
|------|----------|-------|--------|-------|------|-------|------------|---------|
| T10 | London area | 5 (half) | Move+Build | route-executor | 16 | Copper,Cheese | deliver Copper@London (3/4) | Delivered Copper@London, built 2 segs toward Dublin ($9M) |
| T11 | (19,33)→(13,29) | 9 | Move+Build | gemini-3-flash | 11 | Cheese | pickup Chocolate@Bruxelles (0/2) | LLM replanned route. Moved to ferry port. Built 2 segs toward Bruxelles ($5M) |
| **T12** | **(13,29)→(13,29)** | **5 (ferry!)** | **PassTurn** | **route-executor** | **11** | **Cheese** | **pickup Chocolate@Bruxelles (0/2)** | **Wasted entire turn. 5 movement points unused.** |
| T13 | (13,29)→Dublin | 5 (ferry) | Ferry+Build | gemini-3-flash | 10 | Cheese | deliver Cheese@Dublin (0/1) | LLM replanned. Crossed ferry, reached Dublin. Delivered next turn. |

**What happened:**
- T11: LLM replanned route as `[pickup Chocolate@Bruxelles, deliver Cheese@Dublin]` — putting an unneeded pickup BEFORE the delivery of a load already on the train. Bot moved to ferry port (13,29).
- T12: Route-executor evaluated stop 0 (Bruxelles). Bruxelles was not on the network, so entered `resolveBuild()`. JIRA-101 feasibility check found estimated track cost $12M > $11M cash. Abandoned entire route. PassTurn.
- T13: Route abandoned, so LLM was called again. Correctly planned `[deliver Cheese@Dublin]`. Crossed ferry and delivered.

**Impact:** One wasted turn. Flash was sitting at the ferry port with Cheese on board, 5 mileposts of movement available, and a clear path to Dublin for a 19M payout. Instead it did nothing.

## Root Cause Analysis

Three overlapping bugs contributed to the wasted turn:

### Bug 1: JIRA-101 feasibility check abandons entire route when one stop is unaffordable

**File:** `src/server/services/ai/PlanExecutor.ts` lines 367-389

```typescript
// JIRA-101: Feasibility check
if (estimatedCost > snapshot.bot.money) {
  return {
    plan: { type: AIActionType.PassTurn },
    routeComplete: false,
    routeAbandoned: true,  // ← Kills the entire route
    ...
  };
}
```

When stop 0 (Bruxelles, $12M track cost) exceeded cash ($11M), the check returned `routeAbandoned: true` without checking whether **later stops** were immediately completable. Stop 1 (deliver Cheese@Dublin) was achievable this turn via ferry crossing with zero track cost, but was never evaluated.

**The fix should:** Before abandoning, scan remaining stops for any that are immediately actionable (especially deliveries of carried loads). Only abandon if no stops are viable.

### Bug 2: FR-8 deliver-before-build doesn't fire because `isDeliveryReachable` misses ferry teleportation

**File:** `src/server/services/ai/PlanExecutor.ts` lines 324-344
**File:** `src/server/services/ai/ContextBuilder.ts` lines 252-289

`resolveBuild()` has a deliver-before-build guard (FR-8) that checks:
```typescript
const deliverableDemand = context.demands.find(
  d => d.isLoadOnTrain && d.isDeliveryReachable,
);
```

This should have caught the Cheese→Dublin delivery and overridden the build. But `isDeliveryReachable` is computed by a BFS in `ContextBuilder.getReachableCities()` that doesn't model ferry teleportation the same way `ActionResolver.resolveMove()` does.

The BFS (ContextBuilder lines 261-269) treats encountering a ferry port as halving remaining movement:
```typescript
if (isFerry) {
  newRemaining = Math.floor((remaining - 1) / 2);
}
```

But `ActionResolver.resolveMove()` (lines 337-344) teleports the bot to the paired port and then applies half speed from the full train speed. These are different calculations. When the bot starts AT a ferry port with 5 movement points, the BFS may not correctly model the teleport + half-speed from the other side, causing Dublin to appear unreachable when it actually is.

**The fix should:** Ensure the reachability BFS in ContextBuilder models ferry teleportation identically to ActionResolver — when the bot starts at a ferry port, it should teleport to the paired port and BFS from there at half speed.

### Bug 3: Route stop ordering doesn't prioritize carried-load deliveries

**File:** `src/server/services/ai/RouteValidator.ts` lines 341-365

The `reorderStopsByProximity()` algorithm uses pure geographic nearest-neighbor:
```typescript
// Pick the NEAREST eligible stop (by hex distance)
for (const stop of eligible) {
  const dist = estimateHopDistance(currentPos, coords);
  if (dist < nearestDist) { nearest = stop; }
}
```

It does not boost priority for delivers where the load is already on the train. A delivery of a carried load is almost always the highest-value next action (zero pickup cost, immediate income), but the algorithm treats it the same as any other stop.

Additionally, the system prompt (`systemPrompts.ts` line 122) teaches the LLM "PICKUP BEFORE DELIVER" but doesn't add guidance like "deliver carried loads before picking up new ones."

**The fix should:** In `reorderStopsByProximity()`, prioritize deliver stops where the load is already on the train. These should always come before pickup stops for new loads. Optionally add LLM prompt guidance for the same.

## Severity

**Medium.** The pattern is systemic — any time the bot has an unaffordable stop earlier in the route than a deliverable-via-ferry stop, it will pass instead of delivering. The wasted turn costs both time and the opportunity cost of delayed income (19M in this case). The `routeAbandoned: true` also triggers a new LLM call on the next turn, adding latency.

## Proposed Fix Priority

1. **Bug 1 (JIRA-101 abandon logic)** — Highest priority. Most directly caused the PassTurn. Should scan later stops before abandoning.
2. **Bug 3 (route ordering)** — Medium priority. Would have prevented the scenario entirely by putting Dublin delivery first.
3. **Bug 2 (ferry reachability BFS)** — Lower priority. Defense-in-depth; FR-8 would have caught this as a fallback if the BFS were correct.

## Reproduction

Game `fc8ecd8e`, Turn 12, Flash bot. Conditions:
- Bot at a ferry port carrying a deliverable load
- Active route has an unaffordable stop before the delivery stop
- Delivery city is reachable via ferry crossing
