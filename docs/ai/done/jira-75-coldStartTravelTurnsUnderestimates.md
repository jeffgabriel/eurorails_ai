# JIRA-75: Cold-Start Travel Turns Underestimates Round-Trip Travel

## Observed in Game
`000cb369-2a94-4ffd-adf4-42745a9a0fe9` — Flash bot (`41b24096`, gemini-3-flash)

## Problem

When the bot has no track (cold-start), the `estimatedTurns` calculation in `computeSingleSupplyDemandContext` underestimates travel time for demands where the starting city is far from the supply city. The linear model computes travel as `supply→delivery` distance, ignoring the fact that the bot starts at the **hub/starting city** and must first travel to the supply city before heading to delivery.

This inflates the attractiveness of starting at the delivery city (0 delivery track cost) while hiding the massive travel cost (full round trip through supply city).

### Evidence from game log

Flash bot Turn 2 demand ranking (cold-start, no track):

| Demand | Supply→Delivery | Payout | TrackSupply | TrackDelivery | TotalTrack | EstTurns | Score |
|--------|----------------|--------|-------------|---------------|------------|----------|-------|
| Tourists | Ruhr→Napoli | 32M | 0 | 44M | 44M | 8 | -0.13 |
| **Marble** | **Firenze→Ruhr** | **22M** | **35M** | **0** | **35M** | **8** | **-0.24** |

Flash chose Marble Firenze→Ruhr, starting at Ruhr. The `estimatedTurns: 8` breaks down as:
- `buildTurns = ceil(35/20) = 2` (actually 40M via estimatePathCost, ~2 turns)
- `travelTurns = ceil(23/9) = 3` ← **BUG: uses Firenze→Ruhr distance (23 hops)**
- `estimatedTurns = 2 + 3 + 1 = 6` (logged as 8 with other adjustments)

**Actual travel from Ruhr**: Ruhr→Firenze (23 hops) + Firenze→Ruhr (23 hops) = **46 hops = ceil(46/9) = 6 travel turns**, not 3. The bot must travel to Firenze to pick up Marble, then return to Ruhr to deliver it.

### Root Cause — Code Analysis

`ContextBuilder.ts:574-587` — the non-hub-model travel calculation:

```typescript
} else if (supplyPoints.length > 0 && deliveryPoints.length > 0) {
  // Linear model or non-cold-start: supply→delivery
  let minDist = Infinity;
  for (const sp of supplyPoints) {
    for (const dp of deliveryPoints) {
      const dist = estimateHopDistance(sp.row, sp.col, dp.row, dp.col);
      if (dist > 0) {
        minDist = Math.min(minDist, dist);
      }
    }
  }
  if (minDist < Infinity) {
    travelTurns = Math.ceil(minDist / speed);
  }
}
```

This computes `supply→delivery` hop distance. But on cold-start, the bot starts at the **starting city** (chosen by `estimateColdStartRouteCost`), not at the supply city. The actual travel path is:

`startingCity → supply → delivery`

For Ruhr as starting city with Marble Firenze→Ruhr:
- Linear model computes: Firenze→Ruhr = 23 hops → 3 travel turns
- Actual travel: Ruhr→Firenze→Ruhr = 46 hops → 6 travel turns (bot starts and ends at Ruhr)

### Why JIRA-72 hub model doesn't fix this

JIRA-72 added hub-aware travel at lines 549-573, but it only activates when `coldStartIsHubModel` is true. The hub model selection in `estimateColdStartRouteCost` picks Ruhr because:

- **Ruhr hub**: supplyCost(Ruhr→Firenze) = 40M + deliveryCost(Ruhr→Ruhr) = 0M = **40M total**
- **Milano hub**: supplyCost(Milano→Firenze) = 14M + deliveryCost(Milano→Ruhr) = 37M = **51M total**

Ruhr wins on build cost (40 < 51), so `isHubModel = false` and the travel calculation falls into the linear branch. But the linear branch doesn't account for the bot's starting position.

### The compounding effect on scoring

With correct travel turns, Ruhr-start Marble becomes:
- `estimatedTurns = 2 + 6 + 1 = 9` (not 6)
- `efficiencyPerTurn = (22 - 35) / 9 = -1.44 M/turn`

With Milano start:
- `buildTurns = ceil(51/20) = 3`
- Hub travel: Milano→Firenze→Milano→Ruhr = 6+6+17 = 29 hops, `ceil(29/9) = 4`
- `estimatedTurns = 3 + 4 + 1 = 8`
- `efficiencyPerTurn = (22 - 51) / 8 = -3.6 M/turn`

In this specific case, Marble is a bad demand regardless. But the underestimate of travel turns inflates the score of all "start at delivery city" demands, making them look faster than they are. This biases the LLM toward routes with long round trips.

### Broader impact

The bug affects ALL cold-start demands where the optimal starting city is the delivery city. The pattern is:
1. `estimateColdStartRouteCost` picks delivery city as start (0 delivery track cost)
2. `isHubModel = false` because it's effectively a linear one-spoke route
3. Travel computed as `supply→delivery` (short) instead of `start→supply→delivery` (long round trip)
4. `estimatedTurns` is too low, `efficiencyPerTurn` looks too good
5. LLM picks a demand that requires massive round-trip travel

## Proposed Fix

### Fix 1: Always compute cold-start travel from starting city

On cold-start, the travel calculation should ALWAYS account for the bot's starting position, regardless of hub vs linear model. The travel path is:

`startingCity → supplyCity → deliveryCity`

```typescript
if (isColdStart && optimalStartingCity) {
  const startPoints = gridPoints.filter(gp => gp.city?.name === optimalStartingCity);
  if (startPoints.length > 0 && supplyPoints.length > 0 && deliveryPoints.length > 0) {
    // Leg 1: startingCity → supply
    let hopStartToSupply = Infinity;
    for (const stP of startPoints) {
      for (const sp of supplyPoints) {
        const d = estimateHopDistance(stP.row, stP.col, sp.row, sp.col);
        if (d >= 0 && d < hopStartToSupply) hopStartToSupply = d;
      }
    }
    // Leg 2: supply → delivery
    let hopSupplyToDelivery = Infinity;
    for (const sp of supplyPoints) {
      for (const dp of deliveryPoints) {
        const d = estimateHopDistance(sp.row, sp.col, dp.row, dp.col);
        if (d >= 0 && d < hopSupplyToDelivery) hopSupplyToDelivery = d;
      }
    }
    const totalHops = (hopStartToSupply < Infinity ? hopStartToSupply : 0)
      + (hopSupplyToDelivery < Infinity ? hopSupplyToDelivery : 0);
    if (totalHops > 0) {
      travelTurns = Math.ceil(totalHops / speed);
    }
  }
}
```

This replaces both the hub-model branch (lines 549-573) and the linear branch (lines 574-587) for cold-start. The travel is always `start→supply→delivery`, which naturally handles:
- **Start at delivery city**: travel = start→supply + supply→start = round trip (e.g., Ruhr→Firenze→Ruhr = 46 hops)
- **Start at supply city**: travel = 0 + supply→delivery (e.g., if starting at Firenze, just Firenze→Ruhr = 23 hops)
- **Start between**: travel = start→supply + supply→delivery (e.g., Milano→Firenze + Firenze→Ruhr = 6+23 = 29 hops)

### Fix 2: Feed travel turns into `estimateColdStartRouteCost` selection

The current hub model selection in `estimateColdStartRouteCost` only compares **build cost**. But total efficiency depends on build cost AND travel time. A starting city with slightly higher build cost but much lower travel time can be more efficient.

Add travel-aware comparison to the hub selection loop:

```typescript
// In estimateColdStartRouteCost, for each candidate starting city:
const travelHops = hopToSupply + hopSupplyToDelivery; // start→supply→delivery
const travelTurns = Math.ceil(travelHops / speed);
const buildTurns = Math.ceil(totalBuildCost / 20);
const totalTurns = buildTurns + travelTurns;

// Compare on total turns (or total cost / totalTurns) instead of just build cost
```

This is a larger change and may affect many demand scores. Could be a separate JIRA if the travel fix alone improves behavior significantly.

## Acceptance Criteria

1. On cold-start, `travelTurns` accounts for the bot's starting position: travel = `startingCity→supply + supply→delivery` hops
2. Demands where the starting city equals the delivery city correctly show round-trip travel time (not just supply→delivery)
3. `estimatedTurns` for Marble Firenze→Ruhr starting at Ruhr increases from ~6 to ~9 (reflecting 46-hop round trip)
4. Existing tests continue to pass
5. Non-cold-start travel calculation is unchanged (bot has track, travel is from current position)

## Files to Modify

1. **`src/server/services/ai/ContextBuilder.ts:541-590`** — Replace cold-start travel calculation to always use `startingCity→supply→delivery` path
2. **`src/server/__tests__/ai/ContextBuilder.test.ts`** — Add test for cold-start travel from delivery-city start

## Verification

Replay Flash bot game `000cb369` scenario:
- Marble Firenze→Ruhr from Ruhr should show estimatedTurns ~9 (not 6-8)
- If Milano is picked as starting city, travel should be ~29 hops / 9 speed = 4 turns
- The demand ranking should shift: demands with long round trips should score worse
