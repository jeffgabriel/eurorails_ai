# JIRA-90: Post-Delivery A2 Movement Reclamation

## Problem

After a mid-turn delivery that completes the active route, the bot's remaining movement budget is wasted on heuristic targets instead of being directed by LLM replanning.

### Root Cause

The TurnComposer A2 continuation loop runs **before** Stage 3d post-delivery LLM replanning in AIStrategyEngine. When a delivery completes the route:

1. TurnComposer A2 loop detects the delivery step
2. A2 chains heuristic continuation MOVEs via `findMoveTargets()` (deterministic, no LLM)
3. A2 consumes the entire remaining movement budget → `compositionTrace.moveBudget.wasted = 0`
4. Stage 3d fires correctly — calls `planRoute()` for a fresh strategy (JIRA-86 code path)
5. `planRoute()` returns a valid new route
6. **Bug**: `wastedMovement = 0` → `if (wastedMovement > 0)` is false → skips `PlanExecutor.execute()` and `TurnComposer.compose()` re-composition
7. The new route only affects build targeting, not movement — remaining movement was already consumed by A2 heuristics

### Example: Game c22ab70c

Haiku bot delivers Potatoes to Antwerpen, completing its route. It has movement budget remaining. Instead of calling the LLM and moving toward a new strategic goal, it moves toward a heuristic target chosen by `findMoveTargets()` (demand-score-ranked cities, reachable cities fallback).

## Fix

In Stage 3d of `AIStrategyEngine.executeTurn()`, when `routeWasCompleted` and a new route is obtained from `planRoute()`:

1. Find the last `DeliverLoad` step in the composed plan
2. Identify post-delivery steps (A2 heuristic continuations)
3. Calculate movement used by those heuristic steps via `computeEffectivePathLength()`
4. Strip the heuristic steps from the plan
5. Add reclaimed movement to `wastedMovement`
6. Use the reclaimed budget for LLM-guided re-composition via `PlanExecutor.execute()` + `TurnComposer.compose()` with the new route

This only activates when `routeWasCompleted` — the existing `reEvaluateRoute()` path (Path A) for incomplete routes is unchanged.

## Files Modified

- `src/server/services/ai/AIStrategyEngine.ts` — Stage 3d: A2 movement reclamation logic, added `computeEffectivePathLength` and `TurnPlanMoveTrain` imports
- `src/server/__tests__/ai/AIStrategyEngine.test.ts` — 4 new tests, added `computeEnRoutePickups` mock (JIRA-87 dependency)

## Tests

1. **Reclaims A2 heuristic movement and calls planRoute for completed route** — verifies `planRoute()` is called when route completes mid-turn
2. **Uses reclaimed movement for re-composition with new route** — verifies `PlanExecutor.execute()` and `TurnComposer.compose()` are called a second time with reclaimed budget
3. **Graceful fallback when planRoute returns null** — pipeline doesn't crash
4. **Calls reEvaluateRoute when delivery does NOT complete route** — Path A unchanged

## Related

- **JIRA-86**: Added `planRoute()` call for `routeWasCompleted` in Stage 3d (the code path this fix corrects)
- **JIRA-83**: Post-composition re-eval and Stage 3e heuristic fallback
- **JIRA-89**: Proactive Secondary Delivery Planning (different problem — plans multi-load routes upfront before execution)
