# JIRA-149: ContextBuilder Cold-Start Cost Estimate Underprices Water Crossings

## Source
Discovered while investigating JIRA-148 bug 1 (game `1b31e1a2`). The demand ranking at T2 shows `Cars: Manchester→Marseille` as the supply city choice instead of `Cars: Stuttgart→Marseille`. Manchester requires a ferry crossing from the continent — it should never score better than Stuttgart for a Marseille delivery when starting from Ruhr.

## Problem

`ContextBuilder.estimateColdStartRouteCost()` (line 2088) uses a `costBetween()` helper that falls back to `hexDistance * 2.0` when `estimatePathCost()` (Dijkstra) returns 0. The Dijkstra returns 0 for cross-water paths because the pathfinding graph has no ferry links. The fallback treats the English Channel as if it were flat terrain, producing an artificially low build cost for British cities.

### The bad fallback (lines 2100-2108)

```typescript
const costBetween = (fromRow, fromCol, toRow, toCol): number => {
  if (fromRow === toRow && fromCol === toCol) return 0;
  const pathCost = estimatePathCost(fromRow, fromCol, toRow, toCol);
  if (pathCost > 0) return pathCost;
  // BUG: treats water crossings as cheap terrain
  const dist = hexDistance(fromRow, fromCol, toRow, toCol);
  return dist <= 1 ? 0 : Math.round(dist * 2.0);
};
```

When evaluating `Ruhr → Manchester`:
1. `estimatePathCost(Ruhr, Manchester)` → returns `0` (can't cross the Channel)
2. Falls back to `hexDistance(Ruhr, Manchester) * 2.0` → maybe ~15 hexes = **30M**
3. Real cost: ferry port build (8-18M) + track on both sides = **50-70M+**

The ferry turn penalty at line 728-731 (`ferryCrossings * 2` added to `estimatedTurns`) partially compensates in the turn estimate, but the **build cost** (`totalTrackCost`) remains underpriced. Since `demandScore` uses `(payout - totalTrackCost) / estimatedTurns` as its base, the cheap build cost inflates the score.

### Impact

ContextBuilder picks Manchester over Stuttgart as the supply city for Cars→Marseille because Manchester's build cost is underestimated. This propagates into the demand ranking shown in the debug overlay and log viewer, and feeds incorrect data to any downstream system that trusts the ranking (e.g., the JIRA-148 fix wiring `demandScores` into InitialBuildPlanner).

Stuttgart is on the same continent as Ruhr and Marseille with a direct land route — it should always win over Manchester for a Marseille delivery.

## Fix

### Add ferry edges to the Dijkstra graph in `estimatePathCost`

The root cause is that the pathfinding graph is missing ferry links. The graph already has all terrain costs for continental hexes — ferry routes are simply absent. Adding them makes `estimatePathCost` return real costs for cross-water paths, eliminating the fallback entirely for these cases.

All the data needed already exists in `gridPoints`:
- Ferry port hex coordinates (`terrainType === TerrainType.FerryPort`)
- Ferry port build costs (stored per milepost)
- Ferry pair linkages (each port knows its paired destination port)

The fix is a counting exercise: for each ferry pair `(portA, portB)`, add a directed edge in both directions with cost = `portA.buildCost + portB.buildCost`. This is the track cost a bot must pay to connect both ends of the ferry. The Dijkstra then naturally routes through the cheapest ferry when computing cross-water paths, and the returned cost correctly accounts for the port build investment.

```typescript
// When building the Dijkstra adjacency graph, after adding terrain edges:
for (const port of gridPoints.filter(p => p.terrainType === TerrainType.FerryPort && p.ferryDestination)) {
  const dest = gridPoints.find(p => p.row === port.ferryDestination!.row && p.col === port.ferryDestination!.col);
  if (dest) {
    const ferryCost = port.buildCost + dest.buildCost;
    graph.addEdge(port, dest, ferryCost);
    graph.addEdge(dest, port, ferryCost);
  }
}
```

With ferry edges in the graph, `estimatePathCost(Ruhr, Manchester)` will return the actual minimum cost path: cheapest continental track to a Channel port + that port's build cost + Dover/Calais build cost + track to Manchester. The `hexDistance * 2.0` fallback becomes dead code for cross-water cases.

The existing `ferryCrossings * 2` turn penalty in `estimatedTurns` remains correct and unchanged — it accounts for the turn lost to ferry crossing, which is a movement cost not a build cost.

## Files

- `src/server/services/ai/ContextBuilder.ts` — wherever `estimatePathCost`'s Dijkstra graph is constructed; add ferry edges there
- `src/server/services/ai/ContextBuilder.ts:2100-2108` — `costBetween` fallback; dead code for cross-water cases after fix (leave in place as safety net for disconnected graph nodes)
- `src/server/services/ai/ContextBuilder.ts:583-585` — `isFerryOnRoute` (already detects ferry requirement for turn penalty — no change needed)

## Verification

After fix, run game `1b31e1a2` demands through ContextBuilder and verify:
- Cars demand ranking shows `Stuttgart→Marseille`, not `Manchester→Marseille`
- `trackCostToSupply` for Manchester reflects the realistic ferry path cost (50M+)
- All British supply cities have higher build costs than equivalent continental alternatives

Add a unit test to `ContextBuilder.test.ts`:
- Given a bot at Ruhr with both Manchester and Stuttgart as Cars supply options for a Marseille delivery
- Assert Stuttgart is selected as the supply city (higher demand score / lower build cost)
- Assert `trackCostToSupply` for Manchester > `trackCostToSupply` for Stuttgart
