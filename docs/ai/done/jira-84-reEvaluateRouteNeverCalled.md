# JIRA-84: reEvaluateRoute Never Called — Post-Delivery LLM Re-evaluation Not Triggering

## Bug Description

The JIRA-64 post-delivery LLM re-evaluation feature (`reEvaluateRoute`) exists in the codebase but was never called across an entire 33-turn game with 8 deliveries between 2 bots. The LLM is only invoked when a route is fully exhausted (all stops completed), not after mid-route deliveries when a new demand card is drawn and strategy should be reassessed.

## Evidence

### Game `17684b7c`:

**Haiku (5 LLM calls, 0 re-evaluations):**
- T6: Delivered Cheese → LLM called T7 (but only because route was exhausted, not re-eval)
- T15: Delivered Wood → LLM called T16 (route exhausted)
- T24: Delivered Wood → LLM called T25 (route exhausted)
- T32: Delivered Copper → LLM called T33 (route exhausted)

**Gemini (4 LLM calls, 0 re-evaluations):**
- T9: Delivered Tobacco → LLM called T10 (route exhausted)
- T14: Delivered Wheat mid-route (Cars stop remaining) → **NO re-eval** → LLM called T15 (full re-plan)
- T17: Delivered Cars → LLM called T18 (route exhausted)
- T28: Delivered Tobacco mid-route (Wheat stop remaining) → **NO re-eval** → route continued

Key missed re-evaluations:
- **Gemini T14**: Delivered Wheat, drew new demand card (Hops: Cardiff→Milano). Should have re-evaluated whether to continue Cars→Nantes route or pivot.
- **Gemini T28**: Delivered Tobacco, drew new demand (Fish: Porto→Zurich). Should have re-evaluated whether phantom Wheat→Firenze stop is still worth pursuing.

## Root Cause

The re-evaluation code exists in `AIStrategyEngine.ts:482-526` and fires when `hadDelivery` is true (line 462). But the guard condition at line 486 requires:

```typescript
const routeForReEval = activeRoute ?? preDeliveryRoute;
if (routeForReEval && AIStrategyEngine.hasLLMApiKey(botConfig)) {
```

Two potential reasons it never fires:

### Hypothesis 1: `activeRoute` is null after delivery
At AIStrategyEngine line ~301, the route may be cleared after delivery because the route is considered "complete" (all stops done). If the delivery was the last stop, `activeRoute` becomes null before reaching line 486. The `preDeliveryRoute` variable should catch this, but it may not be set correctly.

### Hypothesis 2: `hadDelivery` is false
The `hadDelivery` check at line 369 is `(result.payment ?? 0) > 0`. If TurnExecutor reports `payment: undefined` (e.g., when delivery happens in TurnComposer's A2 chain but the last executed step is a MOVE, not a delivery), `hadDelivery` would be false.

### Hypothesis 3: Route executor handles delivery, not takeTurn
If deliveries happen inside the route-executor path (not the main takeTurn action path), the `result.payment` from TurnExecutor may reflect only the route-executor's delivery, but the `hadDelivery` check happens at a different level.

Need to trace the exact execution path for a mid-route delivery turn to determine which hypothesis is correct.

## Affected Files

- `src/server/services/ai/AIStrategyEngine.ts:369` — `hadDelivery` check
- `src/server/services/ai/AIStrategyEngine.ts:462-526` — Post-delivery re-evaluation block
- `src/server/services/ai/AIStrategyEngine.ts:~280-310` — Route completion / clearing logic
- `src/server/services/ai/TurnExecutor.ts:257` — `payment` only reports last step's payment

## Impact

Without re-evaluation, bots execute stale routes for the rest of the game after drawing new demand cards. In game 17684b7c, Gemini carried a phantom Wheat delivery in its route for 19 turns because no re-evaluation was triggered to remove it or pivot strategy. This cascades into all route planning being suboptimal.
