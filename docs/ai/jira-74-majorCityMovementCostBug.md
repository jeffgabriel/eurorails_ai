# JIRA-74: Major City Internal Movement Costs Movement Points (Should Be Free)

## Bug Summary

The client-side `MovementCostCalculator.findPath()` does not inject major city internal edges (center ↔ outpost connections) into its BFS graph. This causes movement through major cities to be charged movement points when it should be free (the "red area" free travel zone).

## Root Cause

**`MovementCostCalculator.findPath()`** (`src/client/components/MovementCostCalculator.ts:168`) builds a BFS graph using **only player track segments**. It does **not** add the major city internal edges that represent the red area free travel zone.

The server-side equivalent (`src/shared/services/trackUsageFees.ts:84-93` — `buildUnionTrackGraph`) correctly adds these edges:
```typescript
for (const city of cities) {
  const centerKey = nodeKey(city.center);
  for (const outpost of city.outposts) {
    addUndirectedEdge(adjacency, centerKey, outpostKey);
  }
}
```

### Secondary Issue

`initializeCityMappings()` (line 41) maps only outpost nodes (`group.slice(1, 7)`) — **not the city center** — into `cityNodeMap`. So `isNodeInMajorCity()` returns `false` for city centers, meaning the cost-0 logic in `analyzePathSegments` won't fire correctly for center-involving segments.

## What Happens

1. Player enters a major city from one perimeter outpost and tries to exit from another
2. `findPath()` can't find a route through the city (no center↔outpost edges in graph)
3. `calculateMovementCost` returns `isValid: false`
4. `TrainMovementManager.calculateDistance()` falls back to Chebyshev distance at line 212-215
5. **Player gets charged movement points** for traversing through the city when it should be free

## Impact

- Every time a human player moves through a major city, they're overcharged on movement budget
- Client/server desync on movement counting (server handles this correctly via `buildUnionTrackGraph`)

## Fix Plan

1. **`MovementCostCalculator.findPath()`**: Inject center↔outpost edges into the BFS graph, mirroring `buildUnionTrackGraph` in `trackUsageFees.ts`
2. **`initializeCityMappings()`**: Add city center nodes to `cityNodeMap` so `isNodeInMajorCity()` returns true for centers
3. Verify `analyzePathSegments` cost-0 logic works correctly end-to-end after fixes

## Key Files

- `src/client/components/MovementCostCalculator.ts` — primary fix target
- `src/shared/services/trackUsageFees.ts` — reference implementation (correct)
- `src/shared/services/majorCityGroups.ts` — city group data source
- `src/client/components/TrainMovementManager.ts` — consumer of MovementCostCalculator
- `src/client/config/mapConfig.ts` — majorCityGroups client-side data
