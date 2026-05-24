JIRA-107: Preserve Pickup Origin After Load Is On Train

Problem
- When a load is already on the train, ContextBuilder passes `null` as supplyCity to `computeSingleSupplyDemandContext`.
- At ContextBuilder.ts:673, `supplyCity ?? 'Unknown'` coerces null to the string "Unknown".
- RouteValidator.checkPickupFeasibility matches pickup stops against `d.supplyCity`, so `pickup(Fish@Unknown)` passes validation because "Unknown" is the stored supplyCity.
- PlanExecutor then calls ActionResolver.resolve({ action: 'BUILD', details: { toward: 'Unknown' } }) and stalls for multiple turns building toward a non-existent city.

Root Cause
- ContextBuilder.computeBestDemandContext (line 438) correctly detects that a load is on the train, but passes `null` as supplyCity.
- The null-coalescing fallback `supplyCity ?? 'Unknown'` (line 673) makes "Unknown" look like a real city to all downstream consumers.

Goal
- Eliminate "Unknown" pickup stops without blocking valid planned routes (e.g., double-pickup of same load type at a real city).

Recommended Approach (Minimal Fix)
1. Replace "Unknown" sentinel with "OnTrain" in ContextBuilder
   - At ContextBuilder.ts:673, change `supplyCity ?? 'Unknown'` to `supplyCity ?? 'OnTrain'`.
   - "OnTrain" will never match a real city name, so RouteValidator.checkPickupFeasibility (line 207) will reject pickup stops like `pickup(Fish@OnTrain)`.
   - Valid double-pickups (e.g., `pickup(Fish@Aberdeen)`) still pass because the second demand context has a real supplyCity from the supply city iteration loop.

2. No changes to RouteValidator, PlanExecutor, BotMemory, or TurnExecutor
   - RouteValidator already rejects pickups whose city doesn't match any known supplyCity — it just needs "Unknown" to stop matching.
   - PlanExecutor never receives "OnTrain" as a build target because RouteValidator filters it out.

Why NOT the loadOrigins approach (Option 1 from original spec)
- Tracking pickup origin in bot memory (loadOrigins: Record<string, string>) is overkill for this bug.
- The bot doesn't need to re-pick-up a load it already has — it just needs to deliver it.
- Adding memory tracking + plumbing into ContextBuilder + cleanup on deliver/drop is 4+ files changed for a problem solvable with a 1-line sentinel rename.
- Risk: a blanket "reject pickup when isLoadOnTrain" approach would block valid double-pickups (two demand cards for the same load type, bot at a city with that load available).

Plan
1. Change sentinel value
   - ContextBuilder.ts line 673: `supplyCity ?? 'Unknown'` → `supplyCity ?? 'OnTrain'`
2. Add test
   - Unit test: when load is on train, supplyCity is "OnTrain" (not "Unknown").
   - Unit test: RouteValidator rejects pickup(Fish@OnTrain) as infeasible.

Notes
- This is a ~1-line fix. The "Unknown" string was an accidental sentinel that happened to pass validation because RouteValidator doesn't distinguish real city names from fallback strings.
- The LLM prompt context will show supplyCity: "OnTrain" for carried loads, which is actually more informative than "Unknown" — it signals the load doesn't need pickup.
