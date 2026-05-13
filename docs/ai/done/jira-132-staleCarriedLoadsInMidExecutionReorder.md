# JIRA-132: Stale carriedLoads in PlanExecutor mid-execution reorder

## Bug Summary

After a mid-turn pickup completes, `PlanExecutor.execute()` calls `RouteValidator.reorderStopsByProximity()` with `context.loads` — but `context.loads` reflects the state at the **start of turn** (before any pickups). The reorder algorithm doesn't know the bot just picked up a load, so it can't properly prioritize nearby pickups over distant deliveries for carried cargo.

## Observed Behavior (game 15d64904, Flash ~t30-34)

LLM planned the efficient route:
```
pickup(Wood@Sarajevo) → pickup(Labor@Beograd) → deliver(Wood@Lodz) → deliver(Labor@Warszawa)
```

After picking up Wood at Sarajevo, the JIRA-123 reorder changed it to:
```
pickup(Wood@Sarajevo) → deliver(Wood@Lodz) → pickup(Labor@Beograd) → deliver(Labor@Warszawa)
```

Flash zigzagged: Sarajevo → north to Lodz → south to Beograd → north to Warszawa. Wasted ~4 turns of movement.

## Root Cause

`PlanExecutor.ts:66-74` — after `skipCompletedStops()` advances past the Sarajevo pickup:

```typescript
const reordered = RouteValidator.reorderStopsByProximity(
  remainingStops,
  { row: context.position.row, col: context.position.col },
  gridPoints,
  context.loads,  // ← STALE: doesn't include Wood just picked up
);
```

`context.loads` is built by `ContextBuilder.build()` at the start of the turn. Pickups completed during `skipCompletedStops()` are not reflected. The reorder algorithm's carried-load delivery promotion (JIRA-121 Bug 3) and nearby-pickup gate (JIRA-123) both depend on accurate `carriedLoads` to make correct decisions.

## Fix

**Option A (recommended):** Compute effective carried loads from completed stops.

In `PlanExecutor.execute()`, after `skipCompletedStops()` and before calling `reorderStopsByProximity()`, build an accurate carried loads list:

```typescript
// Compute effective carried loads: start-of-turn loads + pickups completed this turn
const completedPickups = route.stops
  .slice(prevIndex, route.currentStopIndex)
  .filter(s => s.action === 'pickup')
  .map(s => s.loadType);
const effectiveLoads = [...(context.loads ?? []), ...completedPickups];

const reordered = RouteValidator.reorderStopsByProximity(
  remainingStops,
  { row: context.position.row, col: context.position.col },
  gridPoints,
  effectiveLoads,  // ← accurate carried loads
);
```

**Option B:** Pass `snapshot.bot.loads` instead of `context.loads`. The snapshot gets mutated during execution, so it may already include the pickup. However, this is fragile — it depends on execution order and snapshot mutation timing.

## Scope

| File | Change |
|------|--------|
| `src/server/services/ai/PlanExecutor.ts` | Compute `effectiveLoads` before reorder call (~5 lines) |

No other files affected. The fix is localized to PlanExecutor's JIRA-123 reorder trigger.

## Test Plan

1. Add unit test: route with 2 pickups + 2 delivers in same region → after first pickup, reorder preserves second pickup before distant delivery
2. Verify existing `PlanExecutor.test.ts` tests pass
3. Manual: replay game 15d64904 scenario — Flash should keep both Balkan pickups before heading north
