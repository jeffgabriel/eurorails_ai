# JIRA-211 — Technical: `checkCumulativeBudget` deducts running cash for infeasible stops

See `docs/jira/jira-211-behavioral.md` for the observed behavior.

## Root cause

`RouteValidator.checkCumulativeBudget` at `src/server/services/ai/RouteValidator.ts:287-342` walks the stop list with a `runningCash` register that starts at `snapshot.bot.money`. For each stop it:

1. Computes `trackCost`
2. Marks the stop infeasible if `trackCost > runningCash`
3. **Always** deducts `trackCost` from `runningCash` (and adds `payment` for delivers)

Step 3 is the bug. Lines 326-340:

```ts
if (stop.action === 'pickup') {
  const trackCost = demand.isSupplyOnNetwork ? 0 : demand.estimatedTrackCostToSupply;
  if (trackCost > runningCash) {
    v.feasible = false;
    v.error = `Cumulative budget exceeded: need ~${trackCost}M track to reach ${stop.city}, only ~${runningCash}M remaining after prior stops.`;
  }
  runningCash -= trackCost;          // ← always deducted
} else {
  // deliver
  const trackCost = demand.isDeliveryOnNetwork ? 0 : demand.estimatedTrackCostToDelivery;
  if (trackCost > runningCash) {
    v.feasible = false;
    v.error = `Cumulative budget exceeded: need ~${trackCost}M track to reach ${stop.city}, only ~${runningCash}M remaining after prior stops.`;
  }
  runningCash -= trackCost;          // ← always deducted
  runningCash += stop.payment ?? demand?.payout ?? 0;   // ← always added
}
```

When a stop is marked infeasible, `runningCash` should not change for it — the bot won't actually visit that stop, so its cost shouldn't be charged against subsequent stops' budgets. Today it is.

## Concrete reproduction (game `b1dc793c`, T13)

LLM proposed `[deliver(Labor, Antwerpen, payment 26), pickup(Ham, Warszawa), deliver(Ham, Milano, payment 26)]`.

- Bot cash: 27M.
- `trackCostToDelivery` for Antwerpen: 36M; for Milano: 19M; `trackCostToSupply` for Warszawa: 4M.

Walk:

| stop | trackCost | runningCash before | feasible? | runningCash after |
|---|---|---|---|---|
| deliver(Labor@Antwerpen) | 36 | 27 | ❌ (36 > 27) | 27 − 36 + 26 = **17** |
| pickup(Ham@Warszawa)     |  4 | 17 | ✅          | 17 −  4 = **13** |
| deliver(Ham@Milano)      | 19 | 13 | ❌ (19 > 13) | 13 − 19 + 26 = 20 |

The error message generated for Milano — *"only ~13M remaining after prior stops"* — is computed from runningCash that was depleted by an infeasible Antwerpen stop the bot will never take. Without the false drain, the walk should be:

| stop | trackCost | runningCash before | feasible? | runningCash after |
|---|---|---|---|---|
| deliver(Labor@Antwerpen) | 36 | 27 | ❌ (36 > 27) | **27** (unchanged — bot won't take this stop) |
| pickup(Ham@Warszawa)     |  4 | 27 | ✅          | 27 −  4 = 23 |
| deliver(Ham@Milano)      | 19 | 23 | ✅          | 23 − 19 + 26 = 30 |

Result: route is pruned to `[pickup(Ham@Warszawa), deliver(Ham@Milano)]`, both feasible, total payout 26M, total build 23M, profitable.

## Fix

In `checkCumulativeBudget`, only update `runningCash` when the stop remains feasible after the affordability check.

```ts
// pickup branch
if (stop.action === 'pickup') {
  const trackCost = demand.isSupplyOnNetwork ? 0 : demand.estimatedTrackCostToSupply;
  if (trackCost > runningCash) {
    v.feasible = false;
    v.error = `Cumulative budget exceeded: need ~${trackCost}M track to reach ${stop.city}, only ~${runningCash}M remaining after prior stops.`;
    continue;   // do not deduct — bot won't visit this stop
  }
  runningCash -= trackCost;
}

// deliver branch
if (stop.action === 'deliver') {
  const trackCost = demand.isDeliveryOnNetwork ? 0 : demand.estimatedTrackCostToDelivery;
  if (trackCost > runningCash) {
    v.feasible = false;
    v.error = `Cumulative budget exceeded: need ~${trackCost}M track to reach ${stop.city}, only ~${runningCash}M remaining after prior stops.`;
    continue;   // do not deduct or credit — bot won't visit this stop
  }
  runningCash -= trackCost;
  runningCash += stop.payment ?? demand?.payout ?? 0;
}
```

The for-loop is currently a `for...of` with no `continue` — minor refactor needed. Equivalent: wrap the post-check side effects in the `else` branch of the affordability check.

## Why this only surfaces now

This is a pre-existing bug in `checkCumulativeBudget` (well before JIRA-210), but JIRA-210B made the LLM more likely to emit multi-stop routes that pair an unaffordable carried-load delivery with a profitable pickup-and-deliver downstream — which is exactly the input that triggers the false running-cash drain. With multi-candidate framing removed, the LLM has fewer chances to "try a different combination" and lands on the poisoned single-route output more consistently.

## Affected code

- `src/server/services/ai/RouteValidator.ts:287-342` — fix site
- `src/server/__tests__/ai/RouteValidator.test.ts` — add unit test reproducing the T13 sequence (Antwerpen infeasible → Ham/Milano feasible) and asserting the pruned route is `[pickup(Ham@Warszawa), deliver(Ham@Milano)]`

## Out of scope (per behavioral)

- LLM retry behavior with single-stop unaffordable plans
- Strategy-brain fallback behavior (it shares the same validator; this fix benefits both paths)
- Stuck-state recovery (drop carried load when no profitable delivery exists)
- Build-cap multi-turn affordability semantics (separate concern; this fix only addresses the running-cash drain)
