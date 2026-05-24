# JIRA-152: InitialBuildPlanner cost estimator ignores hub routing

## Problem

Game e179466e: Ham Warszawa→Stuttgart (21M payout) was filtered out of initial build options entirely. The planner estimated totalBuildCost=49M (Berlin→Warszawa=~24M + Warszawa→Stuttgart=~25M) which exceeds MAX_BUILD_BUDGET(40M).

But a human starting in Berlin would plan this differently:
1. Build east from Berlin toward Warszawa (~18M)
2. Build southwest from Berlin toward Stuttgart (~9-15M)
3. Pick up Ham at Warszawa, travel back through Berlin, deliver at Stuttgart

The bot's track through Berlin connects BOTH cities. The delivery leg doesn't need a direct Warszawa→Stuttgart route — it goes Warszawa→Berlin→Stuttgart, reusing the Berlin hub track.

## Root Cause

`estimateBuildCostFromCity()` computes `buildCostToSupply + buildCostSupplyToDelivery` — a LINEAR route from start→supply→delivery. It never considers that the delivery leg can go BACK THROUGH the starting city.

For Ham from Berlin:
- buildCostToSupply = costBetween(Berlin, Warszawa) ≈ 24M
- buildCostSupplyToDelivery = costBetween(Warszawa, Stuttgart) ≈ 25M  
- totalBuildCost = 49M > 40M → FILTERED OUT

Correct estimate using hub routing:
- buildCostToSupply = costBetween(Berlin, Warszawa) ≈ 24M
- buildCostToDelivery = costBetween(Berlin, Stuttgart) ≈ 15M (through hub, NOT from Warszawa)
- totalBuildCost = 24 + 15 = 39M ≤ 40M → VIABLE

## Fix

In `estimateBuildCostFromCity()`, the supply→delivery cost should be `min(costBetween(supply, delivery), costBetween(start, delivery))`. The bot can deliver either:
- Directly from supply to delivery (current behavior)
- Via the starting city hub (supply→start→delivery), where start→delivery is new track but start→supply is already built

```typescript
// Cost: supply city → delivery city (consider hub routing)
let buildCostSupplyToDelivery = Infinity;
if (supplyCity === deliveryCity) {
  buildCostSupplyToDelivery = 0;
} else {
  // Direct: supply → delivery
  for (const sup of supplyPoints) {
    for (const dp of deliveryPoints) {
      const cost = InitialBuildPlanner.costBetween(sup.row, sup.col, dp.row, dp.col);
      if (cost < buildCostSupplyToDelivery) buildCostSupplyToDelivery = cost;
    }
  }
  // Hub routing: start → delivery (supply→start track already built)
  for (const sp of startPoints) {
    for (const dp of deliveryPoints) {
      const cost = InitialBuildPlanner.costBetween(sp.row, sp.col, dp.row, dp.col);
      if (cost < buildCostSupplyToDelivery) buildCostSupplyToDelivery = cost;
    }
  }
}
```

The totalBuildCost is still `buildCostToSupply + buildCostSupplyToDelivery` — but now buildCostSupplyToDelivery reflects the cheaper of the two routing options.

## Acceptance Criteria

- [ ] Ham Warszawa→Stuttgart from Berlin produces totalBuildCost ≈ 39M (not 49M)
- [ ] Existing tests pass
- [ ] New test: delivery via hub is cheaper than direct supply→delivery route
