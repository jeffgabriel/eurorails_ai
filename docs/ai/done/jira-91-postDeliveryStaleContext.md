# JIRA-91: Post-Delivery Stage 3d Stale Context

## Problem

After a mid-turn delivery, Stage 3d's post-delivery LLM calls (`planRoute()` and `reEvaluateRoute()`) receive stale pre-delivery context. The LLM sees already-delivered loads, fulfilled demand cards, and pre-delivery money — causing validation failures and wasted turns.

### Root Cause

The composed plan includes the delivery, but it hasn't been executed against the DB yet (that happens in Stage 5). Stage 3d calls `capture()` at line 416 which reads the DB — but the DB still has the pre-delivery state. Additionally, `reEvalContext` is built by spreading fresh demands onto the Stage 2 `context` object, so fields like `loads`, `money`, `position`, `canDeliver`, `canPickup` are all stale.

Two specific bugs:
1. **Line 418**: `reEvalContext = { ...context, demands: freshDemands }` — only refreshes demands, all other context fields remain stale from Stage 2
2. **Line 444**: `reEvaluateRoute(snapshot, ...)` passes the Stage 1 `snapshot` instead of `freshSnap` (the `planRoute` path on line 427 correctly uses `freshSnap`, but both paths get stale data from `capture()` anyway since the DB hasn't been updated)

### Example: Game 14843294

Turn 5: Haiku bot delivers Beer to Bruxelles. Stage 3d fires `planRoute()` for fresh strategy. All 3 LLM attempts fail with validation errors:

- Attempt 1: LLM says "PICKUP Beer at Bruxelles" → fails ("Bruxelles is not a known supply city for Beer")
- Attempt 2: LLM says "PICKUP Beer at Ruhr" → fails ("Ruhr is not a known supply city for Beer")
- Attempt 3: LLM says "PICKUP Beer at Bruxelles" → fails again

The LLM keeps trying to plan for Beer because the stale context still shows the Beer demand card and Beer on the train. The correct post-delivery state would show: Beer removed from train, Beer demand card replaced with a new card, +10M cash, and Chocolate available for pickup at Bruxelles (which A1 opportunistically picked up but the LLM never knew about).

Result: No new route set → A2 heuristic moves bot in wrong direction → Turn 6 wastes 7 of 9 movement points.

## Fix

Execute composed steps through the delivery against the DB **before** Stage 3d's LLM call, then call `capture()` to get real post-delivery state including the newly drawn demand card.

1. Find the last `DeliverLoad` step in the composed plan
2. Split into delivery steps (everything up to and including the delivery) and post-delivery steps
3. Execute delivery steps via `TurnExecutor.executeMultiAction()` — commits to DB
4. Call `capture()` — now returns real state with new demand card, updated money, correct loads
5. Call `ContextBuilder.build(freshSnap, ...)` for full fresh context (not just `rebuildDemands` spread)
6. Pass fresh snapshot and context to `planRoute()` / `reEvaluateRoute()`
7. In Stage 5, only execute post-delivery steps (avoid double-execution of delivery steps)

## Files to Modify

- `src/server/services/ai/AIStrategyEngine.ts` — Stage 3d: early execution of pre-delivery steps, fresh context build, fix stale snapshot on line 444, split Stage 5 execution
- `src/server/__tests__/ai/AIStrategyEngine.test.ts` — Tests verifying fresh context in post-delivery LLM calls

## Related

- **JIRA-86**: Added `planRoute()` call for `routeWasCompleted` in Stage 3d (the code path affected)
- **JIRA-90**: A2 movement reclamation in same Stage 3d area (strips post-delivery heuristic steps)
- **JIRA-83**: Post-composition re-eval and Stage 3e heuristic fallback
