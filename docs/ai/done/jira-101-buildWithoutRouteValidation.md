# JIRA-101: Build Execution Without Route Feasibility Validation

## Problem

The bot builds track toward cities without validating that the route is affordable or strategically sound. PlanExecutor blindly executes BUILD toward unreachable stops based on LLM route plans that use wildly inaccurate cost estimates. The bot should NEVER build track without a validated plan.

### Example: Game c9736f59, T5 (player aa9b65d8 "flash")

After delivering Wine at Warszawa, LLM plans Marble@Firenze → Lodz. Demand scoring estimated `trackCostToSupply: 7` for Wien → Firenze. The bot committed $38M building through Alpine terrain (actual cost 5x the estimate), dropping from $46M to $8M — nearly bankrupt on a route it can't complete for many more turns.

## Root Cause

When `PlanExecutor.execute()` is called with the new LLM-planned route (AIStrategyEngine line 583), it resolves the first unreachable stop by returning BUILD toward that city — without any validation that:

1. The build is **affordable** relative to the route's total track cost
2. The route's track cost estimate matches reality (demand scoring said $7M, actual was $38M+)
3. Building toward this target is **strategically sound** given the bot's cash position

No circuit breaker exists between the LLM's optimistic route plan and the build execution.

## Expected Behavior

Before committing to a build, the system should verify:
- The build target is part of a validated route (RouteValidator)
- The estimated track cost is within the bot's budget over a reasonable time horizon
- If the actual build cost dramatically exceeds the demand scoring estimate, the route should be re-evaluated or abandoned

## Possible Fix

RouteValidator (or a new feasibility check in PlanExecutor) should reject routes where `trackCostToSupply + trackCostToDelivery` exceeds the bot's available cash + near-term delivery payouts prior to needing the track. At minimum, the post-delivery PlanExecutor.execute at AIStrategyEngine line 583 should not produce a BUILD for a route that hasn't been validated against actual pathfinding costs.

## Files to Investigate

- `PlanExecutor.ts` — `execute()` and `resolveBuild()` — no feasibility gate before building
- `RouteValidator.ts` — should reject routes with unrealistic track cost estimates
- `AIStrategyEngine.ts:583` — post-delivery PlanExecutor call with no validation
