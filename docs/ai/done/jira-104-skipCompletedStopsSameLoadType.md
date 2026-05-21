# JIRA-104: skipCompletedStops Skips Second Pickup of Same Load Type

## Problem

When a route has two pickup stops for the same load type (e.g., two Flowers pickups at Holland for different demand cards), `PlanExecutor.skipCompletedStops()` incorrectly skips the second pickup after the first one is completed. This causes the bot to travel to the delivery city with only one load, deliver it, then re-plan and travel all the way back to pick up the second load.

### Example: Game 883aae52, player "flash" (410740d4)

LLM planned a 4-stop route:
1. `pickup(Flowers@Holland)` — for Kaliningrad demand
2. `pickup(Flowers@Holland)` — for Krakow demand
3. `deliver(Flowers@Kaliningrad)`
4. `deliver(Flowers@Krakow)`

- **T15**: Bot picks up first Flowers at Holland. Stop index advances from 0 to 1.
- **T16**: `skipCompletedStops` checks stop 1 (`pickup Flowers@Holland`). `context.loads.includes("Flowers")` is `true` (from first pickup). **Stop 1 skipped.** Index jumps to 2 (deliver@Kaliningrad).
- **T18**: Delivers one Flowers at Kaliningrad.
- **T19**: Re-plans new route: `pickup(Flowers@Holland) → deliver(Flowers@Krakow)`. Must travel all the way back west.
- **T21-24**: Round-trip back to Holland and east to Krakow.

~6-8 turns wasted on unnecessary round-trip.

## Root Cause

`PlanExecutor.ts:673-679` — `skipCompletedStops` uses `context.loads.includes(stop.loadType)` to check if a pickup is complete. This is a boolean check that doesn't account for quantity. When the train carries 1 Flowers but the route needs 2 Flowers pickups, the second pickup is wrongly marked as complete.

```typescript
if (stop.action === 'pickup') {
  if (context.loads.includes(stop.loadType)) {  // BUG: doesn't count instances
    idx++;
    continue;
  }
}
```

## Fix

The check needs to be count-aware. Count how many instances of the load type are on the train, and compare against how many pickup stops for that load type have already been completed (i.e., are before the current `idx`). Only skip if the train has more instances than the number of preceding same-type pickups that are still pending.

Simpler approach: count occurrences of `stop.loadType` in `context.loads`, and count how many pickup stops for that load type exist at indices `<= idx` (including stops already skipped in this loop iteration). Skip only if loads-on-train >= pickup-stops-up-to-here.

## Files to Investigate

- `PlanExecutor.ts:666-699` — `skipCompletedStops` method
- `PlanExecutor.test.ts` — needs test for same-load-type multi-pickup route
