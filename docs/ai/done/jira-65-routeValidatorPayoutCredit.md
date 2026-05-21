# JIRA-65: RouteValidator Budget Check Doesn't Credit Delivery Payouts

## Bug Description

`RouteValidator.checkCumulativeBudget()` is supposed to account for delivery payouts when checking if later route stops are affordable. However, it relies on `stop.payment` from the LLM's structured output. When the LLM omits the `payment` field on DELIVER stops, the payout defaults to 0 and subsequent stops are incorrectly marked as budget-infeasible — silently pruning profitable multi-stop routes.

## Evidence

### Game `be09cd45`, Flash (gemini-3-flash), T2:
- LLM planned a 4-stop route:
  1. PICKUP Steel at Ruhr
  2. PICKUP Tourists at Ruhr
  3. DELIVER Steel at Warszawa (19M payout)
  4. DELIVER Tourists at Napoli (32M payout)
- Route was pruned to 2 stops (Steel only)
- Tourist→Napoli deliver marked infeasible by budget check — the Steel delivery payout (19M) was not credited, so projected cash was too low for Napoli track build
- Lost a 32M delivery opportunity at game start

## Root Cause

`RouteValidator.checkCumulativeBudget()` (line 245):
```typescript
runningCash += stop.payment ?? 0;
```

The `payment` field on route stops is parsed from `raw.payment` in `ResponseParser.parseStrategicRoute()` (line 329). If the LLM omits this field (common — the schema doesn't require it), the budget check doesn't credit the payout. The cascading prune logic (lines 83-96) then also removes the corresponding pickup: "picking up without viable delivery is wasteful."

## Fix

When `stop.payment` is missing on a DELIVER stop, look up the payout from `context.demands` by matching `loadType + deliveryCity`:

```typescript
// In checkCumulativeBudget, when processing a deliver stop:
const payout = stop.payment ?? demand?.payout ?? 0;
runningCash += payout;
```

## Affected Files

- `src/server/services/ai/RouteValidator.ts` — `checkCumulativeBudget()` (lines 216-248)

## Impact

Would have preserved Flash's Tourist route at game start — 32M payout over ~8 turns. This bug silently prunes any multi-stop route where a later stop depends on cash from an earlier delivery, whenever the LLM doesn't echo back payout amounts.
