# JIRA-72: Demand Scoring for Initial Turns Doesn't Optimize Starting City

## Observed in Game
`d32bb790-6ed4-43ca-841d-7de9bfb6b609` — Flash bot (`f74864fb`)

## Problem

When no track exists (turns 1-2), the bot can start at any major city and use it as a **hub** — building spokes outward to supply and delivery cities. But `computeSingleSupplyDemandContext()` computes `estimatedTrackCostToSupply` and `estimatedTrackCostToDelivery` using mismatched reference points and a **linear route model**, producing misleading demand scores that cause the LLM to pick bad routes or miss good ones entirely.

### The Hub Model (How Humans Play)

Human players pick a starting city that acts as a central hub. Track is built as spokes:
- **Spoke 1**: hub → supply city (pick up load)
- **Train returns to hub** via existing track (no build cost)
- **Spoke 2**: hub → delivery city (deliver load)

The total build cost is `pathCost(hub→supply) + pathCost(hub→delivery)` — **not** `pathCost(hub→supply) + pathCost(supply→delivery)`.

When the hub is geographically between supply and delivery, the hub model is dramatically cheaper than a linear route through the supply city.

### Evidence from game log

Turn 2 demand ranking (Flash bot, no track built yet):

| Rank | Demand | Supply→Delivery | Payout | Score | BuildSupply | BuildDelivery | Total Cost |
|------|--------|----------------|--------|-------|-------------|---------------|------------|
| #2 | Imports | Antwerpen→Beograd | 31M | -0.62 | 13M | 45M | 58M |
| #9 | Ham | Warszawa→Budapest | 14M | -1.96 | 20M | 18M | 38M |

**Ham Warszawa→Budapest** scores dead last (-1.96) with `buildSupply=20M + buildDelivery=18M = 38M`. But starting at **Wien as a hub**:
- Spoke 1: Wien→Warszawa ≈ 15M (pick up Ham)
- Train returns to Wien on existing track
- Spoke 2: Wien→Budapest ≈ 5M (deliver Ham)
- **Hub total: ~20M** — the demand is viable and cheap

The current code computes delivery cost as `pathCost(Warszawa→Budapest) = 18M` (linear model), missing that Wien→Budapest is only 5M when Wien is the hub.

**Imports Antwerpen→Beograd** scores #2 (-0.62) but is actually infeasible — the route validator rejects it all 3 attempts because 45M delivery track exceeds the ~37M remaining after building to the supply city. Hamburg (the other Imports source) is closer to Beograd and would produce a cheaper total route, but the scoring picked Antwerpen because the supply cost reference point doesn't account for the full route geography.

### Root Cause — Code Analysis

The cost estimation has **two different cold-start strategies** in `estimateTrackCost()` (`ContextBuilder.ts:1774-1834`):

**Supply cost** (line 493-495, calls `estimateTrackCost(supplyCity, segments, gridPoints)` with no `fromCity`):
- Hits the default cold-start path (line 1812-1833)
- Iterates ALL major city groups via `getMajorCityGroups()`
- Picks the **nearest major city to the supply city** as the reference point
- Returns `estimatePathCost(nearestMajorCity → supplyCity)`

**Delivery cost** (line 498-503, calls `estimateTrackCost(deliveryCity, segments, gridPoints, supplyCity)`):
- On cold-start with `fromCity` provided, hits the fromCity path (line 1787-1809)
- Returns `estimatePathCost(supplyCity → deliveryCity)` — a **linear** route

**Three bugs compound**:

1. **Mismatched starting cities**: Supply cost picks nearest major to supply city (Berlin for Warszawa), while delivery cost uses supply→delivery (Warszawa→Budapest). These two costs assume different route topologies.

2. **Linear model instead of hub model**: Delivery cost is computed as `pathCost(supply→delivery)`, but the optimal play is often `pathCost(hub→delivery)` where the hub is the starting city. For Wien→Warszawa→Wien→Budapest, the hub model gives ~20M total vs the linear model's 38M.

3. **Supply city comparison is poisoned**: `computeBestDemandContext()` evaluates each supply city and picks the best `demandScore`. Since inner cost estimates are wrong (bugs 1+2), Antwerpen beats Hamburg for Imports→Beograd despite Antwerpen→Beograd being infeasible.

**Corridor value has the same issue** (`computeCorridorValue` L1563-1575): on cold-start, it independently picks the nearest major city as corridor start. This is lower priority since `corridorMultiplier ≈ 0` on cold-start (no network cities), but `victoryMajorCities` does affect the `victoryBonus` and uses the wrong corridor reference.

### Scoring formula context

`scoreDemand()` (line 1656-1678):
```
baseROI = (payout - totalTrackCost) / estimatedTurns
corridorMultiplier = min(networkCities * 0.05, 0.5)
victoryBonus = (victoryMajorCities * max(payout * 0.15, 5)) / estimatedTurns
score = baseROI + corridorMultiplier * baseROI + victoryBonus
```

On cold-start, `networkCities = 0` so `corridorMultiplier = 0` and `victoryBonus` is the only boost. The score is dominated by `baseROI = (payout - totalTrackCost) / estimatedTurns`. Inflated `totalTrackCost` from the wrong starting city and wrong route topology directly tanks the score.

## Impact

- Flash bot wastes all 3 LLM retries on infeasible Imports→Beograd route on Turn 2
- Falls back to heuristic, building suboptimal track
- Viable cheap routes (Ham Warszawa→Budapest from Wien) are ranked last and never considered
- Affects all bot difficulty levels on initial turns
- `computeBestDemandContext()` picks wrong supply city (Antwerpen over Hamburg) because it compares scores with inflated/wrong costs

## Proposed Solution

Fix in `computeSingleSupplyDemandContext()` (lines 492-503). On cold-start (`segments.length === 0`), evaluate each major city as a potential **hub** and pick the one that minimizes total route cost. For each candidate starting city, compare hub topology (two spokes from hub) vs linear topology (hub→supply→delivery) and use the cheaper option:

```typescript
// Cold-start: evaluate each major city as hub, pick cheapest total route
if (segments.length === 0 && supplyCity) {
  const majorCityGroups = getMajorCityGroups();
  const supplyPoints = gridPoints.filter(gp => gp.city?.name === supplyCity);
  const deliveryPoints = gridPoints.filter(gp => gp.city?.name === deliveryCity);
  let bestTotalCost = Infinity;
  let bestSupplyCost = 0;
  let bestDeliveryCost = 0;

  for (const group of majorCityGroups) {
    const S = group.center;

    // Spoke 1: hub → supply city
    let supplyCost = Infinity;
    for (const sp of supplyPoints) {
      const cost = estimatePathCost(S.row, S.col, sp.row, sp.col);
      if (cost >= 0 && cost < supplyCost) supplyCost = cost;
    }
    if (supplyCost === Infinity) continue;

    // Hub model: hub → delivery city (separate spoke)
    let hubDeliveryCost = Infinity;
    for (const dp of deliveryPoints) {
      const cost = estimatePathCost(S.row, S.col, dp.row, dp.col);
      if (cost >= 0 && cost < hubDeliveryCost) hubDeliveryCost = cost;
    }

    // Linear model: supply → delivery (continuous line)
    let linearDeliveryCost = Infinity;
    for (const sp of supplyPoints) {
      for (const dp of deliveryPoints) {
        const cost = estimatePathCost(sp.row, sp.col, dp.row, dp.col);
        if (cost >= 0 && cost < linearDeliveryCost) linearDeliveryCost = cost;
      }
    }

    // Pick cheaper topology for this starting city
    const hubTotal = supplyCost + (hubDeliveryCost < Infinity ? hubDeliveryCost : 0);
    const linearTotal = supplyCost + (linearDeliveryCost < Infinity ? linearDeliveryCost : 0);
    const bestForThisCity = Math.min(hubTotal, linearTotal);
    const deliveryCostForBest = bestForThisCity === hubTotal
      ? (hubDeliveryCost < Infinity ? hubDeliveryCost : 0)
      : (linearDeliveryCost < Infinity ? linearDeliveryCost : 0);

    if (bestForThisCity < bestTotalCost) {
      bestTotalCost = bestForThisCity;
      bestSupplyCost = supplyCost;
      bestDeliveryCost = deliveryCostForBest;
    }
  }

  if (bestTotalCost < Infinity) {
    estimatedTrackCostToSupply = bestSupplyCost;
    estimatedTrackCostToDelivery = bestDeliveryCost;
  }
}
```

### Why this works

- `computeBestDemandContext()` already iterates over supply cities in the outer loop. By fixing cost estimation in the inner function to optimize starting city with hub awareness, the supply city comparison naturally picks the right one too.
- The hub-vs-linear comparison captures how humans actually play: sometimes a hub is better (Wien for Warszawa+Budapest), sometimes a linear route is better (when supply and delivery are roughly collinear from the start).
- The `estimateTrackCost` function's existing cold-start paths (lines 1784-1833) remain unchanged for non-demand-scoring callers.

### Additional fixes

1. **Surface optimal starting city to LLM**: Add an `optimalStartingCity` field to `DemandContext` so the LLM prompt can include "start at Wien, build toward Warszawa" on cold-start turns.

2. **Corridor value consistency**: Pass the chosen optimal starting city into `computeCorridorValue` so corridor waypoints start from the same reference. Lower priority since corridor multiplier ≈ 0 on cold-start, but keeps data consistent for `victoryMajorCities`.

3. **Travel turns for hub model**: The `travelTurns` calculation (L522-541) should account for hub travel pattern: `hub→supply→hub→delivery` has more milepost hops than linear `hub→supply→delivery`.

### Performance

~20 major cities × 3 Dijkstra calls (hub→supply, hub→delivery, supply→delivery) per demand per supply city. With ~9 demands × ~2 supply cities avg = ~540 Dijkstra calls. Each is bounded by the grid size (~3000 nodes). Should complete in <100ms total.

### Edge cases

- **Supply city IS a major city** (e.g., Berlin supplies Machinery): `supplyCost = 0` for that starting city, hub model degenerates to just `pathCost(Berlin→deliveryCity)`
- **Delivery city IS a major city**: delivery spoke cost is very low; hub model naturally favors nearby starting cities
- **Supply and delivery near each other**: linear model wins, loop correctly picks it via `min(hubTotal, linearTotal)`
- **Cross-continent routes**: hub model unlikely to help (no city between), linear wins
- **Ferry routes**: `estimatePathCost` may return 0 (unreachable) for island cities — verify ferry handling

## Acceptance Criteria

1. On cold-start (no track), `computeSingleSupplyDemandContext` evaluates each major city as a potential **hub** and picks the one that minimizes total build cost using `min(hubCost, linearCost)` topology comparison
2. `computeBestDemandContext()` naturally picks the correct supply city because inner cost estimates are now accurate
3. Ham Warszawa→Budapest starting from Wien should score significantly better than -1.96 (expected ~20M total track cost via hub model vs current 38M linear)
4. Imports→Beograd should evaluate Hamburg as a supply city when Hamburg produces a cheaper total route than Antwerpen
5. Existing tests continue to pass — no regression in demand scoring for bots with existing track
6. (P1) Optimal starting city is surfaced to the LLM in the demand context for cold-start turns
